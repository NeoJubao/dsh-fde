#!/usr/bin/env node
/**
 * FDE 工作站 · ui-contract 体检脚本 v1（只报不修）
 *
 * 位置：`docs/ui-contract/`（随 GitHub 仓库分发；不进 npm 包）。
 * 用法（在插件根目录执行）：
 *   node docs/ui-contract/audit-ui-contract.mjs                  # 体检默认插件源码
 *   node docs/ui-contract/audit-ui-contract.mjs --json           # 只打 JSON
 *   node docs/ui-contract/audit-ui-contract.mjs --selftest       # 自测：跑故意违规的 fixture，预期 exit 1
 *   node docs/ui-contract/audit-ui-contract.mjs --source <file.js>  # 指定源码（相对路径会先按 cwd、再按契约目录解析）
 *   node docs/ui-contract/audit-ui-contract.mjs --dir <contractDir> # 指定契约目录（找 layout.md）
 *
 * 退出码：0 全部通过 / 1 有违规 / 2 运行错误。
 * 末尾固定打印一行 `AUDIT-JSON {...}`，供 CI/`verify/ui-contract.mjs` 解析
 * （JSON 里的 source 是相对路径，避免把本机主目录写进日志）。
 *
 * 设计说明（为什么是这 8 项）：
 *   见 layout.md §10 与 `plugin-audit/fde-v2/03-设计审查与ui-contract.md` §4.4（审查报告，不随仓库分发）。
 *   这 8 项都能「机械判定 + 能失败」；人工项（决策树 totality、明暗走查、
 *   焦点陷阱）不在本脚本里，列在 README.md 的「未自动化清单」。
 *
 * 注意：本脚本读的是「迁移前」源码（没有任何 data-region），所以 A1 的
 *   「源码标注」分支在迁移前应显示 0 个区域（INFO，不算失败）；
 *   A1 仍然会硬校验 layout.md §2 与 region-ids.mjs 是否一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as REGISTRY from './region-ids.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 契约目录 = docs/ui-contract/；默认源码 = 仓库根的 src/ui/ui-panel.js（跨两级）。 */
const DEFAULT_SOURCE = path.resolve(HERE, '../../src/ui/ui-panel.js');
const DEFAULT_CONTRACT_DIR = HERE;
/* 仓库根：docs/ui-contract/ → ../../，用于把绝对路径显示成相对路径（隐私：日志里不出现本机主目录）。 */
const REPO_ROOT = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const CONTRACT_DIR = path.resolve(argOf('dir') || DEFAULT_CONTRACT_DIR);
const JSON_ONLY = args.includes('--json');
const SELFTEST = args.includes('--selftest');

/** 解析源码路径：--selftest > --source（先 cwd 后契约目录）> 默认源码。 */
function resolveSource() {
  if (SELFTEST) return path.join(CONTRACT_DIR, 'selftest', 'ui-panel.broken.js');
  const raw = argOf('source');
  if (!raw) return DEFAULT_SOURCE;
  const abs = path.resolve(raw);
  if (fs.existsSync(abs)) return abs;
  const alt = path.resolve(CONTRACT_DIR, raw);
  return fs.existsSync(alt) ? alt : abs;
}
const SOURCE = resolveSource();

