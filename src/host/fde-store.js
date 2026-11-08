/**
 * FDE 工作站 · 状态层
 *
 * - board.json 读写：版本校验、写前备份（最近 10 份）、临时文件 + rename 原子写
 * - 空 board 生成（不自动导入任何目录）
 * - adopt 扫描：识别 research/<dir> 下的项目/历史目录，给建议阶段，杜绝重复导入
 * - 工件扫描：递归 + 关键词匹配 + mtime，带 TTL 缓存（默认 5 秒）
 * - timeline / activity / reports 截断
 *
 * 只写 <root>/research/.fde/；不写客户卷正文。
 * 只依赖 node 内置，不 import @deepseek-ai/*。
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync,
  renameSync, copyFileSync, unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as schema from './fde-schema.js';
import { safeDirName, safeProjectPath, PathError } from './paths.js';

export const ARCHIVE = '00-项目档案.md';
export const FDE_DIRNAME = '.fde';
export const BOARD_FILENAME = 'board.json';
/** timeline / activity / reports 截断上限（spec §3.1）。 */
export const MAX_ACTIVITY = 300;
export const MAX_TIMELINE = 200;
export const MAX_HISTORY = 200;
export const MAX_REPORTS = 50;
export const MAX_BACKUPS = 10;
export const DEFAULT_CACHE_TTL_MS = 5000;

const ID_RE = /^(eng|itm|prp)_[0-9a-f]{6}$/;
const SOURCE_KINDS = ['manual', 'import', 'folder', 'bid', 'agent'];
const REPORT_KINDS = ['progress', 'ready', 'blocked', 'failed', 'dropped'];
const PROPOSAL_KINDS = ['nudge', 'create_item', 'start_session', 'update_next'];
const PROPOSAL_STATUS = ['pending', 'accepted', 'dismissed'];
const OWNERS = ['human', 'agent', 'both'];
const ATTENTION_KINDS = ['decision', 'blocked', 'answer', 'question'];
const ACTIVITY_KINDS = ['created', 'moved', 'gate', 'attention', 'report', 'adopt', 'proposal', 'updated', 'session'];
const STAKEHOLDER_LEVELS = ['top', 'vp', 'exec', 'unknown'];

/* ============================ 路径 ============================ */

export function fdeDir(root) { return join(resolve(String(root)), 'research', FDE_DIRNAME); }
export function boardPath(root) { return join(fdeDir(root), BOARD_FILENAME); }
export function backupsDir(root) { return join(fdeDir(root), 'backups'); }
export function draftsDir(root) { return join(fdeDir(root), 'drafts'); }
export function researchDir(root) { return join(resolve(String(root)), 'research'); }
/** 客户目录绝对路径；dir 为空或非法（含符号链接指向工作区外）返回 ''。
 *  spec §16.2：FDE 新代码同样复用 paths.safeProjectPath，不得读工作区外文件。 */
