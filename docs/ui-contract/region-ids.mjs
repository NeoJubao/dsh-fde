/**
 * FDE 工作站 · ui-contract 区域注册表（v1，供 Lead 审）
 *
 * 为什么不是 TypeScript 的 `RegionId` 联合类型：
 *   FDE 是零构建纯 JS（`src/ui/ui-panel.js` 单文件 + `build.mjs` 拼接），
 *   没有 tsc，也没有 CSS Modules。ui-contract 的「类型层」因此降级为：
 *     ① 本文件的 REGION_IDS / REGION_META 常量（唯一事实来源）；
 *     ② `region()` helper：渲染处统一产出 `data-region`；
 *     ③ audit-ui-contract.mjs：把「代码里出现的区域名 ⊆ REGION_IDS」
 *        变成可执行的 Node 断言（本目录 A1 检查）。
 *
 * 契约正文见同目录 layout.md / design.md / tokens.md；
 * 本文件只放「机器可读」的那一层：id、中文名、白名单、禁止项、页型映射。
 * 修改本文件必须同时改 layout.md §2 表格 —— 体检脚本会比对两边。
 */

/** 稳定 id（kebab-case；一旦发布不得重命名，只能废弃 + 新增别名）。 */
export const REGION_IDS = Object.freeze({
  /* ---- 外壳（所有页型共享） ---- */
  ROOT: 'root',                        // 面板根容器
  PAGE_HEADER: 'page-header',          // 页面头：标题 / 一句定位 / 页级主操作 / 设置入口
  NAV: 'nav',                          // 主导航
  STATUS: 'status',                    // 页级状态条：载/错/空/降级提示（不遮导航）
  /* ---- 页面内容 ---- */
  CONTENT: 'content',                  // 页面内容容器
  TOOLBAR: 'toolbar',                  // 页型级视图切换 / 搜索 / 筛选
  PRIMARY: 'primary',                  // 主内容（当前任务的主对象）
  ASIDE: 'aside',                      // 次内容 / 摘要 / 图例（每页最多 1 个，可折叠）
  /* ---- 焦点槽 F1：对象详情 ---- */
  DRAWER: 'drawer',                    // 焦点槽容器（遮罩 + 侧板）
  DRAWER_HEAD: 'drawer-head',          // 对象名 + 阶段 + 返回/关闭
  DRAWER_BODY: 'drawer-body',          // 分块区（见 block-*）
  DRAWER_FOOT: 'drawer-foot',          // 固定操作条（主操作唯一）
  /* ---- 焦点槽 F2：确认 / 强制 / 证据 ---- */
  DIALOG: 'dialog',                    // 二级焦点槽（同一时间最多 1 个）
  /* ---- 对象级块（只允许出现在 drawer-body 内） ---- */
  BLOCK_OVERVIEW: 'block-overview',    // 概览：身份 / 阶段 / 优先级 / 负责人
  BLOCK_GATE: 'block-gate',            // 门禁：自动检查 + 人工确认 + 证据
  BLOCK_NEXT: 'block-next',            // 下一步：做什么 / 到期 / 负责人
  BLOCK_STAKEHOLDERS: 'block-stakeholders', // 干系人
  BLOCK_ARTIFACTS: 'block-artifacts',  // 工件（属于该对象）
  BLOCK_BIDS: 'block-bids',            // 招采（属于该对象）
  BLOCK_TIMELINE: 'block-timeline',    // 时间线
  BLOCK_ITEMS: 'block-items',          // 关联任务
  BLOCK_REPORT: 'block-report',        // 会话回报（任务）
});

