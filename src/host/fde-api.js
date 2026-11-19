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

/* ---------------- 给人看的文本（ADR 0010 D1 / D11，spec §22.6） ----------------
 * 新写入 timeline / activity / history 的文本，以及面板会直接弹给人看的失败原因，
 * 用界面上的词：不出现规则编号、检查项 key、门禁 key、会话编号、泳道 key 与英文枚举。
 * 存量记录不改写（面板显示时替换）。 */

const NOT_FOUND_ENGAGEMENT = '找不到这家客户，请刷新后再试';
const NOT_FOUND_ITEM = '找不到这个任务，请刷新后再试';
const NOT_FOUND_PROPOSAL = '找不到这条提醒，可能已经处理过了；请刷新后再试';
const PROPOSAL_DONE = '这条提醒已经处理过了';
const FORCE_NEEDS_REASON = '破例推进需要写明原因';

/** 字段的中文名（记录文本用）；没登记的字段统一叫「其它信息」。 */
const ENGAGEMENT_FIELD_LABELS = {
  name: '名称', company: '公司全称', shortName: '简称', dir: '客户文件夹', priority: '优先级',
  owner: '负责人', tags: '标签', source: '来源', value: '金额备注', nextAction: '下一步',
  stakeholders: '关键人', paused: '暂停状态', bidWatch: '招采关注',
};
const ITEM_FIELD_LABELS = {
  title: '标题', type: '类型', priority: '优先级', due: '到期日', owner: '负责人',
  engagementId: '关联客户', autonomy: 'AI 权限',
};
const SETTING_LABELS = {
  autonomy: 'AI 权限', stallDays: '没有进展的天数', wipLimits: '同时进行上限', sources: '数据来源',
  workdirs: '工作目录', cacheTtlMs: '刷新间隔', bidSignalDays: '新招采公告的回看天数', demoDismissed: '示例数据',
};
function fieldNames(keys, labels) {
  const out = [];
  for (const k of keys || []) {
    const n = labels[k] || '其它信息';
    if (!out.includes(n)) out.push(n);
  }
  return out.join('、');
}

/** 进展（report）五种情况的说法。 */
const REPORT_WORDS = { progress: '更新了进展', ready: '做完了，等验收', blocked: '卡住了', failed: '没做成', dropped: '不做了' };
/** 交给 AI（handoff）按目的的说法；没登记的目的统一叫「交给 AI 推进」。 */
const HANDOFF_WORDS = { stage: '交给 AI 推进', gate: '交给 AI 补齐材料', meeting: '交给 AI 准备会面材料', review: '交给 AI 检查任务结果', harvest: '交给 AI 整理复盘' };
const handoffWords = (intent) => HANDOFF_WORDS[intent] || HANDOFF_WORDS.stage;
/** 提问（attention ask / resolve）的说法。 */
const ASK_WORDS = { decision: '等你决定', blocked: '卡住了', answer: '等你回复', question: '有个问题' };
const RESOLVE_WORDS = { decision: '已决定', blocked: '卡点已解除', answer: '已回复', question: '已回复' };
function askRecordText(kind, question, by) {
  const ai = by === 'agent';
  switch (kind) {
    case 'decision': return (ai ? 'AI 提了一个需要你决定的问题：' : '记下一个要决定的问题：') + question;
    case 'blocked': return (ai ? 'AI 报告卡住了：' : '标记为卡住了：') + question;
    case 'answer': return (ai ? 'AI 提了一个需要你回复的问题：' : '记下一个要回复的问题：') + question;
    default: return (ai ? 'AI 提了一个问题：' : '记下一个问题：') + question;
  }
}
/** 缺项的简短列举（失败原因里用，最多列 3 项）。 */
function missingBrief(missing) {
  const list = (missing || []).map((m) => (m && m.label) || '').filter(Boolean);
  if (!list.length) return '';
  return list.slice(0, 3).join('、') + (list.length > 3 ? ' 等' : '');
}

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
  if (!r.ok) return { ok: false, code: r.code || 'INTERNAL', reason: r.reason || '读取看板数据失败' };
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
    if (w.code !== 'CONFLICT') return { ok: false, code: w.code || 'INTERNAL', reason: w.reason || '保存看板数据失败' };
  }
  return err('刚才有别处同时在改看板，这次没能保存；请刷新后再试', 'CONFLICT');
}

