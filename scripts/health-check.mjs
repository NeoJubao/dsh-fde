#!/usr/bin/env node
/**
 * FDE 工作站健康检查（零依赖，纯 node）
 *
 * 用法：
 *   node scripts/health-check.mjs           # 逐项 OK/WARN/FAIL + JSON 摘要
 *   node scripts/health-check.mjs --json    # 只输出 JSON 摘要（供脚本消费）
 *   FDE_WORKSPACE=<工作区根> node scripts/health-check.mjs   # 显式指定 board 所在工作区
 *
 * 判定规则：
 *   FAIL  交付/契约硬项缺失或非法（技能 frontmatter、必需文件、资料库目录缺失/非法、定价配置非法、依赖约束、board 损坏、交付文本绝对路径）→ exit 1
 *   WARN  集成未完成或并行开发中的状态（宿主未重启/未合入、client.js 待重建、docs/evaluation 待 Lead 交付、招采雷达索引缺失、资料库/生财缓存未刷新、catalog 条目偏少）
 *   OK    通过
 *
 * 说明：本脚本只读，不写任何文件、不联网；全部检查可在等待宿主重启前运行。
 */
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const JSON_ONLY = process.argv.includes('--json');

const FDE_SKILLS = [
  'fde-engagement', 'fde-discovery', 'fde-meeting', 'fde-scoping', 'fde-solution', 'fde-pilot',
  'fde-delivery', 'fde-adoption', 'fde-board', 'fde-harvest', 'fde-bid-radar',
];

const records = [];
const add = (level, name, detail = '') => records.push({ level, name, detail });
const OK = (name, detail = '') => add('ok', name, detail);
const WARN = (name, detail = '') => add('warn', name, detail);
const FAIL = (name, detail = '') => add('fail', name, detail);

const p = (rel) => join(ROOT, rel);
const read = (rel) => readFileSync(p(rel), 'utf8');

/** 递归列出目录下的文件（跳过 node_modules、.git、隐藏目录）。 */
function walk(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ─── 1. 必需文件 ─────────────────────────────────────────── */
const REQUIRED = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'build.mjs',
  'README.md',
  'AGENTS.md',
  'REVIEW.md',
  'docs/00-intent.md',
  'docs/01-spec.md',
  'docs/02-plan.md',
  'docs/adr/0001-fde-workstation.md',
  'docs/retros/README.md',
  'docs/retros/2026-11-03-fde-workstation-build.md',
  'methods/00-调研执行流程.md',
  'methods/01-事实核查协议.md',
  'methods/06-场景选择与数据体检.md',
  'methods/07-成本评估与报价.md',
  'templates/场景评估表.md',
  'templates/成本测算与报价单.md',
  'reference/雷区清单.md',
  'reference/fde-pricing.json',
  'skills/fde-scoping/SKILL.md',
  'scripts/health-check.mjs',
  /* 开源发布身份（ADR 0004 D1/D2）：包名 dsh-fde、代码 MIT、内容 CC BY 4.0、CHANGELOG、locale */
  'LICENSE',
  'LICENSE-docs',
  'CHANGELOG.md',
  'locale/zh.json',
];
{
  const missing = REQUIRED.filter((f) => !existsSync(p(f)));
  if (missing.length) FAIL(`必需文件（${REQUIRED.length} 项）`, '缺失：' + missing.join('、'));
  else OK(`必需文件（${REQUIRED.length} 项）`, '全部存在');
}
if (!existsSync(p('docs/evaluation.md'))) {
  WARN('docs/evaluation.md', '尚未生成（由 Lead 在集成验收前交付；缺失不阻断本检查）');
}

/* ─── 1b. FDE 资料库目录（策展层，spec §19.1；缺失 FAIL、<50 条 WARN） ─── */
{
  const rel = 'reference/fde-library/catalog.json';
  if (!existsSync(p(rel))) {
    FAIL('FDE 资料库目录', `缺失 ${rel}（策展层交付物；缺失时资料库降级为不可用）`);
  } else {
    try {
      const catalog = JSON.parse(read(rel));
      const problems = [];
      if (!catalog || typeof catalog !== 'object') problems.push('不是对象');
      if (catalog && !Array.isArray(catalog.items)) problems.push('items 不是数组');
      if (catalog && catalog.version !== 1) problems.push(`version=${JSON.stringify(catalog && catalog.version)}（应为 1）`);
      if (problems.length) {
        FAIL('FDE 资料库目录', 'catalog.json 校验失败：' + problems.join('；'));
      } else if (catalog.items.length < 50) {
        WARN('FDE 资料库目录', `items=${catalog.items.length}（<50，低于 spec §19.1 预期规模）`);
      } else {
        OK('FDE 资料库目录', `catalog.json 可解析，version=${catalog.version}，updatedAt=${catalog.updatedAt || '(空)'}，items=${catalog.items.length}`);
      }
    } catch (e) {
      FAIL('FDE 资料库目录', `catalog.json 无法解析：${e && e.message ? e.message : e}`);
    }
  }
}

