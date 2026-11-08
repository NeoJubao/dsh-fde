/**
 * FDE 资料库 · 宿主单测（spec §19，v1.3）
 *
 * 不联网、不写真实 research/：所有工作区与 catalog 都在 os.tmpdir()，
 * GitHub 请求全部走注入的 mock fetchImpl（并统计调用、并发、请求头）。
 * 覆盖 spec §19.8 验收 1–6（catalog 校验 / 无缓存视图 / GitHub 合并与失败降级 /
 * 每日一次门控与失败重试上限 / 社区映射 / isNew·updated / featured 排序 / 原子写 / 损坏缓存重建），
 * 以及 index.js 的 2 条 library 路由、fde_library 工具与定时器注册（不执行定时器）。
 *
 * 用法: node verify/fde-library-host.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as lib from '../src/host/fde-library.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ---------------- 断言器 ---------------- */
const passed = [];
const failed = [];
const check = (name, cond, extra) => {
  if (cond) { passed.push(name); console.log('  ✓ ' + name); return true; }
  const detail = extra === undefined ? '' : ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 500));
  failed.push(name + detail);
  console.log('  ✗ ' + name + detail);
  return false;
};
const section = (t) => console.log('\n── ' + t + ' ──');

/* ---------------- 临时工作区 / 日期 ---------------- */
const tempDirs = [];
const newTemp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); tempDirs.push(d); return d; };
const newWs = () => { const d = newTemp('rw-lib-ws-'); mkdirSync(join(d, 'research'), { recursive: true }); return d; };
const PREV_CATALOG_ENV = process.env.FDE_LIBRARY_CATALOG_PATH;
const cleanup = () => {
  if (PREV_CATALOG_ENV === undefined) delete process.env.FDE_LIBRARY_CATALOG_PATH;
  else process.env.FDE_LIBRARY_CATALOG_PATH = PREV_CATALOG_ENV;
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
};
process.on('exit', cleanup);

const localDate = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + Number(offsetDays || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const TODAY = localDate(0);

/* ---------------- 全局网络护栏：任何真实 fetch 都算失败 ---------------- */
const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
globalThis.fetch = () => { globalFetchCalls += 1; return Promise.reject(new Error('测试禁止真实网络请求')); };
process.on('exit', () => { globalThis.fetch = realFetch; });

/* ---------------- catalog / scys 夹具 ---------------- */
const baseGroups = () => lib.GROUPS.map((g) => ({ key: g.key, label: g.label }));

function item(patch = {}) {
  const base = {
    id: 'item-' + Math.random().toString(36).slice(2, 8),
    group: 'intl-official', kind: 'doc', lang: 'zh', title: '测试资料', publisher: '测试发布方',
    url: 'https://example.invalid/' + Math.random().toString(36).slice(2, 10),
    authority: 'A', stages: ['all'], topics: ['测试'], summary: '一句话摘要', why: '一句话价值',
    featured: false, recommend: 'backup', addedAt: localDate(-30), verifiedAt: TODAY, httpStatus: 200,
    staticMeta: { stars: 0, forks: 0, license: '', language: '', pushedAt: '' },
  };
  return Object.assign(base, patch || {});
}

function baseCatalog() {
  return {
    version: 1,
    updatedAt: '2026-11-04',
    notes: [],
    groups: baseGroups(),
    items: [
      item({
        id: 'openai-agents-guide', group: 'intl-official', kind: 'guide', lang: 'en', title: 'A practical guide to building agents',
        publisher: 'OpenAI', url: 'https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/',
        authority: 'A', stages: ['scoping', 'solution'], topics: ['agent'],
        summary: '构建 agent 的实践指南', why: '场景与方案阶段的方法参考',
        featured: true, recommend: 'star', addedAt: localDate(-1), httpStatus: 200,
      }),
      item({
        id: 'tencent-cloud-fde', group: 'cn-official', kind: 'doc', lang: 'zh', title: '腾讯云 FDE 实践',
        publisher: '腾讯云', url: 'https://cloud.tencent.com/document/product/1234567',
        authority: 'A', stages: ['all'], summary: '国内云厂商 FDE 交付实践', why: '国内官方一手',
        recommend: 'recommend', addedAt: localDate(-30),
      }),
      item({
        id: 'openai-agents-python', group: 'opensource', kind: 'repo', lang: 'en', title: 'openai-agents-python',
        publisher: 'openai/openai-agents-python', url: 'https://github.com/openai/openai-agents-python',
        authority: 'B', stages: ['all'], summary: '开源 agent SDK', why: '可直接复用',
        recommend: 'star', addedAt: localDate(-10), repo: 'openai/openai-agents-python', track: true,
        staticMeta: { stars: 11, forks: 2, license: 'MIT', language: 'Python', pushedAt: '2026-10-01T00:00:00Z' },
      }),
      item({
        id: 'anthropic-cookbook', group: 'opensource', kind: 'repo', lang: 'en', title: 'anthropic-cookbook',
        publisher: 'anthropics/anthropic-cookbook', url: 'https://github.com/anthropics/anthropic-cookbook',
        authority: 'B', stages: ['solution'], summary: 'Claude 用法示例', why: '方案阶段参考',
        recommend: 'recommend', addedAt: localDate(-20), repo: 'anthropics/anthropic-cookbook', track: true,
        staticMeta: { stars: 7, forks: 1, license: '', language: '', pushedAt: '' },
      }),
      item({
        id: 'repo-no-track', group: 'opensource', kind: 'repo', lang: 'en', title: 'no-track-repo',
        publisher: 'o/no', url: 'https://github.com/o/no', authority: 'B', stages: ['all'],
        summary: '不参与每日指标刷新', why: 'track=false', recommend: 'backup', addedAt: localDate(-20),
        repo: 'o/no', track: false, staticMeta: { stars: 3, forks: 0, license: 'Apache-2.0', language: 'Go', pushedAt: '2026-09-01T00:00:00Z' },
      }),
      item({
        id: 'internal-scenario-template', group: 'method', kind: 'template', lang: 'zh', title: '场景评估表',
        publisher: '内部方法库', url: 'https://example.invalid/method/scenario', authority: 'B',
        stages: ['scoping'], summary: '12 维场景评分卡模板', why: 'scoping 阶段直接套用',
        recommend: 'recommend', addedAt: localDate(-3),
      }),
    ],
  };
}

function scysPayload() {
  return {
    version: 1,
    date: TODAY,
    fetchedAt: new Date().toISOString(),
    ok: true,
    stats: { total: 2 },
    items: [
      {
        id: 'xq:22255154882458281', kind: 'post', title: '如何入局 FDE',
        summary: '社区里关于 FDE 入局与未来的一篇长帖'.repeat(20), // 超 200 字，验证截断
        author: '苍述', authorAvatar: 'https://avatar.example/x.png',
        url: 'https://scys.com/articleDetail/xq_topic/22255154882458281',
        publishedAt: '2026-11-03T12:00:00.000Z', tags: ['精华'], stats: { like: 395, comment: 28, read: 11035 }, isNew: true,
      },
      {
        id: 'xq:2', kind: 'post', title: '第二条社区动态', summary: '第二条摘要', author: '作者二',
        url: 'https://scys.com/articleDetail/xq_topic/2', publishedAt: '2026-11-01T12:00:00.000Z', tags: [], stats: {}, isNew: false,
      },
    ],
  };
}

function writeCatalog(ws, catalog) {
  const p = join(ws, 'catalog.json');
  writeFileSync(p, JSON.stringify(catalog, null, 2), 'utf8');
  return p;
}
function writeScys(ws, payload) {
  const p = join(ws, 'research', '.fde', 'scys-fde.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2), 'utf8');
  return p;
}
function writeFeedRaw(ws, feed) {
  const p = lib.feedPath(ws);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(feed, null, 2), 'utf8');
}

/* ---------------- GitHub mock ---------------- */
const FAST = { githubConcurrency: 3, githubTimeoutMs: 2000 };
function mockGithub({ behavior = {}, metrics = {}, delayMs = 2 } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (url, init = {}) => {
    const raw = String(url);
    const repo = raw.startsWith(lib.GITHUB_API) ? raw.slice(lib.GITHUB_API.length) : raw;
    calls.push({ url: raw, repo, headers: Object.assign({}, init && init.headers), hasSignal: !!(init && init.signal) });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const mode = behavior[repo] || behavior['*'] || '';
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (mode === 'http-403') return { status: 403, headers: { get: () => null }, text: async () => '{"message":"API rate limit exceeded"}' };
      if (mode === 'throw') throw new Error('mock network down');
      if (mode === 'hang') await new Promise(() => {});
      const m = metrics[repo] || { stars: 1000, forks: 50, license: 'MIT', language: 'Python', pushedAt: '2026-11-02T00:00:00Z' };
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          stargazers_count: m.stars, forks_count: m.forks,
          license: m.license ? { spdx_id: m.license } : null,
          language: m.language, pushed_at: m.pushedAt,
        }),
      };
    } finally { inFlight -= 1; }
  };
  fetchImpl.calls = calls;
  fetchImpl.maxInFlight = () => maxInFlight;
  return fetchImpl;
}

