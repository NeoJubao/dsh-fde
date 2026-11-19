/**
 * FDE 工作站 · 定义层（唯一事实来源）
 *
 * 阶段、泳道、门禁、类型、注意力顺序、规则清单只在这里定义一次：
 * 宿主 API、agent 工具、提示词、面板（通过 GET /fde/meta）全部从本模块派生。
 * 加/改阶段与门禁时只改本文件（spec §16.5）。
 *
 * 只依赖 node 内置，不 import @deepseek-ai/*。
 */

/** board.json 结构版本；升级时递增并在 fde-store 做拒绝高版本写入。 */
export const SCHEMA_VERSION = 1;

/** 宿主 API 统一前缀（面板探测兼容性也用它）。 */
export const API_PREFIX = '/research-workbench/api/fde/';

/* ============================ engagement 阶段 ============================ */

/** playbook 工具 kind 枚举（spec §20.3）：技能 / 方法 / 模板 / 工具 / 资料库来源组。 */
export const PLAYBOOK_TOOL_KINDS = ['skill', 'method', 'template', 'tool', 'library'];

/**
 * 8 个推进阶段，固定顺序、不可跳阶（force 除外）。
 * gate 指向进入该阶段前必须通过的 GATES key。
 * playbook（spec §20.3）：每阶段目标/输入/关键动作/交付物/工具/常见坑，面板从 /meta 读。
 * 工具矩阵覆盖全部 8 阶段；fde_board / fde_brief / fde_attention 是全程工具，不逐阶段重复；
 * fde_library 每阶段出现一次（按阶段给不同来源组）。
 */
