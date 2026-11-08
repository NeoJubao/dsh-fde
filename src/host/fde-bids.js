/**
 * FDE 工作站 · 招采雷达客户关联层（spec §17）
 *
 * 定位：FDE 只做「与客户关联」这一层——查询词生成、关系分类、匹配缓存、
 * 关联（links）与提升为跟进任务（promote）、招采信号（规则在 fde-rules.js）。
 * **不重写检索/批次/报告语义**：数据一律来自 bid-intel 的只读 host 服务 `bidIntel`
 * （version=1；深挖仍用 bid_* 工具）。
 *
 * 本模块只做纯逻辑 + 服务调用；board 的读改写事务在 fde-api.js（runAction/CAS），
 * 避免 fde-api ↔ fde-bids 循环依赖。零新依赖，不 import @deepseek-ai/*。
 */
import * as schema from './fde-schema.js';
import * as store from './fde-store.js';

export const BID_SERVICE_VERSION = 1;
export const MATCH_TTL_MS = schema.BID_CACHE_TTL_MS;
/** 板面/看板摘要用的查询上限（控成本；完整匹配用于 /bids/match）。 */
export const SUMMARY_QUERY_LIMIT = 3;
export const MAX_QUERIES = 8;
export const MATCH_ITEM_LIMIT = 50;
export const SIGNAL_ITEM_LIMIT = 3;
export const SIGNAL_DISMISS_DAYS = 30;
export const LINK_RELATIONS = ['buyer', 'winner', 'candidate', 'mention', 'tender'];
export const TENDER_KIND_RE = /招标|采购|询价|竞争性谈判|竞争性磋商|竞争性|谈判|比选|竞价/;
export const AWARD_KIND_RE = /中标|成交|结果公告|结果公示/;

/* ============================ 服务获取（懒） ============================ */

let injectedService = null;
let serviceResolver = null;

/** 注入服务（测试 / 宿主显式装配）。传 null 清空。 */
export function setBidService(service) { injectedService = service || null; }
/** 注入解析器（index.js 用它把 ctx.get('bidIntel') 懒解析进来，避免插件加载顺序问题）。 */
export function setBidServiceResolver(fn) { serviceResolver = typeof fn === 'function' ? fn : null; }

/** 服务是否可用：存在、version===1、有 search/dataMeta。 */
export function isAvailable(service) {
  return !!(service && Number(service.version) === BID_SERVICE_VERSION &&
    typeof service.search === 'function' && typeof service.dataMeta === 'function');
}

/** 当前服务：注入的优先，其次解析器（每次调用都懒解析，兼容插件加载顺序）。 */
export function currentBidService() {
  if (injectedService) return isAvailable(injectedService) ? injectedService : null;
  if (serviceResolver) {
    try {
      const s = serviceResolver();
      return isAvailable(s) ? s : null;
    } catch { return null; }
  }
  return null;
}

/** 从插件 ctx 懒取 bidIntel 服务（version!==1 或不可用 → null）。 */
export function resolveBidService(ctx) {
  try {
    const s = ctx && typeof ctx.get === 'function' ? ctx.get('bidIntel') : (ctx ? ctx.bidIntel : undefined);
    return isAvailable(s) ? s : null;
  } catch { return null; }
}

/* ============================ 缓存 ============================ */

const matchCache = new Map();     // engagement 级匹配缓存
const queryCache = new Map();     // 单查询词检索缓存（跨客户复用）

export function clearBidCache(engagementId) {
  if (engagementId) {
    const id = String(engagementId);
    for (const k of [...matchCache.keys()]) if (k.startsWith(id + '|')) matchCache.delete(k);
    queryCache.clear();
  } else {
    matchCache.clear();
    queryCache.clear();
  }
}
export function bidCacheStats() { return { matches: matchCache.size, queries: queryCache.size, ttlMs: MATCH_TTL_MS }; }

function metaSig(service) {
  try {
    const m = service.dataMeta ? service.dataMeta() : null;
    return m ? `${Number(m.mtime) || 0}:${Number(m.records) || 0}` : '';
  } catch { return ''; }
}

