/**
 * FDE 工作站 · 规则层
 *
 * - 门禁评估：自动检查来自工件扫描，人工项来自 gateState.checks（spec §2.2）
 * - 派生注意力：blocked/decision/review/answer/overdue/gate/stall/proposal（spec §5）
 * - proposals 生成：spec §6 规则 + 同 rule+target 24h 去重 + pending 上限
 *
 * 纯计算：不写盘、不改 board 持久状态（只向 proposals 数组追加候选）；
 * 写入与动作执行在 fde-api.js。
 * 只依赖 node 内置与本目录模块。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from './fde-schema.js';
import * as store from './fde-store.js';
import * as bids from './fde-bids.js';

/* ============================ 通用小工具 ============================ */

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

function evalAutoCheck(root, engagement, check, scan) {
  const base = { key: check.key, label: check.label, type: check.type };
  try {
    switch (check.type) {
      case 'field': {
        const v = getPath(engagement, check.field);
        return Object.assign(base, { ok: nonEmpty(v), evidence: nonEmpty(v) ? String(v) : '', detail: nonEmpty(v) ? '' : `未填写 ${check.field}` });
      }
      case 'archive': {
        const p = engagement.dir ? join(store.projectAbs(root, engagement.dir) || '', store.ARCHIVE) : '';
        const ok = !!p && existsSync(p);
        return Object.assign(base, { ok, evidence: ok ? store.ARCHIVE : '', detail: ok ? '' : '缺少 00-项目档案.md' });
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
        return Object.assign(base, { ok, evidence: uniq.join('、'), matches: uniq, detail: ok ? '' : `未找到匹配工件（${alts.map((a) => (a.dir ? a.dir + '/ ' : '') + (a.match || '任意 md')).join(' 或 ')}）` });
      }
      case 'content': {
        const alts = Array.isArray(check.alternatives) ? check.alternatives : [];
        if (!engagement.dir) return Object.assign(base, { ok: false, evidence: '', matches: [], detail: '客户无目录，无法检查正文' });
        const r = store.contentMatches(root, engagement.dir, alts);
        const rels = (r.hits || []).map((h) => h.rel);
        return Object.assign(base, { ok: r.ok, evidence: rels.join('、'), matches: rels, detail: r.ok ? '' : '方案文本未见「不做什么」或「边界」' });
      }
      case 'stakeholders': {
        const n = Array.isArray(engagement.stakeholders) ? engagement.stakeholders.length : 0;
        const min = Number(check.min) || 1;
        return Object.assign(base, { ok: n >= min, evidence: String(n), detail: n >= min ? '' : `干系人 ${n} 人，至少需要 ${min} 人` });
      }
      default:
        return Object.assign(base, { ok: false, evidence: '', detail: `未知检查类型 ${check.type}` });
    }
  } catch (e) {
    return Object.assign(base, { ok: false, evidence: '', detail: `检查异常：${(e && e.message) || e}` });
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

function makeAttention(kind, { engagement, item, text, detail, due, days, priority, extra }) {
  const def = schema.attentionDef(kind) || { actions: [] };
  return Object.assign({
    kind,
    rank: schema.attentionRank(kind),
    text: text || '',
    title: text || '',
    detail: detail || '',
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

  for (const e of board.engagements || []) {
    if (!schema.isStage(e.stage)) continue;
    const att = e.attention;
    if (att && att.kind === 'blocked') {
      out.push(makeAttention('blocked', {
        engagement: e, text: `受阻：${e.name}${att.question ? '｜' + att.question : ''}`,
        detail: att.question || '', due: e.nextAction && e.nextAction.due, priority: e.priority,
      }));
    }
    if (att && att.kind === 'decision') {
      out.push(makeAttention('decision', {
        engagement: e, text: `需要决定：${e.name}${att.question ? '｜' + att.question : ''}`,
        detail: att.question || '', due: e.nextAction && e.nextAction.due, priority: e.priority,
      }));
    }
    if (att && att.kind === 'answer') {
      out.push(makeAttention('answer', {
        engagement: e, text: `需要回答：${e.name}${att.question ? '｜' + att.question : ''}`,
        detail: att.question || '', due: e.nextAction && e.nextAction.due, priority: e.priority,
      }));
    }

    const naDue = e.nextAction && e.nextAction.due;
    if (store.isDueStr(naDue) && naDue < today) {
      const days = store.diffDays(naDue, today);
      out.push(makeAttention('overdue', {
        engagement: e, text: `逾期 ${days} 天：${e.name} · ${(e.nextAction && e.nextAction.text) || '下一步'}`,
        detail: (e.nextAction && e.nextAction.text) || '', due: naDue, days, priority: e.priority,
      }));
    }

    const stay = stageStayDays(e, now);
    const ng = nextGate(e);
    if (ng && !e.paused) {
      const gate = evaluateGate(root, e, ng.gateKey, { now, scan: scanOf(e), ttlMs: opts.ttlMs });
      const autoAllPass = gate && gate.auto.every((c) => c.ok);
      const manualMissing = gate && gate.manual.some((c) => c.status !== 'pass');
      if (gate && autoAllPass && manualMissing && stay > schema.GATE_WAIT_DAYS) {
        out.push(makeAttention('gate', {
          engagement: e,
          text: `门禁待确认：${e.name} · ${gate.label} 缺 ${gate.missing.length} 项`,
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
        engagement: e, text: `停滞 ${idle} 天：${e.name}`,
        detail: `阶段「${schema.stageLabel(e.stage)}」已停留 ${stay} 天，最近活动 ${idle} 天前`,
        due: '', days: idle, priority: e.priority, extra: { stage: e.stage },
      }));
    }
  }

  for (const it of board.items || []) {
    if (!['inbox', 'todo', 'doing', 'waiting', 'review'].includes(it.stage)) continue;
    const e = it.engagementId ? engById.get(it.engagementId) : null;
    const att = it.attention;
    if (att && att.kind === 'blocked') {
      out.push(makeAttention('blocked', {
        engagement: e, item: it, text: `受阻：${it.title}${att.question ? '｜' + att.question : ''}`,
        detail: att.question || '', due: it.due, priority: it.priority,
      }));
    }
    if (att && att.kind === 'decision') {
      out.push(makeAttention('decision', {
        engagement: e, item: it, text: `需要决定：${it.title}`, detail: att.question || '', due: it.due, priority: it.priority,
      }));
    }
    if (att && att.kind === 'answer') {
      out.push(makeAttention('answer', {
        engagement: e, item: it, text: `需要回答：${it.title}`, detail: att.question || '', due: it.due, priority: it.priority,
      }));
    }
    if (it.stage === 'review') {
      out.push(makeAttention('review', {
        engagement: e, item: it, text: `待审阅：${it.title}`, detail: e ? e.name : '独立任务',
        due: it.due, days: itemStayDays(it, now), priority: it.priority,
      }));
    }
    if (store.isDueStr(it.due) && it.due < today) {
      const days = store.diffDays(it.due, today);
      out.push(makeAttention('overdue', {
        engagement: e, item: it, text: `逾期 ${days} 天：${it.title}`,
        detail: e ? e.name : '独立任务', due: it.due, days, priority: it.priority,
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

/* ============================ proposals 生成 ============================ */

function proposalRecentlyExists(board, ruleId, engagementId, itemId, nowMs) {
  const eid = engagementId || '';
  const iid = itemId || '';
  return (board.proposals || []).some((p) => {
    if (!p) return false;
    if (p.ruleId !== ruleId) return false;
    if ((p.engagementId || '') !== eid) return false;
    if ((p.itemId || '') !== iid) return false;
    if (p.status === 'pending') return true; /* 待处理的建议不再重复生成 */
    const t = Date.parse(String(p.createdAt || ''));
    return Number.isFinite(t) && nowMs - t < schema.PROPOSAL_DEDUPE_MS;
  });
}

/**
 * 规则求值并追加 proposals（读取 board / 生成 brief / sync 时调用）。
 * 只追加 pending 建议，不自动执行；同一 rule+target 去重；pending 上限 8。
 * @returns {{added:object[], existing:number}}
 */
export function refreshProposals(root, board, opts = {}) {
  const now = opts.now == null ? Date.now() : opts.now;
  const nowIso = store.nowIso(now);
  const today = store.todayStr(now);
  const settings = Object.assign({}, schema.DEFAULT_SETTINGS, board.settings || {});
  const stallDays = Math.max(1, Number(settings.stallDays) || 14);
  const created = [];
  if (!Array.isArray(board.proposals)) board.proposals = [];
  const pendingCount = () => board.proposals.filter((p) => p.status === 'pending').length;
  const scans = new Map();
  const scanOf = (engagement) => {
    if (!engagement || !engagement.dir) return null;
    if (!scans.has(engagement.dir)) scans.set(engagement.dir, store.scanProjectArtifacts(root, engagement.dir, { ttlMs: opts.ttlMs }));
    return scans.get(engagement.dir);
  };
  const add = (ruleId, { engagement, item, title, detail, kind, payload, skipDedupe }) => {
    /* 已 push 的建议会被 pendingCount() 计入，不要再加 created.length（否则首轮最多只出 4 条）。 */
    if (pendingCount() >= schema.MAX_PENDING_PROPOSALS) return null;
    /* bid_signal 以 payload.bidId 为去重键（由规则内 bidProposalSeen 处理），不能按 engagement+item 去重。 */
    if (!skipDedupe && proposalRecentlyExists(board, ruleId, engagement && engagement.id, item && item.id, now)) return null;
    const rule = schema.ruleDef(ruleId);
    const p = {
      id: store.newProposalId(),
      ruleId,
      engagementId: (engagement && engagement.id) || '',
      itemId: (item && item.id) || '',
      kind: kind || (rule ? rule.kind : 'nudge'),
      title: title || '',
      detail: detail || (rule ? rule.detail : ''),
      payload: payload || {},
      status: 'pending',
      createdAt: nowIso,
      decidedAt: '',
    };
    board.proposals.push(p);
    created.push(p);
    return p;
  };

  for (const e of board.engagements || []) {
    if (!schema.isStage(e.stage) || e.paused) continue;
    const stay = stageStayDays(e, now);
    const last = lastActivityAt(e);
    const idle = Number.isFinite(store.daysSince(last, now)) ? Math.floor(store.daysSince(last, now)) : 0;
    const na = e.nextAction || {};

    /* stall：活跃阶段停留 + 无近期活动 */
    if (idle > stallDays && stay > stallDays) {
      add('stall', {
        engagement: e,
        title: `${e.name} 已停滞 ${idle} 天`,
        detail: `建议：安排一次跟进，或标记暂停（阶段「${schema.stageLabel(e.stage)}」停留 ${stay} 天）`,
        payload: { patch: { nextAction: { due: store.addDaysStr(2, now) } } },
      });
    }

    /* nextAction 到期相关 */
    const ds = dueStatus(na.due, now);
    if (ds === 'overdue') {
      const days = store.diffDays(na.due, today);
      add('overdue', {
        engagement: e,
        title: `${e.name} 下一步已逾期 ${days} 天`,
        detail: `建议：改期或标记完成（${na.text || '下一步'}）`,
        payload: { patch: { nextAction: { due: store.addDaysStr(2, now) } } },
      });
    } else if (ds === 'due_soon') {
      const days = Math.max(0, store.diffDays(today, na.due));
      add('due_soon', {
        engagement: e,
        title: `${e.name} 下一步 ${days === 0 ? '今天' : days + ' 天后'}到期`,
        detail: `建议：确认下一步动作与负责人（${na.text || ''}）`,
        payload: {},
      });
    }

    /* no_next：活跃客户没有下一步 */
    if (!nonEmpty(na.text)) {
      add('no_next', {
        engagement: e,
        title: `${e.name} 缺少下一步`,
        detail: '建议：补一个可检查的下一步（谁、做什么、何时）',
        payload: { patch: { nextAction: { text: `确认 ${e.name} 的下一步` } } },
      });
    }

    /* gate_ready：自动检查全过、人工缺失、阶段停留 > 7 天 */
    const ng = nextGate(e);
    if (ng && stay > schema.GATE_WAIT_DAYS) {
      const gate = evaluateGate(root, e, ng.gateKey, { now, scan: scanOf(e), ttlMs: opts.ttlMs });
      if (gate) {
        const autoAllPass = gate.auto.every((c) => c.ok);
        const manualMissing = gate.manual.some((c) => c.status !== 'pass');
        if (autoAllPass && manualMissing) {
          add('gate_ready', {
            engagement: e,
            title: `${e.name} 门禁可确认：${gate.label}`,
            detail: `建议：发起会话补齐门禁证据，或人在面板勾选（缺 ${gate.missing.length} 项）`,
            kind: 'start_session',
            payload: { intent: 'gate', stage: ng.stage, gateKey: ng.gateKey },
          });
        }
      }
    }
  }

  /* item 级规则 */
  const engById = new Map((board.engagements || []).map((e) => [e.id, e]));
  for (const it of board.items || []) {
    if (!['inbox', 'todo', 'doing', 'waiting', 'review'].includes(it.stage)) continue;
    const e = it.engagementId ? engById.get(it.engagementId) : null;
    if (e && e.paused) continue;
    const ds = dueStatus(it.due, now);
    if (ds === 'overdue') {
      const days = store.diffDays(it.due, today);
      add('overdue', {
        engagement: e, item: it,
        title: `任务已逾期 ${days} 天：${it.title}`,
        detail: '建议：改期或标记完成',
        kind: 'update_next',
        payload: { patch: { due: store.addDaysStr(2, now) } },
      });
    } else if (ds === 'due_soon' && it.type === 'meeting') {
      add('meeting_soon', {
        engagement: e, item: it,
        title: `会面临近：${it.title}`,
        detail: `建议：发起会话准备会面材料（到期 ${it.due}）`,
        kind: 'start_session',
        payload: { intent: 'meeting', itemId: it.id },
      });
    } else if (ds === 'due_soon') {
      add('due_soon', {
        engagement: e, item: it,
        title: `任务 ${it.due} 到期：${it.title}`,
        detail: '建议：确认是否按计划完成',
        payload: {},
      });
    }
    if (it.stage === 'review') {
      const lag = itemStayDays(it, now);
      if (lag > schema.REVIEW_LAG_DAYS) {
        add('review_lag', {
          engagement: e, item: it,
          title: `待审阅已 ${lag} 天：${it.title}`,
          detail: '建议：尽快审阅并给出结论',
          payload: {},
        });
      }
    }
  }

  /* ============================ 招采信号（spec §17.6） ============================ */
  const settings2 = board.settings || {};
  const bidService = opts.bidIntel || null;
  if (settings2.sources && settings2.sources.bidWatch === true && bids.isAvailable(bidService)) {
    const signalDays = Math.max(1, Number(settings2.bidSignalDays) || schema.BID_DEFAULT_SIGNAL_DAYS);
    const settings = Object.assign({}, schema.DEFAULT_SETTINGS, settings2);
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
      const candidates = bids.signalCandidates(match, { days: signalDays, now });
      const pendingForEngagement = (board.proposals || []).filter((p) => p && p.ruleId === 'bid_signal' &&
        p.engagementId === e.id && p.status === 'pending').length;
      let addedForEngagement = 0;
      for (const it of candidates) {
        /* 每客户最多 3 条待处理信号（跨刷新稳定，避免每次读板都累积噪音）。 */
        if (addedForEngagement + pendingForEngagement >= bids.SIGNAL_ITEM_LIMIT) break;
        if (bidProposalSeen(e.id, it.id)) continue;
        const buyer = it.buyer || e.name;
        const p = add('bid_signal', {
          skipDedupe: true,
          engagement: e,
          title: `发现招采信号：${buyer} 发布《${it.title}》（${it.date}）`,
          detail: '建议：建跟进任务，确认公告是否与客户经营相关（候选人≠中标人；批次为推断）',
          kind: 'create_item',
          payload: {
            kind: 'create_item',
            engagementId: e.id,
            bidId: it.id,
            title: it.title,
            date: it.date,
            buyer: it.buyer || '',
            url: it.url || '',
            relation: it.relation,
            bidKind: it.kind,
          },
        });
        if (p) addedForEngagement += 1;
      }
      /* 记录最近一次匹配时间（派生字段，仅在真正写盘时随 board 落盘；失败不影响主流程） */
      if (match.generatedAt) {
        try { bids.ensureBidWatch(e).lastMatchAt = match.generatedAt; } catch { /* 忽略 */ }
      }
    }
  }

  return { added: created, existing: board.proposals.length };
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
    if (['inbox', 'todo', 'doing', 'waiting', 'review'].includes(it.stage) && store.isDueStr(it.due) && it.due < today) itemOverdue += 1;
  }
  return {
    engagements: (board.engagements || []).length,
    active,
    byStage,
    items: (board.items || []).length,
    byLane,
    proposalsPending: (board.proposals || []).filter((p) => p.status === 'pending').length,
    attention: (attention || []).length,
    overdue: overdue + itemOverdue,
    dueToday,
  };
}
