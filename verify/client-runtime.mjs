/**
 * 客户端半「准运行时」测试（FDE 工作站）
 * 用法: node verify/client-runtime.mjs
 *
 * 用一个迷你 React（支持嵌套函数组件 + hooks + effect 清理）+ 替身
 * window/document/fetch，eval client.js 后真实渲染面板，走通：
 *  - FDE 九视图渲染（含流程 v2 与资料库）、今日注意力动作、建议采纳
 *  - 看板客户模式/任务模式、HTML5 拖拽、Alt+方向键、门禁缺项确认、证据确认
 *  - 客户/任务抽屉、门禁人工勾选与证据、启动会话、归档/删除确认
 *  - 客户导入（adopt scan/apply）、工件（Finder/导出）、方法、设置
 *  - 兼容页 + 经典模式五页签 + Finder 三通道降级
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
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} }, platform: 'MacIntel' },
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
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
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
/* 九视图导航按钮在 .fde-nav 内，文本可能带计数（如「客户2」） */
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
      outputs: ['board.json 客户记录（lead）'],
      tools: [
        { kind: 'skill', name: 'fde-engagement', label: 'fde-engagement 技能' },
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
        { kind: 'skill', name: 'fde-discovery', label: 'fde-discovery 技能' },
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
        { kind: 'skill', name: 'fde-meeting', label: 'fde-meeting 技能' },
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
        { kind: 'skill', name: 'fde-scoping', label: 'fde-scoping 技能' },
        { kind: 'method', name: '06-场景选择与数据体检.md', label: '场景选择与数据体检' },
        { kind: 'template', name: '场景评估表.md', label: '场景评估表' },
        { kind: 'tool', name: 'fde_scenario', label: '场景评估器' },
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
        { kind: 'skill', name: 'fde-solution', label: 'fde-solution 技能' },
        { kind: 'method', name: '07-成本评估与报价.md', label: '成本评估与报价' },
        { kind: 'template', name: '成本测算与报价单.md', label: '成本测算与报价单' },
        { kind: 'tool', name: 'fde_quote', label: '成本测算器' },
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
        { kind: 'skill', name: 'fde-pilot', label: 'fde-pilot 技能' },
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
        { kind: 'skill', name: 'fde-delivery', label: 'fde-delivery 技能' },
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
        { kind: 'skill', name: 'fde-adoption', label: 'fde-adoption 技能' },
        { kind: 'library', name: 'fde_library', label: '资料库：社区动态' },
      ],
      pitfalls: ['上线即结束，没人用', '没有 ROI 就无法扩展'],
    } },
  ],
  terminalStages: [{ key: 'archived', label: '归档' }, { key: 'lost', label: '流失' }],
  boardLanes: ['todo', 'doing', 'waiting', 'review', 'done'],
  lanes: [
    { key: 'inbox', label: '收集箱', board: false },
    { key: 'todo', label: '待办', board: true },
    { key: 'doing', label: '进行中', board: true, wip: true },
    { key: 'waiting', label: '等外部', board: true },
    { key: 'review', label: '待我审', board: true },
    { key: 'done', label: '已完成', board: true },
    { key: 'canceled', label: '已取消', board: false },
  ],
  itemTypes: [
    { key: 'research', label: '调研' }, { key: 'meeting', label: '会面' },
    { key: 'solution', label: '方案' }, { key: 'followup', label: '跟进' },
  ],
  priorities: [{ key: 'high', label: '高' }, { key: 'normal', label: '中' }, { key: 'low', label: '低' }],
  autonomyModes: [
    { key: 'observe', label: '只建议' }, { key: 'assisted', label: '建议 + 一键' }, { key: 'auto', label: '自动安全动作' },
  ],
  redLines: ['推进客户阶段', '通过门禁', '导出或发送对外材料'],
  gates: {
    lead: { key: 'intake', label: '线索门禁', stage: 'lead', auto: [{ key: 'company', label: '公司名' }, { key: 'source', label: '来源' }, { key: 'next_action', label: '下一步' }], manual: [] },
    discovery: {
      key: 'discovery', label: '研判门禁', stage: 'discovery',
      auto: [{ key: 'archive', label: '项目档案' }, { key: 'factcheck', label: '事实核查清单' }],
      manual: [{ key: 'subject_locked', label: '主体已锁定' }, { key: 'evidence_graded', label: '事实已分级' }],
    },
    meeting: { key: 'meeting', label: '会面门禁', stage: 'meeting', auto: [{ key: 'brief', label: '会面 Brief' }], manual: [{ key: 'meeting_goal', label: '会面目标已确认' }] },
    scoping: {
      key: 'scoping', label: '场景门禁', stage: 'scoping',
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
      key: 'solution', label: '方案门禁', stage: 'solution',
      auto: [{ key: 'proposal', label: '方案 md' }, { key: 'cost', label: '成本测算 md' }, { key: 'quote', label: '报价单/SOW md' }],
      manual: [{ key: 'solution_final', label: '方案已定稿可对外' }, { key: 'pricing_confirmed', label: '成本与报价已复核' }],
    },
    pilot: { key: 'pilot', label: '试点门禁', stage: 'pilot', auto: [{ key: 'pilot_doc', label: '试点方案' }], manual: [{ key: 'pilot_scope', label: '范围与指标客户确认' }] },
    delivery: { key: 'delivery', label: '交付门禁', stage: 'delivery', auto: [{ key: 'delivery_doc', label: '交付文档' }], manual: [{ key: 'acceptance', label: '验收清单' }] },
    adoption: { key: 'adoption', label: '采用门禁', stage: 'adoption', auto: [{ key: 'adoption_doc', label: '使用证据' }], manual: [{ key: 'training', label: '培训完成' }] },
  },
  attentionKinds: [
    { key: 'blocked', label: '受阻' }, { key: 'decision', label: '需要决定' }, { key: 'review', label: '待审阅' },
    { key: 'answer', label: '待回答' }, { key: 'overdue', label: '逾期' }, { key: 'gate', label: '门禁待确认' },
    { key: 'stall', label: '停滞' }, { key: 'proposal', label: '建议' },
  ],
  rules: [{ ruleId: 'stall', label: '停滞', detail: '停滞跟进' }, { ruleId: 'overdue', label: '已逾期', detail: '逾期提醒' }],
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
    proposals: [{
      id: 'prp_aaaaaa', ruleId: 'stall', engagementId: 'eng_aaaaaa', itemId: '', kind: 'nudge',
      title: '某环境已停滞 16 天', detail: '建议：安排一次跟进，或标记暂停', payload: {},
      status: 'pending', createdAt: '2026-11-03T05:00:00.000Z',
    }],
    activity: [{ at: '2026-11-03T05:00:00.000Z', kind: 'created', text: '导入 2 个客户', engagementId: '', itemId: '' }],
  };
}