/** 对外显示用路径：仓库内 → 相对路径；仓库外 → 只留文件名（不打印本机绝对路径）。 */
function displayPath(p) {
  try {
    const rel = path.relative(REPO_ROOT, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    return path.basename(p);
  } catch {
    return path.basename(p);
  }
}
const SOURCE_DISPLAY = displayPath(SOURCE);
const CONTRACT_DISPLAY = displayPath(CONTRACT_DIR);

const C = {
  ok: (s) => 'PASS  ' + s,
  warn: (s) => 'WARN  ' + s,
  fail: (s) => 'FAIL  ' + s,
  info: (s) => 'INFO  ' + s,
};

const results = [];
const record = (id, title, status, lines, extra) => {
  results.push(Object.assign({ id, title, status, lines: lines || [] }, extra || {}));
};

/* ------------------------------------------------------------------ *
 * 0. 读入
 * ------------------------------------------------------------------ */
if (!fs.existsSync(SOURCE)) {
  console.error('AUDIT 运行错误：找不到源码 ' + SOURCE_DISPLAY + '（--source / --selftest 的路径相对 cwd 或契约目录）');
  process.exit(2);
}
const src = fs.readFileSync(SOURCE, 'utf8');
const srcLines = src.split('\n');

/** 取 CSS 模板字符串（const CSS = `...`;） */
function extractCss(text) {
  const start = text.indexOf('const CSS = `');
  if (start < 0) return { css: '', offset: 0 };
  const from = start + 'const CSS = `'.length;
  const end = text.indexOf('\n`;', from);
  return { css: text.slice(from, end < 0 ? text.length : end), offset: from };
}
const { css: cssRaw, offset: cssOffset } = extractCss(src);
/** 解析用 CSS：注释替换为等长空白（保留换行与偏移） */
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const lineAt = (idx) => src.slice(0, idx).split('\n').length;

/** 粗略 CSS 规则解析：顶层 `{}` 配对，返回 [{ selector, body, index, line }] */
function parseCssRules(text) {
  const rules = [];
  let depth = 0;
  let buf = '';
  let ruleStart = 0;
  let media = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    if (ch === '{') {
      depth++;
      if (depth === 1) {
        const head = buf.slice(0, -1).trim();
        if (head.startsWith('@media')) {
          media = head;
          buf = '';
          continue;
        }
        ruleStart = i - head.length - 1;
        buf = head + '{';
      }
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const s = buf.trim();
        if (s && s.indexOf('{') > 0) {
          const selector = s.slice(0, s.indexOf('{')).trim();
          const body = s.slice(s.indexOf('{') + 1, -1);
          rules.push({ selector, body, media, index: cssOffset + i, line: lineAt(cssOffset + i) });
        } else if (s && media) {
          rules.push({ selector: '@media ' + media.replace(/^@media/, '').trim(), body: '', media, index: cssOffset + i, line: lineAt(cssOffset + i) });
        }
        media = null;
        buf = '';
      }
    }
  }
  return rules;
}
const rules = parseCssRules(css);

/** 取函数体（含 function 关键字到匹配的 `}`），返回 { name, body, start, end } */
function extractFunctionBodies(text) {
  const out = [];
  const re = /function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const braceStart = text.indexOf('{', m.index + m[0].length - 1);
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end > 0) out.push({ name: m[1], body: text.slice(m.index, end + 1), start: m.index, end });
  }
  return out;
}
const fnBodies = extractFunctionBodies(src);
const view = (name) => fnBodies.find((f) => f.name === name) || null;

/* ------------------------------------------------------------------ *
 * A1 区域名 ⊆ 白名单 + layout.md §2 与注册表一致
 * ------------------------------------------------------------------ */
