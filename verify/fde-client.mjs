/**
 * FDE 工作站面板静态验收（verify/fde-client.mjs）
 * 用法: node verify/fde-client.mjs
 *
 * 与 client-static.mjs 的分工：client-static 守「模块/注册/旧能力」，
 * 本脚本守「九视图信息架构（含流程 v2 与资料库）、主题 token 纪律、API 前缀、兼容页、
 * 可访问性、拖拽/键盘、破坏性确认、轮询、不白屏」。
 * v1.3：生财页签与 ScysView 已移除（宿主 scys 能力保留），由资料库接替。
 * 全部是对 client.js 的静态断言；运行时行为见 verify/client-runtime.mjs。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = join(ROOT, 'client.js');
const srcPath = join(ROOT, 'src', 'ui', 'ui-panel.js');
const fail = [];
const ok = [];

if (!existsSync(clientPath)) {
  console.log('✗ client.js 未构建（先跑 node build.mjs）');
  process.exit(1);
}
const c = readFileSync(clientPath, 'utf8');
const src = readFileSync(srcPath, 'utf8');

const check = (name, cond, detail) => {
  const pass = !!cond;
  console.log((pass ? '  ✓ ' : '  ✗ ') + name + (pass || !detail ? '' : ' → ' + detail));
  (pass ? ok : fail).push(name);
};

/* ---------- 0. 构建一致性 ---------- */
check('client.js 由 src/ui/ui-panel.js 构建（字节一致）', c === src,
  '先跑 node build.mjs；面板源码与产物已漂移');

/* ---------- 1. 模块与注册契约（spec §16） ---------- */
check("模块 id 与包名一致（dsh-fde；侧栏 panel id 仍为 researchworkbench）", c.includes("id: 'dsh-fde'"));
check("inject 含 slots 与 uiWorkspace", /inject:\s*\[\s*'slots'\s*,\s*'uiWorkspace'\s*\]/.test(c));
check('slots 不可用时显式报错（不静默吞）', c.includes('slots 服务不可用'));
check('sidebar.panellist id=researchworkbench', /id: 'researchworkbench'/.test(c));
check('main key=researchworkbench', /key: 'researchworkbench'/.test(c));
check('Finder 三通道保留（remote.session → /open-in-app → /reveal）',
  c.includes("svc('remote.session')") && c.includes("'/open-in-app/open'") && c.includes("API + '/reveal'"));

