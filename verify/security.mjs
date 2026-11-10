/**
 * 路由安全守卫测试（A2+A3）
 *
 * 用替身 ctx 加载 index.js，逐条打 37 条路由（含 FDE 13 + 招采 7 + 生财 3 + 资料库 2），验证：
 * - 鉴权：无 cookie → 401；伪造跨站 Origin → 403；合法 cookie → 200
 * - 方法白名单：GET 写路由 → 405；POST 只读路由 → 405
 * - POST 内容类型：非 application/json → 415
 * - 路径安全：dir 穿越 / 非法 root → 400；合法项目目录 → 200
 * - 无 connection 时的 Host/Origin fallback fence
 *
 * 不依赖 DSH 运行时与浏览器；所有写操作只落在 os.tmpdir() 的临时工作区，结束即清理。
 * 用法: node verify/security.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __toUrl = (p) => (String(p).startsWith('file:') ? p : pathToFileURL(p).href);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(__toUrl(join(ROOT, 'index.js')));

const fail = [];
const ok = [];
const check = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || !extra ? '' : ' → ' + extra));
  (cond ? ok : fail).push(name);
};

/* ---------------- 临时工作区（只写 /tmp） ---------------- */
const ws = mkdtempSync(join(tmpdir(), 'rw-security-'));
mkdirSync(join(ws, 'research', 'demo'), { recursive: true });
const cleanup = () => { try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ } };
process.on('exit', cleanup);

/* ---------------- 替身 ctx ---------------- */
const CONNECTION = {
  admit(req) {
    const h = (req && req.headers) || {};
    const origin = String(h.origin || '');
    /* 真实 connection 的 Host/Origin fence 与浏览器 cookie 鉴权；这里用最简桩模拟。 */
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return { rejection: 403 };
    if (!String(h.cookie || '').includes('dsh_token=')) return { rejection: 401 };
    return { peer: { id: 'operator' } };
  },
};

function makeCtx({ connection, registryRoot, registryList, noRegistry, bidIntel } = {}) {
  const routes = [];
  const warns = [];
  const ctx = {
    logger: { info() {}, warn(m) { warns.push(String(m)); }, error() {} },
    effect(fn) {
      try { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {}; } catch { return () => {}; }
    },
    get(n) {
      if (n === 'tools') return { register() { return () => {}; } };
      if (n === 'webServer') return { register(d) { routes.push(d); return () => {}; } };
      if (n === 'systemPrompt') return { section() {}, getSectionOrder() { return 2950; } };
      if (n === 'workspaceRegistry') {
        if (noRegistry) return undefined;
        const list = registryList || [{ id: 'ws-security', path: registryRoot || ws, updatedAt: new Date().toISOString() }];
        return { list: () => list };
      }
      if (n === 'sessionController') {
        return {
          create: async () => ({ sessionId: 'security-session' }),
          prompt: async () => true,
          openWorkspacePath: async () => ({ ok: true }),
        };
      }
      if (n === 'connection') return connection;
      if (n === 'bidIntel') return bidIntel;
      return undefined;
    },
  };
  mod.apply(ctx);
  return { routes, warns };
}

/* ---------------- 请求替身 ---------------- */
const parsePayload = (raw) => {
  try { return JSON.parse(raw); } catch { return { raw }; }
};

function call(routes, pathWithQuery, opts = {}) {
  const method = opts.method || 'GET';
  const headers = Object.assign({}, opts.headers);
  const path = pathWithQuery.split('?')[0];
  const route = routes.find((x) => x.path === path);
  return new Promise((resolve) => {
    if (!route) return resolve({ status: 599, payload: { reason: '路由未注册：' + path } });
    let status = 200;
    const req = new EventEmitter();
    req.url = pathWithQuery;
    req.method = method;
    req.headers = headers;
    req.destroy = () => {};
    const resHeaders = {};
    const res = {
      set statusCode(v) { status = v; },
      get statusCode() { return status; },
      /* Phase 3 · 审查 F-13：记录响应头，断言所有 JSON 响应都带 no-store / nosniff。 */
      setHeader(k, v) { resHeaders[String(k).toLowerCase()] = String(v); },
      end(txt) { resolve({ status, payload: parsePayload(String(txt ?? '')), raw: String(txt ?? ''), headers: resHeaders }); },
    };
    if (method === 'POST') {
      const rawBody = JSON.stringify(opts.body ?? {});
      setImmediate(() => { req.emit('data', Buffer.from(rawBody)); req.emit('end'); });
    }
    Promise.resolve(route.handler(req, res)).catch((e) => resolve({ status: 'THROW', payload: { reason: String(e) } }));
  });
}

