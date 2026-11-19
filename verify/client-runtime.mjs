/**
 * 客户端半「准运行时」测试（FDE 工作站）
 * 用法: node verify/client-runtime.mjs
 *
 * 用一个迷你 React（支持嵌套函数组件 + hooks + effect 清理）+ 替身
 * window/document/fetch，eval client.js 后真实渲染面板，走通：
 *  - FDE 九视图渲染（含流程 v2 与资料库）、今日注意力动作、建议采纳
 *  - 看板客户模式/任务模式、HTML5 拖拽、Alt+方向键、门禁缺项确认、证据确认
 *  - v1.5.0 只读演示模式：空板横幅 / DEMO 渲染 / 写操作拦截 / 一键清除 / 设置卡恢复
 *  - 客户/任务抽屉、门禁人工勾选与证据、启动会话、归档/删除确认
 *  - 客户导入（adopt scan/apply）、工件（Finder/导出）、方法、设置
 *  - 宿主未就绪页 + Finder 三通道降级
 *  - 轮询间隔与「切页签立即刷新」
 * 断言的是 client.js 里的真实逻辑，不是复制品。注意：迷你 React 不是
 * 真实 React，行为等价性以「用户操作 → 网络请求/渲染文案」为准。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'client.js'), 'utf8');

const fail = [];
const ok = [];
const check = (name, cond, extra) => {
  const pass = !!cond;
  console.log((pass ? '  ✓ ' : '  ✗ ') + name + (pass || !extra ? '' : ' → ' + String(extra).slice(0, 300)));
  (pass ? ok : fail).push(name);
};

/* ================= 迷你 React（嵌套组件 + hooks + 清理） ================= */
const instances = new Map();
let stack = [];
let dirty = false;
let pendingEffects = [];
const intervalRecords = [];

function instFor(path, type, key) {
  let inst = instances.get(path);
  if (!inst || inst.type !== type || inst.key !== key) {
    inst = { path, type, key, hooks: [], deps: [], refs: [], memos: [], cleanups: [], cursor: 0 };
    instances.set(path, inst);
  }
  return inst;
}
const currentInst = () => stack[stack.length - 1];
const sameDeps = (prev, deps) => Array.isArray(prev) && Array.isArray(deps)
  && prev.length === deps.length && prev.every((d, i) => d === deps[i]);

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const p = Object.assign({}, props || {});
    const flat = children.flat(Infinity);
    if (flat.length) p.children = flat.length === 1 ? flat[0] : flat;
    return { type, props: p, children: flat };
  },
  useState(init) {
    const inst = currentInst();
    const i = inst.cursor++;
    if (!(i in inst.hooks)) inst.hooks[i] = typeof init === 'function' ? init() : init;
    const set = (v) => {
      const nv = typeof v === 'function' ? v(inst.hooks[i]) : v;
      if (nv !== inst.hooks[i]) { inst.hooks[i] = nv; dirty = true; }
    };
    return [inst.hooks[i], set];
  },
  useEffect(fn, deps) {
    const inst = currentInst();
    const i = inst.cursor++;
    if (sameDeps(inst.deps[i], deps)) return;
    inst.deps[i] = Array.isArray(deps) ? deps.slice() : undefined;
    pendingEffects.push({ inst, i, fn });
  },
  useCallback(fn, deps) {
    const inst = currentInst();
    const i = inst.cursor++;
    if (!sameDeps(inst.deps[i], deps)) {
      inst.deps[i] = Array.isArray(deps) ? deps.slice() : undefined;
      inst.memos[i] = fn;
    }
    return inst.memos[i] || fn;
  },
  useRef(v) {
    const inst = currentInst();
    const i = inst.cursor++;
    if (!(i in inst.refs)) inst.refs[i] = { current: v };
    return inst.refs[i];
  },
  useMemo(fn, deps) {
    const inst = currentInst();
    const i = inst.cursor++;
    if (!sameDeps(inst.deps[i], deps)) {
      inst.deps[i] = Array.isArray(deps) ? deps.slice() : undefined;
      inst.memos[i] = fn();
    }
    return inst.memos[i];
  },
};

function renderNode(node, path) {
  if (node === null || node === undefined || node === false || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n, i) => renderNode(n, path + '/' + i));
  if (typeof node.type === 'function') {
    const key = node.props && node.props.key;
    const inst = instFor(path, node.type, key);
    inst.cursor = 0;
    stack.push(inst);
    let out;
    try { out = node.type(node.props); } finally { stack.pop(); }
    /* 组件输出用 path+'~' 区分「组件实例槽」与「其输出树」，避免同路径互相覆盖 */
    return renderNode(out, path + '~');
  }
  return {
    type: node.type,
    props: node.props || {},
    children: (node.children || []).map((c, i) => renderNode(c, path + '/' + i)),
  };
}

function runEffects() {
  const list = pendingEffects;
  pendingEffects = [];
  return list.map(({ inst, i, fn }) => {
    const prev = inst.cleanups[i];
    if (typeof prev === 'function') { try { prev(); } catch (e) { /* ignore */ } }
    let ret;
    try { ret = fn(); } catch (e) { return null; }
    inst.cleanups[i] = typeof ret === 'function' ? ret : undefined;
    return ret && typeof ret.then === 'function' ? ret.catch(() => null) : null;
  });
}

function unmountAll() {
  instances.forEach((inst) => {
    inst.cleanups.forEach((fn) => { if (typeof fn === 'function') { try { fn(); } catch (e) { /* ignore */ } } });
    inst.cleanups = [];
  });
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms === undefined ? 5 : ms));

async function renderStable(App, props) {
  let tree = null;
  for (let pass = 0; pass < 40; pass++) {
    dirty = false;
    stack = [];
    tree = renderNode(React.createElement(App, props), 'root');
    const rets = runEffects();
    await Promise.all(rets.map((p) => (p && p.then ? p : Promise.resolve(null))));
    await tick();
    if (!dirty) return tree;
  }
  return tree;
}

/* ================= 全局替身 ================= */
const fetchCalls = [];
let routeTable = {};
let routeSeq = {};

function stub(method, url, handler) { routeTable[method + ' ' + url] = handler; }
function route(method, url, body) {
  let key = method + ' ' + url;
  let h2 = routeTable[key];
  if (!h2) {
    /* 带 query 的读路由：用「路径前缀」匹配（如 /bids/search?...） */
    const bare = String(url).split('?')[0];
    let best = '';
    Object.keys(routeTable).forEach((k) => {
      const sp = k.indexOf(' ');
      if (sp === -1 || k.slice(0, sp) !== method) return;
      const u = k.slice(sp + 1);
      if ((u === bare || bare.indexOf(u) === 0) && u.length > best.length) best = u;
    });
    if (best) { key = method + ' ' + best; h2 = routeTable[key]; }
  }
  routeSeq[key] = (routeSeq[key] || 0) + 1;
  const n = routeSeq[key];
  if (!h2) return { ok: false, reason: 'no stub: ' + method + ' ' + url };
  return typeof h2 === 'function' ? h2({ method, url, body, nth: n }) : h2;
}

const windowOpens = [];
globalThis.window = {
  __ModuleLoader__: { load(def) { globalThis.__rwDef = def; } },
  open: (url, target, features) => {
    windowOpens.push({ url: String(url), target: String(target || ''), features: String(features || '') });
    return null;
  },
};
globalThis.document = {
  createElement: () => ({ setAttribute() {}, textContent: '', parentNode: null }),
  head: { appendChild() {} },
};
/* 记录写入剪贴板的文本（阶段指南里点技能 / 工具会复制一句话） */
const clipboardWrites = [];
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async (text) => { clipboardWrites.push(String(text)); } }, platform: 'MacIntel' },
  configurable: true, writable: true,
});
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => {
  const id = realSetInterval(fn, ms);
  if (id && typeof id.unref === 'function') id.unref();
  intervalRecords.push({ ms, id });
  return id;
};
globalThis.fetch = async (url, init) => {
  const method = String((init && init.method) || 'GET').toUpperCase();
  let body;
  try { body = init && init.body ? JSON.parse(init.body) : undefined; } catch (e) { body = undefined; }
  const call = { method, url: String(url), body };
  fetchCalls.push(call);
  const payload = route(method, call.url, body);
  const textBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => textBody,
    blob: async () => new Blob([textBody], { type: 'text/plain' }),
  };
};

/* ================= 加载 client.js ================= */
// eslint-disable-next-line no-eval
(0, eval)(src);
const def = globalThis.__rwDef;
check('__ModuleLoader__.load 被调用', !!def, 'def 为空');
const mod = def.factory((n) => {
  if (n === 'react') return React;
  throw new Error('未知 require：' + n);
});
check('模块导出 inject/apply', Array.isArray(mod.inject) && typeof mod.apply === 'function');
check('inject 含 slots/uiWorkspace', mod.inject.includes('slots') && mod.inject.includes('uiWorkspace'));

const sessionOpened = [];
function makeCtx(remote) {
  const captured = { main: null, sidebar: null };
  const ctx = {
    get(n) {
      if (n === 'slots') return ctx.slots;
      if (n === 'uiWorkspace') return ctx.uiWorkspace;
      if (n === 'remote.session') return remote;
      return undefined;
    },
    uiWorkspace: { openSession: (id) => { sessionOpened.push(id); return true; } },
    slots: {
      inject(_name, fn) { fn(); },
      register(meta, comp) {
        if (meta.name === 'main') captured.main = comp;
        if (meta.name === 'sidebar.panellist') captured.sidebar = comp;
        return () => {};
      },
    },
    effect(fn) { try { const d = typeof fn === 'function' ? fn() : fn; return () => { if (typeof d === 'function') d(); }; } catch { return () => {}; } },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, captured };
}
const applied = makeCtx(undefined);
mod.apply(applied.ctx);
check('面板已注册 main 组件', typeof applied.captured.main === 'function');
check('面板已注册侧边栏条目', typeof applied.captured.sidebar === 'function');

/* ================= 测试工具 ================= */
const textOf = (node) => {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children || []).map(textOf).join('');
};
function collect(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => collect(n, pred, out)); return out; }
  if (pred(node)) out.push(node);
  (node.children || []).forEach((c) => collect(c, pred, out));
  return out;
}
const byType = (tree, type) => collect(tree, (n) => n.type === type);
const buttons = (tree) => collect(tree, (n) => n.type === 'button');
const btnByText = (tree, txt) => buttons(tree).filter((b) => textOf(b).includes(txt));
const btnExact = (tree, txt) => buttons(tree).filter((b) => textOf(b).trim() === txt);
/* Phase 2 IA：5 页签导航按钮在 .fde-nav 内，文本可能带计数（如「今日20」） */
const navBtn = (tree, label) => {
  const nav = byClass(tree, 'fde-nav')[0];
  if (!nav) return null;
  return buttons({ children: [nav] }).filter((b) => textOf(b).trim().indexOf(label) === 0)[0] || null;
};
const byAria = (tree, label) => collect(tree, (n) => n.props && n.props['aria-label'] && String(n.props['aria-label']).indexOf(label) !== -1);
const byClass = (tree, cls) => collect(tree, (n) => n.props && typeof n.props.className === 'string' && n.props.className.split(/\s+/).indexOf(cls) !== -1);
const inputByAria = (tree, label) => byType(tree, 'input').concat(byType(tree, 'textarea'), byType(tree, 'select'))
  .filter((n) => n.props && String(n.props['aria-label'] || n.props.placeholder || '').indexOf(label) !== -1);

function evt(over) {
  return Object.assign({
    preventDefault() {}, stopPropagation() {},
    target: { value: '', checked: false },
    currentTarget: null,
  }, over || {});
}
async function act(App, props, fn) {
  fn();
  let tree = null;
  for (let i = 0; i < 8; i++) {
    tree = await renderStable(App, props);
    await tick(5);
  }
  return tree;
}
function lastCall(method, urlFragment) {
  for (let i = fetchCalls.length - 1; i >= 0; i--) {
    const c = fetchCalls[i];
    if ((method === undefined || c.method === method) && c.url.indexOf(urlFragment) !== -1) return c;
  }
  return null;
}
function callsOf(method, urlFragment) {
  return fetchCalls.filter((c) => (method === undefined || c.method === method) && c.url.indexOf(urlFragment) !== -1);
}

/* ================= 夹具（宿主契约：spec §3/§4 + host-dev 确认形状） ================= */
const TODAY = (() => {
  const d = new Date();
  const p2 = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
})();
const ABS = '/tmp/ws/research/某环境-20261013';

