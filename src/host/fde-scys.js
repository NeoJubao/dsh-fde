/**
 * FDE 工作站 · 生财 FDE 情报（spec §18，v1.2 2026-11-04）
 *
 * 定位：只读情报层。每天从生财有术社区 MCP 抓一次与 FDE 相关的内容
 * （帖子 / 公众号与推文 / 航海 / 大会课程 / 手册），归一化后落到
 * `research/.fde/scys-fde.json` 缓存，供宿主路由、`scys_fde` 工具与面板读取。
 *
 * 边界（spec §18.1 / §18.8，ADR 0004 D5）：
 * - 三条授权路径，按优先级解析：① 链接授权（面板保存到 `research/.fde/scys-auth.json`，0600）；
 *   ② 环境变量 `FDE_SCYS_TOKEN`；③ 兼容只读 `~/.dsh/mcp/scys-mcp/tokens.json`（旧 scys-mcp OAuth）。
 *   不实现 refresh_token；不打印/落盘 token（只有 ① 的显式保存），token 只进 Authorization 头。
 * - 只调用只读工具（searchTopic / searchTrustedContent / activitySearch /
 *   searchNavigatorContent / activityManualSearch）；任何生财写接口一律不调。
 * - 只存 ≤200 字摘要 + 链接，不缓存全文/图片。
 *
 * 节奏（spec §18.4）：feed 缺失或 `date !== 本地今天` 才刷新；后台每 30 分钟检查一次
 * （由 index.js 用 ctx.effect 注册与清理）；失败保留旧 feed，当天最多重试 3 次。
 *
 * 相关性（spec §18.2 实测补充）：post 类工具本身精确匹配、不过滤；其余类
 * （wechat / activity / navigator / manual）按 title+summary 是否提及 FDE 关键词做轻量过滤
 * （RELEVANCE_RE / isRelevantItem），被过滤条数记入 stats.filteredOut。
 *
 * 零新依赖；不 import @deepseek-ai/*；本模块不做任何日志输出（token 与网络细节不外泄）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as store from './fde-store.js';

/* ============================ 常量（spec §18） ============================ */

export const FEED_VERSION = 1;
export const FEED_REL = 'research/.fde/scys-fde.json';
export const MCP_URL = 'https://mcp.scys.com/shengcai-web/mcp';
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_CLIENT_INFO = { name: 'dsh-fde', version: '1.3.0' };
/** 单 query 超时（spec §18.2）。 */
export const QUERY_TIMEOUT_MS = 15000;
/** 单次刷新整体预算（spec §18.2）。 */
export const TOTAL_BUDGET_MS = 90000;
/** 相邻查询最小间隔（实测限流后补充，spec §18.2「串行与限流」）。 */
export const MIN_GAP_MS = 1000;
/** summary 上限（spec §18.3）。 */
export const SUMMARY_MAX = 200;
/** 当天最多重试次数（spec §18.4）。 */
export const DAILY_FAIL_LIMIT = 3;
/** feed 归一 kind（spec §18.3 stats 字段）。 */
export const KINDS = ['post', 'wechat', 'activity', 'navigator', 'manual'];
export const AUTH_EXPIRED_REASON = '生财有术 MCP 授权已过期，请在 DSH 中重新授权';
export const AUTH_MISSING_REASON = '未找到生财有术 MCP 授权，请在 DSH 中安装并授权生财 MCP';
export const AUTH_BROKEN_REASON = '生财 MCP 授权文件已损坏，请在 DSH 中重新授权';

/**
 * 7 个固定查询（spec §18.2，代码常量；顺序即执行顺序）。
 * kind 为 feed 归一类型；args 原样作为 tools/call 的 arguments。
 */
export const QUERIES = Object.freeze([
  { tool: 'searchTopic', q: 'FDE', kind: 'post', args: { keyword: 'FDE', pageSize: 20, displayMode: 2 } },
  { tool: 'searchTopic', q: 'Forward Deployed', kind: 'post', args: { keyword: 'Forward Deployed', pageSize: 20, displayMode: 2 } },
  { tool: 'searchTopic', q: '前沿部署工程师', kind: 'post', args: { keyword: '前沿部署工程师', pageSize: 20, displayMode: 2 } },
  { tool: 'searchTrustedContent', q: 'FDE', kind: 'wechat', args: { keyword: 'FDE', pageSize: 10 } },
  { tool: 'activitySearch', q: 'FDE', kind: 'activity', args: { keyword: 'FDE', pageSize: 10 } },
  { tool: 'searchNavigatorContent', q: 'FDE', kind: 'navigator', args: { keyword: 'FDE', pageSize: 10 } },
  { tool: 'activityManualSearch', q: 'FDE', kind: 'manual', args: { keyword: 'FDE', pageSize: 10 } },
]);

/* ============================ 模块内状态（单飞 / 重试计数） ============================ */

const state = {
  inflight: null,      // 单飞：正在进行的刷新 Promise
  attemptDate: '',     // 失败计数所属本地日期
  attemptsToday: 0,    // 当天已失败次数（用于「当天最多重试 3 次」）
};