/** 工具层红线（F1 / spec §6、§7）：阶段推进/归档/门禁勾选与 force 只能由人在面板执行。 */
const AGENT_FORBIDDEN_ENGAGEMENT_ACTIONS = new Set(['move', 'archive']);
export function agentGuard(body, action) {
  if (byOf(body) !== 'agent') return null;
  if (AGENT_FORBIDDEN_ENGAGEMENT_ACTIONS.has(action)) {
    return err('推进阶段、归档只能由人在面板执行（AI 只能准备、建议、提问）', 'BLOCKED');
  }
  const patch = isPlainObject(body.patch) ? body.patch : {};
  const wantsGateWrite = body.force === true || patch.force === true ||
    (isPlainObject(body.checks) && Object.keys(body.checks).length > 0) ||
    (isPlainObject(patch.checks) && Object.keys(patch.checks).length > 0);
  if (action === 'gate' && wantsGateWrite) {
    return err('确认推进条件、破例推进只能由人在面板执行（AI 调用 gate 只能做只读评估）', 'BLOCKED');
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
    if (!name) return { ok: false, reason: '关键人的姓名不能为空' };
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
    if (!v) return { ok: false, reason: '客户名称不能为空' };
    out.name = v;
  }
  for (const k of ['company', 'shortName', 'owner']) {
    if (k in patch) out[k] = pickString(patch[k], 200);
  }
  if ('dir' in patch) {
    const raw = pickString(patch.dir, 200);
    if (raw) {
      try { safeDirName(raw); } catch (e) { return { ok: false, reason: '客户文件夹名称不合法：' + ((e && e.message) || e) }; }
      try { safeProjectPath(root, raw); } catch (e) {
        if (e instanceof PathError) return { ok: false, reason: '客户文件夹名称不合法：' + e.message };
        return { ok: false, reason: '客户文件夹校验失败：' + ((e && e.message) || e) };
      }
      const dup = (board.engagements || []).find((x) => x.dir === raw && (!existing || x.id !== existing.id));
      if (dup) return { ok: false, reason: `这个文件夹已经关联了别的客户：${raw}` };
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
    if (due && !store.isDueStr(due)) return { ok: false, reason: '下一步的到期日格式应为 YYYY-MM-DD（或留空）' };
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
  if ('stage' in patch) return { ok: false, reason: '改阶段请用 action=move（要先满足推进条件）' };
  if ('gateState' in patch) return { ok: false, reason: '推进条件请用 action=gate' };
  if ('attention' in patch) return { ok: false, reason: '向人提问请用 fde_attention' };
  return { ok: true, patch: out };
}

/** 校验 item patch（泳道用 move，回报用 report）。 */
export function sanitizeItemPatch(patch, board) {
  const out = {};
  if (!isPlainObject(patch)) return { ok: false, reason: 'patch 必须为对象' };
  if ('title' in patch) {
    const v = pickString(patch.title, 200);
    if (!v) return { ok: false, reason: '任务标题不能为空' };
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
    if (due && !store.isDueStr(due)) return { ok: false, reason: '到期日格式应为 YYYY-MM-DD（或留空）' };
    out.due = due;
  }
  /* 负责人留空 = 不指定（创建时按调用方取默认值），不当成非法值拒绝。 */
  if ('owner' in patch && patch.owner !== '' && patch.owner !== null && patch.owner !== undefined) {
    if (!['human', 'agent', 'both'].includes(patch.owner)) return { ok: false, reason: '负责人只能选：我（human）、AI（agent）、我和 AI（both）' };
    out.owner = patch.owner;
  }
  if ('engagementId' in patch) {
    const eid = pickString(patch.engagementId, 40);
    if (eid && !findById(board.engagements, eid)) return { ok: false, reason: '关联的客户不存在：' + eid };
    out.engagementId = eid;
  }
  if ('autonomy' in patch) {
    if (!isPlainObject(patch.autonomy)) return { ok: false, reason: 'autonomy 必须为对象' };
    const mode = pickString(patch.autonomy.mode, 20);
    if (mode && !schema.isAutonomy(mode)) return { ok: false, reason: 'autonomy.mode 非法' };
    out.autonomy = { mode: mode || 'observe', rule: pickString(patch.autonomy.rule, 60) };
  }
  if ('stage' in patch) return { ok: false, reason: '改状态请用 action=move' };
  if ('reports' in patch) return { ok: false, reason: '记进展请用 action=report' };
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
    if (!schema.isStage(e.stage)) { summaries[e.id] = Object.assign(bidUnavailable('客户已归档或已流失'), { total: 0, tender: 0, award: 0, candidate: 0, latest: '', queries: [], matches: [] }); continue; }
    if (e.bidWatch && e.bidWatch.enabled === false) {
      summaries[e.id] = Object.assign(bidUnavailable('这家客户已关闭招采关注'), { enabled: false, total: 0, tender: 0, award: 0, candidate: 0, latest: '', queries: [], matches: [] });
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

/** 提醒刷新结果是否改动了 board（新建 / 自动失效 / 标题更新，任一即需落盘；spec §22.2）。 */
function proposalsChanged(r) {
  return !!(r && ((r.added && r.added.length) || r.expired || r.updated));
}

/** 刷新 proposals（含 bid_signal）+ company 回填：有变更时按 CAS 落盘（读时求值，spec §6 / §22.2）。
 * 「有变更」= 新建提醒、提醒自动失效、提醒标题更新、company 回填，任一成立；
 * 四者都没有时返回 noWrite——只读请求不写文件（bidWatch.lastMatchAt 这类派生字段不单独触发写盘）。
 * GET 读路径容忍并发：冲突重试后仍失败时用最新 board 继续，绝不覆盖别人刚写入的数据。 */
function refreshAndPersist(root, opts = {}) {
  const service = opts.bidIntel || null;
  const res = runAction(root, (board) => {
    const ttl = ttlOf(board);
    const backfilled = backfillCompanies(board);
    const r = rules.refreshProposals(root, board, { ttlMs: ttl, bidIntel: service });
    if (!proposalsChanged(r) && !backfilled) return noWrite({ added: 0, expired: 0, updated: 0, backfilled: 0 });
    return { ok: true, added: r.added.length, expired: r.expired || 0, updated: r.updated || 0, backfilled };
  });
  if (res.ok) return res;
  if (opts.tolerant && res.code === 'CONFLICT') {
    const again = load(root);
    if (again.ok) return okr({ board: again.board, added: 0, expired: 0, updated: 0, conflict: true });
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
    proposalsExpired: refreshed.expired || 0,
    proposalsUpdated: refreshed.updated || 0,
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
  /* 「待我处理」只算必须有人动作的事，不含提醒（spec §22.3）；brief.attention 仍含 proposal 种类以兼容工具。 */
  const todo = attention.filter((a) => a && a.kind !== 'proposal').length;
  const headline = `在跟客户 ${stats.active} 个 · 待我处理 ${todo} 件 · 今天到期 ${stats.dueToday} · 已逾期 ${stats.overdue}`;
  const dueTodayItems = (b.items || []).filter((it) => store.isDueStr(it.due) && it.due === store.todayStr() && schema.isLane(it.stage)).map((it) => ({ id: it.id, title: it.title, engagementId: it.engagementId, stage: it.stage }));
  return {
    generatedAt: store.nowIso(),
    period: period === 'week' ? 'week' : 'today',
    headline,
    greeting: !(b.engagements || []).some((e) => e && schema.isStage(e.stage))
      ? '还没有客户：新建一个，或导入已有文件夹'
      : (todo ? `今天有 ${todo} 件事等你处理` : '今天没有等你处理的事'),
    stats: Object.assign({}, stats, { todo }),
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
  if (!name) return err('请填写客户名称或公司全称');
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
    timeline: [{ at: now, kind: 'created', text: '新建客户', by }],
  };
  if (p.bidWatch) {
    e.bidWatch = Object.assign(e.bidWatch, p.bidWatch);
    if (Array.isArray(p.bidWatch.keywords)) e.bidWatch.keywords = p.bidWatch.keywords.slice();
    if (Array.isArray(p.bidWatch.links)) e.bidWatch.links = p.bidWatch.links.slice();
  }
  b.engagements.push(e);
  store.pushActivity(b, { kind: 'created', text: `新建客户：${e.name}`, engagementId: e.id, by });
  return okr({ engagement: e });
}

function moveEngagement(root, b, body) {
  const by = byOf(body);
  const patch = isPlainObject(body.patch) ? body.patch : {};
  const id = pickString(body.id, 40);
  const e = findById(b.engagements, id);
  if (!e) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
  const target = pickString(patch.stage || body.stage, 40);
  const force = !!(patch.force || body.force);
  const reason = pickString(patch.reason || body.reason, 300);
  if (!schema.isEngagementStage(target)) return err(`非法阶段：${target || '(空)'}（${schema.STAGE_KEYS.join('|')}|archived|lost）`);
  if (!schema.isStage(target)) return err(`move 只能推进到 ${schema.ENGAGEMENT_STAGES.length} 个阶段之一；归档请用 action=archive`);
  if (!schema.isStage(e.stage)) return err('这家客户已归档或已流失，不能再调整阶段', 'CONFLICT');
  const curOrder = schema.stageOrder(e.stage);
  const targetOrder = schema.stageOrder(target);
  const backward = targetOrder < curOrder;
  if (!force && !backward) {
    if (targetOrder !== curOrder + 1) {
      const nxt = schema.nextStage(e.stage);
      return err(nxt ? `不能跳过阶段：现在在「${schema.stageLabel(e.stage)}」，下一步只能进入「${schema.stageLabel(nxt)}」（确需跳过请用「破例推进」并写明原因）` : '已经是最后一个阶段了，接下来只能归档', 'INVALID');
    }
  } else if (force && !reason) {
    return err(FORCE_NEEDS_REASON);
  }
  const gateKey = schema.gateKeyOfStage(target);
  const gsKey = gateKey ? schema.gateStateKey(gateKey) : '';
  /* 回退是人工纠正（恢复早前阶段），不校验门禁；前进必须过门禁或已由人强制放行过。 */
  const gate = !backward && gateKey ? rules.evaluateGate(root, e, gateKey, { ttlMs: ttlOf(b) }) : null;
  const forcedBefore = !!(gsKey && e.gateState[gsKey] && e.gateState[gsKey].forced === true);
  if (gate && !gate.passed && !force && !forcedBefore) {
    return err(`还不能进入「${schema.stageLabel(target)}」：还差 ${gate.missing.length} 项（${missingBrief(gate.missing)}）`, 'BLOCKED', { blocked: true, gate, missing: gate.missing });
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
      : `阶段：${schema.stageLabel(from)} → ${schema.stageLabel(target)}${force && gate && !gate.passed ? `（破例推进：${reason}）` : ''}`,
    by,
  });
  store.pushActivity(b, { kind: 'moved', text: `${e.name}：${schema.stageLabel(from)} → ${schema.stageLabel(target)}${backward ? '（回退）' : (force ? '（破例推进）' : '')}`, engagementId: e.id, by });
  const gateFinal = gateKey && !backward ? (rules.evaluateGate(root, e, gateKey, { ttlMs: ttlOf(b) }) || gate) : gate;
  return okr({ engagement: e, gate: gateFinal, missing: gateFinal ? gateFinal.missing : [] });
}

function gateEvaluate(root, b, body) {
  /* 参数归一化（F5）：patch 与顶层字段合并，gate 的 stage/checks/force/reason 不再被静默丢弃。 */
  const a = Object.assign({}, body, isPlainObject(body.patch) ? body.patch : {});
  const by = byOf(body);
  const id = pickString(a.engagementId || a.id, 40);
  const e = findById(b.engagements, id);
  if (!e) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
  const stage = pickString(a.stage, 20) || e.stage;
  if (!schema.isEngagementStage(stage)) return err(`非法阶段：${stage}`);
  if (!schema.isStage(stage)) return err('已归档或已流失的客户没有推进条件');
  const gateKey = schema.gateKeyOfStage(stage);
  if (!gateKey) return err('这个阶段没有设置推进条件', 'NOT_FOUND');
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
    /* 记录用检查项的中文名；勾上与取消分开记。 */
    const manualLabel = (k) => { const c = def.manual.find((x) => x.key === k); return c ? c.label : '其它事项'; };
    const confirmed = touched.filter((k) => gs.checks[k].status === 'pass').map(manualLabel);
    const revoked = touched.filter((k) => gs.checks[k].status !== 'pass').map(manualLabel);
    if (confirmed.length) store.pushTimeline(e, { kind: 'gate', text: `确认了推进条件：${confirmed.join('、')}`, by });
    if (revoked.length) store.pushTimeline(e, { kind: 'gate', text: `取消了推进条件的确认：${revoked.join('、')}`, by });
  }

  /* 先把人工勾选写回 engagement.gateState（按阶段 key），再评估——否则 evaluateGate 读不到刚提交的勾选。 */
  e.gateState[gsKey] = gs;
  const gate = rules.evaluateGate(root, e, gateKey, { ttlMs: ttlOf(b) });
  if (gate.passed && gs.status !== 'pass') { gs.status = 'pass'; gs.at = now; gs.forced = false; changed = true; }

  const force = !!a.force;
  const reason = pickString(a.reason, 300);
  if (force) {
    if (!reason) return err(FORCE_NEEDS_REASON);
    if (!gate.passed) {
      gs.status = 'forced';
      gs.forced = true;
      gs.reason = reason;
      gs.at = now;
      changed = true;
      store.pushTimeline(e, { kind: 'gate', text: `破例推进到「${schema.stageLabel(stage)}」：${reason}`, by });
      store.pushActivity(b, { kind: 'gate', text: `${e.name}破例推进到「${schema.stageLabel(stage)}」`, engagementId: e.id, by });
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
  if (!e) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
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
  store.pushTimeline(e, { kind: 'note', text: '更新了：' + fieldNames(Object.keys(s.patch), ENGAGEMENT_FIELD_LABELS), by });
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
  if (!e) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
  if (schema.isTerminal(e.stage)) return err('这家客户已经归档或已流失了', 'CONFLICT');
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
  store.pushHistory(item, { kind: 'moved', text: `状态：${schema.laneLabel(from)} → ${schema.laneLabel(lane)}`, by: by || 'human' });
  return true;
}

function createItem(root, b, body) {
  const by = byOf(body);
  const patch = Object.assign({}, isPlainObject(body.patch) ? body.patch : {});
  for (const k of ['title', 'type', 'priority', 'due', 'owner', 'engagementId', 'stage', 'autonomy']) {
    if (body[k] !== undefined && patch[k] === undefined) patch[k] = body[k];
  }
  const title = pickString(patch.title, 200);
  if (!title) return err('任务标题不能为空');
  /* 创建时允许直接落在某泳道（move 才有「改泳道」限制），校验前先摘出 stage。 */
  const initialLane = pickString(patch.stage, 20) || 'inbox';
  const forPatch = Object.assign({}, patch);
  delete forPatch.stage;
  const s = sanitizeItemPatch(forPatch, b);
  if (!s.ok) return err(s.reason);
  const p = s.patch;
  const lane = initialLane;
  if (!schema.isLane(lane)) return err(`没有这个任务状态：${lane}（可选 ${schema.LANE_KEYS.join('|')}）`);
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
    history: [{ at: now, kind: 'created', text: '新建任务', by }],
  };
  b.items.push(it);
  const eng = it.engagementId ? findById(b.engagements, it.engagementId) : null;
  store.pushActivity(b, { kind: 'created', text: `新建任务：${it.title}`, engagementId: it.engagementId, itemId: it.id, by });
  if (eng) store.pushTimeline(eng, { kind: 'note', text: `新增任务：${it.title}`, by });
  return okr({ item: it });
}

function updateItem(root, b, body) {
  const by = byOf(body);
  const id = pickString(body.id, 40);
  const it = findById(b.items, id);
  if (!it) return err(NOT_FOUND_ITEM, 'NOT_FOUND');
  const patch = Object.assign({}, isPlainObject(body.patch) ? body.patch : {});
  for (const k of ['title', 'type', 'priority', 'due', 'owner', 'engagementId', 'autonomy']) {
    if (body[k] !== undefined && patch[k] === undefined) patch[k] = body[k];
  }
  const s = sanitizeItemPatch(patch, b);
  if (!s.ok) return err(s.reason);
  if (!Object.keys(s.patch).length) return noWrite({ item: it });
  Object.assign(it, s.patch);
  store.pushHistory(it, { kind: 'updated', text: '更新了：' + fieldNames(Object.keys(s.patch), ITEM_FIELD_LABELS), by });
  store.pushActivity(b, { kind: 'updated', text: `更新任务：${it.title}`, engagementId: it.engagementId, itemId: it.id, by });
  return okr({ item: it });
}

function moveItemAction(root, b, body) {
  const by = byOf(body);
  const id = pickString(body.id, 40);
  const it = findById(b.items, id);
  if (!it) return err(NOT_FOUND_ITEM, 'NOT_FOUND');
  const patch = isPlainObject(body.patch) ? body.patch : {};
  const lane = pickString(patch.stage || body.stage, 20);
  if (!schema.isLane(lane)) return err(`没有这个任务状态：${lane || '(空)'}（可选 ${schema.LANE_KEYS.join('|')}）`);
  const force = !!(patch.force || body.force);
  const evidence = pickString(patch.evidence || body.evidence, 500);
  if (lane === 'done' && !(it.reports || []).length && !evidence && !force) {
    return err(`移入「${schema.laneLabel('done')}」前，请先写一句结果说明（做成了什么、依据在哪）`, 'BLOCKED', { blocked: true, missing: [{ type: 'manual', key: 'evidence', label: '结果说明' }] });
  }
  if (it.stage === lane && !evidence) return noWrite({ item: it, warning: '', moved: false });
  let warning = '';
  if (lane === 'doing') {
    const lim = schema.wipLimitOf(b.settings, 'doing');
    const count = (b.items || []).filter((x) => x.stage === 'doing' && x.id !== it.id).length;
    if (lim && count >= lim) warning = `进行中的任务已有 ${count} 个，达到同时进行上限（${lim} 个）；建议先做完手上的再开新的`;
  }
  if (!moveItem(it, lane, by)) return noWrite({ item: it, warning, moved: false });
  if (evidence) store.pushHistory(it, { kind: 'updated', text: '结果说明：' + evidence, by });
  if (lane === 'done' || lane === 'canceled') it.attention = null;
  store.pushActivity(b, { kind: 'moved', text: `任务「${it.title}」改为「${schema.laneLabel(lane)}」`, engagementId: it.engagementId, itemId: it.id, by });
  return okr({ item: it, warning, moved: true });
}

function reportItem(root, b, body) {
  const by = byOf(body);
  const id = pickString(body.id, 40);
  const it = findById(b.items, id);
  if (!it) return err(NOT_FOUND_ITEM, 'NOT_FOUND');
  const rep = isPlainObject(body.report) ? body.report : body;
  const kind = pickString(rep.kind, 20);
  const kinds = ['progress', 'ready', 'blocked', 'failed', 'dropped'];
  if (!kinds.includes(kind)) return err(`report.kind 必须是 ${kinds.join('|')}`);
  const text = pickString(rep.text, 2000);
  if (!text) return err('进展内容不能为空（写一句摘要，可附文件路径）');
  const artifacts = Array.isArray(rep.artifacts) ? rep.artifacts.map((a) => pickString(a, 500)).filter(Boolean).slice(0, 30) : [];
  const now = store.nowIso();
  let warning = '';
  if (body.sessionId && it.sessionId && body.sessionId !== it.sessionId) {
    warning = '这条进展不是从任务关联的那次对话里发来的（仅提示，不影响记录）';
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
  store.pushHistory(it, { kind: 'report', text: `${REPORT_WORDS[kind]}：${text.slice(0, 120)}`, by });
  const eng = it.engagementId ? findById(b.engagements, it.engagementId) : null;
  store.pushActivity(b, { kind: 'report', text: `任务「${it.title}」${REPORT_WORDS[kind]}`, engagementId: it.engagementId, itemId: it.id, by });
  if (eng) store.pushTimeline(eng, { kind: 'report', text: `任务「${it.title}」${REPORT_WORDS[kind]}`, by });
  const res = okr({ item: it, attention, lane });
  if (warning) res.warning = warning;
  return res;
}

function deleteItem(root, b, body) {
  /* 红线（F1 / spec §6）：删除任务只能由人在面板执行，agent 工具来源一律拒绝。 */
  if (byOf(body) === 'agent') {
    return err('删除任务只能由人在面板执行（AI 只能准备、建议、提问）', 'BLOCKED');
  }
  const by = byOf(body);
  const id = pickString(body.id, 40);
  const idx = (b.items || []).findIndex((x) => x.id === id);
  if (idx < 0) return err(NOT_FOUND_ITEM, 'NOT_FOUND');
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
    return err('删除任务只能由人在面板执行', 'BLOCKED');
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

/** 注意力提问/解决/列表（POST /fde/attention；工具 fde_attention）。记录文本对人称「提问 / 待我处理」。 */
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
    if (!obj) return err(target === 'engagement' ? NOT_FOUND_ENGAGEMENT : NOT_FOUND_ITEM, 'NOT_FOUND');
    /* 最近动态里的主语：客户名（后面留一个空格），或「任务「标题」」（引号结尾，不加空格）。 */
    const subject = target === 'engagement' ? obj.name : `任务「${obj.title}」`;
    const subjectHead = target === 'engagement' ? obj.name : subject;

    if (action === 'ask') {
      const kind = pickString(args.kind, 20) || 'decision';
      if (!schema.ATTENTION_EXPLICIT_KINDS.includes(kind)) return err(`attention.kind 必须是 ${schema.ATTENTION_EXPLICIT_KINDS.join('|')}`);
      const question = pickString(args.question, 1000);
      if (!question) return err('问题内容不能为空');
      const now = store.nowIso();
      const att = { kind, question, askedAt: now, askedBy: by };
      obj.attention = att;
      if (target === 'engagement') store.pushTimeline(obj, { kind: 'attention', text: askRecordText(kind, question, by), by });
      else store.pushHistory(obj, { kind: 'attention', text: askRecordText(kind, question, by), by });
      store.pushActivity(b, { kind: 'attention', text: `${subjectHead}${ASK_WORDS[kind] || ASK_WORDS.question}：${question.slice(0, 80)}`, engagementId: target === 'engagement' ? obj.id : obj.engagementId, itemId: target === 'item' ? obj.id : '', by });
      return okr({ attention: att });
    }

    /* resolve */
    const answer = pickString(args.answer, 2000);
    const had = obj.attention;
    if (!had) return noWrite({ attention: null, cleared: false, warning: '这里没有等人处理的问题' });
    /* 红线（spec §6/§7；Phase 3 · 审查 F-20）：decision/blocked 是「需要人拍板/受阻」的显式注意力，
     * agent 来源不得自行 resolve；answer/question 仍可由 agent 记录人的回答。 */
    if (by === 'agent' && (had.kind === 'decision' || had.kind === 'blocked')) {
      return err('等人决定或卡住的事只能由人在面板处理（AI 不能替人了结，可以继续用 ask 补充信息）', 'BLOCKED');
    }
    obj.attention = null;
    const now = store.nowIso();
    const resolved = RESOLVE_WORDS[had.kind] || RESOLVE_WORDS.question;
    if (target === 'engagement') store.pushTimeline(obj, { kind: 'attention', text: `${resolved}${answer ? '：' + answer : ''}`, by });
    else store.pushHistory(obj, { kind: 'attention', text: `${resolved}${answer ? '：' + answer : ''}`, by });
    store.pushActivity(b, { kind: 'attention', text: `${subject}：${resolved}（${String(had.question || '').slice(0, 60)}）`, engagementId: target === 'engagement' ? obj.id : obj.engagementId, itemId: target === 'item' ? obj.id : '', by });
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
      if (!dir) { rejected.push({ dir: String(rawDir), reason: '文件夹名为空' }); continue; }
      try { safeDirName(dir); } catch (e) { rejected.push({ dir, reason: '文件夹名称不合法：' + ((e && e.message) || e) }); continue; }
      /* F6：复用 safeProjectPath(realpath) 守卫——符号链接指向工作区外时 projectAbs 返回 ''，直接拒绝。 */
      const abs = store.projectAbs(root, dir);
      if (!abs) { rejected.push({ dir, reason: '这个文件夹在工作区之外，不能导入' }); continue; }
      if (!existsSync(abs)) { rejected.push({ dir, reason: '文件夹不存在' }); continue; }
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
          text: `从已有文件夹导入，放在「${schema.stageLabel(suggestion.stage)}」阶段`,
          by,
        }],
      };
      /* 导入前的历史阶段视为已完成：记 forced 并写明原因，保持可审计、可回滚。 */
      for (const st of schema.ENGAGEMENT_STAGES) {
        if (st.order >= schema.stageOrder(suggestion.stage)) break;
        e.gateState[st.key] = { status: 'forced', checks: {}, forced: true, reason: '从已有文件夹导入：之前阶段的材料已经在文件夹里', at: now };
        store.pushTimeline(e, { kind: 'gate', text: `导入时已过「${st.label}」阶段，推进条件视为满足`, by: 'system' });
      }
      b.engagements.push(e);
      added.push({ dir, engagementId: e.id, stage: suggestion.stage });
      store.pushActivity(b, { kind: 'adopt', text: `从已有文件夹导入客户：${e.name}`, engagementId: e.id, by });
    }

    const payload = { added, skipped, rejected, written: added.length > 0 };
    return added.length ? okr(payload) : noWrite(payload);
  });
}