/* ---------- 2. 九视图信息架构（spec §8 / §17.7 / §19.6 / §20.5） ---------- */
const views = ['Today', 'Board', 'Customers', 'Process', 'Library', 'Bids', 'Artifacts', 'Methods', 'Settings'];
check('九个视图组件存在', views.every((v) => c.includes('function ' + v + 'View(')));
check('视图路由分支齐全（今日为默认回退）',
  ['board', 'customers', 'process', 'library', 'bids', 'artifacts', 'methods', 'settings']
    .every((v) => c.includes("view === '" + v + "'"))
  && /return h\(TodayView,/.test(c));
check('导航含九项（流程第 4 / 资料库第 5）且带 role=tablist',
  c.includes("role: 'tablist'") && ['tabToday', 'tabBoard', 'tabCustomers', 'tabProcess', 'tabLibrary',
    'tabBids', 'tabArtifacts', 'tabMethods', 'tabSettings'].every((k) => c.includes("t('" + k + "')")));
check('导航顺序：今日/看板/客户/流程/资料库/招采/工件/方法/设置',
  (() => {
    const m = /const navItems = \[([\s\S]*?)\];/.exec(c);
    if (!m) return false;
    return [...m[1].matchAll(/key: '([a-z]+)'/g)].map((x) => x[1]).join(',')
      === 'today,board,customers,process,library,bids,artifacts,methods,settings';
  })());
check('v1.3 已移除生财页签与 ScysView（宿主 scys 能力保留）',
  !c.includes("key: 'scys'") && !c.includes('function ScysView(')
  && !c.includes("fdeGet('/scys/feed')") && !c.includes('fde-scys-'));
check('今日页四块：注意力/建议/焦点/活动',
  ['todayAttention', 'todayProposals', 'todayFocus', 'todayActivity'].every((k) => c.includes("t('" + k + "')")));
check('注意力 8 类 kind 齐全（spec §5）',
  ['blocked', 'decision', 'review', 'answer', 'overdue', 'gate', 'stall', 'proposal']
    .every((k) => c.includes("'" + k + "'")));
check('看板两种模式 + 空列占位', c.includes("t('boardModeCustomer')") && c.includes("t('boardModeTask')") && c.includes('（空）'));
check('客户页表格 + 筛选 + 两段式导入',
  c.includes("className: 'fde-table'") && c.includes("fdePost('/adopt', { action: 'scan' })") && c.includes("fdePost('/adopt', { action: 'apply', dirs })"));
check('工件页复用旧素材/导出/质检能力',
  c.includes("API + '/materials'") && c.includes("API + '/material-files?dir='") && c.includes("API + '/upload'") && c.includes("t('artifactsQa')"));
check('方法页复用旧 methods 并列出技能', c.includes("API + '/methods'") && c.includes('skills'));
check('设置页含自主性/停滞/WIP/健康检查/重启提示',
  ['settingsAutonomy', 'settingsStall', 'settingsWip', 'settingsHealth', 'settingsRestart']
    .every((k) => c.includes("t('" + k + "')")));

/* ---------- 3. 阶段/泳道定义从 /fde/meta 读，不硬编码顺序 ---------- */
check('有 /fde/meta 探测与归一化', c.includes("getJSON(FDE + '/meta')") && c.includes('function normalizeMeta('));
check('阶段顺序取自 meta.stages（不写死 key 数组）',
  c.includes('meta.stages') && !/\[\s*['"]lead['"]\s*,\s*['"]discovery['"]/.test(c)
  && !/lead[\s\S]{0,60}discovery[\s\S]{0,60}meeting[\s\S]{0,60}solution/.test(c));
check('任务泳道取自 meta.boardLanes / meta.lanes', c.includes('meta.boardLanes') && c.includes('meta.lanes'));

/* ---------- 4. 主题 token 纪律（只用 --dsw-alias-*，可带浅色回退） ---------- */
const cssMatch = /const CSS = `([\s\S]*?)`;\n/.exec(c);
const css = cssMatch ? cssMatch[1] : '';
check('内联 CSS 存在且注入 style 标签', css.length > 5000 && c.includes("document.createElement('style')") && c.includes('disposeStyle'));
const tokenCount = (css.match(/var\(--dsw-alias-/g) || []).length;
check('CSS 使用主题 token >= 40 处', tokenCount >= 40, 'token 数 ' + tokenCount);
/* 把 var(--dsw-alias-xxx, 浅色回退) 的回退值剥掉，剩余不应出现裸色值。
   回退值允许 #hex 与 rgba()（旧面板就是这么写的浅色回退），但必须挂在 token 后面。 */
const stripped = css
  .replace(/var\(--dsw-alias-[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}\)/g, 'var(TOKEN)')
  .replace(/var\(--dsw-alias-[a-z0-9-]+\s*,\s*rgba?\([^)]*\)\)/g, 'var(TOKEN)');
check('无裸十六进制色值（回退值除外）', !/#[0-9a-fA-F]{3,8}\b/.test(stripped),
  (stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || []).slice(0, 3).join(','));
check('无裸 rgb()/hsl() 色值（回退值除外）', !/\brgba?\(/.test(stripped) && !/\bhsla?\(/.test(stripped),
  (stripped.match(/\brgba?\([^)]*\)/g) || []).slice(0, 3).join(' '));
check('无外部资源引用（@import / url()）', !/@import/.test(css) && !/url\(/.test(css));
check('语义别名 --fde-* 全部由主题 token 派生',
  (css.match(/--fde-[a-z-]+:[^;]+;/g) || []).every((line) => line.includes('var(--dsw-alias-')),
  '存在未走主题 token 的 --fde-* 别名');

/* 颜色类声明必须落在 token/color-mix(var)/语义别名上；transparent/inherit 等关键字放行 */
const COLOR_PROPS = /(?:^|[;{\s])(?:color|background|background-color|border-color|border-top-color|border-bottom-color|outline-color|fill|stroke)\s*:\s*([^;}\n]+)/g;
const ALLOW_KEYWORDS = ['transparent', 'inherit', 'currentcolor', 'currentColor', 'none', 'unset', 'initial'];
const hardColors = [];
let cm;
while ((cm = COLOR_PROPS.exec(css))) {
  const val = cm[1].trim();
  const lower = val.toLowerCase();
  if (val.includes('var(')) continue;
  if (ALLOW_KEYWORDS.some((k) => lower === k.toLowerCase())) continue;
  hardColors.push(val);
}
check('颜色声明全部走 token / color-mix（无硬编码色值）', hardColors.length === 0,
  JSON.stringify(hardColors.slice(0, 3)));

/* ---------- 5. API 前缀与请求层 ---------- */
check("API 前缀唯一的字符串常量", (c.match(/'\/research-workbench\/api'/g) || []).length === 1);
check('FDE 前缀由 API 派生', c.includes("const FDE = API + '/fde'"));
check('fetch 只在统一请求层（2 处）', (c.match(/\bfetch\(/g) || []).length === 2);
check('无绝对 http(s) 地址请求', !/fetch\(\s*['"`]https?:/.test(c));
check('FDE 路由全部走 fdeGet/fdePost', (c.match(/fde(?:Get|Post)\(/g) || []).length >= 25);
check('旧路由仍可用（status/projects/files/materials/methods/scaffold/handoff/upload/reveal）',
  ['/status', '/projects', '/files?dir=', '/materials', '/methods', '/scaffold', '/handoff', '/upload', '/reveal']
    .every((p2) => c.includes("API + '" + p2 + "'") || c.includes("'" + p2 + "'")));
check('错误契约统一处理 {ok:false,reason}', c.includes('ok === false') && c.includes('reason'));

/* ---------- 6. 兼容页 / 经典模式（spec §11、§16.10） ---------- */
check('启动探测 /fde/meta', c.includes("getJSON(FDE + '/meta')"));
check('兼容页关键词与可操作按钮', c.includes('宿主需要重启 DSH 后启用 FDE 看板')
  && c.includes("t('compatRetry')") && c.includes("t('compatClassic')"));
check('不白屏：探测中/兼容页/正常三态都有组件',
  c.includes('function ProbingScreen(') && c.includes('function CompatPage(') && c.includes('function FdeApp('));
check('经典模式保留旧五页签', ['tabNew', 'tabProjects', 'tabFiles', 'tabMaterials', 'tabMethods']
  .every((k) => c.includes("t('" + k + "')")) && c.includes('function ClassicApp('));
check('hasSession:false 时任务文本写剪贴板', c.includes('navigator.clipboard') && c.includes("t('copied')"));

/* ---------- 7. 可访问性 / 拖拽 / 键盘（spec §8.8） ---------- */
check('抽屉 role=dialog + aria-modal', c.includes("role: 'dialog'") && c.includes("'aria-modal': 'true'"));
check('键盘关闭（Escape）', c.includes("e.key === 'Escape'"));
check('卡片可 Tab 聚焦（tabIndex 0）', c.includes('tabIndex: 0'));
check('Enter 打开抽屉', c.includes("e.key === 'Enter'"));
check('Alt+左右方向键换列', c.includes('e.altKey') && c.includes("e.key === 'ArrowLeft'") && c.includes("e.key === 'ArrowRight'"));
check('HTML5 拖拽属性与数据通道', c.includes('onDragStart') && c.includes('onDragOver') && c.includes('onDrop') && c.includes("setData('text/plain'"));
check('拖拽过程有视觉态（dragging/over 类）', c.includes("' dragging'") && c.includes("' over'"));
check('错误/提示有无障碍播报（role=alert / aria-live）', c.includes("role: 'alert'") && c.includes("'aria-live'"));
check('导航用 role=tablist/tab + aria-selected', c.includes("role: 'tablist'") && c.includes("'aria-selected'"));

/* ---------- 8. 抽屉与破坏性确认（spec §8.7、§16.4） ---------- */
check('客户抽屉含阶段步进/门禁清单/下一步/干系人/时间线',
  ['drawerStage', 'drawerGate', 'drawerNext', 'drawerStakeholders', 'drawerTimeline']
    .every((k) => c.includes("t('" + k + "')")));
check('门禁人工项可勾选 + 证据输入', c.includes('checksPayload') && c.includes('drawerGateEvidencePh'));
check('抽屉操作：启动会话/暂停/归档',
  ['drawerStartSession', 'drawerPause', 'drawerArchive'].every((k) => c.includes("t('" + k + "')")));
check('任务抽屉含回报历史/关联会话/删除',
  ['drawerReports', 'drawerSession', 'drawerDelete'].every((k) => c.includes("t('" + k + "')")));
check('门禁未过显示缺项并二次确认强制', c.includes("t('drawerGateMissingTitle')") && c.includes("t('drawerForceReason')"));
check('任务移入 done 需证据文本', c.includes("t('drawerEvidenceTitle')") && c.includes('evidence, force: true'));
check('归档/删除都二次确认（无原生 confirm）',
  c.includes("t('drawerArchiveBody')") && c.includes("t('drawerDeleteBody')") && !/window\.confirm\(/.test(c));

/* ---------- 8b. 招采雷达（spec §17.7 / §17.9.6） ---------- */
check('第 7 页签「招采」存在且位于客户之后',
  /\{ key: 'bids', label: t\('tabBids'\), count: null \}/.test(c));
check('招采 API 全部走 fdeGet/fdePost',
  ["fdeGet('/bids/stats')", "FDE + '/bids/search?", "fdeGet('/bids/match?", "fdePost('/bids/link'", "fdePost('/bids/unlink'", "fdePost('/bids/promote'", "fdePost('/bids/refresh'"]
    .every((x) => c.includes(x)));
check('招采不可用降级文案（不白屏不报错）',
  c.includes('招采雷达未就绪（bid-intel 未装载或未升级）') && c.includes('function BidUnavailable('));
check('客户抽屉招采区：统计徽章 + Top5 + 已关联 + 开关',
  c.includes('bidStatBadges') && c.includes("t('bidMatchTop')") && c.includes("t('bidLinksTitle')") && c.includes("t('bidWatchLabel')"));
check('抽屉匹配列表有加入跟进/关联/查看原文',
  c.includes("t('bidAddFollowup')") && c.includes("t('bidLink')") && c.includes("t('bidOpenSource')"));
check('已关联可取消关联', c.includes("t('bidUnlink')") && c.includes("fdePost('/bids/unlink'"));
check('看板卡片招采徽章仅在 total>0 且 available 时显示',
  /bids\.available && bids\.total > 0/.test(c) && c.includes("'招采 ' + bids.total"));
check('卡片徽章 tooltip 含最近日期', /，最近 ' \+ fmtDay\(b\.latest\)/.test(c));
check('原文链接 target=_blank + rel=noreferrer',
  /target: '_blank', rel: 'noreferrer noopener'/.test(c));
check('金额展示为公告原文（不换算）', c.includes("t('bidAmountTip')"));
check('候选人 ≠ 中标人 口径提示', c.includes('候选人 ≠ 中标人') && c.includes("t('bidCandidatesNote')"));
check('导入链接探测 bid-intel（不可用隐藏）',
  c.includes("'/bidintel/api/status'") && c.includes("'/bidintel/api/import-url'") && c.includes('importReady === true'));
check('设置页招标雷达开关 + 服务状态',
  c.includes("t('bidSettingsLabel')") && c.includes("t('bidServiceStatus')") && c.includes("t('bidServiceNotReady')"));
check('采样口径：抽屉「相关 ≈N（采样 M 条）」文案',
  c.includes('bidRelatedBadgeText') && c.includes("t('bidRelatedApproxPrefix')")
  && c.includes("t('bidSamplePrefix')") && c.includes("t('bidSampleSuffix')"));
check('采样口径：看板 tooltip 含 approxTotal（缺失回退 total）',
  c.includes('bidCardBadgeTitle') && c.includes('approxTotalOf')
  && /approxTotal\s*!=\s*null/.test(c) && /bidCardTitlePrefix/.test(c));
check('approxTotal 字段双路容错（match stats + board bids 摘要）',
  /approxTotal:\s*approxTotalOf\(st,/.test(c) && /approxTotal:\s*approxTotalOf\(b,/.test(c));
check('卡片徽章数字仍用采样 total（不把量级当数字）',
  c.includes("children: '招采 ' + bids.total") && !/children: '招采 ' \+ bids\.approxTotal/.test(c));

check('招采用 theme token（无裸色值）',
  /var\(--dsw-alias-/.test(css) && !/fde-bid[^}]*#[0-9a-fA-F]{3,8}/.test(css));

/* ---------- 8c. FDE 资料库（spec §19.6 / §19.8） ---------- */
check('第 5 页签「资料库」存在且位于流程之后、招采之前',
  /\{ key: 'library', label: t\('tabLibrary'\), count: null \}/.test(c));
check('资料库只读接口走 fdeGet/fdePost（feed / refresh force）',
  c.includes("fdeGet('/library/feed')") && c.includes("fdePost('/library/refresh', { force: true })"));
check('资料库顶部：数据日期 / 更新于 / 总条数 / 来源组计数 / 刷新',
  ['libUpdated', 'libTotalPrefix', 'libGroupIntl', 'libGroupOpen', 'libRefresh'].every((k) => c.includes("t('" + k + "')")));
check('本期重点推荐：featured 前 6 条横向卡片',
  c.includes('libFeaturedTitle') && c.includes('featuredIds') && /\.slice\(0, 6\)/.test(c)
  && c.includes('fde-lib-featured'));
check('筛选：来源组 6 段 + 类型 + 8 阶段 + 搜索 + 仅看推荐 + 排序 3 档',
  ['libGroupAll', 'libGroupIntl', 'libGroupCn', 'libGroupOpen', 'libGroupMethod', 'libGroupCommunity',
    'libKindLabel', 'libStageLabel', 'libSearchPh', 'libFeaturedOnly',
    'libSortRecommend', 'libSortLatest', 'libSortHot'].every((k) => c.includes("t('" + k + "')")));
check('卡片：标题外链 / 发布方 / 类型 + A|B|C / 阶段 chips / 摘要 / 开源指标 / 徽章 / 查看原文',
  ['libKindLabel', 'libAuthA', 'libAuthB', 'libAuthC', 'libStageAll',
    'libNewTag', 'libUpdatedTag', 'libFeaturedBadge', 'libOpen']
    .every((k) => c.includes("t('" + k + "')"))
  && ['fde-lib-title', 'fde-lib-byline', 'fde-lib-auth', 'fde-lib-stages', 'fde-lib-summary',
    'fde-lib-repo', 'fde-lib-foot', 'fde-lib-group'].every((cls) => c.includes(cls)));
check('开源条目显示 stars / license / pushedAt（staticMeta + liveMeta 兼容）',
  c.includes('staticMeta') && c.includes('liveMeta') && c.includes('pushedAt')
  && c.includes("t('libStarsPrefix')") && c.includes("t('libLicenseLabel')") && c.includes("t('libPushedLabel')"));
check('降级：刷新失败旧数据黄条（含上次成功）/ 无缓存空态 / 筛选空态 / catalog 缺失错误行',
  ['libStaleWarn', 'libLastOk', 'libEmptyTitle', 'libEmptyBody', 'libFilterEmpty', 'libCatalogMissing']
    .every((k) => c.includes("t('" + k + "')")));
check('资料库外链安全：isSafeUrl 只放行 https?:// + window.open noopener,noreferrer',
  c.includes('function isSafeUrl(') && /window\.open\([^'\n]*'_blank', 'noopener,noreferrer'\)/.test(c));
check('资料库不注入 HTML（无 dangerouslySetInnerHTML）', !c.includes('dangerouslySetInnerHTML'));
check('资料库刷新按钮 busy 时禁用（防重复点击）',
  /busy: busy/.test(c) && /disabled: busy \|\| loading/.test(c));
check('资料库 CSS 走 --fde-* 语义 token 且无裸色值',
  /\.fde-lib-/.test(css) && /var\(--fde-/.test(css) && !/fde-lib[^}]*#[0-9a-fA-F]{3,8}/.test(css));

/* ---------- 8d. FDE 流程 v2（spec §20.5 / §20.7） ---------- */
check('第 4 页签「流程」存在且位于客户之后、资料库之前',
  /\{ key: 'process', label: t\('tabProcess'\), count: null \}/.test(c));
check('8 阶段从 meta.stages 派生（不硬编码阶段数与顺序）',
  c.includes('asList(meta && meta.stages)') && c.includes('stages.map(stepNode)')
  && !/\[\s*'lead'\s*,\s*'discovery'/.test(c) && !c.includes('7 个阶段') && !c.includes('7 列'));
check('步进条：阶段名 + 当前客户数 + 门禁状态点',
  ['processClientCountSuffix', 'fde-flow-step', 'fde-flow-gate-dot', 'fde-flow-name']
    .every((k) => c.includes(k)));
check('阶段详情：goal / inputs / activities / outputs / tools / pitfalls / 门禁清单',
  ['processGoal', 'processInputs', 'processActivities', 'processOutputs', 'processTools',
    'processPitfalls', 'processGateAuto', 'processGateManual'].every((k) => c.includes("t('" + k + "')")));
check('工具 chips：method/template 跳方法页（onOpenMethod + initialName）',
  c.includes("tool.kind === 'method' || tool.kind === 'template'")
  && c.includes('onOpenMethod') && c.includes('initialName') && c.includes('initialSeq'));
check('工具 chips：skill/tool 展开「在会话中这样用」示例 + 复制',
  c.includes("tool.kind === 'skill'") && c.includes('copyExample')
  && c.includes("t('processHowTo')") && c.includes("t('processCopy')"));
check('工具 chips：library 跳资料库', c.includes("tool.kind === 'library'") && c.includes('onOpenLibrary'));
check('阶段 × 工具矩阵（8 行 × 工具列，只读）',
  c.includes('processMatrixTitle') && c.includes('fde-matrix') && c.includes('toolCols')
  && c.includes('processColStage'));
check('meta 缺 playbook 时提示宿主未升级（不白屏）',
  c.includes('processNoPlaybook') && c.includes('hasPlaybook') && c.includes('processNoMeta'));
check('流程 CSS 走 --fde-* 语义 token 且无裸色值',
  /\.fde-flow-/.test(css) && /var\(--fde-/.test(css) && !/fde-flow[^}]*#[0-9a-fA-F]{3,8}/.test(css));

/* ---------- 8e. v1.3 移除生财（宿主 scys 能力保留） ---------- */
check('生财页签 / ScysView / 专用接口与 CSS 均已移除',
  !c.includes("key: 'scys'") && !c.includes('function ScysView(')
  && !c.includes("fdeGet('/scys/feed')") && !c.includes("t('tabScys')")
  && !c.includes('fde-scys-'));

/* ---------- 9. 轮询 / 状态事实源 / 约束 ---------- */
const poll = /const POLL_MS = (\d+);/.exec(c);
check('轮询间隔在 10–15s', poll && Number(poll[1]) >= 10000 && Number(poll[1]) <= 15000, poll && poll[1]);
check('只有一个轮询定时器（不做第二套引擎）', (c.match(/setInterval\(/g) || []).length === 1);
check('切页签立即刷新（effect 依赖 view）', /\[view, loadBoard, loadBrief\]/.test(c));
check('写操作后以服务端为准重新拉取（refreshAll 调用 >= 8 处）',
  (c.match(/refreshAll\(true\)/g) || []).length >= 8, String((c.match(/refreshAll\(true\)/g) || []).length));
check('不用 localStorage / sessionStorage 存状态', !/localStorage|sessionStorage/.test(c));
check('不 import @deepseek-ai/*', !/@deepseek-ai/.test(c));
check('零第三方 import（只 require("react")）',
  (c.match(/require\(['"][^'"]+['"]\)/g) || []).every((s) => s === "require('react')"));
check('无原生 alert/confirm/prompt 弹窗', !/\balert\(/.test(c) && !/window\.confirm\(/.test(c) && !/window\.prompt\(/.test(c));
check('不使用 JSX（统一 h()）', !/<\s*[A-Z][A-Za-z]*\s+[a-z-]+=/.test(c));

/* ---------- 10. 单文件区块组织（可维护性） ---------- */
const sections = ['一、请求层', '二、设计 token 与 CSS', '三、字典与工具', '四、通用组件',
  '五、今日视图', '六、看板视图', '七、客户视图', '八、工件视图', '九、招采视图',
  '十、资料库视图', '十一、流程视图', '十二、方法视图 / 设置视图', '十三、抽屉',
  '十四、FDE 根组件', '十五、经典模式', '十六、兼容页 / 根组件 / 注册'];
check('按区块注释组织（16 个分区标题）', sections.every((s) => c.includes(s)),
  sections.filter((s) => !c.includes(s)).join('、'));
check('空态/加载/失败态组件齐全',
  ['function Empty(', 'function Loading(', 'function ErrorLine(', 'function MsgLine('].every((s) => c.includes(s)));

/* ---------- 汇总 ---------- */
console.log('\n=== 通过 ' + ok.length + ' 项 ===');
if (fail.length) {
  console.log('=== 失败 ' + fail.length + ' 项 ===');
  fail.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('\nFDE 面板静态验收通过（' + (c.length / 1024).toFixed(1) + ' KB）。');