export const ENGAGEMENT_STAGES = [
  {
    key: 'lead', label: '线索', order: 1, gate: 'intake',
    definition: '已识别客户/机会，尚未研究',
    playbook: {
      goal: '识别并登记一个值得跟进的客户机会，写清来源与可检查的下一步',
      inputs: ['公司名与机会来源', '初步接触人信息', '触发信号（招标、招聘、公开讲话等）'],
      activities: [
        '写清公司全称、线索来源和下一步（谁、做什么、什么时候）',
        '建好客户文件夹和项目档案（日期用当天日期）',
        '判断是否值得进入研判：预算、需求、可触达性至少一条成立',
      ],
      outputs: ['00-项目档案.md', 'research/线索来源与初步判断.md'],
      tools: [
        { kind: 'skill', name: 'fde-engagement', label: '客户建档技能' },
        { kind: 'method', name: '00-调研执行流程.md', label: '调研执行流程' },
        { kind: 'template', name: '项目档案模板.md', label: '项目档案模板' },
        { kind: 'tool', name: 'fde_board', label: '客户看板' },
        { kind: 'tool', name: 'fde_library', label: '资料库' },
        { kind: 'library', name: 'method', label: '资料库 · 方法与模板' },
      ],
      pitfalls: [
        '把道听途说当线索：来源必须可追溯（谁说的、哪份公开材料）',
        '没有可检查的下一步就建档，最后变成僵尸客户',
      ],
    },
  },
  {
    key: 'discovery', label: '研判', order: 2, gate: 'discovery',
    definition: '主体锁定、事实核查、KPI/痛点假设',
    playbook: {
      goal: '先锁主体，再做事实核查与 KPI/痛点假设，给出可验证的判断',
      inputs: ['线索登记信息', '公司公告/官网/招聘/采购等原始材料', '能接触到的关键人线索'],
      activities: [
        '主体锁定：地址锚定 + 三链验证，排除同园区他单位',
        '抓取原文并存进客户文件夹，事实按 A/B/C 分级',
        '数字自检：占比重算、分项求和、口径区分、候选人 ≠ 中标人',
        '反推 KPI 与痛点假设：置信度 + 依据 + 可提问验证的问法',
        '查采购史和中标记录，补充经营证据',
      ],
      outputs: ['research/主体锁定与归属核对.md', 'research/事实核查清单.md', 'research/KPI与痛点假设.md'],
      tools: [
        { kind: 'skill', name: 'fde-discovery', label: '研判技能' },
        { kind: 'method', name: '01-事实核查协议.md', label: '事实核查协议' },
        { kind: 'method', name: '02-KPI与痛点假设法.md', label: 'KPI 与痛点假设法' },
        { kind: 'method', name: '数据源清单.md', label: '数据源清单' },
        { kind: 'tool', name: 'fde_bid', label: '招采查询' },
        { kind: 'tool', name: 'fde_library', label: '资料库' },
        { kind: 'library', name: 'intl-official', label: '资料库 · 国外官方' },
      ],
      pitfalls: [
        '主体锁错：把同园区、同集团其他单位当主体，后面全盘皆错',
        '把 C 级（必须现场核实）信息写成结论，未证实清单缺失',
        '拿候选人公示当中标，或把金额口径混用/求和',
      ],
    },
  },
  {
    key: 'meeting', label: '会面', order: 3, gate: 'meeting',
    definition: '会面 Brief、底稿、合作地图',
    playbook: {
      goal: '带着一套现场可用的 Brief、底稿与合作地图见人，拿到可执行的需求清单',
      inputs: ['研判底稿与事实核查清单', 'KPI/痛点假设', '对象层级信息'],
      activities: [
        '按对象层级确定会面目标（一把手讲战略/资产/考核；分管讲可行性/边界；执行层讲场景/数据/工期）',
        '写 Brief（1–2 页可扫读）+ 研判底稿（完整版）+ 合作地图（含「可检查结果 + 卡点」）',
        '明确边界纪律：我们做什么、不做什么；客户有下属数智单位时单列协作原则',
        '会后把候选需求整理成场景池，交接给「场景」阶段',
      ],
      outputs: ['meeting/<客户>面谈Brief.md', 'meeting/<客户>面谈研判底稿（完整版）.md', 'meeting/<客户>合作地图.md', 'scoping/需求池.md'],
      tools: [
        { kind: 'skill', name: 'fde-meeting', label: '会面准备技能' },
        { kind: 'method', name: '03-合作地图构建法.md', label: '合作地图构建法' },
        { kind: 'method', name: '文档模板库.md', label: '文档模板库' },
        { kind: 'tool', name: 'fde_bid', label: '招采查询' },
        { kind: 'tool', name: 'fde_library', label: '资料库' },
        { kind: 'library', name: 'cn-official', label: '资料库 · 国内官方' },
      ],
      pitfalls: [
        '对象层级错配：对执行层讲战略、对一把手讲接口细节',
        '会面后没有场景候选，直接跳方案',
        '把合作地图写成公司介绍，没有「可检查结果 + 卡点」',
      ],
    },
  },
  {
    key: 'scoping', label: '场景', order: 4, gate: 'scoping',
    definition: '需求收敛、场景选择、数据体检、范围与发起人确认',
    playbook: {
      goal: '把需求池收敛到一个 90 天内可上线、可测量、有姓名发起人的场景',
      inputs: ['会面需求清单与场景池', '数据与系统现状', '客户组织与考核信息'],
      activities: [
        '逐个场景过四条硬门槛（有姓名发起人 / 14 天首次集成 / 90 天上线 / 使用可测）',
        '数据体检：数据在哪、谁给、多久能拿到、质量如何；不可得数据写替代方案',
        '按 12 维评分卡打分并逐维写依据（空依据按 3 分封顶），用 Σ(分×权重)/Σ权重 归一化；任一否决项命中 → 不进方案（例外需人签字）',
        '锁定一期范围与「不做什么」，确认发起人愿意每周投入（非挂名）',
        '场景与范围、优先级书面确认后才可进入方案；推进条件由你逐项确认',
      ],
      outputs: ['scoping/场景评估表.md', 'scoping/数据可得性清单.md', 'scoping/范围边界.md'],
      tools: [
        { kind: 'skill', name: 'fde-scoping', label: '场景选择技能' },
        { kind: 'method', name: '06-场景选择与数据体检.md', label: '场景选择与数据体检' },
        { kind: 'template', name: '场景评估表.md', label: '场景评估表' },
        { kind: 'tool', name: 'fde_scenario', label: '场景评估' },
        { kind: 'tool', name: 'fde_library', label: '资料库' },
        { kind: 'library', name: 'opensource', label: '资料库 · 开源工具' },
      ],
      pitfalls: [
        '四个场景都说能做，结果没有主场景、资源摊薄',
        '发起人是礼节性挂名，没人愿意每周投入',
        '14 天对接/90 天上线没人敢承诺，却先写方案',
        '数据拿不到却按能拿到做估算，上线即延期',
      ],
    },
  },
  {
    key: 'solution', label: '方案', order: 5, gate: 'solution',
    definition: '方案、成本测算、报价单/SOW、边界纪律',
    playbook: {
      goal: '把锁定场景写成可执行方案，并给出可复核的成本与报价，写明边界',
      inputs: ['场景评估表与范围边界', '数据可得性清单', '内部成本费率配置（方法默认值，待验证）'],
      activities: [
        '按目标 → 范围（含明确不做）→ 分阶段路径 → 双方分工 → 验收口径 → 风险 写方案',
        '测算成本与报价：三点估算 P80 计价人天、数据评测/云 token/合规/运维等非人力、预备费 15%、毛利 35%、税 6%，产出成本测算与报价单',
        '写明假设、除外、变更条款与验收口径；多对象分层出方案（决策层一页纸 / 执行层技术方案）',
        '对外发送前必须由你确认；AI 只准备材料',
      ],
      outputs: ['proposal/<项目>建设方案.md', 'proposal/成本测算.md', 'proposal/报价单.md'],
      tools: [
        { kind: 'skill', name: 'fde-solution', label: '方案技能' },
        { kind: 'method', name: '07-成本评估与报价.md', label: '成本评估与报价' },
        { kind: 'method', name: '04-领域模型合作方法论.md', label: '领域模型合作方法论' },
        { kind: 'template', name: '成本测算与报价单.md', label: '成本测算与报价单' },
        { kind: 'tool', name: 'fde_quote', label: '成本与报价测算' },
        { kind: 'tool', name: 'fde_library', label: '资料库' },
        { kind: 'library', name: 'intl-official', label: '资料库 · 国外官方' },
      ],
      pitfalls: [
        '报价凭感觉：不算人天、不列非人力，亏损在交付期暴露',
        '云资源/运维/内容/合规漏项（全包项目最常见的吞利润项）',
        '只写做什么不写「不做什么」，范围无边界',
        '未由人确认就对外发送方案或报价',
      ],
    },
  },
  {
    key: 'pilot', label: '试点', order: 6, gate: 'pilot',
    definition: 'Pilot Charter、成功指标、验收口径、价值验证',
    playbook: {
      goal: '用最小范围验证价值，拿到客户确认的、可验收的成功指标',
      inputs: ['方案与首期范围', '基线数据', '双方资源承诺'],
      activities: [
        '写 Pilot Charter：首次集成 ≤14 天、上线 ≤90 天、撤出 ≤120 天 + 成功指标 + 验收口径',
        '定义基线、目标与测量方式，写清数据与资源边界',
        '控制范围：只验证一个假设，不做顺带需求',
        '客户确认与推进条件的确认都由你完成',
      ],
      outputs: ['pilot/Pilot Charter.md', 'pilot/成功指标与验收口径.md'],
      tools: [
        { kind: 'skill', name: 'fde-pilot', label: '试点技能' },
        { kind: 'method', name: '03-合作地图构建法.md', label: '合作地图构建法' },
        { kind: 'method', name: '07-成本评估与报价.md', label: '成本评估与报价' },
        { kind: 'method', name: '06-场景选择与数据体检.md', label: '场景选择与数据体检' },
        { kind: 'tool', name: 'fde_library', label: '资料库' },
        { kind: 'library', name: 'opensource', label: '资料库 · 开源工具' },
      ],
      pitfalls: [
        '成功指标不可测（没有基线/测量方式）',
        '试点范围膨胀，变成小交付',
        '没写撤出条件，失败也退不出来',
      ],
    },
  },
  {
    key: 'delivery', label: '交付', order: 7, gate: 'delivery',
    definition: '实施、验收、风险登记、最小文档集',
    playbook: {
      goal: '按计划交付并可验收，把风险与变更管住',
      inputs: ['Pilot Charter 与验收口径', '实施方案', '变更记录'],
      activities: [
        '实施计划：里程碑、依赖、责任人；变更走书面确认',
        '验收清单逐项可检查（谁验、怎么验、证据是什么）',
        '风险登记：风险、概率、影响、缓解、责任人',
        '最小文档集齐备：Discovery Brief / Pilot Charter / ADR / Go-live Checklist / Incident Runbook / Handoff Pack',
      ],
      outputs: ['delivery/实施计划.md', 'delivery/验收清单.md', 'delivery/风险登记.md'],
      tools: [
        { kind: 'skill', name: 'fde-delivery', label: '交付技能' },
        { kind: 'method', name: '05-正式对外文档交付（DOCX·公文版式）.md', label: '正式对外文档交付' },
        { kind: 'tool', name: 'rw_export_pdf', label: '导出 PDF' },
        { kind: 'tool', name: 'rw_qa_pdf', label: 'PDF 版面检查' },
        { kind: 'tool', name: 'fde_library', label: '资料库' },
        { kind: 'library', name: 'method', label: '资料库 · 方法与模板' },
      ],
      pitfalls: [
        '验收清单不可检查（「效果良好」不算口径）',
        '变更走口头，最后结算扯皮',
        '文档集缺失，交接断层',
      ],
    },
  },
  {
    key: 'adoption', label: '采用', order: 8, gate: 'adoption',
    definition: '培训、使用证据、价值证明、扩展地图',
    playbook: {
      goal: '用证据证明被真正使用并产生价值，规划下一批可复制场景',
      inputs: ['上线后的使用数据', '培训记录', '基线对比材料'],
      activities: [
        '收集使用证据（人群、频次、时长、留存），A/B/C 分级并注明来源',
        '整理培训材料与完成记录',
        '写价值证明：基线对比、可复算口径、不夸大',
        '画扩展地图：下一步可复制场景与前置条件',
      ],
      outputs: ['adoption/使用证据.md', 'adoption/价值证明.md', 'adoption/扩展地图.md'],
      tools: [
        { kind: 'skill', name: 'fde-adoption', label: '采用技能' },
        { kind: 'method', name: '01-事实核查协议.md', label: '事实核查协议' },
        { kind: 'tool', name: 'fde_harvest', label: '复盘草稿' },
        { kind: 'tool', name: 'fde_library', label: '资料库' },
        { kind: 'library', name: 'community', label: '资料库 · 社区动态' },
      ],
      pitfalls: [
        '使用证据靠自述，没有可核对的数据',
        '把「使用」当「价值」，没有基线与口径',
        '扩展地图没有前置条件，下一批照抄必踩坑',
      ],
    },
  },
];