/* ================= 0. catalog 校验与加载（§19.1 / §19.8-1） ================= */
section('0. catalog 校验与加载（id/url/枚举/重复）');
{
  const good = baseCatalog();
  const v = lib.validateCatalog(good);
  check('合法 catalog 通过校验', v.ok === true && v.errors.length === 0, v.errors);
  check('统计与目录一致（total/byGroup/featured/star/track）',
    v.stats.total === good.items.length && v.stats.byGroup['intl-official'] === 1 && v.stats.byGroup['cn-official'] === 1
      && v.stats.byGroup.opensource === 3 && v.stats.byGroup.method === 1 && v.stats.featured === 1 && v.stats.star === 2
      && v.stats.track === 2, v.stats);

  const dup = baseCatalog();
  dup.items.push(item({ id: dup.items[0].id, url: 'https://example.invalid/unique-dup-id' }));
  const vDup = lib.validateCatalog(dup);
  check('id 重复 → 校验失败', vDup.ok === false && vDup.errors.some((e) => e.includes('id 重复')), vDup.errors);

  const dupUrl = baseCatalog();
  dupUrl.items.push(item({ id: 'unique-id-1', url: dupUrl.items[0].url }));
  const vDupUrl = lib.validateCatalog(dupUrl);
  check('同一 URL 重复收录 → 校验失败', vDupUrl.ok === false && vDupUrl.errors.some((e) => e.includes('url 重复')), vDupUrl.errors);

  const badUrl = baseCatalog();
  badUrl.items[0].url = 'ftp://example.com/x';
  check('url 非 http(s) → 校验失败', lib.validateCatalog(badUrl).errors.some((e) => e.includes('url 不是 http')));

  const badEnum = baseCatalog();
  badEnum.items[0].group = 'nope';
  badEnum.items[1].kind = 'nope';
  badEnum.items[2].authority = 'Z';
  badEnum.items[3].stages = ['nope'];
  badEnum.items[4].recommend = 'nope';
  const vEnum = lib.validateCatalog(badEnum);
  check('group/kind/authority/stages/recommend 枚举非法 → 校验失败',
    vEnum.ok === false && ['group 非法', 'kind 非法', 'authority 非法', 'stages 含非法阶段', 'recommend 非法']
      .every((t) => vEnum.errors.some((e) => e.includes(t))), vEnum.errors);

  const soft = baseCatalog();
  soft.items[0].summary = '长'.repeat(lib.SUMMARY_MAX + 10);
  soft.items[0].addedAt = '2026/11/04';
  soft.items[0].id = 'not_kebab_case';
  const vSoft = lib.validateCatalog(soft);
  check('软告警不阻断（summary 超字数/addedAt 格式/id 非 kebab）',
    vSoft.ok === true && vSoft.warnings.some((w) => w.includes('summary')) && vSoft.warnings.some((w) => w.includes('addedAt'))
      && vSoft.warnings.some((w) => w.includes('kebab')), vSoft.warnings);

  const missingPath = join(newTemp('rw-lib-cat-'), 'missing.json');
  const lc1 = lib.loadCatalog({ catalogPath: missingPath });
  check('catalog 缺失 → loadCatalog UNAVAILABLE', lc1.ok === false && lc1.code === 'UNAVAILABLE' && lc1.reason === lib.UNAVAILABLE_REASON, lc1.reason);
  const wsC = newWs();
  writeFileSync(join(wsC, 'bad.json'), '{ not json', 'utf8');
  const lc2 = lib.loadCatalog({ catalogPath: join(wsC, 'bad.json') });
  check('catalog 损坏 → UNAVAILABLE（不抛异常）', lc2.ok === false && lc2.code === 'UNAVAILABLE' && /JSON/.test(lc2.reason), lc2.reason);
  const wsGood = newWs();
  const catPath = writeCatalog(wsGood, baseCatalog());
  const lc3 = lib.loadCatalog({ catalogPath: catPath });
  check('合法 catalog 加载成功并缓存（同 mtime/size 复用）', lc3.ok === true && !!lc3.catalog
    && lib.loadCatalog({ catalogPath: catPath }).catalog === lc3.catalog);
  check('默认路径为插件 reference/fde-library/catalog.json', lib.catalogDefaultPath() === join(ROOT, 'reference', 'fde-library', 'catalog.json'), lib.catalogDefaultPath());
  process.env.FDE_LIBRARY_CATALOG_PATH = catPath;
  try {
    const lcEnv = lib.loadCatalog({});
    check('环境变量 FDE_LIBRARY_CATALOG_PATH 可覆盖默认目录（测试/多目录部署）', lcEnv.ok === true && lcEnv.path === catPath);
  } finally {
    if (PREV_CATALOG_ENV === undefined) delete process.env.FDE_LIBRARY_CATALOG_PATH;
    else process.env.FDE_LIBRARY_CATALOG_PATH = PREV_CATALOG_ENV;
  }
}