/* ============================ handoff ============================ */

/**
 * 交给 AI 时用哪个阶段的做法（spec §22.9）。
 * 推进条件属于要进入的那个阶段，所以默认取下一阶段；最后一个阶段取当前阶段。
 */
function handoffWorkStage(engagement, intent) {
  if (!engagement || !schema.isStage(engagement.stage)) return 'lead';
  if (intent === 'meeting') return 'meeting';
  if (intent === 'harvest') return engagement.stage;
  return schema.nextStage(engagement.stage) || engagement.stage;
}
/** 任务类型里没有「研判」，对应的是「调研」。 */
const WORK_STAGE_ITEM_TYPE = { discovery: 'research' };

/**
 * 当前阶段自己还缺的材料（只读评估）。
 * 只在当前阶段的条件没有通过记录时才看——典型是从文件夹导入的客户：
 * 按「有没有这个阶段的材料」放列，材料未必齐。
 */
function currentStageGap(root, engagement, ttlMs) {
  const cg = rules.currentGate(engagement);
  if (!cg) return [];
  const rec = engagement.gateState && engagement.gateState[schema.gateStateKey(cg.gateKey)];
  if (rec && (rec.status === 'pass' || rec.status === 'forced' || rec.forced === true)) return [];
  const g = rules.evaluateGate(root, engagement, cg.gateKey, { ttlMs });
  return ((g && g.missing) || []).filter((m) => m.type === 'auto').map((m) => m.detail || m.label);
}