const META = {
  version: 1,
  apiPrefix: '/research-workbench/api/fde',
  stages: [
    { key: 'lead', label: '线索', order: 1, gate: 'intake', definition: '已识别客户/机会', playbook: {
      goal: '把机会登记成可跟进线索，写清来源与下一步',
      inputs: ['线索来源', '客户名称与联系人'],
      activities: ['登记客户', '确认下一步与到期', '设置优先级'],
      outputs: ['00-项目档案.md'],
      tools: [
        { kind: 'skill', name: 'fde-engagement', label: '客户建档技能' },
        { kind: 'library', name: 'fde_library', label: '资料库：行业背景' },
      ],
      pitfalls: ['拿到名片就当天冲过去', '不写来源，后面无法核验'],
    } },
    { key: 'discovery', label: '研判', order: 2, gate: 'discovery', definition: '主体锁定/事实核查/KPI假设', playbook: {
      goal: '锁定主体，形成可核查的事实底稿与 KPI 假设',
      inputs: ['客户全称/地址', '公开资料'],
      activities: ['地址锚定', '三链验证', '事实分级', 'KPI 反推'],
      outputs: ['research/事实核查清单.md', 'research/KPI与痛点假设.md'],
      tools: [
        { kind: 'skill', name: 'fde-discovery', label: '研判技能' },
        { kind: 'method', name: '01-主体锁定与三链验证.md', label: '主体锁定与三链验证' },
        { kind: 'library', name: 'fde_library', label: '资料库：国内官方' },
      ],
      pitfalls: ['把同园区他单位当客户', '二手媒体当 A 级证据'],
    } },
    { key: 'meeting', label: '会面', order: 3, gate: 'meeting', definition: 'Brief/底稿/合作地图', playbook: {
      goal: '按见面对象层级准备现场材料，拿到可执行需求',
      inputs: ['研判底稿', '见面对象与职务'],
      activities: ['写现场 Brief', '准备合作地图', '会后补记录'],
      outputs: ['meeting/现场Brief.md', 'meeting/合作地图.md'],
      tools: [
        { kind: 'skill', name: 'fde-meeting', label: '会面准备技能' },
        { kind: 'template', name: '会面Brief模板.md', label: '会面 Brief 模板' },
        { kind: 'library', name: 'fde_library', label: '资料库：同行动态' },
      ],
      pitfalls: ['一把手讲技术细节，执行层讲战略空话'],
    } },
    { key: 'scoping', label: '场景', order: 4, gate: 'scoping', definition: '需求收敛/场景选择/数据体检/范围确认', playbook: {
      goal: '把需求池收敛到可启动场景（四条硬门槛全满足）',
      inputs: ['需求池', '数据可得性清单', '发起人与预算信号'],
      activities: ['四条硬门槛判定', '场景加权评分', '数据体检', '范围与发起人确认'],
      outputs: ['scoping/场景评估表.md', 'scoping/数据可得性清单.md'],
      tools: [
        { kind: 'skill', name: 'fde-scoping', label: '场景技能' },
        { kind: 'method', name: '06-场景选择与数据体检.md', label: '场景选择与数据体检' },
        { kind: 'template', name: '场景评估表.md', label: '场景评估表' },
        { kind: 'tool', name: 'fde_scenario', label: '场景评估' },
        { kind: 'library', name: 'fde_library', label: '资料库：场景参考' },
      ],
      pitfalls: ['没有有姓名的发起人', '数据要 30 天才能拿到还承诺 14 天上线'],
    } },
    { key: 'solution', label: '方案', order: 5, gate: 'solution', definition: '正式方案/成本/报价/边界', playbook: {
      goal: '出可对外定稿的方案，含成本测算与报价边界',
      inputs: ['场景评估表', '数据体检结论'],
      activities: ['写方案', '成本测算', '报价与 SOW', '列边界与除外'],
      outputs: ['proposal/正式方案.md', 'proposal/成本测算.md', 'proposal/报价单.md'],
      tools: [
        { kind: 'skill', name: 'fde-solution', label: '方案技能' },
        { kind: 'method', name: '07-成本评估与报价.md', label: '成本评估与报价' },
        { kind: 'template', name: '成本测算与报价单.md', label: '成本测算与报价单' },
        { kind: 'tool', name: 'fde_quote', label: '成本与报价测算' },
        { kind: 'library', name: 'fde_library', label: '资料库：国外官方' },
      ],
      pitfalls: ['只报人天不算税与预备费', '报价低于成本线'],
    } },
    { key: 'pilot', label: '试点', order: 6, gate: 'pilot', definition: 'POC/成功指标/验收口径', playbook: {
      goal: '用最小范围验证价值，写清成功指标与验收口径',
      inputs: ['定稿方案', '试点范围'],
      activities: ['Pilot Charter', '指标定义', '客户确认'],
      outputs: ['pilot/PilotCharter.md'],
      tools: [
        { kind: 'skill', name: 'fde-pilot', label: '试点技能' },
        { kind: 'library', name: 'fde_library', label: '资料库：开源工具' },
      ],
      pitfalls: ['试点范围越做越大', '没有验收口径'],
    } },
    { key: 'delivery', label: '交付', order: 7, gate: 'delivery', definition: '实施验收/风险登记', playbook: {
      goal: '按验收清单完成实施与交接',
      inputs: ['Pilot 结论', '交付清单'],
      activities: ['实施排期', '风险登记', '验收'],
      outputs: ['delivery/验收清单.md'],
      tools: [
        { kind: 'skill', name: 'fde-delivery', label: '交付技能' },
        { kind: 'library', name: 'fde_library', label: '资料库：方法与模板' },
      ],
      pitfalls: ['口头验收没有证据', '文档缺失导致交接失败'],
    } },
    { key: 'adoption', label: '采用', order: 8, gate: 'adoption', definition: '培训/使用证据/扩展地图', playbook: {
      goal: '让客户真正用起来，并拿到可复用的价值证据',
      inputs: ['上线系统', '使用数据'],
      activities: ['培训', '使用证据采集', 'ROI 复盘', '扩展地图'],
      outputs: ['adoption/使用证据.md', 'adoption/扩展地图.md'],
      tools: [
        { kind: 'skill', name: 'fde-adoption', label: '采用技能' },
        { kind: 'library', name: 'fde_library', label: '资料库：社区动态' },
      ],
      pitfalls: ['上线即结束，没人用', '没有 ROI 就无法扩展'],
    } },
  ],
  terminalStages: [{ key: 'archived', label: '归档' }, { key: 'lost', label: '流失' }],
  boardLanes: ['todo', 'doing', 'waiting', 'review', 'done'],
  lanes: [
    { key: 'inbox', label: '待整理', board: false },
    { key: 'todo', label: '待开始', board: true },
    { key: 'doing', label: '进行中', board: true, wip: true },
    { key: 'waiting', label: '等对方', board: true },
    { key: 'review', label: '待验收', board: true },
    { key: 'done', label: '已完成', board: true },
    { key: 'canceled', label: '已取消', board: false },
  ],
  itemTypes: [
    { key: 'research', label: '调研' }, { key: 'meeting', label: '会面' },
    { key: 'solution', label: '方案' }, { key: 'followup', label: '跟进' },
  ],
  priorities: [{ key: 'high', label: '高' }, { key: 'normal', label: '中' }, { key: 'low', label: '低' }],
  autonomyModes: [
    { key: 'observe', label: '只提醒，由我决定', definition: 'AI 只提醒，不替你改任何东西；每件事都由你决定' },
    { key: 'assisted', label: '小事可以直接处理', definition: 'AI 可以给没定下一步的客户补一条待确认的下一步、为新招采公告建跟进任务；其余都要你决定' },
    { key: 'auto', label: '小事可以直接处理', definition: 'AI 可以给没定下一步的客户补一条待确认的下一步、为新招采公告建跟进任务；其余都要你决定' },
  ],
  redLines: ['推进客户阶段', '确认推进条件', '导出或发送对外材料'],
  gates: {
    lead: { key: 'intake', label: '进入「线索」的条件', stage: 'lead', auto: [{ key: 'company', label: '公司名' }, { key: 'source', label: '来源' }, { key: 'next_action', label: '下一步' }], manual: [] },
    discovery: {
      key: 'discovery', label: '进入「研判」的条件', stage: 'discovery',
      auto: [{ key: 'archive', label: '项目档案' }, { key: 'factcheck', label: '事实核查清单' }],
      manual: [{ key: 'subject_locked', label: '主体已锁定' }, { key: 'evidence_graded', label: '事实已分级' }],
    },
    meeting: { key: 'meeting', label: '进入「会面」的条件', stage: 'meeting', auto: [{ key: 'brief', label: '会面 Brief' }], manual: [{ key: 'meeting_goal', label: '会面目标已确认' }] },
    scoping: {
      key: 'scoping', label: '进入「场景」的条件', stage: 'scoping',
      auto: [{ key: 'scenario', label: '场景评估表' }],
      manual: [
        { key: 'sponsor_named', label: '有姓名的业务发起人' },
        { key: 'integration_14d', label: '14 天内可完成首次数据/系统对接' },
        { key: 'poc_90d', label: '90 天内可生产上线并使用' },
        { key: 'usage_measurable', label: '使用行为可测量' },
        { key: 'scenario_locked', label: '场景与范围已书面确认' },
      ],
    },
    solution: {
      key: 'solution', label: '进入「方案」的条件', stage: 'solution',
      auto: [{ key: 'proposal', label: '方案 md' }, { key: 'cost', label: '成本测算 md' }, { key: 'quote', label: '报价单/SOW md' }],
      manual: [{ key: 'solution_final', label: '方案已定稿可对外' }, { key: 'pricing_confirmed', label: '成本与报价已复核' }],
    },
    pilot: { key: 'pilot', label: '进入「试点」的条件', stage: 'pilot', auto: [{ key: 'pilot_doc', label: '试点方案' }], manual: [{ key: 'pilot_scope', label: '范围与指标客户确认' }] },
    delivery: { key: 'delivery', label: '进入「交付」的条件', stage: 'delivery', auto: [{ key: 'delivery_doc', label: '交付文档' }], manual: [{ key: 'acceptance', label: '验收清单' }] },
    adoption: { key: 'adoption', label: '进入「采用」的条件', stage: 'adoption', auto: [{ key: 'adoption_doc', label: '使用证据' }], manual: [{ key: 'training', label: '培训完成' }] },
  },
  attentionKinds: [
    { key: 'blocked', label: '卡住了' }, { key: 'decision', label: '等你决定' }, { key: 'review', label: '待验收' },
    { key: 'answer', label: '等你回复' }, { key: 'overdue', label: '已逾期' }, { key: 'gate', label: '等你确认' },
    { key: 'stall', label: '没有进展' }, { key: 'proposal', label: '提醒' },
  ],
  rules: [
    { ruleId: 'stall', label: '没有进展', detail: '', derived: true }, { ruleId: 'overdue', label: '已逾期', detail: '', derived: true },
    { ruleId: 'due_soon', label: '快到期', detail: '' }, { ruleId: 'bid_signal', label: '新招采公告', detail: '' },
  ],
  defaults: {
    settings: { autonomy: 'observe', stallDays: 14, wipLimits: { doing: 5 }, sources: { folderWatch: true, briefOnOpen: true, bidWatch: false } },
    gateWaitDays: 7, reviewLagDays: 3, dueSoonDays: 2,
  },
  skills: [
    { name: 'fde-engagement', description: '进入 FDE 工作、问「今天该做什么」时使用' },
    { name: 'fde-discovery', description: '调研某客户、锁主体、KPI 假设时使用' },
  ],
};

const META_NO_PLAYBOOK = Object.assign({}, META, {
  stages: META.stages.map((x) => Object.assign({}, x, { playbook: null })),
});
let META_CURRENT = META;

function makeBoard() {
  return {
    version: 1,
    updatedAt: '2026-11-03T06:00:00.000Z',
    settings: {
      autonomy: 'observe', stallDays: 14, wipLimits: { doing: 5 },
      sources: { folderWatch: true, briefOnOpen: true, bidWatch: true },
    },
    engagements: [
      {
        id: 'eng_aaaaaa', name: '某环境集团', company: '某环境集团有限公司', shortName: '某环境',
        dir: '某环境-20261013', path: ABS, stage: 'discovery', stageSince: '2026-10-20T02:00:00.000Z',
        paused: false, priority: 'high', owner: 'Neo', tags: ['水务', '国企'],
        nextAction: { text: '补 KPI 假设第三段', due: TODAY, owner: 'Neo' },
        stakeholders: [{ name: '张三', role: '董事长', level: 'top', verified: false }],
        gateState: { discovery: { status: 'pending', checks: { subject_locked: { status: 'pass', evidence: '地址锚定 + 三链验证' } } } },
        attention: null, sessionId: '', createdAt: '2026-10-20T02:00:00.000Z', adopted: true,
        artifacts: { md: 6, pdf: 2, total: 8, exists: true },
        bids: { available: true, total: 3, approxTotal: 53, tender: 2, award: 1, candidate: 1, latest: '2026-04-28', matches: BIDS_ITEMS, queries: ['某环境集团', '某环境'] },
        timeline: [{ at: '2026-10-20T02:00:00.000Z', kind: 'created', text: '创建客户', by: 'human' }],
      },
      {
        id: 'eng_bbbbbb', name: '某电子研究所', company: '某电子研究所', shortName: '某所',
        dir: '某电子所-20261029', path: '/tmp/ws/research/某电子所-20261029', stage: 'lead',
        stageSince: '2026-10-29T02:00:00.000Z', paused: false, priority: 'normal', owner: 'Neo', tags: ['涉密'],
        nextAction: { text: '补主体锁定', due: '', owner: 'Neo' }, stakeholders: [],
        gateState: {}, attention: null, sessionId: '', createdAt: '2026-10-29T02:00:00.000Z', adopted: true, timeline: [],
        /* available:false 时即使 total>0 也不显示卡片徽章（§17.7 降级） */
        bids: { available: false, total: 5, tender: 5, award: 0, candidate: 0, latest: '2026-01-01', matches: [], queries: [] },
      },
    ],
    items: [
      {
        id: 'itm_aaaaaa', engagementId: 'eng_aaaaaa', title: '补齐 KPI 假设', type: 'research',
        stage: 'doing', priority: 'normal', due: TODAY, owner: 'agent', reports: [{ at: '2026-11-02T08:00:00.000Z', kind: 'progress', text: '已完成两段' }],
        sessionId: 'sess_1', createdAt: '2026-10-25T02:00:00.000Z', attention: null, history: [],
      },
      {
        id: 'itm_bbbbbb', engagementId: '', title: '整理会后跟进', type: 'followup',
        stage: 'todo', priority: 'high', due: '', owner: 'human', reports: [], sessionId: '',
        createdAt: '2026-11-01T02:00:00.000Z', attention: null, history: [],
      },
      {
        id: 'itm_cccccc', engagementId: 'eng_bbbbbb', title: '写会面 Brief', type: 'meeting',
        stage: 'review', priority: 'normal', due: '', owner: 'agent',
        reports: [{ at: '2026-11-02T09:00:00.000Z', kind: 'ready', text: 'Brief 已出' }],
        sessionId: '', createdAt: '2026-11-01T02:00:00.000Z', attention: null, history: [],
      },
      {
        id: 'itm_dddddd', engagementId: 'eng_aaaaaa', title: '补公司年报摘要', type: 'research',
        stage: 'doing', priority: 'low', due: '', owner: 'agent', reports: [], sessionId: '',
        createdAt: '2026-11-01T02:00:00.000Z', attention: null, history: [],
      },
    ],
    proposals: [
      {
        id: 'prp_aaaaaa', ruleId: 'due_soon', engagementId: 'eng_aaaaaa', itemId: '', kind: 'nudge',
        title: '某环境集团的下一步今天到期：补 KPI 假设第三段', detail: '', payload: {},
        status: 'pending', createdAt: '2026-11-03T05:00:00.000Z',
      },
      /* v1 留下的、与「待我处理」重复的提醒：新版宿主会让它失效，面板在那之前也不显示 */
      {
        id: 'prp_bbbbbb', ruleId: 'stall', engagementId: 'eng_aaaaaa', itemId: '', kind: 'nudge',
        title: '某环境已停滞 16 天', detail: '建议：安排一次跟进，或标记暂停', payload: {},
        status: 'pending', createdAt: '2026-11-03T05:00:00.000Z',
      },
      {
        id: 'prp_cccccc', ruleId: 'bid_signal', engagementId: 'eng_aaaaaa', itemId: '', kind: 'create_item',
        title: '某环境集团发布了新公告：《某水厂自控系统招标公告》（2026-11-01）',
        detail: '可以建一个跟进任务，确认是否和这家客户有关。候选人不等于中标人。', payload: { bidId: 'aecc-ebidding:x9' },
        status: 'pending', createdAt: '2026-11-03T05:00:00.000Z',
      },
    ],
    activity: [
      { at: '2026-11-03T05:00:00.000Z', kind: 'created', text: '导入 2 个客户', engagementId: '', itemId: '' },
      /* 用户自己写的标题 / 客户名里恰好有内部用语或英文字段名：显示时一个字都不能换 */
      { at: '2026-11-03T04:50:00.000Z', kind: 'updated', text: '更新任务：门禁评审方案与泳道设计', engagementId: '', itemId: '' },
      { at: '2026-11-03T04:40:00.000Z', kind: 'updated', text: '更新客户：Stage Value 科技', engagementId: '', itemId: '' },
      /* 旧版本留下的系统句式：显示时换成平实说法 */
      { at: '2026-11-03T04:30:00.000Z', kind: 'report', text: '回报（ready）：补公司年报摘要', engagementId: '', itemId: '' },
      { at: '2026-11-03T04:20:00.000Z', kind: 'gate', text: '某环境集团 门禁 discovery 强制放行', engagementId: '', itemId: '' },
    ],
  };
}

function makeBrief(board) {
  return {
    generatedAt: '2026-11-03T06:00:00.000Z',
    headline: '今天先补 KPI 假设',
    attention: [
      { kind: 'blocked', rank: 1, title: '任务「补齐 KPI 假设」卡住了：KPI 数据拿不到', question: 'KPI 数据拿不到', detail: 'KPI 数据拿不到', itemTitle: '补齐 KPI 假设', engagementId: 'eng_aaaaaa', engagementName: '某环境集团', itemId: 'itm_aaaaaa', days: 3, target: 'item', actions: ['open', 'resolve'] },
      { kind: 'review', rank: 3, title: '任务「写会面 Brief」做完了，等你验收', itemTitle: '写会面 Brief', detail: '某电子研究所', engagementId: 'eng_bbbbbb', engagementName: '某电子研究所', itemId: 'itm_cccccc', days: 1, target: 'item', actions: ['pass', 'return'] },
      { kind: 'overdue', rank: 5, text: '某环境集团的下一步已逾期 2 天：补 KPI 假设第三段', detail: '补 KPI 假设第三段', engagementId: 'eng_aaaaaa', engagementName: '某环境集团', due: '2026-11-01', days: 2, target: 'engagement', actions: ['reschedule', 'done'] },
      /* 宿主的 attention 仍带提醒（kind=proposal，兼容工具）；面板的「待我处理」不计它们 */
      { kind: 'proposal', rank: 8, title: '某环境集团的下一步今天到期：补 KPI 假设第三段', engagementName: '某环境集团', id: 'prp_aaaaaa', proposalId: 'prp_aaaaaa', ruleId: 'due_soon', target: 'proposal', actions: ['accept', 'dismiss'] },
      { kind: 'proposal', rank: 8, title: '某环境已停滞 16 天', engagementName: '某环境集团', id: 'prp_bbbbbb', proposalId: 'prp_bbbbbb', ruleId: 'stall', target: 'proposal', actions: ['accept', 'dismiss'] },
      { kind: 'proposal', rank: 8, title: '某环境集团发布了新公告：《某水厂自控系统招标公告》（2026-11-01）', engagementName: '某环境集团', id: 'prp_cccccc', proposalId: 'prp_cccccc', ruleId: 'bid_signal', target: 'proposal', actions: ['accept', 'dismiss'] },
    ],
    proposals: board.proposals,
    focus: [{ engagementId: 'eng_aaaaaa', name: '某环境集团', stage: 'discovery', nextAction: board.engagements[0].nextAction }],
    activity: board.activity,
    stats: { active: 2, attention: 6, todo: 3, dueToday: 1, overdue: 1 },
    autonomy: 'observe',
  };
}

const BIDS_ITEMS = [
  {
    id: 'aecc-ebidding:x1', source: 'aecc-ebidding', kind: '中标结果公告', url: 'https://example.com/bid/1',
    date: '2026-04-28', title: '某水厂自控系统中标公告', project_no: 'EXAMPLE-2026-001',
    buyer: '某环境集团', winner: '某科技公司',
    candidates: [{ name: '某科技公司', rank: 1 }, { name: '某工程公司', rank: 2 }],
    amounts: ['100万元'], excerpt: '某水厂自控系统中标公告 发布时间：2026-04-28', relation: 'buyer',
  },
  {
    id: 'aecc-ebidding:x2', source: 'aecc-ebidding', kind: '招标公告', url: 'https://example.com/bid/2',
    date: '2026-03-01', title: '某环境集团污水处理项目招标公告', project_no: 'EXAMPLE-2026-002',
    buyer: '某环境集团', winner: '', candidates: [], amounts: ['—'],
    excerpt: '招标公告正文', relation: 'buyer',
  },
  {
    id: 'aecc-ebidding:x3', source: 'aecc-ebidding', kind: '中标候选人公示', url: 'https://example.com/bid/3',
    date: '2026-02-10', title: '某环境集团智慧水务中标候选人公示', buyer: '某环境集团',
    winner: '', candidates: [{ name: '某科技公司', rank: 1 }], amounts: [],
    excerpt: '候选人公示正文', relation: 'candidate',
  },
];
const BIDS_LINKED = [{
  bidId: 'aecc-ebidding:x2', title: '某环境集团污水处理项目招标公告', date: '2026-03-01',
  url: 'https://example.com/bid/2', relation: 'buyer', note: '跟进中',
  linkedAt: '2026-11-01T02:00:00.000Z', by: 'human',
}];
let bidsAvailableFlag = true;
function bidsStatsResponse() {
  return {
    ok: true, available: bidsAvailableFlag,
    reason: bidsAvailableFlag ? '' : 'bidIntel 服务不可用',
    stats: bidsAvailableFlag ? {
      records: 24156, sources: [{ name: 'aecc-ebidding', count: 24156 }],
      dateRange: ['2018-05-03', '2026-04-28'], years: { 2026: 52 }, withWinner: 100, withBuyer: 200, withAmount: 150,
      generatedAt: '2026-11-03T06:00:00.000Z',
    } : { records: 0, sources: [], dateRange: ['', ''] },
    dataMeta: { file: '/tmp/bid/notices.jsonl', mtime: Date.now(), bytes: 42000000, records: 24156, missing: false },
  };
}
function bidsMatchResponse() {
  return {
    ok: true, available: bidsAvailableFlag,
    reason: bidsAvailableFlag ? '' : 'bidIntel 服务不可用',
    stats: { total: 3, approxTotal: 1603, tender: 2, award: 1, candidate: 1, latest: '2026-04-28' },
    queries: ['某环境集团', '某环境'],
    items: BIDS_ITEMS,
    linked: BIDS_LINKED,
  };
}