/** 区域元数据：label 给人看；allowed / forbidden 是白名单的两列（layout.md §2 同文）。 */
export const REGION_META = Object.freeze({
  root: { label: '面板根', pageTypes: ['inbox', 'workbench', 'ledger', 'reference', 'settings', 'focus'],
    allowed: '主题变量作用域 + 页面骨架', forbidden: '任何具体业务内容；任何主题选择器' },
  'page-header': { label: '页面头', pageTypes: ['inbox', 'workbench', 'ledger', 'reference', 'settings', 'focus'],
    allowed: '页面名（1 个）+ 一句定位；页级主操作（≤1）；视图级切换；设置入口',
    forbidden: '全局控件副本（刷新/自主性徽章只在壳层出现一次）；统计数字；对象级操作' },
  nav: { label: '主导航', pageTypes: ['inbox', 'workbench', 'ledger', 'reference', 'settings', 'focus'],
    allowed: '5–6 个页签 + 分组分隔 + 单一计数语义',
    forbidden: '对象级操作；超过 6 个页签；两种语义的计数徽章（待办数 vs 记录数）；参考/配置页签' },
  status: { label: '页级状态条', pageTypes: ['inbox', 'workbench', 'ledger', 'reference', 'settings', 'focus'],
    allowed: '加载 / 空 / 错误 / 降级（UNAVAILABLE）/ 陈旧数据提示；恢复动作（≤1 主 + 1 次）',
    forbidden: '用状态条替代页面结构（空态仍须渲染结构与主行动）；无原因的纯报错' },
  content: { label: '内容容器', pageTypes: ['inbox', 'workbench', 'ledger', 'reference', 'settings', 'focus'],
    allowed: 'toolbar / primary / aside 的组合', forbidden: '第二个 toolbar；跨页型混装（如台账里嵌看板）' },
  toolbar: { label: '视图工具栏', pageTypes: ['workbench', 'ledger'],
    allowed: '视图模式切换、搜索、筛选、排序；每页 1 个',
    forbidden: '刷新（刷新属壳层）；对象级操作；全局设置' },
  primary: { label: '主内容', pageTypes: ['inbox', 'workbench', 'ledger', 'reference', 'settings', 'focus'],
    allowed: '当前页型的主对象（列表 / 看板 / 表单 / 文档正文）',
    forbidden: '广告位、跨页型推荐、重复同一对象第二遍' },
  aside: { label: '次内容', pageTypes: ['inbox', 'workbench', 'reference'],
    allowed: '摘要、图例、推荐、活动流；可折叠；每页 ≤1',
    forbidden: '主对象全量副本（如把看板客户再列一遍）；页级主操作' },
  drawer: { label: '焦点槽', pageTypes: ['focus'],
    allowed: '单个对象的切面；最多两层（对象 + 子对象），第二层须带返回',
    forbidden: '全量列表 / 跨对象比较；同一时间多于 1 个抽屉；替换式切换（丢上下文）' },
  'drawer-head': { label: '焦点槽头', pageTypes: ['focus'],
    allowed: '对象名 + 阶段/状态 + 面包屑返回 + 关闭',
    forbidden: '主操作按钮（主操作属 drawer-foot）；未标注的 id 串（需有标签）' },
  'drawer-body': { label: '焦点槽正文', pageTypes: ['focus'],
    allowed: 'block-* 分块；块标题可 sticky', forbidden: '全局控件；跨对象内容；无分块的超长表单' },
  'drawer-foot': { label: '焦点槽操作条', pageTypes: ['focus'],
    allowed: '1 个主操作 + ≤2 个次操作 + 危险操作（分离）', forbidden: '多个同等强调的主按钮；保存类按钮散落在正文' },
  dialog: { label: '确认弹窗', pageTypes: ['focus'],
    allowed: '一句话说明 + 原因/证据输入 + 取消/确认（危险操作双确认）',
    forbidden: '表单编辑（应回抽屉）；关闭后丢失输入的流程' },
  'block-overview': { label: '概览块', pageTypes: ['focus'], allowed: '身份、阶段、优先级、负责人、到期', forbidden: '门禁/下一步（各有专块）' },
  'block-gate': { label: '门禁块', pageTypes: ['focus'], allowed: '自动检查、人工确认、证据输入、重新评估', forbidden: '推进阶段的按钮（属 foot）；绕过证据的默认勾选' },
  'block-next': { label: '下一步块', pageTypes: ['focus'], allowed: '做什么 / 到期 / 负责人 / 保存', forbidden: '会话发起（属 foot）' },
  'block-stakeholders': { label: '干系人块', pageTypes: ['focus'], allowed: '姓名/职务/层级/是否核实', forbidden: '联系方式明文落盘' },
  'block-artifacts': { label: '工件块', pageTypes: ['focus'], allowed: '该对象的文件清单 + 打开/导出', forbidden: '跨客户文件；批量导出主按钮' },
  'block-bids': { label: '招采块', pageTypes: ['focus'], allowed: '关联公告、匹配候选、关联/取消关联', forbidden: '把候选人写成中标人；无出处的金额' },
  'block-timeline': { label: '时间线块', pageTypes: ['focus'], allowed: '事件 + 时间 + 来源（人/agent/系统）', forbidden: '可编辑正文' },
  'block-items': { label: '关联任务块', pageTypes: ['focus'], allowed: '该对象的任务摘要 + 打开', forbidden: '全量任务看板副本' },
  'block-report': { label: '回报块', pageTypes: ['focus'], allowed: '回报文本 + 产物路径 + 回报类型', forbidden: '长文全文（应落文件给路径）' },
});

