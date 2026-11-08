/**
 * 生财 FDE 情报 · 宿主单测（spec §18）
 *
 * 不联网、不写真实 research/：所有工作区在 os.tmpdir()，MCP 用注入的 mock fetchImpl。
 * 覆盖：7 查询串行 + 间隔 ≥1000ms / 合并去重 / 归一化（HTML、200 字截断、tags、publishedAt 口径）/
 *       isNew 只标新增 / 每天一次门控 / force / 失败保留旧 feed / 当天重试上限 3 /
 *       UNAUTHORIZED（缺失、过期、保留旧 feed）/ 损坏 JSON 重建 / 原子写 / MCP_RATE_LIMITED 重试 /
 *       SSE 响应 / index.js 路由与 scys_fde 工具（含未授权 HTTP 200 降级）。
 *
 * 用法: node verify/fde-scys-host.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as scys from '../src/host/fde-scys.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TOKEN = 'test-access-token-should-never-leak';
const ENV_KEY = 'SCYS_MCP_STATE_DIR';
const PREV_ENV = process.env[ENV_KEY];

const fail = [];
const ok = [];
const check = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || extra === undefined ? '' : ' → ' + String(extra)));
  (cond ? ok : fail).push(name);
};

/* ---------------- 临时目录与授权环境 ---------------- */

const tempDirs = [];
const newTemp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); tempDirs.push(d); return d; };
const newWs = () => { const d = newTemp('rw-scys-ws-'); mkdirSync(join(d, 'research'), { recursive: true }); return d; };
const useStateDir = (dir) => { process.env[ENV_KEY] = dir; };
const newStateDir = ({ token = TOKEN, expiresAt = Date.now() + 3600 * 1000 } = {}) => {
  const d = newTemp('rw-scys-auth-');
  if (token) {
    writeFileSync(join(d, 'tokens.json'), JSON.stringify({
      access_token: token, token_type: 'Bearer', scope: 'mcp', expires_at: expiresAt,
    }), 'utf8');
  }
  return d;
};
const emptyStateDir = () => newTemp('rw-scys-auth-');

function cleanup() {
  if (PREV_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = PREV_ENV;
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
process.on('exit', cleanup);

/* ---------------- mock MCP server（JSON-RPC + JSON/SSE 响应） ---------------- */

const headersOf = (map) => ({ get: (k) => (Object.prototype.hasOwnProperty.call(map, String(k).toLowerCase()) ? map[String(k).toLowerCase()] : null) });
const jsonRes = (payload) => ({ ok: true, status: 200, headers: headersOf({ 'content-type': 'application/json' }), text: async () => JSON.stringify(payload) });
const sseRes = (payload) => ({ ok: true, status: 200, headers: headersOf({ 'content-type': 'text/event-stream' }), text: async () => 'event: message\ndata: ' + JSON.stringify(payload) + '\n\n' });
const emptyRes = () => ({ ok: true, status: 202, headers: headersOf({}), text: async () => '' });
const statusRes = (status) => ({ ok: false, status, headers: headersOf({ 'content-type': 'text/plain' }), text: async () => 'http ' + status });
const errorRes = (body, text) => jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }], isError: true } });

/**
 * @param {{data?: object, behavior?: object, sse?: object}} cfg
 *   data[name] = payload（或 (args)=>payload）；behavior[name] ∈ throw|http-401|rate-limit-once|rate-limit-always|plain-error；
 *   behavior.initialize 同样可用（如 http-401 / throw）；behavior['*'] 兜底。
 */
function makeServer({ data = {}, behavior = {}, sse = {} } = {}) {
  const calls = [];
  const once = new Set();
  const fetchImpl = async (url, init = {}) => {
    let body = {};
    try { body = JSON.parse(String(init.body || '{}')); } catch { body = {}; }
    const method = String(body.method || '');
    const name = body && body.params && body.params.name ? String(body.params.name) : '';
    calls.push({ method, name, args: body && body.params ? body.params.arguments : undefined, url: String(url), headers: (init && init.headers) || {} });
    const mode = behavior[name] || (method === 'initialize' ? behavior.initialize : '') || behavior['*'] || '';
    if (method === 'initialize') {
      if (mode === 'http-401') return statusRes(401);
      if (mode === 'throw') { const e = new Error('mock network down'); e.code = 'ECONNREFUSED'; throw e; }
      return jsonRes({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'mock-scys' } } });
    }
    if (method === 'notifications/initialized') return emptyRes();
    if (method === 'tools/call') {
      if (mode === 'throw') { const e = new Error('mock network down'); e.code = 'ECONNREFUSED'; throw e; }
      if (mode === 'http-401') return statusRes(401);
      if (mode === 'rate-limit-once' && !once.has(name)) {
        once.add(name);
        return errorRes(body, `MCP_RATE_LIMITED: dimension=USER, retryAfterSeconds=1, toolName=${name}, action=sleep 1s before calling this tool again; do not retry immediately`);
      }
      if (mode === 'rate-limit-always') return errorRes(body, `MCP_RATE_LIMITED: dimension=USER, retryAfterSeconds=1, toolName=${name}`);
      if (mode === 'plain-error') return errorRes(body, 'boom: tool exploded');
      const raw = typeof data[name] === 'function' ? data[name](body.params && body.params.arguments) : data[name];
      const payload = raw === undefined ? { items: [], total: 0 } : raw;
      const message = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };
      return sse[name] ? sseRes(message) : jsonRes(message);
    }
    return jsonRes({ jsonrpc: '2.0', id: body.id, result: {} });
  };
  fetchImpl.calls = calls;
  fetchImpl.toolCalls = (toolName) => calls.filter((c) => c.method === 'tools/call' && (!toolName || c.name === toolName));
  return fetchImpl;
}

