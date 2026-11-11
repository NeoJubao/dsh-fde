/**
 * FDE 工作站 · 独立验收审计（第三方视角，不参与实现）
 *
 * 用途：按 docs/01-spec.md 的契约**独立**写断言，再对照实现找「既有测试没覆盖到的真问题」。
 * v1.3（2026-11-04）：口径更新为 8 阶段 / 8 门禁 / 9 类型 / 25 条 FDE 路由 / 16 工具
 * （rw*5 + FDE 11）/ 16 技能 / 5 页签（v1.4 起，ADR 0005）；新增 §19 资料库、§20 流程 v2、§21 两个计算工具的独立断言。
 * 开源改造（ADR 0004）：新增第 37 条路由 /fde/scys/auth；package.json 允许可选 peerDependencies。
 * 与既有 verify/*.mjs 的分工：
 *   - fde-host.mjs   宿主内核单测 A1–A9（实现者视角）
 *   - security.mjs   路由守卫冒烟（实现者视角）
 *   - 本脚本          第三方验收：路由契约/错误码/路径与 fail-safe/红线/提示词闭环/
 *                     客户端⇄宿主一致性/元数据单点/skills 降级/真实工作区只读扫描/并发与状态污染
 * 报告：verify/audit-report.md（P0/P1/P2 + 证据 + 无法验证项）
 *
 * 用法: node verify/acceptance-audit.mjs
 *        FDE_WORKSPACE=<含 research/ 的工作区根> node verify/acceptance-audit.mjs
 * 约束:
 *   - 只写 os.tmpdir()；插件源码只读；
 *   - 工作区（默认插件上一级，可用 FDE_WORKSPACE 指定）只做一次只读 adopt scan，绝不调用任何写路由；
 *     该工作区没有 research/ 时（如干净检出 / CI / npm 包解压目录）跳过这段并记 WARN，不判失败；
 *   - 不 import 被测模块的内部私有符号（只走 fde-api / fde-schema / fde-store / fde-prompts 公开导出），
 *     宿主半走 index.js + 替身 ctx（自己写，不复用 verify/*.mjs 的断言）。
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync,
  statSync, rmSync, cpSync, symlinkSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __toUrl = (p) => (String(p).startsWith('file:') ? p : pathToFileURL(p).href);

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, '..');
const REAL_ROOT = resolve(PLUGIN, '..'); // 工作区根；只读扫描用

const store = await import(__toUrl(join(PLUGIN, 'src', 'host', 'fde-store.js')));
const schema = await import(__toUrl(join(PLUGIN, 'src', 'host', 'fde-schema.js')));
const api = await import(__toUrl(join(PLUGIN, 'src', 'host', 'fde-api.js')));
const rules = await import(__toUrl(join(PLUGIN, 'src', 'host', 'fde-rules.js')));
const prompts = await import(__toUrl(join(PLUGIN, 'src', 'host', 'fde-prompts.js')));
/* v1.3：资料库与两个计算工具（独立复算，不联网） */
const fdeLibrary = await import(__toUrl(join(PLUGIN, 'src', 'host', 'fde-library.js')));
const fdeCalc = await import(__toUrl(join(PLUGIN, 'src', 'host', 'fde-calc.js')));

/* 审计禁止联网：任何真实 fetch 都计一次调用并失败（资料库/GitHub 测试一律注入 mock fetchImpl）。 */
const REAL_FETCH = globalThis.fetch;
let globalFetchCalls = 0;
globalThis.fetch = (...args) => {
  globalFetchCalls += 1;
  return Promise.reject(new Error('审计脚本禁止联网（fetch 被拦截）'));
};
process.on('exit', () => { globalThis.fetch = REAL_FETCH; });


/* ============================ 断言器 / 发现登记 ============================ */

const FINDINGS = {
  F1: { sev: 'P1', title: '红线未在代码层阻断：agent 工具可推进/强制推进阶段、归档客户（新 spec §7：move/archive 只能由人执行）' },
  F2: { sev: 'P1', title: '会话闭环断点：engagement handoff 提示词要求 fde_item(report)，但没有 itemId、也没有「先建任务再回报」的指引' },
  F3: { sev: 'P1', title: '并发写无冲突保护：board 快照直接写回，GET /board 的 proposal 持久化与 agent 写并发时可能覆盖丢失 report（核心断言：并发 report 不丢）' },
  F4: { sev: 'P2', title: '状态污染：fde_brief apply=true 把派生的 artifacts 摘要写进 research/.fde/board.json' },
  F5: { sev: 'P2', title: '工具层未显式拒绝门禁勾选/force（新 spec §7：应返回 BLOCKED 且不落盘；现实现静默忽略）——口径已更新，非缺陷' },
  F6: { sev: 'P2', title: '路径保护降级：FDE 工件扫描/导入只做 safeDirName，不落 realpath 守卫，research 下符号链接目录会让扫描读到工作区外文件' },
  F7: { sev: 'P2', title: '语义不一致：暂停（paused）客户仍产生 stall/gate 派生注意力，与 refreshProposals 跳过 paused 的口径相反' },
  F8: { sev: 'P2', title: '工具错误结果缺 reason 字段（spec §7 要求参数校验失败返回 {ok:false, reason}）' },
};

const OBSERVATIONS = {
  O1: 'report.text 允许到 2000 字，「≤300 字摘要」只是提示词约定、无强校验',
  O2: 'refreshProposals 的 pending 上限把 created 重复计数，新 board 首轮最多只生成 4 条（仍 ≤8，不越界）',
  O3: 'engagementPrompt 的「说明：」引用不存在的 engagement.notes 字段，恒为空行',
  O4: 'lead 阶段 handoff 显示的是下一阶段（discovery）的门禁缺口，与 lead 阶段产物指引不匹配',
  O5: '创建客户不评估 intake 门禁（spec §2.1「进入该阶段前」），看板会显示缺项但创建不被拦',
  O6: 'spec §7 工具表列了 fde_item 的 delete 动作，实现有意移除并在 execute 兜底拒绝——建议在 spec 注记「红线优先」',
  O7: 'adopt apply 在每个目录循环里重扫全部候选（O(n²)），真实工作区 9 个候选下可接受',
  O8: 'sync 每次调用都会写 board 并生成备份，刷新频繁时备份噪音偏大',
  O9: '并发写第二轮：当前实现尚未暴露 revision 字段，等待 host-dev 的 CAS/stale 方案落地后再验',
  O13: '工件扫描 TTL 缓存签名不看子目录 mtime：既有子目录内新增文件后 5 秒内 gate/move 自动检查可能仍读旧扫描（spec §16.8 允许 TTL；瞬时口径风险）',
  O15: '/fde/health 未单列资料库检查项（catalog/缓存由 scripts/health-check.mjs 覆盖；spec 未硬性要求）',
  O16: 'catalog 新字段 featuredRank 与 track≤30 无校验：validateCatalog 只统计 track、不校验上限，featuredRank 非法值在归一化时静默丢弃（建议补 soft warning）',
};

let passed = 0;
const failed = [];
const findingsOpen = new Set();
const observationsHit = new Set();
/* 环境能力缺失导致的未验证项：显式记录，汇总里单列，不伪装成「通过」。 */
const skipped = [];
let sectionName = '';

function sec(name) {
  sectionName = name;
  console.log('\n── ' + name + ' ──');
}
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); return true; }
  const extra = detail === undefined ? '' : ' → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600));
  console.log('  ✗ ' + name + extra);
  failed.push('[' + sectionName + '] ' + name + extra);
  return false;
}
/** 与 spec 不符的检查：失败即登记为发现（脚本红 = 发现仍存在）。 */
function specCheck(id, cond, detail) {
  const f = FINDINGS[id];
  const ok = check('[' + id + '·' + f.sev + '] ' + f.title, cond, detail);
  if (!ok) findingsOpen.add(id);
  return ok;
}
/** 观察项：不判失败，只记录是否复现。 */
function note(id, cond, detail) {
  const hit = !!cond;
  if (hit) observationsHit.add(id);
  console.log('  ' + (hit ? '⚠' : '○') + ' [观察 ' + id + '] ' + OBSERVATIONS[id] + (hit ? '（已复现）' : '') +
    (detail === undefined ? '' : ' → ' + JSON.stringify(detail).slice(0, 300)));
}

/* ============================ 临时工作区 / 替身宿主 ============================ */

const createdRoots = [];
const rootIds = new Map();
let rootSeq = 0;
const hosts = [];
const copyDirs = [];

function newRoot(tag = 'ws') {
  const p = mkdtempSync(join(tmpdir(), 'fde-audit-' + tag + '-'));
  mkdirSync(join(p, 'research'), { recursive: true });
  createdRoots.push(p);
  rootIds.set(p, 'ws-' + tag + '-' + (++rootSeq));
  return p;
}
function registerNested(parent, name) {
  const p = join(parent, name);
  mkdirSync(join(p, 'research'), { recursive: true });
  createdRoots.push(p);
  rootIds.set(p, 'ws-nested-' + (++rootSeq));
  return p;
}
const idOf = (p) => rootIds.get(p) || 'ws-unknown';

const DAY = 86400000;
const iso = (n) => new Date(Date.now() + n * DAY).toISOString();
const dateStr = (n) => store.addDaysStr(n);

function makeProject(root, dir, files = {}) {
  const base = join(root, 'research', dir);
  for (const d of ['raw', 'research', 'meeting', 'proposal', 'pilot', 'delivery', 'adoption']) {
    mkdirSync(join(base, d), { recursive: true });
  }
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(base, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return base;
}

let hostSeq = 0;
/** 构建替身宿主（自己写；只在测试里记录注册项，不发真实网络/会话）。 */
async function applyMock(modulePath, opts = {}) {
  const capture = { tools: [], routes: [], sections: [], skills: [], sessions: [], prompts: [], threw: null };
  const missing = opts.missing || {};
  const currentRef = opts.currentRef || { root: '' };
  const skillsMode = opts.skillsMode || 'ok';
  const sessionMode = opts.sessionMode || 'ok';
  const bidIntelSvc = opts.bidIntel; /* 第三轮 §17：假招采服务注入（不读真实索引） */
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    /* 宿主定时器（生财/资料库刷新）注册后立即清理：审计不得联网、也不依赖定时器副作用。
     * Cordis effect 的回调返回 disposer；这里调用它等价于宿主卸载，避免 20s 后自动刷新发请求。 */
    effect(fn) {
      try {
        const d = typeof fn === 'function' ? fn() : undefined;
        if (typeof d === 'function') { try { d(); } catch { /* 清理失败不影响断言 */ } }
        return () => {};
      } catch { return () => {}; }
    },
    get(n) {
      if (missing[n]) return undefined;
      if (n === 'tools') return { register: (d) => capture.tools.push(d) };
      if (n === 'webServer') return { register: (d) => { capture.routes.push(d); return () => {}; } };
      if (n === 'systemPrompt') return { section: (d) => capture.sections.push(d), getSectionOrder: () => 2950 };
      if (n === 'workspaceRegistry') {
        return {
          current: () => (currentRef.root ? { id: idOf(currentRef.root), path: currentRef.root } : undefined),
          list: () => createdRoots.map((p) => ({ id: idOf(p), path: p, updatedAt: '2026-01-01T00:00:00.000Z' })),
        };
      }
      if (n === 'sessionController') {
        if (sessionMode === 'missing') return undefined;
        return {
          current: () => null,
          create: async (t) => { capture.sessions.push(t || {}); return { sessionId: 'audit-sess-' + capture.sessions.length }; },
          prompt: async (p) => { capture.prompts.push(p); return true; },
          openWorkspacePath: async () => ({ ok: true }),
        };
      }
      if (n === 'bidIntel') return bidIntelSvc;
      if (n === 'skills') {
        if (skillsMode === 'missing') return undefined;
        if (skillsMode === 'throw-get') throw new Error('skills 服务读取抛错（测试）');
        return {
          register: (d) => {
            if (skillsMode === 'throw-register') throw new Error('register 抛错（测试）');
            capture.skills.push(d);
          },
        };
      }
      return undefined;
    },
  };
  if (bidIntelSvc) { try { ctx.bidIntel = bidIntelSvc; } catch { /* 只读注入兼容 */ } }
  const mod = await import(__toUrl(modulePath) + (String(modulePath).startsWith('file:') ? '' : '?audit-host=' + (++hostSeq)));
  try { mod.apply(ctx); } catch (e) { capture.threw = e; }
  hosts.push(capture);
  return capture;
}

function routeOf(host, path) { return host.routes.find((r) => r.path === path); }

/** 直接驱动已注册路由（与 verify/*.mjs 的 mock 思路相同，但独立实现）。 */
async function call(host, path, opts = {}) {
  const {
    method = 'GET', root = '', body = null, headers = {},
    rawBody = null, contentType = 'application/json', skipContentType = false,
  } = opts;
  const [pathOnly, inlineQuery] = String(path).split('?');
  const route = routeOf(host, pathOnly);
  if (!route) return { status: 599, headers: {}, payload: { ok: false, reason: '路由未注册：' + pathOnly } };
  const h = Object.assign({}, headers);
  let url = pathOnly;
  if (method === 'GET') {
    const q = [];
    if (inlineQuery) q.push(inlineQuery);
    if (root) q.push('root=' + encodeURIComponent(root));
    if (q.length) url += '?' + q.join('&');
  } else if (!skipContentType) {
    h['content-type'] = contentType;
  }
  const res = {
    _status: 200, headers: {},
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(t) { try { res.payload = JSON.parse(String(t)); } catch { res.payload = { raw: String(t) }; } },
  };
  Object.defineProperty(res, 'statusCode', { get() { return this._status; }, set(v) { this._status = v; } });
  const req = { method, url, headers: h, on() {}, destroy() {} };
  if (method === 'POST') {
    let raw;
    if (rawBody !== null) raw = rawBody;
    else {
      const b = Object.assign({}, body || {});
      if (root && b.root === undefined) b.root = root;
      raw = JSON.stringify(b);
    }
    req.on = (ev, cb) => { if (ev === 'data') cb(Buffer.from(raw)); if (ev === 'end') cb(); return req; };
  }
  try { await route.handler(req, res); } catch (e) { return { status: 'THROW', headers: res.headers, payload: { ok: false, reason: 'handler 抛异常：' + (e && e.message) } }; }
  return { status: res._status, headers: res.headers, payload: res.payload };
}
const fdeCall = (host, route, opts) => call(host, '/research-workbench/api/fde/' + route, opts);

function parseBody(res) { return res && res.payload && typeof res.payload === 'object' ? res.payload : {}; }
function rowBody(res) { return JSON.stringify(parseBody(res)).slice(0, 400); }

/* 重建阶段/泳道看板：用公开 API 创建 -> 读 board -> 改 stage -> 写回（writeBoard 会做校验） */
function setStages(root, pairs) {
  const b = store.readBoard(root);
  if (!b.ok) throw new Error(b.reason);
  const bd = b.board;
  for (const [id, stage, extra] of pairs) {
    const e = bd.engagements.find((x) => x.id === id);
    if (!e) throw new Error('测试自身错误：找不到客户 ' + id);
    e.stage = stage;
    if (extra) Object.assign(e, extra);
  }
  const w = store.writeBoard(root, bd);
  if (!w.ok) throw new Error('测试自身错误：写 board 失败 ' + w.reason);
}

