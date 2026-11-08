/**
 * 调研工作台 · 宿主侧共享逻辑
 * - 工作区根探测（多策略）
 * - 目录三分类：真项目 / 历史项目 / 素材目录
 * - 素材索引（散落的抓取原文）
 * - 项目内文件收集（md / pdf / 上传素材）
 * - 模板渲染
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const ARCHIVE = '00-项目档案.md';
/** 本地日期 YYYY-MM-DD（目录名/文档日期一律本地，不用 UTC toISOString）。 */
function localDateStr(d) {
  const x = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
const PROJECT_DIRS = ['raw', 'meeting', 'proposal', 'internal'];

function listDir(p) {
  try { return readdirSync(p); } catch { return []; }
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function countByExt(dir, exts) {
  if (!isDir(dir)) return 0;
  let n = 0;
  for (const f of listDir(dir)) {
    const p = join(dir, f);
    if (isDir(p)) n += countByExt(p, exts);
    else if (exts.some((e) => f.toLowerCase().endsWith(e))) n++;
  }
  return n;
}

const countMd = (dir) => countByExt(dir, ['.md']);
const countPdf = (dir) => countByExt(dir, ['.pdf']);

/* ---------------- 工作区根探测 ---------------- */

function hasProjectMarkers(p) {
  return existsSync(join(p, 'research')) || existsSync(join(p, 'projects'));
}

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

export function detectRoot(svcOf, explicit) {
  if (explicit) return { root: resolve(explicit), how: '参数指定' };

  const reg = svcOf('workspaceRegistry');
  if (reg) {
    for (const m of ['current', 'getCurrent', 'active']) {
      try {
        const p = pickPath(typeof reg[m] === 'function' ? reg[m]() : undefined);
        if (p) return { root: p, how: 'workspaceRegistry.' + m + '()' };
      } catch { /* 下一个 */ }
    }
    for (const m of ['list', 'all', 'workspaces']) {
      try {
        const v = typeof reg[m] === 'function' ? reg[m]() : undefined;
        const arr = Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);
        for (const it of arr) {
          const p = pickPath(it);
          if (p && hasProjectMarkers(p)) return { root: p, how: 'workspaceRegistry.' + m + '()' };
        }
      } catch { /* 下一个 */ }
    }
  }

  const sc = svcOf('sessionController');
  if (sc) {
    for (const m of ['current', 'getCurrent', 'active']) {
      try {
        const p = pickPath(typeof sc[m] === 'function' ? sc[m]() : undefined);
        if (p) return { root: p, how: 'sessionController.' + m + '()' };
      } catch { /* 下一个 */ }
    }
    try {
      const p = pickPath(sc);
      if (p) return { root: p, how: 'sessionController 属性' };
    } catch { /* 忽略 */ }
  }

  let cur = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (hasProjectMarkers(cur)) return { root: cur, how: 'cwd 上溯' };
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const c of [join(homedir(), 'Documents', 'dshtest'), process.cwd()]) {
    if (existsSync(c)) return { root: c, how: '常见位置回退' };
  }
  return { root: process.cwd(), how: 'process.cwd()' };
}

/* ---------------- 目录分类 ---------------- */

/**
 * project  真项目：有 00-项目档案.md，或有 raw/meeting/proposal/internal 任一，或 ≥2 个 md
 * legacy   历史项目：有 md 产物但未建档
 * material 素材目录：无 md，只有抓取的 html/txt/json 等原文
 */
function classify(p) {
  const archive = existsSync(join(p, ARCHIVE));
  const hasProjDir = PROJECT_DIRS.some((d) => existsSync(join(p, d)));
  const md = countMd(p);
  if (archive) return { kind: 'project', md, archive: true };
  if (hasProjDir || md >= 1) return { kind: 'legacy', md, archive: false };
  return { kind: 'material', md, archive: false };
}