/* ================= 1. 无缓存视图（§19.8-2） ================= */
section('1. 无缓存 / catalog 缺失时的 status 视图');
{
  const ws = newWs();
  const catPath = writeCatalog(ws, baseCatalog());
  const st = lib.status(ws, { catalogPath: catPath });
  check('无缓存：{ok:true, feed:null, stale:true, refreshing:false}',
    st.ok === true && st.feed === null && st.stale === true && st.refreshing === false, { ok: st.ok, feed: st.feed, stale: st.stale });
  check('无缓存时返回 catalog 版本信息', st.catalog && st.catalog.version === 1 && st.catalog.updatedAt === '2026-11-04', st.catalog);

  const stMissing = lib.status(ws, { catalogPath: join(ws, 'nope.json') });
  check('catalog 缺失：{ok:false, code:UNAVAILABLE} 且带旧 feed（此处 null）',
    stMissing.ok === false && stMissing.code === 'UNAVAILABLE' && stMissing.feed === null && stMissing.stale === true, stMissing);
}

/* ================= 2. 刷新：GitHub 合并 / 失败降级 / 社区映射（§19.8-3、5） ================= */
section('2. 首次刷新：GitHub 指标合并 + 单仓 403 降级 + 社区映射');
let ws2 = null;
let catPath2 = null;
{
  ws2 = newWs();
  catPath2 = writeCatalog(ws2, baseCatalog());
  writeScys(ws2, scysPayload());
  lib.resetLibraryState();
  const gh = mockGithub({ behavior: { 'anthropics/anthropic-cookbook': 'http-403' }, metrics: { 'openai/openai-agents-python': { stars: 12345, forks: 678, license: 'Apache-2.0', language: 'Python', pushedAt: '2026-11-03T00:00:00Z' } } });
  const r = await lib.refresh(ws2, Object.assign({ catalogPath: catPath2, fetchImpl: gh }, FAST));
  const f = r.feed || {};
  check('刷新成功：ok + feed.ok + stale=false', r.ok === true && f.ok === true && r.stale === false, { ok: r.ok, code: r.code });
  check('缓存落盘 <root>/research/.fde/fde-library.json', existsSync(lib.feedPath(ws2)) && lib.feedPath(ws2) === join(ws2, 'research', '.fde', 'fde-library.json'));
  check('原子写后 JSON 可解析且无 .tmp 残留',
    (() => { try { return Array.isArray(JSON.parse(readFileSync(lib.feedPath(ws2), 'utf8')).items); } catch { return false; } })()
      && readdirSync(join(ws2, 'research', '.fde')).filter((x) => x.includes('.tmp-')).length === 0);

  const os1 = f.items.find((x) => x.id === 'openai-agents-python');
  check('GitHub 指标合并：staticMeta 覆盖为实测 + liveMeta 记录',
    os1 && os1.staticMeta.stars === 12345 && os1.staticMeta.forks === 678 && os1.staticMeta.license === 'Apache-2.0'
      && os1.liveMeta && os1.liveMeta.stars === 12345 && os1.liveMeta.language === 'Python' && !!os1.liveMeta.fetchedAt, os1 && os1.staticMeta);
  const os2 = f.items.find((x) => x.id === 'anthropic-cookbook');
  check('单个仓库 403：保留旧值、不阻断其它条目', os2 && os2.staticMeta.stars === 7 && os2.liveMeta === null, os2 && os2.staticMeta);
  const ghSrc = (f.sources || []).find((x) => x.key === 'github');
  check('sources.github：requested/okCount/errors 记录（2 请求 1 失败）',
    ghSrc && ghSrc.requested === 2 && ghSrc.okCount === 1 && ghSrc.errors.length === 1
      && ghSrc.errors[0].repo === 'anthropics/anthropic-cookbook' && /403/.test(ghSrc.errors[0].error), ghSrc);
  check('feed.ok 仍为 true，warnings 提示 GitHub 未全量更新',
    f.ok === true && f.warnings.some((w) => w.includes('GitHub 指标未更新')), f.warnings);
  const noTrack = f.items.find((x) => x.id === 'repo-no-track');
  check('track=false 的仓库不参与刷新（保留策展 staticMeta、无 liveMeta）',
    noTrack && noTrack.staticMeta.stars === 3 && noTrack.liveMeta === null && !gh.calls.some((c) => c.repo === 'o/no'));
  check('GitHub 请求带 UA / Accept、不带 token / Authorization',
    gh.calls.every((c) => c.headers['user-agent'] === lib.GITHUB_UA && c.headers.accept === lib.GITHUB_ACCEPT
      && !Object.keys(c.headers).some((k) => k.toLowerCase() === 'authorization')), gh.calls[0] && gh.calls[0].headers);
  check('GitHub 请求带 AbortSignal（10s 超时实现）', gh.calls.every((c) => c.hasSignal === true));

  const community = f.items.filter((x) => x.group === 'community');
  check('社区动态映射为 group=community / kind=post / authority=C / stages=["all"]',
    community.length === 2 && community.every((x) => x.kind === 'post' && x.authority === 'C'
      && JSON.stringify(x.stages) === JSON.stringify(['all'])), community.map((x) => x.id));
  check('社区条目 id = community:<scys id> 且带 author/publishedAt/stats/tags',
    community[0] && community[0].id === 'community:xq:22255154882458281'
      && community[0].community.author === '苍述' && !!community[0].community.publishedAt
      && community[0].community.stats.like === 395 && community[0].community.tags.includes('精华'), community[0] && community[0].community);
  check('社区摘要去 HTML/截断 ≤200 字', community.every((x) => typeof x.summary === 'string' && x.summary.length <= lib.COMMUNITY_SUMMARY_MAX));
  check('社区条目按 publishedAt 倒序', (() => {
    const ts = community.map((x) => Date.parse(x.community.publishedAt));
    return ts.every((t, i) => i === 0 || ts[i - 1] >= t);
  })());

  const catSrc = (f.sources || []).find((x) => x.key === 'catalog');
  const cmSrc = (f.sources || []).find((x) => x.key === 'community');
  check('sources：catalog / github / community 三项齐全',
    catSrc && catSrc.ok === true && catSrc.items === 6 && cmSrc && cmSrc.ok === true && cmSrc.items === 2 && cmSrc.date === TODAY, f.sources);
  check('stats 计数（total/分组/featured/new/updated）',
    f.stats.total === 8 && f.stats.intlOfficial === 1 && f.stats.cnOfficial === 1 && f.stats.opensource === 3
      && f.stats.method === 1 && f.stats.community === 2 && f.stats.featured === f.featured.length, f.stats);
  check('feed 数据模型字段齐全（version/date/fetchedAt/catalogVersion/catalogUpdatedAt）',
    f.version === 1 && f.date === TODAY && Number.isFinite(Date.parse(f.fetchedAt)) && f.catalogVersion === 1 && f.catalogUpdatedAt === '2026-11-04', f);
  check('首版全部 isNew=true（无上一版缓存可比对）', f.items.every((x) => x.isNew === true) && f.stats.new === 8, f.stats.new);

  const st = lib.status(ws2, { catalogPath: catPath2 });
  check('刷新后 status：ok/stale=false/refreshing=false', st.ok === true && st.stale === false && st.refreshing === false && st.feed.items.length === 8);
  check('readFeed 与 status 读同一份缓存', lib.readFeed(ws2).feed && lib.readFeed(ws2).feed.items.length === 8);
  check('catalog 未被刷新改写（只读策展层）', lib.loadCatalog({ catalogPath: catPath2 }).catalog.items[2].staticMeta.stars === 11);

  /* 每日一次门控（§19.8-4） */
  const callsAfter = gh.calls.length;
  const skip = await lib.maybeRefresh(ws2, Object.assign({ catalogPath: catPath2, fetchImpl: gh }, FAST));
  check('同一天第二次 maybeRefresh 跳过且不发请求', skip.skipped === true && gh.calls.length === callsAfter, { skipped: skip.skipped, calls: gh.calls.length });
  check('跳过时仍返回当日 feed（stale=false）', skip.feed && skip.stale === false);

  /* force 可再刷（§19.8-4） */
  const forced = await lib.maybeRefresh(ws2, Object.assign({ catalogPath: catPath2, fetchImpl: gh, force: true }, FAST));
  check('force 再刷不受「每天一次」限制', forced.ok === true && forced.skipped !== true && gh.calls.length > callsAfter, { calls: gh.calls.length });
}