const cleanupAll = () => {
  for (const p of createdRoots) { try { rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  for (const p of copyDirs) { try { rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ } }
};
process.on('exit', cleanupAll);

/* ============================ 0. 环境与产物一致性 ============================ */

sec('0. 环境 / 构建一致性');
for (const f of ['index.js', 'client.js', 'src/host/fde-api.js', 'src/host/fde-store.js',
  'src/host/fde-schema.js', 'src/host/fde-rules.js', 'src/host/fde-prompts.js', 'src/ui/ui-panel.js']) {
  check('存在 ' + f, existsSync(join(PLUGIN, f)));
}
{
  const src = readFileSync(join(PLUGIN, 'src', 'ui', 'ui-panel.js'), 'utf8');
  const built = readFileSync(join(PLUGIN, 'client.js'), 'utf8');
  check('client.js 与 src/ui/ui-panel.js 字节一致（构建产物未漂移）', src === built);
}

/* 主替身宿主（正常服务齐全） */
const MAIN = newRoot('main');
const currentRef = { root: MAIN };
const HOST = await applyMock(join(PLUGIN, 'index.js'), { currentRef });

/* ============================ 1. 契约：路由存在性 / 方法 / 守卫 ============================ */

sec('1. 契约 · 25 条 FDE 路由的存在性与方法（v1 13 + 招采 7 + 生财 3 + 资料库 2）');
/* v1 的 13 条：方法白名单 / 415 / 正确方法不被误伤都逐条测；其余三组单独测存在性与方法。 */
const EXPECTED_ROUTES = [
  ['board', 'GET'], ['brief', 'GET'], ['health', 'GET'], ['meta', 'GET'],
  ['engagement', 'POST'], ['item', 'POST'], ['attention', 'POST'], ['gate', 'POST'],
  ['adopt', 'POST'], ['handoff', 'POST'], ['proposal', 'POST'], ['settings', 'POST'], ['sync', 'POST'],
];
const V11_ROUTES = [
  ['bids/stats', 'GET'], ['bids/search', 'GET'], ['bids/match', 'GET'],
  ['bids/link', 'POST'], ['bids/unlink', 'POST'], ['bids/promote', 'POST'], ['bids/refresh', 'POST'],
];
const V12_COMPAT_ROUTES = [['scys/feed', 'GET'], ['scys/refresh', 'POST']];
/* ADR 0004 D5：生财三路授权的状态/保存/清除同路径同方法族（GET 状态，POST 保存或清除）。 */
const AUTH_ROUTE = ['scys/auth', ['GET', 'POST']];
const V13_ROUTES = [['library/feed', 'GET'], ['library/refresh', 'POST']];
const FDE_PREFIX = '/research-workbench/api/fde/';
const fdeRoutes = HOST.routes.filter((r) => r.path.startsWith(FDE_PREFIX));
check('FDE 路由 25 条（v1 13 + 招采 7 + 生财 3（feed/refresh/auth）+ 资料库 2；spec §19.4 / §20.7）',
  fdeRoutes.length === 25, fdeRoutes.map((r) => r.path));
for (const [name, method] of EXPECTED_ROUTES) {
  check('路由存在 /fde/' + name, !!routeOf(HOST, FDE_PREFIX + name));
}
check('v1.1 招采 7 条路由全部存在（spec §17.4）',
  V11_ROUTES.every(([n]) => !!routeOf(HOST, FDE_PREFIX + n)), V11_ROUTES.filter(([n]) => !routeOf(HOST, FDE_PREFIX + n)));
check('v1.2 生财 2 条路由保留兼容（面板入口已移除，工具/缓存仍在；spec §19/§20.6）',
  V12_COMPAT_ROUTES.every(([n]) => !!routeOf(HOST, FDE_PREFIX + n)));
check('生财授权路由 /fde/scys/auth 存在（ADR 0004 D5：GET 状态 / POST 保存·清除）',
  !!routeOf(HOST, FDE_PREFIX + AUTH_ROUTE[0]));
check('v1.3 资料库 2 条路由存在（spec §19.4）',
  V13_ROUTES.every(([n]) => !!routeOf(HOST, FDE_PREFIX + n)), V13_ROUTES.filter(([n]) => !routeOf(HOST, FDE_PREFIX + n)));
/* 方法正确性用 HTTP 行为验证（守卫在 handler 外，注册项本身不存 methods 字段）：错方法必须 405 + Allow。 */
for (const [name, method] of [...V11_ROUTES, ...V12_COMPAT_ROUTES, ...V13_ROUTES]) {
  const wrong = method === 'GET' ? 'POST' : 'GET';
  const r = await fdeCall(HOST, name, { method: wrong, root: MAIN, body: {} });
  check('/fde/' + name + ' 只接受 ' + method + '（' + wrong + ' → 405 + Allow）',
    r.status === 405 && String(r.headers.allow || '').includes(method), { status: r.status, allow: r.headers.allow });
}
/* scys/auth 是唯一 GET+POST 同路径的路由：GET 状态、POST 保存/清除；DELETE 仍须 405。 */
{
  const getAuth = await fdeCall(HOST, AUTH_ROUTE[0], { root: MAIN });
  check('/fde/scys/auth GET → 200 ok:true + auth 状态形状',
    getAuth.status === 200 && parseBody(getAuth).ok === true &&
    ['link', 'env', 'compat', 'none'].includes((parseBody(getAuth).auth || {}).source),
    { status: getAuth.status, body: rowBody(getAuth) });
  const delAuth = await fdeCall(HOST, AUTH_ROUTE[0], { method: 'DELETE', root: MAIN });
  check('/fde/scys/auth DELETE → 405（只接受 GET/POST）', delAuth.status === 405,
    { status: delAuth.status, allow: delAuth.headers.allow });
  const postAuth = await fdeCall(HOST, AUTH_ROUTE[0], { method: 'POST', root: MAIN, body: { url: 'https://mcp.scys.com/auth?code=' } });
  check('/fde/scys/auth POST 链接无 token → 200 + ok:false + code:INVALID（HTTP 恒 200，token 不回显）',
    postAuth.status === 200 && parseBody(postAuth).ok === false && parseBody(postAuth).code === 'INVALID' &&
    !JSON.stringify(parseBody(postAuth)).includes('access_token='),
    { status: postAuth.status, body: rowBody(postAuth) });
}
const LEGACY_ROUTES = ['/research-workbench/api/status', '/research-workbench/api/projects',
  '/research-workbench/api/methods', '/research-workbench/api/files', '/research-workbench/api/scaffold',
  '/research-workbench/api/handoff', '/research-workbench/api/materials', '/research-workbench/api/material-files',
  '/research-workbench/api/upload', '/research-workbench/api/toproject', '/research-workbench/api/adopt',
  '/research-workbench/api/reveal'];
check('旧 12 条路由全部保留（spec §16.10）', LEGACY_ROUTES.every((p) => !!routeOf(HOST, p)),
  LEGACY_ROUTES.filter((p) => !routeOf(HOST, p)));
check('旧 5 个 rw_* 工具仍注册（spec §16.10）',
  ['rw_status', 'rw_scaffold', 'rw_export_pdf', 'rw_qa_pdf', 'rw_method'].every((n) => HOST.tools.some((t) => t.name === n)));

/* 方法白名单：错误方法一律 405 + Allow 头 */
for (const [name, method] of EXPECTED_ROUTES) {
  const wrong = method === 'GET' ? 'POST' : 'GET';
  const r = await fdeCall(HOST, name, { method: wrong, root: MAIN, body: {} });
  check('/fde/' + name + ' 只接受 ' + method + '（' + wrong + ' → 405）', r.status === 405,
    { status: r.status, allow: r.headers.allow });
  check('/fde/' + name + ' 405 带 Allow: ' + method, String(r.headers.allow || '').includes(method), r.headers);
}
/* 正确方法不是 405（GET 路由还要 ok:true） */
for (const [name, method] of EXPECTED_ROUTES) {
  const r = await fdeCall(HOST, name, { method, root: MAIN, body: {} });
  check('/fde/' + name + ' ' + method + ' 未被方法白名单误伤', r.status !== 405 && r.status !== 'THROW',
    { status: r.status, reason: parseBody(r).reason });
}
for (const [name, view] of [['board', '?view=board'], ['brief', ''], ['health', ''], ['meta', '']]) {
  const r = await call(HOST, FDE_PREFIX + name + view, { root: MAIN });
  check('/fde/' + name + ' GET → 200 ok:true', r.status === 200 && parseBody(r).ok === true,
    { status: r.status, reason: parseBody(r).reason });
}
{
  const r = await fdeCall(HOST, 'meta', { root: MAIN });
  const m = parseBody(r).meta || {};
  check('/fde/meta 返回 8 阶段（v1.3 §20.1；含 scoping，order 连续 1–8）',
    Array.isArray(m.stages) && m.stages.length === 8 &&
    JSON.stringify(m.stages.map((s) => s.order)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]) &&
    m.stages.map((s) => s.key).join(',') === 'lead,discovery,meeting,scoping,solution,pilot,delivery,adoption',
    m.stages && m.stages.map((s) => s.key));
  check('/fde/meta 返回 8 门禁（含按阶段索引与 gateList，v1.3 新增 scoping）',
    m.gates && Object.keys(m.gates).length === 8 && Array.isArray(m.gateList) && m.gateList.length === 8 &&
    !!m.gates.scoping && m.gates.scoping.key === 'scoping', m.gates && Object.keys(m.gates));
}

/* 统一守卫：来源 fence + POST JSON 内容类型 */
{
  const evilHost = await call(HOST, FDE_PREFIX + 'meta', { headers: { host: 'evil.example.com' } });
  check('来源守卫：伪造 Host → 403', evilHost.status === 403, evilHost.status);
  const evilOrigin = await call(HOST, FDE_PREFIX + 'meta', { headers: { host: '127.0.0.1:62419', origin: 'http://evil.example.com' } });
  check('来源守卫：外站 Origin → 403', evilOrigin.status === 403, evilOrigin.status);
  const crossSite = await call(HOST, FDE_PREFIX + 'meta', { headers: { 'sec-fetch-site': 'cross-site' } });
  check('来源守卫：cross-site → 403', crossSite.status === 403, crossSite.status);
  const goodOrigin = await call(HOST, FDE_PREFIX + 'meta', { headers: { host: '127.0.0.1:62419', origin: 'http://127.0.0.1:62419' } });
  check('来源守卫：同源回环放行 → 200', goodOrigin.status === 200, goodOrigin.status);
}
for (const [name] of EXPECTED_ROUTES.filter((x) => x[1] === 'POST')) {
  const r = await fdeCall(HOST, name, { method: 'POST', root: MAIN, body: {}, contentType: 'text/plain' });
  check('/fde/' + name + ' 非 JSON Content-Type → 415', r.status === 415, r.status);
}
{
  const bad = await fdeCall(HOST, 'settings', { method: 'POST', root: MAIN, skipContentType: false, rawBody: '{ 坏掉的 json', contentType: 'application/json' });
  check('FDE 路由 JSON 解析失败 → 400 INVALID（不抛）', bad.status === 400 && parseBody(bad).code === 'INVALID',
    { status: bad.status, body: rowBody(bad) });
}

/* 错误契约：code ↔ HTTP 状态码映射 */
sec('2. 契约 · 错误码 / HTTP 状态映射 / 不泄露堆栈');
{
  check('httpStatusOf 映射 INVALID→400', api.httpStatusOf({ ok: false, code: 'INVALID', reason: 'x' }) === 400);
  check('httpStatusOf 映射 BLOCKED→409', api.httpStatusOf({ ok: false, code: 'BLOCKED', reason: 'x' }) === 409);
  check('httpStatusOf 映射 CONFLICT→409', api.httpStatusOf({ ok: false, code: 'CONFLICT', reason: 'x' }) === 409);
  check('httpStatusOf 映射 NOT_FOUND→404', api.httpStatusOf({ ok: false, code: 'NOT_FOUND', reason: 'x' }) === 404);
  check('httpStatusOf 映射 INTERNAL→500', api.httpStatusOf({ ok: false, code: 'INTERNAL', reason: 'x' }) === 500);
  check('带 prompt 的失败仍回 200（剪贴板降级契约）', api.httpStatusOf({ ok: false, code: 'INTERNAL', reason: 'x', prompt: 'p' }) === 200);

  const wsErr = newRoot('err');
  const inv = await fdeCall(HOST, 'engagement', { method: 'POST', root: wsErr, body: { action: 'create' } });
  check('INVALID → 400（create 缺 name）', inv.status === 400 && parseBody(inv).code === 'INVALID', { status: inv.status, body: rowBody(inv) });
  const nf = await fdeCall(HOST, 'engagement', { method: 'POST', root: wsErr, body: { action: 'update', id: 'eng_000000' } });
  check('NOT_FOUND → 404（未知客户 id）', nf.status === 404 && parseBody(nf).code === 'NOT_FOUND', { status: nf.status, body: rowBody(nf) });
  const it0 = api.item(wsErr, { action: 'create', patch: { title: '证据任务', stage: 'doing' } }).item;
  const blocked = await fdeCall(HOST, 'item', { method: 'POST', root: wsErr, body: { action: 'move', id: it0.id, patch: { stage: 'done' } } });
  check('BLOCKED → 409 且带 blocked/missing', blocked.status === 409 && parseBody(blocked).blocked === true &&
    Array.isArray(parseBody(blocked).missing) && parseBody(blocked).missing.length === 1, { status: blocked.status, body: rowBody(blocked) });

  /* CONFLICT：损坏 board */
  const wsBad = newRoot('badboard');
  api.engagement(wsBad, { action: 'create', patch: { name: '损坏前客户' } });
  const goodRaw = readFileSync(store.boardPath(wsBad), 'utf8');
  writeFileSync(store.boardPath(wsBad), '{ 这不是 json');
  const conflict = await fdeCall(HOST, 'board', { root: wsBad });
  check('CONFLICT → 409（损坏 board）', conflict.status === 409 && parseBody(conflict).code === 'CONFLICT',
    { status: conflict.status, body: rowBody(conflict) });
  const conflictWrite = await fdeCall(HOST, 'settings', { method: 'POST', root: wsBad, body: { patch: { stallDays: 20 } } });
  check('写路由在损坏 board 上 → 409 且不覆盖文件',
    conflictWrite.status === 409 && readFileSync(store.boardPath(wsBad), 'utf8') === '{ 这不是 json', conflictWrite.status);
  writeFileSync(store.boardPath(wsBad), goodRaw);

  /* INTERNAL：研究目录被一个同名文件占位（写盘必失败） */
  const wsBroken = newRoot('broken');
  rmSync(join(wsBroken, 'research', '.fde'), { recursive: true, force: true });
  writeFileSync(join(wsBroken, 'research', '.fde'), '占位文件，不是目录');
  const internal = await fdeCall(HOST, 'engagement', { method: 'POST', root: wsBroken, body: { action: 'create', patch: { name: '写不进' } } });
  check('INTERNAL → 500 且仍是 {ok:false, reason}（不抛）',
    internal.status === 500 && parseBody(internal).ok === false && typeof parseBody(internal).reason === 'string',
    { status: internal.status, body: rowBody(internal) });
  const dirty = JSON.stringify(parseBody(internal));
  check('错误响应不含堆栈（无 stack / "    at "）', !/"stack"/.test(dirty) && !/\n\s+at /.test(dirty));
}

/* ============================ 3. 契约：6 个工具 / schema ============================ */

sec('3. 契约 · 16 个 agent 工具（rw_*5 + FDE 11）与参数 schema（spec §7 / §19.5 / §21）');
const FDE_TOOLS = ['fde_board', 'fde_engagement', 'fde_item', 'fde_attention', 'fde_brief', 'fde_harvest',
  'fde_bid', 'fde_library', 'fde_scenario', 'fde_quote'];
const scysTool = HOST.tools.find((t) => t.name === 'scys_fde');
check('v1.2 工具 scys_fde 保留兼容（生财只读情报，feed/refresh）',
  !!scysTool && /生财/.test(String(scysTool.description || '')) && typeof scysTool.execute === 'function',
  scysTool && scysTool.description);
check('FDE 工具 11 个 = 10 个 fde_* + scys_fde（v1.3 §19.5 第 9 / §21 第 10–11 + 兼容保留）',
  HOST.tools.filter((t) => t.name.startsWith('fde_')).length === 10 && !!scysTool,
  HOST.tools.map((t) => t.name));
check('宿主工具总数 16（rw_* 5 + FDE 11；spec §7 v1.3 标注）', HOST.tools.length === 16, HOST.tools.map((t) => t.name));
for (const n of FDE_TOOLS) {
  const t = HOST.tools.find((x) => x.name === n);
  check('工具 ' + n + ' 已注册且 description 为中文（含 FDE）',
    !!t && typeof t.description === 'string' && t.description.length >= 20 && /FDE/.test(t.description) && /[\u4e00-\u9fa5]/.test(t.description));
  check('工具 ' + n + ' parameters 合法', !!t && t.parameters && t.parameters.type === 'object' && typeof t.execute === 'function');
  check('工具 ' + n + ' output.render / presentCall 存在', !!t && t.output && typeof t.output.render === 'function' && typeof t.presentCall === 'function');
}
{
  const t = (n) => HOST.tools.find((x) => x.name === n);
  const p = (n) => t(n).parameters;
  check('fde_board.view 枚举含 board/brief/engagement/item',
    ['board', 'brief', 'engagement', 'item'].every((v) => p('fde_board').properties.view.enum.includes(v)));
  check('fde_board.limit 为 integer 且范围说明存在', p('fde_board').properties.limit.type === 'integer');
  check('fde_engagement.action 枚举与 spec §7 一致（create/update/move/gate/archive）',
    JSON.stringify(p('fde_engagement').properties.action.enum) === JSON.stringify(['create', 'update', 'move', 'gate', 'archive']),
    p('fde_engagement').properties.action.enum);
  check('fde_engagement 提供 patch/force/reason 参数', ['patch', 'force', 'reason'].every((k) => k in p('fde_engagement').properties));
  const itemProps = p('fde_item').properties;
  check('fde_item.report.kind 枚举五态', JSON.stringify(itemProps.report.properties.kind.enum) ===
    JSON.stringify(['progress', 'ready', 'blocked', 'failed', 'dropped']));
  check('fde_item 工具不提供 delete 动作（红线：删除只能人做）',
    !itemProps.action.enum.includes('delete') && /删除/.test(String(itemProps.action.description || '')));
  check('fde_attention.action 枚举 ask/resolve/list',
    JSON.stringify(p('fde_attention').properties.action.enum) === JSON.stringify(['ask', 'resolve', 'list']));
  check('fde_attention.kind 枚举 decision/blocked/answer/question',
    JSON.stringify(p('fde_attention').properties.kind.enum) === JSON.stringify(['decision', 'blocked', 'answer', 'question']));
  check('fde_brief.apply 为 boolean', p('fde_brief').properties.apply.type === 'boolean');
  check('fde_harvest.text 为必填', Array.isArray(p('fde_harvest').required) && p('fde_harvest').required.includes('text'));
  check('fde_harvest.targets 枚举 pitfall/method/skill',
    JSON.stringify(p('fde_harvest').properties.targets.items.enum) === JSON.stringify(['pitfall', 'method', 'skill']));
}
/* 参数校验失败：不抛异常 + 返回 ok:false（spec §7 要求带 reason） */
{
  const t = (n) => HOST.tools.find((x) => x.name === n);
  const cases = [
    ['fde_engagement 未知 action', t('fde_engagement'), { action: 'nope', root: MAIN }],
    ['fde_item 未知 id', t('fde_item'), { action: 'report', id: 'itm_000000', kind: 'ready', text: 'x', root: MAIN }],
    ['fde_board 未知客户', t('fde_board'), { view: 'engagement', id: 'eng_000000', root: MAIN }],
    ['fde_harvest 空 text', t('fde_harvest'), { text: '', root: MAIN }],
    ['fde_attention 未知 id', t('fde_attention'), { action: 'ask', target: 'engagement', id: 'eng_000000', question: 'q', root: MAIN }],
  ];
  for (const [name, tool, args] of cases) {
    let threw = false;
    let r = null;
    try { r = await tool.execute(args); } catch { threw = true; }
    check(name + ' → 不抛异常且 ok:false', !threw && r && r.ok === false, r && (r.text || r.reason));
  }
  const r = await t('fde_engagement').execute({ action: 'nope', root: MAIN });
  specCheck('F8', !!(r && typeof r.reason === 'string'), r && { reason: r.reason, text: String(r.text || '').slice(0, 80) });
}

/* 工具 ↔ HTTP 同一实现（spec §10 A10） */
{
  const ws = newRoot('sameness');
  const t = (n) => HOST.tools.find((x) => x.name === n);
  const made = await t('fde_engagement').execute({ action: 'create', name: '同一实现客户', company: '同一实现有限公司', root: ws });
  check('工具创建客户成功', made && made.ok === true && !!made.engagement.id, made && made.text);
  const read = await fdeCall(HOST, 'board', { root: ws });
  check('HTTP GET /board 能读到工具写入的客户（同一 board 文件）',
    parseBody(read).board.engagements.some((e) => e.id === made.engagement.id), read.status);
  const it = await t('fde_item').execute({ action: 'create', patch: { title: '同一实现任务', stage: 'doing', engagementId: made.engagement.id }, root: ws });
  await t('fde_item').execute({ action: 'report', id: it.item.id, report: { kind: 'ready', text: '完成摘要', artifacts: ['research/x.md'] }, root: ws });
  const read2 = await fdeCall(HOST, 'board', { root: ws });
  const item2 = parseBody(read2).board.items.find((x) => x.id === it.item.id);
  check('工具 report 与 HTTP board 读一致（泳道/回报条数）',
    !!item2 && item2.stage === 'review' && item2.reports.length === 1, item2 && { stage: item2.stage, reports: item2.reports.length });
}

/* ============================ 4. 安全：路径穿越 / 未知 id / 符号链接 ============================ */

sec('4. 安全 · 路径穿越与未知 id（越界写必须先拒）');
const SEC = newRoot('sec');
{
  const w = (patch) => fdeCall(HOST, 'engagement', { method: 'POST', root: SEC, body: { action: 'create', patch } });
  for (const badDir of ['../pwn-audit', '/etc/passwd', 'a/b', '..', '.']) {
    const r = await w({ name: '穿越' + badDir, dir: badDir });
    check('engagement.create dir=' + JSON.stringify(badDir) + ' → 400', r.status === 400, { status: r.status, body: rowBody(r) });
  }
  check('穿越目录未被创建（工作区外/内都没有 pwn-audit）',
    !existsSync(join(SEC, 'pwn-audit')) && !existsSync(join(tmpdir(), 'pwn-audit')));
  const created = api.engagement(SEC, { action: 'create', patch: { name: '合法客户', company: '合法有限公司' } }).engagement;
  const upd = await fdeCall(HOST, 'engagement', { method: 'POST', root: SEC, body: { action: 'update', id: created.id, patch: { dir: '../../etc' } } });
  check('engagement.update dir 穿越 → 400', upd.status === 400, { status: upd.status, body: rowBody(upd) });
  check('穿越 update 未写盘（board 里 dir 仍为空）',
    (api.board(SEC).board.engagements.find((e) => e.id === created.id) || {}).dir === '');

  const adoptBad = await fdeCall(HOST, 'adopt', {
    method: 'POST', root: SEC, body: { action: 'apply', dirs: ['../a', '/etc', '..', '.', 'a/b'] },
  });
  check('adopt.apply 非法 dirs 全部 rejected、不新增客户',
    parseBody(adoptBad).added.length === 0 && parseBody(adoptBad).rejected.length >= 4 &&
    api.board(SEC).board.engagements.length === 1, rowBody(adoptBad));

  const itemTraversal = await fdeCall(HOST, 'item', { method: 'POST', root: SEC, body: { action: 'create', patch: { title: 'x', engagementId: '../../x' } } });
  check('item.create engagementId 穿越 → 400', itemTraversal.status === 400, itemTraversal.status);
  const handoffTraversal = await fdeCall(HOST, 'handoff', { method: 'POST', root: SEC, body: { target: 'engagement', id: '../../etc' } });
  check('handoff id 穿越 → 404（不做路径拼接）', handoffTraversal.status === 404, handoffTraversal.status);
}
/* 未知 id 矩阵 */
{
  const ws = newRoot('ids');
  const probes = [
    ['engagement.update', 'engagement', { action: 'update', id: 'eng_000000', patch: { name: 'x' } }],
    ['engagement.move', 'engagement', { action: 'move', id: 'eng_000000', patch: { stage: 'discovery' } }],
    ['engagement.gate', 'engagement', { action: 'gate', engagementId: 'eng_000000', stage: 'discovery' }],
    ['engagement.archive', 'engagement', { action: 'archive', id: 'eng_000000' }],
    ['item.report', 'item', { action: 'report', id: 'itm_000000', kind: 'ready', text: 'x' }],
    ['item.move', 'item', { action: 'move', id: 'itm_000000', patch: { stage: 'done' } }],
    ['attention.ask', 'attention', { action: 'ask', target: 'engagement', id: 'eng_000000', question: 'q' }],
    ['attention.resolve', 'attention', { action: 'resolve', target: 'engagement', id: 'eng_000000' }],
    ['proposal.accept', 'proposal', { action: 'accept', id: 'prp_000000' }],
    ['sync.engagementId', 'sync', { engagementId: 'eng_000000' }],
    ['harvest.engagementId', null, { action: 'harvest' }],
  ];
  for (const [name, route, body] of probes) {
    if (!route) continue;
    const r = await fdeCall(HOST, route, { method: 'POST', root: ws, body });
    check('未知 id：' + name + ' → 404', r.status === 404, { status: r.status, body: rowBody(r) });
  }
  check('未知 id：fde_harvest 关联客户不存在 → ok:false（工具层）',
    (await HOST.tools.find((t) => t.name === 'fde_harvest').execute({ engagementId: 'eng_000000', text: 'x', root: ws })).ok === false);
}

/* 符号链接目录：FDE 扫描不得读到工作区外（spec §16.2 不得出工作区） */
{
  const ws = newRoot('symlink');
  const outside = mkdtempSync(join(tmpdir(), 'fde-outside-'));
  createdRoots.push(outside);
  mkdirSync(join(outside, 'proposal'), { recursive: true });
  writeFileSync(join(outside, 'proposal', 'outside-secret.md'), '工作区外文件：这里写了「不做什么」边界，但不在工作区内。');
  let auditSymlinkOk = true;
  try { symlinkSync(outside, join(ws, 'research', 'linked-audit')); }
  catch (e) {
    // Windows 默认策略下普通用户无权创建 symlink（需管理员或开发者模式），属环境能力缺失
    const code = e && e.code;
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES') auditSymlinkOk = false;
    else throw e;
  }
  if (!auditSymlinkOk) {
    /* 环境能力缺失：显式记录为「未验证」，日志与汇总都能看到，不伪装成通过。 */
    skipped.push('F6 符号链接目录边界（环境无 symlink 权限）');
    console.log('  ⚠ SKIP [F6·P2] 符号链接边界断言：当前环境不允许创建 symlink，未验证');
  } else {
  const apply = await fdeCall(HOST, 'adopt', { method: 'POST', root: ws, body: { action: 'apply', dirs: ['linked-audit'] } });
  const imported = parseBody(apply).added.length > 0;
  const eng = (api.board(ws).board.engagements || []).find((e) => e.dir === 'linked-audit');
  let readOutside = false;
  let evidence = '';
  if (eng) {
    const g = api.gate(ws, { engagementId: eng.id, stage: 'solution' });
    const boundary = g.ok && g.gate && g.gate.auto && g.gate.auto.find((c) => c.key === 'boundary');
    readOutside = !!(boundary && boundary.ok);
    evidence = boundary && boundary.evidence;
  }
  specCheck('F6', !(imported || readOutside), { imported, readOutside, evidence });
  }
}

/* ============================ 5. fail-safe：board 损坏 / 高版本 / 写失败 / 备份 ============================ */

sec('5. fail-safe · board 损坏 / 高版本 / 写失败 / 原子写与备份');
{
  const ws = newRoot('fail');
  const e = api.engagement(ws, { action: 'create', patch: { name: '保护客户' } }).engagement;
  api.engagement(ws, { action: 'update', id: e.id, patch: { nextAction: { text: '跟进', due: dateStr(3) } } });
  const before = readFileSync(store.boardPath(ws), 'utf8');

  /* 高版本拒绝读写 */
  const data = JSON.parse(before);
  data.version = 2;
  writeFileSync(store.boardPath(ws), JSON.stringify(data));
  const hi = await fdeCall(HOST, 'board', { root: ws });
  check('board.version 更高 → 409 CONFLICT（spec §11）', hi.status === 409 && parseBody(hi).code === 'CONFLICT',
    { status: hi.status, body: rowBody(hi) });
  check('高版本 board 未被改写', JSON.parse(readFileSync(store.boardPath(ws), 'utf8')).version === 2);

  /* 版本缺失/非法 */
  writeFileSync(store.boardPath(ws), JSON.stringify({ version: 0, engagements: [] }));
  const v0 = await fdeCall(HOST, 'board', { root: ws });
  check('board.version=0 → 400（拒绝而不是猜）', v0.status === 400, v0.status);

  /* 损坏 JSON */
  writeFileSync(store.boardPath(ws), before);
  writeFileSync(store.boardPath(ws), '{ 损坏');
  const corrupt = await fdeCall(HOST, 'brief', { root: ws });
  check('损坏 board：brief 返回 409 而非抛异常', corrupt.status === 409, corrupt.status);
  const corruptHealth = await fdeCall(HOST, 'health', { root: ws });
  check('损坏 board：health 返回逐项失败而不是抛异常',
    corruptHealth.status === 200 && parseBody(corruptHealth).ok === true &&
    parseBody(corruptHealth).healthy === false &&
    parseBody(corruptHealth).checks.some((c) => c.status === 'fail'), rowBody(corruptHealth));
  check('损坏 board：文件原样保留（未覆盖）', readFileSync(store.boardPath(ws), 'utf8') === '{ 损坏');

  /* 备份目录被占位 → 备份失败必须取消写入 */
  writeFileSync(store.boardPath(ws), before);
  rmSync(store.backupsDir(ws), { recursive: true, force: true });
  writeFileSync(store.backupsDir(ws), '占位文件，不是目录');
  const w = await fdeCall(HOST, 'engagement', { method: 'POST', root: ws, body: { action: 'create', patch: { name: '备份被挡' } } });
  check('备份失败 → 取消写入并返回 INTERNAL（不破坏旧 board）',
    w.status === 500 && parseBody(w).code === 'INTERNAL' && readFileSync(store.boardPath(ws), 'utf8') === before,
    { status: w.status, body: rowBody(w) });
  rmSync(store.backupsDir(ws), { force: true });

  /* 正常写：备份 = 写前内容、上限 10、无临时文件残留 */
  const ws2 = newRoot('backup');
  const e2 = api.engagement(ws2, { action: 'create', patch: { name: '备份客户' } }).engagement;
  api.engagement(ws2, { action: 'update', id: e2.id, patch: { nextAction: { text: '第二轮', due: dateStr(2) } } });
  const backups = store.listBackups(ws2);
  check('写前备份存在', backups.length >= 1, backups.length);
  check('备份文件名符合 board-<YYYYMMDD-HHmmss>.json（spec §3）',
    backups.every((b) => /^board-\d{8}-\d{6}(-\d+)?\.json$/.test(b.name)), backups.map((b) => b.name));
  const newest = JSON.parse(readFileSync(backups[0].path, 'utf8'));
  check('备份内容可解析且是写前 board', Array.isArray(newest.engagements) && newest.engagements.length === 1);
  for (let i = 0; i < 12; i += 1) {
    api.engagement(ws2, { action: 'update', id: e2.id, patch: { nextAction: { text: '第' + i + '轮', due: dateStr(2 + i) } } });
  }
  check('备份保留最近 10 份', store.listBackups(ws2).length <= store.MAX_BACKUPS && store.listBackups(ws2).length === 10,
    store.listBackups(ws2).length);
  check('写后无 .tmp 残留', !readdirSync(store.fdeDir(ws2)).some((f) => f.includes('.tmp')));
  check('.fde 目录只有 board.json/backups（状态落点唯一，无客户卷写入）',
    readdirSync(store.fdeDir(ws2)).sort().every((f) => ['board.json', 'backups', 'drafts'].includes(f)),
    readdirSync(store.fdeDir(ws2)));
  /* 校验失败的写入不落盘 */
  const good = readFileSync(store.boardPath(ws2), 'utf8');
  const badBoard = store.readBoard(ws2).board;
  badBoard.engagements.push({ id: 'eng_000001', name: '坏', stage: 'bogus', priority: 'normal', paused: false });
  const badWrite = store.writeBoard(ws2, badBoard);
  check('非法 stage 写入被拒且旧 board 不变',
    badWrite.ok === false && readFileSync(store.boardPath(ws2), 'utf8') === good, badWrite.reason);
}

/* ============================ 6. 语义：门禁 ============================ */

sec('6. 语义 · 门禁 pass/blocked/force 与留痕（spec §2.2 / §4.1）');
const GATE = newRoot('gate');
{
  makeProject(GATE, '门禁客户-20260101', {
    '00-项目档案.md': '# 项目档案：门禁客户\n',
    'research/事实核查清单.md': 'A 级事实',
    'research/KPI与痛点假设.md': '本节全部为假设',
  });
  const cr = api.engagement(GATE, {
    action: 'create',
    patch: { name: '门禁客户', company: '门禁客户有限公司', dir: '门禁客户-20260101', source: { kind: 'manual' }, nextAction: { text: '补 KPI', due: dateStr(3) } },
  });
  const id = cr.engagement.id;
  const blocked = await fdeCall(HOST, 'engagement', { method: 'POST', root: GATE, body: { action: 'move', id, patch: { stage: 'discovery' } } });
  check('discovery 自动项全过、人工项缺失 → blocked:true + missing 2 项（全 manual）',
    blocked.status === 409 && parseBody(blocked).blocked === true &&
    parseBody(blocked).missing.length === 2 && parseBody(blocked).missing.every((m) => m.type === 'manual'),
    rowBody(blocked));
  const partial = await fdeCall(HOST, 'gate', {
    method: 'POST', root: GATE,
    body: { engagementId: id, stage: 'discovery', checks: { subject_locked: { status: 'pass', evidence: '地址锚定 + 三链验证' } } },
  });
  check('只勾一项人工确认 → 仍 pending、missing 1 项',
    parseBody(partial).ok === true && parseBody(partial).gate.passed === false && parseBody(partial).missing.length === 1,
    rowBody(partial));
  const full = await fdeCall(HOST, 'gate', {
    method: 'POST', root: GATE,
    body: {
      engagementId: id, stage: 'discovery',
      checks: { subject_locked: { status: 'pass', evidence: '地址锚定' }, evidence_graded: { status: 'pass', evidence: 'A/B/C 分级' } },
    },
  });
  check('人工项补齐 → gate.passed=true 且 status=pass',
    parseBody(full).ok === true && parseBody(full).gate.passed === true && parseBody(full).gate.status === 'pass', rowBody(full));
  const mv = await fdeCall(HOST, 'engagement', { method: 'POST', root: GATE, body: { action: 'move', id, patch: { stage: 'discovery' } } });
  check('门禁通过后 move 成功、stageSince 更新', parseBody(mv).ok === true && parseBody(mv).engagement.stage === 'discovery' &&
    Date.parse(parseBody(mv).engagement.stageSince) > 0, rowBody(mv));
  check('推进写入 timeline（kind=stage）',
    (parseBody(mv).engagement.timeline || []).some((t) => t.kind === 'stage' && String(t.text).includes('研判')));
  const stats = await fdeCall(HOST, 'board', { root: GATE });
  check('GET board stats.byStage 计数正确', parseBody(stats).stats.byStage.discovery === 1, parseBody(stats).stats);

  /* force 流程 */
  const cr2 = api.engagement(GATE, { action: 'create', patch: { name: '强制客户', company: '强制有限公司', nextAction: { text: '跟进', due: dateStr(3) } } }).engagement;
  const noReason = await fdeCall(HOST, 'engagement', { method: 'POST', root: GATE, body: { action: 'move', id: cr2.id, patch: { stage: 'discovery', force: true } } });
  check('force 缺 reason → 400（强制必须留原因）', noReason.status === 400, rowBody(noReason));
  const forced = await fdeCall(HOST, 'engagement', {
    method: 'POST', root: GATE,
    body: { action: 'move', id: cr2.id, patch: { stage: 'discovery', force: true, reason: '用户明确要求先推进' } },
  });
  check('force move 成功且 gateState.<stage>.forced=true + reason',
    parseBody(forced).ok === true && parseBody(forced).engagement.gateState.discovery.forced === true &&
    String(parseBody(forced).engagement.gateState.discovery.reason).includes('用户明确'), rowBody(forced));
  check('force 记录写入 timeline（含原因）',
    (parseBody(forced).engagement.timeline || []).some((t) => String(t.text).includes('force') && String(t.text).includes('用户明确')));
  const jump = await fdeCall(HOST, 'engagement', { method: 'POST', root: GATE, body: { action: 'move', id: cr2.id, patch: { stage: 'solution' } } });
  check('非 force 跳阶 → 400 INVALID', jump.status === 400 && parseBody(jump).code === 'INVALID', rowBody(jump));
  const forceJump = await fdeCall(HOST, 'engagement', { method: 'POST', root: GATE, body: { action: 'move', id: cr2.id, patch: { stage: 'solution', force: true, reason: '人确认越级' } } });
  check('force 允许越级（spec §2.1 除 force 外）', parseBody(forceJump).ok === true && parseBody(forceJump).engagement.stage === 'solution', rowBody(forceJump));

  /* 面板真实流程：gate force → move 不带 force */
  const cr3 = api.engagement(GATE, { action: 'create', patch: { name: '门禁强制客户', company: '门禁强制公司', nextAction: { text: '跟进', due: dateStr(3) } } }).engagement;
  const gf = await fdeCall(HOST, 'gate', { method: 'POST', root: GATE, body: { engagementId: cr3.id, stage: 'discovery', force: true, reason: '面板强制放行' } });
  check('/fde/gate force → status=forced / forced=true',
    parseBody(gf).ok === true && parseBody(gf).gate.status === 'forced' && parseBody(gf).gate.forced === true, rowBody(gf));
  const mv2 = await fdeCall(HOST, 'engagement', { method: 'POST', root: GATE, body: { action: 'move', id: cr3.id, patch: { stage: 'discovery' } } });
  check('已 force 放行的门禁，后续 move 免 force 通过', parseBody(mv2).ok === true && parseBody(mv2).engagement.stage === 'discovery', rowBody(mv2));
  const back = await fdeCall(HOST, 'engagement', { method: 'POST', root: GATE, body: { action: 'move', id: cr3.id, patch: { stage: 'lead' } } });
  check('阶段回退（人工纠正）无需门禁且留痕', parseBody(back).ok === true && parseBody(back).engagement.stage === 'lead' &&
    (parseBody(back).engagement.timeline || []).some((t) => String(t.text).includes('回退')), rowBody(back));
}

/* ============================ 7. 语义：item 回报 / 注意力 / 统计 ============================ */

sec('7. 语义 · item 四态迁移 / 证据门禁 / 注意力排序（spec §4.1 / §5）');
const ITEM = newRoot('item');
{
  const mk = (title, stage) => api.item(ITEM, { action: 'create', patch: { title, stage } }).item;
  const a = mk('任务A', 'doing');
  const ready = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'report', id: a.id, kind: 'ready', text: '完成，产物 research/a.md', artifacts: ['research/a.md'] } });
  check('report ready → review + reports 追加 + artifacts 保留',
    parseBody(ready).ok === true && parseBody(ready).item.stage === 'review' &&
    parseBody(ready).item.reports.length === 1 && parseBody(ready).item.reports[0].artifacts.length === 1, rowBody(ready));
  const blocked = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'report', id: a.id, kind: 'blocked', text: '等客户数据' } });
  check('report blocked → waiting + 显式注意力（kind=blocked）',
    parseBody(blocked).ok === true && parseBody(blocked).item.stage === 'waiting' &&
    parseBody(blocked).attention && parseBody(blocked).attention.kind === 'blocked', rowBody(blocked));
  const brief = await fdeCall(HOST, 'brief', { root: ITEM });
  check('blocked 回报出现在 brief 注意力中',
    parseBody(brief).brief.attention.some((x) => x.kind === 'blocked' && x.itemId === a.id), rowBody(brief));
  const ready2 = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'report', id: a.id, kind: 'ready', text: '补齐后可审' } });
  check('blocked 后 report ready → review 且清空显式注意力',
    parseBody(ready2).ok === true && parseBody(ready2).item.stage === 'review' && parseBody(ready2).item.attention === null, rowBody(ready2));
  const b = mk('任务B', 'doing');
  const failed = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'report', id: b.id, kind: 'failed', text: '接口不通' } });
  check('report failed → 保持 doing + 生成注意力', parseBody(failed).ok === true && parseBody(failed).item.stage === 'doing' &&
    parseBody(failed).attention && parseBody(failed).attention.kind === 'blocked', rowBody(failed));
  const d = mk('任务D', 'doing');
  const dropped = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'report', id: d.id, kind: 'dropped', text: '范围外' } });
  check('report dropped → canceled', parseBody(dropped).ok === true && parseBody(dropped).item.stage === 'canceled');
  const p = mk('任务P', 'todo');
  const prog = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'report', id: p.id, kind: 'progress', text: '50%' } });
  check('report progress 不改泳道', parseBody(prog).ok === true && parseBody(prog).item.stage === 'todo');
  const badKind = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'report', id: p.id, kind: 'nope', text: 'x' } });
  check('非法 report.kind → 400', badKind.status === 400, badKind.status);
  const emptyText = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'report', id: p.id, kind: 'progress', text: '  ' } });
  check('空回报文本 → 400', emptyText.status === 400, emptyText.status);

  /* 进 done 的证据门禁 */
  const c = mk('任务C', 'doing');
  const noEvidence = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'move', id: c.id, patch: { stage: 'done' } } });
  check('无回报/证据进 done → 409 blocked（可 force）',
    noEvidence.status === 409 && parseBody(noEvidence).blocked === true &&
    parseBody(noEvidence).missing.some((m) => m.key === 'evidence'), rowBody(noEvidence));
  const evidence = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'move', id: c.id, patch: { stage: 'done', evidence: '验收单 internal/验收.md' } } });
  check('带人工证据进 done 成功', parseBody(evidence).ok === true && parseBody(evidence).item.stage === 'done', rowBody(evidence));
  const willForce = mk('任务F', 'doing');
  const forcedDone = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'move', id: willForce.id, patch: { stage: 'done', force: true } } });
  check('force 可覆盖 done 证据门禁', parseBody(forcedDone).ok === true && parseBody(forcedDone).item.stage === 'done', rowBody(forcedDone));

  /* WIP 提示 */
  api.settings(ITEM, { patch: { wipLimits: { doing: 1 } } });
  mk('WIP-1', 'doing');
  const wipItem = mk('WIP-2', 'todo');
  const wipMove = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'move', id: wipItem.id, patch: { stage: 'doing' } } });
  check('WIP 超限给 warning（不阻断）', parseBody(wipMove).ok === true && /WIP/.test(String(parseBody(wipMove).warning)), rowBody(wipMove));

  /* 人工删除任务（HTTP 路由；agent 工具不提供，见 F1 节） */
  const del = mk('待删除任务', 'todo');
  const delRes = await fdeCall(HOST, 'item', { method: 'POST', root: ITEM, body: { action: 'delete', id: del.id } });
  check('人在面板删除任务 → 成功且从 board 移除',
    parseBody(delRes).ok === true && !api.board(ITEM).board.items.some((x) => x.id === del.id), rowBody(delRes));
}

