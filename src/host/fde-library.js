/**
 * FDE 工作站 · FDE 资料库（spec §19，v1.3 2026-11-04）
 *
 * 定位：**只读资料层** —— 把权威资料（国外官方一手 / 国内官方一手）、开源工具（GitHub）、
 * 方法与模板、社区动态（生财，来自 scys-fde.json 缓存）合并为一个可筛选、可重点推荐的资料集，
 * 供宿主路由 `library/feed` `library/refresh`、工具 `fde_library` 与面板读取。
 *
 * 数据来源与边界（spec §19.7）：
 * - 策展目录 `reference/fde-library/catalog.json` 随插件发布、人工维护（只读，本模块不改）；
 * - 每日刷新只做三件事：① GitHub 指标（items[].repo && track，≤30 个、并发 ≤3、10s 超时、不带 token）；
 *   ② 社区动态映射（只读 research/.fde/scys-fde.json，不重复调用 MCP）；③ isNew/updated 差分。
 * - **不抓取任意网页正文**：策展条目内容只在发版/人工编辑时更新（版权与不可控抓取风险）。
 * - 目录缺失/不可读 → `{ok:false, code:'UNAVAILABLE'}`（同时带旧 feed）；GitHub/社区失败不阻断主体，
 *   只写 sources 与 warnings（spec §19.4）。
 *
 * 缓存：`research/.fde/fde-library.json`，原子写（tmp + rename）；损坏 JSON 视为空缓存；不写备份（缓存类）。
 * 节奏：缓存缺失 / feed.date !== 本地今天 / force 时刷新；宿主启动后 20s 检查、此后每 30 分钟；
 *       单飞；失败保留旧 feed，当天最多重试 3 次（由 index.js 定时器与 maybeRefresh 共同保证）。
 *
 * 零新依赖；不 import @deepseek-ai/*；本模块不做日志输出。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './fde-store.js';
import * as schema from './fde-schema.js';
import { cleanText, sanitizeUrl } from './fde-scys.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 插件根目录（src/host/../..）。 */
export const PLUGIN_ROOT = join(HERE, '..', '..');

/* ============================ 常量（spec §19） ============================ */

export const LIBRARY_VERSION = 1;
/** 缓存相对路径（工作区内）。 */
export const FEED_REL = 'research/.fde/fde-library.json';
/** 策展目录相对插件根的默认路径。 */
export const CATALOG_REL = 'reference/fde-library/catalog.json';
/** 社区动态缓存（scys-fde.json）相对工作区路径。 */
export const COMMUNITY_REL = 'research/.fde/scys-fde.json';

/** 来源组（spec §19.1；面板一级筛选）。 */
export const GROUPS = Object.freeze([
  { key: 'intl-official', label: '国外官方', definition: 'OpenAI/Anthropic/Google/Microsoft/Palantir 等官方一手' },
  { key: 'cn-official', label: '国内官方', definition: '腾讯云/阿里云/字节/华为云/百度等官方一手' },
  { key: 'opensource', label: '开源工具', definition: 'GitHub 仓库（指标每日刷新）' },
  { key: 'method', label: '方法与模板', definition: '方法论、清单、模板、报告（含内部可公开方法）' },
  { key: 'community', label: '社区动态', definition: '生财 FDE 情报（来自 scys-fde.json 缓存，非策展）' },
]);
export const GROUP_KEYS = GROUPS.map((g) => g.key);

/** 条目类型（spec §19.1；社区映射为 post）。 */
export const KINDS = Object.freeze(['doc', 'whitepaper', 'guide', 'playbook', 'blog', 'course', 'report', 'case', 'job', 'repo', 'template', 'post']);
/** 权威性分级。 */
export const AUTHORITIES = Object.freeze(['A', 'B', 'C']);
/** 推荐等级（spec §19.1）。 */
export const RECOMMENDS = Object.freeze(['star', 'recommend', 'backup']);

/** GitHub 刷新约束（spec §19.2）。 */
export const GITHUB_API = 'https://api.github.com/repos/';
export const GITHUB_UA = 'research-workbench/0.1';
export const GITHUB_ACCEPT = 'application/vnd.github+json';
export const GITHUB_TIMEOUT_MS = 10000;
export const GITHUB_CONCURRENCY = 3;
export const GITHUB_TRACK_MAX = 30;

/** 重点推荐条数上限（spec §19.3）。 */
export const FEATURED_MAX = 12;
/** `addedAt` 在 7 天内视为「新」。 */
export const NEW_DAYS = 7;
/** summary / why 字数上限（策展口径，超限只告警不阻断）。 */
export const SUMMARY_MAX = 120;
export const WHY_MAX = 80;
/** 社区动态摘要上限（spec §19.7：只存摘要 + 链接）。 */
export const COMMUNITY_SUMMARY_MAX = 200;
/** 当天刷新失败最多重试次数（spec §19.2）。 */
export const DAILY_FAIL_LIMIT = 3;
/** 定时器节奏（index.js 使用；spec §19.2）。 */
export const TIMER_START_DELAY_MS = 20 * 1000;
export const TIMER_INTERVAL_MS = 30 * 60 * 1000;