/* ---------------- 测试数据（字段形状按 2026-11-04 实测） ---------------- */

const LONG = '这一段用来说明摘要截断与清洗，里面还有 <em>FDE</em> 高亮与**加粗**标记。'.repeat(20);

function postItem(id, title, content, opts = {}) {
  return {
    topicDTO: {
      entityType: 'xq_topic',
      entityId: String(id),
      showTitle: title,
      highlightShowTitle: title.replace('FDE', '<em>FDE</em>'),
      articleContent: content,
      gmtCreate: opts.gmtCreate != null ? opts.gmtCreate : 1787142159,
      isDigested: opts.digested ? 1 : 0,
      likeCount: opts.like != null ? opts.like : 10,
      commentsCount: opts.comment != null ? opts.comment : 2,
      readingCount: 100,
      coinCount: 3,
      favoriteCount: 4,
      type: opts.type || 'talk',
    },
    topicUserDTO: { name: opts.author || '测试作者', avatar: 'https://avatar.example/x.png' },
    detailUrl: opts.detailUrl !== undefined ? opts.detailUrl : ('https://scys.com/articleDetail/xq_topic/' + id),
  };
}
function trustedItem(id, title, snippet, publishedAt, sourceType = 'wechat_mp') {
  return {
    sourceType,
    itemId: String(id),
    title,
    titleZh: null,
    accountName: '测试公众号',
    publishedAt,
    originalUrl: sourceType === 'twitter' ? ('https://x.com/test/status/' + id) : ('https://mp.weixin.qq.com/s/' + id),
    snippet,
    startDate: '2026-11-03',
    sections: [],
  };
}
function activityItem(id, name, target) {
  return { id: String(id), name, label: '2026年8月实战活动', type: '常规航海', target, startTime: 1784721600, joinCount: 100, hrefUrl: null };
}
function navigatorItem(id, title, summary) {
  return {
    contentType: 'course', contentId: 'nav' + id, title, subtitle: '某老师 · 2026-06-24', summary,
    date: '2026-06-24', tags: ['成长/教育/其他'], detailUrl: 'https://scys.com/navigator/courses/' + id,
    createdAt: '2026-11-04 07:46:30.065',
  };
}
function manualItem(id, title, activityName) {
  return {
    id: String(id), title, activityId: '10465', activityName, label: '2026年10月实战活动', type: '常规航海',
    highlightShowTitle: title, highlightArticleContent: null, gmtCreate: 1791960900,
    hrefUrl: 'https://scys.com/course/detail/206',
  };
}

function baseData() {
  return {
    searchTopic: {
      items: [
        postItem(101, '【精华】如何入局 FDE', '<p>**加粗** <em>FDE</em> 内容：' + LONG + '</p>', { digested: true, like: 395, comment: 28 }),
        /* 标题/正文都不含 FDE 关键词：post 类不过滤，必须保留（断言用） */
        postItem(102, '纯正文帖子（不含关键词）', '第二篇正文', { like: 99, type: 'q&a' }),
      ],
      total: 2,
    },
    searchTrustedContent: {
      items: [
        trustedItem(9001, 'FDE 公众号文章', '<em>FDE</em> 摘要 ' + LONG, '2026-11-03 12:08:25'),
        trustedItem(9002, 'FDE 推文', '推文摘要', '2026-11-04 09:00:00', 'twitter'),
        /* 实测混入的无关推文：应被相关性过滤 */
        trustedItem(9003, 'Gemini：我服务器从来不崩', '无关推文摘要：模型稳定性', '2026-11-04 08:00:00', 'twitter'),
      ],
      total: 954, // 全文匹配量级，不是本次条数
    },
    activitySearch: {
      items: [
        activityItem(3001, 'FDE 实战航海', '用 AI 做 FDE 交付的实战活动'),
        activityItem(3002, 'AI 视频带货', '用 AI 批量做带货视频'), // 无关，应被过滤
      ],
      total: 2,
    },
    /* 无 total（实测 searchNavigatorContent 返回 items/nextCursor/hasMore），必须用 items.length 计数 */
    searchNavigatorContent: {
      items: [
        navigatorItem(4001, '让 AI 跑进业务：FDE', '丹元智能 CEO，服务 120 家企业'),
        navigatorItem(4002, '金虎：小红书MCN的18个坑', '夜话分享：MCN 踩坑经验'), // 实测混入的无关夜话，应被过滤
      ],
      hasMore: false,
    },
    activityManualSearch: {
      items: [
        manualItem(5001, 'FDE 手册：02. 内容制作&引流', '抖音自然流 CPS ｜ 双11 进阶冲刺'),
        manualItem(5002, '02. 文章发布与变现设置', '垂直小号-内容自动化'), // 实测混入的无关手册，应被过滤
      ],
      total: 2,
    },
  };
}

const fast = (fetchImpl, extra = {}) => Object.assign({ fetchImpl, gapMs: 0, sleepImpl: async () => {} }, extra);
const timeOf = (it) => { const t = Date.parse(String((it && it.publishedAt) || '')); return Number.isFinite(t) ? t : 0; };
const isDesc = (items) => items.every((it, i) => i === 0 || timeOf(items[i - 1]) >= timeOf(it));
const localIso = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).toISOString();