function dirStat(p) {
  let mtime = 0;
  let files = 0;
  const walk = (d, depth) => {
    if (depth > 4) return;
    for (const f of listDir(d)) {
      if (f.startsWith('.')) continue;
      const q = join(d, f);
      let st;
      try { st = statSync(q); } catch { continue; }
      if (st.isDirectory()) walk(q, depth + 1);
      else { files++; mtime = Math.max(mtime, st.mtimeMs); }
    }
  };
  walk(p, 0);
  try { mtime = Math.max(mtime, statSync(p).mtimeMs); } catch { /* 忽略 */ }
  return { mtime, files };
}

export function scanProjects(root) {
  if (!isDir(root)) return [];
  const out = [];
  for (const name of listDir(root)) {
    const p = join(root, name);
    if (!isDir(p) || name.startsWith('.') || name === 'node_modules') continue;
    const c = classify(p);
    const st = dirStat(p);
    let title = name;
    if (c.archive) {
      try {
        const m = readFileSync(join(p, ARCHIVE), 'utf8').match(/^#\s*项目档案[：:]\s*(.+)$/m);
        if (m) title = m[1].trim();
      } catch { /* 忽略 */ }
    }
    out.push({
      dir: name,
      path: p,
      title,
      kind: c.kind,
      adopted: c.archive,
      mtime: st.mtime,
      fileCount: st.files,
      totalMd: c.md,
      stages: {
        archive: c.archive,
        research: countMd(join(p, 'research')),
        meeting: countMd(join(p, 'meeting')),
        proposal: countMd(join(p, 'proposal')),
        exports: countPdf(join(p, 'meeting')) + countPdf(join(p, 'proposal')) + countPdf(join(p, 'exports')),
      },
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 散落在 research/ 顶层、未归入任何子目录的素材文件 */
export function scanLooseMaterials(root, limit = 300) {
  if (!isDir(root)) return [];
  const out = [];
  for (const f of listDir(root)) {
    const p = join(root, f);
    if (isDir(p) || f.startsWith('.')) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    out.push({
      name: f,
      ext: (f.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase(),
      size: st.size,
      mtime: st.mtimeMs,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** 项目内文件（md / pdf / 上传素材 / 其他） */
export function collectFiles(projRoot) {
  const out = [];
  const walk = (dir, rel) => {
    for (const n of listDir(dir)) {
      if (n.startsWith('.')) continue;
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p, rel ? rel + '/' + n : n); continue; }
      const low = n.toLowerCase();
      const kind = low.endsWith('.pdf') ? 'pdf'
        : low.endsWith('.md') ? 'md'
          : /\.(html?|txt|json|csv|tsv|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|zip|gz)$/.test(low) ? 'asset'
            : 'other';
      out.push({
        rel: rel ? rel + '/' + n : n,
        name: n,
        kind,
        ext: (n.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase(),
        size: st.size,
        mtime: st.mtimeMs,
        upload: rel.startsWith('raw/uploads'),
      });
    }
  };
  walk(projRoot, '');
  for (const f of out) {
    if (f.kind !== 'md') continue;
    const stem = f.rel.replace(/\.md$/i, '');
    const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
    const base = stem.split('/').pop();
    f.pdfRel = (dir ? dir + '/exports/' : 'exports/') + base + '.pdf';
    f.exported = out.some((x) => x.kind === 'pdf' && x.rel === f.pdfRel);
  }
  const order = { md: 0, pdf: 1, asset: 2, other: 3 };
  return out.sort((a, b) => (order[a.kind] - order[b.kind]) || a.rel.localeCompare(b.rel));
}

/** 素材索引清单（把素材目录升级为项目时留档） */
export function renderMaterialsIndex(dirName, files) {
  const lines = [
    `# 素材索引：${dirName}`,
    '',
    '> 本文件由调研工作台自动生成，记录该目录下已抓取的原始素材，便于后续引用与追溯。',
    '',
    '| # | 文件 | 大小 | 修改时间 |',
    '|---|---|---|---|',
  ];
  files.slice(0, 500).forEach((f, i) => {
    lines.push(`| ${i + 1} | \`${f.rel}\` | ${(f.size / 1024).toFixed(1)} KB | ${new Date(f.mtime).toISOString().slice(0, 10)} |`);
  });
  lines.push('');
  lines.push(`共 ${files.length} 个文件。`);
  return lines.join('\n');
}

/** 项目档案模板渲染 */
export function renderArchive({ company, person, role, purpose, when, where }) {
  return `# 项目档案：${company}

> 本文件为项目总入口，记录输入、进展与结论状态。

---

## 一、输入三要素

| 项 | 内容 |
|---|---|
| 公司全称 | ${company} |
| 见面对象与职务 | ${person || ''} ${role ? '（' + role + '）' : ''} |
| 见面性质与目标 | ${purpose || ''} |
| 见面时间与地点 | ${[when, where].filter(Boolean).join(' · ')} |
| 我方身份 | <我方公司全称> |
| 建档日期 | ${localDateStr()} |

---

## 二、本次要拿到的三个结果

| # | 目标 | 判定标准 | 状态 |
|---|---|---|---|
| 1 | | | ☐ |
| 2 | | | ☐ |
| 3 | | | ☐ |

---

## 三、进展看板

| 步骤 | 产出 | 状态 |
|---|---|---|
| 1 立项 | 本文件 | ☑ |
| 2 侦察与主体锁定 | \`research/主体锁定与归属核对.md\` | ☐ |
| 3 信息抓取 | \`raw/\`（原文落盘；上传文件在 \`raw/uploads/\`） | ☐ |
| 4 事实核查 | \`research/事实核查清单.md\` | ☐ |
| 5 KPI 假设 | \`research/KPI与痛点假设.md\` | ☐ |
| 6 会面材料 | \`meeting/\`（Brief + 底稿 + 合作地图） | ☐ |
| 7 方案与 PDF | \`proposal/\`（md + exports/） | ☐ |

---

## 四、主体锁定结论

| 项 | 结论 | 证据 |
|---|---|---|
| 公司全称 | | |
| 实际控制人 / 母集团 | | |
| 与用户口述是否一致 | | |
| 一把手姓名与职务 | | |
| 办公地址（与见面地点核对） | | |

**三链验证**：自述链 ☐ ／ 上级链 ☐ ／ 排除链 ☐

---

## 五、已确认的关键事实（A 级）

| # | 事实 | 来源 |
|---|---|---|
| 1 | | |

---

## 六、待核实事项（C 级，现场验证）

| # | 待核实事项 | 影响 | 验证方式 | 状态 |
|---|---|---|---|---|
| C1 | | | | ☐ |

---

## 七、交付物清单

> **格式约定：md 为主格式（唯一事实来源），PDF 按需导出到 \`exports/\`。**

| 文件 | 用途 | md | PDF（按需） |
|---|---|---|---|
| \`meeting/<客户>面谈Brief.md\` | 现场打印 | ☐ | ☐ |
| \`meeting/<客户>合作地图.md\` | 谈"做什么" | ☐ | ☐ |
| \`meeting/<客户>面谈研判底稿（完整版）.md\` | 前一晚通读 | ☐ | ☐ |
| \`proposal/<项目>建设方案-*.md\` | 正式方案 | ☐ | ☐ |

**导出命令**：\`bash scripts/make-pdf.sh "<文件>.md"\` → 默认输出到同级 \`exports/\`

---

## 八、复盘（项目结束后填写）

**有效的做法**：

**踩过的坑**：

**可沉淀到工作台的内容**：
- ☐ 新增数据源 → \`reference/数据源清单.md\`
- ☐ 新增雷区 → \`reference/雷区清单.md\`
- ☐ 方法论改进 → \`methods/\`
`;
}