/* ================= 3. isNew / updated 差分（§19.8-6） ================= */
section('3. isNew / updated 差分');
{
  lib.resetLibraryState();
  const ws = newWs();
  const catPath = writeCatalog(ws, baseCatalog());
  lib.resetLibraryState();
  const gh1 = mockGithub({ metrics: { 'openai/openai-agents-python': { stars: 100, forks: 1, license: 'MIT', language: 'Python', pushedAt: '2026-11-01T00:00:00Z' } } });
  const r1 = await lib.refresh(ws, Object.assign({ catalogPath: catPath, fetchImpl: gh1 }, FAST));
  check('（准备）首版刷新成功', r1.ok === true);

  const gh2 = mockGithub({ metrics: { 'openai/openai-agents-python': { stars: 100, forks: 1, license: 'MIT', language: 'Python', pushedAt: '2026-11-01T00:00:00Z' } } });
  const r2 = await lib.refresh(ws, Object.assign({ catalogPath: catPath, fetchImpl: gh2 }, FAST));
  const byId = (f) => new Map(f.items.map((x) => [x.id, x]));
  const m2 = byId(r2.feed);
  check('同数据再刷：GitHub 指标未变 → updated=false', r2.feed.stats.updated === 0 && m2.get('openai-agents-python').updated === false, r2.feed.stats);
  check('addedAt 在 7 天内的条目保持 isNew=true（addedAt −1/−3 天）',
    m2.get('openai-agents-guide').isNew === true && m2.get('internal-scenario-template').isNew === true, {
      guide: m2.get('openai-agents-guide').isNew, tmpl: m2.get('internal-scenario-template').isNew,
    });
  check('旧条目（addedAt −10/−20/−30 天）isNew=false', m2.get('openai-agents-python').isNew === false
    && m2.get('anthropic-cookbook').isNew === false && m2.get('tencent-cloud-fde').isNew === false);

  /* GitHub 指标变化 → updated */
  const gh3 = mockGithub({ metrics: { 'openai/openai-agents-python': { stars: 999, forks: 9, license: 'MIT', language: 'Python', pushedAt: '2026-11-02T00:00:00Z' } } });
  const r3 = await lib.refresh(ws, Object.assign({ catalogPath: catPath, fetchImpl: gh3 }, FAST));
  const m3 = byId(r3.feed);
  check('GitHub 指标变化 → updated=true 且 stats.updated 计数', m3.get('openai-agents-python').updated === true && r3.feed.stats.updated >= 1,
    { updated: m3.get('openai-agents-python').updated, stats: r3.feed.stats.updated });

  /* 目录新增条目 → isNew=true，旧条目不残留 */
  const cat2 = baseCatalog();
  cat2.items.push(item({ id: 'brand-new-item', group: 'method', kind: 'doc', title: '新增资料', url: 'https://example.invalid/new-item', addedAt: localDate(-60) }));
  const catPath2 = writeCatalog(ws, cat2);
  const gh4 = mockGithub({ metrics: { 'openai/openai-agents-python': { stars: 999, forks: 9, license: 'MIT', language: 'Python', pushedAt: '2026-11-02T00:00:00Z' } } });
  const r4 = await lib.refresh(ws, Object.assign({ catalogPath: catPath2, fetchImpl: gh4 }, FAST));
  const m4 = byId(r4.feed);
  check('目录新增条目 isNew=true（即使 addedAt 很旧）', m4.get('brand-new-item') && m4.get('brand-new-item').isNew === true);
  check('未变化条目 isNew=false（旧牌不残留）', m4.get('tencent-cloud-fde').isNew === false);
}