/** 仅供测试重置模块状态（生产不用）。 */
export function resetScysState() {
  state.inflight = null;
  state.attemptDate = '';
  state.attemptsToday = 0;
}

/* ============================ 小工具 ============================ */

const str = (v) => (typeof v === 'string' ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const shortMsg = (e) => String((e && e.message) || e || '未知错误').slice(0, 240);

/** 只保留 http(s) 链接（spec §18.3 / §18.7 链接安全）。 */
export function sanitizeUrl(v) {
  const s = str(v);
  return /^https?:\/\//i.test(s) ? s : '';
}

/** 秒 / 毫秒时间戳 → ISO8601（UTC）；无法解析 → ''。 */
function isoFromEpoch(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

/**
 * 本地时间字符串 → ISO8601。
 * `searchTrustedContent.publishedAt` 实测为 `YYYY-MM-DD HH:mm:ss`（无时区），按本地时间解析
 * （spec §18.2「字段差异」）。
 */
function isoFromLocal(v) {
  const s = str(v);
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [y, mo, d, h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h < 24 && mi < 60 && se < 60) {
      const date = new Date(y, mo - 1, d, h, mi, se, 0);
      return Number.isFinite(date.getTime()) ? date.toISOString() : '';
    }
    return '';
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

/**
 * 纯文本化：去 HTML 标签（含 <em> 高亮）、实体、markdown 标记与多余空白，截断 ≤max 字。
 * @param {unknown} v
 * @param {number} [max]
 * @returns {string}
 */
export function cleanText(v, max = SUMMARY_MAX) {
  let s = String(v == null ? '' : v);
  if (!s) return '';
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/<[^>]{0,500}>/g, ' ');
  s = s.replace(/!\[[^\]]{0,200}\]\([^)]{0,500}\)/g, ' ');
  s = s.replace(/\[([^\]]{0,300})\]\([^)]{0,500}\)/g, '$1');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, '&');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s{0,3}(?:[-*+]|\d{1,2}[.)])\s+/gm, '');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
  s = s.replace(/\*([^*\n]+)\*/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/~~([^~\n]+)~~/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    s = s.slice(0, max);
    /* 避免把 emoji 等代理对切成半个字符 */
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  }
  return s;
}

/** 稳定 id 兜底：各工具 item 的 itemId/contentId/id，没有时用 url。 */
function fallbackId(prefix, candidates, url) {
  for (const c of candidates) { const s = str(c); if (s) return prefix + s; }
  return url ? prefix + url : '';
}

/* ============================ 归一化（spec §18.2 / §18.3） ============================ */

function tagsOfPost(t) {
  const tags = [];
  if (num(t.isDigested) === 1) tags.push('精华');
  if (num(t.likeCount) >= 100) tags.push('热门');
  if (str(t.type) === 'q&a') tags.push('问答');
  return tags;
}

const zeroStats = () => ({ like: 0, comment: 0, read: 0, coin: 0, favorite: 0 });

function baseItem(kind, id) {
  return {
    id,
    kind,
    subtype: '',
    title: '',
    summary: '',
    author: '',
    authorAvatar: '',
    url: '',
    publishedAt: '',
    tags: [],
    stats: zeroStats(),
    isNew: false,
  };
}