/** 终止状态：不在看板列中；不参与派生注意力。 */
export const TERMINAL_STAGES = [
  { key: 'archived', label: '归档', definition: '不再跟进，保留记录' },
  { key: 'lost', label: '流失', definition: '机会已失去' },
];

/* ============================ item 泳道 ============================ */

/**
 * 泳道：inbox / canceled 不上看板（inbox 在今日处理）。
 * wip: true 的列受 settings.wipLimits 约束（默认 doing=5）。
 * label / definition 是给人看的文本（ADR 0010 D1：任务状态），key 与结构不变。
 */
export const ITEM_LANES = [
  { key: 'inbox', label: '待整理', order: 0, board: false, definition: '刚记下来，还没分类；先在「今日」里整理' },
  { key: 'todo', label: '待开始', order: 1, board: true, definition: '已经想清楚要做，还没开始' },
  { key: 'doing', label: '进行中', order: 2, board: true, wip: true, definition: '正在做；同时进行的数量有上限' },
  { key: 'waiting', label: '等对方', order: 3, board: true, definition: '在等客户、上级或材料，暂时推不动' },
  { key: 'review', label: '待验收', order: 4, board: true, definition: '已经做完，等你验收' },
  { key: 'done', label: '已完成', order: 5, board: true, definition: '有结果，也有依据' },
  { key: 'canceled', label: '已取消', order: 6, board: false, definition: '确定不做了' },
];

