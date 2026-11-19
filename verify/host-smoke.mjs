/**
 * 宿主半冒烟测试：不依赖 DSH 运行时，用替身 ctx 验证注册是否正常。
 * 用法: node verify/host-smoke.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __toUrl = (p) => (String(p).startsWith('file:') ? p : pathToFileURL(p).href);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/* Phase 3 · 宿主内核加固：子进程执行层（官方 ctx.subprocess 优先 + 脱敏 execFile 回退）单测。 */
const subproc = await import(__toUrl(join(ROOT, 'src', 'host', 'subprocess.js')));

const mod = await import(__toUrl(join(ROOT, 'index.js')));
const fail = [];
const ok = [];

if (typeof mod.apply !== 'function') fail.push('缺少 apply 导出');
else ok.push('apply 导出存在');
if (!Array.isArray(mod.inject)) fail.push('缺少 inject 数组');
else ok.push('inject: ' + mod.inject.join(','));
/* DSH 0.2.1 兼容：硬依赖只有 dsh-base 自带的 tools 与 systemPrompt。
 * workspaceRegistry / sessionController 只在 Web 组合里有，写进 inject 会让 headless / acp / sdk 载体下
 * apply 根本不执行；webServer 自 v1.3 起就是可选挂载（ADR 0004 D3）。三者都改为用到时懒取。 */
if (Array.isArray(mod.inject)) {
  const need = ['tools', 'systemPrompt'];
  const mustNot = ['workspaceRegistry', 'sessionController', 'webServer', 'skills'];
  const missing = need.filter((n) => !mod.inject.includes(n));
  const extra = mod.inject.filter((n) => !need.includes(n));
  if (missing.length) fail.push('inject 缺少：' + missing.join(','));
  else if (mustNot.some((n) => mod.inject.includes(n))) fail.push('inject 不应硬依赖：' + mustNot.filter((n) => mod.inject.includes(n)).join(','));
  else if (extra.length) fail.push('inject 只应含 tools / systemPrompt，多出：' + extra.join(','));
  else ok.push('inject 契约：只硬依赖 tools / systemPrompt（workspaceRegistry / sessionController / webServer / skills 懒取）');
}
if (mod.name !== 'research-workbench') fail.push('name 应为 research-workbench，实际 ' + mod.name);
else ok.push('name=' + mod.name);

// 替身服务
const tools = [];
const routes = [];
const sections = [];
const openCalls = [];
const openSignals = [];
/* Phase 3 · 子进程替身：记录 spawn spec，不真的执行命令（用于断言走的是官方 ctx.subprocess 路径）。 */
const subCalls = [];
const fakeSubprocess = {
  resolveExecutable: async (cmd) => { subCalls.push({ kind: 'resolve', cmd }); return '/fake-bin/' + cmd; },
  spawn: (spec) => {
    subCalls.push({ kind: 'spawn', spec });
    return {
      done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: '模拟子进程输出', nextOffset: 20, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      terminate() {},
      waitForExit: async () => true,
    };
  },
};
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  get(n) {
    if (n === 'tools') return { register: (d) => tools.push(d) };
    if (n === 'webServer') return { register: (d) => { routes.push(d); return () => {}; } };
    if (n === 'systemPrompt') return {
      section: (d) => sections.push(d),
      getSectionOrder: () => 2950,
    };
    if (n === 'workspaceRegistry') return {
      cwd: join(ROOT, 'verify', 'tmp-ws'),
      list: () => [{ id: 'ws-1', path: join(ROOT, 'verify', 'tmp-ws'), updatedAt: new Date().toISOString() }],
    };
    if (n === 'sessionController') return {
      create: async () => ({ sessionId: 'test-session-1' }),
      prompt: async () => true,
      /* reveal 路由首选这条；测试里只记录，不真的调起 Finder。
       * 与 DSH 0.2.1 的实现同口径：第一步就是 signal.throwIfAborted()——不传 signal 必抛 TypeError。 */
      openWorkspacePath: async (req, signal) => {
        signal.throwIfAborted();
        openSignals.push(signal);
        openCalls.push(req);
        return { opened: true };
      },
    };
    /* Phase 3 · 官方子进程服务替身：让 rw_export_pdf / rw_qa_pdf 走 ctx.subprocess 主路径。 */
    if (n === 'subprocess') return fakeSubprocess;
    return undefined;
  },
};

const ws = join(ROOT, 'verify', 'tmp-ws');
mkdirSync(join(ws, 'research'), { recursive: true });

try {
  mod.apply(fakeCtx);
} catch (e) {
  fail.push('apply 抛错: ' + (e && e.message));
}

if (tools.length !== 16) fail.push(`应注册 16 个工具（rw_* 5 + fde_* 11），实际 ${tools.length}`);
else ok.push('工具注册 16 个: ' + tools.map((t) => t.name).join(', '));

const needTools = ['rw_status', 'rw_scaffold', 'rw_export_pdf', 'rw_qa_pdf', 'rw_method',
  'fde_board', 'fde_engagement', 'fde_item', 'fde_attention', 'fde_brief', 'fde_harvest', 'fde_bid', 'scys_fde',
  'fde_library', 'fde_scenario', 'fde_quote'];
for (const n of needTools) {
  const t = tools.find((x) => x.name === n);
  if (!t) { fail.push('缺少工具 ' + n); continue; }
  if (!t.description || t.description.length < 20) fail.push(n + ' 描述过短');
  if (!t.parameters || t.parameters.type !== 'object') fail.push(n + ' 缺少 parameters');
  if (typeof t.execute !== 'function') fail.push(n + ' 缺少 execute');
}

