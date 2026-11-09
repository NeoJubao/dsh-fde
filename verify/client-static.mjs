/**
 * 客户端半静态检查（FDE 工作站面板）
 * 用法: node verify/client-static.mjs
 *
 * 覆盖三类：
 *  1) 包/模块/注册契约（必须保留，破坏即安装不上或面板不出现）
 *  2) 旧能力兼容（Finder 三通道、旧五页签、经典模式）
 *  3) FDE 新能力（Phase 2 IA：5 页签 + 页内子页签、看板拖拽/键盘、抽屉、兼容页、轮询、
 *     主题 token、招采雷达、流程 v2（8 阶段 playbook）、资料库（v1.3））
 *  注：Phase 2 起导航为「今日 / 客户 / 资料 / 流程 / 文件」+ 页头设置齿轮；
 *     原「看板/客户」合并为「客户」页内视图，原「资料库/招采」并入「资料」，
 *     原「方法」并入「流程」，「工件」改名「文件」。断言随新 IA 同步（未放宽）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = join(ROOT, 'client.js');
const fail = [];

if (!existsSync(p)) {
  console.log('✗ client.js 未构建（先跑 node build.mjs）');
  process.exit(1);
}
const c = readFileSync(p, 'utf8');

const checks = [
  /* ---- 1. 模块 / 注册契约（旧断言保留） ---- */
  ['__ModuleLoader__ 入口', c.includes('window.__ModuleLoader__.load')],
  ["模块 id 与包名一致（dsh-fde）", c.includes("id: 'dsh-fde'")],
  ['使用 require("react")', c.includes("require('react')")],
  ["声明 inject: ['slots', 'uiWorkspace']", /inject:\s*\[\s*'slots'/.test(c)],
  ['通过 svc() 取 slots（不直接依赖 ctx.slots）', c.includes("svc('slots')")],
  ['slots 不可用时有显式报错', c.includes('slots 服务不可用')],
  ['注册 sidebar.panellist', c.includes("'sidebar.panellist'")],
  ['注册 main 面板', c.includes("name: 'main'")],
  ['面板 id 与 key 一致', c.includes("id: 'researchworkbench'") && c.includes("key: 'researchworkbench'")],
  ['侧边栏标题为 FDE 工作站', c.includes("t('fdeBrand')")],
  ['调用宿主 API 前缀正确', c.includes("'/research-workbench/api'")],
  ['面板 actions 传入 openPath', /actions:\s*\{\s*openSession,\s*openPath\s*\}/.test(c)],

  /* ---- 2. 旧能力兼容 ---- */
  ['懒解析 remote.session 服务', c.includes("svc('remote.session')")],
  ['调用 session.openWorkspacePath', c.includes('openWorkspacePath(')],
  ["reveal 传 action: 'reveal'", /action: 'reveal'/.test(c)],
  ['目录兜底走 open-in-app 路由', c.includes("'/open-in-app/open'")],
  ['兜底走本插件宿主路由 /reveal', c.includes("API + '/reveal'")],
  ['文件行有 Finder 显示按钮', c.includes("t('reveal')")],
  ['有「在 Finder 中打开」按钮', c.includes("t('revealDir')")],
  ['有复制路径按钮', c.includes("t('copyPath')")],
  ['显示项目绝对路径（位置）', c.includes("t('locLabel')")],
  ['有样式注入与回收', c.includes('data-plugin') && c.includes('disposeStyle')],
  ['旧五页签仍在（经典模式）',
    ["t('tabNew')", "t('tabProjects')", "t('tabFiles')", "t('tabMaterials')", "t('tabMethods')"].every((s) => c.includes(s))],
  ['经典模式组件存在', c.includes('function ClassicApp(')],

  /* ---- 3. FDE 页型组件（Phase 2：5 页签 + 页内子页签） ---- */
  ['视图组件存在（今日/看板/客户/流程/资料库/招采/工件/方法/设置）',
    ['function TodayView(', 'function BoardView(', 'function CustomersView(', 'function ProcessView(',
      'function LibraryView(', 'function BidsView(', 'function ArtifactsView(', 'function MethodsView(',
      'function SettingsView('].every((s) => c.includes(s))],
  ['5 页签导航文案齐全（今日 / 客户 / 资料 / 流程 / 文件 + 设置入口）',
    ["t('tabToday')", "t('tabCustomers')", "t('tabKnowledge')", "t('tabProcess')",
      "t('tabNavFiles')", "t('tabSettings')"].every((s) => c.includes(s))],
  ['导航 5 项顺序正确（今日 / 客户 / 资料 / 流程 / 文件）',
    (() => {
      const m = /const navItems = \[([\s\S]*?)\];/.exec(c);
      if (!m) return false;
      const order = [...m[1].matchAll(/key: '([a-z]+)'/g)].map((x) => x[1]);
      return order.join(',') === 'today,customers,knowledge,process,files';
    })()],
  ['设置不再占页签：靠页头齿轮入口打开（layout.md §7）',
    (() => {
      const m = /const navItems = \[([\s\S]*?)\];/.exec(c);
      if (!m) return false;
      return !/key: 'settings'/.test(m[1]) && c.includes("className: 'fde-iconbtn'")
        && /onClick: activeView === 'settings' \? closeSettings : openSettings/.test(c)
        && c.includes("'aria-label': t('tabSettings')");
    })()],
  ['页内子页签壳：客户三态 / 资料两态 / 流程三态（layout.md §7）',
    c.includes('function PageTabs(')
    && ["t('customersViewBoardCustomer')", "t('customersViewBoardTask')", "t('customersViewList')"].every((x) => c.includes(x))
    && ["t('knowledgeTabs')", "t('tabLibrary')", "t('tabBids')"].every((x) => c.includes(x))
    && ["t('processTabFlow')", "t('processTabMethods')", "t('processTabSkills')"].every((x) => c.includes(x))],
  ['旧 state 值回落今日（不白屏）：normalizeView + LEGACY_VIEW_ALIASES',
    c.includes('function normalizeView(') && c.includes('LEGACY_VIEW_ALIASES')
    && c.includes("return LEGACY_VIEW_ALIASES[k] || 'today'")],
  ['深链/跳转改到新 IA：流程 chip→方法库/技能、资料库跳转、扫描→清单',
    c.includes("kind === 'template' ? 'skills' : 'methods'")
    && c.includes("setKnowledgeTab('library')") && c.includes("setCustomersTab('list')")],
  ['v1.3 已移除生财页签与 ScysView（宿主 scys 能力保留）',
    !c.includes("key: 'scys'") && !c.includes('function ScysView(')
    && !c.includes("fdeGet('/scys/feed')") && !c.includes("t('tabScys')")],
  ['生财专用 CSS 已删除（fde-scys-* 不再出现在面板）',
    !c.includes('.fde-scys-') && !c.includes('fde-scys-card')],
  ['FDE API 前缀统一', c.includes("const FDE = API + '/fde'")],
  ['今日：一屏四宫格结构（ADR 0007 / spec §8.1，inbox-grid）',
    c.includes("className: 'fde-view fde-view-fill fde-today'")
    && c.includes("className: 'fde-today-head'")
    && c.includes("className: 'fde-today-grid'")
    && c.includes("className: 'fde-card fde-today-panel'")
    && ['fde-today-panel-head', 'fde-today-panel-title', 'fde-today-panel-body'].every((x) => c.includes(x))],
  ['今日：四块顺序固定（待我处理 → 建议 → 今日焦点 → 最近活动）',
    (() => {
      const i = c.indexOf("className: 'fde-today-grid'");
      const tail = i >= 0 ? c.slice(i) : '';
      const order = ['todayAttention', 'todayProposals', 'todayFocus', 'todayActivity']
        .map((k) => tail.indexOf("t('" + k + "')"));
      return order.every((x) => x >= 0) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3];
    })()],
  ['今日：头部一行 4 个内联 KPI（活跃客户/待我处理/今日到期/逾期）',
    c.includes("className: 'fde-today-kpis'") && c.includes("className: 'fde-kpi-num'")
    && ["'活跃客户'", "'待我处理'", "'今日到期'", "'逾期'"].every((x) => c.includes(x))],
  ['今日：响应式三档（宽 4 列 / 中 2×2 / 窄单列，容器查询）',
    c.includes('grid-template-columns:repeat(4,minmax(0,1fr))')
    && c.includes('@container (max-width:1199px)') && c.includes('@container (max-width:899px)')
    && c.includes('grid-template-columns:repeat(2,minmax(0,1fr))')],
  ['今日：旧两栏结构已移除（不再有 fde-grid-two 标记）',
    !c.includes("className: 'fde-grid-two'")],
  ['客户页内三态：看板（客户/任务）+ 客户清单',
    ["t('customersViewBoardCustomer')", "t('customersViewBoardTask')", "t('customersViewList')"]
      .every((s) => c.includes(s)) && c.includes('（空）')],
  ['客户：导入现有项目两段式（scan/apply）',
    c.includes("fdePost('/adopt', { action: 'scan' })") && c.includes("fdePost('/adopt', { action: 'apply', dirs })")],

  /* ---- 4. 拖拽 / 键盘 / 抽屉 ---- */
  ['HTML5 拖拽（dragStart/dragOver/drop）',
    ['onDragStart', 'onDragOver', 'onDrop', 'dataTransfer'].every((s) => c.includes(s))],
  ['拖拽数据 JSON 序列化', c.includes("dataTransfer.setData('text/plain'")],
  ['键盘可达：Tab 聚焦 / Enter / Alt+方向键',
    c.includes('tabIndex: 0') && c.includes("e.key === 'Enter'") && c.includes('e.altKey') && c.includes("e.key === 'ArrowRight'")],
  ['客户抽屉 + 任务抽屉', c.includes('function EngagementDrawer(') && c.includes('function ItemDrawer(')],
  ['抽屉 role=dialog / aria-modal', c.includes("role: 'dialog'") && c.includes("'aria-modal': 'true'")],
  ['门禁未过弹缺项 + 强制确认', c.includes("t('drawerGateMissingTitle')") && c.includes('force: true') && c.includes('MissingList')],
  ['任务 done 需要证据', c.includes("t('drawerEvidenceTitle')") && c.includes('evidence')],
  ['破坏性操作二次确认', c.includes('function ConfirmDialog(') && c.includes("t('drawerArchiveConfirm')") && c.includes("t('drawerDeleteConfirm')")],

  /* ---- 5. 兼容 / 降级 / 轮询 ---- */
  ['启动探测 GET /fde/meta', c.includes("getJSON(FDE + '/meta')")],
  ['兼容页文案与经典模式入口', c.includes("t('compatTitle')") && c.includes('宿主需要重启 DSH 后启用 FDE 看板') && c.includes("t('classicMode')")],
  ['任何分支都渲染（不白屏）', c.includes('function ProbingScreen(') && c.includes('function CompatPage(')],
  ['轮询 10–15s', /const POLL_MS = (1[0-5]\d{3})/.test(c) && c.includes('setInterval(')],
  ['切页签立即刷新（轮询 effect 依赖 view）', /useEffect\(\(\) => \{[\s\S]*?\[view, loadBoard, loadBrief\]/.test(c)],
  ['hasSession:false 剪贴板降级', c.includes('copyText') && c.includes('navigator.clipboard')],

  /* ---- 6. 招采雷达（v1.1，spec §17.7）；Phase 2 起并入「资料」页子页签 ---- */
  ['招采并入「资料」页子页签（不再单列导航）',
    /\{ key: 'bids', label: t\('tabBids'\) \}/.test(c) && c.includes('function KnowledgePage(')],
  ['招采 API 前缀统一（stats/search/match/link/unlink/promote/refresh）',
    ["'/bids/stats'", "'/bids/search?", "'/bids/match?", "'/bids/link'", "'/bids/unlink'", "'/bids/promote'", "'/bids/refresh'"]
      .every((x) => c.includes(x))],
  ['招采未就绪文案与降级（available=false 不白屏）',
    c.includes('招采雷达未就绪（bid-intel 未装载或未升级）') && c.includes('available') && c.includes('BidUnavailable')],
  ['招采结果列表关系徽章齐全（采购/中标/候选/提及/招标）',
    ["bidRelBuyer", "bidRelWinner", "bidRelCandidate", "bidRelMention", "bidRelTender"].every((k) => c.includes("'" + k + "'"))],
  ['原文链接新窗口 + rel=noreferrer',
    /target: '_blank', rel: 'noreferrer noopener'/.test(c)],
  ['金额只展示原文（不换算/不求和）',
    c.includes("t('bidAmountTip')") && c.includes('金额为公告原文，不做换算/求和') && !/\.amount[^\n]{0,40}toLocaleString/.test(c)],
  ['客户抽屉招采区（统计/加入跟进/关联/取消关联）',
    c.includes('bidsBlock') && c.includes("t('bidAddFollowup')") && c.includes("t('bidLink')") && c.includes("t('bidUnlink')")],
  ['看板卡片招采徽章条件（total>0 且 available）',
    /bids\.available && bids\.total > 0/.test(c) && c.includes("'招采 ' + bids.total")],
  ['导入链接仅探测到 bid-intel 时显示',
    c.includes("'/bidintel/api/status'") && c.includes("'/bidintel/api/import-url'") && c.includes('importReady === true')],
  ['设置页招标雷达开关与索引状态',
    c.includes("t('bidSettingsLabel')") && c.includes("t('bidServiceStatus')") && c.includes('bidStats')],

  /* ---- 6b. FDE 资料库（v1.3，spec §19.6）；Phase 2 起并入「资料」页子页签 ---- */
  ['资料库并入「资料」页子页签（与招采同页）',
    /\{ key: 'library', label: t\('tabLibrary'\) \}/.test(c) && c.includes('function KnowledgePage(')],
  ['资料库视图由「资料」页型壳承载（activeView 分支）',
    c.includes("activeView === 'knowledge'") && /function KnowledgePage\(/.test(c) && /h\(LibraryView,/.test(c)],
  ['资料库接口走 fdeGet/fdePost（feed 读 / refresh 强制刷新）',
    c.includes("fdeGet('/library/feed')") && c.includes("fdePost('/library/refresh', { force: true })")],
  ['资料库顶部：日期 / 更新于 / 总条数 / 来源组计数 / 刷新',
    ['libUpdated', 'libTotalPrefix', 'libGroupIntl', 'libGroupOpen', 'libRefresh'].every((k) => c.includes(k))],
  ['资料库重点推荐前 6 条（featured 排序）',
    c.includes('libFeaturedTitle') && c.includes('featuredIds') && /\.slice\(0, 6\)/.test(c)],
  ['资料库筛选：来源组 6 段 / 类型 / 8 阶段 / 搜索 / 仅看重点推荐 / 排序 3 档',
    ['libGroupAll', 'libGroupIntl', 'libGroupCn', 'libGroupOpen', 'libGroupMethod', 'libGroupCommunity',
      'libKindLabel', 'libStageLabel', 'libSearchPh', 'libFeaturedOnly',
      'libSortRecommend', 'libSortLatest', 'libSortHot'].every((k) => c.includes(k))],
  ['资料库卡片：标题外链 / 发布方 / 类型 + A|B|C / 阶段 chips / 摘要 / 开源指标 / 新更新推荐徽章 / 查看原文',
    ['libKindLabel', 'fde-lib-auth', 'fde-lib-stages', 'fde-lib-summary',
      'libNewTag', 'libUpdatedTag', 'libFeaturedBadge', 'libOpen'].every((k) => c.includes(k))
    && c.includes('staticMeta') && c.includes('liveMeta') && c.includes('pushedAt') && c.includes('license')],
  ['资料库降级：刷新失败旧数据黄条 / 无缓存空态 / 筛选空态 / catalog 缺失错误行',
    ['libStaleWarn', 'libEmptyTitle', 'libFilterEmpty', 'libCatalogMissing', 'libLastOk'].every((k) => c.includes(k))],
  ['资料库外链安全：仅 https?:// + window.open noopener,noreferrer',
    c.includes('function isSafeUrl(') && /window\.open\([^'\n]*'_blank', 'noopener,noreferrer'\)/.test(c)],
  ['资料库不注入 HTML（无 dangerouslySetInnerHTML，纯文本渲染）',
    !c.includes('dangerouslySetInnerHTML')],
  ['资料库刷新按钮 busy 时禁用（防重复点击）',
    /busy: busy/.test(c) && /disabled: busy \|\| loading/.test(c)],
  ['资料库 CSS 走 --fde-* 语义 token（明暗自适应）',
    /\.fde-lib-/.test(c) && /var\(--fde-/.test(c)],

  /* ---- 6c. FDE 流程 v2（v1.3，spec §20.5）；Phase 2 起「方法」并入本页 ---- */
  ['流程在导航中且带页内子页签（8 阶段 / 方法库 / 技能与模板）',
    /\{ key: 'process', label: t\('tabProcess'\)/.test(c) && c.includes('function ProcessPage(')
    && ["t('processTabFlow')", "t('processTabMethods')", "t('processTabSkills')"].every((x) => c.includes(x))],
  ['流程视图由「流程」页型壳承载（activeView 分支）',
    c.includes("activeView === 'process'") && /function ProcessPage\(/.test(c) && /h\(ProcessView,/.test(c)],
  ['方法页并入流程页：MethodsView 按 section 拆「方法库 / 技能与模板」',
    c.includes("p.section === 'skills' ? 'skills' : 'methods'") && c.includes('function MethodsView(')],
  ['8 阶段从 meta.stages 派生（不硬编码阶段数组）',
    c.includes('asList(meta && meta.stages)') && c.includes('stages.map(stepNode)')
    && !/\[\s*'lead'\s*,\s*'discovery'/.test(c) && !c.includes('7 个阶段') && !c.includes('7 列')],
  ['流程步进条：阶段名 + 当前客户数 + 门禁状态点',
    ['processClientCountSuffix', 'fde-flow-step', 'fde-flow-gate-dot'].every((k) => c.includes(k))],
  ['流程详情：目标 / 输入 / 关键动作 / 交付物 / 工具 / 常见坑 / 门禁清单',
    ['processGoal', 'processInputs', 'processActivities', 'processOutputs', 'processTools',
      'processPitfalls', 'processGateAuto', 'processGateManual'].every((k) => c.includes(k))],
  ['流程工具 chips：method/template 跳方法页（onOpenMethod）',
    c.includes("tool.kind === 'method' || tool.kind === 'template'") && c.includes('onOpenMethod')],
  ['流程工具 chips：skill/tool 展开「在会话中这样用」+ 复制',
    c.includes("tool.kind === 'skill'") && c.includes("t('processHowTo')")
    && c.includes("t('processCopy')") && c.includes('copyExample')],
  ['流程工具 chips：library 跳资料库',
    c.includes("tool.kind === 'library'") && c.includes('onOpenLibrary')],
  ['底部阶段 × 工具矩阵（只读）',
    c.includes('processMatrixTitle') && c.includes('fde-matrix') && c.includes('toolCols')],
  ['meta 缺 playbook 时提示宿主未升级（不白屏）',
    c.includes('processNoPlaybook') && c.includes('hasPlaybook')],
  ['方法页支持 initialName/initialSeq（流程页直达打开文件）',
    c.includes('initialName') && c.includes('initialSeq') && c.includes('methodJump')],
  ['流程 CSS 走 --fde-* 语义 token（明暗自适应）',
    /\.fde-flow-/.test(c) && /var\(--fde-/.test(c)],

  /* ---- 6d. A7 去重（Phase 2 IA：全局刷新/自主性只在壳层一处） ---- */
  ['A7：页内刷新只允许块级（t(\'refresh\') 全文件 = 壳层 1 + 经典模式 1）',
    (() => {
      const n = (c.match(/t\('refresh'\)/g) || []).length;
      return n === 2;
    })()],
  ['A7：自主性徽章只在壳层渲染（视图内无 AutonomyBadge 调用）',
    (() => {
      const shellStart = c.indexOf('const autonomy = autonomyKey');
      if (shellStart < 0) return false;
      const before = c.slice(0, shellStart);
      return !/AutonomyBadge\(\{ meta, mode: autonomyKey\(meta, board\) \}\)/.test(before);
    })()],

  /* ---- 6e. v1.5.0 只读演示模式（ADR 0006 / spec §8.8） ---- */
  ['演示模式：内置 DEMO_BOARD / DEMO_BRIEF（4 示例客户跨 4 阶段 + 3 任务 + 2 注意力 + 4 活动）',
    c.includes('const DEMO_BOARD') && c.includes('const DEMO_BRIEF')
    && ['demo-eng-1', 'demo-eng-2', 'demo-eng-3', 'demo-eng-4'].every((x) => c.includes(x))
    && ['demo-itm-scoping', 'demo-itm-discovery', 'demo-itm-meeting'].every((x) => c.includes(x))
    && ['demo-attn-decision', 'demo-attn-review'].every((x) => c.includes(x))
    && (c.match(/（示例）/g) || []).length >= 8],
  ['演示阶段从 meta.stages 解析（不硬编码阶段 key/顺序，spec §16.5）',
    c.includes('stageIndex: 0') && c.includes('demoBoardView(board, meta)')
    && c.includes('const stages = asList(meta && meta.stages)')],
  ['演示触发：真实看板为空且 settings.demoDismissed !== true',
    c.includes('function isDemoEligible(') && c.includes('function isBoardEmpty(')
    && c.includes('settings.demoDismissed === true')],
  ['演示只读：demoGuard 包装写请求与写回调（runAction / openCreate / postJSON）',
    c.includes('const postJSON = demoGuard(sendJSON)')
    && c.includes('const runAction = demoGuard(useCallback(')
    && c.includes('const openCreate = demoGuard(useCallback(')
    && c.includes('const guarded = {')],
  ['演示只读：抽屉/看板/注意力写入口全走 guarded（漏一处即 bug）',
    ['moveEngagement', 'moveItem', 'evaluateGate', 'saveGate', 'forceGate', 'saveNext', 'saveStakeholders',
      'pauseEngagement', 'archiveEngagement', 'saveItem', 'reportItem', 'deleteItem', 'handoff',
      'attentionAction', 'proposalAction'].every((k) => c.includes(k + ': demoGuard('))],
  ['演示横幅（nav 与内容之间）+ 一键清除 POST settings demoDismissed:true（唯一 bypass 写）',
    c.includes("className: 'fde-demo-banner'") && c.includes("patch: { demoDismissed: true }")
    && c.includes('demoBypass: true') && c.includes("t('demoStart')")],
  ['演示卡片：设置页状态 + 重新查看示例（demoDismissed:false）',
    c.includes("t('demoCardTitle')") && c.includes("patch: { demoDismissed: false }")
    && c.includes('onDemoRestore')],
  ['空态三步引导（新建客户 / 导入现有项目 / 重新查看示例）',
    c.includes('fde-onboard-step') && c.includes("t('demoStepRestore')") && c.includes("t('demoOnboardTitle')")],

  /* ---- 7. 约束 ---- */
  ['不 import @deepseek-ai/*', !c.includes('@deepseek-ai')],
  ['不写 localStorage 作为事实源', !c.includes('localStorage') && !c.includes('sessionStorage')],
  ['不使用原生 alert/confirm 弹窗', !/\balert\(/.test(c) && !/window\.confirm\(/.test(c)],
  ['只用主题 token 定义配色', /var\(--dsw-alias-/.test(c) && !/(?:^|[;{\s])(?:color|background|border-color)\s*:\s*#/.test(c)],
  ['无语法错误征兆（括号平衡）',
    (c.match(/\(/g) || []).length === (c.match(/\)/g) || []).length],
];

for (const [name, pass] of checks) {
  console.log((pass ? '  ✓ ' : '  ✗ ') + name);
  if (!pass) fail.push(name);
}

if (fail.length) {
  console.log('\n客户端静态检查失败 ' + fail.length + ' 项。');
  process.exit(1);
}
console.log('\n客户端静态检查通过（' + (c.length / 1024).toFixed(1) + ' KB，' + checks.length + ' 项）。');