export const UNAVAILABLE_REASON = '资料目录缺失';
const str = (v) => (typeof v === 'string' ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const shortMsg = (e) => String((e && e.message) || e || '未知错误').slice(0, 240);
const isHttpUrl = (v) => /^https?:\/\//i.test(str(v));

/* ============================ 模块内状态（单飞 / 重试计数） ============================ */

const state = {
  inflight: null,      // 单飞：正在进行的刷新 Promise
  attemptDate: '',     // 失败计数所属本地日期
  attemptsToday: 0,    // 当天已失败次数（当天最多重试 3 次）
};

/** 仅供测试重置模块状态（生产不用）。 */
export function resetLibraryState() {
  state.inflight = null;
  state.attemptDate = '';
  state.attemptsToday = 0;
}

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

/* ============================ 目录加载与校验（spec §19.1） ============================ */

/** 策展目录默认绝对路径（插件 reference/ 下）。 */
export function catalogDefaultPath() {
  return join(PLUGIN_ROOT, 'reference', 'fde-library', 'catalog.json');
}

function catalogPathOf(opts = {}) {
  const custom = str(opts && opts.catalogPath);
  if (custom) return custom;
  /* 可选环境变量覆盖（测试 / 多目录部署用；生产默认仍为插件 reference/ 下的策展目录）。 */
  const envPath = str(process.env.FDE_LIBRARY_CATALOG_PATH);
  return envPath || catalogDefaultPath();
}

const catalogCache = new Map(); // `${file}|${mtimeMs}|${size}` → parsed catalog（只读复用）

/**
 * 校验策展目录（spec §19.1 规则 + §19.8 验收 1）。
 * 硬错误：结构、id 唯一、url 为 http(s)、同 URL 不重复、group/kind/authority/stages/recommend 枚举。
 * 软告警：summary/why 超字数、id 非 kebab-case、group 列表缺失、addedAt 非法等（不阻断）。
 * @returns {{ok:boolean, errors:string[], warnings:string[], stats:object}}
 */
export function validateCatalog(catalog) {
  const errors = [];
  const warnings = [];
  const emptyStats = { total: 0, byGroup: {}, featured: 0, star: 0, track: 0 };
  if (!isObj(catalog)) return { ok: false, errors: ['catalog 不是 JSON 对象'], warnings, stats: emptyStats };
  if (!Array.isArray(catalog.items)) return { ok: false, errors: ['catalog.items 不是数组'], warnings, stats: emptyStats };
  if (catalog.groups !== undefined) {
    if (!Array.isArray(catalog.groups)) {
      warnings.push('catalog.groups 不是数组，已按内置来源组处理');
    } else {
      for (const g of catalog.groups) {
        const key = str(g && g.key);
        if (!GROUP_KEYS.includes(key)) errors.push('catalog.groups 含未知来源组：' + (key || '(空)'));
      }
    }
  } else {
    warnings.push('catalog 缺少 groups 字段（面板将使用内置来源组）');
  }
  const seenIds = new Set();
  const seenUrls = new Set();
  const byGroup = Object.fromEntries(GROUP_KEYS.map((k) => [k, 0]));
  let featured = 0;
  let star = 0;
  let track = 0;
  /* 阶段枚举从 schema 取（唯一事实来源），避免本模块硬编码阶段顺序。 */
  const validStages = new Set(['all'].concat(schema.STAGE_KEYS));

  catalog.items.forEach((raw, i) => {
    const at = 'items[' + i + ']';
    if (!isObj(raw)) { errors.push(at + ' 不是对象'); return; }
    const id = str(raw.id);
    if (!id) errors.push(at + ' 缺少 id');
    else if (seenIds.has(id)) errors.push(at + ' id 重复：' + id);
    else seenIds.add(id);
    if (id && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) warnings.push(at + ' id 不是 kebab-case：' + id);
    const url = str(raw.url);
    if (!isHttpUrl(url)) errors.push(at + ' url 不是 http(s) 绝对地址：' + (url || '(空)'));
    else if (seenUrls.has(url)) errors.push(at + ' url 重复收录：' + url);
    else seenUrls.add(url);
    const group = str(raw.group);
    if (!GROUP_KEYS.includes(group)) errors.push(at + ' group 非法：' + (group || '(空)'));
    else byGroup[group] += 1;
    const kind = str(raw.kind);
    if (!KINDS.includes(kind)) errors.push(at + ' kind 非法：' + (kind || '(空)'));
    const authority = str(raw.authority);
    if (!AUTHORITIES.includes(authority)) errors.push(at + ' authority 非法：' + (authority || '(空)'));
    const stages = Array.isArray(raw.stages) ? raw.stages.map(str).filter(Boolean) : null;
    if (!stages || !stages.length) errors.push(at + ' stages 必须是非空数组');
    else {
      const bad = stages.filter((s) => !validStages.has(s));
      if (bad.length) errors.push(at + ' stages 含非法阶段：' + bad.join('、'));
    }
    if (raw.recommend !== undefined && !RECOMMENDS.includes(str(raw.recommend))) errors.push(at + ' recommend 非法：' + str(raw.recommend));
    if (raw.featured !== undefined && typeof raw.featured !== 'boolean') warnings.push(at + ' featured 不是布尔值（按 !!featured 处理）');
    if (raw.summary && str(raw.summary).length > SUMMARY_MAX) warnings.push(at + ' summary 超过 ' + SUMMARY_MAX + ' 字（当前 ' + str(raw.summary).length + '）');
    if (raw.why && str(raw.why).length > WHY_MAX) warnings.push(at + ' why 超过 ' + WHY_MAX + ' 字（当前 ' + str(raw.why).length + '）');
    if (raw.addedAt && !/^\d{4}-\d{2}-\d{2}$/.test(str(raw.addedAt))) warnings.push(at + ' addedAt 不是 YYYY-MM-DD：' + str(raw.addedAt));
    if (raw.group === 'opensource' && !str(raw.repo)) warnings.push(at + ' 开源条目缺少 repo（不参与指标刷新）');
    if (raw.recommend === 'star') star += 1;
    if (raw.featured === true) featured += 1;
    if (raw.repo && raw.track !== false) track += 1;
  });

  const stats = { total: catalog.items.length, byGroup, featured, star, track };
  return { ok: errors.length === 0, errors, warnings, stats };
}

/**
 * 只读加载并校验策展目录（带 mtime/size 进程内缓存）。
 * @param {{catalogPath?: string}} [opts]
 * @returns {{ok:boolean, catalog:object|null, path:string, code?:string, reason?:string, errors:string[], warnings:string[], stats?:object}}
 */
export function loadCatalog(opts = {}) {
  const file = catalogPathOf(opts || {});
  if (!existsSync(file)) {
    return { ok: false, catalog: null, path: file, code: 'UNAVAILABLE', reason: UNAVAILABLE_REASON, errors: [], warnings: [] };
  }
  let st;
  try { st = statSync(file); } catch (e) {
    return { ok: false, catalog: null, path: file, code: 'UNAVAILABLE', reason: '资料目录不可读：' + shortMsg(e), errors: [], warnings: [] };
  }
  const key = file + '|' + st.mtimeMs + '|' + st.size;
  const hit = catalogCache.get(key);
  if (hit) return hit;
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, catalog: null, path: file, code: 'UNAVAILABLE', reason: '资料目录不可读：' + shortMsg(e), errors: [], warnings: [] };
  }
  let catalog = null;
  try { catalog = JSON.parse(raw); } catch {
    return { ok: false, catalog: null, path: file, code: 'UNAVAILABLE', reason: '资料目录不是合法 JSON', errors: [], warnings: [] };
  }
  const v = validateCatalog(catalog);
  const result = {
    ok: v.ok,
    catalog: v.ok ? catalog : null,
    path: file,
    code: v.ok ? undefined : 'UNAVAILABLE',
    reason: v.ok ? undefined : '资料目录不合法：' + (v.errors[0] || '未知错误'),
    errors: v.errors,
    warnings: v.warnings,
    stats: v.stats,
  };
  if (v.ok) catalogCache.set(key, result);
  return result;
}