/** 看板默认显示的 5 列（顺序固定）：todo → doing → waiting → review → done。 */
export const BOARD_LANES = ITEM_LANES.filter((l) => l.board).map((l) => l.key);

/** item 类型（spec §2.4）。 */
export const ITEM_TYPES = [
  { key: 'research', label: '调研' },
  { key: 'meeting', label: '会面' },
  { key: 'scoping', label: '场景' },
  { key: 'solution', label: '方案' },
  { key: 'pilot', label: '试点' },
  { key: 'delivery', label: '交付' },
  { key: 'adoption', label: '采用' },
  { key: 'followup', label: '跟进' },
  { key: 'admin', label: '杂务' },
];

/** 优先级（排序用 order，数值小=高）。 */
export const PRIORITIES = [
  { key: 'high', label: '高', order: 0 },
  { key: 'normal', label: '中', order: 1 },
  { key: 'low', label: '低', order: 2 },
];

/**
 * 自主性模式（spec §6 / §22.4；界面称「AI 权限」）。
 * assisted 与 auto 的实现相同（applySafeProposals），界面合并显示为同一档；三档 key 都保留。
 * 「小事」的范围以 applySafeProposals 为准，definition 如实描述。
 */
const AUTONOMY_SMALL_THINGS = 'AI 可以给没定下一步的客户补一条待确认的下一步、为新招采公告建跟进任务；其余都要你决定';
export const AUTONOMY_MODES = [
  { key: 'observe', label: '只提醒，由我决定', definition: 'AI 只提醒，不替你改任何东西；每件事都由你决定' },
  { key: 'assisted', label: '小事可以直接处理', definition: AUTONOMY_SMALL_THINGS },
  { key: 'auto', label: '小事可以直接处理', definition: AUTONOMY_SMALL_THINGS },
];

/** 任何模式都不自动执行的红线动作（spec §6；界面称「只能由你决定的事」）。 */
export const RED_LINES = [
  '推进客户阶段',
  '确认推进条件',
  '标记交付或验收完成',
  '导出或发送对外材料',
  '删除客户或任务',
  '修改客户文件夹里的定稿文件',
];

/* ============================ 门禁 ============================ */

/**
 * 门禁定义（spec §2.2）。auto = 宿主计算的自动检查；manual = 人勾选并留证据。
 * auto check type：
 * - field      engagement 字段非空（field 为点路径）
 * - archive    项目目录内存在 00-项目档案.md
 * - artifact   工件匹配：alternatives 任一满足即通过（dir 为空=整个项目目录；match 为正则源）
 * - content    方案文本关键词：alternatives 任一目录下 md 正文命中（dir 为空=整个项目目录）
 * - stakeholders engagement.stakeholders 数量 ≥ min
 * 两类都通过才算 gate pass；force 需人给 reason 并记 forced。
 *
 * 给人看的文本（ADR 0010 D1 / D11，界面称「推进条件」）：
 * - gate.label      「进入「<阶段名>」的条件」
 * - check.label     一句人能看懂的话（不含文件匹配规则、字段名）
 * - check.missingText  auto 检查没通过时的原因（fde-rules 的 detail 直接取它；meta 不输出）
 */
