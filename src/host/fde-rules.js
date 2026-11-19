/**
 * FDE 工作站 · 规则层
 *
 * - 门禁评估：自动检查来自工件扫描，人工项来自 gateState.checks（spec §2.2）
 * - 派生注意力：blocked/decision/review/answer/overdue/gate/stall/proposal（spec §5 / §22.3）
 * - proposals（提醒）：spec §6 规则 + 同 rule+target 24h 去重 + pending 上限；
 *   derived 规则不生成、条件消失自动失效、条件仍在时标题保持准确（spec §22.2）
 *
 * 本模块返回的 text / title / detail / label 都是给人看的：用 ADR 0010 D1 的词，
 * 不出现字段名、规则编号、目录规则与英文枚举。
 *
 * 纯计算：不写盘；只改 board.proposals（新建 / 失效 / 更新标题），是否落盘由 fde-api.js 判断。
 * 写入与动作执行在 fde-api.js。
 * 只依赖 node 内置与本目录模块。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from './fde-schema.js';
import * as store from './fde-store.js';
import * as bids from './fde-bids.js';

/* ============================ 通用小工具 ============================ */

/** 仍在流转的任务状态（已完成 / 已取消之外）。 */
const OPEN_LANES = ['inbox', 'todo', 'doing', 'waiting', 'review'];

