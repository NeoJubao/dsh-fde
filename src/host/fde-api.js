/**
 * FDE 工作站 · 业务层（路由与 agent 工具共用同一实现，spec §7）
 *
 * 每个函数：读/写 board（唯一状态文件 research/.fde/board.json），返回统一结果：
 *   成功 {ok:true, ...}
 *   失败 {ok:false, reason, code}  code ∈ INVALID | BLOCKED | NOT_FOUND | CONFLICT | INTERNAL
 * httpStatusOf(result) 负责映射 HTTP 状态码（路由层用）。
 *
 * 红线（spec §6）：本层不执行阶段推进/过门禁/删除归档/对外发送；
 * 这些只能由人在面板或对话中明确触发，agent 工具只准备与建议。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import * as schema from './fde-schema.js';
import * as store from './fde-store.js';
import * as rules from './fde-rules.js';
import * as prompts from './fde-prompts.js';
import * as bids from './fde-bids.js';
import { safeDirName, safeProjectPath, PathError } from './paths.js';

export const API_PREFIX = schema.API_PREFIX;
export const CODE_STATUS = { INVALID: 400, BLOCKED: 409, CONFLICT: 409, NOT_FOUND: 404, INTERNAL: 500 };

/** 结果 → HTTP 状态码；带 prompt 的失败仍回 200（面板剪贴板降级）。 */
export function httpStatusOf(result) {
  if (!result || typeof result !== 'object') return 500;
  if (result.ok) return 200;
  if (result.prompt) return 200;
  return CODE_STATUS[result.code] || 400;
}

const err = (reason, code = 'INVALID', extra) => Object.assign({ ok: false, reason, code }, extra || {});
const okr = (extra) => Object.assign({ ok: true }, extra || {});
const pickString = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function ttlOf(board) {
  const n = Number(board && board.settings && board.settings.cacheTtlMs);
  return Number.isFinite(n) && n >= 0 ? n : store.DEFAULT_CACHE_TTL_MS;
}

function findById(list, id) {
  const key = String(id || '');
  if (!key) return null;
  return (list || []).find((x) => x && x.id === key) || null;
}

function scanOf(root, engagement, ttlMs) {
  if (!engagement || !engagement.dir) return null;
  return store.scanProjectArtifacts(root, engagement.dir, { ttlMs });
}

/** 读取 board 的统一入口（失败结果可直接返回给调用方）。 */
function load(root) {
  const r = store.readBoard(root);
  if (!r.ok) return { ok: false, code: r.code || 'INTERNAL', reason: r.reason || '读取 board 失败' };
  return { ok: true, board: r.board, fresh: !!r.fresh };
}

/* ---------------- 调用方来源 / 参数归一化 / CAS 事务 ---------------- */

/** 调用方来源：agent 工具显式传 by:'agent'；HTTP 面板与进程内直接调用默认 human。 */
export function byOf(body) {
  return body && body.by === 'agent' ? 'agent' : 'human';
}

/**
 * 统一参数归一化（F5）：patch 与顶层控制字段合并，避免工具声明的参数被静默丢弃。
 * 只搬控制字段（stage/force/reason/checks/evidence/sessionId/lost），不改业务字段语义。
 */
export function normalizeArgs(body) {
  const b = Object.assign({}, body || {});
  const patch = Object.assign({}, isPlainObject(b.patch) ? b.patch : {});
  for (const k of ['stage', 'force', 'reason', 'checks', 'evidence', 'sessionId', 'lost']) {
    if (b[k] !== undefined && patch[k] === undefined) patch[k] = b[k];
  }
  b.patch = patch;
  return b;
}

/** runAction 用：操作成功但不需要写盘（无状态变更）。 */
const noWrite = (extra) => Object.assign({ ok: true, noWrite: true }, extra || {});

/**
 * 读-改-写 + CAS 事务（spec §4.1 并发写）：
 * 每次基于**磁盘最新 board** 执行 mutate；写盘带 expectedRevision；
 * 冲突时重读并重跑一次 mutate（mutate 必须是基于 board 的纯变换）。
 */
function runAction(root, mutate) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const r = load(root);
    if (!r.ok) return r;
    const board = r.board;
    const out = mutate(board);
    if (!out || out.ok !== true) return out || err('内部错误：操作未返回结果', 'INTERNAL');
    if (out.noWrite) return Object.assign({}, out, { board });
    const w = store.writeBoard(root, board, { expectedRevision: board.revision });
    if (w.ok) {
      return Object.assign({}, out, {
        board: w.board,
        revision: w.revision,
        backup: w.backup || '',
        staleSkipped: !!w.staleSkipped,
      });
    }
    if (w.code !== 'CONFLICT') return { ok: false, code: w.code || 'INTERNAL', reason: w.reason || '写入 board 失败' };
  }
  return err('board 并发冲突：已重读并重试一次仍失败，请刷新后重试', 'CONFLICT');
}

/** 工具层红线（F1 / spec §6、§7）：阶段推进/归档/门禁勾选与 force 只能由人在面板执行。 */
const AGENT_FORBIDDEN_ENGAGEMENT_ACTIONS = new Set(['move', 'archive']);
export function agentGuard(body, action) {
  if (byOf(body) !== 'agent') return null;
  if (AGENT_FORBIDDEN_ENGAGEMENT_ACTIONS.has(action)) {
    return err('阶段推进/归档只能由人在面板执行（agent 红线：只能准备、建议、提问）', 'BLOCKED');
  }
  const patch = isPlainObject(body.patch) ? body.patch : {};
  const wantsGateWrite = body.force === true || patch.force === true ||
    (isPlainObject(body.checks) && Object.keys(body.checks).length > 0) ||
    (isPlainObject(patch.checks) && Object.keys(patch.checks).length > 0);
  if (action === 'gate' && wantsGateWrite) {
    return err('门禁勾选与 force 放行只能由人在面板执行（agent 红线：gate 只允许只读评估）', 'BLOCKED');
  }
  return null;
}

/* ============================ patch 校验 ============================ */

function sanitizeStakeholders(list) {
  if (!Array.isArray(list)) return { ok: false, reason: 'stakeholders 必须为数组' };
  const out = [];
  for (const raw of list.slice(0, 50)) {
    if (!isPlainObject(raw)) continue;
    const name = pickString(raw.name, 60);
    if (!name) return { ok: false, reason: 'stakeholders[].name 不能为空' };
    const level = ['top', 'vp', 'exec', 'unknown'].includes(raw.level) ? raw.level : 'unknown';
    out.push({ name, role: pickString(raw.role, 80), level, stance: pickString(raw.stance, 200), verified: !!raw.verified });
  }
  return { ok: true, value: out };
}

function sanitizeTags(list) {
  if (!Array.isArray(list)) return { ok: false, reason: 'tags 必须为数组' };
  return { ok: true, value: list.map((t) => pickString(t, 40)).filter(Boolean).slice(0, 20) };
}

/**
 * 校验 engagement patch（只接受白名单字段；stage/gateState/attention 有专用动作）。
 * @param {string} root
 * @param {object} patch
 * @param {object} board
 * @param {object|null} existing 更新时的现有客户（create 传 null）
 */
export function sanitizeEngagementPatch(root, patch, board, existing) {
  const out = {};
  if (!isPlainObject(patch)) return { ok: false, reason: 'patch 必须为对象' };
  if ('name' in patch) {
    const v = pickString(patch.name, 120);
    if (!v) return { ok: false, reason: 'name 不能为空' };
    out.name = v;
  }
  for (const k of ['company', 'shortName', 'owner']) {
    if (k in patch) out[k] = pickString(patch[k], 200);
  }
  if ('dir' in patch) {
    const raw = pickString(patch.dir, 200);
    if (raw) {
      try { safeDirName(raw); } catch (e) { return { ok: false, reason: '非法目录名：' + ((e && e.message) || e) }; }
      try { safeProjectPath(root, raw); } catch (e) {
        if (e instanceof PathError) return { ok: false, reason: '非法目录名：' + e.message };
        return { ok: false, reason: '目录校验失败：' + ((e && e.message) || e) };
      }
      const dup = (board.engagements || []).find((x) => x.dir === raw && (!existing || x.id !== existing.id));
      if (dup) return { ok: false, reason: `目录已被客户占用：${raw}` };
    }
    out.dir = raw;
  }
  if ('priority' in patch) {
    if (!schema.isPriority(patch.priority)) return { ok: false, reason: 'priority 必须是 high|normal|low' };
    out.priority = patch.priority;
  }
  if ('paused' in patch) out.paused = !!patch.paused;
  if ('tags' in patch) {
    const t = sanitizeTags(patch.tags);
    if (!t.ok) return t;
    out.tags = t.value;
  }
  if ('source' in patch) {
    if (!isPlainObject(patch.source)) return { ok: false, reason: 'source 必须为对象' };
    const kind = pickString(patch.source.kind, 20) || 'manual';
    if (!['manual', 'import', 'folder', 'bid', 'agent'].includes(kind)) return { ok: false, reason: 'source.kind 非法' };
    out.source = { kind, ref: pickString(patch.source.ref, 300), at: store.isValidIso(patch.source.at) ? patch.source.at : store.nowIso() };
  }
  if ('value' in patch) {
    if (!isPlainObject(patch.value)) return { ok: false, reason: 'value 必须为对象' };
    const amount = Number(patch.value.amount);
    out.value = {
      amount: Number.isFinite(amount) ? amount : 0,
      currency: pickString(patch.value.currency, 8) || 'CNY',
      note: pickString(patch.value.note, 300),
    };
  }
  if ('nextAction' in patch) {
    if (!isPlainObject(patch.nextAction)) return { ok: false, reason: 'nextAction 必须为对象' };
    const na = patch.nextAction;
    const due = pickString(na.due, 20);
    if (due && !store.isDueStr(due)) return { ok: false, reason: 'nextAction.due 必须为 YYYY-MM-DD 或空' };
    out.nextAction = { text: pickString(na.text, 300), due, owner: pickString(na.owner, 60) };
  }
  if ('stakeholders' in patch) {
    const s = sanitizeStakeholders(patch.stakeholders);
    if (!s.ok) return s;
    out.stakeholders = s.value;
  }
  if ('bidWatch' in patch) {
    if (!isPlainObject(patch.bidWatch)) return { ok: false, reason: 'bidWatch 必须为对象' };
    const src = patch.bidWatch;
    const w = {};
    if ('enabled' in src) {
      if (typeof src.enabled !== 'boolean') return { ok: false, reason: 'bidWatch.enabled 必须为布尔' };
      w.enabled = src.enabled;
    }
    if ('keywords' in src) {
      if (!Array.isArray(src.keywords)) return { ok: false, reason: 'bidWatch.keywords 必须为数组' };
      w.keywords = src.keywords.map((k) => pickString(k, 40)).filter(Boolean).slice(0, 20);
    }
    if ('links' in src) {
      if (!Array.isArray(src.links)) return { ok: false, reason: 'bidWatch.links 必须为数组' };
      const links = [];
      for (const raw of src.links.slice(0, 200)) {
        if (!isPlainObject(raw)) continue;
        const bidId = pickString(raw.bidId, 300);
        if (!bidId) return { ok: false, reason: 'bidWatch.links[].bidId 不能为空' };
        links.push({
          bidId,
          title: pickString(raw.title, 300),
          date: pickString(raw.date, 20),
          url: pickString(raw.url, 500),
          relation: pickString(raw.relation, 20) || 'mention',
          note: pickString(raw.note, 500),
          linkedAt: pickString(raw.linkedAt, 40) || store.nowIso(),
          by: raw.by === 'agent' ? 'agent' : 'human',
        });
      }
      w.links = links;
    }
    out.bidWatch = w;
  }
  if ('stage' in patch) return { ok: false, reason: '改阶段请用 action=move（受门禁约束）' };
  if ('gateState' in patch) return { ok: false, reason: '门禁请用 action=gate' };
  if ('attention' in patch) return { ok: false, reason: '注意力请用 attention 动作' };
  return { ok: true, patch: out };
}