/* ---- FDE 资料库夹具（v1.3，spec §19.3/§19.4）；libMode 控制降级分支 ---- */
let libMode = 'ok';
const LIB_ITEMS = [
  {
    id: 'openai-agents-guide', group: 'intl-official', kind: 'guide', lang: 'en',
    title: 'A practical guide to building agents', publisher: 'OpenAI',
    url: 'https://openai.com/business/guides-and-resources/a-practical-guide-to-building-agents/',
    authority: 'A', stages: ['scoping', 'solution'], topics: ['agent', '生命周期'],
    summary: 'OpenAI 官方 agent 构建指南：何时用 agent、如何拆工具与评测，方案阶段可直接引用。',
    why: '避免把 RAG 当 agent，官方口径可直接进方案。',
    featured: true, recommend: 'star', addedAt: '2026-11-04', verifiedAt: '2026-11-04', httpStatus: 200,
  },
  {
    id: 'aliyun-fde', group: 'cn-official', kind: 'doc', title: '企业级 AI 落地方法论',
    publisher: '阿里云', url: 'https://www.aliyun.com/product/ai/method',
    authority: 'A', stages: ['all'], topics: ['落地'],
    summary: '国内大厂官方 AI 落地方法论，对齐国内采购与交付语境。',
    why: '给国内客户讲方案时对齐语言体系。',
    featured: true, recommend: 'recommend', addedAt: '2026-11-03', verifiedAt: '2026-11-03',
  },
  {
    id: 'repo-openai-agents-python', group: 'opensource', kind: 'repo',
    title: 'openai/openai-agents-python', publisher: 'openai/openai-agents-python',
    url: 'https://github.com/openai/openai-agents-python',
    authority: 'A', stages: ['pilot', 'delivery'], topics: ['sdk'],
    summary: 'OpenAI 官方 Agents SDK，试点阶段可作为参考实现。',
    why: '省掉一层自研框架的工期。',
    recommend: 'star', addedAt: '2026-11-02', repo: 'openai/openai-agents-python',
    staticMeta: { stars: 1000, forks: 100, license: 'MIT', language: 'Python', pushedAt: '2026-11-01' },
    liveMeta: { stars: 12345, forks: 1200, license: 'MIT', language: 'Python', pushedAt: '2026-11-03' },
    isNew: true, updated: true,
  },
  {
    id: 'method-scenario', group: 'method', kind: 'template', title: '场景评估表', publisher: '内部方法库',
    url: 'https://internal.example.com/methods/scenario', authority: 'B', stages: ['scoping'],
    topics: ['场景'], summary: '四条硬门槛 + 加权评分的场景评估模板。',
    why: 'scoping 阶段直接套用，省一张表。',
    featured: true, recommend: 'recommend', addedAt: '2026-11-01',
  },
  {
    id: 'community:1', group: 'community', kind: 'post', title: '从 0 起步做 FDE：两个月复盘',
    url: 'https://scys.com/articleDetail/xq_topic/1', authority: 'C', stages: ['all'], topics: ['复盘'],
    summary: '社区复盘：入局路径、交付方法与踩过的坑。',
    why: '看同行怎么获客与定价。',
    addedAt: '2026-11-03', isNew: true,
    community: { author: '苍述', publishedAt: '2026-11-03T02:00:00.000Z', stats: { like: 395, comment: 28, read: 11035 }, tags: ['精华'] },
  },
  {
    id: 'unsafe-link', group: 'method', kind: 'doc', title: '未核实链接示例', publisher: '某媒体',
    url: 'ftp://example.com/x', authority: 'C', stages: ['meeting'],
    summary: '用于验证非 http(s) 链接不渲染为可点标题。', addedAt: '2026-10-30',
  },
  {
    id: 'anthropic-context', group: 'intl-official', kind: 'blog', title: 'Anthropic 的上下文工程笔记',
    publisher: 'Anthropic', url: 'https://www.anthropic.com/engineering/context-engineering',
    authority: 'B', stages: ['solution'], topics: ['context'],
    summary: '上下文工程实践：长任务怎么组织上下文。',
    recommend: 'backup', addedAt: '2026-10-20',
  },
];
const LIB_FEATURED = ['openai-agents-guide', 'aliyun-fde', 'repo-openai-agents-python', 'method-scenario', 'community:1', 'anthropic-context'];

function libraryFeedResponse() {
  const today = TODAY;
  if (libMode === 'empty') return { ok: true, feed: null, today, stale: true, refreshing: false };
  const feed = {
    version: 1, date: TODAY, fetchedAt: new Date().toISOString(), ok: true, lastError: null,
    catalogVersion: 1, catalogUpdatedAt: '2026-11-04',
    stats: {
      total: LIB_ITEMS.length, intlOfficial: 2, cnOfficial: 1, opensource: 1,
      method: 2, community: 1, featured: LIB_FEATURED.length, new: 2, updated: 1,
    },
    sources: [{ key: 'catalog', ok: true, items: 6, error: null }],
    warnings: [], items: LIB_ITEMS, featured: LIB_FEATURED,
  };
  if (libMode === 'stale') {
    return { ok: false, reason: 'GitHub 指标未更新', feed: Object.assign({}, feed, { ok: false, lastError: 'GitHub 指标未更新（403）' }), today, stale: true, refreshing: false };
  }
  if (libMode === 'unavailable') {
    return { ok: false, code: 'UNAVAILABLE', reason: '资料目录缺失', feed, today, stale: true, refreshing: false };
  }
  return { ok: true, feed, today, stale: false, refreshing: false };
}

const BOARD = makeBoard();
const BRIEF = makeBrief(BOARD);
const STATUS = { ok: true, root: '/tmp/ws', projects: 1, materials: 1, loose: 1, methods: 2, reference: 1, hasSession: true };
const PROJECTS = {
  ok: true, root: '/tmp/ws',
  projects: [{
    dir: '某环境-20261013', path: ABS, title: '某环境', kind: 'project', adopted: true, fileCount: 3,
    mtime: Date.now(), stages: { archive: true, research: 1, meeting: 0, proposal: 0, exports: 0 },
  }],
};
const FILES = {
  ok: true, dir: '某环境-20261013', path: ABS,
  files: [
    { rel: '00-项目档案.md', name: '00-项目档案.md', kind: 'md', size: 2048, mtime: Date.now(), exported: false },
    { rel: 'research/事实核查清单.md', name: '事实核查清单.md', kind: 'md', size: 1024, mtime: Date.now(), exported: false },
  ],
};
const MATERIALS = {
  ok: true, root: '/tmp/ws/research',
  materials: [{ dir: '素材A', path: '/tmp/ws/research/素材A', fileCount: 1, mtime: Date.now(), kind: 'material' }],
  loose: [{ name: 'loose.html', size: 1024, mtime: Date.now() }],
};
const GATE_OK = {
  ok: true,
  gate: {
    key: 'discovery', label: '研判门禁', status: 'pending',
    auto: [{ key: 'archive', label: '项目档案', ok: true }, { key: 'factcheck', label: '事实核查清单', ok: true }],
    manual: [{ key: 'subject_locked', label: '主体已锁定', status: 'pass', evidence: '地址锚定' }, { key: 'evidence_graded', label: '事实已分级', status: 'pending', evidence: '' }],
    missing: [{ type: 'manual', key: 'evidence_graded', label: '事实已分级' }],
  },
  missing: [{ type: 'manual', key: 'evidence_graded', label: '事实已分级' }],
};

let currentBoard = makeBoard();
let CURRENT_BRIEF = makeBrief(currentBoard);

function boardResponse() {
  const active = currentBoard.engagements.filter((e) => !e.paused && META.terminalStages.indexOf(e.stage) === -1).length;
  return {
    ok: true, board: currentBoard, meta: META_CURRENT,
    root: '/tmp/ws',
    bidStats: { available: true, records: 24156, dateRange: ['2018-05-03', '2026-04-28'], engagedCount: 1 },
    stats: { active, dueToday: 1, overdue: 1, items: currentBoard.items.length, engagements: currentBoard.engagements.length, attention: CURRENT_BRIEF.attention.length },
  };
}

function gateResponse(stageKey, checks) {
  const stageDef = META.stages.find((x) => x.key === stageKey) || META.stages[1];
  const def = META.gates[stageKey] || META.gates.discovery;
  const manual = def.manual.map((m) => ({ key: m.key, label: m.label, status: 'pending', evidence: '' }));
  Object.keys(checks || {}).forEach((k) => {
    const m = manual.find((x) => x.key === k);
    if (m) { m.status = checks[k].status; m.evidence = checks[k].evidence; }
  });
  const missing = manual.filter((m) => m.status !== 'pass').map((m) => ({ type: 'manual', key: m.key, label: m.label }));
  return {
    ok: true,
    gate: {
      key: def.key, label: def.label, status: missing.length ? 'pending' : 'pass',
      auto: def.auto.map((a) => ({ key: a.key, label: a.label, ok: true })),
      manual, missing,
    },
    missing,
  };
}

function applyEngagement(call) {
  const body = call.body || {};
  const eng = currentBoard.engagements.find((e) => e.id === body.id);
  if (!eng) return { ok: false, reason: 'engagement not found' };
  if (body.action === 'move' && body.patch && body.patch.stage) {
    eng.stage = body.patch.stage;
    eng.stageSince = new Date().toISOString();
    currentBoard.updatedAt = new Date().toISOString();
  } else if (body.action === 'update' && body.patch) {
    Object.assign(eng, body.patch);
    currentBoard.updatedAt = new Date().toISOString();
  } else if (body.action === 'archive') {
    eng.stage = 'archived';
    currentBoard.updatedAt = new Date().toISOString();
  }
  return { ok: true, engagement: eng };
}

function applyItem(call) {
  const body = call.body || {};
  const item = currentBoard.items.find((x) => x.id === body.id);
  if (!item) return { ok: false, reason: 'item not found' };
  if (body.action === 'move' && body.patch && body.patch.stage) {
    item.stage = body.patch.stage;
    currentBoard.updatedAt = new Date().toISOString();
  } else if (body.action === 'update' && body.patch) {
    Object.assign(item, body.patch);
    currentBoard.updatedAt = new Date().toISOString();
  } else if (body.action === 'report' && body.kind) {
    item.reports = (item.reports || []).concat([{ at: new Date().toISOString(), kind: body.kind, text: body.text }]);
    if (body.kind === 'ready') item.stage = 'review';
    currentBoard.updatedAt = new Date().toISOString();
  } else if (body.action === 'delete') {
    currentBoard.items = currentBoard.items.filter((x) => x.id !== body.id);
    currentBoard.updatedAt = new Date().toISOString();
    return { ok: true, deleted: true };
  }
  return { ok: true, item };
}

function installFdeStubs() {
  routeTable = {}; routeSeq = {};
  META_CURRENT = META;
  currentBoard = makeBoard();
  CURRENT_BRIEF = makeBrief(currentBoard);
  stub('GET', '/research-workbench/api/fde/meta', { ok: true, meta: META });
  stub('GET', '/research-workbench/api/fde/board?view=board', () => boardResponse());
  stub('GET', '/research-workbench/api/fde/brief', () => ({ ok: true, brief: CURRENT_BRIEF }));
  stub('POST', '/research-workbench/api/fde/engagement', (call) => {
    const body = call.body || {};
    if (body.action === 'move' && body.patch && body.patch.stage === 'pilot' && !body.patch.force) {
      return { ok: false, blocked: true, code: 'BLOCKED', reason: '门禁未通过', missing: [{ type: 'manual', key: 'pilot_scope', label: '范围与指标客户确认' }] };
    }
    return applyEngagement(call);
  });
  stub('POST', '/research-workbench/api/fde/item', (call) => {
    const body = call.body || {};
    const target = (currentBoard.items || []).find((x) => x.id === body.id);
    const needEvidence = body.action === 'move' && body.patch && body.patch.stage === 'done'
      && !(target && (target.reports || []).length) && !body.patch.evidence && !body.patch.force;
    if (needEvidence) {
      return { ok: false, blocked: true, reason: '进入 done 需要证据', missing: [{ type: 'manual', key: 'evidence', label: '回报或人工证据' }] };
    }
    return applyItem(call);
  });
  stub('POST', '/research-workbench/api/fde/gate', (call) => gateResponse((call.body || {}).stage, (call.body || {}).checks));
  stub('POST', '/research-workbench/api/fde/attention', () => ({ ok: true, attention: null }));
  stub('POST', '/research-workbench/api/fde/proposal', () => ({ ok: true }));
  stub('POST', '/research-workbench/api/fde/settings', () => ({ ok: true, settings: currentBoard.settings }));
  stub('GET', '/research-workbench/api/fde/health', { ok: true, checks: [{ name: '看板数据可读', status: 'ok', detail: '2 家客户、4 个任务' }, { name: '自动备份', status: 'warn', detail: '还没有备份' }] });
  stub('GET', '/research-workbench/api/fde/bids/stats', () => bidsStatsResponse());
  stub('GET', '/research-workbench/api/fde/bids/search', () => ({
    ok: true, available: bidsAvailableFlag, reason: bidsAvailableFlag ? '' : 'bidIntel 服务不可用',
    total: 3, direct: 3, mentioned: 0, items: BIDS_ITEMS, facets: { byYear: { 2026: 3 } },
  }));
  stub('GET', '/research-workbench/api/fde/bids/match', () => bidsMatchResponse());
  stub('POST', '/research-workbench/api/fde/bids/link', () => ({ ok: true, link: BIDS_LINKED[0] }));
  stub('POST', '/research-workbench/api/fde/bids/unlink', () => ({ ok: true }));
  stub('POST', '/research-workbench/api/fde/bids/promote', () => ({
    ok: true, item: { id: 'itm_bid_new', title: '跟进招标：某水厂自控系统中标公告' }, link: { bidId: 'aecc-ebidding:x1' },
  }));
  stub('POST', '/research-workbench/api/fde/bids/refresh', () => bidsMatchResponse());
  stub('GET', '/research-workbench/api/fde/library/feed', () => libraryFeedResponse());
  stub('POST', '/research-workbench/api/fde/library/refresh', () => libraryFeedResponse());
  stub('GET', '/bidintel/api/status', { ok: true, stats: { records: 24156 }, indexExists: true });
  stub('POST', '/bidintel/api/import-url', { ok: true, source: 'web-import', item: { title: '新导入公告' } });
  stub('POST', '/research-workbench/api/fde/adopt', (call) => {
    if ((call.body || {}).action === 'scan') {
      return {
        ok: true,
        candidates: [
          { dir: '某环境-20261013', title: '某环境集团', kind: 'project', suggestedStage: 'discovery', suggestedStageLabel: '研判', confidence: 'high', adopted: true, importable: true, alreadyImported: true, engagementId: 'eng_aaaaaa', mdCount: 42, evidence: ['有 00-项目档案.md'] },
          { dir: 'legacy-project', title: 'legacy-project', kind: 'legacy', suggestedStage: 'discovery', suggestedStageLabel: '研判', confidence: 'medium', adopted: false, importable: true, alreadyImported: false, mdCount: 27, evidence: ['无项目档案', 'md 27 篇'] },
        ],
      };
    }
    return { ok: true, board: currentBoard };
  });
  stub('POST', '/research-workbench/api/fde/handoff', (call) => {
    const body = call.body || {};
    const eng = currentBoard.engagements.find((e) => e.id === body.id);
    if (eng) eng.sessionId = 'sess_new_1';
    return { ok: true, sessionId: 'sess_new_1', prompt: '去补 KPI 假设' };
  });
  stub('GET', '/research-workbench/api/status', STATUS);
  stub('GET', '/research-workbench/api/projects', PROJECTS);
  stub('GET', '/research-workbench/api/methods', { ok: true, items: [
    { kind: 'method', name: '00-调研执行流程.md' },
    { kind: 'method', name: '06-场景选择与数据体检.md' },
    { kind: 'template', name: '场景评估表.md' },
  ] });
  stub('GET', '/research-workbench/api/methods?name=00-%E8%B0%83%E7%A0%94%E6%89%A7%E8%A1%8C%E6%B5%81%E7%A8%8B', { ok: true, file: '00-调研执行流程.md', body: '# 调研执行流程\n七步' });
  stub('GET', '/research-workbench/api/methods?name=06-%E5%9C%BA%E6%99%AF%E9%80%89%E6%8B%A9%E4%B8%8E%E6%95%B0%E6%8D%AE%E4%BD%93%E6%A3%80', { ok: true, file: '06-场景选择与数据体检.md', body: '# 场景选择与数据体检\n四条硬门槛：发起人 / 14 天 / 90 天 / 可测' });
  stub('GET', '/research-workbench/api/methods?name=%E5%9C%BA%E6%99%AF%E8%AF%84%E4%BC%B0%E8%A1%A8', { ok: true, file: '场景评估表.md', body: '# 场景评估表\n模板：场景 / 发起人 / 数据 / 评分' });
  stub('GET', '/research-workbench/api/materials', MATERIALS);
  stub('GET', '/research-workbench/api/files?dir=' + encodeURIComponent('某环境-20261013'), FILES);
  stub('GET', '/api/file', '# 00-项目档案\n\n预览正文\n\n- 事实核查通过');
  stub('POST', '/research-workbench/api/handoff', { ok: true, sessionId: 'sess_export_1', promptText: '导出 md' });
}
installFdeStubs();

/* 渲染用 props：真实 actions 由 apply 注册时传入，这里复用面板注册的 actions 便于断言 */
const openPathCalls = [];
const openSessionCalls = [];
function makeProps(over) {
  return Object.assign({
    actions: {
      openSession: (id) => { openSessionCalls.push(id); return true; },
      openPath: async (path, mode, kind) => { openPathCalls.push({ path, mode, kind }); return { ok: true, how: 'stub' }; },
    },
  }, over || {});
}
const PanelApp = applied.captured.main;