/* 注意力排序（spec §5：blocked > decision > review > answer > overdue > gate > stall > proposal） */
const ATTN = newRoot('attn');
{
  const mkEng = (name, extra = {}) => Object.assign(
    api.engagement(ATTN, { action: 'create', patch: Object.assign({ name, company: name + '有限公司', nextAction: { text: '跟进', due: dateStr(5) } }, extra) }).engagement,
    {}
  );
  const eBlocked = mkEng('受阻客户');
  api.attention(ATTN, { action: 'ask', target: 'engagement', id: eBlocked.id, kind: 'blocked', question: '客户数据拿不到，是否升级？' });
  const eDecision = mkEng('待决客户');
  api.attention(ATTN, { action: 'ask', target: 'engagement', id: eDecision.id, kind: 'decision', question: '是否进入试点？' });
  const eAnswer = mkEng('待答客户');
  api.attention(ATTN, { action: 'ask', target: 'engagement', id: eAnswer.id, kind: 'answer', question: '预算口径？' });
  const eOverdue = mkEng('逾期客户', { nextAction: { text: '补事实核查', due: '2020-01-01' } });
  makeProject(ATTN, '门禁注意力客户-20260102', {
    '00-项目档案.md': '# 项目档案：门禁注意力\n',
    'research/事实核查清单.md': 'A 级',
    'research/KPI与痛点假设.md': '假设',
  });
  const eGate = api.engagement(ATTN, { action: 'create', patch: { name: '门禁注意力客户', company: '门禁注意力有限公司', dir: '门禁注意力客户-20260102', nextAction: { text: '补人工确认', due: dateStr(5) } } }).engagement;
  const eStall = mkEng('停滞客户');
  const reviewItem = api.item(ATTN, { action: 'create', patch: { title: '待审任务', stage: 'review', due: dateStr(1) } }).item;
  /* 手工把停留时间改成旧日期（只改 tmp 工作区里的 board，模拟真实数据） */
  {
    const b = store.readBoard(ATTN).board;
    const gateEng = b.engagements.find((x) => x.id === eGate.id);
    gateEng.stageSince = iso(-8); gateEng.createdAt = iso(-8); gateEng.timeline = [];
    const stallEng = b.engagements.find((x) => x.id === eStall.id);
    stallEng.stageSince = iso(-20); stallEng.createdAt = iso(-20); stallEng.timeline = [];
    const w = store.writeBoard(ATTN, b);
    check('测试预置：注意力看板写盘成功', w.ok, w.reason);
  }
  const br = await fdeCall(HOST, 'brief', { root: ATTN });
  const list = parseBody(br).brief.attention || [];
  const kinds = list.map((x) => x.kind);
  check('注意力覆盖 §5 八类（当前看板可见全部 kind）',
    ['blocked', 'decision', 'review', 'answer', 'overdue', 'gate', 'stall', 'proposal'].every((k) => kinds.includes(k)), kinds);
  check('注意力排序：rank 单调不减（blocked→…→proposal）',
    list.every((x, i) => i === 0 || list[i - 1].rank <= x.rank), kinds);
  const firstIdx = ['blocked', 'decision', 'review', 'answer', 'overdue', 'gate', 'stall', 'proposal']
    .map((k) => kinds.indexOf(k)).filter((i) => i >= 0);
  check('注意力首现顺序符合 spec §5', firstIdx.every((v, i) => i === 0 || firstIdx[i - 1] < v), firstIdx);
  const uniqKey = (x) => [x.kind, x.engagementId || '', x.itemId || '', x.text].join('|');
  check('注意力无重复条目', new Set(list.map(uniqKey)).size === list.length);
  const listRoute = await fdeCall(HOST, 'attention', { method: 'POST', root: ATTN, body: { action: 'list' } });
  check('/fde/attention list 与 brief 注意力条数一致',
    parseBody(listRoute).ok === true && (parseBody(listRoute).list || []).length === list.length, rowBody(listRoute));
  const resolve = await fdeCall(HOST, 'attention', { method: 'POST', root: ATTN, body: { action: 'resolve', target: 'engagement', id: eBlocked.id, answer: '已升级' } });
  check('resolve 清空显式注意力', parseBody(resolve).ok === true && parseBody(resolve).cleared === true && parseBody(resolve).attention === null, rowBody(resolve));
  const br2 = await fdeCall(HOST, 'brief', { root: ATTN });
  check('resolve 后 blocked 注意力消失', !parseBody(br2).brief.attention.some((x) => x.kind === 'blocked' && x.engagementId === eBlocked.id));

  /* 暂停客户不应继续产生 stall/gate 注意力（与 refreshProposals 的 paused 口径一致） */
  const wsPaused = newRoot('paused');
  const ep = api.engagement(wsPaused, { action: 'create', patch: { name: '暂停客户', company: '暂停有限公司', nextAction: { text: '等消息', due: dateStr(5) } } }).engagement;
  api.engagement(wsPaused, { action: 'update', id: ep.id, patch: { paused: true } });
  {
    const b = store.readBoard(wsPaused).board;
    const x = b.engagements.find((y) => y.id === ep.id);
    x.stageSince = iso(-30); x.createdAt = iso(-30); x.timeline = [];
    store.writeBoard(wsPaused, b);
  }
  const brPaused = await fdeCall(HOST, 'brief', { root: wsPaused });
  const pausedAtt = parseBody(brPaused).brief.attention.filter((x) => x.engagementId === ep.id).map((x) => x.kind);
  specCheck('F7', pausedAtt.length === 0, { pausedAtt });
  note('O8', false);
}

/* ============================ 8. 语义：adopt 导入 / proposal 建议 ============================ */

sec('8. 语义 · adopt 两段式与幂等 / proposal 去重、采纳与上限（spec §4.1 / §6）');
const ADOPT = newRoot('adopt');
{
  makeProject(ADOPT, '导入项目-20260101', {
    '00-项目档案.md': '# 项目档案：导入项目\n',
    'research/事实核查清单.md': 'A 级',
    'meeting/客户面谈Brief.md': 'Brief 内容',
  });
  makeProject(ADOPT, '历史目录-20260102', { 'research/旧方案.md': '方案正文' });
  mkdirSync(join(ADOPT, 'research', '素材目录'), { recursive: true });
  writeFileSync(join(ADOPT, 'research', '素材目录', 'a.html'), '<html></html>');
  const scan = await fdeCall(HOST, 'adopt', { method: 'POST', root: ADOPT, body: { action: 'scan' } });
  const cands = parseBody(scan).candidates || [];
  check('adopt scan 返回候选（含 project 与 legacy）',
    cands.some((c) => c.dir === '导入项目-20260101' && c.kind === 'project') &&
    cands.some((c) => c.dir === '历史目录-20260102' && c.kind === 'legacy'), cands.map((c) => c.dir + ':' + c.kind));
  check('adopt scan 跳过纯素材目录', !cands.some((c) => c.dir === '素材目录'), cands.map((c) => c.dir));
  const proj = cands.find((c) => c.dir === '导入项目-20260101');
  check('adopt scan 给建议阶段 + 置信度 + 证据（推断，非公告明示）',
    !!proj && schema.isStage(proj.suggestedStage) && typeof proj.confidence === 'string' &&
    Array.isArray(proj.evidence), proj && { stage: proj.suggestedStage, confidence: proj.confidence, evidence: proj.evidence });
  const apply = await fdeCall(HOST, 'adopt', { method: 'POST', root: ADOPT, body: { action: 'apply', dirs: ['导入项目-20260101', '历史目录-20260102'] } });
  check('adopt apply 导入 2 个客户', parseBody(apply).ok === true && parseBody(apply).added.length === 2, rowBody(apply));
  const bd = api.board(ADOPT).board;
  const imported = bd.engagements.find((e) => e.dir === '导入项目-20260101');
  check('导入客户 adopted=true、stage=建议阶段、历史门禁标 forced',
    !!imported && imported.adopted === true && schema.isStage(imported.stage) &&
    imported.gateState.lead && imported.gateState.lead.status === 'forced', imported && { adopted: imported.adopted, stage: imported.stage });
  const apply2 = await fdeCall(HOST, 'adopt', { method: 'POST', root: ADOPT, body: { action: 'apply', dirs: ['导入项目-20260101'] } });
  check('adopt apply 幂等：重复导入被 skipped', parseBody(apply2).ok === true && parseBody(apply2).added.length === 0 &&
    parseBody(apply2).skipped.length === 1, rowBody(apply2));
  const scan2 = await fdeCall(HOST, 'adopt', { method: 'POST', root: ADOPT, body: { action: 'scan' } });
  check('adopt scan 标记 alreadyImported',
    (parseBody(scan2).candidates || []).find((c) => c.dir === '导入项目-20260101').alreadyImported === true);
  const noDirs = await fdeCall(HOST, 'adopt', { method: 'POST', root: ADOPT, body: { action: 'apply', dirs: [] } });
  check('adopt apply 缺 dirs → 400', noDirs.status === 400, noDirs.status);
}

const PROP = newRoot('prop');
{
  /* stall 建议 + 24h 去重 + accept 执行 payload + dismiss */
  const e = api.engagement(PROP, { action: 'create', patch: { name: '停滞客户', company: '停滞有限公司', nextAction: { text: '跟进', due: dateStr(30) } } }).engagement;
  {
    const b = store.readBoard(PROP).board;
    const x = b.engagements.find((y) => y.id === e.id);
    x.stageSince = iso(-20); x.createdAt = iso(-20); x.timeline = [];
    x.nextAction = { text: '跟进', due: dateStr(10), owner: '' };
    store.writeBoard(PROP, b);
  }
  const b1 = api.board(PROP);
  const stall = b1.board.proposals.filter((p) => p.ruleId === 'stall' && p.engagementId === e.id);
  check('stall 规则生成 proposal（nudge + payload）', stall.length === 1 && stall[0].kind === 'nudge' &&
    /^prp_[0-9a-f]{6}$/.test(stall[0].id) && !!stall[0].payload, stall.map((p) => p.id));
  const count1 = api.board(PROP).board.proposals.filter((p) => p.ruleId === 'stall' && p.engagementId === e.id).length;
  check('同一规则同一对象 24h 内不重复生成', count1 === stall.length, { first: stall.length, second: count1 });
  const acc = await fdeCall(HOST, 'proposal', { method: 'POST', root: PROP, body: { action: 'accept', id: stall[0].id } });
  check('proposal accept 执行 payload（nextAction.due 改为 +2 天）并标记 accepted',
    parseBody(acc).ok === true && parseBody(acc).proposal.status === 'accepted' &&
    api.board(PROP).board.engagements.find((x) => x.id === e.id).nextAction.due === dateStr(2), rowBody(acc));
  const again = await fdeCall(HOST, 'proposal', { method: 'POST', root: PROP, body: { action: 'accept', id: stall[0].id } });
  check('已处理建议再次 accept → 409 CONFLICT', again.status === 409 && parseBody(again).code === 'CONFLICT', again.status);
  const pendingDismiss = api.board(PROP).board.proposals.find((p) => p.status === 'pending');
  if (pendingDismiss) {
    const dm = await fdeCall(HOST, 'proposal', { method: 'POST', root: PROP, body: { action: 'dismiss', id: pendingDismiss.id } });
    check('proposal dismiss 标记 dismissed', parseBody(dm).ok === true && parseBody(dm).proposal.status === 'dismissed', rowBody(dm));
  }

  /* start_session 建议：accept 会真实建会话并保留 sessionId（防旧快照覆盖） */
  const wsSess = newRoot('sess');
  makeProject(wsSess, '会话客户-20260103', {
    '00-项目档案.md': '# 项目档案：会话客户\n',
    'research/事实核查清单.md': 'A 级',
    'research/KPI与痛点假设.md': '假设',
  });
  const se = api.engagement(wsSess, { action: 'create', patch: { name: '会话客户', company: '会话有限公司', dir: '会话客户-20260103', nextAction: { text: '补门禁', due: dateStr(6) } } }).engagement;
  {
    const b = store.readBoard(wsSess).board;
    const x = b.engagements.find((y) => y.id === se.id);
    x.stageSince = iso(-9); x.createdAt = iso(-9); x.timeline = [];
    store.writeBoard(wsSess, b);
  }
  const br = api.board(wsSess);
  const gateReady = br.board.proposals.find((p) => p.ruleId === 'gate_ready' && p.engagementId === se.id);
  check('gate_ready 生成 start_session 建议', !!gateReady && gateReady.kind === 'start_session', br.board.proposals.map((p) => p.ruleId));
  if (gateReady) {
    const accepted = await fdeCall(HOST, 'proposal', { method: 'POST', root: wsSess, body: { action: 'accept', id: gateReady.id } });
    check('start_session accept → 创建会话并标记 accepted',
      parseBody(accepted).ok === true && !!parseBody(accepted).sessionId && parseBody(accepted).proposal.status === 'accepted', rowBody(accepted));
    const after = api.board(wsSess).board.engagements.find((x) => x.id === se.id);
    check('accept 后会话记录未被旧快照覆盖（sessionId + timeline.session）',
      after.sessionId === parseBody(accepted).sessionId && (after.timeline || []).some((t) => t.kind === 'session'));
  }

  /* pending 上限 8 */
  const wsCap = newRoot('cap');
  for (let i = 0; i < 10; i += 1) {
    const x = api.engagement(wsCap, { action: 'create', patch: { name: '上限客户' + i, company: '上限' + i, nextAction: { text: '跟进', due: dateStr(20) } } }).engagement;
    const b = store.readBoard(wsCap).board;
    const y = b.engagements.find((z) => z.id === x.id);
    y.stageSince = iso(-20); y.createdAt = iso(-20); y.timeline = [];
    store.writeBoard(wsCap, b);
  }
  const capBoard = api.board(wsCap).board;
  const pendingCount = capBoard.proposals.filter((p) => p.status === 'pending').length;
  check('pending proposals 不超过 8 条上限（spec §14 噪音缓解）', pendingCount > 0 && pendingCount <= 8, pendingCount);
  note('O2', pendingCount < 8, pendingCount);

  /* 自主性：observe 不执行；assisted 只执行 safe；start_session 永不自动 */
  const wsAuto = newRoot('auto');
  const ae = api.engagement(wsAuto, { action: 'create', patch: { name: '自主客户', company: '自主有限公司', nextAction: { text: '', due: '' } } }).engagement;
  api.board(wsAuto); // 生成 no_next 建议
  const observe = api.applySafeProposals(wsAuto, api.board(wsAuto).board);
  check('observe 模式不自动执行任何建议', observe.ok === true && observe.applied.length === 0 && observe.mode === 'observe', observe);
  api.settings(wsAuto, { patch: { autonomy: 'assisted' } });
  const assisted = api.applySafeProposals(wsAuto, api.board(wsAuto).board);
  const aeAfter = api.board(wsAuto).board.engagements.find((x) => x.id === ae.id);
  check('assisted 模式执行安全动作（补 nextAction）', assisted.ok === true && assisted.applied.length >= 1 &&
    String(aeAfter.nextAction.text || '').length > 0, { applied: assisted.applied, nextAction: aeAfter.nextAction });
  check('assisted 模式不执行 start_session（门禁/对外/阶段类保持人工）',
    assisted.ok === true && !(api.board(wsAuto).board.proposals || []).some((p) => p.kind === 'start_session' && p.status === 'accepted'));
}

/* 并发写：快照写回不得覆盖并发 agent 写（评估 D2 的 CAS 兜底）。
 * 接受两种合法实现：①显式 expectedRevision 不匹配 → CONFLICT；
 *                  ②未显式传参但快照 stale → 不覆盖（ok:true/staleSkipped）。
 * 核心断言只有一条：并发写入的 report 不丢。 */
{
  const ws = newRoot('race');
  const e = api.engagement(ws, { action: 'create', patch: { name: '并发客户', company: '并发有限公司', nextAction: { text: '跟进', due: dateStr(3) } } }).engagement;
  const stale = store.readBoard(ws).board; // 模拟 GET /board 进入时的快照
  const it = api.item(ws, { action: 'create', patch: { title: '并发写入的任务', stage: 'doing', engagementId: e.id } }).item;
  api.item(ws, { action: 'report', id: it.id, kind: 'progress', text: 'agent 刚写的回报' });
  const w = store.writeBoard(ws, stale); // 模拟 refreshAndPersist 把快照写回
  const after = store.readBoard(ws).board;
  const itemAfter = after.items.find((x) => x.id === it.id);
  const reportKept = !!(itemAfter && (itemAfter.reports || []).some((r) => String(r.text || '').includes('agent 刚写的回报')));
  specCheck('F3', reportKept, {
    writeOk: w.ok, code: w.code, staleSkipped: w.staleSkipped,
    lostUpdate: !reportKept, itemsAfter: after.items.length,
  });
  /* 可选实现：显式 expectedRevision 过期时必须冲突/跳过且不覆盖 */
  const b0 = store.readBoard(ws).board;
  const rev0 = b0.revision != null ? b0.revision : (b0.rev != null ? b0.rev : null);
  if (rev0 != null) {
    const it2 = api.item(ws, { action: 'create', patch: { title: '并发任务2', stage: 'todo', engagementId: e.id } }).item;
    const w2 = store.writeBoard(ws, b0, { expectedRevision: rev0 });
    const after2 = store.readBoard(ws).board;
    const kept2 = after2.items.some((x) => x.id === it2.id);
    check('并发写（显式 expectedRevision 过期）：CONFLICT/staleSkipped 且不覆盖',
      kept2 && ((w2.ok === false && w2.code === 'CONFLICT') ||
        (w2.ok === true && (w2.staleSkipped === true || w2.skipped === true))),
      { writeOk: w2.ok, code: w2.code, staleSkipped: w2.staleSkipped, itemKept: kept2 });
  } else {
    note('O9', true, '实现尚未暴露 revision 字段');
    check('并发写（显式 expectedRevision）：当前实现未暴露 revision，跳过该可选断言（核心断言见上）', true);
  }
}

/* fde_brief apply=true：派生 artifacts 不得写入状态文件（spec §3 数据模型） */
{
  const ws = newRoot('pollute');
  api.engagement(ws, { action: 'create', patch: { name: '污染客户', company: '污染有限公司', nextAction: { text: '', due: '' } } });
  api.board(ws); // 生成 no_next 建议
  api.settings(ws, { patch: { autonomy: 'assisted' } });
  const b = api.board(ws); // index.js fde_brief 的真实路径：先 board() 再 applySafeProposals(b.board)
  const applied = api.applySafeProposals(ws, b.board);
  const raw = JSON.parse(readFileSync(store.boardPath(ws), 'utf8'));
  const hasDerived = (raw.engagements || []).some((x) => Object.prototype.hasOwnProperty.call(x, 'artifacts'));
  specCheck('F4', applied.ok === true && !hasDerived, { applied: applied.ok, hasDerived });
}

/* ============================ 9. 红线：agent 工具不得越权（spec §6 + 新 spec §7） ============================ */

/* 新口径（Lead 2026-11-03 裁定，spec §7 已更新）：
 * - agent 工具只允许 create/update、gate 只读评估；
 * - move（含 force）、archive、门禁人工勾选与 force 必须由人执行 → 工具层返回 {ok:false, code:'BLOCKED'}；
 * - 人类路径（面板 HTTP 路由）执行同一操作必须成功，且 timeline 如实记 by:"human"。
 * 同时断言「工具拒绝」与「面板允许」：只断言前者无法证明服务端不是两边都坏。 */
sec('9. 红线 · agent 工具挡得住吗（新 spec §7：move/archive/门禁勾选与 force 只能人做；gate 只读允许）');
{
  const t = (n) => HOST.tools.find((x) => x.name === n);
  const ws = newRoot('redline');
  const boardEng = (id) => api.board(ws).board.engagements.find((x) => x.id === id);
  const gateStateOf = (id) => JSON.stringify((boardEng(id) || {}).gateState || {});
  const stageOf = (id) => (boardEng(id) || {}).stage;
  const stageEntries = (id) => ((boardEng(id) || {}).timeline || []).filter((x) => x.kind === 'stage');

  /* 0) 准备：工具 create 仍允许；人类路径先用 HTTP 把门禁强制放行 */
  const made = await t('fde_engagement').execute({ action: 'create', name: '红线客户', company: '红线有限公司', root: ws });
  check('agent 工具 create 仍允许（白名单动作）', made && made.ok === true && !!made.engagement.id, made && made.text);
  const id = made.engagement.id;
  const humanGate = await fdeCall(HOST, 'gate', {
    method: 'POST', root: ws,
    body: { engagementId: id, stage: 'discovery', checks: { subject_locked: { status: 'pass', evidence: '人已确认' } }, force: true, reason: '人类强制放行' },
  });
  check('人类路径（HTTP /fde/gate）可强制放行门禁并落盘',
    parseBody(humanGate).ok === true && parseBody(humanGate).gate.forced === true, rowBody(humanGate));
  const gsAfterHuman = gateStateOf(id);
  const entriesAfterHuman = stageEntries(id).length;

  /* 1) 工具 move：即使门禁已由人放行，也必须被工具层以 BLOCKED 拒绝且不改状态 */
  const toolMove = await t('fde_engagement').execute({ action: 'move', id, patch: { stage: 'discovery' }, root: ws });
  specCheck('F1', toolMove && toolMove.ok === false && toolMove.code === 'BLOCKED',
    { ok: toolMove && toolMove.ok, code: toolMove && toolMove.code, text: toolMove && String(toolMove.text || '').slice(0, 140) });
  specCheck('F1', stageOf(id) === 'lead' && gateStateOf(id) === gsAfterHuman && stageEntries(id).length === entriesAfterHuman,
    { stage: stageOf(id), gateStateChanged: gateStateOf(id) !== gsAfterHuman, newStageEntries: stageEntries(id).length - entriesAfterHuman });

  /* 2) 工具 force move：拒绝且不得产生 forced 记录 / by:"human" 留痕 */
  const made2 = await t('fde_engagement').execute({ action: 'create', name: '强制红线客户', company: '强制红线有限公司', root: ws });
  const id2 = made2.engagement.id;
  const gs2 = gateStateOf(id2);
  const toolForce = await t('fde_engagement').execute({
    action: 'move', id: id2, patch: { stage: 'discovery', force: true, reason: 'agent 自行决定' }, root: ws,
  });
  specCheck('F1', toolForce && toolForce.ok === false && toolForce.code === 'BLOCKED',
    { ok: toolForce && toolForce.ok, code: toolForce && toolForce.code, text: toolForce && String(toolForce.text || '').slice(0, 140) });
  specCheck('F1', stageOf(id2) === 'lead' && gateStateOf(id2) === gs2 && !stageEntries(id2).some((x) => x.by === 'human'),
    { stage: stageOf(id2), gateState: gateStateOf(id2), stageEntries: stageEntries(id2).length });

  /* 3) 工具 archive：拒绝且阶段不变 */
  const toolArchive = await t('fde_engagement').execute({ action: 'archive', id: id2, root: ws });
  specCheck('F1', toolArchive && toolArchive.ok === false && toolArchive.code === 'BLOCKED',
    { ok: toolArchive && toolArchive.ok, code: toolArchive && toolArchive.code });
  specCheck('F1', stageOf(id2) === 'lead', { stage: stageOf(id2) });

  /* 4) 人类路径 move/archive：成功且 timeline by:"human" */
  const humanMove = await fdeCall(HOST, 'engagement', { method: 'POST', root: ws, body: { action: 'move', id, patch: { stage: 'discovery' } } });
  const moveEntries = stageEntries(id);
  check('人类路径（HTTP /fde/engagement move）成功且 timeline by:"human"',
    parseBody(humanMove).ok === true && stageOf(id) === 'discovery' &&
    moveEntries.length > entriesAfterHuman && moveEntries.slice(-1)[0].by === 'human', rowBody(humanMove));
  const humanArchive = await fdeCall(HOST, 'engagement', { method: 'POST', root: ws, body: { action: 'archive', id: id2 } });
  const archiveTl = ((boardEng(id2) || {}).timeline || []);
  check('人类路径（HTTP /fde/engagement archive）成功且 timeline by:"human"',
    parseBody(humanArchive).ok === true && stageOf(id2) === 'archived' &&
    archiveTl.length > 0 && archiveTl.slice(-1)[0].by === 'human', rowBody(humanArchive));

  /* 5) 工具 gate：只读评估允许；带 checks/force 必须显式 BLOCKED 且 gateState 不变 */
  const made3 = await t('fde_engagement').execute({ action: 'create', name: '门禁工具客户', company: '门禁工具有限公司', root: ws });
  const gid = made3.engagement.id;
  const readOnlyGate = await t('fde_engagement').execute({ action: 'gate', id: gid, patch: { stage: 'discovery' }, root: ws });
  specCheck('F5', readOnlyGate && readOnlyGate.ok === true && readOnlyGate.gate && readOnlyGate.gate.key === 'discovery',
    { ok: readOnlyGate && readOnlyGate.ok, gate: readOnlyGate && readOnlyGate.gate && readOnlyGate.gate.key });
  const gsBeforeToolGate = gateStateOf(gid);
  const toolGateWrite = await t('fde_engagement').execute({
    action: 'gate', id: gid,
    patch: { stage: 'discovery', checks: { subject_locked: { status: 'pass', evidence: '证据' } }, force: true, reason: '工具声明 force' },
    root: ws,
  });
  specCheck('F5', toolGateWrite && toolGateWrite.ok === false && toolGateWrite.code === 'BLOCKED',
    { ok: toolGateWrite && toolGateWrite.ok, code: toolGateWrite && toolGateWrite.code, text: toolGateWrite && String(toolGateWrite.text || '').slice(0, 140) });
  specCheck('F5', gateStateOf(gid) === gsBeforeToolGate,
    { gateStateBefore: gsBeforeToolGate, gateStateAfter: gateStateOf(gid) });

  /* 6) 同一组门禁参数走人类路径（HTTP）必须落盘——证明「工具拒绝、面板允许」而不是两边都坏 */
  const humanGate2 = await fdeCall(HOST, 'gate', {
    method: 'POST', root: ws,
    body: {
      engagementId: gid, stage: 'discovery',
      checks: { subject_locked: { status: 'pass', evidence: '人在面板勾选' } }, force: true, reason: '人确认强制放行',
    },
  });
  const gsHuman = (JSON.parse(gateStateOf(gid) || '{}')).discovery || {};
  check('人类路径（HTTP /fde/gate）同一参数会落盘（checks + forced）',
    parseBody(humanGate2).ok === true && !!gsHuman.checks && !!gsHuman.checks.subject_locked &&
    gsHuman.checks.subject_locked.status === 'pass' && gsHuman.forced === true,
    { status: humanGate2.status, gateState: gsHuman });

  /* 7) 删除任务：工具层必须拒绝（spec §6 红线） */
  const it = await t('fde_item').execute({ action: 'create', patch: { title: '待删任务', stage: 'todo' }, root: ws });
  const del = await t('fde_item').execute({ action: 'delete', id: it.item.id, root: ws });
  check('agent 工具删除任务被拒（红线）', del && del.ok === false && del.code === 'BLOCKED', del && { ok: del.ok, code: del.code });
  check('agent 工具删除客户无入口（fde_engagement 无 delete action）',
    !t('fde_engagement').parameters.properties.action.enum.includes('delete'));
}

/* ============================ 10. 交接提示词：阶段方法 / 产物 / 回报闭环（spec §9） ============================ */