/* ================= 4. featured 排序（§19.8-6 / §19.3） ================= */
section('4. 重点推荐排序（star → featured → addedAt → 阶段覆盖；每组 ≥1；≤12）');
{
  const ws = newWs();
  const cat = { version: 1, updatedAt: TODAY, notes: [], groups: baseGroups(), items: [] };
  cat.items.push(item({ id: 'f-star', group: 'intl-official', title: '★重点：star 但非 featured', recommend: 'star', featured: false, addedAt: localDate(-100), stages: ['scoping'] }));
  cat.items.push(item({ id: 'f-featured', group: 'intl-official', title: 'featured 但非 star', recommend: 'recommend', featured: true, addedAt: localDate(-1), stages: ['all'] }));
  cat.items.push(item({ id: 'g-cn', group: 'cn-official', recommend: 'backup', addedAt: localDate(-50) }));
  cat.items.push(item({ id: 'g-os', group: 'opensource', kind: 'repo', recommend: 'backup', addedAt: localDate(-50), repo: 'o/x', track: false }));
  cat.items.push(item({ id: 'g-method-all', group: 'method', recommend: 'backup', featured: true, addedAt: localDate(-40), stages: ['all'] }));
  cat.items.push(item({ id: 'g-method-one', group: 'method', recommend: 'backup', featured: true, addedAt: localDate(-40), stages: ['solution'] }));
  /* 权威性 tie-break：同 star/featured/addedAt/stages，A 应排在 B 之前 */
  cat.items.push(item({ id: 'auth-b', group: 'intl-official', authority: 'B', recommend: 'star', featured: true, addedAt: localDate(-5), stages: ['all'] }));
  cat.items.push(item({ id: 'auth-a', group: 'intl-official', authority: 'A', recommend: 'star', featured: true, addedAt: localDate(-5), stages: ['all'] }));
  /* 人工策展位：featuredRank 小者优先，可压过权威性（FDE 专属资料优先于通用资料） */
  cat.items.push(item({ id: 'rank-2', group: 'intl-official', authority: 'A', recommend: 'star', featured: true, addedAt: localDate(-5), stages: ['all'], featuredRank: 2 }));
  cat.items.push(item({ id: 'rank-1', group: 'intl-official', authority: 'B', recommend: 'star', featured: true, addedAt: localDate(-5), stages: ['all'], featuredRank: 1 }));
  /* 8 条同组低优先条目，把总数推到 > 12，验证上限 */
  for (let i = 0; i < 8; i += 1) {
    cat.items.push(item({ id: 'extra-' + i, group: 'intl-official', recommend: 'backup', addedAt: localDate(-60 - i) }));
  }
  const catPath = writeCatalog(ws, cat);
  writeScys(ws, { version: 1, date: TODAY, items: [{ id: 'xq:9', kind: 'post', title: '社区', summary: '社区摘要', author: 'a', url: 'https://scys.com/a', publishedAt: '2026-11-02T00:00:00Z', tags: [], stats: {}, isNew: false }] });
  lib.resetLibraryState();
  const r = await lib.refresh(ws, Object.assign({ catalogPath: catPath, fetchImpl: mockGithub() }, FAST));
  const f = r.feed;
  const idx = (id) => f.featured.indexOf(id);
  check('featured 总数 ≤12', f.featured.length > 0 && f.featured.length <= lib.FEATURED_MAX, f.featured.length);
  check('recommend=star 优先于 featured（f-star 在 f-featured 之前）', idx('f-star') >= 0 && idx('f-featured') >= 0 && idx('f-star') < idx('f-featured'),
    { star: idx('f-star'), featured: idx('f-featured') });
  check('「同一来源组至少 1 条」：5 个来源组都在 featured 中',
    ['intl-official', 'cn-official', 'opensource', 'method', 'community'].every((g) => f.featured.some((id) => (f.items.find((x) => x.id === id) || {}).group === g)),
    f.featured.map((id) => ((f.items.find((x) => x.id === id) || {}).group || '?') + ':' + id));
  check('阶段覆盖数作次序 tie-break（all 在单阶段之前）', idx('g-method-all') >= 0 && idx('g-method-one') >= 0 && idx('g-method-all') < idx('g-method-one'),
    { all: idx('g-method-all'), one: idx('g-method-one') });
  check('权威性 A 优先于 B（同 star/featured/addedAt/stages）', idx('auth-a') >= 0 && idx('auth-b') >= 0 && idx('auth-a') < idx('auth-b'),
    { a: idx('auth-a'), b: idx('auth-b') });
  check('人工策展位 featuredRank 小者优先（rank-1 在 rank-2 之前，可压过 B/A 权威性）',
    idx('rank-1') >= 0 && idx('rank-2') >= 0 && idx('rank-1') < idx('rank-2'),
    { r1: idx('rank-1'), r2: idx('rank-2') });
  check('featured 内 id 均存在且唯一', new Set(f.featured).size === f.featured.length && f.featured.every((id) => f.items.some((x) => x.id === id)));
  check('stats.featured = featured.length', f.stats.featured === f.featured.length, f.stats.featured);
  const compactF = lib.compactFeed(lib.status(ws, { catalogPath: catPath }), { featured: true, limit: 3 });
  check('compactFeed(featured) 按 featured 顺序返回且 limit 生效', compactF.items.length === 3
    && compactF.items.map((x) => x.id).join(',') === f.featured.slice(0, 3).join(','), compactF.items.map((x) => x.id));
}

