/**
 * FDE 工作站（dsh-fde）· 宿主半
 *
 * 能力
 * - agent 工具：rw_status / rw_scaffold / rw_export_pdf / rw_qa_pdf / rw_method
 * - HTTP 路由 /research-workbench/api/*
 *     status · projects · methods · files · scaffold · handoff · adopt
 * - 客户端面板「调研工作台」：立项 / 继续调研 / 按需导出 / 质检，均在面板内完成
 * - 系统提示词注入：七步流程、证据分级、md 优先约定
 *
 * 约束：本插件位于 profile 的 link: 依赖里，运行时无法 import @deepseek-ai/*，
 * 一律通过 ctx.get(...) 取服务。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve, sep } from 'node:path';
import * as subproc from './src/host/subprocess.js';
import * as store from './src/host/store.js';
import * as paths from './src/host/paths.js';
import * as fdeApi from './src/host/fde-api.js';
import * as fdeSchema from './src/host/fde-schema.js';
import * as fdeStore from './src/host/fde-store.js';
import * as fdeRules from './src/host/fde-rules.js';
import * as fdeBids from './src/host/fde-bids.js';
import * as fdeScys from './src/host/fde-scys.js';
import * as fdeLibrary from './src/host/fde-library.js';
import * as fdeCalc from './src/host/fde-calc.js';

const name = 'research-workbench';
/* webServer 不是必需服务（ADR 0004 / 审查 F-03）：非 Web 组合也要能激活工具/技能/提示词。
 * 路由在 webServer 就绪后条件挂载；拿不到就跳过路由、其余能力照常工作。 */
const inject = ['tools', 'systemPrompt', 'workspaceRegistry', 'sessionController'];

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, 'scripts');
const METHODS = join(HERE, 'methods');
const REFERENCE = join(HERE, 'reference');
const TEMPLATES = join(HERE, 'templates');
const ARCHIVE_NAME = '00-项目档案.md';

const text = (t) => [{ type: 'text', text: t }];

function json(res, status, payload, headers) {
  try {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    /* Phase 3 · 审查 F-13：私有状态与鉴权结果一律不缓存、不嗅探（对齐官方 /api 与 open-in-app 路由）。 */
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(payload));
  } catch { /* 已发送 */ }
}

function qs(req) {
  const u = new URL(req.url || '/', 'http://localhost');
  const o = {};
  for (const [k, v] of u.searchParams) o[k] = v;
  return o;
}

function readJsonBody(req, maxBytes = 400000) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolveBody({}); return; }
      try { resolveBody(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}


function svcOfImpl(ctx, n) {
  try { if (ctx[n] && typeof ctx[n] === 'object') return ctx[n]; } catch { /* 忽略 */ }
  try { return typeof ctx.get === 'function' ? ctx.get(n) : undefined; } catch { return undefined; }
}

const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[?::1\]?)$/i;

/** 从 Host 头取 hostname（IPv6 保留方括号，去掉端口）。 */
function hostnameOf(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) { const end = raw.indexOf(']'); return end === -1 ? raw : raw.slice(0, end + 1); }
  return raw.split(':')[0];
}

/**
 * 没有 connection 服务时的最小来源护栏（非 Web 组合 / 测试环境）：
 * Host 必须是本机回环（缺省视为本机）；带 Origin 时其 host 必须与 Host 一致且为回环；
 * sec-fetch-site: cross-site 一律拒绝。
 * @returns {0|403} 0 表示放行
 */