/* ================= 0. 相关性判定（非 post 类轻量过滤） ================= */
console.log('\n── 0. 相关性判定：非 post 类按 FDE 关键词过滤 ──');
{
  check('RELEVANCE_RE 导出且命中 FDE / Forward Deployed / 前沿部署 / 部署工程师',
    scys.RELEVANCE_RE instanceof RegExp
      && scys.isRelevantItem({ title: 'FDE 入门' })
      && scys.isRelevantItem({ title: 'Forward Deployed 实践' })
      && scys.isRelevantItem({ summary: '前沿部署工程师手册' })
      && scys.isRelevantItem({ summary: '做部署工程师的日常' }));
  check('不区分大小写（fde / forward deployed）',
    scys.isRelevantItem({ title: '聊聊 fde' }) && scys.isRelevantItem({ summary: 'forward deployed engineer' }));
  check('无关标题/摘要不命中（实测混入的夜话/推文/手册）',
    !scys.isRelevantItem({ title: '小红书MCN的18个坑' })
      && !scys.isRelevantItem({ title: 'Gemini：我服务器从来不崩', summary: '模型稳定性' })
      && !scys.isRelevantItem({ title: '02. 文章发布与变现设置', summary: '垂直小号-内容自动化' })
      && !scys.isRelevantItem(null));
}

/* ================= 1. 首次刷新：合并去重 / 归一化 / 原子写 ================= */
console.log('\n── 1. 首次刷新：7 查询合并去重 / 归一化 / 原子写 ──');
{
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  const server = makeServer({ data: baseData() });
  const r = await scys.refresh(ws, fast(server));
  const feed = r.feed || {};

  check('refresh ok + feed.ok', r.ok === true && feed.ok === true, JSON.stringify({ ok: r.ok, code: r.code }));
  check('queries 7 条全部成功（activitySearch 0 条也算 ok）', Array.isArray(feed.queries) && feed.queries.length === 7 && feed.queries.every((q) => q.ok === true));
  check('queries[i] 结构含 {tool,q,ok,count,error,ms}', feed.queries[0] && typeof feed.queries[0].tool === 'string' && typeof feed.queries[0].q === 'string' && 'count' in feed.queries[0] && 'error' in feed.queries[0] && 'ms' in feed.queries[0]);

  const file = scys.feedPath(ws);
  check('feed 落盘 <root>/research/.fde/scys-fde.json', existsSync(file) && file === join(ws, 'research', '.fde', 'scys-fde.json'));
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { parsed = null; }
  check('原子写后文件 JSON 可解析', !!parsed && Array.isArray(parsed.items));
  const dirFiles = readdirSync(join(ws, 'research', '.fde'));
  check('原子写无临时文件残留', dirFiles.filter((f) => f.includes('.tmp-')).length === 0, dirFiles.join(','));

  check('feed.version=1 / date=本地今天', Number(feed.version) === 1 && feed.date === scys.status(ws).today);
  check('fetchedAt 为可解析 ISO 时间', Number.isFinite(Date.parse(String(feed.fetchedAt || ''))) && String(feed.fetchedAt).endsWith('Z'));
  check('统计：去重 + 相关性过滤后 total=7（post 2·wechat 2·activity 1·navigator 1·manual 1；另过滤 4 条无关）',
    feed.stats && feed.stats.total === 7 && feed.stats.post === 2 && feed.stats.wechat === 2
      && feed.stats.activity === 1 && feed.stats.navigator === 1 && feed.stats.manual === 1,
    JSON.stringify(feed.stats));
  check('stats.filteredOut 记录被过滤条数 = 4（wechat/navigator/manual/activity 各 1）',
    feed.stats && feed.stats.filteredOut === 4, feed.stats && feed.stats.filteredOut);
  check('非 post 无关条目被过滤（twitter 9003 / activity 3002 / navigator 4002 / manual 5002）',
    feed.items.every((it) => !['wechat:9003', 'activity:3002', 'navigator:nav4002', 'manual:5002'].includes(it.id)),
    feed.items.map((it) => it.id).join(','));
  check('非 post 相关条目保留（wechat 9001/9002、activity 3001、navigator 4001、manual 5001）',
    ['wechat:9001', 'wechat:9002', 'activity:3001', 'navigator:nav4001', 'manual:5001']
      .every((id) => feed.items.some((it) => it.id === id)));
  check('post 类不过滤：标题/正文不含关键词的帖子仍保留', !!feed.items.find((it) => it.id === 'xq:102'));
  check('3 个 searchTopic 重复结果按 xq:<entityId> 去重（单查询 2/2/2 → 合并 2）',
    feed.queries.map((q) => q.count).join(',') === '2,2,2,2,1,1,1', feed.queries.map((q) => q.count).join(','));
  check('searchNavigatorContent 无 total 时用 items.length 计数', feed.queries[5] && feed.queries[5].ok === true && feed.queries[5].count === 1);
  check('searchTrustedContent total=954 不当作条数（count=2）', feed.queries[3] && feed.queries[3].count === 2);
  check('items 按 publishedAt 倒序（无时间排后）', isDesc(feed.items));
  check('首条是最新的 11-04 推特', feed.items[0] && feed.items[0].id === 'wechat:9002', feed.items[0] && feed.items[0].id);
  check('首版全部 isNew=true', feed.stats.new === 7);

  const p1 = feed.items.find((i) => i.id === 'xq:101');
  check('post 标题去掉 <em> 高亮', p1 && p1.title === '【精华】如何入局 FDE', p1 && p1.title);
  check('post 摘要去 HTML/高亮/markdown 且 ≤200 字',
    p1 && !/[<>*]/.test(p1.summary) && p1.summary.includes('加粗') && p1.summary.includes('FDE') && p1.summary.length <= scys.SUMMARY_MAX,
    p1 && p1.summary.length);
  check('tags：精华（isDigested）+ 热门（like≥100）', p1 && p1.tags.includes('精华') && p1.tags.includes('热门'), p1 && p1.tags.join(','));
  check('post 统计与作者/头像/链接', p1 && p1.stats.like === 395 && p1.stats.comment === 28 && p1.stats.read === 100
    && p1.author === '测试作者' && String(p1.authorAvatar).startsWith('https://') && String(p1.url).startsWith('https://'));
  const p2 = feed.items.find((i) => i.id === 'xq:102');
  check('tags：问答（type=q&a），like=99 不算热门', p2 && p2.tags.includes('问答') && !p2.tags.includes('热门'), p2 && p2.tags.join(','));

  const tw = feed.items.find((i) => i.id === 'wechat:9002');
  const wx = feed.items.find((i) => i.id === 'wechat:9001');
  check('searchTrustedContent publishedAt（本地时间无时区）按本地解析为 ISO',
    wx && wx.publishedAt === localIso(2026, 11, 3, 12, 8, 25), wx && wx.publishedAt);
  check('微信/推特共用 kind=wechat，subtype 保留来源', wx && wx.kind === 'wechat' && wx.subtype === 'wechat_mp'
    && tw && tw.subtype === 'twitter', (wx && wx.subtype) + '/' + (tw && tw.subtype));
  const act = feed.items.find((i) => i.id === 'activity:3001');
  check('activity：startTime → publishedAt；无 hrefUrl 时 url 置空',
    act && act.publishedAt === new Date(1784721600 * 1000).toISOString() && act.url === '', act && act.publishedAt);
  const nav = feed.items.find((i) => i.id === 'navigator:nav4001');
  check('navigator：date（YYYY-MM-DD）→ 本地零点 ISO', nav && nav.publishedAt === localIso(2026, 6, 24), nav && nav.publishedAt);
  const man = feed.items.find((i) => i.id === 'manual:5001');
  check('manual：gmtCreate → publishedAt；hrefUrl 保留', man && man.publishedAt === new Date(1791960900 * 1000).toISOString()
    && man.url === 'https://scys.com/course/detail/206');
  check('条目字段齐全（id/kind/title/summary/author/url/publishedAt/tags/stats/isNew）',
    feed.items.every((it) => it.id && it.kind && typeof it.title === 'string' && typeof it.summary === 'string'
      && 'author' in it && 'url' in it && Array.isArray(it.tags) && it.stats && 'isNew' in it));
  check('结果不含 token（不落盘/不回传）', !JSON.stringify(r).includes(TOKEN) && !readFileSync(file, 'utf8').includes(TOKEN));

  const st = scys.status(ws);
  check('status：ok / stale=false / refreshing=false / 带 feed', st.ok === true && st.stale === false && st.refreshing === false && st.feed && st.feed.items.length === 7);
  check('readFeed 与 status 读到同一份', scys.readFeed(ws).feed && scys.readFeed(ws).feed.items.length === 7);
}

