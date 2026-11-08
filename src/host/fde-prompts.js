/**
 * FDE 工作站 · 交接提示词
 *
 * 按阶段 / intent 生成 handoff 提示词（spec §9）。固定包含：
 * ① 角色与唯一编排声明
 * ② 客户上下文（名称、目录、阶段、缺的门禁、下一步）
 * ③ 要加载的技能与方法
 * ④ 产物落盘路径与命名
 * ⑤ 回报要求（fde_item report，≤300 字摘要 + 文件路径）
 *
 * 纯字符串生成，不读写文件、不发会话。
 */
import * as schema from './fde-schema.js';

/** 阶段任务模板：产物路径与命名口径集中在此。 */
export const STAGE_GUIDES = {
  lead: {
    skill: 'fde-engagement',
    methods: ['methods/00-调研执行流程.md'],
    goal: '线索准入：确认客户基本盘与来源，写出可检查的下一步',
    steps: [
      '补齐客户字段：company（工商全称）、source（线索来源）、nextAction（谁、做什么、何时）',
      '若还没有客户目录，先按 research/<公司简称>-<本地日期>/ 建立项目骨架（用 rw_scaffold，不要手写目录名日期）',
      '把线索来源与初步判断写入 00-项目档案.md，不要编造未证实的结论',
      '门禁确认后由人推进到「研判」阶段；你不要自行改阶段',
    ],
    artifacts: ['00-项目档案.md', 'research/线索来源与初步判断.md'],
  },
  discovery: {
    skill: 'fde-discovery',
    methods: ['methods/00-调研执行流程.md', 'methods/01-事实核查协议.md', 'methods/02-KPI与痛点假设法.md', 'reference/数据源清单.md', 'reference/雷区清单.md'],
    goal: '研判：先锁主体，再做事实核查与 KPI/痛点假设',
    steps: [
      '主体锁定：地址锚定 + 三链验证（子公司自述 / 母公司成员清单 / 排除链，排除链要核验全部分页）；三链不全降级为「待现场确认」并准备两种情形',
      '抓取：用 bash 的 curl（scripts/grab.py）取原文，PDF 用 pdftotext -layout 落 raw/；不要用 web_fetch 取正文',
      '事实分级：A（官方一手原文）/ B（二手或推算）/ C（必须现场核实），C 级单列未证实清单，不得作为事实陈述',
      '数字自检：占比重算、分项求和校验、口径区分（估算/控制价/成交价）、候选人 ≠ 中标人',
      'KPI 与痛点假设：用对方公开动作反推考核压力，每条标注置信度 + 依据 + 可提问验证的问法，明确写「本节全部为假设」',
      '产物落盘：research/主体锁定与归属核对.md、research/事实核查清单.md、research/KPI与痛点假设.md',
    ],
    artifacts: ['research/主体锁定与归属核对.md', 'research/事实核查清单.md', 'research/KPI与痛点假设.md', 'raw/（原文）'],
  },
  meeting: {
    skill: 'fde-meeting',
    methods: ['methods/00-调研执行流程.md', 'methods/03-合作地图构建法.md', 'reference/文档模板库.md', 'reference/雷区清单.md'],
    goal: '会面：一套现场可用的 Brief + 底稿 + 合作地图，并带回可收敛的场景池',
    steps: [
      '确认会面目标与对象层级（一把手讲战略/资产/考核；分管副总讲技术可行性与责任边界；执行层讲场景/数据/工期）',
      '写 Brief（现场用，1–2 页可扫读）+ 研判底稿（完整版，前一晚通读）+ 合作地图（按业务方向分组，每项含「可检查结果 + 卡点」）',
      '合作地图必须写明「我们不做什么」（边界纪律）；若客户已有下属数智单位，单列关系设计与协作原则',
      '未确认的称谓用中性称呼（「院领导」「贵单位领导」），不夸大合作方层级，不假设未证实的项目关系',
      '会后交接：把候选需求整理成需求池（scoping/需求池.md），交给「场景」阶段用 fde_scenario 筛；不要直接跳方案',
      '全部写 md：meeting/<客户>面谈Brief.md、meeting/<客户>面谈研判底稿（完整版）.md、meeting/<客户>合作地图.md',
    ],
    artifacts: ['meeting/<客户>面谈Brief.md', 'meeting/<客户>面谈研判底稿（完整版）.md', 'meeting/<客户>合作地图.md', 'scoping/需求池.md'],
  },
  scoping: {
    skill: 'fde-scoping',
    methods: ['methods/06-场景选择与数据体检.md', 'methods/02-KPI与痛点假设法.md', 'reference/雷区清单.md'],
    goal: '场景：把需求池收敛到一个可启动、可测量、有发起人的场景',
    steps: [
      '逐场景用 `fde_scenario`（action=evaluate）按四条硬门槛判定：有姓名发起人 / 14 天内首次集成 / 90 天内生产上线 / 使用可测量；任一不满足 → 结论「暂不启动」并列出缺项',
      '数据体检：数据在哪、谁提供、多久能拿到、质量如何；拿不到的数据要写替代方案，不要假设能拿到',
      '按 12 维评分卡（1–5 分）逐维打分并写明依据（空依据按 3 分封顶），归一化分 = Σ(分×权重)/Σ权重(101)，**不得除以 100**；任一否决项（1–7）命中 → 不进方案（例外需人签字）',
      '档位：归一化分 ≥3.6 且门槛全过且无否决 → 进方案；3.2–3.6 → 补证/小 POC；<3.2 → 拒绝或转咨询。评分只用于排序，不替代人的判断',
      '收敛范围：一期只做一个可上线场景，写清「不做什么」；确认发起人愿意每周投入（非礼节性挂名）',
      '产物落盘 scoping/：场景评估表、数据可得性清单、范围边界；门禁人工项由人勾选，你不要自行推进阶段',
    ],
    artifacts: ['scoping/场景评估表.md', 'scoping/数据可得性清单.md', 'scoping/范围边界.md'],
  },
  solution: {
    skill: 'fde-solution',
    methods: ['methods/03-合作地图构建法.md', 'methods/04-领域模型合作方法论.md', 'methods/07-成本评估与报价.md', 'reference/文档模板库.md'],
    goal: '方案：能对外讲清「做什么、怎么落地、边界在哪、要多少钱」的正式方案',
    steps: [
      '从场景评估表收敛为方案：目标 → 范围（含明确不做）→ 分阶段路径 → 双方分工 → 验收口径 → 风险',
      '成本与报价必做：用 `fde_quote`（action=calculate）算成本——三点估算 P80 计价人天、数据评测/云 token/合规/运维等非人力、预备费/税/毛利，产出成本测算与报价单；`reference/fde-pricing.json` 是内部成本费率，不代表对外报价',
      '写明假设、除外、变更条款与验收口径；报价区间与甜点区只是风险提示，最终定价由人确认',
      '必须写明「我们不做什么」（边界纪律），并给出首期最小可交付范围',
      '需要多版本时按对象分层（决策层一页纸 / 执行层技术方案），版本间保持口径一致',
      '方案正文先 md 落在 proposal/；PDF/DOCX 只有在用户明确要求递交/打印时才导出到 exports/',
      '对外发送前必须由人确认（红线：agent 不得自行对外发送或修改定稿）',
    ],
    artifacts: ['proposal/<项目>建设方案.md', 'proposal/成本测算.md', 'proposal/报价单.md', 'proposal/<项目>一页纸.md'],
  },
  pilot: {
    skill: 'fde-pilot',
    methods: ['methods/03-合作地图构建法.md', 'reference/文档模板库.md'],
    goal: '试点：范围受控、指标可验收的 POC 方案',
    steps: [
      '写 Pilot Charter 三条时间门限：首次集成 ≤14 天、生产上线 ≤90 天、撤出 ≤120 天',
      '写清试点假设：验证什么、成功指标（基线/目标/测量方式）、范围与不做什么、时间盒',
      '数据与资源边界要写实：客户提供什么、我们投入什么、不承诺额外资源',
      '产物落盘 pilot/：Pilot Charter、成功指标、验收口径',
      '客户确认与门禁勾选由人完成',
    ],
    artifacts: ['pilot/Pilot Charter.md', 'pilot/成功指标与验收口径.md'],
  },
  delivery: {
    skill: 'fde-delivery',
    methods: ['methods/00-调研执行流程.md', 'methods/05-正式对外文档交付（DOCX·公文版式）.md'],
    goal: '交付：可检查的实施计划、验收清单与风险登记',
    steps: [
      '实施计划：里程碑、依赖、责任人、变更走确认流程',
      '验收清单：逐项可检查（谁验、怎么验、证据是什么）',
      '风险登记：风险、概率、影响、缓解、责任人',
      '产物落盘 delivery/；对外材料由人确认后交付',
    ],
    artifacts: ['delivery/实施计划.md', 'delivery/验收清单.md', 'delivery/风险登记.md'],
  },
  adoption: {
    skill: 'fde-adoption',
    methods: ['methods/00-调研执行流程.md', 'reference/数据源清单.md'],
    goal: '采用：使用证据、培训完成、价值证明与扩展地图',
    steps: [
      '收集使用证据（A/B/C 分级，注明来源与时间）',
      '整理培训材料与完成记录',
      '写价值证明：基线对比、可复算的口径、不夸大',
      '画扩展地图：下一步可复制场景与前置条件',
      '产物落盘 adoption/',
    ],
    artifacts: ['adoption/使用证据.md', 'adoption/价值证明.md', 'adoption/扩展地图.md'],
  },
  archived: {
    skill: 'fde-harvest',
    methods: ['methods/00-调研执行流程.md'],
    goal: '复盘：把事实复盘与方法沉淀分开',
    steps: [
      '事实复盘进客户卷（发生了什么、为什么、下次怎么做）',
      '方法沉淀进插件仓 docs/retros/ 与 methods/reference（脱敏，不写死客户信息）',
      '用 fde_harvest 生成复盘草稿，人审后再归档',
    ],
    artifacts: ['复盘草稿（research/.fde/drafts/）'],
  },
  lost: {
    skill: 'fde-harvest',
    methods: ['methods/00-调研执行流程.md'],
    goal: '流失复盘：记录原因与可复用的教训',
    steps: [
      '写清流失原因与关键节点，区分事实与推测',
      '提炼可复用的判断规则（进 methods/ 或雷区清单）',
      '用 fde_harvest 生成复盘草稿，人审后再归档',
    ],
    artifacts: ['复盘草稿（research/.fde/drafts/）'],
  },
};