const AUTH = { cookie: 'dsh_token=test-token' };
const JSON_HDR = { 'content-type': 'application/json', ...AUTH };

/* ================= 1. 有 connection（真实 Web 组合语义） ================= */
{
  const { routes } = makeCtx({ connection: CONNECTION });
  check('37 条路由全部注册（旧 12 + FDE 13 + 招采 7 + 生财 3（feed/refresh/auth）+ 资料库 2）', routes.length === 37, '实际 ' + routes.length + '：' + routes.map((r) => r.path).join(','));

  const noCookie = await call(routes, '/research-workbench/api/status', { headers: {} });
  check('无 cookie /api/status → 401', noCookie.status === 401, '实际 ' + noCookie.status);

  const evilOrigin = await call(routes, '/research-workbench/api/status', {
    headers: { ...AUTH, origin: 'https://evil.example' },
  });
  check('伪造跨站 Origin → 403', evilOrigin.status === 403, '实际 ' + evilOrigin.status);

  const good = await call(routes, '/research-workbench/api/status', { headers: AUTH });
  check('合法 cookie /api/status → 200', good.status === 200 && good.payload.ok === true, JSON.stringify(good.payload).slice(0, 120));

  /* Phase 3 · 审查 F-13：私有状态与鉴权结果一律 Cache-Control: no-store + nosniff（对齐官方 /api 路由）。 */
  check('200 响应头 Cache-Control: no-store', good.headers['cache-control'] === 'no-store', good.headers['cache-control']);
  check('200 响应头 X-Content-Type-Options: nosniff', good.headers['x-content-type-options'] === 'nosniff', good.headers['x-content-type-options']);
  check('200 响应仍声明 JSON Content-Type', String(good.headers['content-type'] || '').startsWith('application/json'), good.headers['content-type']);
  check('401 鉴权失败响应同样 no-store + nosniff', noCookie.headers['cache-control'] === 'no-store' && noCookie.headers['x-content-type-options'] === 'nosniff', JSON.stringify(noCookie.headers));

  const getUpload = await call(routes, '/research-workbench/api/upload?dir=demo', { headers: AUTH });
  check('GET /api/upload → 405', getUpload.status === 405, '实际 ' + getUpload.status);
  check('405 错误响应同样 no-store + nosniff', getUpload.headers['cache-control'] === 'no-store' && getUpload.headers['x-content-type-options'] === 'nosniff', JSON.stringify(getUpload.headers));
  check('405 保留 Allow 头（方法白名单可见）', !!getUpload.headers.allow, String(getUpload.headers.allow));

  const postFiles = await call(routes, '/research-workbench/api/files', { method: 'POST', headers: JSON_HDR, body: {} });
  check('POST /api/files → 405', postFiles.status === 405, '实际 ' + postFiles.status);

  const badType = await call(routes, '/research-workbench/api/upload', {
    method: 'POST', headers: { 'content-type': 'text/plain', ...AUTH }, body: { dir: 'demo' },
  });
  check('POST /api/upload 非 JSON → 415', badType.status === 415, '实际 ' + badType.status);
  check('415 错误响应同样 no-store + nosniff', badType.headers['cache-control'] === 'no-store' && badType.headers['x-content-type-options'] === 'nosniff', JSON.stringify(badType.headers));

  const traversal = await call(routes, '/research-workbench/api/files?dir=' + encodeURIComponent('../../../../../etc'), { headers: AUTH });
  check('files?dir=../../../../../etc → 400', traversal.status === 400, '实际 ' + traversal.status + ' ' + JSON.stringify(traversal.payload).slice(0, 100));

  const traversal2 = await call(routes, '/research-workbench/api/material-files?dir=' + encodeURIComponent('../../etc'), { headers: AUTH });
  check('material-files?dir=../../etc → 400', traversal2.status === 400, '实际 ' + traversal2.status);

  const badToproject = await call(routes, '/research-workbench/api/toproject', {
    method: 'POST', headers: JSON_HDR, body: { dir: '../../outside' },
  });
  check('toproject dir=../../outside → 400', badToproject.status === 400, '实际 ' + badToproject.status);

  const badRoot = await call(routes, '/research-workbench/api/scaffold', {
    method: 'POST', headers: JSON_HDR, body: { company: 'x', root: '/etc' },
  });
  check('scaffold root=/etc（不在注册工作区）→ 400', badRoot.status === 400, '实际 ' + badRoot.status);

  const goodToproject = await call(routes, '/research-workbench/api/toproject', {
    method: 'POST', headers: JSON_HDR, body: { dir: 'demo', company: 'demo' },
  });
  const archive = join(ws, 'research', 'demo', '00-项目档案.md');
  check('合法 toproject（/tmp 临时项目）→ 200 且建档', goodToproject.status === 200 && existsSync(archive), '状态 ' + goodToproject.status + '，档案存在 ' + existsSync(archive));

  const filesAfter = await call(routes, '/research-workbench/api/files?dir=demo', { headers: AUTH });
  check('合法 files?dir=demo → 200', filesAfter.status === 200 && Array.isArray(filesAfter.payload.files), '实际 ' + filesAfter.status);

  /* 合法显式 root（= 已注册工作区）必须放行，不能误伤多工作区用法。 */
  const legalRoot = await call(routes, '/research-workbench/api/status?root=' + encodeURIComponent(ws), { headers: AUTH });
  check('status?root=已注册工作区 → 200', legalRoot.status === 200 && legalRoot.payload.ok === true, '实际 ' + legalRoot.status);

  const fsRoot = await call(routes, '/research-workbench/api/status?root=' + encodeURIComponent('/'), { headers: AUTH });
  check('status?root=/（文件系统根）→ 400', fsRoot.status === 400, '实际 ' + fsRoot.status);

  /* 兼容历史项目名：全角括号/全角竖线（真实工作区存在此类目录，不能误杀）。 */
  mkdirSync(join(ws, 'research', '兼容测试（全角）｜项目'), { recursive: true });
  const legacyName = await call(routes, '/research-workbench/api/files?dir=' + encodeURIComponent('兼容测试（全角）｜项目'), { headers: AUTH });
  check('历史项目名（全角括号/竖线）files → 200', legacyName.status === 200, '实际 ' + legacyName.status);

  const revealOutside = await call(routes, '/research-workbench/api/reveal', {
    method: 'POST', headers: JSON_HDR, body: { path: '/etc/passwd' },
  });
  check('reveal 工作区外路径 → 403', revealOutside.status === 403, '实际 ' + revealOutside.status);

  /* ---- FDE 路由：同一 guard + 同一路径安全栈 ---- */
  const fdeNoCookie = await call(routes, '/research-workbench/api/fde/meta', { headers: {} });
  check('fde/meta 无 cookie → 401', fdeNoCookie.status === 401, '实际 ' + fdeNoCookie.status);

  const fdeMeta = await call(routes, '/research-workbench/api/fde/meta', { headers: AUTH });
  check('fde/meta 合法 cookie → 200 且 8 阶段', fdeMeta.status === 200 && fdeMeta.payload.ok === true && fdeMeta.payload.meta.stages.length === 8, JSON.stringify(fdeMeta.payload).slice(0, 120));

  const fdeBoard = await call(routes, '/research-workbench/api/fde/board', { headers: AUTH });
  check('fde/board 合法 cookie → 200', fdeBoard.status === 200 && fdeBoard.payload.ok === true && !!fdeBoard.payload.board, '实际 ' + fdeBoard.status);

  const fdeGetWrite = await call(routes, '/research-workbench/api/fde/engagement', { headers: AUTH });
  check('GET /fde/engagement → 405', fdeGetWrite.status === 405, '实际 ' + fdeGetWrite.status);

  const fdeBadType = await call(routes, '/research-workbench/api/fde/engagement', {
    method: 'POST', headers: { 'content-type': 'text/plain', ...AUTH }, body: { action: 'create', patch: { name: 'x' } },
  });
  check('POST /fde/engagement 非 JSON → 415', fdeBadType.status === 415, '实际 ' + fdeBadType.status);

  const fdeTraversal = await call(routes, '/research-workbench/api/fde/engagement', {
    method: 'POST', headers: JSON_HDR, body: { action: 'create', patch: { name: '穿越', dir: '../../etc' } },
  });
  check('fde/engagement dir=../../etc → 400', fdeTraversal.status === 400, '实际 ' + fdeTraversal.status + ' ' + JSON.stringify(fdeTraversal.payload).slice(0, 100));

  const fdeMissing = await call(routes, '/research-workbench/api/fde/handoff', {
    method: 'POST', headers: JSON_HDR, body: { target: 'engagement', id: 'eng_000000' },
  });
  check('fde/handoff 不存在的客户 → 404', fdeMissing.status === 404, '实际 ' + fdeMissing.status);

  /* ---- FDE 资料库 2 条路由（v1.3，spec §19.4）：同一 guard；业务降级 HTTP 恒 200 ----
   * 只验证鉴权/方法/内容类型，不触发刷新（避免在测试中访问 GitHub）；GET feed 读缓存不联网。 */
  const libNoCookie = await call(routes, '/research-workbench/api/fde/library/feed', { headers: {} });
  check('fde/library/feed 无 cookie → 401', libNoCookie.status === 401, '实际 ' + libNoCookie.status);
  const libFeed = await call(routes, '/research-workbench/api/fde/library/feed', { headers: AUTH });
  check('fde/library/feed 合法 cookie → 200（无缓存 feed:null 或 catalog 缺失 UNAVAILABLE）',
    libFeed.status === 200 && (libFeed.payload.ok === true ? (libFeed.payload.feed === null && libFeed.payload.stale === true) : libFeed.payload.code === 'UNAVAILABLE'),
    libFeed.status + ' ' + JSON.stringify(libFeed.payload).slice(0, 140));
  const libGetWrite = await call(routes, '/research-workbench/api/fde/library/refresh', { headers: AUTH });
  check('GET /fde/library/refresh → 405', libGetWrite.status === 405, '实际 ' + libGetWrite.status);
  const libBadType = await call(routes, '/research-workbench/api/fde/library/refresh', {
    method: 'POST', headers: { 'content-type': 'text/plain', ...AUTH }, body: {},
  });
  check('POST /fde/library/refresh 非 JSON → 415', libBadType.status === 415, '实际 ' + libBadType.status);

  /* ---- 招采雷达 7 条路由：同一 guard（无服务时也要 200 + available:false，不 500） ---- */
  const bidNoCookie = await call(routes, '/research-workbench/api/fde/bids/stats', { headers: {} });
  check('fde/bids/stats 无 cookie → 401', bidNoCookie.status === 401, '实际 ' + bidNoCookie.status);

  const bidStats = await call(routes, '/research-workbench/api/fde/bids/stats', { headers: AUTH });
  check('fde/bids/stats 服务缺失 → 200 + available:false', bidStats.status === 200 && bidStats.payload.ok === true && bidStats.payload.available === false,
    { status: bidStats.status, body: JSON.stringify(bidStats.payload).slice(0, 120) });

  const bidSearch = await call(routes, '/research-workbench/api/fde/bids/search?q=x', { headers: AUTH });
  check('fde/bids/search 服务缺失 → 200 + available:false', bidSearch.status === 200 && bidSearch.payload.available === false, bidSearch.status);

  const bidGetWrite = await call(routes, '/research-workbench/api/fde/bids/link', { headers: AUTH });
  check('GET /fde/bids/link → 405', bidGetWrite.status === 405, '实际 ' + bidGetWrite.status);

  const bidBadType = await call(routes, '/research-workbench/api/fde/bids/link', {
    method: 'POST', headers: { 'content-type': 'text/plain', ...AUTH }, body: { engagementId: 'eng_000000', bidId: 'x' },
  });
  check('POST /fde/bids/link 非 JSON → 415', bidBadType.status === 415, '实际 ' + bidBadType.status);

  const bidTraversalDegrade = await call(routes, '/research-workbench/api/fde/bids/match?engagementId=' + encodeURIComponent('../../etc'), { headers: AUTH });
  check('fde/bids/match 服务缺失时优先降级（200 + available:false，不拼接路径）',
    bidTraversalDegrade.status === 200 && bidTraversalDegrade.payload.available === false, '实际 ' + bidTraversalDegrade.status);

  /* ---- 生财 FDE 情报 2 条路由：同一 guard；未授权属业务降级但 HTTP 恒 200（spec §18.5） ---- */
  const scysNoCookie = await call(routes, '/research-workbench/api/fde/scys/feed', { headers: {} });
  check('fde/scys/feed 无 cookie → 401', scysNoCookie.status === 401, '实际 ' + scysNoCookie.status);

  const scysFeed = await call(routes, '/research-workbench/api/fde/scys/feed', { headers: AUTH });
  check('fde/scys/feed 合法 cookie → 200（本机无缓存 → feed:null / stale:true）',
    scysFeed.status === 200 && scysFeed.payload.ok === true && scysFeed.payload.feed === null && scysFeed.payload.stale === true,
    scysFeed.status + ' ' + JSON.stringify(scysFeed.payload).slice(0, 140));

  const scysGetWrite = await call(routes, '/research-workbench/api/fde/scys/refresh', { headers: AUTH });
  check('GET /fde/scys/refresh → 405', scysGetWrite.status === 405, '实际 ' + scysGetWrite.status);

  const scysBadType = await call(routes, '/research-workbench/api/fde/scys/refresh', {
    method: 'POST', headers: { 'content-type': 'text/plain', ...AUTH }, body: {},
  });
  check('POST /fde/scys/refresh 非 JSON → 415', scysBadType.status === 415, '实际 ' + scysBadType.status);

  /* 未授权分支：把授权状态目录临时指向空目录（不联网），应 200 + code:UNAUTHORIZED 且不写缓存。 */
  {
    const prevStateDir = process.env.SCYS_MCP_STATE_DIR;
    process.env.SCYS_MCP_STATE_DIR = join(ws, 'no-scys-auth');
    try {
      const unauth = await call(routes, '/research-workbench/api/fde/scys/refresh', {
        method: 'POST', headers: JSON_HDR, body: {},
      });
      check('fde/scys/refresh 未授权 → HTTP 200 + code:UNAUTHORIZED（不联网）',
        unauth.status === 200 && unauth.payload.ok === false && unauth.payload.code === 'UNAUTHORIZED',
        unauth.status + ' ' + JSON.stringify(unauth.payload).slice(0, 140));
      const afterUnauth = await call(routes, '/research-workbench/api/fde/scys/feed', { headers: AUTH });
      check('未授权后 fde/scys/feed 仍 200（业务 ok:true / 无缓存，不 500）',
        afterUnauth.status === 200 && afterUnauth.payload.ok === true && afterUnauth.payload.feed === null,
        afterUnauth.status + ' ' + JSON.stringify(afterUnauth.payload).slice(0, 120));
    } finally {
      if (prevStateDir === undefined) delete process.env.SCYS_MCP_STATE_DIR;
      else process.env.SCYS_MCP_STATE_DIR = prevStateDir;
    }
  }

  /* ---- 生财三路授权（ADR 0004 D5）：第 37 条路由 /fde/scys/auth，GET 状态 / POST 保存·清除 ----
   * 只写临时工作区 <ws>/research/.fde/scys-auth.json；断言执行后清理。
   * 安全不变量：token 不出现在响应；链接中自动提取 token。 */
  {
    const AUTH_ROOT = ws;
    const TOKEN = 'test-token-abcdef123456';
    const authNoCookie = await call(routes, '/research-workbench/api/fde/scys/auth?root=' + encodeURIComponent(AUTH_ROOT), { headers: {} });
    check('fde/scys/auth 无 cookie → 401', authNoCookie.status === 401, '实际 ' + authNoCookie.status);

    const authStatus = await call(routes, '/research-workbench/api/fde/scys/auth?root=' + encodeURIComponent(AUTH_ROOT), { headers: AUTH });
    check('fde/scys/auth GET 合法 cookie → 200 + auth 状态形状',
      authStatus.status === 200 && authStatus.payload.ok === true && authStatus.payload.auth &&
      typeof authStatus.payload.auth.available === 'boolean' &&
      ['link', 'env', 'compat', 'none'].includes(authStatus.payload.auth.source) &&
      Object.prototype.hasOwnProperty.call(authStatus.payload.auth, 'expiresAt'),
      authStatus.status + ' ' + JSON.stringify(authStatus.payload).slice(0, 160));

    const authBadType = await call(routes, '/research-workbench/api/fde/scys/auth', {
      method: 'POST', headers: { 'content-type': 'text/plain', ...AUTH }, body: { root: AUTH_ROOT, token: TOKEN },
    });
    check('POST /fde/scys/auth 非 JSON → 415', authBadType.status === 415, '实际 ' + authBadType.status);

    const authNoToken = await call(routes, '/research-workbench/api/fde/scys/auth', {
      method: 'POST', headers: JSON_HDR, body: { root: AUTH_ROOT, url: 'https://mcp.scys.com/auth?code=' },
    });
    check('POST /fde/scys/auth 链接无 token → 200 + ok:false + code:INVALID（HTTP 恒 200）',
      authNoToken.status === 200 && authNoToken.payload.ok === false && authNoToken.payload.code === 'INVALID' &&
      !JSON.stringify(authNoToken.payload).includes('access_token='),
      authNoToken.status + ' ' + JSON.stringify(authNoToken.payload).slice(0, 160));

    const saveByUrl = await call(routes, '/research-workbench/api/fde/scys/auth', {
      method: 'POST', headers: JSON_HDR,
      body: { root: AUTH_ROOT, url: 'https://mcp.scys.com/auth?access_token=' + TOKEN },
    });
    check('POST /fde/scys/auth 从链接提取 access_token → 200 + source=link',
      saveByUrl.status === 200 && saveByUrl.payload.ok === true && saveByUrl.payload.auth.source === 'link',
      saveByUrl.status + ' ' + JSON.stringify(saveByUrl.payload).slice(0, 160));
    check('授权响应不回显 token（安全不变量）', !JSON.stringify(saveByUrl.payload).includes(TOKEN));
    check('授权文件落盘 <root>/research/.fde/scys-auth.json',
      existsSync(join(AUTH_ROOT, 'research', '.fde', 'scys-auth.json')));

    const authSaved = await call(routes, '/research-workbench/api/fde/scys/auth?root=' + encodeURIComponent(AUTH_ROOT), { headers: AUTH });
    check('保存后 GET 来源为 link 且 available=true',
      authSaved.status === 200 && authSaved.payload.auth.available === true && authSaved.payload.auth.source === 'link',
      JSON.stringify(authSaved.payload).slice(0, 160));

    const clear = await call(routes, '/research-workbench/api/fde/scys/auth', {
      method: 'POST', headers: JSON_HDR, body: { root: AUTH_ROOT, clear: true },
    });
    check('POST /fde/scys/auth {clear:true} → 200 + removed:true + 文件删除',
      clear.status === 200 && clear.payload.ok === true && clear.payload.removed === true &&
      !existsSync(join(AUTH_ROOT, 'research', '.fde', 'scys-auth.json')),
      clear.status + ' ' + JSON.stringify(clear.payload).slice(0, 160));
    check('清除后来源不再为 link（回落下一来源）',
      clear.payload.ok === true && clear.payload.auth.source !== 'link', JSON.stringify(clear.payload.auth));
    check('清除响应不回显 token', !JSON.stringify(clear.payload).includes(TOKEN));
  }
}