/** 校验 item patch（泳道用 move，回报用 report）。 */
export function sanitizeItemPatch(patch, board) {
  const out = {};
  if (!isPlainObject(patch)) return { ok: false, reason: 'patch 必须为对象' };
  if ('title' in patch) {
    const v = pickString(patch.title, 200);
    if (!v) return { ok: false, reason: 'title 不能为空' };
    out.title = v;
  }
  if ('type' in patch) {
    if (!schema.isItemType(patch.type)) return { ok: false, reason: 'type 非法：' + String(patch.type) };
    out.type = patch.type;
  }
  if ('priority' in patch) {
    if (!schema.isPriority(patch.priority)) return { ok: false, reason: 'priority 必须是 high|normal|low' };
    out.priority = patch.priority;
  }
  if ('due' in patch) {
    const due = pickString(patch.due, 20);
    if (due && !store.isDueStr(due)) return { ok: false, reason: 'due 必须为 YYYY-MM-DD 或空' };
    out.due = due;
  }
  if ('owner' in patch) {
    if (!['human', 'agent', 'both'].includes(patch.owner)) return { ok: false, reason: 'owner 必须是 human|agent|both' };
    out.owner = patch.owner;
  }
  if ('engagementId' in patch) {
    const eid = pickString(patch.engagementId, 40);
    if (eid && !findById(board.engagements, eid)) return { ok: false, reason: 'engagementId 不存在：' + eid };
    out.engagementId = eid;
  }
  if ('autonomy' in patch) {
    if (!isPlainObject(patch.autonomy)) return { ok: false, reason: 'autonomy 必须为对象' };
    const mode = pickString(patch.autonomy.mode, 20);
    if (mode && !schema.isAutonomy(mode)) return { ok: false, reason: 'autonomy.mode 非法' };
    out.autonomy = { mode: mode || 'observe', rule: pickString(patch.autonomy.rule, 60) };
  }
  if ('stage' in patch) return { ok: false, reason: '改泳道请用 action=move' };
  if ('reports' in patch) return { ok: false, reason: '回报请用 action=report' };
  return { ok: true, patch: out };
}

/* ============================ board / brief ============================ */

function artifactSummary(root, board, ttlMs) {
  const out = {};
  for (const e of board.engagements || []) {
    if (!e.dir) { out[e.id] = store.summarizeArtifacts(null); continue; }
    out[e.id] = store.summarizeArtifacts(store.scanProjectArtifacts(root, e.dir, { ttlMs }));
  }
  return out;
}

/* ---------------- 招采雷达（spec §17）：服务获取与派生上下文 ---------------- */

/** board/brief 摘要匹配参数（与 fde-rules.bid_signal 一致 → 命中同一匹配缓存）。 */
const SUMMARY_MATCH_OPTS = { maxQueries: bids.SUMMARY_QUERY_LIMIT, perQueryLimit: 30, limit: bids.MATCH_ITEM_LIMIT };

function bidServiceOf(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'bidIntel')) {
    return bids.isAvailable(opts.bidIntel) ? opts.bidIntel : null;
  }
  return bids.currentBidService();
}

function bidUnavailable(reason) {
  return { available: false, reason: reason || '招采雷达未就绪（bid-intel 未装载或未升级）' };
}

/** 从 name/dir 回填缺失的 company（仅当含公司/机构标记；幂等，CAS 由 runAction 保证）。 */
function backfillCompanies(board) {
  let changed = 0;
  for (const e of board.engagements || []) {
    if (String(e.company || '').trim()) continue;
    const inferred = bids.inferCompany(e.name) || bids.inferCompany(e.dir);
    if (inferred) { e.company = inferred; changed += 1; }
  }
  return changed;
}

/**
 * 每个客户的招采摘要 + 全局 bidStats（派生，不落盘）。
 * 服务不可用时只回 available:false，不触发任何数据加载。
 */
function bidContext(board, service, ttlMs) {
  const summaries = {};
  const available = bids.isAvailable(service);
  for (const e of board.engagements || []) {
    if (!schema.isStage(e.stage)) { summaries[e.id] = Object.assign(bidUnavailable('客户已终止'), { total: 0, tender: 0, award: 0, candidate: 0, latest: '', queries: [], matches: [] }); continue; }
    if (e.bidWatch && e.bidWatch.enabled === false) {
      summaries[e.id] = Object.assign(bidUnavailable('该客户已关闭招采雷达'), { enabled: false, total: 0, tender: 0, award: 0, candidate: 0, latest: '', queries: [], matches: [] });
      continue;
    }
    if (!available) { summaries[e.id] = Object.assign(bidUnavailable(), { total: 0, tender: 0, award: 0, candidate: 0, latest: '', queries: [], matches: [] }); continue; }
    let match = null;
    try { match = bids.matchEngagement(service, e, Object.assign({}, SUMMARY_MATCH_OPTS, { ttlMs })); } catch { match = null; }
    summaries[e.id] = bids.summarizeMatch(match || bidUnavailable('匹配失败'));
  }
  const stats = bids.bidStatsOf(service);
  stats.engagedCount = bids.countEngaged(summaries);
  return { summaries, bidStats: stats };
}

/** 刷新 proposals（含 bid_signal）+ company 回填：有变更时按 CAS 落盘（读时求值，spec §6）。
 * GET 读路径容忍并发：冲突重试后仍失败时用最新 board 继续，绝不覆盖别人刚写入的数据。 */
function refreshAndPersist(root, opts = {}) {
  const service = opts.bidIntel || null;
  const res = runAction(root, (board) => {
    const ttl = ttlOf(board);
    const backfilled = backfillCompanies(board);
    const r = rules.refreshProposals(root, board, { ttlMs: ttl, bidIntel: service });
    if (!r.added.length && !backfilled) return noWrite({ added: 0, backfilled: 0 });
    return { ok: true, added: r.added.length, backfilled };
  });
  if (res.ok) return res;
  if (opts.tolerant && res.code === 'CONFLICT') {
    const again = load(root);
    if (again.ok) return okr({ board: again.board, added: 0, conflict: true });
  }
  return res;
}

/**
 * 看板全量（GET /fde/board）。
 * @param {string} root
 * @param {{view?:'board'|'brief'}} [opts]
 */
export function board(root, opts = {}) {
  const service = bidServiceOf(opts);
  const refreshed = refreshAndPersist(root, { tolerant: true, bidIntel: service });
  if (!refreshed.ok) return refreshed;
  const b = refreshed.board;
  const ttl = ttlOf(b);
  const attention = rules.derivedAttention(root, b, { ttlMs: ttl });
  const stats = rules.computeStats(root, b, attention);
  const artifacts = artifactSummary(root, b, ttl);
  const bidCtx = bidContext(b, service, ttl);
  /* 响应副本：客户对象挂 artifacts/bids 摘要（面板卡片直接读），不写回状态文件。 */
  const boardForClient = Object.assign({}, b, {
    engagements: (b.engagements || []).map((e) => Object.assign({}, e, {
      artifacts: artifacts[e.id] || null,
      bids: bidCtx.summaries[e.id] || bidUnavailable(),
    })),
  });
  const result = {
    ...okr({}),
    root,
    board: boardForClient,
    meta: schema.meta(),
    stats,
    attention,
    artifacts,
    bidStats: bidCtx.bidStats,
    generatedAt: store.nowIso(),
    fresh: false,
    proposalsAdded: refreshed.added || 0,
    companiesBackfilled: refreshed.backfilled || 0,
  };
  if (opts.view === 'brief') result.brief = buildBrief(b, { attention, stats, artifacts, period: 'today', bidCtx });
  return result;
}

function buildBrief(b, { attention, stats, period = 'today', bidCtx = null }) {
  const engById = new Map((b.engagements || []).map((e) => [e.id, e]));
  const attentionCount = new Map();
  for (const a of attention) {
    const key = a.engagementId || '';
    if (key) attentionCount.set(key, (attentionCount.get(key) || 0) + 1);
  }
  const focus = (b.engagements || [])
    .filter((e) => schema.isStage(e.stage) && !e.paused)
    .map((e) => ({
      engagementId: e.id,
      name: e.name,
      stage: e.stage,
      stageLabel: schema.stageLabel(e.stage),
      priority: e.priority,
      nextAction: e.nextAction || { text: '', due: '', owner: '' },
      attentionCount: attentionCount.get(e.id) || 0,
      stayDays: rules.stageStayDays(e),
    }))
    .sort((a, c) => (schema.priorityOrder(a.priority) - schema.priorityOrder(c.priority)) || (a.attentionCount < c.attentionCount ? 1 : -1) || String(a.nextAction.due || '9999').localeCompare(String(c.nextAction.due || '9999')))
    .slice(0, 3);
  const proposals = (b.proposals || []).filter((p) => p.status === 'pending');
  const activity = (b.activity || []).slice(-10).reverse();
  const headline = `活跃客户 ${stats.active} 个 · 待处理 ${attention.length} 条 · 今天到期 ${stats.dueToday} · 逾期 ${stats.overdue}`;
  const dueTodayItems = (b.items || []).filter((it) => store.isDueStr(it.due) && it.due === store.todayStr() && schema.isLane(it.stage)).map((it) => ({ id: it.id, title: it.title, engagementId: it.engagementId, stage: it.stage }));
  return {
    generatedAt: store.nowIso(),
    period: period === 'week' ? 'week' : 'today',
    headline,
    greeting: stats.active === 0
      ? '还没有客户在推进：先「导入现有项目」或新建一个客户'
      : (attention.length ? `今天有 ${attention.length} 件事需要你处理` : '今天没有需要你处理的事'),
    stats,
    autonomy: (b.settings && b.settings.autonomy) || 'observe',
    attention,
    proposals,
    focus,
    dueTodayItems,
    activity,
    bidStats: bidCtx ? bidCtx.bidStats : bids.bidStatsOf(null),
  };
}

/** 今日简报（GET /fde/brief）。 */
export function brief(root, opts = {}) {
  const service = bidServiceOf(opts);
  const refreshed = refreshAndPersist(root, { tolerant: true, bidIntel: service });
  if (!refreshed.ok) return refreshed;
  const b = refreshed.board;
  const ttl = ttlOf(b);
  const attention = rules.derivedAttention(root, b, { ttlMs: ttl });
  const stats = rules.computeStats(root, b, attention);
  const data = buildBrief(b, { attention, stats, period: opts.period || 'today', bidCtx: bidContext(b, service, ttl) });
  return okr({ root, brief: data, meta: schema.meta(), stats });
}

/* ============================ engagement ============================ */