/* ============================ 缓存读写（spec §19.3） ============================ */

/** 缓存绝对路径：<root>/research/.fde/fde-library.json */
export function feedPath(root) {
  return join(String(root || ''), 'research', '.fde', 'fde-library.json');
}

/** 社区缓存绝对路径：<root>/research/.fde/scys-fde.json */
export function communityPath(root) {
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
    if (!isObj(obj)) return { feed: null, corrupt: true };
    if (!Array.isArray(obj.items)) obj.items = [];
    if (!Array.isArray(obj.featured)) obj.featured = [];
    if (!Array.isArray(obj.sources)) obj.sources = [];
    if (!Array.isArray(obj.warnings)) obj.warnings = [];
    if (!isObj(obj.stats)) obj.stats = {};
    obj.version = Number(obj.version) || LIBRARY_VERSION;
    return { feed: obj, corrupt: false };
  } catch {
    return { feed: null, corrupt: true };
  }
}

/** 原子写：先写同目录临时文件再 rename（spec §19.2）。 */
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

/* ============================ 条目归一化 / 映射 ============================ */

/** 本地日期差（YYYY-MM-DD → 相差天数；非法返回 NaN）。 */
function dateDiffDays(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(a));
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(b));
  if (!pa || !pb) return NaN;
  const ma = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
  const mb = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
  return Math.round((ma - mb) / 86400000);
}