/* ================= 5. GitHub 约束：≤30 / 并发 ≤3 / 10s 超时（§19.2） ================= */
section('5. GitHub 刷新约束（≤30 仓库、并发 ≤3、超时降级）');
{
  check('常量符合 spec：10s 超时 / 并发 3 / ≤30', lib.GITHUB_TIMEOUT_MS === 10000 && lib.GITHUB_CONCURRENCY === 3 && lib.GITHUB_TRACK_MAX === 30);
  const items = [];
  for (let i = 0; i < 31; i += 1) items.push({ id: 'r' + i, repo: 'owner/repo-' + i, track: true, staticMeta: {} });
  items.push({ id: 'untracked', repo: 'owner/untracked', track: false, staticMeta: {} });
  const gh = mockGithub({ delayMs: 3 });
  const res = await lib.refreshGithub(items, { fetchImpl: gh, githubTimeoutMs: 2000 });
  check('单日 ≤30 个仓库（31 个仅取前 30，track=false 排除）', res.requested === 30 && gh.calls.length === 30, { requested: res.requested, calls: gh.calls.length });
  check('并发 ≤3', gh.maxInFlight() <= lib.GITHUB_CONCURRENCY && gh.maxInFlight() >= 2, gh.maxInFlight());
  check('全部成功 okCount=30 / errors 空', res.okCount === 30 && res.errors.length === 0, res);

  const hang = mockGithub({ behavior: { 'owner/hang': 'hang' }, delayMs: 0 });
  const t0 = Date.now();
  const resTimeout = await lib.refreshGithub([{ id: 'h', repo: 'owner/hang', track: true }], { fetchImpl: hang, githubTimeoutMs: 40 });
  check('单请求超时 → 记 error（不挂死，不抛）', resTimeout.requested === 1 && resTimeout.okCount === 0
    && resTimeout.errors.length === 1 && /超时/.test(resTimeout.errors[0].error), resTimeout.errors);
  check('超时在设定时间附近返回（< 2s）', Date.now() - t0 < 2000);

  const savedFetch = globalThis.fetch;
  globalThis.fetch = undefined;
  let resNoFetch = null;
  try {
    resNoFetch = await lib.refreshGithub([{ id: 'x', repo: 'a/b', track: true }], {});
  } finally {
    globalThis.fetch = savedFetch;
  }
  check('无 fetch 环境 → 记 error 不抛', resNoFetch.okCount === 0 && resNoFetch.errors.length === 1 && /fetch/.test(resNoFetch.errors[0].error), resNoFetch.errors);
}

/* ================= 6. 失败保留旧 feed + 当天重试上限 3（§19.8-4） ================= */
section('6. 失败保留旧 feed / 当天最多重试 3 次 / force 可越过');
{
  const ws = newWs();
  const catPath = writeCatalog(ws, baseCatalog());
  lib.resetLibraryState();
  const okR = await lib.refresh(ws, Object.assign({ catalogPath: catPath, fetchImpl: mockGithub() }, FAST));
  check('（准备）成功写入旧 feed', okR.ok === true && okR.feed.items.length === 6);
  /* 把缓存日期改成昨天，模拟「今天未更新」 */
  const staleFeed = JSON.parse(readFileSync(lib.feedPath(ws), 'utf8'));
  staleFeed.date = localDate(-1);
  writeFeedRaw(ws, staleFeed);
  const missingCat = join(ws, 'no-catalog.json');
  const noFetch = () => { throw new Error('不应发起网络请求'); };
  const f1 = await lib.maybeRefresh(ws, { catalogPath: missingCat, fetchImpl: noFetch });
  check('刷新失败保留旧 feed（6 条不变）', f1.ok === false && f1.code === 'UNAVAILABLE' && f1.feed && f1.feed.items.length === 6, f1.feed && f1.feed.items.length);
  const stAfterFail = lib.status(ws, { catalogPath: catPath });
  check('失败后旧 feed 文件未被破坏（仍可读）', stAfterFail.ok === true && stAfterFail.feed.items.length === 6);
  const f2 = await lib.maybeRefresh(ws, { catalogPath: missingCat, fetchImpl: noFetch });
  const f3 = await lib.maybeRefresh(ws, { catalogPath: missingCat, fetchImpl: noFetch });
  check('前 3 次真实尝试且失败', f1.ok === false && f2.ok === false && f3.ok === false);
  const f4 = await lib.maybeRefresh(ws, { catalogPath: missingCat, fetchImpl: noFetch });
  check('第 4 次跳过：code=RETRY_LIMIT，不再尝试', f4.ok === false && f4.code === 'RETRY_LIMIT' && f4.skipped === true);
  const fForce = await lib.maybeRefresh(ws, { catalogPath: missingCat, fetchImpl: noFetch, force: true });
  check('force 越过当天重试上限（人工手动刷新）', fForce.ok === false && fForce.code !== 'RETRY_LIMIT', fForce.code);

  /* 缓存日期为今天时：无 force 跳过，force 才会刷 */
  lib.resetLibraryState();
  const ws2b = newWs();
  const cat2b = writeCatalog(ws2b, baseCatalog());
  await lib.refresh(ws2b, Object.assign({ catalogPath: cat2b, fetchImpl: mockGithub() }, FAST));
  const skip2 = await lib.maybeRefresh(ws2b, { catalogPath: cat2b, fetchImpl: mockGithub() });
  check('当日已有缓存：maybeRefresh 跳过（不重复抓）', skip2.skipped === true);
}