function createEngagement(root, b, body) {
  /* 兼容两种传参：patch 内聚（面板）与顶层扁平字段（工具 create）。 */
  const patch = Object.assign({}, isPlainObject(body.patch) ? body.patch : {});
  for (const k of ['name', 'company', 'shortName', 'dir', 'priority', 'owner', 'tags', 'source', 'value', 'nextAction', 'stakeholders', 'paused']) {
    if (body[k] !== undefined && patch[k] === undefined) patch[k] = body[k];
  }
  const s = sanitizeEngagementPatch(root, patch, b, null);
  if (!s.ok) return err(s.reason);
  const p = s.patch;
  const name = p.name || pickString(patch.company, 120);
  if (!name) return err('请提供 name（看板标题）或 company（工商全称）');
  const by = byOf(body);
  const now = store.nowIso();
  const e = {
    id: store.newEngagementId(),
    name,
    company: p.company || '',
    shortName: p.shortName || '',
    dir: p.dir || '',
    stage: 'lead',
    stageSince: now,
    paused: !!p.paused,
    priority: p.priority || 'normal',
    owner: p.owner || '',
    tags: p.tags || [],
    source: p.source || { kind: by === 'agent' ? 'agent' : 'manual', ref: '', at: now },
    value: p.value || { amount: 0, currency: 'CNY', note: '' },
    nextAction: p.nextAction || { text: '', due: '', owner: '' },
    stakeholders: p.stakeholders || [],
    gateState: {},
    attention: null,
    bidWatch: { enabled: true, keywords: [], links: [], lastMatchAt: '' },
    sessionId: '',
    createdAt: now,
    adopted: false,
    timeline: [{ at: now, kind: 'created', text: '看板创建客户', by }],
  };
  if (p.bidWatch) {
    e.bidWatch = Object.assign(e.bidWatch, p.bidWatch);
    if (Array.isArray(p.bidWatch.keywords)) e.bidWatch.keywords = p.bidWatch.keywords.slice();
    if (Array.isArray(p.bidWatch.links)) e.bidWatch.links = p.bidWatch.links.slice();
  }
  b.engagements.push(e);
  store.pushActivity(b, { kind: 'created', text: `创建客户：${e.name}`, engagementId: e.id, by });
  return okr({ engagement: e });
}

function moveEngagement(root, b, body) {
  const by = byOf(body);
  const patch = isPlainObject(body.patch) ? body.patch : {};
  const id = pickString(body.id, 40);
  const e = findById(b.engagements, id);
  if (!e) return err(`客户不存在：${id || '(空)'}`, 'NOT_FOUND');
  const target = pickString(patch.stage || body.stage, 40);
  const force = !!(patch.force || body.force);
  const reason = pickString(patch.reason || body.reason, 300);
  if (!schema.isEngagementStage(target)) return err(`非法阶段：${target || '(空)'}（${schema.STAGE_KEYS.join('|')}|archived|lost）`);
  if (!schema.isStage(target)) return err(`move 只能推进到 ${schema.ENGAGEMENT_STAGES.length} 个阶段之一；归档请用 action=archive`);
  if (!schema.isStage(e.stage)) return err('客户已终止（归档/流失），不能再移动阶段', 'CONFLICT');
  const curOrder = schema.stageOrder(e.stage);
  const targetOrder = schema.stageOrder(target);
  const backward = targetOrder < curOrder;
  if (!force && !backward) {
    if (targetOrder !== curOrder + 1) {
      const nxt = schema.nextStage(e.stage);
      return err(nxt ? `不可跳阶：当前「${schema.stageLabel(e.stage)}」只能推进到「${schema.stageLabel(nxt)}」（force 可越级）` : '已到最后一个阶段，只能归档', 'INVALID');
    }
  } else if (force && !reason) {
    return err('强制推进必须给出 reason（记录到 gateState.forced）');
  }
  const gateKey = schema.gateKeyOfStage(target);
  const gsKey = gateKey ? schema.gateStateKey(gateKey) : '';
  /* 回退是人工纠正（恢复早前阶段），不校验门禁；前进必须过门禁或已由人强制放行过。 */
  const gate = !backward && gateKey ? rules.evaluateGate(root, e, gateKey, { ttlMs: ttlOf(b) }) : null;
  const forcedBefore = !!(gsKey && e.gateState[gsKey] && e.gateState[gsKey].forced === true);
  if (gate && !gate.passed && !force && !forcedBefore) {
    return err(`门禁未通过（${gate.label}）：缺 ${gate.missing.length} 项`, 'BLOCKED', { blocked: true, gate, missing: gate.missing });
  }
  const now = store.nowIso();
  if (gsKey && !backward) {
    const prev = e.gateState[gsKey] || {};
    const record = Object.assign({ checks: prev.checks || {}, forced: false, reason: '', at: now }, prev);
    if (gate && !gate.passed && force) { record.status = 'forced'; record.forced = true; record.reason = reason; record.at = now; }
    else if (gate && gate.passed) { record.status = 'pass'; record.forced = false; record.at = now; }
    /* forcedBefore 且仍未通过：保留既有 forced 记录（人在 /fde/gate 已强制放行过） */
    e.gateState[gsKey] = record;
  }
  const from = e.stage;
  e.stage = target;
  e.stageSince = now;
  store.pushTimeline(e, {
    kind: 'stage',
    text: backward
      ? `阶段回退：${schema.stageLabel(from)} → ${schema.stageLabel(target)}（人工纠正）`
      : `阶段：${schema.stageLabel(from)} → ${schema.stageLabel(target)}${force && gate && !gate.passed ? `（force：${reason}）` : ''}`,
    by,
  });
  store.pushActivity(b, { kind: 'moved', text: `${e.name}：${schema.stageLabel(from)} → ${schema.stageLabel(target)}${backward ? '（回退）' : (force ? '（force）' : '')}`, engagementId: e.id, by });
  const gateFinal = gateKey && !backward ? (rules.evaluateGate(root, e, gateKey, { ttlMs: ttlOf(b) }) || gate) : gate;
  return okr({ engagement: e, gate: gateFinal, missing: gateFinal ? gateFinal.missing : [] });
}

function gateEvaluate(root, b, body) {
  /* 参数归一化（F5）：patch 与顶层字段合并，gate 的 stage/checks/force/reason 不再被静默丢弃。 */
  const a = Object.assign({}, body, isPlainObject(body.patch) ? body.patch : {});
  const by = byOf(body);
  const id = pickString(a.engagementId || a.id, 40);
  const e = findById(b.engagements, id);
  if (!e) return err(`客户不存在：${id || '(空)'}`, 'NOT_FOUND');
  const stage = pickString(a.stage, 20) || e.stage;
  if (!schema.isEngagementStage(stage)) return err(`非法阶段：${stage}`);
  if (!schema.isStage(stage)) return err('终止状态没有门禁');
  const gateKey = schema.gateKeyOfStage(stage);
  if (!gateKey) return err('该阶段没有门禁定义', 'NOT_FOUND');
  const def = schema.gateDef(gateKey);
  const gsKey = schema.gateStateKey(gateKey);
  const now = store.nowIso();
  let changed = false;
  const gs = Object.assign({ status: 'pending', checks: {}, forced: false, reason: '', at: '' }, e.gateState[gsKey] || {});
  gs.checks = Object.assign({}, gs.checks || {});

  if (isPlainObject(a.checks)) {
    const manualKeys = new Set(def.manual.map((c) => c.key));
    const touched = [];
    for (const [k, v] of Object.entries(a.checks)) {
      if (!manualKeys.has(k)) continue;
      if (!isPlainObject(v)) continue;
      const status = v.status === 'pass' ? 'pass' : 'pending';
      gs.checks[k] = { status, evidence: pickString(v.evidence, 1000), at: now };
      touched.push(k);
      changed = true;
    }
    if (touched.length) store.pushTimeline(e, { kind: 'gate', text: `门禁 ${gateKey} 人工项：${touched.join('、')}`, by });
  }

  /* 先把人工勾选写回 engagement.gateState（按阶段 key），再评估——否则 evaluateGate 读不到刚提交的勾选。 */
  e.gateState[gsKey] = gs;
  const gate = rules.evaluateGate(root, e, gateKey, { ttlMs: ttlOf(b) });
  if (gate.passed && gs.status !== 'pass') { gs.status = 'pass'; gs.at = now; gs.forced = false; changed = true; }

  const force = !!a.force;
  const reason = pickString(a.reason, 300);
  if (force) {
    if (!reason) return err('force 必须给出 reason');
    if (!gate.passed) {
      gs.status = 'forced';
      gs.forced = true;
      gs.reason = reason;
      gs.at = now;
      changed = true;
      store.pushTimeline(e, { kind: 'gate', text: `门禁 ${gateKey} 强制放行：${reason}`, by });
      store.pushActivity(b, { kind: 'gate', text: `${e.name} 门禁 ${gateKey} 强制放行`, engagementId: e.id, by });
    }
  }
  /* 写回后重算一次：让人工勾选/force 的状态如实出现在响应里（面板据此渲染）。 */
  const gateFinal = changed ? (rules.evaluateGate(root, e, gateKey, { ttlMs: ttlOf(b) }) || gate) : gate;
  const payload = { gate: gateFinal, missing: gateFinal.missing, engagement: e, changed };
  return changed ? okr(payload) : noWrite(payload);
}

function updateEngagement(root, b, body) {
  const by = byOf(body);
  const id = pickString(body.id, 40);
  const e = findById(b.engagements, id);
  if (!e) return err(`客户不存在：${id || '(空)'}`, 'NOT_FOUND');
  const patch = Object.assign({}, isPlainObject(body.patch) ? body.patch : {});
  for (const k of ['name', 'company', 'shortName', 'dir', 'priority', 'owner', 'tags', 'source', 'value', 'nextAction', 'stakeholders', 'paused']) {
    if (body[k] !== undefined && patch[k] === undefined) patch[k] = body[k];
  }
  const s = sanitizeEngagementPatch(root, patch, b, e);
  if (!s.ok) return err(s.reason);
  if (!Object.keys(s.patch).length) return noWrite({ engagement: e });
  const nextBidWatch = s.patch.bidWatch;
  const rest = Object.assign({}, s.patch);
  delete rest.bidWatch;
  Object.assign(e, rest);
  if (nextBidWatch) {
    const merged = Object.assign({ enabled: true, keywords: [], links: [], lastMatchAt: '' }, e.bidWatch || {}, nextBidWatch);
    if (Array.isArray(nextBidWatch.links)) merged.links = nextBidWatch.links;
    e.bidWatch = merged;
  }
  store.pushTimeline(e, { kind: 'note', text: '更新客户字段：' + Object.keys(s.patch).join('、'), by });
  store.pushActivity(b, { kind: 'updated', text: `更新客户：${e.name}`, engagementId: e.id, by });
  return okr({ engagement: e });
}

function archiveEngagement(root, b, body) {
  const by = byOf(body);
  const patch = isPlainObject(body.patch) ? body.patch : {};
  const reason = pickString(patch.reason || body.reason, 200);
  const lost = !!(patch.lost || body.lost);
  const id = pickString(body.id, 40);
  const e = findById(b.engagements, id);
  if (!e) return err(`客户不存在：${id || '(空)'}`, 'NOT_FOUND');
  if (schema.isTerminal(e.stage)) return err('客户已归档或已流失', 'CONFLICT');
  const target = lost ? 'lost' : 'archived';
  const now = store.nowIso();
  const from = e.stage;
  e.stage = target;
  e.stageSince = now;
  e.paused = false;
  store.pushTimeline(e, { kind: 'stage', text: `阶段：${schema.stageLabel(from)} → ${schema.stageLabel(target)}${reason ? '（' + reason + '）' : ''}`, by });
  store.pushActivity(b, { kind: 'moved', text: `${e.name}：${schema.stageLabel(from)} → ${schema.stageLabel(target)}`, engagementId: e.id, by });
  return okr({ engagement: e });
}