/* Phase 2 IA 导航助手：页内子页签在 .fde-pagebar；设置入口是页头齿轮 */
const pageTab = (tree, label) => {
  const bar = byClass(tree, 'fde-pagebar')[0];
  if (!bar) return null;
  return buttons({ children: [bar] }).filter((b) => textOf(b).trim().indexOf(label) === 0)[0] || null;
};
const gearBtn = (tree) => collect(tree, (n) => n.props && String(n.props['aria-label'] || '') === '设置')[0] || null;
/* 抽屉头部的关闭按钮（抽屉里别处也复用了这个样式类，取第一个） */
const drawerCloseBtn = (tree) => {
  const d = byClass(tree, 'fde-drawer')[0];
  return d ? byClass(d, 'fde-drawer-close')[0] || null : null;
};
const todayPanel = (tree, i) => byClass(tree, 'fde-today-panel')[i] || { children: [] };
const clickNode = (tree, node) => (node ? act(PanelApp, makeProps(), () => node.props.onClick()) : Promise.resolve(tree));
const goNav = (tree, label) => clickNode(tree, navBtn(tree, label));
const goPage = (tree, label) => clickNode(tree, pageTab(tree, label));
const goFlow = async (tree) => {
  tree = await goNav(tree, '流程');
  tree = await goPage(tree, '阶段指南');
  return tree;
};

/* ================= 场景一：FDE 今日 ================= */
let tree = await renderStable(PanelApp, makeProps());
if (process.env.DBG) {
  console.log('DBG buttons:', buttons(tree).map((b) => textOf(b).trim()).slice(0, 40));
  console.log('DBG text:', textOf(tree).slice(0, 1200));
}
check('面板标题为 FDE 工作站', textOf(tree).includes('FDE 工作站'));
check('今日页渲染问候与日期行（不再有解释性的一句话）',
  textOf(tree).includes('在跟客户') && /\d+月\d+日 周[日一二三四五六]/.test(textOf(tree)) && !textOf(tree).includes('先处理要你拍板的事'));
check('页头只有刷新与设置两个图标按钮（各带文字提示），没有标语与 AI 权限徽章',
  byClass(tree, 'fde-iconbtn').length === 2
  && byClass(tree, 'fde-iconbtn').every((b) => !!b.props['aria-label'] && !!b.props.title)
  && !textOf(tree).includes('客户经营 · ') && byClass(tree, 'fde-autonomy').length === 0);
check('5 页签齐全（今日/客户/资料/流程/情报，无生财）',
  ['今日', '客户', '资料', '流程', '情报'].every((x) => textOf(tree).includes(x))
  && !textOf(tree).includes('生财'));
check('导航顺序：今日 → 客户 → 资料 → 流程 → 情报', (() => {
  const nav = byClass(tree, 'fde-nav')[0];
  if (!nav) return false;
  const labels = buttons({ children: [nav] }).map((b) => textOf(b).trim().replace(/\d+/g, ''));
  return labels.join('|') === '今日|客户|资料|流程|情报';
})());
check('设置走页头齿轮入口（不占页签）', !!gearBtn(tree) && !textOf(byClass(tree, 'fde-nav')[0] || {}).includes('设置'));
check('今日四块：4 块 panel + 固定标题条（待我处理→提醒→今天跟进→最近动态）',
  byClass(tree, 'fde-today-panel').length === 4
  && collect(tree, (n) => n.props && String(n.props.className || '') === 'fde-today-panel-title')
    .map((n) => textOf(n).trim()).join('|') === '待我处理|提醒|今天跟进|最近动态');
check('今日四块：头部一行 4 个数字（在跟客户/待我处理/今天到期/已逾期）',
  byClass(tree, 'fde-kpi').length === 4
  && collect(tree, (n) => n.props && String(n.props.className || '') === 'fde-kpi-label')
    .map((n) => textOf(n).trim()).join('|') === '在跟客户|待我处理|今天到期|已逾期');
check('今日四块：旧两栏结构不再出现（fde-grid-two）',
  byClass(tree, 'fde-grid-two').length === 0);

const todoPanelText = textOf(todayPanel(tree, 0));
const remindPanelText = textOf(todayPanel(tree, 1));
check('待我处理渲染三类（卡住了 / 待验收 / 已逾期），行标题说的是事',
  todoPanelText.includes('卡住了') && todoPanelText.includes('KPI 数据拿不到')
  && todoPanelText.includes('待验收') && todoPanelText.includes('写会面 Brief')
  && todoPanelText.includes('已逾期') && todoPanelText.includes('补 KPI 假设第三段') && todoPanelText.includes('逾期'),
  todoPanelText.slice(0, 300));
check('待我处理不含提醒；页签角标与顶部数字都是 3（宿主 attention 共 6 条，其中 3 条是提醒）',
  !todoPanelText.includes('发布了新公告') && !todoPanelText.includes('今天到期：补 KPI')
  && /今日\s*3/.test(textOf(navBtn(tree, '今日')))
  && collect(tree, (n) => n.props && String(n.props.className || '').indexOf('fde-kpi-num') === 0).map((n) => textOf(n).trim()).join('|') === '2|3|1|1',
  textOf(navBtn(tree, '今日')));
check('行标题不带「种类：」前缀，也不重复客户名',
  !todoPanelText.includes('受阻：') && !todoPanelText.includes('待审阅：') && !todoPanelText.includes('任务「补齐 KPI 假设」卡住了：')
  && (todoPanelText.match(/某电子研究所/g) || []).length === 1);
check('待我处理的动作翻成按钮文字（查看 / 已解决 / 通过 / 退回 / 改期 / 完成）',
  btnExact(tree, '已解决').length >= 1 && btnExact(tree, '查看').length >= 1
  && btnExact(tree, '通过').length >= 1 && btnExact(tree, '退回').length >= 1
  && btnExact(tree, '改期').length >= 1 && btnExact(tree, '完成').length >= 1,
  buttons(tree).map((b) => textOf(b).trim()).filter(Boolean).slice(0, 24).join('|'));
check('提醒渲染：快到期 + 新招采公告；与待我处理重复的旧提醒（没有进展）不显示',
  remindPanelText.includes('某环境集团的下一步今天到期') && remindPanelText.includes('发布了新公告')
  && !remindPanelText.includes('已停滞 16 天') && !remindPanelText.includes('16 天') && !textOf(tree).includes('stall') && !textOf(tree).includes('due_soon'),
  remindPanelText.slice(0, 300));
check('提醒的按钮说结果：去处理 / 建跟进任务 / 知道了（没有「采纳」「忽略」）',
  btnExact(tree, '去处理').length === 1 && btnExact(tree, '建跟进任务').length === 1 && btnExact(tree, '知道了').length === 2
  && btnExact(tree, '采纳').length === 0 && btnExact(tree, '忽略').length === 0);
check('今天跟进与最近动态渲染', textOf(tree).includes('今天跟进') && textOf(tree).includes('最近动态') && textOf(tree).includes('导入 2 个客户'));
check('最近动态：用户自己写的标题和客户名原样显示（不被旧用语替换误伤）',
  textOf(tree).includes('更新任务：门禁评审方案与泳道设计') && textOf(tree).includes('更新客户：Stage Value 科技'),
  textOf(byClass(tree, 'fde-today-panel').slice(-1)[0] || tree).slice(0, 300));
check('最近动态：旧版本的系统句式换成平实说法',
  textOf(tree).includes('做完了，等验收：补公司年报摘要') && textOf(tree).includes('某环境集团破例推进')
  && !textOf(tree).includes('回报（ready）') && !textOf(tree).includes('强制放行'));
check('轮询只注册一个定时器且间隔 12s',
  intervalRecords.length === 1 && intervalRecords[0].ms === 12000, JSON.stringify(intervalRecords.map((x) => x.ms)));
check('今日页只轮询 brief（首屏有 /fde/brief 请求）',
  callsOf('GET', '/fde/brief').length >= 1);

/* 待我处理的动作：已解决 */
const resolveBtn = btnExact(tree, '已解决')[0];
check('卡住了的那一行有「已解决」', !!resolveBtn);
const beforeResolve = callsOf('POST', '/fde/attention').length;
if (resolveBtn) {
  tree = await act(PanelApp, makeProps(), () => resolveBtn.props.onClick());
  check('已解决 → POST /fde/attention resolve',
    callsOf('POST', '/fde/attention').length > beforeResolve
    && lastCall('POST', '/fde/attention').body.action === 'resolve',
    JSON.stringify(lastCall('POST', '/fde/attention')));
}
/* 提醒：去处理只打开抽屉，不改提醒状态 */
const goBtn = btnExact(tree, '去处理')[0];
const beforeGo = callsOf('POST', '/fde/proposal').length;
if (goBtn) {
  tree = await act(PanelApp, makeProps(), () => goBtn.props.onClick());
  check('提醒「去处理」→ 打开客户抽屉，不发 POST /fde/proposal',
    byClass(tree, 'fde-drawer').length === 1 && callsOf('POST', '/fde/proposal').length === beforeGo);
  const closeGo = drawerCloseBtn(tree);
  if (closeGo) tree = await act(PanelApp, makeProps(), () => closeGo.props.onClick());
}
/* 提醒：建跟进任务 = accept */
const acceptBtn = btnExact(tree, '建跟进任务')[0];
const beforeAccept = callsOf('POST', '/fde/proposal').length;
if (acceptBtn) {
  tree = await act(PanelApp, makeProps(), () => acceptBtn.props.onClick());
  check('提醒「建跟进任务」→ POST /fde/proposal accept（新招采公告那一条）',
    callsOf('POST', '/fde/proposal').length > beforeAccept
    && lastCall('POST', '/fde/proposal').body.action === 'accept' && lastCall('POST', '/fde/proposal').body.id === 'prp_cccccc',
    JSON.stringify(lastCall('POST', '/fde/proposal')));
}
/* 提醒：知道了 = dismiss */
const dismissBtn = btnExact(tree, '知道了')[0];
if (dismissBtn) {
  tree = await act(PanelApp, makeProps(), () => dismissBtn.props.onClick());
  check('提醒「知道了」→ POST /fde/proposal dismiss',
    lastCall('POST', '/fde/proposal').body.action === 'dismiss', JSON.stringify(lastCall('POST', '/fde/proposal')));
}

/* ================= 场景二：看板（客户模式）+ 拖拽 + 键盘 ================= */
const customersNav = navBtn(tree, '客户');
check('可切换到「客户」页（看板视图）', !!customersNav);
tree = await act(PanelApp, makeProps(), () => customersNav.props.onClick());
const boardTab = pageTab(tree, '看板');
check('客户页三个子页签，顺序为 看板 / 列表 / 任务，默认在「看板」',
  !!boardTab && boardTab.props['aria-selected'] === 'true'
  && buttons({ children: [byClass(tree, 'fde-pagebar')[0]] }).map((b) => textOf(b).trim()).join('|') === '看板|列表|任务');
check('看板工具条有「新建客户」；没有操作说明文字', btnExact(tree, '新建客户').length >= 1
  && !textOf(tree).includes('拖拽卡片换列') && !textOf(tree).includes('横向滚动查看'));
const colNodes = byClass(tree, 'fde-col');
check('客户模式 8 列（含空列，来自 meta.stages）', colNodes.length === 8, '列数 ' + colNodes.length);
check('8 列阶段名含 v1.3 新增「场景」', textOf(tree).includes('场景'));
check('列头显示阶段名与数量', textOf(tree).includes('线索') && textOf(tree).includes('研判') && textOf(tree).includes('采用'));
check('客户卡片渲染名称/下一步', textOf(tree).includes('某环境集团') && textOf(tree).includes('补 KPI 假设第三段'));
check('卡片说人话：本阶段第 N 天 / 今天到期 / 待确认 N；不显示文件数',
  /第 \d+ 天/.test(textOf(tree)) && textOf(tree).includes('今天到期') && textOf(tree).includes('待确认 1') && !textOf(tree).includes('工 8'));
/* spec §22.9：卡片与抽屉读同一组条件（要进入的那个阶段）。线索列的客户看「研判」的 2 项；
   研判列的客户看「会面」的 1 项——它在研判那一列已经勾过的 1 项不算在内。 */
{
  const dotTitles = byClass(tree, 'fde-dotline').map((n) => String((n.props && n.props.title) || ''));
  check('卡片的「待确认」读的是要进入的阶段（与抽屉一致）',
    textOf(tree).includes('待确认 2')
    && dotTitles.some((x) => x === '进入「研判」需要你确认的事：已确认 0 项，共 2 项')
    && dotTitles.some((x) => x === '进入「会面」需要你确认的事：已确认 0 项，共 1 项'),
    JSON.stringify(dotTitles));
}
check('空列不放「（空）」占位文字', !textOf(tree).includes('（空）') && byClass(tree, 'fde-col-empty').length >= 1);
check('卡片有 draggable 与 tabIndex=0',
  collect(tree, (n) => n.props && n.props.draggable === 'true' && n.props.tabIndex === 0).length >= 2);

/* 拖拽：研判 → 会面 */
const cardA = collect(tree, (n) => n.props && n.props.draggable === 'true' && String(n.props['aria-label'] || '').indexOf('某环境集团') !== -1)[0];
const meetingCol = collect(tree, (n) => n.props && n.props.role === 'list' && String(n.props['aria-label'] || '').indexOf('会面') === 0)[0];
check('找到客户卡片与目标列', !!cardA && !!meetingCol);
if (cardA && meetingCol) {
  const dt = { data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k] || ''; }, dropEffect: '', effectAllowed: '' };
  cardA.props.onDragStart(evt({ dataTransfer: dt }));
  tree = await renderStable(PanelApp, makeProps());
  const meetingCol2 = collect(tree, (n) => n.props && n.props.role === 'list' && String(n.props['aria-label'] || '').indexOf('会面') === 0)[0];
  meetingCol2.props.onDrop(evt({ dataTransfer: dt }));
  tree = await act(PanelApp, makeProps(), () => {});
  const move = lastCall('POST', '/fde/engagement');
  check('拖拽移动阶段 → POST engagement move patch.stage=meeting',
    !!move && move.body.action === 'move' && move.body.patch.stage === 'meeting',
    JSON.stringify(move && move.body));
}

/* 键盘：会面 → 场景（Alt+ArrowRight，v1.3 8 阶段顺序） */
const cardA2 = collect(tree, (n) => n.props && n.props.draggable === 'true' && String(n.props['aria-label'] || '').indexOf('某环境集团') !== -1)[0];
check('键盘可达：卡片可聚焦（tabIndex=0）', !!cardA2);
if (cardA2) {
  tree = await act(PanelApp, makeProps(), () => cardA2.props.onKeyDown(evt({ key: 'ArrowRight', altKey: true })));
  const move2 = lastCall('POST', '/fde/engagement');
  check('Alt+→ 移动阶段 → patch.stage=scoping（会议之后是场景）',
    !!move2 && move2.body.action === 'move' && move2.body.patch.stage === 'scoping',
    JSON.stringify(move2 && move2.body));
}

/* 门禁拦截 → 缺项弹层 → 强制（需理由） */
stub('POST', '/research-workbench/api/fde/engagement', (call) => {
  const body = call.body || {};
  if (body.action === 'move' && body.patch && body.patch.stage === 'pilot' && !body.patch.force) {
    return { ok: false, blocked: true, code: 'BLOCKED', reason: '门禁未通过', missing: [{ type: 'manual', key: 'pilot_scope', label: '范围与指标客户确认' }] };
  }
  return { ok: true, engagement: BOARD.engagements[0] };
});
const cardA3 = collect(tree, (n) => n.props && n.props.draggable === 'true' && String(n.props['aria-label'] || '').indexOf('某环境集团') !== -1)[0];
const pilotCol = collect(tree, (n) => n.props && n.props.role === 'list' && String(n.props['aria-label'] || '').indexOf('试点') === 0)[0];
if (cardA3 && pilotCol) {
  const dt2 = { data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k] || ''; } };
  cardA3.props.onDragStart(evt({ dataTransfer: dt2 }));
  tree = await renderStable(PanelApp, makeProps());
  const pilotCol2 = collect(tree, (n) => n.props && n.props.role === 'list' && String(n.props['aria-label'] || '').indexOf('试点') === 0)[0];
  pilotCol2.props.onDrop(evt({ dataTransfer: dt2 }));
  tree = await act(PanelApp, makeProps(), () => {});
  check('推进条件没满足：弹层列出还差什么', textOf(tree).includes('还不能进入下一阶段') && textOf(tree).includes('进入「试点」还差这些')
    && textOf(tree).includes('范围与指标客户确认') && btnExact(tree, '去补齐').length === 1);
  if (process.env.DBG) console.log('DBG dialog buttons:', buttons(tree).map((b) => textOf(b).trim()).slice(0, 20), 'inputs:', byType(tree, 'input').map((n) => n.props.placeholder || n.props['aria-label']));
  const forceBtn = btnExact(tree, '破例推进')[0];
  check('弹层提供「破例推进」并需二次确认', !!forceBtn);
  if (forceBtn) {
    tree = await act(PanelApp, makeProps(), () => forceBtn.props.onClick());
    const reasonInput = inputByAria(tree, '原因')[1] || inputByAria(tree, '原因')[0];
    check('破例推进弹出原因输入（必填）', !!reasonInput);
    if (reasonInput) {
      const emptyConfirm = btnExact(tree, '破例推进').pop();
      const beforeForce = callsOf('POST', '/fde/engagement').length;
      if (emptyConfirm) tree = await act(PanelApp, makeProps(), () => emptyConfirm.props.onClick());
      check('不写原因不能破例推进（不发请求，行内提示）',
        callsOf('POST', '/fde/engagement').length === beforeForce && textOf(tree).includes('写下原因再继续'));
      const reasonInput2 = inputByAria(tree, '原因')[1] || inputByAria(tree, '原因')[0];
      tree = await act(PanelApp, makeProps(), () => reasonInput2.props.onChange(evt({ target: { value: '客户口头确认，先推进' } })));
      const confirmForce = btnExact(tree, '破例推进').pop();
      if (confirmForce) tree = await act(PanelApp, makeProps(), () => confirmForce.props.onClick());
      const forced = lastCall('POST', '/fde/engagement');
      check('破例推进提交 force+reason',
        !!forced && forced.body.patch.force === true && /口头确认/.test(String(forced.body.patch.reason)),
        JSON.stringify(forced && forced.body));
    }
  }
}
/* 恢复后端正常响应 */
stub('POST', '/research-workbench/api/fde/engagement', () => ({ ok: true, engagement: BOARD.engagements[0] }));