if (routes.length < 37) fail.push(`应注册 ≥37 条路由（旧 12 + FDE 13 + 招采 7 + 生财 3（feed/refresh/auth）+ 资料库 2），实际 ${routes.length}`);
else ok.push('路由注册 ' + routes.length + ' 条（含 FDE 13 + 招采 7 + 生财 3 + 资料库 2）');
const needFdeRoutes = ['board', 'brief', 'engagement', 'item', 'attention', 'gate', 'adopt', 'handoff', 'proposal', 'settings', 'sync', 'health', 'meta',
  'bids/stats', 'bids/search', 'bids/match', 'bids/link', 'bids/unlink', 'bids/promote', 'bids/refresh', 'scys/feed', 'scys/refresh', 'scys/auth',
  'library/feed', 'library/refresh']
  .map((x) => '/research-workbench/api/fde/' + x);
for (const n of needFdeRoutes) if (!routes.some((r) => r.path === n)) fail.push('缺少 FDE 路由 ' + n);

if (sections.length !== 1) fail.push(`应注册 1 段系统提示词，实际 ${sections.length}`);
else {
  const txt = sections[0].text || '';
  const must = ['默认只交付', '不要主动导出 PDF', '地址锚定', '三链验证', '候选人 ≠ 中标人', 'rw_scaffold',
    'FDE', 'fde_board', '回报协议', '红线', '阶段门禁', 'fde_bid', '招采雷达', 'UNAVAILABLE',
    'scys_fde', '生财 FDE 情报', 'UNAUTHORIZED',
    '8 个阶段', 'fde_library', 'FDE 资料库', 'fde_scenario', 'fde_quote', '不得除以 100', '场景'];
  for (const m of must) if (!txt.includes(m)) fail.push('系统提示词缺少关键约定: ' + m);
  ok.push('系统提示词 ' + txt.length + ' 字，含关键约定');
}

/* 功能冒烟：rw_scaffold */
const scaffold = tools.find((t) => t.name === 'rw_scaffold');
if (scaffold) {
  const r = await scaffold.execute({ company: '验证用公司', person: '张三', role: '董事长', purpose: '初次拜访' });
  if (!r.project) fail.push('rw_scaffold 未返回项目路径');
  else if (!existsSync(join(r.project, '00-项目档案.md'))) fail.push('rw_scaffold 未生成项目档案');
  else {
    for (const d of ['raw', 'research', 'meeting/exports', 'proposal/exports']) {
      if (!existsSync(join(r.project, d))) fail.push('缺少目录 ' + d);
    }
    ok.push('rw_scaffold 生成项目: ' + r.dir);
  }
}

/* 功能冒烟：rw_status */
const status = tools.find((t) => t.name === 'rw_status');
if (status) {
  const r = await status.execute({});
  if (!r.text || !r.text.includes('调研工作台')) fail.push('rw_status 输出异常');
  else ok.push('rw_status 可读，识别项目 ' + (r.projects || []).length + ' 个');
}

/* 功能冒烟：rw_method */
const method = tools.find((t) => t.name === 'rw_method');
if (method) {
  const all = await method.execute({});
  if (!all.text || !all.text.includes('methods')) fail.push('rw_method 列表异常');
  const one = await method.execute({ name: '流程' });
  if (!one.text || one.text.length < 300) fail.push('rw_method 读取「流程」异常');
  else ok.push('rw_method 可列出并读取方法文件');
}

/* 路由冒烟：scaffold / handoff / files / adopt */
const callRoute = async (pathWithQuery, method, body) => {
  const path = pathWithQuery.split('?')[0];
  const r = routes.find((x) => x.path === path);
  if (!r) return { status: 599, payload: { ok: false, reason: '路由未注册：' + path } };
  let status = 200; let payload = null;
  /* 路由统一守卫要求 POST 带 application/json；替身请求补齐该头（真实面板同样发送）。 */
  const headers = method === 'POST' ? { 'content-type': 'application/json' } : {};
  const req = { method, url: pathWithQuery, headers, on() {}, destroy() {} };
  const res = {
    set statusCode(v) { status = v; },
    get statusCode() { return status; },
    setHeader() {},
    end(txt) { try { payload = JSON.parse(txt); } catch { payload = { raw: txt }; } },
  };
  // 模拟 POST body
  if (method === 'POST') {
    const chunks = [Buffer.from(JSON.stringify(body || {}))];
    req.on = (ev, cb) => { if (ev === 'data') chunks.forEach(cb); if (ev === 'end') cb(); return req; };
  }
  await r.handler(req, res);
  return { status, payload };
};