sec('10. 交接（handoff）· 提示词固定内容、真实建会话、workspace 选择');
const HANDOFF = newRoot('handoff');
const STAGE_SKILL = {
  lead: 'fde-engagement', discovery: 'fde-discovery', meeting: 'fde-meeting',
  scoping: 'fde-scoping',
  solution: 'fde-solution', pilot: 'fde-pilot', delivery: 'fde-delivery', adoption: 'fde-adoption',
};
let handoffEngIds = {};
{
  for (const st of schema.ENGAGEMENT_STAGES) {
    const e = api.engagement(HANDOFF, { action: 'create', patch: { name: st.label + '阶段客户', company: st.label + '有限公司', source: { kind: 'manual' }, nextAction: { text: '推进' + st.label, due: dateStr(5) } } }).engagement;
    handoffEngIds[st.key] = e.id;
  }
  setStages(HANDOFF, Object.entries(handoffEngIds).map(([stage, id]) => [id, stage]));
  const route = (body) => fdeCall(HOST, 'handoff', { method: 'POST', root: HANDOFF, body });
  for (const st of schema.ENGAGEMENT_STAGES) {
    const r = await route({ target: 'engagement', id: handoffEngIds[st.key] });
    const p = parseBody(r).prompt || '';
    check('handoff(' + st.key + ') 创建会话并返回提示词', parseBody(r).ok === true && !!parseBody(r).sessionId &&
      typeof p === 'string' && p.length > 300, { status: r.status, reason: parseBody(r).reason });
    check('handoff(' + st.key + ') 提示词含编排声明/红线',
      p.includes('编排声明') && p.includes('不要自行推进') && p.includes('对外发送'));
    check('handoff(' + st.key + ') 提示词含客户上下文（名称/目录/阶段/缺口）',
      p.includes('客户上下文') && p.includes('阶段') && p.includes('门禁缺口') && p.includes('research/'));
    check('handoff(' + st.key + ') 提示词含该阶段技能 ' + STAGE_SKILL[st.key], p.includes(STAGE_SKILL[st.key]));
    check('handoff(' + st.key + ') 提示词含方法文件与产物落盘路径',
      p.includes('methods/') && p.includes('【产物落盘】'));
    check('handoff(' + st.key + ') 提示词含回报要求（fde_item + 300 字 + artifacts）',
      p.includes('fde_item') && p.includes('300 字') && p.includes('artifacts'));
    if (st.key === 'lead') {
      /* F2：engagement 目标提示词是否给出可执行的回报路径（itemId 或先建任务指引） */
      const actionable = /\bitm_[0-9a-f]{6}\b/.test(p) ||
        /(先|创建|建立|新建).{0,12}(任务|item)|(任务|item).{0,12}(创建|建立|新建)/i.test(p);
      specCheck('F2', actionable, { excerpt: p.slice(p.indexOf('【回报要求】'), p.indexOf('【回报要求】') + 220) });
    }
    if (st.key === 'scoping') {
      check('handoff(scoping) 提示词含 fde-scoping 技能 + fde_scenario + 四条硬门槛（spec §20.4/§21.1）',
        p.includes('fde-scoping') && p.includes('fde_scenario') &&
        ['发起人', '14 天', '90 天', '可测量'].every((k) => p.includes(k)));
      check('handoff(scoping) 产物路径为 scoping/（场景评估表/数据可得性/范围）',
        p.includes('scoping/') && p.includes('场景评估表') && p.includes('数据可得性'));
    }
  }
  /* item 目标：回报必须带 itemId */
  const it = api.item(HANDOFF, { action: 'create', patch: { title: '交接任务', stage: 'todo', engagementId: handoffEngIds.solution } }).item;
  const ir = await fdeCall(HOST, 'handoff', { method: 'POST', root: HANDOFF, body: { target: 'item', id: it.id } });
  const ip = parseBody(ir).prompt || '';
  check('item handoff 提示词含 itemId + 回报要求', parseBody(ir).ok === true && ip.includes(it.id) && ip.includes('fde_item') && ip.includes('300 字'));
  check('item handoff 写回 item.sessionId 与 history',
    api.board(HANDOFF).board.items.find((x) => x.id === it.id).sessionId === parseBody(ir).sessionId);

  /* 已归档客户不发起阶段会话 */
  const archived = api.engagement(HANDOFF, { action: 'create', patch: { name: '归档客户', company: '归档有限公司' } }).engagement;
  api.engagement(HANDOFF, { action: 'archive', id: archived.id });
  const ar = await route({ target: 'engagement', id: archived.id });
  check('已归档客户 handoff → 409 CONFLICT', ar.status === 409 && parseBody(ar).code === 'CONFLICT', ar.status);

  /* workspace 选择：不能盲选 updatedAt 最新（修复点回归） */
  const unrelated = newRoot('unrelated');
  const wsH = newRoot('workspace-choice');
  const eH = api.engagement(wsH, { action: 'create', patch: { name: '工作区客户', company: '工作区有限公司' } }).engagement;
  const prevRoot = currentRef.root;
  currentRef.root = unrelated;
  const wr = await fdeCall(HOST, 'handoff', { method: 'POST', root: wsH, body: { target: 'engagement', id: eH.id } });
  const lastSession = HOST.sessions[HOST.sessions.length - 1];
  check('handoff 工作区选择：当前工作区与客户根无关时，选与客户根匹配的工作区（不盲选最新）',
    parseBody(wr).ok === true && lastSession && lastSession.workspaceId === idOf(wsH),
    { target: lastSession, expect: idOf(wsH), root: rowBody(wr) });
  /* 当前工作区是客户根的祖先时优先当前 */
  const parent = newRoot('parent');
  const nested = registerNested(parent, 'nested-proj');
  const eN = api.engagement(nested, { action: 'create', patch: { name: '嵌套客户', company: '嵌套有限公司' } }).engagement;
  currentRef.root = parent;
  const nr = await fdeCall(HOST, 'handoff', { method: 'POST', root: nested, body: { target: 'engagement', id: eN.id } });
  const nestedSession = HOST.sessions[HOST.sessions.length - 1];
  check('handoff 工作区选择：当前工作区包含客户根时优先当前工作区',
    parseBody(nr).ok === true && nestedSession && nestedSession.workspaceId === idOf(parent),
    { target: nestedSession, expect: idOf(parent) });
  currentRef.root = prevRoot;
}

/* 会话服务缺失：降级为 200 + prompt（剪贴板兜底，spec §16.10） */
{
  const noSessionHost = await applyMock(join(PLUGIN, 'index.js'), { currentRef, sessionMode: 'missing' });
  const r = await call(noSessionHost, FDE_PREFIX + 'handoff', {
    method: 'POST', root: HANDOFF, body: { target: 'engagement', id: handoffEngIds.discovery },
  });
  check('未挂载会话服务：handoff → 200 + ok:false + 可复制 prompt',
    r.status === 200 && parseBody(r).ok === false && typeof parseBody(r).prompt === 'string' &&
    parseBody(r).prompt.length > 100, { status: r.status, body: rowBody(r) });
}

/* ============================ 11. 一致性：客户端 ⇄ 宿主路由 / meta 单点 / 客户端不硬编码 ============================ */

