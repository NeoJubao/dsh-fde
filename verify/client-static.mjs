/**
 * 客户端半静态检查（FDE 工作站面板）
 * 用法: node verify/client-static.mjs
 *
 * 覆盖三类：
 *  1) 包/模块/注册契约（必须保留，破坏即安装不上或面板不出现）
 *  2) 旧能力兼容（Finder 三通道、旧五页签、经典模式）
 *  3) FDE 新能力（九视图、看板拖拽/键盘、抽屉、兼容页、轮询、主题 token、招采雷达、
 *     流程 v2（8 阶段 playbook）、资料库（v1.3））
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

  /* ---- 3. FDE 九视图（v1.1 招采 / v1.3 流程 + 资料库） ---- */
  ['九视图组件存在',
    ['function TodayView(', 'function BoardView(', 'function CustomersView(', 'function ProcessView(',
      'function LibraryView(', 'function BidsView(', 'function ArtifactsView(', 'function MethodsView(',
      'function SettingsView('].every((s) => c.includes(s))],
  ['九视图导航文案齐全（流程 / 资料库 / 招采 / 工件 / 方法 / 设置）',
    ["t('tabToday')", "t('tabBoard')", "t('tabCustomers')", "t('tabProcess')", "t('tabLibrary')",
      "t('tabBids')", "t('tabArtifacts')", "t('tabMethods')", "t('tabSettings')"].every((s) => c.includes(s))],
  ['导航 9 项顺序正确（流程第 4、资料库第 5、招采第 6）',
    (() => {
      const m = /const navItems = \[([\s\S]*?)\];/.exec(c);
      if (!m) return false;
      const order = [...m[1].matchAll(/key: '([a-z]+)'/g)].map((x) => x[1]);
      return order.join(',') === 'today,board,customers,process,library,bids,artifacts,methods,settings';
    })()],
  ['v1.3 已移除生财页签与 ScysView（宿主 scys 能力保留）',
    !c.includes("key: 'scys'") && !c.includes('function ScysView(')
    && !c.includes("fdeGet('/scys/feed')") && !c.includes("t('tabScys')")],
  ['生财专用 CSS 已删除（fde-scys-* 不再出现在面板）',
    !c.includes('.fde-scys-') && !c.includes('fde-scys-card')],
  ['FDE API 前缀统一', c.includes("const FDE = API + '/fde'")],
  ['今日：注意力 + 建议 + 焦点 + 活动',
    ["t('todayAttention')", "t('todayProposals')", "t('todayFocus')", "t('todayActivity')"].every((s) => c.includes(s))],
  ['看板：客户模式 + 任务模式',
    ["t('boardModeCustomer')", "t('boardModeTask')"].every((s) => c.includes(s))],
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

  /* ---- 6. 招采雷达（v1.1，spec §17.7） ---- */
  ['招采页签在导航中（客户之后）',
    /\{ key: 'bids', label: t\('tabBids'\)/.test(c)],
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

  /* ---- 6b. FDE 资料库（v1.3，spec §19.6） ---- */
  ['资料库页签在导航中（流程之后、招采之前）',
    /\{ key: 'library', label: t\('tabLibrary'\), count: null \}/.test(c)],
  ['资料库视图有独立路由分支',
    c.includes("view === 'library'") && /return h\(LibraryView,/.test(c)],
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

  /* ---- 6c. FDE 流程 v2（v1.3，spec §20.5） ---- */
  ['流程页签在导航中（客户之后、资料库之前）',
    /\{ key: 'process', label: t\('tabProcess'\), count: null \}/.test(c)],
  ['流程视图有独立路由分支',
    c.includes("view === 'process'") && /return h\(ProcessView,/.test(c)],
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
