/**
 * 打包内容检查（A5 · ADR 0004 D3）
 *
 * `npm pack --dry-run --json` 后断言：包内**必须**有运行必需的入口/宿主/客户端/方法/许可，
 * 且**不得**夹带 samples / src/ui / verify / tools / docs / 历史报告等发布集排除项。
 * 背景：package.json 的 `files` 曾漏掉 cordis.patch.yml，一旦打包发布 bundle 就装不上；
 * 开源改造后 `files` 又必须把构建脚本、测试、私有内容挡在包外。
 * 用法: node verify/pack.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* npm 日志/缓存默认写 ~/.npm；该目录可能被别的账户写过导致 EPERM。
 * 打包检查不需要网络与缓存，指向临时目录即可，避免把环境问题误判成代码问题。 */
const NPM_CACHE = mkdtempSync(join(tmpdir(), 'npm-pack-cache-'));
const fail = [];
const ok = [];
const check = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || !extra ? '' : ' → ' + extra));
  (cond ? ok : fail).push(name);
};

/* 运行/发布必需项：bundle 补丁、宿主入口、客户端产物、宿主源码、方法/技能/模板/参考、
 * 脚本（含导出与版本检查）、locale、许可与 README。 */
const NEED = [
  'package.json',
  'cordis.patch.yml',
  'index.js',
  'client.js',
  'icon.svg',
  'src/host/fde-api.js',
  'src/host/fde-schema.js',
  'src/host/subprocess.js',
  'methods/00-调研执行流程.md',
  'methods/05-正式对外文档交付（DOCX·公文版式）.md',
  'skills/fde-engagement/SKILL.md',
  'skills/longdoc-brief/SKILL.md',
  'templates/项目档案模板.md',
  'reference/fde-pricing.json',
  'reference/fde-library/catalog.json',
  'scripts/grab.py',
  'scripts/health-check.mjs',
  'scripts/check-readme-version.mjs',
  'scripts/md2docx.py',
  'locale/zh.json',
  'LICENSE',
  'LICENSE-docs',
  'README.md',
  'CHANGELOG.md',
];
/* 禁止项（发布集排除：ADR 0004 D3/D4）。 */
const FORBIDDEN = [
  ['samples', /(?:^|\/)samples\//],
  ['src/ui', /^src\/ui\//],
  ['verify/', /^verify\//],
  ['tools/', /^tools\//],
  ['docs/', /^docs\//],
  ['examples/（仓库示例不进包）', /^examples\//],
  ['assets/（README 截图不进包）', /^assets\//],
  ['build.mjs（构建脚本不进包）', /^build\.mjs$/],
  ['docs-workbench.md（旧文档已移出）', /docs-workbench\.md$/],
  ['历史审计报告 *-report.md', /-report\.md$/],
  ['PDF 样本', /\.pdf$/i],
];

let stdout = '';
try {
  stdout = execFileSync('npm', ['pack', '--dry-run', '--json', '--cache', NPM_CACHE], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
    env: { ...process.env, npm_config_cache: NPM_CACHE, npm_config_update_notifier: 'false' },
  });
} catch (e) {
  console.log('  ✗ npm pack --dry-run 执行失败：' + String((e && (e.stderr || e.message)) || e));
  process.exit(1);
}

let files = [];
let meta = {};
try {
  /* npm 12 输出"以包名为 key 的对象"，旧版 npm 输出数组；两种都接受。 */
  const text = stdout.trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    const at = text.indexOf('{');
    if (at === -1) throw new Error('输出里没有 JSON 对象');
    parsed = JSON.parse(text.slice(at));
  }
  const entry = Array.isArray(parsed) ? parsed[0] : (parsed.files ? parsed : Object.values(parsed)[0]);
  meta = entry && entry.name ? entry : {};
  files = (entry && entry.files ? entry.files : []).map((f) => String(f.path || f).replace(/^package\//, ''));
} catch (e) {
  console.log('  ✗ 无法解析 npm pack --json 输出：' + String((e && e.message) || e));
  console.log(stdout.slice(0, 400));
  process.exit(1);
}

/* 0) 包元数据 */
check('包内文件数 > 0', files.length > 0, '实际 ' + files.length);
check('包名 = dsh-fde', meta.name === 'dsh-fde', meta.name);
check('包版本 = 1.3.0', meta.version === '1.3.0', meta.version);
check('包可发布（非 private）', meta.private !== true, meta.private);

/* 1) 必需文件 */
const set = new Set(files);
for (const f of NEED) {
  check('包内含 ' + f, set.has(f), '实际包内 ' + files.length + ' 个文件');
}

/* 2) 禁止项 */
for (const [label, re] of FORBIDDEN) {
  const hit = files.filter((f) => re.test(f));
  check('包内不含 ' + label, hit.length === 0, hit.slice(0, 5).join('、'));
}

console.log('\n包内文件（' + files.length + '）：');
for (const f of files) console.log('  - ' + f);

console.log('\n=== 通过 ' + ok.length + ' 项 ===');
if (fail.length) {
  console.log('\n=== 失败 ' + fail.length + ' 项 ===');
  for (const f of fail) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('打包内容检查通过。');
