/**
 * 一键验证：宿主冒烟 + 客户端静态检查 + 脚本可用性
 * 用法: node verify/all.mjs
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const run = (cmd, args) => new Promise((res) => {
  execFile(cmd, args, { cwd: ROOT, timeout: 120000 }, (err, stdout, stderr) => {
    res({ ok: !err, out: String(stdout || ''), err: String(stderr || '') });
  });
});

let failed = 0;
const step = async (label, cmd, args) => {
  process.stdout.write('\n── ' + label + ' ──\n');
  const r = await run(cmd, args);
  process.stdout.write(r.out || '');
  if (!r.ok) { process.stdout.write((r.err || '') + '\n✗ ' + label + ' 失败\n'); failed++; }
  else process.stdout.write('✓ ' + label + '\n');
};

// 0) 必备文件
process.stdout.write('── 必备文件 ──\n');
const need = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml',
  'LICENSE', 'LICENSE-docs', 'CHANGELOG.md', 'locale/zh.json',
  'AGENTS.md', 'REVIEW.md',
  'docs/00-intent.md', 'docs/01-spec.md', 'docs/02-plan.md', 'docs/adr/0001-fde-workstation.md',
  'docs/adr/0002-bid-intel-integration.md', 'docs/adr/0003-fde-library-and-process-v2.md',
  'scripts/grab.py', 'scripts/md2html.py', 'scripts/make-pdf.sh', 'scripts/qa-pdf.py',
  'scripts/health-check.mjs',
  'skills/fde-engagement/SKILL.md', 'skills/fde-scoping/SKILL.md', 'skills/fde-board/SKILL.md', 'skills/fde-harvest/SKILL.md', 'skills/longdoc-brief/SKILL.md',
  'methods/00-调研执行流程.md', 'methods/06-场景选择与数据体检.md', 'methods/07-成本评估与报价.md',
  'templates/项目档案模板.md', 'templates/场景评估表.md', 'templates/成本测算与报价单.md',
  'reference/fde-pricing.json', 'reference/fde-library/catalog.json',
  /* 开源发布配套（ADR 0004 D3/D4）：合成示例与 README 截图资产（仓库级，不进 npm 包） */
  'examples/README.md', 'examples/research/某集团-20260101/00-项目档案.md',
  'assets/screenshot-today.png', 'assets/screenshot-board.png', 'assets/screenshot-library.png'];
for (const f of need) {
  const ok = existsSync(join(ROOT, f));
  process.stdout.write((ok ? '  ✓ ' : '  ✗ ') + f + '\n');
  if (!ok) failed++;
}

await step('宿主冒烟测试', 'node', [join(HERE, 'host-smoke.mjs')]);
await step('路由安全守卫测试（A2+A3）', 'node', [join(HERE, 'security.mjs')]);
await step('FDE 宿主内核测试（schema/store/rules/api/门禁/回报）', 'node', [join(HERE, 'fde-host.mjs')]);
await step('生财 FDE 情报宿主单测（mock MCP，不联网）', 'node', [join(HERE, 'fde-scys-host.mjs')]);
await step('FDE 资料库宿主单测（mock GitHub，不联网）', 'node', [join(HERE, 'fde-library-host.mjs')]);
await step('FDE 计算工具单测（场景评分/成本报价，不联网）', 'node', [join(HERE, 'fde-tools.mjs')]);
await step('独立审计（verifier：契约/安全/并发/红线/一致性）', 'node', [join(HERE, 'acceptance-audit.mjs')]);
await step('客户端静态检查', 'node', [join(HERE, 'client-static.mjs')]);
await step('FDE 面板静态验收（九页签/兼容页/主题 token）', 'node', [join(HERE, 'fde-client.mjs')]);
await step('客户端准运行时测试（面板渲染 + 九页签 + Finder 按钮）', 'node', [join(HERE, 'client-runtime.mjs')]);
await step('README 版本一致性（README 顶部/声明版本 ⇄ package.json.version）', 'node', [join(ROOT, 'scripts', 'check-readme-version.mjs')]);
await step('开源发布检查（ADR 0004：身份/许可/白名单/隐私/构建一致）', 'node', [join(HERE, 'open-source.mjs')]);
await step('打包内容检查（A5）', 'node', [join(HERE, 'pack.mjs')]);
await step('插件自检（skills/board/docs/绝对路径/产物一致）', 'node', [join(ROOT, 'scripts', 'health-check.mjs')]);
// 导出脚本自检：无参应打印用法并以非零码退出（期望行为），故单独判定
process.stdout.write('\n── 导出脚本自检 ──\n');
{
  const r = await run('bash', [join(ROOT, 'scripts', 'make-pdf.sh')]);
  const printed = (r.err + r.out).includes('用法');
  if (printed && !r.ok) process.stdout.write('  ✓ 无参时打印用法并退出（符合预期）\n');
  else { process.stdout.write('  ✗ 无参行为异常\n'); failed++; }
}

await step('UI 契约体检（advisory，始终 exit 0，不改变全绿判定）', 'node', [join(HERE, 'ui-contract.mjs')]);
process.stdout.write('\n' + (failed ? `✗ 共 ${failed} 项失败\n` : '✓ 全部验证通过\n'));
process.exit(failed ? 1 : 0);