/* ─── 1c. 定价配置（spec §21.3；JSON 合法 + 默认值可用） ─── */
{
  const rel = 'reference/fde-pricing.json';
  if (!existsSync(p(rel))) {
    WARN('定价配置', `${rel} 不存在（REQUIRED 已记 FAIL；工具会用内置默认值并给 warning）`);
  } else {
    try {
      const cfg = JSON.parse(read(rel));
      const problems = [];
      const d = cfg && cfg.defaults;
      if (!d || typeof d !== 'object') {
        problems.push('缺 defaults');
      } else {
        const need = ['ratePerPersonDay', 'contingencyPct', 'taxPct', 'marginPct', 'discountPct', 'sweetSpotMin', 'sweetSpotMax'];
        for (const k of need) if (typeof d[k] !== 'number' || !Number.isFinite(d[k])) problems.push(`defaults.${k} 不是数字`);
        if (typeof d.ratePerPersonDay === 'number' && d.ratePerPersonDay <= 0) problems.push('defaults.ratePerPersonDay ≤ 0');
        if (typeof d.marginPct === 'number' && (d.marginPct < 0 || d.marginPct >= 90)) problems.push('defaults.marginPct 超出 0–89.99');
        if (typeof d.taxPct === 'number' && (d.taxPct < 0 || d.taxPct >= 100)) problems.push('defaults.taxPct 超出 0–99.99');
        if (typeof d.contingencyPct === 'number' && (d.contingencyPct < 0 || d.contingencyPct > 100)) problems.push('defaults.contingencyPct 超出 0–100');
        if (typeof d.sweetSpotMin === 'number' && typeof d.sweetSpotMax === 'number' && d.sweetSpotMin > d.sweetSpotMax) problems.push('sweetSpotMin > sweetSpotMax');
      }
      if (!Array.isArray(cfg && cfg.rateCard) || cfg.rateCard.length === 0) problems.push('rateCard 为空或不是数组');
      if (typeof (cfg && cfg.disclaimer) !== 'string' || !cfg.disclaimer) problems.push('缺 disclaimer');
      if (problems.length) {
        FAIL('定价配置', 'fde-pricing.json 非法：' + problems.join('；'));
      } else {
        OK('定价配置', `fde-pricing.json 合法（默认费率 ${cfg.defaults.ratePerPersonDay}/人天，毛利 ${cfg.defaults.marginPct}%，税 ${cfg.defaults.taxPct}%，费率卡 ${cfg.rateCard.length} 项）`);
      }
    } catch (e) {
      FAIL('定价配置', `fde-pricing.json 无法解析：${e && e.message ? e.message : e}`);
    }
  }
}

/* ─── 2. 十一个 FDE 技能：frontmatter 与结构 ───────────────── */
function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return null;
  const head = text.slice(4, end);
  const body = text.slice(end + 5);
  const fm = {};
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, body };
}

