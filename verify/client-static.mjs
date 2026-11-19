/**
 * 客户端半静态检查（FDE 工作站面板）
 * 用法: node verify/client-static.mjs
 *
 * 覆盖三类：
 *  1) 包/模块/注册契约（必须保留，破坏即安装不上或面板不出现）
 *  2) 旧能力兼容（文件定位三通道；经典模式 v1.7.0 已移除）
 *  3) FDE 能力（5 页签 + 页内子页签、看板拖拽/键盘、抽屉、未就绪页、轮询、
 *     主题 token、招采、流程（8 阶段指南）、资料库）
 *  4) v2.0 可交付版（ADR 0010 / spec §22）：字典完整、面板禁词、不显示内部标识、
 *     今日去重、提醒按钮、客户抽屉顺序、设置收敛、DSH 0.2.1 的地址与样式约定。
 *  导航：今日 / 客户 / 资料 / 流程 / 情报 + 页头设置入口。断言随契约同步（未放宽）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDict, findBannedWords } from '../tools/panel-checks.mjs';

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
  ['调用 DSH 侧 API 前缀正确（按文档 base 解析，见 6g）', c.includes("const API = appUrl('research-workbench/api')")],
  ['面板 actions 传入 openPath 与资料预览服务', /actions:\s*\{\s*openSession,\s*openPath,\s*services:/.test(c)],
  ['资料页左右分隔条可拖动调宽（鼠标 + 键盘 + 宽度记忆）',
    c.includes("className: 'fde-mat-splitter'") && c.includes("role: 'separator'")
    && c.includes('onSplitterDown') && c.includes('onSplitterKey')
    && c.includes("'ArrowLeft'") && c.includes("'ArrowRight'") && c.includes('MAT_UI_MEM.listWidth')],
  ['资料预览留在面板内（点行不切换主面板 / 不调用原生预览）',
    c.includes('onClick: () => selectFile(f)') && !c.includes('openNativePreview')
    && c.includes('function FilePreview(') && c.includes("t('matPick')")],

  /* ---- 2. 旧能力兼容 ---- */
  ['懒解析 remote.session 服务', c.includes("svc('remote.session')")],
  ['调用 session.openWorkspacePath', c.includes('openWorkspacePath(')],
  ["reveal 传 action: 'reveal'", /action: 'reveal'/.test(c)],
  ['目录兜底走 open-in-app 路由', c.includes("appUrl('open-in-app/open')")],
  ['兜底走本插件宿主路由 /reveal', c.includes("API + '/reveal'")],
  ['文件行有 Finder 显示按钮', c.includes("t('reveal')")],
  ['资料行菜单含 Finder 显示 / 复制路径', c.includes("t('reveal')") && c.includes("t('matCopyPath')")],
  ['资料预览头部有系统打开', c.includes("t('matSystemOpen')")],
  ['有样式注入与回收', c.includes('data-plugin') && c.includes('disposeStyle')],
  ['经典模式已移除（无 ClassicApp / 旧五页签文案）',
    !c.includes('function ClassicApp(') && !c.includes("t('tabNew')") && !c.includes("t('classicMode')")],

  /* ---- 3. FDE 页型组件（Phase 2：5 页签 + 页内子页签） ---- */
  ['视图组件存在（今日/看板/客户/流程/资料库/招采/工件/方法/设置）',
    ['function TodayView(', 'function BoardView(', 'function CustomersView(', 'function ProcessView(',
      'function LibraryView(', 'function BidsView(', 'function ArtifactsView(', 'function MethodsView(',
      'function SettingsView('].every((s) => c.includes(s))],
  ['5 页签导航文案齐全（今日 / 客户 / 资料 / 流程 / 文件 + 设置入口）',
    ["t('tabToday')", "t('tabCustomers')", "t('tabKnowledge')", "t('tabProcess')",
      "t('tabNavFiles')", "t('tabSettings')"].every((s) => c.includes(s))],
  ['导航 5 项顺序正确（今日 / 客户 / 资料 / 流程 / 情报）',
    (() => {
      const m = /const navItems = \[([\s\S]*?)\];/.exec(c);
      if (!m) return false;
      const order = [...m[1].matchAll(/key: '([a-z]+)'/g)].map((x) => x[1]);
      return order.join(',') === 'today,customers,files,process,knowledge';
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
  ['今日：四块顺序固定（待我处理 → 提醒 → 今天跟进 → 最近动态）',
    (() => {
      const i = c.indexOf("className: 'fde-today-grid'");
      const tail = i >= 0 ? c.slice(i) : '';
      const order = ['todayAttention', 'todayProposals', 'todayFocus', 'todayActivity']
        .map((k) => tail.indexOf("t('" + k + "')"));
      return order.every((x) => x >= 0) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3];
    })()],
  ['今日：头部一行 4 个数字（在跟客户 / 待我处理 / 今天到期 / 已逾期）+ 日期行',
    c.includes("className: 'fde-today-kpis'") && c.includes("className: 'fde-kpi-num'")
    && ["kpi('active', stats.active, '在跟客户')", "kpi('attention', attention.length, t('todayAttention')",
      "kpi('due', stats.dueToday, '今天到期')", "'已逾期'"].every((x) => c.includes(x))
    && c.includes('todayLine()')],
  ['今日：响应式三档（宽 4 列且待我处理最宽 / 中 2×2 / 窄单列，容器查询）',
    c.includes('grid-template-columns:minmax(0,1.45fr) minmax(0,1.15fr) minmax(0,1fr) minmax(0,1fr)')
    && c.includes('@container (max-width:1199px)') && c.includes('@container (max-width:899px)')
    && c.includes('grid-template-columns:repeat(2,minmax(0,1fr))')],
  ['今日：旧两栏结构已移除（不再有 fde-grid-two 标记）',
    !c.includes("className: 'fde-grid-two'")],
  ['客户页内三个视图，顺序为 看板 / 列表 / 任务；空列不放占位文字',
    (() => {
      const i = c.indexOf('function CustomersPage(');
      const seg = i >= 0 ? c.slice(i, i + 1200) : '';
      const order = ["key: 'board-customer'", "key: 'list'", "key: 'board-item'"].map((k) => seg.indexOf(k));
      return order.every((x) => x >= 0) && order[0] < order[1] && order[1] < order[2] && !c.includes('（空）');
    })()],
  ['客户三个视图都能新建：看板与列表「新建客户」、任务「新建任务」',
    c.includes("onClick: p.onCreateEngagement }, '新建客户')") && c.includes("onClick: p.onCreate }, '新建客户')")
    && c.includes("onClick: p.onCreateItem }, '新建任务')")],
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
  ['未就绪页：标题「需要重启 DSH」+ 一句原因 + 只给重试（技术原因收在「详细信息」里）',
    c.includes("t('compatTitle')") && c.includes("compatTitle: '需要重启 DSH'") && c.includes("t('compatRetry')")
    && c.includes("className: 'fde-compat-detail'") && !c.includes('function ClassicApp(')],
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
    c.includes('招采数据暂时用不了：需要安装并启用「招采雷达」插件。') && c.includes('available') && c.includes('BidUnavailable')],
  ['招采结果列表关系徽章齐全（采购/中标/候选/提及/招标）',
    ["bidRelBuyer", "bidRelWinner", "bidRelCandidate", "bidRelMention", "bidRelTender"].every((k) => c.includes("'" + k + "'"))],
  ['原文链接新窗口 + rel=noreferrer',
    /target: '_blank', rel: 'noreferrer noopener'/.test(c)],
  ['金额只展示原文（不换算/不求和）',
    c.includes("t('bidAmountTip')") && c.includes('金额是公告原文，没有换算') && !/\.amount[^\n]{0,40}toLocaleString/.test(c)],
  ['客户抽屉招采区（统计/加入跟进/关联/取消关联）',
    c.includes('bidsBlock') && c.includes("t('bidAddFollowup')") && c.includes("t('bidLink')") && c.includes("t('bidUnlink')")],
  ['看板卡片招采徽章条件（total>0 且 available）',
    /bids\.available && bids\.total > 0/.test(c) && c.includes("'招采 ' + bids.total")],
  ['导入链接仅探测到 bid-intel 时显示',
    c.includes("appUrl('bidintel/api/status')") && c.includes("appUrl('bidintel/api/import-url')") && c.includes('importReady === true')],
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
  ['阶段指南的阶段条：阶段名 + 当前客户数（不再有装饰性的状态点）',
    ['processClientCountSuffix', 'fde-flow-step'].every((k) => c.includes(k)) && !c.includes('fde-flow-gate-dot')],
  ['阶段指南详情：要达成 / 要做的事 / 开始前要有 / 要交出来的 / 容易踩的坑 / 进入条件 / 可以用的',
    ['processGoal', 'processInputs', 'processActivities', 'processOutputs', 'processTools',
      'processPitfalls', 'processGate', 'processGateManual'].every((k) => c.includes("t('" + k + "')"))],
  ['阶段指南的进入条件：材料与确认项合成一张清单',
    c.includes('const gateItems = gate') && c.includes('manual: true') && c.includes('manual: false')],
  ['流程工具 chips：method/template 跳方法页（onOpenMethod）',
    c.includes("tool.kind === 'method' || tool.kind === 'template'") && c.includes('onOpenMethod')],
  ['阶段指南的技能与工具：点一下就复制一句能粘贴到会话的话（复制不了时展开给人手动复制）',
    c.includes("tool.kind === 'skill'") && c.includes("t('processHowTo')") && c.includes("t('processCopied')")
    && c.includes('copyExample(tool)') && c.includes('setOpenTool(tool.key)')],
  ['流程工具 chips：library 跳资料库',
    c.includes("tool.kind === 'library'") && c.includes('onOpenLibrary')],
  ['阶段 × 工具矩阵已移除（每个阶段自己的清单已包含同样信息；ADR 0010 D8）',
    !c.includes('processMatrixTitle') && !c.includes('fde-matrix') && !c.includes('toolCols')],
  ['从客户抽屉「这个阶段怎么做」直达对应阶段的指南',
    c.includes('onOpenGuide') && c.includes('initialStage') && c.includes('guideJump')],
  ['方法正文用 Markdown 渲染（不显示 md 源码）',
    c.includes("className: 'fde-pv-md fde-method-body'") && c.includes("renderMarkdown(body.body, '')")],
  ['meta 缺 playbook 时提示宿主未升级（不白屏）',
    c.includes('processNoPlaybook') && c.includes('hasPlaybook')],
  ['方法页支持 initialName/initialSeq（流程页直达打开文件）',
    c.includes('initialName') && c.includes('initialSeq') && c.includes('methodJump')],
  ['流程 CSS 走 --fde-* 语义 token（明暗自适应）',
    /\.fde-flow-/.test(c) && /var\(--fde-/.test(c)],

  /* ---- 6d. 页头（ADR 0010 D10）：全局刷新只在页头一处；不再有标语与 AI 权限徽章 ---- */
  ['页头：全局刷新只有页头图标按钮一处（title 与 aria-label 各引用一次文案）',
    (() => {
      const n = (c.match(/t\('refresh'\)/g) || []).length;
      return n === 2 && /title: t\('refresh'\),\s*'aria-label': t\('refresh'\),/.test(c);
    })()],
  ['页头：没有标语，也没有 AI 权限徽章（它是设置项，不是常驻状态）',
    !c.includes('AutonomyBadge') && !c.includes('fde-autonomy') && !c.includes('fdeTagline') && !c.includes('fde-subtitle')],

  /* ---- 6e. v1.5.0 只读演示模式（ADR 0006 / spec §8.8） ---- */
  ['示例数据：内置示例客户 / 任务 / 动态与今日内容（4 示例客户跨 4 阶段 + 3 任务 + 2 件待我处理 + 4 条动态）',
    c.includes('const DEMO_ENGAGEMENTS') && c.includes('const DEMO_ITEMS') && c.includes('const DEMO_ACTIVITY') && c.includes('const DEMO_BRIEF')
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
  ['示例数据：设置页状态 + 显示示例（demoDismissed:false；已经有客户时这一组不显示）',
    c.includes("t('demoCardTitle')") && c.includes("patch: { demoDismissed: false }")
    && c.includes('onDemoRestore')],
  ['空状态给下一步：新建客户 / 导入已有文件夹 / 看示例（三个按钮，不再用文字分步解释）',
    c.includes("t('demoOnboardTitle')") && c.includes("onClick: p.onCreate }, '新建客户')")
    && c.includes("onClick: p.onScanNow }, t('scanNow'))") && c.includes("t('demoStepRestore')")
    && !c.includes('fde-onboard-step')],

  /* ---- 6f. v2.0 可交付版（ADR 0010 / spec §22） ---- */
  ['v2 字典完整：每个被引用的文案 key 都有非空文案（缺 key 不会显示成 key 名）',
    (() => { try { return checkDict(c).missing.length === 0; } catch (e) { return false; } })()],
  ['v2 字典没有废弃项（没被引用的 key 已清理）',
    (() => { try { return checkDict(c).unused.length === 0; } catch (e) { return false; } })()],
  ['v2 面板禁词：给人看的中文文案里没有内部用语与内部标识',
    findBannedWords(c).length === 0],
  ['v2 不显示内部标识：对象编号 / 检查项 key / 规则编号都不渲染',
    !c.includes("className: 'fde-gate-key'") && !/className: 'fde-dim' \}, eng\.id\)/.test(c)
    && !/className: 'fde-dim' \}, it\.id\)/.test(c) && !/pr\.ruleId \? Chip/.test(c)
    && !c.includes("h('span', { className: 'fde-code' }, it.sessionId)")],
  ['v2 今日：待我处理不含提醒；与待我处理重复的四类旧提醒不显示',
    c.includes('function todoAttention(') && c.includes("a.kind !== 'proposal'")
    && c.includes('const DERIVED_RULE_IDS = { stall: true, overdue: true, gate_ready: true, review_lag: true }')
    && c.includes('const attention = todoAttention(brief.attention)') && c.includes('const proposals = visibleProposals(brief.proposals)')
    && c.includes('todoAttention(displayBrief && displayBrief.attention).length')],
  ['v2 今日：行标题由结构化字段拼出（不带「种类：」前缀，客户名只出现一次）',
    c.includes('function attentionRowText(') && c.includes('function stripKindPrefix(')
    && c.includes("title.indexOf(customer) === -1 ? customer : ''")],
  ['v2 提醒的按钮说结果：建跟进任务 / 交给 AI 准备 / 去处理，都能「知道了」',
    c.includes('function proposalActions(') && c.includes("label: t('bidAddFollowup'), kind: 'primary'")
    && c.includes("label: '交给 AI 准备', kind: 'primary'") && c.includes("label: '去处理', kind: 'primary'")
    && c.includes("{ key: 'dismiss', label: t('actDismiss') }") && c.includes('onProposalOpen')],
  ['v2 看板：列均分宽度（最小 132px）；卡片说人话（本阶段第 N 天 / 到期口语 / 待确认 N）',
    c.includes('.fde-col{flex:1 1 0;min-width:132px;') && c.includes('stayText(stay)') && c.includes('dueText(next.due)')
    && c.includes("'待确认 ' + (gate.total - gate.pass)") && !c.includes("'工 ' + artCount") && !c.includes('boardDragHint')],
  ['v2 客户抽屉顺序：下一步 → 阶段与推进条件 → 任务 → 关键人 → 资料 → 招采 → 记录',
    c.includes('children: [nextBlock, stageBlock, itemsBlock, stakeBlock, artBlock, bidsBlock, timelineBlock]')],
  ['v2 客户抽屉：打开即核对推进条件——客户 id 由抽屉传入（子组件的 effect 先于父组件，不能只靠 drawerRef）',
    c.includes('onGateEvaluate: (stage) => guarded.evaluateGate(stage, drawerEngagement.id)')
    && c.includes('const evaluateGate = useCallback(async (stageKey, engagementId) =>')
    && c.includes("const id = str(engagementId) || (d && d.type === 'engagement' ? str(d.id) : '');")],
  ['v2 客户抽屉：材料与确认项一张清单；主按钮在清单下面；破例推进为次级入口',
    c.includes('gateAuto.map(gateAutoRow)') && c.includes('manualDefs.map(gateManualRow)')
    && c.includes("'交给 AI 准备材料'") && c.includes("'进入「' + nextStage.label + '」'") && c.includes("t('drawerGateForce')")],
  ['v2 抽屉里的保存按钮只在有改动时出现（下一步 / 推进条件确认 / 关键人 / 任务字段）',
    c.includes('const nextDirty =') && c.includes('const stakeDirty =') && /nextDirty\s*\? h\('div'/.test(c)
    && /stakeDirty\s*\? h\('div'/.test(c) && /dirty\s*\? h\(Btn, \{ small: true, kind: 'primary', onClick: saveChecks \}/.test(c)],
  ['v2 任务抽屉：等你处理的问题在最上面；进展用人话；底部「交给 AI」',
    c.includes('children: [attentionBlock, fields, reportsBlock]') && c.includes('const REPORT_KIND_LABELS = {')
    && c.includes("ready: '做完了，等验收'")],
  ['v2 新建任务：负责人是三选一（不再是会被拒绝的自由文本）',
    c.includes("owner: owner || 'human',") && c.includes("const [owner, setOwner] = useState('human');")],
  ['v2 设置：五组（AI 权限 / 提醒 / 数据来源 / 示例数据 / 运行状态），改了就存',
    c.includes('const savePatch = async (key, patch) =>') && c.includes("t('settingsAutonomy')") && c.includes("title: t('todayProposals')")
    && c.includes("title: '数据来源'") && c.includes("t('demoCardTitle')") && c.includes("t('settingsHealth')")
    && !c.includes("t('settingsSave')")],
  ['v2 设置：AI 权限两档（auto 与 assisted 合并显示，不主动改写已有的 auto）',
    c.includes("const assistedKey = savedAutonomy === 'auto' ? 'auto' : 'assisted';") && c.includes('const modeOptions = [')],
  ['v2 设置：不再显示两个没有效果的开关与只读的规则清单',
    !c.includes('目录监听') && !c.includes('打开即出简报') && !c.includes("t('settingsRules')")],
  ['v2 存量记录显示时替换旧用语（只影响显示，不改写看板文件）',
    c.includes('function humanizeLog(') && c.includes('const LOG_REPLACEMENTS = [') && c.includes('humanizeLog(e.text)')
    && c.includes('humanizeLog(a.text)')],

  /* ---- 6g. DSH 0.2.1 的地址与样式约定（docs/02-plan.md §11.5） ---- */
  ['接口地址按文档 base 解析（支持带前缀的代理与 dsh-app://；没有 base 时退回根路径）',
    c.includes('function appUrl(rel)') && c.includes('document.baseURI') && c.includes("return '/' + path;")
    && c.includes("appUrl('api/file')") && !/fetch\('\/|getJSON\('\/|postJSON\('\//.test(c)],
  ['样式标签与模块 id 一致（data-plugin = dsh-fde）',
    c.includes("styleEl.setAttribute('data-plugin', 'dsh-fde')")],
  ['侧边栏图标使用 DSH 传入的 size',
    c.includes('const Icon = function (props)') && c.includes('Number(props.size)')],
  ['焦点环用官方变量；滚动条交给 DSH 的全局样式；胶囊圆角配 corner-shape:round；顶栏可拖动窗口',
    c.includes('var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,') && !c.includes('::-webkit-scrollbar')
    && !/border-radius:999px(?!;corner-shape:round)/.test(c) && c.includes("'data-window-drag': ''")],
  ['招采外链只渲染 http(s) 地址',
    (c.match(/isSafeUrl\((?:item|link)\.url\)\s*\? h\('a'/g) || []).length === 4],

  /* ---- 7. 约束 ---- */
  ['不 import @deepseek-ai/*', !c.includes('@deepseek-ai')],
  ['不写 localStorage 作为事实源', !c.includes('localStorage') && !c.includes('sessionStorage')],
  ['不使用原生 alert/confirm 弹窗', !/\balert\(/.test(c) && !/window\.confirm\(/.test(c)],
  ['只用主题 token 定义配色', /var\(--dsw-alias-/.test(c) && !/(?:^|[;{\s])(?:color|background|border-color)\s*:\s*#/.test(c)],
  ['无语法错误征兆（用 Function 编译整份 bundle）',
    (() => { try { new Function(c); return true; } catch (e) { return false; } })()],
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
