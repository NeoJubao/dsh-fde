/**
 * 开源发布检查（ADR 0004 · Phase 0）
 * 用法: node verify/open-source.mjs
 *
 * 守的是「能安全开源、外部可安装」的硬契约，不测业务逻辑：
 *   1) 包身份：包名/版本/模块 id/cordis.patch.yml 一致（侧栏面板 id 保持 researchworkbench）
 *   2) 分发字段：license/repository/homepage/bugs/author/publishConfig/engines/可选 peer
 *   3) npm files 白名单：必须项在、禁止项不在（samples / src/ui / verify / tools / docs 等）
 *   4) 许可文件：LICENSE（MIT）、LICENSE-docs（CC BY 4.0）、CHANGELOG、locale
 *   5) README：官方安装命令、许可节、版本一致、无旧包名
 *   6) 隐私：发布集无个人主目录绝对路径（macOS/Linux 家目录前缀）；有工作区 research/ 时做客户词表复扫
 *   7) 构建一致性：client.js 与 src/ui/ui-panel.js 字节一致
 *
 * 干净检出（无 ../research）时客户词表复扫按 WARN 跳过——CI 与 npm 包解压目录属预期场景。
 * 隐私扫描只在终端输出「文件:行 + 词表序号」，不回显真实客户名（避免二次泄露）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const P = (rel) => join(ROOT, rel);
const pkgFile = P('package.json');
const fail = [];
const ok = [];
const check = (name, cond, detail) => {
  const pass = !!cond;
  console.log((pass ? '  ✓ ' : '  ✗ ') + name + (pass || detail === undefined ? '' : ' → ' + String(detail).slice(0, 600)));
  (pass ? ok : fail).push(name);
  return pass;
};
const skip = (name, detail) => console.log('  ⚠ 跳过 ' + name + (detail ? ' — ' + detail : ''));

/* ============================ 0. 读包元数据 ============================ */
if (!existsSync(pkgFile)) {
  console.log('✗ 找不到 package.json：' + pkgFile);
  process.exit(1);
}
let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
} catch (e) {
  console.log('✗ package.json 无法解析：' + ((e && e.message) || e));
  process.exit(1);
}
const NAME = 'dsh-fde';
const VERSION = pkg.version; // 由 package.json 单一来源提供

/* ============================ 1. 包身份 ============================ */
console.log('\n── 1. 包身份（ADR 0004 D1） ──');
check('包名 = ' + NAME, pkg.name === NAME, pkg.name);
check('版本 = ' + VERSION, pkg.version === VERSION, pkg.version);
check('非 private（可公开发布）', pkg.private !== true, pkg.private);
check('type = module（纯 ESM）', pkg.type === 'module', pkg.type);
check('exports 暴露 . / ./client / ./package.json',
  pkg.exports && pkg.exports['.'] === './index.js' && pkg.exports['./client'] === './client.js' &&
  pkg.exports['./package.json'] === './package.json', JSON.stringify(pkg.exports));
check('cordis.patch.yml 通过 exports 暴露', !!(pkg.exports && pkg.exports['./cordis.patch.yml'] === './cordis.patch.yml'),
  pkg.exports && pkg.exports['./cordis.patch.yml']);