{
  const fmProblems = [];
  const styleWarns = [];
  let present = 0;
  for (const name of FDE_SKILLS) {
    const rel = `skills/${name}/SKILL.md`;
    if (!existsSync(p(rel))) { fmProblems.push(`${rel} 不存在`); continue; }
    present++;
    const parsed = parseFrontmatter(readFileSync(p(rel), 'utf8'));
    if (!parsed) { fmProblems.push(`${name}: 缺少合法 frontmatter（须以 --- 开头并以单独一行 --- 结束）`); continue; }
    const { fm, body } = parsed;
    const fn = fm.name || '';
    const desc = fm.description || '';
    if (fn !== name) fmProblems.push(`${name}: name 应为 "${name}"，实际 "${fn || '(空)'}"`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fn)) fmProblems.push(`${name}: name 不是 kebab-case`);
    if (!desc) fmProblems.push(`${name}: description 为空`);
    else if (desc.length < 8) fmProblems.push(`${name}: description 过短（${desc.length} 字）`);
    if (/\n/.test(desc)) fmProblems.push(`${name}: description 必须是单行`);
    const bodyLines = body.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length;
    if (bodyLines < 60 || bodyLines > 150) styleWarns.push(`${name}: 正文 ${bodyLines} 行（约定 60–150）`);
    if (!body.includes('触发时机')) styleWarns.push(`${name}: 缺少「触发时机」章节`);
    if (!body.includes('边界')) styleWarns.push(`${name}: 缺少「边界」章节`);
  }
  if (fmProblems.length) FAIL(`FDE 技能 frontmatter（${present}/${FDE_SKILLS.length} 存在）`, fmProblems.join('；'));
  else OK(`FDE 技能 frontmatter（${present}/${FDE_SKILLS.length}）`, 'name/description 合法');
  if (styleWarns.length) WARN('FDE 技能正文结构', styleWarns.join('；'));
  else OK('FDE 技能正文结构', '正文行数与章节符合约定');

  /* 技能数量断言：清单 11 个；允许更多（新增技能未纳入清单时提示） */
  const dirs = existsSync(p('skills'))
    ? readdirSync(p('skills'), { withFileTypes: true }).filter((e) => e.isDirectory() && /^fde-/.test(e.name)).map((e) => e.name)
    : [];
  if (dirs.length < FDE_SKILLS.length) {
    FAIL(`FDE 技能目录（${dirs.length}/${FDE_SKILLS.length}）`, 'skills/ 下 fde-* 目录不足：' + FDE_SKILLS.filter((n) => !dirs.includes(n)).join('、'));
  } else if (dirs.length === FDE_SKILLS.length) {
    OK(`FDE 技能目录（${dirs.length}）`, '与断言清单一致（允许 ≥11）');
  } else {
    WARN(`FDE 技能目录（${dirs.length}）`, '多于断言清单，新增技能未纳入 health-check：' + dirs.filter((n) => !FDE_SKILLS.includes(n)).join('、'));
  }
}