export function projectAbs(root, dir) {
  const d = String(dir || '').trim();
  if (!d) return '';
  try {
    safeDirName(d);
    return safeProjectPath(root, d, 'research').path;
  } catch { return ''; }
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function listDir(p) {
  try { return readdirSync(p); } catch { return []; }
}
function mtimeMs(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

/* ============================ 时间 ============================ */

/** ISO8601（UTC）字符串；存储口径。 */
export function nowIso(now) { return new Date(now == null ? Date.now() : now).toISOString(); }
/** 本地时区日期 YYYY-MM-DD；展示与「今天」口径。 */
export function localDateStr(d) {
  const x = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function todayStr(now) { return localDateStr(now == null ? new Date() : new Date(now)); }
/** 本地日期加减，返回 YYYY-MM-DD。 */
export function addDaysStr(days, from) {
  const d = new Date(from == null ? Date.now() : (from instanceof Date ? from.getTime() : from));
  d.setDate(d.getDate() + Number(days || 0));
  return localDateStr(d);
}
/** 备份文件名的本地时间戳：YYYYMMDD-HHmmss。 */
export function localStamp(d) {
  const x = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}-${p(x.getHours())}${p(x.getMinutes())}${p(x.getSeconds())}`;
}
export function isDueStr(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
export function isValidIso(s) {
  const t = String(s || '');
  if (!t) return false;
  const ms = Date.parse(t);
  return Number.isFinite(ms);
}
/** 两个 YYYY-MM-DD 相差的自然日（b - a，可为负）。 */
export function diffDays(a, b) {
  if (!isDueStr(a) || !isDueStr(b)) return NaN;
  const toUtc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}
/** 距现在多少天（正数=过去）。 */
export function daysSince(iso, now) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return NaN;
  const ref = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Number(now));
  return (ref - t) / 86400000;
}

/* ============================ id ============================ */

export function newId(prefix) { return `${prefix}_${randomBytes(3).toString('hex')}`; }
export const newEngagementId = () => newId('eng');
export const newItemId = () => newId('itm');
export const newProposalId = () => newId('prp');

/* ============================ 空 board / 归一 ============================ */

/** 空 board（文件不存在时使用；不自动导入任何目录）。 */
export function emptyBoard() {
  return {
    version: schema.SCHEMA_VERSION,
    revision: 0,
    updatedAt: nowIso(),
    settings: JSON.parse(JSON.stringify(schema.DEFAULT_SETTINGS)),
    engagements: [],
    items: [],
    proposals: [],
    activity: [],
  };
}

function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

/** 补齐缺省字段（只做结构归一，不做合法性判断；写盘前必须过 validateBoard）。 */
export function normalizeBoard(data) {
  const base = emptyBoard();
  const board = Object.assign(base, data || {});
  board.version = Number(board.version || schema.SCHEMA_VERSION);
  board.revision = Number.isInteger(Number(board.revision)) && Number(board.revision) >= 0 ? Number(board.revision) : 0;
  board.settings = Object.assign(clone(schema.DEFAULT_SETTINGS), board.settings || {});
  board.settings.wipLimits = Object.assign({ doing: 5 }, board.settings.wipLimits || {});
  board.settings.sources = Object.assign({ folderWatch: true, briefOnOpen: true, bidWatch: true }, board.settings.sources || {});
  if (!Number.isFinite(Number(board.settings.bidSignalDays))) board.settings.bidSignalDays = 30;
  if (!Array.isArray(board.settings.workdirs)) board.settings.workdirs = ['research'];
  for (const k of ['engagements', 'items', 'proposals', 'activity']) {
    if (!Array.isArray(board[k])) board[k] = [];
  }
  board.engagements = board.engagements.map((e) => {
    const x = Object.assign({
      id: '', name: '', company: '', shortName: '', dir: '',
      stage: 'lead', stageSince: nowIso(), paused: false, priority: 'normal',
      owner: '', tags: [], source: { kind: 'manual', ref: '', at: nowIso() },
      value: { amount: 0, currency: 'CNY', note: '' },
      nextAction: { text: '', due: '', owner: '' },
      stakeholders: [], gateState: {}, attention: null, sessionId: '',
      createdAt: nowIso(), adopted: false, timeline: [],
    }, e || {});
    /* 手写/旧版 board 可能把这些字段存成 null：归一为安全默认，避免写盘校验误杀。 */
    if (!x.gateState || typeof x.gateState !== 'object' || Array.isArray(x.gateState)) x.gateState = {};
    if (!x.source || typeof x.source !== 'object') x.source = { kind: 'manual', ref: '', at: nowIso() };
    if (!x.nextAction || typeof x.nextAction !== 'object') x.nextAction = { text: '', due: '', owner: '' };
    if (!Array.isArray(x.stakeholders)) x.stakeholders = [];
    if (!Array.isArray(x.tags)) x.tags = [];
    if (!Array.isArray(x.timeline)) x.timeline = [];
    /* 招采雷达（spec §17.2）：默认 enabled:true；links/keywords 结构容错。 */
    if (!x.bidWatch || typeof x.bidWatch !== 'object' || Array.isArray(x.bidWatch)) {
      x.bidWatch = { enabled: true, keywords: [], links: [], lastMatchAt: '' };
    } else {
      if (typeof x.bidWatch.enabled !== 'boolean') x.bidWatch.enabled = true;
      if (!Array.isArray(x.bidWatch.keywords)) x.bidWatch.keywords = [];
      if (!Array.isArray(x.bidWatch.links)) x.bidWatch.links = [];
      if (typeof x.bidWatch.lastMatchAt !== 'string') x.bidWatch.lastMatchAt = '';
    }
    return x;
  });
  board.items = board.items.map((it) => {
    const x = Object.assign({
      id: '', engagementId: '', title: '', type: 'research', stage: 'inbox',
      priority: 'normal', due: '', owner: 'human',
      source: { kind: 'manual', ref: '', at: nowIso() },
      autonomy: { mode: 'observe', rule: '' }, attention: null, reports: [],
      sessionId: '', createdAt: nowIso(), history: [],
    }, it || {});
    if (!Array.isArray(x.bidRefs)) x.bidRefs = [];
    return x;
  });
  board.proposals = board.proposals.map((p) => Object.assign({
    id: '', ruleId: '', engagementId: '', itemId: '', kind: 'nudge',
    title: '', detail: '', payload: {}, status: 'pending', createdAt: nowIso(), decidedAt: '',
  }, p || {}));
  board.activity = board.activity.map((a) => Object.assign({ at: nowIso(), kind: 'updated', text: '', engagementId: '', itemId: '' }, a || {}));
  return board;
}

/* ============================ 校验 ============================ */

const bad = (reason) => ({ ok: false, code: 'INVALID', reason });

function checkIsoField(o, key, where, errors) {
  if (o[key] && !isValidIso(o[key])) errors.push(`${where}.${key} 必须为 ISO8601`);
}
function checkDueField(o, key, where, errors) {
  if (o[key] && !isDueStr(o[key])) errors.push(`${where}.${key} 必须为 YYYY-MM-DD 或空`);
}

/**
 * 写前校验（spec §3.1）。
 * @returns {{ok:true}|{ok:false,code:string,reason:string}}
 */
export function validateBoard(board) {
  if (!board || typeof board !== 'object' || Array.isArray(board)) return bad('board 必须是对象');
  if (Number(board.version) !== schema.SCHEMA_VERSION) return bad(`board.version 必须为 ${schema.SCHEMA_VERSION}`);
  if (!Number.isInteger(Number(board.revision)) || Number(board.revision) < 0) return bad('board.revision 必须为非负整数');
  const errors = [];
  const s = board.settings || {};
  if (!schema.isAutonomy(s.autonomy)) errors.push('settings.autonomy 非法');
  if (!Number.isFinite(Number(s.stallDays)) || Number(s.stallDays) < 1 || Number(s.stallDays) > 365) errors.push('settings.stallDays 应为 1..365');
  if (s.wipLimits && s.wipLimits.doing != null && (!Number.isFinite(Number(s.wipLimits.doing)) || Number(s.wipLimits.doing) < 1)) errors.push('settings.wipLimits.doing 非法');
  if (s.bidSignalDays != null && (!Number.isFinite(Number(s.bidSignalDays)) || Number(s.bidSignalDays) < 1 || Number(s.bidSignalDays) > 365)) errors.push('settings.bidSignalDays 应为 1..365');

  const engagementIds = new Set();
  const dirs = new Set();
  (board.engagements || []).forEach((e, i) => {
    const w = `engagements[${i}]`;
    if (!ID_RE.test(String(e.id || '')) || !String(e.id).startsWith('eng_')) errors.push(`${w}.id 非法`);
    if (engagementIds.has(e.id)) errors.push(`${w}.id 重复：${e.id}`);
    engagementIds.add(e.id);
    if (typeof e.name !== 'string' || !e.name.trim()) errors.push(`${w}.name 不能为空`);
    if (!schema.isEngagementStage(e.stage)) errors.push(`${w}.stage 非法：${e.stage}`);
    if (!schema.isPriority(e.priority)) errors.push(`${w}.priority 非法`);
    if (typeof e.paused !== 'boolean') errors.push(`${w}.paused 必须为布尔`);
    if (e.dir) {
      try { safeDirName(e.dir); } catch (err) { errors.push(`${w}.dir 非法：${(err && err.message) || err}`); }
      if (dirs.has(e.dir)) errors.push(`${w}.dir 重复：${e.dir}`);
      dirs.add(e.dir);
    }
    checkIsoField(e, 'stageSince', w, errors);
    checkIsoField(e, 'createdAt', w, errors);
    if (e.nextAction) checkDueField(e.nextAction, 'due', `${w}.nextAction`, errors);
    if (!Array.isArray(e.stakeholders)) errors.push(`${w}.stakeholders 必须为数组`);
    if (!Array.isArray(e.timeline)) errors.push(`${w}.timeline 必须为数组`);
    if (e.gateState == null || typeof e.gateState !== 'object' || Array.isArray(e.gateState)) errors.push(`${w}.gateState 必须为对象`);
    if (e.source && e.source.kind && !SOURCE_KINDS.includes(e.source.kind)) errors.push(`${w}.source.kind 非法`);
    if (e.attention && !ATTENTION_KINDS.includes(e.attention.kind)) errors.push(`${w}.attention.kind 非法`);
    if (e.bidWatch != null && (typeof e.bidWatch !== 'object' || Array.isArray(e.bidWatch))) errors.push(`${w}.bidWatch 必须为对象`);
    if (e.bidWatch && e.bidWatch.enabled != null && typeof e.bidWatch.enabled !== 'boolean') errors.push(`${w}.bidWatch.enabled 必须为布尔`);
    if (e.bidWatch && e.bidWatch.keywords != null && !Array.isArray(e.bidWatch.keywords)) errors.push(`${w}.bidWatch.keywords 必须为数组`);
    if (e.bidWatch && e.bidWatch.links != null) {
      if (!Array.isArray(e.bidWatch.links)) errors.push(`${w}.bidWatch.links 必须为数组`);
      else e.bidWatch.links.forEach((lk, j) => {
        if (!lk || typeof lk !== 'object' || !String(lk.bidId || '').trim()) errors.push(`${w}.bidWatch.links[${j}].bidId 不能为空`);
      });
    }
    (e.stakeholders || []).forEach((st, j) => {
      if (!st || typeof st.name !== 'string' || !st.name.trim()) errors.push(`${w}.stakeholders[${j}].name 不能为空`);
      if (st && st.level && !STAKEHOLDER_LEVELS.includes(st.level)) errors.push(`${w}.stakeholders[${j}].level 非法`);
    });
  });

  const itemIds = new Set();
  (board.items || []).forEach((it, i) => {
    const w = `items[${i}]`;
    if (!ID_RE.test(String(it.id || '')) || !String(it.id).startsWith('itm_')) errors.push(`${w}.id 非法`);
    if (itemIds.has(it.id)) errors.push(`${w}.id 重复：${it.id}`);
    itemIds.add(it.id);
    if (typeof it.title !== 'string' || !it.title.trim()) errors.push(`${w}.title 不能为空`);
    if (!schema.isLane(it.stage)) errors.push(`${w}.stage（泳道）非法：${it.stage}`);
    if (!schema.isItemType(it.type)) errors.push(`${w}.type 非法`);
    if (!schema.isPriority(it.priority)) errors.push(`${w}.priority 非法`);
    if (!OWNERS.includes(it.owner)) errors.push(`${w}.owner 非法`);
    if (it.engagementId && !engagementIds.has(it.engagementId)) errors.push(`${w}.engagementId 不存在：${it.engagementId}`);
    checkDueField(it, 'due', w, errors);
    checkIsoField(it, 'createdAt', w, errors);
    if (!Array.isArray(it.reports)) errors.push(`${w}.reports 必须为数组`);
    if (!Array.isArray(it.history)) errors.push(`${w}.history 必须为数组`);
    if (it.bidRefs != null && !Array.isArray(it.bidRefs)) errors.push(`${w}.bidRefs 必须为数组`);
    (it.reports || []).forEach((r, j) => {
      if (!REPORT_KINDS.includes(r && r.kind)) errors.push(`${w}.reports[${j}].kind 非法`);
      if (r && r.at && !isValidIso(r.at)) errors.push(`${w}.reports[${j}].at 必须为 ISO8601`);
    });
    if (it.attention && !ATTENTION_KINDS.includes(it.attention.kind)) errors.push(`${w}.attention.kind 非法`);
  });

  (board.proposals || []).forEach((p, i) => {
    const w = `proposals[${i}]`;
    if (!ID_RE.test(String(p.id || '')) || !String(p.id).startsWith('prp_')) errors.push(`${w}.id 非法`);
    if (!schema.isRuleId(p.ruleId)) errors.push(`${w}.ruleId 非法`);
    if (!PROPOSAL_KINDS.includes(p.kind)) errors.push(`${w}.kind 非法`);
    if (!PROPOSAL_STATUS.includes(p.status)) errors.push(`${w}.status 非法`);
    if (p.engagementId && !engagementIds.has(p.engagementId)) errors.push(`${w}.engagementId 不存在`);
    if (p.itemId && !itemIds.has(p.itemId)) errors.push(`${w}.itemId 不存在`);
    checkIsoField(p, 'createdAt', w, errors);
  });

  (board.activity || []).forEach((a, i) => {
    if (!a || !isValidIso(a.at)) errors.push(`activity[${i}].at 必须为 ISO8601`);
  });

  if (errors.length) return { ok: false, code: 'INVALID', reason: errors.slice(0, 8).join('；') + (errors.length > 8 ? `（共 ${errors.length} 项）` : '') };
  return { ok: true };
}

/* ============================ 读 ============================ */

/**
 * 读 board。
 * - 文件不存在：返回空 board（fresh:true），不写盘、不自动导入
 * - 版本更高：拒绝（CONFLICT，spec §11）
 * - JSON 损坏：CONFLICT（不抛异常）
 */
export function readBoard(root) {
  const p = boardPath(root);
  if (!existsSync(p)) return { ok: true, board: emptyBoard(), fresh: true, path: p };
  let raw;
  try { raw = readFileSync(p, 'utf8'); } catch (e) {
    return { ok: false, code: 'INTERNAL', reason: `读取 board.json 失败：${(e && e.message) || e}` };
  }
  let data;
  try { data = JSON.parse(raw); } catch {
    return { ok: false, code: 'CONFLICT', reason: 'board.json 不是合法 JSON（可用备份恢复）' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, code: 'CONFLICT', reason: 'board.json 结构不合法' };
  const v = Number(data.version || 0);
  if (!Number.isFinite(v) || v < 1) return { ok: false, code: 'INVALID', reason: 'board.version 缺失或非法' };
  if (v > schema.SCHEMA_VERSION) {
    return { ok: false, code: 'CONFLICT', reason: `board.version=${v} 高于插件支持的 ${schema.SCHEMA_VERSION}，拒绝读写；请升级插件或删除 research/.fde/ 回滚` };
  }
  return { ok: true, board: normalizeBoard(data), fresh: false, path: p };
}

/* ============================ 写（备份 + 原子） ============================ */

/** 覆盖写前备份现有 board，保留最近 MAX_BACKUPS 份。 */
export function backupBoard(root) {
  const src = boardPath(root);
  if (!existsSync(src)) return { ok: true, backed: false, reason: '' };
  try {
    const dir = backupsDir(root);
    mkdirSync(dir, { recursive: true });
    let name = `board-${localStamp(new Date())}.json`;
    let target = join(dir, name);
    /* 同一秒内多次写：加序号避免互相覆盖。 */
    let n = 1;
    while (existsSync(target) && n < 100) { name = `board-${localStamp(new Date())}-${n}.json`; target = join(dir, name); n += 1; }
    copyFileSync(src, target);
    pruneBackups(root);
    return { ok: true, backed: true, path: target };
  } catch (e) {
    return { ok: false, backed: false, reason: `备份失败：${(e && e.message) || e}` };
  }
}

/** 只保留最近 MAX_BACKUPS 份备份。 */
export function pruneBackups(root) {
  try {
    const dir = backupsDir(root);
    const files = listDir(dir).filter((f) => /^board-.*\.json$/.test(f));
    files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); /* 文件名含时间戳，字典序=时间序 */
    for (const f of files.slice(MAX_BACKUPS)) {
      try { unlinkSync(join(dir, f)); } catch { /* 忽略单个删除失败 */ }
    }
    return { ok: true, removed: Math.max(0, files.length - MAX_BACKUPS) };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

export function listBackups(root) {
  const dir = backupsDir(root);
  if (!isDir(dir)) return [];
  return listDir(dir)
    .filter((f) => /^board-.*\.json$/.test(f))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((f) => ({ name: f, path: join(dir, f), modifiedAt: new Date(mtimeMs(join(dir, f))).toISOString() }));
}

/** 截断（写盘前调用）：activity 300 / timeline 200 / history 200 / reports 50。 */
export function truncateBoard(board) {
  if (Array.isArray(board.activity) && board.activity.length > MAX_ACTIVITY) board.activity = board.activity.slice(-MAX_ACTIVITY);
  for (const e of board.engagements || []) {
    if (Array.isArray(e.timeline) && e.timeline.length > MAX_TIMELINE) e.timeline = e.timeline.slice(-MAX_TIMELINE);
  }
  for (const it of board.items || []) {
    if (Array.isArray(it.history) && it.history.length > MAX_HISTORY) it.history = it.history.slice(-MAX_HISTORY);
    if (Array.isArray(it.reports) && it.reports.length > MAX_REPORTS) it.reports = it.reports.slice(-MAX_REPORTS);
  }
  return board;
}

/**
 * 校验 → 备份 → 原子写（临时文件 + rename）。
 * 写入失败时不破坏旧 board。
 * @returns {{ok:true,board:object,backup:string}|{ok:false,code:string,reason:string}}
 */
export function writeBoard(root, board, opts = {}) {
  try {
    const dir = fdeDir(root);
    mkdirSync(dir, { recursive: true });
    board.version = schema.SCHEMA_VERSION;
    board.updatedAt = nowIso();
    truncateBoard(board);
    const v = validateBoard(board);
    if (!v.ok) return v;
    /* 乐观并发（spec §4.1）：磁盘 revision 与已读 revision 不一致时：
     * - 显式 expectedRevision 不匹配 → CONFLICT（调用方重读重试）
     * - 未显式传参：若提交的是更旧的快照（board.revision < 磁盘）→ 安全跳过，绝不覆盖新数据；
     *   否则按磁盘最新版本继续写（revision 以 max+1 自增）。 */
    const disk = readBoard(root);
    if (!disk.ok) return { ok: false, code: disk.code || 'CONFLICT', reason: disk.reason || '读取 board 失败' };
    const diskRev = Number(disk.board.revision) || 0;
    const boardRev = Number(board.revision) || 0;
    if (opts.expectedRevision != null && Number(opts.expectedRevision) !== diskRev) {
      return { ok: false, code: 'CONFLICT', reason: `board 已被并发修改（磁盘 revision=${diskRev}，期望 ${opts.expectedRevision}）`, diskRevision: diskRev };
    }
    if (opts.expectedRevision == null && boardRev < diskRev) {
      return { ok: true, board: disk.board, staleSkipped: true, revision: diskRev, backup: '' };
    }
    board.revision = Math.max(boardRev, diskRev) + 1;
    const bk = backupBoard(root);
    if (bk && bk.backed === false && bk.ok === false) {
      /* 备份失败时宁可本次不写：旧 board 才是唯一事实来源。 */
      return { ok: false, code: 'INTERNAL', reason: `备份失败，已取消写入以保护旧 board：${bk.reason || ''}` };
    }
    const target = boardPath(root);
    const tmp = join(dir, `.${BOARD_FILENAME}.${process.pid}.${Date.now()}.${randomBytes(2).toString('hex')}.tmp`);
    /* Phase 3 · 审查 F-15：临时文件用 wx 独占创建（不跟随预置符号链接）+ 0600 权限；
     * rename 保留该 inode 的权限位，落盘后的 board 即是 0600（与 dsh-atomic-write 语义一致）。 */
    let created = false;
    try {
      writeFileSync(tmp, JSON.stringify(board, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      created = true;
      renameSync(tmp, target);
    } catch (e) {
      if (created) { try { unlinkSync(tmp); } catch { /* 忽略 */ } }
      return { ok: false, code: 'INTERNAL', reason: `写入 board 失败（旧文件已保留）：${(e && e.message) || e}` };
    }
    clearScanCache();
    return { ok: true, board, revision: board.revision, backup: bk && bk.path ? bk.path : '', staleSkipped: false };
  } catch (e) {
    return { ok: false, code: 'INTERNAL', reason: `写入 board 异常：${(e && e.message) || e}` };
  }
}

/* ============================ 事件/时间线 ============================ */

export function pushTimeline(engagement, entry) {
  if (!engagement) return engagement;
  if (!Array.isArray(engagement.timeline)) engagement.timeline = [];
  engagement.timeline.push(Object.assign({ at: nowIso(), kind: 'note', text: '', by: 'human' }, entry || {}));
  if (engagement.timeline.length > MAX_TIMELINE) engagement.timeline = engagement.timeline.slice(-MAX_TIMELINE);
  return engagement;
}

export function pushHistory(item, entry) {
  if (!item) return item;
  if (!Array.isArray(item.history)) item.history = [];
  item.history.push(Object.assign({ at: nowIso(), kind: 'updated', text: '', by: 'human' }, entry || {}));
  if (item.history.length > MAX_HISTORY) item.history = item.history.slice(-MAX_HISTORY);
  return item;
}

export function pushActivity(board, entry) {
  if (!board) return board;
  if (!Array.isArray(board.activity)) board.activity = [];
  board.activity.push(Object.assign({ at: nowIso(), kind: 'updated', text: '', engagementId: '', itemId: '' }, entry || {}));
  if (board.activity.length > MAX_ACTIVITY) board.activity = board.activity.slice(-MAX_ACTIVITY);
  return board;
}

/* ============================ 工件扫描（TTL 缓存） ============================ */

/** 进程内扫描缓存：key = 客户目录绝对路径。 */
const scanCache = new Map();
/** 正文关键词缓存：key = 目录路径 + 匹配源。 */
const contentCache = new Map();

export function clearScanCache() {
  scanCache.clear();
  contentCache.clear();
}

/** 缓存签名：客户目录 mtime + 直接子项数 + board.json mtime（spec §4）。 */
function signatureOf(projectPath, root) {
  let entries = 0;
  try { entries = readdirSync(projectPath).length; } catch { /* 忽略 */ }
  return `${mtimeMs(projectPath)}|${entries}|${mtimeMs(boardPath(root))}`;
}

function walkFiles(projectPath, maxFiles, maxDepth) {
  const files = [];
  let truncated = false;
  const walk = (dir, rel, depth) => {
    if (depth > maxDepth) return;
    for (const name of listDir(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      if (files.length >= maxFiles) { truncated = true; return; }
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      const childRel = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) { walk(abs, childRel, depth + 1); continue; }
      const m = name.match(/\.[a-z0-9]+$/i);
      files.push({
        rel: childRel,
        name,
        dir: rel,
        ext: m ? m[0].toLowerCase() : '',
        size: st.size,
        modifiedAt: new Date(st.mtimeMs).toISOString(),
        mtimeMs: st.mtimeMs,
      });
    }
  };
  walk(projectPath, '', 0);
  return { files, truncated };
}

/**
 * 扫描客户目录工件（递归、跳过隐藏目录与 node_modules）。
 * @param {string} root 工作区根
 * @param {string} dir 客户目录名（board.engagements[].dir）
 * @param {{ttlMs?:number, force?:boolean}} [opts]
 */
export function scanProjectArtifacts(root, dir, opts = {}) {
  const d = String(dir || '').trim();
  const p = d ? projectAbs(root, d) : '';
  if (!p || !isDir(p)) {
    return { dir: d, path: p, exists: false, files: [], mdCount: 0, pdfCount: 0, fileCount: 0, truncated: false, scannedAt: nowIso(), source: 'missing' };
  }
  const ttl = Number(opts.ttlMs) >= 0 ? Number(opts.ttlMs) : DEFAULT_CACHE_TTL_MS;
  const sig = signatureOf(p, root);
  const now = Date.now();
  const hit = scanCache.get(p);
  if (!opts.force && hit && hit.signature === sig && now - hit.at < ttl) {
    return Object.assign({}, hit.result, { source: 'cache', cachedAt: new Date(hit.at).toISOString() });
  }
  const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : 5000;
  const { files, truncated } = walkFiles(p, maxFiles, 8);
  const result = {
    dir: d,
    path: p,
    exists: true,
    files,
    mdCount: files.filter((f) => f.ext === '.md').length,
    pdfCount: files.filter((f) => f.ext === '.pdf').length,
    fileCount: files.length,
    truncated,
    scannedAt: nowIso(),
    source: 'scan',
    lastModifiedAt: files.length ? new Date(Math.max(...files.map((f) => f.mtimeMs))).toISOString() : '',
  };
  scanCache.set(p, { signature: sig, at: now, result });
  return result;
}

/** 工件摘要（看板卡片用，不放全量文件清单）。
 *  同时给 md/pdf/total 别名：面板 engagementArtifactCount 直接读它们。 */
export function summarizeArtifacts(scan) {
  if (!scan || !scan.exists) {
    return { dir: scan ? scan.dir : '', exists: false, md: 0, pdf: 0, total: 0, mdCount: 0, pdfCount: 0, fileCount: 0, lastModifiedAt: '', scannedAt: scan ? scan.scannedAt : '' };
  }
  return {
    dir: scan.dir, exists: true,
    md: scan.mdCount, pdf: scan.pdfCount, total: scan.fileCount,
    mdCount: scan.mdCount, pdfCount: scan.pdfCount, fileCount: scan.fileCount,
    lastModifiedAt: scan.lastModifiedAt || '', scannedAt: scan.scannedAt,
  };
}

/** 按目录前缀 + 关键词过滤工件（不区分大小写；match 为正则源）。 */
export function matchArtifacts(files, alternative, min = 1) {
  const dir = String((alternative && alternative.dir) || '').replace(/^\/+|\/+$/g, '');
  const src = String((alternative && alternative.match) || '');
  let re = null;
  if (src) { try { re = new RegExp(src, 'i'); } catch { re = null; } }
  const hits = (files || []).filter((f) => {
    if (dir && !(f.rel === dir || f.rel.startsWith(dir + '/'))) return false;
    if (re && !re.test(f.rel)) return false;
    return f.ext === '.md';
  });
  return { ok: hits.length >= Math.max(1, Number(min) || 1), hits };
}

/**
 * 正文关键词匹配（用于「方案含不做什么/边界」这类检查）。
 * 只读 md 前 maxBytes 字节；带缓存；失败按不匹配处理。
 */
export function contentMatches(root, dir, alternatives, opts = {}) {
  const d = String(dir || '').trim();
  const p = d ? projectAbs(root, d) : '';
  const alts = Array.isArray(alternatives) ? alternatives : [];
  if (!p || !isDir(p) || !alts.length) return { ok: false, hits: [] };
  const key = `${p}|${JSON.stringify(alts)}`;
  const now = Date.now();
  const hit = contentCache.get(key);
  if (!opts.force && hit && now - hit.at < DEFAULT_CACHE_TTL_MS) return hit.result;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 96 * 1024;
  const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : 24;
  const scan = scanProjectArtifacts(root, d);
  const hits = [];
  for (const alt of alts) {
    const dirPrefix = String(alt.dir || '').replace(/^\/+|\/+$/g, '');
    let re = null;
    try { re = new RegExp(String(alt.match || '不做什么|边界')); } catch { re = null; }
    if (!re) continue;
    const candidates = scan.files
      .filter((f) => f.ext === '.md')
      .filter((f) => !dirPrefix || f.rel === dirPrefix || f.rel.startsWith(dirPrefix + '/'))
      .slice(0, maxFiles);
    for (const f of candidates) {
      let txt = '';
      try { txt = readFileSync(join(p, f.rel), 'utf8').slice(0, maxBytes); } catch { continue; }
      if (re.test(txt)) {
        const m = txt.match(re);
        const idx = m && typeof m.index === 'number' ? m.index : 0;
        hits.push({ rel: f.rel, modifiedAt: f.modifiedAt, snippet: txt.slice(Math.max(0, idx - 20), idx + 60).replace(/\s+/g, ' ').trim() });
        break;
      }
    }
  }
  const result = { ok: hits.length > 0, hits };
  contentCache.set(key, { at: now, result });
  return result;
}

/* ============================ adopt 扫描 ============================ */

const PROJECT_DIRS = ['raw', 'meeting', 'proposal', 'internal', 'research'];

function readArchiveTitle(projectPath) {
  try {
    const head = readFileSync(join(projectPath, ARCHIVE), 'utf8').slice(0, 4000);
    const m = head.match(/^#\s*项目档案[：:]\s*(.+)$/m) || head.match(/^#\s*(.+)$/m);
    if (m && m[1]) return m[1].trim().replace(/\s*[|｜·].*$/, '');
  } catch { /* 忽略 */ }
  return '';
}

/** 建议阶段：按目录证据优先，其次 md 文件名关键词；都是推断，面板需人确认。
 * 只认 .md（raw/ 里抓来的 html/txt 属素材，不能当阶段证据，避免「培训通知」误判成采用）。 */
export function suggestStage(projectPath, scan) {
  const files = (scan && scan.files) || [];
  const mdFiles = files.filter((f) => f.ext === '.md');
  const inDir = (d) => mdFiles.some((f) => f.rel.startsWith(d + '/'));
  const matchAny = (re) => mdFiles.filter((f) => !f.rel.startsWith('raw/') && re.test(f.rel)).slice(0, 3).map((f) => f.rel);
  const steps = [
    { stage: 'adoption', evidence: [...(inDir('adoption') ? ['adoption/ 目录'] : []), ...matchAny(/采用|使用证据|培训|扩展/)], label: '采用' },
    { stage: 'delivery', evidence: [...(inDir('delivery') ? ['delivery/ 目录'] : []), ...(inDir('docs') ? ['docs/ 目录'] : []), ...matchAny(/验收|里程碑|风险登记/)], label: '交付' },
    { stage: 'pilot', evidence: [...(inDir('pilot') ? ['pilot/ 目录'] : []), ...matchAny(/试点|POC|pilot/i)], label: '试点' },
    { stage: 'solution', evidence: [...(inDir('proposal') ? ['proposal/ 目录'] : []), ...matchAny(/方案|报价|blueprint/i)], label: '方案' },
    { stage: 'meeting', evidence: [...(inDir('meeting') ? ['meeting/ 目录'] : []), ...matchAny(/Brief|会谈|纪要|合作地图/i)], label: '会面' },
    { stage: 'discovery', evidence: [...(inDir('research') ? ['research/ 目录'] : []), ...matchAny(/事实核查|KPI|主体锁定|研判/)], label: '研判' },
  ];
  for (const s of steps) {
    if (s.evidence.length) {
      const confidence = s.evidence.some((x) => x.endsWith('目录')) && s.evidence.length >= 2 ? 'high' : 'medium';
      return { stage: s.stage, confidence, evidence: [...new Set(s.evidence)].slice(0, 4), label: s.label };
    }
  }
  return { stage: 'lead', confidence: 'low', evidence: [], label: '线索' };
}

/**
 * 扫描 research/ 下可导入的目录（含 00-项目档案.md 的 project 与有 md/阶段目录的 legacy）。
 * 不写盘；已在 board 中的标记 alreadyImported（杜绝重复导入）。
 */
export function adoptScan(root, board) {
  const base = researchDir(root);
  if (!isDir(base)) return [];
  const known = new Set(((board && board.engagements) || []).map((e) => e.dir).filter(Boolean));
  const knownIds = new Map(((board && board.engagements) || []).filter((e) => e.dir).map((e) => [e.dir, e.id]));
  const out = [];
  for (const name of listDir(base)) {
    if (!name || name.startsWith('.') || name === 'node_modules') continue;
    const full = projectAbs(root, name);
    /* projectAbs 已做 safeDirName + safeProjectPath(realpath) 守卫：符号链接出工作区 → ''，直接跳过。 */
    if (!full || !isDir(full)) continue;
    let dirOk = true;
    try { safeDirName(name); } catch (e) { if (e instanceof PathError) dirOk = false; }
    const archive = existsSync(join(full, ARCHIVE));
    const scan = scanProjectArtifacts(root, name, { force: true });
    const hasProjDir = PROJECT_DIRS.some((d) => isDir(join(full, d)));
    const kind = archive ? 'project' : ((scan.mdCount >= 1 || hasProjDir) ? 'legacy' : 'material');
    if (kind === 'material') continue;
    const suggestion = suggestStage(full, scan);
    const lastMs = Math.max(mtimeMs(full), ...(scan.files.length ? scan.files.map((f) => f.mtimeMs) : [0]));
    out.push({
      dir: name,
      title: archive ? (readArchiveTitle(full) || name) : name,
      kind,
      adopted: archive,
      importable: dirOk,
      alreadyImported: known.has(name),
      engagementId: knownIds.get(name) || '',
      mdCount: scan.mdCount,
      fileCount: scan.fileCount,
      lastModifiedAt: lastMs ? new Date(lastMs).toISOString() : '',
      suggestedStage: suggestion.stage,
      suggestedStageLabel: suggestion.label,
      confidence: archive ? (suggestion.confidence === 'low' ? 'medium' : suggestion.confidence) : suggestion.confidence,
      evidence: suggestion.evidence,
    });
  }
  return out.sort((a, b) => String(b.lastModifiedAt).localeCompare(String(a.lastModifiedAt)));
}

/* ============================ 杂项 ============================ */

/** board 是否存在（health 用）。 */
export function boardExists(root) { return existsSync(boardPath(root)); }
/** board 文件 mtime（缓存签名用）。 */
export function boardMtime(root) { return mtimeMs(boardPath(root)); }
/** 目录是否可写（尽力而为，不抛异常）。 */
export function canWriteDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return true;
  } catch { return false; }
}