function makeBrief(board) {
  return {
    generatedAt: '2026-11-03T06:00:00.000Z',
    headline: '今天先补 KPI 假设',
    attention: [
      { kind: 'blocked', rank: 1, title: '受阻：KPI 数据拿不到', engagementId: 'eng_aaaaaa', engagementName: '某环境集团', itemId: 'itm_aaaaaa', days: 3, target: 'item', actions: ['open', 'resolve'] },
      { kind: 'review', rank: 3, title: '待审阅：写会面 Brief', engagementId: 'eng_bbbbbb', engagementName: '某所', itemId: 'itm_cccccc', target: 'item', actions: ['pass', 'return'] },
      { kind: 'overdue', rank: 5, text: '逾期 2 天：补 KPI 假设第三段', engagementId: 'eng_aaaaaa', engagementName: '某环境集团', due: '2026-11-01', target: 'engagement', actions: ['reschedule', 'done'] },
      { kind: 'proposal', rank: 8, title: '某环境已停滞 16 天', engagementName: '某环境集团', id: 'prp_aaaaaa', proposalId: 'prp_aaaaaa', target: 'proposal', actions: ['accept', 'dismiss'] },
    ],
    proposals: board.proposals,
    focus: [{ engagementId: 'eng_aaaaaa', name: '某环境集团', stage: 'discovery', nextAction: board.engagements[0].nextAction }],
    activity: board.activity,
    stats: { active: 2, attention: 4, dueToday: 1, overdue: 1 },
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
  stub('GET', '/research-workbench/api/fde/health', { ok: true, checks: [{ name: 'board', status: 'ok', detail: '可读' }, { name: 'backup', status: 'warn', detail: '尚无备份' }] });
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

/* ================= 场景一：FDE 今日 ================= */
let tree = await renderStable(PanelApp, makeProps());
if (process.env.DBG) {
  console.log('DBG buttons:', buttons(tree).map((b) => textOf(b).trim()).slice(0, 40));
  console.log('DBG text:', textOf(tree).slice(0, 1200));
}
check('面板标题为 FDE 工作站', textOf(tree).includes('FDE 工作站'));
check('今日页渲染问候与战况', textOf(tree).includes('活跃客户'));
check('九视图页签齐全（含流程与资料库，无生财）',
  ['今日', '看板', '客户', '流程', '资料库', '招采', '工件', '方法', '设置'].every((x) => textOf(tree).includes(x))
  && !textOf(tree).includes('生财'));
check('导航顺序：客户 → 流程 → 资料库 → 招采', (() => {
  const nav = byClass(tree, 'fde-nav')[0];
  if (!nav) return false;
  const labels = buttons({ children: [nav] }).map((b) => textOf(b).trim());
  const idx = (k) => labels.findIndex((x) => x.indexOf(k) === 0);
  return idx('客户') < idx('流程') && idx('流程') < idx('资料库') && idx('资料库') < idx('招采');
})());
check('注意力列表渲染（受阻/待审/逾期/建议）',
  textOf(tree).includes('受阻') && textOf(tree).includes('受阻：KPI 数据拿不到')
  && textOf(tree).includes('逾期 2 天') && textOf(tree).includes('待审阅：写会面 Brief'));
check('注意力动作按宿主语义 key 翻译为中文按钮',
  btnExact(tree, '解决').length >= 1 && btnExact(tree, '打开').length >= 1
  && btnExact(tree, '通过').length >= 1 && btnExact(tree, '退回').length >= 1
  && btnExact(tree, '改期').length >= 1 && btnExact(tree, '完成').length >= 1,
  buttons(tree).map((b) => textOf(b).trim()).filter(Boolean).slice(0, 24).join('|'));
check('建议列表渲染并可采纳', textOf(tree).includes('某环境已停滞 16 天') && btnExact(tree, '采纳').length >= 1);
check('今日焦点与最近活动渲染', textOf(tree).includes('今日焦点') && textOf(tree).includes('最近活动') && textOf(tree).includes('导入 2 个客户'));
check('轮询只注册一个定时器且间隔 12s',
  intervalRecords.length === 1 && intervalRecords[0].ms === 12000, JSON.stringify(intervalRecords.map((x) => x.ms)));
check('今日页只轮询 brief（首屏有 /fde/brief 请求）',
  callsOf('GET', '/fde/brief').length >= 1);

/* 注意力动作：解决（弹层后确认） */
const resolveBtn = btnExact(tree, '解决')[0];
check('注意力行有「解决」动作', !!resolveBtn);
const beforeResolve = callsOf('POST', '/fde/attention').length;
if (resolveBtn) {
  tree = await act(PanelApp, makeProps(), () => resolveBtn.props.onClick());
  check('解决注意力 → POST /fde/attention resolve',
    callsOf('POST', '/fde/attention').length > beforeResolve
    && lastCall('POST', '/fde/attention').body.action === 'resolve',
    JSON.stringify(lastCall('POST', '/fde/attention')));
}
/* 采纳建议 */
const acceptBtn = btnExact(tree, '采纳')[0];
const beforeAccept = callsOf('POST', '/fde/proposal').length;
if (acceptBtn) {
  tree = await act(PanelApp, makeProps(), () => acceptBtn.props.onClick());
  check('采纳建议 → POST /fde/proposal accept',
    callsOf('POST', '/fde/proposal').length > beforeAccept
    && lastCall('POST', '/fde/proposal').body.action === 'accept');
}

/* ================= 场景二：看板（客户模式）+ 拖拽 + 键盘 ================= */
const boardTab = navBtn(tree, '看板');
check('可切换到看板视图', !!boardTab);
check('点击「看板」页签可导航', !!boardTab);
tree = await act(PanelApp, makeProps(), () => boardTab.props.onClick());
const colNodes = byClass(tree, 'fde-col');
check('客户模式 8 列（含空列，来自 meta.stages）', colNodes.length === 8, '列数 ' + colNodes.length);
check('8 列阶段名含 v1.3 新增「场景」', textOf(tree).includes('场景'));
check('列头显示阶段名与数量', textOf(tree).includes('线索') && textOf(tree).includes('研判') && textOf(tree).includes('采用'));
check('客户卡片渲染名称/下一步', textOf(tree).includes('某环境集团') && textOf(tree).includes('补 KPI 假设第三段'));
check('卡片工件数读取 eng.artifacts（host 摘要）', textOf(tree).includes('工 8'));
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
  check('门禁未过：弹层显示缺项', textOf(tree).includes('门禁未通过') && textOf(tree).includes('范围与指标客户确认'));
  if (process.env.DBG) console.log('DBG dialog buttons:', buttons(tree).map((b) => textOf(b).trim()).slice(0, 20), 'inputs:', byType(tree, 'input').map((n) => n.props.placeholder || n.props['aria-label']));
  const forceBtn = btnExact(tree, '强制推进（填写理由）')[0];
  check('弹层提供「强制推进」并需二次确认', !!forceBtn);
  if (forceBtn) {
    tree = await act(PanelApp, makeProps(), () => forceBtn.props.onClick());
    const reasonInput = inputByAria(tree, '强制理由')[1] || inputByAria(tree, '强制理由')[0];
    check('强制推进弹出理由输入（必填）', !!reasonInput);
    if (reasonInput) {
      tree = await act(PanelApp, makeProps(), () => reasonInput.props.onChange(evt({ target: { value: '客户口头确认，先推进' } })));
      const confirmForce = btnExact(tree, '确认强制推进')[0];
      if (confirmForce) tree = await act(PanelApp, makeProps(), () => confirmForce.props.onClick());
      const forced = lastCall('POST', '/fde/engagement');
      check('强制推进提交 force+reason',
        !!forced && forced.body.patch.force === true && /口头确认/.test(String(forced.body.patch.reason)),
        JSON.stringify(forced && forced.body));
    }
  }
}
/* 恢复后端正常响应 */
stub('POST', '/research-workbench/api/fde/engagement', () => ({ ok: true, engagement: BOARD.engagements[0] }));

/* 任务模式：5 列 + 拖拽到 done 需证据 */
const taskSeg = btnExact(tree, '任务')[0];
check('看板可切换到任务模式', !!taskSeg);
if (taskSeg) {
  tree = await act(PanelApp, makeProps(), () => taskSeg.props.onClick());
  const taskCols = byClass(tree, 'fde-col');
  check('任务模式 5 列（meta.boardLanes）', taskCols.length === 5, '列数 ' + taskCols.length);
  check('任务卡片渲染标题/泳道', textOf(tree).includes('补齐 KPI 假设'));

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
    check('任务移入 done 前要求证据（弹层）', textOf(tree).includes('移入「已完成」需要证据'));
    const evidenceInput = byType(tree, 'textarea')[0];
    if (evidenceInput) {
      tree = await act(PanelApp, makeProps(), () => evidenceInput.props.onChange(evt({ target: { value: '已完成，产物 research/KPI与痛点假设.md' } })));
      const moveWithEvidence = btnExact(tree, '带证据移动')[0];
      if (moveWithEvidence) tree = await act(PanelApp, makeProps(), () => moveWithEvidence.props.onClick());
      const evCall = lastCall('POST', '/fde/item');
      check('带证据移动提交 evidence + force',
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
check('客户表格渲染行与下一步', textOf(tree).includes('某环境集团') && textOf(tree).includes('补 KPI 假设第三段'));
const customerRow = collect(tree, (n) => n.type === 'tr' && String(textOf(n)).indexOf('某环境集团') !== -1)[0];
check('客户行可点击打开抽屉', !!customerRow);
if (customerRow) {
  tree = await act(PanelApp, makeProps(), () => { if (customerRow.props.onClick) customerRow.props.onClick(); else customerRow.props.onKeyDown(evt({ key: 'Enter' })); });
}
check('客户抽屉渲染（阶段/门禁/下一步/干系人/时间线）',
  textOf(tree).includes('门禁清单') && textOf(tree).includes('下一步') && textOf(tree).includes('干系人')
  && textOf(tree).includes('时间线') && textOf(tree).includes('启动会话'));
check('抽屉 role=dialog + aria-modal',
  collect(tree, (n) => n.props && n.props.role === 'dialog' && n.props['aria-modal'] === 'true').length >= 1);
check('抽屉打开时评估门禁 → POST /fde/gate',
  callsOf('POST', '/fde/gate').length >= 1,
  JSON.stringify(callsOf('POST', '/fde/gate').slice(-1)));
const gateEvalCall = lastCall('POST', '/fde/gate');
check('门禁评估请求用阶段 key（宿主契约：gateState[stageKey]）',
  !!gateEvalCall && gateEvalCall.body.engagementId === 'eng_aaaaaa'
  && META.stages.some((x) => x.key === gateEvalCall.body.stage),
  JSON.stringify(gateEvalCall && gateEvalCall.body));

/* 门禁人工勾选 + 证据保存 */
const manualCheckbox = byType(tree, 'input').filter((n) => n.props.type === 'checkbox'
  && ['事实已分级', '会面目标已确认', '主体已锁定', '方案已定稿可对外', '范围与指标客户确认', '验收清单']
    .some((k) => String(n.props['aria-label'] || '').indexOf(k) !== -1))[0];
check('门禁人工项有勾选框', !!manualCheckbox);
if (manualCheckbox) {
  tree = await act(PanelApp, makeProps(), () => manualCheckbox.props.onChange(evt({ target: { checked: true } })));
  const evidenceInputs = byType(tree, 'input').filter((n) => String(n.props.placeholder || '').indexOf('证据') !== -1);
  check('门禁人工项有证据输入框', evidenceInputs.length >= 1);
  if (evidenceInputs[0]) {
    tree = await act(PanelApp, makeProps(), () => evidenceInputs[0].props.onChange(evt({ target: { value: 'A 级证据 2 条，B 级 3 条' } })));
    const saveGateBtn = btnExact(tree, '保存人工确认')[0];
    if (saveGateBtn) tree = await act(PanelApp, makeProps(), () => saveGateBtn.props.onClick());
    const gateCall = lastCall('POST', '/fde/gate');
    const savedChecks = (gateCall && gateCall.body && gateCall.body.checks) || {};
    const savedKey = Object.keys(savedChecks)[0];
    check('保存人工确认 → checks.<key>.status=pass + 证据',
      !!savedKey && savedChecks[savedKey].status === 'pass' && /A 级证据/.test(String(savedChecks[savedKey].evidence)),
      JSON.stringify(gateCall && gateCall.body));
  }
}

/* 启动会话 */
const handoffBtn = btnExact(tree, '启动会话')[0];
if (handoffBtn) {
  tree = await act(PanelApp, makeProps(), () => handoffBtn.props.onClick());
  const ho = lastCall('POST', '/fde/handoff');
  check('启动会话 → POST /fde/handoff + openSession',
    !!ho && ho.body.target === 'engagement' && ho.body.id === 'eng_aaaaaa' && sessionOpened.indexOf('sess_new_1') !== -1,
    JSON.stringify(ho && ho.body));
}

/* 归档：二次确认 */
const archiveBtn = btnExact(tree, '归档')[0];
if (archiveBtn) {
  tree = await act(PanelApp, makeProps(), () => archiveBtn.props.onClick());
  check('归档弹二次确认（说明不删目录）', textOf(tree).includes('不删除目录与文件'));
  const confirmArchive = btnExact(tree, '归档').filter((b) => textOf(b).trim() === '归档').pop();
  if (confirmArchive) tree = await act(PanelApp, makeProps(), () => confirmArchive.props.onClick());
  const archCall = lastCall('POST', '/fde/engagement');
  check('确认归档 → POST engagement archive', !!archCall && archCall.body.action === 'archive', JSON.stringify(archCall && archCall.body));
}

/* ================= 场景三·续：任务抽屉（编辑/回报/删除） ================= */
{
  const boardNav = navBtn(tree, '看板');
  tree = await act(PanelApp, makeProps(), () => boardNav.props.onClick());
  const taskSeg2 = btnExact(tree, '任务')[0];
  tree = await act(PanelApp, makeProps(), () => taskSeg2.props.onClick());
  const taskCard2 = collect(tree, (n) => n.props && n.props.draggable === 'true' && String(n.props['aria-label'] || '').indexOf('补公司年报摘要') !== -1)[0];
  check('任务卡片可打开抽屉', !!taskCard2);
  if (taskCard2) {
    tree = await act(PanelApp, makeProps(), () => taskCard2.props.onClick());
    check('任务抽屉渲染（回报历史/关联会话/删除）',
      textOf(tree).includes('回报历史') && textOf(tree).includes('关联会话') && btnByText(tree, '删除任务').length >= 1);

    /* 编辑标题：update 不得带 stage（宿主会拒绝） */
    const titleInput = byType(tree, 'input').filter((n) => n.props.value === '补公司年报摘要')[0];
    check('任务抽屉可编辑标题', !!titleInput);
    if (titleInput) {
      tree = await act(PanelApp, makeProps(), () => titleInput.props.onChange(evt({ target: { value: '补公司年报摘要（复核）' } })));
      const saveItemBtn = btnByText(tree, '保存任务')[0];
      if (saveItemBtn) tree = await act(PanelApp, makeProps(), () => saveItemBtn.props.onClick());
      const upd = lastCall('POST', '/fde/item');
      check('保存任务 → update 且 patch 不含 stage（宿主契约）',
        !!upd && upd.body.action === 'update' && upd.body.patch.title === '补公司年报摘要（复核）'
        && !Object.prototype.hasOwnProperty.call(upd.body.patch, 'stage'),
        JSON.stringify(upd && upd.body));
    }

    /* 人工回报 */
    const kindSel = byType(tree, 'select').filter((n) => String(n.props['aria-label'] || '').indexOf('回报类型') !== -1)[0];
    if (kindSel) tree = await act(PanelApp, makeProps(), () => kindSel.props.onChange(evt({ target: { value: 'ready' } })));
    const reportArea = byType(tree, 'textarea').filter((n) => String(n.props['aria-label'] || '').indexOf('回报内容') !== -1)[0];
    check('任务抽屉有回报输入', !!reportArea);
    if (reportArea) {
      tree = await act(PanelApp, makeProps(), () => reportArea.props.onChange(evt({ target: { value: '摘要已补，产物 research/年报摘要.md' } })));
      const submitReport = btnByText(tree, '提交回报')[0];
      if (submitReport) tree = await act(PanelApp, makeProps(), () => submitReport.props.onClick());
      const rep = lastCall('POST', '/fde/item');
      check('提交回报 → action=report kind=ready',
        !!rep && rep.body.action === 'report' && rep.body.kind === 'ready' && /年报摘要/.test(String(rep.body.text)),
        JSON.stringify(rep && rep.body));
    }

    /* 删除：二次确认 */
    const delBtn = btnByText(tree, '删除任务')[0];
    if (delBtn) tree = await act(PanelApp, makeProps(), () => delBtn.props.onClick());
    check('删除任务弹二次确认（只改看板状态）', textOf(tree).includes('只改看板状态'));
    const confirmDel = btnByText(tree, '删除任务').pop();
    if (confirmDel) tree = await act(PanelApp, makeProps(), () => confirmDel.props.onClick());
    const delCall = lastCall('POST', '/fde/item');
    check('确认删除 → action=delete', !!delCall && delCall.body.action === 'delete', JSON.stringify(delCall && delCall.body));
  }
}

/* ================= 场景四：客户导入（adopt 两段式） ================= */
const adoptBtn = btnExact(tree, '导入现有项目')[0] || btnByText(tree, '导入现有项目')[0];
if (adoptBtn) {
  tree = await act(PanelApp, makeProps(), () => adoptBtn.props.onClick());
  check('扫描候选 → POST /fde/adopt scan', callsOf('POST', '/fde/adopt').some((c) => c.body.action === 'scan'));
  check('候选列表渲染并识别已在看板', textOf(tree).includes('legacy-project') && textOf(tree).includes('已在看板'));
  const candCheckbox = byType(tree, 'input').filter((n) => n.props.type === 'checkbox' && String(n.props['aria-label'] || '').indexOf('legacy-project') !== -1)[0];
  const knownCand = byType(tree, 'input').filter((n) => n.props.type === 'checkbox' && String(n.props['aria-label'] || '').indexOf('某环境集团') !== -1)[0];
  check('候选可勾选（未导入的）', !!candCheckbox && candCheckbox.props.disabled === false);
  check('已在看板的候选禁止重复导入', !!knownCand && knownCand.props.disabled === true);
  if (candCheckbox) {
    tree = await act(PanelApp, makeProps(), () => candCheckbox.props.onChange(evt({ target: { checked: true } })));
    const applyBtn = btnByText(tree, '导入选中')[0];
    if (applyBtn) tree = await act(PanelApp, makeProps(), () => applyBtn.props.onClick());
    const applyCall = callsOf('POST', '/fde/adopt').filter((c) => c.body.action === 'apply').pop();
    check('确认导入 → POST /fde/adopt apply dirs 含 legacy-project',
      !!applyCall && Array.isArray(applyCall.body.dirs) && applyCall.body.dirs.indexOf('legacy-project') !== -1,
      JSON.stringify(applyCall && applyCall.body));
  }
}

/* ================= 场景五：工件 / 方法 / 设置 ================= */
const artTab = navBtn(tree, '工件');
check('点击「工件」页签可导航', !!artTab);
tree = await act(PanelApp, makeProps(), () => artTab.props.onClick());
check('工件页按客户聚合（可展开）', textOf(tree).includes('某环境集团'));
const accHead = collect(tree, (n) => n.props && String(n.props.className || '').indexOf('fde-acc-head') !== -1)[0];
if (accHead) tree = await act(PanelApp, makeProps(), () => accHead.props.onClick());
check('展开客户工件 → GET /files?dir= 并渲染 md 行',
  callsOf('GET', '/files?dir=').length >= 1 && textOf(tree).includes('research/事实核查清单.md'));
check('工件行有导出 PDF / Finder 显示', btnByText(tree, '导出 PDF').length >= 1 && btnByText(tree, 'Finder 显示').length >= 1);
const exportBtn = btnByText(tree, '导出 PDF')[0];
if (exportBtn) {
  tree = await act(PanelApp, makeProps(), () => exportBtn.props.onClick());
  const expCall = lastCall('POST', '/research-workbench/api/handoff');
  check('导出 PDF 复用旧 /handoff action=export',
    !!expCall && expCall.body.action === 'export' && expCall.body.dir === '某环境-20261013',
    JSON.stringify(expCall && expCall.body));
}

const methodsTab = navBtn(tree, '方法');
check('点击「方法」页签可导航', !!methodsTab);
tree = await act(PanelApp, makeProps(), () => methodsTab.props.onClick());
check('方法页列出旧方法文件与 FDE 技能',
  textOf(tree).includes('00-调研执行流程') && textOf(tree).includes('fde-engagement'));
const methodEntry = btnByText(tree, '00-调研执行流程')[0];
if (methodEntry) {
  tree = await act(PanelApp, makeProps(), () => methodEntry.props.onClick());
  check('点开即读方法正文', textOf(tree).includes('调研执行流程'));
}

const settingsTab = navBtn(tree, '设置');
check('点击「设置」页签可导航', !!settingsTab);
tree = await act(PanelApp, makeProps(), () => settingsTab.props.onClick());
check('设置页渲染自主性/停滞/WIP/重启提示',
  textOf(tree).includes('自主性') && textOf(tree).includes('停滞天数') && textOf(tree).includes('WIP') && textOf(tree).includes('重启'));
check('设置页显示招采索引状态（board 顶层 bidStats 合并）',
  textOf(tree).includes('招采索引') && textOf(tree).includes('24156') && textOf(tree).includes('2018-05-03'));
const healthBtn = btnByText(tree, '运行健康检查')[0];
if (healthBtn) {
  tree = await act(PanelApp, makeProps(), () => healthBtn.props.onClick());
  check('健康检查 GET /fde/health 并渲染逐项状态',
    callsOf('GET', '/fde/health').length === 1 && textOf(tree).includes('board') && textOf(tree).includes('通过'));
}
const saveSettingsBtn = btnByText(tree, '保存设置')[0];
if (saveSettingsBtn) {
  tree = await act(PanelApp, makeProps(), () => saveSettingsBtn.props.onClick());
  const setCall = lastCall('POST', '/fde/settings');
  check('保存设置 → POST /fde/settings patch',
    !!setCall && setCall.body.patch && typeof setCall.body.patch.autonomy === 'string');
}

/* ================= 场景五·续：招采雷达（v1.1）看板徽章 / 招采页 / 抽屉 / 降级 ================= */
{
  /* 重置看板与招采可用性，避免前面场景（归档/删除）影响 */
  currentBoard = makeBoard();
  CURRENT_BRIEF = makeBrief(currentBoard);
  bidsAvailableFlag = true;

  /* 看板卡片徽章：available && total>0 才显示 */
  const boardNav2 = navBtn(tree, '看板');
  tree = await act(PanelApp, makeProps(), () => boardNav2.props.onClick());
  const customerModeBtn = btnExact(tree, '客户')[0];
  if (customerModeBtn) tree = await act(PanelApp, makeProps(), () => customerModeBtn.props.onClick());
  check('看板客户卡片显示「招采 N」徽章（数字为采样 total）', textOf(tree).includes('招采 3'));
  check('available:false 的客户不显示徽章（即使 total>0）', !textOf(tree).includes('招采 5'));
  const bidBadge = collect(tree, (n) => n.props && String(n.props.title || '').indexOf('招采匹配') === 0)[0];
  check('看板卡片徽章 tooltip 含量级「≈53（采样 3 条）」',
    !!bidBadge && /≈53（采样 3 条）/.test(String(bidBadge.props.title)),
    bidBadge && bidBadge.props.title);

  /* 招采页签：概况 + 结果列表 */
  const bidsNav = navBtn(tree, '招采');
  check('导航含「招采」页签', !!bidsNav);
  tree = await act(PanelApp, makeProps(), () => bidsNav.props.onClick());
  check('招采概况渲染（条数/区间/来源）',
    textOf(tree).includes('24156') && textOf(tree).includes('2018-05-03') && textOf(tree).includes('aecc-ebidding'));
  check('招采检索自动加载结果列表（标题/关系徽章）',
    textOf(tree).includes('某水厂自控系统中标公告')
    && textOf(tree).includes('中标') && textOf(tree).includes('招标') && textOf(tree).includes('候选'));
  check('招采页显示按客户匹配概览', textOf(tree).includes('按客户匹配') && textOf(tree).includes('招采 3'));
  check('招采页显示导入链接（bid-intel 探测可用）', textOf(tree).includes('导入公告链接'));
  check('首查走 /fde/bids/search', callsOf('GET', '/fde/bids/search').length >= 1);

  /* 展开结果：正文摘录 + 候选人名次 + 原文链接 */
  const expandBtn = btnExact(tree, '展开')[0];
  check('结果可展开正文与候选人', !!expandBtn);
  if (expandBtn) {
    tree = await act(PanelApp, makeProps(), () => expandBtn.props.onClick());
    const anchors = collect(tree, (n) => n.type === 'a' && n.props && String(n.props.href || '').indexOf('example.com/bid') !== -1);
    check('展开显示正文摘录与候选人口径提示',
      textOf(tree).includes('发布时间：2026-04-28') && textOf(tree).includes('候选人 ≠ 中标人') && textOf(tree).includes('第 1 名'));
    check('原文链接新窗口 + rel=noreferrer',
      anchors.length >= 1 && anchors[0].props.target === '_blank' && /noreferrer/.test(String(anchors[0].props.rel)),
      JSON.stringify(anchors.slice(0, 2).map((a) => a.props)));
    check('金额展示公告原文（不换算）', textOf(tree).includes('100万元'));
  }

  /* 检索交互 */
  const searchInput = inputByAria(tree, '搜索公司 / 采购单位 / 标题 / 全文…')[0];
  check('招采检索输入框存在', !!searchInput);
  if (searchInput) {
    tree = await act(PanelApp, makeProps(), () => searchInput.props.onChange(evt({ target: { value: '某环境' } })));
    const submit = btnExact(tree, '检索')[0];
    if (submit) tree = await act(PanelApp, makeProps(), () => submit.props.onClick());
    const sCall = callsOf('GET', '/fde/bids/search').pop();
    check('检索提交 q/mode 参数', !!sCall && /q=%E6%9F%90%E7%8E%AF%E5%A2%83/.test(sCall.url) && /mode=any/.test(sCall.url),
      sCall && sCall.url);
  }

  /* 导入链接（探测可用时） */
  const importInput = inputByAria(tree, '公告原文链接')[0];
  check('导入链接输入框存在', !!importInput);
  if (importInput) {
    tree = await act(PanelApp, makeProps(), () => importInput.props.onChange(evt({ target: { value: 'https://example.com/new-bid' } })));
    const importBtn = btnExact(tree, '导入')[0];
    if (importBtn) tree = await act(PanelApp, makeProps(), () => importBtn.props.onClick());
    const imp = lastCall('POST', '/bidintel/api/import-url');
    check('导入链接 POST /bidintel/api/import-url 并回显成功',
      !!imp && imp.body.url === 'https://example.com/new-bid' && textOf(tree).includes('已导入'));
  }

  /* 客户抽屉招采区 */
  const overviewRow = buttons(tree).filter((b) => textOf(b).includes('某环境集团') && textOf(b).includes('招采 3'))[0];
  check('按客户匹配行可打开客户抽屉', !!overviewRow);
  if (overviewRow) tree = await act(PanelApp, makeProps(), () => overviewRow.props.onClick());
  check('抽屉招采区渲染（统计徽章/匹配 Top5/已关联）',
    textOf(tree).includes('招采雷达') && textOf(tree).includes('相关 ≈1603（采样 3 条）') && textOf(tree).includes('招标 2')
    && textOf(tree).includes('中标 1') && textOf(tree).includes('候选 1')
    && textOf(tree).includes('匹配公告 Top5') && textOf(tree).includes('已关联公告') && textOf(tree).includes('备注：跟进中'));
  const drawerNode = byClass(tree, 'fde-drawer')[0];
  const drawerAnchorText = drawerNode ? collect(drawerNode, (n) => n.type === 'a').map((a) => textOf(a)).join('|') : '';
  check('抽屉匹配行有加入跟进/关联/查看原文/取消关联',
    btnExact(tree, '加入跟进').length >= 1 && btnExact(tree, '关联').length >= 1
    && btnExact(tree, '取消关联').length >= 1 && drawerAnchorText.indexOf('查看原文') !== -1);
  const watchBox = byType(tree, 'input').filter((n) => n.props.type === 'checkbox' && String(n.props['aria-label'] || '').indexOf('招采雷达') !== -1)[0];
  check('抽屉有 bidWatch 开关（默认开）', !!watchBox && watchBox.props.checked === true);
  if (watchBox) {
    tree = await act(PanelApp, makeProps(), () => watchBox.props.onChange(evt({ target: { checked: false } })));
    const wc = lastCall('POST', '/fde/engagement');
    check('关闭 bidWatch → POST engagement update patch.bidWatch.enabled=false',
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
  const promoteBtn = btnExact(tree, '加入跟进')[0];
  if (promoteBtn) {
    tree = await act(PanelApp, makeProps(), () => promoteBtn.props.onClick());
    const pc = lastCall('POST', '/fde/bids/promote');
    check('加入跟进 → POST /fde/bids/promote 并提示已建任务',
      !!pc && pc.body.bidId === 'aecc-ebidding:x1' && textOf(tree).includes('已创建跟进任务'));
  }
  const unlinkBtn = btnExact(tree, '取消关联')[0];
  if (unlinkBtn) {
    tree = await act(PanelApp, makeProps(), () => unlinkBtn.props.onClick());
    const uc = lastCall('POST', '/fde/bids/unlink');
    check('取消关联 → POST /fde/bids/unlink（bidId）',
      !!uc && uc.body.engagementId === 'eng_aaaaaa' && uc.body.bidId === 'aecc-ebidding:x2', JSON.stringify(uc && uc.body));
  }
  const drawerNow = byClass(tree, 'fde-drawer')[0] || tree;
  const bidRefreshBtn = buttons(drawerNow).filter((b) => textOf(b).trim() === '刷新招采')[0];
  if (bidRefreshBtn) {
    tree = await act(PanelApp, makeProps(), () => bidRefreshBtn.props.onClick());
    const rc = lastCall('POST', '/fde/bids/refresh');
    check('刷新 → POST /fde/bids/refresh（engagementId）', !!rc && rc.body.engagementId === 'eng_aaaaaa');
  }
  const closeBtn = byAria(tree, '关闭抽屉')[0];
  if (closeBtn) tree = await act(PanelApp, makeProps(), () => closeBtn.props.onClick());
  check('抽屉关闭后回到页面', !byClass(tree, 'fde-drawer').length);

  /* 服务不可用降级：available:false 显示未就绪，不白屏不报错 */
  bidsAvailableFlag = false;
  const settingsNav2 = navBtn(tree, '设置');
  tree = await act(PanelApp, makeProps(), () => settingsNav2.props.onClick());
  const bidsNav2 = navBtn(tree, '招采');
  tree = await act(PanelApp, makeProps(), () => bidsNav2.props.onClick());
  check('available:false → 显示「招采雷达未就绪」且不白屏',
    textOf(tree).includes('招采雷达未就绪（bid-intel 未装载或未升级）') && textOf(tree).includes('重试')
    && textOf(tree).includes('按客户匹配'));
  check('available:false → 检索区降级为未就绪提示（不报错）',
    textOf(tree).indexOf('没有命中记录') === -1);
  bidsAvailableFlag = true;
}

/* ================= 场景五·续2：流程 v2（v1.3，spec §20.5） ================= */
{
  const processNav = navBtn(tree, '流程');
  check('第 4 页签「流程」在导航中（客户之后、资料库之前）', !!processNav);
  if (processNav) tree = await act(PanelApp, makeProps(), () => processNav.props.onClick());

  const stepByLabel = (label) => byClass(tree, 'fde-flow-step').filter((b) => textOf(b).includes(label))[0];
  check('流程步进条渲染 8 个阶段（来自 meta.stages）',
    byClass(tree, 'fde-flow-step').length === 8, '阶段数 ' + byClass(tree, 'fde-flow-step').length);
  check('8 个阶段名齐全（含 v1.3 新增「场景」）',
    ['线索', '研判', '会面', '场景', '方案', '试点', '交付', '采用'].every((x) => textOf(tree).includes(x)));
  check('步进条显示当前客户数与门禁状态点',
    textOf(tree).includes('1 个客户') && byClass(tree, 'fde-flow-gate-dot').length === 8);

  const scopingStep = stepByLabel('场景');
  check('可点击切换阶段详情', !!scopingStep);
  if (scopingStep) tree = await act(PanelApp, makeProps(), () => scopingStep.props.onClick());
  check('阶段详情渲染目标/输入/动作/交付物/常见坑',
    textOf(tree).includes('把需求池收敛到可启动场景')
    && textOf(tree).includes('阶段目标') && textOf(tree).includes('输入')
    && textOf(tree).includes('关键动作') && textOf(tree).includes('交付物') && textOf(tree).includes('常见坑'));
  check('阶段详情渲染门禁清单（auto + manual）',
    textOf(tree).includes('自动检查') && textOf(tree).includes('人工确认')
    && textOf(tree).includes('有姓名的业务发起人') && textOf(tree).includes('场景评估表'));

  /* method chip → 方法页直达打开文件 */
  const methodChip = buttons(tree).filter((b) => textOf(b).trim() === '场景选择与数据体检')[0];
  check('工具 chips 含 method（场景选择与数据体检）', !!methodChip);
  if (methodChip) tree = await act(PanelApp, makeProps(), () => methodChip.props.onClick());
  check('method chip → 跳「方法」页并直接打开该文件',
    callsOf('GET', '/methods?name=06-').length >= 1
    && textOf(tree).includes('场景选择与数据体检') && textOf(tree).includes('四条硬门槛'));

  /* template chip → 方法页打开模板 */
  const processNav2 = navBtn(tree, '流程');
  if (processNav2) tree = await act(PanelApp, makeProps(), () => processNav2.props.onClick());
  const scopingStep2 = stepByLabel('场景');
  if (scopingStep2) tree = await act(PanelApp, makeProps(), () => scopingStep2.props.onClick());
  const tplChip = buttons(tree).filter((b) => textOf(b).trim() === '场景评估表')[0];
  check('工具 chips 含 template（场景评估表）', !!tplChip);
  if (tplChip) tree = await act(PanelApp, makeProps(), () => tplChip.props.onClick());
  check('template chip → 跳「方法」页并直接打开模板',
    callsOf('GET', '/methods?name=%E5%9C%BA%E6%99%AF%E8%AF%84%E4%BC%B0%E8%A1%A8').length >= 1
    && textOf(tree).includes('模板：场景'));

  /* skill chip → 展开「在会话中这样用」+ 复制 */
  const processNav3 = navBtn(tree, '流程');
  if (processNav3) tree = await act(PanelApp, makeProps(), () => processNav3.props.onClick());
  const scopingStep3 = stepByLabel('场景');
  if (scopingStep3) tree = await act(PanelApp, makeProps(), () => scopingStep3.props.onClick());
  const skillChip = buttons(tree).filter((b) => textOf(b).trim() === 'fde-scoping 技能')[0];
  check('工具 chips 含 skill（fde-scoping）', !!skillChip);
  if (skillChip) tree = await act(PanelApp, makeProps(), () => skillChip.props.onClick());
  check('skill chip 展开「在会话中这样用」示例',
    textOf(tree).includes('在会话中这样用') && textOf(tree).includes('请加载技能')
    && textOf(tree).includes('fde-scoping'));
  const copyBtn = btnExact(tree, '复制')[0];
  check('示例提供复制按钮', !!copyBtn);
  if (copyBtn) tree = await act(PanelApp, makeProps(), () => copyBtn.props.onClick());
  check('复制后按钮反馈「已复制」', textOf(tree).includes('已复制'));

  /* tool chip → 展开示例 */
  const toolChip = buttons(tree).filter((b) => textOf(b).trim() === '场景评估器')[0];
  check('工具 chips 含 tool（场景评估器）', !!toolChip);
  if (toolChip) tree = await act(PanelApp, makeProps(), () => toolChip.props.onClick());
  check('tool chip 展开「请调用工具」示例',
    textOf(tree).includes('请调用工具') && textOf(tree).includes('fde_scenario'));

  /* library chip → 资料库 */
  const libChip = buttons(tree).filter((b) => textOf(b).trim() === '资料库：场景参考')[0];
  check('工具 chips 含 library（跳资料库）', !!libChip);
  if (libChip) tree = await act(PanelApp, makeProps(), () => libChip.props.onClick());
  check('library chip → 跳资料库并加载 feed',
    textOf(tree).includes('FDE 资料库') && callsOf('GET', '/fde/library/feed').length >= 1);

  /* 阶段 × 工具矩阵 */
  const processNav4 = navBtn(tree, '流程');
  if (processNav4) tree = await act(PanelApp, makeProps(), () => processNav4.props.onClick());
  const matrix = byClass(tree, 'fde-matrix')[0];
  check('阶段 × 工具矩阵渲染（表头 + 8 行，只读）',
    textOf(tree).includes('阶段 × 工具矩阵') && !!matrix
    && collect(matrix, (n) => n.type === 'tr').length === 9,
    matrix ? String(collect(matrix, (n) => n.type === 'tr').length) : 'no matrix');
  check('矩阵含工具列（场景评估器 / fde_scenario 口径）', textOf(tree).includes('场景评估器'));
}

/* ================= 场景五·续3：meta 缺 playbook 降级（不白屏） ================= */
{
  META_CURRENT = META_NO_PLAYBOOK;
  stub('GET', '/research-workbench/api/fde/meta', { ok: true, meta: META_NO_PLAYBOOK });
  instances.clear();
  tree = await renderStable(PanelApp, makeProps());
  const processNav = navBtn(tree, '流程');
  check('无 playbook 时流程页签仍可达（不白屏）', !!processNav);
  if (processNav) tree = await act(PanelApp, makeProps(), () => processNav.props.onClick());
  check('meta 缺 playbook → 提示「宿主未升级」',
    textOf(tree).includes('宿主未升级') && textOf(tree).includes('FDE 流程'));

  META_CURRENT = META;
  stub('GET', '/research-workbench/api/fde/meta', { ok: true, meta: META });
  instances.clear();
  tree = await renderStable(PanelApp, makeProps());
}

/* ================= 场景五·续4：资料库（v1.3，spec §19.6） ================= */
{
  libMode = 'ok';
  windowOpens.length = 0;
  const libNav = navBtn(tree, '资料库');
  check('第 5 页签「资料库」在导航中（流程之后、招采之前）', !!libNav);
  if (libNav) tree = await act(PanelApp, makeProps(), () => libNav.props.onClick());

  check('资料库首屏 GET /fde/library/feed', callsOf('GET', '/fde/library/feed').length >= 1);
  check('顶部信息：数据日期 / 更新于 / 总条数 / 来源组计数',
    textOf(tree).includes('FDE 资料库') && textOf(tree).includes('更新于')
    && textOf(tree).includes('共 7 条') && textOf(tree).includes('国外官方') && textOf(tree).includes('社区动态'));
  const featuredCards = byClass(tree, 'fde-lib-featured-card');
  check('本期重点推荐渲染前 6 条', featuredCards.length === 6, 'featured ' + featuredCards.length);
  check('重点推荐卡片含标题 / 发布方 / 来源组 / 权威性徽章 / 阶段 chips / 外链',
    textOf(featuredCards[0]).includes('A practical guide to building agents')
    && textOf(featuredCards[0]).includes('OpenAI')
    && textOf(featuredCards[0]).includes('国外官方')
    && !!byClass(featuredCards[0], 'fde-lib-auth').length
    && buttons(featuredCards[0]).some((b) => textOf(b).trim() === '查看原文')
    && textOf(tree).includes('重点推荐'));
  const repoCard = byClass(tree, 'fde-lib-card').filter((n) => textOf(n).includes('openai/openai-agents-python'))[0];
  check('开源条目显示 stars / license / pushedAt',
    !!repoCard && textOf(repoCard).includes('12,345') && textOf(repoCard).includes('MIT')
    && textOf(repoCard).includes('推送'));

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
  const libSearch = inputByAria(tree, '搜索标题')[0];
  check('资料库关键词搜索框存在', !!libSearch);
  if (libSearch) {
    tree = await act(PanelApp, makeProps(), () => libSearch.props.onChange(evt({ target: { value: 'Anthropic' } })));
    check('关键词过滤生效', byClass(tree, 'fde-lib-card').length === 1 && textOf(tree).includes('Anthropic'));
    tree = await act(PanelApp, makeProps(), () => inputByAria(tree, '搜索标题')[0].props.onChange(evt({ target: { value: '不存在的关键词zzz' } })));
    check('筛选无结果 → 空态 + 清空筛选',
      textOf(tree).includes('当前筛选下没有资料') && !!btnExact(tree, '清空筛选')[0]);
    const resetBtn = btnExact(tree, '清空筛选')[0];
    if (resetBtn) tree = await act(PanelApp, makeProps(), () => resetBtn.props.onClick());
    check('清空筛选恢复列表', byClass(tree, 'fde-lib-card').length === 7);
  }

  /* 仅看重点推荐 */
  const favBox = byType(tree, 'input').filter((n) => n.props.type === 'checkbox'
    && String(n.props['aria-label'] || '').includes('仅看重点推荐'))[0];
  check('「仅看重点推荐」开关存在', !!favBox);
  if (favBox) tree = await act(PanelApp, makeProps(), () => favBox.props.onChange(evt({ target: { checked: true } })));
  check('仅看重点推荐生效（只显示 featured 条目）',
    byClass(tree, 'fde-lib-card').length === 6 && !textOf(tree).includes('未核实链接示例'));
  const favBox2 = byType(tree, 'input').filter((n) => n.props.type === 'checkbox'
    && String(n.props['aria-label'] || '').includes('仅看重点推荐'))[0];
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
    !!unsafeCard && textOf(unsafeCard).includes('该条没有可用 https 链接')
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
  check('刷新成功提示', textOf(tree).includes('资料库已刷新'));

  libMode = 'stale';
  const failBtn = libRefresh();
  if (failBtn) tree = await act(PanelApp, makeProps(), () => failBtn.props.onClick());
  check('刷新失败但有旧数据 → 黄条（含上次成功时间）+ 旧数据仍在',
    textOf(tree).includes('上次刷新未成功') && textOf(tree).includes('上次成功')
    && textOf(tree).includes('A practical guide'));

  libMode = 'unavailable';
  const missingBtn = libRefresh();
  if (missingBtn) tree = await act(PanelApp, makeProps(), () => missingBtn.props.onClick());
  check('catalog 缺失 → 错误行（不白屏，旧数据保留）',
    textOf(tree).includes('资料目录缺失') && textOf(tree).includes('A practical guide'));

  libMode = 'empty';
  const emptyBtn = libRefresh();
  if (emptyBtn) tree = await act(PanelApp, makeProps(), () => emptyBtn.props.onClick());
  check('无缓存 → 空态 + 刷新按钮',
    textOf(tree).includes('还没有资料缓存') && !!libRefresh());

  libMode = 'ok';
  const todayNav = navBtn(tree, '今日');
  if (todayNav) tree = await act(PanelApp, makeProps(), () => todayNav.props.onClick());
}

/* ================= 场景六：兼容页 + 经典模式 + Finder 三通道 ================= */
{
  routeTable = {}; routeSeq = {}; fetchCalls.length = 0;
  stub('GET', '/research-workbench/api/fde/meta', { ok: false, reason: 'HTTP 404（路由不存在，可能宿主未重启）' });
  stub('GET', '/research-workbench/api/status', STATUS);
  stub('GET', '/research-workbench/api/projects', PROJECTS);
  stub('GET', '/research-workbench/api/methods', { ok: true, items: [{ kind: 'method', name: '00-调研执行流程.md' }] });
  stub('GET', '/research-workbench/api/materials', MATERIALS);
  stub('GET', '/research-workbench/api/files?dir=' + encodeURIComponent('某环境-20261013'), FILES);
  instances.clear();
  let compatTree = await renderStable(PanelApp, makeProps());
  check('兼容页：明确提示需重启 DSH', textOf(compatTree).includes('宿主需要重启 DSH 后启用 FDE 看板'));
  check('兼容页：提供重试与经典模式入口',
    btnByText(compatTree, '重试探测').length >= 1 && btnByText(compatTree, '进入经典模式').length >= 1);
  const classicBtn = btnByText(compatTree, '进入经典模式')[0];
  let classicTree = await act(PanelApp, makeProps(), () => classicBtn.props.onClick());
  check('经典模式：旧五页签可见',
    ['新建调研', '项目', '产物 / 导出', '素材', '方法'].every((x) => textOf(classicTree).includes(x)));
  check('经典模式：顶部有返回 FDE 的入口（404 时提示重试探测）',
    btnByText(classicTree, '重试探测 FDE').length >= 1 || textOf(classicTree).includes('经典模式'));

  const projTab = btnExact(classicTree, '项目')[0];
  if (projTab) classicTree = await act(PanelApp, makeProps(), () => projTab.props.onClick());
  check('经典模式项目页渲染项目名', textOf(classicTree).includes('某环境'));
  const finderBtn = btnByText(classicTree, '在 Finder 中打开').find((b) => b.props.title === ABS);
  check('经典模式保留 Finder 按钮并带绝对路径', !!finderBtn);
  openPathCalls.length = 0;
  fetchCalls.length = 0;
  stub('POST', '/open-in-app/open', { ok: true });
  if (finderBtn) classicTree = await act(PanelApp, makeProps(), () => finderBtn.props.onClick());
  /* 面板注册的 actions 是真实 openPath：无 remote 时目录走 open-in-app 通道（AST 路径） */
  const dirOpen = lastCall('POST', '/open-in-app/open');
  check('经典模式 Finder → 真实 openPath 打开项目目录（open-in-app 通道）',
    !!dirOpen && dirOpen.body.path === ABS && dirOpen.body.app === 'finder',
    JSON.stringify(dirOpen && dirOpen.body));

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
  stub('GET', '/research-workbench/api/fde/board?view=board', { ok: false, reason: 'board.json 解析失败' });
  stub('GET', '/research-workbench/api/fde/brief', { ok: false, reason: '读不到' });
  instances.clear();
  const errTree = await renderStable(PanelApp, makeProps());
  check('看板读取失败时显示行内错误与重试（不白屏）',
    textOf(errTree).includes('看板读取失败') && btnByText(errTree, '重试').length >= 1);
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