/** 单条归一：字段缺失一律兜底为空，不抛错。 */
function normalizeItem(kind, raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (kind === 'post') {
    const t = raw.topicDTO && typeof raw.topicDTO === 'object' ? raw.topicDTO : {};
    const u = raw.topicUserDTO && typeof raw.topicUserDTO === 'object' ? raw.topicUserDTO : {};
    const entityId = str(t.entityId) || str(t.topicId) || str(raw.entityId);
    const url = sanitizeUrl(raw.detailUrl) || sanitizeUrl(t.detailUrl)
      || (entityId ? `https://scys.com/articleDetail/${str(t.entityType) || 'xq_topic'}/${entityId}` : '');
    const id = entityId ? 'xq:' + entityId : fallbackId('xq:', [], url);
    if (!id) return null;
    const it = baseItem('post', id);
    it.subtype = str(t.type);
    it.title = cleanText(t.showTitle || t.highlightShowTitle || t.title || '', 300);
    it.summary = cleanText(t.articleContent || t.highlightArticleContent || '', SUMMARY_MAX);
    it.author = cleanText(u.name || '', 100);
    it.authorAvatar = sanitizeUrl(u.avatar);
    it.url = url;
    it.publishedAt = isoFromEpoch(t.gmtCreate);
    it.tags = tagsOfPost(t);
    it.stats = {
      like: num(t.likeCount),
      comment: num(t.commentsCount),
      read: num(t.readingCount),
      coin: num(t.coinCount),
      favorite: num(t.favoriteCount),
    };
    return it;
  }
  if (kind === 'wechat') {
    /* searchTrustedContent：公众号（wechat_mp）与推特（twitter）共用；total 是全文匹配量级，不能用。 */
    const itemId = str(raw.itemId) || str(raw.contentId) || str(raw.id);
    const url = sanitizeUrl(raw.originalUrl);
    const id = fallbackId('wechat:', [itemId], url);
    if (!id) return null;
    const it = baseItem('wechat', id);
    it.subtype = str(raw.sourceType);
    it.title = cleanText(raw.titleZh || raw.title || '', 300);
    it.summary = cleanText(raw.snippet || raw.title || '', SUMMARY_MAX);
    it.author = cleanText(raw.accountName || '', 100);
    it.url = url;
    it.publishedAt = isoFromLocal(raw.publishedAt);
    return it;
  }
  if (kind === 'activity') {
    /* activitySearch：航海项目。startTime 是开船时间（可能在未来），作为 publishedAt 唯一可用时间。 */
    const rawId = str(raw.id) || str(raw.activityId);
    const url = sanitizeUrl(raw.hrefUrl);
    const id = fallbackId('activity:', [rawId], url);
    if (!id) return null;
    const it = baseItem('activity', id);
    it.subtype = str(raw.type);
    it.title = cleanText(raw.name || raw.title || '', 300);
    it.summary = cleanText(raw.target || '', SUMMARY_MAX);
    it.url = url;
    it.publishedAt = isoFromEpoch(raw.startTime);
    return it;
  }
  if (kind === 'navigator') {
    /* searchNavigatorContent：无 total，用 items.length 计数；date 为内容日期。 */
    const rawId = str(raw.contentId) || str(raw.itemId) || str(raw.id);
    const url = sanitizeUrl(raw.detailUrl);
    const id = fallbackId('navigator:', [rawId], url);
    if (!id) return null;
    const it = baseItem('navigator', id);
    it.subtype = str(raw.contentType);
    it.title = cleanText(raw.title || raw.subtitle || '', 300);
    it.summary = cleanText(raw.summary || raw.subtitle || '', SUMMARY_MAX);
    it.url = url;
    it.publishedAt = isoFromLocal(raw.date) || isoFromLocal(raw.createdAt);
    return it;
  }
  if (kind === 'manual') {
    /* activityManualSearch：航海手册条目。 */
    const rawId = str(raw.id) || str(raw.itemId);
    const url = sanitizeUrl(raw.hrefUrl);
    const id = fallbackId('manual:', [rawId], url);
    if (!id) return null;
    const it = baseItem('manual', id);
    it.subtype = str(raw.type);
    it.title = cleanText(raw.title || raw.highlightShowTitle || '', 300);
    it.summary = cleanText(raw.highlightArticleContent || raw.activityName || '', SUMMARY_MAX);
    it.url = url;
    it.publishedAt = isoFromEpoch(raw.gmtCreate);
    return it;
  }
  return null;
}

/** 工具 payload → 归一 items；单条坏数据跳过，不抛错。 */
export function normalizeItems(kind, payload) {
  if (!payload || typeof payload !== 'object') return [];
  const list = Array.isArray(payload.items) ? payload.items : (Array.isArray(payload) ? payload : []);
  const out = [];
  for (const raw of list) {
    try {
      const it = normalizeItem(kind, raw);
      if (it && it.id) out.push(it);
    } catch { /* 单条失败静默跳过 */ }
  }
  return out;
}

const publishedValue = (it) => {
  const t = Date.parse(String(it && it.publishedAt ? it.publishedAt : ''));
  return Number.isFinite(t) ? t : 0;
};

/** 合并去重（id 键，先到先得）+ publishedAt 倒序（无时间排后）。 */
export function mergeItems(list) {
  const map = new Map();
  for (const it of list || []) {
    if (!it || !it.id || map.has(it.id)) continue;
    map.set(it.id, it);
  }
  const arr = [...map.values()];
  arr.sort((a, b) => publishedValue(b) - publishedValue(a));
  return arr;
}

/* ---------------- 非 post 类相关性过滤（spec §18.2「不做本地相关性过滤」的实测补充） ----------------
 * 2026-11-04 真实冒烟：除 searchTopic 外，其余工具对 keyword 'FDE' 匹配很松——
 * activityManualSearch 返回抖音 CPS / 小红书 PPT 等无关手册、searchNavigatorContent 混入夜话、
 * searchTrustedContent 混入无关推文。post 类工具本身精确匹配，**不过滤**；其余（wechat / activity /
 * navigator / manual）只保留 title + summary 提及 FDE / Forward Deployed / 前沿部署 / 部署工程师 的条目
 * （不区分大小写）。过滤发生在归一化之后、合并之前；被过滤条数记入 feed.stats.filteredOut 便于诊断。 */
export const RELEVANCE_RE = /fde|forward\s*deployed|前沿部署|部署工程师/i;

/** 非 post 类条目是否与 FDE 相关（title/summary 任一命中关键词）。 */
export function isRelevantItem(item) {
  if (!item || typeof item !== 'object') return false;
  return RELEVANCE_RE.test(String(item.title || '') + ' ' + String(item.summary || ''));
}

