/**
 * 构建 client.js = 面板 UI
 * 用法: node build.mjs
 *
 * 构建前做三项检查（后两项见 ADR 0010 D2，实现在 tools/panel-checks.mjs）：
 *  1. 入口与模块 id 正确；
 *  2. 文案字典完整：每个被引用的 key 都要有非空文案，缺一个就构建失败——
 *     界面不会再把 key 名当文案显示；
 *  3. 面板禁词：给人看的中文文案里不出现内部用语与内部标识。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDict, findBannedWords } from './tools/panel-checks.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const ui = readFileSync(join(root, 'src', 'ui', 'ui-panel.js'), 'utf8');

if (!ui.includes('window.__ModuleLoader__.load')) {
  throw new Error('src/ui/ui-panel.js 缺少 __ModuleLoader__ 入口');
}
/* ADR 0004 D1：包名与 client-modules 模块 id 统一为 dsh-fde（一次改全）。 */
if (!ui.includes("id: 'dsh-fde'")) {
  throw new Error("src/ui/ui-panel.js 的模块 id 必须是 dsh-fde");
}

const dict = checkDict(ui);
if (dict.missing.length) {
  throw new Error(`文案字典缺 ${dict.missing.length} 个 key（界面会显示成 key 名）：${dict.missing.join('、')}`);
}
const banned = findBannedWords(ui);
if (banned.length) {
  const lines = banned.slice(0, 20).map((x) => `  「${x.word}」 ← ${x.text}`);
  throw new Error(`面板文案里有 ${banned.length} 处内部用语（见 ADR 0010 D1）：\n${lines.join('\n')}`);
}

writeFileSync(join(root, 'client.js'), ui, 'utf8');
console.log(`built: client.js (${(ui.length / 1024).toFixed(1)} KB)`);
if (dict.unused.length) {
  console.log(`  提示：字典里有 ${dict.unused.length} 个没被引用的 key：${dict.unused.join('、')}`);
}