/* ================= 2. 串行与间隔 ================= */
console.log('\n── 2. 7 个 MCP 查询严格串行、相邻间隔 ≥1000ms ──');
{
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  const waits = [];
  const server = makeServer({ data: baseData() });
  const r = await scys.refresh(ws, { fetchImpl: server, gapMs: scys.MIN_GAP_MS, sleepImpl: async (ms) => { waits.push(ms); } });
  check('MIN_GAP_MS 常量 = 1000', scys.MIN_GAP_MS === 1000);
  check('成功刷新', r.ok === true);
  check('7 查询之间 6 次等待，每次 ≥1000ms', waits.length === 6 && waits.every((ms) => ms >= 1000), JSON.stringify(waits));
  const seq = server.calls.map((c) => c.method);
  check('握手顺序 initialize → notifications/initialized',
    seq[0] === 'initialize' && seq[1] === 'notifications/initialized', seq.slice(0, 3).join(','));
  check('查询顺序与 QUERIES 常量一致（严格串行）',
    server.toolCalls().map((c) => c.name).join(',') === scys.QUERIES.map((q) => q.tool).join(','),
    server.toolCalls().map((c) => c.name).join(','));
  check('请求带 Bearer 头（token 只在头里）', String(server.calls[0].headers.authorization || '') === 'Bearer ' + TOKEN);
}

/* ================= 3. 每天一次门控 ================= */
console.log('\n── 3. 每天一次门控：同一天两次 maybeRefresh 只抓 1 次 ──');
{
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  const server = makeServer({ data: baseData() });
  const r1 = await scys.maybeRefresh(ws, fast(server));
  const callsAfterFirst = server.calls.length;
  const r2 = await scys.maybeRefresh(ws, fast(server));
  check('第一次 maybeRefresh 真实抓取', r1.ok === true && r1.skipped !== true && callsAfterFirst > 0);
  check('同一天第二次 maybeRefresh 跳过且不发请求', r2.skipped === true && server.calls.length === callsAfterFirst, 'calls=' + server.calls.length);
  check('跳过时仍返回当日 feed（stale=false）', r2.feed && r2.stale === false);
}