function statsOf(items, filteredOut = 0) {
  const stats = { total: 0, post: 0, wechat: 0, activity: 0, navigator: 0, manual: 0, new: 0, filteredOut: 0 };
  for (const it of items || []) {
    stats.total += 1;
    if (Object.prototype.hasOwnProperty.call(stats, it.kind)) stats[it.kind] += 1;
    if (it.isNew) stats.new += 1;
  }
  stats.filteredOut = Math.max(0, Number(filteredOut) || 0);
  return stats;
}

/* ============================ 凭证（spec §18.1 / ADR 0004 D5） ============================ */

/** 链接授权文件：<root>/research/.fde/scys-auth.json（0600；只由面板显式保存）。 */
export function authFilePath(root) {
  return join(String(root || ''), 'research', '.fde', 'scys-auth.json');
}

/** MCP OAuth 状态目录（旧 scys-mcp 兼容路径；可用环境变量覆盖以便测试）。 */
export function authStateDir() {
  const env = str(process.env.SCYS_MCP_STATE_DIR);
  return env || join(homedir(), '.dsh', 'mcp', 'scys-mcp');
}

function tokenFile() { return join(authStateDir(), 'tokens.json'); }

/** 把秒级/毫秒级 expires_at 归一成毫秒；无效值返回 0。 */
function normalizeExpiry(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/** 路径①：链接授权文件（面板保存）。文件存在但损坏/过期时立即报错，不静默回退。 */
function readLinkAuth(root) {
  if (!root) return null;
  let raw;
  try { raw = readFileSync(authFilePath(root), 'utf8'); } catch { return null; }
  let obj;
  try { obj = JSON.parse(raw); } catch {
    return { ok: false, code: 'UNAUTHORIZED', source: 'link', reason: '链接授权文件损坏：请在面板「生财情报授权」重新保存' };
  }
  const token = obj && typeof obj === 'object' && typeof (obj.access_token || obj.token) === 'string'
    ? String(obj.access_token || obj.token).trim() : '';
  if (!token) return null;
  const exp = normalizeExpiry(obj.expires_at);
  const expiresAt = exp ? new Date(exp).toISOString() : null;
  if (exp && exp <= Date.now()) {
    return { ok: false, code: 'UNAUTHORIZED', source: 'link', expiresAt, reason: '链接授权已过期：请重新授权' };
  }
  return { ok: true, token, source: 'link', expiresAt };
}

/** 路径②：环境变量。 */
function readEnvAuth() {
  const token = str(process.env.FDE_SCYS_TOKEN);
  if (!token) return null;
  const exp = normalizeExpiry(process.env.FDE_SCYS_TOKEN_EXPIRES_AT);
  const expiresAt = exp ? new Date(exp).toISOString() : null;
  if (exp && exp <= Date.now()) {
    return { ok: false, code: 'UNAUTHORIZED', source: 'env', expiresAt, reason: 'FDE_SCYS_TOKEN 已过期' };
  }
  return { ok: true, token, source: 'env', expiresAt };
}

/** 路径③：旧 scys-mcp token 文件（兼容，只读，不推荐）。 */
function readCompatAuth() {
  let raw;
  try {
    raw = readFileSync(tokenFile(), 'utf8');
  } catch {
    return null;
  }
  let obj;
  try { obj = JSON.parse(raw); } catch {
    return { ok: false, code: 'UNAUTHORIZED', source: 'compat', reason: AUTH_BROKEN_REASON };
  }
  const token = obj && typeof obj === 'object' && typeof obj.access_token === 'string' ? obj.access_token.trim() : '';
  if (!token) return null;
  let exp = Number(obj.expires_at);
  if (Number.isFinite(exp) && exp > 0) {
    if (exp < 1e12) exp *= 1000; // 兼容秒级 expires_at
    if (exp <= Date.now()) return { ok: false, code: 'UNAUTHORIZED', source: 'compat', reason: AUTH_EXPIRED_REASON };
  }
  return { ok: true, token, source: 'compat', expiresAt: exp ? new Date(exp).toISOString() : null };
}

/**
 * 按优先级解析授权：链接授权 > 环境变量 > 兼容 token 文件。
 * 第一个「存在」的来源决定结果（损坏/过期会报错，不静默降级到下一来源）。
 * 返回值只在模块内部带 token；对外导出 authStatus() 不含 token。
 * @returns {{ok:true, token:string, source:'link'|'env'|'compat', expiresAt:string|null}|{ok:false, code:string, source?:string, reason:string}}
 */
function loadAuth(root) {
  const link = readLinkAuth(root);
  if (link) return link;
  const env = readEnvAuth();
  if (env) return env;
  const compat = readCompatAuth();
  if (compat) return compat;
  return { ok: false, code: 'UNAUTHORIZED', source: 'none', reason: AUTH_MISSING_REASON };
}

/** 授权状态（诊断用；绝不返回 token）。 */
export function authStatus(root) {
  const a = loadAuth(root);
  const base = { stateDir: authStateDir(), authFile: authFilePath(root) };
  if (a.ok) return Object.assign({ ok: true, available: true, source: a.source, expiresAt: a.expiresAt || null }, base);
  return Object.assign({ ok: false, available: false, source: a.source || 'none', code: a.code, reason: a.reason }, base);
}

/** 面板/GUI 用的授权摘要（不含路径与 token）。 */
export function authSummary(root) {
  const s = authStatus(root);
  return { available: s.ok === true, source: s.source || 'none', expiresAt: s.expiresAt || null };
}

/**
 * 解析用户粘贴的「授权链接或 access_token」。
 * 链接：取 search 里的 access_token/token/code，或 hash 里的 access_token/token；
 * 不是 URL 时按原串当 token。
 * @returns {{ok:true, token:string}|{ok:false, reason:string}}
 */
export function parseAuthInput(input = {}) {
  const rawToken = str(input.token);
  const rawUrl = str(input.url);
  let value = rawToken;
  if (!value && rawUrl) {
    try {
      const u = new URL(rawUrl);
      value = str(u.searchParams.get('access_token')) || str(u.searchParams.get('token')) || str(u.searchParams.get('code')) || '';
      if (!value && u.hash) {
        const h = new URLSearchParams(String(u.hash).replace(/^#/, ''));
        value = str(h.get('access_token')) || str(h.get('token')) || '';
      }
    } catch {
      value = rawUrl; // 不是 URL：按 token 原串处理
    }
  }
  const token = value.trim();
  if (!token) return { ok: false, reason: '没有拿到 token：请粘贴授权链接或 access_token' };
  if (token.length < 12 || token.length > 4096) return { ok: false, reason: 'token 长度异常，请核对后重试' };
  if (/[\s\u0000-\u001f]/.test(token)) return { ok: false, reason: 'token 含空白或控制字符，请核对' };
  return { ok: true, token };
}

/**
 * 保存链接授权到 <root>/research/.fde/scys-auth.json（0600，临时文件 + rename）。
 * 写失败不破坏旧授权。
 */
export function saveLinkAuth(root, { token, expiresAt } = {}) {
  const base = String(root || '');
  if (!base) return { ok: false, code: 'INVALID', reason: '缺少工作区根，无法保存授权' };
  const dir = join(base, 'research', '.fde');
  try { mkdirSync(dir, { recursive: true }); } catch {
    return { ok: false, code: 'INTERNAL', reason: '无法创建授权目录（research/.fde）' };
  }
  const exp = normalizeExpiry(expiresAt);
  const payload = { version: 1, access_token: token, savedAt: store.nowIso() };
  if (exp) payload.expires_at = exp;
  const target = authFilePath(root);
  const tmp = join(dir, `.scys-auth.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target);
    try { chmodSync(target, 0o600); } catch { /* Windows 等不支持时忽略 */ }
    return { ok: true };
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 忽略 */ }
    return { ok: false, code: 'INTERNAL', reason: '写入授权文件失败（旧授权已保留）' };
  }
}

/** 清除链接授权（不影响环境变量/兼容文件）。 */
export function clearLinkAuth(root) {
  const target = authFilePath(root);
  try {
    if (!existsSync(target)) return { ok: true, removed: false };
    unlinkSync(target);
    return { ok: true, removed: true };
  } catch (e) {
    return { ok: false, code: 'INTERNAL', reason: '删除授权文件失败' };
  }
}

/** 路由：保存授权（POST body = {token?|url?, expiresAt?}）。 */
export function saveAuthFromInput(root, input = {}) {
  const parsed = parseAuthInput(input);
  if (!parsed.ok) return { ok: false, code: 'INVALID', reason: parsed.reason };
  const w = saveLinkAuth(root, { token: parsed.token, expiresAt: input.expiresAt || input.expires_at });
  if (!w.ok) return w;
  return { ok: true, auth: authSummary(root) };
}

/** 路由：清除授权（返回清除后的状态）。 */
export function clearAuthFromInput(root) {
  const c = clearLinkAuth(root);
  if (!c.ok) return c;
  return { ok: true, auth: authSummary(root), removed: c.removed };
}

/* ============================ MCP JSON-RPC 客户端（spec §18.1） ============================ */

class McpError extends Error {
  constructor(message, { code = 'MCP_ERROR', status = 0, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** 解析 JSON 或 SSE（text/event-stream）响应体，返回对应 id 的 JSON-RPC 消息。 */
function parseMessage(raw, contentType, expectId) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const isSse = String(contentType || '').toLowerCase().includes('text/event-stream')
    || /^event:/m.test(text) || /^data:/m.test(text);
  if (isSse) {
    const messages = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data) continue;
      try { messages.push(JSON.parse(data)); } catch { /* 跳过坏块 */ }
    }
    return messages.find((m) => expectId == null || m.id === expectId) || messages[messages.length - 1] || null;
  }
  try { return JSON.parse(text); } catch {
    throw new McpError('生财 MCP 返回非 JSON：' + text.slice(0, 120), { code: 'BAD_PAYLOAD' });
  }
}

/** tools/call 结果解包：区分限流（可重试一次）、工具错误、非 JSON 正文。 */
function unwrapToolResult(result, name) {
  if (!result || typeof result !== 'object') throw new McpError(name + ' 返回为空', { code: 'BAD_RESPONSE' });
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n').trim();
  if (result.isError === true) {
    const retry = Number((text.match(/retryAfterSeconds\s*=\s*([\d.]+)/i) || [])[1]);
    const rateLimited = /MCP_RATE_LIMITED/.test(text);
    throw new McpError(text.slice(0, 160) || (name + ' 调用失败'), {
      code: rateLimited ? 'MCP_RATE_LIMITED' : 'TOOL_ERROR',
      retryAfter: Number.isFinite(retry) ? retry : 1,
    });
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    throw new McpError(name + ' 返回非 JSON：' + text.slice(0, 120), { code: 'BAD_PAYLOAD' });
  }
}

/**
 * 新建一次 MCP 握手（initialize → notifications/initialized），返回调用会话。
 * 每次刷新新建握手、不复用 session（spec §18.1）。
 */
async function openSession({ fetchImpl, token, sleep, timeoutMs }) {
  let nextId = 1;
  let sessionId = null;
  let protocolVersion = null;

  async function post(payload, tMs) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + token,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* 忽略 */ } }, Math.max(1000, tMs));
    try {
      let res;
      try {
        res = await fetchImpl(MCP_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
      } catch (e) {
        throw new McpError('请求生财 MCP 失败：' + shortMsg(e), { code: 'NETWORK' });
      }
      if (!res || typeof res !== 'object') throw new McpError('生财 MCP 无响应', { code: 'NETWORK' });
      const getHeader = (k) => {
        try { return res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null; } catch { return null; }
      };
      const sid = getHeader('mcp-session-id');
      if (sid) sessionId = String(sid);
      const status = Number(res.status) || 0;
      const raw = typeof res.text === 'function' ? await res.text() : '';
      /* 2xx 均视为成功：MCP 对 notifications/initialized 常回 202 空响应。 */
      if (status && (status < 200 || status >= 300)) {
        throw new McpError('生财 MCP HTTP ' + status, {
          code: status === 401 ? 'UNAUTHORIZED' : 'UNAVAILABLE',
          status,
        });
      }
      if (!String(raw || '').trim()) return null;
      return parseMessage(raw, getHeader('content-type'), payload.id);
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(method, params, tMs) {
    const id = nextId++;
    const message = await post({ jsonrpc: '2.0', id, method, params }, tMs);
    if (!message) throw new McpError(method + ' 无响应', { code: 'BAD_RESPONSE' });
    if (message.error) {
      throw new McpError('MCP ' + method + ' 错误：' + (message.error.message || message.error.code || '未知'), {
        code: 'MCP_ERROR',
        status: Number(message.error.code) || 0,
      });
    }
    return message.result;
  }

  async function notify(method, params, tMs) {
    await post({ jsonrpc: '2.0', method, params }, tMs);
  }

  /**
   * 调只读工具。MCP 限流（MCP_RATE_LIMITED）按提示等待后重试一次，
   * 仍失败抛错由调用方记 queries[i].error（spec §18.2）。
   */
  async function callTool(name, args, tMs) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await request('tools/call', { name, arguments: args || {} }, tMs);
        return unwrapToolResult(result, name);
      } catch (e) {
        if (e instanceof McpError && e.code === 'MCP_RATE_LIMITED' && attempt === 0) {
          const seconds = Math.min(Math.max(Number(e.retryAfter) || 1, 0.2), 10);
          await sleep(seconds * 1000);
          continue;
        }
        throw e;
      }
    }
  }

  return {
    async initialize(tMs) {
      const result = await request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      }, tMs);
      protocolVersion = (result && result.protocolVersion) || MCP_PROTOCOL_VERSION;
      await notify('notifications/initialized', {}, tMs);
    },
    callTool,
  };
}

/* ============================ feed 读写（spec §18.3） ============================ */

/** feed 绝对路径：<root>/research/.fde/scys-fde.json */
export function feedPath(root) {
  return join(String(root || ''), 'research', '.fde', 'scys-fde.json');
}

/**
 * 读缓存。文件缺失 → {feed:null, corrupt:false}；JSON 损坏 → {feed:null, corrupt:true}（不抛错）。
 * @returns {{feed: object|null, corrupt: boolean}}
 */
export function readFeed(root) {
  let raw;
  try {
    raw = readFileSync(feedPath(root), 'utf8');
  } catch {
    return { feed: null, corrupt: false };
  }
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { feed: null, corrupt: true };
    if (!Array.isArray(obj.items)) obj.items = [];
    if (!Array.isArray(obj.queries)) obj.queries = [];
    if (!obj.stats || typeof obj.stats !== 'object') obj.stats = statsOf(obj.items);
    if (!Number.isFinite(Number(obj.version))) obj.version = FEED_VERSION;
    return { feed: obj, corrupt: false };
  } catch {
    return { feed: null, corrupt: true };
  }
}

/** 原子写：先写同目录临时文件再 rename（spec §18.3）。 */
function writeFeed(root, feed) {
  const file = feedPath(root);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36);
  writeFileSync(tmp, JSON.stringify(feed, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 忽略 */ }
    throw e;
  }
  return file;
}

/** 失败时保留上次成功数据，只更新 ok / lastError / lastCode（无旧 feed 则不落盘）。 */
function writeFeedFailure(root, prevFeed, { code, reason }) {
  if (!prevFeed || typeof prevFeed !== 'object') return null;
  const next = Object.assign({}, prevFeed, {
    ok: false,
    lastError: String(reason || '刷新失败').slice(0, 300),
    lastCode: code || 'UNAVAILABLE',
    lastAttemptAt: new Date().toISOString(),
  });
  try { writeFeed(root, next); } catch { /* 落盘失败不影响返回 */ }
  return next;
}

/* ============================ 视图 / 状态（spec §18.5） ============================ */

const failureView = (today, { code, reason, feed }) => ({
  ok: false,
  code,
  reason,
  feed: feed || null,
  today,
  stale: !feed || feed.date !== today,
  refreshing: false,
});

/** 只读当前状态（不联网）：GET /scys/feed 与工具 feed 共用。 */
export function status(root) {
  const today = store.localDateStr();
  const refreshing = !!state.inflight;
  const { feed } = readFeed(root);
  if (!feed) return { ok: true, feed: null, today, stale: true, refreshing };
  const stale = feed.date !== today;
  if (feed.ok === false) {
    return {
      ok: false,
      code: feed.lastCode || 'UNAVAILABLE',
      reason: feed.lastError || '上次刷新失败',
      feed,
      today,
      stale,
      refreshing,
    };
  }
  return { ok: true, feed, today, stale, refreshing };
}

/* ============================ 抓取（spec §18.2 / §18.4） ============================ */

function recordFailure(today) {
  if (state.attemptDate !== today) { state.attemptDate = today; state.attemptsToday = 0; }
  state.attemptsToday += 1;
}

function recordSuccess(today) {
  state.attemptDate = today;
  state.attemptsToday = 0;
}

function failedToday(today) {
  return state.attemptDate === today ? state.attemptsToday : 0;
}

async function doRefresh(root, opts) {
  const startedAt = Date.now();
  const today = store.localDateStr(startedAt);
  const fetchImpl = typeof opts.fetchImpl === 'function'
    ? opts.fetchImpl
    : (typeof fetch === 'function' ? fetch : null);
  const gapMs = Number.isFinite(Number(opts.gapMs)) ? Math.max(0, Number(opts.gapMs)) : MIN_GAP_MS;
  const sleep = async (ms) => {
    const n = Math.max(0, Number(ms) || 0);
    if (typeof opts.sleepImpl === 'function') { await opts.sleepImpl(n); return; }
    await new Promise((r) => setTimeout(r, n));
  };
  const budgetEnd = startedAt + TOTAL_BUDGET_MS;
  const prev = readFeed(root).feed;

  /* 1) 凭证（缺失/过期 → UNAUTHORIZED，同时保留上次 feed） */
  const auth = loadAuth(root);
  if (!auth.ok) {
    recordFailure(today);
    const feed = writeFeedFailure(root, prev, { code: 'UNAUTHORIZED', reason: auth.reason });
    return failureView(today, { code: 'UNAUTHORIZED', reason: auth.reason, feed: feed || prev });
  }

  /* 2) 握手（每次刷新新建，不复用 session） */
  if (typeof fetchImpl !== 'function') {
    const reason = '当前运行环境不支持 fetch，无法访问生财 MCP';
    recordFailure(today);
    const feed = writeFeedFailure(root, prev, { code: 'UNAVAILABLE', reason });
    return failureView(today, { code: 'UNAVAILABLE', reason, feed: feed || prev });
  }
  let session;
  try {
    session = await openSession({
      fetchImpl,
      token: auth.token,
      sleep,
      timeoutMs: Math.min(QUERY_TIMEOUT_MS, Math.max(1000, budgetEnd - Date.now())),
    });
    await session.initialize(Math.min(QUERY_TIMEOUT_MS, Math.max(1000, budgetEnd - Date.now())));
  } catch (e) {
    const code = e instanceof McpError && e.code === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : 'UNAVAILABLE';
    const reason = code === 'UNAUTHORIZED' ? AUTH_EXPIRED_REASON : ('连接生财 MCP 失败：' + shortMsg(e));
    recordFailure(today);
    const feed = writeFeedFailure(root, prev, { code, reason });
    return failureView(today, { code, reason, feed: feed || prev });
  }

  /* 3) 7 个查询：严格串行，相邻间隔 ≥ gapMs；单 query 超时 15s，整体预算 90s
   *    非 post 类做轻量相关性过滤（见 isRelevantItem 注释），post 类不过滤。 */
  const queries = [];
  const collected = [];
  let filteredOut = 0;
  for (let i = 0; i < QUERIES.length; i += 1) {
    const def = QUERIES[i];
    if (i > 0 && gapMs > 0) await sleep(gapMs);
    const qStartedAt = Date.now();
    const remaining = budgetEnd - qStartedAt;
    if (remaining <= 500) {
      queries.push({ tool: def.tool, q: def.q, ok: false, count: 0, error: '整体预算超时，未执行', ms: 0 });
      continue;
    }
    try {
      const payload = await session.callTool(def.tool, def.args, Math.min(QUERY_TIMEOUT_MS, remaining));
      const normalized = normalizeItems(def.kind, payload);
      const items = def.kind === 'post' ? normalized : normalized.filter(isRelevantItem);
      filteredOut += normalized.length - items.length;
      queries.push({ tool: def.tool, q: def.q, ok: true, count: items.length, error: null, ms: Date.now() - qStartedAt });
      collected.push(...items);
    } catch (e) {
      queries.push({ tool: def.tool, q: def.q, ok: false, count: 0, error: shortMsg(e), ms: Date.now() - qStartedAt });
    }
  }

  /* 4) 全失败 → 保留旧 feed，记 lastError；有成功则写新 feed */
  const okCount = queries.filter((q) => q.ok).length;
  if (okCount === 0) {
    const firstError = (queries.find((q) => q.error) || {}).error || '所有查询均失败';
    const reason = '生财 MCP 抓取失败：' + firstError;
    recordFailure(today);
    const feed = writeFeedFailure(root, prev, { code: 'UNAVAILABLE', reason });
    return failureView(today, { code: 'UNAVAILABLE', reason, feed: feed || prev });
  }

  const prevIds = new Set(((prev && Array.isArray(prev.items)) ? prev.items : []).map((x) => (x && x.id) || '').filter(Boolean));
  const items = mergeItems(collected);
  for (const it of items) it.isNew = !prevIds.has(it.id);

  const feed = {
    version: FEED_VERSION,
    date: today,
    fetchedAt: new Date().toISOString(),
    ok: true,
    lastError: null,
    lastCode: null,
    stats: statsOf(items, filteredOut),
    queries,
    items,
  };
  try {
    writeFeed(root, feed);
  } catch (e) {
    recordFailure(today);
    return failureView(today, {
      code: 'INTERNAL',
      reason: '写入生财情报缓存失败：' + shortMsg(e),
      feed: prev,
    });
  }
  recordSuccess(today);
  return { ok: true, feed, today, stale: false, refreshing: false };
}

/**
 * 强制执行一次刷新（不做「每天一次」门控；单飞：并发调用共享同一次 flight）。
 * @param {string} root 工作区根
 * @param {{fetchImpl?:Function, gapMs?:number, sleepImpl?:Function, force?:boolean}} [opts]
 */
export function refresh(root, opts = {}) {
  if (state.inflight) return state.inflight;
  state.inflight = doRefresh(root, opts || {}).finally(() => { state.inflight = null; });
  return state.inflight;
}

/**
 * 按「每天一次」门控刷新：feed 缺失 / 日期不是今天 / force 才抓；
 * 失败当天最多重试 DAILY_FAIL_LIMIT 次（force 不受限，供面板/工具手动刷新）。
 */
export async function maybeRefresh(root, opts = {}) {
  const today = store.localDateStr();
  if (state.inflight) return Object.assign(status(root), { skipped: true });
  const { feed } = readFeed(root);
  if (feed && feed.date === today && !opts.force) return Object.assign(status(root), { skipped: true });
  if (!opts.force && failedToday(today) >= DAILY_FAIL_LIMIT) {
    return Object.assign(status(root), {
      ok: false,
      code: 'RETRY_LIMIT',
      reason: '今日生财情报刷新失败已达 ' + DAILY_FAIL_LIMIT + ' 次，明日再试',
      skipped: true,
    });
  }
  return refresh(root, opts);
}

/** 紧凑展示条目（工具 scys_fde / 面板共用口径；只取缓存，不联网）。 */
export function compactFeed(statusResult, { limit = 20, kind = '', q = '' } = {}) {
  const feed = statusResult && statusResult.feed;
  const kw = str(q).toLowerCase();
  const kindFilter = KINDS.includes(str(kind)) ? str(kind) : '';
  const max = Math.min(50, Math.max(1, Number(limit) || 20));
  const all = (feed && Array.isArray(feed.items)) ? feed.items : [];
  let items = all.filter((it) => (!kindFilter || it.kind === kindFilter));
  if (kw) {
    items = items.filter((it) => [it.title, it.summary, it.author].some((v) => String(v || '').toLowerCase().includes(kw)));
  }
  return {
    feed,
    items: items.slice(0, max),
    matched: items.length,
    total: all.length,
    limit: max,
    kind: kindFilter,
    q: str(q),
  };
}