/* 任务模式：5 列 + 拖拽到 done 需证据 */
const taskSeg = pageTab(tree, '任务');
check('客户页可切换到「任务」子页签', !!taskSeg);
if (taskSeg) {
  tree = await act(PanelApp, makeProps(), () => taskSeg.props.onClick());
  const taskCols = byClass(tree, 'fde-col');
  check('任务模式 5 列（meta.boardLanes）', taskCols.length === 5, '列数 ' + taskCols.length);
  check('任务卡片渲染标题；列头显示同时进行上限（2/5），不出现 WIP 字样', textOf(tree).includes('补齐 KPI 假设')
    && textOf(tree).includes('2/5') && !textOf(tree).includes('WIP'));
  check('任务视图有「新建任务」', btnExact(tree, '新建任务').length >= 1);

  stub('POST', '/research-workbench/api/fde/item', (call) => {
    const body = call.body || {};
    if (body.action === 'move' && body.patch && body.patch.stage === 'done' && !body.patch.evidence) {
      return { ok: false, blocked: true, reason: '进入 done 需要证据', missing: [{ type: 'manual', key: 'evidence', label: '证据' }] };
    }
    return { ok: true, item: BOARD.items[0] };
  });
  const taskCard = collect(tree, (n) => n.props && n.props.draggable === 'true' && String(n.props['aria-label'] || '').indexOf('补公司年报摘要') !== -1)[0];
  const doneCol = collect(tree, (n) => n.props && n.props.role === 'list' && String(n.props['aria-label'] || '').indexOf('已完成') === 0)[0];
  check('找到任务卡片与已完成列', !!taskCard && !!doneCol);
  if (taskCard && doneCol) {
    const dt3 = { data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k] || ''; } };
    taskCard.props.onDragStart(evt({ dataTransfer: dt3 }));
    tree = await renderStable(PanelApp, makeProps());
    const doneCol2 = collect(tree, (n) => n.props && n.props.role === 'list' && String(n.props['aria-label'] || '').indexOf('已完成') === 0)[0];
    doneCol2.props.onDrop(evt({ dataTransfer: dt3 }));
    tree = await act(PanelApp, makeProps(), () => {});
    check('标记完成前要写一句结果（弹层）', textOf(tree).includes('写一句结果再标记完成'));
    const evidenceInput = byType(tree, 'textarea')[0];
    if (evidenceInput) {
      tree = await act(PanelApp, makeProps(), () => evidenceInput.props.onChange(evt({ target: { value: '已完成，产物 research/KPI与痛点假设.md' } })));
      const moveWithEvidence = btnExact(tree, '标记完成')[0];
      if (moveWithEvidence) tree = await act(PanelApp, makeProps(), () => moveWithEvidence.props.onClick());
      const evCall = lastCall('POST', '/fde/item');
      check('带结果说明标记完成：提交 evidence + force',
        !!evCall && /KPI与痛点假设/.test(String(evCall.body.patch.evidence)) && evCall.body.patch.force === true,
        JSON.stringify(evCall && evCall.body));
    }
  }
  stub('POST', '/research-workbench/api/fde/item', () => ({ ok: true, item: BOARD.items[0] }));
}

/* ================= 场景三：客户抽屉 ================= */
const customerTab = navBtn(tree, '客户');
check('点击「客户」页签可导航', !!customerTab);
tree = await act(PanelApp, makeProps(), () => customerTab.props.onClick());
const listTab = pageTab(tree, '列表');
check('客户页可切换到「列表」子页签', !!listTab);
if (listTab) tree = await act(PanelApp, makeProps(), () => listTab.props.onClick());
check('客户表格渲染行与下一步；表头是中文（不是文案 key）', textOf(tree).includes('某环境集团') && textOf(tree).includes('补 KPI 假设第三段')
  && collect(tree, (n) => n.type === 'th').map((n) => textOf(n).trim()).join('|') === '客户|阶段|优先级|下一步|到期|本阶段|待处理');
const customerRow = collect(tree, (n) => n.type === 'tr' && String(textOf(n)).indexOf('某环境集团') !== -1)[0];
check('客户行可点击打开抽屉', !!customerRow);
if (customerRow) {
  tree = await act(PanelApp, makeProps(), () => { if (customerRow.props.onClick) customerRow.props.onClick(); else customerRow.props.onKeyDown(evt({ key: 'Enter' })); });
}
const drawerText = () => textOf(byClass(tree, 'fde-drawer')[0] || {});
check('客户抽屉渲染（下一步 / 阶段与推进条件 / 关键人 / 资料 / 记录），按这个顺序',
  (() => {
    const titles = collect(byClass(tree, 'fde-drawer')[0] || {}, (n) => n.props && n.props.className === 'fde-block-title').map((n) => textOf(n).trim());
    const order = ['下一步', '阶段', '关键人', '资料', '记录'].map((x) => titles.indexOf(x));
    return order.every((x) => x >= 0) && order.join(',') === order.slice().sort((a, b) => a - b).join(',');
  })() && btnByText(byClass(tree, 'fde-drawer')[0] || {}, '交给 AI').length >= 1);
check('客户抽屉不显示内部标识（对象编号 / 检查项 key / created · human）',
  !drawerText().includes('eng_aaaaaa') && !drawerText().includes('subject_locked') && !/created|human/.test(drawerText()));
check('下一步没有改动时不显示保存按钮；改了才出现', btnExact(byClass(tree, 'fde-drawer')[0] || {}, '保存').length === 0);
{
  {
    /* 链接上的阶段名要和「进入「X」还差什么」是同一个阶段 */
    const guideTexts = buttons(byClass(tree, 'fde-drawer')[0] || {}).map((b) => textOf(b).trim()).filter((x) => /^「.+」怎么做$/.test(x));
    const guideStage = guideTexts[0] ? guideTexts[0].replace(/^「(.+)」怎么做$/, '$1') : '';
    check('指南链接指向要进入的阶段，文字写明阶段名',
      guideTexts.length === 1 && !!guideStage && drawerText().includes('进入「' + guideStage + '」')
      && btnExact(byClass(tree, 'fde-drawer')[0] || {}, '这个阶段怎么做').length === 0,
      JSON.stringify(guideTexts));
  }
  {
    const spaceInput = inputByAria(byClass(tree, 'fde-drawer')[0] || {}, '下一步')[0];
    if (spaceInput) {
      tree = await act(PanelApp, makeProps(), () => spaceInput.props.onChange(evt({ target: { value: '补 KPI 假设第三段  ' } })));
      check('只多了首尾空格不算改动：不出现「保存」', btnExact(byClass(tree, 'fde-drawer')[0] || {}, '保存').length === 0);
    }
  }
  const nextInput = inputByAria(byClass(tree, 'fde-drawer')[0] || {}, '下一步')[0];
  check('抽屉里可以改下一步', !!nextInput);
  if (nextInput) {
    tree = await act(PanelApp, makeProps(), () => nextInput.props.onChange(evt({ target: { value: '约王总确认试点范围' } })));
    const saveNextBtn = btnExact(byClass(tree, 'fde-drawer')[0] || {}, '保存')[0];
    check('改了下一步后出现「保存」', !!saveNextBtn);
    if (saveNextBtn) tree = await act(PanelApp, makeProps(), () => saveNextBtn.props.onClick());
    const nx = lastCall('POST', '/fde/engagement');
    check('保存下一步 → POST engagement update patch.nextAction.text',
      !!nx && nx.body.action === 'update' && nx.body.patch.nextAction && nx.body.patch.nextAction.text === '约王总确认试点范围',
      JSON.stringify(nx && nx.body));
  }
}
check('抽屉 role=dialog + aria-modal',
  collect(tree, (n) => n.props && n.props.role === 'dialog' && n.props['aria-modal'] === 'true').length >= 1);
check('抽屉打开即核对推进条件 → POST /fde/gate（不用点按钮）',
  callsOf('POST', '/fde/gate').length >= 1,
  JSON.stringify(callsOf('POST', '/fde/gate').slice(-1)));
const gateEvalCall = lastCall('POST', '/fde/gate');
check('核对请求只带阶段 key，不带 checks / force（只评估不写入）',
  !!gateEvalCall && gateEvalCall.body.engagementId === 'eng_aaaaaa'
  && META.stages.some((x) => x.key === gateEvalCall.body.stage)
  && !('checks' in gateEvalCall.body) && !gateEvalCall.body.force,
  JSON.stringify(gateEvalCall && gateEvalCall.body));
check('推进条件核对结果直接显示（已有 / 还没有），不出现「未评估」',
  !drawerText().includes('未评估') && byClass(tree, 'fde-gate-mark').length >= 1);

/* 推进条件：勾选确认项 + 选填备注 + 保存 */
const manualCheckbox = byType(tree, 'input').filter((n) => n.props.type === 'checkbox'
  && ['事实已分级', '会面目标已确认', '主体已锁定', '方案已定稿可对外', '范围与指标客户确认', '验收清单']
    .some((k) => String(n.props['aria-label'] || '').indexOf(k) !== -1))[0];
check('需要你确认的项有勾选框', !!manualCheckbox);
if (manualCheckbox) {
  check('没勾选前没有「保存确认」按钮', btnExact(tree, '保存确认').length === 0);
  const checkedLabel = String(manualCheckbox.props['aria-label']);
  tree = await act(PanelApp, makeProps(), () => manualCheckbox.props.onChange(evt({ target: { checked: true } })));
  const noteBtn = btnExact(tree, '加备注')[0];
  check('备注是选填：点「加备注」才出现输入框', !!noteBtn);
  if (noteBtn) tree = await act(PanelApp, makeProps(), () => noteBtn.props.onClick());
  const evidenceInputs = byType(tree, 'input').filter((n) => String(n.props['aria-label'] || '').indexOf(checkedLabel) === 0
    && String(n.props.placeholder || '').indexOf('备注') !== -1);
  check('备注输入框出现', evidenceInputs.length >= 1);
  if (evidenceInputs[0]) {
    tree = await act(PanelApp, makeProps(), () => evidenceInputs[0].props.onChange(evt({ target: { value: 'A 级证据 2 条，B 级 3 条' } })));
    const saveGateBtn = btnExact(tree, '保存确认')[0];
    check('勾选后出现「保存确认」', !!saveGateBtn);
    if (saveGateBtn) tree = await act(PanelApp, makeProps(), () => saveGateBtn.props.onClick());
    const gateCall = lastCall('POST', '/fde/gate');
    const savedChecks = (gateCall && gateCall.body && gateCall.body.checks) || {};
    const savedKey = Object.keys(savedChecks).filter((k) => /A 级证据/.test(String(savedChecks[k].evidence)))[0];
    check('保存确认 → checks.<key>.status=pass + 备注',
      !!savedKey && savedChecks[savedKey].status === 'pass',
      JSON.stringify(gateCall && gateCall.body));
    check('保存成功后「保存确认」收起', btnExact(tree, '保存确认').length === 0);
  }
}

/* 交给 AI */
const handoffBtn = btnByText(byClass(tree, 'fde-drawer')[0] || {}, '交给 AI')[0];
check('抽屉里有「交给 AI」', !!handoffBtn);
if (handoffBtn) {
  tree = await act(PanelApp, makeProps(), () => handoffBtn.props.onClick());
  const ho = lastCall('POST', '/fde/handoff');
  check('交给 AI → POST /fde/handoff + 打开会话',
    !!ho && ho.body.target === 'engagement' && ho.body.id === 'eng_aaaaaa' && sessionOpened.indexOf('sess_new_1') !== -1,
    JSON.stringify(ho && ho.body));
}

/* 没能自动新开会话：把要发给 AI 的那段话交到人手里（能复制就复制；复制不了就摆出来） */
{
  const handoffKey = 'POST /research-workbench/api/fde/handoff';
  const origHandoff = routeTable[handoffKey];
  stub('POST', '/research-workbench/api/fde/handoff', () => ({ ok: false, reason: '这里没法自动开新对话', prompt: '【FDE 工作站 · 阶段交接】去补事实核查清单', sessionId: '' }));
  const failBtn = btnByText(byClass(tree, 'fde-drawer')[0] || {}, '交给 AI')[0];
  clipboardWrites.length = 0;
  if (failBtn) tree = await act(PanelApp, makeProps(), () => failBtn.props.onClick());
  check('没开成会话：那段话写进剪贴板', clipboardWrites.length === 1 && clipboardWrites[0].includes('去补事实核查清单'), JSON.stringify(clipboardWrites));
  check('没开成会话且已复制：提示任务说明已复制，不弹层', textOf(tree).includes('任务说明已复制') && byClass(tree, 'fde-modal').length === 0);
  const realNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel' }, configurable: true, writable: true });
  const failBtn2 = btnByText(byClass(tree, 'fde-drawer')[0] || {}, '交给 AI')[0];
  if (failBtn2) tree = await act(PanelApp, makeProps(), () => failBtn2.props.onClick());
  const promptModal = byClass(tree, 'fde-modal')[0];
  const promptArea = promptModal ? byType(promptModal, 'textarea')[0] : null;
  check('复制不了：弹层里摆出那段话，人可以自己复制',
    !!promptArea && String(promptArea.props.value).includes('去补事实核查清单') && textOf(promptModal).includes('没能自动新开会话'),
    promptModal ? textOf(promptModal).slice(0, 80) : '（没有弹层）');
  Object.defineProperty(globalThis, 'navigator', { value: realNavigator, configurable: true, writable: true });
  const promptClose = promptModal ? btnExact(promptModal, '关闭')[0] : null;
  if (promptClose) tree = await act(PanelApp, makeProps(), () => promptClose.props.onClick());
  check('点「关闭」收起弹层', byClass(tree, 'fde-modal').length === 0);
  routeTable[handoffKey] = origHandoff;
}

/* 归档：二次确认 */
const archiveBtn = btnExact(tree, '归档')[0];
if (archiveBtn) {
  tree = await act(PanelApp, makeProps(), () => archiveBtn.props.onClick());
  check('归档弹二次确认（说明文件都还在）', textOf(tree).includes('文件夹和文件都还在'));
  const confirmArchive = btnExact(tree, '归档').filter((b) => textOf(b).trim() === '归档').pop();
  if (confirmArchive) tree = await act(PanelApp, makeProps(), () => confirmArchive.props.onClick());
  const archCall = lastCall('POST', '/fde/engagement');
  check('确认归档 → POST engagement archive', !!archCall && archCall.body.action === 'archive', JSON.stringify(archCall && archCall.body));
}

/* ================= 场景三·续：任务抽屉（编辑/回报/删除） ================= */
{
  const boardNav = navBtn(tree, '客户');
  tree = await act(PanelApp, makeProps(), () => boardNav.props.onClick());
  const taskSeg2 = pageTab(tree, '任务');
  tree = await act(PanelApp, makeProps(), () => taskSeg2.props.onClick());
  const taskCard2 = collect(tree, (n) => n.props && n.props.draggable === 'true' && String(n.props['aria-label'] || '').indexOf('补公司年报摘要') !== -1)[0];
  check('任务卡片可打开抽屉', !!taskCard2);
  if (taskCard2) {
    tree = await act(PanelApp, makeProps(), () => taskCard2.props.onClick());
    const itemDrawer = () => byClass(tree, 'fde-drawer')[0] || {};
    check('任务抽屉渲染（字段 / 进展 / 交给 AI / 删除），不显示任务编号',
      textOf(itemDrawer()).includes('进展') && btnExact(itemDrawer(), '交给 AI').length === 1 && btnExact(itemDrawer(), '删除').length === 1
      && !textOf(itemDrawer()).includes('itm_dddddd'));
    check('任务字段没有改动时不显示保存按钮', btnExact(itemDrawer(), '保存').length === 0);

    /* 编辑标题：update 不得带 stage（宿主会拒绝） */
    const titleInput = byType(tree, 'input').filter((n) => n.props.value === '补公司年报摘要')[0];
    check('任务抽屉可编辑标题', !!titleInput);
    if (titleInput) {
      tree = await act(PanelApp, makeProps(), () => titleInput.props.onChange(evt({ target: { value: '补公司年报摘要（复核）' } })));
      const saveItemBtn = btnExact(byClass(tree, 'fde-drawer')[0] || {}, '保存')[0];
      check('改了标题后出现「保存」', !!saveItemBtn);
      if (saveItemBtn) tree = await act(PanelApp, makeProps(), () => saveItemBtn.props.onClick());
      const upd = lastCall('POST', '/fde/item');
      check('保存任务 → update 且 patch 不含 stage（状态变更走移动）',
        !!upd && upd.body.action === 'update' && upd.body.patch.title === '补公司年报摘要（复核）'
        && !Object.prototype.hasOwnProperty.call(upd.body.patch, 'stage'),
        JSON.stringify(upd && upd.body));
    }

    /* 记一笔进展：表单默认收起，点开才出现 */
    check('进展表单默认收起', byType(byClass(tree, 'fde-drawer')[0] || {}, 'textarea').length === 0);
    const openReport = btnExact(tree, '记一笔进展')[0];
    check('任务抽屉有「记一笔进展」', !!openReport);
    if (openReport) tree = await act(PanelApp, makeProps(), () => openReport.props.onClick());
    const kindSel = byType(tree, 'select').filter((n) => String(n.props['aria-label'] || '') === '情况')[0];
    check('进展的几种情况是人话（不出现 ready / blocked）',
      !!kindSel && collect(kindSel, (n) => n.type === 'option').map((n) => textOf(n).trim()).join('|') === '有进展|做完了，等验收|卡住了|没做成|不做了');
    if (kindSel) tree = await act(PanelApp, makeProps(), () => kindSel.props.onChange(evt({ target: { value: 'ready' } })));
    const reportArea = byType(tree, 'textarea').filter((n) => String(n.props['aria-label'] || '') === '说明')[0];
    check('进展表单有说明输入', !!reportArea);
    if (reportArea) {
      tree = await act(PanelApp, makeProps(), () => reportArea.props.onChange(evt({ target: { value: '摘要已补，产物 research/年报摘要.md' } })));
      const submitReport = btnExact(tree, '记下')[0];
      if (submitReport) tree = await act(PanelApp, makeProps(), () => submitReport.props.onClick());
      const rep = lastCall('POST', '/fde/item');
      check('记下进展 → action=report kind=ready',
        !!rep && rep.body.action === 'report' && rep.body.kind === 'ready' && /年报摘要/.test(String(rep.body.text)),
        JSON.stringify(rep && rep.body));
    }

    /* 删除：二次确认 */
    const delBtn = btnExact(byClass(tree, 'fde-drawer')[0] || {}, '删除')[0];
    if (delBtn) tree = await act(PanelApp, makeProps(), () => delBtn.props.onClick());
    check('删除任务弹二次确认（说明不能恢复、客户文件不受影响）', textOf(tree).includes('删除这个任务？') && textOf(tree).includes('删除后不能恢复'));
    const confirmDel = btnExact(tree, '删除').pop();
    if (confirmDel) tree = await act(PanelApp, makeProps(), () => confirmDel.props.onClick());
    const delCall = lastCall('POST', '/fde/item');
    check('确认删除 → action=delete', !!delCall && delCall.body.action === 'delete', JSON.stringify(delCall && delCall.body));
  }
}

