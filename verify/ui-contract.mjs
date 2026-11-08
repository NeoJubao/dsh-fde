/**
 * UI 契约体检 · advisory 汇总（不阻断发布）
 *
 * 做什么：运行 `docs/ui-contract/audit-ui-contract.mjs --json`（8 项检查），
 *        汇总 PASS/FAIL/INFO，打印「drift N 项」与迁移目标；再跑一次 `--selftest`，
 *        确认体检脚本「故意写错会变红」（non-vacuity 自检）。
 *
 * 为什么永远 exit 0：本脚本是 **advisory**。契约 v1 刚并入，迁移（data-region 标注、
 *        token 替换、页内重复控件、hover 包裹）尚未完成——A4/A5/A7/A8 在迁移期会一直 FAIL。
 *        这些失败不阻断 `verify/all.mjs` 与开源发布；它们记在 drift 里，由迁移批次消。
 *        真正阻断发布的检查是 `verify/open-source.mjs` / `verify/pack.mjs` / `health-check`。
 *
 * 迁移目标：`docs/ui-contract/layout.md`（附录 C 迁移清单）、`docs/ui-contract/README.md` §6。
 *
 * 用法：node verify/ui-contract.mjs [--json]
 * 输出：一行人读摘要；`--json` 时只打 JSON（含 drift 明细）。
 * 边界：只读；不联网；不改任何文件；找不到体检脚本时记 INFO 跳过（干净检出/裁剪包不报错）。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const AUDIT = join(ROOT, 'docs', 'ui-contract', 'audit-ui-contract.mjs');
const JSON_ONLY = process.argv.includes('--json');
const say = (...a) => { if (!JSON_ONLY) console.log(...a); };

/** 跑子进程（node 内置；不继承 stdio，避免把审计 JSON 原样刷屏）。 */
function runNode(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: ROOT, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) code = typeof err.code === 'number' ? err.code : 1;
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
}

/** 从审计输出里取最后一行 AUDIT-JSON。 */
function parseAudit(stdout) {
  const lines = String(stdout || '').split('\n').filter((l) => l.startsWith('AUDIT-JSON '));
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1].slice('AUDIT-JSON '.length)); } catch { return null; }
}

const summarize = (data) => {
  const checks = Array.isArray(data && data.checks) ? data.checks : [];
  const by = (status) => checks.filter((c) => c.status === status).map((c) => c.id);
  return {
    total: checks.length,
    pass: by('PASS'),
    fail: by('FAIL'),
    info: by('INFO'),
    warn: by('WARN'),
    summary: data && data.summary ? data.summary : null,
    source: data && data.source ? data.source : '(未知)',
  };
};

const main = async () => {
  const result = { advisory: true, ok: true, drift: 0, failIds: [], passIds: [], infoIds: [], selftest: 'skipped' };

  if (!existsSync(AUDIT)) {
    result.skipped = '缺少 docs/ui-contract/audit-ui-contract.mjs';
    result.reason = '契约体检脚本不在（裁剪包/旧检出均可能）——advisory 跳过，不算失败';
    if (JSON_ONLY) console.log(JSON.stringify(result, null, 2));
    else console.log('INFO  UI 契约体检跳过：' + result.reason);
    return;
  }

  const audit = await runNode([AUDIT, '--json']);
  const data = parseAudit(audit.stdout);
  if (!data) {
    result.skipped = '审计输出无法解析';
    result.reason = 'advisory 跳过（exit ' + audit.code + '）：' + String(audit.stderr || '').split('\n')[0];
    if (JSON_ONLY) console.log(JSON.stringify(result, null, 2));
    else console.log('INFO  UI 契约体检跳过：' + result.reason);
    return;
  }

  const s = summarize(data);
  result.drift = s.fail.length;
  result.failIds = s.fail;
  result.passIds = s.pass;
  result.infoIds = s.info;
  result.source = s.source;
  result.summary = s.summary;

  if (!JSON_ONLY) {
    say('UI 契约体检（advisory，不阻断）');
    say('  源码：' + s.source + '（audit 8 项）');
    for (const c of (data.checks || [])) {
      const first = Array.isArray(c.lines) && c.lines.length ? ' — ' + String(c.lines[0]).replace(/\s+/g, ' ').slice(0, 90) : '';
      say('  ' + String(c.status).padEnd(5) + ' ' + c.id + first);
    }
    say('  drift ' + s.fail.length + ' 项' + (s.fail.length ? '（' + s.fail.join(' / ') + '）' : '') +
      '；迁移目标见 docs/ui-contract/layout.md（附录 C）与 README §6');
  }

  /* non-vacuity 自检：故意违规的 fixture 必须让 audit 变红（exit 1 且 FAIL ≥ 3）。 */
  const selftest = await runNode([AUDIT, '--selftest', '--json']);
  const st = parseAudit(selftest.stdout);
  const stFail = st && Array.isArray(st.checks) ? st.checks.filter((c) => c.status === 'FAIL').length : 0;
  if (selftest.code === 1 && stFail >= 3) {
    result.selftest = 'ok';
    say('  自测 PASS：故意违规 fixture → exit 1，FAIL ' + stFail + ' 项（体检脚本不是永远绿）');
  } else {
    result.selftest = 'unexpected';
    say('  自测 INFO：预期 exit 1 且 FAIL ≥ 3，实际 exit ' + selftest.code + ' / FAIL ' + stFail +
      '（advisory，记录不阻断）');
  }

  if (JSON_ONLY) console.log(JSON.stringify(result, null, 2));
  else console.log('INFO  UI 契约为 advisory：drift ' + result.drift + ' 项不阻断 verify/all.mjs 与发布');
};

main()
  .catch((e) => {
    /* advisory：任何异常都只记录，不改变退出码。 */
    if (JSON_ONLY) console.log(JSON.stringify({ advisory: true, ok: true, skipped: 'exception', reason: String((e && e.message) || e) }, null, 2));
    else console.log('INFO  UI 契约体检异常（advisory，跳过）：' + String((e && e.message) || e));
  })
  .finally(() => process.exit(0));