/* ================= 4. force 刷新与 isNew ================= */
console.log('\n── 4. force 刷新 & isNew 只标本次新增 ──');
{
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  await scys.maybeRefresh(ws, fast(makeServer({ data: baseData() })));
  const data2 = baseData();
  data2.searchTopic.items.push(postItem(103, '新出现的 FDE 帖', '新帖正文', { gmtCreate: 1793600000, like: 120 }));
  const server2 = makeServer({ data: data2 });
  const r = await scys.maybeRefresh(ws, fast(server2, { force: true }));
  check('force 刷新不受「每天一次」限制，真实抓取', r.ok === true && r.skipped !== true && server2.calls.length > 0);
  check('isNew 只标记本次新增（1 条）', r.feed.stats.new === 1, JSON.stringify(r.feed.stats));
  check('新增条目 isNew=true', r.feed.items.find((i) => i.id === 'xq:103') ? r.feed.items.find((i) => i.id === 'xq:103').isNew === true : false);
  check('旧条目 isNew 不残留（false）', r.feed.items.find((i) => i.id === 'xq:101') ? r.feed.items.find((i) => i.id === 'xq:101').isNew === false : false);
}

/* ================= 5. MCP 限流：重试一次成功 / 仍失败 / 普通工具错误 ================= */
console.log('\n── 5. MCP_RATE_LIMITED（文本错误不阻断整体） ──');
{
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  const sleeps = [];
  const server = makeServer({ data: baseData(), behavior: { activityManualSearch: 'rate-limit-once' } });
  const r = await scys.refresh(ws, { fetchImpl: server, gapMs: 0, sleepImpl: async (ms) => { sleeps.push(ms); } });
  const q = r.feed && r.feed.queries[6];
  check('限流一次：等 retryAfter 后重试成功', r.ok === true && q && q.ok === true && q.count === 1, JSON.stringify(q));
  check('确实调用了两次 activityManualSearch', server.toolCalls('activityManualSearch').length === 2);
  check('按 retryAfterSeconds=1 等待（≥1000ms）', sleeps.some((ms) => ms >= 1000), JSON.stringify(sleeps));
}
{
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  const server = makeServer({ data: baseData(), behavior: { activityManualSearch: 'rate-limit-always' } });
  const r = await scys.refresh(ws, fast(server));
  const q = r.feed && r.feed.queries[6];
  check('限流重试仍失败：记 queries[i].error，不阻断其它查询', r.ok === true && q && q.ok === false && /MCP_RATE_LIMITED/.test(String(q.error)), q && q.error);
  check('重试仍失败时只调 2 次（不无限重试）', server.toolCalls('activityManualSearch').length === 2);
  check('其它 6 个查询成功、manual 计数为 0', r.feed.queries.filter((x) => x.ok).length === 6 && r.feed.stats.manual === 0);
}
{
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  const server = makeServer({ data: baseData(), behavior: { searchNavigatorContent: 'plain-error' } });
  const r = await scys.refresh(ws, fast(server));
  const q = r.feed && r.feed.queries[5];
  check('普通工具错误也记 error 且不抛', r.ok === true && q && q.ok === false && /boom/.test(String(q.error)), q && q.error);
}

/* ================= 6. 失败保留旧 feed ================= */
console.log('\n── 6. 刷新失败：保留旧 feed + lastError，不重新抓取 ──');
{
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  const okR = await scys.refresh(ws, fast(makeServer({ data: baseData() })));
  const before = okR.feed.items.length;

  const bad = makeServer({ behavior: { '*': 'throw' } });
  const failR = await scys.refresh(ws, fast(bad));
  check('网络失败：ok:false + code:UNAVAILABLE', failR.ok === false && failR.code === 'UNAVAILABLE', failR.code);
  check('保留旧 feed 数据（7 条不变）', failR.feed && failR.feed.items.length === before, failR.feed && failR.feed.items.length);
  check('旧 feed 标记 ok=false + lastError + lastCode', failR.feed.ok === false && !!failR.feed.lastError && failR.feed.lastCode === 'UNAVAILABLE');
  const st = scys.status(ws);
  check('GET 视图：ok:false + code + 仍带上次 feed', st.ok === false && st.code === 'UNAVAILABLE' && st.feed && st.feed.items.length === before);

  const callsAfterFail = bad.calls.length;
  const gate = await scys.maybeRefresh(ws, fast(bad));
  check('当天已有缓存时失败后不自动反复打网络（同一天跳过）', gate.skipped === true && bad.calls.length === callsAfterFail);

  const unauth = makeServer({ behavior: { initialize: 'http-401' } });
  const r401 = await scys.refresh(ws, fast(unauth));
  check('握手 HTTP 401 → UNAUTHORIZED 且提示重新授权', r401.ok === false && r401.code === 'UNAUTHORIZED' && String(r401.reason).includes('重新授权'), r401.reason);
  check('401 后仍保留旧 feed', r401.feed && r401.feed.items.length === before);
}

/* ================= 7. 失败当天重试上限 3 ================= */
console.log('\n── 7. 失败当天最多重试 3 次（force 可人工越过） ──');
{
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  const bad = makeServer({ behavior: { '*': 'throw' } });
  const r1 = await scys.maybeRefresh(ws, fast(bad));
  const r2 = await scys.maybeRefresh(ws, fast(bad));
  const r3 = await scys.maybeRefresh(ws, fast(bad));
  const callsAfter3 = bad.calls.length;
  const r4 = await scys.maybeRefresh(ws, fast(bad));
  check('前 3 次都真实抓取且失败', r1.ok === false && r2.ok === false && r3.ok === false && callsAfter3 === 3, 'calls=' + callsAfter3);
  check('第 4 次跳过：code=RETRY_LIMIT，不再请求', r4.ok === false && r4.code === 'RETRY_LIMIT' && r4.skipped === true && bad.calls.length === 3, 'calls=' + bad.calls.length);
  check('从未成功时不落盘空缓存（feed=null）', scys.status(ws).feed === null);
  const forced = await scys.maybeRefresh(ws, fast(bad, { force: true }));
  check('force 越过当天重试上限（人工手动刷新）', forced.ok === false && bad.calls.length === 4, 'calls=' + bad.calls.length);
}