/** 客户增改移（POST /fde/engagement；工具 fde_engagement）。
 *  并发：runAction 基于磁盘最新 board 读改写 + CAS（spec §4.1）。
 *  红线：agent 工具来源（by:'agent'）的 move/archive/门禁勾选与 force 在宿主层同样拒绝（F1）。 */
export function engagement(root, body = {}) {
  const args = normalizeArgs(body);
  const action = pickString(args.action, 20);
  const guard = agentGuard(args, action);
  if (guard) return guard;
  if (!['create', 'update', 'move', 'gate', 'archive'].includes(action)) {
    return err(`未知 action：${action || '(空)'}（create|update|move|gate|archive）`);
  }
  return runAction(root, (b) => {
    switch (action) {
      case 'create': return createEngagement(root, b, args);
      case 'update': return updateEngagement(root, b, args);
      case 'move': return moveEngagement(root, b, args);
      case 'gate': return gateEvaluate(root, b, args);
      case 'archive': return archiveEngagement(root, b, args);
      default: return err('未知 action：' + action);
    }
  });
}

/* ============================ item ============================ */

function moveItem(item, lane, by) {
  if (item.stage === lane) return false;
  const from = item.stage;
  item.stage = lane;
  store.pushHistory(item, { kind: 'moved', text: `泳道：${schema.laneLabel(from)} → ${schema.laneLabel(lane)}`, by: by || 'human' });
  return true;
}

function createItem(root, b, body) {
  const by = byOf(body);
  const patch = Object.assign({}, isPlainObject(body.patch) ? body.patch : {});
  for (const k of ['title', 'type', 'priority', 'due', 'owner', 'engagementId', 'stage', 'autonomy']) {
    if (body[k] !== undefined && patch[k] === undefined) patch[k] = body[k];
  }
  const title = pickString(patch.title, 200);
  if (!title) return err('title 不能为空');
  /* 创建时允许直接落在某泳道（move 才有「改泳道」限制），校验前先摘出 stage。 */
  const initialLane = pickString(patch.stage, 20) || 'inbox';
  const forPatch = Object.assign({}, patch);
  delete forPatch.stage;
  const s = sanitizeItemPatch(forPatch, b);
  if (!s.ok) return err(s.reason);
  const p = s.patch;
  const lane = initialLane;
  if (!schema.isLane(lane)) return err(`非法泳道：${lane}（${schema.LANE_KEYS.join('|')}）`);
  const now = store.nowIso();
  const it = {
    id: store.newItemId(),
    engagementId: p.engagementId || '',
    title,
    type: p.type || 'research',
    stage: lane,
    priority: p.priority || 'normal',
    due: p.due || '',
    owner: p.owner || (by === 'agent' ? 'agent' : 'human'),
    source: { kind: by === 'agent' ? 'agent' : 'manual', ref: '', at: now },
    autonomy: p.autonomy || { mode: (b.settings && b.settings.autonomy) || 'observe', rule: '' },
    attention: null,
    reports: [],
    sessionId: '',
    createdAt: now,
    history: [{ at: now, kind: 'created', text: '创建任务', by }],
  };
  b.items.push(it);
  const eng = it.engagementId ? findById(b.engagements, it.engagementId) : null;
  store.pushActivity(b, { kind: 'created', text: `创建任务：${it.title}`, engagementId: it.engagementId, itemId: it.id, by });
  if (eng) store.pushTimeline(eng, { kind: 'note', text: `新增任务：${it.title}`, by });
  return okr({ item: it });
}

function updateItem(root, b, body) {
  const by = byOf(body);
  const id = pickString(body.id, 40);
  const it = findById(b.items, id);
  if (!it) return err(`任务不存在：${id || '(空)'}`, 'NOT_FOUND');
  const patch = Object.assign({}, isPlainObject(body.patch) ? body.patch : {});
  for (const k of ['title', 'type', 'priority', 'due', 'owner', 'engagementId', 'autonomy']) {
    if (body[k] !== undefined && patch[k] === undefined) patch[k] = body[k];
  }
  const s = sanitizeItemPatch(patch, b);
  if (!s.ok) return err(s.reason);
  if (!Object.keys(s.patch).length) return noWrite({ item: it });
  Object.assign(it, s.patch);
  store.pushHistory(it, { kind: 'updated', text: '更新字段：' + Object.keys(s.patch).join('、'), by });
  store.pushActivity(b, { kind: 'updated', text: `更新任务：${it.title}`, engagementId: it.engagementId, itemId: it.id, by });
  return okr({ item: it });
}

function moveItemAction(root, b, body) {
  const by = byOf(body);
  const id = pickString(body.id, 40);
  const it = findById(b.items, id);
  if (!it) return err(`任务不存在：${id || '(空)'}`, 'NOT_FOUND');
  const patch = isPlainObject(body.patch) ? body.patch : {};
  const lane = pickString(patch.stage || body.stage, 20);
  if (!schema.isLane(lane)) return err(`非法泳道：${lane || '(空)'}（${schema.LANE_KEYS.join('|')}）`);
  const force = !!(patch.force || body.force);
  const evidence = pickString(patch.evidence || body.evidence, 500);
  if (lane === 'done' && !(it.reports || []).length && !evidence && !force) {
    return err('进入「已完成」需要至少 1 条回报或人工证据文本（可 force 覆盖）', 'BLOCKED', { blocked: true, missing: [{ type: 'manual', key: 'evidence', label: '回报或人工证据' }] });
  }
  if (it.stage === lane && !evidence) return noWrite({ item: it, warning: '', moved: false });
  let warning = '';
  if (lane === 'doing') {
    const lim = schema.wipLimitOf(b.settings, 'doing');
    const count = (b.items || []).filter((x) => x.stage === 'doing' && x.id !== it.id).length;
    if (lim && count >= lim) warning = `WIP 已满：进行中 ${count} 个（上限 ${lim}），建议先推进再拉新`;
  }
  if (!moveItem(it, lane, by)) return noWrite({ item: it, warning, moved: false });
  if (evidence) store.pushHistory(it, { kind: 'updated', text: '人工证据：' + evidence, by });
  if (lane === 'done' || lane === 'canceled') it.attention = null;
  store.pushActivity(b, { kind: 'moved', text: `任务「${it.title}」→ ${schema.laneLabel(lane)}`, engagementId: it.engagementId, itemId: it.id, by });
  return okr({ item: it, warning, moved: true });
}

function reportItem(root, b, body) {
  const by = byOf(body);
  const id = pickString(body.id, 40);
  const it = findById(b.items, id);
  if (!it) return err(`任务不存在：${id || '(空)'}`, 'NOT_FOUND');
  const rep = isPlainObject(body.report) ? body.report : body;
  const kind = pickString(rep.kind, 20);
  const kinds = ['progress', 'ready', 'blocked', 'failed', 'dropped'];
  if (!kinds.includes(kind)) return err(`report.kind 必须是 ${kinds.join('|')}`);
  const text = pickString(rep.text, 2000);
  if (!text) return err('report.text 不能为空（≤300 字摘要 + 文件路径）');
  const artifacts = Array.isArray(rep.artifacts) ? rep.artifacts.map((a) => pickString(a, 500)).filter(Boolean).slice(0, 30) : [];
  const now = store.nowIso();
  let warning = '';
  if (body.sessionId && it.sessionId && body.sessionId !== it.sessionId) {
    warning = '会话 id 与任务关联会话不一致（仅警告，不阻断）';
  }
  it.reports.push({ at: now, kind, text, artifacts });
  let lane = it.stage;
  let attention = null;
  if (kind === 'ready') { lane = 'review'; it.attention = null; }
  else if (kind === 'blocked') {
    lane = 'waiting';
    attention = { kind: 'blocked', question: text, askedAt: now, askedBy: by };
    it.attention = attention;
  } else if (kind === 'failed') {
    if (it.stage !== 'doing') lane = 'doing';
    attention = { kind: 'blocked', question: text, askedAt: now, askedBy: by };
    it.attention = attention;
  } else if (kind === 'dropped') { lane = 'canceled'; it.attention = null; }
  if (lane !== it.stage) moveItem(it, lane, by);
  store.pushHistory(it, { kind: 'report', text: `${kind}：${text.slice(0, 120)}`, by });
  const eng = it.engagementId ? findById(b.engagements, it.engagementId) : null;
  store.pushActivity(b, { kind: 'report', text: `回报（${kind}）：${it.title}`, engagementId: it.engagementId, itemId: it.id, by });
  if (eng) store.pushTimeline(eng, { kind: 'report', text: `任务「${it.title}」回报：${kind}`, by });
  const res = okr({ item: it, attention, lane });
  if (warning) res.warning = warning;
  return res;
}

function deleteItem(root, b, body) {
  /* 红线（F1 / spec §6）：删除任务只能由人在面板执行，agent 工具来源一律拒绝。 */
  if (byOf(body) === 'agent') {
    return err('删除任务只能由人在面板执行（agent 红线：只能准备、建议、提问）', 'BLOCKED');
  }
  const by = byOf(body);
  const id = pickString(body.id, 40);
  const idx = (b.items || []).findIndex((x) => x.id === id);
  if (idx < 0) return err(`任务不存在：${id || '(空)'}`, 'NOT_FOUND');
  const it = b.items[idx];
  b.items.splice(idx, 1);
  b.proposals = (b.proposals || []).filter((p) => p.itemId !== it.id);
  store.pushActivity(b, { kind: 'updated', text: `删除任务：${it.title}`, engagementId: it.engagementId, by });
  return okr({ deleted: { id: it.id, title: it.title } });
}

/** 任务增改移/回报（POST /fde/item；工具 fde_item）。 */
export function item(root, body = {}) {
  const args = normalizeArgs(body);
  const action = pickString(args.action, 20);
  if (!['create', 'update', 'move', 'report', 'delete'].includes(action)) {
    return err(`未知 action：${action || '(空)'}（create|update|move|report|delete）`);
  }
  /* 工具层红线：fde_item 不提供 delete（宿主层同样拒绝 agent 来源）。 */
  if (action === 'delete' && byOf(args) === 'agent') {
    return err('删除任务只能由人在面板执行（agent 红线）', 'BLOCKED');
  }
  return runAction(root, (b) => {
    switch (action) {
      case 'create': return createItem(root, b, args);
      case 'update': return updateItem(root, b, args);
      case 'move': return moveItemAction(root, b, args);
      case 'report': return reportItem(root, b, args);
      case 'delete': return deleteItem(root, b, args);
      default: return err('未知 action：' + action);
    }
  });
}

/* ============================ attention ============================ */