export const GATES = {
  intake: {
    key: 'intake', label: '进入「线索」的条件', stage: 'lead',
    auto: [
      { key: 'company', label: '写了公司全称', missingText: '还没写公司全称', type: 'field', field: 'company' },
      { key: 'source', label: '写了线索来源', missingText: '还没写线索来源', type: 'field', field: 'source.kind' },
      { key: 'next_action', label: '定了下一步', missingText: '还没定下一步', type: 'field', field: 'nextAction.text' },
    ],
    manual: [],
  },
  discovery: {
    key: 'discovery', label: '进入「研判」的条件', stage: 'discovery',
    auto: [
      { key: 'archive', label: '有项目档案', missingText: '客户文件夹里没有项目档案', type: 'archive' },
      { key: 'factcheck', label: '有事实核查清单', missingText: '还没找到事实核查清单', type: 'artifact', alternatives: [{ match: '事实核查' }], min: 1 },
      { key: 'kpi', label: '有 KPI 或痛点假设', missingText: '还没找到 KPI 或痛点假设', type: 'artifact', alternatives: [{ match: 'KPI|痛点' }], min: 1 },
    ],
    manual: [
      { key: 'subject_locked', label: '主体已锁定' },
      { key: 'evidence_graded', label: '事实已分级' },
    ],
  },
  meeting: {
    key: 'meeting', label: '进入「会面」的条件', stage: 'meeting',
    auto: [
      { key: 'brief', label: '有会面 Brief', missingText: '还没找到会面 Brief', type: 'artifact', alternatives: [{ dir: 'meeting', match: 'Brief|brief' }], min: 1 },
      { key: 'stakeholders', label: '至少登记 1 位关键人', type: 'stakeholders', min: 1 },
    ],
    manual: [
      { key: 'meeting_goal', label: '会面目标与对象层级已确认' },
    ],
  },
  scoping: {
    key: 'scoping', label: '进入「场景」的条件', stage: 'scoping',
    auto: [
      {
        key: 'scenario', label: '有场景评估表', missingText: '还没找到场景评估表', type: 'artifact',
        alternatives: [{ dir: 'scoping', match: '场景' }, { dir: 'meeting', match: '场景' }], min: 1,
      },
    ],
    manual: [
      { key: 'sponsor_named', label: '有姓名的业务发起人（愿意每周投入，非礼节性挂名）' },
      { key: 'integration_14d', label: '14 天内可完成首次数据/系统对接' },
      { key: 'poc_90d', label: '90 天内可生产上线并使用' },
      { key: 'usage_measurable', label: '使用行为可测量（有明确人群与频次）' },
      { key: 'criteria_scored', label: '12 维评分卡已打分并逐维写明依据（空依据按 3 分封顶）' },
      { key: 'scenario_locked', label: '场景与范围、优先级已与客户书面确认' },
    ],
  },
  solution: {
    key: 'solution', label: '进入「方案」的条件', stage: 'solution',
    auto: [
      { key: 'proposal', label: '有方案文档', missingText: '还没找到方案文档', type: 'artifact', alternatives: [{ dir: 'proposal' }], min: 1 },
      { key: 'boundary', label: '方案里写明了不做什么', missingText: '方案里还没写明不做什么', type: 'content', alternatives: [{ dir: 'proposal', match: '不做什么|边界' }] },
      {
        key: 'cost', label: '有成本测算', missingText: '还没找到成本测算', type: 'artifact',
        alternatives: [{ dir: 'proposal', match: '成本' }, { match: '成本' }], min: 1,
      },
      {
        key: 'quote', label: '有报价单或工作说明书', missingText: '还没找到报价单或工作说明书', type: 'artifact',
        alternatives: [{ match: '报价|SOW|工作说明书' }], min: 1,
      },
    ],
    manual: [
      { key: 'solution_final', label: '方案已定稿可对外' },
      { key: 'pricing_confirmed', label: '成本与报价已复核，假设/除外/变更条款已列明' },
    ],
  },
  pilot: {
    key: 'pilot', label: '进入「试点」的条件', stage: 'pilot',
    auto: [
      {
        key: 'pilot_md', label: '有试点方案', missingText: '还没找到试点方案', type: 'artifact',
        alternatives: [{ dir: 'pilot' }, { dir: 'proposal', match: '试点|POC|pilot' }], min: 1,
      },
    ],
    manual: [
      { key: 'pilot_scope', label: '范围与成功指标已和客户确认' },
    ],
  },
  delivery: {
    key: 'delivery', label: '进入「交付」的条件', stage: 'delivery',
    auto: [
      {
        key: 'delivery_md', label: '有交付文档', missingText: '还没找到交付文档', type: 'artifact',
        alternatives: [{ dir: 'delivery' }, { dir: 'docs' }], min: 1,
      },
    ],
    manual: [
      { key: 'acceptance', label: '验收清单已和客户确认' },
      { key: 'milestones', label: '里程碑已排定' },
      { key: 'risks', label: '风险登记已建立' },
    ],
  },
  adoption: {
    key: 'adoption', label: '进入「采用」的条件', stage: 'adoption',
    auto: [
      {
        key: 'adoption_evidence', label: '有使用或价值证据', missingText: '还没找到使用或价值证据', type: 'artifact',
        alternatives: [{ dir: 'adoption' }, { dir: 'research', match: '价值|使用证据|培训|扩展' }], min: 1,
      },
    ],
    manual: [
      { key: 'usage_evidence', label: '使用证据已收集' },
      { key: 'training', label: '培训已完成' },
      { key: 'expansion_map', label: '扩展地图已画出' },
    ],
  },
};