/* ================= 8. 未授权（缺失 / 过期 / 保留旧 feed） ================= */
console.log('\n── 8. UNAUTHORIZED：token 缺失 / 过期 / 保留旧 feed ──');
{
  const ws = newWs();
  useStateDir(emptyStateDir());
  scys.resetScysState();
  const server = makeServer({ data: baseData() });
  const r = await scys.refresh(ws, fast(server));
  check('无 tokens.json → UNAUTHORIZED 且完全不联网', r.ok === false && r.code === 'UNAUTHORIZED' && server.calls.length === 0, 'calls=' + server.calls.length);
  check('未授权且无历史时不落盘（feed=null）', scys.status(ws).feed === null);
  const a = scys.authStatus();
  check('authStatus 不含 token 字段', a.ok === false && a.code === 'UNAUTHORIZED' && !('token' in a) && !JSON.stringify(a).includes(TOKEN));
}
{
  const ws = newWs();
  useStateDir(newStateDir({ expiresAt: Date.now() - 1000 }));
  scys.resetScysState();
  const r = await scys.refresh(ws, fast(makeServer({ data: baseData() })));
  check('token 已过期 → UNAUTHORIZED + 重新授权提示', r.ok === false && r.code === 'UNAUTHORIZED' && String(r.reason).includes('重新授权'), r.reason);
}
{
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  const okR = await scys.refresh(ws, fast(makeServer({ data: baseData() })));
  check('（准备）有效授权写入缓存', okR.ok === true && okR.feed.items.length === 7);
  useStateDir(newStateDir({ expiresAt: Date.now() - 1000 }));
  const bad = await scys.refresh(ws, fast(makeServer({ data: baseData() })));
  check('授权过期：保留上次 feed（7 条）+ lastCode=UNAUTHORIZED',
    bad.ok === false && bad.code === 'UNAUTHORIZED' && bad.feed && bad.feed.items.length === 7 && bad.feed.lastCode === 'UNAUTHORIZED');
  const st = scys.status(ws);
  check('GET 视图：ok:false/UNAUTHORIZED 且带上次 feed', st.ok === false && st.code === 'UNAUTHORIZED' && !!st.feed && st.feed.items.length === 7);
}