const INTENT_LABELS = {
  stage: '推进当前阶段',
  gate: '补齐门禁',
  meeting: '准备会面材料',
  review: '审阅任务结果',
  harvest: '复盘沉淀',
};

function line(...parts) { return parts.filter((x) => x != null && x !== '').join(''); }

function missingText(gate) {
  if (!gate || !gate.missing || !gate.missing.length) return '无（自动检查与人工项均已通过）';
  return gate.missing.map((m) => `${m.type === 'auto' ? '自动' : '人工'}：${m.label}${m.detail ? '（' + m.detail + '）' : ''}`).join('；');
}

function skillHint(names) {
  const uniq = [...new Set((names || []).filter(Boolean))];
  if (!uniq.length) return '';
  return [
    '【先加载技能】用 skill 工具依次加载：' + uniq.map((n) => '`' + n + '`').join('、'),
    '技能正文含触发时机、步骤、产物路径与边界；技能服务不可用时按本提示词与 methods/ 执行。',
  ].join('\n');
}

/**
 * engagement 交接提示词。
 * @param {object} ctxData
 * @param {string} ctxData.root 工作区根
 * @param {object} ctxData.engagement
 * @param {string} [ctxData.intent] stage|gate|meeting|review|harvest
 * @param {object} [ctxData.gate] 当前/目标门禁评估结果
 * @param {string[]} [ctxData.extraSkills] 额外技能（如 fde-board）
 * @param {boolean} [ctxData.hasSkills] 技能是否可加载
 */