/* ============================ 注意力 ============================ */

/** 招采关系（spec §17.3，优先级即数组顺序）：buyer 该单位采购 → winner 客户中标 → candidate 候选人（≠中标）→ mention 全文提及。 */
export const BID_RELATIONS = [
  { key: 'buyer', label: '采购方', order: 1, definition: '这家单位自己发布的采购或招标公告' },
  { key: 'winner', label: '中标', order: 2, definition: '客户是中标人或成交人（只有中标或成交公告才算）' },
  { key: 'candidate', label: '候选人', order: 3, definition: '候选人公示的名次，不是中标' },
  { key: 'mention', label: '提及', order: 4, definition: '公告标题或正文里提到，不代表成交' },
];
export const BID_RELATION_KEYS = BID_RELATIONS.map((x) => x.key);
export const BID_DEFAULT_SIGNAL_DAYS = 30;
export const BID_CACHE_TTL_MS = 5 * 60 * 1000;
export function isBidRelation(key) { return BID_RELATION_KEYS.includes(key); }

/**
 * 派生注意力种类与优先级（spec §5）。数组顺序即排序优先级。
 * 同级：到期日升序 → 优先级（high 先）。
 */
export const ATTENTION_KINDS = [
  { key: 'blocked', label: '卡住了', order: 1, text: '', actions: ['open', 'resolve'], target: 'item' },
  { key: 'decision', label: '等你决定', order: 2, text: '', actions: ['answer', 'accept'], target: 'both' },
  { key: 'review', label: '待验收', order: 3, text: '', actions: ['pass', 'return'], target: 'item' },
  { key: 'answer', label: '等你回复', order: 4, text: '', actions: ['answer'], target: 'both' },
  { key: 'overdue', label: '已逾期', order: 5, text: '', actions: ['reschedule', 'done'], target: 'both' },
  { key: 'gate', label: '等你确认', order: 6, text: '', actions: ['confirm'], target: 'engagement' },
  { key: 'stall', label: '没有进展', order: 7, text: '', actions: ['followup', 'pause'], target: 'engagement' },
  { key: 'proposal', label: '提醒', order: 8, text: '', actions: ['accept', 'dismiss'], target: 'proposal' },
];

/** 显式注意力允许的 kind（写 attention 时校验）。 */
export const ATTENTION_EXPLICIT_KINDS = ['decision', 'blocked', 'answer', 'question'];

/* ============================ 规则清单 ============================ */

/**
 * proposals 规则（spec §6 / §22.2；界面称「提醒」）。kind 取 nudge|create_item|start_session|update_next。
 * safe = 在 assisted/auto 模式下允许自动/一键执行的安全动作。
 * derived = 该情形已由派生注意力（待我处理）覆盖：规则定义保留（meta.rules 仍是 8 条），
 *           但 refreshProposals 不再为它生成提醒，存量的待处理提醒在刷新时自动失效（ADR 0010 D4）。
 * label / condition / detail 是给人看的文本，不含字段名与设置项标识。
 */
export const RULES = [
  {
    ruleId: 'stall', label: '没有进展', kind: 'nudge', safe: true, derived: true,
    condition: '在跟的客户超过设定天数没有任何进展',
    detail: '安排一次跟进，或先暂停这家客户',
  },
  {
    ruleId: 'due_soon', label: '快到期', kind: 'nudge', safe: true,
    condition: '客户的下一步或任务在 2 天内到期',
    detail: '确认能不能按时完成，由谁来做',
  },
  {
    ruleId: 'overdue', label: '已逾期', kind: 'update_next', safe: true, derived: true,
    condition: '客户的下一步或任务已经过了到期日',
    detail: '改期，或标记为已完成',
  },
  {
    ruleId: 'no_next', label: '没定下一步', kind: 'update_next', safe: true,
    condition: '在跟的客户还没有定下一步',
    detail: '写清谁、做什么、什么时候',
  },
  {
    ruleId: 'gate_ready', label: '等你确认', kind: 'start_session', safe: false, derived: true,
    condition: '进入下一阶段的材料已齐、还有事项等你确认，并且在本阶段超过 7 天',
    detail: '逐项确认，或交给 AI 补齐依据',
  },
  {
    ruleId: 'meeting_soon', label: '会面快到了', kind: 'start_session', safe: false,
    condition: '会面类任务在 2 天内到期',
    detail: '可以交给 AI 先准备会面材料',
  },
  {
    ruleId: 'review_lag', label: '验收拖延', kind: 'nudge', safe: false, derived: true,
    condition: '任务做完后超过 3 天还没验收',
    detail: '尽快验收并给出结论',
  },
  {
    ruleId: 'bid_signal', label: '新招采公告', kind: 'create_item', safe: true,
    condition: '开启招采关注后，客户在最近一段时间（默认 30 天）有新的招标或采购公告',
    detail: '可以建一个跟进任务，确认是否和这家客户有关。候选人不等于中标人。',
  },
];

