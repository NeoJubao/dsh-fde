/**
 * 构建 client.js = 面板 UI
 * 用法: node build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const ui = readFileSync(join(root, 'src', 'ui', 'ui-panel.js'), 'utf8');

if (!ui.includes('window.__ModuleLoader__.load')) {
  throw new Error('src/ui/ui-panel.js 缺少 __ModuleLoader__ 入口');
}
/* ADR 0004 D1：包名与 client-modules 模块 id 统一为 dsh-fde（一次改全）。 */
if (!ui.includes("id: 'dsh-fde'")) {
  throw new Error("src/ui/ui-panel.js 的模块 id 必须是 dsh-fde");
}

writeFileSync(join(root, 'client.js'), ui, 'utf8');
console.log(`built: client.js (${(ui.length / 1024).toFixed(1)} KB)`);