/** 注意力提问/解决/列表（POST /fde/attention；工具 fde_attention）。 */
export function attention(root, body = {}) {
  const args = normalizeArgs(body);
  const action = pickString(args.action, 20);
  const target = pickString(args.target, 20) || 'engagement';
  if (!['engagement', 'item'].includes(target)) return err('target 必须是 engagement|item');
  if (!['ask', 'resolve', 'list'].includes(action)) return err(`未知 action：${action || '(空)'}（ask|resolve|list）`);
  const by = byOf(args);

  if (action === 'list') {
    const pre = load(root);
    if (!pre.ok) return pre;
    const list = rules.derivedAttention(root, pre.board, { ttlMs: ttlOf(pre.board) });
    return okr({ list, attention: list });
  }

  return runAction(root, (b) => {
    const id = pickString(args.id, 40);
    const obj = target === 'engagement' ? findById(b.engagements, id) : findById(b.items, id);
    if (!obj) return err(`${target === 'engagement' ? '客户' : '任务'}不存在：${id || '(空)'}`, 'NOT_FOUND');

    if (action === 'ask') {
      const kind = pickString(args.kind, 20) || 'decision';
      if (!schema.ATTENTION_EXPLICIT_KINDS.includes(kind)) return err(`attention.kind 必须是 ${schema.ATTENTION_EXPLICIT_KINDS.join('|')}`);
      const question = pickString(args.question, 1000);
      if (!question) return err('question 不能为空');
      const now = store.nowIso();
      const att = { kind, question, askedAt: now, askedBy: by };
      obj.attention = att;
      if (target === 'engagement') store.pushTimeline(obj, { kind: 'attention', text: `提问（${kind}）：${question}`, by });
      else store.pushHistory(obj, { kind: 'attention', text: `提问（${kind}）：${question}`, by });
      store.pushActivity(b, { kind: 'attention', text: `注意力：${question.slice(0, 80)}`, engagementId: target === 'engagement' ? obj.id : obj.engagementId, itemId: target === 'item' ? obj.id : '', by });
      return okr({ attention: att });
    }

    /* resolve */
    const answer = pickString(args.answer, 2000);
    const had = obj.attention;
    if (!had) return noWrite({ attention: null, cleared: false, warning: '该对象没有显式注意力' });
    /* 红线（spec §6/§7；Phase 3 · 审查 F-20）：decision/blocked 是「需要人拍板/受阻」的显式注意力，
     * agent 来源不得自行 resolve；answer/question 仍可由 agent 记录人的回答。 */
    if (by === 'agent' && (had.kind === 'decision' || had.kind === 'blocked')) {
      return err('需要决定/受阻的注意力只能由人在面板处理（agent 红线：不要自行替人清除，可继续用 ask 补充信息）', 'BLOCKED');
    }
    obj.attention = null;
    const now = store.nowIso();
    if (target === 'engagement') store.pushTimeline(obj, { kind: 'attention', text: `已解决（${had.kind}）：${answer || '无补充'}`, by });
    else store.pushHistory(obj, { kind: 'attention', text: `已解决（${had.kind}）：${answer || '无补充'}`, by });
    store.pushActivity(b, { kind: 'attention', text: `注意力已解决：${had.question.slice(0, 60)}`, engagementId: target === 'engagement' ? obj.id : obj.engagementId, itemId: target === 'item' ? obj.id : '', by });
    return okr({ attention: null, cleared: true, answer, resolvedAt: now });
  });
}

/* ============================ gate ============================ */

/** 门禁评估/人工勾选/放行（POST /fde/gate）。
 *  红线（F1/spec §7）：agent 工具来源（by:'agent'）只允许只读评估；
 *  带 checks/force 的写操作与阶段推进一样只能由人在面板执行。 */
export function gate(root, body = {}) {
  const args = normalizeArgs(body);
  const guard = agentGuard(args, 'gate');
  if (guard) return guard;
  return runAction(root, (b) => gateEvaluate(root, b, args));
}

/* ============================ adopt ============================ */

/** 扫描/导入旧项目（POST /fde/adopt）。 */
export function adopt(root, body = {}) {
  const action = pickString(body.action, 20) || 'scan';

  if (action === 'scan') {
    const pre = load(root);
    if (!pre.ok) return pre;
    const candidates = store.adoptScan(root, pre.board);
    return okr({ candidates, scannedAt: store.nowIso(), total: candidates.length });
  }

  if (action !== 'apply') return err(`未知 action：${action}（scan|apply）`);
  const dirs = Array.isArray(body.dirs) ? body.dirs : (body.dir ? [body.dir] : []);
  if (!dirs.length) return err('apply 需要 dirs 数组（先 scan 再让用户确认）');
  const by = byOf(body);

  return runAction(root, (b) => {
    const added = [];
    const skipped = [];
    const rejected = [];
    const now = store.nowIso();
    /* 候选只扫描一次（避免每个目录重扫全量；审计 O7）。 */
    let candMap = new Map();
    try { candMap = new Map(store.adoptScan(root, b).map((c) => [c.dir, c])); } catch { candMap = new Map(); }
    for (const rawDir of dirs.slice(0, 100)) {
      const dir = pickString(rawDir, 200);
      if (!dir) { rejected.push({ dir: String(rawDir), reason: '目录名为空' }); continue; }
      try { safeDirName(dir); } catch (e) { rejected.push({ dir, reason: '非法目录名：' + ((e && e.message) || e) }); continue; }
      /* F6：复用 safeProjectPath(realpath) 守卫——符号链接指向工作区外时 projectAbs 返回 ''，直接拒绝。 */
      const abs = store.projectAbs(root, dir);
      if (!abs) { rejected.push({ dir, reason: '目录越界或指向工作区外（不允许符号链接逃逸）' }); continue; }
      if (!existsSync(abs)) { rejected.push({ dir, reason: '目录不存在' }); continue; }
      const exist = (b.engagements || []).find((e) => e.dir === dir);
      if (exist) { skipped.push({ dir, reason: '已导入', engagementId: exist.id }); continue; }
      const scan = store.scanProjectArtifacts(root, dir, { ttlMs: 0, force: true });
      const suggestion = store.suggestStage(abs, scan);
      const title = candMap.get(dir);
      const e = {
        id: store.newEngagementId(),
        name: (title && title.title) || dir,
        company: bids.inferCompany((title && title.title) || dir) || '',
        shortName: '',
        dir,
        stage: suggestion.stage,
        stageSince: now,
        paused: false,
        priority: 'normal',
        owner: '',
        tags: [],
        source: { kind: 'import', ref: dir, at: now },
        value: { amount: 0, currency: 'CNY', note: '' },
        nextAction: { text: '', due: '', owner: '' },
        stakeholders: [],
        gateState: {},
        attention: null,
        bidWatch: { enabled: true, keywords: [], links: [], lastMatchAt: '' },
        sessionId: '',
        createdAt: now,
        adopted: true,
        timeline: [{
          at: now,
          kind: 'created',
          text: `从目录导入（建议阶段「${schema.stageLabel(suggestion.stage)}」，置信度 ${suggestion.confidence}；证据：${suggestion.evidence.join('、') || '仅目录存在'}）`,
          by,
        }],
      };
      /* 导入前的历史阶段视为已完成：记 forced 并写明原因，保持可审计、可回滚。 */
      for (const st of schema.ENGAGEMENT_STAGES) {
        if (st.order >= schema.stageOrder(suggestion.stage)) break;
        e.gateState[st.key] = { status: 'forced', checks: {}, forced: true, reason: '导入既有项目：历史阶段产物已在磁盘上', at: now };
        store.pushTimeline(e, { kind: 'gate', text: `历史门禁「${st.label}」按导入处理（forced）`, by: 'system' });
      }
      b.engagements.push(e);
      added.push({ dir, engagementId: e.id, stage: suggestion.stage });
      store.pushActivity(b, { kind: 'adopt', text: `导入客户：${dir}`, engagementId: e.id, by });
    }

    const payload = { added, skipped, rejected, written: added.length > 0 };
    return added.length ? okr(payload) : noWrite(payload);
  });
}

/* ============================ handoff ============================ */

/** 客户阶段 handoff 的执行任务标题（含阶段名；用于「创建或复用」判定）。 */
function handoffItemTitle(engagement) {
  return `执行任务：${schema.stageLabel(engagement.stage)} · ${engagement.name}`;
}

/**
 * 确保客户有一个 open 的执行任务（F2 / spec §9）：
 * source.kind=agent、ref=handoff、泳道 todo|doing，标题含当前阶段名；已存在则复用。
 */
function ensureExecutionItem(root, engagementId, by) {
  return runAction(root, (b) => {
    const e = findById(b.engagements, engagementId);
    if (!e) return err(`客户不存在：${engagementId || '(空)'}`, 'NOT_FOUND');
    if (!schema.isStage(e.stage)) return err('客户已归档/流失，不发起阶段会话；需要复盘用 intent=harvest', 'CONFLICT');
    const title = handoffItemTitle(e);
    const existing = (b.items || []).find((it) => it.engagementId === e.id &&
      it.source && it.source.kind === 'agent' && it.source.ref === 'handoff' &&
      ['todo', 'doing'].includes(it.stage) && it.title === title);
    if (existing) return noWrite({ item: existing, reused: true });
    const now = store.nowIso();
    const it = {
      id: store.newItemId(),
      engagementId: e.id,
      title,
      type: schema.isItemType(e.stage) ? e.stage : 'followup',
      stage: 'doing',
      priority: e.priority || 'normal',
      due: (e.nextAction && e.nextAction.due) || '',
      owner: 'agent',
      source: { kind: 'agent', ref: 'handoff', at: now },
      autonomy: { mode: (b.settings && b.settings.autonomy) || 'observe', rule: 'handoff' },
      attention: null,
      reports: [],
      sessionId: '',
      createdAt: now,
      history: [{ at: now, kind: 'created', text: '由 handoff 创建执行任务（回报闭环）', by }],
    };
    b.items.push(it);
    store.pushActivity(b, { kind: 'created', text: `执行任务：${it.title}`, engagementId: e.id, itemId: it.id, by });
    return okr({ item: it, reused: false });
  });
}

/**
 * 按阶段发起会话（POST /fde/handoff）。
 * 客户目标：先创建/复用执行任务，把 itemId 写进提示词并返回（F2 闭环）。
 * 工作区选择由依赖注入的 handoff 负责（优先当前/匹配工作区，其次 updatedAt 最新）。
 * @param {string} root
 * @param {{target?:string, id?:string, intent?:string, by?:string}} body
 * @param {{handoff?:Function, skillsAvailable?:boolean}} [deps]
 */