check('dsh.bundle.patch 指向 ./cordis.patch.yml',
  !!(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml'), JSON.stringify(pkg.dsh && pkg.dsh.bundle));
check('dsh.manifestVersion = 1（format-1 索引）', !!(pkg.dsh && pkg.dsh.manifestVersion === 1),
  pkg.dsh && pkg.dsh.manifestVersion);
check('dsh.client.platform = web', !!(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web'),
  JSON.stringify(pkg.dsh && pkg.dsh.client));
check('icon 指向 ./icon.svg', pkg.icon === './icon.svg' && existsSync(P('icon.svg')), pkg.icon);

/* cordis 补丁：insert id / name 都是包名；侧栏面板 id 不在补丁里（由 client 注册，保持 researchworkbench） */
const patchFile = P('cordis.patch.yml');
if (!existsSync(patchFile)) {
  check('cordis.patch.yml 存在', false);
} else {
  const patch = readFileSync(patchFile, 'utf8');
  check('cordis.patch.yml insert id = ' + NAME, new RegExp('insert:[\\s\\S]*?\\bid:\\s*' + NAME + '\\b').test(patch), patch.trim());
  check('cordis.patch.yml insert name = ' + NAME,
    new RegExp("insert:[\\s\\S]*?\\bname:\\s*['\\\"]?" + NAME + "['\\\"]?").test(patch), patch.trim());
}
const clientFile = P('client.js');
const uiFile = P('src/ui/ui-panel.js');
if (!existsSync(clientFile) || !existsSync(uiFile)) {
  check('client.js 与 src/ui/ui-panel.js 均存在（先 node build.mjs）', false);
} else {
  const client = readFileSync(clientFile, 'utf8');
  check('client.js 模块 id 与包名一致（' + NAME + '）', client.includes("id: '" + NAME + "'"),
    (client.match(/id:\s*'[^']+'/) || [''])[0]);
  check('侧栏面板 id 保持 researchworkbench（不随包名改）',
    /id:\s*'researchworkbench'/.test(client) && /key:\s*'researchworkbench'/.test(client));
}

/* ============================ 2. 分发字段与许可 ============================ */
console.log('\n── 2. 分发与许可（ADR 0004 D2/D3） ──');
check('license = MIT', pkg.license === 'MIT', pkg.license);
check('repository 存在且为 URL', !!(pkg.repository && /^(git\+)?https?:\/\//.test(String(pkg.repository.url || pkg.repository))),
  JSON.stringify(pkg.repository));
check('homepage 为 http(s) URL', /^https?:\/\//.test(String(pkg.homepage || '')), pkg.homepage);
check('bugs 有 url', !!(pkg.bugs && /^https?:\/\//.test(String(pkg.bugs.url || ''))), JSON.stringify(pkg.bugs));
check('author 有 name', !!(pkg.author && (typeof pkg.author === 'string' ? pkg.author : pkg.author.name)),
  JSON.stringify(pkg.author));
check('publishConfig.access = public', !!(pkg.publishConfig && pkg.publishConfig.access === 'public'),
  JSON.stringify(pkg.publishConfig));
check('engines.node 声明（>=20）', !!(pkg.engines && /(>=|>)\s*2[0-9]|>=20/.test(String(pkg.engines.node || ''))),
  pkg.engines && pkg.engines.node);
check('engines.dsh 声明（ADR 0004 D3：>=0.2.0-rc.2 <0.3.0）',
  !!(pkg.engines && /0\.2\.0-rc\.2/.test(String(pkg.engines.dsh || ''))), pkg.engines && pkg.engines.dsh);
check('无 dependencies（零运行时依赖）', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
  JSON.stringify(pkg.dependencies));
{
  const peerKeys = Object.keys(pkg.peerDependencies || {});
  const meta = pkg.peerDependenciesMeta || {};
  check('peerDependencies 只允许 optional 的 @deepseek-ai/dsh（避免 pnpm 重复安装宿主包）',
    peerKeys.length === 1 && peerKeys[0] === '@deepseek-ai/dsh' && !!(meta['@deepseek-ai/dsh'] && meta['@deepseek-ai/dsh'].optional === true),
    JSON.stringify({ peerDependencies: pkg.peerDependencies, peerDependenciesMeta: meta }));
}
check('keywords 含 dsh-plugin 与 fde',
  Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin') && pkg.keywords.includes('fde'),
  JSON.stringify(pkg.keywords));
check('scripts.build / scripts.verify 可用',
  !!(pkg.scripts && pkg.scripts.build === 'node build.mjs' && pkg.scripts.verify === 'node verify/all.mjs'),
  JSON.stringify(pkg.scripts));

/* 许可文件内容 */
const licenseFile = P('LICENSE');
const licenseDocsFile = P('LICENSE-docs');
if (!existsSync(licenseFile)) {
  check('LICENSE 存在且为 MIT 文本', false);
} else {
  const text = readFileSync(licenseFile, 'utf8');
  check('LICENSE 为 MIT 文本', /MIT License/i.test(text) && /Permission is hereby granted/i.test(text),
    text.slice(0, 80).replace(/\n/g, ' '));
  check('LICENSE 含版权行', /Copyright\s*(?:\(c\))?\s*\d{4}/i.test(text));
}
if (!existsSync(licenseDocsFile)) {
  check('LICENSE-docs 存在且声明 CC BY 4.0', false);
} else {
  const text = readFileSync(licenseDocsFile, 'utf8');
  check('LICENSE-docs 声明 CC BY 4.0（内容许可）',
    /CC\s*BY\s*4\.0/i.test(text) || /Creative Commons Attribution 4\.0/i.test(text), text.slice(0, 80).replace(/\n/g, ' '));
}
check('CHANGELOG.md 存在且提到当前版本（' + VERSION + '）',
  existsSync(P('CHANGELOG.md')) && readFileSync(P('CHANGELOG.md'), 'utf8').includes(VERSION));
check('locale/zh.json 存在且为合法 JSON',
  existsSync(P('locale/zh.json')) && (() => { try { JSON.parse(readFileSync(P('locale/zh.json'), 'utf8')); return true; } catch { return false; } })());

/* ============================ 3. files 白名单 ============================ */
console.log('\n── 3. npm files 白名单（ADR 0004 D3） ──');
const files = Array.isArray(pkg.files) ? pkg.files.map((x) => String(x)) : [];
check('files 是非空数组', files.length > 0, typeof pkg.files);
const hasEntry = (entry) => files.some((f) => f === entry || f === entry + '/' || f.startsWith(entry + '/'));
const REQUIRED = ['index.js', 'client.js', 'cordis.patch.yml', 'src/host', 'methods', 'reference', 'templates',
  'scripts', 'skills', 'locale', 'icon.svg', 'README.md', 'CHANGELOG.md'];
for (const req of REQUIRED) {
  check('files 含 ' + req, hasEntry(req), files.join(','));
}
check('files 含 LICENSE 与 LICENSE-docs', hasEntry('LICENSE') && hasEntry('LICENSE-docs'), files.join(','));
const FORBIDDEN = [
  ['src/ui', /^src\/ui(?:\/|$)/],
  ['verify', /^verify(?:\/|$)/],
  ['tools', /^tools(?:\/|$)/],
  ['docs', /^docs(?:\/|$)/],
  ['reference/samples', /samples/i],
  ['build.mjs', /^build\.mjs$/],
  ['docs-workbench.md', /docs-workbench/],
];
for (const [label, re] of FORBIDDEN) {
  const hit = files.filter((f) => re.test(f));
  check('files 不含 ' + label, hit.length === 0, hit.join(','));
}
check('files 无通配全包（* 或 .）', !files.includes('*') && !files.includes('.'), files.join(','));

/* ============================ 4. README 契约 ============================ */
console.log('\n── 4. README（安装与许可） ──');
if (!existsSync(P('README.md'))) {
  check('README.md 存在', false);
} else {
  const readme = readFileSync(P('README.md'), 'utf8');
  check('README 含官方安装命令（dsh plugin … add）', /dsh\s+plugin[\s\S]{0,80}?\badd\b/.test(readme),
    (readme.match(/dsh\s+plugin[^\n]{0,80}/) || [''])[0]);
  check('README 安装命令使用 --profile', /dsh\s+plugin[\s\S]{0,40}?--profile/.test(readme),
    (readme.match(/dsh\s+plugin[^\n]{0,60}/) || [''])[0]);
  check('README 含许可节（标题含「许可」或 License）', /^#{2,3}\s*[^\n]*(?:许可|License)/m.test(readme));
  check('README 许可节分别说明代码 MIT', /MIT/.test(readme));
  check('README 许可节说明内容 CC BY 4.0', /CC\s*BY\s*4\.0|Creative Commons Attribution 4\.0/i.test(readme));
  check('README 使用新包名 ' + NAME, readme.includes(NAME));
  check('README 不含旧包名 @local/research-workbench', !readme.includes('@local/research-workbench'));
  /* 版本一致（与 scripts/check-readme-version.mjs 同口径：优先顶部，兜底全文首个版本声明） */
  const h2 = readme.indexOf('\n## ');
  const top = h2 === -1 ? readme.slice(0, 4000) : readme.slice(0, h2);
  const versionRe = /\bv(\d+)\.(\d+)(?:\.(\d+))?/i;
  const findVersion = (lines) => {
    for (const line of lines.filter((l) => /版本|状态|version/i.test(l))) {
      const hit = versionRe.exec(line);
      if (hit) return hit;
    }
    for (const line of lines) {
      const hit = versionRe.exec(line);
      if (hit) return hit;
    }
    return null;
  };
  let m = findVersion(top.split('\n'));
  if (!m) m = findVersion(readme.split('\n'));
  const readmeLabel = m ? ('v' + m[1] + '.' + m[2] + (m[3] ? '.' + m[3] : '')) : '';
  const [maj, min] = VERSION.split('.');
  const expected = m && m[3] ? 'v' + VERSION : 'v' + maj + '.' + min;
  check('README 版本与 package.json.version 一致（' + expected + '）', readmeLabel === expected,
    readmeLabel || '(未找到 vX.Y)');
}

/* ============================ 5. 隐私：发布集无个人路径 / 无客户词 ============================ */
console.log('\n── 5. 隐私（发布集无绝对路径 / 客户词表复扫） ──');

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.gz', '.tgz', '.ico', '.woff', '.woff2', '.ttf']);
const TEXT_EXT = new Set(['.md', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.svg', '.txt', '.py', '.sh', '.html', '.css']);

/** 递归列出目录文件（跳过 node_modules/.git 与给定的目录前缀）。 */
function walk(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.DS_Store') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* 发布集 = 会进 GitHub 仓库的文本文件；排除历史证据/报告/样本（ADR 0004 D4）。 */
const EXCLUDE_DIRS = [
  'docs/research', 'reference/samples', 'verify/tmp-ws', 'node_modules', '.git',
  '.github/workflows', /* workflow YAML 由本目录单独断言，不参与内容扫描（含 actions URL） */
];
const EXCLUDE_FILE_RE = [
  /^verify\/[^/]+-report\.md$/,
  /^verify\/audit-report\.md$/,
];
let publishFiles = [];
try {
  const all = walk(ROOT);
  publishFiles = all.filter((abs) => {
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (EXCLUDE_DIRS.some((d) => rel === d || rel.startsWith(d + '/'))) return false;
    if (EXCLUDE_FILE_RE.some((re) => re.test(rel))) return false;
    return true;
  });
} catch (e) {
  publishFiles = [];
}
const isTextFile = (abs) => {
  const ext = (abs.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();
  if (BINARY_EXT.has(ext)) return false;
  if (TEXT_EXT.has(ext)) return true;
  try { return statSync(abs).size < 1024 * 1024; } catch { return false; }
};
const publishText = publishFiles.filter(isTextFile);
check('发布集可枚举（文本文件 > 20 个）', publishText.length > 20, publishText.length);

/* 5a. 个人主目录绝对路径（macOS 为 Users、Linux 为 home 前缀）。脚本自身用拆分字符串规避误报。 */
const HOME_MARKS = ['/' + 'Users/', '/' + 'home/'];
const pathHits = [];
for (const abs of publishText) {
  let text = '';
  try { text = readFileSync(abs, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (HOME_MARKS.some((m) => lines[i].includes(m))) {
      pathHits.push(relative(ROOT, abs).split(sep).join('/') + ':' + (i + 1));
      break;
    }
  }
}
check('发布集无个人主目录绝对路径（macOS/Linux 家目录前缀）', pathHits.length === 0,
  pathHits.slice(0, 10).join('、') + (pathHits.length > 10 ? ' …共 ' + pathHits.length + ' 处' : ''));

/* 5b. 客户词表复扫：从工作区 research/ 目录名派生（只在内存里用，不写入任何文件/输出）。
 * 干净检出（CI / npm 包）没有 ../research → WARN 跳过；impl-sanitize 的复扫报告仍是权威口径。 */
const workspace = resolve(ROOT, '..');
const researchDir = join(workspace, 'research');
if (!existsSync(researchDir)) {
  skip('客户词表复扫', '没有 ' + researchDir + '（干净检出/CI 属预期；有工作区时自动启用）');
} else {
  let dirs = [];
  try {
    dirs = readdirSync(researchDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch { dirs = []; }
  /* 只取像客户卷的目录：含中文，或以 -YYYYMMDD 结尾；去掉日期后缀后 ≥4 字。 */
  const terms = new Set();
  const addTerm = (raw) => {
    const t = String(raw || '').trim();
    if (t.length >= 4 && /[\u4e00-\u9fff]/.test(t)) terms.add(t);
  };
  for (const name of dirs) {
    if (!/[\u4e00-\u9fff]/.test(name) && !/-\d{8}$/.test(name)) continue;
    const stripped = name.replace(/-\d{8}.*$/, '').replace(/[（(].*$/, '').trim();
    for (const t of [stripped, name.split('-')[0]]) addTerm(t);
  }
  /* 补充：看板里登记过的客户名/简称（只读 board.json；覆盖目录名之外的工商名称与别名）。 */
  try {
    const boardFile = join(researchDir, '.fde', 'board.json');
    if (existsSync(boardFile)) {
      const board = JSON.parse(readFileSync(boardFile, 'utf8'));
      for (const e of (board.engagements || [])) {
        for (const v of [e.name, e.company, e.shortName, e.dir]) {
          const t = String(v || '').trim();
          if (t) addTerm(t.replace(/-\d{8}.*$/, '').trim());
        }
      }
    }
  } catch { /* board 损坏不影响本检查（其它测试会报）；退化为仅目录名词表 */ }
  const termList = [...terms];
  if (!termList.length) {
    skip('客户词表复扫', 'research/ 下未识别出客户卷目录');
  } else {
    const hits = [];
    for (const abs of publishText) {
      let text = '';
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const idxes = termList.map((t, k) => (lines[i].includes(t) ? k : -1)).filter((k) => k >= 0);
        if (idxes.length) {
          /* 不回显真实客户名：只给文件:行 + 词表序号。 */
          hits.push(relative(ROOT, abs).split(sep).join('/') + ':' + (i + 1) + '（词表#' + idxes.join('/') + '）');
          break;
        }
      }
    }
    check('发布集无客户词表命中（词表 ' + termList.length + ' 项，来自工作区 research/ 目录名）',
      hits.length === 0, hits.slice(0, 10).join('、') + (hits.length > 10 ? ' …共 ' + hits.length + ' 处' : ''));
  }
}

/* ============================ 6. 构建一致性 ============================ */
console.log('\n── 6. 构建产物一致 ──');
check('client.js 与 src/ui/ui-panel.js 字节一致（node build.mjs 产物未漂移）',
  existsSync(clientFile) && existsSync(uiFile) && readFileSync(clientFile).equals(readFileSync(uiFile)));

/* ============================ 汇总 ============================ */
console.log('\n=== 通过 ' + ok.length + ' 项 ===');
if (fail.length) {
  console.log('=== 失败 ' + fail.length + ' 项 ===');
  for (const f of fail) console.log('  ✗ ' + f);
  console.log('\n开源发布检查未通过：先修上面的 ✗ 再发布（ADR 0004 D1–D6）。');
  process.exit(1);
}
console.log('\n开源发布检查通过（' + publishText.length + ' 个发布集文本文件）。');