/* ================= 4. 招采雷达：服务可用时的路径安全 ================= */
const FAKE_BID_INTEL = {
  version: 1,
  dataMeta: () => ({ file: 'fake', mtime: 1, bytes: 1, records: 1, missing: false }),
  stats: () => ({ records: 1, missing: false, file: 'fake', bytes: 1, sources: [], years: {}, withWinner: 0, withBuyer: 0, withAmount: 0, dateRange: ['', ''] }),
  search: () => ({ total: 0, direct: 0, mentioned: 0, offset: 0, limit: 20, items: [], facets: {} }),
  timeline: () => ({ total: 0, byMonth: {} }),
  batches: () => ({ total: 0, clusters: [] }),
  report: () => '# fake',
  getRecord: () => null,
};
{
  const { routes } = makeCtx({ connection: CONNECTION, bidIntel: FAKE_BID_INTEL });
  const okStats = await call(routes, '/research-workbench/api/fde/bids/stats', { headers: AUTH });
  check('fde/bids/stats 服务可用 → 200 + available:true', okStats.status === 200 && okStats.payload.available === true, '实际 ' + okStats.status);

  const trav = await call(routes, '/research-workbench/api/fde/bids/match?engagementId=' + encodeURIComponent('../../etc'), { headers: AUTH });
  check('fde/bids/match id 穿越 → 404（不拼路径）', trav.status === 404, '实际 ' + trav.status);

  const travLink = await call(routes, '/research-workbench/api/fde/bids/link', {
    method: 'POST', headers: JSON_HDR, body: { engagementId: '../../etc', bidId: 'fake:1' },
  });
  check('fde/bids/link engagementId 穿越 → 404', travLink.status === 404, '实际 ' + travLink.status);
}

