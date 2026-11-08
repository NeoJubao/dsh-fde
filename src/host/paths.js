/**
 * 调研工作台 · 路径安全
 *
 * 所有来自 HTTP 路由 / 工具参数的目录与根路径都必须先经过本模块校验：
 * - `safeDirName`     单段目录名（拒绝分隔符、'.'/'..'、控制字符、超长）
 * - `safeProjectPath` 项目目录解析（保留原 projectBase 在 research/projects/. 中探测的语义），
 *                     resolve + realpath 后必须落在基线目录内，否则抛 PathError
 * - `safeRoot`        工作区根校验（显式传入时必须在已注册 workspace 内、存在且非文件系统根）
 *
 * 本模块只依赖 node 内置，不 import @deepseek-ai/*（本插件为 link: 安装）。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export const ARCHIVE = '00-项目档案.md';
const BASES = ['research', 'projects', '.'];
const MAX_DIR_LEN = 120;

/** 路径校验失败（调用方据此回 400，不算内部错误）。 */
export class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathError';
    this.code = 'INVALID_PATH';
  }
}

/* 严格集合（spec 推荐）：仅字母、数字、点、下划线、连字符。 */
const STRICT_RE = /^[\p{L}\p{N}._-]+$/u;
/* 兼容集合：历史项目名里存在全角括号/全角竖线（如「…（某所）｜…-20261013」）。
 * 仍只允许"单段"：禁止路径分隔符、控制字符与 Windows 保留字符，杜绝穿越。 */
