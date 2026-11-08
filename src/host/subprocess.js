/**
 * 子进程执行层（Phase 3 · 宿主内核加固 / 审查 F-04）
 *
 * 优先使用 DSH 官方 `ctx.subprocess`：provider 负责找出可执行文件、管理进程范围，
 * 并用它自己的脱敏父环境启动（`@deepseek-ai/dsh-subprocess/README.zh.md`：
 * 「从拥有该命令的能力调用 ctx.subprocess」「子进程环境会先移除环境中的凭据与 DSH_* 值」）。
 * 服务缺失或调用失败时回退 `node:child_process.execFile`，但回退路径仍必须：
 *  (1) 用脱敏环境（去掉 `^DSH_` 与凭据形状变量，保留 PATH、HOME、locale、proxy，
 *      与官方 `scrubbedParentEnv()` 同语义、并额外覆盖 credential/auth）；
 *  (2) 显式 cwd（调用方传工作区根，不在宿主进程的 cwd 上跑）；
 *  (3) 有界输出 + 超时（collect 语义：超限保留尾部）。
 *
 * 本模块只依赖 node 内置，不 import @deepseek-ai/*（本插件为 link: 安装）。
 */
import { execFile } from 'node:child_process';

/** 单流收集上限（官方 collect 语义：超出保留尾部）。 */
export const COLLECT_MAX_BYTES = 8 * 1024 * 1024;
/** 默认终止宽限期（官方 spawn spec.graceMs）。 */
export const RUN_GRACE_MS = 5000;
/** 默认执行上限（毫秒）。 */
export const RUN_TIMEOUT_MS = 120000;

/** 凭据形状环境变量（官方 SENSITIVE_ENV_PATTERN 的超集：另含 credential/auth）。 */
export const SENSITIVE_ENV_RE = /KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL|AUTH/i;
/** Harness 保留变量前缀（不转发给子进程）。 */
const DSH_PREFIX = 'DSH_';

/**
 * 脱敏后的父环境：DSH_* 与凭据形状变量不转发；PATH、HOME、locale、proxy 保留。
 * 与 `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv()` 对齐（大小写不敏感）。
 * @param {NodeJS.ProcessEnv} [src] 环境源（测试可注入；默认 process.env）
 * @returns {Record<string,string>} 可安全交给子进程的环境副本
 */