function checkA1() {
  const problems = [];
  const env = [];
  // ① 源码里的区域标注
  const annotated = [];
  const reData = /['"]?data-region['"]?\s*[:=]\s*['"]([a-z0-9-]+)['"]/g;
  let m;
  while ((m = reData.exec(src))) annotated.push(m[1]);
  const reHelper = /region\(\s*(?:REGION_IDS\.([A-Z_]+)|['"]([a-z0-9-]+)['"])/g;
  while ((m = reHelper.exec(src))) annotated.push(m[1] ? { const: m[1] } : m[2]);

  // 注册表（静态 import；路径固定在同目录）
  const registry = REGISTRY;
  const IDs = Object.values(registry.REGION_IDS);
  const ID_SET = new Set(IDs);
  const CONST_TO_ID = registry.REGION_IDS;

  for (const a of annotated) {
    if (typeof a === 'object') {
      const id = CONST_TO_ID[a.const];
      if (!id) problems.push('REGION_IDS.' + a.const + ' 未在注册表定义');
      else env.push(id);
    } else if (!ID_SET.has(a)) {
      problems.push('data-region="' + a + '" 不在白名单');
    } else env.push(a);
  }

  // ② layout.md §2 表格
  const layoutPath = path.join(CONTRACT_DIR, 'layout.md');
  let docIds = [];
  if (!fs.existsSync(layoutPath)) {
    problems.push('缺少 layout.md（契约目录 ' + CONTRACT_DIR + '）');
  } else {
    const doc = fs.readFileSync(layoutPath, 'utf8');
    const section = (doc.split(/^## 2\./m)[1] || '').split(/^## 3\./m)[0];
    const rows = section.split('\n').filter((l) => /^\|\s*`[a-z0-9-]+`\s*\|/.test(l));
    docIds = rows.map((l) => l.match(/`([a-z0-9-]+)`/)[1]);
    for (const l of rows) {
      const cells = l.split('|').map((x) => x.trim());
      // | id | 允许放 | 禁止放 | 页型 | 边界 | → 拆完首尾为空串，共 7 段
      if (cells.length < 6) problems.push('layout.md §2 行缺列：' + l.slice(0, 60));
      const forbid = cells[3] || '';
      if (cells.length >= 4 && (!forbid || forbid === '—' || forbid.length < 3)) {
        problems.push('layout.md §2 行「禁止放」为空：' + l.slice(0, 60));
      }
    }
    const missing = IDs.filter((x) => docIds.indexOf(x) === -1);
    const extra = docIds.filter((x) => ID_SET.has(x) === false);
    if (missing.length) problems.push('注册表有、layout.md §2 缺：' + missing.join(', '));
    if (extra.length) problems.push('layout.md §2 有、注册表缺：' + extra.join(', '));
    env.push('layout.md §2 行数=' + docIds.length);
  }

  if (annotated.length === 0) {
    record('A1b', '源码区域标注覆盖', 'INFO',
      ['迁移前源码 0 个 data-region（预期；迁移后此项应 >0）。迁移清单见 layout.md 附录 C。']);
  } else {
    record('A1b', '源码区域标注覆盖', problems.length ? 'FAIL' : 'PASS', ['源码区域标注 ' + annotated.length + ' 处']);
  }
  record('A1', '区域名 ⊆ 白名单 / layout.md §2 与注册表一致',
    problems.length ? 'FAIL' : 'PASS',
    problems.length ? problems : ['注册表 ' + IDs.length + ' 个区域；' + env.join('；')]);
}

/* ------------------------------------------------------------------ *
 * A2 无写死色值（只允许 var(--token, fallback) 里的 fallback）
 * ------------------------------------------------------------------ */
function stripVarFallbacks(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf('var(', i);
    if (idx === -1) { out += text.slice(i); break; }
    out += text.slice(i, idx);
    // 找到与 var( 匹配的右括号
    let depth = 0;
    let j = idx + 3;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') { depth--; if (depth === 0) break; }
    }
    out += 'var()';
    i = j + 1;
  }
  return out;
}
function checkA2() {
  const cssNoFallback = stripVarFallbacks(css);
  const hex = cssNoFallback.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const rgb = cssNoFallback.match(/rgba?\([^)]*\)/g) || [];
  const hsl = cssNoFallback.match(/hsla?\([^)]*\)/g) || [];
  // 内联 style 里的色值（CSS 之外）
  const jsPart = src.slice(0, cssOffset) + src.slice(cssOffset + css.length);
  const jsHex = (jsPart.match(/#[0-9a-fA-F]{6}\b/g) || []).filter((x) => /^#(?:[0-9a-fA-F]{6})$/.test(x));
  const naked = [].concat(hex, rgb, hsl);
  const lines = [];
  if (naked.length) lines.push('CSS 裸色值 ' + naked.length + ' 处：' + naked.slice(0, 8).join(' '));
  if (jsHex.length) lines.push('JS 内联裸色值 ' + jsHex.length + ' 处：' + jsHex.slice(0, 8).join(' '));
  const fallbacks = (css.match(/var\(\s*--[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}/g) || []).length;
  if (fallbacks) lines.push('INFO 允许的回退值（var(--token, #hex)）' + fallbacks + ' 处 —— 见 tokens.md §5 收拢建议');
  record('A2', '无写死色值（回退值除外）', naked.length || jsHex.length ? 'FAIL' : 'PASS', lines.length ? lines : ['未发现裸色值']);
}

/* ------------------------------------------------------------------ *
 * A3 无主题选择器
 * ------------------------------------------------------------------ */
function checkA3() {
  const hits = [];
  const re = /prefers-color-scheme|data-ds-dark-theme|data-theme\s*=|\[data-ds-[a-z-]+/g;
  let m;
  while ((m = re.exec(src))) hits.push('line ' + lineAt(m.index) + ': ' + m[0]);
  record('A3', '无主题选择器', hits.length ? 'FAIL' : 'PASS',
    hits.length ? hits : ['CSS/JS 均无主题分支（颜色全部来自 --dsw-alias-*）']);
}

/* ------------------------------------------------------------------ *
 * A4 :hover 必须在 @media (hover: hover) 内
 * ------------------------------------------------------------------ */
function checkA4() {
  const inHover = [];
  const outside = [];
  for (const r of rules) {
    if (r.selector.indexOf(':hover') === -1 && !/^@media/.test(r.selector)) continue;
    if (r.selector.indexOf(':hover') === -1) continue;
    (r.media && /hover\s*:\s*hover/.test(r.media) ? inHover : outside).push(r.line + ' ' + r.selector);
  }
  const lines = [];
  if (outside.length) {
    lines.push('媒体查询外的 :hover ' + outside.length + ' 处：');
    outside.slice(0, 8).forEach((x) => lines.push('  line ' + x));
    if (outside.length > 8) lines.push('  …共 ' + outside.length + ' 处');
  }
  lines.push('已包裹的 :hover ' + inHover.length + ' 处');
  record('A4', ':hover 位于 @media (hover: hover) 内', outside.length ? 'FAIL' : 'PASS', lines);
}

/* ------------------------------------------------------------------ *
 * A5 字号 ⊆ 官方 type scale（11/12/13/14/16/18/20/24）
 * ------------------------------------------------------------------ */
const TYPE_SCALE = [11, 12, 13, 14, 16, 18, 20, 24];
function checkA5() {
  const found = new Map();
  for (const r of rules) {
    const re = /font-size\s*:\s*([0-9.]+)px/g;
    let m;
    while ((m = re.exec(r.body))) {
      const v = parseFloat(m[1]);
      if (!found.has(v)) found.set(v, []);
      found.get(v).push(r.selector);
    }
  }
  const off = [...found.keys()].filter((v) => TYPE_SCALE.indexOf(v) === -1).sort((a, b) => a - b);
  const lines = [];
  lines.push('字号取值 ' + found.size + ' 种：' + [...found.keys()].sort((a, b) => a - b).join(' / ') + 'px');
  if (off.length) {
    lines.push('越界字号 ' + off.length + ' 种（不在 ' + TYPE_SCALE.join('/') + '）：');
    off.forEach((v) => {
      const sels = [...new Set(found.get(v))];
      lines.push('  ' + v + 'px × ' + found.get(v).length + '（' + sels.slice(0, 4).join(' , ') + (sels.length > 4 ? ' …' : '') + '）');
    });
  }
  record('A5', '字号 ⊆ 官方 type scale', off.length ? 'FAIL' : 'PASS', lines);
}

/* ------------------------------------------------------------------ *
 * A6 每个页型必有 空/错/载 三态
 * ------------------------------------------------------------------ */
// 视图 → 三态来源；parent = 由 App 级统一渲染（页级状态条），partial = 仅行内提示
const STATE_EXPECT = {
  TodayView: { name: '今日', loading: 'self', empty: 'self', error: 'self' },
  BoardView: { name: '看板', loading: 'parent', empty: 'self', error: 'parent' },
  CustomersView: { name: '客户', loading: 'partial', empty: 'self', error: 'self' },
  ProcessView: { name: '流程', loading: 'n/a', empty: 'self', error: 'self' },
  LibraryView: { name: '资料库', loading: 'self', empty: 'self', error: 'self' },
  BidsView: { name: '招采', loading: 'self', empty: 'self', error: 'self' },
  ArtifactsView: { name: '工件', loading: 'self', empty: 'self', error: 'partial' },
  MethodsView: { name: '方法', loading: 'self', empty: 'self', error: 'self' },
  SettingsView: { name: '设置', loading: 'n/a', empty: 'n/a', error: 'self' },
  EngagementDrawer: { name: '客户抽屉', loading: 'self', empty: 'n/a', error: 'self' },
  ItemDrawer: { name: '任务抽屉', loading: 'n/a', empty: 'n/a', error: 'self' },
};
// 组件以 h(Loading, {...}) 形式引用，按「标识符出现」判定，不用 `(`。
const STATE_RE = {
  loading: /\b(?:Loading|Spinner)\b/,
  empty: /\bEmpty\b/,
  error: /\b(?:ErrorLine|BidUnavailable|MsgLine)\b/,
};
function checkA6() {
  const rows = [];
  const gaps = [];
  for (const [fnName, exp] of Object.entries(STATE_EXPECT)) {
    const fn = view(fnName);
    if (!fn) { gaps.push(fnName + '：源码中找不到组件'); continue; }
    const mark = {};
    for (const key of ['loading', 'empty', 'error']) {
      const self = STATE_RE[key].test(fn.body);
      if (exp[key] === 'self' && !self) gaps.push(exp.name + '：缺 ' + key + ' 态（页面级）');
      mark[key] = self ? '有'
        : exp[key] === 'parent' ? '父级'
          : exp[key] === 'partial' ? '局部'
            : exp[key] === 'n/a' ? '不适用' : '无';
    }
    rows.push(exp.name + '：载=' + mark.loading + ' 空=' + mark.empty + ' 错=' + mark.error);
  }
  record('A6', '每页型 空/错/载 三态', gaps.length ? 'FAIL' : 'PASS', rows.concat(gaps.length ? ['缺口：'].concat(gaps) : []));
}

/* ------------------------------------------------------------------ *
 * A7 重复全局控件（刷新 / 自主性徽章每页只允许壳层 1 处）
 * ------------------------------------------------------------------ */
const REFRESH_RES = [/t\('refresh'\)/g];              // 全局刷新（壳层唯一）
const BLOCK_REFRESH_RES = [/t\('libRefresh'\)/g, /t\('bidRefresh'\)/g, /t\('artifactsRefresh'\)/g]; // 块级刷新（合法）
function countMatches(body, res) {
  let n = 0;
  for (const re of res) { const m = body.match(re); if (m) n += m.length; }
  return n;
}
function checkA7() {
  const VIEWS = ['TodayView', 'BoardView', 'CustomersView', 'ProcessView', 'LibraryView', 'BidsView', 'ArtifactsView', 'MethodsView', 'SettingsView', 'EngagementDrawer', 'ItemDrawer'];
  const rows = [];
  const bad = [];
  for (const name of VIEWS) {
    const fn = view(name);
    if (!fn) continue;
    const refresh = countMatches(fn.body, REFRESH_RES);
    const blockRefresh = countMatches(fn.body, BLOCK_REFRESH_RES);
    const autonomy = (fn.body.match(/AutonomyBadge\s*\(/g) || []).length;
    const label = (STATE_EXPECT[name] || {}).name || name;
    if (blockRefresh) rows.push(label + '：块级刷新 ' + blockRefresh + ' 个（合法：只刷新该块数据）');
    // 壳层已提供 1 个刷新 + 1 个自主性；视图内再出现即重复
    if (refresh > 0) bad.push(label + '：页内刷新 ' + refresh + ' 个（壳层已 1 个）');
    if (autonomy > 0) bad.push(label + '：页内自主性徽章 ' + autonomy + ' 个（壳层已 1 个）');
    rows.push(label + '：页内刷新 ' + refresh + ' / 自主性 ' + autonomy);
  }
  // 壳层重复检测：App 渲染里 refresh 只允许 1 次
  const appFn = view('FdeApp') || fnBodies.find((f) => f.name.indexOf('App') >= 0 && f.body.indexOf('fde-nav-wrap') >= 0);
  if (appFn) {
    const shellRefresh = (appFn.body.match(/t\('refresh'\)/g) || []).length;
    if (shellRefresh > 1) bad.push('壳层刷新按钮 ' + shellRefresh + ' 个（应 1 个）');
    rows.push('壳层：刷新 ' + shellRefresh + ' 个 / 自主性 ' + (appFn.body.match(/AutonomyBadge\s*\(/g) || []).length + ' 个');
  }
  record('A7', '重复全局控件（刷新/自主性）', bad.length ? 'FAIL' : 'PASS', rows.concat(bad.length ? ['违规：'].concat(bad) : []));
}

/* ------------------------------------------------------------------ *
 * A8 几何 token（圆角尺度 / 中性描边 0.5px / 高层级表面材质）
 * ------------------------------------------------------------------ */
const RADIUS_TOKENS = [4, 8, 12, 16, 20, 28];
function checkA8() {
  const problems = [];
  const cats = { radius: 0, pill: 0, border: 0, dashed: 0, elevation: 0 };
  const radiusStats = new Map();
  let pills = 0;
  let pillsWithCorner = 0;
  for (const r of rules) {
    const re = /border-radius\s*:\s*([^;}]+)/g;
    let m;
    while ((m = re.exec(r.body))) {
      const v = m[1].trim();
      if (/var\(--dsw-radius-/.test(v)) continue;
      if (/^(50%|999px)$/.test(v)) {
        pills++;
        if (/corner-shape\s*:\s*round/.test(r.body)) pillsWithCorner++;
        else { cats.pill++; problems.push('圆/胶囊缺 corner-shape: round → ' + r.selector + ' (' + v + ')'); }
        continue;
      }
      const num = parseFloat(v);
      if (!Number.isFinite(num)) { problems.push('无法识别的圆角 → ' + r.selector + ': ' + v); continue; }
      radiusStats.set(num, (radiusStats.get(num) || 0) + 1);
      if (RADIUS_TOKENS.indexOf(num) === -1) { cats.radius++; problems.push('圆角越界 ' + num + 'px（不在 4/8/12/16/20/28）→ ' + r.selector); }
    }
    // 中性 solid 描边必须 0.5px
    const borderRe = /border(?:-(?:top|right|bottom|left))?\s*:\s*([0-9.]+)px\s+(solid|dashed)\s+var\(--(?:fde-border(?:-2)?|dsw-alias-border-l[1-4])/g;
    let bm;
    while ((bm = borderRe.exec(r.body))) {
      // 官方 web-styling 明确豁免 spinner 圆环宽度（1–2px 保持可辨识）
      if (/fde-spinner|rw-spinner/.test(r.selector)) continue;
      const w = parseFloat(bm[1]);
      const style = bm[2];
      if (style === 'solid' && w !== 0.5) { cats.border++; problems.push('中性 solid 描边 ' + w + 'px（应 0.5px）→ ' + r.selector); }
      if (style === 'dashed' && w !== 1) { cats.dashed++; problems.push('dashed 记号 ' + w + 'px（应 1px）→ ' + r.selector); }
    }
  }
  // 高层级表面：border + elevation 不得配对
  const hasRealBorder = (body) => {
    const re = /(?:^|[;{])\s*(border|border-(?:top|right|bottom|left))\s*:\s*([^;}]+)/g;
    let m;
    while ((m = re.exec(body))) {
      const v = String(m[2] || '').trim();
      if (/^0(?:\s|$)/.test(v)) continue; // border:0 —— 合规
      if (/^none(?:\s|$)/i.test(v)) continue;
      return true;
    }
    return false;
  };
  for (const sel of ['.fde-drawer', '.fde-modal']) {
    const r = rules.find((x) => x.selector === sel);
    if (r && hasRealBorder(r.body) && /box-shadow/.test(r.body)) {
      cats.elevation++;
      problems.push('高层级表面 ' + sel + ' 同时用 border + box-shadow（官方：border:0 + --dsw-elevation-*）');
    }
  }
  const rstats = [...radiusStats.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => k + 'px×' + v).join(' / ');
  const lines = ['圆角（非 token）：' + rstats, '圆/胶囊 ' + pills + ' 处，配 corner-shape ' + pillsWithCorner + ' 处'];
  lines.push('分类：圆角越界 ' + cats.radius + ' / 圆胶囊缺 corner-shape ' + cats.pill + ' / 中性 solid 描边 ' + cats.border + ' / dashed 宽 ' + cats.dashed + ' / 高层级材质 ' + cats.elevation);
  if (problems.length) lines.push('违规 ' + problems.length + ' 处；示例：', ...problems.slice(0, 8));
  record('A8', '几何 token（圆角/描边/材质）', problems.length ? 'FAIL' : 'PASS', lines);
}

/* ------------------------------------------------------------------ *
 * 运行
 * ------------------------------------------------------------------ */
const run = async () => {
  if (!JSON_ONLY) {
    console.log('# FDE ui-contract 体检 v1');
    console.log('源码：' + SOURCE_DISPLAY);
    console.log('契约：' + CONTRACT_DISPLAY);
    console.log('时间：' + new Date().toISOString());
    console.log('—'.repeat(72));
  }
  await checkA1();
  checkA2();
  checkA3();
  checkA4();
  checkA5();
  checkA6();
  checkA7();
  checkA8();

  const summary = { pass: 0, fail: 0, info: 0, warn: 0 };
  for (const r of results) {
    if (r.status === 'PASS') summary.pass++;
    else if (r.status === 'FAIL') summary.fail++;
    else if (r.status === 'INFO') summary.info++;
    else summary.warn++;
    if (!JSON_ONLY) {
      console.log('');
      const printer = C[{ PASS: 'ok', FAIL: 'fail', INFO: 'info', WARN: 'warn' }[r.status]] || C.info;
      console.log(printer(r.id + ' · ' + r.title));
      for (const l of r.lines) console.log('      ' + l);
    }
  }
  if (!JSON_ONLY) {
    console.log('');
    console.log('—'.repeat(72));
    console.log('总计：' + summary.pass + ' 通过 / ' + summary.fail + ' 违规 / ' + summary.info + ' 信息');
  }
  const payload = {
    ok: summary.fail === 0,
    source: SOURCE_DISPLAY,
    checkedAt: new Date().toISOString(),
    summary,
    checks: results.map((r) => ({ id: r.id, title: r.title, status: r.status, lines: r.lines })),
  };
  console.log('AUDIT-JSON ' + JSON.stringify(payload));
  process.exit(summary.fail === 0 ? 0 : 1);
};
run().catch((e) => {
  console.error('AUDIT 运行错误：' + (e && e.stack || e));
  process.exit(2);
});