const COMPAT_RE = /^[^\u0000-\u001f\u007f<>:"/\\|?*]+$/u;

/**
 * 校验一个"项目目录名"：必须是单段目录名。
 * @param {unknown} dir - 来自路由 / 工具参数的目录名。
 * @returns {string} 规范化后的目录名。
 * @throws {PathError} 非法时抛出。
 */
export function safeDirName(dir) {
  const name = String(dir ?? '').trim();
  if (!name) throw new PathError('目录名为空');
  if (name === '.' || name === '..') throw new PathError('不允许 . / .. 目录');
  if (name.length > MAX_DIR_LEN) throw new PathError('目录名过长');
  if (name.includes('\0')) throw new PathError('目录名包含非法字符');
  if (!STRICT_RE.test(name) && !COMPAT_RE.test(name)) throw new PathError('目录名包含非法字符');
  return name;
}

/** 把目标路径断言在基线目录内（相等也不允许）。 */
function assertUnder(base, target) {
  const b = resolve(base);
  const t = resolve(target);
  if (t === b || !t.startsWith(b + sep)) throw new PathError('路径越界');
}

/**
 * 解析项目目录，并断言结果落在允许的基线内。
 * 基线探测保留原 `projectBase()` 语义：含 00-项目档案.md 时用其所在基线
 * （research / projects / 工作区根），否则默认 `research/`。
 *
 * @param {string} root - 工作区根（已由 safeRoot 校验）。
 * @param {unknown} dir - 项目目录名（单段）。
 * @param {string} [forceBase] - 强制基线（如 'research'），用于只允许素材目录的旧路由。
 * @returns {{ base: string, path: string, dir: string }}
 * @throws {PathError}
 */
export function safeProjectPath(root, dir, forceBase) {
  const name = safeDirName(dir);
  const rootAbs = resolve(String(root));
  let base = forceBase ? resolve(rootAbs, forceBase) : null;
  if (!base) {
    for (const b of BASES) {
      const candidate = join(rootAbs, b, name);
      if (existsSync(join(candidate, ARCHIVE))) { base = resolve(rootAbs, b); break; }
    }
  }
  if (!base) base = resolve(rootAbs, 'research');
  const target = resolve(base, name);
  assertUnder(base, target);
  assertUnder(rootAbs, target);

  /* 目标已存在时再做一次 realpath 校验，挡住"目录内符号链接指向工作区外"的情况。 */
  if (existsSync(target)) {
    try {
      const real = realpathSync(target);
      let baseReal = base;
      try { baseReal = realpathSync(base); } catch { /* base 不存在时用字面值 */ }
      assertUnder(baseReal, real);
    } catch (e) {
      if (e instanceof PathError) throw e;
      /* realpath 失败（权限等）：保留字面校验结果 */
    }
  }
  return { base, path: target, dir: name };
}

/** 从 workspaceRegistry 返回值里尽力取路径字符串（与 store.pickPath 同口径，模块内自持）。 */
function pickPath(v) {
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

/** 读取已注册工作区路径列表；registry 不可用时返回 null（区别于"可用但为空"）。 */
function registeredRoots(ctx) {
  try {
    const reg = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
    if (!reg || typeof reg !== 'object') return null;
    for (const m of ['list', 'all', 'workspaces']) {
      if (typeof reg[m] !== 'function') continue;
      const v = reg[m]();
      const arr = Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : null);
      if (arr) return arr.map(pickPath).filter(Boolean);
    }
  } catch { /* registry 异常按不可用处理 */ }
  return null;
}

/**
 * 校验显式传入的工作区根。
 * - 未传（空）时返回 ''，由调用方走自动探测；
 * - 传了就必须：resolve 后存在且是目录、不是文件系统根、且（registry 可用时）落在某个已注册工作区内。
 *
 * @param {object} ctx - 插件上下文（用 ctx.get('workspaceRegistry')）。
 * @param {unknown} requested - 调用方传入的 root。
 * @returns {string} 校验后的绝对路径；'' 表示未显式指定。
 * @throws {PathError}
 */
export function safeRoot(ctx, requested) {
  const raw = String(requested ?? '').trim();
  if (!raw) return '';

  let abs;
  try { abs = resolve(raw); } catch { throw new PathError('非法工作区根'); }
  const fsRoot = resolve(sep);
  if (abs === fsRoot) throw new PathError('不允许文件系统根作为工作区');

  let real = abs;
  try { if (existsSync(abs)) real = realpathSync(abs); } catch { /* 保持字面值 */ }
  let st = null;
  try { st = statSync(real); } catch { throw new PathError('工作区根不存在'); }
  if (!st.isDirectory()) throw new PathError('工作区根不是目录');

  /* registry 可用（返回了数组）时一律以白名单为准——即使列表为空也 fail-closed；
   * 只有 registry 完全不可用（null）才退回"存在性 + 非根目录"的最小校验。 */
  const roots = registeredRoots(ctx);
  if (roots !== null) {
    const ok = roots.some((r) => {
      let rr = resolve(r);
      try { if (existsSync(rr)) rr = realpathSync(rr); } catch { /* 字面值 */ }
      return real === rr || real.startsWith(rr + sep);
    });
    if (!ok) throw new PathError('工作区根不在已注册工作区内');
  }
  return real;
}

/**
 * 把工具参数里的路径解析并断言在工作区根内（Phase 3 · 审查 F-04 路径越界）。
 * 与 `safeRoot` 不同：本函数**不抛异常**，返回结构化结果，供工具直接回 `{ok:false, reason}`。
 * 规则：
 * - 相对路径按工作区根解析；绝对路径同样必须落在根内；
 * - 目标已存在：realpath 后仍须在根内（挡住符号链接指向工作区外）；
 * - 目标不存在（如输出 PDF）：父目录必须存在且其 realpath 在根内（挡住经符号链接目录写出根外）。
 *
 * @param {string} root - 工作区根（已由 safeRoot 校验）。
 * @param {unknown} input - 工具参数中的路径（绝对或相对工作区）。
 * @param {{mustExist?:boolean, label?:string}} [opts]
 * @returns {{ok:true,path:string}|{ok:false,reason:string}}
 */
export function resolveInsideRoot(root, input, opts = {}) {
  const label = opts.label || '路径';
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, reason: label + '不能为空' };
  if (raw.includes('\0')) return { ok: false, reason: label + '包含非法字符' };

  const rootAbs = resolve(String(root || ''));
  let rootReal = rootAbs;
  try { if (existsSync(rootAbs)) rootReal = realpathSync(rootAbs); } catch { /* 保持字面值 */ }
  const inside = (p, base) => p === base || p.startsWith(base + sep);

  let abs;
  try { abs = resolve(rootAbs, raw); } catch { return { ok: false, reason: '非法' + label }; }
  if (!inside(abs, rootAbs) && !inside(abs, rootReal)) {
    return { ok: false, reason: label + '越界：必须落在工作区根内' };
  }

  if (existsSync(abs)) {
    let real = abs;
    try { real = realpathSync(abs); } catch { return { ok: false, reason: label + '无法解析真实路径（可能是断链符号链接）' }; }
    if (!inside(real, rootReal)) return { ok: false, reason: label + '越界：符号链接指向工作区外' };
    return { ok: true, path: abs };
  }
  if (opts.mustExist) return { ok: false, reason: label + '不存在：' + abs };

  const parent = dirname(abs);
  if (!existsSync(parent)) return { ok: false, reason: label + '所在目录不存在：' + parent };
  let parentReal = parent;
  try { parentReal = realpathSync(parent); } catch { /* 保持字面值 */ }
  if (!inside(parentReal, rootReal)) return { ok: false, reason: label + '越界：所在目录不在工作区根内' };
  return { ok: true, path: abs };
}
