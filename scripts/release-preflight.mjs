#!/usr/bin/env node
/**
 * 发布预检（release preflight）—— 零依赖、串行、只读
 *
 * 做什么（按序）：
 *   0) 环境：Node 版本满足 package.json.engines.node（当前 >=20）
 *   1) README 版本一致性     scripts/check-readme-version.mjs（阻断）
 *   2) 开源发布检查          verify/open-source.mjs（阻断：身份/许可/白名单/隐私/构建一致）
 *   3) 打包内容              verify/pack.mjs（阻断：npm pack --dry-run 内容断言）
 *   4) 健康检查              scripts/health-check.mjs（阻断：FAIL 即失败，WARN 可接受）
 *   5) UI 契约体检 advisory  verify/ui-contract.mjs（不阻断：迁移期 A4/A5/A7/A8 预期为红，只记 drift）
 *   全部通过后打印 git / npm 发布命令（由人执行）。
 *
 * 明确不做：不联网（npm pack 用临时 cache、--dry-run）、不发布、不改任何文件、不执行 git 命令。
 * 用法：node scripts/release-preflight.mjs [--verbose] [--help]
 * 退出码：0 全部通过 / 1 有阻断项失败 / 2 运行错误（找不到仓库根）
 * 发布手册：docs/RELEASE.md
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log([
    '发布预检（零依赖、串行、只读）',
    '',
    '用法：node scripts/release-preflight.mjs [--verbose] [--help]',
    '',
    '串行检查：',
    '  0. Node 版本（package.json.engines.node）',
    '  1. README 版本一致性        scripts/check-readme-version.mjs  [阻断]',
    '  2. 开源发布检查             verify/open-source.mjs             [阻断]',
    '  3. 打包内容                 verify/pack.mjs                    [阻断]',
    '  4. 健康检查                 scripts/health-check.mjs           [阻断]',
    '  5. UI 契约体检              verify/ui-contract.mjs             [advisory]',
    '',
    '通过后打印 git tag / npm publish 命令（人工执行）。不联网、不发布、不改文件。',
    '发布手册：docs/RELEASE.md',
  ].join('\n'));
  process.exit(0);
}
const VERBOSE = args.includes('--verbose');

const USAGE = '发布预检（零依赖、串行、只读）；详见 docs/RELEASE.md';
const pkgFile = join(ROOT, 'package.json');
if (!existsSync(pkgFile)) {
  console.error('发布预检运行错误：找不到 ' + pkgFile + '（请在插件根目录或仓库内执行）');
  process.exit(2);
}
let pkg;
try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')); } catch (e) {
  console.error('发布预检运行错误：package.json 无法解析：' + String((e && e.message) || e));
  process.exit(2);
}
const NAME = String(pkg.name || 'dsh-fde');
const VERSION = String(pkg.version || '');
const TAG = 'v' + VERSION;

const pad = (s, n) => String(s).padEnd(n, ' ');

/** 单步子进程（捕获输出，成功/失败都给摘要）。 */
function runNode(script, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [join(ROOT, script)], {
      cwd: ROOT, timeout: timeoutMs || 240000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, npm_config_update_notifier: 'false' },
    }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === 'number' ? err.code : 1;
      resolve({
        code,
        ok: !err,
        ms: Date.now() - started,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

/** 取输出末尾 n 行（失败诊断用；避免整段刷屏）。 */
const tail = (text, n = 14) => {
  const lines = String(text || '').split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-n).map((l) => '      ' + l).join('\n');
};

/** 从 ui-contract advisory 输出里取 drift 数。 */
const driftOf = (text) => {
  const m = /drift\s+(\d+)\s*项/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
};

console.log(USAGE);
console.log('包：' + NAME + '@' + VERSION + ' ｜ Node ' + process.version + ' ｜ 模式：只读预检（不联网/不发布）');
console.log('—'.repeat(72));

const results = [];

/* 0) 环境：Node 版本（只做最低主版本判断，避免引 semver 依赖）。 */
{
  const need = String((pkg.engines && pkg.engines.node) || '>=20');
  const m = />=\s*(\d+)/.exec(need);
  const minMajor = m ? Number(m[1]) : 20;
  const major = Number(process.versions.node.split('.')[0]);
  const ok = Number.isFinite(major) && major >= minMajor;
  results.push({ name: '环境：Node 版本', blocking: true, ok, ms: 0, detail: '需要 ' + need + '，当前 ' + process.version });
  console.log((ok ? '✓ ' : '✗ ') + pad('环境：Node 版本', 34) + '需要 ' + need + '，当前 ' + process.version);
}

const CHECKS = [
  { script: 'scripts/check-readme-version.mjs', name: 'README 版本一致性', blocking: true, hint: '改 README 顶部版本或 package.json.version，使两者一致' },
  { script: 'verify/open-source.mjs', name: '开源发布检查（身份/许可/隐私）', blocking: true, hint: '按输出逐项修；发布集不得有客户词/个人主目录路径' },
  { script: 'verify/pack.mjs', name: '打包内容（npm pack --dry-run）', blocking: true, hint: '检查 package.json files 白名单与包内必需文件' },
  { script: 'scripts/health-check.mjs', name: '健康检查', blocking: true, hint: 'FAIL 必修；WARN 属预期（见 docs/RELEASE.md §7）' },
  { script: 'verify/ui-contract.mjs', name: 'UI 契约体检（advisory）', blocking: false, hint: 'advisory：迁移期 drift 不阻断，记录数字即可（迁移计划见 docs/ui-contract/README.md §6）' },
];

for (const c of CHECKS) {
  const path = join(ROOT, c.script);
  if (!existsSync(path)) {
    const ok = !c.blocking;
    results.push({ name: c.name, blocking: c.blocking, ok, ms: 0, detail: '脚本不存在：' + c.script });
    console.log((ok ? '✓ ' : '✗ ') + pad(c.name, 34) + (ok ? '跳过（脚本不存在，advisory）' : '脚本不存在：' + c.script));
    continue;
  }
  const r = await runNode(c.script);
  const ok = c.blocking ? r.ok : true; /* advisory：无论退出码都不算失败 */
  let extra = '';
  if (!c.blocking) {
    const d = driftOf(r.stdout + r.stderr);
    extra = 'drift ' + (d === null ? '?' : d + ' 项') + '（不阻断）';
  } else {
    extra = r.ok ? '通过' : '失败（exit ' + r.code + '）';
  }
  results.push({ name: c.name, blocking: c.blocking, ok, ms: r.ms, detail: extra });
  console.log((ok ? '✓ ' : '✗ ') + pad(c.name, 34) + extra + '  ' + (r.ms / 1000).toFixed(1) + 's');
  if (!ok) {
    console.log(tail(r.stdout + '\n' + r.stderr));
    console.log('    → ' + c.hint);
  } else if (VERBOSE && c.blocking) {
    console.log(tail(r.stdout, 4));
  }
}

console.log('—'.repeat(72));
const failed = results.filter((r) => r.blocking && !r.ok);
const advisory = results.filter((r) => !r.blocking);
if (failed.length) {
  console.log('✗ 发布预检未通过：' + failed.length + ' 项阻断失败');
  for (const r of failed) console.log('  ✗ ' + r.name);
  console.log('  修完后重跑：node scripts/release-preflight.mjs');
  console.log('  清单与回滚：docs/RELEASE.md');
  process.exit(1);
}

console.log('✓ 发布预检通过：' + NAME + '@' + VERSION + '（阻断项 ' + results.filter((r) => r.blocking).length + ' 项全过' +
  (advisory.length ? '；advisory ' + advisory.map((r) => r.name.replace(/（.*$/, '') + ' ' + r.detail).join('、') : '') + '）');
console.log('');
console.log('下一步（人工执行；本脚本不联网、不发布）：');
console.log('  1) git status && git add -A && git commit -m "release: ' + TAG + '"');
console.log('  2) git tag -a ' + TAG + ' -m "' + NAME + ' ' + TAG + '"');
console.log('  3) git push origin main --tags');
console.log('  4) npm publish --dry-run        # 先干跑看清单（约 60+ 文件）');
console.log('  5) npm publish --access public');
console.log('  6) 发布后验证：dsh plugin --profile releasecheck add ' + NAME);
console.log('  未完成前不要跳过 docs/RELEASE.md §9 的人工确认清单。');