/* ================= 2. 无 connection（fallback fence） ================= */
{
  const { routes, warns } = makeCtx({ connection: undefined });
  const badHost = await call(routes, '/research-workbench/api/status', { headers: { host: 'evil.example' } });
  check('fallback：伪造 Host → 403', badHost.status === 403, '实际 ' + badHost.status);

  const badOrigin = await call(routes, '/research-workbench/api/status', {
    headers: { host: '127.0.0.1:50922', origin: 'https://evil.example' },
  });
  check('fallback：伪造跨站 Origin → 403', badOrigin.status === 403, '实际 ' + badOrigin.status);

  const crossSite = await call(routes, '/research-workbench/api/status', {
    headers: { host: '127.0.0.1:50922', 'sec-fetch-site': 'cross-site' },
  });
  check('fallback：sec-fetch-site cross-site → 403', crossSite.status === 403, '实际 ' + crossSite.status);

  const fdeBadHost = await call(routes, '/research-workbench/api/fde/meta', { headers: { host: 'evil.example' } });
  check('fallback：fde/meta 伪造 Host → 403', fdeBadHost.status === 403, '实际 ' + fdeBadHost.status);

  const local = await call(routes, '/research-workbench/api/status', { headers: { host: '127.0.0.1:50922' } });
  check('fallback：本机 Host → 200', local.status === 200, '实际 ' + local.status);
  check('fallback：只 warn 一次且文案含 connection', warns.length === 1 && warns[0].includes('connection'), JSON.stringify(warns).slice(0, 160));
}