/* ================= 7. 社区缓存缺失 / 损坏不阻断（§19.8-5） ================= */
section('7. 社区动态：缓存缺失不报错 / 损坏降级');
{
  const ws = newWs();
  const catPath = writeCatalog(ws, baseCatalog());
  lib.resetLibraryState();
  const r = await lib.refresh(ws, Object.assign({ catalogPath: catPath, fetchImpl: mockGithub() }, FAST));
  const cm = (r.feed.sources || []).find((x) => x.key === 'community');
  check('scys-fde.json 缺失：刷新仍 ok，社区来源为空且不报错',
    r.ok === true && cm && cm.ok === true && cm.items === 0 && r.feed.stats.community === 0, cm);
  check('缺失时 warnings 如实提示社区来源为空', r.feed.warnings.some((w) => w.includes('社区')), r.feed.warnings);

  const ws2 = newWs();
  const catPath2 = writeCatalog(ws2, baseCatalog());
  writeScys(ws2, '{ not json');
  lib.resetLibraryState();
  const r2 = await lib.refresh(ws2, Object.assign({ catalogPath: catPath2, fetchImpl: mockGithub() }, FAST));
  const cm2 = (r2.feed.sources || []).find((x) => x.key === 'community');
  check('社区缓存损坏：feed.ok=true，sources.community 记 error 并 warning',
    r2.ok === true && r2.feed.ok === true && cm2 && cm2.ok === false && !!cm2.error
      && r2.feed.warnings.some((w) => w.includes('社区')), { source: cm2, warnings: r2.feed.warnings });
}

/* ================= 8. 损坏缓存重建 / 原子写（§19.8 补充） ================= */
section('8. 损坏缓存 → 空视图重建，不抛异常');
{
  const ws = newWs();
  const catPath = writeCatalog(ws, baseCatalog());
  mkdirSync(join(ws, 'research', '.fde'), { recursive: true });
  writeFileSync(lib.feedPath(ws), '{ this is not json', 'utf8');
  const read = lib.readFeed(ws);
  check('损坏 JSON：readFeed → feed=null + corrupt=true', read.feed === null && read.corrupt === true);
  const st = lib.status(ws, { catalogPath: catPath });
  check('损坏缓存 status：feed=null/stale=true 且 warning 提示', st.ok === true && st.feed === null && st.stale === true
    && st.warnings.some((w) => w.includes('损坏')), st.warnings);
  lib.resetLibraryState();
  const r = await lib.refresh(ws, Object.assign({ catalogPath: catPath, fetchImpl: mockGithub() }, FAST));
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(lib.feedPath(ws), 'utf8')); } catch { parsed = null; }
  check('刷新后重建有效缓存（可解析、含 items/featured/sources）',
    r.ok === true && parsed && Array.isArray(parsed.items) && Array.isArray(parsed.featured) && Array.isArray(parsed.sources));
}

/* ================= 9. catalog 缺失时带旧 feed（§19.4） ================= */
section('9. catalog 缺失 → UNAVAILABLE 同时带旧 feed');
{
  const ws = newWs();
  const catPath = writeCatalog(ws, baseCatalog());
  lib.resetLibraryState();
  await lib.refresh(ws, Object.assign({ catalogPath: catPath, fetchImpl: mockGithub() }, FAST));
  const st = lib.status(ws, { catalogPath: join(ws, 'gone.json') });
  check('status：ok=false/code=UNAVAILABLE 且带旧 feed',
    st.ok === false && st.code === 'UNAVAILABLE' && st.feed && st.feed.items.length === 6, st);
  const r = await lib.refresh(ws, { catalogPath: join(ws, 'gone.json'), fetchImpl: mockGithub() });
  check('refresh：UNAVAILABLE 且保留旧 feed（不覆盖缓存）',
    r.ok === false && r.code === 'UNAVAILABLE' && r.feed && r.feed.items.length === 6
      && lib.readFeed(ws).feed.items.length === 6, r.reason);
}

/* ================= 10. compactFeed 过滤（工具口径） ================= */
section('10. compactFeed 过滤（group/kind/stage/q/limit）');
{
  const ws = newWs();
  const catPath = writeCatalog(ws, baseCatalog());
  writeScys(ws, scysPayload());
  lib.resetLibraryState();
  await lib.refresh(ws, Object.assign({ catalogPath: catPath, fetchImpl: mockGithub() }, FAST));
  const st = lib.status(ws, { catalogPath: catPath });
  const all = lib.compactFeed(st, { limit: 50 });
  check('limit 生效（默认 20 / 最大 50）', all.total === 8 && all.items.length === 8);
  const opensource = lib.compactFeed(st, { group: 'opensource', limit: 50 });
  check('group 过滤（opensource=3）', opensource.matched === 3 && opensource.items.every((x) => x.group === 'opensource'));
  const repos = lib.compactFeed(st, { kind: 'repo', limit: 50 });
  check('kind 过滤（repo=3）', repos.matched === 3 && repos.items.every((x) => x.kind === 'repo'));
  const scoping = lib.compactFeed(st, { stage: 'scoping', limit: 50 });
  check('stage 过滤（scoping = all + scoping）', scoping.matched === 7
    && scoping.items.every((x) => x.stages.includes('all') || x.stages.includes('scoping')), scoping.items.map((x) => x.id));
  const kw = lib.compactFeed(st, { q: 'agent', limit: 50 });
  check('q 关键词过滤（标题/摘要/主题）', kw.matched >= 2 && kw.items.every((x) => JSON.stringify([x.title, x.summary, x.why, x.topics]).toLowerCase().includes('agent')));
  const lim = lib.compactFeed(st, { limit: 2 });
  check('limit 截断但 matched/total 仍为全量', lim.items.length === 2 && lim.total === 8 && lim.matched === 8);
  const bad = lib.compactFeed(st, { group: 'nope', kind: 'nope', limit: 999 });
  check('非法 group/kind 被忽略（不报错）且 limit 上限 50', bad.group === '' && bad.kind === '' && bad.limit === 50);
}