/** 阶段覆盖数（"all" 视为覆盖全部阶段）。 */
function stageCoverage(stages) {
  const list = Array.isArray(stages) ? stages : [];
  if (list.includes('all')) return 99;
  return new Set(list.filter(Boolean)).size;
}

/** staticMeta 归一（策展快照）。 */
function staticMetaOf(raw) {
  const m = isObj(raw && raw.staticMeta) ? raw.staticMeta : {};
  return { stars: num(m.stars), forks: num(m.forks), license: str(m.license), language: str(m.language), pushedAt: str(m.pushedAt) };
}

/** 策展条目 → 缓存条目（保持目录顺序；只在内存中加工，不改 catalog）。 */
function normalizeCatalogItem(raw, prevItem) {
  const prevLive = isObj(prevItem && prevItem.liveMeta) ? prevItem.liveMeta : null;
  const recommend = RECOMMENDS.includes(str(raw.recommend)) ? str(raw.recommend) : 'backup';
  const st = staticMetaOf(raw);
  const base = Object.assign({}, prevLive ? { stars: num(prevLive.stars), forks: num(prevLive.forks), license: str(prevLive.license), language: str(prevLive.language), pushedAt: str(prevLive.pushedAt) } : st);
  return {
    id: str(raw.id),
    group: str(raw.group),
    kind: str(raw.kind),
    lang: str(raw.lang) || 'zh',
    title: str(raw.title),
    publisher: str(raw.publisher),
    url: sanitizeUrl(raw.url),
    authority: str(raw.authority),
    stages: Array.isArray(raw.stages) ? raw.stages.map(str).filter(Boolean) : ['all'],
    topics: Array.isArray(raw.topics) ? raw.topics.map(str).filter(Boolean) : [],
    summary: cleanText(raw.summary, SUMMARY_MAX),
    why: cleanText(raw.why, WHY_MAX),
    featured: raw.featured === true,
    featuredRank: (raw.featuredRank != null && Number.isFinite(Number(raw.featuredRank))) ? Number(raw.featuredRank) : null,
    recommend,
    addedAt: str(raw.addedAt),
    verifiedAt: str(raw.verifiedAt),
    httpStatus: Number.isFinite(Number(raw.httpStatus)) ? Number(raw.httpStatus) : null,
    note: str(raw.note),
    repo: str(raw.repo),
    track: raw.track !== false,
    staticMeta: base,
    liveMeta: prevLive ? { stars: num(prevLive.stars), forks: num(prevLive.forks), license: str(prevLive.license), language: str(prevLive.language), pushedAt: str(prevLive.pushedAt), fetchedAt: str(prevLive.fetchedAt) } : null,
    isNew: false,
    updated: false,
  };
}

