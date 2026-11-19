/**
 * FDE 工作站 · 工具返回值出口（DSH 0.2.1 兼容）
 *
 * DSH 0.2.1 的工具注册表在登记结果前会给返回值做一次「无损 JSON」快照：
 * 值为 undefined 的键、NaN / ±Infinity、-0、稀疏数组、非普通对象、环引用，任一出现
 * 都判 INVALID_TOOL_OUTPUT（模型拿不到结果）。本模块把任意返回值规整成普通 JSON 值，
 * 规整后的值满足：JSON.parse(JSON.stringify(x)) 与 x 深度相等。
 *
 * 规则（与 JSON.stringify 的取舍一致，只是不经过字符串）：
 * - 对象里值为 undefined / 函数 / symbol 的键：剔除；
 * - 数组里的 undefined / 函数 / symbol / 空位：转 null（保持长度与下标）；
 * - 非有限数字（NaN / ±Infinity）：转 null；-0 转 0；
 * - 带 toJSON 的对象（如 Date）：取 toJSON() 的结果；bigint：转字符串；
 * - 环引用：断开处置为 null；其它非普通对象：只取自身可枚举的字符串键。
 *
 * 纯函数：不改入参，只依赖语言内置。
 */

const DROP = Symbol('drop');

function convert(value, ancestors) {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) return null;
      return value === 0 ? 0 : value; /* -0 → 0 */
    case 'bigint':
      return String(value);
    case 'undefined':
    case 'function':
    case 'symbol':
      return DROP;
    default:
      break;
  }
  if (ancestors.has(value)) return null; /* 环引用：断开 */
  if (typeof value.toJSON === 'function') {
    let json;
    try { json = value.toJSON(); } catch { return DROP; }
    /* toJSON 返回自身时按普通对象继续，避免无限递归。 */
    if (json !== value) return convert(json, ancestors);
  }
  ancestors.add(value);
  let out;
  if (Array.isArray(value)) {
    out = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      const v = convert(value[i], ancestors);
      out[i] = v === DROP ? null : v;
    }
  } else {
    out = {};
    for (const key of Object.keys(value)) {
      let raw;
      try { raw = value[key]; } catch { continue; }
      const v = convert(raw, ancestors);
      if (v === DROP) continue;
      /* 直接赋值 '__proto__' 会改原型，必须按数据属性定义。 */
      if (key === '__proto__') Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      else out[key] = v;
    }
  }
  ancestors.delete(value);
  return out;
}

/**
 * 把任意值规整为无损 JSON 值。顶层是 undefined / 函数 / symbol 时返回 null。
 * @param {unknown} value
 * @returns {null|boolean|number|string|Array|object}
 */
export function toLosslessJson(value) {
  const out = convert(value, new Set());
  return out === DROP ? null : out;
}

/**
 * 给一个工具定义套上统一出口（返回新对象，不改原定义）：
 * - execute 的返回值（同步值或 Promise）一律经过 toLosslessJson；
 * - execute 同步抛错或 Promise 拒绝时不向外抛，改为返回 describeError(e, def) 的结果
 *   （同样经过 toLosslessJson）——工具不抛异常，失败用 {ok:false, reason} 表达。
 *
 * @param {object} def 工具定义（含 execute）
 * @param {(error:unknown, def:object)=>object} describeError 把异常转成结构化失败结果
 * @returns {object}
 */
export function guardTool(def, describeError) {
  if (!def || typeof def.execute !== 'function') return def;
  const run = def.execute;
  const fail = (e) => {
    let described;
    try { described = describeError(e, def); } catch { described = null; }
    if (!described || typeof described !== 'object') {
      const reason = '操作失败：' + String((e && e.message) || e);
      described = { ok: false, reason, text: reason };
    }
    return toLosslessJson(described);
  };
  return Object.assign({}, def, {
    execute(...args) {
      let out;
      try { out = run.apply(def, args); } catch (e) { return Promise.resolve(fail(e)); }
      return Promise.resolve(out).then(toLosslessJson, fail);
    },
  });
}