/* ================= 场景四：客户导入（adopt 两段式） ================= */
{
  const listNav = navBtn(tree, '客户');
  if (listNav) tree = await act(PanelApp, makeProps(), () => listNav.props.onClick());
  const listTab2 = pageTab(tree, '列表');
  if (listTab2) tree = await act(PanelApp, makeProps(), () => listTab2.props.onClick());
}
const adoptBtn = btnExact(tree, '导入已有文件夹')[0];
check('列表页有「导入已有文件夹」', !!adoptBtn);
if (adoptBtn) {
  tree = await act(PanelApp, makeProps(), () => adoptBtn.props.onClick());
  check('扫描候选 → POST /fde/adopt scan', callsOf('POST', '/fde/adopt').some((c) => c.body.action === 'scan'));
  check('候选列表渲染并标出已导入的；不显示「置信度」这类内部字段',
    textOf(tree).includes('legacy-project') && textOf(tree).includes('已导入') && !textOf(tree).includes('置信度') && !textOf(tree).includes('high'));
  const candCheckbox = byType(tree, 'input').filter((n) => n.props.type === 'checkbox' && String(n.props['aria-label'] || '').indexOf('legacy-project') !== -1)[0];
  const knownCand = byType(tree, 'input').filter((n) => n.props.type === 'checkbox' && String(n.props['aria-label'] || '').indexOf('某环境集团') !== -1)[0];
  check('候选可勾选（未导入的）', !!candCheckbox && candCheckbox.props.disabled === false);
  check('已导入的候选不能重复导入', !!knownCand && knownCand.props.disabled === true);
  if (candCheckbox) {
    tree = await act(PanelApp, makeProps(), () => candCheckbox.props.onChange(evt({ target: { checked: true } })));
    const applyBtn = btnByText(tree, '导入（1）')[0];
    check('勾选后按钮显示数量「导入（1）」', !!applyBtn);
    if (applyBtn) tree = await act(PanelApp, makeProps(), () => applyBtn.props.onClick());
    const applyCall = callsOf('POST', '/fde/adopt').filter((c) => c.body.action === 'apply').pop();
    check('确认导入 → POST /fde/adopt apply dirs 含 legacy-project',
      !!applyCall && Array.isArray(applyCall.body.dirs) && applyCall.body.dirs.indexOf('legacy-project') !== -1,
      JSON.stringify(applyCall && applyCall.body));
  }
}

/* ================= 场景五：资料 / 方法 / 设置 ================= */
const matTab = navBtn(tree, '资料');
check('点击「资料」页签可导航', !!matTab);
tree = await act(PanelApp, makeProps(), () => matTab.props.onClick());
check('资料页加载客户文件并渲染列表（最近 / 按客户）',
  callsOf('GET', '/files?dir=').length >= 1 && btnByText(tree, '最近').length >= 1 && btnByText(tree, '按客户').length >= 1
  && textOf(tree).includes('00-项目档案.md'));
check('资料页默认隐藏原始素材（展示原始素材开关与计数）', textOf(tree).includes('原始素材'));
const firstFile = byClass(tree, 'fde-mat-file')[0];
if (firstFile) tree = await act(PanelApp, makeProps(), () => firstFile.props.onClick());
check('点文件 → 右侧内嵌预览（/api/file 读取 + 渲染正文）',
  callsOf('GET', '/api/file').length >= 1 && textOf(tree).includes('预览正文'));
check('预览头部有导出 PDF / 用系统应用打开', btnByText(tree, '导出 PDF').length >= 1 && btnByText(tree, '用系统应用打开').length >= 1);
const exportBtn = btnByText(tree, '导出 PDF')[0];
if (exportBtn) {
  tree = await act(PanelApp, makeProps(), () => exportBtn.props.onClick());
  const expCall = lastCall('POST', '/research-workbench/api/handoff');
  check('导出 PDF 复用旧 /handoff action=export',
    !!expCall && expCall.body.action === 'export' && expCall.body.dir === '某环境-20261013',
    JSON.stringify(expCall && expCall.body));
}

const processNav = navBtn(tree, '流程');
check('点击「流程」页签可导航', !!processNav);
if (processNav) tree = await act(PanelApp, makeProps(), () => processNav.props.onClick());
const methodsTab = pageTab(tree, '方法库');
check('流程页可切换到「方法库」子页签', !!methodsTab);
if (methodsTab) tree = await act(PanelApp, makeProps(), () => methodsTab.props.onClick());
check('方法库列出方法文件（名称不带序号前缀与扩展名）',
  btnExact(tree, '调研执行流程').length === 1 && !textOf(tree).includes('00-调研执行流程'));
const methodEntry = btnExact(tree, '调研执行流程')[0];
if (methodEntry) {
  tree = await act(PanelApp, makeProps(), () => methodEntry.props.onClick());
  check('点开即读方法正文（Markdown 渲染，不是源码）',
    textOf(tree).includes('调研执行流程') && byClass(tree, 'fde-method-body').length === 1 && byType(tree, 'pre').length === 0);
}
const skillsTab = pageTab(tree, '技能与模板');
check('流程页可切换到「技能与模板」子页签', !!skillsTab);
if (skillsTab) tree = await act(PanelApp, makeProps(), () => skillsTab.props.onClick());
check('技能与模板列出 FDE 技能（meta.skills）', textOf(tree).includes('fde-engagement'));
const backToList = btnByText(tree, '← 返回')[0];
if (backToList) tree = await act(PanelApp, makeProps(), () => backToList.props.onClick());

const settingsTab = gearBtn(tree);
check('点击页头齿轮可打开设置', !!settingsTab);
if (settingsTab) tree = await act(PanelApp, makeProps(), () => settingsTab.props.onClick());
check('设置页五组：AI 权限 / 提醒 / 数据来源 / 运行状态（已经有客户时不显示示例数据）',
  (() => {
    const titles = collect(tree, (n) => n.props && n.props.className === 'fde-section-title').map((n) => textOf(n).trim());
    return ['AI 权限', '提醒', '数据来源', '运行状态'].every((x) => titles.indexOf(x) !== -1) && titles.indexOf('示例数据') === -1;
  })());
check('设置页标题与各项名称是中文（不是文案 key）',
  textOf(tree).includes('设置') && !/tabSettings|settingsAutonomy/.test(textOf(tree))
  && textOf(tree).includes('多少天没有进展要提醒我') && textOf(tree).includes('同时进行的任务上限') && textOf(tree).includes('重启 DSH'));
check('设置页不显示没有效果的开关、规则清单与保存按钮',
  !textOf(tree).includes('目录监听') && !textOf(tree).includes('打开即出简报') && !textOf(tree).includes('规则清单')
  && btnByText(tree, '保存设置').length === 0);
check('设置页显示招采数据状态（看板响应里的招采概况）',
  textOf(tree).includes('招采数据') && textOf(tree).includes('24156') && textOf(tree).includes('2018-05-03'));
check('AI 权限只有两档，说的是 AI 能做什么；只能由你决定的事写在下面',
  byType(tree, 'input').filter((n) => n.props.type === 'radio').length === 2
  && textOf(tree).includes('只提醒，由我决定') && textOf(tree).includes('小事可以直接处理')
  && textOf(tree).includes('这些事只能由你来做') && textOf(tree).includes('推进客户阶段'));
{
  /* 改了就存：单选立即保存 */
  const radios = byType(tree, 'input').filter((n) => n.props.type === 'radio');
  const beforeSet = callsOf('POST', '/fde/settings').length;
  if (radios[1]) tree = await act(PanelApp, makeProps(), () => radios[1].props.onChange(evt({ target: { checked: true } })));
  const setCall = lastCall('POST', '/fde/settings');
  check('选「小事可以直接处理」→ 立即 POST /fde/settings patch.autonomy=assisted',
    callsOf('POST', '/fde/settings').length === beforeSet + 1 && !!setCall && setCall.body.patch.autonomy === 'assisted',
    JSON.stringify(setCall && setCall.body));
  /* 数字：离开输入框时保存；不合法的不保存并提示 */
  const stallInput = () => byType(tree, 'input').filter((n) => String(n.props['aria-label'] || '') === '多少天没有进展要提醒我')[0];
  check('没有进展的天数是数字输入框', !!stallInput() && stallInput().props.type === 'number');
  if (stallInput()) {
    tree = await act(PanelApp, makeProps(), () => stallInput().props.onChange(evt({ target: { value: '21' } })));
    tree = await act(PanelApp, makeProps(), () => stallInput().props.onBlur());
    const stallCall = lastCall('POST', '/fde/settings');
    check('改天数后离开输入框 → POST patch.stallDays=21', !!stallCall && stallCall.body.patch.stallDays === 21, JSON.stringify(stallCall && stallCall.body));
    const beforeBad = callsOf('POST', '/fde/settings').length;
    tree = await act(PanelApp, makeProps(), () => stallInput().props.onChange(evt({ target: { value: '0' } })));
    tree = await act(PanelApp, makeProps(), () => stallInput().props.onBlur());
    check('填 0 → 不保存，提示可填范围', callsOf('POST', '/fde/settings').length === beforeBad && textOf(tree).includes('请填 1 到 365 之间的整数'));

    const settingsKey = 'POST /research-workbench/api/fde/settings';
    const origSettings = routeTable[settingsKey];
    /* 没存上：输入框退回已保存的值，不留一个看起来已经生效的数 */
    stub('POST', '/research-workbench/api/fde/settings', () => ({ ok: false, reason: '没能保存设置' }));
    tree = await act(PanelApp, makeProps(), () => stallInput().props.onChange(evt({ target: { value: '30' } })));
    tree = await act(PanelApp, makeProps(), () => stallInput().props.onBlur());
    check('保存失败：输入框退回已保存的值，并说明原因',
      String(stallInput().props.value) === String(currentBoard.settings.stallDays) && textOf(tree).includes('没能保存设置'), String(stallInput().props.value));

    /* 存完一个数字，另一个正在输入的数字框不被冲掉 */
    const wipInput = () => byType(tree, 'input').filter((n) => String(n.props['aria-label'] || '') === '同时进行的任务上限')[0];
    stub('POST', '/research-workbench/api/fde/settings', (call) => {
      const patch = (call.body && call.body.patch) || {};
      if (patch.stallDays) currentBoard.settings.stallDays = patch.stallDays;
      return { ok: true, settings: currentBoard.settings };
    });
    const stallBefore = currentBoard.settings.stallDays;
    if (wipInput()) {
      tree = await act(PanelApp, makeProps(), () => stallInput().props.onChange(evt({ target: { value: '28' } })));
      tree = await act(PanelApp, makeProps(), () => wipInput().props.onChange(evt({ target: { value: '9' } })));
      tree = await act(PanelApp, makeProps(), () => stallInput().props.onBlur());
      check('存完天数后，正在输入的「同时进行上限」不被冲掉',
        currentBoard.settings.stallDays === 28 && String(stallInput().props.value) === '28' && String(wipInput().props.value) === '9',
        JSON.stringify({ stall: stallInput().props.value, wip: wipInput().props.value, saved: currentBoard.settings.stallDays }));
      /* 复原，不影响后面的场景 */
      tree = await act(PanelApp, makeProps(), () => wipInput().props.onChange(evt({ target: { value: String(currentBoard.settings.wipLimits.doing) } })));
    }
    currentBoard.settings.stallDays = stallBefore;
    routeTable[settingsKey] = origSettings;
  }
}
const healthBtn = btnExact(tree, '检查一下')[0];
check('运行状态有「检查一下」', !!healthBtn);
if (healthBtn) {
  tree = await act(PanelApp, makeProps(), () => healthBtn.props.onClick());
  check('检查一下 → GET /fde/health 并渲染逐项状态（正常 / 留意）',
    callsOf('GET', '/fde/health').length === 1 && textOf(tree).includes('看板数据可读') && textOf(tree).includes('正常') && textOf(tree).includes('留意'));
}