/* ================= 3. registry 可用但为空 / registry 不可用 ================= */
{
  const { routes } = makeCtx({ connection: CONNECTION, registryList: [] });
  const emptyRoot = await call(routes, '/research-workbench/api/status?root=' + encodeURIComponent(ws), { headers: AUTH });
  check('registry 列表为空时显式 root → 400（fail-closed）', emptyRoot.status === 400, '实际 ' + emptyRoot.status);
}
{
  /* registry 完全不可用：退回"存在且非文件系统根"的最小校验，合法根放行。 */
  const { routes } = makeCtx({ connection: CONNECTION, noRegistry: true });
  const noRegRoot = await call(routes, '/research-workbench/api/status?root=' + encodeURIComponent(ws), { headers: AUTH });
  check('无 workspaceRegistry 时显式 root（存在且非根）→ 200', noRegRoot.status === 200, '实际 ' + noRegRoot.status);
}

/* ================= 4. 工具路径参数仍可用（不回归） ================= */
{
  const { routes } = makeCtx({ connection: CONNECTION });
  const status = await call(routes, '/research-workbench/api/projects', { headers: AUTH });
  check('合法 /api/projects → 200', status.status === 200 && Array.isArray(status.payload.projects), '实际 ' + status.status);
}

console.log('\n=== 通过 ' + ok.length + ' 项 ===');
if (fail.length) {
  console.log('\n=== 失败 ' + fail.length + ' 项 ===');
  for (const f of fail) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('路由安全守卫测试全部通过。');