function fallbackFence(req) {
  const h = (req && req.headers) || {};
  const hostRaw = String(h.host || '').trim().toLowerCase();
  const hostName = hostnameOf(hostRaw);
  if (hostRaw && !LOCAL_HOST_RE.test(hostName)) return 403;
  if (String(h['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403;
  const origin = String(h.origin || '').trim();
  if (origin) {
    try {
      const o = new URL(origin);
      if (!LOCAL_HOST_RE.test(o.hostname.toLowerCase())) return 403;
      if (hostRaw && o.host.toLowerCase() !== hostRaw) return 403;
    } catch { return 403; }
  }
  return 0;
}

/**
 * 路由统一守卫（语义见 plugin-audit/batchA-spec.md 第 1 节）：
 * 方法白名单 → 鉴权/来源（connection.admit，缺省走 Host/Origin fence）→ POST JSON 内容类型。
 * @returns {boolean} true 表示继续执行 handler
 */
function makeGuard(ctx) {
  let warned = false;
  return function guard(req, res, opts = {}) {
    const methods = Array.isArray(opts.methods) && opts.methods.length ? opts.methods : ['GET'];
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (!methods.includes(method)) {
      json(res, 405, { ok: false, reason: 'Method Not Allowed' }, { Allow: methods.join(', ') });
      return false;
    }

    const conn = svcOfImpl(ctx, 'connection');
    if (conn && typeof conn.admit === 'function') {
      let admission;
      try { admission = conn.admit(req); } catch { json(res, 500, { ok: false, reason: '鉴权检查失败' }); return false; }
      if (admission && typeof admission === 'object' && 'rejection' in admission) {
        const code = admission.rejection === 401 ? 401 : 403;
        json(res, code, { ok: false, reason: code === 401 ? '未授权：需要浏览器会话' : '来源不可信' });
        return false;
      }
    } else {
      if (!warned) {
        warned = true;
        try { ctx.logger?.warn?.('research-workbench: 未挂载 connection，路由处于无鉴权 fallback（仅 Host/Origin fence）'); } catch { /* 忽略 */ }
      }
      if (fallbackFence(req)) { json(res, 403, { ok: false, reason: '来源不可信' }); return false; }
    }

    if (opts.json && method === 'POST') {
      const ct = String(((req && req.headers) || {})['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') {
        json(res, 415, { ok: false, reason: 'Content-Type 必须为 application/json' });
        return false;
      }
    }
    return true;
  };
}

/**
 * 兜底通道：直接用系统命令在文件管理器中定位 / 打开。
 * macOS `open -R` 选中文件、`open` 交给默认应用；Windows 用 explorer；Linux 用 xdg-open。
 */
async function revealBySystem(ctx, abs, mode, cwd) {
  const p = process.platform;
  let cmd;
  let args;
  if (p === 'darwin') { cmd = 'open'; args = mode === 'reveal' ? ['-R', abs] : [abs]; }
  else if (p === 'win32') { cmd = 'explorer'; args = mode === 'reveal' ? ['/select,' + abs] : [abs]; }
  else { cmd = 'xdg-open'; args = [mode === 'reveal' ? dirname(abs) : abs]; }
  const how = cmd + ' ' + args.join(' ');
  /* Phase 3 · 审查 F-04：优先官方 ctx.subprocess（脱敏环境/进程范围由 provider 管理）；
   * 不可用时由 subproc.run 回退 execFile（同样脱敏 env + 显式 cwd=工作区根）。 */
  const r = await subproc.run(ctx, cmd, args, { cwd, timeoutMs: 15000, maxBytes: 1024 * 1024 });
  return { ok: r.ok, how, runner: r.how, reason: r.ok ? '' : (r.stderr || r.reason || '调用系统命令失败'), stderr: r.stderr };
}

let lastRootHow = '';

/**
 * 解析工作区根：显式传入必须过 paths.safeRoot（注册工作区白名单 + 存在性校验），
 * 未传时沿用 store.detectRoot 的自动探测链。
 * @throws {paths.PathError} 显式 root 非法
 */
function workspaceRoot(ctx, argRoot) {
  const requested = String(argRoot ?? '').trim();
  if (requested) {
    const root = paths.safeRoot(ctx, requested);
    lastRootHow = '参数指定（已校验）';
    return root;
  }
  const { root, how } = store.detectRoot((n) => svcOfImpl(ctx, n));
  lastRootHow = how;
  return root;
}

/** 路由级：解析工作区根，非法时回 400 并返回 null。 */
function rootOr400(ctx, res, argRoot) {
  try { return workspaceRoot(ctx, argRoot); } catch (e) {
    json(res, 400, { ok: false, reason: '非法工作区根：' + String((e && e.message) || e) });
    return null;
  }
}

function projectRoot(root, dir) {
  return paths.safeProjectPath(root, dir).path;
}

/** 路由级：解析项目目录，非法时回 400 并返回 null。 */
function projectOr400(root, res, dir, forceBase) {
  try { return forceBase ? paths.safeProjectPath(root, dir, forceBase).path : projectRoot(root, dir); } catch (e) {
    json(res, 400, { ok: false, reason: '非法项目目录：' + String((e && e.message) || e) });
    return null;
  }
}

/** 校验项目内相对文件路径（handoff 的 md/pdf），越界回 400 并返回 null。 */
function relFileOr400(proj, res, rel) {
  const s = String(rel ?? '').trim();
  try {
    if (!s || s.includes('\0') || s.includes('\\')) throw new paths.PathError('非法文件路径');
    const base = resolve(proj);
    const abs = resolve(proj, s);
    if (abs === base || !abs.startsWith(base + sep)) throw new paths.PathError('文件路径越界');
    return abs;
  } catch (e) {
    json(res, 400, { ok: false, reason: '非法文件路径：' + String((e && e.message) || e) });
    return null;
  }
}

function slugify(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || '未命名项目';
}

/* ---------------- handoff：工作区选择（修复多工作区误派发） ---------------- */

/** 从工作区记录里取路径（与 store.pickPath 同口径）。 */
function workspacePathOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  for (const k of ['cwd', 'path', 'root', 'dir', 'directory', 'workspacePath', 'rootPath']) {
    const x = v[k];
    if (typeof x === 'string' && x) return x;
    if (x && typeof x.path === 'string' && x.path) return x.path;
    if (x && typeof x.root === 'string' && x.root) return x.root;
  }
  return '';
}

function workspaceIdOf(v) {
  if (!v || typeof v !== 'object') return '';
  const direct = v.id || v.workspaceId;
  if (typeof direct === 'string' && direct) return direct;
  if (v.workspace && typeof v.workspace.id === 'string') return v.workspace.id;
  if (v.session && typeof v.session.workspaceId === 'string') return v.session.workspaceId;
  return '';
}

function listWorkspaces(ctx) {
  const reg = svcOfImpl(ctx, 'workspaceRegistry');
  if (!reg) return [];
  for (const m of ['list', 'all', 'workspaces']) {
    try {
      const v = typeof reg[m] === 'function' ? reg[m]() : undefined;
      const arr = Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : null);
      if (arr) return arr.filter(Boolean);
    } catch { /* 下一个 */ }
  }
  return [];
}

function normPath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  try { return realpathSync(resolve(raw)); } catch { return resolve(raw); }
}

/**
 * 选定 handoff 目标工作区（修复现有缺陷：不能盲选 updatedAt 最新）。
 * 优先级：显式指定 → 当前工作区（且与客户根不冲突）→ 与工作区根匹配 → 当前会话 → updatedAt 最新。
 * @returns {{id:string, how:string}}
 */
function chooseWorkspace(ctx, opts = {}) {
  const explicit = String(opts.workspaceId || '').trim();
  if (explicit) return { id: explicit, how: '显式指定' };
  const rootNorm = normPath(opts.root);
  const underRoot = (p) => {
    if (!rootNorm || !p) return false;
    const np = normPath(p);
    return np === rootNorm || rootNorm.startsWith(np + sep);
  };
  const reg = svcOfImpl(ctx, 'workspaceRegistry');
  /* 1) 当前工作区：有当前工作区且它确实是客户根所在的（或未知）工作区 */
  if (reg) {
    for (const m of ['current', 'getCurrent', 'active']) {
      try {
        const w = typeof reg[m] === 'function' ? reg[m]() : undefined;
        if (!w) continue;
        const id = workspaceIdOf(w);
        const p = workspacePathOf(w);
        if (id && (!rootNorm || !p || underRoot(p))) return { id, how: 'workspaceRegistry.' + m + '()' };
      } catch { /* 下一个 */ }
    }
  }
  const list = listWorkspaces(ctx);
  /* 2) 与客户根匹配的工作区（显式传了 root 时最准） */
  if (rootNorm) {
    const hit = list.filter((w) => w && workspaceIdOf(w)).find((w) => {
      const p = workspacePathOf(w);
      return p && underRoot(p);
    });
    if (hit) return { id: workspaceIdOf(hit), how: '匹配工作区根' };
  }
  /* 3) 当前会话所在工作区 */
  try {
    const sc = svcOfImpl(ctx, 'sessionController');
    const cur = sc && typeof sc.current === 'function' ? sc.current() : undefined;
    const id = workspaceIdOf(cur);
    if (id) return { id, how: '当前会话' };
  } catch { /* 忽略 */ }
  /* 4) 最后才退回 updatedAt 最新（并如实标注依据） */
  let best = null;
  for (const w of list) {
    const id = workspaceIdOf(w);
    if (!id) continue;
    const t = Date.parse(w.updatedAt || '') || 0;
    if (!best || t > best.t) best = { id, t };
  }
  if (best) return { id: best.id, how: 'updatedAt 最新' };
  return { id: '', how: '默认工作区' };
}

/**
 * 创建会话并下发任务，返回 sessionId。
 * @param {{root?:string, workspaceId?:string}} [opts]
 */
async function handoff(ctx, promptText, opts = {}) {
  const sc = svcOfImpl(ctx, 'sessionController');
  if (!sc || typeof sc.create !== 'function' || typeof sc.prompt !== 'function') {
    return { ok: false, reason: '本部署未挂载 sessionController，无法自动开会话——请在对话框里粘贴任务继续。', prompt: promptText };
  }
  const choice = chooseWorkspace(ctx, opts);
  const target = choice.id ? { workspaceId: choice.id } : {};
  try {
    const created = await sc.create(target);
    const sessionId = created && created.sessionId;
    if (!sessionId) return { ok: false, reason: '会话创建失败：未返回 sessionId', prompt: promptText };
    await sc.prompt({
      requestId: `rw-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
    }, new AbortController().signal);
    return { ok: true, sessionId, workspace: choice.id || '', workspaceHow: choice.how || '' };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e), prompt: promptText };
  }
}

/* ============================ 插件主体 ============================ */

export function apply(ctx) {
  const log = (m) => { try { ctx.logger?.info?.('research-workbench: ' + m); } catch { /* 忽略 */ } };
  const guard = makeGuard(ctx);
  /* FDE 依赖：路由与工具共用 fde-api；handoff 走修复后的工作区选择。
   * skillsState 由 registerSkills 填充，health 与 meta 会读。 */
  const skillsState = { available: false, registered: 0, error: '' };
  const fdeDeps = { handoff: (text, opts) => handoff(ctx, text, opts), skillsAvailable: false };
  /* 招采雷达只读服务（bid-intel 提供 ctx.provide('bidIntel')）：每次调用按本插件 ctx 懒解析并
   * 显式传给业务层（多实例/测试互不影响）；服务缺失 → bids 功能降级 available:false，不报错。 */
  const bidSvc = () => fdeBids.resolveBidService(ctx);

  /* ---------------- HTTP 路由 ---------------- */
  const registerRoutes = () => {
    const ws = svcOfImpl(ctx, 'webServer');
    if (!ws || typeof ws.register !== 'function') { log('webServer 不可用，面板接口未注册'); return; }
    const disposers = [];
    /* 每条路由统一先过 guard（方法白名单 → 鉴权/来源 → POST JSON 类型）。
     * 方法表按面板现有调用：只读 GET，写操作 POST。 */
    const add = (path, opts, handler) => disposers.push(ws.register({
      kind: 'exact',
      path,
      handler: (req, res) => (guard(req, res, opts) ? handler(req, res) : undefined),
    }));

    add('/research-workbench/api/status', { methods: ['GET'] }, (req, res) => {
      const root = rootOr400(ctx, res, qs(req).root);
      if (!root) return;
      const projects = store.scanProjects(join(root, 'research'));
      const sc = svcOfImpl(ctx, 'sessionController');
      const all = store.scanProjects(join(root, 'research'));
      const materials = all.filter((x) => x.kind === 'material').length;
      json(res, 200, {
        ok: true,
        root,
        how: lastRootHow,
        materials,
        loose: store.scanLooseMaterials(join(root, 'research')).length,
        scripts: existsSync(join(SCRIPTS, 'make-pdf.sh')),
        hasSession: !!(sc && typeof sc.create === 'function'),
        methods: existsSync(METHODS) ? readdirSync(METHODS).length : 0,
        reference: existsSync(REFERENCE) ? readdirSync(REFERENCE).length : 0,
        projects: projects.filter((x) => x.kind !== 'material').length,
      });
    });

    add('/research-workbench/api/projects', { methods: ['GET'] }, (req, res) => {
      const root = rootOr400(ctx, res, qs(req).root);
      if (!root) return;
      json(res, 200, { ok: true, root, projects: store.scanProjects(join(root, 'research')) });
    });

    add('/research-workbench/api/methods', { methods: ['GET'] }, (req, res) => {
      const list = [];
      for (const [dir, kind] of [[METHODS, 'method'], [REFERENCE, 'reference'], [TEMPLATES, 'template']]) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) if (f.endsWith('.md')) list.push({ kind, name: f });
      }
      const key = qs(req).name;
      if (key) {
        const hit = list.find((i) => i.name.includes(key));
        if (!hit) { json(res, 404, { ok: false, reason: `未找到含「${key}」的方法文件` }); return; }
        const dir = hit.kind === 'method' ? METHODS : hit.kind === 'reference' ? REFERENCE : TEMPLATES;
        json(res, 200, { ok: true, file: hit.name, body: readFileSync(join(dir, hit.name), 'utf8') });
        return;
      }
      json(res, 200, { ok: true, items: list });
    });

    add('/research-workbench/api/files', { methods: ['GET'] }, (req, res) => {
      const root = rootOr400(ctx, res, qs(req).root);
      if (!root) return;
      const dir = qs(req).dir;
      if (!dir) { json(res, 400, { ok: false, reason: '缺少 dir' }); return; }
      const proj = projectOr400(root, res, dir);
      if (!proj) return;
      if (!existsSync(proj)) { json(res, 404, { ok: false, reason: '项目不存在：' + dir }); return; }
      const _files = store.collectFiles(proj);
      json(res, 200, { ok: true, dir, path: proj, files: _files });
    });

    add('/research-workbench/api/scaffold', { methods: ['POST'], json: true }, async (req, res) => {
      let body = {};
      try { body = await readJsonBody(req); } catch (e) { json(res, 400, { ok: false, reason: String(e.message) }); return; }
      const company = String(body.company || '').trim();
      if (!company) { json(res, 400, { ok: false, reason: '请填写公司全称' }); return; }
      const root = rootOr400(ctx, res, body.root);
      if (!root) return;
      let dirName;
      try { dirName = paths.safeDirName(`${slugify(company)}-${fdeStore.localDateStr().replace(/-/g, '')}`); }
      catch (e) { json(res, 400, { ok: false, reason: '非法项目目录：' + String((e && e.message) || e) }); return; }
      const proj = join(root, 'research', dirName);
      const archive = join(proj, '00-项目档案.md');
      const existed = existsSync(archive);
      if (!existed) {
        for (const d of ['raw', 'research', 'meeting/exports', 'proposal/exports', 'internal']) {
          mkdirSync(join(proj, d), { recursive: true });
        }
        writeFileSync(archive, store.renderArchive({
          company,
          person: body.person || '',
          role: body.role || '',
          purpose: body.purpose || '',
          when: body.when || '',
          where: body.where || '',
        }), 'utf8');
      }
      json(res, 200, { ok: true, existed, dir: dirName, path: proj });
    });

    /* 交给会话：启动调研 / 继续某阶段 / 导出 / 质检 */
    add('/research-workbench/api/handoff', { methods: ['POST'], json: true }, async (req, res) => {
      let body = {};
      try { body = await readJsonBody(req); } catch (e) { json(res, 400, { ok: false, reason: String(e.message) }); return; }
      const root = rootOr400(ctx, res, body.root);
      if (!root) return;
      const action = String(body.action || 'start');
      const dir = String(body.dir || '');
      let proj = '';
      if (dir) { proj = projectOr400(root, res, dir); if (!proj) return; }
      const rel = dir ? `research/${dir}` : 'research/<新项目>';

      let promptText = '';
      if (action === 'start') {
        const company = String(body.company || '').trim();
        if (!company) { json(res, 400, { ok: false, reason: '请填写公司全称' }); return; }
        promptText = [
          '【调研工作台 · 启动调研】',
          `目标公司：${company}`,
          body.person ? `见面对象：${body.person}${body.role ? '（' + body.role + '）' : ''}` : '',
          body.purpose ? `见面性质与目标：${body.purpose}` : '',
          (body.when || body.where) ? `时间地点：${[body.when, body.where].filter(Boolean).join(' · ')}` : '',
          '',
          `项目目录：${rel}（若尚未建立，先用 rw_scaffold 立项）`,
          '',
          '请严格按调研工作台七步流程执行：',
          '1) 先用 `rw_method` 读取「流程」「核查」「KPI」「合作地图」「数据源」「雷区」等方法文件；',
          '2) 侦察与主体锁定：**地址锚定 + 三链验证**（自述链/上级链/排除链，且排除链要核验全部分页），三链不全则降级为「待现场确认」并准备两种情形；',
          '3) 抓取：用 bash 的 curl（`scripts/grab.py`）取原文，PDF 用 `pdftotext -layout`；不要用 web_fetch；',
          '4) 事实核查：全部事实按 A/B/C 分级，C 级不得作为事实陈述，单列未证实清单；数字自检（占比重算、分项求和、候选人≠中标人）；',
          '5) KPI 与痛点假设：用对方公开动作（上级意见、一把手讲话、招聘、采购）反推，每条标注置信度+依据+可提问验证的问法；',
          '6) 会面材料：Brief（现场用）+ 合作地图（含"我们不做什么"）+ 研判底稿（完整版），**全部写 md**；',
          '7) 仅在需要递交/打印时才用 `rw_export_pdf` 导出到 exports/，并用 `rw_qa_pdf` 自检。',
        ].filter(Boolean).join('\n');
      } else if (action === 'stage') {
        if (!proj) { json(res, 400, { ok: false, reason: '缺少 dir' }); return; }
        if (!existsSync(proj)) { json(res, 404, { ok: false, reason: '项目不存在：' + dir }); return; }
        const stage = String(body.stage || '');
        const stageMap = {
          subject: '侦察与主体锁定（地址锚定 + 三链验证）→ research/主体锁定与归属核对.md',
          crawl: '信息抓取（curl/grab.py，原文落盘到 raw/）',
          factcheck: '事实核查（A/B/C 分级 + 数字自检 + 未证实清单）→ research/事实核查清单.md',
          kpi: 'KPI 与痛点假设（含置信度与验证问法）→ research/KPI与痛点假设.md',
          meeting: '会面材料（Brief + 合作地图 + 研判底稿，全部 md）→ meeting/',
          proposal: '正式方案（md 为主，需要时再导出）→ proposal/',
        };
        if (!stageMap[stage]) { json(res, 400, { ok: false, reason: '未知阶段：' + stage }); return; }
        promptText = [
          '【调研工作台 · 继续调研】',
          `项目：${dir}`,
          `项目目录：${rel}`,
          `本次阶段：${stage}`,
          '',
          `请继续完成该项目的这一阶段：${stageMap[stage]}`,
          '',
          `要求：先读 \`${rel}/00-项目档案.md\` 了解已有输入与进展；沿用已确认的事实与证据分级；产出用 md 写入对应目录；完成后更新项目档案的进展看板。`,
        ].join('\n');
      } else if (action === 'export') {
        const md = String(body.md || '');
        if (!proj || !md) { json(res, 400, { ok: false, reason: '缺少 dir 或 md' }); return; }
        const mdAbs = relFileOr400(proj, res, md);
        if (!mdAbs) return;
        if (!existsSync(mdAbs)) { json(res, 404, { ok: false, reason: 'md 不存在：' + md }); return; }
        promptText = [
          '【调研工作台 · 按需导出】',
          `项目：${dir}`,
          `待导出文件：${rel}/${md}`,
          '',
          '请调用 `rw_export_pdf` 把上述 md 导出为 PDF（默认输出到同级 exports/），然后用 `rw_qa_pdf` 检查版面：',
          '- **致命问题必须为 0**（表头/标签被逐字断开）；',
          '- 缺字必须为「否」；',
          '- 末行残字 1–2 字属 CJK 窄列固有，可接受；',
          '- 若出现致命问题，先修 md（优先改文案：缩短长单元格、拆成短句），再重新导出。',
          '',
          '完成后回报 PDF 路径与自检结果，并提醒用户该 PDF 会随 md 变更而过期。',
        ].join('\n');
      } else if (action === 'qa') {
        const pdf = String(body.pdf || '');
        if (!proj || !pdf) { json(res, 400, { ok: false, reason: '缺少 dir 或 pdf' }); return; }
        if (!relFileOr400(proj, res, pdf)) return;
        promptText = [
          '【调研工作台 · PDF 质检】',
          `待检查文件：${rel}/${pdf}`,
          '',
          '请调用 `rw_qa_pdf` 检查版面质量，并说明：致命问题数、缺字与否、末行残字情况；若有致命问题，给出 md 侧的修改建议。',
        ].join('\n');
      } else {
        json(res, 400, { ok: false, reason: '未知 action：' + action });
        return;
      }

      const r = await handoff(ctx, promptText);
      if (!r.ok) { json(res, 200, { ok: false, reason: r.reason, promptText }); return; }
      json(res, 200, { ok: true, sessionId: r.sessionId, bytes: promptText.length });
    });

    /* 素材目录：列表（含散落文件） */
    add('/research-workbench/api/materials', { methods: ['GET'] }, (req, res) => {
      const root = rootOr400(ctx, res, qs(req).root);
      if (!root) return;
      const base = join(root, 'research');
      const all = store.scanProjects(base);
      const materials = all.filter((x) => x.kind === 'material');
      const loose = store.scanLooseMaterials(base);
      json(res, 200, { ok: true, root: base, materials, loose });
    });

    /* 素材目录详情（文件清单） */
    add('/research-workbench/api/material-files', { methods: ['GET'] }, (req, res) => {
      const root = rootOr400(ctx, res, qs(req).root);
      if (!root) return;
      const dir = qs(req).dir;
      if (!dir) { json(res, 400, { ok: false, reason: '缺少 dir' }); return; }
      const p = projectOr400(root, res, dir, 'research');
      if (!p) return;
      if (!existsSync(p)) { json(res, 404, { ok: false, reason: '目录不存在：' + dir }); return; }
      json(res, 200, { ok: true, dir, files: store.collectFiles(p) });
    });

    /* 上传文件（客户端以 base64 提交，JSON 通道） */
    add('/research-workbench/api/upload', { methods: ['POST'], json: true }, async (req, res) => {
      let body = {};
      try { body = await readJsonBody(req, 300 * 1024 * 1024); } catch (e) { json(res, 400, { ok: false, reason: String(e.message) }); return; }
      const dir = String(body.dir || '').trim();
      const items = Array.isArray(body.files) ? body.files : (body.name ? [body] : []);
      if (!items.length) { json(res, 400, { ok: false, reason: '没有要上传的文件' }); return; }
      if (!dir) { json(res, 400, { ok: false, reason: '请先选择项目' }); return; }

      const root = rootOr400(ctx, res, body.root);
      if (!root) return;
      const proj = projectOr400(root, res, dir);
      if (!proj) return;
      if (!existsSync(proj)) { json(res, 404, { ok: false, reason: '项目不存在：' + dir }); return; }

      const upDir = join(proj, 'raw', 'uploads');
      try { mkdirSync(upDir, { recursive: true }); } catch (e) { json(res, 500, { ok: false, reason: '无法创建上传目录：' + String(e.message) }); return; }

      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      const saved = [];
      const failed = [];
      for (const it of items) {
        const rawName = String(it.name || 'file');
        const safe = rawName.replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
        const target = join(upDir, `${stamp}-${safe}`);
        try {
          const data = String(it.data || '').replace(/^data:[^,]*,/, '');
          const buf = Buffer.from(data, 'base64');
          if (!buf.length) throw new Error('文件为空');
          writeFileSync(target, buf);
          saved.push({ name: safe, savedAs: `${stamp}-${safe}`, bytes: buf.length, rel: `raw/uploads/${stamp}-${safe}` });
        } catch (e) {
          failed.push({ name: safe, reason: String((e && e.message) || e) });
        }
      }
      json(res, 200, { ok: saved.length > 0, saved, failed, dir: upDir });
    });

    /* 把素材目录升级为项目（建档 + 生成素材索引） */
    add('/research-workbench/api/toproject', { methods: ['POST'], json: true }, async (req, res) => {
      let body = {};
      try { body = await readJsonBody(req); } catch (e) { json(res, 400, { ok: false, reason: String(e.message) }); return; }
      const root = rootOr400(ctx, res, body.root);
      if (!root) return;
      const dir = String(body.dir || '');
      if (!dir) { json(res, 400, { ok: false, reason: '缺少 dir' }); return; }
      const proj = projectOr400(root, res, dir, 'research');
      if (!proj) return;
      if (!existsSync(proj)) { json(res, 404, { ok: false, reason: '目录不存在：' + dir }); return; }

      const archive = join(proj, ARCHIVE_NAME);
      let created = false;
      if (!existsSync(archive)) {
        for (const d of ['raw', 'research', 'meeting/exports', 'proposal/exports', 'internal']) {
          mkdirSync(join(proj, d), { recursive: true });
        }
        writeFileSync(archive, store.renderArchive({ company: String(body.company || dir) }), 'utf8');
        created = true;
      }
      // 生成素材索引（若尚无）
      const idx = join(proj, 'internal', '素材索引.md');
      let indexed = false;
      if (!existsSync(idx)) {
        const files = store.collectFiles(proj);
        writeFileSync(idx, store.renderMaterialsIndex(dir, files), 'utf8');
        indexed = true;
      }
      json(res, 200, { ok: true, created, indexed, dir, path: proj });
    });

    /* 给历史目录补建档案 */
    add('/research-workbench/api/adopt', { methods: ['POST'], json: true }, async (req, res) => {
      let body = {};
      try { body = await readJsonBody(req); } catch (e) { json(res, 400, { ok: false, reason: String(e.message) }); return; }
      const root = rootOr400(ctx, res, body.root);
      if (!root) return;
      const dir = String(body.dir || '');
      if (!dir) { json(res, 400, { ok: false, reason: '缺少 dir' }); return; }
      const proj = projectOr400(root, res, dir);
      if (!proj) return;
      if (!existsSync(proj)) { json(res, 404, { ok: false, reason: '目录不存在：' + dir }); return; }
      const archive = join(proj, '00-项目档案.md');
      if (existsSync(archive)) { json(res, 200, { ok: true, existed: true, path: proj }); return; }
      for (const d of ['raw', 'research', 'meeting/exports', 'proposal/exports', 'internal']) {
        mkdirSync(join(proj, d), { recursive: true });
      }
      writeFileSync(archive, store.renderArchive({ company: dir }), 'utf8');
      json(res, 200, { ok: true, existed: false, path: proj });
    });

    /* 在 Finder / 资源管理器中定位（reveal）或打开（open）工作区内的路径 */
    add('/research-workbench/api/reveal', { methods: ['POST'], json: true }, async (req, res) => {
      let body = {};
      try { body = await readJsonBody(req); } catch (e) { json(res, 400, { ok: false, reason: String(e.message) }); return; }
      const raw = String(body.path || '').trim();
      const mode = String(body.mode || 'reveal') === 'open' ? 'open' : 'reveal';
      if (!raw) { json(res, 400, { ok: false, reason: '缺少 path' }); return; }
      const root = rootOr400(ctx, res, body.root);
      if (!root) return;
      const abs = resolve(raw);
      let rootAbs = resolve(root);
      try { if (existsSync(rootAbs)) rootAbs = realpathSync(rootAbs); } catch { /* 保留字面值 */ }
      let checkAbs = abs;
      try { if (existsSync(abs)) checkAbs = realpathSync(abs); } catch { /* 保留字面值 */ }
      if (checkAbs !== rootAbs && !checkAbs.startsWith(rootAbs + sep)) {
        json(res, 403, { ok: false, reason: '只允许打开工作区内的路径：' + rootAbs });
        return;
      }
      let isDir = false;
      try { isDir = statSync(abs).isDirectory(); } catch { json(res, 404, { ok: false, reason: '路径不存在：' + abs }); return; }

      /* 首选：DSH 原生路径能力（与界面上的「Open In…」按钮同源） */
      const sc = svcOfImpl(ctx, 'sessionController');
      if (sc && typeof sc.openWorkspacePath === 'function') {
        try {
          await sc.openWorkspacePath(mode === 'reveal' ? { path: abs, action: 'reveal' } : { path: abs });
          json(res, 200, { ok: true, path: abs, isDir, mode, how: 'sessionController' });
          return;
        } catch { /* 退回系统命令 */ }
      }
      const r = await revealBySystem(ctx, abs, mode, root);
      json(res, r.ok ? 200 : 502, {
        ok: r.ok, path: abs, isDir, mode, how: r.how, runner: r.runner,
        reason: r.ok ? undefined : (r.stderr || r.reason || '调用系统命令失败'),
      });
    });

    /* ---------------- FDE 工作站路由（spec §4，13 条；v1.3 起另有招采 7 + 生财 2 + 资料库 2） ----------------
     * 全部复用 makeGuard（方法白名单 → 同源/回环 fence → JSON 限制）与 workspaceRoot/paths.*；
     * 失败统一 {ok:false, reason, code}，HTTP 状态由 fdeApi.httpStatusOf 映射。
     * opts.http200=true 的旁路路由（生财情报 scys/*）业务失败也回 200：
     * 未授权/不可达属可预期降级，面板据 code 显示空态，不应触发 HTTP 错误分支。 */
    const fdeRoute = (route, opts, fn) => {
      add('/research-workbench/api/fde/' + route, opts, async (req, res) => {
        const q = qs(req);
        const isPost = String((req && req.method) || 'GET').toUpperCase() === 'POST';
        let body = {};
        if (isPost) {
          try { body = await readJsonBody(req); } catch (e) {
            json(res, 400, { ok: false, reason: String((e && e.message) || e), code: 'INVALID' });
            return;
          }
          /* 审计留痕（spec §4.1）：HTTP 面板入口一律按人类处理；agent 工具走 API 时显式 by:'agent'。 */
          body = Object.assign({}, body || {}, { by: 'human' });
        }
        let root;
        try {
          root = workspaceRoot(ctx, (body && body.root) || q.root);
        } catch (e) {
          json(res, 400, { ok: false, reason: '非法工作区根：' + String((e && e.message) || e), code: 'INVALID' });
          return;
        }
        let result;
        try {
          result = await fn(root, body || {}, q);
        } catch (e) {
          result = { ok: false, reason: String((e && e.message) || e), code: 'INTERNAL' };
        }
        json(res, opts.http200 ? 200 : fdeApi.httpStatusOf(result), result);
      });
    };

    fdeRoute('board', { methods: ['GET'] }, (root, body, q) => fdeApi.board(root, { view: q.view, bidIntel: bidSvc() }));
    fdeRoute('brief', { methods: ['GET'] }, (root, body, q) => fdeApi.brief(root, { period: q.period, bidIntel: bidSvc() }));
    fdeRoute('engagement', { methods: ['POST'], json: true }, (root, body) => fdeApi.engagement(root, body));
    fdeRoute('item', { methods: ['POST'], json: true }, (root, body) => fdeApi.item(root, body));
    fdeRoute('attention', { methods: ['POST'], json: true }, (root, body) => fdeApi.attention(root, body));
    fdeRoute('gate', { methods: ['POST'], json: true }, (root, body) => fdeApi.gate(root, body));
    fdeRoute('adopt', { methods: ['POST'], json: true }, (root, body) => fdeApi.adopt(root, body));
    fdeRoute('handoff', { methods: ['POST'], json: true }, (root, body) => fdeApi.handoff(root, body, fdeDeps));
    fdeRoute('proposal', { methods: ['POST'], json: true }, (root, body) => fdeApi.proposal(root, body, fdeDeps));
    fdeRoute('settings', { methods: ['POST'], json: true }, (root, body) => fdeApi.settings(root, body));
    fdeRoute('sync', { methods: ['POST'], json: true }, (root, body) => fdeApi.sync(root, body));
    fdeRoute('health', { methods: ['GET'] }, (root) => fdeApi.health(root, { skills: skillsState, bidIntel: bidSvc() }));
    fdeRoute('meta', { methods: ['GET'] }, () => fdeApi.meta());

    /* ---- 招采雷达（v1.1，spec §17.4）7 条：全部走同一 makeGuard/workspaceRoot；by 由路由注入 human ---- */
    fdeRoute('bids/stats', { methods: ['GET'] }, (root) => fdeApi.bidsStats(root, { bidIntel: bidSvc() }));
    fdeRoute('bids/search', { methods: ['GET'] }, (root, body, q) => fdeApi.bidsSearch(root, q, { bidIntel: bidSvc() }));
    fdeRoute('bids/match', { methods: ['GET'] }, (root, body, q) => fdeApi.bidsMatch(root, q, { bidIntel: bidSvc() }));
    fdeRoute('bids/link', { methods: ['POST'], json: true }, (root, body) => fdeApi.bidLink(root, body, { bidIntel: bidSvc() }));
    fdeRoute('bids/unlink', { methods: ['POST'], json: true }, (root, body) => fdeApi.bidUnlink(root, body, { bidIntel: bidSvc() }));
    fdeRoute('bids/promote', { methods: ['POST'], json: true }, (root, body) => fdeApi.bidPromote(root, body, { bidIntel: bidSvc() }));
    fdeRoute('bids/refresh', { methods: ['POST'], json: true }, (root, body) => fdeApi.bidsRefresh(root, body, { bidIntel: bidSvc() }));

    /* ---- 生财 FDE 情报（v1.2，spec §18.5）2 条：只读缓存 + 手动刷新 ----
     * 未授权/不可达属业务降级：HTTP 恒 200，由 {ok:false, code} 表达（spec §18.5）。 */
    fdeRoute('scys/feed', { methods: ['GET'], http200: true }, (root) => fdeScys.status(root));
    fdeRoute('scys/refresh', { methods: ['POST'], json: true, http200: true }, (root, body) => fdeScys.refresh(root, { force: !!(body && body.force) }));
    /* 新增（ADR 0004 D5）：生财三路授权。GET = 状态摘要；POST {token|url} = 保存链接授权；{clear:true} = 清除。
     * HTTP 恒 200，由 {ok, auth} 表达；token 不返回、不写日志。 */
    fdeRoute('scys/auth', { methods: ['GET', 'POST'], json: true, http200: true }, (root, body) => {
      const b = body || {};
      if (b.clear === true) return fdeScys.clearAuthFromInput(root);
      if (b.token || b.url) return fdeScys.saveAuthFromInput(root, b);
      return { ok: true, auth: fdeScys.authSummary(root) };
    });

    /* ---- FDE 资料库（v1.3，spec §19.4）2 条：只读缓存 + 刷新 ----
     * catalog 缺失 → UNAVAILABLE；GitHub/社区失败只写 sources/warnings；
     * 业务降级 HTTP 恒 200（同 scys，由 {ok:false, code} 表达）。 */
    fdeRoute('library/feed', { methods: ['GET'], http200: true }, (root) => fdeLibrary.status(root));
    fdeRoute('library/refresh', { methods: ['POST'], json: true, http200: true }, (root, body) => (
      body && body.force
        ? fdeLibrary.refresh(root, { force: true })
        : fdeLibrary.maybeRefresh(root, {})
    ));

    ctx.effect(() => disposers, 'research-workbench: routes');
    log('面板路由已注册（' + disposers.length + ' 条，含 FDE 14 条 + 招采 7 条 + 生财 3 条 + 资料库 2 条）');
  };

  /* ---------------- agent 工具 ---------------- */
  const registerTools = () => {
    const tools = svcOfImpl(ctx, 'tools');
    if (!tools || typeof tools.register !== 'function') { log('tools 服务不可用'); return; }

    tools.register({
      name: 'rw_status',
      description: '调研工作台：查看工作区下所有调研项目的进展（已完成哪些阶段、有哪些 md 与 PDF 产物）。回答"现在有哪些调研项目/进展到哪了"时使用。',
      parameters: { type: 'object', properties: { root: { type: 'string', description: '工作区根目录（可选，默认自动探测）' } } },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      execute(args) {
        const root = workspaceRoot(ctx, args.root);
        const projects = store.scanProjects(join(root, 'research'));
        const lines = [`调研工作台｜工作区：${root}（探测方式：${lastRootHow}）`, `项目数：${projects.length}`];
        const legacy = projects.filter((p) => !p.adopted && p.kind !== 'material');
        const mats = projects.filter((p) => p.kind === 'material');
        for (const p of projects) {
          const s = p.stages;
          lines.push(`- ${p.dir}｜${p.title}${p.adopted ? '' : '（未建档）'}`);
          lines.push(`  立项 ${s.archive ? '✓' : '✗'}｜research ${s.research} 篇｜meeting ${s.meeting} 篇｜proposal ${s.proposal} 篇｜导出 PDF ${s.exports} 个`);
        }
        if (mats.length) {
          lines.push('');
          lines.push(`素材目录 ${mats.length} 个（已抓取原文，无 md 产物）：${mats.slice(0, 12).map((p) => p.dir).join('、')}${mats.length > 12 ? ' …' : ''}`);
        }
        if (!projects.length) lines.push('（尚无项目；用 rw_scaffold 建新项目，或在左侧「调研工作台」面板立项）');
        if (legacy.length) {
          lines.push('');
          lines.push(`提示：${legacy.length} 个历史目录未建 00-项目档案.md（${legacy.map((p) => p.dir).join('、')}），内容正常统计；可在面板点「补建档案」纳入七步流程。`);
        }
        return Promise.resolve({ text: lines.join('\n'), projects, root });
      },
      presentCall: () => ({ card: 'generic', title: '调研工作台状态', kind: 'read' }),
    });

    tools.register({
      name: 'rw_scaffold',
      description: '调研工作台：新建一个调研项目目录（research/<客户>/ 下含 raw、research、meeting/exports、proposal/exports 与 00-项目档案.md）。用户说"帮我调研某公司"时先调用本工具立项。',
      parameters: {
        type: 'object',
        properties: {
          company: { type: 'string', description: '公司全称' },
          person: { type: 'string', description: '见面对象姓名（可选）' },
          role: { type: 'string', description: '见面对象职务（可选）' },
          purpose: { type: 'string', description: '见面性质与目标（可选）' },
          when: { type: 'string', description: '见面时间（可选）' },
          where: { type: 'string', description: '见面地点（可选）' },
          root: { type: 'string', description: '工作区根目录（可选）' },
        },
        required: ['company'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      execute(args) {
        const root = workspaceRoot(ctx, args.root);
        const dirName = `${slugify(args.company)}-${fdeStore.localDateStr().replace(/-/g, '')}`;
        const proj = join(root, 'research', dirName);
        const archive = join(proj, '00-项目档案.md');
        if (existsSync(archive)) return Promise.resolve({ text: `项目已存在：${proj}`, project: proj, dir: dirName });
        for (const d of ['raw', 'research', 'meeting/exports', 'proposal/exports', 'internal']) {
          mkdirSync(join(proj, d), { recursive: true });
        }
        writeFileSync(archive, store.renderArchive(args), 'utf8');
        return Promise.resolve({
          text: [
            `已立项：${proj}`,
            '目录：raw/ · research/ · meeting/exports/ · proposal/exports/ · internal/',
            '',
            '下一步按七步流程执行：',
            '2) 侦察与主体锁定（地址锚定 + 三链验证）→ research/主体锁定与归属核对.md',
            '3) 抓取（用 scripts/grab.py，勿用 web_fetch）→ raw/',
            '4) 事实核查（A/B/C 分级 + 数字自检）→ research/事实核查清单.md',
            '5) KPI 与痛点假设 → research/KPI与痛点假设.md',
            '6) 会面材料（Brief + 合作地图 + 研判底稿）→ meeting/',
            '7) 方案（md 为主）→ proposal/，需要时 rw_export_pdf 导出',
          ].join('\n'),
          project: proj,
          dir: dirName,
        });
      },
      presentCall: (a) => ({ card: 'generic', title: `立项：${a.company}`, kind: 'edit' }),
    });

    tools.register({
      name: 'rw_export_pdf',
      description: '调研工作台：把指定 md 导出为正式排版 PDF（默认输出到 md 同级的 exports/）。⚠️ 仅在用户明确要求导出/打印/递交时调用；默认交付格式是 md，不要主动导出。',
      parameters: {
        type: 'object',
        properties: {
          md: { type: 'string', description: 'md 文件路径（可绝对或相对工作区根，必须在工作区内）' },
          out: { type: 'string', description: '输出 PDF 路径（可选，相对工作区根或绝对；必须在工作区内；默认 exports/<同名>.pdf）' },
          root: { type: 'string', description: '工作区根目录（可选）' },
        },
        required: ['md'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      async execute(args) {
        try {
          const a = args || {};
          const root = workspaceRoot(ctx, a.root);
          const mdIn = paths.resolveInsideRoot(root, a.md, { mustExist: true, label: 'md 路径' });
          if (!mdIn.ok) return { text: mdIn.reason, ok: false, reason: mdIn.reason };
          const mdPath = mdIn.path;
          const script = join(SCRIPTS, 'make-pdf.sh');
          if (!existsSync(script)) return { text: '缺少 scripts/make-pdf.sh', ok: false };
          let outPath = '';
          if (a.out) {
            const outIn = paths.resolveInsideRoot(root, a.out, { label: 'out 路径' });
            if (!outIn.ok) return { text: outIn.reason, ok: false, reason: outIn.reason };
            outPath = outIn.path;
          }
          const argv = [script, mdPath];
          if (outPath) argv.push(outPath);
          const r = await subproc.run(ctx, 'bash', argv, { cwd: root });
          const pdfPath = outPath || join(dirname(mdPath), 'exports', basename(mdPath).replace(/\.md$/, '.pdf'));
          return {
            text: [r.ok ? '导出成功' : '导出失败', `md：${mdPath}`, `pdf：${pdfPath}`, '', String(r.stdout || '').trim(),
              String(r.stderr || '').trim() ? '\n[stderr]\n' + String(r.stderr || '').trim() : ''].join('\n'),
            ok: r.ok, pdf: pdfPath,
          };
        } catch (e) {
          const reason = '导出 PDF 失败：' + String((e && e.message) || e);
          return { text: reason, ok: false, reason };
        }
      },
      presentCall: (a) => ({ card: 'generic', title: `导出 PDF：${basename(a.md || '')}`, kind: 'edit' }),
    });

    tools.register({
      name: 'rw_qa_pdf',
      description: '调研工作台：检查 PDF 版面质量，区分「致命问题」（表头/标签被逐字断开）与「可接受的末行残字」，并检查缺字。导出 PDF 后应调用本工具确认。',
      parameters: {
        type: 'object',
        properties: { pdf: { type: 'string', description: 'PDF 文件路径（可绝对或相对工作区根，必须在工作区内）' }, root: { type: 'string', description: '工作区根目录（可选）' } },
        required: ['pdf'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      async execute(args) {
        try {
          const a = args || {};
          const root = workspaceRoot(ctx, a.root);
          /* Phase 3 · 审查 F-04：工具参数路径必须在工作区根内（realpath 前缀，越界回 ok:false 不抛）。 */
          const pdfIn = paths.resolveInsideRoot(root, a.pdf, { mustExist: true, label: 'pdf 路径' });
          if (!pdfIn.ok) return { text: pdfIn.reason, ok: false, reason: pdfIn.reason };
          const r = await subproc.run(ctx, 'python3', [join(SCRIPTS, 'qa-pdf.py'), pdfIn.path], { cwd: root });
          return { text: String(r.stdout || '').trim() || String(r.stderr || '').trim(), ok: r.ok };
        } catch (e) {
          const reason = 'PDF 质检失败：' + String((e && e.message) || e);
          return { text: reason, ok: false, reason };
        }
      },
      presentCall: (a) => ({ card: 'generic', title: `PDF 质检：${basename(a.pdf || '')}`, kind: 'read' }),
    });

    tools.register({
      name: 'rw_method',
      description: '调研工作台：读取方法论/参考文件（七步流程、事实核查协议、KPI假设法、合作地图构建法、数据源清单、雷区清单、文档模板库、项目档案模板）。开始调研或撰写材料前应先读取相关方法。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '文件名关键词，如"流程""核查""KPI""合作地图""数据源""雷区""模板"；留空则列出全部' } },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      execute(args) {
        const items = [];
        for (const [dir, kind] of [[METHODS, 'methods'], [REFERENCE, 'reference'], [TEMPLATES, 'templates']]) {
          if (!existsSync(dir)) continue;
          for (const f of readdirSync(dir)) if (f.endsWith('.md')) items.push({ kind, name: f, path: join(dir, f) });
        }
        const key = (args.name || '').trim();
        if (!key) {
          return Promise.resolve({
            text: '可用方法/参考文件：\n' + items.map((i) => `- [${i.kind}] ${i.name}`).join('\n') + '\n\n用 rw_method 带上关键词即可读取内容。',
            items: items.map((i) => i.name),
          });
        }
        const hit = items.find((i) => i.name.includes(key)) || items.find((i) => key.includes(i.name.replace(/\.md$/, '')));
        if (!hit) return Promise.resolve({ text: `未找到含「${key}」的方法文件。可用：\n` + items.map((i) => '- ' + i.name).join('\n') });
        const body = readFileSync(hit.path, 'utf8');
        return Promise.resolve({ text: `# ${hit.name}\n\n${body}`, file: hit.name, chars: body.length });
      },
      presentCall: (a) => ({ card: 'generic', title: `方法：${a.name || '全部'}`, kind: 'read' }),
    });

    /* ---------------- FDE 工具（6 个；与 HTTP 路由共用 fde-api 实现） ---------------- */
    const fdeToolRoot = (args) => workspaceRoot(ctx, (args && args.root) || '');
    const fdeFail = (e) => {
      const reason = 'FDE 操作失败：' + String((e && e.message) || e);
      return { ok: false, reason, text: reason };
    };
    const daysOf = (iso) => {
      const t = Date.parse(String(iso || ''));
      if (!Number.isFinite(t)) return 0;
      return Math.max(0, Math.floor((Date.now() - t) / 86400000));
    };
    const fmtAttentionList = (list, max) => list.slice(0, max).map((a) => {
      const who = a.engagementName ? '｜' + a.engagementName : (a.itemTitle ? '｜' + a.itemTitle : '');
      const due = a.due ? '｜到期 ' + a.due : '';
      return `- [${a.kind}] ${a.text}${who}${due}`;
    }).join('\n');
    const fmtMissing = (missing) => (missing || []).map((m) => `- ${m.type === 'auto' ? '自动' : '人工'}：${m.label}${m.detail ? '（' + m.detail + '）' : ''}`).join('\n');

    tools.register({
      name: 'fde_board',
      description: 'FDE 工作站：读取客户看板与今日状态。用户问「有哪些客户/各自到哪一步/今天该处理什么/任务卡在哪」时先调用本工具，再决定下一步动作。只读，不改状态。',
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: ['board', 'brief', 'engagement', 'item'], description: 'board=看板全量（默认）；brief=今日简报；engagement=客户列表或单个客户详情；item=任务列表或单条任务' },
          id: { type: 'string', description: 'engagement/item 视图下的对象 id（不传则列表）' },
          engagementId: { type: 'string', description: '只看某个客户的任务（item 视图）' },
          stage: { type: 'string', description: '按阶段/泳道过滤：客户阶段 lead|discovery|meeting|scoping|solution|pilot|delivery|adoption；任务泳道 inbox|todo|doing|waiting|review|done|canceled' },
          limit: { type: 'integer', description: '返回条目上限，默认 20，范围 1..100' },
          root: { type: 'string', description: '工作区根目录（可选，默认自动探测）' },
        },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      execute(args) {
        try {
          const a = args || {};
          const root = fdeToolRoot(a);
          const view = String(a.view || 'board');
          const limit = Math.min(100, Math.max(1, Number(a.limit) || 20));
          if (view === 'brief') {
            const r = fdeApi.brief(root, { period: a.period || 'today', bidIntel: fdeBids.resolveBidService(ctx) });
            if (!r.ok) return Promise.resolve({ text: '读取今日简报失败：' + r.reason, ok: false, reason: r.reason || '读取今日简报失败', code: r.code });
            const bf = r.brief;
            const lines = [
              `FDE 今日简报｜工作区：${root}`,
              bf.headline,
              `上下文：${bf.greeting}`,
              '',
              `【待我处理】${bf.attention.length} 条`,
              bf.attention.length ? fmtAttentionList(bf.attention, limit) : '（今天没有需要你处理的事）',
            ];
            if (bf.proposals.length) {
              lines.push('', `【建议】${bf.proposals.length} 条`);
              lines.push(bf.proposals.slice(0, limit).map((p) => `- ${p.title}（${p.ruleId}｜建议动作 ${p.kind}｜id=${p.id}）`).join('\n'));
            }
            if (bf.focus.length) {
              lines.push('', '【今日焦点】');
              lines.push(bf.focus.map((f) => `- ${f.name}｜${f.stageLabel}｜下一步：${f.nextAction.text || '（未填）'}${f.nextAction.due ? '（' + f.nextAction.due + '）' : ''}｜注意力 ${f.attentionCount}`).join('\n'));
            }
            return Promise.resolve({ text: lines.join('\n'), ok: true, brief: bf, stats: r.stats });
          }

          const r = fdeApi.board(root, { bidIntel: fdeBids.resolveBidService(ctx) });
          if (!r.ok) return Promise.resolve({ text: '读取看板失败：' + r.reason, ok: false, reason: r.reason || '读取看板失败', code: r.code });
          const b = r.board;
          const st = r.stats;

          if (view === 'engagement') {
            if (!a.id) {
              const list = (b.engagements || []).filter((e) => fdeSchema.isStage(e.stage)).filter((e) => !a.stage || e.stage === a.stage);
              if (!list.length) return Promise.resolve({ text: '看板暂无客户。可用 fde_engagement(action=create) 新建，或用面板「导入现有项目」扫描 research/ 下已有目录。', ok: true, engagements: [] });
              return Promise.resolve({
                text: ['FDE 客户列表：', ...list.slice(0, limit).map((e) => `- ${e.id}｜${e.name}｜${fdeSchema.stageLabel(e.stage)}｜${e.priority}｜停留 ${daysOf(e.stageSince)} 天｜下一步：${(e.nextAction && e.nextAction.text) || '（未填）'}`)].join('\n'),
                ok: true, engagements: list,
              });
            }
            return Promise.resolve(fdeEngagementDetail(root, b, r, a, limit));
          }

          if (view === 'item') {
            const items = (b.items || []).filter((i) => (!a.id || i.id === a.id) && (!a.engagementId || i.engagementId === a.engagementId) && (!a.stage || i.stage === a.stage));
            if (!items.length) return Promise.resolve({ text: '没有匹配的任务。', ok: true, items: [] });
            const lines = items.slice(0, limit).map((i) => {
              const e = i.engagementId ? (b.engagements || []).find((x) => x.id === i.engagementId) : null;
              return `- ${i.id}｜${fdeSchema.laneLabel(i.stage)}｜${i.title}${e ? '｜' + e.name : ''}${i.due ? '｜到期 ' + i.due : ''}｜回报 ${i.reports.length} 条`;
            });
            return Promise.resolve({ text: ['FDE 任务列表：', ...lines].join('\n'), ok: true, items });
          }

          const sorted = (b.engagements || []).filter((e) => fdeSchema.isStage(e.stage))
            .slice()
            .sort((x, y) => (fdeSchema.priorityOrder(x.priority) - fdeSchema.priorityOrder(y.priority)) || String((x.nextAction && x.nextAction.due) || '9999').localeCompare(String((y.nextAction && y.nextAction.due) || '9999')));
          const open = (b.items || []).filter((i) => ['inbox', 'todo', 'doing', 'waiting', 'review'].includes(i.stage));
          const pend = (b.proposals || []).filter((p) => p.status === 'pending');
          const lines = [
            `FDE 看板｜工作区：${root}`,
            `统计：活跃客户 ${st.active}｜客户 ${st.engagements}｜任务 ${st.items}｜待处理 ${r.attention.length}｜逾期 ${st.overdue}｜今天到期 ${st.dueToday}｜待采纳建议 ${pend.length}`,
            '阶段分布：' + fdeSchema.ENGAGEMENT_STAGES.map((x) => `${x.label} ${st.byStage[x.key] || 0}`).join('｜'),
            '',
            `【客户】${sorted.length} 个`,
            sorted.length ? sorted.slice(0, limit).map((e) => {
              const att = r.attention.filter((x) => x.engagementId === e.id).length;
              const bb = e.bids && e.bids.available && Number(e.bids.approxTotal) > 0 ? `｜招采 ≈${e.bids.approxTotal}（采样 ${e.bids.total} 条）` : '';
              return `- ${e.name}｜${fdeSchema.stageLabel(e.stage)}｜${e.priority}｜停留 ${daysOf(e.stageSince)} 天｜下一步：${(e.nextAction && e.nextAction.text) || '（未填）'}${e.nextAction && e.nextAction.due ? '（' + e.nextAction.due + '）' : ''}${att ? '｜注意力 ' + att : ''}${bb}${e.dir ? '' : '｜无客户目录'}`;
            }).join('\n') : '（暂无；可新建客户或用面板「导入现有项目」扫描 research/ 下已有目录）',
          ];
          if (r.attention.length) {
            lines.push('', `【待我处理】${r.attention.length} 条`, fmtAttentionList(r.attention, Math.min(limit, 8)));
          }
          if (open.length) {
            lines.push('', `【未完成任务】${open.length} 个`);
            lines.push(open.slice(0, limit).map((i) => `- ${fdeSchema.laneLabel(i.stage)}｜${i.title}${i.due ? '｜到期 ' + i.due : ''}`).join('\n'));
          }
          if (pend.length) {
            lines.push('', `【待采纳建议】${pend.length} 条`);
            lines.push(pend.slice(0, limit).map((p) => `- ${p.title}（${p.ruleId}｜${p.kind}｜id=${p.id}）`).join('\n'));
          }
          lines.push('', 'hint：阶段推进与门禁通过只能由人执行；agent 用 fde_item(action=report) 回报、用 fde_attention(action=ask) 提问。');
          return Promise.resolve({ text: lines.join('\n'), ok: true, board: b, stats: st, attention: r.attention.slice(0, limit), proposals: pend });
        } catch (e) { return Promise.resolve(fdeFail(e)); }
      },
      presentCall: () => ({ card: 'generic', title: 'FDE 看板', kind: 'read' }),
    });

    /* 客户详情渲染（fde_board view=engagement&id=… 用；独立函数避免依赖 this 绑定）。 */
    const fdeEngagementDetail = (root, b, r, a, limit) => {
        const e = (b.engagements || []).find((x) => x.id === a.id);
        if (!e) return { text: '客户不存在：' + a.id, ok: false, reason: '客户不存在：' + a.id, code: 'NOT_FOUND' };
        const nxt = fdeSchema.nextStage(e.stage);
        const gateStage = a.stage || nxt || e.stage;
        /* 只读工具：直接用 rules.evaluateGate 评估，不经过 api.gate（后者可能在人类路径写 gateState）。 */
        const gateKey = fdeSchema.gateKeyOfStage(gateStage);
        const gateDef = gateKey ? fdeRules.evaluateGate(root, e, gateKey) : null;
        const items = (b.items || []).filter((i) => i.engagementId === e.id);
        const att = r.attention.filter((x) => x.engagementId === e.id);
        const lines = [
          `客户：${e.name}（${e.id}）`,
          `阶段：${fdeSchema.stageLabel(e.stage)}｜停留 ${daysOf(e.stageSince)} 天｜优先级 ${e.priority}${e.paused ? '｜已暂停' : ''}`,
          `公司全称：${e.company || '（未填写）'}${e.shortName ? '｜简称 ' + e.shortName : ''}`,
          `客户目录：${e.dir ? 'research/' + e.dir : '（无）'}`,
          `下一步：${(e.nextAction && e.nextAction.text) || '（未填）'}${e.nextAction && e.nextAction.due ? '｜到期 ' + e.nextAction.due : ''}${e.nextAction && e.nextAction.owner ? '｜' + e.nextAction.owner : ''}`,
          `干系人：${(e.stakeholders || []).map((x) => x.name + (x.role ? '（' + x.role + '）' : '')).join('、') || '（未录入）'}`,
          `招采雷达：${e.bids && e.bids.available ? (Number(e.bids.approxTotal) > 0 ? `相关 ≈${e.bids.approxTotal}（采样 ${e.bids.total} 条）｜招标 ${e.bids.tender}｜中标 ${e.bids.award}｜候选 ${e.bids.candidate}` : '无匹配（0 命中是数据事实）') : '未就绪（bid-intel 未装载或未升级）'}`,
        ];
        if (gateDef) {
          lines.push('', `【门禁】${gateDef.label}｜${gateDef.status}｜缺 ${gateDef.missing.length} 项`);
          if (gateDef.missing.length) lines.push(fmtMissing(gateDef.missing));
        }
        if (items.length) {
          lines.push('', `【任务】${items.length} 个`);
          lines.push(items.slice(0, limit).map((i) => `- ${i.id}｜${fdeSchema.laneLabel(i.stage)}｜${i.title}${i.due ? '｜到期 ' + i.due : ''}`).join('\n'));
        }
        if (att.length) {
          lines.push('', `【注意力】${att.length} 条`);
          lines.push(fmtAttentionList(att, limit));
        }
        const tl = (e.timeline || []).slice(-5).reverse();
        if (tl.length) {
          lines.push('', '【最近时间线】');
          lines.push(tl.map((t) => `- ${String(t.at || '').slice(0, 16).replace('T', ' ')}｜${t.kind}｜${t.text}`).join('\n'));
        }
        lines.push('', 'hint：移动阶段会校验门禁；门禁未过时先补齐缺项或由人 force（需 reason）。');
        return { text: lines.join('\n'), ok: true, engagement: e, gate: gateDef, missing: gateDef ? gateDef.missing : [], attention: att, items };
    };

    tools.register({
      name: 'fde_engagement',
      description: 'FDE 工作站：客户创建/更新与门禁只读评估。红线：move（推进阶段）、archive（归档）、门禁勾选与 force 放行只能由人在面板执行——本工具调用会被直接拒绝（code=BLOCKED）；gate 只允许只读评估（不要传 checks/force）。创建与更新客户字段可用。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'move', 'gate', 'archive'], description: 'create=新建客户；update=改字段；move=推进阶段（受门禁）；gate=评估/勾选门禁；archive=归档' },
          id: { type: 'string', description: '客户 id（create 之外必填）' },
          patch: {
            type: 'object',
            description: '要写入的字段：name/company/shortName/dir/priority/owner/tags/source/value/nextAction/stakeholders/paused；move 时用 {stage, force?, reason?}；gate 时用 {stage, checks?, force?, reason?}',
          },
          force: { type: 'boolean', description: '强制推进/放行（必须同时给 reason；会记 forced，仅限用户明确要求）' },
          reason: { type: 'string', description: '强制原因，写入 gateState 与时间线' },
          root: { type: 'string', description: '工作区根目录（可选）' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      execute(args) {
        try {
          const a = args || {};
          const action = String(a.action || '');
          const root = fdeToolRoot(a);
          /* F1 红线（spec §6/§7）：agent 工具不得推进阶段/归档/写门禁；宿主层同样拒绝，这里给出明确原因。 */
          const toolPatch = Object.assign({}, a.patch || {});
          const wantsGateWrite = action === 'gate' && (
            a.force === true || toolPatch.force === true ||
            (toolPatch.checks && Object.keys(toolPatch.checks).length > 0)
          );
          if (action === 'move' || action === 'archive') {
            return Promise.resolve({
              text: '拒绝：阶段推进与归档只能由人在面板执行（FDE 红线）。agent 可以：补齐门禁证据、写产物、用 fde_attention 提问、给用户操作建议。',
              ok: false, reason: '阶段推进/归档只能由人在面板执行（agent 红线）', code: 'BLOCKED',
            });
          }
          if (wantsGateWrite) {
            return Promise.resolve({
              text: '拒绝：门禁勾选与 force 放行只能由人在面板执行（FDE 红线）。agent 只能做只读评估（gate 不传 checks/force），或提示用户去面板勾选。',
              ok: false, reason: '门禁勾选与 force 放行只能由人在面板执行（agent 红线）', code: 'BLOCKED',
            });
          }
          const body = { action, id: a.id || '', by: 'agent' };
          const patch = Object.assign({}, a.patch || {});
          if (a.force) patch.force = true;
          if (a.reason) patch.reason = a.reason;
          if (action === 'create') {
            for (const k of ['name', 'company', 'shortName', 'dir', 'priority', 'owner', 'tags', 'source', 'value', 'nextAction', 'stakeholders']) {
              if (a[k] != null) patch[k] = a[k];
            }
          }
          if (Object.keys(patch).length) body.patch = patch;
          const r = fdeApi.engagement(root, body);
          if (!r.ok) {
            const extra = r.blocked && r.missing && r.missing.length ? '\n缺少：\n' + fmtMissing(r.missing) + '\n请由人在面板补齐门禁项，或按用户明确指示带 force+reason 重试。' : '';
            return Promise.resolve({ text: `客户操作失败（${r.code || 'ERROR'}）：${r.reason}${extra}`, ok: false, reason: r.reason || '客户操作失败', code: r.code, blocked: !!r.blocked, missing: r.missing || [] });
          }
          const e = r.engagement || {};
          const parts = [`客户操作成功：${action}`];
          if (e.id) parts.push(`客户：${e.name}（${e.id}）｜阶段 ${fdeSchema.stageLabel(e.stage)}｜优先级 ${e.priority}`);
          if (e.dir) parts.push(`目录：research/${e.dir}`);
          if (r.gate && r.gate.missing && r.gate.missing.length) parts.push(`门禁仍缺 ${r.gate.missing.length} 项：` + r.gate.missing.map((m) => m.label).join('、'));
          return Promise.resolve({ text: parts.join('\n'), ok: true, engagement: e, board: r.board, gate: r.gate || null, missing: (r.gate && r.gate.missing) || [] });
        } catch (e) { return Promise.resolve(fdeFail(e)); }
      },
      presentCall: (a) => ({ card: 'generic', title: `FDE 客户：${a.action || ''}`, kind: 'edit' }),
    });

    tools.register({
      name: 'fde_item',
      description: 'FDE 工作站：任务增改移与回报。创建/更新/移动泳道；report 回报进度——ready 自动进「待我审」，blocked 进「等外部」并生成注意力，failed 保持进行中并生成注意力，dropped 取消。执行会话完成后必须用 report 回报（≤300 字摘要 + 文件路径）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'move', 'report'], description: 'create=建任务；update=改字段；move=改泳道；report=回报。删除任务只能由人在面板执行，本工具不提供 delete。' },
          id: { type: 'string', description: '任务 id（create 之外必填）' },
          patch: {
            type: 'object',
            description: 'create/update 字段：title/type/priority/due/owner/engagementId/autonomy；move 用 {stage, evidence?, force?, reason?}',
          },
          report: {
            type: 'object',
            description: '回报体：{kind: progress|ready|blocked|failed|dropped, text: ≤300字摘要, artifacts: [文件路径]}',
            properties: {
              kind: { type: 'string', enum: ['progress', 'ready', 'blocked', 'failed', 'dropped'] },
              text: { type: 'string' },
              artifacts: { type: 'array', items: { type: 'string' } },
            },
            required: ['kind', 'text'],
          },
          root: { type: 'string', description: '工作区根目录（可选）' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      execute(args) {
        try {
          const a = args || {};
          const action = String(a.action || '');
          const root = fdeToolRoot(a);
          if (action === 'delete') {
            return Promise.resolve({ text: '拒绝：删除客户或任务只能由人在面板执行（红线）。如确需删除，请提示用户在「客户」或「看板」抽屉里操作。', ok: false, reason: '删除任务只能由人在面板执行（agent 红线）', code: 'BLOCKED' });
          }
          const body = { action, id: a.id || '', by: 'agent' };
          if (a.patch) body.patch = a.patch;
          if (action === 'create') {
            for (const k of ['title', 'type', 'priority', 'due', 'owner', 'engagementId', 'stage']) if (a[k] != null) body[k] = a[k];
            if (!body.patch && a.patch) body.patch = a.patch;
          }
          if (action === 'report') {
            if (a.report) body.report = a.report;
            else if (a.kind || a.text) body.report = { kind: a.kind, text: a.text, artifacts: a.artifacts };
          }
          const r = fdeApi.item(root, body);
          if (!r.ok) {
            const extra = r.blocked && r.missing && r.missing.length ? '\n缺少：' + r.missing.map((m) => m.label).join('、') : '';
            return Promise.resolve({ text: `任务操作失败（${r.code || 'ERROR'}）：${r.reason}${extra}`, ok: false, reason: r.reason || '任务操作失败', code: r.code, blocked: !!r.blocked, missing: r.missing || [] });
          }
          const it = r.item || {};
          const parts = [`任务操作成功：${action}`];
          if (it.id) parts.push(`任务：${it.title}（${it.id}）｜泳道 ${fdeSchema.laneLabel(it.stage)}｜优先级 ${it.priority}${it.due ? '｜到期 ' + it.due : ''}`);
          if (r.attention) parts.push('已生成注意力：' + (r.attention.question || '').slice(0, 120));
          if (r.warning) parts.push('提示：' + r.warning);
          if (action === 'report') parts.push('回报已记录；如任务需要人决定，用 fde_attention(action=ask) 提问。');
          return Promise.resolve({ text: parts.join('\n'), ok: true, item: it, attention: r.attention || null, board: r.board, warning: r.warning || '' });
        } catch (e) { return Promise.resolve(fdeFail(e)); }
      },
      presentCall: (a) => ({ card: 'generic', title: `FDE 任务：${a.action || ''}`, kind: a.action === 'report' ? 'read' : 'edit' }),
    });

    tools.register({
      name: 'fde_attention',
      description: 'FDE 工作站：注意力的唯一通道。ask=向人提问（需要决定/受阻/需要回答），resolve=记录回答并清除，list=查看全部派生注意力（受阻/待决定/待审/逾期/门禁/停滞/建议）。需要人决定时用 ask，不要自行替人决定。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['ask', 'resolve', 'list'], description: 'ask=提问；resolve=回答并清除；list=查看列表' },
          target: { type: 'string', enum: ['engagement', 'item'], description: 'ask/resolve 的对象类型，默认 engagement' },
          id: { type: 'string', description: '对象 id（ask/resolve 必填）' },
          question: { type: 'string', description: '要人回答的问题（ask 必填）' },
          kind: { type: 'string', enum: ['decision', 'blocked', 'answer', 'question'], description: '注意力种类，默认 decision' },
          answer: { type: 'string', description: '人的回答（resolve 可选）' },
          root: { type: 'string', description: '工作区根目录（可选）' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      execute(args) {
        try {
          const a = args || {};
          const root = fdeToolRoot(a);
          const body = { action: a.action, target: a.target, id: a.id, question: a.question, kind: a.kind, answer: a.answer, by: 'agent' };
          const r = fdeApi.attention(root, body);
          if (!r.ok) return Promise.resolve({ text: `注意力操作失败（${r.code || 'ERROR'}）：${r.reason}`, ok: false, reason: r.reason || '注意力操作失败', code: r.code });
          if (String(a.action) === 'list') {
            const list = r.list || [];
            return Promise.resolve({
              text: list.length ? [`FDE 注意力 ${list.length} 条：`, fmtAttentionList(list, 50)].join('\n') : '当前没有需要人处理的注意力。',
              ok: true, list,
            });
          }
          if (String(a.action) === 'ask') {
            return Promise.resolve({ text: `已向人提问（${r.attention.kind}）：${r.attention.question}\n人回答后用 action=resolve 记录。`, ok: true, attention: r.attention, board: r.board });
          }
          return Promise.resolve({ text: `已处理注意力${r.cleared ? '：' + (a.answer || '已清除') : '（本来就没有显式注意力）'}`, ok: true, attention: r.attention, board: r.board });
        } catch (e) { return Promise.resolve(fdeFail(e)); }
      },
      presentCall: (a) => ({ card: 'generic', title: `FDE 注意力：${a.action || ''}`, kind: a.action === 'ask' ? 'edit' : 'read' }),
    });

    tools.register({
      name: 'fde_brief',
      description: 'FDE 工作站：今日简报（待处理注意力、待采纳建议、今日焦点、最近活动）。apply=true 时按 settings.autonomy 执行安全动作（建任务/改下一步）；observe 模式只建议不执行。门禁/阶段/对外/删除永不由本工具自动执行。',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['today', 'week'], description: '简报周期，默认 today' },
          apply: { type: 'boolean', description: '是否按自主性模式执行安全建议，默认 false' },
          root: { type: 'string', description: '工作区根目录（可选）' },
        },
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      async execute(args) {
        try {
          const a = args || {};
          const root = fdeToolRoot(a);
          let applied = null;
          const bidIntel = fdeBids.resolveBidService(ctx);
          if (a.apply) {
            /* 先读一次 board 触发建议求值（读时求值并持久化）；F4：applySafeProposals 内部
             * 从磁盘重新 load 原始 board，不会把响应副本里的派生 artifacts 写进状态文件。 */
            const b0 = fdeApi.board(root, { bidIntel });
            if (!b0.ok) return { text: '读取看板失败：' + b0.reason, ok: false, reason: b0.reason || '读取看板失败', code: b0.code };
            applied = fdeApi.applySafeProposals(root);
            if (!applied.ok) return { text: '执行安全建议失败：' + applied.reason, ok: false, reason: applied.reason || '执行安全建议失败', code: applied.code };
          }
          const r = fdeApi.brief(root, { period: a.period || 'today', bidIntel });
          if (!r.ok) return { text: '读取今日简报失败：' + r.reason, ok: false, reason: r.reason || '读取今日简报失败', code: r.code };
          const bf = r.brief;
          const lines = [`FDE 今日简报（${bf.period === 'week' ? '本周' : '今日'}）`, bf.headline, '', `【待我处理】${bf.attention.length} 条`];
          lines.push(bf.attention.length ? fmtAttentionList(bf.attention, 20) : '（今天没有需要你处理的事）');
          if (bf.proposals.length) {
            lines.push('', `【建议】${bf.proposals.length} 条`);
            lines.push(bf.proposals.map((p) => `- ${p.title}（${p.ruleId}｜${p.kind}｜id=${p.id}）`).join('\n'));
          }
          if (applied) {
            lines.push('', `【自主性执行】模式 ${applied.mode}｜已执行 ${applied.applied.length} 条｜保留待人工 ${applied.skipped.length} 条`);
            if (applied.mode === 'observe') lines.push('（observe 模式只建议，不自动执行；可在设置里切到 assisted/auto）');
          }
          if (bf.focus.length) lines.push('', '【今日焦点】', bf.focus.map((f) => `- ${f.name}｜${f.stageLabel}｜下一步：${f.nextAction.text || '（未填）'}`).join('\n'));
          return { text: lines.join('\n'), ok: true, brief: bf, proposals: bf.proposals, applied: applied || null };
        } catch (e) { return Promise.resolve(fdeFail(e)); }
      },
      presentCall: () => ({ card: 'generic', title: 'FDE 今日简报', kind: 'read' }),
    });

    tools.register({
      name: 'fde_harvest',
      description: 'FDE 工作站：写复盘草稿（项目复盘/事故/方法沉淀）。落 research/.fde/drafts/ 的未审草稿，不是客户卷定稿；给出坑卡/方法/技能三种回流建议。脱敏：不写客户真名到方法论，示例用「某集团」。',
      parameters: {
        type: 'object',
        properties: {
          engagementId: { type: 'string', description: '关联客户 id（可选）' },
          itemId: { type: 'string', description: '关联任务 id（可选）' },
          text: { type: 'string', description: '复盘正文：发生了什么、为什么、下次怎么做' },
          targets: { type: 'array', items: { type: 'string', enum: ['pitfall', 'method', 'skill'] }, description: '沉淀去向建议：pitfall=坑卡 / method=方法 / skill=技能' },
          root: { type: 'string', description: '工作区根目录（可选）' },
        },
        required: ['text'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      execute(args) {
        try {
          const a = args || {};
          const root = fdeToolRoot(a);
          const r = fdeApi.harvest(root, { engagementId: a.engagementId, itemId: a.itemId, text: a.text, targets: a.targets, by: 'agent' });
          if (!r.ok) return Promise.resolve({ text: `写复盘草稿失败（${r.code || 'ERROR'}）：${r.reason}`, ok: false, reason: r.reason || '写复盘草稿失败', code: r.code });
          return Promise.resolve({
            text: [`复盘草稿已写入：${r.draftPath}`, `沉淀建议：${r.targets.join('、')}`, r.next].join('\n'),
            ok: true, draftPath: r.draftPath, targets: r.targets,
          });
        } catch (e) { return Promise.resolve(fdeFail(e)); }
      },
      presentCall: () => ({ card: 'generic', title: 'FDE 复盘草稿', kind: 'edit' }),
    });

    /* ---------------- 第 7 个 FDE 工具：fde_bid（招采雷达客户关联层，spec §17.5） ---------------- */
    tools.register({
      name: 'fde_bid',
      description: 'FDE 工作站：招采雷达客户关联层。search=检索招标/中标公告；match=某客户相关公告与统计（含查询词/已关联）；link/unlink=关联或取消关联公告；promote=把公告提升为跟进任务；timeline=按月看某单位采购节奏。口径：候选人≠中标人、批次是推断、金额只引原文不换算；全量深挖请用 bid-intel 的 bid_search/bid_batches/bid_report，不要用本工具替代。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'match', 'link', 'unlink', 'promote', 'timeline'], description: 'search=全局检索；match=客户匹配；link/unlink=关联/取消关联；promote=建跟进任务；timeline=按月聚合' },
          engagementId: { type: 'string', description: '客户 id（match/link/unlink/promote 必填；search 可选用于附关系）' },
          bidId: { type: 'string', description: '公告 id（link/unlink/promote 必填）' },
          q: { type: 'string', description: '检索词（search/timeline）' },
          mode: { type: 'string', enum: ['any', 'buyer', 'company', 'title'], description: '检索模式，默认 any' },
          from: { type: 'string', description: '起始日期 YYYY-MM-DD（可选）' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD（可选）' },
          source: { type: 'string', description: '来源过滤（可选）' },
          relation: { type: 'string', enum: ['buyer', 'winner', 'candidate', 'mention', 'tender'], description: '关联关系标签（可选）' },
          note: { type: 'string', description: '关联备注（可选）' },
          limit: { type: 'integer', description: '返回条数上限（search 默认 20，最大 50）' },
          refresh: { type: 'boolean', description: 'match 时强制刷新缓存' },
          root: { type: 'string', description: '工作区根目录（可选）' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      async execute(args) {
        try {
          const a = args || {};
          const action = String(a.action || '');
          const root = fdeToolRoot(a);
          const bidOpts = { bidIntel: fdeBids.resolveBidService(ctx) };
          const unavailable = (r) => ({
            text: '招采雷达未就绪：' + ((r && r.reason) || 'bid-intel 未装载或未升级') + '\n可提示用户安装/升级 bid-intel，或改用 bid-intel 的 bid_* 工具。',
            ok: false,
            reason: (r && r.reason) || '招采雷达未就绪（bid-intel 未装载或未升级）',
            code: 'UNAVAILABLE',
            available: false,
          });
          if (action === 'search') {
            const r = fdeApi.bidsSearch(root, { q: a.q, mode: a.mode, from: a.from, to: a.to, source: a.source, limit: a.limit, engagementId: a.engagementId }, bidOpts);
            if (!r.ok) return { text: '招采检索失败：' + r.reason, ok: false, reason: r.reason, code: r.code };
            if (!r.available) return unavailable(r);
            const items = (r.items || []).slice(0, Math.min(Number(a.limit) || 20, 20));
            const lines = [`招采检索「${a.q || '（全部）'}」：命中 ${r.total} 条（直接 ${r.direct || 0}｜提及 ${r.mentioned || 0}），显示 ${items.length} 条`];
            for (const it of items) {
              lines.push(`- ${it.date || '日期未知'}｜${it.kind || '公告'}｜${it.title}｜采购 ${it.buyer || '—'}｜中标/候选 ${it.winner || ((it.candidates || [])[0] && ((it.candidates || [])[0].name || (it.candidates || [])[0])) || '—'}${it.relation ? '｜关系 ' + it.relation : ''}｜金额 ${(it.amounts || []).join('；') || '—'}`);
            }
            lines.push('口径：候选人≠中标人；金额为原文，未换算/未求和。');
            return { text: lines.join('\n'), ok: true, available: true, total: r.total, items, facets: r.facets || null };
          }
          if (action === 'match') {
            const r = fdeApi.bidsMatch(root, { engagementId: a.engagementId, refresh: a.refresh }, bidOpts);
            if (!r.ok) return { text: '客户招采匹配失败：' + r.reason, ok: false, reason: r.reason, code: r.code };
            if (!r.available) return unavailable(r);
            const items = (r.items || []).slice(0, Math.min(Number(a.limit) || 20, 20));
            const approx = Number(r.stats.approxTotal) || Number(r.stats.total) || 0;
            const sampled = Number(r.stats.total) || 0;
            const lines = [
              `客户招采匹配：相关 ≈${approx}（采样 ${sampled} 条）｜招标 ${r.stats.tender}｜中标 ${r.stats.award}｜候选 ${r.stats.candidate}｜最近 ${r.stats.latest || '—'}`,
              `查询词：${(r.queries || []).join('、') || '（无）'}${approx > sampled ? '｜「≈N」为各查询真实量级，采样 M 为本次截断返回数；全量请用 bid_search / bid_timeline' : ''}`,
            ];
            for (const it of items) {
              lines.push(`- ${it.date || '日期未知'}｜${it.relation || '提及'}｜${it.title}｜采购 ${it.buyer || '—'}｜中标/候选 ${it.winner || '—'}${it.tender ? '｜招标类' : ''}${it.award ? '｜中标/结果' : ''}`);
            }
            if ((r.linked || []).length) lines.push(`已关联：${r.linked.length} 条`);
            lines.push('口径：候选人≠中标人；金额只引原文。全量深挖用 bid_search / bid_batches / bid_report。');
            return { text: lines.join('\n'), ok: true, available: true, stats: r.stats, queries: r.queries, items, linked: r.linked, cached: !!r.cached };
          }
          if (action === 'timeline') {
            const r = fdeApi.bidsTimeline(root, { q: a.q, mode: a.mode, from: a.from, to: a.to, source: a.source, limit: a.limit }, bidOpts);
            if (!r.ok) return { text: '招采时间线查询失败：' + r.reason, ok: false, reason: r.reason, code: r.code };
            if (!r.available) return unavailable(r);
            const months = Object.entries(r.byMonth || {}).sort((x, y) => String(y[0]).localeCompare(String(x[0]))).slice(0, 24);
            return {
              text: [`招采时间线「${r.q}」（${r.mode}）：共 ${r.total} 条`, ...months.map(([m, n]) => `- ${m}：${n} 条`)].join('\n'),
              ok: true, available: true, total: r.total, byMonth: r.byMonth,
            };
          }
          if (action === 'link') {
            const r = fdeApi.bidLink(root, { engagementId: a.engagementId, bidId: a.bidId, relation: a.relation, note: a.note, by: 'agent' }, bidOpts);
            if (!r.ok) return { text: '关联公告失败：' + r.reason, ok: false, reason: r.reason, code: r.code };
            if (!r.available) return unavailable(r);
            return { text: `已关联公告：${r.link.title || a.bidId}${r.changed ? '' : '（此前已关联，已同步）'}`, ok: true, link: r.link, changed: !!r.changed };
          }
          if (action === 'unlink') {
            const r = fdeApi.bidUnlink(root, { engagementId: a.engagementId, bidId: a.bidId, by: 'agent' }, bidOpts);
            if (!r.ok) return { text: '取消关联失败：' + r.reason, ok: false, reason: r.reason, code: r.code };
            return { text: r.changed ? '已取消关联' : '此前未关联（幂等，无需处理）', ok: true, changed: !!r.changed };
          }
          if (action === 'promote') {
            const r = fdeApi.bidPromote(root, { engagementId: a.engagementId, bidId: a.bidId, relation: a.relation, note: a.note, by: 'agent' }, bidOpts);
            if (!r.ok) return { text: '提升为跟进任务失败：' + r.reason, ok: false, reason: r.reason, code: r.code };
            if (!r.available) return unavailable(r);
            return { text: `已创建跟进任务：${r.item.title}（${r.item.id}，泳道 ${fdeSchema.laneLabel(r.item.stage)}）\n已关联公告 ${r.link ? r.link.bidId : a.bidId}。`, ok: true, item: r.item, link: r.link };
          }
          return { text: `未知 action：${action || '(空)'}（search|match|link|unlink|promote|timeline）`, ok: false, reason: '未知 action：' + (action || '(空)'), code: 'INVALID' };
        } catch (e) { return fdeFail(e); }
      },
      presentCall: (a) => ({ card: 'generic', title: `FDE 招采：${a.action || ''}`, kind: a.action === 'search' || a.action === 'match' || a.action === 'timeline' ? 'read' : 'edit' }),
    });

    /* ---------------- 第 8 个 FDE 工具：scys_fde（生财 FDE 情报，spec §18.6） ----------------
     * 只读社区情报：feed=读缓存（可按 kind/q 过滤），refresh=立即抓一次（每天自动一次，非必要不刷）。
     * 未授权/不可达返回 {ok:false, code, reason}，不抛异常；不调用任何生财写接口。 */
    tools.register({
      name: 'scys_fde',
      description: 'FDE 工作站：生财有术社区的 FDE 情报（只读）。feed=读今天缓存的情报（帖子/公众号/航海与大会/手册，默认 20 条，可按 kind/q 过滤）；refresh=立即抓取一次并写缓存（宿主每天自动更新一次，非必要不用手动刷）。内容为社区公开摘要、非全文，原帖以链接为准；无授权/无网络返回 {ok:false, code}（UNAUTHORIZED/UNAVAILABLE），不抛异常；不调用生财写接口。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['feed', 'refresh'], description: 'feed=读缓存情报；refresh=立即刷新' },
          limit: { type: 'integer', description: '返回条数上限（feed，默认 20，最大 50）' },
          kind: { type: 'string', enum: ['post', 'wechat', 'activity', 'navigator', 'manual'], description: '按类型过滤（feed，可选）' },
          q: { type: 'string', description: '在标题/摘要/作者里做关键词过滤（feed，可选；只过滤已抓到的缓存）' },
          root: { type: 'string', description: '工作区根目录（可选）' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      async execute(args) {
        try {
          const a = args || {};
          const action = String(a.action || 'feed');
          const root = fdeToolRoot(a);
          const fmtWhen = (iso) => {
            const t = Date.parse(String(iso || ''));
            return Number.isFinite(t) ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—';
          };
          if (action === 'refresh') {
            const r = await fdeScys.refresh(root);
            if (!r.ok) {
              return {
                text: `生财 FDE 情报刷新失败（${r.code}）：${r.reason}\n${r.feed ? '已保留上次缓存（' + (r.feed.date || '日期未知') + '）。' : '暂无缓存。'}`,
                ok: false, code: r.code, reason: r.reason, feed: r.feed || null, today: r.today, stale: r.stale,
              };
            }
            const f = r.feed || {};
            const s = f.stats || {};
            const qOk = Array.isArray(f.queries) ? f.queries.filter((q) => q.ok).length : 0;
            return {
              text: `生财 FDE 情报已刷新：${f.date}｜共 ${s.total || 0} 条（帖子 ${s.post || 0}·公众号 ${s.wechat || 0}·航海 ${s.activity || 0}·大会 ${s.navigator || 0}·手册 ${s.manual || 0}；新 ${s.new || 0}；过滤无关 ${s.filteredOut || 0}）｜查询成功 ${qOk}/${Array.isArray(f.queries) ? f.queries.length : 0}`,
              ok: true, feed: f, stats: s, fetchedAt: f.fetchedAt || '', today: r.today, stale: false,
            };
          }
          if (action !== 'feed') {
            return { text: `未知 action：${action || '(空)'}（feed|refresh）`, ok: false, code: 'INVALID', reason: '未知 action：' + (action || '(空)') };
          }
          const st = fdeScys.status(root);
          const c = fdeScys.compactFeed(st, { limit: a.limit, kind: a.kind, q: a.q });
          if (!st.feed) {
            return {
              text: [
                '生财 FDE 情报暂无缓存。',
                st.ok === false ? `上次状态：${st.code}｜${st.reason}` : '宿主会自动在启动后/每天抓取一次；也可用 scys_fde {action:"refresh"} 立即抓取。',
                '口径：来源生财有术社区 MCP，只读公开摘要；未授权时需在 DSH 中重新授权生财 MCP。',
              ].join('\n'),
              ok: st.ok, code: st.code, reason: st.reason, feed: null, today: st.today, stale: true,
            };
          }
          const f = st.feed;
          const s = f.stats || {};
          const lines = [
            `生财 FDE 情报｜数据日期 ${f.date || '—'}${st.stale ? '（今日尚未更新，宿主会自动更新）' : ''}｜更新于 ${fmtWhen(f.fetchedAt)}｜共 ${s.total || 0} 条（帖子 ${s.post || 0}·公众号 ${s.wechat || 0}·航海 ${s.activity || 0}·大会 ${s.navigator || 0}·手册 ${s.manual || 0}；新 ${s.new || 0}；过滤无关 ${s.filteredOut || 0}）`,
          ];
          if (st.ok === false) lines.push(`⚠ 上次刷新失败（${st.code}）：${st.reason}`);
          if (c.kind || c.q) {
            const parts = [];
            if (c.kind) parts.push('类型=' + c.kind);
            if (c.q) parts.push('关键词=' + c.q);
            lines.push(`筛选：${parts.join('｜')}｜命中 ${c.matched} 条，显示 ${c.items.length} 条`);
          }
          for (const it of c.items) {
            const tags = (it.tags && it.tags.length) ? '[' + it.tags.join('｜') + '] ' : '';
            const who = it.author ? '（' + it.author + '）' : '';
            const stt = it.stats || {};
            const meter = [stt.like ? '赞 ' + stt.like : '', stt.comment ? '评 ' + stt.comment : '', stt.read ? '读 ' + stt.read : ''].filter(Boolean).join(' ');
            lines.push(`- [${it.kind}${it.isNew ? '｜新' : ''}] ${tags}${it.title || '（无标题）'}${who}${it.publishedAt ? '｜' + it.publishedAt.slice(0, 10) : ''}${meter ? '｜' + meter : ''}${it.url ? '｜' + it.url : '｜（无链接）'}`);
          }
          lines.push('口径：来源生财有术社区 MCP 的公开内容摘要（非全文，原帖以链接为准）；帖子外内容已按 FDE/Forward Deployed/前沿部署/部署工程师 做轻量相关性过滤（stats.filteredOut 为被过滤条数）；统计数字来自各工具返回；缓存每天自动更新一次，可用 action=refresh 手动刷新。');
          return {
            text: lines.join('\n'),
            ok: st.ok, code: st.code, reason: st.reason,
            feed: f, items: c.items, stats: s, fetchedAt: f.fetchedAt || '', date: f.date || '',
            today: st.today, stale: st.stale, matched: c.matched, total: c.total,
          };
        } catch (e) { return fdeFail(e); }
      },
      presentCall: (a) => ({ card: 'generic', title: `生财 FDE 情报：${(a && a.action) || 'feed'}`, kind: 'read' }),
    });

    /* ---------------- 第 9 个 FDE 工具：fde_library（FDE 资料库，spec §19.5） ----------------
     * feed=读缓存（紧凑条目），search=按来源组/类型/阶段/关键词/重点推荐过滤，refresh=刷新一次。
     * catalog 缺失 → code=UNAVAILABLE；GitHub/社区失败只降级 sources/warnings，不抛异常；
     * 不抓取任意网页正文、不调用外部写接口。 */
    tools.register({
      name: 'fde_library',
      description: 'FDE 工作站：FDE 资料库（只读）。feed=读资料库缓存（权威资料/开源工具/方法模板/社区动态，默认 20 条）；search=按来源组/类型/适用阶段/关键词/仅看重点推荐过滤；refresh=刷新一次（GitHub 指标 + 社区动态，宿主每天自动刷新一次）。资料目录人工策展、A/B/C 分级；GitHub 指标为抓取时快照；社区动态为摘要非全文。不抓任意网页正文，不调用外部写接口。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['feed', 'search', 'refresh'], description: 'feed=读缓存（可带过滤）；search=按条件检索缓存；refresh=刷新缓存' },
          group: { type: 'string', description: '来源组过滤：intl-official（国外官方）/cn-official（国内官方）/opensource（开源工具）/method（方法与模板）/community（社区动态）' },
          kind: { type: 'string', description: '类型过滤：doc/whitepaper/guide/playbook/blog/course/report/case/job/repo/template/post' },
          stage: { type: 'string', description: '适用阶段过滤：lead/discovery/meeting/scoping/solution/pilot/delivery/adoption（all 表示全流程）' },
          q: { type: 'string', description: '关键词（标题/摘要/价值/发布方/主题）' },
          featured: { type: 'boolean', description: '仅看本期重点推荐' },
          limit: { type: 'integer', description: '返回条数上限（默认 20，最大 50）' },
          root: { type: 'string', description: '工作区根目录（可选）' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      async execute(args) {
        try {
          const a = args || {};
          const action = String(a.action || 'feed');
          const root = fdeToolRoot(a);
          const groupLabel = (key) => {
            const g = fdeLibrary.GROUPS.find((x) => x.key === key);
            return g ? g.label : (key || '');
          };
          const stageText = (it) => {
            const list = Array.isArray(it.stages) ? it.stages : ['all'];
            return list.includes('all') ? '全流程' : list.map((x) => fdeSchema.stageLabel(x)).join('、');
          };
          const authText = (it) => (['A', 'B', 'C'].includes(it.authority) ? it.authority : '?');
          const fmtWhen = (iso) => {
            const t = Date.parse(String(iso || ''));
            return Number.isFinite(t) ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—';
          };
          const fmtItems = (c) => c.items.map((it) => {
            const star = it.recommend === 'star' ? '★' : '';
            const flags = [it.isNew ? '新' : '', it.updated ? '更新' : ''].filter(Boolean).join('');
            return `- [${groupLabel(it.group)}/${it.kind}/${authText(it)}] ${star}${it.title || '（无标题）'} — ${it.publisher || '—'}｜${stageText(it)}｜${it.summary || it.why || ''}${flags ? '｜' + flags : ''}${it.url ? '｜' + it.url : '｜（无链接）'}`;
          }).join('\n');
          const catalogText = (st) => (st.catalog
            ? `资料目录 v${st.catalog.version || '?'}（更新 ${st.catalog.updatedAt || '—'}，人工策展）`
            : '资料目录不可用');

          if (action === 'refresh') {
            const r = await fdeLibrary.refresh(root);
            if (!r.ok) {
              return {
                text: `资料库刷新失败（${r.code}）：${r.reason}\n${r.feed ? '已保留上次缓存（日期 ' + (r.feed.date || '未知') + '，' + ((r.feed.items || []).length) + ' 条）。' : '暂无缓存。'}`,
                ok: false, code: r.code, reason: r.reason, feed: r.feed || null, today: r.today, stale: r.stale, warnings: r.warnings || [],
              };
            }
            const f = r.feed || {};
            const s = f.stats || {};
            const gh = (f.sources || []).find((x) => x.key === 'github') || {};
            const cm = (f.sources || []).find((x) => x.key === 'community') || {};
            const lines = [
              `FDE 资料库已刷新：${f.date || '—'}｜更新于 ${fmtWhen(f.fetchedAt)}｜共 ${s.total || 0} 条（国外官方 ${s.intlOfficial || 0}·国内官方 ${s.cnOfficial || 0}·开源 ${s.opensource || 0}·方法模板 ${s.method || 0}·社区 ${s.community || 0}；重点推荐 ${s.featured || 0}；新 ${s.new || 0}；更新 ${s.updated || 0}）`,
              `数据源：GitHub ${gh.ok ? '正常' : '部分失败'}（${gh.okCount || 0}/${gh.requested || 0}）｜社区 ${cm.ok ? '正常' : '不可读'}（${cm.items || 0} 条${cm.date ? '，' + cm.date : ''}）`,
            ];
            for (const w of (r.warnings || [])) lines.push('⚠ ' + w);
            lines.push('口径：资料目录人工策展（A/B/C 分级）；GitHub 指标为抓取时快照；社区动态为摘要非全文。');
            return { text: lines.join('\n'), ok: true, feed: f, stats: s, date: f.date || '', fetchedAt: f.fetchedAt || '', warnings: r.warnings || [] };
          }
          if (action !== 'feed' && action !== 'search') {
            return { text: `未知 action：${action || '(空)'}（feed|search|refresh）`, ok: false, code: 'INVALID', reason: '未知 action：' + (action || '(空)') };
          }
          const st = fdeLibrary.status(root);
          if (!st.ok) {
            const code = st.code || 'UNAVAILABLE';
            return {
              text: `资料库暂不可用（${code}）：${st.reason || '资料目录缺失'}\n${st.feed ? '已保留上次缓存（日期 ' + (st.feed.date || '未知') + '，' + ((st.feed.items || []).length) + ' 条）。' : '暂无缓存。'}`,
              ok: false, code, reason: st.reason, feed: st.feed || null, today: st.today, stale: st.stale, warnings: st.warnings || [],
            };
          }
          const c = fdeLibrary.compactFeed(st, {
            limit: a.limit, group: a.group, kind: a.kind, stage: a.stage, q: a.q, featured: a.featured === true,
          });
          const f = st.feed;
          if (!f) {
            return {
              text: [
                'FDE 资料库暂无缓存。',
                catalogText(st),
                '宿主会在启动后/每天自动刷新一次；也可用 action=refresh 立即刷新。',
                '口径：资料目录人工策展（A/B/C 分级）；GitHub 指标为抓取时快照；社区动态为摘要非全文。',
              ].join('\n'),
              ok: true, feed: null, today: st.today, stale: true, catalog: st.catalog, warnings: st.warnings || [],
            };
          }
          const s = f.stats || {};
          const flags = [c.group ? '来源组=' + groupLabel(c.group) : '', c.kind ? '类型=' + c.kind : '', c.stage ? '阶段=' + fdeSchema.stageLabel(c.stage) : '', c.q ? '关键词=' + c.q : '', c.featured ? '仅看重点推荐' : ''].filter(Boolean);
          const lines = [
            `FDE 资料库｜数据日期 ${f.date || '—'}${st.stale ? '（今日尚未更新，宿主会自动更新）' : ''}｜更新于 ${fmtWhen(f.fetchedAt)}｜${catalogText(st)}｜共 ${s.total || 0} 条（国外官方 ${s.intlOfficial || 0}·国内官方 ${s.cnOfficial || 0}·开源 ${s.opensource || 0}·方法模板 ${s.method || 0}·社区 ${s.community || 0}；重点推荐 ${s.featured || 0}；新 ${s.new || 0}；更新 ${s.updated || 0}）`,
          ];
          for (const w of (st.warnings || []).concat(f.warnings || [])) lines.push('⚠ ' + w);
          if (flags.length) lines.push(`筛选：${flags.join('｜')}｜命中 ${c.matched} 条，显示 ${c.items.length} 条`);
          if (c.featured && c.featuredIds.length) {
            const byId = new Map((f.items || []).map((it) => [it.id, it]));
            lines.push('本期重点推荐：' + c.featuredIds.slice(0, 6).map((id) => (byId.get(id) || {}).title || id).join('、'));
          }
          const body = fmtItems(c);
          if (body) lines.push(body);
          lines.push('口径：资料目录人工策展（A/B/C 分级：A 官方一手 / B 二手 / C 社区未核实）；GitHub 指标为抓取时快照；社区动态为摘要非全文（原帖以链接为准）；每日自动更新一次，可 action=refresh 手动刷新。');
          return {
            text: lines.join('\n'),
            ok: true, feed: f, items: c.items, stats: s, featured: c.featuredIds,
            date: f.date || '', fetchedAt: f.fetchedAt || '', catalog: st.catalog,
            total: c.total, matched: c.matched, stale: st.stale,
          };
        } catch (e) { return fdeFail(e); }
      },
      presentCall: (a) => ({ card: 'generic', title: `FDE 资料库：${(a && a.action) || 'feed'}`, kind: 'read' }),
    });

    /* ---------------- 第 10 个 FDE 工具：fde_scenario（场景选择评估，spec §21.1） ----------------
     * 纯函数计算，不写文件、不写 board、不联网：4 条硬门槛 + 12 维归一化加权分（Σ权重 101）
     * + 1–7 否决项 + 档位；返回 ranked + Markdown，由会话落盘到 scoping/。 */
    tools.register({
      name: 'fde_scenario',
      description: 'FDE 工作站：场景选择评估（纯计算，不写文件、不联网）。按 4 条硬门槛（有姓名发起人/14 天首次集成/90 天上线/使用可测量）+ 12 维评分（权重合计 101，按 Σ(分×权重)/101 归一化）+ 1–7 否决项，输出排序、档位（≥3.6 进方案 / 3.2–3.6 补证 / <3.2 拒绝）与可落盘 Markdown。action=template 返回空白评分表。评分只用于排序，不替代人的判断。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['evaluate', 'template'], description: 'evaluate=评估候选场景；template=返回空白评分表' },
          scenarios: {
            type: 'array',
            description: '候选场景（action=evaluate 必填）：每条含 name、gates{sponsor,integration14d,prod90d,measurable}、scores{value/pain/data/tech/accept/compliance/roi/readiness/delivery/reuse/alternative/timing，1–5}、vetoes[1–7]、note',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '场景名（写业务动作，不写系统名）' },
                gates: { type: 'object', description: '四条硬门槛：sponsor/integration14d/prod90d/measurable（true/false）' },
                scores: { type: 'object', description: '12 维分值 1–5：value/pain/data/tech/accept/compliance/roi/readiness/delivery/reuse/alternative/timing' },
                vetoes: { type: 'array', items: { type: 'integer' }, description: '否决项编号 1–7（任一命中 → 不进方案，例外需人签字）' },
                note: { type: 'string', description: '备注' },
              },
            },
          },
        },
        required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      async execute(args) {
        try {
          const a = args || {};
          const r = fdeCalc.evaluateScenario({
            action: a.action === 'template' ? 'template' : (a.action || 'evaluate'),
            scenarios: a.scenarios,
            title: a.title,
          });
          if (!r.ok) return { text: `场景评估失败（${r.code || 'ERROR'}）：${r.reason}`, ok: false, code: r.code, reason: r.reason };
          if (r.action === 'template') {
            return { text: r.markdown, ok: true, action: 'template', markdown: r.markdown, warnings: r.warnings || [] };
          }
          const ranked = r.ranked || [];
          const lines = [
            `场景评估（${ranked.length} 个候选）：归一化口径 = Σ(分值×权重)/${fdeCalc.SCENARIO_WEIGHT_SUM}（权重合计 ${fdeCalc.SCENARIO_WEIGHT_SUM}，不得除以 100）`,
            '| # | 场景 | 归一化分 | 结论 | 缺项/否决 |',
            '|---|---|---|---|---|',
          ];
          ranked.forEach((x, i) => {
            const gatesOk = fdeCalc.SCENARIO_GATES.every((g) => x.gates[g.key]);
            const extra = !gatesOk ? x.missing.join('；') : (x.vetoed ? x.vetoLabels.join('；') : '—');
            lines.push(`| ${i + 1} | ${x.name} | ${x.score} | ${x.conclusion} | ${extra} |`);
          });
          const first = ranked.find((x) => x.eligible);
          lines.push('');
          lines.push(first
            ? `建议：优先「${first.name}」（${first.conclusion}，归一化分 ${first.score}）${first.conclusion === fdeCalc.SCENARIO_GRADE_PASS ? '' : '；先补证或做小 POC，不要直接进方案'}。`
            : '建议：当前没有可进方案的场景（四条硬门槛不全或命中否决项），先补前置条件。');
          for (const w of (r.warnings || [])) lines.push('⚠ ' + w);
          lines.push('口径：评分只用于排序，不替代人的判断；逐维须写依据（空依据按 3 分封顶）；场景最终由人确认。');
          lines.push('完整 Markdown 见返回的 markdown 字段，由会话落盘到 research/<客户>/scoping/。');
          return {
            text: lines.join('\n'),
            ok: true, action: 'evaluate', ranked, markdown: r.markdown, warnings: r.warnings || [], formula: r.formula,
          };
        } catch (e) { return fdeFail(e); }
      },
      presentCall: (a) => ({ card: 'generic', title: `FDE 场景评估：${(a && a.action) || 'evaluate'}`, kind: 'read' }),
    });

    /* ---------------- 第 11 个 FDE 工具：fde_quote（成本测算与报价，spec §21.2） ----------------
     * 纯函数计算，不写文件、不写 board、不联网：三点估算 P80 计价人天 + 7 项非人力
     * + 预备费/税/毛利 → 成本/底线/目标/上限/成交价/实现毛利率；返回 summary + Markdown。 */
    tools.register({
      name: 'fde_quote',
      description: 'FDE 工作站：成本测算与报价（纯计算，不写文件、不联网）。人力支持直接人天或三点估算（P80=te+0.84σ 向上取 0.1 人天，同时给 P50）；非人力 7 项（数据评测/云 token/合规/运维/差旅/质保/其他）；按预备费 15%、毛利 35%、税 6%（默认，来自 reference/fde-pricing.json）算成本底线/目标/上限/成交价与实现毛利率，并给亏损/低毛利/甜点区/漏项/人天不匹配警告。⚠ 结果为方法默认值，不构成对外报价；对外报价必须由人确认。action=template 返回空白模板。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['calculate', 'template'], description: 'calculate=测算；template=返回空白成本测算与报价单模板' },
          engagementId: { type: 'string', description: '客户 id（可选，仅用于标题）' },
          title: { type: 'string', description: '标题（可选）' },
          labor: {
            type: 'array',
            description: '人力行：直接人天用 {name, personDays, rate?}；三点估算用 {name, optimistic, likely, pessimistic, rate?}',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                personDays: { type: 'number' },
                optimistic: { type: 'number' },
                likely: { type: 'number' },
                pessimistic: { type: 'number' },
                rate: { type: 'number', description: '元/人天（省略用 defaultRate）' },
              },
            },
          },
          defaultRate: { type: 'number', description: '默认人天费率（元/人天，默认 940）' },
          nonLabor: {
            type: 'object',
            description: '非人力成本（元）：dataEval/cloudToken/compliance/ops/travel/quality/other',
          },
          contingencyPct: { type: 'number', description: '风险预备费 %（默认 15）' },
          taxPct: { type: 'number', description: '税率 %（默认 6）' },
          marginPct: { type: 'number', description: '目标毛利率 %（默认 35）' },
          discountPct: { type: 'number', description: '折扣 %（默认 0）' },
          teamSize: { type: 'integer', description: '团队人数（用于人天/周期匹配检查）' },
          weeks: { type: 'integer', description: '周期周数（用于人天/周期匹配检查）' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => text(v.text) },
      async execute(args) {
        try {
          const a = args || {};
          const r = fdeCalc.calculateQuote(a);
          if (!r.ok) return { text: `成本测算失败（${r.code || 'ERROR'}）：${r.reason}`, ok: false, code: r.code, reason: r.reason };
          if (r.action === 'template') return { text: r.markdown, ok: true, action: 'template', markdown: r.markdown, warnings: r.warnings || [] };
          const s = r.summary || {};
          const yuan = (v) => '¥' + Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const lines = [
            `成本测算与报价（方法默认值，不构成对外报价）：${a.title || '未命名项目'}${a.engagementId ? '（' + a.engagementId + '）' : ''}`,
            `人力：${s.p80PersonDays} 人天（P80 计价；P50 ${s.p50PersonDays} 人天）｜人力成本 ${yuan(s.laborCost)}｜非人力 ${yuan(s.nonLaborTotal)}`,
            `直接成本 ${yuan(s.directCost)}｜预备费(${s.contingencyPct}%) ${yuan(s.contingency)}｜总成本 ${yuan(s.totalCost)}`,
            `成本底线 ${yuan(s.floor)}｜目标报价 ${yuan(s.target)}｜定价上限 ${yuan(s.ceiling)}｜本次报价 ${yuan(s.final)}`,
            `毛利额（税前）${yuan(s.marginAmount)}｜实现毛利率 ${s.realizedMarginPct}%｜甜点区 ${yuan(s.sweetSpotMin)}–${yuan(s.sweetSpotMax)}`,
          ];
          for (const w of (r.warnings || [])) lines.push('⚠ ' + w);
          lines.push('口径：费率为内部成本费率（默认 ' + yuan(s.defaultRate) + '/人天），来自 reference/fde-pricing.json；对外报价 = 成本 ÷(1−毛利)，必须由人复核确认。');
          lines.push('完整 Markdown 见返回的 markdown 字段，由会话落盘到 research/<客户>/proposal/。');
          return { text: lines.join('\n'), ok: true, action: 'calculate', summary: s, warnings: r.warnings || [], details: r.details, markdown: r.markdown };
        } catch (e) { return fdeFail(e); }
      },
      presentCall: (a) => ({ card: 'generic', title: `FDE 成本报价：${(a && a.action) || 'calculate'}`, kind: 'read' }),
    });

    log('agent 工具已注册（16 个：rw_* 5 + fde_* 11）');
  };

  /* ---------------- agent skills（运行时注册） ----------------
   * skills/<name>/SKILL.md 由 docs-dev 维护；这里只读不写。
   * 服务不可用 / 目录为空 / 单个技能前置元数据不合法：一律静默降级，不影响插件启动。 */
  const registerSkills = () => {
    const svc = svcOfImpl(ctx, 'skills');
    if (!svc || typeof svc.register !== 'function') {
      skillsState.available = false;
      log('skills 服务不可用：技能降级为系统提示词列出 skills/ 路径');
      return;
    }
    skillsState.available = true;
    fdeDeps.skillsAvailable = true;
    let list = [];
    try {
      list = fdeApi.discoverSkills(join(HERE, 'skills'));
    } catch (e) {
      skillsState.error = String((e && e.message) || e);
      list = [];
    }
    let n = 0;
    for (const sk of list) {
      try {
        svc.register({
          name: sk.name,
          description: sk.description,
          content: sk.content,
          path: sk.path,
          resourceBase: sk.resourceBase,
        });
        n += 1;
      } catch { /* 单个技能失败静默；同名 first-wins */ }
    }
    skillsState.registered = n;
    log('FDE 技能已注册 ' + n + ' 个' + (n ? '：' + list.map((x) => x.name).join('、') : '（skills/ 暂无可注册技能）'));
  };

  /* ---------------- 系统提示词 ---------------- */
  const registerPrompt = () => {
    const sp = svcOfImpl(ctx, 'systemPrompt');
    if (!sp || typeof sp.section !== 'function') { log('systemPrompt 不可用'); return; }
    let order = 2950;
    try { if (typeof sp.getSectionOrder === 'function') order = sp.getSectionOrder('TOOL_REPORT'); } catch { /* 默认 */ }
    sp.section({
      name: 'tool:research-workbench',
      order,
      text: [
        '调研工作台 · FDE 工作站能力已装配。',
        '',
        '【FDE 编排者声明】你是 FDE 工作站的编排者：客户（engagement）沿 8 个阶段推进、任务（item）在 5 列看板流转、需要人动作的事汇总为注意力（attention），由看板按阶段模板发起会话，执行会话再向看板回报。',
        '- **唯一编排**：客户经营流程只由 FDE 看板驱动；`rw_*` 是执行工具，不要平行启动第二套流程或另写状态文件。',
        '- **阶段顺序（不可跳阶）**：线索 → 研判 → 会面 → **场景** → 方案 → 试点 → 交付 → 采用（终止：归档 / 流失）。阶段与门禁定义以 `fde_board` / `GET /research-workbench/api/fde/meta` 为准，不要凭记忆硬编码。',
        '- **状态落点**：看板状态在 `research/.fde/board.json`，只通过 `fde_*` 工具与面板读写；不要手改该文件，也不要把状态写进客户卷。',
        '',
        '【何时启用】用户给出「公司名 + 见面对象/职务」并要求调研、出会面材料、写方案，或问「今天该做什么 / 客户到哪一步 / 有什么要处理」时：先用 `fde_board`（或 `fde_brief`）读状态，再按阶段执行。用户也可在左侧「FDE 工作站」面板直接操作看板与今日，并由面板一键发起会话。',
        '',
        '【阶段门禁】进入下一阶段前必须通过门禁：**自动检查**（项目档案 / 事实核查 / KPI 假设 / Brief / 方案 / 试点 / 验收 / 采用证据等文件）+ **人工确认**（人勾选并留证据）。两类都过才算通过；`force` 必须由人给出原因并记录。',
        '',
        '【红线 · 任何自主性模式都不自动】① 推进客户阶段 ② 通过门禁 ③ 标记交付/验收完成 ④ 导出或发送对外材料 ⑤ 删除客户或任务 ⑥ 修改客户卷定稿文件。这些只能由人执行；agent 只准备、建议、提问、提醒。',
        '',
        '【回报协议】执行会话必须用 `fde_item`（action=report）回报：`ready` → 待我审；`blocked` → 等外部并生成注意力；`failed` → 保持进行中并生成注意力；`dropped` → 取消。摘要 ≤300 字 + artifacts 文件路径；长文写文件，不要整段贴进消息。需要人决定时用 `fde_attention`（action=ask）提问，不要自行替人决定。',
        '',
        '【自主性】observe（默认，只生成建议）/ assisted（安全动作一键执行）/ auto（安全动作自动执行）。安全动作仅限：建任务、改下一步、提醒；门禁、对外材料、删除归档、阶段推进永远人工。',
        '',
        '【FDE 工具】`fde_board`（看板 / 简报 / 客户 / 任务）· `fde_engagement`（客户增改移；move/archive/门禁 force 只能人在面板执行，agent 调用会被拒绝）· `fde_item`（任务增改移与回报）· `fde_attention`（注意力唯一通道）· `fde_brief`（今日简报，apply 按自主性执行安全动作）· `fde_harvest`（复盘草稿）· `fde_bid`（招采雷达客户关联层：search/match/link/unlink/promote/timeline）· `fde_library`（FDE 资料库：feed/search/refresh）· `fde_scenario`（场景评估：evaluate/template）· `fde_quote`（成本测算与报价：calculate/template）。',
        '',
        '【招采雷达（v1.1）】`fde_bid` 只做「与客户关联」这一层（检索、匹配、关联公告、提升为跟进任务）；全量深挖用 bid-intel 的 `bid_search` / `bid_timeline` / `bid_batches` / `bid_report`，**不要用 fde_bid 替代**，也不要另写一套检索语义。',
        '- 口径铁律：**候选人 ≠ 中标人**（候选人公示只是评标排序，只有中标/成交公告才算中标）；批次/专项归属是**推断**，不是公告明示；金额只引原文（口径不一，不换算、不求和）。',
        '- 数据缺口如实说明：索引以中国航发专区为主，其他平台覆盖有限，0 命中是数据事实不是 bug；`fde_bid` 返回 `code=UNAVAILABLE`（招采雷达未就绪）时提示用户安装/升级 bid-intel，不得臆造数据。',
        '- `fde_bid` 的 link/unlink/promote 属允许 agent 执行的可逆动作（by=agent 留痕）；推进阶段/过门禁/删除/对外发送仍是人的红线。',
        '',
        '【生财 FDE 情报（v1.2）】`scys_fde` 是只读社区情报：`action=feed` 读今天缓存（帖子/公众号/航海与大会/手册，含摘要与链接），`action=refresh` 立即抓一次。缓存每天自动更新一次；内容为社区公开摘要、**非全文**，引用前点链接核对；无授权/无网络返回 `code`（`UNAUTHORIZED`/`UNAVAILABLE`），如实告知用户在 DSH 重新授权生财 MCP，不要臆造内容；**不调用任何生财写接口**（点赞/投锚/评论/收藏/发帖/关注）。',
        '',
        '【FDE 资料库（v1.3）】`fde_library` 是只读资料层：`action=feed` 读缓存，`search` 按来源组/类型/适用阶段/关键词/仅看重点推荐过滤，`refresh` 刷新一次（GitHub 指标 + 社区动态；宿主每天自动刷新一次）。资料目录 `reference/fde-library/catalog.json` 人工策展、A/B/C 分级（A 官方一手 / B 二手 / C 社区未核实）；GitHub 指标为抓取时快照；社区动态为摘要非全文（原帖以链接为准）。**不抓任意网页正文、不调用外部写接口**；catalog 缺失返回 `code=UNAVAILABLE` 时如实说明，不要臆造资料。',
        '',
        '【场景与报价（v1.3）】`fde_scenario` 是纯计算（不写文件/不联网）：4 条硬门槛（有姓名发起人 / 14 天首次集成 / 90 天上线 / 使用可测量）+ 12 维评分（权重合计 101，按 Σ(分×权重)/101 归一化，**不得除以 100**）+ 1–7 否决项，输出档位（≥3.6 进方案 / 3.2–3.6 补证 / <3.2 拒绝）。`fde_quote` 同样是纯计算：三点估算 P80 计价人天 + 数据评测/云 token/合规/运维等 7 项非人力 + 预备费/税/毛利，输出成本/底线/目标/上限/成交价与实现毛利率。**两者结果都是方法默认值，不构成对外报价**；对外报价与场景决策必须由人确认（红线不变）。Markdown 由会话落盘到 `scoping/`、`proposal/`。',
        '',
        '【七步流程（执行层）】① 立项 → ② 侦察与主体锁定 → ③ 抓取 → ④ 事实核查 → ⑤ KPI与痛点假设 → ⑥ 会面材料 → ⑦ 方案与按需导出。',
        '',
        '【铁律】',
        '1. **先锁主体，再研究特征**：用**地址锚定**（地址反查主体，官网≥2处互证，排除同园区他单位）+ **三链验证**（子公司自述 / 母公司成员清单 / 可疑另一方的排除，且排除链要核验全部分页）。归属结论三链不全时必须降级为「待现场确认」，并准备两种情形，不得替用户下结论。',
        '2. **抓取通道**：本机 `web_fetch` 对全部外网域名报 "resolves to a non-public IP"，**必须改用 bash 里的 `curl`**（用 `scripts/grab.py`），PDF 用 `pdftotext -layout`，DOCX 用 zipfile 解 XML。`web_search` 仅用于发现 URL 与摘要，不用于取正文。',
        '3. **证据分级**：所有事实按 A（官方一手原文）/ B（二手或推算）/ C（必须现场核实）三级标注；C 级**不得作为事实陈述**，须单列「未证实清单」。',
        '4. **数字自检**：占比一律重算、分项求和校验、口径区分（估算/控制价/成交价）、**候选人 ≠ 中标人**。原文件自身矛盾要如实标注。',
        '5. **KPI 与痛点假设**：用对方公开动作反推考核压力（上级/外部董事意见、一把手内部讲话、招聘公告、采购记录），每条标注**置信度 + 依据 + 可提问验证的问法**，明确写"本节全部为假设"。',
        '6. **合作地图**：按客户业务方向分组，每项含"可检查结果 + 卡点"，并**必须写明"我们不做什么"**（边界纪律）；若客户已有下属数智单位，须单列关系设计与协作原则。',
        '7. **对象分层**：一把手讲战略/资产/考核/示范效应；分管副总讲技术可行性与责任边界；执行层讲场景/数据/工期。同一客户多场会面**分别重做材料**。',
        '8. **称谓纪律**：未确认前用中性称呼（"院领导""贵单位领导"）；不得把合作方夸大为集团；不得假设未证实的项目关系。',
        '',
        '【格式约定 · 铁律】默认只交付 **md**，**不要主动导出 PDF**：',
        '- 产出、修改、汇报一律用 md；PDF **仅在用户明确说"要打印/要递交/导 PDF/发文件"时**才用 `rw_export_pdf` 生成到 `exports/`。',
        '- **禁止**在交付时顺手为每个文档生成 PDF；也**禁止**因为"看起来更正式"而导出。',
        '- 用户未要求时，交付说明里**不要提 PDF**。',
        '- 导出后用 `rw_qa_pdf` 自检（致命问题须为 0、缺字须为否；末行残字 1–2 字属可接受）。',
        '- **永远不要手改 PDF**；改 md 后重跑导出即可。',
        '- 若用户要"发微信给别人看"：优先建议**直接发 md 正文或粘贴文本**；确需发文件时提醒对方用「其他应用打开」（微信内置预览对部分 PDF 字体渲染异常，排查方法见 `reference/PDF兼容性核查.md`）。',
        '- **正式对外发送的材料**（递交/邮件附件/打印带进场/投标立项）：md 定版进 `对外材料/<客户卷>/`，再用 `cn-procurement-docs` 技能导出**可编辑 DOCX**（中文公文版式）到该卷 `exports/`；要改写正文时同时加载 `human-writing`。**DOCX 不手改**，改 md 后重出。',
        '- 交付 DOCX 时如实交代核验范围：本机缺仿宋/楷体/方正小标宋、且无 LibreOffice，**未做渲染核验就写"未做"**，不得宣称已通过格式复核。',
        '',
        '【可用工具】FDE：`fde_board` · `fde_engagement` · `fde_item` · `fde_attention` · `fde_brief` · `fde_harvest` · `fde_bid` · `scys_fde`（生财 FDE 情报：feed/refresh）· `fde_library`（资料库）· `fde_scenario`（场景评估）· `fde_quote`（成本报价）；执行：`rw_status`（项目进展）· `rw_scaffold`（立项）· `rw_export_pdf`（按需导出）· `rw_qa_pdf`（版面质检）· `rw_method`（读取方法论与模板）。',
        '',
        '【技能与方法】FDE 技能（宿主可用时注册为 runtime skill）：`fde-engagement` / `fde-discovery` / `fde-meeting` / `fde-scoping`（场景选择：四条硬门槛 + 12 维评分 + 数据体检） / `fde-solution` / `fde-pilot` / `fde-delivery` / `fde-adoption` / `fde-board` / `fde-harvest` / `fde-bid-radar`（招采雷达：查采购史/中标情况、找招标机会、补会面采购证据），按阶段加载；技能服务不可用时按 `methods/` 与 `skills/*/SKILL.md` 路径读取。',
        '',
        '【方法文件】开始调研前，建议先用 `rw_method` 读取「流程」「核查」「KPI」「合作地图」「场景」「成本」「数据源」「雷区」「模板」「对外文档」等文件，避免重复踩坑。',
      ].join('\n'),
    });
    log('系统提示词已注册');
  };

  /* ---------------- 生财 FDE 情报：每天一次的刷新定时器（spec §18.4） ----------------
   * 启动后 20s 检查一次，此后每 30 分钟；maybeRefresh 内部做「每天一次」门控、
   * 失败当天最多重试 3 次、单飞；工作区根解析失败/无服务一律静默跳过，不影响插件启动。
   * 清理走 ctx.effect（卸载即停，spec §18.4）。 */
  const startScysTimer = () => {
    if (typeof ctx.effect !== 'function') { log('ctx.effect 不可用，跳过生财情报定时器'); return; }
    let timer = null;
    let interval = null;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      let root;
      try { root = workspaceRoot(ctx, ''); } catch (e) {
        log('生财情报刷新跳过：无法解析工作区根（' + String((e && e.message) || e) + '）');
        return;
      }
      if (!root) return;
      Promise.resolve()
        .then(() => fdeScys.maybeRefresh(root))
        .catch((e) => log('生财情报刷新失败：' + String((e && e.message) || e)));
    };
    timer = setTimeout(tick, 20 * 1000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    interval = setInterval(tick, 30 * 60 * 1000);
    if (interval && typeof interval.unref === 'function') interval.unref();
    ctx.effect(() => () => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (interval) { clearInterval(interval); interval = null; }
    }, 'research-workbench: scys timer');
    log('生财情报定时器已启动（20s 后首次检查，此后每 30 分钟）');
  };

  /* ---------------- FDE 资料库：每天一次的刷新定时器（spec §19.2） ----------------
   * 启动后 20s 检查一次，此后每 30 分钟；maybeRefresh 内部做「每天一次」门控、
   * 失败当天最多重试 3 次、单飞；catalog 缺失时 maybeRefresh 直接返回 UNAVAILABLE（不联网）。
   * 工作区根解析失败/无服务一律静默跳过，不影响插件启动；清理走 ctx.effect。 */
  const startLibraryTimer = () => {
    if (typeof ctx.effect !== 'function') { log('ctx.effect 不可用，跳过资料库定时器'); return; }
    let timer = null;
    let interval = null;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      let root;
      try { root = workspaceRoot(ctx, ''); } catch (e) {
        log('资料库刷新跳过：无法解析工作区根（' + String((e && e.message) || e) + '）');
        return;
      }
      if (!root) return;
      Promise.resolve()
        .then(() => fdeLibrary.maybeRefresh(root))
        .catch((e) => log('资料库刷新失败：' + String((e && e.message) || e)));
    };
    timer = setTimeout(tick, fdeLibrary.TIMER_START_DELAY_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    interval = setInterval(tick, fdeLibrary.TIMER_INTERVAL_MS);
    if (interval && typeof interval.unref === 'function') interval.unref();
    ctx.effect(() => () => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (interval) { clearInterval(interval); interval = null; }
    }, 'research-workbench: library timer');
    log('资料库定时器已启动（20s 后首次检查，此后每 30 分钟）');
  };

  const results = { routes: null, tools: null, skills: null, prompt: null };
  const mountRoutes = () => {
    try { registerRoutes(); results.routes = 'ok'; } catch (e) { results.routes = 'error:' + String(e?.message || e); }
  };
  try {
    if (svcOfImpl(ctx, 'webServer')) mountRoutes();
    else if (typeof ctx.inject === 'function') {
      results.routes = 'waiting:webServer';
      ctx.inject(['webServer'], () => mountRoutes());
    } else results.routes = 'skipped:no-webServer';
  } catch (e) { results.routes = 'error:' + String(e?.message || e); }
  try { registerTools(); results.tools = 'ok'; } catch (e) { results.tools = 'error:' + String(e?.message || e); }
  try { registerSkills(); results.skills = skillsState.available ? 'ok:' + skillsState.registered : 'degraded'; } catch (e) { results.skills = 'error:' + String(e?.message || e); }
  try { registerPrompt(); results.prompt = 'ok'; } catch (e) { results.prompt = 'error:' + String(e?.message || e); }
  try { startScysTimer(); results.scysTimer = 'ok'; } catch (e) { results.scysTimer = 'error:' + String(e?.message || e); }
  try { startLibraryTimer(); results.libraryTimer = 'ok'; } catch (e) { results.libraryTimer = 'error:' + String(e?.message || e); }
  log('apply 完成 ' + JSON.stringify(results));
}

export { inject, name };
export default { apply, inject, name };