export function scrubbedEnv(src = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(src || {})) {
    if (typeof value !== 'string') continue;
    if (key.toUpperCase().startsWith(DSH_PREFIX)) continue;
    if (SENSITIVE_ENV_RE.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** 从插件 ctx 解析可选服务（与 index.js 的 svcOfImpl 同口径，但失败不抛）。 */
function resolveService(ctx, name) {
  try {
    const direct = ctx && ctx[name];
    if (direct && typeof direct === 'object') return direct;
  } catch { /* 继续走 ctx.get */ }
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch { return undefined; }
}

/** 把结果规整成统一形状。 */
function outcome({ ok, code, stdout, stderr, how, timedOut, signal, reason }) {
  const res = { ok: !!ok, code: code === undefined || code === null ? (ok ? 0 : 1) : code, stdout: String(stdout || ''), stderr: String(stderr || ''), how };
  if (timedOut) res.timedOut = true;
  if (signal) res.signal = signal;
  if (reason) res.reason = String(reason);
  return res;
}

/** 用官方子进程服务执行一次「不交互、有界收集」的命令。 */
async function runViaService(svc, cmd, args, opts) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : RUN_TIMEOUT_MS;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : COLLECT_MAX_BYTES;
  const graceMs = Number(opts.graceMs) > 0 ? Number(opts.graceMs) : RUN_GRACE_MS;
  const cwd = String(opts.cwd || process.cwd());
  const controller = new AbortController();
  let timedOut = false;
  let handle;
  let started = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { controller.abort(); } catch { /* 忽略 */ }
    try { if (handle && typeof handle.terminate === 'function') handle.terminate(); } catch { /* 忽略 */ }
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const exe = typeof svc.resolveExecutable === 'function'
      ? await svc.resolveExecutable(cmd, opts.lookupEnv, controller.signal)
      : cmd;
    handle = svc.spawn({
      argv: [String(exe), ...args.map(String)],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes },
        stderr: { maxBytes },
      },
      graceMs,
      signal: controller.signal,
      ...(opts.env ? { env: opts.env } : {}),
    });
    started = true;
    const read = (reader) => {
      try { return reader && typeof reader.readFrom === 'function' ? reader.readFrom(0).text : ''; } catch { return ''; }
    };
    let done;
    try {
      done = await handle.done;
    } catch (doneError) {
      if (timedOut) {
        return outcome({
          ok: false, code: 'TIMEOUT', how: 'subprocess', timedOut: true,
          stdout: read(handle.collected && handle.collected.stdout),
          stderr: read(handle.collected && handle.collected.stderr),
          reason: `命令超时（${timeoutMs}ms）`,
        });
      }
      /* 进程已启动后 done 拒绝：可能已产生副作用，不能回退重跑；作为本次失败返回。 */
      if (started) {
        return outcome({
          ok: false, code: 'INTERNAL', how: 'subprocess',
          stdout: read(handle.collected && handle.collected.stdout),
          stderr: read(handle.collected && handle.collected.stderr),
          reason: String((doneError && doneError.message) || doneError),
        });
      }
      throw doneError;
    }
    const stdout = read(handle.collected && handle.collected.stdout);
    const stderr = read(handle.collected && handle.collected.stderr);
    const exitCode = done && Number.isInteger(done.exitCode) ? done.exitCode : null;
    return outcome({
      ok: exitCode === 0,
      code: exitCode === null ? 1 : exitCode,
      stdout,
      stderr,
      how: 'subprocess',
      timedOut,
      signal: done && done.signal ? String(done.signal) : '',
      reason: timedOut ? `命令超时（${timeoutMs}ms）` : '',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 回退路径：execFile + 脱敏 env + 显式 cwd。 */
function runViaExecFile(cmd, args, opts) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : RUN_TIMEOUT_MS;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : COLLECT_MAX_BYTES;
  const cwd = String(opts.cwd || process.cwd());
  const env = Object.assign(scrubbedEnv(process.env), opts.env || {});
  return new Promise((resolveResult) => {
    execFile(cmd, args.map(String), { cwd, timeout: timeoutMs, maxBuffer: maxBytes, env }, (err, stdout, stderr) => {
      const errCode = err && err.code !== undefined ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const timedOut = !!(err && (err.killed === true || errCode === 'ETIMEDOUT' || /timed?\s*out|ETIMEDOUT/i.test(String((err && err.message) || ''))));
      resolveResult(outcome({
        ok: !err,
        code: errCode,
        stdout,
        stderr: String(stderr || '') || (err && err.message ? '' : ''),
        how: 'execFile',
        timedOut,
        signal: err && err.signal ? String(err.signal) : '',
        reason: err ? String(err.message || err) : '',
      }));
    });
  });
}

/**
 * 执行一次命令（统一入口）。
 * @param {object} ctx 插件上下文（用于解析可选 `ctx.subprocess`）
 * @param {string} cmd 命令名（PATH 查名或绝对路径）
 * @param {readonly string[]} [args] 参数数组（不经 shell）
 * @param {{cwd?:string, timeoutMs?:number, maxBytes?:number, graceMs?:number,
 *          env?:Record<string,string>, lookupEnv?:Record<string,string>}} [opts]
 *   `cwd` 因子进程工具必须显式传工作区根；`env` 只做显式补充，回退路径会先脱敏父环境。
 * @returns {Promise<{ok:boolean, code:number|string, stdout:string, stderr:string,
 *   how:'subprocess'|'execFile', timedOut?:true, signal?:string, reason?:string}>}
 */
export async function run(ctx, cmd, args = [], opts = {}) {
  if (!cmd || typeof cmd !== 'string') {
    return outcome({ ok: false, code: 'INVALID', how: 'none', reason: '命令不能为空' });
  }
  const svc = resolveService(ctx, 'subprocess');
  if (svc && typeof svc.spawn === 'function') {
    try {
      return await runViaService(svc, cmd, args, opts);
    } catch (primaryError) {
      /* 服务存在但本次调用失败（executable 缺失/远端执行世界不可用等）：退回本地执行，
       * 但保留原因以便诊断（how 仍记 execFile）。 */
      const fallback = await runViaExecFile(cmd, args, opts);
      if (fallback.reason === undefined) fallback.reason = String((primaryError && primaryError.message) || primaryError);
      fallback.fallbackFrom = 'subprocess';
      return fallback;
    }
  }
  return runViaExecFile(cmd, args, opts);
}

export default { run, scrubbedEnv, SENSITIVE_ENV_RE, COLLECT_MAX_BYTES, RUN_GRACE_MS, RUN_TIMEOUT_MS };