/** proposals 最多保留的 pending 条数（spec §14 噪音缓解）。 */
export const MAX_PENDING_PROPOSALS = 8;

/** 门禁确认停留判定天数（gate 注意力 / gate_ready 规则）。 */
export const GATE_WAIT_DAYS = 7;
/** review 停留判定天数（review_lag）。 */
export const REVIEW_LAG_DAYS = 3;
/** due_soon 提前天数。 */
export const DUE_SOON_DAYS = 2;
/** 同一规则对同一对象的去重窗口（毫秒）。 */
export const PROPOSAL_DEDUPE_MS = 24 * 60 * 60 * 1000;

/** settings 默认值（spec §3）。 */
export const DEFAULT_SETTINGS = {
  autonomy: 'observe',
  stallDays: 14,
  wipLimits: { doing: 5 },
  sources: { folderWatch: true, briefOnOpen: true, bidWatch: true },
  bidSignalDays: 30,
  workdirs: ['research'],
  cacheTtlMs: 5000,
  /* ADR 0006：首次上手只读演示模式。true = 用户已点「开始使用（清除示例）」，
   * 之后空看板不再显示示例；普通布尔设置项，随 board 持久化，不新增状态文件。 */
  demoDismissed: false,
};

/* ============================ 工具函数（派生用） ============================ */

export const STAGE_KEYS = ENGAGEMENT_STAGES.map((s) => s.key);
export const TERMINAL_KEYS = TERMINAL_STAGES.map((s) => s.key);
export const LANE_KEYS = ITEM_LANES.map((l) => l.key);
export const ITEM_TYPE_KEYS = ITEM_TYPES.map((t) => t.key);
export const PRIORITY_KEYS = PRIORITIES.map((p) => p.key);
export const AUTONOMY_KEYS = AUTONOMY_MODES.map((a) => a.key);
export const ATTENTION_ORDER = ATTENTION_KINDS.map((a) => a.key);
export const GATE_KEYS = Object.keys(GATES);
export const RULE_IDS = RULES.map((r) => r.ruleId);
/** derived 规则（不生成提醒；由待我处理覆盖）。 */
export const DERIVED_RULE_IDS = RULES.filter((r) => r.derived === true).map((r) => r.ruleId);

const STAGE_MAP = new Map(ENGAGEMENT_STAGES.map((s) => [s.key, s]));
const TERMINAL_MAP = new Map(TERMINAL_STAGES.map((s) => [s.key, s]));
const LANE_MAP = new Map(ITEM_LANES.map((l) => [l.key, l]));
const GATE_MAP = new Map(Object.entries(GATES));
const ATTENTION_MAP = new Map(ATTENTION_KINDS.map((a) => [a.key, a]));
const RULE_MAP = new Map(RULES.map((r) => [r.ruleId, r]));

/** 是否生命周期阶段（不含终止状态）。 */
export function isStage(key) { return STAGE_MAP.has(key); }
/** 是否终止状态。 */
export function isTerminal(key) { return TERMINAL_MAP.has(key); }
/** engagement.stage 允许值 = 8 阶段 + 2 终止。 */
export function isEngagementStage(key) { return STAGE_MAP.has(key) || TERMINAL_MAP.has(key); }
export function stageDef(key) { return STAGE_MAP.get(key) || TERMINAL_MAP.get(key) || null; }
export function stageLabel(key) { const s = stageDef(key); return s ? s.label : String(key || ''); }
/** 阶段序号（1..8）；终止状态返回 0。 */
export function stageOrder(key) { const s = STAGE_MAP.get(key); return s ? s.order : 0; }
/** 下一阶段 key；无下一阶段返回 ''。 */
export function nextStage(key) {
  const s = STAGE_MAP.get(key);
  if (!s) return '';
  const nxt = ENGAGEMENT_STAGES.find((x) => x.order === s.order + 1);
  return nxt ? nxt.key : '';
}
/** gateState 的键：按阶段 key 存（spec §3 示例；lead 阶段对应 intake 门禁）。
 *  门禁 key → 阶段 key 的映射只在这里写一次。 */
export function gateStateKey(gateKey) {
  const g = GATE_MAP.get(gateKey);
  return g ? g.stage : String(gateKey || '');
}