/** 页型：决定「哪些区域可以出现」。layout.md §4 与此一致。 */
export const PAGE_TYPES = Object.freeze({
  inbox: { label: '收件箱页', question: '现在该我做什么？', regions: ['page-header', 'nav', 'status', 'content', 'primary', 'aside'] },
  workbench: { label: '工作台页', question: '这组对象处在什么状态、怎么推进？', regions: ['page-header', 'nav', 'toolbar', 'status', 'content', 'primary'] },
  ledger: { label: '台账页', question: '全量对象在哪、怎么筛、怎么批量处理？', regions: ['page-header', 'nav', 'toolbar', 'status', 'content', 'primary'] },
  reference: { label: '参考页', question: '方法/资料/规则是什么？', regions: ['page-header', 'nav', 'status', 'content', 'primary', 'aside'] },
  settings: { label: '配置页', question: '阈值/开关/自主性怎么设？', regions: ['page-header', 'nav', 'status', 'content', 'primary'] },
  focus: { label: '焦点槽', question: '这个对象现在是什么、下一步做什么？', regions: ['drawer', 'drawer-head', 'drawer-body', 'drawer-foot', 'dialog'] },
});

/**
 * 视图 → 页型映射。v1 契约的目标态（现状 9 页签 → 目标 5 页签 + 设置入口）：
 *   inbox     今日
 *   workbench 客户（阶段看板 / 任务看板 两种模式）
 *   ledger    客户（清单模式）/ 招采 / 工件
 *   reference 流程（含方法） / 资料（资料库 + 招采子页签，见 layout.md §7 决策点 A）
 *   settings  设置（页头入口，不占页签）
 *   focus     客户抽屉 / 任务抽屉 / 确认弹窗
 * 迁移期允许一页多页型（同一路由下不同模式），但每个模式必须只落到一个页型。
 */
export const VIEW_TO_PAGE_TYPE = Object.freeze({
  today: 'inbox',
  'board-customer': 'workbench',
  'board-item': 'workbench',
  'customer-list': 'ledger',
  'bids-list': 'ledger',
  artifacts: 'ledger',
  process: 'reference',
  library: 'reference',
  settings: 'settings',
  'drawer-engagement': 'focus',
  'drawer-item': 'focus',
  dialog: 'focus',
});

/** 目标导航：5 页签 + 页头设置入口（layout.md §7）。 */
export const NAV_ITEMS = Object.freeze([
  { key: 'today', label: '今日', pageType: 'inbox', badge: 'attention' },
  { key: 'customers', label: '客户', pageType: 'workbench', badge: null },
  { key: 'knowledge', label: '资料', pageType: 'reference', badge: null },
  { key: 'process', label: '流程', pageType: 'reference', badge: null },
  { key: 'artifacts', label: '文件', pageType: 'ledger', badge: null },
]);

/**
 * 渲染 helper：区域标记的唯一出口。
 * 用法：h('div', region(REGION_IDS.PAGE_HEADER, { className: 'fde-top' }), …)
 * @param {string} id 必须是 REGION_IDS 里的值
 * @param {object} [attrs] 其他属性（className / id 等）
 */
export function region(id, attrs) {
  assertRegionId(id);
  return Object.assign({ 'data-region': id }, attrs || {});
}

const REGION_ID_SET = new Set(Object.values(REGION_IDS));

/** 断言：区域名必须 ⊆ 白名单；供渲染期与测试期共用。 */
export function assertRegionId(id) {
  if (!REGION_ID_SET.has(id)) {
    throw new Error('ui-contract: 未登记的区域 "' + String(id) + '"（见 layout.md §2 白名单）');
  }
  return id;
}

/** 断言：某页型是否允许出现该区域；返回 { allowed, reason }。 */
export function checkRegionForPage(pageType, regionId) {
  const page = PAGE_TYPES[pageType];
  if (!page) return { allowed: false, reason: '未知页型 ' + pageType };
  if (page.regions.indexOf(regionId) === -1) {
    return { allowed: false, reason: '页型 ' + pageType + ' 不允许区域 ' + regionId + '（layout.md §4）' };
  }
  return { allowed: true, reason: '' };
}

/** 集合相等断言：layout.md §2 与 REGION_META 必须一一对应（audit A1 调用）。 */
export function assertSameRegions(idsFromDoc) {
  const a = Object.values(REGION_IDS).slice().sort();
  const b = (idsFromDoc || []).slice().sort();
  const missing = a.filter((x) => b.indexOf(x) === -1);
  const extra = b.filter((x) => a.indexOf(x) === -1);
  if (missing.length || extra.length) {
    throw new Error('ui-contract: layout.md §2 与 region-ids.mjs 不一致；缺 ' + JSON.stringify(missing) + '，多 ' + JSON.stringify(extra));
  }
  return true;
}

export default { REGION_IDS, REGION_META, PAGE_TYPES, VIEW_TO_PAGE_TYPE, NAV_ITEMS, region, assertRegionId, checkRegionForPage, assertSameRegions };