{
  const need = ['/research-workbench/api/status', '/research-workbench/api/projects',
    '/research-workbench/api/methods', '/research-workbench/api/files',
    '/research-workbench/api/scaffold', '/research-workbench/api/handoff', '/research-workbench/api/adopt'];
  const got = routes.map((r) => r.path);
  for (const n of need) if (!got.includes(n)) fail.push('缺少路由 ' + n);

  const sc = await callRoute('/research-workbench/api/scaffold', 'POST', { company: '路由冒烟公司', person: '李四', role: '总经理' });
  if (!sc.payload || !sc.payload.ok) fail.push('scaffold 路由失败：' + JSON.stringify(sc.payload));
  else ok.push('scaffold 路由 OK → ' + sc.payload.dir);

  const fl = await callRoute('/research-workbench/api/files?dir=' + encodeURIComponent(sc.payload.dir), 'GET');
  if (!fl.payload || !fl.payload.ok) fail.push('files 路由失败：' + JSON.stringify(fl.payload));
  else ok.push('files 路由 OK（md ' + (fl.payload.files || []).filter((f) => f.kind === 'md').length + ' 个）');

  const ho = await callRoute('/research-workbench/api/handoff', 'POST', { action: 'start', company: '路由冒烟公司' });
  if (!ho.payload || !ho.payload.ok || !ho.payload.sessionId) fail.push('handoff(start) 失败：' + JSON.stringify(ho.payload));
  else ok.push('handoff(start) 路由 OK → sessionId=' + ho.payload.sessionId);

  const hs = await callRoute('/research-workbench/api/handoff', 'POST', { action: 'stage', dir: sc.payload.dir, stage: 'factcheck' });
  if (!hs.payload || !hs.payload.ok) fail.push('handoff(stage) 失败：' + JSON.stringify(hs.payload));
  else ok.push('handoff(stage) 路由 OK');

  const hx = await callRoute('/research-workbench/api/handoff', 'POST', { action: 'export', dir: sc.payload.dir, md: '00-项目档案.md' });
  if (!hx.payload || !hx.payload.ok) fail.push('handoff(export) 失败：' + JSON.stringify(hx.payload));
  else ok.push('handoff(export) 路由 OK');

  const ad = await callRoute('/research-workbench/api/adopt', 'POST', { dir: sc.payload.dir });
  if (!ad.payload || !ad.payload.ok) fail.push('adopt 路由失败：' + JSON.stringify(ad.payload));
  else ok.push('adopt 路由 OK');

  // 素材与上传
  const mt = await callRoute('/research-workbench/api/materials', 'GET');
  if (!mt.payload || !mt.payload.ok) fail.push('materials 路由失败：' + JSON.stringify(mt.payload));
  else ok.push('materials 路由 OK（素材目录 ' + (mt.payload.materials || []).length + ' · 散落 ' + (mt.payload.loose || []).length + '）');

  const upFile = Buffer.from('上传测试内容 hello').toString('base64');
  const up = await callRoute('/research-workbench/api/upload', 'POST', {
    dir: sc.payload.dir,
    files: [{ name: '测试资料.txt', data: upFile }],
  });
  if (!up.payload || !up.payload.ok || !(up.payload.saved || []).length) fail.push('upload 路由失败：' + JSON.stringify(up.payload));
  else ok.push('upload 路由 OK → ' + up.payload.saved[0].rel + '（' + up.payload.saved[0].bytes + ' 字节）');

  const upBad = await callRoute('/research-workbench/api/upload', 'POST', { dir: sc.payload.dir, files: [] });
  if (upBad.payload && upBad.payload.ok) fail.push('upload 空文件应报错');
  else ok.push('upload 空文件正确拒绝');

  // 上传文件应出现在 files 清单且标记 upload
  const fl2 = await callRoute('/research-workbench/api/files?dir=' + encodeURIComponent(sc.payload.dir), 'GET');
  const upItem = (fl2.payload.files || []).find((f) => f.upload);
  if (!upItem) fail.push('上传文件未出现在 files 清单');
  else ok.push('上传文件已被 files 路由识别（' + upItem.rel + '）');

  // 素材目录 → 转项目
  mkdirSync(join(ws, 'research', '素材测试目录'), { recursive: true });
  writeFileSync(join(ws, 'research', '素材测试目录', 'a.html'), '<html>x</html>');
  writeFileSync(join(ws, 'research', '素材测试目录', 'b.txt'), 'text');
  const tp = await callRoute('/research-workbench/api/toproject', 'POST', { dir: '素材测试目录', company: '素材测试目录' });
  if (!tp.payload || !tp.payload.ok) fail.push('toproject 路由失败：' + JSON.stringify(tp.payload));
  else {
    const arch = join(ws, 'research', '素材测试目录', '00-项目档案.md');
    const idxf = join(ws, 'research', '素材测试目录', 'internal', '素材索引.md');
    if (!existsSync(arch)) fail.push('toproject 未生成项目档案');
    else if (!existsSync(idxf)) fail.push('toproject 未生成素材索引');
    else ok.push('toproject 路由 OK（建档 + 素材索引）');
  }

  /* reveal：在 Finder 中定位 / 打开（替身 sessionController 只记录调用，绝不真的调起 Finder） */
  const target = join(ws, 'research', sc.payload.dir, '00-项目档案.md');
  const rv = await callRoute('/research-workbench/api/reveal', 'POST', { path: target, mode: 'reveal' });
  if (!rv.payload || !rv.payload.ok) fail.push('reveal 路由（reveal）失败：' + JSON.stringify(rv.payload));
  else if (rv.payload.how !== 'sessionController') fail.push('reveal 未走 sessionController，实际 ' + rv.payload.how);
  else if (!openCalls[0] || openCalls[0].action !== 'reveal' || openCalls[0].path !== target) fail.push('reveal 参数不对：' + JSON.stringify(openCalls[0]));
  else ok.push('reveal 路由 OK（reveal → 选中文件 ' + target.split('/').pop() + '）');

  const rvOpen = await callRoute('/research-workbench/api/reveal', 'POST', { path: join(ws, 'research', sc.payload.dir), mode: 'open' });
  if (!rvOpen.payload || !rvOpen.payload.ok || !rvOpen.payload.isDir) fail.push('reveal 路由（目录 open）失败：' + JSON.stringify(rvOpen.payload));
  else if (!openCalls[1] || openCalls[1].action !== undefined) fail.push('目录 open 不该带 action：' + JSON.stringify(openCalls[1]));
  else ok.push('reveal 路由 OK（目录 open → 交给默认应用）');
  /* DSH 0.2.1：openWorkspacePath 的第二参必须是可用的 AbortSignal（未取消），否则原生通道恒失败、静默退回系统命令。 */
  const badSignal = openSignals.filter((sg) => !sg || typeof sg.throwIfAborted !== 'function' || typeof sg.addEventListener !== 'function' || sg.aborted !== false);
  if (openSignals.length !== openCalls.length || openSignals.length < 2) fail.push('reveal 未给 openWorkspacePath 传 signal（调用 ' + openCalls.length + ' 次，带 signal ' + openSignals.length + ' 次）');
  else if (badSignal.length) fail.push('reveal 传给 openWorkspacePath 的 signal 不可用或已取消');
  else ok.push('reveal 传给 openWorkspacePath 的第二参是可用的 AbortSignal（' + openSignals.length + ' 次调用）');

  const rvOut = await callRoute('/research-workbench/api/reveal', 'POST', { path: '/etc/hosts' });
  if (!rvOut.payload || rvOut.payload.ok) fail.push('reveal 应拒绝工作区外的路径');
  else if (rvOut.status !== 403) fail.push('工作区外路径应回 403，实际 ' + rvOut.status);
  else ok.push('reveal 正确拒绝工作区外路径（403）');

  const rvMissing = await callRoute('/research-workbench/api/reveal', 'POST', { path: join(ws, 'research', '不存在的东西.md') });
  if (!rvMissing.payload || rvMissing.payload.ok) fail.push('reveal 应拒绝不存在的路径');
  else ok.push('reveal 正确拒绝不存在的路径（' + rvMissing.status + '）');

  const rvNoPath = await callRoute('/research-workbench/api/reveal', 'POST', {});
  if (!rvNoPath.payload || rvNoPath.payload.ok) fail.push('reveal 缺少 path 时应报错');
  else ok.push('reveal 缺少 path 正确报错');

  /* FDE 只读路由冒烟（不写 board，避免污染 tmp-ws） */
  const fmeta = await callRoute('/research-workbench/api/fde/meta', 'GET');
  if (!fmeta.payload || !fmeta.payload.ok || !fmeta.payload.meta || !Array.isArray(fmeta.payload.meta.stages) || fmeta.payload.meta.stages.length !== 8) {
    fail.push('fde/meta 失败：' + JSON.stringify(fmeta.payload).slice(0, 200));
  } else if (!fmeta.payload.meta.stages.every((x) => x.playbook && x.playbook.goal && x.playbook.tools.length)) {
    fail.push('fde/meta 阶段 playbook 缺失');
  } else ok.push('fde/meta 路由 OK（8 阶段 · 8 门禁 · playbook 齐全）');

  const fboard = await callRoute('/research-workbench/api/fde/board', 'GET');
  if (!fboard.payload || !fboard.payload.ok || !fboard.payload.board) fail.push('fde/board 失败：' + JSON.stringify(fboard.payload).slice(0, 200));
  else ok.push('fde/board 路由 OK（客户 ' + (fboard.payload.board.engagements || []).length + ' · 任务 ' + (fboard.payload.board.items || []).length + '）');

  const fbrief = await callRoute('/research-workbench/api/fde/brief', 'GET');
  if (!fbrief.payload || !fbrief.payload.ok || !fbrief.payload.brief) fail.push('fde/brief 失败：' + JSON.stringify(fbrief.payload).slice(0, 200));
  else ok.push('fde/brief 路由 OK（待处理 ' + (fbrief.payload.brief.attention || []).length + ' 条）');

  const fbidstats = await callRoute('/research-workbench/api/fde/bids/stats', 'GET');
  if (!fbidstats.payload || fbidstats.payload.ok !== true || fbidstats.payload.available !== false) {
    fail.push('fde/bids/stats 服务缺失时应 200 + available:false：' + JSON.stringify(fbidstats.payload).slice(0, 160));
  } else ok.push('fde/bids/stats 路由 OK（bid-intel 未装载时 available:false，不报错）');

  const fbidsearch = await callRoute('/research-workbench/api/fde/bids/search?q=' + encodeURIComponent('招标') + '&limit=5', 'GET');
  if (!fbidsearch.payload || fbidsearch.payload.ok !== true || fbidsearch.payload.available !== false) {
    fail.push('fde/bids/search 服务缺失时应 200 + available:false');
  } else ok.push('fde/bids/search 路由 OK（降级不报错）');

  const fbidmatch = await callRoute('/research-workbench/api/fde/bids/match?engagementId=eng_000000', 'GET');
  if (!fbidmatch.payload || fbidmatch.payload.ok !== true || fbidmatch.payload.available !== false) {
    fail.push('fde/bids/match 服务缺失时应 200 + available:false（优先降级，不做客户校验）');
  } else ok.push('fde/bids/match 服务缺失降级 OK（200 + available:false）');

  /* 生财 FDE 情报：只读缓存路由（不触发联网刷新；本机首跑无缓存时 feed:null 属正常） */
  const fscys = await callRoute('/research-workbench/api/fde/scys/feed', 'GET');
  if (!fscys.payload || typeof fscys.payload.ok !== 'boolean' || !('feed' in fscys.payload) || !('today' in fscys.payload)) {
    fail.push('fde/scys/feed 失败：' + JSON.stringify(fscys.payload).slice(0, 200));
  } else ok.push('fde/scys/feed 路由 OK（ok=' + fscys.payload.ok + '，缓存 ' + (fscys.payload.feed ? '有（' + (fscys.payload.feed.items || []).length + ' 条）' : '无') + '）');

  /* FDE 资料库：只读缓存路由（不触发刷新；无缓存或 catalog 缺失都属结构化降级） */
  const flib = await callRoute('/research-workbench/api/fde/library/feed', 'GET');
  if (!flib.payload || typeof flib.payload.ok !== 'boolean' || !('feed' in flib.payload) || !('today' in flib.payload)) {
    fail.push('fde/library/feed 失败：' + JSON.stringify(flib.payload).slice(0, 200));
  } else if (flib.payload.ok === false && flib.payload.code !== 'UNAVAILABLE') {
    fail.push('fde/library/feed 降级 code 非 UNAVAILABLE：' + JSON.stringify(flib.payload).slice(0, 160));
  } else ok.push('fde/library/feed 路由 OK（' + (flib.payload.feed ? (flib.payload.feed.items || []).length + ' 条缓存' : '无缓存') + (flib.payload.code ? ' / ' + flib.payload.code : '') + '）');

  const fhealth = await callRoute('/research-workbench/api/fde/health', 'GET');
  if (!fhealth.payload || !fhealth.payload.ok || !Array.isArray(fhealth.payload.checks) || fhealth.payload.checks.length < 5) {
    fail.push('fde/health 失败：' + JSON.stringify(fhealth.payload).slice(0, 200));
  } else ok.push('fde/health 路由 OK（' + fhealth.payload.checks.length + ' 项自检）');
}