/* ================= 9. 损坏 JSON 重建 ================= */
console.log('\n── 9. 损坏 JSON → 空 feed 重建，不抛错 ──');
{
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  const file = scys.feedPath(ws);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{ this is not json', 'utf8');
  const read = scys.readFeed(ws);
  check('损坏 JSON：readFeed → feed=null + corrupt=true（不抛）', read.feed === null && read.corrupt === true);
  const st = scys.status(ws);
  check('损坏 JSON 的 GET 视图：feed=null + stale', st.feed === null && st.stale === true && st.ok === true);
  const r = await scys.refresh(ws, fast(makeServer({ data: baseData() })));
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { parsed = null; }
  check('刷新后重建有效 feed 文件（7 条）', r.ok === true && !!parsed && parsed.items.length === 7);
}

/* ================= 10. SSE 响应兼容 ================= */
console.log('\n── 10. text/event-stream 响应兼容 ──');
{
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  const server = makeServer({ data: baseData(), sse: { searchTopic: true, activityManualSearch: true } });
  const r = await scys.refresh(ws, fast(server));
  check('SSE 包裹的 JSON-RPC 结果也能解析', r.ok === true && r.feed.stats.total === 7, r.code || JSON.stringify(r.feed && r.feed.stats));
}

/* ================= 11. index.js：路由 / scys_fde 工具 / 定时器 / HTTP 200 降级 ================= */
console.log('\n── 11. index.js：2 路由 + scys_fde 工具 + 未授权 HTTP 200 降级 ──');
{
  const mod = await import(join(ROOT, 'index.js'));
  const ws = newWs();
  useStateDir(newStateDir());
  scys.resetScysState();
  const tools = [];
  const routes = [];
  const sections = [];
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      try {
        const d = typeof fn === 'function' ? fn() : undefined;
        if (typeof d === 'function') { disposers.push(d); return d; }
      } catch { /* ignore */ }
      return () => {};
    },
    get(n) {
      if (n === 'tools') return { register(d) { tools.push(d); return () => {}; } };
      if (n === 'webServer') return { register(d) { routes.push(d); return () => {}; } };
      if (n === 'systemPrompt') return { section(d) { sections.push(d); }, getSectionOrder() { return 2950; } };
      if (n === 'workspaceRegistry') return { list() { return [{ id: 'ws-scys', path: ws, updatedAt: new Date().toISOString() }]; } };
      return undefined;
    },
  };
  mod.apply(ctx);

  const feedRoute = routes.find((r) => r.path === '/research-workbench/api/fde/scys/feed');
  const refreshRoute = routes.find((r) => r.path === '/research-workbench/api/fde/scys/refresh');
  check('注册路由 scys/feed（GET）与 scys/refresh（POST）', !!feedRoute && !!refreshRoute);
  const tool = tools.find((t) => t.name === 'scys_fde');
  check('注册第 8 个 FDE 工具 scys_fde', !!tool && typeof tool.execute === 'function'
    && tool.parameters && tool.parameters.type === 'object' && tool.parameters.required.includes('action'));
  check('系统提示词含 scys_fde 与生财情报口径', sections.length === 1
    && sections[0].text.includes('scys_fde') && sections[0].text.includes('生财 FDE 情报') && sections[0].text.includes('UNAUTHORIZED'));

  const seed = await scys.refresh(ws, fast(makeServer({ data: baseData() })));
  check('（准备）缓存已写入', seed.ok === true);

  const feedOut = await tool.execute({ action: 'feed', root: ws });
  check('工具 feed：ok + 7 条 + 统计/时间/口径提示',
    feedOut.ok === true && feedOut.items.length === 7 && feedOut.stats.total === 7
      && feedOut.stats.filteredOut === 4
      && !!feedOut.fetchedAt && feedOut.text.includes('口径') && feedOut.text.includes('https://')
      && feedOut.text.includes('过滤无关 4'),
    JSON.stringify({ ok: feedOut.ok, n: feedOut.items && feedOut.items.length, stats: feedOut.stats }));
  const limited = await tool.execute({ action: 'feed', root: ws, limit: 2 });
  check('工具 feed limit 生效（≤limit 条，total 仍为全量）', limited.items.length === 2 && limited.total === 7, limited.items.length + '/' + limited.total);
  const posts = await tool.execute({ action: 'feed', root: ws, kind: 'post' });
  check('工具 feed kind 过滤（post=2）', posts.items.length === 2 && posts.items.every((i) => i.kind === 'post'));
  const kw = await tool.execute({ action: 'feed', root: ws, q: '公众号' });
  check('工具 feed q 过滤（公众号命中 2）', kw.items.length === 2 && kw.items.every((i) => (i.title + i.author).includes('公众号')));
  const badAction = await tool.execute({ action: 'nope', root: ws });
  check('工具未知 action → ok:false/INVALID，不抛异常', badAction.ok === false && badAction.code === 'INVALID');

  const g = await callRoute(feedRoute, '/research-workbench/api/fde/scys/feed', 'GET');
  check('路由 GET scys/feed → 200 + ok + feed', g.status === 200 && g.payload.ok === true && g.payload.feed && g.payload.feed.items.length === 7);
  const m405 = await callRoute(refreshRoute, '/research-workbench/api/fde/scys/refresh', 'GET');
  check('GET /scys/refresh → 405（方法白名单）', m405.status === 405, m405.status);

  /* 未授权分支：不联网、HTTP 仍 200、保留上次 feed */
  useStateDir(emptyStateDir());
  const rUnauth = await tool.execute({ action: 'refresh', root: ws });
  check('工具 refresh 无授权 → {ok:false, code:UNAUTHORIZED} 不抛异常', rUnauth.ok === false && rUnauth.code === 'UNAUTHORIZED');
  const p = await callRoute(refreshRoute, '/research-workbench/api/fde/scys/refresh', 'POST', {});
  check('路由 POST scys/refresh 未授权仍 HTTP 200（业务 ok:false + code）',
    p.status === 200 && p.payload.ok === false && p.payload.code === 'UNAUTHORIZED',
    p.status + ' ' + JSON.stringify(p.payload).slice(0, 120));
  const g2 = await callRoute(feedRoute, '/research-workbench/api/fde/scys/feed', 'GET');
  check('未授权后 GET 仍带上次 feed（ok:false + code + items）',
    g2.status === 200 && g2.payload.ok === false && g2.payload.code === 'UNAUTHORIZED' && !!g2.payload.feed && g2.payload.feed.items.length === 7);

  /* 生财三路授权路由（ADR 0004 D5）：GET 状态 / POST 保存 / POST 清除 */
  const authRoute = routes.find((r) => r.path === '/research-workbench/api/fde/scys/auth');
  check('注册 scys/auth 路由（GET+POST 同路径）', !!authRoute);
  const aGet = await callRoute(authRoute, '/research-workbench/api/fde/scys/auth', 'GET');
  check('GET scys/auth → 200 + auth 摘要且不含 token',
    aGet.status === 200 && aGet.payload.ok === true && !!aGet.payload.auth
      && typeof aGet.payload.auth.available === 'boolean' && !JSON.stringify(aGet.payload).includes(TOKEN),
    JSON.stringify(aGet.payload).slice(0, 160));
  const aPost = await callRoute(authRoute, '/research-workbench/api/fde/scys/auth', 'POST', { url: 'https://auth.example/cb?access_token=' + TOKEN });
  check('POST scys/auth 保存链接授权 → source=link 且不返回 token',
    aPost.status === 200 && aPost.payload.ok === true && aPost.payload.auth.source === 'link'
      && !JSON.stringify(aPost.payload).includes(TOKEN),
    JSON.stringify(aPost.payload).slice(0, 160));
  const aClear = await callRoute(authRoute, '/research-workbench/api/fde/scys/auth', 'POST', { clear: true });
  check('POST scys/auth clear → removed=true', aClear.status === 200 && aClear.payload.ok === true && aClear.payload.removed === true);
  const aBad = await callRoute(authRoute, '/research-workbench/api/fde/scys/auth', 'POST', { token: 'bad token' });
  check('POST scys/auth 非法 token → ok:false/INVALID，不写文件', aBad.status === 200 && aBad.payload.ok === false && aBad.payload.code === 'INVALID');

  for (const d of disposers) { try { d(); } catch { /* ignore */ } }
}

