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
        '补齐 company / source / nextAction（谁、做什么、何时）',
        '建立客户卷骨架（00-项目档案.md，日期用本地日期）',
        '判断是否值得进入研判：预算、需求、可触达性至少一条成立',
      ],
      outputs: ['00-项目档案.md', 'research/线索来源与初步判断.md'],
      tools: [
        { kind: 'skill', name: 'fde-engagement', label: 'fde-engagement 技能' },
        { kind: 'method', name: '00-调研执行流程.md', label: '调研执行流程' },
        { kind: 'template', name: '项目档案模板.md', label: '项目档案模板' },
        { kind: 'tool', name: 'fde_board', label: 'FDE 看板' },
        { kind: 'tool', name: 'fde_library', label: 'FDE 资料库' },
        { kind: 'library', name: 'method', label: '资料库·方法与模板' },
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
      inputs: ['线索登记信息', '公司公告/官网/招聘/采购等原始材料', '可触达的干系人线索'],
      activities: [
        '主体锁定：地址锚定 + 三链验证，排除同园区他单位',
        '抓取原文并落 raw/（curl + pdftotext），事实按 A/B/C 分级',
        '数字自检：占比重算、分项求和、口径区分、候选人 ≠ 中标人',
        '反推 KPI 与痛点假设：置信度 + 依据 + 可提问验证的问法',
        '查采购史/中标记录（fde_bid）补经营证据',
      ],
      outputs: ['research/主体锁定与归属核对.md', 'research/事实核查清单.md', 'research/KPI与痛点假设.md'],
      tools: [
        { kind: 'skill', name: 'fde-discovery', label: 'fde-discovery 技能' },
        { kind: 'method', name: '01-事实核查协议.md', label: '事实核查协议' },
        { kind: 'method', name: '02-KPI与痛点假设法.md', label: 'KPI 与痛点假设法' },
        { kind: 'method', name: '数据源清单.md', label: '数据源清单' },
        { kind: 'tool', name: 'fde_bid', label: '招采雷达（客户关联层）' },
        { kind: 'tool', name: 'fde_library', label: 'FDE 资料库' },
        { kind: 'library', name: 'intl-official', label: '资料库·国外官方' },
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
        { kind: 'skill', name: 'fde-meeting', label: 'fde-meeting 技能' },
        { kind: 'method', name: '03-合作地图构建法.md', label: '合作地图构建法' },
        { kind: 'method', name: '文档模板库.md', label: '文档模板库' },
        { kind: 'tool', name: 'fde_bid', label: '招采雷达（客户关联层）' },
        { kind: 'tool', name: 'fde_library', label: 'FDE 资料库' },
        { kind: 'library', name: 'cn-official', label: '资料库·国内官方' },
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
        '逐场景用 fde_scenario 判定四条硬门槛（有姓名发起人 / 14 天首次集成 / 90 天上线 / 使用可测）',
        '数据体检：数据在哪、谁给、多久能拿到、质量如何；不可得数据写替代方案',
        '按 12 维评分卡打分并逐维写依据（空依据按 3 分封顶），用 Σ(分×权重)/Σ权重 归一化；任一否决项命中 → 不进方案（例外需人签字）',
        '锁定一期范围与「不做什么」，确认发起人愿意每周投入（非挂名）',
        '场景与范围、优先级书面确认后才可进入方案；门禁由人勾选',
      ],
      outputs: ['scoping/场景评估表.md', 'scoping/数据可得性清单.md', 'scoping/范围边界.md'],
      tools: [
        { kind: 'skill', name: 'fde-scoping', label: 'fde-scoping 技能' },
        { kind: 'method', name: '06-场景选择与数据体检.md', label: '场景选择与数据体检' },
        { kind: 'template', name: '场景评估表.md', label: '场景评估表' },
        { kind: 'tool', name: 'fde_scenario', label: '场景评估器' },
        { kind: 'tool', name: 'fde_library', label: 'FDE 资料库' },
        { kind: 'library', name: 'opensource', label: '资料库·开源工具' },
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
      inputs: ['场景评估表与范围边界', '数据可得性清单', '定价配置 reference/fde-pricing.json'],
      activities: [
        '按目标 → 范围（含明确不做）→ 分阶段路径 → 双方分工 → 验收口径 → 风险 写方案',
        '用 fde_quote 计算成本与报价：三点估算 P80 计价人天、数据评测/云 token/合规/运维等非人力、预备费 15%、毛利 35%、税 6%，产出成本测算与报价单',
        '写明假设、除外、变更条款与验收口径；多对象分层出方案（决策层一页纸 / 执行层技术方案）',
        '对外发送前必须由人确认；agent 只准备材料',
      ],
      outputs: ['proposal/<项目>建设方案.md', 'proposal/成本测算.md', 'proposal/报价单.md'],
      tools: [
        { kind: 'skill', name: 'fde-solution', label: 'fde-solution 技能' },
        { kind: 'method', name: '07-成本评估与报价.md', label: '成本评估与报价' },
        { kind: 'method', name: '04-领域模型合作方法论.md', label: '领域模型合作方法论' },
        { kind: 'template', name: '成本测算与报价单.md', label: '成本测算与报价单' },
        { kind: 'tool', name: 'fde_quote', label: '成本测算与报价器' },
        { kind: 'tool', name: 'fde_library', label: 'FDE 资料库' },
        { kind: 'library', name: 'intl-official', label: '资料库·国外官方' },
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
        '客户确认与门禁勾选由人完成',
      ],
      outputs: ['pilot/Pilot Charter.md', 'pilot/成功指标与验收口径.md'],
      tools: [
        { kind: 'skill', name: 'fde-pilot', label: 'fde-pilot 技能' },
        { kind: 'method', name: '03-合作地图构建法.md', label: '合作地图构建法' },
        { kind: 'method', name: '文档模板库.md', label: '文档模板库' },
        { kind: 'tool', name: 'fde_library', label: 'FDE 资料库' },
        { kind: 'library', name: 'opensource', label: '资料库·开源工具' },
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
        { kind: 'skill', name: 'fde-delivery', label: 'fde-delivery 技能' },
        { kind: 'method', name: '05-正式对外文档交付（DOCX·公文版式）.md', label: '正式对外文档交付' },
        { kind: 'tool', name: 'rw_export_pdf', label: '按需导出 PDF' },
        { kind: 'tool', name: 'rw_qa_pdf', label: 'PDF 版面质检' },
        { kind: 'tool', name: 'fde_library', label: 'FDE 资料库' },
        { kind: 'library', name: 'method', label: '资料库·方法与模板' },
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
        { kind: 'skill', name: 'fde-adoption', label: 'fde-adoption 技能' },
        { kind: 'method', name: '00-调研执行流程.md', label: '调研执行流程' },
        { kind: 'tool', name: 'fde_harvest', label: '复盘草稿' },
        { kind: 'tool', name: 'fde_library', label: 'FDE 资料库' },
        { kind: 'library', name: 'community', label: '资料库·社区动态' },
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
 */
export const ITEM_LANES = [
  { key: 'inbox', label: '收集箱', order: 0, board: false, definition: '刚捕获、未分类，默认不显示在看板（显示在今日）' },
  { key: 'todo', label: '待办', order: 1, board: true, definition: '已明确、未开始' },
  { key: 'doing', label: '进行中', order: 2, board: true, wip: true, definition: '正在做（WIP 受限）' },
  { key: 'waiting', label: '等外部', order: 3, board: true, definition: '等客户/等上级/等材料，不由我们推进' },
  { key: 'review', label: '待我审', order: 4, board: true, definition: 'agent 或协作者已完成，等人审阅' },
  { key: 'done', label: '已完成', order: 5, board: true, definition: '有结果与证据' },
  { key: 'canceled', label: '已取消', order: 6, board: false, definition: '明确不做' },
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

/** 自主性模式（spec §6）。 */
export const AUTONOMY_MODES = [
  { key: 'observe', label: '只建议', definition: '生成建议，展示「待采纳」；不做任何自动动作' },
  { key: 'assisted', label: '建议+一键执行', definition: '安全动作可一键执行：建 item、改 nextAction、标逾期；门禁/对外材料/删除归档仍需人工确认' },
  { key: 'auto', label: '安全动作自动', definition: '自动执行安全动作；门禁、对外材料、删除归档、阶段推进仍只能人工' },
];

/** 任何模式都不自动执行的红线动作（spec §6）。 */
export const RED_LINES = [
  '推进 engagement 阶段',
  '通过门禁',
  '标记交付/验收完成',
  '导出/发送对外材料',
  '删除客户或任务',
  '修改客户卷定稿文件',
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
 */
export const GATES = {
  intake: {
    key: 'intake', label: '线索准入', stage: 'lead',
    auto: [
      { key: 'company', label: '公司名非空', type: 'field', field: 'company' },
      { key: 'source', label: '来源非空', type: 'field', field: 'source.kind' },
      { key: 'next_action', label: '下一步非空', type: 'field', field: 'nextAction.text' },
    ],
    manual: [],
  },
  discovery: {
    key: 'discovery', label: '研判门禁', stage: 'discovery',
    auto: [
      { key: 'archive', label: '项目档案 00-项目档案.md 存在', type: 'archive' },
      { key: 'factcheck', label: '事实核查 md ≥1', type: 'artifact', alternatives: [{ match: '事实核查' }], min: 1 },
      { key: 'kpi', label: 'KPI 或痛点 md ≥1', type: 'artifact', alternatives: [{ match: 'KPI|痛点' }], min: 1 },
    ],
    manual: [
      { key: 'subject_locked', label: '主体已锁定' },
      { key: 'evidence_graded', label: '事实已分级' },
    ],
  },
  meeting: {
    key: 'meeting', label: '会面门禁', stage: 'meeting',
    auto: [
      { key: 'brief', label: 'meeting/ 下 Brief md ≥1', type: 'artifact', alternatives: [{ dir: 'meeting', match: 'Brief|brief' }], min: 1 },
      { key: 'stakeholders', label: '干系人 ≥1', type: 'stakeholders', min: 1 },
    ],
    manual: [
      { key: 'meeting_goal', label: '会面目标与对象层级已确认' },
    ],
  },
  scoping: {
    key: 'scoping', label: '场景门禁', stage: 'scoping',
    auto: [
      {
        key: 'scenario', label: '场景评估 md ≥1（scoping/ 或历史 meeting/ 场景选择表）', type: 'artifact',
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
    key: 'solution', label: '方案门禁', stage: 'solution',
    auto: [
      { key: 'proposal', label: 'proposal/ 下 md ≥1', type: 'artifact', alternatives: [{ dir: 'proposal' }], min: 1 },
      { key: 'boundary', label: '方案文本含「不做什么」或「边界」', type: 'content', alternatives: [{ dir: 'proposal', match: '不做什么|边界' }] },
      {
        key: 'cost', label: '成本测算 md ≥1（proposal/ 或文件名含「成本」）', type: 'artifact',
        alternatives: [{ dir: 'proposal', match: '成本' }, { match: '成本' }], min: 1,
      },
      {
        key: 'quote', label: '报价单/SOW md ≥1（文件名含「报价」「SOW」「工作说明书」）', type: 'artifact',
        alternatives: [{ match: '报价|SOW|工作说明书' }], min: 1,
      },
    ],
    manual: [
      { key: 'solution_final', label: '方案已定稿可对外' },
      { key: 'pricing_confirmed', label: '成本与报价已复核，假设/除外/变更条款已列明' },
    ],
  },
  pilot: {
    key: 'pilot', label: '试点门禁', stage: 'pilot',
    auto: [
      {
        key: 'pilot_md', label: 'pilot/ 下 md ≥1（或 proposal/ 含试点）', type: 'artifact',
        alternatives: [{ dir: 'pilot' }, { dir: 'proposal', match: '试点|POC|pilot' }], min: 1,
      },
    ],
    manual: [
      { key: 'pilot_scope', label: '范围与成功指标客户确认' },
    ],
  },
  delivery: {
    key: 'delivery', label: '交付门禁', stage: 'delivery',
    auto: [
      {
        key: 'delivery_md', label: 'delivery/ 下 md ≥1（或 docs/）', type: 'artifact',
        alternatives: [{ dir: 'delivery' }, { dir: 'docs' }], min: 1,
      },
    ],
    manual: [
      { key: 'acceptance', label: '验收清单' },
      { key: 'milestones', label: '里程碑' },
      { key: 'risks', label: '风险登记' },
    ],
  },
  adoption: {
    key: 'adoption', label: '采用门禁', stage: 'adoption',
    auto: [
      {
        key: 'adoption_evidence', label: 'adoption/ 下 md ≥1（或 research/ 含价值证明）', type: 'artifact',
        alternatives: [{ dir: 'adoption' }, { dir: 'research', match: '价值|使用证据|培训|扩展' }], min: 1,
      },
    ],
    manual: [
      { key: 'usage_evidence', label: '使用证据' },
      { key: 'training', label: '培训完成' },
      { key: 'expansion_map', label: '扩展地图' },
    ],
  },
};

/* ============================ 注意力 ============================ */

/** 招采关系（spec §17.3，优先级即数组顺序）：buyer 该单位采购 → winner 客户中标 → candidate 候选人（≠中标）→ mention 全文提及。 */
export const BID_RELATIONS = [
  { key: 'buyer', label: '采购方', order: 1, definition: '该单位发布的采购/招标公告（buyer 命中）' },
  { key: 'winner', label: '中标', order: 2, definition: '我们的客户是中标人/成交人（只有中标/成交公告才算）' },
  { key: 'candidate', label: '候选人', order: 3, definition: '候选人公示名次，**不是中标**' },
  { key: 'mention', label: '提及', order: 4, definition: '公告全文/标题提及，不构成成交' },
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
  { key: 'blocked', label: '受阻', order: 1, text: '受阻：', actions: ['open', 'resolve'], target: 'item' },
  { key: 'decision', label: '需要决定', order: 2, text: '需要决定：', actions: ['answer', 'accept'], target: 'both' },
  { key: 'review', label: '待审阅', order: 3, text: '待审阅：', actions: ['pass', 'return'], target: 'item' },
  { key: 'answer', label: '需要回答', order: 4, text: '需要回答：', actions: ['answer'], target: 'both' },
  { key: 'overdue', label: '逾期', order: 5, text: '逾期', actions: ['reschedule', 'done'], target: 'both' },
  { key: 'gate', label: '门禁待确认', order: 6, text: '门禁待确认：', actions: ['confirm'], target: 'engagement' },
  { key: 'stall', label: '停滞', order: 7, text: '停滞', actions: ['followup', 'pause'], target: 'engagement' },
  { key: 'proposal', label: '建议', order: 8, text: '', actions: ['accept', 'dismiss'], target: 'proposal' },
];

/** 显式注意力允许的 kind（写 attention 时校验）。 */
export const ATTENTION_EXPLICIT_KINDS = ['decision', 'blocked', 'answer', 'question'];

/* ============================ 规则清单 ============================ */

/**
 * proposals 规则（spec §6）。kind 取 nudge|create_item|start_session|update_next。
 * safe = 在 assisted/auto 模式下允许自动/一键执行的安全动作。
 */
export const RULES = [
  {
    ruleId: 'stall', label: '停滞', kind: 'nudge', safe: true,
    condition: '活跃阶段停留 > stallDays 且无近期活动',
    detail: '建议：安排一次跟进，或标记暂停',
  },
  {
    ruleId: 'due_soon', label: '即将到期', kind: 'nudge', safe: true,
    condition: 'nextAction 或 item 2 天内到期',
    detail: '建议：确认下一步动作与负责人',
  },
  {
    ruleId: 'overdue', label: '已逾期', kind: 'update_next', safe: true,
    condition: 'nextAction 或 item 已逾期',
    detail: '建议：改期或标记完成',
  },
  {
    ruleId: 'no_next', label: '缺下一步', kind: 'update_next', safe: true,
    condition: '活跃客户无 nextAction',
    detail: '建议：补一个可检查的下一步',
  },
  {
    ruleId: 'gate_ready', label: '门禁可确认', kind: 'start_session', safe: false,
    condition: '自动检查全过、人工项缺失、阶段停留 > 7 天',
    detail: '建议：发起会话补齐门禁证据',
  },
  {
    ruleId: 'meeting_soon', label: '会面临近', kind: 'start_session', safe: false,
    condition: 'meeting 类 item 48 小时内到期',
    detail: '建议：发起会面材料会话',
  },
  {
    ruleId: 'review_lag', label: '审阅滞后', kind: 'nudge', safe: false,
    condition: 'item 在 review 停留 > 3 天',
    detail: '建议：尽快审阅并给出结论',
  },
  {
    ruleId: 'bid_signal', label: '招采信号', kind: 'create_item', safe: true,
    condition: 'settings.sources.bidWatch=true 且近 bidSignalDays 天该客户有新招标/采购公告（关系 buyer/mention）',
    detail: '建议：建跟进任务，确认公告是否与客户经营相关（候选人≠中标人；批次为推断）',
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
