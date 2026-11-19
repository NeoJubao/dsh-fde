/**
 * 面板源码的两项文本检查（ADR 0010 D2）。纯函数，不读写文件；
 * 由 build.mjs（构建前）与 verify/client-static.mjs（验证时）共用。
 *
 *  checkDict(source)       文案字典完整性：每个被引用的 key 都要有非空文案
 *  findBannedWords(source) 面板禁词：给人看的中文文案里不出现内部用语与内部标识
 */

/** 文案字典完整性检查；返回 {keys, used, missing, unused}。 */
export function checkDict(source) {
  const start = source.indexOf('const DICT = {');
  const end = source.indexOf('const t = (k)');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('面板源码里找不到 DICT 或 t()');
  }
  const dictSrc = source.slice(start, end);
  const keys = new Set();
  for (const m of dictSrc.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(['"`])((?:\\.|(?!\2).)*)\2/g)) {
    if (m[3].length) keys.add(m[1]);
  }
  const used = new Set();
  /* 三种引号都认：t('k')、t("k")、t(`k`)。t(变量) 这种动态写法静态查不到，
     只能靠下面的 dict-keys 标记覆盖——新增动态 key 时记得给映射表加标记。 */
  for (const m of source.matchAll(/\bt\(\s*(['"`])([A-Za-z_$][\w$]*)\1\s*\)/g)) used.add(m[2]);
  const rest = source.slice(end);
  for (const m of rest.matchAll(/\bDICT\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  /* 动态 key：映射表声明前以 dict-keys 注释标记，表内所有字符串值都算被引用。 */
  for (const m of source.matchAll(/\/\*\s*dict-keys\s*\*\/[^=]*=\s*\{([\s\S]*?)\};/g)) {
    for (const v of m[1].matchAll(/:\s*'([A-Za-z_$][\w$]*)'/g)) used.add(v[1]);
  }
  const missing = [...used].filter((k) => !keys.has(k)).sort();
  const unused = [...keys].filter((k) => !used.has(k) && !new RegExp(`['"]${k}['"]`).test(rest)).sort();
  return { keys, used, missing, unused };
}

/**
 * 面板禁词（ADR 0010 D1「不再出现在界面」一栏 + D2 内部标识）。
 * 只检查「含中文的字符串字面量」——也就是会显示给人看的文案；
 * 注释、正则（旧记录的显示替换用得到这些词）、纯英文的程序标识不在检查范围内。
 */
export const BANNED_WORDS = [
  '注意力', '门禁', '自主性', '工件', '泳道', '回报', '干系人', '宿主', '时间线', '停滞', '演示模式', '客户卷',
  '硬红线', '启动会话', '会话派发', '采纳建议', '忽略建议', '规则引擎',
  'WIP', 'board.json', '/fde/', 'engagement', 'nextAction', 'handoff', 'access_token', 'catalog', 'sandbox',
];

/** 去掉注释与样式表后，取出含中文的字符串字面量。 */
export function visibleStrings(source) {
  let js = source;
  const cssStart = js.indexOf('const CSS = `');
  if (cssStart !== -1) {
    const cssEnd = js.indexOf('`;', cssStart);
    if (cssEnd !== -1) js = js.slice(0, cssStart) + js.slice(cssEnd + 2);
  }
  const out = [];
  /* 依次匹配：块注释 / 行注释 / 正则字面量（粗略）/ 单引号串 / 双引号串 / 模板串。
     只有后三种会被收集；前三种只是为了跳过其中的引号与文字。 */
  const token = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?<=[=(,:[!&|?{};]\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[gimsuy]*|'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`/g;
  for (const m of js.matchAll(token)) {
    const text = m[1] ?? m[2] ?? m[3];
    if (text === undefined) continue;
    if (/[一-鿿]/.test(text)) out.push({ text, index: m.index });
  }
  return out;
}

/** 返回命中的禁词列表：[{word, text}]。空数组表示通过。 */
export function findBannedWords(source, words = BANNED_WORDS) {
  const hits = [];
  for (const { text } of visibleStrings(source)) {
    for (const w of words) {
      if (text.includes(w)) hits.push({ word: w, text: text.length > 60 ? text.slice(0, 60) + '…' : text });
    }
  }
  return hits;
}