function cachedQuery(service, args, ttlMs, sig, bypass = false) {
  const key = `${args.mode}|${args.q}|${args.limit}|${args.from || ''}|${args.to || ''}|${args.source || ''}|${sig}`;
  const now = Date.now();
  const hit = queryCache.get(key);
  if (!bypass && hit && now - hit.at < ttlMs) return hit.value;
  let value = null;
  try { value = service.search(args); } catch { value = null; }
  queryCache.set(key, { at: now, value });
  return value;
}

/* ============================ 文本与查询词（spec §17.3） ============================ */

/** 与 bid-intel store.normalize 同口径（检索语义不另起一套）。 */
export function normalizeText(v) {
  return String(v || '')
    .replace(/\s+/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .toLowerCase();
}

const COMPANY_MARKERS = ['股份有限公司', '有限责任公司', '有限公司', '集团有限公司', '集团', '研究院', '研究所', '设计院', '学院', '大学', '公司', '中心', '委员会', '医院', '电厂', '工厂', '厂', '局'];
const UNIT_TAILS_RE = /(体系部|全所汇总|项目组|事业部|分公司|办事处|办公室|工作专班|专班|研发部|技术部|市场部|总体部|中心|部)$/;
const NOISE_ONLY = new Set(['中国', '集团', '公司', '研究院', '研究所', '学院', '大学', '中心', '部', '所', '院', '有限', '股份']);

/** 去掉目录名里的年份后缀（-20261013 / _20261013 / 2026-10-13）。 */
export function stripYear(s) {
  return String(s || '')
    .replace(/[-_－·]?\d{8}$/, '')
    .replace(/[-_－·]?\d{6}$/, '')
    .replace(/[-_－·]?(19|20)\d{2}[-_－]?(0[1-9]|1[0-2])$/,'')
    .trim();
}

/** 去掉括号及括号后内容（如「…研究院（某所）体系部」→「…研究院」）。 */
export function stripParens(s) {
  const t = String(s || '');
  const i = t.search(/[（(]/);
  const head = i >= 0 ? t.slice(0, i) : t;
  return head.replace(/[｜|].*$/, '').trim();
}

/** 提取括号内 token（如「某所」「某集团（代号）」→ 多个 token）。 */
export function parenTokens(s) {
  const out = [];
  const t = String(s || '');
  const re = /[（(]([^）)]+)[）)]/g;
  let m;
  while ((m = re.exec(t))) {
    for (const piece of m[1].split(/[｜|,，、;；/\s]+/)) {
      const v = piece.trim();
      if (v) out.push(v);
    }
  }
  return out;
}

/** 短核心：去年份→去括号→去单位/项目尾缀（可叠 3 次）。 */
export function shortCore(s) {
  let t = stripYear(stripParens(s));
  for (let i = 0; i < 3; i += 1) {
    const next = t.replace(UNIT_TAILS_RE, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/** 从客户名/档案标题推断工商名（仅当含「有限公司/集团/研究院/研究所/学院/大学」等标记）。 */
export function inferCompany(name) {
  const clean = stripYear(stripParens(name));
  if (!clean) return '';
  let end = -1;
  for (const marker of COMPANY_MARKERS) {
    const i = clean.indexOf(marker);
    if (i >= 0) {
      const e = i + marker.length;
      if (e > end) end = e;
    }
  }
  if (end <= 0) return '';
  const out = clean.slice(0, end).trim();
  return out.length >= 4 ? out : '';
}

/** 去噪：长度≥2；去掉公司后缀后仍需≥2；纯噪音词丢弃。 */
function acceptQuery(raw) {
  const q = String(raw || '').replace(/\s+/g, ' ').trim();
  if (q.length < 2) return false;
  if (NOISE_ONLY.has(q)) return false;
  let core = q;
  for (const marker of ['股份有限公司', '有限责任公司', '有限公司', '集团有限公司', '集团', '研究院', '研究所', '设计院', '学院', '大学', '公司']) {
    core = core.replace(marker, '');
  }
  return core.trim().length >= 2;
}

/**
 * 生成客户查询词（顺序即优先级，去重后 ≤MAX_QUERIES）：
 * ① company（空则从 name 回填）② name 完整 ③ name 去括号 ④ 括号内 token
 * ⑤ shortName ⑥ dir 去年份/括号 ⑦ 短核心 ⑧ bidWatch.keywords
 */
export function queriesFor(engagement, opts = {}) {
  const e = engagement || {};
  const watch = (e.bidWatch && typeof e.bidWatch === 'object') ? e.bidWatch : {};
  const raw = [];
  const push = (v) => { if (v != null && String(v).trim()) raw.push(v); };

  const company = String(e.company || '').trim() || inferCompany(e.name) || inferCompany(e.dir);
  const dirBase = stripYear(stripParens(e.dir));
  const dirCore = shortCore(e.dir);
  const nameCore = stripYear(stripParens(e.name));
  const nameShort = shortCore(e.name);
  /* 顺序 = 有用度优先（board 摘要只取前 3 个）：实体核心 → 括号 token → 简称/目录；
   * 括号内 token 必须靠前（如「某所」这类短名只能靠它命中）。原始 name（含年份/单位尾缀）放最后兜底。 */
  push(company);
  push(nameCore);
  for (const t of parenTokens(e.name)) push(t);
  push(e.shortName);
  push(dirBase);
  for (const t of parenTokens(e.dir)) push(t);
  if (nameShort !== nameCore) push(nameShort);
  if (dirCore && dirCore !== dirBase) push(dirCore);
  for (const k of (Array.isArray(watch.keywords) ? watch.keywords : [])) push(k);
  push(stripYear(e.name));

  const limit = Math.max(1, Math.min(MAX_QUERIES, Number(opts.maxQueries) || MAX_QUERIES));
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!acceptQuery(item)) continue;
    const key = normalizeText(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(item).trim());
    if (out.length >= limit) break;
  }
  return out;
}

/* ============================ 分类（spec §17.3） ============================ */

/** 关系分类：buyer → winner → candidate → mention（候选人 ≠ 中标人）。 */
export function relationOf(record, queries) {
  const list = (queries || []).map(normalizeText).filter(Boolean);
  if (!record || !list.length) return { relation: 'mention', matchedBy: '' };
  const buyer = normalizeText(record.buyer);
  const winner = normalizeText(record.winner);
  const candNames = (record.candidates || []).map((c) => normalizeText(c && c.name != null ? c.name : c));
  const hay = normalizeText([
    record.title, record.buyer, record.winner, record.project_no,
    (record.candidates || []).map((c) => (c && c.name) || '').join(' '), record.excerpt,
  ].join(' '));
  for (const q of list) if (buyer.includes(q)) return { relation: 'buyer', matchedBy: q };
  for (const q of list) if (winner.includes(q)) return { relation: 'winner', matchedBy: q };
  for (const q of list) if (candNames.some((c) => c.includes(q))) return { relation: 'candidate', matchedBy: q };
  for (const q of list) if (hay.includes(q)) return { relation: 'mention', matchedBy: q };
  return { relation: 'mention', matchedBy: '' };
}

/** 招标类公告：kind 含招标/采购/询价/竞争性谈判等。 */
export function isTenderKind(kind) { return TENDER_KIND_RE.test(String(kind || '')); }
/** 中标/成交/结果类公告；**候选人公示不算中标**（spec 口径铁律）。 */
export function isAwardKind(kind) {
  const k = String(kind || '');
  if (/候选人/.test(k)) return false;
  return AWARD_KIND_RE.test(k);
}

/**
 * 分类单条公告（relation + tender/award 标记）。
 * @returns {{relation:string, matchedBy:string, tender:boolean, award:boolean}}
 */
export function classifyRecord(record, queries) {
  const rel = relationOf(record, queries);
  return {
    relation: rel.relation,
    matchedBy: rel.matchedBy,
    tender: isTenderKind(record && record.kind),
    award: isAwardKind(record && record.kind),
  };
}

/** 记录 → 紧凑条目（金额只保留原文数组，不求和；候选人与中标人分列）。 */
export function normalizeItem(record, queries, opts = {}) {
  const rec = record || {};
  const cls = queries && queries.length ? classifyRecord(rec, queries) : null;
  const item = {
    id: String(rec.id || ''),
    source: String(rec.source || ''),
    channel: String(rec.channel || ''),
    kind: String(rec.kind || ''),
    url: String(rec.url || ''),
    date: String(rec.date || ''),
    title: String(rec.title || ''),
    project_no: String(rec.project_no || ''),
    buyer: String(rec.buyer || ''),
    winner: String(rec.winner || ''),
    candidates: Array.isArray(rec.candidates) ? rec.candidates : [],
    amounts: Array.isArray(rec.amounts) ? rec.amounts.slice(0, 10) : [],
    excerpt: String(rec.excerpt || '').slice(0, 240),
    tender: isTenderKind(rec.kind),
    award: isAwardKind(rec.kind),
    match: String(rec.match || ''),
  };
  if (cls) {
    item.relation = cls.relation;
    item.matchedBy = cls.matchedBy;
  }
  if (opts.withExcerpt === false) delete item.excerpt;
  return item;
}

/* ============================ 匹配（spec §17.3） ============================ */

/**
 * 客户视角匹配招采公告。
 * @param {object} service bidIntel 服务（可空）
 * @param {object} engagement
 * @param {{queries?:string[], maxQueries?:number, perQueryLimit?:number, limit?:number,
 *          ttlMs?:number, refresh?:boolean, meta?:object}} [opts]
 * @returns {{available:boolean, total:number, tender:number, award:number, candidate:number,
 *            latest:string, queries:string[], queryHits:object[], items:object[], sample:object[]}}
 */
export function matchEngagement(service, engagement, opts = {}) {
  const unavailable = {
    available: false, total: 0, approxTotal: 0, tender: 0, award: 0, candidate: 0, latest: '',
    queries: [], queryHits: [], items: [], sample: [], reason: '招采雷达未就绪（bid-intel 未装载或未升级）',
  };
  if (!isAvailable(service)) return unavailable;
  const e = engagement || {};
  const ttlMs = Number(opts.ttlMs) >= 0 ? Number(opts.ttlMs) : MATCH_TTL_MS;
  const meta = opts.meta || safeDataMeta(service);
  const queries = Array.isArray(opts.queries)
    ? opts.queries.slice(0, MAX_QUERIES)
    : queriesFor(e, { maxQueries: opts.maxQueries });
  const limit = clamp(Number(opts.limit) || MATCH_ITEM_LIMIT, 1, MATCH_ITEM_LIMIT);
  const perQueryLimit = clamp(Number(opts.perQueryLimit) || MATCH_ITEM_LIMIT, 1, MATCH_ITEM_LIMIT);
  if (!queries.length) {
    return {
      available: true, total: 0, approxTotal: 0, tender: 0, award: 0, candidate: 0, latest: '',
      queries: [], queryHits: [], items: [], sample: [], dataMeta: meta,
      reason: '客户缺少可用查询词（补 company/shortName 或 bidWatch.keywords）',
    };
  }
  const sig = `${Number(meta && meta.mtime) || 0}:${Number(meta && meta.records) || 0}`;
  /* engagement 级缓存键：engagement + 查询词 + 条数（TTL 决定新鲜度；数据更新靠 refresh 或 TTL 到期后的
   * 单查询缓存 mtime 签名生效）。验收口径要求「TTL 内未 refresh 仍命中」，故不把 mtime 放进本键。 */
  const cacheKey = [String(e.id || ''), queries.map(normalizeText).join('\u0001'), perQueryLimit, limit].join('|');
  const now = Date.now();
  const hit = matchCache.get(cacheKey);
  if (!opts.refresh && hit && now - hit.at < ttlMs) {
    return Object.assign({}, hit.value, { cached: true, cachedAt: new Date(hit.at).toISOString() });
  }

  const byId = new Map();
  const queryHits = [];
  for (const q of queries) {
    for (const mode of ['buyer', 'company']) {
      const r = cachedQuery(service, { mode, q, from: opts.from || '', to: opts.to || '', source: opts.source || '', limit: perQueryLimit }, ttlMs, sig, !!opts.refresh);
      if (!r) continue;
      queryHits.push({ q, mode, total: Number(r.total) || 0 });
      for (const rec of r.items || []) {
        if (rec && rec.id && !byId.has(rec.id)) byId.set(rec.id, rec);
      }
    }
  }
  const all = [...byId.values()]
    .map((rec) => normalizeItem(rec, queries))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const tender = all.filter((x) => x.tender).length;
  const award = all.filter((x) => x.award).length;
  const candidate = all.filter((x) => x.relation === 'candidate').length;
  const latest = all.reduce((max, x) => (x.date && x.date > max ? x.date : max), '');
  /* approxTotal：各查询词（buyer/company 两种模式）search.total 的最大值，代表该客户的真实量级；
   * total 是采样去重后的条数（items 还受 limit 截断）——两者不可混淆。 */
  const approxTotal = queryHits.reduce((max, h) => (Number(h.total) > max ? Number(h.total) : max), 0);
  const value = {
    available: true,
    total: all.length,
    approxTotal,
    tender,
    award,
    candidate,
    latest,
    queries,
    queryHits,
    items: all.slice(0, limit),
    sample: all.slice(0, 3).map((x) => ({ id: x.id, title: x.title, date: x.date, relation: x.relation, buyer: x.buyer })),
    dataMeta: meta,
    generatedAt: store.nowIso(),
  };
  matchCache.set(cacheKey, { at: now, value });
  return Object.assign({}, value, { cached: false });
}

function safeDataMeta(service) {
  try { return service.dataMeta ? service.dataMeta() : null; } catch { return null; }
}
function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** 看板/简报用的摘要（不含大字段；matches ≤5）。 */
export function summarizeMatch(match, opts = {}) {
  const m = match || {};
  if (!m.available) {
    return { available: false, total: 0, approxTotal: 0, tender: 0, award: 0, candidate: 0, latest: '', queries: [], matches: [], reason: m.reason || '招采雷达未就绪' };
  }
  const totalNum = Number(m.total) || 0;
  const approxNum = Math.max(Number(m.approxTotal) || 0, totalNum);
  return {
    available: true,
    total: totalNum,
    approxTotal: approxNum,
    tender: Number(m.tender) || 0,
    award: Number(m.award) || 0,
    candidate: Number(m.candidate) || 0,
    latest: m.latest || '',
    queries: Array.isArray(m.queries) ? m.queries.slice(0, MAX_QUERIES) : [],
    matches: (m.items || []).slice(0, clamp(Number(opts.limit) || 5, 1, 5)).map((x) => ({
      id: x.id, title: x.title, date: x.date, kind: x.kind, relation: x.relation,
      buyer: x.buyer, winner: x.winner, tender: x.tender, award: x.award, url: x.url,
    })),
  };
}

/** 全局招采概况（§17.2 bidStats）。 */
export function bidStatsOf(service) {
  if (!isAvailable(service)) {
    return { available: false, records: 0, dateRange: ['', ''], engagedCount: 0, reason: '招采雷达未就绪（bid-intel 未装载或未升级）' };
  }
  let stats = null;
  let meta = null;
  try { stats = service.stats ? service.stats() : null; } catch { stats = null; }
  try { meta = service.dataMeta ? service.dataMeta() : null; } catch { meta = null; }
  return {
    available: true,
    records: Number(stats && stats.records) || 0,
    dateRange: (stats && Array.isArray(stats.dateRange)) ? stats.dateRange : ['', ''],
    sources: (stats && Array.isArray(stats.sources)) ? stats.sources : [],
    missing: !!(stats && stats.missing),
    dataMeta: meta,
    engagedCount: 0,
  };
}

/* ============================ 检索（透传，不新增语义） ============================ */

/**
 * 招采检索（透传 bid-intel search；给 engagement 时逐项附关系分类）。
 * @param {object} service
 * @param {{q?:string, mode?:string, from?:string, to?:string, source?:string, limit?:number,
 *          offset?:number, engagement?:object}} [opts]
 */
export function searchBids(service, opts = {}) {
  if (!isAvailable(service)) {
    return { available: false, total: 0, direct: 0, mentioned: 0, items: [], facets: null, reason: '招采雷达未就绪（bid-intel 未装载或未升级）' };
  }
  const args = {
    mode: opts.mode || 'any',
    q: String(opts.q || '').trim(),
    from: String(opts.from || ''),
    to: String(opts.to || ''),
    source: String(opts.source || ''),
    limit: clamp(Number(opts.limit) || 20, 1, MATCH_ITEM_LIMIT),
    offset: Math.max(0, Number(opts.offset) || 0),
  };
  let r = null;
  try { r = service.search(args); } catch (e) {
    return { available: false, total: 0, direct: 0, mentioned: 0, items: [], facets: null, reason: '招采检索失败：' + String((e && e.message) || e) };
  }
  const queries = opts.engagement ? queriesFor(opts.engagement) : [];
  const items = (r.items || []).map((rec) => normalizeItem(rec, queries.length ? queries : null));
  return {
    available: true,
    total: Number(r.total) || 0,
    direct: Number(r.direct) || 0,
    mentioned: Number(r.mentioned) || 0,
    offset: args.offset,
    limit: args.limit,
    mode: args.mode,
    q: args.q,
    items,
    facets: r.facets || null,
    relation: opts.engagement ? relationHint(items) : undefined,
  };
}

function relationHint(items) {
  const out = {};
  for (const it of items || []) if (it.relation) out[it.relation] = (out[it.relation] || 0) + 1;
  return out;
}

/** 按 id 取单条公告：getRecord/getById → 匹配缓存 → 服务全量检索兜底（旧版服务无 getRecord 时）。 */
export function recordById(service, bidId) {
  const id = String(bidId || '');
  if (!id) return null;
  if (isAvailable(service)) {
    try {
      if (typeof service.getRecord === 'function') {
        const r = service.getRecord(id);
        if (r) return r;
      }
      if (typeof service.getById === 'function') {
        const r = service.getById(id);
        if (r) return r;
      }
    } catch { /* 落缓存回退 */ }
  }
  for (const entry of matchCache.values()) {
    const found = (entry.value && entry.value.items || []).find((x) => x.id === id);
    if (found) return found;
  }
  if (isAvailable(service)) {
    try {
      const all = service.search({ mode: 'any', q: '', limit: 2000 });
      const hit = (all.items || []).find((x) => x && x.id === id);
      if (hit) return hit;
    } catch { /* 忽略 */ }
  }
  return null;
}

/** 客户已关联公告（持久化在 engagement.bidWatch.links）。 */
export function linksOf(engagement) {
  const watch = engagement && engagement.bidWatch;
  return watch && Array.isArray(watch.links) ? watch.links : [];
}

/* ============================ 关联 / 取消关联 / 提升为任务 ============================ */

/** 统一关系值（允许 tender 作为关联标签；未知关系回退 mention）。 */
export function normalizeRelation(rel, fallback = 'mention') {
  const v = String(rel || '');
  if (!v) return fallback;
  return LINK_RELATIONS.includes(v) ? v : (schema.isBidRelation(v) ? v : fallback);
}

/** 确保 engagement.bidWatch 结构存在（默认 enabled:true）。 */
export function ensureBidWatch(engagement) {
  if (!engagement) return null;
  if (!engagement.bidWatch || typeof engagement.bidWatch !== 'object' || Array.isArray(engagement.bidWatch)) {
    engagement.bidWatch = { enabled: true, keywords: [], links: [], lastMatchAt: '' };
  }
  const w = engagement.bidWatch;
  if (typeof w.enabled !== 'boolean') w.enabled = true;
  if (!Array.isArray(w.keywords)) w.keywords = [];
  if (!Array.isArray(w.links)) w.links = [];
  if (typeof w.lastMatchAt !== 'string') w.lastMatchAt = '';
  return w;
}

/** 由公告记录生成持久化 link 对象。 */
export function makeLink({ record, bidId, relation, note, by, now }) {
  const rec = record || {};
  return {
    bidId: String(bidId || rec.id || ''),
    title: String(rec.title || ''),
    date: String(rec.date || ''),
    url: String(rec.url || ''),
    relation: normalizeRelation(relation),
    note: String(note || '').slice(0, 500),
    linkedAt: now || store.nowIso(),
    by: by === 'agent' ? 'agent' : 'human',
  };
}

/**
 * 关联公告（幂等：同 bidId 不重复插入，已有则更新 relation/note）。
 * 纯 board 变更；事务与落盘在 fde-api。
 */
export function applyLink(board, engagement, { record, bidId, relation, note, by, now }) {
  if (!engagement) return { ok: false, code: 'NOT_FOUND', reason: '客户不存在' };
  const id = String(bidId || (record && record.id) || '');
  if (!id) return { ok: false, code: 'INVALID', reason: '缺少 bidId' };
  const watch = ensureBidWatch(engagement);
  const rec = record || recordById(currentBidService(), id);
  if (!rec) return { ok: false, code: 'NOT_FOUND', reason: `未找到公告：${id}` };
  const existing = watch.links.find((x) => x && x.bidId === id);
  if (existing) {
    const rel = normalizeRelation(relation, existing.relation || 'mention');
    const changed = rel !== existing.relation || (note != null && String(note) !== existing.note);
    if (changed) {
      existing.relation = rel;
      if (note != null) existing.note = String(note).slice(0, 500);
      existing.linkedAt = now || store.nowIso();
      existing.by = by === 'agent' ? 'agent' : 'human';
    }
    return { ok: true, link: existing, changed };
  }
  const link = makeLink({ record: rec, bidId: id, relation, note, by, now });
  watch.links.push(link);
  return { ok: true, link, changed: true };
}

/** 取消关联（幂等：不存在时返回 changed:false）。 */
export function applyUnlink(board, engagement, bidId, by, now) {
  if (!engagement) return { ok: false, code: 'NOT_FOUND', reason: '客户不存在' };
  const id = String(bidId || '');
  if (!id) return { ok: false, code: 'INVALID', reason: '缺少 bidId' };
  const watch = ensureBidWatch(engagement);
  const before = watch.links.length;
  watch.links = watch.links.filter((x) => !(x && x.bidId === id));
  const changed = watch.links.length !== before;
  return { ok: true, changed, removed: before - watch.links.length };
}

/**
 * 提升为跟进任务（spec §17.4）：建 item「跟进招标：<title>」（type=followup/stage=todo）
 * + item.bidRefs + 关联（link）。纯 board 变更；事务与落盘在 fde-api。
 */
export function applyPromote(board, engagement, { record, bidId, relation, note, by, now, settings }) {
  if (!engagement) return { ok: false, code: 'NOT_FOUND', reason: '客户不存在' };
  const id = String(bidId || (record && record.id) || '');
  if (!id) return { ok: false, code: 'INVALID', reason: '缺少 bidId' };
  const rec = record || recordById(currentBidService(), id);
  if (!rec) return { ok: false, code: 'NOT_FOUND', reason: `未找到公告：${id}` };
  const at = now || store.nowIso();
  const actor = by === 'agent' ? 'agent' : 'human';
  const queries = queriesFor(engagement);
  const cls = classifyRecord(rec, queries);
  const rel = normalizeRelation(relation, cls.relation || 'mention');
  const linkRes = applyLink(board, engagement, { record: rec, bidId: id, relation: rel, note, by: actor, now: at });
  if (!linkRes.ok) return linkRes;
  const title = `跟进招标：${String(rec.title || id).slice(0, 160)}`;
  const item = {
    id: store.newItemId(),
    engagementId: engagement.id,
    title,
    type: 'followup',
    stage: 'todo',
    priority: 'normal',
    due: '',
    owner: actor === 'agent' ? 'agent' : 'human',
    source: { kind: actor === 'agent' ? 'agent' : 'manual', ref: `bid:${id}`, at },
    autonomy: { mode: (settings && settings.autonomy) || 'observe', rule: 'bid_signal' },
    attention: null,
    reports: [],
    sessionId: '',
    createdAt: at,
    history: [{ at, kind: 'created', text: '由招采雷达提升为跟进任务', by: actor }],
    bidRefs: [{
      bidId: id,
      title: String(rec.title || ''),
      date: String(rec.date || ''),
      url: String(rec.url || ''),
      relation: rel,
    }],
  };
  board.items.push(item);
  return { ok: true, item, link: linkRes.link, changed: true, created: true };
}

/** 记录上的来源标签（面板/工具展示用）。 */
export function kindLabel(record) {
  const kind = String((record && record.kind) || '').trim();
  if (isAwardKind(kind)) return '中标/结果';
  if (isTenderKind(kind)) return '招标/采购';
  return kind || '公告';
}

/** 供 fde-rules.bid_signal 使用：近 N 天、招标类、关系 buyer/mention。 */
export function signalCandidates(match, { days = schema.BID_DEFAULT_SIGNAL_DAYS, now = Date.now() } = {}) {
  if (!match || !match.available) return [];
  const since = store.addDaysStr(-Math.max(1, Number(days) || schema.BID_DEFAULT_SIGNAL_DAYS), now);
  return (match.items || []).filter((it) => it && it.tender && (it.relation === 'buyer' || it.relation === 'mention') && it.date && it.date >= since);
}

/** summary 里附带的「有匹配客户数」（bidStats.engagedCount）。 */
export function countEngaged(summaries) {
  return Object.values(summaries || {}).filter((s) => s && s.available && Number(s.total) > 0).length;
}