/* ================= 12. 生财三路授权：链接 / 环境变量 / 兼容文件（ADR 0004 D5） ================= */
console.log('\n── 12. 生财三路授权：链接 / 环境变量 / 兼容文件 ──');
{
  const ws = newWs();
  const PREV_FDE = process.env.FDE_SCYS_TOKEN;
  const PREV_FDE_EXP = process.env.FDE_SCYS_TOKEN_EXPIRES_AT;
  delete process.env.FDE_SCYS_TOKEN;
  delete process.env.FDE_SCYS_TOKEN_EXPIRES_AT;
  useStateDir(emptyStateDir());
  scys.resetScysState();

  check('三路都缺失：authSummary = unavailable/none',
    JSON.stringify(scys.authSummary(ws)) === JSON.stringify({ available: false, source: 'none', expiresAt: null }),
    JSON.stringify(scys.authSummary(ws)));

  check('parse：直接粘贴 token', scys.parseAuthInput({ token: 'a'.repeat(20) }).ok === true);
  const pQuery = scys.parseAuthInput({ url: 'https://mcp.scys.com/auth?access_token=' + 'b'.repeat(20) });
  check('parse：授权链接 query 提取 token', pQuery.ok === true && pQuery.token === 'b'.repeat(20));
  const pHash = scys.parseAuthInput({ url: 'https://auth.example/cb#token=' + 'c'.repeat(20) });
  check('parse：授权链接 hash 提取 token', pHash.ok === true && pHash.token === 'c'.repeat(20));
  check('parse：空输入 → ok:false 不抛', scys.parseAuthInput({}).ok === false);
  check('parse：含空白/控制字符 → ok:false', scys.parseAuthInput({ token: 'bad token with space' }).ok === false);

  const saved = scys.saveAuthFromInput(ws, { url: 'https://auth.example/cb?access_token=' + TOKEN });
  const authFile = scys.authFilePath(ws);
  const mode = (statSync(authFile).mode & 0o777).toString(8);
  check('保存链接授权：ok + 文件存在 + 0600', saved.ok === true && existsSync(authFile) && mode === '600', mode);
  const sum = scys.authSummary(ws);
  check('授权摘要：available + source=link + 不含 token',
    sum.available === true && sum.source === 'link' && !JSON.stringify(sum).includes(TOKEN), JSON.stringify(sum));

  /* 链接授权优先于兼容文件 */
  useStateDir(newStateDir());
  check('优先级：链接授权 > 兼容 token 文件', scys.authSummary(ws).source === 'link', JSON.stringify(scys.authSummary(ws)));

  /* 用链接授权实际刷新（mock 检查 Bearer 头） */
  scys.resetScysState();
  const server = makeServer({ data: baseData() });
  const r = await scys.refresh(ws, fast(server));
  check('链接授权可用于刷新（Bearer 头来自链接授权）',
    r.ok === true && String(server.calls[0] && server.calls[0].headers.authorization) === 'Bearer ' + TOKEN,
    String((server.calls[0] && server.calls[0].headers.authorization) || ''));

  /* 清除 → 回落到兼容文件 */
  const cleared = scys.clearAuthFromInput(ws);
  check('清除链接授权：removed=true 且回落到 compat',
    cleared.ok === true && cleared.removed === true && !existsSync(authFile) && scys.authSummary(ws).source === 'compat',
    JSON.stringify(cleared.auth || {}));

  /* 环境变量优先于兼容文件 */
  process.env.FDE_SCYS_TOKEN = TOKEN;
  check('优先级：环境变量 > 兼容 token 文件', scys.authSummary(ws).source === 'env', JSON.stringify(scys.authSummary(ws)));
  delete process.env.FDE_SCYS_TOKEN;

  /* 损坏的链接文件：报错，不静默回退 */
  mkdirSync(dirname(authFile), { recursive: true });
  writeFileSync(authFile, '{broken', 'utf8');
  const broken = scys.authStatus(ws);
  check('链接授权文件损坏：ok:false + source=link（不静默回退）',
    broken.ok === false && broken.source === 'link' && !!broken.code,
    JSON.stringify({ ok: broken.ok, source: broken.source, code: broken.code }));
  try { rmSync(authFile, { force: true }); } catch { /* ignore */ }
  if (PREV_FDE === undefined) delete process.env.FDE_SCYS_TOKEN; else process.env.FDE_SCYS_TOKEN = PREV_FDE;
  if (PREV_FDE_EXP === undefined) delete process.env.FDE_SCYS_TOKEN_EXPIRES_AT; else process.env.FDE_SCYS_TOKEN_EXPIRES_AT = PREV_FDE_EXP;
}

/* ---------------- 汇总 ---------------- */

console.log('\n=== 通过 ' + ok.length + ' 项 ===');
if (fail.length) {
  console.log('\n=== 失败 ' + fail.length + ' 项 ===');
  for (const f of fail) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('生财 FDE 情报宿主单测全部通过（mock fetch，未联网）。');
}
cleanup();

/* ---------------- 路由调用替身（copy 自 host-smoke，独立文件不 import 测试） ---------------- */
async function callRoute(route, pathWithQuery, method = 'GET', body) {
  if (!route) return { status: 599, payload: { ok: false, reason: '路由未注册：' + pathWithQuery } };
  let status = 200;
  let payload = null;
  const headers = method === 'POST' ? { 'content-type': 'application/json' } : {};
  const chunks = [Buffer.from(JSON.stringify(body || {}))];
  const req = { method, url: pathWithQuery, headers, on() {}, destroy() {} };
  if (method === 'POST') {
    req.on = (ev, cb) => {
      if (ev === 'data') chunks.forEach(cb);
      if (ev === 'end') cb();
      return req;
    };
  }
  const res = {
    set statusCode(v) { status = v; },
    get statusCode() { return status; },
    setHeader() {},
    end(txt) { try { payload = JSON.parse(String(txt ?? '')); } catch { payload = { raw: String(txt ?? '') }; } },
  };
  await route.handler(req, res);
  return { status, payload };
}