sec('11. 一致性 · 客户端路由集合 ⇄ index.js 注册 / meta 单一来源');
{
  const src = readFileSync(join(PLUGIN, 'src', 'ui', 'ui-panel.js'), 'utf8');
  const calls = [];
  for (const m of src.matchAll(/fde(Get|Post)\('([^']+)'/g)) {
    calls.push({ method: m[1] === 'Get' ? 'GET' : 'POST', path: m[2].split('?')[0] });
  }
  /* 面板里有两类直接调用：fdeGet/fdePost 包装，以及少量 getJSON(FDE + '/xxx')；都计入调用集合。 */
  for (const m of src.matchAll(/getJSON\(FDE \+ '\/([a-z/]+)/g)) calls.push({ method: 'GET', path: '/' + m[1] });
  const norm = (x) => String(x).replace(/^\/+/, '');
  /* v1.3：面板调用集合与宿主注册集合做**全量**双向一致性；唯一豁免是「兼容保留」的 scys 两条
   * （v1.2 生财面板入口已移除、工具/缓存保留，spec §19 / §20.6）。 */
  const COMPAT_ONLY = new Set(['scys/feed', 'scys/refresh']);
  const clientPaths = new Set(calls.map((c) => norm(c.path)));
  const registered = new Set(fdeRoutes.map((r) => norm(r.path.slice(FDE_PREFIX.length))));
  check('客户端 fetch 的每个 /fde/* 路径都在 index.js 注册（无死链）',
    [...clientPaths].every((x) => registered.has(x)), [...clientPaths].filter((x) => !registered.has(x)));
  const zombies = [...registered].filter((x) => !clientPaths.has(x));
  check('index.js 注册的每条 FDE 路由都被面板调用；僵尸路由仅豁免兼容保留 scys/feed|refresh（v1.3）',
    zombies.every((x) => COMPAT_ONLY.has(x)), zombies);
  check('兼容保留路由恰为 scys/feed + scys/refresh 且均已注册（生财页签移除但服务保留）',
    COMPAT_ONLY.size === 2 && [...COMPAT_ONLY].every((x) => registered.has(x)) &&
    zombies.filter((x) => COMPAT_ONLY.has(x)).length === 2);
  const methodMap = new Map([...EXPECTED_ROUTES, ...V11_ROUTES, ...V12_COMPAT_ROUTES, ...V13_ROUTES].map(([n, m]) => [n, m]));
  /* scys/auth 是唯一同路径双方法路由（GET 状态 / POST 保存·清除），按允许集合比较。 */
  const multiMethod = new Map([[AUTH_ROUTE[0], AUTH_ROUTE[1]]]);
  const wrongMethod = calls.filter((c) => {
    const p = norm(c.path);
    if (multiMethod.has(p)) return !multiMethod.get(p).includes(c.method);
    return methodMap.has(p) && methodMap.get(p) !== c.method;
  });
  check('客户端调用方法与宿主注册方法一致（GET/POST 无错配，含招采/资料库/授权）', wrongMethod.length === 0, wrongMethod);
  check('面板 API 前缀唯一常量（/research-workbench/api）', (src.match(/'\/research-workbench\/api'/g) || []).length === 1);
  check('面板 FDE 前缀由 API 派生（const FDE = API + \'/fde\'）', src.includes("const FDE = API + '/fde'"));
  check('fetch 只出现在统一请求层（2 处）', (src.match(/\bfetch\(/g) || []).length === 2);

  /* 不硬编码阶段顺序 / 泳道顺序（spec §16.5；v1.3 起 8 阶段、9 页签） */
  const quotedStage = ['lead', 'discovery'].filter((k) => new RegExp("['\"]" + k + "['\"]").test(src));
  check('面板源码不含阶段特有 key 字面量（lead/discovery，顺序只能来自 meta）', quotedStage.length === 0, quotedStage);
  const st = schema.STAGE_KEYS;
  check('面板源码不含 8 阶段 key 的硬编码顺序片段（任意 60 字窗口）', !new RegExp(st.join('[\\s\\S]{0,60}')).test(src));
  check('面板源码不含过期 7 阶段计数，也不硬编码阶段数（stages.length === 7/8、slice(0,7)）',
    !/七阶段|7\s*个阶段/.test(src) && !/(stages|stageKeys|STAGES)\.length\s*===?\s*[78]/.test(src) &&
    !/(stages|stageKeys|STAGES)\.slice\(0,\s*[78]\)/.test(src));
  check('面板从 meta 读阶段/泳道（meta.stages / meta.boardLanes / normalizeMeta）',
    src.includes('meta.stages') && src.includes('meta.boardLanes') && src.includes('function normalizeMeta('));
  check('看板列由 meta 生成（客户模式 stages / 任务模式 boardLanes，8 列不写死）',
    /asList\(meta && meta\.stages\)\.map\(\(s\) => \(\{ key: s\.key/.test(src) &&
    /asList\(meta && meta\.boardLanes\)\.map\(\(l\) => \(\{ key: l\.key/.test(src));
  check('抽屉阶段步进用 stageIndex(meta, …) 定位（不写死下标）', /stageIndex\(meta(Ref\.current)?,/.test(src));
  check('门禁定义从 meta.gates 取（不写死 key）', /function gateOfStage\(/.test(src) && /meta\.gates/.test(src));
  check('面板轮询 10–15s 且只有 1 个定时器', (() => {
    const poll = /const POLL_MS = (\d+);/.exec(src);
    return poll && Number(poll[1]) >= 10000 && Number(poll[1]) <= 15000 && (src.match(/setInterval\(/g) || []).length === 1;
  })());
  check('兼容页：探测 /fde/meta，失败显示重启说明且保留经典模式入口',
    src.includes("getJSON(FDE + '/meta')") && src.includes('function CompatPage(') &&
    src.includes('宿主需要重启 DSH 后启用 FDE 看板') && src.includes("t('classicMode')"));
  /* 5 页签（v1.4 起，ADR 0005）：从 FdeApp 的 tab 定义数组提取（顺序即导航）；设置走页头入口；生财页签不存在 */
  const navBlock = (src.match(/const navItems = \[([\s\S]*?)\];/) || ['', ''])[1];
  const tabKeys = [...navBlock.matchAll(/\{ key: '([a-z]+)'/g)].map((m) => m[1]);
  check('FDE 面板 5 页签且顺序为 今日/客户/资料/流程/文件（spec §8 / ADR 0005；资料内部 key=knowledge）',
    tabKeys.join(',') === 'today,customers,knowledge,process,files', tabKeys);
  check('视图组件齐全（5 页签 + 页内子视图/设置/经典模式）且设置与子页签组件存在',
    ['Today', 'Board', 'Customers', 'Process', 'Library', 'Bids', 'Artifacts', 'Methods', 'Settings']
      .every((v) => src.includes('function ' + v + 'View(')) && src.includes('function ClassicApp(')
      && /function\s+SettingsView\s*\(/.test(src) && /function\s+normalizeView\s*\(/.test(src));
  /* 口径同步（ADR 0004 D5 / 实施规格 §2.8）：生财「页签」已移除，但设置页新增「生财情报授权」卡片，
   * 资料库仍标注社区来源；因此不再按出现次数 ≤2 断言，改为逐处上下文白名单（仍禁止 ScysView/tabScys）。 */
  check('生财页签已移除（无 ScysView / tabScys；「生财」仅出现在资料库社区来源与设置页生财情报授权）',
    !/ScysView/.test(src) && !/tabScys/.test(src) && (() => {
      const ALLOWED = /生财情报授权|生财社区|生财有术|生财 MCP|生财 FDE 情报|「生财」/;
      return [...src.matchAll(/.{0,30}生财.{0,40}/g)].every((m) => ALLOWED.test(m[0]));
    })(), [...src.matchAll(/.{0,30}生财.{0,40}/g)]
      .filter((m) => !/生财情报授权|生财社区|生财有术|生财 MCP|生财 FDE 情报|「生财」/.test(m[0]))
      .map((m) => m[0].trim()).slice(0, 5));
  check('流程视图从 meta.stages[].playbook 派生（目标/输入/动作/交付物/工具/坑）',
    src.includes('function ProcessView(') && /playbook/.test(src) &&
    ['goal', 'inputs', 'activities', 'outputs', 'tools', 'pitfalls'].every((k) => new RegExp('playbook(\\.| && playbook\\.)' + k).test(src)));
  check('流程视图工具 chips 支持 kind 分组与跳转方法页（MethodsView initialName）',
    /PROCESS_TOOL_KINDS\s*=\s*\['skill', 'method', 'template', 'tool', 'library'\]/.test(src) &&
    /initialName/.test(src) && /initialSeq/.test(src));
  check('资料库视图存在且读 /library/feed + POST /library/refresh（spec §19.6）',
    src.includes('function LibraryView(') && src.includes('/library/feed') && src.includes('/library/refresh'));
  check('资料库视图含重点推荐/来源组/阶段筛选/仅看重点推荐/搜索/刷新/降级态',
    /featured/.test(src) && /feed\.stats|stats\.intlOfficial/.test(src) &&
    /仅看重点推荐|libFeaturedOnly/.test(src) && /libRefresh/.test(src) &&
    /libCatalogMissing|catalog 缺失/.test(src));
  check('资料库外链安全：window.open + noopener,noreferrer + 仅 http(s)',
    /window\.open\([^)]*_blank[^)]*noopener/.test(src) && /\^https\?:\\\/\\\//.test(src));
  check('不用 localStorage 当事实源 / 不 import @deepseek-ai/*',
    !/localStorage|sessionStorage/.test(src) && !src.includes('@deepseek-ai'));
  check('无原生 alert/confirm/prompt（错误行内展示）',
    !/\balert\(/.test(src) && !/window\.confirm\(/.test(src) && !/window\.prompt\(/.test(src));
  check('只用主题 token 定义语义色（--dsw-alias-*）', (src.match(/var\(--dsw-alias-/g) || []).length >= 40);
}

/* meta 与 schema 单点一致 */
{
  const r = await fdeCall(HOST, 'meta', { root: MAIN });
  const m = parseBody(r).meta || {};
  check('meta.apiPrefix === schema.API_PREFIX', m.apiPrefix === schema.API_PREFIX);
  check('meta.stages 与 ENGAGEMENT_STAGES 完全一致（key/label/order/gate）',
    JSON.stringify(m.stages.map((s) => [s.key, s.label, s.order, s.gate])) ===
    JSON.stringify(schema.ENGAGEMENT_STAGES.map((s) => [s.key, s.label, s.order, s.gate])));
  check('meta.stages 原样返回 playbook（8 阶段都有，面板从 /meta 读；spec §20.3）',
    Array.isArray(m.stages) && m.stages.length === 8 && m.stages.every((s) => s.playbook &&
      JSON.stringify(s.playbook) === JSON.stringify((schema.ENGAGEMENT_STAGES.find((x) => x.key === s.key) || {}).playbook)));
  check('meta.itemTypes 与 ITEM_TYPES 一致且为 9 类（v1.3 新增 scoping；spec §20.4）',
    Array.isArray(m.itemTypes) && m.itemTypes.length === 9 &&
    JSON.stringify(m.itemTypes.map((t) => t.key)) === JSON.stringify(schema.ITEM_TYPE_KEYS));
  check('meta.lanes 与 ITEM_LANES 一致（key/label/order/board）',
    JSON.stringify(m.lanes.map((l) => [l.key, l.label, l.order, !!l.board])) ===
    JSON.stringify(schema.ITEM_LANES.map((l) => [l.key, l.label, l.order, !!l.board])));
  check('meta.boardLanes === schema.BOARD_LANES', JSON.stringify(m.boardLanes) === JSON.stringify(schema.BOARD_LANES));
  check('meta.gates 按阶段索引且与 GATES 的 auto/manual key 一致', schema.ENGAGEMENT_STAGES.every((st) => {
    const g = m.gates[st.key];
    const def = schema.GATES[st.gate];
    return g && g.key === def.key && g.stage === def.stage &&
      JSON.stringify(g.auto.map((c) => c.key)) === JSON.stringify(def.auto.map((c) => c.key)) &&
      JSON.stringify(g.manual.map((c) => c.key)) === JSON.stringify(def.manual.map((c) => c.key));
  }));
  check('meta.gateList 与 GATE_KEYS 一致', JSON.stringify(m.gateList.map((g) => g.key)) === JSON.stringify(schema.GATE_KEYS));
  check('meta.attentionKinds 顺序符合 spec §5', JSON.stringify(m.attentionKinds.map((a) => a.key)) ===
    JSON.stringify(['blocked', 'decision', 'review', 'answer', 'overdue', 'gate', 'stall', 'proposal']));
  check('meta.rules 规则清单与 RULES 一致', JSON.stringify(m.rules.map((x) => [x.ruleId, x.kind])) ===
    JSON.stringify(schema.RULES.map((x) => [x.ruleId, x.kind])));
  check('meta.redLines 为 spec §6 六条红线',
    Array.isArray(m.redLines) && m.redLines.length === 6 &&
    JSON.stringify(m.redLines) === JSON.stringify(schema.RED_LINES));
  check('meta.defaults.settings === schema.DEFAULT_SETTINGS', JSON.stringify(m.defaults.settings) === JSON.stringify(schema.DEFAULT_SETTINGS));
  const board = await fdeCall(HOST, 'board', { root: MAIN });
  check('GET /board 内嵌 meta 与 /fde/meta 同源（阶段一致）',
    JSON.stringify(parseBody(board).meta.stages.map((s) => s.key)) === JSON.stringify(m.stages.map((s) => s.key)));
}

/* ============================ 12. skills 与降级 ============================ */

sec('12. skills · 16 个技能（11 个 fde-* + 4 方法库 + 1 通用）frontmatter / 注册 / 服务与目录降级（spec §10 / §16.9）');
const SKILLS_DIR = join(PLUGIN, 'skills');
const EXPECTED_SKILLS = ['fde-engagement', 'fde-discovery', 'fde-meeting', 'fde-scoping', 'fde-solution',
  'fde-pilot', 'fde-delivery', 'fde-adoption', 'fde-board', 'fde-harvest', 'fde-bid-radar'];
const LEGACY_SKILLS = ['company-research', 'meeting-prep', 'proposal-forge', 'domain-model-partnership'];
{
  const found = api.discoverSkills(SKILLS_DIR);
  check('discoverSkills 共 16 个（11 FDE（v1.3 新增 fde-scoping）+ 4 方法库 + 1 通用）',
    found.length === 16 && found.filter((s) => s.name.startsWith('fde-')).length === 11, found.map((s) => s.name));
  check('11 个 FDE 技能名与 spec §10 / §17.8 / §20.4 一一对应',
    JSON.stringify(found.filter((s) => s.name.startsWith('fde-')).map((s) => s.name).sort()) === JSON.stringify(EXPECTED_SKILLS.slice().sort()));
  check('4 个方法库技能保留', LEGACY_SKILLS.every((n) => found.some((s) => s.name === n)));
  check('1 个通用技能 longdoc-brief 保留', found.some((s) => s.name === 'longdoc-brief'));
  for (const sk of found) {
    const dir = basename(dirname(sk.path));
    check('技能 ' + sk.name + '：name=目录名、kebab-case、单行 description',
      sk.name === dir && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sk.name) && sk.description.length >= 10 && !/\n/.test(sk.description));
    check('技能 ' + sk.name + '：content 为正文且 resourceBase 指向技能目录',
      typeof sk.content === 'string' && sk.content.length > 100 && !sk.content.startsWith('---') &&
      sk.resourceBase && sk.resourceBase.kind === 'directory' && sk.resourceBase.path === dirname(sk.path));
  }
  for (const n of EXPECTED_SKILLS) {
    const sk = found.find((s) => s.name === n);
    const body = (sk && sk.content) || '';
    check('FDE 技能 ' + n + ' 正文含 触发/输入/步骤/产物/边界',
      ['触发', '输入', '步骤', '产物', '边界'].every((k) => body.includes(k)));
  }
  check('宿主 mock 已注册全部 16 个技能（v1.3：11 FDE + 4 方法库 + 1 通用）', HOST.skills.length === 16 && HOST.skills.filter((x) => String(x.name).startsWith('fde-')).length === 11, HOST.skills.length);
  check('注册项字段齐全（name/description/content/path/resourceBase）且无重名',
    HOST.skills.every((s) => s.name && s.description && typeof s.content === 'string' && s.path && s.resourceBase) &&
    new Set(HOST.skills.map((s) => s.name)).size === HOST.skills.length);
}
/* 服务缺失 / register 抛错 / get 抛错：apply 不得抛，其他能力不得丢 */
{
  for (const [label, opts] of [
    ['skills 服务缺失', { skillsMode: 'missing' }],
    ['skills.register 抛错', { skillsMode: 'throw-register' }],
    ['ctx.get("skills") 抛错', { skillsMode: 'throw-get' }],
  ]) {
    const h = await applyMock(join(PLUGIN, 'index.js'), Object.assign({ currentRef }, opts));
    check(label + '：apply 不抛异常', h.threw === null, h.threw && String(h.threw.message));
    check(label + '：16 工具 + 37 路由仍正常注册（v1.3 + ADR 0004 授权路由）', h.tools.length === 16 && h.routes.length === 37, { tools: h.tools.length, routes: h.routes.length });
    check(label + '：技能注册静默降级（0 个成功注册，不阻断启动）', h.skills.length === 0);
  }
  /* 空 skills 目录：复制最小插件到 tmp，import 一个新的 skills 目录 */
  const copy = mkdtempSync(join(tmpdir(), 'fde-plug-copy-'));
  copyDirs.push(copy);
  for (const f of ['index.js', 'package.json']) cpSync(join(PLUGIN, f), join(copy, f));
  for (const d of ['src', 'methods', 'reference', 'templates', 'scripts']) cpSync(join(PLUGIN, d), join(copy, d), { recursive: true });
  mkdirSync(join(copy, 'skills')); // 空目录
  const emptyHost = await applyMock(join(copy, 'index.js'), { currentRef: { root: MAIN } });
  check('skills 目录为空：apply 不抛异常', emptyHost.threw === null, emptyHost.threw && String(emptyHost.threw.message));
  check('skills 目录为空：16 工具 + 37 路由仍注册（v1.3 + ADR 0004 授权路由）', emptyHost.tools.length === 16 && emptyHost.routes.length === 37,
    { tools: emptyHost.tools.length, routes: emptyHost.routes.length });
  check('skills 目录为空：0 个技能注册（静默降级）', emptyHost.skills.length === 0);
  const emptyMeta = await call(emptyHost, FDE_PREFIX + 'meta', { root: MAIN });
  check('skills 目录为空：/fde/meta 仍返回（meta.skills=[]，面板不白屏）',
    parseBody(emptyMeta).ok === true && Array.isArray(parseBody(emptyMeta).meta.skills) && parseBody(emptyMeta).meta.skills.length === 0);
  const emptyHealth = await call(emptyHost, FDE_PREFIX + 'health', { root: MAIN });
  check('skills 目录为空：/fde/health 把技能列为 warn（不 fail）',
    parseBody(emptyHealth).ok === true &&
    parseBody(emptyHealth).checks.filter((c) => c.name === 'skills 注册').every((c) => c.status === 'warn'),
    parseBody(emptyHealth).checks && parseBody(emptyHealth).checks.filter((c) => c.name === 'skills 注册'));
  /* webServer / tools 缺失：apply 不抛（服务缺失不影响其他能力） */
  const noWeb = await applyMock(join(PLUGIN, 'index.js'), { currentRef, missing: { webServer: true } });
  check('webServer 缺失：apply 不抛且工具仍注册（v1.3 = 16）', noWeb.threw === null && noWeb.tools.length === 16,
    { threw: noWeb.threw && String(noWeb.threw.message), tools: noWeb.tools.length });
  const noTools = await applyMock(join(PLUGIN, 'index.js'), { currentRef, missing: { tools: true } });
  check('tools 缺失：apply 不抛且路由仍注册（v1.3 = 37）', noTools.threw === null && noTools.routes.length === 37,
    { threw: noTools.threw && String(noTools.threw.message), routes: noTools.routes.length });
  check('宿主半源码无 @deepseek-ai 依赖、package.json 无运行时依赖（spec §16.1；ADR 0004 D3 允许可选 peer @deepseek-ai/dsh）', (() => {
    const files = ['index.js', ...readdirSync(join(PLUGIN, 'src', 'host')).map((f) => join('src', 'host', f))];
    const hasImport = files.some((f) => /(?:from\s+|import\s*\(|require\s*\()\s*['\"]@deepseek-ai/.test(readFileSync(join(PLUGIN, f), 'utf8')));
    const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
    /* 开源契约（ADR 0004 D3）：无 dependencies；peerDependencies 只允许 @deepseek-ai/dsh 且 optional。 */
    const peerKeys = Object.keys(pkg.peerDependencies || {});
    const optionalPeer = !!(pkg.peerDependenciesMeta && pkg.peerDependenciesMeta['@deepseek-ai/dsh'] &&
      pkg.peerDependenciesMeta['@deepseek-ai/dsh'].optional === true);
    const peerOk = peerKeys.length === 0 || (peerKeys.length === 1 && peerKeys[0] === '@deepseek-ai/dsh' && optionalPeer);
    return !hasImport && !(pkg.dependencies && Object.keys(pkg.dependencies).length) && peerOk;
  })());
}
/* 系统提示词：旧铁律保留 + FDE 增量 */
{
  const text = (HOST.sections[0] && HOST.sections[0].text) || '';
  check('系统提示词只 1 段（替换而非新增）', HOST.sections.length === 1);
  check('系统提示词保留旧铁律（md 优先/地址锚定/三链/候选人≠中标人）',
    ['默认只交付', '不要主动导出 PDF', '地址锚定', '三链验证', '候选人 ≠ 中标人'].every((m) => text.includes(m)));
  check('系统提示词含 FDE 编排者声明/阶段门禁/回报协议/红线',
    ['FDE 编排者声明', '阶段门禁', '回报协议', '红线', 'fde_item'].every((m) => text.includes(m)));
}

/* ============================ 13. 数据：真实工作区只读 adopt scan ============================ */

/* 工作区可用 `FDE_WORKSPACE` 指定（与 scripts/health-check.mjs 同口径）；默认插件上一级。
 * 无 research/ 时（干净检出 / CI / npm 包解压目录）跳过本段并记 WARN，不判失败（ADR 0004 D6）。 */
const AUDIT_WORKSPACE = process.env.FDE_WORKSPACE ? resolve(process.env.FDE_WORKSPACE) : REAL_ROOT;
const AUDIT_RESEARCH = join(AUDIT_WORKSPACE, 'research');
sec('13. 数据 · 工作区只读 adopt scan（可选；无 research/ 时 WARN 跳过）');
if (!existsSync(AUDIT_RESEARCH) || (() => { try { return !statSync(AUDIT_RESEARCH).isDirectory(); } catch { return true; } })()) {
  console.log('  ⚠ 跳过：工作区没有 research/（' + AUDIT_RESEARCH + '）；干净检出/CI 属预期，' +
    '需要审计真实工作区时用 FDE_WORKSPACE=<含 research/ 的根> 指定');
} else {
  const research = AUDIT_RESEARCH;
  const fde = join(research, '.fde');
  const boardFile = join(fde, 'board.json');
  check('工作区存在 research/（审计对象）', existsSync(research));
  const fdeBefore = existsSync(fde);
  const boardBefore = existsSync(boardFile) ? readFileSync(boardFile, 'utf8') : '';
  const mtimeBefore = existsSync(boardFile) ? statSync(boardFile).mtimeMs : 0;
  const topBefore = readdirSync(research).sort();
  const t0 = Date.now();
  const scan = api.adopt(AUDIT_WORKSPACE, { action: 'scan' });
  const ms = Date.now() - t0;
  check('真实工作区 adopt scan 成功（只读）', scan.ok === true && Array.isArray(scan.candidates), scan && scan.reason);
  /* 真实看板若已被初始化（Lead 已 adopt apply），候选应全部 alreadyImported（0 候选属正常）；否则应有候选 */
  const initialized = boardBefore.length > 0;
  const candidates = scan.ok ? scan.candidates : [];
  /* 口径修正（v1.2）：board 已初始化后新增/遗留的 research 目录出现「未导入候选」是**正常待办**，
   * 不是缺陷——adopt 是两段式（scan → 人确认 apply），因此断言只检查 scan 给每个候选标了导入状态，
   * 并在 detail 里列出来待导入目录，不再要求「候选全部已导入」。 */
  /* 环境依赖：工作区 research/ 下若没有任何子目录，则「未初始化应有候选」不适用 */
  const researchHasDirs = existsSync(research) && readdirSync(research, { withFileTypes: true }).some((d) => d.isDirectory());
  check('真实工作区 scan 结果为每个候选标注导入状态（未初始化→有候选；已初始化→列出待导入）',
    initialized ? candidates.every((c) => typeof c.alreadyImported === 'boolean') : (!researchHasDirs || candidates.length >= 1),
    { initialized, candidates: candidates.length, notImported: candidates.filter((c) => !c.alreadyImported).map((c) => c.dir), skipped: researchHasDirs ? undefined : '工作区 research/ 下无子目录' });
  check('真实工作区 scan 候选字段完整（dir/title/kind/suggestedStage/confidence）',
    candidates.every((c) => c.dir && c.title && ['project', 'legacy'].includes(c.kind) &&
      schema.isStage(c.suggestedStage) && typeof c.confidence === 'string'));
  check('真实工作区 scan 未修改 research/.fde/board.json（内容与 mtime 均未变）',
    (existsSync(boardFile) === (boardBefore.length > 0)) &&
    (boardBefore.length === 0 || readFileSync(boardFile, 'utf8') === boardBefore) &&
    (mtimeBefore === 0 || statSync(boardFile).mtimeMs === mtimeBefore),
    { existedBefore: boardBefore.length > 0, sameBytes: boardBefore.length === 0 || readFileSync(boardFile, 'utf8') === boardBefore });
  check('真实工作区 scan 未新增/删除 research/ 顶层条目',
    JSON.stringify(readdirSync(research).sort()) === JSON.stringify(topBefore));
  check('真实工作区 scan 未创建 .fde（若原本不存在）', existsSync(fde) === fdeBefore || fdeBefore === true);
  check('真实工作区 scan 性能可接受（< 5s，样本量 ' + topBefore.length + ' 条）', ms < 5000, ms + 'ms');
}

/* ============================ 14. 第三轮：招采雷达集成（spec §17 / ADR-0002） ============================ */

/* 设计原则：
 * - 独立断言：只按 docs/01-spec.md §17 契约写，假 bidIntel 服务注入，不读真实 42MB 索引；
 * - 实现未就绪（宿主路由/工具、面板、服务适配层任一缺失）时记录「等待实现」，不把既有 395 条拖红；
 * - 能力就绪后自动执行；失败按 B1–B8 登记 P0/P1/P2。
 * 假服务记录形状取自 bid-intel 数据契约（id/source/kind/url/date/title/project_no/buyer/winner/candidates/amounts/excerpt）。 */
const clientSrc17 = readFileSync(join(PLUGIN, 'src', 'ui', 'ui-panel.js'), 'utf8');
const hostFiles17 = ['index.js'].concat(readdirSync(join(PLUGIN, 'src', 'host')).map((f) => join('src', 'host', f)));
const hostSrc17 = hostFiles17.map((f) => { try { return readFileSync(join(PLUGIN, f), 'utf8'); } catch { return ''; } }).join('\n');
const BIDS_PREFIX = FDE_PREFIX + 'bids/';
const BIDS_ROUTES = [
  ['stats', 'GET'], ['search', 'GET'], ['match', 'GET'],
  ['link', 'POST'], ['unlink', 'POST'], ['promote', 'POST'], ['refresh', 'POST'],
];
const G17 = {
  routes: HOST.routes.some((r) => String(r.path).startsWith(BIDS_PREFIX)),
  tool: HOST.tools.some((t) => t.name === 'fde_bid'),
  client: (() => {
    const want = ['stats', 'search', 'match', 'link', 'unlink', 'promote', 'refresh'];
    const got = new Set([...clientSrc17.matchAll(/\/bids\/(stats|search|match|link|unlink|promote|refresh)/g)].map((m) => m[1]));
    return want.every((x) => got.has(x));
  })(),
  adapter: /bidIntel/.test(hostSrc17),
};
G17.any = G17.routes || G17.tool || G17.client || G17.adapter;

const FINDINGS17 = {
  B1: { sev: 'P0', title: '招采服务缺失/版本不匹配时未优雅降级（应 available:false、200、不抛；工具应 UNAVAILABLE）' },
  B2: { sev: 'P1', title: '匹配/分类不符 spec §17.3（关系优先级、tender/award、去重、金额不求和、查询词去噪）' },
  B3: { sev: 'P1', title: 'link/unlink/promote 不符 spec §17.4（持久化/幂等/by 留痕/promote item 带 bidRefs）' },
  B4: { sev: 'P1', title: 'bid_signal 规则不符 spec §17.6（开关/30 天/招标类/去重/dismissed 30 天/paused/上限）' },
  B5: { sev: 'P2', title: 'bids 路由/缓存契约偏差（方法、415、路径安全、limit、mtime 缓存 + refresh）' },
  B6: { sev: 'P2', title: '客户端招采集成偏差（资料→招采子页签、API 路径登记、available=false 降级、卡片徽章条件）' },
  B7: { sev: 'P2', title: 'fde_bid 工具契约偏差（schema/紧凑返回/口径提示/UNAVAILABLE）' },
  B8: { sev: 'P2', title: 'health 未纳入招采雷达检查（服务可用 records>0 → ok，否则 warn 不 fail）' },
};
const thirdFindings = new Set();
const pending17 = [];
const pend17 = (name, need) => { const x = (need ? '[' + need + '] ' : '') + name; if (!pending17.includes(x)) pending17.push(x); };
function check17(name, cond, detail, need = 'routes') {
  if (!G17[need]) { pend17(name, need); return false; }
  return check('[§17] ' + name, cond, detail);
}
function spec17(id, cond, detail, need = 'routes') {
  if (!G17[need]) { pend17(FINDINGS17[id].title, need); return false; }
  const ok = check('[§17·' + id + '·' + FINDINGS17[id].sev + '] ' + FINDINGS17[id].title, cond, detail);
  if (!ok) thirdFindings.add(id);
  return ok;
}

/* ---------- 假 bidIntel 服务（确定性；不读真实索引） ---------- */
function makeFakeBidIntel(records, opts = {}) {
  const state = {
    version: opts.version == null ? 1 : opts.version,
    mtime: opts.mtime || 1000,
    records: records.slice(),
  };
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const hay = (r) => norm([r.title, r.buyer, r.winner, r.project_no,
    (r.candidates || []).map((c) => c.name).join(' '), r.excerpt].join(' '));
  function search(o = {}) {
    const mode = o.mode || 'any';
    const q = norm(o.q);
    const limit = Math.min(50, Math.max(1, Number(o.limit) || 50));
    const offset = Number(o.offset) || 0;
    const hits = state.records.filter((r) => {
      if (o.from && r.date && r.date < o.from) return false;
      if (o.to && r.date && r.date > o.to) return false;
      if (o.source && r.source !== o.source) return false;
      if (!q) return true;
      if (mode === 'buyer') return norm(r.buyer).includes(q);
      if (mode === 'company') {
        return norm(r.winner).includes(q) ||
          (r.candidates || []).some((c) => norm(c.name).includes(q)) || hay(r).includes(q);
      }
      if (mode === 'title') return norm(r.title).includes(q);
      return hay(r).includes(q);
    });
    hits.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return {
      total: hits.length,
      direct: hits.filter((r) => r.winner || (r.candidates || []).length).length,
      mentioned: hits.filter((r) => !r.winner && !(r.candidates || []).length).length,
      offset, limit,
      items: hits.slice(offset, offset + limit).map((r) => Object.assign({}, r, { match: mode })),
      facets: { years: {}, sources: [] },
    };
  }
  return {
    version: state.version,
    dataMeta: () => ({ file: '/fake/notices.jsonl', mtime: state.mtime, bytes: 42 * 1024 * 1024, records: state.records.length, missing: false }),
    stats: () => ({
      records: state.records.length, missing: false, file: '/fake/notices.jsonl',
      sources: [{ name: 'fake', count: state.records.length }],
      years: {}, withWinner: state.records.filter((r) => r.winner).length,
      withBuyer: state.records.filter((r) => r.buyer).length,
      withAmount: state.records.filter((r) => (r.amounts || []).length).length,
      dateRange: ['2025-01-01', dateStr(0)],
    }),
    search,
    timeline: () => ({ total: 0, items: [], byMonth: {} }),
    batches: () => ({ total: 0, clusters: [] }),
    report: () => '# fake report',
    _state: state,
    _add(rec) { state.records.push(rec); state.mtime += 1; },
    _touch() { state.mtime += 1; },
  };
}
const BID_CLIENT = { company: '测试客户有限公司', shortName: '测试客户', dir: '测试客户-20260101' };
const rec = (over) => Object.assign({
  id: 'fake:0', source: 'fake', channel: 'c', kind: '招标公告',
  url: 'https://example.test/0', date: dateStr(-10), title: '', project_no: 'P0',
  buyer: '', winner: '', candidates: [], amounts: [], excerpt: '',
}, over);
const BID_RECORDS = [
  rec({ id: 'fake:1', buyer: BID_CLIENT.company, kind: '招标公告', title: BID_CLIENT.company + ' 2026 年设备采购招标公告', date: dateStr(-10), amounts: ['100万元'] }),
  rec({ id: 'fake:2', buyer: '甲方研究院', winner: BID_CLIENT.company, kind: '中标结果公告', title: 'XX系统采购中标结果公告', date: dateStr(-20), amounts: ['200万元'] }),
  rec({ id: 'fake:3', buyer: '乙方公司', candidates: [{ name: BID_CLIENT.company, rank: 1 }], kind: '中标候选人公示', title: 'YY项目中标候选人公示', date: dateStr(-15) }),
  rec({ id: 'fake:4', buyer: '丙方单位', kind: '其他公告', title: '关于某项目合作事项的说明', excerpt: BID_CLIENT.company + ' 参与该项目。', date: dateStr(-30) }),
  rec({ id: 'fake:5', buyer: BID_CLIENT.company, kind: '询价公告', title: BID_CLIENT.company + ' 2025 年采购询价公告', date: dateStr(-60) }),
  rec({ id: 'fake:6', buyer: BID_CLIENT.company, kind: '中标结果公告', title: BID_CLIENT.company + ' 某项目中标结果', date: dateStr(-5) }),
  /* 同 id 两条（模拟多查询词/多 mode 命中同一条记录）：去重断言用 */
  rec({ id: 'fake:1', buyer: BID_CLIENT.company, kind: '招标公告', title: BID_CLIENT.company + ' 2026 年设备采购招标公告（重复）', date: dateStr(-10) }),
];
const FAKE_BID = makeFakeBidIntel(BID_RECORDS);
const FAKE_BID_OLD = makeFakeBidIntel(BID_RECORDS, { version: 2 });
const BIDHOST = await applyMock(join(PLUGIN, 'index.js'), { currentRef, bidIntel: FAKE_BID });
const BADHOST = await applyMock(join(PLUGIN, 'index.js'), { currentRef, bidIntel: FAKE_BID_OLD });

/* ---------- 14.1 服务契约 / 降级（§17.1、§17.9-1） ---------- */
sec('§17.1 bidIntel 服务契约与降级（可用 / 缺失 / 版本不匹配）');
{
  /* 服务缺失（主替身宿主无 bidIntel）：所有 bids 路由 200 + available:false，不 500 */
  const statsMissing = await fdeCall(HOST, 'bids/stats', { root: MAIN });
  spec17('B1', statsMissing.status === 200 && parseBody(statsMissing).ok === true &&
    parseBody(statsMissing).available === false && typeof parseBody(statsMissing).reason === 'string',
  { status: statsMissing.status, body: rowBody(statsMissing) });
  const routeProbes = [
    ['bids/search', 'GET', {}],
    ['bids/match', 'GET', { engagementId: 'eng_000000' }],
    ['bids/link', 'POST', { engagementId: 'eng_000000', bidId: 'fake:1' }],
    ['bids/unlink', 'POST', { engagementId: 'eng_000000', bidId: 'fake:1' }],
    ['bids/promote', 'POST', { engagementId: 'eng_000000', bidId: 'fake:1' }],
    ['bids/refresh', 'POST', { engagementId: 'eng_000000' }],
  ];
  const badDegrade = [];
  for (const [r, m, body] of routeProbes) {
    const res = await fdeCall(HOST, r, { method: m, root: MAIN, body });
    if (!(res.status === 200 && parseBody(res).ok === true && parseBody(res).available === false)) {
      badDegrade.push({ route: r, status: res.status, available: parseBody(res).available, reason: parseBody(res).reason });
    }
  }
  spec17('B1', badDegrade.length === 0, badDegrade);

  /* 版本不匹配（version:2）同样按不可用处理 */
  const statsBadVer = await fdeCall(BADHOST, 'bids/stats', { root: MAIN });
  spec17('B1', statsBadVer.status === 200 && parseBody(statsBadVer).ok === true && parseBody(statsBadVer).available === false,
    { status: statsBadVer.status, body: rowBody(statsBadVer) });

  /* 服务可用：stats.records>0 + dataMeta 契约 */
  const statsOk = await fdeCall(BIDHOST, 'bids/stats', { root: MAIN });
  const st = parseBody(statsOk);
  spec17('B1', statsOk.status === 200 && st.ok === true && st.available === true &&
    st.stats && Number(st.stats.records) > 0 && st.dataMeta && typeof st.dataMeta.mtime === 'number' &&
    Number(st.dataMeta.records) > 0, { status: statsOk.status, body: rowBody(statsOk) });

  /* 工具 fde_bid：服务缺失/旧版本 → ok:false + code UNAVAILABLE；可用 → ok:true 紧凑列表 */
  const bidTool = (host) => host.tools.find((t) => t.name === 'fde_bid');
  if (G17.tool) {
    const miss = await bidTool(HOST).execute({ action: 'search', q: '测试', root: MAIN });
    spec17('B1', miss && miss.ok === false && miss.code === 'UNAVAILABLE' && /未就绪|不可用/.test(String(miss.reason || '')), miss);
    const badv = await bidTool(BADHOST).execute({ action: 'search', q: '测试', root: MAIN });
    spec17('B1', badv && badv.ok === false && badv.code === 'UNAVAILABLE', badv);
    const ok = await bidTool(BIDHOST).execute({ action: 'search', q: BID_CLIENT.company, limit: 50, root: MAIN });
    const okItems = (ok && (ok.items || (ok.result && ok.result.items))) || [];
    spec17('B7', ok && ok.ok === true && okItems.length <= 20 &&
      /候选人|中标/.test(String(ok.text || '')), { ok: ok && ok.ok, count: okItems.length, text: String(ok && ok.text || '').slice(0, 120) });
  } else {
    pend17('fde_bid 工具（服务缺失/可用路径）', 'tool');
  }
}

/* ---------- 14.2 匹配与分类（§17.3、§17.9-2/4） ---------- */
sec('§17.2 匹配分类 / 去重 / tender-award / 金额口径 / 查询词去噪 / 缓存');
let MATCH_WS17 = null;
{
  const ws = newRoot('bidmatch');
  MATCH_WS17 = ws;
  const eng = api.engagement(ws, {
    action: 'create',
    patch: {
      name: BID_CLIENT.shortName, company: BID_CLIENT.company, shortName: BID_CLIENT.shortName,
      dir: BID_CLIENT.dir, source: { kind: 'manual' }, nextAction: { text: '补采购证据', due: dateStr(5) },
      bidWatch: { enabled: true, keywords: [], links: [] },
    },
  });
  if (!eng.ok) check('测试预置：招采匹配客户创建成功（bidWatch 字段被接受）', false, eng.reason);
  const eid = eng.ok ? eng.engagement.id : '';
  const match = await fdeCall(BIDHOST, 'bids/match', { root: ws, body: {}, method: 'GET' });
  let payload = parseBody(match);
  if (G17.routes && payload.available !== true) {
    /* 用 query 形式再试一次（GET 路由通常读 qs） */
    const r2 = await call(BIDHOST, BIDS_PREFIX + 'match?engagementId=' + encodeURIComponent(eid) + '&refresh=1', { root: ws });
    payload = parseBody(r2);
  } else if (G17.routes) {
    const r2 = await call(BIDHOST, BIDS_PREFIX + 'match?engagementId=' + encodeURIComponent(eid) + '&refresh=1', { root: ws });
    payload = parseBody(r2);
  }
  const items = payload.items || [];
  const relOf = (id) => (items.find((x) => x.id === id) || {}).relation;
  const ids = items.map((x) => x.id);
  spec17('B2', payload.ok === true && payload.available === true && items.length > 0, { ok: payload.ok, available: payload.available, reason: payload.reason });
  spec17('B2', new Set(ids).size === ids.length, { duplicateIds: ids.filter((x, i) => ids.indexOf(x) !== i) });
  spec17('B2', relOf('fake:1') === 'buyer' && relOf('fake:2') === 'winner' &&
    relOf('fake:3') === 'candidate' && relOf('fake:4') === 'mention',
  { relations: { f1: relOf('fake:1'), f2: relOf('fake:2'), f3: relOf('fake:3'), f4: relOf('fake:4') } });
  /* 关系优先级：buyer > winner > candidate > mention（用同一条记录多字段命中的构造验证） */
  const prio = items.find((x) => x.id === 'fake:1');
  const statsM = payload.stats || {};
  spec17('B2', statsM.tender >= 1 && statsM.award >= 1 && statsM.candidate >= 1 &&
    Number(statsM.total) === new Set(ids).size, { stats: statsM, unique: new Set(ids).size });
  /* tender/award 标记：招标/询价类 → tender；中标/成交/结果类 → award */
  spec17('B2', !!(prio && (prio.tender === true || prio.kind === '招标公告')), prio && { tender: prio.tender, kind: prio.kind });
  const awardRec = items.find((x) => x.id === 'fake:2') || {};
  spec17('B2', !!(awardRec.award === true || /中标|成交|结果/.test(String(awardRec.kind || ''))), { award: awardRec.award, kind: awardRec.kind });
  /* 金额不求和：stats 不出现数值型金额合计 */
  const statsStr = JSON.stringify(statsM);
  spec17('B2', !/"(totalAmount|amountSum|sumAmount|amount|amounts)"\s*:\s*\d/.test(statsStr), statsStr.slice(0, 200));
  /* 查询词去噪：≤8、≥2 字、无去后缀后仅剩停用词、无重复、去年份后缀、含全称/简称 */
  const queries = payload.queries || [];
  const qNoise = queries.filter((q) => String(q).length < 2);
  spec17('B2', Array.isArray(queries) && queries.length > 0 && queries.length <= 8 && qNoise.length === 0 &&
    new Set(queries).size === queries.length &&
    queries.some((q) => String(q).includes('测试客户')) &&
    !queries.some((q) => /^有限公司$|^集团$|^研究院$/.test(String(q))) &&
    !queries.some((q) => /-20\d{6}$/.test(String(q))),
  { queries, qNoise });
  /* 缓存：数据 mtime 变化后 match 结果更新；refresh 立即失效 */
  if (G17.routes) {
    const firstTotal = Number(statsM.total) || 0;
    FAKE_BID._add(rec({ id: 'fake:new', buyer: BID_CLIENT.company, kind: '招标公告', title: BID_CLIENT.company + ' 新增采购招标公告', date: dateStr(-1) }));
    const cached = await call(BIDHOST, BIDS_PREFIX + 'match?engagementId=' + encodeURIComponent(eid), { root: ws });
    const afterCached = parseBody(cached).stats || {};
    const forced = await call(BIDHOST, BIDS_PREFIX + 'match?engagementId=' + encodeURIComponent(eid) + '&refresh=1', { root: ws });
    const afterForced = parseBody(forced).stats || {};
    spec17('B5', Number(afterCached.total) === firstTotal && Number(afterForced.total) > firstTotal,
      { firstTotal, cachedTotal: afterCached.total, forcedTotal: afterForced.total });
    /* 清理 fake:new，避免影响其他断言 */
    FAKE_BID._state.records = FAKE_BID._state.records.filter((r) => r.id !== 'fake:new');
    FAKE_BID._touch();
  }
}

/* ---------- 14.3 link / unlink / promote（§17.4、§17.9-3/7） ---------- */
sec('§17.3 link/unlink/promote · 持久化/幂等/by 留痕/item.bidRefs（人类 + agent）');
const LINK_WS17 = newRoot('bidlink');
{
  const eng = api.engagement(LINK_WS17, {
    action: 'create',
    patch: {
      name: BID_CLIENT.shortName, company: BID_CLIENT.company, shortName: BID_CLIENT.shortName,
      dir: BID_CLIENT.dir, nextAction: { text: '补证据', due: dateStr(5) },
      bidWatch: { enabled: true, keywords: [], links: [] },
    },
  });
  const eid = eng.ok ? eng.engagement.id : '';
  const linksOf = () => (api.board(LINK_WS17).board.engagements.find((x) => x.id === eid) || {}).bidWatch || {};
  check17('测试预置：客户 bidWatch 字段可创建', eng.ok && !!eid, eng.reason);
  /* 人类路径 link */
  const link1 = await fdeCall(BIDHOST, 'bids/link', { method: 'POST', root: LINK_WS17, body: { engagementId: eid, bidId: 'fake:2', relation: 'winner', note: '会面证据' } });
  spec17('B3', parseBody(link1).ok === true, { status: link1.status, body: rowBody(link1) });
  const lw = linksOf();
  const linkEntry = (lw.links || []).find((l) => l.bidId === 'fake:2');
  spec17('B3', !!linkEntry && linkEntry.by === 'human' && !!linkEntry.linkedAt && linkEntry.relation === 'winner' &&
    linkEntry.note === '会面证据' && linkEntry.title && linkEntry.date, linkEntry || lw);
  const tlLink = (api.board(LINK_WS17).board.engagements.find((x) => x.id === eid) || {}).timeline || [];
  spec17('B3', tlLink.some((t) => t.by === 'human' && /关联|招采|link/i.test(String(t.text || ''))), tlLink.slice(-2));
  /* 幂等：重复 link 不产生重复条目 */
  await fdeCall(BIDHOST, 'bids/link', { method: 'POST', root: LINK_WS17, body: { engagementId: eid, bidId: 'fake:2', relation: 'winner' } });
  spec17('B3', ((linksOf().links || []).filter((l) => l.bidId === 'fake:2')).length === 1, (linksOf().links || []).map((l) => l.bidId));
  /* unlink */
  const unlink1 = await fdeCall(BIDHOST, 'bids/unlink', { method: 'POST', root: LINK_WS17, body: { engagementId: eid, bidId: 'fake:2' } });
  spec17('B3', parseBody(unlink1).ok === true && !(linksOf().links || []).some((l) => l.bidId === 'fake:2'), rowBody(unlink1));
  /* promote：建 item + bidRefs + link */
  const promote = await fdeCall(BIDHOST, 'bids/promote', { method: 'POST', root: LINK_WS17, body: { engagementId: eid, bidId: 'fake:1' } });
  const promo = parseBody(promote);
  const newItem = promo.item || {};
  spec17('B3', promo.ok === true && !!newItem.id && newItem.stage === 'todo' && newItem.type === 'followup' &&
    /跟进招标/.test(String(newItem.title || '')), { ok: promo.ok, item: newItem && { id: newItem.id, stage: newItem.stage, type: newItem.type, title: newItem.title } });
  const savedItem = api.board(LINK_WS17).board.items.find((x) => x.id === newItem.id) || {};
  spec17('B3', Array.isArray(savedItem.bidRefs) && savedItem.bidRefs.some((b) => b.bidId === 'fake:1') &&
    (linksOf().links || []).some((l) => l.bidId === 'fake:1'), { bidRefs: savedItem.bidRefs, links: (linksOf().links || []).map((l) => l.bidId) });
  /* agent 路径（fde_bid 工具）：link/unlink/promote 允许且 by:"agent" */
  const bidTool = BIDHOST.tools.find((t) => t.name === 'fde_bid');
  if (bidTool) {
    const tl = await bidTool.execute({ action: 'link', engagementId: eid, bidId: 'fake:3', relation: 'candidate', note: 'agent 关联', root: LINK_WS17 });
    spec17('B3', tl && tl.ok === true, tl);
    const agentLink = (linksOf().links || []).find((l) => l.bidId === 'fake:3');
    spec17('B3', !!agentLink && agentLink.by === 'agent', agentLink || linksOf());
    const tu = await bidTool.execute({ action: 'unlink', engagementId: eid, bidId: 'fake:3', root: LINK_WS17 });
    spec17('B3', tu && tu.ok === true && !(linksOf().links || []).some((l) => l.bidId === 'fake:3'), tu);
    const tp = await bidTool.execute({ action: 'promote', engagementId: eid, bidId: 'fake:4', root: LINK_WS17 });
    spec17('B3', tp && tp.ok === true, tp);
  } else {
    pend17('fde_bid link/unlink/promote（agent 路径）', 'tool');
  }
}

/* ---------- 14.4 bid_signal 规则（§17.6、§17.9-5） ---------- */
sec('§17.4 bid_signal · 开关/30 天/招标类/buyer|mention/去重/dismissed 30 天/paused/上限');
{
  const ws = newRoot('bidsignal');
  const eng = api.engagement(ws, {
    action: 'create',
    patch: {
      name: BID_CLIENT.shortName, company: BID_CLIENT.company, shortName: BID_CLIENT.shortName,
      dir: BID_CLIENT.dir, nextAction: { text: '跟进采购信号', due: dateStr(10) },
      bidWatch: { enabled: true, keywords: [], links: [] },
    },
  });
  const eid = eng.ok ? eng.engagement.id : '';
  api.settings(ws, { patch: { sources: { bidWatch: true } } });
  const listSignals = (boardPayload, id) => ((boardPayload && boardPayload.board && boardPayload.board.proposals) || [])
    .filter((p) => p && p.ruleId === 'bid_signal' && (!id || p.engagementId === id));
  const board1 = await fdeCall(BIDHOST, 'board', { root: ws });
  const p1 = parseBody(board1);
  const sig1 = listSignals(p1, eid);
  spec17('B4', sig1.length >= 1, { proposals: ((p1.board && p1.board.proposals) || []).map((x) => x.ruleId) });
  spec17('B4', sig1.every((p) => p.payload && p.payload.bidId && p.payload.engagementId === eid) &&
    sig1.some((p) => /招标|采购|询价|谈判/.test(String(p.title || '') + String(p.detail || '') + JSON.stringify(p.payload))), sig1);
  /* 不应为旧公告/纯中标类生成信号；也不应为 paused 客户生成 */
  const badSignal = sig1.filter((p) => p.payload && /fake:5|fake:6/.test(String(p.payload.bidId)));
  spec17('B4', badSignal.length === 0, badSignal.map((p) => p.payload.bidId));
  const eng2 = api.engagement(ws, {
    action: 'create',
    patch: {
      name: '暂停招采客户', company: BID_CLIENT.company, shortName: BID_CLIENT.shortName,
      nextAction: { text: '暂停', due: dateStr(10) }, paused: true,
      bidWatch: { enabled: true, keywords: [], links: [] },
    },
  });
  await fdeCall(BIDHOST, 'board', { root: ws });
  const pausedSignals = (api.board(ws).board.proposals || []).filter((p) => p.ruleId === 'bid_signal' && p.engagementId === (eng2.engagement && eng2.engagement.id));
  spec17('B4', pausedSignals.length === 0, pausedSignals.length);
  /* 去重：同一次刷新/再次刷新不生成同 bid 重复 */
  const beforeCount = (api.board(ws).board.proposals || []).filter((p) => p.ruleId === 'bid_signal' && p.engagementId === eid).length;
  await fdeCall(BIDHOST, 'board', { root: ws });
  const afterCount = (api.board(ws).board.proposals || []).filter((p) => p.ruleId === 'bid_signal' && p.engagementId === eid).length;
  spec17('B4', afterCount === beforeCount, { beforeCount, afterCount });
  /* dismissed 30 天内不重复生成 */
  const toDismiss = (api.board(ws).board.proposals || []).find((p) => p.ruleId === 'bid_signal' && p.engagementId === eid && p.status === 'pending');
  if (toDismiss) {
    const dismissedBid = toDismiss.payload && toDismiss.payload.bidId;
    await fdeCall(BIDHOST, 'proposal', { method: 'POST', root: ws, body: { action: 'dismiss', id: toDismiss.id } });
    await fdeCall(BIDHOST, 'board', { root: ws });
    await fdeCall(BIDHOST, 'board', { root: ws });
    const regen = (api.board(ws).board.proposals || []).filter((p) => p.ruleId === 'bid_signal' && p.status === 'pending' &&
      p.engagementId === eid && p.payload && p.payload.bidId === dismissedBid);
    spec17('B4', regen.length === 0, { dismissedBid, regen: regen.length });
  } else {
    pend17('bid_signal dismissed 30 天断言（未找到可 dismiss 的 signal）', 'routes');
  }
  /* pending 上限（全局 ≤8，§17.6 明确仍受上限约束） */
  const pendingAll = (api.board(ws).board.proposals || []).filter((p) => p.status === 'pending').length;
  spec17('B4', pendingAll <= 8, { pendingAll });
  /* 开关关闭：不生成 */
  api.settings(ws, { patch: { sources: { bidWatch: false } } });
  const wsOff = newRoot('bidsignaloff');
  const engOff = api.engagement(wsOff, {
    action: 'create',
    patch: {
      name: BID_CLIENT.shortName, company: BID_CLIENT.company, shortName: BID_CLIENT.shortName,
      nextAction: { text: '跟进', due: dateStr(10) },
      bidWatch: { enabled: true, keywords: [], links: [] },
    },
  });
  api.settings(wsOff, { patch: { sources: { bidWatch: false } } });
  await fdeCall(BIDHOST, 'board', { root: wsOff });
  const offSignals = ((api.board(wsOff).board.proposals) || []).filter((p) => p.ruleId === 'bid_signal' && p.engagementId === (engOff.engagement && engOff.engagement.id));
  spec17('B4', offSignals.length === 0, offSignals.length);
}

/* ---------- 14.5 7 条新路由 + makeGuard（§17.4、§17.9-8） ---------- */
sec('§17.5 bids 路由存在性/方法/守卫/limit/空结果');
{
  const missingRoutes = BIDS_ROUTES.filter(([n]) => !routeOf(BIDHOST, BIDS_PREFIX + n)).map(([n]) => n);
  spec17('B5', missingRoutes.length === 0, missingRoutes);
  const wrongMethods = [];
  for (const [n, m] of BIDS_ROUTES) {
    const wrong = m === 'GET' ? 'POST' : 'GET';
    const r = await fdeCall(BIDHOST, 'bids/' + n, { method: wrong, root: MAIN, body: {} });
    if (r.status !== 405) wrongMethods.push({ route: n, wrong, status: r.status });
  }
  spec17('B5', wrongMethods.length === 0, wrongMethods);
  /* POST 非 JSON → 415 */
  const badType = [];
  for (const [n] of BIDS_ROUTES.filter(([, m]) => m === 'POST')) {
    const r = await fdeCall(BIDHOST, 'bids/' + n, { method: 'POST', root: MAIN, body: {}, contentType: 'text/plain' });
    if (r.status !== 415) badType.push({ route: n, status: r.status });
  }
  spec17('B5', badType.length === 0, badType);
  /* makeGuard：伪造 Host / 外站 Origin → 403 */
  const badHost = await call(BIDHOST, BIDS_PREFIX + 'stats', { headers: { host: 'evil.example.com' } });
  const badOrigin = await call(BIDHOST, BIDS_PREFIX + 'stats', { headers: { host: '127.0.0.1:62419', origin: 'http://evil.example.com' } });
  spec17('B5', badHost.status === 403 && badOrigin.status === 403, { badHost: badHost.status, badOrigin: badOrigin.status });
  /* search：缺省 mode=any、limit 上限 50、空结果不报错 */
  const search1 = await call(BIDHOST, BIDS_PREFIX + 'search?limit=999', { root: MAIN });
  const s1 = parseBody(search1);
  spec17('B5', search1.status === 200 && s1.ok === true && Array.isArray(s1.items) && s1.items.length <= 50,
    { status: search1.status, count: (s1.items || []).length });
  const searchEmpty = await call(BIDHOST, BIDS_PREFIX + 'search?q=' + encodeURIComponent('不存在的单位XYZ'), { root: MAIN });
  spec17('B5', searchEmpty.status === 200 && parseBody(searchEmpty).ok === true && Array.isArray(parseBody(searchEmpty).items) &&
    parseBody(searchEmpty).items.length === 0, { status: searchEmpty.status, body: rowBody(searchEmpty) });
  /* 路径安全：engagementId 穿越不得读到工作区外 / 不得 500 */
  const trav = await call(BIDHOST, BIDS_PREFIX + 'match?engagementId=' + encodeURIComponent('../../etc'), { root: MAIN });
  spec17('B5', [400, 404, 200].includes(trav.status) && !parseBody(trav).items, { status: trav.status, body: rowBody(trav) });
  const travLink = await fdeCall(BIDHOST, 'bids/link', { method: 'POST', root: MAIN, body: { engagementId: '../../etc', bidId: 'fake:1' } });
  spec17('B5', travLink.status === 400 || travLink.status === 404, { status: travLink.status });
}

/* ---------- 14.6 客户端一致性（§17.7、§17.9-6） ---------- */
sec('§17.6 客户端一致性 · 招采页签/API 路径登记/降级文案/卡片徽章');
{
  check17('面板源码含招采集成（页签/视图/文案）', /招采/.test(clientSrc17), undefined, 'client');
  /* 客户端源码里出现过的 /bids/* 路径（不依赖具体 helper） */
  const clientSrcNoComments = clientSrc17
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const clientBidNames = [...new Set([...clientSrcNoComments.matchAll(/\/bids\/([a-z]+)/g)].map((m) => m[1]))];
  const clientBidCalls = clientBidNames.map((n) => ({
    method: ['link', 'unlink', 'promote', 'refresh'].includes(n) ? 'POST' : 'GET', path: '/bids/' + n,
  }));
  const want = ['/bids/stats', '/bids/search', '/bids/match', '/bids/link', '/bids/unlink', '/bids/promote', '/bids/refresh'];
  const missingCalls = want.filter((p) => !clientBidCalls.some((c) => c.path === p));
  spec17('B6', clientBidCalls.length > 0 && missingCalls.length === 0, { calls: clientBidCalls, missingCalls }, 'client');
  /* 客户端使用的招采 API 路径必须都在宿主注册（已有 routes 时才可判） */
  const registeredBids = new Set(BIDS_ROUTES.map(([n, m]) => '/bids/' + n + '|' + m));
  const wrongMethod = clientBidCalls.filter((c) => !registeredBids.has(c.path + '|' + c.method));
  if (G17.routes) {
    spec17('B6', wrongMethod.length === 0, { wrongMethod, calls: clientBidCalls }, 'client');
  } else {
    pend17('客户端 bids API 路径 ⊆ 宿主注册（方法一致）', 'routes');
  }
  spec17('B6', /招采雷达未就绪/.test(clientSrc17), '缺少 spec §17.1 指定的降级文案', 'client');
  /* 卡片徽章条件：必须由 bids.available / bids.total 驱动（不可无条件渲染） */
  spec17('B6', /bids\.available|bids\?\.available|!.*available/.test(clientSrc17) &&
    /bids\.total|bids\.matches|bids\.latest|bidCount/.test(clientSrc17),
  '未找到「bids 有匹配才显示徽章」的条件渲染', 'client');
  /* 招采视图（v1.4 起为「资料」子页签；DICT/子页签出现招采） */
  spec17('B6', /tabBid|tabBids|招采/.test(clientSrc17) && /function\s+Bid\w*View\s*\(/.test(clientSrc17),
    '未找到招采视图组件'), 'client';
}

/* ---------- 14.7 health 招采检查（§17.8） ---------- */
sec('§17.7 health · 招采雷达服务检查项（可用 ok / 缺失 warn 不 fail）');
{
  const hOk = await fdeCall(BIDHOST, 'health', { root: MAIN });
  const checksOk = parseBody(hOk).checks || [];
  const bidCheck = checksOk.find((c) => /招采|bidIntel/i.test(String(c.name)));
  spec17('B8', hOk.status === 200 && parseBody(hOk).ok === true && !!bidCheck && bidCheck.status === 'ok',
    { checks: checksOk.map((c) => c.name + ':' + c.status) });
  const hMiss = await fdeCall(HOST, 'health', { root: MAIN });
  const checksMiss = parseBody(hMiss).checks || [];
  const bidCheckMiss = checksMiss.find((c) => /招采|bidIntel/i.test(String(c.name)));
  spec17('B8', hMiss.status === 200 && parseBody(hMiss).ok === true && !!bidCheckMiss && bidCheckMiss.status === 'warn' &&
    !checksMiss.some((c) => c.status === 'fail'), { checks: checksMiss.map((c) => c.name + ':' + c.status) });
}

/* §17 汇总（打印在本节末尾；不影响后续 v1.3 段落与总汇总的 exit 语义） */
console.log('\n§17 第三轮小结：断言通过（本段）已并入总数；等待实现 ' + pending17.length + ' 项' +
  (thirdFindings.size ? '；发现 ' + [...thirdFindings].sort().join('、') : ''));
if (pending17.length) {
  console.log('  等待实现清单（宿主/客户端就绪后自动转为断言）：');
  for (const p of pending17.slice(0, 40)) console.log('    ⏳ ' + p);
  if (pending17.length > 40) console.log('    … 共 ' + pending17.length + ' 项');
}


/* ============================ 15. v1.3 · §19 FDE 资料库 ============================ */

sec('§19 资料库 · catalog 合法性（真实目录只读；spec §19.1 / §19.8-1）');
{
  const catalogFile = join(PLUGIN, 'reference', 'fde-library', 'catalog.json');
  check('资料目录 reference/fde-library/catalog.json 存在（策展层随插件发布）', existsSync(catalogFile));
  const rawText = readFileSync(catalogFile, 'utf8');
  let cat = null; let parseErr = '';
  try { cat = JSON.parse(rawText); } catch (e) { parseErr = String((e && e.message) || e); }
  check('catalog 为合法 JSON', !!cat && !parseErr, parseErr);
  const v = fdeLibrary.validateCatalog(cat);
  check('validateCatalog 校验通过（硬错误 0）', v.ok === true && v.errors.length === 0, v.errors.slice(0, 5));
  check('catalog 版本/更新日期合法（version=1，updatedAt=YYYY-MM-DD）',
    cat.version === 1 && /^\d{4}-\d{2}-\d{2}$/.test(String(cat.updatedAt || '')));
  const items = Array.isArray(cat.items) ? cat.items : [];
  check('catalog 条目 108 条（v1.3 收尾策展规模；105 → 108 新增 3 条 GitHub 教程/示例集）', items.length === 108, items.length);
  check('groups 为 5 个规定来源组且顺序恒定（国外官方/国内官方/开源工具/方法与模板/社区动态）',
    Array.isArray(cat.groups) && cat.groups.map((g) => g.key).join(',') === fdeLibrary.GROUP_KEYS.join(','),
    cat.groups && cat.groups.map((g) => g.key));
  const ids = items.map((x) => x.id);
  check('id 唯一（105 个）且全为 kebab-case',
    new Set(ids).size === items.length && ids.every((x) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x)));
  const urls = items.map((x) => x.url);
  check('url 唯一且全部为 http(s) 绝对地址（同 URL 不重复收录）',
    new Set(urls).size === items.length && urls.every((u) => /^https?:\/\//i.test(u)));
  check('每项 group ∈ 5 组枚举', items.every((x) => fdeLibrary.GROUP_KEYS.includes(x.group)),
    items.filter((x) => !fdeLibrary.GROUP_KEYS.includes(x.group)).slice(0, 3).map((x) => x.id));
  check('每项 kind ∈ 12 类枚举（doc…repo/template）', items.every((x) => fdeLibrary.KINDS.includes(x.kind)),
    items.filter((x) => !fdeLibrary.KINDS.includes(x.kind)).slice(0, 3).map((x) => x.id));
  check('每项 authority ∈ A/B/C，且策展条目只有 A/B（C 级由社区动态产生）',
    items.every((x) => fdeLibrary.AUTHORITIES.includes(x.authority)) &&
    items.every((x) => x.authority === 'A' || x.authority === 'B'));
  const AUTH = items.reduce((m, x) => { m[x.authority] = (m[x.authority] || 0) + 1; return m; }, {});
  check('A/B/C 分布：A=92 / B=16，A 级（官方一手）占比 ≥70%',
    AUTH.A === 92 && AUTH.B === 16 && AUTH.A + AUTH.B === items.length && AUTH.A / items.length >= 0.7, AUTH);
  check('每项 stages 非空且 ∈ {all} ∪ 8 阶段（v1.3 阶段枚举）',
    items.every((x) => Array.isArray(x.stages) && x.stages.length > 0 &&
      x.stages.every((s) => s === 'all' || schema.STAGE_KEYS.includes(s))),
    items.filter((x) => !Array.isArray(x.stages) || x.stages.some((s) => s !== 'all' && !schema.STAGE_KEYS.includes(s))).slice(0, 3).map((x) => x.id));
  check('每项 recommend ∈ star/recommend/backup，featured 为布尔',
    items.every((x) => x.recommend === undefined || fdeLibrary.RECOMMENDS.includes(x.recommend)) &&
    items.every((x) => x.featured === undefined || typeof x.featured === 'boolean'));
  const feat = items.filter((x) => x.featured === true).length;
  const star = items.filter((x) => x.recommend === 'star').length;
  const track = items.filter((x) => x.repo && x.track !== false).length;
  check('featured / star / track 计数与校验统计一致（32 / 33 / 24，track ≤30）',
    feat === v.stats.featured && star === v.stats.star && track === v.stats.track &&
    track === 24 && track <= fdeLibrary.GITHUB_TRACK_MAX,
    { featured: feat, star, track, stats: v.stats });
  check('repo 条目均为 owner/name 形式且只出现在 opensource / method 组（spec §19.1 已注记 method 组允许 repo 课程/示例集）',
    items.filter((x) => x.repo).every((x) => /^[^/\s]+\/[^/\s]+$/.test(x.repo) && ['opensource', 'method'].includes(x.group)),
    items.filter((x) => x.repo && !['opensource', 'method'].includes(x.group)).map((x) => x.id));
  /* featuredRank 人工策展位（spec §19.1 新字段 / §19.3 排序） */
  const rankedItems = items.filter((x) => x.featuredRank !== undefined);
  const ranks = rankedItems.map((x) => x.featuredRank);
  check('featuredRank 人工策展位存在且合法（11 条，整数 1–11 唯一，均落在 recommend=star 条目）',
    rankedItems.length === 11 && rankedItems.every((x) => Number.isInteger(x.featuredRank)) &&
    new Set(ranks).size === 11 && Math.min(...ranks) === 1 && Math.max(...ranks) === 11 &&
    rankedItems.every((x) => x.recommend === 'star'),
    { count: rankedItems.length, ranks: ranks.slice().sort((a, b) => a - b) });
  check('全部策展条目 httpStatus=200（策展实测快照；本审计不联网复核）',
    items.every((x) => x.httpStatus === 200), [...new Set(items.map((x) => x.httpStatus))]);
  check('summary ≤120 字 / why ≤80 字（spec §19.1 字数上限）',
    items.every((x) => String(x.summary || '').length <= fdeLibrary.SUMMARY_MAX) &&
    items.every((x) => String(x.why || '').length <= fdeLibrary.WHY_MAX));
  check('规模满足 spec §19.1 下限（国外官方 ≥25 / 国内官方 ≥15 / 开源 ≥25 / 方法模板 ≥8）',
    v.stats.byGroup['intl-official'] >= 25 && v.stats.byGroup['cn-official'] >= 15 &&
    v.stats.byGroup.opensource >= 25 && v.stats.byGroup.method >= 8,
    v.stats.byGroup);
  check('catalog 无本地/相对路径泄漏（url 均 http(s)，无 file:/绝对路径）',
    items.every((x) => !/^(file:|\/|~)/i.test(String(x.url))));
}

/* 真实 catalog 端到端：featuredRank 排序与 track 24 请求数（mock GitHub，不联网） */
{
  const REAL_LIB_WS = newRoot('libreal');
  const ghUrls = [];
  const mockGh = async (url) => {
    ghUrls.push(String(url));
    return {
      status: 200,
      text: async () => JSON.stringify({ stargazers_count: 1, forks_count: 0, license: { spdx_id: 'MIT' }, language: 'Python', pushed_at: '2026-11-01T00:00:00Z' }),
    };
  };
  fdeLibrary.resetLibraryState();
  const rr = await fdeLibrary.refresh(REAL_LIB_WS, { fetchImpl: mockGh });
  const realCat = JSON.parse(readFileSync(join(PLUGIN, 'reference', 'fde-library', 'catalog.json'), 'utf8'));
  const rankedOrder = realCat.items.filter((x) => x.featuredRank != null)
    .sort((a, b) => Number(a.featuredRank) - Number(b.featuredRank)).map((x) => x.id);
  check('真实 catalog 刷新：featured 前 11 条顺序 = featuredRank 1…11（人工策展位最优先）',
    rr.ok === true && rr.feed.featured.length === 12 &&
    JSON.stringify(rr.feed.featured.slice(0, 11)) === JSON.stringify(rankedOrder),
    { featured: rr.feed && rr.feed.featured.slice(0, 12), ranked: rankedOrder });
  check('真实 catalog 刷新：track=24 只请求 24 个仓库（单日 ≤30，留限流余量）',
    ghUrls.length === 24 && ghUrls.every((u) => /^https:\/\/api\.github\.com\/repos\//.test(u)), ghUrls.length);
  check('真实 catalog 刷新：feed 条目保留 featuredRank（供排序/面板透传）',
    rr.feed.items.find((x) => x.id === 'openai-fde-job-sf').featuredRank === 1 &&
    rr.feed.items.filter((x) => x.featuredRank != null).length === 11);
}

sec('§19 资料库 · 刷新/失败降级/社区/差分/重点推荐/每日一次（mock GitHub，不联网）');
const LIB_TODAY = store.localDateStr();
const libAux = [];
const libTmp = (tag) => { const d = mkdtempSync(join(tmpdir(), 'fde-audit-' + tag + '-')); libAux.push(d); return d; };
const libText = (v, n) => String(v == null ? '' : v).slice(0, n);
function libItem(patch = {}) {
  const id = patch.id || ('lib-' + Math.random().toString(36).slice(2, 9));
  const base = {
    id, group: 'intl-official', kind: 'doc', lang: 'zh', title: '测试资料 ' + id, publisher: '测试发布方',
    url: 'https://example.com/' + id, authority: 'A', stages: ['all'], topics: ['测试'],
    summary: '一句话摘要', why: '一句话价值', featured: false, recommend: 'backup',
    addedAt: dateStr(-30), verifiedAt: LIB_TODAY, httpStatus: 200,
    staticMeta: { stars: 0, forks: 0, license: '', language: '', pushedAt: '' },
  };
  return Object.assign(base, patch || {});
}
function libCatalog(items, patch = {}) {
  return Object.assign({
    version: 1, updatedAt: LIB_TODAY, notes: [],
    groups: fdeLibrary.GROUPS.map((g) => ({ key: g.key, label: g.label })), items,
  }, patch || {});
}
const LIB_WS = newRoot('lib');
const LIB_CAT_DIR = libTmp('libcat');
copyDirs.push(LIB_CAT_DIR);
const LIB_CAT = join(LIB_CAT_DIR, 'catalog.json');
const LIB_FIXTURE = [
  libItem({ id: 'intl-star', group: 'intl-official', kind: 'guide', title: 'OpenAI 官方指南', publisher: 'OpenAI',
    url: 'https://example.com/intl-star', authority: 'A', stages: ['scoping', 'solution'], featured: true, recommend: 'star',
    featuredRank: 2, addedAt: dateStr(-30) }),
  libItem({ id: 'cn-doc', group: 'cn-official', kind: 'doc', title: '腾讯云 FDE 实践', publisher: '腾讯云',
    url: 'https://example.com/cn-doc', authority: 'A', stages: ['meeting', 'scoping'], addedAt: dateStr(-30) }),
  libItem({ id: 'open-r1', group: 'opensource', kind: 'repo', title: '开源工具 r1', publisher: 'o/r1',
    url: 'https://example.com/open-r1', authority: 'B', stages: ['solution'], recommend: 'recommend',
    repo: 'o/r1', track: true, addedAt: dateStr(-30), staticMeta: { stars: 5, forks: 1, license: 'MIT', language: 'Python', pushedAt: '2026-10-01T00:00:00Z' } }),
  libItem({ id: 'open-r2', group: 'opensource', kind: 'repo', title: '开源工具 r2', publisher: 'o/r2',
    url: 'https://example.com/open-r2', authority: 'B', stages: ['pilot'],
    repo: 'o/r2', track: true, addedAt: dateStr(-30), staticMeta: { stars: 7, forks: 2, license: 'Apache-2.0', language: 'Go', pushedAt: '2026-10-02T00:00:00Z' } }),
  libItem({ id: 'open-r3', group: 'opensource', kind: 'repo', title: '不参与刷新的仓库', publisher: 'o/r3',
    url: 'https://example.com/open-r3', authority: 'B', stages: ['delivery'], repo: 'o/r3', track: false, addedAt: dateStr(-30) }),
  libItem({ id: 'method-recent', group: 'method', kind: 'template', title: '场景评估模板', publisher: '内部方法库',
    url: 'https://example.com/method-recent', authority: 'B', stages: ['scoping'], featured: true, recommend: 'recommend', addedAt: dateStr(-1) }),
];
const LIB_SCYS = {
  version: 1, date: LIB_TODAY, fetchedAt: new Date().toISOString(), ok: true, items: [
    { id: 'scys-1', title: '生财帖子一', summary: '<p>' + '社区摘要'.repeat(80) + '</p>', url: 'https://scys.example/1',
      publishedAt: '2026-11-04T10:00:00.000Z', author: '圈友甲', tags: ['FDE', '交付'], stats: { likes: 5 }, kind: 'post', isNew: false },
    { id: 'scys-2', title: '生财帖子二', summary: '摘要二', url: 'https://scys.example/2',
      publishedAt: '2026-11-03T10:00:00.000Z', author: '圈友乙', tags: ['报价'], stats: { likes: 1 }, kind: 'post', isNew: true },
  ],
};
const GH_STARS = { 'o/r1': 42, 'o/r2': 7 };
const ghCalls = [];
const ghFetch = (failSet = new Set(), stars = GH_STARS) => async (url) => {
  const repo = decodeURIComponent(String(url).split('/repos/')[1] || '');
  ghCalls.push(repo);
  if (failSet.has(repo)) return { status: 403, text: async () => '{"message":"rate limited"}' };
  const stars0 = Number(stars[repo] || 1);
  return {
    status: 200,
    text: async () => JSON.stringify({
      stargazers_count: stars0, forks_count: 2, license: { spdx_id: 'MIT' }, language: 'Python',
      pushed_at: '2026-11-01T00:00:00Z',
    }),
  };
};
{
  /* ---- 夹具落盘：catalog + 社区缓存 ---- */
  writeFileSync(LIB_CAT, JSON.stringify(libCatalog(LIB_FIXTURE), null, 2), 'utf8');
  mkdirSync(join(LIB_WS, 'research', '.fde'), { recursive: true });
  writeFileSync(fdeLibrary.communityPath(LIB_WS), JSON.stringify(LIB_SCYS, null, 2), 'utf8');
  const catBytesBefore = readFileSync(LIB_CAT);
  fdeLibrary.resetLibraryState();
  const r1 = await fdeLibrary.refresh(LIB_WS, { fetchImpl: ghFetch(new Set(['o/r2'])), catalogPath: LIB_CAT });
  check('刷新成功：{ok:true, feed.ok:true, stale:false}', r1.ok === true && r1.feed && r1.feed.ok === true && r1.stale === false,
    { ok: r1.ok, code: r1.code, reason: r1.reason });
  const feed1 = r1.feed || {};
  const byId1 = (id) => (feed1.items || []).find((x) => x.id === id) || {};
  check('feed 数据模型字段齐全（version/date/fetchedAt/catalogVersion/catalogUpdatedAt/stats/sources/warnings/items/featured）',
    feed1.version === fdeLibrary.LIBRARY_VERSION && feed1.date === LIB_TODAY && !!feed1.fetchedAt &&
    feed1.catalogVersion === 1 && feed1.catalogUpdatedAt === LIB_TODAY &&
    !!feed1.stats && Array.isArray(feed1.sources) && Array.isArray(feed1.warnings) && Array.isArray(feed1.items) && Array.isArray(feed1.featured),
    { date: feed1.date, keys: Object.keys(feed1) });
  check('缓存落盘 research/.fde/fde-library.json 且原子写无 .tmp 残留',
    existsSync(fdeLibrary.feedPath(LIB_WS)) &&
    !readdirSync(join(LIB_WS, 'research', '.fde')).some((f) => f.includes('.tmp')),
    readdirSync(join(LIB_WS, 'research', '.fde')));
  check('sources 三项齐全（catalog/github/community）',
    feed1.sources.map((x) => x.key).join(',') === 'catalog,github,community' &&
    feed1.sources[0].items === 6 && feed1.sources[2].items === 2,
    feed1.sources.map((x) => x.key));
  check('GitHub 指标合并：成功仓库 staticMeta 覆盖为实测 + liveMeta 记录',
    byId1('open-r1').staticMeta && byId1('open-r1').staticMeta.stars === 42 &&
    byId1('open-r1').liveMeta && byId1('open-r1').liveMeta.stars === 42, byId1('open-r1').staticMeta);
  check('单个仓库 403：保留旧值、不阻断其它条目（feed.ok 仍 true）',
    byId1('open-r2').staticMeta && byId1('open-r2').staticMeta.stars === 7 && byId1('open-r2').liveMeta === null &&
    feed1.ok === true, byId1('open-r2').staticMeta);
  check('sources.github 记录 requested/okCount/errors（2 请求 1 失败）',
    feed1.sources[1].requested === 2 && feed1.sources[1].okCount === 1 &&
    feed1.sources[1].errors.length === 1 && feed1.sources[1].errors[0].repo === 'o/r2', feed1.sources[1]);
  check('GitHub 失败写 warnings（保留旧值，不伪装成全绿）',
    feed1.warnings.some((w) => /GitHub 指标未更新/.test(String(w))), feed1.warnings);
  check('track=false 的仓库不参与刷新（未发起请求、保留策展 staticMeta）',
    !ghCalls.includes('o/r3') && byId1('open-r3').liveMeta === null && ghCalls.length === 2, ghCalls);
  check('社区动态映射：id=community:<scys id> / group=community / kind=post / authority=C / stages=["all"]',
    ['community:scys-1', 'community:scys-2'].every((cid) => {
      const it = byId1(cid);
      return it && it.group === 'community' && it.kind === 'post' && it.authority === 'C' &&
        JSON.stringify(it.stages) === JSON.stringify(['all']) && it.community && it.community.author;
    }), (feed1.items || []).filter((x) => x.group === 'community').map((x) => x.id));
  check('社区摘要去 HTML 且 ≤200 字，原帖链接保留（摘要非全文）',
    (feed1.items || []).filter((x) => x.group === 'community').every((x) =>
      typeof x.summary === 'string' && x.summary.length <= fdeLibrary.COMMUNITY_SUMMARY_MAX &&
      !/<p>|<\/p>/.test(x.summary) && /^https:\/\//.test(x.url)) &&
    byId1('community:scys-1').note && /非全文/.test(byId1('community:scys-1').note));
  check('社区条目按 publishedAt 倒序（scys-1 在 scys-2 之前）', (() => {
    const list = (feed1.items || []).filter((x) => x.group === 'community').map((x) => x.id);
    return list.indexOf('community:scys-1') < list.indexOf('community:scys-2');
  })());
  check('stats 分组合计一致（total=8 / 各组合计 / featured=new 计数）',
    feed1.stats.total === 8 && feed1.stats.intlOfficial === 1 && feed1.stats.cnOfficial === 1 &&
    feed1.stats.opensource === 3 && feed1.stats.method === 1 && feed1.stats.community === 2 &&
    (feed1.stats.intlOfficial + feed1.stats.cnOfficial + feed1.stats.opensource + feed1.stats.method + feed1.stats.community) === feed1.stats.total &&
    feed1.stats.featured === feed1.featured.length, feed1.stats);
  check('首版全部 isNew=true（无上一版缓存可比对）', feed1.items.every((x) => x.isNew === true) && feed1.stats.new === 8, feed1.stats.new);
  check('缓存条目保留 featuredRank（策展位字段透传，面板/排序同源）',
    byId1('intl-star').featuredRank === 2);
  check('featured 数量 ≤12、id 唯一且都在 items 内',
    feed1.featured.length > 0 && feed1.featured.length <= fdeLibrary.FEATURED_MAX &&
    new Set(feed1.featured).size === feed1.featured.length &&
    feed1.featured.every((id) => feed1.items.some((x) => x.id === id)), feed1.featured);
  check('featured 覆盖全部 5 个来源组（同一来源组至少 1 条）',
    ['intl-official', 'cn-official', 'opensource', 'method', 'community'].every((g) =>
      feed1.featured.some((id) => byId1(id).group === g)), feed1.featured);
  check('featured 排序：recommend=star 优先于 featured/普通条目',
    (() => {
      const idxStar = feed1.featured.findIndex((id) => byId1(id).recommend === 'star');
      const idxPlain = feed1.featured.findIndex((id) => byId1(id).recommend !== 'star');
      return idxStar >= 0 && idxPlain >= 0 && idxStar < idxPlain;
    })());
  check('featured 排序稳定：featured=true 条目进入重点推荐（method-recent 在 featured 内）',
    feed1.featured.indexOf('method-recent') >= 0, feed1.featured);
  /* ---- 第二次刷新（同数据）：updated=0 / isNew 7 天规则 ---- */
  const r2 = await fdeLibrary.refresh(LIB_WS, { fetchImpl: ghFetch(new Set(['o/r2'])), catalogPath: LIB_CAT });
  const f2 = r2.feed || {};
  const m2 = (id) => (f2.items || []).find((x) => x.id === id) || {};
  check('同数据再刷：GitHub 指标未变 → updated=false 且 stats.updated=0',
    f2.stats.updated === 0 && m2('open-r1').updated === false, f2.stats);
  check('isNew 7 天规则：addedAt 近 7 天 → true；旧条目 → false',
    m2('method-recent').isNew === true && m2('intl-star').isNew === false && m2('open-r1').isNew === false,
    { recent: m2('method-recent').isNew, old: m2('intl-star').isNew });
  check('社区 isNew 标记保留：scys-2 true / scys-1 false',
    m2('community:scys-2').isNew === true && m2('community:scys-1').isNew === false);
  /* ---- 第三次刷新（指标变化）：updated 标记 ---- */
  const r3 = await fdeLibrary.refresh(LIB_WS, { fetchImpl: ghFetch(new Set(), { 'o/r1': 50, 'o/r2': 9 }), catalogPath: LIB_CAT });
  const f3 = r3.feed || {};
  const m3 = (id) => (f3.items || []).find((x) => x.id === id) || {};
  check('GitHub 指标变化 → updated=true 且 stats.updated 计数（r1 由 42→50，计 1 条）',
    m3('open-r1').updated === true && f3.stats.updated === 1, f3.stats);
  /* ---- 每天一次门控 ---- */
  const callsBeforeSkip = ghCalls.length;
  const skip = await fdeLibrary.maybeRefresh(LIB_WS, { fetchImpl: ghFetch(new Set()), catalogPath: LIB_CAT });
  check('同日第二次 maybeRefresh 跳过且不再请求（每天一次门控）',
    skip.skipped === true && ghCalls.length === callsBeforeSkip && skip.feed && skip.stale === false,
    { skipped: skip.skipped, calls: ghCalls.length });
  const forced = await fdeLibrary.maybeRefresh(LIB_WS, { fetchImpl: ghFetch(new Set()), catalogPath: LIB_CAT, force: true });
  check('force=true 不受每天一次限制（再刷一次）',
    forced.ok === true && forced.skipped !== true && ghCalls.length > callsBeforeSkip, { calls: ghCalls.length });
  /* ---- 失败保留旧 feed ---- */
  const feedBytesBefore = readFileSync(fdeLibrary.feedPath(LIB_WS));
  const callsBeforeFail = ghCalls.length;
  const failRefresh = await fdeLibrary.refresh(LIB_WS, { catalogPath: join(LIB_CAT_DIR, 'missing-catalog.json'), fetchImpl: ghFetch() });
  check('catalog 缺失刷新失败：ok:false / code=UNAVAILABLE / reason=资料目录缺失',
    failRefresh.ok === false && failRefresh.code === 'UNAVAILABLE' && failRefresh.reason === fdeLibrary.UNAVAILABLE_REASON,
    { ok: failRefresh.ok, code: failRefresh.code, reason: failRefresh.reason });
  check('失败保留旧 feed（返回旧 feed 且缓存文件字节未变、不发 GitHub 请求）',
    failRefresh.feed && failRefresh.feed.items.length === 8 &&
    Buffer.compare(readFileSync(fdeLibrary.feedPath(LIB_WS)), feedBytesBefore) === 0 &&
    ghCalls.length === callsBeforeFail);
  /* ---- 当天失败最多 3 次 ---- */
  fdeLibrary.resetLibraryState();
  const LIB_WS_RETRY = newRoot('libretry');
  const missingCat = join(LIB_CAT_DIR, 'missing-catalog.json');
  const tries = [];
  for (let i = 0; i < 4; i += 1) tries.push(await fdeLibrary.maybeRefresh(LIB_WS_RETRY, { catalogPath: missingCat }));
  check('刷新失败当天最多重试 3 次：第 1–3 次失败，第 4 次 RETRY_LIMIT',
    tries.slice(0, 3).every((x) => x.ok === false && x.code === 'UNAVAILABLE') &&
    tries[3].code === 'RETRY_LIMIT' && tries[3].skipped === true,
    tries.map((x) => x.code || (x.ok ? 'ok' : 'fail')));
  /* ---- 损坏缓存 / 目录缺失 / 目录非法 ---- */
  const LIB_WS_BAD = newRoot('libbad');
  mkdirSync(join(LIB_WS_BAD, 'research', '.fde'), { recursive: true });
  writeFileSync(fdeLibrary.feedPath(LIB_WS_BAD), '{ 这不是 json', 'utf8');
  const badStatus = fdeLibrary.status(LIB_WS_BAD, { catalogPath: LIB_CAT });
  check('损坏缓存视为空缓存（ok:true / feed:null / stale:true + warning）',
    badStatus.ok === true && badStatus.feed === null && badStatus.stale === true &&
    badStatus.warnings.some((w) => /损坏/.test(w)), { ok: badStatus.ok, warnings: badStatus.warnings });
  const missStatus = fdeLibrary.status(LIB_WS_BAD, { catalogPath: missingCat });
  check('catalog 缺失：status → ok:false / code=UNAVAILABLE / reason=资料目录缺失',
    missStatus.ok === false && missStatus.code === 'UNAVAILABLE' && missStatus.reason === fdeLibrary.UNAVAILABLE_REASON,
    { ok: missStatus.ok, code: missStatus.code });
  const brokenCat = join(LIB_CAT_DIR, 'broken.json');
  writeFileSync(brokenCat, '{ bad json', 'utf8');
  const brokenStatus = fdeLibrary.status(LIB_WS_BAD, { catalogPath: brokenCat });
  check('catalog 非法 JSON：status → UNAVAILABLE 且 reason 指明 JSON（不抛异常）',
    brokenStatus.ok === false && brokenStatus.code === 'UNAVAILABLE' && /JSON/.test(String(brokenStatus.reason)),
    brokenStatus.reason);
  /* ---- 常量与目录约定 ---- */
  check('资料库常量符合 spec（缓存/目录/社区路径、12 类 kind、3 级权威、3 档推荐、≤12 featured、7 天 isNew）',
    fdeLibrary.FEED_REL === 'research/.fde/fde-library.json' &&
    fdeLibrary.CATALOG_REL === 'reference/fde-library/catalog.json' &&
    fdeLibrary.COMMUNITY_REL === 'research/.fde/scys-fde.json' &&
    fdeLibrary.KINDS.includes('post') && fdeLibrary.KINDS.length === 12 &&
    fdeLibrary.AUTHORITIES.join(',') === 'A,B,C' && fdeLibrary.RECOMMENDS.join(',') === 'star,recommend,backup' &&
    fdeLibrary.FEATURED_MAX === 12 && fdeLibrary.NEW_DAYS === 7 &&
    fdeLibrary.SUMMARY_MAX === 120 && fdeLibrary.WHY_MAX === 80 && fdeLibrary.COMMUNITY_SUMMARY_MAX === 200 &&
    fdeLibrary.DAILY_FAIL_LIMIT === 3);
  check('catalogDefaultPath 指向插件 reference/fde-library/catalog.json（生产默认路径不变）',
    fdeLibrary.catalogDefaultPath() === join(PLUGIN, 'reference', 'fde-library', 'catalog.json'), fdeLibrary.catalogDefaultPath());
  check('GitHub 抓取约束常量：10s 超时 / 并发 ≤3 / 单日 ≤30 / 定时器 20s+30min',
    fdeLibrary.GITHUB_TIMEOUT_MS === 10000 && fdeLibrary.GITHUB_CONCURRENCY === 3 && fdeLibrary.GITHUB_TRACK_MAX === 30 &&
    fdeLibrary.TIMER_START_DELAY_MS === 20000 && fdeLibrary.TIMER_INTERVAL_MS === 30 * 60 * 1000);
  check('githubTargets 单日 ≤30 个仓库（31 个只取前 30）',
    fdeLibrary.githubTargets(Array.from({ length: 31 }, (_, i) => ({ id: 'x' + i, repo: 'o/r' + i, track: true }))).length === 30);
  check('pickFeatured 阶段覆盖数作 tie-break（all 在单阶段之前）',
    (() => {
      const a = libItem({ id: 'tie-all', url: 'https://example.com/tie-all', addedAt: '2026-01-01', stages: ['all'] });
      const b = libItem({ id: 'tie-one', url: 'https://example.com/tie-one', addedAt: '2026-01-01', stages: ['scoping'] });
      const picked = fdeLibrary.pickFeatured([b, a], 2);
      return picked[0] === 'tie-all';
    })());
  check('pickFeatured：featuredRank 小者优先（rank 1 / stars 1 排在 rank 2 / stars 900 之前）',
    (() => {
      const rank2 = libItem({ id: 'rank-2', url: 'https://example.com/rank-2', recommend: 'star', featured: true, featuredRank: 2, staticMeta: { stars: 900 } });
      const rank1 = libItem({ id: 'rank-1', url: 'https://example.com/rank-1', recommend: 'star', featured: false, featuredRank: 1, staticMeta: { stars: 1 } });
      const picked = fdeLibrary.pickFeatured([rank2, rank1], 2);
      return picked[0] === 'rank-1';
    })());
  check('pickFeatured：recommend=star 优先于 featuredRank（star 判定在 rank 之前）',
    (() => {
      const plainStar = libItem({ id: 'plain-star', url: 'https://example.com/plain-star', recommend: 'star' });
      const rankedNonStar = libItem({ id: 'ranked-nonstar', url: 'https://example.com/ranked-nonstar', recommend: 'recommend', featuredRank: 1 });
      const picked = fdeLibrary.pickFeatured([rankedNonStar, plainStar], 2);
      return picked[0] === 'plain-star';
    })());
  /* O16：新字段/上限校验缺口（观察，不判失败） */
  {
    const badRank = libCatalog([libItem({ id: 'bad-rank', url: 'https://example.com/bad-rank', recommend: 'star', featuredRank: '不是数字' })]);
    const vBad = fdeLibrary.validateCatalog(badRank);
    const tooManyTrack = libCatalog(Array.from({ length: 31 }, (_, i) =>
      libItem({ id: 'track-' + i, url: 'https://example.com/track-' + i, group: 'opensource', kind: 'repo', repo: 'o/r' + i, track: true })));
    const vTrack = fdeLibrary.validateCatalog(tooManyTrack);
    note('O16', vBad.ok === true && vTrack.ok === true,
      { badRankAccepted: vBad.ok, track31Accepted: vTrack.ok, track31: vTrack.stats.track });
  }
  check('刷新不改写策展 catalog（只读策展层，字节不变）',
    Buffer.compare(readFileSync(LIB_CAT), catBytesBefore) === 0);
  check('状态落点唯一：刷新只写 research/.fde/fde-library.json（无 board.json / 不写客户卷）',
    !existsSync(join(LIB_WS, 'research', '.fde', 'board.json')) &&
    readdirSync(join(LIB_WS, 'research')).join(',') === '.fde' &&
    existsSync(fdeLibrary.feedPath(LIB_WS)));
}

sec('§19 资料库 · 路由与 fde_library 工具契约（UNAVAILABLE / 降级 HTTP 200 / 只读）');
{
  fdeLibrary.resetLibraryState(); // 前面「失败重试上限」用例已累计当日失败次数，路由段从干净状态开始
  const ROUTE_WS = newRoot('libroute');
  const feed0 = await fdeCall(HOST, 'library/feed', { root: ROUTE_WS });
  check('GET /fde/library/feed 无缓存 → 200 {ok:true, feed:null, stale:true}',
    feed0.status === 200 && parseBody(feed0).ok === true && parseBody(feed0).feed === null && parseBody(feed0).stale === true,
    { status: feed0.status, body: rowBody(feed0) });
  const badJson = await fdeCall(HOST, 'library/refresh', { method: 'POST', root: ROUTE_WS, body: {}, contentType: 'text/plain' });
  check('POST /fde/library/refresh 非 JSON → 415', badJson.status === 415, badJson.status);
  const evil = await call(HOST, FDE_PREFIX + 'library/feed', { headers: { host: 'evil.example.com' } });
  check('资料库路由走统一来源守卫（伪造 Host → 403）', evil.status === 403, evil.status);
  /* 用环境变量覆盖目录路径验证「catalog 缺失 → UNAVAILABLE + 保留旧 feed」（生产默认路径不变） */
  const envPrev = process.env.FDE_LIBRARY_CATALOG_PATH;
  process.env.FDE_LIBRARY_CATALOG_PATH = join(LIB_CAT_DIR, 'no-such-catalog.json');
  try {
    const missFeed = await fdeCall(HOST, 'library/feed', { root: ROUTE_WS });
    check('catalog 缺失：GET library/feed → HTTP 200 + {ok:false, code:UNAVAILABLE, reason:资料目录缺失}',
      missFeed.status === 200 && parseBody(missFeed).ok === false &&
      parseBody(missFeed).code === 'UNAVAILABLE' && parseBody(missFeed).reason === '资料目录缺失', rowBody(missFeed));
    const missRefresh = await fdeCall(HOST, 'library/refresh', { method: 'POST', root: ROUTE_WS, body: {} });
    check('catalog 缺失：POST library/refresh → HTTP 200 + UNAVAILABLE（业务降级不是 5xx）',
      missRefresh.status === 200 && parseBody(missRefresh).ok === false && parseBody(missRefresh).code === 'UNAVAILABLE',
      rowBody(missRefresh));
    const toolMiss = await HOST.tools.find((t) => t.name === 'fde_library').execute({ action: 'feed', root: ROUTE_WS });
    check('fde_library 工具在 catalog 缺失时返回 ok:false / code=UNAVAILABLE（不抛异常）',
      toolMiss && toolMiss.ok === false && toolMiss.code === 'UNAVAILABLE', toolMiss && toolMiss.text);
    const toolRefreshMiss = await HOST.tools.find((t) => t.name === 'fde_library').execute({ action: 'refresh', root: ROUTE_WS });
    check('fde_library refresh 在 catalog 缺失时返回 UNAVAILABLE（不抛异常）',
      toolRefreshMiss && toolRefreshMiss.ok === false && toolRefreshMiss.code === 'UNAVAILABLE', toolRefreshMiss && toolRefreshMiss.text);
  } finally {
    if (envPrev === undefined) delete process.env.FDE_LIBRARY_CATALOG_PATH;
    else process.env.FDE_LIBRARY_CATALOG_PATH = envPrev;
  }
  /* 工具 schema */
  const tool = HOST.tools.find((t) => t.name === 'fde_library');
  check('fde_library.action 枚举 feed/search/refresh（spec §19.5）',
    JSON.stringify(tool.parameters.properties.action.enum) === JSON.stringify(['feed', 'search', 'refresh']),
    tool.parameters.properties.action.enum);
  check('fde_library 支持 group/kind/stage/q/featured/limit 过滤参数',
    ['group', 'kind', 'stage', 'q', 'featured', 'limit'].every((k) => k in tool.parameters.properties));
  const toolWs = newRoot('libtool');
  const noCache = await tool.execute({ action: 'feed', root: toolWs });
  check('fde_library feed 无缓存 → ok:true + feed:null + 提示刷新（不报错）',
    noCache && noCache.ok === true && noCache.feed === null && /暂无缓存/.test(String(noCache.text)));
  /* 无 repo 的小目录：refresh 不触发 GitHub 请求（验证不联网） */
  const TINY_DIR = libTmp('libtiny');
  copyDirs.push(TINY_DIR);
  const TINY_CAT = join(TINY_DIR, 'catalog.json');
  writeFileSync(TINY_CAT, JSON.stringify(libCatalog([
    libItem({ id: 'tiny-intl', url: 'https://example.com/tiny-intl', group: 'intl-official' }),
    libItem({ id: 'tiny-open', url: 'https://example.com/tiny-open', group: 'opensource', kind: 'repo' }),
    libItem({ id: 'tiny-method', url: 'https://example.com/tiny-method', group: 'method', kind: 'template' }),
  ]), null, 2), 'utf8');
  const envPrev2 = process.env.FDE_LIBRARY_CATALOG_PATH;
  process.env.FDE_LIBRARY_CATALOG_PATH = TINY_CAT;
  try {
    const callsBefore = globalFetchCalls;
    const toolRefresh = await tool.execute({ action: 'refresh', root: toolWs });
    check('fde_library refresh（无 repo 目录）→ ok:true 且真实网络请求 0 次',
      toolRefresh && toolRefresh.ok === true && globalFetchCalls === callsBefore, toolRefresh && toolRefresh.text);
    check('fde_library refresh 落盘 research/.fde/fde-library.json（工具只读缓存层，不写 board）',
      existsSync(fdeLibrary.feedPath(toolWs)) && !existsSync(join(toolWs, 'research', '.fde', 'board.json')));
    const toolFeed = await tool.execute({ action: 'feed', root: toolWs });
    check('fde_library feed 有缓存 → 返回统计 + 紧凑条目（含来源组/类型/权威性/URL）',
      toolFeed && toolFeed.ok === true && toolFeed.items && toolFeed.items.length === 3 &&
      /\[.+?\/.+?\/[ABC]\]/.test(String(toolFeed.text)) && /https:\/\//.test(String(toolFeed.text)), toolFeed && toolFeed.text);
    const toolSearch = await tool.execute({ action: 'search', group: 'opensource', root: toolWs });
    check('fde_library search 按 group 过滤（opensource → 1 条且全部同组）',
      toolSearch && toolSearch.ok === true && toolSearch.items.length === 1 && toolSearch.items.every((x) => x.group === 'opensource'),
      toolSearch && toolSearch.items);
    const toolLimit = await tool.execute({ action: 'feed', limit: 2, root: toolWs });
    check('fde_library limit 生效（≤2 条）', toolLimit && toolLimit.items.length === 2, toolLimit && toolLimit.items.length);
    const toolBad = await tool.execute({ action: 'nope', root: toolWs });
    check('fde_library 未知 action → ok:false / code=INVALID（不抛异常）',
      toolBad && toolBad.ok === false && toolBad.code === 'INVALID', toolBad && (toolBad.code || toolBad.text));
  } finally {
    if (envPrev2 === undefined) delete process.env.FDE_LIBRARY_CATALOG_PATH;
    else process.env.FDE_LIBRARY_CATALOG_PATH = envPrev2;
  }
}

/* ============================ 16. v1.3 · §20 流程 v2 ============================ */

sec('§20 流程 v2 · 8 阶段 playbook / scoping 与 solution 门禁 / handoff（spec §20.1–§20.7）');
const FLOW_SKILL = {
  lead: 'fde-engagement', discovery: 'fde-discovery', meeting: 'fde-meeting', scoping: 'fde-scoping',
  solution: 'fde-solution', pilot: 'fde-pilot', delivery: 'fde-delivery', adoption: 'fde-adoption',
};
{
  const stages = schema.ENGAGEMENT_STAGES;
  check('8 阶段顺序固定：lead → discovery → meeting → scoping → solution → pilot → delivery → adoption',
    stages.map((s) => s.key).join(',') === 'lead,discovery,meeting,scoping,solution,pilot,delivery,adoption' &&
    stages.map((s) => s.order).join(',') === '1,2,3,4,5,6,7,8');
  check('门禁顺序 8 个且 scoping 位于 meeting 与 solution 之间',
    schema.GATE_KEYS.join(',') === 'intake,discovery,meeting,scoping,solution,pilot,delivery,adoption',
    schema.GATE_KEYS);
  check('每阶段 playbook 字段齐全（goal 非空 + inputs/activities/outputs/tools/pitfalls 非空数组）',
    stages.every((st) => {
      const p = st.playbook;
      return p && typeof p.goal === 'string' && p.goal.length >= 8 &&
        ['inputs', 'activities', 'outputs', 'tools', 'pitfalls'].every((k) => Array.isArray(p[k]) && p[k].length > 0);
    }), stages.filter((st) => !st.playbook).map((st) => st.key));
  check('playbook 工具 kind 均在枚举内（skill/method/template/tool/library）且 name/label 非空',
    stages.every((st) => st.playbook.tools.every((t) =>
      schema.PLAYBOOK_TOOL_KINDS.includes(t.kind) && typeof t.name === 'string' && t.name.length > 0 &&
      typeof t.label === 'string' && t.label.length > 0)));
  check('工具矩阵覆盖 8 阶段：每阶段恰好 1 个 fde_library 来源入口（spec §20.3）',
    stages.every((st) => st.playbook.tools.filter((t) => t.name === 'fde_library').length === 1));
  check('全程工具不逐阶段重复（fde_board 不出现在全部 8 阶段）',
    stages.reduce((n, st) => n + st.playbook.tools.filter((t) => t.name === 'fde_board').length, 0) < 8);
  check('每阶段 skill 与阶段技能映射一致（fde-engagement/fde-discovery/…/fde-scoping…）',
    stages.every((st) => st.playbook.tools.some((t) => t.kind === 'skill' && t.name === FLOW_SKILL[st.key])),
    stages.map((st) => [st.key, st.playbook.tools.filter((t) => t.kind === 'skill').map((t) => t.name)]));
  check('scoping playbook 含 fde_scenario + 场景评估表模板 + 06 场景方法（spec §20.3/§20.4）',
    ['fde_scenario', '场景评估表.md', '06-场景选择与数据体检.md'].every((n) =>
      stages.find((s) => s.key === 'scoping').playbook.tools.some((t) => t.name === n)));
  check('solution playbook 含 fde_quote + 成本测算与报价单模板 + 07 成本方法',
    ['fde_quote', '成本测算与报价单.md', '07-成本评估与报价.md'].every((n) =>
      stages.find((s) => s.key === 'solution').playbook.tools.some((t) => t.name === n)));
  check('scoping 门禁：auto=scenario，manual=6 项（四条硬门槛 + 评分 + 场景书面确认）',
    schema.GATES.scoping.auto.map((c) => c.key).join(',') === 'scenario' &&
    schema.GATES.scoping.manual.map((c) => c.key).join(',') ===
      'sponsor_named,integration_14d,poc_90d,usage_measurable,criteria_scored,scenario_locked',
    schema.GATES.scoping.manual.map((c) => c.key));
  check('solution 门禁新增 auto cost/quote + manual pricing_confirmed（原 solution_final 保留）',
    ['proposal', 'boundary', 'cost', 'quote'].every((k) => schema.GATES.solution.auto.some((c) => c.key === k)) &&
    schema.GATES.solution.manual.some((c) => c.key === 'pricing_confirmed') &&
    schema.GATES.solution.manual.some((c) => c.key === 'solution_final'));
  check('itemTypes 9 类且含 scoping（v1.3 新增；spec §20.4）',
    schema.ITEM_TYPES.length === 9 && schema.ITEM_TYPE_KEYS.includes('scoping'));
  check('终止状态不变（archived / lost）', schema.TERMINAL_KEYS.join(',') === 'archived,lost');
  check('handoff STAGE_GUIDES 覆盖 8 阶段且 scoping 模板产物为 scoping/ 三件套',
    schema.STAGE_KEYS.every((k) => prompts.STAGE_GUIDES[k] && prompts.STAGE_GUIDES[k].skill === FLOW_SKILL[k]) &&
    ['scoping/场景评估表.md', 'scoping/数据可得性清单.md', 'scoping/范围边界.md']
      .every((a) => prompts.STAGE_GUIDES.scoping.artifacts.includes(a)));
  check('方法/模板交付物存在（06/07 方法与两个新模板；spec §20.4）',
    ['methods/06-场景选择与数据体检.md', 'methods/07-成本评估与报价.md',
      'templates/场景评估表.md', 'templates/成本测算与报价单.md'].every((f) => existsSync(join(PLUGIN, f))));
  check('§20.7-4 旧 7 阶段 board 可读取且不自动改写阶段', (() => {
    const OLD = newRoot('oldboard');
    const e = api.engagement(OLD, { action: 'create', patch: { name: '旧阶段客户', company: '旧阶段有限公司', source: { kind: 'manual' }, nextAction: { text: '推进', due: dateStr(3) } } }).engagement;
    setStages(OLD, [[e.id, 'solution']]); // 模拟 v1.2 存量 board（无 scoping 阶段）
    const b = api.board(OLD).board;
    return b.engagements.find((x) => x.id === e.id).stage === 'solution';
  })());
  /* ---- 门禁行为：meeting → scoping ---- */
  const FLOW = newRoot('flowv2');
  makeProject(FLOW, '流程客户-20260101', {
    '00-项目档案.md': '# 项目档案\n',
    'meeting/会面Brief.md': '# Brief\n',
  });
  const eng = api.engagement(FLOW, {
    action: 'create',
    patch: {
      name: '流程客户', company: '流程客户有限公司', dir: '流程客户-20260101',
      source: { kind: 'manual' }, nextAction: { text: '推进场景', due: dateStr(3) },
      stakeholders: [{ name: '张三', role: '董事长', level: 'top' }],
    },
  }).engagement;
  setStages(FLOW, [[eng.id, 'meeting']]);
  const b1 = await fdeCall(HOST, 'engagement', { method: 'POST', root: FLOW, body: { action: 'move', id: eng.id, patch: { stage: 'scoping' } } });
  const body1 = parseBody(b1);
  check('meeting→scoping：缺场景评估 + 6 项人工确认 → 409 blocked，missing = 1 auto + 6 manual',
    b1.status === 409 && body1.blocked === true && body1.missing.length === 7 &&
    body1.missing.some((m) => m.key === 'scenario') && body1.missing.filter((m) => m.type === 'manual').length === 6,
    body1.missing && body1.missing.map((m) => m.key + ':' + m.type));
  mkdirSync(join(FLOW, 'research', '流程客户-20260101', 'scoping'), { recursive: true });
  writeFileSync(join(FLOW, 'research', '流程客户-20260101', 'scoping', '场景评估表.md'), '# 场景评估表\n四条硬门槛均满足，12 维已打分。\n', 'utf8');
  const SCOPING_CHECKS = {
    sponsor_named: { status: 'pass', evidence: '张三维董事长，承诺每周投入' },
    integration_14d: { status: 'pass', evidence: '接口 10 天内可通' },
    poc_90d: { status: 'pass', evidence: '90 天生产上线' },
    usage_measurable: { status: 'pass', evidence: '日活与调用量可测' },
    criteria_scored: { status: 'pass', evidence: '12 维逐维有依据' },
    scenario_locked: { status: 'pass', evidence: '客户书面确认范围' },
  };
  const sg = await fdeCall(HOST, 'gate', { method: 'POST', root: FLOW, body: { engagementId: eng.id, stage: 'scoping', checks: SCOPING_CHECKS } });
  check('scoping 门禁 6 项人工确认 + 场景文件 → gate.passed=true',
    parseBody(sg).ok === true && parseBody(sg).gate.passed === true, rowBody(sg));
  const m1 = await fdeCall(HOST, 'engagement', { method: 'POST', root: FLOW, body: { action: 'move', id: eng.id, patch: { stage: 'scoping' } } });
  check('补齐后 meeting→scoping 成功且 stageSince 更新',
    parseBody(m1).ok === true && parseBody(m1).engagement.stage === 'scoping' && Date.parse(parseBody(m1).engagement.stageSince) > 0, rowBody(m1));
  /* ---- 门禁行为：scoping → solution（成本/报价） ---- */
  const b2 = await fdeCall(HOST, 'engagement', { method: 'POST', root: FLOW, body: { action: 'move', id: eng.id, patch: { stage: 'solution' } } });
  const body2 = parseBody(b2);
  check('scoping→solution：缺成本测算/报价单 → 409 blocked 且 missing 含 cost/quote',
    b2.status === 409 && body2.blocked === true &&
    body2.missing.some((m) => m.key === 'cost') && body2.missing.some((m) => m.key === 'quote'),
    body2.missing && body2.missing.map((m) => m.key + ':' + m.type));
  const proposalDir = join(FLOW, 'research', '流程客户-20260101', 'proposal');
  mkdirSync(proposalDir, { recursive: true });
  writeFileSync(join(proposalDir, '建设方案.md'), '# 建设方案\n## 范围\n本项目明确不做什么：不做通用平台。边界：一期只做一个场景。\n', 'utf8');
  writeFileSync(join(proposalDir, '成本测算.md'), '# 成本测算\nP80 计价人天见报价单。\n', 'utf8');
  writeFileSync(join(proposalDir, '报价单.md'), '# 报价单\n含假设、除外与变更条款。\n', 'utf8');
  store.clearScanCache(); // 工件扫描有 5s TTL 缓存，新增子目录文件不改变项目根 mtime 签名
  const mg = await fdeCall(HOST, 'gate', {
    method: 'POST', root: FLOW,
    body: {
      engagementId: eng.id, stage: 'solution',
      checks: { solution_final: { status: 'pass', evidence: '人已定稿' }, pricing_confirmed: { status: 'pass', evidence: '成本与报价已复核' } },
    },
  });
  check('solution 门禁成本/报价补齐 + 人工确认 → gate.passed=true',
    parseBody(mg).ok === true && parseBody(mg).gate.passed === true, rowBody(mg));
  const m2 = await fdeCall(HOST, 'engagement', { method: 'POST', root: FLOW, body: { action: 'move', id: eng.id, patch: { stage: 'solution' } } });
  check('补齐后 scoping→solution 成功（不跳阶）', parseBody(m2).ok === true && parseBody(m2).engagement.stage === 'solution', rowBody(m2));
  const scopingItem = await fdeCall(HOST, 'item', { method: 'POST', root: FLOW, body: { action: 'create', patch: { title: '场景评估任务', type: 'scoping', stage: 'todo', engagementId: eng.id } } });
  check('新 item 类型 scoping 可创建（spec §20.4）',
    parseBody(scopingItem).ok === true && parseBody(scopingItem).item.type === 'scoping', rowBody(scopingItem));
}

/* ============================ 17. v1.3 · §21 两个计算工具（独立复算） ============================ */

sec('§21 计算工具 · fde_scenario 4 门槛 / 12 维归一化（101 分母）/ 否决 / 档位');
const SCORES_360 = { value: 5, pain: 4, data: 3, tech: 3, accept: 3, compliance: 4, roi: 3, readiness: 3, delivery: 3, reuse: 3, alternative: 4, timing: 3 };
const GATES_OK = { sponsor: true, integration14d: true, prod90d: true, measurable: true };
const scnTool = HOST.tools.find((t) => t.name === 'fde_scenario');
{
  check('12 维权重合计 = 101（不是 100）且维度 key 与 spec §21.1 一致',
    fdeCalc.SCENARIO_WEIGHT_SUM === 101 && fdeCalc.SCENARIO_DIMENSIONS.length === 12 &&
    fdeCalc.SCENARIO_DIM_KEYS.join(',') === 'value,pain,data,tech,accept,compliance,roi,readiness,delivery,reuse,alternative,timing',
    fdeCalc.SCENARIO_DIM_KEYS);
  check('四条硬门槛 key 与 spec §21.1 一致（sponsor/integration14d/prod90d/measurable）',
    fdeCalc.GATE_KEYS.join(',') === 'sponsor,integration14d,prod90d,measurable', fdeCalc.GATE_KEYS);
  check('否决项编号 1–7 齐全，档位阈值 3.6 / 3.2',
    fdeCalc.SCENARIO_VETO_IDS.join(',') === '1,2,3,4,5,6,7' &&
    fdeCalc.SCENARIO_GRADE_PASS_MIN === 3.6 && fdeCalc.SCENARIO_GRADE_SUPPLEMENT_MIN === 3.2);
  check('归一化公式 = Σ(分×权重)/101（360 → 3.56，不是 3.60；101→1；505→5）',
    fdeCalc.normalizeScenarioScore(360) === 3.56 && fdeCalc.normalizeScenarioScore(101) === 1 &&
    fdeCalc.normalizeScenarioScore(505) === 5 && fdeCalc.normalizeScenarioScore(364) === 3.6,
    { s360: fdeCalc.normalizeScenarioScore(360), s364: fdeCalc.normalizeScenarioScore(364) });
  const rA = fdeCalc.evaluateScenario({ action: 'evaluate', scenarios: [{ name: 'A 场景', gates: GATES_OK, scores: SCORES_360, vetoes: [] }] });
  const a0 = (rA.ranked || [])[0] || {};
  check('evaluate 归一化回归：Σ=360 / weightSum=101 / score=3.56 / 结论「补证/小 POC」（≠进方案）',
    rA.ok === true && a0.rawSum === 360 && a0.weightSum === 101 && a0.score === 3.56 &&
    a0.conclusion === fdeCalc.SCENARIO_GRADE_SUPPLEMENT && a0.score !== 3.6,
    { rawSum: a0.rawSum, score: a0.score, conclusion: a0.conclusion });
  const r364 = fdeCalc.scoreScenario({ name: 'B 场景', gates: GATES_OK, scores: { value: 5, pain: 4, data: 4, tech: 3, accept: 3, compliance: 3, roi: 3, readiness: 3, delivery: 3, reuse: 3, alternative: 3, timing: 4 }, vetoes: [] });
  check('364/101 = 3.60 → 结论「进方案」（档位边界回归）',
    r364.rawSum === 364 && r364.score === 3.6 && r364.conclusion === fdeCalc.SCENARIO_GRADE_PASS,
    { rawSum: r364.rawSum, score: r364.score, conclusion: r364.conclusion });
  const rGate = fdeCalc.evaluateScenario({
    action: 'evaluate',
    scenarios: [{ name: '门槛缺项场景', gates: { sponsor: true, integration14d: true, prod90d: false, measurable: false }, scores: SCORES_360, vetoes: [] }],
  });
  const g0 = (rGate.ranked || [])[0] || {};
  check('四条硬门槛任一 false → 暂不启动（补前置条件）并列出缺项',
    g0.startable === false && g0.conclusion === fdeCalc.SCENARIO_NOT_STARTABLE && g0.missing.length === 2,
    { conclusion: g0.conclusion, missing: g0.missing });
  const rVeto = fdeCalc.evaluateScenario({ action: 'evaluate', scenarios: [{ name: '否决场景', gates: GATES_OK, scores: SCORES_360, vetoes: [2] }] });
  const v0 = (rVeto.ranked || [])[0] || {};
  check('命中否决项 → 不进方案（例外需人签字），且带否决文案',
    v0.vetoed === true && v0.eligible === false && v0.conclusion === fdeCalc.SCENARIO_VETOED &&
    v0.vetoLabels.length === 1 && /合规/.test(v0.vetoLabels[0]),
    { conclusion: v0.conclusion, labels: v0.vetoLabels });
  const rRank = fdeCalc.evaluateScenario({
    action: 'evaluate',
    scenarios: [
      { name: '低分可进', gates: GATES_OK, scores: SCORES_360, vetoes: [] },
      { name: '高分被否决', gates: GATES_OK, scores: { value: 5, pain: 5, data: 5, tech: 5, accept: 5, compliance: 5, roi: 5, readiness: 5, delivery: 5, reuse: 5, alternative: 5, timing: 5 }, vetoes: [1] },
    ],
  });
  check('排序：gates 全过且无否决优先，再按归一化分降序',
    rRank.ok === true && rRank.ranked[0].name === '低分可进' && rRank.ranked[1].eligible === false,
    rRank.ranked && rRank.ranked.map((x) => x.name));
  check('缺失维度按 3 分计、超出 1–5 被夹紧（不抛异常）',
    (() => {
      const x = fdeCalc.scoreScenario({ name: '部分分值', gates: GATES_OK, scores: { value: 9, pain: 0 }, vetoes: [] });
      return x.scores.value === 5 && x.scores.pain === 1 && x.scores.data === 3;
    })());
  const tplScn = fdeCalc.evaluateScenario({ action: 'template' });
  check('template 返回空白评分表（12 维 + 4 门槛 + 否决项 + 依据列 + 档位 + 101 口径）',
    tplScn.ok === true && tplScn.action === 'template' && /12 维/.test(tplScn.markdown) &&
    /101/.test(tplScn.markdown) && /否决/.test(tplScn.markdown) && /四条硬门槛|硬门槛/.test(tplScn.markdown));
  check('非法输入（未知 action / scenarios 为空）→ ok:false INVALID 且不抛异常',
    fdeCalc.evaluateScenario({ action: 'nope' }).ok === false &&
    fdeCalc.evaluateScenario({ action: 'evaluate', scenarios: [] }).ok === false);
  /* 工具层 */
  check('fde_scenario 工具 action 枚举 evaluate/template + scenarios 参数',
    JSON.stringify(scnTool.parameters.properties.action.enum) === JSON.stringify(['evaluate', 'template']) &&
    scnTool.parameters.properties.scenarios.type === 'array');
  const outScn = await scnTool.execute({ action: 'evaluate', scenarios: [{ name: '工具场景', gates: GATES_OK, scores: SCORES_360, vetoes: [] }] });
  check('fde_scenario 工具 evaluate → ranked/score=3.56/formula.weightSum=101，文本含「不得除以 100」',
    outScn && outScn.ok === true && outScn.ranked[0].score === 3.56 &&
    outScn.formula && outScn.formula.weightSum === 101 &&
    /不得除以 100/.test(String(outScn.text)) && /归一化/.test(String(outScn.text)),
    outScn && { score: outScn.ranked && outScn.ranked[0].score, formula: outScn.formula });
  const outScnTpl = await scnTool.execute({ action: 'template' });
  check('fde_scenario 工具 template 返回空白评分表 Markdown',
    outScnTpl && outScnTpl.ok === true && outScnTpl.action === 'template' && /否决项/.test(String(outScnTpl.markdown)));
}

sec('§21 计算工具 · fde_quote 三点估算 P80 / 10 步公式 / 警告 / template（独立复算）');
const quoteTool = HOST.tools.find((t) => t.name === 'fde_quote');
{
  const pricing = JSON.parse(readFileSync(join(PLUGIN, 'reference', 'fde-pricing.json'), 'utf8'));
  check('定价配置 reference/fde-pricing.json 合法：默认费率 940 / 预备费 15 / 税 6 / 毛利 35 / 折扣 0 / 甜点区 5–20 万',
    pricing.version === 1 && pricing.defaults.ratePerPersonDay === 940 && pricing.defaults.contingencyPct === 15 &&
    pricing.defaults.taxPct === 6 && pricing.defaults.marginPct === 35 && pricing.defaults.discountPct === 0 &&
    pricing.defaults.sweetSpotMin === 50000 && pricing.defaults.sweetSpotMax === 200000);
  check('定价配置标明「方法默认值/内部成本费率/不构成对外报价」，且明确不是行业标准',
    /不构成对外报价/.test(String(pricing.disclaimer)) &&
    pricing.notes.some((n) => /方法默认值|内部成本费率/.test(n)) &&
    pricing.notes.some((n) => /不是行业标准|非行业统计|经验区间/.test(n)));
  const BASE_QUOTE = {
    action: 'calculate',
    labor: [
      { name: 'FDE/算法', personDays: 20, rate: 1200 },
      { name: '数据与评测', optimistic: 8, likely: 10, pessimistic: 15, rate: 940 },
    ],
    defaultRate: 940,
    nonLabor: { dataEval: 10000, cloudToken: 2000, compliance: 3000, ops: 2000, travel: 1000, quality: 2000, other: 0 },
    contingencyPct: 15, taxPct: 6, marginPct: 35, discountPct: 0, teamSize: 3, weeks: 12,
  };
  const q0 = fdeCalc.calculateQuote(BASE_QUOTE);
  const s0 = q0.summary || {};
  check('三点估算：(8,10,15) → te=10.5 / σ=1.17 / P80=11.48 向上取 0.1 = 11.5，同时给 P50=10.5',
    q0.details.labor[1].te === undefined && q0.details.labor[1].p50PersonDays === 10.5 &&
    q0.details.labor[1].p80PersonDays === 11.5 &&
    fdeCalc.threePointEstimate(8, 10, 15).p80 === 11.5);
  check('公式 1–4：laborCost=34810 / nonLaborTotal=20000 / directCost=54810（按 spec §21.2 顺序）',
    s0.laborCost === 34810 && s0.nonLaborTotal === 20000 && s0.directCost === 54810, { ...s0 });
  check('公式 5–6：contingency=8221.50 / totalCost=63031.50',
    s0.contingency === 8221.5 && s0.totalCost === 63031.5);
  check('公式 7–8：target=102789.83 / final=102789.83（毛利率 35%、税 6%）',
    s0.target === 102789.83 && s0.final === 102789.83);
  check('公式 9–10：floor=66813.39 / ceiling=121478.89 / realizedMarginPct=35 / marginAmount=33940.04',
    s0.floor === 66813.39 && s0.ceiling === 121478.89 && s0.realizedMarginPct === 35 && s0.marginAmount === 33940.04);
  check('汇总含 P50/P80 总人天（30.5 / 31.5）且 P80 为计价口径',
    s0.p50PersonDays === 30.5 && s0.p80PersonDays === 31.5);
  check('正常输入无风险警告（定价配置存在时 warnings 为空）',
    Array.isArray(q0.warnings) && q0.warnings.length === 0, q0.warnings);
  const q = (patch) => fdeCalc.calculateQuote(Object.assign({}, BASE_QUOTE, patch));
  const hasW = (r, re) => (r.warnings || []).some((w) => re.test(w));
  const loss = q({ discountPct: 45 });
  check('警告：final < floor（亏损）+ 毛利严重偏低（<10%）',
    loss.summary.final === 56534.41 && loss.summary.floor === 66813.39 &&
    hasW(loss, /亏损/) && hasW(loss, /严重偏低/), loss.summary);
  const low = q({ discountPct: 20 });
  check('警告：18.75% < 20% → 低毛利（不标严重）', low.summary.realizedMarginPct === 18.75 &&
    hasW(low, /低于定制交付经验区间下限/) && !hasW(low, /严重偏低/), low.warnings);
  const sweet = fdeCalc.calculateQuote({
    action: 'calculate',
    labor: [{ name: '大项目', personDays: 200, rate: 1200 }],
    nonLabor: { dataEval: 10000, cloudToken: 2000, compliance: 3000, ops: 2000, travel: 1000, quality: 2000, other: 0 },
    contingencyPct: 15, taxPct: 6, marginPct: 35, discountPct: 0, teamSize: 3, weeks: 12,
  });
  check('警告：final > 20 万 → 超甜点区（尾款/招采风险）', sweet.summary.final === 487600 && hasW(sweet, /甜点区/), sweet.summary);
  const missing = q({ nonLabor: {} });
  check('警告：cloudToken/ops/compliance 为 0 → 漏项；dataEval=0 → 评测成本漏项',
    hasW(missing, /漏项/) && hasW(missing, /cloudToken/) && hasW(missing, /数据清洗/));
  check('警告：contingencyPct<10 → 预备费偏低；P80 人天/周期与团队不匹配',
    hasW(q({ contingencyPct: 5 }), /预备费偏低/) &&
    hasW(q({ weeks: 2, teamSize: 1 }), /人天与周期不匹配/));
  const nonlabor = fdeCalc.calculateQuote({
    action: 'calculate',
    labor: [{ name: '少量人力', personDays: 10, rate: 1000 }],
    nonLabor: { dataEval: 20000, cloudToken: 10000, compliance: 5000, ops: 5000, travel: 0, quality: 0, other: 0 },
    contingencyPct: 15, taxPct: 6, marginPct: 35, discountPct: 0,
  });
  check('警告：非人力占比 >40% → 按量项上限提示；报价公式仍按 totalCost=57500',
    hasW(nonlabor, /非人力成本为主/) && nonlabor.summary.totalCost === 57500);
  check('非法参数（marginPct≥90 / taxPct≥100 / discountPct<0）→ ok:false INVALID',
    q({ marginPct: 90 }).ok === false && q({ taxPct: 100 }).ok === false && q({ discountPct: -1 }).ok === false);
  const tplQuote = fdeCalc.calculateQuote({ action: 'template' });
  check('template 返回空白模板：成本测算表 + 报价单结构（范围/除外/里程碑/变更单/验收/质保）+ 三点估算说明 + 方法默认值免责',
    tplQuote.ok === true && /成本测算/.test(tplQuote.markdown) && /变更单/.test(tplQuote.markdown) &&
    /三点估算/.test(tplQuote.markdown) && /不构成对外报价/.test(tplQuote.markdown) && /某客户/.test(tplQuote.markdown));
  /* 工具层 */
  check('fde_quote 工具 action 枚举 calculate/template + labor/nonLabor/费率/毛利参数',
    JSON.stringify(quoteTool.parameters.properties.action.enum) === JSON.stringify(['calculate', 'template']) &&
    quoteTool.parameters.properties.labor.type === 'array' &&
    ['defaultRate', 'nonLabor', 'contingencyPct', 'taxPct', 'marginPct', 'discountPct'].every((k) => k in quoteTool.parameters.properties));
  const outQ = await quoteTool.execute(BASE_QUOTE);
  check('fde_quote 工具 calculate → summary 与模块一致（到分）且文本含「不构成对外报价」',
    outQ && outQ.ok === true && outQ.summary.laborCost === 34810 && outQ.summary.totalCost === 63031.5 &&
    outQ.summary.final === 102789.83 && /不构成对外报价/.test(String(outQ.text)), outQ && outQ.summary);
  const outQTpl = await quoteTool.execute({ action: 'template' });
  check('fde_quote 工具 template 返回空白成本测算与报价单',
    outQTpl && outQTpl.ok === true && /变更单/.test(String(outQTpl.markdown)) && /三点估算/.test(String(outQTpl.markdown)));
}

sec('§21 计算工具 · 纯函数边界（不写文件 / 不写 board / 不联网）');
{
  const CALC_WS = newRoot('calcnowrite');
  const callsBefore = globalFetchCalls;
  const scnTool = HOST.tools.find((t) => t.name === 'fde_scenario');
  const quoteTool = HOST.tools.find((t) => t.name === 'fde_quote');
  await scnTool.execute({ action: 'evaluate', scenarios: [{ name: '写入检查', gates: GATES_OK, scores: SCORES_360, vetoes: [] }], root: CALC_WS });
  await quoteTool.execute(Object.assign({ action: 'calculate', root: CALC_WS }, {
    labor: [{ name: 'FDE', personDays: 3 }], nonLabor: {}, defaultRate: 940,
  }));
  check('两个计算工具不写文件/不写 board（research/.fde 未创建，根目录内容不变）',
    !existsSync(join(CALC_WS, 'research', '.fde')) && !existsSync(join(CALC_WS, 'research', '.fde', 'board.json')));
  check('两个计算工具不联网（真实 fetch 调用 0 次）', globalFetchCalls === callsBefore, globalFetchCalls - callsBefore);
  check('两个工具返回 Markdown 由会话落盘（结果含 markdown 字段，工具自身不落盘）',
    (await scnTool.execute({ action: 'template' })).markdown.length > 100 &&
    (await quoteTool.execute({ action: 'template' })).markdown.length > 100);
}

/* ============================ 18. v1.3 · 红线与 §16 硬约束 ============================ */

sec('v1.3 · 红线与 §16 硬约束（零依赖 / 状态落点 / 单一事实来源 / 不联网）');
{
  const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
  /* 开源契约（ADR 0004 D3）：无运行时依赖；peerDependencies 只允许 optional 的 @deepseek-ai/dsh。 */
  const peerKeys = Object.keys(pkg.peerDependencies || {});
  const optionalPeer = !!(pkg.peerDependenciesMeta && pkg.peerDependenciesMeta['@deepseek-ai/dsh'] &&
    pkg.peerDependenciesMeta['@deepseek-ai/dsh'].optional === true);
  check('零新依赖：package.json 无 dependencies；peerDependencies 仅 optional 的 @deepseek-ai/dsh（spec §16.1 / ADR 0004 D3）',
    !(pkg.dependencies && Object.keys(pkg.dependencies).length) &&
    peerKeys.length <= 1 && (peerKeys.length === 0 || (peerKeys[0] === '@deepseek-ai/dsh' && optionalPeer)));
  const hostRels = ['index.js'].concat(readdirSync(join(PLUGIN, 'src', 'host')).map((f) => join('src', 'host', f)))
    .concat(['src/ui/ui-panel.js']);
  const allSrc = hostRels.map((rel) => readFileSync(join(PLUGIN, rel), 'utf8')).join('\n');
  check('宿主/客户端源码不 import @deepseek-ai/*（spec §16.1）',
    !/(?:from\s+|import\s*\(|require\s*\()\s*['"]@deepseek-ai/.test(allSrc));
  check('阶段/门禁/类型定义只在 fde-schema.js 出现一次（spec §16.5）',
    (allSrc.match(/export const ENGAGEMENT_STAGES/g) || []).length === 1 &&
    (allSrc.match(/export const GATES\s*=/g) || []).length === 1 &&
    (allSrc.match(/export const ITEM_TYPES\s*=/g) || []).length === 1);
  const libSrc = readFileSync(join(PLUGIN, 'src', 'host', 'fde-library.js'), 'utf8');
  const calcSrc = readFileSync(join(PLUGIN, 'src', 'host', 'fde-calc.js'), 'utf8');
  check('资料库只写 research/.fde/fde-library.json（FEED_REL + 唯一 writeFileSync + 不含 board.json）',
    fdeLibrary.FEED_REL === 'research/.fde/fde-library.json' &&
    (libSrc.match(/writeFileSync\(/g) || []).length === 1 && !/board\.json/.test(libSrc));
  check('计算工具纯函数：fde-calc 无文件写 / 无网络 / 不引用 board（spec §21.4）',
    !/writeFileSync|appendFileSync|createWriteStream|fetch\(|node:https|node:http/.test(calcSrc) &&
    !/board\.json/.test(calcSrc));
  check('GitHub 抓取不带 token（源码无 Authorization/token 头；UA 与 Accept 常量存在）',
    !/authorization/i.test(libSrc) && /user-agent/i.test(libSrc) && /application\/vnd\.github\+json/.test(libSrc));
  check('资料库不抓任意网页正文（只用 GitHub API + 本地 scys 缓存，不引入爬虫库）',
    !/@mozilla|cheerio|puppeteer|playwright|jsdom/i.test(libSrc));
  check('无第二套流程引擎/状态机（无 superagent/thread/executor 全栈复制；状态文件仅 .fde 三类）',
    !/superagent|SourceThread|Executor\b/.test(allSrc) &&
    (() => {
      const names = [...allSrc.matchAll(/(board\.json|fde-library\.json|scys-fde\.json|[a-z-]+\.jsonl)/g)].map((m) => m[1]);
      return new Set(names).size <= 4;
    })());
  check('无个人主目录绝对路径泄漏（index.js / src / client.js / skills / methods / templates / reference）',
    (() => {
      const roots = ['index.js', 'client.js', 'reference/fde-library/catalog.json', 'reference/fde-pricing.json'];
      const list = roots.slice();
      for (const dir of ['src', 'skills', 'methods', 'templates']) {
        const walk = (d) => {
          for (const ent of readdirSync(join(PLUGIN, d), { withFileTypes: true })) {
            const rel = d + '/' + ent.name;
            if (ent.isDirectory()) walk(rel); else list.push(rel);
          }
        };
        walk(dir);
      }
      const hits = list.filter((rel) => {
        try { return /\/Users\/|\/home\/[a-z]/i.test(readFileSync(join(PLUGIN, rel), 'utf8')); } catch { return false; }
      });
      return hits.length === 0;
    })());
  check('系统提示词含 v1.3 新工具与资料库/场景报价口径',
    (() => {
      const text = (HOST.sections[0] && HOST.sections[0].text) || '';
      return ['fde_library', 'fde_scenario', 'fde_quote', '资料库', '不构成对外报价'].every((k) => text.includes(k));
    })());
  /* O13：工件扫描 TTL 缓存签名口径（观察，不判失败） */
  {
    const ws = newRoot('scancache');
    makeProject(ws, '缓存客户-20260101', { '00-项目档案.md': '# 档案\n' });
    store.clearScanCache();
    store.scanProjectArtifacts(ws, '缓存客户-20260101');
    writeFileSync(join(ws, 'research', '缓存客户-20260101', 'proposal', '成本.md'), '# 成本\n', 'utf8');
    const again = store.scanProjectArtifacts(ws, '缓存客户-20260101');
    note('O13', again.source === 'cache' && again.mdCount === 1,
      { source: again.source, mdCount: again.mdCount, cleared: true });
    store.clearScanCache();
  }
  const h = await fdeCall(HOST, 'health', { root: MAIN });
  check('/fde/health 全绿（无 fail 项；资料库/招采缺失只 warn）',
    h.status === 200 && parseBody(h).ok === true &&
    (parseBody(h).checks || []).every((c) => c.status !== 'fail'),
    (parseBody(h).checks || []).map((c) => c.name + ':' + c.status));
  note('O15', !(parseBody(h).checks || []).some((c) => /资料库/.test(String(c.name))),
    (parseBody(h).checks || []).map((c) => c.name));
}

/* ============================ 19. v1.3 · 文档与验证一致性 ============================ */

sec('v1.3 · 文档一致性（README / AGENTS / spec 数字，无过期表述）');
{
  const read = (rel) => readFileSync(join(PLUGIN, rel), 'utf8');
  const readme = read('README.md');
  const agents = read('AGENTS.md');
  const spec = read('docs/01-spec.md');
  const allm = readFileSync(join(PLUGIN, 'verify', 'all.mjs'), 'utf8');
  /* README 在开源改造中重写：版本标识允许 v1.3.x（SemVer 全写）；v1.4 起面板表述为「5 页签 + 页内子页签」（ADR 0005）。 */
  check('README：版本 / 8 阶段 / 5 页签 / 资料库 / 11 个 fde-* 技能',
    /v1\.\d/.test(readme) && /8 阶段/.test(readme) && /(?:5 页签|五页签)/.test(readme) &&
    readme.includes('11 个 `fde-*` 编排技能') && /资料库/.test(readme));
  check('README 工具口径：FDE 11 + 执行 5（含 fde_library/fde_scenario/fde_quote/scys_fde 兼容保留）',
    /FDE 11 \+ 执行 5|FDE 编排工具（11）/.test(readme) &&
    ['fde_library', 'fde_scenario', 'fde_quote', 'scys_fde'].every((x) => readme.includes(x)));
  check('AGENTS：8 阶段 / 5 页签 / FDE 工具（11）/ 执行工具（5）/ 11 编排技能',
    /8 个阶段/.test(agents) && /(?:5 页签|五页签)/.test(agents) && /FDE 工具（11）/.test(agents) &&
    /执行工具（5）/.test(agents) && agents.includes('11 个 `fde-*` 编排技能'));
  check('spec 首段与术语表已是 8 阶段（v1.3 标注）',
    /沿 8 个阶段推进/.test(spec) && /生命周期中的位置（8 个/.test(spec));
  check('spec §7 工具口径：FDE 工具共 11 个 / 宿主注册总数 16（v1.3 标注）',
    /FDE 工具共 \*\*11 个\*\*/.test(spec) && /宿主注册工具总数 16/.test(spec));
  check('spec §10 技能：标题声明 v1.3 起 11 个，且 fde-scoping / fde-bid-radar 在 spec 内有文档',
    /v1\.3 起 11 个/.test(spec) && spec.includes('fde-scoping') && spec.includes('fde-bid-radar'));
  check('spec §19.5 / §20 / §21 章节存在（资料库第 9 个工具 / 流程 v2 / 两个计算工具）',
    spec.includes('### 19.5 工具 `fde_library`（第 9 个 FDE 工具）') &&
    spec.includes('## 20. 流程 v2') && spec.includes('## 21. 两个交付工具'));
  check('spec §20 明确覆盖 §2.1（旧 7 阶段表保留为历史基线）', /本节覆盖 §2\.1/.test(spec));
  check('spec §19.1 已增 featuredRank 字段说明与「method 组允许 repo 课程/示例集」注记',
    spec.includes('"featuredRank"') && spec.includes('opensource / method 组中的开源课程与示例集'));
  check('spec §19.1 方法/模板规模预期已按实际更新（首版 5 条，补 3 条后达标，≥8）',
    /方法\/模板 ≥8（首版 5 条，2026-11-04 补 3 条后达标）/.test(spec));
  check('spec §19.3 排序口径：recommend=star → featuredRank → featured → 权威性 → addedAt → 阶段覆盖 → stars',
    (() => {
      const line = spec.split('\n').find((l) => l.includes('重点推荐排序') && l.includes('featuredRank')) || '';
      return /recommend=star.*featuredRank.*featured=true.*权威性.*addedAt.*阶段.*stars/.test(line.replace(/\s+/g, ' '));
    })());
  const staleCounts = ['8 个工具', '9 个技能', '14 个技能', '10 个 FDE 技能', '六个 fde-'];
  check('spec/README/AGENTS 无过期计数（8 个工具 / 9 个技能 / 14 个技能 / 10 个 FDE 技能）',
    staleCounts.every((w) => !spec.includes(w) && !readme.includes(w) && !agents.includes(w)),
    staleCounts.filter((w) => spec.includes(w) || readme.includes(w) || agents.includes(w)));
  const sevenCtx = [...spec.matchAll(/7\s*个?阶段|七阶段/g)].map((m) => spec.slice(Math.max(0, m.index - 50), m.index + 50));
  check('spec 中「7 阶段」仅出现在历史/迁移语境（当前/旧 board/v1）',
    sevenCtx.length > 0 && sevenCtx.every((ctx) => /当前|旧|v1|历史/.test(ctx)), sevenCtx);
  const sixCtx = [...spec.matchAll(/六页签|六视图/g)].map((m) => spec.slice(Math.max(0, m.index - 50), m.index + 60));
  check('spec 中「六页签/六视图」仅出现在 v1 历史标注语境',
    sixCtx.every((ctx) => /v1|历史/.test(ctx)), sixCtx);
  check('verify/all.mjs 纳入资料库 / 计算工具 / 独立审计三个测试（spec §19.8-8 / §20.7-6）',
    allm.includes('fde-library-host.mjs') && allm.includes('fde-tools.mjs') && allm.includes('acceptance-audit.mjs'));
  check('spec §13 A11/A12 已带版本历史标注（A11 v1.4 = 5 页签；A12 v1.3 = 11 个 FDE 技能 + 4 方法库）',
    spec.includes('**5 页签 + 页头设置入口**') && spec.includes('v1.3 九页签为历史基线') &&
    spec.includes('9 个 SKILL.md 有合法前置元数据（v1 历史；v1.3 为 11 个 FDE 技能'));
  const spec10 = (spec.match(/## 10\. agent skills([\s\S]*?)## 11\./g) || [''])[0];
  const tableRows = (spec10.match(/^\| `fde-[a-z-]+`/gm) || []).length;
  check('spec §10 技能表 11 行（v1.3 已补 fde-bid-radar / fde-scoping 两行）', tableRows === 11, tableRows);
}

/* 审计不联网的总断言：所有 GitHub 请求都走注入 mock，真实 fetch 一次都没发生。 */
check('审计全程未发起真实网络请求（fetch 拦截计数 = 0）', globalFetchCalls === 0, globalFetchCalls);

/* ============================ 汇总（v1 / v1.1 / v1.2 / v1.3 全部轮次） ============================ */

console.log('\n════════════════ 审计汇总 ════════════════');
console.log('断言通过：' + passed + ' 项；失败：' + failed.length + ' 项');
if (skipped.length) console.log('环境跳过（未验证）：' + skipped.join('、'));
if (findingsOpen.size) {
  console.log('\n未通过的发现（按 spec 断言失败 = 问题仍存在）：');
  for (const id of [...findingsOpen].sort()) console.log('  ' + id + ' [' + FINDINGS[id].sev + '] ' + FINDINGS[id].title);
}
const sevCount = { P0: 0, P1: 0, P2: 0 };
for (const id of findingsOpen) sevCount[FINDINGS[id].sev] += 1;
console.log('\n发现统计：P0=' + sevCount.P0 + '，P1=' + sevCount.P1 + '，P2=' + sevCount.P2);
if (observationsHit.size) console.log('观察项复现：' + [...observationsHit].sort().join('、'));
if (failed.length) {
  console.log('\n失败明细：');
  for (const f of failed) console.log('  ✗ ' + f);
  console.log('\n审计结论：发现 ' + failed.length + ' 项与 spec 不符（详见 verify/audit-report.md）。');
  process.exit(1);
}
if (typeof pending17 !== 'undefined' && pending17.length) {
  console.log('\n审计结论：既有断言全绿；第三轮 §17 等待实现 ' + pending17.length + ' 项（宿主/面板就绪后自动转为断言）。');
} else if (skipped.length) {
  console.log('\n审计结论：断言全绿；但有 ' + skipped.length + ' 项因环境限制未验证（见上）。');
} else {
  console.log('\n审计结论：全部 spec 断言通过（无发现）。');
}
