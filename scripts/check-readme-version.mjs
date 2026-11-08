#!/usr/bin/env node
/**
 * README 版本标识 与 package.json.version 一致性检查（零依赖，纯 node）
 *
 * 约定（ADR-0004 D1 / 实施规格 §4.6）：
 *   - 包名 `dsh-fde`，版本按 SemVer（当前 1.3.0）
 *   - README「顶部」（首个二级标题 `## ` 之前）必须有版本标识 `vX.Y` 或 `vX.Y.Z`
 *   - 只写主次版本（`v1.3`）时，要求与 package.json 的 major.minor 一致；
 *     写全（`v1.3.0`）时要求完全一致
 *
 * 用法：
 *   node scripts/check-readme-version.mjs          # 校验仓库根（本脚本上一级目录）
 *   node scripts/check-readme-version.mjs <dir>    # 校验指定目录（含 package.json / README.md）
 *
 * 退出码：一致 → 0；不一致 / 文件缺失 → 1
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argDir = process.argv.slice(2).find((a) => !a.startsWith('-'));
const ROOT = resolve(argDir || join(HERE, '..'));
const pkgFile = join(ROOT, 'package.json');
const readmeFile = join(ROOT, 'README.md');

const fail = (msg) => {
  console.log('✗ README 版本检查失败：' + msg);
  process.exit(1);
};

if (!existsSync(pkgFile)) fail('找不到 ' + pkgFile);
if (!existsSync(readmeFile)) fail('找不到 ' + readmeFile);

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
} catch (e) {
  fail('package.json 无法解析：' + ((e && e.message) || e));
}
const version = String((pkg && pkg.version) || '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  fail('package.json.version 不是合法 SemVer：' + JSON.stringify(version));
}
const [pkgMajor, pkgMinor] = version.split('.');

const readme = readFileSync(readmeFile, 'utf8');
/* 「顶部」= 首个二级标题之前；README 若没有二级标题，只看前 4000 字。 */
const h2 = readme.indexOf('\n## ');
const top = h2 === -1 ? readme.slice(0, 4000) : readme.slice(0, h2);
if (!top.trim()) fail('README 顶部为空，无法找到版本标识');

/* 优先取「版本 / 状态 / version」所在行的版本号，避免误抓运行环境版本（如 Harness 0.2.0-rc.2）。
 * 顶部没有时兜底扫全文首个版本声明（README 结构差异不影响「README 明示版本 = package.json.version」这一不变量）。 */
const VERSION_RE = /\bv(\d+)\.(\d+)(?:\.(\d+))?/i;
const findVersion = (lines) => {
  for (const line of lines.filter((l) => /版本|状态|version/i.test(l))) {
    const hit = VERSION_RE.exec(line);
    if (hit) return hit;
  }
  for (const line of lines) {
    const hit = VERSION_RE.exec(line);
    if (hit) return hit;
  }
  return null;
};
let m = findVersion(top.split('\n'));
let where = '顶部';
if (!m) {
  m = findVersion(readme.split('\n'));
  where = '全文首个版本声明';
}

if (!m) fail('README 找不到 vX.Y 版本标识（建议在顶部写成「版本：v' + version + '」）');

const major = m[1];
const minor = m[2];
const patch = m[3];
const readmeLabel = 'v' + major + '.' + minor + (patch ? '.' + patch : '');
const expected = patch
  ? 'v' + version
  : 'v' + pkgMajor + '.' + pkgMinor;

if (readmeLabel !== expected) {
  fail('README 顶部 ' + readmeLabel + ' ≠ package.json.version ' + version +
    '（写主次版本时按 ' + 'v' + pkgMajor + '.' + pkgMinor + ' 比较；写全版本时须完全一致）');
}

console.log('✓ README 版本一致：README ' + where + ' ' + readmeLabel + ' ≡ package.json.version ' + version +
  '（包名 ' + ((pkg && pkg.name) || '(空)') + '）');
process.exit(0);