/** 客户阶段 handoff 的执行任务标题（含阶段名；用于「创建或复用」判定）。 */
function handoffItemTitle(engagement, workStage) {
  const ws = schema.isStage(workStage) ? workStage : engagement.stage;
  return ws !== engagement.stage
    ? `准备进入「${schema.stageLabel(ws)}」：${engagement.name}`
    : `推进「${schema.stageLabel(engagement.stage)}」：${engagement.name}`;
}
/** v1 的标题写法；在办的旧任务按它复用，不重复建。 */
function legacyHandoffItemTitle(engagement) {
  return `执行任务：${schema.stageLabel(engagement.stage)} · ${engagement.name}`;
}

/**
 * 确保客户有一个 open 的执行任务（F2 / spec §9）：
 * source.kind=agent、ref=handoff、泳道 todo|doing，标题含当前阶段名；已存在则复用。
 */
function ensureExecutionItem(root, engagementId, by, intent) {
  return runAction(root, (b) => {
    const e = findById(b.engagements, engagementId);
    if (!e) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
    if (!schema.isStage(e.stage)) return err('这家客户已归档或已流失，不能再交给 AI 推进；需要复盘时请写复盘草稿', 'CONFLICT');
    const workStage = handoffWorkStage(e, intent);
    const itemType = WORK_STAGE_ITEM_TYPE[workStage] || workStage;
    const title = handoffItemTitle(e, workStage);
    const legacyTitle = legacyHandoffItemTitle(e);
    const existing = (b.items || []).find((it) => it.engagementId === e.id &&
      it.source && it.source.kind === 'agent' && it.source.ref === 'handoff' &&
      ['todo', 'doing'].includes(it.stage) && (it.title === title || it.title === legacyTitle));
    if (existing) return noWrite({ item: existing, reused: true });
    const now = store.nowIso();
    const it = {
      id: store.newItemId(),
      engagementId: e.id,
      title,
      type: schema.isItemType(itemType) ? itemType : 'followup',
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
      history: [{ at: now, kind: 'created', text: '交给 AI 时自动创建', by }],
    };
    b.items.push(it);
    store.pushActivity(b, { kind: 'created', text: `新建任务：${it.title}`, engagementId: e.id, itemId: it.id, by });
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
    const ensured = ensureExecutionItem(root, id, by, intent);
    if (!ensured.ok) return ensured;
    item = ensured.item;
    reusedItem = !!ensured.reused;
    contextBoard = ensured.board;
    engagement = findById(contextBoard.engagements, id) || null;
    if (!engagement) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
    const ttl = ttlOf(contextBoard);
    const ng = rules.nextGate(engagement) || rules.currentGate(engagement);
    if (ng) gate = rules.evaluateGate(root, engagement, ng.gateKey, { ttlMs: ttl });
    prompt = prompts.buildPrompt('engagement', {
      root,
      engagement,
      item,
      intent,
      gate,
      workStage: handoffWorkStage(engagement, intent),
      doorGap: currentStageGap(root, engagement, ttl),
      stayDays: rules.stageStayDays(engagement),
      hasSkills: !!deps.skillsAvailable,
    });
  } else {
    const pre = load(root);
    if (!pre.ok) return pre;
    contextBoard = pre.board;
    item = findById(contextBoard.items, id);
    if (!item) return err(NOT_FOUND_ITEM, 'NOT_FOUND');
    engagement = item.engagementId ? findById(contextBoard.engagements, item.engagementId) : null;
    prompt = prompts.buildPrompt('item', {
      root, item, engagement, intent,
      workStage: engagement ? handoffWorkStage(engagement, intent) : '',
    });
  }

  if (typeof deps.handoff !== 'function') {
    return err('这里没法自动开新对话——请把下面这段话粘贴到对话框里继续', 'INTERNAL', { prompt, sessionId: '', itemId: item ? item.id : '' });
  }
  const hr = await deps.handoff(prompt, { root });
  if (!hr || !hr.ok) {
    return err((hr && hr.reason) || '没能开出新对话', 'INTERNAL', { prompt, sessionId: '', itemId: item ? item.id : '' });
  }
  const sessionId = hr.sessionId || '';
  /* 会话创建在事务外（避免冲突重试时重复建会话）；写回用 CAS 事务，绝不覆盖并发写。 */
  const wrote = runAction(root, (b) => {
    const now = store.nowIso();
    if (target === 'engagement') {
      const e = findById(b.engagements, id);
      if (!e) return err('新对话已开出，但这家客户找不到了（可能刚被别处改动）', 'NOT_FOUND');
      e.sessionId = sessionId;
      /* 记录里不写会话编号与英文目的；编号留在 sessionId 字段。 */
      store.pushTimeline(e, { kind: 'session', text: handoffWords(intent), by });
      const it = item ? findById(b.items, item.id) : null;
      if (it) {
        it.sessionId = sessionId;
        store.pushHistory(it, { kind: 'report', text: handoffWords(intent), by });
      }
      store.pushActivity(b, { kind: 'session', text: `${e.name}已交给 AI`, engagementId: e.id, itemId: it ? it.id : '', by });
      return okr({});
    }
    const it = findById(b.items, id);
    if (!it) return err('新对话已开出，但这个任务找不到了（可能刚被别处删除）', 'NOT_FOUND');
    it.sessionId = sessionId;
    store.pushHistory(it, { kind: 'report', text: handoffWords(intent), by });
    store.pushActivity(b, { kind: 'session', text: `任务「${it.title}」已交给 AI`, engagementId: it.engagementId, itemId: it.id, by });
    return okr({});
  });
  if (!wrote.ok) {
    return err(wrote.reason || '新对话已开出，但没能记到看板上', 'INTERNAL', { prompt, sessionId, itemId: item ? item.id : '' });
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

/** 处理提醒（POST /fde/proposal）：accept = 按提醒处理（建跟进任务 / 交给 AI 准备）；dismiss = 知道了。 */
export async function proposal(root, body = {}, deps = {}) {
  const args = normalizeArgs(body);
  const by = byOf(args);
  const id = pickString(args.id, 40);
  const action = pickString(args.action, 20);
  if (!['accept', 'dismiss'].includes(action)) return err(`未知 action：${action || '(空)'}（accept|dismiss）`);
  const pre = load(root);
  if (!pre.ok) return pre;
  const p0 = findById(pre.board.proposals, id);
  if (!p0) return err(NOT_FOUND_PROPOSAL, 'NOT_FOUND');
  if (p0.status !== 'pending') return err(PROPOSAL_DONE, 'CONFLICT');

  if (action === 'dismiss') {
    return runAction(root, (b) => {
      const p = findById(b.proposals, id);
      if (!p) return err(NOT_FOUND_PROPOSAL, 'NOT_FOUND');
      if (p.status !== 'pending') return err(PROPOSAL_DONE, 'CONFLICT');
      p.status = 'dismissed';
      p.decidedAt = store.nowIso();
      store.pushActivity(b, { kind: 'proposal', text: `不再提醒：${p.title}`, engagementId: p.engagementId, itemId: p.itemId, by });
      return okr({ proposal: p });
    });
  }

  /* start_session 需要真实创建会话（安全动作之外，必须有会话服务） */
  if (p0.kind === 'start_session') {
    if (typeof deps.handoff !== 'function') return err('这里没法自动开新对话，暂时不能把这条提醒交给 AI', 'BLOCKED');
    const payload = p0.payload || {};
    const target = p0.itemId ? 'item' : 'engagement';
    const hid = p0.itemId || p0.engagementId;
    const hr = await handoff(root, { target, id: hid, intent: payload.intent || 'stage' }, deps);
    if (!hr.ok) return hr;
    /* handoff 内部已按 CAS 写回 board；这里再读改写一次标记建议状态（不再用旧快照整份覆盖）。 */
    const wrote = runAction(root, (b) => {
      const p = findById(b.proposals, id);
      if (!p) return err('新对话已开出，但这条提醒找不到了（可能刚被别处处理）', 'NOT_FOUND');
      if (p.status !== 'pending') return err(PROPOSAL_DONE, 'CONFLICT');
      p.status = 'accepted';
      p.decidedAt = store.nowIso();
      p.payload = Object.assign({}, p.payload || {}, { sessionId: hr.sessionId });
      store.pushActivity(b, { kind: 'proposal', text: `已交给 AI 处理：${p.title}`, engagementId: p.engagementId, itemId: p.itemId, by });
      return okr({ proposal: p, sessionId: hr.sessionId });
    });
    if (!wrote.ok) return err(wrote.reason, wrote.code, { sessionId: hr.sessionId, prompt: hr.prompt });
    return okr({ board: wrote.board, proposal: wrote.proposal, sessionId: hr.sessionId, prompt: hr.prompt, itemId: hr.itemId });
  }

  return runAction(root, (b) => {
    const p = findById(b.proposals, id);
    if (!p) return err(NOT_FOUND_PROPOSAL, 'NOT_FOUND');
    if (p.status !== 'pending') return err(PROPOSAL_DONE, 'CONFLICT');
    const ex = executeProposal(b, p, store.nowIso(), by);
    if (!ex.ok) return err(ex.reason || '没能按提醒处理', 'INTERNAL');
    p.status = 'accepted';
    p.decidedAt = store.nowIso();
    store.pushActivity(b, { kind: 'proposal', text: `已按提醒处理：${p.title}`, engagementId: p.engagementId, itemId: p.itemId, by });
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
        history: [{ at: now, kind: 'created', text: '由提醒创建', by: actor }],
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
      store.pushActivity(board, { kind: 'created', text: `建了跟进任务：${it.title}`, engagementId: it.engagementId, itemId: it.id, by: actor });
    }
    if (p.kind === 'update_next' || p.kind === 'nudge') {
      const patch = isPlainObject(payload.patch) ? payload.patch : {};
      if (p.engagementId && isPlainObject(patch.nextAction)) {
        const e = findById(board.engagements, p.engagementId);
        if (e) {
          /* 只补空着的字段：提醒生成之后人已经写了下一步，就不拿提醒里的占位文字去盖。 */
          const cur = Object.assign({ text: '', due: '', owner: '' }, e.nextAction || {});
          let filled = false;
          for (const k of ['text', 'due', 'owner']) {
            if (!String(cur[k] || '').trim() && String(patch.nextAction[k] || '').trim()) { cur[k] = patch.nextAction[k]; filled = true; }
          }
          if (filled) {
            e.nextAction = cur;
            store.pushTimeline(e, { kind: 'note', text: `已按提醒处理：${p.title}`, by: actor });
          }
          applied.nextAction = e.nextAction || cur;
        }
      }
      if (p.itemId && store.isDueStr(patch.due)) {
        const it = findById(board.items, p.itemId);
        if (it) {
          it.due = patch.due;
          store.pushHistory(it, { kind: 'updated', text: `按提醒改期到 ${patch.due}`, by: actor });
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
 * 按 AI 权限（autonomy）直接处理「小事」（fde_brief apply=true 用；红线动作永不执行）。
 * 范围（spec §22.4）：safe 且非 derived、非 start_session 的提醒——
 * no_next（补一条待确认的下一步）、bid_signal（建跟进任务）；due_soon 没有可执行动作，只标记为知道了。
 * derived 规则的提醒一律跳过（即便存量里还有 pending 的；它们会在下次刷新时自动失效）。
 * observe 档不执行；assisted 与 auto 行为相同。
 * F4：忽略调用方传入的 board（可能是带派生 artifacts 的响应副本），一律从磁盘重新 load 原始状态再写。
 */
export function applySafeProposals(root, _ignoredBoard) {
  return runAction(root, (board) => {
    const mode = (board.settings && board.settings.autonomy) || 'observe';
    const safeRuleIds = new Set(schema.RULES.filter((r) => r.safe && !r.derived).map((r) => r.ruleId));
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
      /* 真的改了东西才说「已直接处理」；没有可执行动作的（如快到期）只是标记为知道了。 */
      const did = ex.applied && Object.keys(ex.applied).length > 0;
      store.pushActivity(board, { kind: 'proposal', text: `${did ? 'AI 已直接处理' : 'AI 已标记为知道了'}：${p.title}`, engagementId: p.engagementId, itemId: p.itemId, by: 'agent' });
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
    if (!wantNum(patch.stallDays, 1, 365)) invalid.push('「没有进展」的天数应在 1 到 365 之间');
    else { next.stallDays = Math.round(Number(patch.stallDays)); appliedKeys.push('stallDays'); }
  }
  if ('wipLimits' in patch) {
    if (!isPlainObject(patch.wipLimits)) invalid.push('wipLimits 必须为对象');
    else {
      const wip = Object.assign({ doing: 5 }, next.wipLimits || {});
      for (const k of Object.keys(patch.wipLimits)) {
        if (!schema.isLane(k)) { invalid.push('同时进行上限里有未知的任务状态：' + k); continue; }
        if (!wantNum(patch.wipLimits[k], 1, 50)) { invalid.push('同时进行上限应在 1 到 50 之间'); continue; }
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
    if (!wantNum(patch.bidSignalDays, 1, 365)) invalid.push('新招采公告的回看天数应在 1 到 365 之间');
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
  store.pushActivity(b, { kind: 'updated', text: '修改了设置：' + fieldNames(appliedKeys, SETTING_LABELS), by });
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
      if (!e) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
      targets = [e];
      filterId = e.id;
    }
    const artifacts = {};
    for (const e of targets) {
      if (!e.dir) { artifacts[e.id] = store.summarizeArtifacts(null); continue; }
      artifacts[e.id] = store.summarizeArtifacts(store.scanProjectArtifacts(root, e.dir, { ttlMs: 0, force: true }));
    }
    const pr = rules.refreshProposals(root, b, { ttlMs: ttl });
    refreshed = {
      engagementId: filterId, engagements: targets.map((e) => e.id), artifacts,
      proposalsAdded: pr.added.length, proposalsExpired: pr.expired || 0, proposalsUpdated: pr.updated || 0,
      scannedAt: store.nowIso(),
    };
    /* 提醒有新建 / 自动失效 / 标题更新才落盘（其余刷新结果都是派生数据，不写状态文件）。 */
    return proposalsChanged(pr) ? okr({}) : noWrite({});
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

/** 自检项的名称（给人看；集中在这里，测试按它取）。 */
export const HEALTH_NAMES = {
  boardReadable: '看板数据可读',
  boardValid: '看板数据完整',
  dataVersion: '数据版本匹配',
  folders: '客户文件夹都在',
  dataDirWritable: '数据目录可写',
  backups: '自动备份',
  skills: '技能可用',
  bidRadar: '招采雷达可用',
};

/**
 * 自检（GET /fde/health）。返回 {ok, healthy, checks:[{name,status,detail}]}；
 * 单项失败不抛异常。status：ok | warn | fail。
 * name / detail 会原样显示在面板「运行状态」里：用人话，不出现状态文件名、内部模块名（ADR 0010 D11）。
 * @param {{skills?:{available:boolean,registered:number,error?:string}}} [deps]
 */
export function health(root, deps = {}) {
  const checks = [];
  const push = (name, status, detail) => checks.push({ name, status, detail });
  const r = store.readBoard(root);
  let b = null;
  if (r.ok) {
    b = r.board;
    push(HEALTH_NAMES.boardReadable, 'ok', r.fresh ? '还没有看板数据，第一次保存时会自动创建' : '读取正常');
    const v = store.validateBoard(b);
    push(HEALTH_NAMES.boardValid, v.ok ? 'ok' : 'fail', v.ok ? '数据校验通过' : v.reason);
    const sameVersion = b.version === schema.SCHEMA_VERSION;
    push(HEALTH_NAMES.dataVersion, sameVersion ? 'ok' : 'fail', sameVersion
      ? '看板数据的版本与插件一致'
      : `看板数据是版本 ${b.version}，这个插件支持的是版本 ${schema.SCHEMA_VERSION}`);
    const missingDirs = (b.engagements || []).filter((e) => e.dir && !existsSync(store.projectAbs(root, e.dir))).map((e) => e.dir);
    push(HEALTH_NAMES.folders, missingDirs.length ? 'warn' : 'ok', missingDirs.length ? `有 ${missingDirs.length} 个客户文件夹找不到了：${missingDirs.slice(0, 5).join('、')}` : '全部都在');
  } else {
    push(HEALTH_NAMES.boardReadable, 'fail', r.reason);
    b = null;
  }
  const dataDirOk = store.canWriteDir(store.fdeDir(root));
  push(HEALTH_NAMES.dataDirWritable, dataDirOk ? 'ok' : 'fail', dataDirOk ? '可以正常保存' : `没有写入权限：${store.fdeDir(root)}`);
  const bk = store.backupsDir(root);
  push(HEALTH_NAMES.backups, existsSync(bk) ? 'ok' : 'warn', existsSync(bk) ? `每次保存前自动备份，现有 ${store.listBackups(root).length} 份` : '还没有备份，第一次保存时会自动创建');
  const sk = deps.skills || {};
  if (sk.available) push(HEALTH_NAMES.skills, sk.registered > 0 ? 'ok' : 'warn', `技能已注册 ${sk.registered} 个`);
  else push(HEALTH_NAMES.skills, 'warn', '技能暂时用不了：AI 会改为直接读方法文件来执行，其它功能不受影响');
  /* 招采雷达（spec §17.8）：服务可用且 records>0 → ok；未装载/旧版本 → warn（不 fail，FDE 其余功能不受影响）。 */
  const bidSvc = deps.bidIntel || null;
  if (bids.isAvailable(bidSvc)) {
    let meta = null;
    try { meta = bidSvc.dataMeta(); } catch { meta = null; }
    const records = Number(meta && meta.records) || 0;
    push(HEALTH_NAMES.bidRadar, records > 0 ? 'ok' : 'warn', records > 0
      ? `招采雷达可用（${records} 条公告）`
      : '招采雷达已装好，但还没有公告数据（先采集或导入）');
  } else {
    push(HEALTH_NAMES.bidRadar, 'warn', '招采雷达还没装好或版本太旧：招采功能暂时用不了，其它功能不受影响');
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
 * source 固定为 'runtime'：DSH 0.2.1 的技能服务在加载时校验 source 是字符串，
 * 运行时注册（ctx.skills.register）的既定取值就是 'runtime'。
 * @returns {Array<{name,description,content,path,source,resourceBase}>}
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
          source: 'runtime',
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
    if (!engagement) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
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
  if (!engagement) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
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
    if (!e) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
    const rec = bids.recordById(service, bidId);
    if (!rec) return err(`未找到公告：${bidId}`, 'NOT_FOUND');
    const r = bids.applyLink(board, e, { record: rec, bidId, relation: body.relation, note: body.note, by, now: store.nowIso() });
    if (!r.ok) return err(r.reason, r.code || 'INVALID');
    if (!r.changed) return noWrite({ available: true, link: r.link, engagement: e, changed: false, warning: '已关联，关系/备注已同步' });
    store.pushTimeline(e, { kind: 'note', text: `关联招采公告：${r.link.title || '（未命名公告）'}`, by });
    store.pushActivity(board, { kind: 'updated', text: `${e.name}关联了招采公告：${r.link.title || '（未命名公告）'}`, engagementId: e.id, by });
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
    if (!e) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
    /* 记录里写公告标题，不写公告编号：取消前先记下标题。 */
    const unlinkedTitle = ((bids.linksOf(e) || []).find((x) => x && x.bidId === bidId) || {}).title || '';
    const r = bids.applyUnlink(board, e, bidId, by, store.nowIso());
    if (!r.ok) return err(r.reason, r.code || 'INVALID');
    if (!r.changed) return noWrite({ unlinked: false, changed: false, engagement: e });
    store.pushTimeline(e, { kind: 'note', text: `取消关联招采公告${unlinkedTitle ? '：' + unlinkedTitle : ''}`, by });
    store.pushActivity(board, { kind: 'updated', text: `${e.name}取消关联了一条招采公告`, engagementId: e.id, by });
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
    if (!e) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
    const rec = bids.recordById(service, bidId);
    if (!rec) return err(`未找到公告：${bidId}`, 'NOT_FOUND');
    const r = bids.applyPromote(board, e, {
      record: rec, bidId, relation: body.relation, note: body.note,
      by, now: store.nowIso(), settings: board.settings,
    });
    if (!r.ok) return err(r.reason, r.code || 'INVALID');
    store.pushTimeline(e, { kind: 'note', text: `为招采公告建了跟进任务：${r.item.title}`, by });
    store.pushActivity(board, { kind: 'created', text: `建了跟进任务：${r.item.title}`, engagementId: e.id, itemId: r.item.id, by });
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
    if (!e) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
    engagement = e;
    match = bids.matchEngagement(service, e, { refresh: true, ttlMs: ttlOf(board) });
    const w = bids.ensureBidWatch(e);
    w.lastMatchAt = store.nowIso();
    store.pushActivity(board, { kind: 'updated', text: `刷新了${e.name}的招采公告`, engagementId: e.id, by });
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
  if (!args.q) return err('查采购节奏需要 q（公司或采购单位关键字）');
  let r = null;
  try { r = service.timeline ? service.timeline(args) : null; } catch (e) {
    return err('采购节奏查询失败：' + String((e && e.message) || e), 'INTERNAL');
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
  if (args.engagementId && !engagement) return err(NOT_FOUND_ENGAGEMENT, 'NOT_FOUND');
  const it = args.itemId ? findById(pre.board.items, args.itemId) : null;
  if (args.itemId && !it) return err(NOT_FOUND_ITEM, 'NOT_FOUND');
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
    store.pushActivity(b, { kind: 'updated', text: `写了复盘草稿：${base}`, engagementId: engagement ? engagement.id : '', itemId: it ? it.id : '', by });
    return okr({});
  });
  return okr({
    draftPath: file,
    targets,
    bytes: md.length,
    engagementId: engagement ? engagement.id : '',
    itemId: it ? it.id : '',
    next: '草稿在 research/.fde/drafts/，不是客户文件夹里的定稿。人审后：事实复盘进客户文件夹，方法沉淀进插件仓 docs/retros/、methods/、reference/、skills/（脱敏，示例用「某集团」）。',
    boardWritten: !!rec.ok,
    board: rec.ok ? rec.board : undefined,
  });
}