/* ================= 11. index.js：2 条路由 + fde_library 工具 + 定时器 ================= */
section('11. index.js：library 路由 / fde_library 工具 / 定时器注册');
{
  const mod = await import(join(ROOT, 'index.js'));
  const ws = newWs();
  const catPath = writeCatalog(ws, baseCatalog());
  /* 工具/路由走模块默认 catalog 路径：用环境变量覆盖到临时 catalog（测试隔离，不影响生产默认） */
  process.env.FDE_LIBRARY_CATALOG_PATH = catPath;
  lib.resetLibraryState();
  await lib.refresh(ws, Object.assign({ catalogPath: catPath, fetchImpl: mockGithub() }, FAST));

  const tools = [];
  const routes = [];
  const sections = [];
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn, name) { effects.push({ fn, name }); return () => {}; },
    get(n) {
      if (n === 'tools') return { register(d) { tools.push(d); return () => {}; } };
      if (n === 'webServer') return { register(d) { routes.push(d); return () => {}; } };
      if (n === 'systemPrompt') return { section(d) { sections.push(d); }, getSectionOrder() { return 2950; } };
      if (n === 'workspaceRegistry') return { list() { return [{ id: 'ws-lib', path: ws, updatedAt: new Date().toISOString() }]; } };
      return undefined;
    },
  };
  mod.apply(ctx);
  const feedRoute = routes.find((r) => r.path === '/research-workbench/api/fde/library/feed');
  const refreshRoute = routes.find((r) => r.path === '/research-workbench/api/fde/library/refresh');
  check('注册路由 library/feed 与 library/refresh', !!feedRoute && !!refreshRoute
    && typeof feedRoute.handler === 'function' && typeof refreshRoute.handler === 'function');
  const tool = tools.find((t) => t.name === 'fde_library');
  check('注册第 9 个 FDE 工具 fde_library', !!tool && typeof tool.execute === 'function'
    && tool.parameters && tool.parameters.type === 'object' && tool.parameters.required.includes('action'));
  const promptText = (sections[0] && sections[0].text) || '';
  check('系统提示词含资料库口径（fde_library / A·B·C / 摘要非全文 / 8 阶段）',
    promptText.includes('fde_library') && promptText.includes('资料库') && promptText.includes('A/B/C')
      && promptText.includes('摘要') && promptText.includes('8 个阶段') && promptText.includes('fde_scenario') && promptText.includes('fde_quote'));

  const feedOut = await tool.execute({ action: 'feed', root: ws });
  check('工具 feed：ok + 缓存条数 + 统计/口径提示', feedOut.ok === true && feedOut.items.length === 6
    && feedOut.stats.total === 6 && feedOut.text.includes('口径') && feedOut.text.includes('人工策展')
    && feedOut.text.includes('https://'), { ok: feedOut.ok, n: feedOut.items && feedOut.items.length });
  const searchOut = await tool.execute({ action: 'search', root: ws, group: 'opensource', featured: false });
  check('工具 search：group 过滤生效', searchOut.ok === true && searchOut.items.length === 3
    && searchOut.items.every((x) => x.group === 'opensource'));
  const featOut = await tool.execute({ action: 'feed', root: ws, featured: true, limit: 5 });
  check('工具 feed featured=true：仅重点推荐', featOut.ok === true && featOut.items.length > 0
    && featOut.items.every((x) => (feedOut.feed.featured || []).includes(x.id)));
  const badAction = await tool.execute({ action: 'nope', root: ws });
  check('工具未知 action → ok:false/INVALID，不抛异常', badAction.ok === false && badAction.code === 'INVALID');

  const callRoute = async (route, pathWithQuery, method, body) => {
    if (!route) return { status: 599, payload: { ok: false, reason: '路由未注册' } };
    let status = 200; let payload = null;
    const headers = method === 'POST' ? { 'content-type': 'application/json' } : {};
    const req = { method, url: pathWithQuery, headers, on() {}, destroy() {} };
    if (method === 'POST') {
      const chunks = [Buffer.from(JSON.stringify(body || {}))];
      req.on = (ev, cb) => { if (ev === 'data') chunks.forEach(cb); if (ev === 'end') cb(); return req; };
    }
    const res = { set statusCode(v) { status = v; }, get statusCode() { return status; }, setHeader() {}, end(t) { try { payload = JSON.parse(String(t)); } catch { payload = { raw: String(t) }; } } };
    await route.handler(req, res);
    return { status, payload };
  };
  const g = await callRoute(feedRoute, '/research-workbench/api/fde/library/feed', 'GET');
  check('GET library/feed → 200 + feed（读缓存）', g.status === 200 && g.payload.ok === true && g.payload.feed && g.payload.feed.items.length === 6,
    { status: g.status, ok: g.payload && g.payload.ok, reason: g.payload && g.payload.reason });
  const m405 = await callRoute(refreshRoute, '/research-workbench/api/fde/library/refresh', 'GET');
  check('GET library/refresh → 405（方法白名单）', m405.status === 405, m405.status);

  const timerEffects = effects.filter((e) => String(e.name || '').includes('library timer'));
  check('注册 library 定时器（ctx.effect + 名称）', timerEffects.length === 1, effects.map((e) => e.name));
  let disposed = false;
  try {
    const dispose = timerEffects[0].fn();
    check('定时器 effect 返回清理函数', typeof dispose === 'function');
    dispose();
    disposed = true;
  } catch (e) { check('定时器 effect 返回清理函数', false, String(e && e.message)); }
  check('定时器清理函数可调用（卸载即停）', disposed === true);
  check('全程未发生真实网络请求（global fetch 调用次数 0）', globalFetchCalls === 0, globalFetchCalls);
}

/* ---------------- 汇总 ---------------- */
console.log('\n=== 通过 ' + passed.length + ' 项 ===');
if (failed.length) {
  console.log('\n=== 失败 ' + failed.length + ' 项 ===');
  for (const f of failed) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('FDE 资料库宿主单测全部通过（mock GitHub，未联网）。');
}
cleanup();