/** 社区动态映射（spec §19.2：id/group/kind/authority/stages/summary/url/publishedAt/stats/tags）。 */
function mapCommunityItems(scysFeed) {
  const list = scysFeed && Array.isArray(scysFeed.items) ? scysFeed.items : [];
  const out = [];
  for (const x of list) {
    if (!isObj(x)) continue;
    const rawId = str(x.id);
    if (!rawId) continue;
    const author = cleanText(x.author, 100);
    const publishedAt = str(x.publishedAt);
    const tags = Array.isArray(x.tags) ? x.tags.map((t) => str(t)).filter(Boolean) : [];
    out.push({
      id: 'community:' + rawId,
      group: 'community',
      kind: 'post',
      lang: 'zh',
      title: cleanText(x.title, 300) || '（社区动态）',
      publisher: author || '生财有术社区',
      url: sanitizeUrl(x.url),
      authority: 'C',
      stages: ['all'],
      topics: tags.slice(0, 6),
      summary: cleanText(x.summary, COMMUNITY_SUMMARY_MAX),
      why: '社区动态（摘要，非全文）',
      featured: false,
      featuredRank: null,
      recommend: 'backup',
      addedAt: '',
      verifiedAt: scysFeed && str(scysFeed.date) ? str(scysFeed.date) : '',
      httpStatus: null,
      note: '社区摘要，非全文；原帖以链接为准',
      repo: '',
      track: false,
      staticMeta: { stars: 0, forks: 0, license: '', language: '', pushedAt: '' },
      liveMeta: null,
      isNew: false,
      updated: false,
      community: {
        author,
        authorAvatar: sanitizeUrl(x.authorAvatar),
        publishedAt,
        stats: isObj(x.stats) ? Object.assign({}, x.stats) : {},
        tags,
        kind: str(x.kind),
        isNew: x.isNew === true,
      },
    });
  }
  out.sort((a, b) => {
    const ta = Date.parse(String(a.community.publishedAt || ''));
    const tb = Date.parse(String(b.community.publishedAt || ''));
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  return out;
}

/* ============================ GitHub 指标刷新（spec §19.2） ============================ */

/** 取参与刷新的仓库列表（items[].repo && track，≤30，保持目录顺序）。 */
export function githubTargets(items) {
  return (items || []).filter((it) => it && it.repo && it.track !== false).slice(0, GITHUB_TRACK_MAX);
}

/** 并发受限的 map（保持结果顺序）。 */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function headersOf(res) {
  try { return res && res.headers && typeof res.headers.get === 'function' ? res.headers : null; } catch { return null; }
}

/** 单仓库指标请求：10s 超时（即使 fetchImpl 不响应 abort 也能超时返回）、不携带 token。 */
async function fetchGithubRepo(repo, { fetchImpl, timeoutMs }) {
  const path = repo.split('/').map((s) => encodeURIComponent(s)).join('/');
  const url = GITHUB_API + path;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { if (controller) controller.abort(); } catch { /* 忽略 */ }
      reject(new Error('GitHub 请求超时（' + Math.round(timeoutMs / 1000) + 's）'));
    }, Math.max(10, timeoutMs));
  });
  try {
    const req = {
      method: 'GET',
      headers: { 'user-agent': GITHUB_UA, accept: GITHUB_ACCEPT },
    };
    if (controller) req.signal = controller.signal;
    const res = await Promise.race([Promise.resolve(fetchImpl(url, req)), timeout]);
    if (!res || typeof res !== 'object') throw new Error('GitHub 无响应');
    const status = Number(res.status) || 0;
    const bodyText = typeof res.text === 'function' ? await res.text() : '';
    if (status && (status < 200 || status >= 300)) throw new Error('GitHub HTTP ' + status);
    let data = null;
    try { data = JSON.parse(bodyText); } catch { data = null; }
    if (!isObj(data)) throw new Error('GitHub 返回非 JSON 对象');
    const license = isObj(data.license) ? (str(data.license.spdx_id) || str(data.license.name)) : '';
    return {
      stars: num(data.stargazers_count),
      forks: num(data.forks_count),
      license,
      language: str(data.language),
      pushedAt: str(data.pushed_at),
      fetchedAt: store.nowIso(),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * GitHub 指标刷新：并发 ≤3、单请求 10s 超时、≤30 仓库、不带 token；
 * 单个失败不阻断整体（spec §19.2）。
 * @returns {Promise<{requested:number, okCount:number, errors:Array<{repo:string,error:string}>, byRepo:Map<string,object>}>}
 */
export async function refreshGithub(items, opts = {}) {
  const targets = githubTargets(items);
  const fetchImpl = typeof opts.fetchImpl === 'function'
    ? opts.fetchImpl
    : (typeof fetch === 'function' ? fetch : null);
  const timeoutMs = Number.isFinite(Number(opts.githubTimeoutMs)) ? Math.max(10, Number(opts.githubTimeoutMs)) : GITHUB_TIMEOUT_MS;
  const concurrency = Number.isFinite(Number(opts.githubConcurrency))
    ? Math.max(1, Math.min(GITHUB_CONCURRENCY, Number(opts.githubConcurrency)))
    : GITHUB_CONCURRENCY;
  const byRepo = new Map();
  const errors = [];
  if (!targets.length) return { requested: 0, okCount: 0, errors, byRepo };
  if (typeof fetchImpl !== 'function') {
    for (const it of targets) errors.push({ repo: it.repo, error: '当前运行环境不支持 fetch' });
    return { requested: targets.length, okCount: 0, errors, byRepo };
  }
  const results = await mapLimit(targets, concurrency, async (it) => {
    const repo = str(it.repo);
    try {
      const live = await fetchGithubRepo(repo, { fetchImpl, timeoutMs });
      byRepo.set(repo, live);
      return { repo, ok: true };
    } catch (e) {
      errors.push({ repo, error: shortMsg(e) });
      return { repo, ok: false, error: shortMsg(e) };
    }
  });
  const okCount = results.filter((r) => r && r.ok).length;
  return { requested: targets.length, okCount, errors, byRepo };
}

/* ============================ 社区动态读取（spec §19.2） ============================ */

/** 只读 scys-fde.json 缓存（缺失不报错，不重复调用 MCP）。 */
export function readCommunity(root) {
  let raw;
  try {
    raw = readFileSync(communityPath(root), 'utf8');
  } catch {
    return { ok: true, missing: true, items: [], date: '', error: null };
  }
  let obj = null;
  try { obj = JSON.parse(raw); } catch { obj = null; }
  if (!isObj(obj)) return { ok: false, missing: false, items: [], date: '', error: '社区动态缓存不是合法 JSON 对象' };
  return {
    ok: true,
    missing: false,
    items: mapCommunityItems(obj),
    date: str(obj.date),
    error: null,
  };
}

/* ============================ 重点推荐（spec §19.3） ============================ */

/** 重点推荐排序：recommend=star → featuredRank（人工策展位）→ featured → 权威性 A/B/C → addedAt → 阶段覆盖数 → stars。 */
const AUTHORITY_RANK = Object.freeze({ A: 0, B: 1, C: 2 });
function featuredCompare(a, b) {
  const sa = a.recommend === 'star' ? 0 : 1;
  const sb = b.recommend === 'star' ? 0 : 1;
  if (sa !== sb) return sa - sb;
  const ra = (a.featuredRank != null && Number.isFinite(Number(a.featuredRank))) ? Number(a.featuredRank) : Infinity;
  const rb = (b.featuredRank != null && Number.isFinite(Number(b.featuredRank))) ? Number(b.featuredRank) : Infinity;
  if (ra !== rb) return ra - rb;
  const fa = a.featured ? 0 : 1;
  const fb = b.featured ? 0 : 1;
  if (fa !== fb) return fa - fb;
  const aa = AUTHORITY_RANK[a.authority] ?? 3;
  const ab = AUTHORITY_RANK[b.authority] ?? 3;
  if (aa !== ab) return aa - ab;
  const da = Date.parse(str(a.addedAt) + 'T00:00:00Z');
  const db = Date.parse(str(b.addedAt) + 'T00:00:00Z');
  const va = Number.isFinite(da) ? da : 0;
  const vb = Number.isFinite(db) ? db : 0;
  if (va !== vb) return vb - va;
  const ca = stageCoverage(a.stages);
  const cb = stageCoverage(b.stages);
  if (ca !== cb) return cb - ca;
  const sta = Number(a.liveMeta && a.liveMeta.stars) || Number(a.staticMeta && a.staticMeta.stars) || 0;
  const stb = Number(b.liveMeta && b.liveMeta.stars) || Number(b.staticMeta && b.staticMeta.stars) || 0;
  if (sta !== stb) return stb - sta;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * 选重点推荐：先按排序取 top，再保证「同一来源组至少 1 条」，总 ≤12。
 * @returns {string[]} 排序后的 id 列表
 */
export function pickFeatured(items, max = FEATURED_MAX) {
  const list = (items || []).slice().sort(featuredCompare);
  if (!list.length) return [];
  const cap = Math.max(1, Math.min(FEATURED_MAX, Number(max) || FEATURED_MAX));
  const chosen = [];
  const seenGroups = new Set();
  for (const it of list) {
    if (seenGroups.has(it.group)) continue;
    seenGroups.add(it.group);
    chosen.push(it);
  }
  const chosenIds = new Set(chosen.map((x) => x.id));
  for (const it of list) {
    if (chosen.length >= cap) break;
    if (chosenIds.has(it.id)) continue;
    chosen.push(it);
    chosenIds.add(it.id);
  }
  return chosen.slice(0, cap).sort(featuredCompare).map((x) => x.id);
}

/* ============================ 统计 / 视图 ============================ */

const GROUP_STAT_KEY = Object.freeze({
  'intl-official': 'intlOfficial',
  'cn-official': 'cnOfficial',
  opensource: 'opensource',
  method: 'method',
  community: 'community',
});

function buildStats(items, featured) {
  const stats = { total: 0, intlOfficial: 0, cnOfficial: 0, opensource: 0, method: 0, community: 0, featured: 0, new: 0, updated: 0 };
  for (const it of items || []) {
    stats.total += 1;
    const key = GROUP_STAT_KEY[it.group];
    if (key) stats[key] += 1;
    if (it.isNew) stats.new += 1;
    if (it.updated) stats.updated += 1;
  }
  stats.featured = (featured || []).length;
  return stats;
}

const catalogInfo = (cat) => (cat && cat.catalog
  ? { version: Number(cat.catalog.version) || 1, updatedAt: str(cat.catalog.updatedAt) }
  : null);

/**
 * 只读当前状态（不联网）：GET /library/feed 与工具 feed 共用。
 * catalog 缺失/不合法 → ok:false + code:UNAVAILABLE（同时带旧 feed，spec §19.4）。
 */
export function status(root, opts = {}) {
  const today = store.localDateStr();
  const refreshing = !!state.inflight;
  const cat = loadCatalog(opts || {});
  const { feed, corrupt } = readFeed(root);
  const stale = !feed || feed.date !== today;
  const warnings = (cat.warnings || []).slice();
  if (corrupt) warnings.push('资料库缓存 JSON 损坏，已按空缓存处理');
  if (!cat.ok) {
    return {
      ok: false,
      code: cat.code || 'UNAVAILABLE',
      reason: cat.reason || UNAVAILABLE_REASON,
      feed: feed || null,
      today,
      stale,
      refreshing,
      catalog: null,
      warnings,
    };
  }
  const info = catalogInfo(cat);
  if (!feed) return { ok: true, feed: null, today, stale: true, refreshing, catalog: info, warnings };
  if (feed.ok === false) {
    return {
      ok: false,
      code: feed.lastCode || 'UNAVAILABLE',
      reason: feed.lastError || '上次刷新失败',
      feed,
      today,
      stale,
      refreshing,
      catalog: info,
      warnings,
    };
  }
  return { ok: true, feed, today, stale, refreshing, catalog: info, warnings };
}

/* ============================ 刷新（spec §19.2 / §19.4） ============================ */

const failureView = (today, { code, reason, feed, catalog, warnings }) => ({
  ok: false,
  code,
  reason,
  feed: feed || null,
  today,
  stale: !feed || feed.date !== today,
  refreshing: false,
  catalog: catalog || null,
  warnings: warnings || [],
});

function annotateDiff(items, prevFeed, today) {
  const hasPrev = !!(prevFeed && Array.isArray(prevFeed.items));
  const prevIds = new Set(hasPrev ? prevFeed.items.map((x) => (x && x.id) || '').filter(Boolean) : []);
  return items.map((it) => {
    if (it.group === 'community') {
      const scysNew = !!(it.community && it.community.isNew);
      it.isNew = scysNew || !hasPrev || !prevIds.has(it.id);
      it.updated = false;
      return it;
    }
    const diff = dateDiffDays(today, it.addedAt);
    const addedRecent = Number.isFinite(diff) && diff >= 0 && diff <= NEW_DAYS;
    it.isNew = addedRecent || !hasPrev || !prevIds.has(it.id);
    it.updated = false;
    const prevItem = hasPrev ? prevFeed.items.find((x) => x && x.id === it.id) : null;
    const prevLive = isObj(prevItem && prevItem.liveMeta) ? prevItem.liveMeta : null;
    if (prevLive && it.liveMeta) {
      it.updated = ['stars', 'forks', 'license', 'language', 'pushedAt'].some((k) => String(prevLive[k] ?? '') !== String(it.liveMeta[k] ?? ''));
    }
    return it;
  });
}

async function doRefresh(root, opts = {}) {
  const startedAt = Date.now();
  const today = store.localDateStr(startedAt);
  const prev = readFeed(root).feed;

  /* 1) 策展目录：缺失/不合法 → UNAVAILABLE，保留旧 feed（spec §19.4） */
  const cat = loadCatalog(opts || {});
  if (!cat.ok) {
    recordFailure(today);
    return failureView(today, { code: cat.code || 'UNAVAILABLE', reason: cat.reason || UNAVAILABLE_REASON, feed: prev, catalog: null, warnings: cat.warnings });
  }

  const prevById = new Map(((prev && Array.isArray(prev.items)) ? prev.items : []).map((x) => [x && x.id, x]));
  const catalogItems = (cat.catalog.items || []).map((raw) => normalizeCatalogItem(raw, prevById.get(str(raw && raw.id))));

  /* 2) GitHub 指标（失败不阻断，保留旧值） */
  const github = await refreshGithub(catalogItems, opts || {});
  for (const it of catalogItems) {
    if (!it.repo || it.track === false) continue;
    const live = github.byRepo.get(it.repo);
    if (live) {
      it.liveMeta = live;
      it.staticMeta = { stars: live.stars, forks: live.forks, license: live.license, language: live.language, pushedAt: live.pushedAt };
    }
  }

  /* 3) 社区动态（只读缓存，缺失不报错） */
  const community = readCommunity(root);
  const communityItems = community.items || [];

  /* 4) isNew / updated 差分 + 重点推荐 */
  const items = annotateDiff(catalogItems.concat(communityItems), prev, today);
  const featured = pickFeatured(items);
  const stats = buildStats(items, featured);
  const warnings = (cat.warnings || []).slice();
  if (cat.errors && cat.errors.length) warnings.push('资料目录校验告警：' + cat.errors.slice(0, 3).join('；'));
  if (github.errors.length) {
    warnings.push('GitHub 指标未更新：' + github.errors.length + '/' + github.requested + ' 个仓库失败（保留旧值）');
  }
  if (!community.ok) warnings.push('社区动态缓存不可读（scys-fde.json），本次社区来源为空');
  else if (community.missing) warnings.push('暂无社区动态缓存（scys-fde.json 缺失），社区来源为空');
  const feed = {
    version: LIBRARY_VERSION,
    date: today,
    fetchedAt: store.nowIso(),
    ok: true,
    lastError: null,
    catalogVersion: Number(cat.catalog.version) || 1,
    catalogUpdatedAt: str(cat.catalog.updatedAt),
    stats,
    sources: [
      { key: 'catalog', ok: true, items: catalogItems.length, error: null },
      { key: 'github', ok: github.errors.length === 0, requested: github.requested, okCount: github.okCount, errors: github.errors.map((e) => ({ repo: e.repo, error: e.error })) },
      { key: 'community', ok: community.ok, items: communityItems.length, date: community.date || '', error: community.error },
    ],
    warnings,
    items,
    featured,
  };

  try {
    writeFeed(root, feed);
  } catch (e) {
    recordFailure(today);
    return failureView(today, { code: 'INTERNAL', reason: '写入资料库缓存失败：' + shortMsg(e), feed: prev, catalog: catalogInfo(cat), warnings });
  }
  recordSuccess(today);
  return { ok: true, feed, today, stale: false, refreshing: false, catalog: catalogInfo(cat), warnings };
}

/**
 * 强制执行一次刷新（不做「每天一次」门控；单飞：并发调用共享同一次 flight）。
 * @param {string} root 工作区根
 * @param {{fetchImpl?:Function, catalogPath?:string, githubTimeoutMs?:number, githubConcurrency?:number, force?:boolean}} [opts]
 */
export function refresh(root, opts = {}) {
  if (state.inflight) return state.inflight;
  state.inflight = doRefresh(root, opts || {}).finally(() => { state.inflight = null; });
  return state.inflight;
}

/**
 * 按「每天一次」门控刷新：缓存缺失 / 日期不是今天 / force 才刷；
 * 失败当天最多重试 DAILY_FAIL_LIMIT 次（force 不受限，供面板/工具手动刷新）。
 */
export async function maybeRefresh(root, opts = {}) {
  const today = store.localDateStr();
  if (state.inflight) return Object.assign(status(root, opts), { skipped: true });
  const { feed } = readFeed(root);
  if (feed && feed.date === today && !opts.force) return Object.assign(status(root, opts), { skipped: true });
  if (!opts.force && failedToday(today) >= DAILY_FAIL_LIMIT) {
    return Object.assign(status(root, opts), {
      ok: false,
      code: 'RETRY_LIMIT',
      reason: '今日资料库刷新失败已达 ' + DAILY_FAIL_LIMIT + ' 次，明日再试',
      skipped: true,
    });
  }
  return refresh(root, opts);
}

/* ============================ 工具 / 面板共用视图（spec §19.5） ============================ */

/**
 * 紧凑条目（工具 fde_library / 面板共用口径；只读缓存，不联网）。
 * @param {object} statusResult status()/refresh() 的返回
 * @param {{limit?:number, group?:string, kind?:string, stage?:string, q?:string, featured?:boolean}} [opts]
 */
export function compactFeed(statusResult, opts = {}) {
  const feed = statusResult && statusResult.feed;
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 20));
  const group = GROUP_KEYS.includes(str(opts.group)) ? str(opts.group) : '';
  const kind = KINDS.includes(str(opts.kind)) ? str(opts.kind) : '';
  const stage = str(opts.stage);
  const q = str(opts.q).toLowerCase();
  const onlyFeatured = opts.featured === true;
  const all = (feed && Array.isArray(feed.items)) ? feed.items : [];
  let items = all.slice();
  if (onlyFeatured) {
    const order = new Map(((feed && feed.featured) || []).map((id, i) => [id, i]));
    items = items.filter((it) => order.has(it.id));
    items.sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0));
  }
  if (group) items = items.filter((it) => it.group === group);
  if (kind) items = items.filter((it) => it.kind === kind);
  if (stage && stage !== 'all') items = items.filter((it) => Array.isArray(it.stages) && (it.stages.includes('all') || it.stages.includes(stage)));
  if (q) {
    items = items.filter((it) => [it.title, it.summary, it.why, it.publisher, it.id, (it.topics || []).join(' '), it.community && it.community.author]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }
  return {
    feed,
    items: items.slice(0, limit),
    matched: items.length,
    total: all.length,
    limit,
    group,
    kind,
    stage,
    q: str(opts.q),
    featured: onlyFeatured,
    featuredIds: (feed && Array.isArray(feed.featured)) ? feed.featured.slice() : [],
  };
}