/** 进入某阶段前要过的门禁 key（终止状态返回 ''）。 */
export function gateKeyOfStage(stage) { const s = STAGE_MAP.get(stage); return s ? s.gate : ''; }
export function gateDef(key) { return GATE_MAP.get(key) || null; }
export function laneDef(key) { return LANE_MAP.get(key) || null; }
export function laneLabel(key) { const l = LANE_MAP.get(key); return l ? l.label : String(key || ''); }
export function isLane(key) { return LANE_MAP.has(key); }
export function isItemType(key) { return ITEM_TYPE_KEYS.includes(key); }
export function isPriority(key) { return PRIORITY_KEYS.includes(key); }
export function isAutonomy(key) { return AUTONOMY_KEYS.includes(key); }
export function isAttentionKind(key) { return ATTENTION_MAP.has(key); }
export function attentionRank(kind) {
  const a = ATTENTION_MAP.get(kind);
  return a ? a.order : 99;
}
export function attentionDef(kind) { return ATTENTION_MAP.get(kind) || null; }
export function ruleDef(ruleId) { return RULE_MAP.get(ruleId) || null; }
export function isRuleId(id) { return RULE_MAP.has(id); }
/** 是否 derived 规则（未知 ruleId 返回 false）。 */
export function isDerivedRule(ruleId) { const r = RULE_MAP.get(ruleId); return !!(r && r.derived === true); }
/** 优先级中文名（未知 key 原样返回）。 */
export function priorityLabel(p) { const hit = PRIORITIES.find((x) => x.key === p); return hit ? hit.label : String(p || ''); }
/** 待我处理分类中文名（未知 kind 原样返回）。 */
export function attentionLabel(kind) { const a = ATTENTION_MAP.get(kind); return a ? a.label : String(kind || ''); }
/** 提醒规则中文名（未知 ruleId 返回「提醒」）。 */
export function ruleLabel(ruleId) { const r = RULE_MAP.get(ruleId); return r ? r.label : '提醒'; }
/** 优先级排序权重（high=0 / normal=1 / low=2 / 未知=3）。 */
export function priorityOrder(p) {
  const hit = PRIORITIES.find((x) => x.key === p);
  return hit ? hit.order : 3;
}
/** WIP 上限（某泳道受约束时返回数字，否则返回 0）。 */
export function wipLimitOf(settings, lane) {
  const lim = settings && settings.wipLimits;
  const v = lim && Number(lim[lane]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 面板 / 工具共用的元数据（GET /fde/meta 的 payload）。
 * 客户端不得硬编码阶段顺序，必须从这里读。
 */
export function meta() {
  return {
    version: SCHEMA_VERSION,
    apiPrefix: API_PREFIX,
    stages: ENGAGEMENT_STAGES.map((s) => ({ ...s })),
    terminalStages: TERMINAL_STAGES.map((s) => ({ ...s })),
    boardLanes: BOARD_LANES.slice(),
    lanes: ITEM_LANES.map((l) => ({ ...l })),
    itemTypes: ITEM_TYPES.map((t) => ({ ...t })),
    priorities: PRIORITIES.map((p) => ({ ...p })),
    autonomyModes: AUTONOMY_MODES.map((a) => ({ ...a })),
    redLines: RED_LINES.slice(),
    /* gates 按**阶段 key** 索引（spec §3 的 gateState 示例按阶段；面板按 stage 取，lead→intake）；
     * gateList 保留按门禁 key 的有序数组（工具/文档/spec §2.2 用）。 */
    gates: Object.fromEntries(ENGAGEMENT_STAGES.map((st) => {
      const g = GATES[st.gate];
      return [st.key, {
        key: g.key,
        label: g.label,
        stage: g.stage,
        auto: g.auto.map((c) => ({ key: c.key, label: c.label, type: c.type })),
        manual: g.manual.map((c) => ({ key: c.key, label: c.label })),
      }];
    })),
    gateList: Object.values(GATES).map((g) => ({
      key: g.key,
      label: g.label,
      stage: g.stage,
      auto: g.auto.map((c) => ({ key: c.key, label: c.label, type: c.type })),
      manual: g.manual.map((c) => ({ key: c.key, label: c.label })),
    })),
    bidRelations: BID_RELATIONS.map((r) => ({ ...r })),
    bidWatch: { relations: BID_RELATION_KEYS.slice(), signalDays: BID_DEFAULT_SIGNAL_DAYS },
    attentionKinds: ATTENTION_KINDS.map((a) => ({ ...a })),
    rules: RULES.map((r) => ({ ...r })),
    defaults: {
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      /* 面板兼容别名（等价 defaults.settings） */
      settingsDefaults: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      gateWaitDays: GATE_WAIT_DAYS,
      reviewLagDays: REVIEW_LAG_DAYS,
      dueSoonDays: DUE_SOON_DAYS,
    },
  };
}