/* ================= 场景五·续：招采雷达（v1.1）看板徽章 / 招采页 / 抽屉 / 降级 ================= */
{
  /* 重置看板与招采可用性，避免前面场景（归档/删除）影响 */
  currentBoard = makeBoard();
  CURRENT_BRIEF = makeBrief(currentBoard);
  bidsAvailableFlag = true;

  /* 看板卡片徽章：available && total>0 才显示 */
  const boardNav2 = navBtn(tree, '客户');
  tree = await act(PanelApp, makeProps(), () => boardNav2.props.onClick());
  const customerModeBtn = pageTab(tree, '看板');
  if (customerModeBtn) tree = await act(PanelApp, makeProps(), () => customerModeBtn.props.onClick());
  check('看板客户卡片显示「招采 N」徽章（数字为采样 total）', textOf(tree).includes('招采 3'));
  check('available:false 的客户不显示徽章（即使 total>0）', !textOf(tree).includes('招采 5'));
  const bidBadge = collect(tree, (n) => n.props && String(n.props.title || '').indexOf('相关公告约') === 0)[0];
  check('看板卡片徽章的提示含量级「相关公告约 53（已取 3 条）」',
    !!bidBadge && /相关公告约 53（已取 3 条）/.test(String(bidBadge.props.title)),
    bidBadge && bidBadge.props.title);

  /* 招采页签：概况 + 结果列表 */
  const bidsNav = navBtn(tree, '情报');
  check('「情报」页签在导航中（资料库/招采同页）', !!bidsNav);
  tree = await act(PanelApp, makeProps(), () => bidsNav.props.onClick());
  const bidsTab = pageTab(tree, '招采');
  check('情报页可切换到「招采」子页签', !!bidsTab);
  if (bidsTab) tree = await act(PanelApp, makeProps(), () => bidsTab.props.onClick());
  check('招采概况渲染（条数/区间/来源）',
    textOf(tree).includes('24156') && textOf(tree).includes('2018-05-03') && textOf(tree).includes('aecc-ebidding'));
  check('招采检索自动加载结果列表（标题/关系徽章）',
    textOf(tree).includes('某水厂自控系统中标公告')
    && textOf(tree).includes('中标') && textOf(tree).includes('招标') && textOf(tree).includes('候选'));
  check('招采页显示「我的客户」概览', textOf(tree).includes('我的客户') && textOf(tree).includes('招采 3'));
  check('招采页显示「添加一条公告」（探测到招采雷达时）', textOf(tree).includes('添加一条公告'));
  check('招采页口径提示只出现一次', (textOf(tree).match(/候选人不等于中标人；金额是公告原文/g) || []).length === 1);
  check('首查走 /fde/bids/search', callsOf('GET', '/fde/bids/search').length >= 1);

  /* 展开结果：正文摘录 + 候选人名次 + 原文链接 */
  const expandBtn = btnExact(tree, '展开')[0];
  check('结果可展开正文与候选人', !!expandBtn);
  if (expandBtn) {
    tree = await act(PanelApp, makeProps(), () => expandBtn.props.onClick());
    const anchors = collect(tree, (n) => n.type === 'a' && n.props && String(n.props.href || '').indexOf('example.com/bid') !== -1);
    check('展开显示正文摘录与候选人口径提示',
      textOf(tree).includes('发布时间：2026-04-28') && textOf(tree).includes('候选人只是评标排序，不等于中标') && textOf(tree).includes('第 1 名'));
    check('原文链接新窗口 + rel=noreferrer',
      anchors.length >= 1 && anchors[0].props.target === '_blank' && /noreferrer/.test(String(anchors[0].props.rel)),
      JSON.stringify(anchors.slice(0, 2).map((a) => a.props)));
    check('金额展示公告原文（不换算）', textOf(tree).includes('100万元'));
  }

  /* 检索交互 */
  const searchInput = inputByAria(tree, '公司、采购单位、标题或正文里的词')[0];
  check('招采检索输入框存在', !!searchInput);
  if (searchInput) {
    tree = await act(PanelApp, makeProps(), () => searchInput.props.onChange(evt({ target: { value: '某环境' } })));
    const submit = btnExact(tree, '查询')[0];
    if (submit) tree = await act(PanelApp, makeProps(), () => submit.props.onClick());
    const sCall = callsOf('GET', '/fde/bids/search').pop();
    check('检索提交 q/mode 参数', !!sCall && /q=%E6%9F%90%E7%8E%AF%E5%A2%83/.test(sCall.url) && /mode=any/.test(sCall.url),
      sCall && sCall.url);
  }

  /* 导入链接（探测可用时） */
  const importInput = inputByAria(tree, '粘贴公告链接')[0];
  check('导入链接输入框存在', !!importInput);
  if (importInput) {
    tree = await act(PanelApp, makeProps(), () => importInput.props.onChange(evt({ target: { value: 'https://example.com/new-bid' } })));
    const importBtn = btnExact(tree, '添加')[0];
    if (importBtn) tree = await act(PanelApp, makeProps(), () => importBtn.props.onClick());
    const imp = lastCall('POST', '/bidintel/api/import-url');
    check('导入链接 POST /bidintel/api/import-url 并回显成功',
      !!imp && imp.body.url === 'https://example.com/new-bid' && textOf(tree).includes('已添加'));
  }

  /* 客户抽屉招采区 */
  const overviewRow = buttons(tree).filter((b) => textOf(b).includes('某环境集团') && textOf(b).includes('招采 3'))[0];
  check('「我的客户」里的行可打开客户抽屉', !!overviewRow);
  if (overviewRow) tree = await act(PanelApp, makeProps(), () => overviewRow.props.onClick());
  check('抽屉招采区渲染（统计徽章 / 相关公告 / 已关联的公告）',
    textOf(tree).includes('相关约 1603（已取 3 条）') && textOf(tree).includes('招标 2')
    && textOf(tree).includes('中标 1') && textOf(tree).includes('候选 1')
    && textOf(tree).includes('已关联的公告') && textOf(tree).includes('备注：跟进中'));
  const drawerNode = byClass(tree, 'fde-drawer')[0];
  const drawerAnchorText = drawerNode ? collect(drawerNode, (n) => n.type === 'a').map((a) => textOf(a)).join('|') : '';
  check('抽屉相关公告行有 建跟进任务 / 关联 / 看原文 / 取消关联',
    btnExact(tree, '建跟进任务').length >= 1 && btnExact(tree, '关联').length >= 1
    && btnExact(tree, '取消关联').length >= 1 && drawerAnchorText.indexOf('看原文') !== -1);
  const watchBox = byType(tree, 'input').filter((n) => n.props.type === 'checkbox' && String(n.props['aria-label'] || '').indexOf('有新公告时提醒我') !== -1)[0];
  check('抽屉有「有新公告时提醒我」开关（默认开）', !!watchBox && watchBox.props.checked === true);
  if (watchBox) {
    tree = await act(PanelApp, makeProps(), () => watchBox.props.onChange(evt({ target: { checked: false } })));
    const wc = lastCall('POST', '/fde/engagement');
    check('关掉新公告提醒 → POST engagement update patch.bidWatch.enabled=false',
      !!wc && wc.body.action === 'update' && wc.body.patch && wc.body.patch.bidWatch && wc.body.patch.bidWatch.enabled === false,
      JSON.stringify(wc && wc.body));
  }
  const linkBtn = btnExact(tree, '关联')[0];
  if (linkBtn) {
    tree = await act(PanelApp, makeProps(), () => linkBtn.props.onClick());
    const lc = lastCall('POST', '/fde/bids/link');
    check('关联 → POST /fde/bids/link（engagementId+bidId）',
      !!lc && lc.body.engagementId === 'eng_aaaaaa' && lc.body.bidId === 'aecc-ebidding:x1', JSON.stringify(lc && lc.body));
  }
  const promoteBtn = btnExact(byClass(tree, 'fde-drawer')[0] || tree, '建跟进任务')[0];
  if (promoteBtn) {
    tree = await act(PanelApp, makeProps(), () => promoteBtn.props.onClick());
    const pc = lastCall('POST', '/fde/bids/promote');
    check('建跟进任务 → POST /fde/bids/promote 并提示已建任务',
      !!pc && pc.body.bidId === 'aecc-ebidding:x1' && textOf(tree).includes('已建跟进任务'));
  }
  const unlinkBtn = btnExact(tree, '取消关联')[0];
  if (unlinkBtn) {
    tree = await act(PanelApp, makeProps(), () => unlinkBtn.props.onClick());
    const uc = lastCall('POST', '/fde/bids/unlink');
    check('取消关联 → POST /fde/bids/unlink（bidId）',
      !!uc && uc.body.engagementId === 'eng_aaaaaa' && uc.body.bidId === 'aecc-ebidding:x2', JSON.stringify(uc && uc.body));
  }
  const drawerNow = byClass(tree, 'fde-drawer')[0] || tree;
  const bidRefreshBtn = buttons(drawerNow).filter((b) => textOf(b).trim() === '刷新')[0];
  check('抽屉招采区有「刷新」', !!bidRefreshBtn);
  if (bidRefreshBtn) {
    tree = await act(PanelApp, makeProps(), () => bidRefreshBtn.props.onClick());
    const rc = lastCall('POST', '/fde/bids/refresh');
    check('刷新 → POST /fde/bids/refresh（engagementId）', !!rc && rc.body.engagementId === 'eng_aaaaaa');
  }
  const closeBtn = drawerCloseBtn(tree);
  if (closeBtn) tree = await act(PanelApp, makeProps(), () => closeBtn.props.onClick());
  check('抽屉关闭后回到页面', !byClass(tree, 'fde-drawer').length);

  /* 服务不可用降级：available:false 显示未就绪，不白屏不报错 */
  bidsAvailableFlag = false;
  const settingsNav2 = gearBtn(tree);
  tree = await act(PanelApp, makeProps(), () => settingsNav2.props.onClick());
  const bidsNav2 = navBtn(tree, '情报');
  tree = await act(PanelApp, makeProps(), () => bidsNav2.props.onClick());
  const bidsTab2 = pageTab(tree, '招采');
  if (bidsTab2) tree = await act(PanelApp, makeProps(), () => bidsTab2.props.onClick());
  check('招采数据不可用 → 说清原因和怎么办（装招采雷达插件），不白屏',
    textOf(tree).includes('招采数据暂时用不了：需要安装并启用「招采雷达」插件。') && textOf(tree).includes('重试')
    && !textOf(tree).includes('bid-intel') && textOf(tree).includes('我的客户'));
  check('招采数据不可用 → 查询区不显示「没有查到公告」（不报错）',
    textOf(tree).indexOf('没有查到公告') === -1);
  {
    /* 没装招采雷达时，客户抽屉里整块不显示招采 */
    const custNav = navBtn(tree, '客户');
    tree = await act(PanelApp, makeProps(), () => custNav.props.onClick());
    const listTab3 = pageTab(tree, '列表');
    if (listTab3) tree = await act(PanelApp, makeProps(), () => listTab3.props.onClick());
    const row3 = collect(tree, (n) => n.type === 'tr' && String(textOf(n)).indexOf('某环境集团') !== -1)[0];
    if (row3) tree = await act(PanelApp, makeProps(), () => row3.props.onClick());
    const titles = collect(byClass(tree, 'fde-drawer')[0] || {}, (n) => n.props && n.props.className === 'fde-block-title').map((n) => textOf(n).trim());
    check('没装招采雷达时，客户抽屉不显示「招采」一块', titles.length >= 4 && titles.indexOf('招采') === -1, titles.join('|'));
    const closeIt = drawerCloseBtn(tree);
    if (closeIt) tree = await act(PanelApp, makeProps(), () => closeIt.props.onClick());
  }
  bidsAvailableFlag = true;
}

/* ================= 场景五·续2：流程 v2（v1.3，spec §20.5） ================= */
{
  const processNav = navBtn(tree, '流程');
  check('流程在导航中（第 4 项）', !!processNav);
  tree = await goFlow(tree);
  check('流程页带页内子页签（阶段指南 / 方法库 / 技能与模板）',
    !!pageTab(tree, '阶段指南') && !!pageTab(tree, '方法库') && !!pageTab(tree, '技能与模板'));
  check('阶段指南不解释实现（不出现接口路径与「从宿主读取」）',
    !textOf(tree).includes('/fde/meta') && !textOf(tree).includes('宿主'));

  const stepByLabel = (label) => byClass(tree, 'fde-flow-step').filter((b) => textOf(b).includes(label))[0];
  check('流程步进条渲染 8 个阶段（来自 meta.stages）',
    byClass(tree, 'fde-flow-step').length === 8, '阶段数 ' + byClass(tree, 'fde-flow-step').length);
  check('8 个阶段名齐全（含 v1.3 新增「场景」）',
    ['线索', '研判', '会面', '场景', '方案', '试点', '交付', '采用'].every((x) => textOf(tree).includes(x)));
  check('阶段条显示当前客户数（没有装饰性的状态点）',
    textOf(tree).includes('1 个客户') && byClass(tree, 'fde-flow-gate-dot').length === 0);

  const scopingStep = stepByLabel('场景');
  check('可点击切换阶段详情', !!scopingStep);
  if (scopingStep) tree = await act(PanelApp, makeProps(), () => scopingStep.props.onClick());
  check('阶段详情渲染 要达成 / 要做的事 / 开始前要有 / 要交出来的 / 容易踩的坑',
    textOf(tree).includes('把需求池收敛到可启动场景')
    && textOf(tree).includes('这个阶段要达成') && textOf(tree).includes('开始前要有')
    && textOf(tree).includes('要做的事') && textOf(tree).includes('要交出来的') && textOf(tree).includes('容易踩的坑'));
  check('阶段详情渲染进入条件（材料与确认项一张清单，确认项标出「需要你确认」）',
    textOf(tree).includes('进入这个阶段的条件') && textOf(tree).includes('（需要你确认）')
    && textOf(tree).includes('有姓名的业务发起人') && textOf(tree).includes('场景评估表')
    && !textOf(tree).includes('自动检查') && !textOf(tree).includes('人工确认'));

  /* method chip → 方法页直达打开文件 */
  const methodChip = buttons(tree).filter((b) => textOf(b).trim() === '场景选择与数据体检')[0];
  check('工具 chips 含 method（场景选择与数据体检）', !!methodChip);
  if (methodChip) tree = await act(PanelApp, makeProps(), () => methodChip.props.onClick());
  check('method chip → 跳「方法」页并直接打开该文件',
    callsOf('GET', '/methods?name=06-').length >= 1
    && textOf(tree).includes('场景选择与数据体检') && textOf(tree).includes('四条硬门槛'));

  /* template chip → 方法页打开模板 */
  tree = await goFlow(tree);
  const scopingStep2 = stepByLabel('场景');
  if (scopingStep2) tree = await act(PanelApp, makeProps(), () => scopingStep2.props.onClick());
  const tplChip = buttons(tree).filter((b) => textOf(b).trim() === '场景评估表')[0];
  check('工具 chips 含 template（场景评估表）', !!tplChip);
  if (tplChip) tree = await act(PanelApp, makeProps(), () => tplChip.props.onClick());
  check('template chip → 跳「方法」页并直接打开模板',
    callsOf('GET', '/methods?name=%E5%9C%BA%E6%99%AF%E8%AF%84%E4%BC%B0%E8%A1%A8').length >= 1
    && textOf(tree).includes('模板：场景'));

  /* 技能：点一下就复制一句能粘贴到会话的话 */
  tree = await goFlow(tree);
  const scopingStep3 = stepByLabel('场景');
  if (scopingStep3) tree = await act(PanelApp, makeProps(), () => scopingStep3.props.onClick());
  const skillChip = buttons(tree).filter((b) => textOf(b).trim() === '场景技能')[0];
  check('可以用的：含技能（场景技能）', !!skillChip);
  clipboardWrites.length = 0;
  if (skillChip) tree = await act(PanelApp, makeProps(), () => skillChip.props.onClick());
  check('点技能 → 直接复制一句话（含技能名），不用再点「复制」',
    clipboardWrites.length === 1 && clipboardWrites[0].includes('请加载技能「fde-scoping」') && btnExact(tree, '复制').length === 0,
    JSON.stringify(clipboardWrites));
  check('复制后有反馈：已复制，粘贴到会话里就能用', textOf(tree).includes('已复制') && textOf(tree).includes('粘贴到会话里就能用'));

  /* 工具：同样一键复制 */
  const toolChip = buttons(tree).filter((b) => textOf(b).trim().indexOf('场景评估') === 0 && textOf(b).trim() !== '场景评估表')[0];
  check('可以用的：含工具（场景评估）', !!toolChip);
  if (toolChip) tree = await act(PanelApp, makeProps(), () => toolChip.props.onClick());
  check('点工具 → 复制「请用工具「fde_scenario」来算…」',
    clipboardWrites.length === 2 && clipboardWrites[1].includes('请用工具「fde_scenario」来算'), JSON.stringify(clipboardWrites.slice(-1)));

  /* 资料库 → 跳资料库 */
  const libChip = buttons(tree).filter((b) => textOf(b).trim() === '资料库：场景参考')[0];
  check('可以用的：含资料库（跳资料库）', !!libChip);
  if (libChip) tree = await act(PanelApp, makeProps(), () => libChip.props.onClick());
  check('点资料库 → 跳到情报页的资料库并加载',
    !!pageTab(tree, '资料库') && pageTab(tree, '资料库').props['aria-selected'] === 'true' && callsOf('GET', '/fde/library/feed').length >= 1);

  /* 阶段 × 工具矩阵已移除 */
  tree = await goFlow(tree);
  check('阶段 × 工具矩阵不再出现（每个阶段自己的清单已包含同样信息）',
    !textOf(tree).includes('阶段 × 工具矩阵') && byClass(tree, 'fde-matrix').length === 0);
}

/* ================= 场景五·续3：meta 缺 playbook 降级（不白屏） ================= */
{
  META_CURRENT = META_NO_PLAYBOOK;
  stub('GET', '/research-workbench/api/fde/meta', { ok: true, meta: META_NO_PLAYBOOK });
  instances.clear();
  tree = await renderStable(PanelApp, makeProps());
  const processNav = navBtn(tree, '流程');
  check('无 playbook 时流程页仍可达（不白屏）', !!processNav);
  tree = await goFlow(tree);
  check('阶段指南没加载出来 → 提示重启 DSH（不白屏，阶段条仍在）',
    textOf(tree).includes('阶段指南还没加载出来，重启 DSH 后再看') && byClass(tree, 'fde-flow-step').length === 8);

  META_CURRENT = META;
  stub('GET', '/research-workbench/api/fde/meta', { ok: true, meta: META });
  instances.clear();
  tree = await renderStable(PanelApp, makeProps());
}