function getPath(obj, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function nonEmpty(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

/** 客户最近活动时间（ISO）：timeline / stageSince / createdAt 的最大值。 */
export function lastActivityAt(engagement) {
  if (!engagement) return '';
  const times = [engagement.stageSince, engagement.createdAt];
  for (const t of engagement.timeline || []) if (t && t.at) times.push(t.at);
  let best = '';
  let bestMs = -Infinity;
  for (const t of times) {
    const ms = Date.parse(String(t || ''));
    if (Number.isFinite(ms) && ms > bestMs) { bestMs = ms; best = t; }
  }
  return best;
}

/** 阶段停留天数（自 stageSince；非法返回 0）。 */
export function stageStayDays(engagement, now) {
  const d = store.daysSince(engagement && engagement.stageSince, now);
  return Number.isFinite(d) ? Math.max(0, Math.floor(d)) : 0;
}

/** item 在某泳道停留天数：取最后一条 history 时间（无则 createdAt）。 */
export function itemStayDays(item, now) {
  if (!item) return 0;
  const hist = Array.isArray(item.history) ? item.history : [];
  let ref = item.createdAt;
  let bestMs = Date.parse(String(ref || ''));
  for (const h of hist) {
    const ms = Date.parse(String((h && h.at) || ''));
    if (Number.isFinite(ms) && ms >= bestMs) { bestMs = ms; ref = h.at; }
  }
  const d = store.daysSince(ref, now);
  return Number.isFinite(d) ? Math.max(0, Math.floor(d)) : 0;
}

/** 「今天」的本地日期字符串。 */
export function todayOf(now) { return store.todayStr(now); }

/** 到期状态：overdue | due_soon | future | none。 */
export function dueStatus(due, now) {
  if (!store.isDueStr(due)) return 'none';
  const today = store.todayStr(now);
  const diff = store.diffDays(today, due);
  if (!Number.isFinite(diff)) return 'none';
  if (diff < 0) return 'overdue';
  if (diff <= schema.DUE_SOON_DAYS) return 'due_soon';
  return 'future';
}

/** 进入下一阶段前要过的门禁（最后一阶段用当前门禁）。 */
export function nextGate(engagement) {
  if (!engagement) return null;
  const cur = engagement.stage;
  if (!schema.isStage(cur)) return null;
  const nxt = schema.nextStage(cur);
  const stage = nxt || cur;
  const gateKey = schema.gateKeyOfStage(stage);
  return gateKey ? { stage, gateKey } : null;
}

/** 当前阶段门禁 key（未过说明还停在门口）。 */
export function currentGate(engagement) {
  if (!engagement || !schema.isStage(engagement.stage)) return null;
  const gateKey = schema.gateKeyOfStage(engagement.stage);
  return gateKey ? { stage: engagement.stage, gateKey } : null;
}

/* ============================ 门禁评估 ============================ */

/** 客户没有关联文件夹时，材料类检查没法核对（给人看的原因）。 */
const NO_FOLDER_TEXT = '这家客户还没有关联文件夹，没法核对材料';
const NO_FOLDER_CONTENT_TEXT = '这家客户还没有关联文件夹，没法核对方案内容';

/**
 * 单个自动检查（材料）。判定逻辑只看 schema 的 type / field / alternatives / min；
 * detail 是没通过时给人看的原因：不含字段路径、目录规则与正则（ADR 0010 D11）。
 */
function evalAutoCheck(root, engagement, check, scan) {
  const base = { key: check.key, label: check.label, type: check.type };
  /* schema 的 missingText 优先；新增检查项忘了写时兜底为「还没满足：<检查项名称>」。 */
  const missing = check.missingText || `还没满足：${check.label}`;
  try {
    switch (check.type) {
      case 'field': {
        const v = getPath(engagement, check.field);
        return Object.assign(base, { ok: nonEmpty(v), evidence: nonEmpty(v) ? String(v) : '', detail: nonEmpty(v) ? '' : missing });
      }
      case 'archive': {
        const p = engagement.dir ? join(store.projectAbs(root, engagement.dir) || '', store.ARCHIVE) : '';
        const ok = !!p && existsSync(p);
        return Object.assign(base, { ok, evidence: ok ? store.ARCHIVE : '', detail: ok ? '' : (engagement.dir ? missing : NO_FOLDER_TEXT) });
      }
      case 'artifact': {
        const alts = Array.isArray(check.alternatives) ? check.alternatives : [];
        const hits = [];
        for (const alt of alts) {
          const r = store.matchArtifacts(scan && scan.files ? scan.files : [], alt, check.min);
          if (r.ok) { hits.push(...r.hits.map((h) => h.rel)); }
        }
        const uniq = [...new Set(hits)].slice(0, 5);
        const ok = uniq.length > 0;
        /* evidence 用字符串（面板直接拼「证据：…」）；同时给 matches 数组供程序消费。 */
        return Object.assign(base, { ok, evidence: uniq.join('、'), matches: uniq, detail: ok ? '' : (engagement.dir ? missing : NO_FOLDER_TEXT) });
      }
      case 'content': {
        const alts = Array.isArray(check.alternatives) ? check.alternatives : [];
        if (!engagement.dir) return Object.assign(base, { ok: false, evidence: '', matches: [], detail: NO_FOLDER_CONTENT_TEXT });
        const r = store.contentMatches(root, engagement.dir, alts);
        const rels = (r.hits || []).map((h) => h.rel);
        return Object.assign(base, { ok: r.ok, evidence: rels.join('、'), matches: rels, detail: r.ok ? '' : missing });
      }
      case 'stakeholders': {
        const n = Array.isArray(engagement.stakeholders) ? engagement.stakeholders.length : 0;
        const min = Number(check.min) || 1;
        return Object.assign(base, { ok: n >= min, evidence: String(n), detail: n >= min ? '' : `只登记了 ${n} 位关键人，至少需要 ${min} 位` });
      }
      default:
        return Object.assign(base, { ok: false, evidence: '', detail: '这一项暂时没法自动核对' });
    }
  } catch (e) {
    return Object.assign(base, { ok: false, evidence: '', detail: `核对时出错：${(e && e.message) || e}` });
  }
}

/**
 * 评估某门禁。
 * @param {string} root 工作区根
 * @param {object} engagement board.engagements[i]
 * @param {string} gateKey GATES 的 key
 * @param {{scan?:object, now?:number, ttlMs?:number}} [opts] 传入已扫描工件可复用
 * @returns {null|{key,label,stage,status,forced,auto,manual,missing,passed,evaluatedAt}}
 */
export function evaluateGate(root, engagement, gateKey, opts = {}) {
  const def = schema.gateDef(gateKey);
  if (!def) return null;
  const scan = opts.scan || (engagement.dir ? store.scanProjectArtifacts(root, engagement.dir, { ttlMs: opts.ttlMs }) : null);
  const auto = def.auto.map((c) => evalAutoCheck(root, engagement, c, scan));
  const gsKey = schema.gateStateKey(gateKey);
  const gateState = (engagement.gateState && engagement.gateState[gsKey]) || {};
  const checks = gateState.checks || {};
  const manual = def.manual.map((c) => {
    const rec = checks[c.key] || {};
    const pass = rec.status === 'pass';
    return { key: c.key, label: c.label, status: pass ? 'pass' : 'pending', evidence: rec.evidence || '', at: rec.at || '' };
  });
  const missing = [];
  for (const c of auto) if (!c.ok) missing.push({ type: 'auto', key: c.key, label: c.label, detail: c.detail || '' });
  for (const c of manual) if (c.status !== 'pass') missing.push({ type: 'manual', key: c.key, label: c.label });
  const passed = missing.length === 0;
  const forced = !!gateState.forced && !passed;
  let status = passed ? 'pass' : (forced ? 'forced' : (gateState.status === 'failed' ? 'failed' : 'pending'));
  return {
    key: def.key,
    label: def.label,
    stage: def.stage,
    gateStateKey: gsKey,
    status,
    forced,
    auto,
    manual,
    missing,
    passed,
    evaluatedAt: store.nowIso(opts.now),
  };
}

/* ============================ 派生注意力 ============================ */

/**
 * 一条待我处理。text（同时也是 title）是不带「种类：」前缀的完整句子（spec §22.3）；
 * detail 保留结构化用途（问题 / 下一步 / 缺项 / 所属客户名）；question 是提问原文（没有则空串）。
 */
function makeAttention(kind, { engagement, item, text, detail, question, due, days, priority, extra }) {
  const def = schema.attentionDef(kind) || { actions: [] };
  return Object.assign({
    kind,
    rank: schema.attentionRank(kind),
    text: text || '',
    title: text || '',
    detail: detail || '',
    question: question || '',
    engagementId: engagement ? engagement.id : '',
    engagementName: engagement ? engagement.name : '',
    itemId: item ? item.id : '',
    itemTitle: item ? item.title : '',
    due: due || '',
    days: Number.isFinite(days) ? days : null,
    priority: priority || 'normal',
    actions: (def.actions || []).slice(),
    target: def.target || (item ? 'item' : 'engagement'),
  }, extra || {});
}

/** 注意力排序：kind 优先级 → 到期日升序 → 优先级。 */
export function sortAttention(list) {
  return (list || []).slice().sort((a, b) => {
    const ra = Number(a.rank) || 99;
    const rb = Number(b.rank) || 99;
    if (ra !== rb) return ra - rb;
    const da = a.due || '9999-12-31';
    const db = b.due || '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    const pa = schema.priorityOrder(a.priority);
    const pb = schema.priorityOrder(b.priority);
    if (pa !== pb) return pa - pb;
    return String(a.text).localeCompare(String(b.text));
  });
}

/**
 * 派生注意力（读取时计算，不写文件）。proposals 以 pending 形式进入列表。
 * @param {string} root
 * @param {object} board
 * @param {{now?:number, ttlMs?:number}} [opts]
 */
export function derivedAttention(root, board, opts = {}) {
  const now = opts.now == null ? Date.now() : opts.now;
  const today = store.todayStr(now);
  const settings = Object.assign({}, schema.DEFAULT_SETTINGS, board.settings || {});
  const stallDays = Math.max(1, Number(settings.stallDays) || 14);
  const out = [];
  const scans = new Map();
  const scanOf = (engagement) => {
    if (!engagement || !engagement.dir) return null;
    if (!scans.has(engagement.dir)) scans.set(engagement.dir, store.scanProjectArtifacts(root, engagement.dir, { ttlMs: opts.ttlMs }));
    return scans.get(engagement.dir);
  };
  const engById = new Map((board.engagements || []).map((e) => [e.id, e]));

  /* 显式提问三类的句式：「<客户名>卡住了：<问题>」「任务「<标题>」卡住了：<问题>」（等你决定 / 等你回复同理）。 */
  const ASK_WORDS = { blocked: '卡住了', decision: '等你决定', answer: '等你回复' };
  const askText = (subject, kind, question) => {
    const head = subject;
    if (question) return `${head}${ASK_WORDS[kind]}：${question}`;
    return kind === 'blocked' ? `${head}卡住了，等你处理` : `${head}${ASK_WORDS[kind]}`;
  };

  for (const e of board.engagements || []) {
    if (!schema.isStage(e.stage)) continue;
    const att = e.attention;
    if (att && ASK_WORDS[att.kind]) {
      const question = String(att.question || '').trim();
      out.push(makeAttention(att.kind, {
        engagement: e, text: askText(e.name, att.kind, question),
        detail: question, question, due: e.nextAction && e.nextAction.due, priority: e.priority,
      }));
    }

    const naDue = e.nextAction && e.nextAction.due;
    if (store.isDueStr(naDue) && naDue < today) {
      const days = store.diffDays(naDue, today);
      const naText = String((e.nextAction && e.nextAction.text) || '').trim();
      out.push(makeAttention('overdue', {
        engagement: e, text: `${e.name}的下一步已逾期 ${days} 天${naText ? '：' + naText : ''}`,
        detail: naText, due: naDue, days, priority: e.priority,
      }));
    }

    const stay = stageStayDays(e, now);
    const ng = nextGate(e);
    if (ng && !e.paused) {
      const gate = evaluateGate(root, e, ng.gateKey, { now, scan: scanOf(e), ttlMs: opts.ttlMs });
      const autoAllPass = gate && gate.auto.every((c) => c.ok);
      const manualPending = gate ? gate.manual.filter((c) => c.status !== 'pass').length : 0;
      if (gate && autoAllPass && manualPending > 0 && stay > schema.GATE_WAIT_DAYS) {
        /* 最后一个阶段没有「下一阶段」，nextGate 返回的是当前阶段自己的推进条件。 */
        const where = ng.stage === e.stage
          ? `在「${schema.stageLabel(ng.stage)}」阶段`
          : `进入「${schema.stageLabel(ng.stage)}」`;
        out.push(makeAttention('gate', {
          engagement: e,
          text: `${e.name}${where}的材料已齐，还有 ${manualPending} 项等你确认`,
          detail: gate.missing.map((m) => m.label).join('、'),
          due: '', days: stay, priority: e.priority,
          extra: { gateKey: gate.key, stage: ng.stage, missing: gate.missing, manual: gate.manual },
        }));
      }
    }

    const last = lastActivityAt(e);
    const idle = Number.isFinite(store.daysSince(last, now)) ? Math.floor(store.daysSince(last, now)) : 0;
    if (!e.paused && idle > stallDays) {
      out.push(makeAttention('stall', {
        engagement: e, text: `${e.name}已 ${idle} 天没有进展`,
        detail: `在「${schema.stageLabel(e.stage)}」已 ${stay} 天`,
        due: '', days: idle, priority: e.priority, extra: { stage: e.stage },
      }));
    }
  }

  for (const it of board.items || []) {
    if (!OPEN_LANES.includes(it.stage)) continue;
    const e = it.engagementId ? engById.get(it.engagementId) : null;
    const subject = `任务「${it.title}」`;
    /* 任务行的 detail：提问类放问题原文；其余放所属客户名（独立任务为空串）。 */
    const owner = e ? e.name : '';
    const att = it.attention;
    if (att && ASK_WORDS[att.kind]) {
      const question = String(att.question || '').trim();
      out.push(makeAttention(att.kind, {
        engagement: e, item: it, text: askText(subject, att.kind, question),
        detail: question, question, due: it.due, priority: it.priority,
      }));
    }
    if (it.stage === 'review') {
      out.push(makeAttention('review', {
        engagement: e, item: it, text: `${subject}做完了，等你验收`, detail: owner,
        due: it.due, days: itemStayDays(it, now), priority: it.priority,
      }));
    }
    if (store.isDueStr(it.due) && it.due < today) {
      const days = store.diffDays(it.due, today);
      out.push(makeAttention('overdue', {
        engagement: e, item: it, text: `${subject}已逾期 ${days} 天`,
        detail: owner, due: it.due, days, priority: it.priority,
      }));
    }
  }

  for (const p of board.proposals || []) {
    if (p.status !== 'pending') continue;
    const e = p.engagementId ? engById.get(p.engagementId) : null;
    out.push(makeAttention('proposal', {
      engagement: e, text: p.title, detail: p.detail || '',
      priority: e ? e.priority : 'normal', extra: { proposalId: p.id, ruleId: p.ruleId },
    }));
  }

  return sortAttention(out);
}

/* ============================ proposals（提醒）生成与失效 ============================ */

function proposalRecentlyExists(board, ruleId, engagementId, itemId, nowMs) {
  const eid = engagementId || '';
  const iid = itemId || '';
  return (board.proposals || []).some((p) => {
    if (!p) return false;
    if (p.ruleId !== ruleId) return false;
    if ((p.engagementId || '') !== eid) return false;
    if ((p.itemId || '') !== iid) return false;
    if (p.status === 'pending') return true; /* 待处理的提醒不再重复生成 */
    /* 已处理 / 已知会 / 自动失效的，都按创建时间计入 24 小时去重窗口（spec §22.2）。 */
    const t = Date.parse(String(p.createdAt || ''));
    return Number.isFinite(t) && nowMs - t < schema.PROPOSAL_DEDUPE_MS;
  });
}

/** 到期的口语说法：今天 / 明天 / N 天后。 */
function dueWords(days) {
  if (days <= 0) return '今天';
  if (days === 1) return '明天';
  return `${days} 天后`;
}

/**
 * bid_signal 提醒的标题与详情。只依赖 payload 与客户名，不依赖招采服务：
 * 生成时与刷新时用同一个函数，服务不可用也能把存量提醒的文案对齐。
 */
function bidSignalText(payload, engagement) {
  const pl = payload || {};
  const buyer = String(pl.buyer || (engagement && engagement.name) || '').trim() || '客户';
  const rule = schema.ruleDef('bid_signal');
  return {
    title: `${buyer}发布了新公告：《${String(pl.title || '').trim() || '未命名公告'}》${pl.date ? `（${pl.date}）` : ''}`,
    detail: rule ? rule.detail : '',
  };
}

/**
 * 规则求值：生成提醒、让条件已不成立的提醒自动失效、让条件仍成立的提醒标题保持准确
 * （读取 board / 生成 brief / sync 时调用；spec §6 / §22.2，ADR 0010 D4）。
 *
 * 一次刷新分三步，顺序不能换：
 *   ① 求值   只读 board，算出「当前条件成立」的集合（key = ruleId + engagementId + itemId），
 *            与去重、上限无关——即使这次不会新建，它也算成立。
 *   ② 失效   逐条看待处理的提醒：derived 规则遗留的、条件已不在 ① 集合里的 → 失效
 *            （status='dismissed'、expired=true、decidedAt=now，不写 activity / timeline）；
 *            条件仍在的，标题或详情变了就原地更新（不改 id / createdAt）。
 *            bid_signal 是一次性事件，不参与 ① 的集合：只按创建时间（超过 bidSignalDays × 2 天）
 *            或客户已暂停 / 已终止来失效；招采雷达不可用、招采关注关闭都不会让它失效。
 *   ③ 生成   按 ① 的结果新建。失效在前，所以过期的先腾出名额（待处理上限 8 条），
 *            新条件在同一次刷新里就能出现；而 ② 只看 ① 的集合、不看 ③ 新建的，
 *            所以本次刚成立的条件不会被误判为失效。
 *
 * derived 规则（stall / overdue / gate_ready / review_lag）的情形由 derivedAttention 覆盖，
 * 这里不再求值、不再生成。
 *
 * 只改 board.proposals（及派生字段 bidWatch.lastMatchAt）；是否落盘由调用方按
 * added / expired / updated 判断——三者都为 0 时不应写盘。
 * @returns {{added:object[], existing:number, expired:number, updated:number, pruned:number}}
 */
export function refreshProposals(root, board, opts = {}) {
  const now = opts.now == null ? Date.now() : opts.now;
  const nowIso = store.nowIso(now);
  const today = store.todayStr(now);
  const settings = Object.assign({}, schema.DEFAULT_SETTINGS, board.settings || {});
  const created = [];
  let expired = 0;
  let updated = 0;
  if (!Array.isArray(board.proposals)) board.proposals = [];
  const pendingCount = () => board.proposals.filter((p) => p && p.status === 'pending').length;
  const engById = new Map((board.engagements || []).map((e) => [e.id, e]));

  /* ---------------- ① 求值：当前成立的条件（不改 board） ---------------- */
  const candidates = [];
  const live = new Map();
  const keyOf = (ruleId, engagementId, itemId) => `${ruleId}|${engagementId || ''}|${itemId || ''}`;
  const want = (ruleId, c) => {
    if (schema.isDerivedRule(ruleId)) return; /* derived 规则不生成（由待我处理覆盖） */
    const rule = schema.ruleDef(ruleId);
    const cand = {
      ruleId,
      engagement: c.engagement || null,
      item: c.item || null,
      kind: c.kind || (rule ? rule.kind : 'nudge'),
      title: c.title || '',
      /* detail 显式给空串就是空串；没给才用规则的默认说明。 */
      detail: c.detail == null ? (rule ? rule.detail : '') : c.detail,
      payload: c.payload || {},
    };
    candidates.push(cand);
    live.set(keyOf(ruleId, cand.engagement && cand.engagement.id, cand.item && cand.item.id), cand);
  };

  for (const e of board.engagements || []) {
    if (!schema.isStage(e.stage) || e.paused) continue;
    const na = e.nextAction || {};
    const naText = nonEmpty(na.text) ? String(na.text).trim() : '';

    /* due_soon：客户的下一步快到期 */
    if (dueStatus(na.due, now) === 'due_soon') {
      const days = Math.max(0, store.diffDays(today, na.due));
      want('due_soon', {
        engagement: e,
        /* 「的下一步今天到期」「的下一步明天到期」「的下一步 2 天后到期」：数字前留一个空格。 */
        title: `${e.name}的下一步${days >= 2 ? ' ' : ''}${dueWords(days)}到期${naText ? '：' + naText : ''}`,
        detail: '',
        payload: {},
      });
    }

    /* no_next：在跟的客户还没定下一步 */
    if (!naText) {
      want('no_next', {
        engagement: e,
        title: `${e.name}还没定下一步`,
        payload: { patch: { nextAction: { text: `确认${e.name}的下一步` } } },
      });
    }
  }

  for (const it of board.items || []) {
    if (!OPEN_LANES.includes(it.stage)) continue;
    const e = it.engagementId ? engById.get(it.engagementId) : null;
    /* 已暂停或已终止（归档 / 流失）客户名下的任务不提醒。 */
    if (e && (e.paused || !schema.isStage(e.stage))) continue;
    if (dueStatus(it.due, now) !== 'due_soon') continue;
    if (it.type === 'meeting') {
      want('meeting_soon', {
        engagement: e, item: it,
        title: `会面快到了：${it.title}（${it.due}）`,
        kind: 'start_session',
        payload: { intent: 'meeting', itemId: it.id },
      });
    } else {
      const days = Math.max(0, store.diffDays(today, it.due));
      want('due_soon', {
        engagement: e, item: it,
        title: `任务「${it.title}」${dueWords(days)}到期`,
        detail: '',
        payload: {},
      });
    }
  }

  /* ---------------- ② 失效与标题更新（先于生成，腾出待处理名额） ---------------- */
  const bidSignalDays = Math.max(1, Number(settings.bidSignalDays) || schema.BID_DEFAULT_SIGNAL_DAYS);
  const bidMaxAgeMs = bidSignalDays * 2 * 86400000;
  const expire = (p) => {
    p.status = 'dismissed';
    p.expired = true;
    p.decidedAt = nowIso;
    expired += 1;
  };
  const retitle = (p, title, detail) => {
    if (p.title === title && (p.detail || '') === (detail || '')) return;
    p.title = title;
    p.detail = detail || '';
    updated += 1;
  };
  for (const p of board.proposals) {
    if (!p || p.status !== 'pending') continue;
    if (schema.isDerivedRule(p.ruleId)) { expire(p); continue; }
    if (p.ruleId === 'bid_signal') {
      const e = p.engagementId ? engById.get(p.engagementId) : null;
      const createdMs = Date.parse(String(p.createdAt || ''));
      const tooOld = Number.isFinite(createdMs) && now - createdMs > bidMaxAgeMs;
      const inactive = !e || !schema.isStage(e.stage) || !!e.paused;
      if (tooOld || inactive) { expire(p); continue; }
      const t = bidSignalText(p.payload, e);
      retitle(p, t.title, t.detail);
      continue;
    }
    const cand = live.get(keyOf(p.ruleId, p.engagementId, p.itemId));
    if (!cand) { expire(p); continue; }
    retitle(p, cand.title, cand.detail);
  }

  /* ---------------- ③ 生成 ---------------- */
  const add = (cand, { skipDedupe = false } = {}) => {
    /* 已 push 的提醒会被 pendingCount() 计入，不要再加 created.length（否则首轮最多只出 4 条）。 */
    if (pendingCount() >= schema.MAX_PENDING_PROPOSALS) return null;
    const eid = (cand.engagement && cand.engagement.id) || '';
    const iid = (cand.item && cand.item.id) || '';
    /* bid_signal 以 payload.bidId 为去重键（由规则内 bidProposalSeen 处理），不能按 engagement+item 去重。 */
    if (!skipDedupe && proposalRecentlyExists(board, cand.ruleId, eid, iid, now)) return null;
    const p = {
      id: store.newProposalId(),
      ruleId: cand.ruleId,
      engagementId: eid,
      itemId: iid,
      kind: cand.kind,
      title: cand.title,
      detail: cand.detail,
      payload: cand.payload,
      status: 'pending',
      createdAt: nowIso,
      decidedAt: '',
    };
    board.proposals.push(p);
    created.push(p);
    return p;
  };
  for (const cand of candidates) add(cand);

  /* ---------------- 新招采公告（spec §17.6；一次性事件，不进 ① 的集合） ---------------- */
  const rawSettings = board.settings || {};
  const bidService = opts.bidIntel || null;
  if (rawSettings.sources && rawSettings.sources.bidWatch === true && bids.isAvailable(bidService)) {
    const bidRule = schema.ruleDef('bid_signal');
    const bidProposalSeen = (engagementId, bidId) => (board.proposals || []).some((p) => {
      if (!p || p.ruleId !== 'bid_signal') return false;
      if ((p.engagementId || '') !== (engagementId || '')) return false;
      const pid = p.payload && p.payload.bidId;
      if (pid !== bidId) return false;
      if (p.status === 'pending' || p.status === 'accepted') return true;
      if (p.status === 'dismissed') {
        const t = Date.parse(String(p.decidedAt || p.createdAt || ''));
        return Number.isFinite(t) && now - t < bids.SIGNAL_DISMISS_DAYS * 86400000;
      }
      return false;
    });
    const meta = opts.bidMeta || null;
    for (const e of board.engagements || []) {
      if (!schema.isStage(e.stage) || e.paused) continue;
      if (e.bidWatch && e.bidWatch.enabled === false) continue;
      let match = null;
      try {
        match = bids.matchEngagement(bidService, e, {
          ttlMs: opts.ttlMs,
          maxQueries: bids.SUMMARY_QUERY_LIMIT,
          perQueryLimit: 30,
          limit: bids.MATCH_ITEM_LIMIT,
          meta,
        });
      } catch { match = null; }
      if (!match || !match.available) continue;
      const signals = bids.signalCandidates(match, { days: bidSignalDays, now });
      const pendingForEngagement = (board.proposals || []).filter((p) => p && p.ruleId === 'bid_signal' &&
        p.engagementId === e.id && p.status === 'pending').length;
      let addedForEngagement = 0;
      for (const it of signals) {
        /* 每客户最多 3 条待处理（跨刷新稳定，避免每次读板都累积噪音）。 */
        if (addedForEngagement + pendingForEngagement >= bids.SIGNAL_ITEM_LIMIT) break;
        if (bidProposalSeen(e.id, it.id)) continue;
        const payload = {
          kind: 'create_item',
          engagementId: e.id,
          bidId: it.id,
          title: it.title,
          date: it.date,
          buyer: it.buyer || '',
          url: it.url || '',
          relation: it.relation,
          bidKind: it.kind,
        };
        const t = bidSignalText(payload, e);
        const p = add({
          ruleId: 'bid_signal',
          engagement: e,
          item: null,
          kind: 'create_item',
          title: t.title,
          detail: t.detail || (bidRule ? bidRule.detail : ''),
          payload,
        }, { skipDedupe: true });
        if (p) addedForEngagement += 1;
      }
      /* 记录最近一次匹配时间（派生字段，仅在真正写盘时随 board 落盘；失败不影响主流程） */
      if (match.generatedAt) {
        try { bids.ensureBidWatch(e).lastMatchAt = match.generatedAt; } catch { /* 忽略 */ }
      }
    }
  }

  /* 清理：已处理或已失效超过保留期的提醒不再留在看板数据里。
   * 只在本次已有其它变更时顺带清理，不因清理单独触发写盘；
   * 保留期覆盖 24 小时去重窗口与招采公告的静默期。 */
  let pruned = 0;
  if (created.length || expired || updated) {
    const keepMs = Math.max(45, bidSignalDays * 2 + 1) * 86400000;
    const kept = board.proposals.filter((p) => {
      if (!p) return false;
      if (p.status === 'pending') return true;
      const t = Date.parse(String(p.decidedAt || p.createdAt || ''));
      return !Number.isFinite(t) || now - t <= keepMs;
    });
    pruned = board.proposals.length - kept.length;
    if (pruned) board.proposals = kept;
  }

  return { added: created, existing: board.proposals.length, expired, updated, pruned };
}

/* ============================ 统计 ============================ */

/** 看板统计（spec §4 board 响应 stats）。 */
export function computeStats(root, board, attention, opts = {}) {
  const now = opts.now == null ? Date.now() : opts.now;
  const today = store.todayStr(now);
  const byStage = {};
  for (const s of schema.ENGAGEMENT_STAGES) byStage[s.key] = 0;
  let active = 0;
  let overdue = 0;
  let dueToday = 0;
  for (const e of board.engagements || []) {
    if (!schema.isStage(e.stage)) continue;
    if (!e.paused) active += 1;
    byStage[e.stage] = (byStage[e.stage] || 0) + 1;
    if (store.isDueStr(e.nextAction && e.nextAction.due)) {
      if (e.nextAction.due < today) overdue += 1;
      else if (e.nextAction.due === today) dueToday += 1;
    }
  }
  const byLane = {};
  for (const l of schema.ITEM_LANES) byLane[l.key] = 0;
  let itemOverdue = 0;
  for (const it of board.items || []) {
    byLane[it.stage] = (byLane[it.stage] || 0) + 1;
    if (OPEN_LANES.includes(it.stage) && store.isDueStr(it.due) && it.due < today) itemOverdue += 1;
  }
  return {
    engagements: (board.engagements || []).length,
    active,
    byStage,
    items: (board.items || []).length,
    byLane,
    proposalsPending: (board.proposals || []).filter((p) => p.status === 'pending').length,
    /* attention = 派生注意力全部条数（含 proposal 种类，兼容旧口径）；
     * todo = 必须有人动作的条数（不含提醒；面板「待我处理」与页签角标用它，spec §22.3）。 */
    attention: (attention || []).length,
    todo: (attention || []).filter((a) => a && a.kind !== 'proposal').length,
    overdue: overdue + itemOverdue,
    dueToday,
  };
}