/* ─── 3. 不得 import @deepseek-ai/* ────────────────────────── */
{
  const files = ['index.js', 'client.js', ...walk(p('src')).filter((f) => f.endsWith('.js'))];
  const hits = [];
  const importRe = /(?:^|\n)\s*(?:import\b[^\n;]*?\bfrom\s*|export\b[^\n;]*?\bfrom\s*|import\s*\(\s*)['"]@deepseek-ai\//;
  for (const abs of files) {
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    if (importRe.test(text)) {
      const line = text.split('\n').findIndex((l) => /@deepseek-ai\//.test(l)) + 1;
      hits.push(`${relative(ROOT, abs)}:${line || '?'}`);
    }
  }
  if (hits.length) FAIL('无 @deepseek-ai 依赖', '发现 import/require：' + hits.join('、'));
  else OK('无 @deepseek-ai 依赖', `已检查 ${files.filter(existsSync).length} 个 JS 文件`);
}

/* ─── 4. 客户端产物与源码一致 ─────────────────────────────── */
{
  const ui = p('src/ui/ui-panel.js');
  const cli = p('client.js');
  if (!existsSync(ui) || !existsSync(cli)) {
    WARN('客户端产物一致', 'client.js 或 src/ui/ui-panel.js 不存在');
  } else if (!readFileSync(ui).equals(readFileSync(cli))) {
    WARN('客户端产物一致', 'client.js 与 src/ui/ui-panel.js 字节不一致：运行 node build.mjs 后应转为一致（面板并行开发期间属预期）');
  } else {
    OK('客户端产物一致', 'client.js 与 src/ui/ui-panel.js 字节相同');
  }
}

/* ─── 5. 看板状态（research/.fde/board.json，若存在） ─────── */
function detectWorkspace() {
  if (process.env.FDE_WORKSPACE) return resolve(process.env.FDE_WORKSPACE);
  const parent = resolve(ROOT, '..');
  if (existsSync(join(parent, 'research'))) return parent;
  if (existsSync(join(process.cwd(), 'research'))) return resolve(process.cwd());
  return null;
}
const WS = detectWorkspace();
if (!WS) {
  WARN('看板状态', '未找到含 research/ 的工作区（可用 FDE_WORKSPACE 指定），已跳过 board 检查');
} else {
  const boardPath = join(WS, 'research', '.fde', 'board.json');
  if (!existsSync(boardPath)) {
    OK('看板状态', 'research/.fde/board.json 尚未创建（首次启用时由工具生成，正常）');
  } else {
    try {
      const board = JSON.parse(readFileSync(boardPath, 'utf8'));
      const issues = [];
      if (board.version !== 1) issues.push(`version=${JSON.stringify(board.version)}（应为 1）`);
      if (!Array.isArray(board.engagements)) issues.push('engagements 不是数组');
      if (!Array.isArray(board.items)) issues.push('items 不是数组');
      if (issues.length) FAIL('看板状态', 'board.json 校验失败：' + issues.join('；'));
      else OK('看板状态', `board.json 可解析，version=1（客户 ${board.engagements.length} / 任务 ${board.items.length}）`);
      const backups = join(WS, 'research', '.fde', 'backups');
      const n = existsSync(backups) ? readdirSync(backups).filter((f) => f.startsWith('board-')).length : 0;
      if (n === 0) WARN('看板备份', 'board.json 已存在但 research/.fde/backups/ 无备份（首次写入后应出现）');
      else OK('看板备份', `${n} 份 board 备份`);
    } catch (e) {
      FAIL('看板状态', `board.json 无法解析：${e && e.message ? e.message : e}`);
    }
  }
}

/* ─── 6. 招采雷达索引（bid-intel 独立插件，只读；缺失只 WARN） ─── */
{
  const envData = process.env.BID_INTEL_DATA;
  const candidates = [];
  if (envData) candidates.push(envData.endsWith('.jsonl') ? resolve(envData) : join(resolve(envData), 'notices.jsonl'));
  if (WS) candidates.push(join(WS, 'bid-intel', 'data', 'notices.jsonl'));
  candidates.push(resolve(ROOT, '..', 'bid-intel', 'data', 'notices.jsonl'));
  const file = candidates.find((f) => existsSync(f));
  if (!file) {
    WARN('招采雷达索引', '未找到 bid-intel/data/notices.jsonl（可用 BID_INTEL_DATA 指定）→ 招采功能降级（available:false），FDE 其余功能不受影响');
  } else {
    try {
      const size = statSync(file).size;
      const fd = openSync(file, 'r');
      let head = '';
      try {
        const buf = Buffer.alloc(65536);
        const got = readSync(fd, buf, 0, buf.length, 0);
        head = buf.slice(0, got).toString('utf8').split('\n')[0].trim();
      } finally { closeSync(fd); }
      const first = JSON.parse(head);
      const problems = [];
      if (!first || typeof first !== 'object') problems.push('首行不是 JSON 对象');
      if (!first.id) problems.push('缺 id');
      if (!first.title) problems.push('缺 title');
      if (!first.date) problems.push('缺 date');
      if (problems.length) {
        WARN('招采雷达索引', `可读但首行字段异常（${problems.join('、')}）：${relative(ROOT, file)}`);
      } else {
        OK('招采雷达索引', `${relative(ROOT, file)} 可解析（${(size / 1048576).toFixed(1)}MB，首条 ${first.date}）`);
      }
    } catch (e) {
      WARN('招采雷达索引', `索引存在但首行不可解析：${e && e.message ? e.message : e}`);
    }
  }
}

/* ─── 6a. FDE 资料库缓存（宿主每日刷新；缺失/过期只 WARN） ─── */
{
  const libPath = WS ? join(WS, 'research', '.fde', 'fde-library.json') : null;
  if (!libPath || !existsSync(libPath)) {
    WARN('FDE 资料库缓存', '尚未生成 research/.fde/fde-library.json（宿主未刷新；资料库用随包 catalog 兜底，其余功能不受影响）');
  } else {
    try {
      const lib = JSON.parse(readFileSync(libPath, 'utf8'));
      const problems = [];
      if (!lib || typeof lib !== 'object') problems.push('不是对象');
      if (lib && lib.version !== 1) problems.push(`version=${JSON.stringify(lib && lib.version)}（应为 1）`);
      if (lib && !Array.isArray(lib.items)) problems.push('items 不是数组');
      if (!lib || !lib.fetchedAt) problems.push('缺 fetchedAt');
      const today = new Date().toLocaleDateString('sv-SE');
      const date = lib && typeof lib.date === 'string' ? lib.date : '';
      if (problems.length) {
        WARN('FDE 资料库缓存', '缓存校验失败（缓存类，宿主会重建）：' + problems.join('；'));
      } else if (date !== today) {
        WARN('FDE 资料库缓存', `缓存日期 ${date || '(空)'} 不是今天（宿主未刷新或今日尚未抓取）`);
      } else {
        OK('FDE 资料库缓存', `可解析，date=${date}，${lib.items.length} 条，fetchedAt=${String(lib.fetchedAt).slice(0, 19)}Z`);
      }
    } catch (e) {
      WARN('FDE 资料库缓存', `缓存存在但不可解析（缓存类，宿主会重建）：${e && e.message ? e.message : e}`);
    }
  }
}

/* ─── 6b. 资料库社区来源 feed（scys-fde.json，v1.2 兼容；缺失/过期只 WARN） ─── */
{
  const feedPath = WS ? join(WS, 'research', '.fde', 'scys-fde.json') : null;
  if (!feedPath || !existsSync(feedPath)) {
    WARN('资料库社区来源', '尚未生成 research/.fde/scys-fde.json（宿主启动后每天自动抓取一次；也可在资料库「社区动态」刷新）');
  } else {
    try {
      const feed = JSON.parse(readFileSync(feedPath, 'utf8'));
      const problems = [];
      if (!feed || typeof feed !== 'object') problems.push('不是对象');
      if (feed && feed.version !== 1) problems.push(`version=${JSON.stringify(feed && feed.version)}（应为 1）`);
      if (feed && !Array.isArray(feed.items)) problems.push('items 不是数组');
      if (!feed || !feed.fetchedAt) problems.push('缺 fetchedAt');
      const today = new Date().toLocaleDateString('sv-SE');
      const date = feed && typeof feed.date === 'string' ? feed.date : '';
      const total = feed && feed.stats && typeof feed.stats.total === 'number'
        ? feed.stats.total
        : (feed && Array.isArray(feed.items) ? feed.items.length : 0);
      if (problems.length) {
        WARN('资料库社区来源', 'feed 校验失败：' + problems.join('；'));
      } else if (date !== today) {
        WARN('资料库社区来源', `feed 日期 ${date || '(空)'} 不是今天（缓存类；宿主每天刷新一次）`);
      } else {
        OK('资料库社区来源', `feed 可解析，date=${date}，${total} 条，fetchedAt=${String(feed.fetchedAt).slice(0, 19)}Z`);
      }
    } catch (e) {
      WARN('资料库社区来源', `feed 存在但不可解析（缓存类数据，宿主会重建）：${e && e.message ? e.message : e}`);
    }
  }
}

/* ─── 7. 交付文本无个人主目录绝对路径 ─────────────────────── */
const ABSOLUTE_MARK = '/' + 'Users/'; /* 拆开写，避免本脚本自身被误判 */
{
  const TEXT_EXT = /[.](?:md|json|ya?ml|txt|html)$/i;
  const delivered = [
    'README.md', 'AGENTS.md', 'REVIEW.md', 'CHANGELOG.md',
    'docs/00-intent.md', 'docs/01-spec.md',
  ].filter((f) => existsSync(p(f))).map(p);
  const addDir = (dir) => {
    if (!existsSync(p(dir))) return;
    for (const f of walk(p(dir))) if (TEXT_EXT.test(f)) delivered.push(f);
  };
  /* 实施规格 §6：绝对路径检查范围从 README/docs/skills 扩到发布清单全部文本
   * （methods / reference / templates / examples / locale）。 */
  ['docs/adr', 'docs/retros', 'methods', 'reference', 'templates', 'examples', 'locale'].forEach(addDir);
  if (existsSync(p('skills'))) {
    for (const f of walk(p('skills'))) if (f.endsWith('SKILL.md')) delivered.push(f);
  }
  const hits = [];
  for (const abs of delivered) {
    const text = readFileSync(abs, 'utf8');
    if (text.includes(ABSOLUTE_MARK)) {
      const line = text.split('\n').findIndex((l) => l.includes(ABSOLUTE_MARK)) + 1;
      hits.push(`${relative(ROOT, abs)}:${line}`);
    }
  }
  if (hits.length) FAIL('交付文本无绝对路径', '发现个人主目录绝对路径：' + hits.join('、'));
  else OK('交付文本无绝对路径', `已检查 ${delivered.length} 个交付文本（README/AGENTS/REVIEW/CHANGELOG/docs/adr/retros/methods/reference/templates/examples/locale/skills）`);

  /* 历史文档例外：docs/research 与 docs/02-plan 是证据/计划原文，按设计保留绝对路径，只提示不失败 */
  const scanned = new Set(delivered.map((f) => relative(ROOT, f)));
  const legacy = [];
  for (const f of walk(ROOT)) {
    if (!f.endsWith('.md')) continue;
    const r = relative(ROOT, f);
    if (scanned.has(r) || r.startsWith('docs/research/')) continue;
    if (readFileSync(f, 'utf8').includes(ABSOLUTE_MARK)) legacy.push(r);
  }
  if (legacy.length) WARN('历史文档绝对路径', '非交付文本含个人主目录绝对路径（证据/计划原文，按设计保留）：' + legacy.join('、'));
  else OK('历史文档绝对路径', '无额外遗留');
}

/* ─── 8. README 技能清单 ──────────────────────────────────── */
{
  if (!existsSync(p('README.md'))) {
    WARN('README 技能清单', 'README.md 不存在');
  } else {
    const text = read('README.md');
    const missing = FDE_SKILLS.filter((s) => !text.includes(s));
    if (missing.length) WARN('README 技能清单', 'README 未列出：' + missing.join('、'));
    else OK('README 技能清单', `${FDE_SKILLS.length} 个 FDE 技能均已列出`);
  }
}

/* ─── 9. 宿主集成状态（并行开发中 → WARN，集成后转 OK） ────── */
{
  const hostFiles = ['src/host/fde-schema.js', 'src/host/fde-store.js', 'src/host/fde-rules.js', 'src/host/fde-prompts.js', 'src/host/fde-api.js', 'src/host/fde-bids.js', 'src/host/fde-library.js', 'src/host/fde-calc.js'];
  const missing = hostFiles.filter((f) => !existsSync(p(f)));
  const idx = existsSync(p('index.js')) ? read('index.js') : '';
  const flags = {
    '路由 /fde/': /\/fde\//.test(idx),
    '工具 fde_board 等': /fde_board/.test(idx),
    '技能注册 ctx.skills': /skills/.test(idx) && /register\s*\(/.test(idx),
    '招采 fde_bid / bids 路由': /fde_bid/.test(idx) && /bids\//.test(idx),
    '资料库/计算工具 fde_library/fde_scenario/fde_quote': /fde_library/.test(idx) && /fde_scenario/.test(idx) && /fde_quote/.test(idx),
  };
  const notYet = Object.entries(flags).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length || notYet.length) {
    const parts = [];
    if (missing.length) parts.push('缺文件：' + missing.join('、'));
    if (notYet.length) parts.push('index.js 未出现：' + notYet.join('、'));
    WARN('宿主集成（需重启 DSH 生效）', '宿主半并行开发中，完成后应转 OK：' + parts.join('；'));
  } else {
    OK('宿主集成（需重启 DSH 生效）', '宿主内核文件、路由、工具与技能注册均已就位');
  }
  WARN('宿主重启状态', '无法从文件判断 DSH 是否已重启：技能注册与新路由需用户手动重启宿主后生效（未重启时面板显示兼容页）');
}

/* ─── 输出 ───────────────────────────────────────────────── */
const n = { ok: 0, warn: 0, fail: 0 };
for (const r of records) n[r.level]++;
const summary = {
  ok: n.fail === 0,
  fail: n.fail,
  warn: n.warn,
  okCount: n.ok,
  workspace: WS || '',
  root: ROOT,
  generatedAt: new Date().toISOString(),
  checks: records,
};

if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} else {
  console.log(`FDE 工作站健康检查 · 插件根：${ROOT}`);
  if (WS) console.log(`工作区：${WS}`);
  console.log('');
  for (const r of records) {
    const tag = r.level === 'ok' ? 'OK  ' : r.level === 'warn' ? 'WARN' : 'FAIL';
    console.log(`[${tag}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log('');
  console.log(`JSON 摘要：${JSON.stringify(summary)}`);
  console.log('');
  if (n.fail) console.log(`✗ 健康检查失败：${n.fail} 项 FAIL、${n.warn} 项 WARN、${n.ok} 项 OK`);
  else console.log(`✓ 健康检查通过：${n.warn} 项 WARN、${n.ok} 项 OK（exit 0）`);
}
process.exit(n.fail ? 1 : 0);