/* ================= 场景五·续4：资料库（v1.3，spec §19.6） ================= */
{
  libMode = 'ok';
  windowOpens.length = 0;
  const libNav = navBtn(tree, '情报');
  check('「资料」页签在导航中（资料库 / 招采同页）', !!libNav);
  if (libNav) tree = await act(PanelApp, makeProps(), () => libNav.props.onClick());
  const libTab = pageTab(tree, '资料库');
  check('情报页带子页签（资料库 / 招采）', !!libTab && !!pageTab(tree, '招采'));
  if (libTab) tree = await act(PanelApp, makeProps(), () => libTab.props.onClick());

  check('资料库首屏 GET /fde/library/feed', callsOf('GET', '/fde/library/feed').length >= 1);
  check('顶部信息：数据日期 / 更新于 / 总条数 / 来源组计数',
    textOf(tree).includes('更新于')
    && textOf(tree).includes('共 7 条') && textOf(tree).includes('国外官方') && textOf(tree).includes('社区动态'));
  const featuredCards = byClass(tree, 'fde-lib-featured-card');
  check('本期重点推荐渲染前 6 条', featuredCards.length === 6, 'featured ' + featuredCards.length);
  check('重点推荐卡片含标题 / 发布方 / 来源组 / 权威性徽章 / 阶段 chips / 外链',
    textOf(featuredCards[0]).includes('A practical guide to building agents')
    && textOf(featuredCards[0]).includes('OpenAI')
    && textOf(featuredCards[0]).includes('国外官方')
    && !!byClass(featuredCards[0], 'fde-lib-auth').length
    && buttons(featuredCards[0]).some((b) => textOf(b).trim() === '看原文')
    && textOf(tree).includes('重点推荐'));
  const repoCard = byClass(tree, 'fde-lib-card').filter((n) => textOf(n).includes('openai/openai-agents-python'))[0];
  check('开源条目显示 stars / license / pushedAt',
    !!repoCard && textOf(repoCard).includes('12,345') && textOf(repoCard).includes('MIT')
    && textOf(repoCard).includes('最近更新'));
  check('资料类型显示中文（不是文案 key）', !/libKind[A-Z]/.test(textOf(tree)) && textOf(tree).includes('指南'));

  /* 来源组筛选 */
  const groupSeg = byClass(tree, 'fde-lib-groups')[0];
  const groupBtn = (label) => (groupSeg ? buttons(groupSeg).filter((b) => textOf(b).indexOf(label) === 0)[0] : null);
  check('来源组分段齐全（全部 / 国外官方 / 国内官方 / 开源工具 / 方法与模板 / 社区动态）',
    ['全部', '国外官方', '国内官方', '开源工具', '方法与模板', '社区动态'].every((x) => !!groupBtn(x)));
  if (groupBtn('开源工具')) tree = await act(PanelApp, makeProps(), () => groupBtn('开源工具').props.onClick());
  check('来源组筛选生效：只剩开源条目', byClass(tree, 'fde-lib-card').length === 1);
  if (groupBtn('全部')) tree = await act(PanelApp, makeProps(), () => groupBtn('全部').props.onClick());

  /* 适用阶段筛选（8 阶段来自 meta.stages） */
  const selectByAria = (label) => byType(tree, 'select').filter((n) => String(n.props['aria-label'] || '') === label)[0];
  const stageSelect = selectByAria('适用阶段');
  check('适用阶段筛选有 9 个选项（全部 + 8 阶段）',
    !!stageSelect && collect(stageSelect, (n) => n.type === 'option').length === 9);
  if (stageSelect) tree = await act(PanelApp, makeProps(), () => stageSelect.props.onChange(evt({ target: { value: 'scoping' } })));
  check('阶段筛选生效（scoping 命中 4 条：含 all 阶段条目）', byClass(tree, 'fde-lib-card').length === 4,
    'cards ' + byClass(tree, 'fde-lib-card').length);
  const stageAll = selectByAria('适用阶段');
  if (stageAll) tree = await act(PanelApp, makeProps(), () => stageAll.props.onChange(evt({ target: { value: 'all' } })));

  /* 类型筛选 */
  const kindSelect = selectByAria('类型');
  check('类型筛选存在', !!kindSelect);
  if (kindSelect) tree = await act(PanelApp, makeProps(), () => kindSelect.props.onChange(evt({ target: { value: 'repo' } })));
  check('类型筛选生效：只剩 repo', byClass(tree, 'fde-lib-card').length === 1);
  const kindAll = selectByAria('类型');
  if (kindAll) tree = await act(PanelApp, makeProps(), () => kindAll.props.onChange(evt({ target: { value: 'all' } })));

  /* 关键词搜索 + 筛选空态 */
  const libSearch = inputByAria(tree, '搜标题')[0];
  check('资料库关键词搜索框存在', !!libSearch);
  if (libSearch) {
    tree = await act(PanelApp, makeProps(), () => libSearch.props.onChange(evt({ target: { value: 'Anthropic' } })));
    check('关键词过滤生效', byClass(tree, 'fde-lib-card').length === 1 && textOf(tree).includes('Anthropic'));
    tree = await act(PanelApp, makeProps(), () => inputByAria(tree, '搜标题')[0].props.onChange(evt({ target: { value: '不存在的关键词zzz' } })));
    check('筛选无结果 → 空态 + 清空筛选',
      textOf(tree).includes('没有符合条件的资料') && !!btnExact(tree, '清空筛选')[0]);
    const resetBtn = btnExact(tree, '清空筛选')[0];
    if (resetBtn) tree = await act(PanelApp, makeProps(), () => resetBtn.props.onClick());
    check('清空筛选恢复列表', byClass(tree, 'fde-lib-card').length === 7);
  }

  /* 仅看重点推荐 */
  const favBox = byType(tree, 'input').filter((n) => n.props.type === 'checkbox'
    && String(n.props['aria-label'] || '').includes('只看重点推荐'))[0];
  check('「只看重点推荐」开关存在', !!favBox);
  if (favBox) tree = await act(PanelApp, makeProps(), () => favBox.props.onChange(evt({ target: { checked: true } })));
  check('只看重点推荐生效（只显示 featured 条目）',
    byClass(tree, 'fde-lib-card').length === 6 && !textOf(tree).includes('未核实链接示例'));
  const favBox2 = byType(tree, 'input').filter((n) => n.props.type === 'checkbox'
    && String(n.props['aria-label'] || '').includes('只看重点推荐'))[0];
  if (favBox2) tree = await act(PanelApp, makeProps(), () => favBox2.props.onChange(evt({ target: { checked: false } })));

  /* 排序：最新 / 热度 */
  const latestBtn = btnExact(tree, '最新')[0];
  check('排序切换到「最新」', !!latestBtn);
  if (latestBtn) tree = await act(PanelApp, makeProps(), () => latestBtn.props.onClick());
  check('最新排序：addedAt 最新的排第一',
    textOf(byClass(tree, 'fde-lib-card')[0]).includes('A practical guide'));
  const hotBtn = btnExact(tree, '热度')[0];
  if (hotBtn) tree = await act(PanelApp, makeProps(), () => hotBtn.props.onClick());
  check('热度排序：stars 最高的排第一',
    textOf(byClass(tree, 'fde-lib-card')[0]).includes('openai-agents-python'));

  /* 外链安全 */
  const openTitle = buttons(tree).filter((b) => textOf(b).includes('A practical guide')).filter((b) => b.props.className === 'fde-lib-title')[0];
  check('资料库标题是外链按钮', !!openTitle);
  if (openTitle) {
    windowOpens.length = 0;
    openTitle.props.onClick();
    check('外链新窗口打开且 noopener,noreferrer',
      windowOpens.length === 1 && windowOpens[0].target === '_blank'
      && windowOpens[0].features === 'noopener,noreferrer' && windowOpens[0].url === LIB_ITEMS[0].url,
      JSON.stringify(windowOpens));
  }
  const unsafeCard = byClass(tree, 'fde-lib-card').filter((n) => textOf(n).includes('未核实链接示例'))[0];
  check('非 https?:// 链接不渲染为可点标题（只提示无链接）',
    !!unsafeCard && textOf(unsafeCard).includes('这条没有可用链接')
    && buttons(unsafeCard).every((b) => !textOf(b).includes('未核实链接示例')));

  /* 刷新：成功 / 失败保留旧数据 / catalog 缺失 / 无缓存 */
  const libRefresh = () => {
    const info = byClass(tree, 'fde-lib-info')[0];
    const scope = info || byClass(tree, 'fde-card')[0] || tree;
    return buttons(scope).filter((b) => textOf(b).trim() === '刷新')[0] || btnExact(tree, '刷新')[0];
  };
  const okBtn = libRefresh();
  if (okBtn) tree = await act(PanelApp, makeProps(), () => okBtn.props.onClick());
  check('刷新 → POST /fde/library/refresh {force:true}',
    !!lastCall('POST', '/fde/library/refresh') && lastCall('POST', '/fde/library/refresh').body.force === true);
  check('刷新成功提示', textOf(tree).includes('资料库已更新'));

  libMode = 'stale';
  const failBtn = libRefresh();
  if (failBtn) tree = await act(PanelApp, makeProps(), () => failBtn.props.onClick());
  check('刷新失败但有旧数据 → 黄条（含上次成功时间）+ 旧数据仍在',
    textOf(tree).includes('上次更新没成功，现在看到的是旧内容') && textOf(tree).includes('上次成功')
    && textOf(tree).includes('A practical guide'));

  libMode = 'unavailable';
  const missingBtn = libRefresh();
  if (missingBtn) tree = await act(PanelApp, makeProps(), () => missingBtn.props.onClick());
  check('资料目录读不到 → 错误行说清怎么办（不白屏，旧数据保留，不出现 catalog 字样）',
    textOf(tree).includes('资料库打不开') && !textOf(tree).includes('catalog') && textOf(tree).includes('A practical guide'));

  libMode = 'empty';
  const emptyBtn = libRefresh();
  if (emptyBtn) tree = await act(PanelApp, makeProps(), () => emptyBtn.props.onClick());
  check('无缓存 → 空态 + 刷新按钮',
    textOf(tree).includes('资料库还没有内容') && !!libRefresh());

  libMode = 'ok';
  const todayNav = navBtn(tree, '今日');
  if (todayNav) tree = await act(PanelApp, makeProps(), () => todayNav.props.onClick());
}

/* ================= 场景五·续5：v1.5.0 只读演示模式（ADR 0006 / spec §8.8） ================= */
{
  const demoEmpty = makeBoard();
  demoEmpty.engagements = [];
  demoEmpty.items = [];
  demoEmpty.proposals = [];
  demoEmpty.activity = [];
  demoEmpty.settings = Object.assign({}, demoEmpty.settings || {}, { demoDismissed: false });
  currentBoard = demoEmpty;
  CURRENT_BRIEF = { attention: [], proposals: [], focus: [], activity: [], stats: { active: 0, dueToday: 0, overdue: 0 } };
  /* 设置写入落盘到 currentBoard.settings（模拟宿主持久化），供清除/恢复后重新拉 board */
  stub('POST', '/research-workbench/api/fde/settings', (call) => {
    const patch = (call.body || {}).patch || {};
    if ('demoDismissed' in patch) currentBoard.settings.demoDismissed = !!patch.demoDismissed;
    return { ok: true, settings: currentBoard.settings };
  });
  instances.clear();
  tree = await renderStable(PanelApp, makeProps());

  check('示例数据：没有客户且没隐藏过示例 → 横幅可见，说清「只能看，不会保存」',
    !!byClass(tree, 'fde-demo-banner')[0] && textOf(tree).includes('这是示例数据，只能看，不会保存。'));
  check('示例数据：今日用示例渲染（示例客户带「（示例）」+ 2 件待我处理 + 四块）',
    textOf(tree).includes('某集团（示例）') && textOf(tree).includes('某研究院（示例）')
    && byClass(tree, 'fde-today-panel').length === 4
    && textOf(tree).includes('等你决定') && textOf(tree).includes('待验收'));
  check('示例数据：四块内容分布正确（待我处理 2 / 提醒空 / 今天跟进 3 / 最近动态 4），动态里没有英文枚举',
    byClass(tree, 'fde-today-panel').length === 4
    && textOf(tree).includes('待我处理')
    && textOf(tree).includes('暂时没有提醒')
    && textOf(tree).includes('某材料（示例）')
    && textOf(tree).includes('任务「补齐数据来源清单和对接人」有进展') && !/progress|ready/.test(textOf(tree)));

  check('示例数据：横幅含「开始使用」「看看流程怎么走」',
    btnExact(tree, '开始使用').length === 1 && btnExact(tree, '看看流程怎么走').length === 1);

  /* 写操作被拦截：点「回复」→ 不发请求 + 行内提示 */
  const beforeWrites = fetchCalls.filter((c) => c.method === 'POST').length;
  const answerBtn = buttons(tree).filter((b) => textOf(b).trim() === '回复')[0];
  check('示例数据：今日待我处理的行有可点动作（用于验证拦截）', !!answerBtn);
  if (answerBtn) tree = await act(PanelApp, makeProps(), () => answerBtn.props.onClick());
  check('示例数据：写操作被拦截（不发 POST + 行内提示怎么换成自己的客户）',
    fetchCalls.filter((c) => c.method === 'POST').length === beforeWrites
    && textOf(tree).includes('示例数据不能改。点「开始使用」换成你自己的客户。'));

  /* 客户页：DEMO 看板 + 任务泳道均为只读示例卡 */
  const demoCustNav = navBtn(tree, '客户');
  if (demoCustNav) tree = await act(PanelApp, makeProps(), () => demoCustNav.props.onClick());
  check('示例数据：客户页看板渲染 4 张示例卡', byClass(tree, 'fde-card').length >= 4
    && textOf(tree).includes('某研究院（示例）'));
  const demoTaskTab = pageTab(tree, '任务');
  if (demoTaskTab) tree = await act(PanelApp, makeProps(), () => demoTaskTab.props.onClick());
  check('示例数据：任务看板渲染 3 个示例任务',
    textOf(tree).includes('整理场景评估表（示例）')
    && textOf(tree).includes('等待客户确认会面时间（示例）'));

  /* 一键清除：POST settings demoDismissed:true → 横幅消失 + 三步引导 */
  const clearBtn = byClass(tree, 'fde-demo-banner')[0]
    ? buttons(byClass(tree, 'fde-demo-banner')[0]).filter((b) => textOf(b).includes('开始使用'))[0] : null;
  check('示例数据：横幅有清除按钮', !!clearBtn);
  if (clearBtn) tree = await act(PanelApp, makeProps(), () => clearBtn.props.onClick());
  const clearCall = lastCall('POST', '/fde/settings');
  check('示例数据：清除 → POST /fde/settings patch.demoDismissed=true',
    !!clearCall && clearCall.body && clearCall.body.patch && clearCall.body.patch.demoDismissed === true,
    JSON.stringify(clearCall && clearCall.body));
  const backToday = navBtn(tree, '今日');
  if (backToday) tree = await act(PanelApp, makeProps(), () => backToday.props.onClick());
  check('示例数据：清除后横幅消失',
    !byClass(tree, 'fde-demo-banner').length,
    textOf(tree).slice(0, 200));
  check('隐藏示例后：今日空状态给三个按钮（新建客户 / 导入已有文件夹 / 看示例）',
    textOf(tree).includes('从第一个客户开始') && btnExact(tree, '新建客户').length >= 1
    && btnExact(tree, '导入已有文件夹').length >= 1 && btnExact(tree, '看示例').length >= 1);
  check('示例数据：清除后今日回真实空数据（无 DEMO 客户）',
    !textOf(tree).includes('某集团（示例）'),
    textOf(tree).slice(0, 300));

  /* 设置页「演示数据」卡：已清除 + 重新查看示例（demoDismissed:false） */
  const gear = gearBtn(tree);
  check('示例数据：设置页可从页头齿轮进入', !!gear);
  if (gear) tree = await act(PanelApp, makeProps(), () => gear.props.onClick());
  check('没有客户时，设置页有「示例数据」一组：状态「已隐藏」+「显示示例」',
    textOf(tree).includes('示例数据') && textOf(tree).includes('已隐藏')
    && btnExact(tree, '显示示例').length === 1);
  const restoreBtn = btnExact(tree, '显示示例')[0];
  if (restoreBtn) tree = await act(PanelApp, makeProps(), () => restoreBtn.props.onClick());
  const restoreCall = lastCall('POST', '/fde/settings');
  check('示例数据：重新查看 → POST /fde/settings patch.demoDismissed=false',
    !!restoreCall && restoreCall.body && restoreCall.body.patch && restoreCall.body.patch.demoDismissed === false,
    JSON.stringify(restoreCall && restoreCall.body));
  check('示例数据：恢复后横幅重新出现（示例只读覆盖层）', !!byClass(tree, 'fde-demo-banner')[0]);

  /* 复位：用真实数据重新挂载 FdeApp，让 demoRuntime 复位 */
  currentBoard = makeBoard();
  CURRENT_BRIEF = makeBrief(currentBoard);
  installFdeStubs();
  instances.clear();
  tree = await renderStable(PanelApp, makeProps());
}

/* ================= 场景六：宿主未就绪页 + Finder 三通道 ================= */
{
  routeTable = {}; routeSeq = {}; fetchCalls.length = 0;
  stub('GET', '/research-workbench/api/fde/meta', { ok: false, reason: '还没准备好，重启 DSH 后再试（HTTP 404）' });
  instances.clear();
  let compatTree = await renderStable(PanelApp, makeProps());
  check('未就绪页：标题「需要重启 DSH」+ 一句原因', textOf(compatTree).includes('需要重启 DSH')
    && textOf(compatTree).includes('FDE 工作站刚安装或刚升级，重启 DSH 后才能使用。'));
  check('未就绪页：只有一个「重试」（经典模式已移除），不出现内部用语',
    btnExact(compatTree, '重试').length === 1 && !textOf(compatTree).includes('经典模式')
    && !textOf(compatTree).includes('宿主') && !textOf(compatTree).includes('路由'));
  check('未就绪页：技术原因收在「详细信息」里', textOf(compatTree).includes('详细信息') && textOf(compatTree).includes('HTTP 404'));

  /* 真实 apply 的 Finder 三通道（等价旧测试） */
  const remoteCalls = [];
  const remote = { openWorkspacePath: async (req) => { remoteCalls.push(req); return { ok: true, value: { opened: true } }; } };
  const c2 = makeCtx(remote);
  mod.apply(c2.ctx);
  const actions2 = c2.captured.main().props.actions;
  const r1 = await actions2.openPath('/tmp/ws/research/x.md', 'reveal', 'file');
  check('通道①：有 remote.session 走 openWorkspacePath',
    r1.ok && r1.how === 'session-remote' && remoteCalls.length === 1
    && remoteCalls[0].action === 'reveal' && remoteCalls[0].path === '/tmp/ws/research/x.md',
    JSON.stringify({ r1, remoteCalls }));

  fetchCalls.length = 0;
  stub('POST', '/open-in-app/open', { ok: true });
  stub('POST', '/research-workbench/api/reveal', { ok: true, how: 'sessionController' });
  const c3 = makeCtx(undefined);
  mod.apply(c3.ctx);
  const actions3 = c3.captured.main().props.actions;
  const rDir = await actions3.openPath('/tmp/ws/research/素材A', 'open', 'dir');
  check('通道②：无 remote 时目录走 /open-in-app/open',
    rDir.ok && rDir.how === 'open-in-app'
    && fetchCalls[0].url === '/open-in-app/open'
    && fetchCalls[0].body.app === 'finder',
    JSON.stringify({ rDir, first: fetchCalls[0] }));
  fetchCalls.length = 0;
  const rFile = await actions3.openPath('/tmp/ws/research/x.md', 'reveal', 'file');
  check('通道③：文件回退到本插件宿主路由 /reveal',
    rFile.ok && rFile.how === 'sessionController'
    && fetchCalls.length === 1 && fetchCalls[0].url === '/research-workbench/api/reveal'
    && fetchCalls[0].body.mode === 'reveal',
    JSON.stringify({ rFile, urls: fetchCalls.map((c) => c.url) }));
}

/* ================= 场景七：FDE 路由可用但 board 读取失败 → 行内错误 + 重试 ================= */
{
  routeTable = {}; routeSeq = {}; fetchCalls.length = 0;
  stub('GET', '/research-workbench/api/fde/meta', { ok: true, meta: META });
  stub('GET', '/research-workbench/api/fde/board?view=board', { ok: false, reason: '看板数据读不了' });
  stub('GET', '/research-workbench/api/fde/brief', { ok: false, reason: '读不到' });
  instances.clear();
  const errTree = await renderStable(PanelApp, makeProps());
  check('看板读取失败时显示行内错误与重试（不白屏）',
    textOf(errTree).includes('没能读取看板') && textOf(errTree).includes('看板数据读不了') && btnByText(errTree, '重试').length >= 1);
}

/* ================= 收尾 ================= */
unmountAll();
await tick(10);

console.log('\n=== 通过 ' + ok.length + ' 项 ===');
if (fail.length) {
  console.log('=== 失败 ' + fail.length + ' 项 ===');
  fail.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('\n客户端准运行时测试全部通过。');
process.exit(0);