export function engagementPrompt(ctxData) {
  const { root, engagement: e } = ctxData || {};
  const intent = ctxData.intent || 'stage';
  const stage = e && schema.isStage(e.stage) ? e.stage : 'lead';
  const guide = STAGE_GUIDES[stage] || STAGE_GUIDES.lead;
  const gate = ctxData.gate || null;
  /* 执行任务：客户目标的 handoff 由宿主先建/复用 item，回报指令必须能定位它（spec §9）。 */
  const execItem = ctxData.item || null;
  const itemRef = execItem && execItem.id ? execItem.id : '';
  const dir = e && e.dir ? e.dir : '';
  const rel = dir ? `research/${dir}` : 'research/<待建立客户目录>';
  const skills = [guide.skill].concat(intent === 'harvest' ? ['fde-harvest'] : ['fde-board']);
  if (ctxData.extraSkills) skills.push(...ctxData.extraSkills);

  const lines = [
    '【FDE 工作站 · 阶段交接】',
    '',
    `你是 FDE 工作站的执行会话，负责客户「${e ? e.name : '未命名客户'}」的${schema.stageLabel(stage)}阶段（intent=${intent}：${INTENT_LABELS[intent] || intent}）。`,
    '**编排声明**：FDE 看板是唯一编排者；你只执行本任务并向看板回报。不要自行推进客户阶段、不要替人通过门禁、不要对外发送材料、不要修改客户卷定稿文件。',
    '',
    '【客户上下文】',
    `- 工作区：${root}`,
    `- 客户目录：${rel}${dir ? '' : '（尚无目录；需要时用 rw_scaffold 建立，日期用本地日期）'}`,
    `- 客户全称：${(e && (e.company || e.name)) || ''}${e && e.shortName ? '（简称 ' + e.shortName + '）' : ''}`,
    `- 当前阶段：${schema.stageLabel(stage)}（停留 ${ctxData.stayDays != null ? ctxData.stayDays : '?'} 天）`,
    `- 门禁：${gate ? gate.label + '｜' + gate.status : (schema.gateKeyOfStage(stage) || '—')}`,
    `- 门禁缺口：${missingText(gate)}`,
    `- 下一步（人填）：${(e && e.nextAction && e.nextAction.text) || '未填写'}`,
    execItem ? `- 执行任务：${execItem.title}（id=${execItem.id}，泳道 ${schema.laneLabel(execItem.stage)}，负责人 ${execItem.owner || 'agent'}）` : '',
    '',
    skillHint(skills),
    '',
    `【本次任务】${guide.goal}`,
    ...guide.steps.map((s, i) => `${i + 1}) ${s}`),
    '',
    '【方法文件】先读（用 rw_method）：',
    ...(guide.methods || []).map((m) => `- ${m}`),
    '',
    '【产物落盘】',
    `- 目录：${rel}/`,
    ...guide.artifacts.map((a) => `- ${a}`),
    '- 全部写 md；PDF/DOCX 仅在用户明确要求导出/打印/递交时生成到 exports/，不要主动导出',
    '- 不回写看板状态文件（research/.fde/）；状态一律通过工具回报',
    '',
    '【回报要求】',
    itemRef
      ? `- 本会话已关联执行任务 id=${itemRef}（看板可见）。完成后调用 \`fde_item\`（action=report，id=${itemRef}）回报：kind=ready/progress/blocked，text ≤300 字摘要，artifacts=[文件路径…]`
      : '- 完成前先调用 `fde_item`（action=create）建立本阶段执行任务，再对返回的 id 用 action=report 回报（kind=ready/progress/blocked，text ≤300 字摘要，artifacts=[文件路径…]）',
    '- 需要人决定时用 `fde_attention`（action=ask）提问，不要自行替人决定；受阻用 kind=blocked',
    `- 阶段与门禁推进只能由人执行；回报里列出「还缺什么」即可`,
  ];
  if (intent === 'harvest') {
    lines.push('', '【复盘】用 fde_harvest 生成复盘草稿（targets=pitfall/method/skill），脱敏；不写死客户信息到方法论。');
  }
  return lines.filter((l) => l !== '' || true).join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * item 交接提示词（看板任务 → 会话）。
 * @param {object} ctxData {root, item, engagement?, intent?}
 */
export function itemPrompt(ctxData) {
  const { root, item: it } = ctxData || {};
  const e = ctxData.engagement || null;
  const intent = ctxData.intent || 'stage';
  const guide = STAGE_GUIDES[schema.isStage(e && e.stage) ? e.stage : 'lead'] || STAGE_GUIDES.lead;
  const rel = e && e.dir ? `research/${e.dir}` : 'research/<客户目录>';
  const lines = [
    '【FDE 工作站 · 任务交接】',
    '',
    `你是 FDE 工作站的执行会话，负责任务「${it ? it.title : '未命名任务'}」${e ? `（客户「${e.name}」）` : '（独立任务）'}。`,
    '**编排声明**：FDE 看板是唯一编排者；你只执行本任务并向看板回报。不要自行推进客户阶段、不要替人通过门禁、不要对外发送材料、不要修改客户卷定稿文件。',
    '',
    '【任务上下文】',
    `- 工作区：${root}`,
    `- 客户目录：${e && e.dir ? rel : '（无关联客户目录）'}`,
    `- 任务类型：${schema.ITEM_TYPES.find((t) => t.key === (it && it.type)) ? schema.ITEM_TYPES.find((t) => t.key === it.type).label : (it && it.type) || ''}`,
    `- 泳道：${schema.laneLabel(it && it.stage)}｜优先级：${(it && it.priority) || 'normal'}｜到期：${(it && it.due) || '未设'}`,
    `- 完成标准：${(it && it.title) || ''}（有可检查的结果与证据）`,
    e ? `- 客户阶段：${schema.stageLabel(e.stage)}｜下一步：${(e.nextAction && e.nextAction.text) || '未填写'}` : '',
    '',
    skillHint([guide.skill, 'fde-board']),
    '',
    `【产物落盘】${e && e.dir ? rel + '/' : '按任务内容选择客户卷或插件仓'} 下的 md 文件；不要写 research/.fde/`,
    '',
    '【回报要求】',
    '- 调用 `fde_item`（action=report，id=' + (it ? it.id : '<itemId>') + '）回报：',
    '  - 完成：kind=ready，text ≤300 字摘要 + artifacts=[文件路径…]',
    '  - 进展：kind=progress',
    '  - 受阻：kind=blocked（会自动进入「等外部」并生成注意力）',
    '  - 失败：kind=failed（保持进行中并生成注意力）',
    '- 需要人决定时用 `fde_attention`（action=ask）提问',
  ];
  if (intent === 'review') {
    lines.push('', '【本次是审阅任务】读 reports 与产物，给出通过/退回结论与理由；结论由人在面板确认。');
  }
  return lines.filter((l) => l !== '').join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * 统一入口。
 * @returns {string}
 */
export function buildPrompt(target, ctxData) {
  return target === 'item' ? itemPrompt(ctxData) : engagementPrompt(ctxData);
}

/** 复盘草稿（fde_harvest 用）：写进 research/.fde/drafts/，不碰客户卷定稿。 */
export function harvestDraft({ text, engagement, item, targets, at }) {
  const list = Array.isArray(targets) && targets.length ? targets : ['pitfall', 'method'];
  const labels = { pitfall: '坑卡', method: '方法', skill: '技能' };
  const lines = [
    `# 复盘草稿：${engagement ? engagement.name : (item ? item.title : '未命名')}`,
    '',
    `> 生成时间：${at || new Date().toISOString()}｜来源：FDE 工作站 fde_harvest（未审草稿）`,
    `> 关联：${engagement ? 'engagement=' + engagement.id + '（' + engagement.name + '）' : '—'}${item ? '｜item=' + item.id + '（' + item.title + '）' : ''}`,
    '',
    '## 原始记录',
    '',
    String(text || '').trim() || '（空）',
    '',
    '## 沉淀建议',
    '',
    ...list.map((t) => `- [${labels[t] || t}] ${t === 'pitfall' ? '补进 reference/雷区清单.md（含触发条件、后果、防范动作）' : t === 'method' ? '补进 methods/（可复用步骤，脱敏）' : '补进 skills/（触发时机 + 输入 + 步骤 + 产物 + 边界）'}`),
    '',
    '## 边界',
    '',
    '- 本文件是**未审草稿**，位于 research/.fde/drafts/，不是客户卷定稿。',
    '- 归档前需人确认：事实复盘进客户卷，方法沉淀进插件仓 docs/retros/、methods/、reference/。',
    '- 脱敏：不写客户真名、金额、人名到方法论；示例用「某集团」。',
  ];
  return lines.join('\n');
}