export async function handoff(root, body = {}, deps = {}) {
  const args = normalizeArgs(body);
  const target = pickString(args.target, 20) || 'engagement';
  if (!['engagement', 'item'].includes(target)) return err('target 必须是 engagement|item');
  const id = pickString(args.id, 40);
  const intent = pickString(args.intent, 20) || 'stage';
  const by = byOf(args);
  let prompt = '';
  let engagement = null;
  let item = null;
  let gate = null;
  let contextBoard = null;
  let reusedItem = false;

  if (target === 'engagement') {
    const ensured = ensureExecutionItem(root, id, by);
    if (!ensured.ok) return ensured;
    item = ensured.item;
    reusedItem = !!ensured.reused;
    contextBoard = ensured.board;
    engagement = findById(contextBoard.engagements, id) || null;
    if (!engagement) return err(`客户不存在：${id || '(空)'}`, 'NOT_FOUND');
    const ttl = ttlOf(contextBoard);
    const ng = rules.nextGate(engagement) || rules.currentGate(engagement);
    if (ng) gate = rules.evaluateGate(root, engagement, ng.gateKey, { ttlMs: ttl });
    prompt = prompts.buildPrompt('engagement', {
      root,
      engagement,
      item,
      intent,
      gate,
      stayDays: rules.stageStayDays(engagement),
      hasSkills: !!deps.skillsAvailable,
    });
  } else {
    const pre = load(root);
    if (!pre.ok) return pre;
    contextBoard = pre.board;
    item = findById(contextBoard.items, id);
    if (!item) return err(`任务不存在：${id || '(空)'}`, 'NOT_FOUND');
    engagement = item.engagementId ? findById(contextBoard.engagements, item.engagementId) : null;
    prompt = prompts.buildPrompt('item', { root, item, engagement, intent });
  }

  if (typeof deps.handoff !== 'function') {
    return err('本部署未挂载 sessionController，无法自动开会话——请把 prompt 内容粘贴到对话框继续', 'INTERNAL', { prompt, sessionId: '', itemId: item ? item.id : '' });
  }
  const hr = await deps.handoff(prompt, { root });
  if (!hr || !hr.ok) {
    return err((hr && hr.reason) || '创建会话失败', 'INTERNAL', { prompt, sessionId: '', itemId: item ? item.id : '' });
  }
  const sessionId = hr.sessionId || '';
  /* 会话创建在事务外（避免冲突重试时重复建会话）；写回用 CAS 事务，绝不覆盖并发写。 */
  const wrote = runAction(root, (b) => {
    const now = store.nowIso();
    if (target === 'engagement') {
      const e = findById(b.engagements, id);
      if (!e) return err('客户在会话创建后消失（可能被并发归档/删除）', 'NOT_FOUND');
      e.sessionId = sessionId;
      store.pushTimeline(e, { kind: 'session', text: `发起会话 ${sessionId}（${intent}）`, by });
      const it = item ? findById(b.items, item.id) : null;
      if (it) {
        it.sessionId = sessionId;
        store.pushHistory(it, { kind: 'report', text: `发起会话 ${sessionId}（${intent}）`, by });
      }
      store.pushActivity(b, { kind: 'session', text: `会话 ${sessionId}：${e.name}`, engagementId: e.id, itemId: it ? it.id : '', by });
      return okr({});
    }
    const it = findById(b.items, id);
    if (!it) return err('任务在会话创建后消失（可能被并发删除）', 'NOT_FOUND');
    it.sessionId = sessionId;
    store.pushHistory(it, { kind: 'report', text: `发起会话 ${sessionId}（${intent}）`, by });
    store.pushActivity(b, { kind: 'session', text: `会话 ${sessionId}：${it.title}`, engagementId: it.engagementId, itemId: it.id, by });
    return okr({});
  });
  if (!wrote.ok) {
    return err(wrote.reason || '会话已创建但写 board 失败', 'INTERNAL', { prompt, sessionId, itemId: item ? item.id : '' });
  }
  return okr({
    sessionId,
    prompt,
    target,
    gate,
    missing: gate ? gate.missing : [],
    itemId: item ? item.id : '',
    item: item || null,
    reusedItem,
    workspace: hr.workspace || '',
  });
}

/* ============================ proposal ============================ */

/** 采纳/忽略建议（POST /fde/proposal）。 */
export async function proposal(root, body = {}, deps = {}) {
  const args = normalizeArgs(body);
  const by = byOf(args);
  const id = pickString(args.id, 40);
  const action = pickString(args.action, 20);
  if (!['accept', 'dismiss'].includes(action)) return err(`未知 action：${action || '(空)'}（accept|dismiss）`);
  const pre = load(root);
  if (!pre.ok) return pre;
  const p0 = findById(pre.board.proposals, id);
  if (!p0) return err(`建议不存在：${id || '(空)'}`, 'NOT_FOUND');
  if (p0.status !== 'pending') return err('建议已处理（status=' + p0.status + '）', 'CONFLICT');

  if (action === 'dismiss') {
    return runAction(root, (b) => {
      const p = findById(b.proposals, id);
      if (!p) return err(`建议不存在：${id || '(空)'}`, 'NOT_FOUND');
      if (p.status !== 'pending') return err('建议已处理（status=' + p.status + '）', 'CONFLICT');
      p.status = 'dismissed';
      p.decidedAt = store.nowIso();
      store.pushActivity(b, { kind: 'proposal', text: `忽略建议：${p.title}`, engagementId: p.engagementId, itemId: p.itemId, by });
      return okr({ proposal: p });
    });
  }

  /* start_session 需要真实创建会话（安全动作之外，必须有会话服务） */
  if (p0.kind === 'start_session') {
    if (typeof deps.handoff !== 'function') return err('本部署无法创建会话，无法采纳 start_session 建议', 'BLOCKED');
    const payload = p0.payload || {};
    const target = p0.itemId ? 'item' : 'engagement';
    const hid = p0.itemId || p0.engagementId;
    const hr = await handoff(root, { target, id: hid, intent: payload.intent || 'stage' }, deps);
    if (!hr.ok) return hr;
    /* handoff 内部已按 CAS 写回 board；这里再读改写一次标记建议状态（不再用旧快照整份覆盖）。 */
    const wrote = runAction(root, (b) => {
      const p = findById(b.proposals, id);
      if (!p) return err('建议在会话创建后消失（可能被并发忽略）', 'NOT_FOUND');
      if (p.status !== 'pending') return err('建议已被并发处理（status=' + p.status + '）', 'CONFLICT');
      p.status = 'accepted';
      p.decidedAt = store.nowIso();
      p.payload = Object.assign({}, p.payload || {}, { sessionId: hr.sessionId });
      store.pushActivity(b, { kind: 'proposal', text: `采纳建议并创建会话：${p.title}`, engagementId: p.engagementId, itemId: p.itemId, by });
      return okr({ proposal: p, sessionId: hr.sessionId });
    });
    if (!wrote.ok) return err(wrote.reason, wrote.code, { sessionId: hr.sessionId, prompt: hr.prompt });
    return okr({ board: wrote.board, proposal: wrote.proposal, sessionId: hr.sessionId, prompt: hr.prompt, itemId: hr.itemId });
  }

  return runAction(root, (b) => {
    const p = findById(b.proposals, id);
    if (!p) return err(`建议不存在：${id || '(空)'}`, 'NOT_FOUND');
    if (p.status !== 'pending') return err('建议已处理（status=' + p.status + '）', 'CONFLICT');
    const ex = executeProposal(b, p, store.nowIso(), by);
    if (!ex.ok) return err(ex.reason || '执行建议失败', 'INTERNAL');
    p.status = 'accepted';
    p.decidedAt = store.nowIso();
    store.pushActivity(b, { kind: 'proposal', text: `采纳建议：${p.title}`, engagementId: p.engagementId, itemId: p.itemId, by });
    return okr({ proposal: p, applied: ex.applied || {} });
  });
}