/* ================= Phase 3 · 宿主内核加固 ================= */
/* 审查 F-04/F-10/F-13 对应断言：子进程走官方服务、路径包含性、presentCall 枚举合法。 */
{
  const exportTool = tools.find((t) => t.name === 'rw_export_pdf');
  const qaTool = tools.find((t) => t.name === 'rw_qa_pdf');
  const cleanDir = join(ws, 'research', '_pw-clean');
  mkdirSync(cleanDir, { recursive: true });
  writeFileSync(join(cleanDir, 'a.md'), '# 硬化测试\n', 'utf8');
  writeFileSync(join(cleanDir, 'x.pdf'), '%PDF-1.4\n', 'utf8');

  /* presentCall.kind 必须是官方 ToolCallKind 枚举（dsh-tools/lib/types/presentation.d.ts）。 */
  const KIND_ENUM = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other'];
  const badKinds = [];
  for (const t of tools) {
    if (typeof t.presentCall !== 'function') continue;
    let view = null;
    try { view = t.presentCall({ action: 'x', target: 'engagement', id: 'eng_x', company: '某集团有限公司', person: '张三' }); } catch (e) { badKinds.push(t.name + ' 抛错：' + String(e && e.message)); continue; }
    if (!view || !KIND_ENUM.includes(view.kind)) badKinds.push(t.name + ' → ' + (view && view.kind));
  }
  if (badKinds.length) fail.push('presentCall.kind 非法（应属官方枚举）：' + badKinds.join('；'));
  else ok.push('presentCall.kind 全部属官方 ToolCallKind 枚举（' + tools.filter((t) => typeof t.presentCall === 'function').length + ' 个工具）');

  if (!exportTool || !qaTool) {
    fail.push('缺少 rw_export_pdf / rw_qa_pdf，无法完成路径与子进程断言');
  } else {
    /* 路径包含性（F-04）：越界/不存在一律 ok:false 且不抛异常。 */
    const escAbs = await exportTool.execute({ md: '/etc/hosts' });
    if (escAbs.ok !== false || !/越界/.test(String(escAbs.reason || escAbs.text))) fail.push('rw_export_pdf 绝对路径越界未被拒：' + JSON.stringify(escAbs).slice(0, 160));
    else ok.push('rw_export_pdf 拒绝工作区外绝对路径（ok:false，不抛）');

    const escRel = await exportTool.execute({ md: 'research/_pw-clean/a.md', out: '../outside.pdf' });
    if (escRel.ok !== false || !/越界/.test(String(escRel.reason || escRel.text))) fail.push('rw_export_pdf out=../outside.pdf 未被拒：' + JSON.stringify(escRel).slice(0, 160));
    else ok.push('rw_export_pdf 拒绝 out 相对越界（..）');

    const missing = await exportTool.execute({ md: 'research/_pw-clean/nope.md' });
    if (missing.ok !== false || !/不存在/.test(String(missing.reason || missing.text))) fail.push('rw_export_pdf 缺失文件未按 ok:false 返回：' + JSON.stringify(missing).slice(0, 160));
    else ok.push('rw_export_pdf 缺失文件返回 ok:false（不抛）');

    const qaEsc = await qaTool.execute({ pdf: '/etc/hosts' });
    if (qaEsc.ok !== false || !/越界/.test(String(qaEsc.reason || qaEsc.text))) fail.push('rw_qa_pdf 绝对路径越界未被拒：' + JSON.stringify(qaEsc).slice(0, 160));
    else ok.push('rw_qa_pdf 拒绝工作区外绝对路径（ok:false，不抛）');

    /* 符号链接指向工作区外：realpath 前缀校验必须拒绝。 */
    const outsideDir = mkdtempSync(join(tmpdir(), 'fde-outside-'));
    const outsideFile = join(outsideDir, 'secret.pdf');
    writeFileSync(outsideFile, '%PDF-1.4 outside', 'utf8');
    const linkPath = join(cleanDir, 'link.pdf');
    let linkReady = false;
    try {
      rmSync(linkPath, { force: true });
      symlinkSync(outsideFile, linkPath);
      linkReady = true;
    } catch (e) {
      const code = e && e.code;
      // 只有创建符号链接这一步的 EPERM/ENOTSUP/EACCES 才算环境能力缺失；
      // 工具执行期的错误不能被吞成「环境跳过」，否则会掩盖真实缺陷。
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES') ok.push('符号链接用例跳过（当前环境不允许创建 symlink）');
      else fail.push('符号链接用例无法执行（环境不支持 symlink）：' + String((e && e.message) || e));
    }
    if (linkReady) {
      try {
        const qaLink = await qaTool.execute({ pdf: 'research/_pw-clean/link.pdf' });
        if (qaLink.ok !== false || !/符号链接|越界/.test(String(qaLink.reason || qaLink.text))) fail.push('rw_qa_pdf 未拒绝指向工作区外的符号链接：' + JSON.stringify(qaLink).slice(0, 160));
        else ok.push('rw_qa_pdf 拒绝指向工作区外的符号链接（realpath 前缀）');
      } catch (e) {
        fail.push('rw_qa_pdf 符号链接用例执行异常：' + String((e && e.message) || e));
      }
    }
    rmSync(outsideDir, { recursive: true, force: true });

    /* 子进程主路径（F-04）：优先 ctx.subprocess.spawn，spec 显式 cwd/stdio/grace。 */
    subCalls.length = 0;
    const expOk = await exportTool.execute({ md: 'research/_pw-clean/a.md' });
    const spawnCall = subCalls.find((c) => c.kind === 'spawn');
    if (!expOk.ok) fail.push('rw_export_pdf 走 ctx.subprocess 主路径失败：' + JSON.stringify(expOk).slice(0, 200));
    else if (!spawnCall) fail.push('rw_export_pdf 未调用 ctx.subprocess.spawn（回退了 execFile）');
    else {
      const spec = spawnCall.spec;
      const problems = [];
      if (!spec || !Array.isArray(spec.argv)) problems.push('argv 缺失');
      else if (spec.argv[0] !== '/fake-bin/bash') problems.push('argv[0] 未用 resolveExecutable 结果：' + spec.argv[0]);
      if (spec.cwd !== ws) problems.push('cwd 未显式传工作区根：' + spec.cwd);
      if (!spec.stdio || spec.stdio.stdin !== 'ignore') problems.push('stdin 未显式 ignore');
      if (!spec.stdio.stdout || !(spec.stdio.stdout.maxBytes > 0)) problems.push('stdout 未用有界 collect');
      if (!spec.stdio.stderr || !(spec.stdio.stderr.maxBytes > 0)) problems.push('stderr 未用有界 collect');
      if (!(spec.graceMs > 0)) problems.push('graceMs 缺失');
      if (problems.length) fail.push('ctx.subprocess.spawn spec 不合契约：' + problems.join('；'));
      else ok.push('rw_export_pdf 走 ctx.subprocess.spawn（显式 cwd/stdio/graceMs，argv[0] 为解析后可执行文件）');
    }

    subCalls.length = 0;
    const qaOk = await qaTool.execute({ pdf: 'research/_pw-clean/x.pdf' });
    const qaSpawn = subCalls.find((c) => c.kind === 'spawn');
    if (!qaOk.ok) fail.push('rw_qa_pdf 走 ctx.subprocess 主路径失败：' + JSON.stringify(qaOk).slice(0, 200));
    else if (!qaSpawn || qaSpawn.spec.argv[0] !== '/fake-bin/python3') fail.push('rw_qa_pdf 未走 ctx.subprocess（或 argv[0] 不对）');
    else ok.push('rw_qa_pdf 走 ctx.subprocess.spawn（python3 经 resolveExecutable）');

    /* 回退路径（F-04）：服务缺失时必须脱敏 env + 显式 cwd。 */
    const savedEnv = {};
    const probeEnv = {
      DSH_PW_TEST: '1', MY_TEST_TOKEN: 't', MY_TEST_API_KEY: 'k', MY_TEST_PASSWORD: 'p',
      MY_TEST_SECRET: 's', MY_TEST_CREDENTIAL: 'c', MY_TEST_AUTH_HEADER: 'a',
      HTTP_PROXY: 'http://127.0.0.1:9',
    };
    for (const [k, v] of Object.entries(probeEnv)) { savedEnv[k] = process.env[k]; process.env[k] = v; }
    try {
      const env = subproc.scrubbedEnv();
      /* Windows 环境变量不区分大小写：runner 上是 `Path`，Git Bash 里可能是 `PATH`，
       * 这里按不区分大小写检查，否则 Windows CI 会误判「误删 PATH」。 */
      const envHas = (name) => Object.keys(env).some((k) => k.toUpperCase() === name);
      const leak = ['DSH_PW_TEST', 'MY_TEST_TOKEN', 'MY_TEST_API_KEY', 'MY_TEST_PASSWORD', 'MY_TEST_SECRET', 'MY_TEST_CREDENTIAL', 'MY_TEST_AUTH_HEADER'].filter((k) => Object.prototype.hasOwnProperty.call(env, k));
      if (leak.length) fail.push('scrubbedEnv 未剔除 DSH_/凭据变量：' + leak.join(','));
      else if (!envHas('PATH') || !envHas('HTTP_PROXY')) fail.push('scrubbedEnv 误删 PATH/proxy（应保留）');
      else ok.push('scrubbedEnv 剔除 DSH_/凭据形状变量、保留 PATH/proxy');

      const noSubCtx = { get: () => undefined };
      const prog = 'process.stdout.write(JSON.stringify({dsh:Object.prototype.hasOwnProperty.call(process.env,"DSH_PW_TEST"),tok:Object.prototype.hasOwnProperty.call(process.env,"MY_TEST_TOKEN"),path:!!process.env.PATH,cwd:process.cwd()}))';
      const fb = await subproc.run(noSubCtx, process.execPath, ['-e', prog], { cwd: ws, timeoutMs: 20000 });
      let parsed = null;
      try { parsed = JSON.parse(fb.stdout); } catch { /* 下面统一判失败 */ }
      if (!fb.ok || fb.how !== 'execFile') fail.push('服务缺失时未回退 execFile：' + String(fb.reason || fb.code));
      else if (!parsed || parsed.dsh || parsed.tok || !parsed.path) fail.push('execFile 回退未脱敏 env：' + fb.stdout.slice(0, 200));
      else if (parsed.cwd !== ws) fail.push('execFile 回退未显式 cwd：子进程 cwd=' + parsed.cwd + '，期望 ' + ws);
      else ok.push('服务缺失时回退 execFile（脱敏 env + 显式 cwd=工作区根）');

      /* 服务存在但本次 spawn 失败：同样回退，并标记 fallbackFrom。 */
      const brokenSvcCtx = {
        get: (n) => (n === 'subprocess' ? {
          resolveExecutable: async (cmd) => '/fake-bin/' + cmd,
          spawn: () => { throw new Error('spawn failed in test'); },
        } : undefined),
      };
      const fb2 = await subproc.run(brokenSvcCtx, process.execPath, ['-e', 'process.stdout.write("ok")'], { cwd: ws, timeoutMs: 20000 });
      if (!fb2.ok || fb2.how !== 'execFile' || fb2.fallbackFrom !== 'subprocess') fail.push('官方服务失败时未回退 execFile：' + JSON.stringify({ ok: fb2.ok, how: fb2.how, from: fb2.fallbackFrom, reason: fb2.reason }));
      else ok.push('ctx.subprocess 调用失败时回退 execFile（标记 fallbackFrom=subprocess）');
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }
}

/* 客户端半检查 */
if (!existsSync(join(ROOT, 'client.js'))) fail.push('client.js 未构建（先跑 node build.mjs）');
else {
  const c = (await import('node:fs')).readFileSync(join(ROOT, 'client.js'), 'utf8');
  /* ADR 0004 D1：client-modules 模块 id 与包名一致（dsh-fde）；侧栏 panel id 仍是 researchworkbench。 */
  if (!c.includes("id: 'dsh-fde'")) fail.push('client.js 模块 id 不符（应为 dsh-fde）');
  else if (!c.includes("id: 'researchworkbench'")) fail.push('client.js 侧栏 panel id 不符（应保持 researchworkbench）');
  else ok.push('client.js 就绪');
}

/* ============================ DSH 0.2.1 兼容性 ============================ */

/** 与 dsh-skill 0.2.1 同口径的技能服务替身：register 只校验名称与描述，get（加载）时校验
 *  source / provider / content 必须是字符串——缺 source 的技能「能注册、能列出，加载必抛」。 */
function makeStrictSkills() {
  const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const runtime = new Map();
  return {
    register(skill) {
      if (!SKILL_NAME.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`);
      if (skill.description.length === 0) throw new Error(`skill "${skill.name}" requires a description`);
      if (runtime.has(skill.name)) return () => {};
      runtime.set(skill.name, {
        ...skill,
        invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
        provider: skill.provider ?? 'runtime',
      });
      return () => { runtime.delete(skill.name); };
    },
    async list() { return [...runtime.values()].map((d) => ({ name: d.name, description: d.description, source: d.source, provider: d.provider })); },
    async get(skillName) {
      const d = runtime.get(skillName);
      if (d === undefined) return undefined;
      if (typeof d.name !== 'string') throw new TypeError('loaded skill name must be a string');
      if (typeof d.description !== 'string') throw new TypeError(`loaded skill "${d.name}" description must be a string`);
      if (typeof d.source !== 'string') throw new TypeError(`loaded skill "${d.name}" source must be a string`);
      if (typeof d.provider !== 'string') throw new TypeError(`loaded skill "${d.name}" provider must be a string`);
      if (typeof d.content !== 'string') throw new TypeError(`loaded skill "${d.name}" content must be a string`);
      if (d.path !== undefined && typeof d.path !== 'string') throw new TypeError(`loaded skill "${d.name}" path must be a string`);
      return d;
    },
    _names: () => [...runtime.keys()],
  };
}

/* 替身自检（反例）：缺 source 的注册对象，加载时必须抛——证明下面的断言不是空转。 */
{
  const probe = makeStrictSkills();
  probe.register({ name: 'probe-skill', description: '反例', content: '正文' });
  let msg = '';
  try { await probe.get('probe-skill'); } catch (e) { msg = String(e && e.message); }
  if (!/source must be a string/.test(msg)) fail.push('技能服务替身没有校验 source（反例未抛）：' + msg);
  else ok.push('技能服务替身与 dsh-skill 0.2.1 同口径（缺 source → 加载抛 TypeError）');
}

/* 最小服务集：只有 tools + systemPrompt（dsh-base 自带；headless / acp / sdk 载体就是这样）。
 * apply 必须成功、16 个工具注册、不注册路由；工具可调用且不抛。 */
{
  const minTools = [];
  const minSections = [];
  const modMin = await import(__toUrl(join(ROOT, 'index.js')) + '?minimal=1');
  const minCtx = {
    logger: { info() {}, warn() {}, error() {} },
    get(n) {
      if (n === 'tools') return { register: (d) => minTools.push(d) };
      if (n === 'systemPrompt') return { section: (d) => minSections.push(d), getSectionOrder: () => 2950 };
      return undefined;
    },
  };
  let threw = null;
  try { modMin.apply(minCtx); } catch (e) { threw = e; }
  if (threw) fail.push('最小服务集（tools + systemPrompt）apply 抛错：' + String(threw && threw.message));
  else if (minTools.length !== 16) fail.push('最小服务集应注册 16 个工具，实际 ' + minTools.length);
  else if (minSections.length !== 1) fail.push('最小服务集应注册 1 段系统提示词，实际 ' + minSections.length);
  else ok.push('最小服务集（只有 tools + systemPrompt）apply 成功：16 个工具 + 1 段系统提示词，不注册路由');
  if (!threw && minTools.length === 16) {
    const run = async (toolName, args) => {
      try { return await minTools.find((t) => t.name === toolName).execute(args); } catch (e) { return { threw: String(e && e.message) }; }
    };
    const st = await run('rw_status', { root: ws });
    const bd = await run('fde_board', { view: 'board', root: ws });
    const sn = await run('fde_scenario', { action: 'template' });
    const bad = [['rw_status', st], ['fde_board', bd], ['fde_scenario', sn]].filter(([, r]) => !r || r.threw || r.ok === false || typeof r.text !== 'string');
    if (bad.length) fail.push('最小服务集下工具不可用：' + bad.map(([n, r]) => n + ' → ' + JSON.stringify(r).slice(0, 120)).join('；'));
    else ok.push('最小服务集下工具可用（rw_status / fde_board / fde_scenario；没有 workspaceRegistry 与 sessionController）');
  }
}

/* 真实 cordis 的访问语义：没写进 inject 的服务用属性访问会抛（cannot get property … without inject），
 * 只能 ctx.get；晚到的服务经 ctx.inject(deps, cb) 通知。验证：apply 不受影响，skills / webServer 晚到后补注册。 */
{
  const lateTools = [];
  const lateRoutes = [];
  const provided = {
    tools: { register: (d) => lateTools.push(d) },
    systemPrompt: { section() {}, getSectionOrder: () => 2950 },
  };
  const waiters = [];
  const base = {
    logger: { info() {}, warn() {}, error() {} },
    get: (n) => provided[n],
    inject: (deps, cb) => { waiters.push({ deps, cb }); },
    effect: (fn) => { try { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
  };
  const strictCtx = new Proxy(base, {
    get(t, prop) {
      if (typeof prop === 'symbol' || prop in t) return t[prop];
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  });
  const modLate = await import(__toUrl(join(ROOT, 'index.js')) + '?late=1');
  let threw = null;
  try { modLate.apply(strictCtx); } catch (e) { threw = e; }
  if (threw) fail.push('未声明服务属性访问会抛的上下文里 apply 失败：' + String(threw && threw.message));
  else if (lateTools.length !== 16) fail.push('未声明服务属性访问会抛的上下文里应注册 16 个工具，实际 ' + lateTools.length);
  else ok.push('未声明的服务只走 ctx.get（属性访问抛错也不影响 apply，16 个工具注册）');
  const waiting = waiters.map((w) => w.deps.join('+')).sort().join(',');
  if (waiting !== 'skills,webServer') fail.push('应等待 skills 与 webServer 晚到，实际等待：' + (waiting || '（无）'));
  else {
    /* 服务晚到：先挂上，再触发 ctx.inject 的回调。 */
    const strictSkills = makeStrictSkills();
    provided.skills = strictSkills;
    provided.webServer = { register: (d) => { lateRoutes.push(d); return () => {}; } };
    let lateErr = null;
    try { for (const w of waiters) w.cb(strictCtx); } catch (e) { lateErr = e; }
    const names = strictSkills._names();
    const diskSkills = (await import(__toUrl(join(ROOT, 'src', 'host', 'fde-api.js')))).discoverSkills(join(ROOT, 'skills'));
    if (lateErr) fail.push('服务晚到后的补注册抛错：' + String(lateErr && lateErr.message));
    else if (names.length !== diskSkills.length || names.length < 1) fail.push('skills 晚到后应补注册 ' + diskSkills.length + ' 个技能，实际 ' + names.length);
    else if (lateRoutes.length < 37) fail.push('webServer 晚到后应挂载 ≥37 条路由，实际 ' + lateRoutes.length);
    else ok.push('skills / webServer 晚到后补注册（技能 ' + names.length + ' 个 · 路由 ' + lateRoutes.length + ' 条）');
    /* 注册 + 读取：每个技能都能加载，source 是非空字符串。 */
    const loadBad = [];
    for (const n of names) {
      try {
        const d = await strictSkills.get(n);
        if (!d || typeof d.source !== 'string' || !d.source || d.provider !== 'runtime' || typeof d.content !== 'string' || !d.content) loadBad.push(n + '（字段不全）');
      } catch (e) { loadBad.push(n + ' → ' + String(e && e.message)); }
    }
    if (loadBad.length) fail.push('技能加载失败（DSH 0.2.1 要求 source 是字符串）：' + loadBad.join('；'));
    else if (names.length) ok.push('技能注册 + 读取：' + names.length + ' 个技能全部可加载，source 均为非空字符串（runtime）');
    const srcBad = diskSkills.filter((x) => typeof x.source !== 'string' || !x.source);
    if (srcBad.length) fail.push('discoverSkills 产出的对象缺 source：' + srcBad.map((x) => x.name).join('、'));
    else ok.push('discoverSkills 产出的每个对象都带 source（' + diskSkills.length + ' 个）');
  }
}

console.log('\n=== 通过 ===');
for (const s of ok) console.log('  ✓ ' + s);
if (fail.length) {
  console.log('\n=== 失败 ===');
  for (const f of fail) console.log('  ✗ ' + f);
}
/* 清理本次冒烟产生的临时项目（按前缀清，避免日期后缀变化导致残留；失败时也清理） */
try {
  const { rmSync, readdirSync } = await import('node:fs');
  const base = join(ws, 'research');
  let removed = 0;
  for (const name of readdirSync(base)) {
    if (name.startsWith('验证用公司-') || name.startsWith('路由冒烟公司-') || name === '素材测试目录' || name === '_pw-clean') {
      rmSync(join(base, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  /* FDE health 自检会建 research/.fde（可写性探测），一并清理 */
  try { rmSync(join(ws, 'research', '.fde'), { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n（已清理冒烟测试临时项目 ${removed} 个）`);
} catch (e) { /* ignore */ }

if (fail.length) process.exit(1);
console.log('\n宿主冒烟测试全部通过。');