/** 执行 proposal payload（只做安全动作：建 item / 改 nextAction / 改 due）。 */
function executeProposal(board, p, now, by) {
  const actor = by || 'agent';
  const payload = p.payload || {};
  const applied = {};
  try {
    if (p.kind === 'create_item' || isPlainObject(payload.item)) {
      const spec = isPlainObject(payload.item) ? payload.item : payload;
      const isBid = !!pickString(spec.bidId, 300);
      const title = isBid
        ? `跟进招标：${pickString(spec.title, 160) || p.title || '招采公告'}`
        : (pickString(spec.title, 200) || p.title || '跟进');
      const lane = schema.isLane(spec.stage) ? spec.stage : 'todo';
      const it = {
        id: store.newItemId(),
        engagementId: p.engagementId || '',
        title,
        type: isBid ? 'followup' : (schema.isItemType(spec.type) ? spec.type : 'followup'),
        stage: lane,
        priority: schema.isPriority(spec.priority) ? spec.priority : 'normal',
        due: store.isDueStr(spec.due) ? spec.due : '',
        owner: ['human', 'agent', 'both'].includes(spec.owner) ? spec.owner : 'human',
        source: { kind: 'agent', ref: 'proposal:' + p.id, at: now },
        autonomy: { mode: (board.settings && board.settings.autonomy) || 'observe', rule: p.ruleId },
        attention: null,
        reports: [],
        sessionId: '',
        createdAt: now,
        history: [{ at: now, kind: 'created', text: `由建议 ${p.ruleId} 创建`, by: actor }],
        bidRefs: isBid ? [{
          bidId: pickString(spec.bidId, 300),
          title: pickString(spec.title, 300),
          date: pickString(spec.date, 20),
          url: pickString(spec.url, 500),
          relation: pickString(spec.relation, 20) || 'mention',
        }] : [],
      };
      board.items.push(it);
      applied.item = it.id;
      store.pushActivity(board, { kind: 'created', text: `按建议创建任务：${it.title}`, engagementId: it.engagementId, itemId: it.id, by: actor });
    }
    if (p.kind === 'update_next' || p.kind === 'nudge') {
      const patch = isPlainObject(payload.patch) ? payload.patch : {};
      if (p.engagementId && isPlainObject(patch.nextAction)) {
        const e = findById(board.engagements, p.engagementId);
        if (e) {
          e.nextAction = Object.assign({ text: '', due: '', owner: '' }, e.nextAction || {}, patch.nextAction);
          store.pushTimeline(e, { kind: 'note', text: `采纳建议：${p.title}`, by: actor });
          applied.nextAction = e.nextAction;
        }
      }
      if (p.itemId && store.isDueStr(patch.due)) {
        const it = findById(board.items, p.itemId);
        if (it) {
          it.due = patch.due;
          store.pushHistory(it, { kind: 'updated', text: `采纳建议改期至 ${patch.due}`, by: actor });
          applied.due = it.due;
        }
      }
    }
    return { ok: true, applied };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

/**
 * 按自主性模式执行安全建议（fde_brief apply=true 用；红线动作永不执行）。
 * F4：忽略调用方传入的 board（可能是带派生 artifacts 的响应副本），一律从磁盘重新 load 原始状态再写。
 */
export function applySafeProposals(root, _ignoredBoard) {
  return runAction(root, (board) => {
    const mode = (board.settings && board.settings.autonomy) || 'observe';
    const safeRuleIds = new Set(schema.RULES.filter((r) => r.safe).map((r) => r.ruleId));
    const pending = (board.proposals || []).filter((p) => p.status === 'pending');
    if (mode === 'observe') return noWrite({ applied: [], skipped: pending.map((p) => p.id), mode });
    const applied = [];
    const skipped = [];
    const now = store.nowIso();
    for (const p of pending) {
      if (!safeRuleIds.has(p.ruleId) || p.kind === 'start_session') { skipped.push(p.id); continue; }
      const ex = executeProposal(board, p, now, 'agent');
      if (!ex.ok) { skipped.push(p.id); continue; }
      p.status = 'accepted';
      p.decidedAt = now;
      store.pushActivity(board, { kind: 'proposal', text: `自动执行安全建议（${mode}）：${p.title}`, engagementId: p.engagementId, itemId: p.itemId, by: 'agent' });
      applied.push(p.id);
    }
    if (!applied.length) return noWrite({ applied, skipped, mode });
    return okr({ applied, skipped, mode });
  });
}

/* ============================ settings ============================ */
/* ============================ settings ============================ */

/** 修改设置（POST /fde/settings）。 */
export function settings(root, body = {}) {
  const patch = isPlainObject(body.patch) ? body.patch : body;
  return runAction(root, (b) => {
  const by = byOf(body);
  const next = Object.assign({}, b.settings || {});
  const appliedKeys = [];
  const invalid = [];

  const wantNum = (v, min, max) => Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max;

  if ('autonomy' in patch) {
    if (!schema.isAutonomy(patch.autonomy)) invalid.push('autonomy 必须是 observe|assisted|auto');
    else { next.autonomy = patch.autonomy; appliedKeys.push('autonomy'); }
  }
  if ('stallDays' in patch) {
    if (!wantNum(patch.stallDays, 1, 365)) invalid.push('stallDays 应为 1..365');
    else { next.stallDays = Math.round(Number(patch.stallDays)); appliedKeys.push('stallDays'); }
  }
  if ('wipLimits' in patch) {
    if (!isPlainObject(patch.wipLimits)) invalid.push('wipLimits 必须为对象');
    else {
      const wip = Object.assign({ doing: 5 }, next.wipLimits || {});
      for (const k of Object.keys(patch.wipLimits)) {
        if (!schema.isLane(k)) { invalid.push('wipLimits 未知泳道：' + k); continue; }
        if (!wantNum(patch.wipLimits[k], 1, 50)) { invalid.push(`wipLimits.${k} 应为 1..50`); continue; }
        wip[k] = Math.round(Number(patch.wipLimits[k]));
      }
      next.wipLimits = wip;
      appliedKeys.push('wipLimits');
    }
  }
  if ('sources' in patch) {
    if (!isPlainObject(patch.sources)) invalid.push('sources 必须为对象');
    else {
      const src = Object.assign({ folderWatch: true, briefOnOpen: true, bidWatch: false }, next.sources || {});
      for (const k of Object.keys(patch.sources)) {
        if (typeof patch.sources[k] !== 'boolean') { invalid.push(`sources.${k} 必须为布尔`); continue; }
        src[k] = patch.sources[k];
      }
      next.sources = src;
      appliedKeys.push('sources');
    }
  }
  if ('workdirs' in patch) {
    if (!Array.isArray(patch.workdirs)) invalid.push('workdirs 必须为数组');
    else {
      next.workdirs = patch.workdirs.map((w) => pickString(w, 60)).filter(Boolean).slice(0, 10);
      appliedKeys.push('workdirs');
    }
  }
  if ('cacheTtlMs' in patch) {
    if (!wantNum(patch.cacheTtlMs, 0, 60000)) invalid.push('cacheTtlMs 应为 0..60000');
    else { next.cacheTtlMs = Math.round(Number(patch.cacheTtlMs)); appliedKeys.push('cacheTtlMs'); }
  }
  if ('bidSignalDays' in patch) {
    if (!wantNum(patch.bidSignalDays, 1, 365)) invalid.push('bidSignalDays 应为 1..365');
    else { next.bidSignalDays = Math.round(Number(patch.bidSignalDays)); appliedKeys.push('bidSignalDays'); }
  }
  /* ADR 0006：演示模式开关。false = 允许在空看板显示示例；true = 已清除且不再显示。 */
  if ('demoDismissed' in patch) {
    if (typeof patch.demoDismissed !== 'boolean') invalid.push('demoDismissed 必须为布尔');
    else { next.demoDismissed = patch.demoDismissed; appliedKeys.push('demoDismissed'); }
  }
  if (invalid.length) return err(invalid.join('；'));
  if (!appliedKeys.length) return noWrite({ settings: next, appliedKeys, already: true });
  b.settings = next;
  store.pushActivity(b, { kind: 'updated', text: '修改设置：' + appliedKeys.join('、'), by });
  return okr({ settings: next, appliedKeys });
  });
}

/* ============================ sync ============================ */

/** 重扫工件/刷新派生数据（POST /fde/sync）。 */
export function sync(root, body = {}) {
  store.clearScanCache();
  let refreshed = null;
  const res = runAction(root, (b) => {
    const ttl = ttlOf(b);
    let targets = b.engagements || [];
    let filterId = '';
    if (body.engagementId) {
      const e = findById(b.engagements, body.engagementId);
      if (!e) return err(`客户不存在：${body.engagementId}`, 'NOT_FOUND');
      targets = [e];
      filterId = e.id;
    }
    const artifacts = {};
    for (const e of targets) {
      if (!e.dir) { artifacts[e.id] = store.summarizeArtifacts(null); continue; }
      artifacts[e.id] = store.summarizeArtifacts(store.scanProjectArtifacts(root, e.dir, { ttlMs: 0, force: true }));
    }
    const pr = rules.refreshProposals(root, b, { ttlMs: ttl });
    refreshed = { engagementId: filterId, engagements: targets.map((e) => e.id), artifacts, proposalsAdded: pr.added.length, scannedAt: store.nowIso() };
    /* 只有新增建议才落盘（其余刷新结果都是派生数据，不写状态文件）。 */
    return pr.added.length ? okr({}) : noWrite({});
  });
  if (!res.ok) return res;
  const b = res.board;
  const ttl = ttlOf(b);
  const attention = rules.derivedAttention(root, b, { ttlMs: ttl });
  const stats = rules.computeStats(root, b, attention);
  return okr({
    root,
    board: b,
    refreshed,
    attention,
    stats,
    meta: schema.meta(),
  });
}

/* ============================ health ============================ */

/**
 * 自检（GET /fde/health）。返回 {ok, healthy, checks:[{name,status,detail}]}；
 * 单项失败不抛异常。status：ok | warn | fail。
 * @param {{skills?:{available:boolean,registered:number,error?:string}}} [deps]
 */
export function health(root, deps = {}) {
  const checks = [];
  const push = (name, status, detail) => checks.push({ name, status, detail });
  const r = store.readBoard(root);
  let b = null;
  if (r.ok) {
    b = r.board;
    push('board 可读', 'ok', r.fresh ? 'board.json 不存在（首次使用，读写时自动创建）' : '已读取，version=' + b.version);
    const v = store.validateBoard(b);
    push('board 结构', v.ok ? 'ok' : 'fail', v.ok ? '字段与引用校验通过' : v.reason);
    push('schema 版本', b.version === schema.SCHEMA_VERSION ? 'ok' : 'fail', `board.version=${b.version}，插件支持 ${schema.SCHEMA_VERSION}`);
    const missingDirs = (b.engagements || []).filter((e) => e.dir && !existsSync(store.projectAbs(root, e.dir))).map((e) => e.dir);
    push('客户目录一致', missingDirs.length ? 'warn' : 'ok', missingDirs.length ? `${missingDirs.length} 个目录不存在：${missingDirs.slice(0, 5).join('、')}` : '全部存在');
  } else {
    push('board 可读', 'fail', r.reason);
    b = null;
  }
  push('状态目录可写', store.canWriteDir(store.fdeDir(root)) ? 'ok' : 'fail', store.fdeDir(root));
  const bk = store.backupsDir(root);
  push('备份目录', existsSync(bk) ? 'ok' : 'warn', existsSync(bk) ? `已存在，保留最近 ${store.listBackups(root).length} 份` : '尚未创建（首次写 board 时创建）');
  const sk = deps.skills || {};
  if (sk.available) push('skills 注册', sk.registered > 0 ? 'ok' : 'warn', `已注册 ${sk.registered} 个技能`);
  else push('skills 注册', 'warn', 'skills 服务不可用或未注册：降级为系统提示词列出技能路径（不影响其他功能）');
  /* 招采雷达（spec §17.8）：服务可用且 records>0 → ok；未装载/旧版本 → warn（不 fail，FDE 其余功能不受影响）。 */
  const bidSvc = deps.bidIntel || null;
  if (bids.isAvailable(bidSvc)) {
    let meta = null;
    try { meta = bidSvc.dataMeta(); } catch { meta = null; }
    const records = Number(meta && meta.records) || 0;
    push('招采雷达服务', records > 0 ? 'ok' : 'warn', records > 0
      ? `bid-intel 已就绪：${records} 条公告（mtime=${meta ? meta.mtime : '?'}）`
      : 'bid-intel 已装载但索引为空（可先运行采集/导入）');
  } else {
    push('招采雷达服务', 'warn', 'bid-intel 未装载或未升级：招采功能降级 available:false，其余功能不受影响');
  }
  const healthy = checks.every((c) => c.status !== 'fail');
  return { ok: true, healthy, checks, root, checkedAt: store.nowIso() };
}

/* ============================ meta ============================ */

const HERE = dirname(fileURLToPath(import.meta.url));
/** 插件根目录（src/host 的上两级）。 */
export function pluginRoot() { return resolve(HERE, '..', '..'); }
export function skillsDir() { return join(pluginRoot(), 'skills'); }

/**
 * 极简 frontmatter 解析（不引入 yaml 依赖）：只取 `key: value` 标量行。
 * @returns {{frontmatter:Object<string,string>, body:string}}
 */
export function parseSkillFrontmatter(raw) {
  const text = String(raw || '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: {}, body: text };
  const frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    frontmatter[kv[1]] = v;
  }
  return { frontmatter, body: text.slice(m[0].length) };
}

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 扫描插件 skills/*\/SKILL.md，返回可注册的技能定义（目录为空/损坏一律跳过，不抛异常）。
 * @returns {Array<{name,description,content,path,resourceBase}>}
 */
export function discoverSkills(dir) {
  const base = dir || skillsDir();
  const out = [];
  try {
    if (!existsSync(base)) return out;
    for (const name of readdirSync(base)) {
      const file = join(base, name, 'SKILL.md');
      if (!existsSync(file)) continue;
      try {
        const raw = readFileSync(file, 'utf8');
        const { frontmatter, body } = parseSkillFrontmatter(raw);
        const skillName = (frontmatter.name || name).trim();
        const description = (frontmatter.description || '').trim();
        if (!SKILL_NAME_RE.test(skillName)) continue;
        if (!description) continue;
        out.push({
          name: skillName,
          description,
          content: body && body.trim() ? body : raw,
          path: file,
          resourceBase: { kind: 'directory', path: join(base, name) },
        });
      } catch { /* 单个技能失败不影响其他 */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* 目录不可读：降级为空 */ }
  return out;
}

/** 阶段/泳道/门禁定义（GET /fde/meta）。 */
export function meta() {
  const m = schema.meta();
  const skills = discoverSkills().map((s) => ({ name: s.name, description: s.description, path: s.path }));
  return okr({ meta: Object.assign({}, m, { skills }) });
}

/* ============================ 招采雷达 API（spec §17.4） ============================ */

function bidMatchStats(match) {
  const m = match || {};
  const totalNum = Number(m.total) || 0;
  return {
    total: totalNum,
    /* 真实量级（各查询 search.total 最大值）；total 只是采样去重数（见 spec §17.3 口径）。 */
    approxTotal: Math.max(Number(m.approxTotal) || 0, totalNum),
    tender: Number(m.tender) || 0,
    award: Number(m.award) || 0,
    candidate: Number(m.candidate) || 0,
    latest: m.latest || '',
  };
}

/** GET /fde/bids/stats：数据概况（服务不可用也 200 + available:false）。 */
export function bidsStats(root, opts = {}) {
  const service = bidServiceOf(opts);
  if (!bids.isAvailable(service)) {
    return okr({ available: false, reason: '招采雷达未就绪（bid-intel 未装载或未升级）', stats: null, dataMeta: null, bidStats: bids.bidStatsOf(null) });
  }
  let stats = null;
  let dataMeta = null;
  try { stats = service.stats ? service.stats() : null; } catch { stats = null; }
  try { dataMeta = service.dataMeta ? service.dataMeta() : null; } catch { dataMeta = null; }
  let bidStats = bids.bidStatsOf(service);
  const pre = load(root);
  if (pre.ok) bidStats = bidContext(pre.board, service, ttlOf(pre.board)).bidStats;
  return okr({ available: true, stats, dataMeta, bidStats });
}

/** GET /fde/bids/search：透传检索；给 engagementId 时逐项附 relation。 */
export function bidsSearch(root, body = {}, opts = {}) {
  const service = bidServiceOf(opts);
  if (!bids.isAvailable(service)) {
    return okr({ available: false, reason: '招采雷达未就绪（bid-intel 未装载或未升级）', total: 0, direct: 0, mentioned: 0, items: [], facets: null });
  }
  let engagement = null;
  const eid = pickString(body.engagementId, 40);
  if (eid) {
    const pre = load(root);
    if (!pre.ok) return pre;
    engagement = findById(pre.board.engagements, eid);
    if (!engagement) return err(`客户不存在：${eid}`, 'NOT_FOUND');
  }
  const r = bids.searchBids(service, {
    q: body.q,
    mode: body.mode,
    from: body.from,
    to: body.to,
    source: body.source,
    limit: body.limit,
    offset: body.offset,
    engagement,
  });
  return okr(r);
}

/** GET /fde/bids/match：客户匹配（refresh=1 强制失效缓存）。 */
export function bidsMatch(root, body = {}, opts = {}) {
  const service = bidServiceOf(opts);
  const eid = pickString(body.engagementId || body.id, 40);
  /* §17.1：服务不可用时所有 bids 路由 200 + available:false（先降级，再做参数/对象校验）。 */
  if (!bids.isAvailable(service)) {
    return okr({
      available: false, reason: '招采雷达未就绪（bid-intel 未装载或未升级）',
      engagementId: eid, queries: [], stats: null, items: [], linked: [],
    });
  }
  const pre = load(root);
  if (!pre.ok) return pre;
  const engagement = findById(pre.board.engagements, eid);
  if (!engagement) return err(`客户不存在：${eid || '(空)'}`, 'NOT_FOUND');
  const linked = bids.linksOf(engagement);
  const refresh = body.refresh === true || body.refresh === '1' || body.refresh === 'true';
  const match = bids.matchEngagement(service, engagement, { refresh, ttlMs: ttlOf(pre.board) });
  return okr({
    available: true,
    engagementId: engagement.id,
    queries: match.queries || [],
    stats: bidMatchStats(match),
    items: match.items || [],
    queryHits: match.queryHits || [],
    linked,
    cached: !!match.cached,
    generatedAt: match.generatedAt || '',
  });
}

/** POST /fde/bids/link：关联公告（幂等；by 如实）。 */
export function bidLink(root, body = {}, opts = {}) {
  const service = bidServiceOf(opts);
  if (!bids.isAvailable(service)) return okr({ available: false, reason: '招采雷达未就绪（bid-intel 未装载或未升级）', linked: false });
  const eid = pickString(body.engagementId, 40);
  const bidId = pickString(body.bidId, 300);
  if (!eid) return err('缺少 engagementId');
  if (!bidId) return err('缺少 bidId');
  const by = byOf(body);
  return runAction(root, (board) => {
    const e = findById(board.engagements, eid);
    if (!e) return err(`客户不存在：${eid}`, 'NOT_FOUND');
    const rec = bids.recordById(service, bidId);
    if (!rec) return err(`未找到公告：${bidId}`, 'NOT_FOUND');
    const r = bids.applyLink(board, e, { record: rec, bidId, relation: body.relation, note: body.note, by, now: store.nowIso() });
    if (!r.ok) return err(r.reason, r.code || 'INVALID');
    if (!r.changed) return noWrite({ available: true, link: r.link, engagement: e, changed: false, warning: '已关联，关系/备注已同步' });
    store.pushTimeline(e, { kind: 'note', text: `关联招采公告：${r.link.title || bidId}`, by });
    store.pushActivity(board, { kind: 'updated', text: `关联招采：${e.name} ← ${r.link.title || bidId}`, engagementId: e.id, by });
    return okr({ available: true, link: r.link, engagement: e, changed: true });
  });
}

/** POST /fde/bids/unlink：取消关联（幂等）。 */
export function bidUnlink(root, body = {}, opts = {}) {
  const service = bidServiceOf(opts);
  if (!bids.isAvailable(service)) return okr({ available: false, reason: '招采雷达未就绪（bid-intel 未装载或未升级）', linked: false });
  const eid = pickString(body.engagementId, 40);
  const bidId = pickString(body.bidId, 300);
  if (!eid) return err('缺少 engagementId');
  if (!bidId) return err('缺少 bidId');
  const by = byOf(body);
  return runAction(root, (board) => {
    const e = findById(board.engagements, eid);
    if (!e) return err(`客户不存在：${eid}`, 'NOT_FOUND');
    const r = bids.applyUnlink(board, e, bidId, by, store.nowIso());
    if (!r.ok) return err(r.reason, r.code || 'INVALID');
    if (!r.changed) return noWrite({ unlinked: false, changed: false, engagement: e });
    store.pushTimeline(e, { kind: 'note', text: `取消关联招采公告：${bidId}`, by });
    store.pushActivity(board, { kind: 'updated', text: `取消关联招采：${e.name}`, engagementId: e.id, by });
    return okr({ unlinked: true, changed: true, engagement: e });
  });
}

/** POST /fde/bids/promote：提升为跟进任务（item.bidRefs + link）。 */
export function bidPromote(root, body = {}, opts = {}) {
  const service = bidServiceOf(opts);
  if (!bids.isAvailable(service)) return okr({ available: false, reason: '招采雷达未就绪（bid-intel 未装载或未升级）' });
  const eid = pickString(body.engagementId, 40);
  const bidId = pickString(body.bidId, 300);
  if (!eid) return err('缺少 engagementId');
  if (!bidId) return err('缺少 bidId');
  const by = byOf(body);
  return runAction(root, (board) => {
    const e = findById(board.engagements, eid);
    if (!e) return err(`客户不存在：${eid}`, 'NOT_FOUND');
    const rec = bids.recordById(service, bidId);
    if (!rec) return err(`未找到公告：${bidId}`, 'NOT_FOUND');
    const r = bids.applyPromote(board, e, {
      record: rec, bidId, relation: body.relation, note: body.note,
      by, now: store.nowIso(), settings: board.settings,
    });
    if (!r.ok) return err(r.reason, r.code || 'INVALID');
    store.pushTimeline(e, { kind: 'note', text: `招采提升为跟进任务：${r.item.title}`, by });
    store.pushActivity(board, { kind: 'created', text: `招采提升：${r.item.title}`, engagementId: e.id, itemId: r.item.id, by });
    return okr({ available: true, item: r.item, link: r.link, engagement: e });
  });
}

/** POST /fde/bids/refresh：清缓存并返回最新匹配（可只针对单个客户）。 */
export function bidsRefresh(root, body = {}, opts = {}) {
  const service = bidServiceOf(opts);
  const eid = pickString(body.engagementId, 40);
  bids.clearBidCache(eid || null);
  if (!bids.isAvailable(service)) {
    return okr({ available: false, reason: '招采雷达未就绪（bid-intel 未装载或未升级）', refreshed: false, items: [], queries: [], stats: null });
  }
  if (!eid) {
    const pre = load(root);
    const bidStats = pre.ok ? bidContext(pre.board, service, ttlOf(pre.board)).bidStats : bids.bidStatsOf(service);
    return okr({ available: true, refreshed: true, scope: 'all', bidStats });
  }
  const by = byOf(body);
  let match = null;
  let engagement = null;
  const res = runAction(root, (board) => {
    const e = findById(board.engagements, eid);
    if (!e) return err(`客户不存在：${eid}`, 'NOT_FOUND');
    engagement = e;
    match = bids.matchEngagement(service, e, { refresh: true, ttlMs: ttlOf(board) });
    const w = bids.ensureBidWatch(e);
    w.lastMatchAt = store.nowIso();
    store.pushActivity(board, { kind: 'updated', text: `刷新招采匹配：${e.name}`, engagementId: e.id, by });
    return okr({});
  });
  if (!res.ok) return res;
  return okr({
    available: true,
    refreshed: true,
    engagementId: eid,
    queries: match ? match.queries : [],
    stats: bidMatchStats(match),
    items: match ? match.items : [],
    linked: engagement ? bids.linksOf(engagement) : [],
    cached: false,
  });
}

/** GET /fde/bids/timeline（工具 fde_bid action=timeline 用）：透传 bid-intel timeline。 */
export function bidsTimeline(root, body = {}, opts = {}) {
  const service = bidServiceOf(opts);
  if (!bids.isAvailable(service)) {
    return okr({ available: false, reason: '招采雷达未就绪（bid-intel 未装载或未升级）', byMonth: {} });
  }
  const args = {
    mode: body.mode || 'company',
    q: String(body.q || '').trim(),
    from: String(body.from || ''),
    to: String(body.to || ''),
    source: String(body.source || ''),
    limit: Math.min(Math.max(Number(body.limit) || 3000, 1), 5000),
  };
  if (!args.q) return err('timeline 需要 q（公司或采购单位关键字）');
  let r = null;
  try { r = service.timeline ? service.timeline(args) : null; } catch (e) {
    return err('招采时间线查询失败：' + String((e && e.message) || e), 'INTERNAL');
  }
  if (!r) return okr({ available: false, reason: '招采雷达未就绪（bid-intel 未装载或未升级）', byMonth: {} });
  return okr({ available: true, q: args.q, mode: args.mode, byMonth: r.byMonth || {}, total: r.total || 0, items: (r.items || []).slice(0, 20) });
}

/* ============================ harvest ============================ */

/**
 * 写复盘草稿（工具 fde_harvest）。
 * 落点：research/.fde/drafts/（状态目录内），不碰客户卷定稿；人审后再归档。
 * 与 spec §7 的「写 docs/retros/ 或客户卷」有偏差：§16.3 硬约束要求只写 research/.fde/，
 * 这里以硬约束为准，返回 next 说明归档去向。
 */
export function harvest(root, body = {}) {
  const args = normalizeArgs(body);
  const by = byOf(args);
  const text = pickString(args.text, 8000);
  if (!text) return err('text 不能为空（写清发生了什么、为什么、下次怎么做）');
  const pre = load(root);
  if (!pre.ok) return pre;
  const engagement = args.engagementId ? findById(pre.board.engagements, args.engagementId) : null;
  if (args.engagementId && !engagement) return err(`客户不存在：${args.engagementId}`, 'NOT_FOUND');
  const it = args.itemId ? findById(pre.board.items, args.itemId) : null;
  if (args.itemId && !it) return err(`任务不存在：${args.itemId}`, 'NOT_FOUND');
  const targets = Array.isArray(args.targets)
    ? args.targets.filter((t) => ['pitfall', 'method', 'skill'].includes(t))
    : ['pitfall', 'method'];
  const now = store.nowIso();
  const at = now.replace(/[:.]/g, '-');
  const base = (engagement ? engagement.name : it ? it.title : '复盘');
  const slug = base.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || '复盘';
  const dir = store.draftsDir(root);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return err('无法创建草稿目录：' + ((e && e.message) || e), 'INTERNAL');
  }
  const file = join(dir, `harvest-${at}-${slug}.md`);
  const md = prompts.harvestDraft({ text, engagement, item: it, targets, at: now });
  try {
    writeFileSync(file, md, 'utf8');
  } catch (e) {
    return err('写入复盘草稿失败：' + ((e && e.message) || e), 'INTERNAL');
  }
  /* 状态变更（activity）同样走 CAS 事务；草稿文件本身不在 board 里。 */
  const rec = runAction(root, (b) => {
    store.pushActivity(b, { kind: 'updated', text: `复盘草稿：${base}`, engagementId: engagement ? engagement.id : '', itemId: it ? it.id : '', by });
    return okr({});
  });
  return okr({
    draftPath: file,
    targets,
    bytes: md.length,
    engagementId: engagement ? engagement.id : '',
    itemId: it ? it.id : '',
    next: '草稿在 research/.fde/drafts/，不是客户卷定稿。人审后：事实复盘进客户卷，方法沉淀进插件仓 docs/retros/、methods/、reference/、skills/（脱敏，示例用「某集团」）。',
    boardWritten: !!rec.ok,
    board: rec.ok ? rec.board : undefined,
  });
}
