/**
 * FDE 工作站 · 场景评估 / 成本报价计算（spec §21，v1.3 2026-11-04；按 §21 修订版实现）
 *
 * 两个**纯函数计算器**，把「场景选择」与「成本/报价」从拍脑袋变成可复核的计算：
 * - fde_scenario：4 条硬门槛 + 12 维加权评分（权重合计 101，必须归一化）+ 1–7 否决项 + 档位排序；
 * - fde_quote：三点估算 P80 计价人天 + 7 项非人力 + 预备费/税/毛利 → 成本、底线、目标、上限、成交价与实现毛利率。
 *
 * 边界（spec §21.4）：
 * - 不写文件、不写 board、不联网、不生成 PDF/DOCX、不对外发送；
 * - 输出 Markdown 由会话落盘到客户卷（scoping/ 或 proposal/）；
 * - 费率、甜点区、毛利率是**方法默认值**，不构成对外报价；对外报价必须由人确认（红线不变）；
 * - 模板示例用「某客户」，不写入真实客户名（除非调用方显式传入）。
 *
 * 定价配置 `reference/fde-pricing.json` 只读加载；缺失/损坏时用内置默认值并给 warning（spec §21.3）。
 * 零新依赖；不 import @deepseek-ai/*。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 插件根目录（src/host/../..）。 */
export const PLUGIN_ROOT = join(HERE, '..', '..');
/** 定价配置相对插件根的路径（spec §21.3）。 */
export const PRICING_REL = 'reference/fde-pricing.json';

/* ============================ 默认定价配置（spec §21.3 修订版） ============================ */

/** 内置默认定价（配置文件缺失/损坏时的兜底；费率为内部成本费率，不是对外报价）。 */
export const DEFAULT_PRICING = Object.freeze({
  version: 1,
  updatedAt: '2026-11-04',
  currency: 'CNY',
  defaults: Object.freeze({
    ratePerPersonDay: 940,
    contingencyPct: 15,
    taxPct: 6,
    marginPct: 35,
    discountPct: 0,
    sweetSpotMin: 50000,
    sweetSpotMax: 200000,
  }),
  rateCard: Object.freeze([
    { key: 'fde', label: 'FDE/交付负责人', ratePerPersonDay: 1200 },
    { key: 'engineer', label: '工程师', ratePerPersonDay: 940 },
    { key: 'data', label: '数据/评测', ratePerPersonDay: 800 },
    { key: 'pm', label: '项目管理', ratePerPersonDay: 1100 },
  ]),
  notes: Object.freeze([
    '费率为内部成本费率，不是对外报价；对外报价 = 成本 ÷ (1 − 毛利)。',
    '毛利率 35%–50% 为经验区间（待验证）；低于 20% 需人工确认。',
    '5–20 万为单兵/小团队 FDE 甜点区（作者实践经验区间，B/C 级，非行业统计；待验证）。',
    '税率按现行税目与财务确认，工具默认 6% 仅为示例。',
  ]),
  disclaimer: '费率为方法默认值，按实际项目调整；不构成对外报价。',
});

/** 会写进 Markdown 的免责声明（无论配置是否可用都输出）。 */
export const QUOTE_DISCLAIMER = '本表为方法默认值测算，不构成对外报价；对外报价必须由人复核确认。';

/* ============================ 场景评估常量（spec §21.1） ============================ */

/** 四条硬门槛（任一 false → 暂不启动）。 */
export const SCENARIO_GATES = Object.freeze([
  { key: 'sponsor', label: '有姓名的业务发起人（愿意每周投入）' },
  { key: 'integration14d', label: '14 天内可完成首次数据/系统对接' },
  { key: 'prod90d', label: '90 天内可生产上线并使用' },
  { key: 'measurable', label: '使用行为可测量（人群 + 频次）' },
]);
export const GATE_KEYS = SCENARIO_GATES.map((g) => g.key);

/**
 * 12 维评分权重（spec §21.1 修订版，原始权重合计 **101**）。
 * ⚠ 归一化口径：归一化分 = Σ(分×权重) / Σ权重；**禁止**用固定除以 100 的公式
 * （101 权重下除以 100 会把 3.56 抬成 3.60，档位从「补证」误判为「进方案」）。
 */
export const SCENARIO_DIMENSIONS = Object.freeze([
  { key: 'value', label: '业务价值与可量化收益', weight: 18 },
  { key: 'pain', label: '痛点强度与频率', weight: 10 },
  { key: 'data', label: '数据就绪度', weight: 14 },
  { key: 'tech', label: '技术可行性', weight: 12 },
  { key: 'accept', label: '可验收性', weight: 10 },
  { key: 'compliance', label: '合规与安全', weight: 8 },
  { key: 'roi', label: '投资回报与预算匹配', weight: 8 },
  { key: 'readiness', label: '客户就绪度', weight: 7 },
  { key: 'delivery', label: '交付与集成风险（分越高风险越低）', weight: 6 },
  { key: 'reuse', label: '可复制性', weight: 4 },
  { key: 'alternative', label: '替代方案成本（build/buy）', weight: 3 },
  { key: 'timing', label: '时间窗与见效速度', weight: 1 },
]);
/** 权重合计（真实值 101；归一化分母必须用它，不是 100）。 */
export const SCENARIO_WEIGHT_SUM = SCENARIO_DIMENSIONS.reduce((s, d) => s + d.weight, 0);
export const SCENARIO_DIM_KEYS = SCENARIO_DIMENSIONS.map((d) => d.key);
export const SCENARIO_SCORE_MIN = 1;
export const SCENARIO_SCORE_MAX = 5;
/** 缺省/非法维度分值（中性 3 分 + warning）。 */
export const SCENARIO_DEFAULT_SCORE = 3;

/** 1–7 否决项（spec §21.1；清单详见 methods/06-场景选择与数据体检.md）。 */
export const SCENARIO_VETOES = Object.freeze([
  { id: 1, label: '数据不可得（拿不到/无权限/无历史数据）' },
  { id: 2, label: '合规或安全禁止（数据等级/监管不允许）' },
  { id: 3, label: '验收口径不可定义（无法验收）' },
  { id: 4, label: '无预算或无决策人' },
  { id: 5, label: '只做 Demo（无生产使用意图）' },
  { id: 6, label: '接口不开放（系统无法对接）' },
  { id: 7, label: '坏流程拒绝 redesign（要求原样自动化烂流程）' },
]);
export const SCENARIO_VETO_IDS = SCENARIO_VETOES.map((v) => v.id);

/** 结论档位（spec §21.1：归一化分 ≥3.6 / 3.2–3.6 / <3.2）。 */
export const SCENARIO_GRADE_PASS = '进方案';
export const SCENARIO_GRADE_SUPPLEMENT = '补证/小 POC';
export const SCENARIO_GRADE_REJECT = '拒绝或转咨询';
export const SCENARIO_GRADE_PASS_MIN = 3.6;
export const SCENARIO_GRADE_SUPPLEMENT_MIN = 3.2;
export const SCENARIO_NOT_STARTABLE = '暂不启动（补前置条件）';
export const SCENARIO_VETOED = '不进方案（例外需人签字）';

/* ============================ 报价常量（spec §21.2） ============================ */

/** 非人力成本项（spec §21.2 修订版 7 项）。 */
export const NON_LABOR_KEYS = Object.freeze([
  { key: 'dataEval', label: '数据与评测（清洗/标注/评测集）' },
  { key: 'cloudToken', label: '云与推理 token' },
  { key: 'compliance', label: '合规与安全' },
  { key: 'ops', label: '运维' },
  { key: 'travel', label: '差旅与驻场' },
  { key: 'quality', label: '质保与支持' },
  { key: 'other', label: '其他' },
]);
export const NON_LABOR_KEY_LIST = NON_LABOR_KEYS.map((k) => k.key);

/** 警告阈值（spec §21.2）。 */
export const WARN_SWEET_MAX = 200000;
export const WARN_SWEET_MIN = 50000;
export const WARN_MARGIN_MIN = 20;
export const WARN_MARGIN_SEVERE = 10;
export const WARN_CONTINGENCY_MIN = 10;
export const WARN_NON_LABOR_RATIO = 0.4;
export const WARN_TEAM_LOAD_FACTOR = 1.2;
export const PERSON_DAYS_PER_WEEK = 5;
/** 三点估算 P80 系数（te + 0.84σ）。 */
export const P80_Z = 0.84;

/* ============================ 小工具 ============================ */

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const finite = (v) => Number.isFinite(Number(v));
const numOr = (v, d) => (finite(v) ? Number(v) : d);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** 四舍五入到分（2 位小数），去掉 -0。 */
export function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/** 向上取到 0.1 人天（消除浮点误差：11.48 → 11.5；11.5 → 11.5）。 */
export function ceilTenth(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.ceil(Number((n * 10).toFixed(6))) / 10;
}

/** 人民币展示：金额统一带千分位、两位小数。 */
export function money(v) {
  const n = round2(v);
  return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 百分比展示（保留 2 位小数，去掉多余的 .0）。 */
export function pct(v) {
  return String(round2(v)).replace(/(\.\d)0$/, '$1') + '%';
}

/** 表格单元格转义：竖线换行不能破坏 Markdown 表格。 */
function cell(v) {
  return String(v == null ? '' : v).replace(/\|/g, '／').replace(/\r?\n/g, ' ').trim();
}

/** 本地日期 YYYY-MM-DD（展示口径）。 */
function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ============================ 定价配置加载（spec §21.3） ============================ */

/** 定价配置默认绝对路径（插件 reference/ 下）。 */
export function pricingPath(opts = {}) {
  const custom = str(opts && opts.pricingPath);
  return custom || join(PLUGIN_ROOT, 'reference', 'fde-pricing.json');
}

function clonePricing(base) {
  return {
    version: Number(base.version) || 1,
    updatedAt: str(base.updatedAt) || DEFAULT_PRICING.updatedAt,
    currency: str(base.currency) || 'CNY',
    defaults: Object.assign({}, DEFAULT_PRICING.defaults, isObj(base.defaults) ? base.defaults : {}),
    rateCard: Array.isArray(base.rateCard) && base.rateCard.length
      ? base.rateCard.map((r) => Object.assign({}, r))
      : DEFAULT_PRICING.rateCard.map((r) => Object.assign({}, r)),
    notes: Array.isArray(base.notes) && base.notes.length ? base.notes.map(str).filter(Boolean) : DEFAULT_PRICING.notes.slice(),
    disclaimer: str(base.disclaimer) || DEFAULT_PRICING.disclaimer,
  };
}

/**
 * 只读加载定价配置。缺失/损坏/字段非法 → 内置默认值 + warnings（不抛异常，spec §21.3）。
 * @param {{pricingPath?: string}} [opts]
 * @returns {{pricing: object, warnings: string[], source: 'file'|'default', path: string}}
 */
export function loadPricing(opts = {}) {
  const file = pricingPath(opts || {});
  const warnings = [];
  let raw = null;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    warnings.push('定价配置缺失（' + PRICING_REL + '），已使用内置默认费率（预备费 15%/毛利 35%/税 6%）；对外报价前请人工复核');
    return { pricing: clonePricing(DEFAULT_PRICING), warnings, source: 'default', path: file };
  }
  let obj = null;
  try { obj = JSON.parse(raw); } catch { obj = null; }
  if (!isObj(obj)) {
    warnings.push('定价配置损坏（' + PRICING_REL + ' 不是合法 JSON 对象），已使用内置默认费率');
    return { pricing: clonePricing(DEFAULT_PRICING), warnings, source: 'default', path: file };
  }
  const pricing = clonePricing(obj);
  const d = pricing.defaults;
  const numericKeys = ['ratePerPersonDay', 'contingencyPct', 'taxPct', 'marginPct', 'discountPct', 'sweetSpotMin', 'sweetSpotMax'];
  const bad = numericKeys.filter((k) => !finite(d[k]));
  for (const k of bad) d[k] = DEFAULT_PRICING.defaults[k];
  if (bad.length) warnings.push('定价配置字段非法已回退默认值：' + bad.join('、'));
  for (const k of numericKeys) d[k] = Number(d[k]);
  pricing.rateCard = pricing.rateCard
    .filter((r) => r && typeof r === 'object')
    .map((r, i) => ({
      key: str(r.key) || ('rate-' + (i + 1)),
      label: str(r.label) || str(r.key) || ('费率 ' + (i + 1)),
      ratePerPersonDay: numOr(r.ratePerPersonDay, d.ratePerPersonDay),
    }));
  if (!pricing.rateCard.length) pricing.rateCard = DEFAULT_PRICING.rateCard.map((r) => Object.assign({}, r));
  return { pricing, warnings, source: 'file', path: file };
}

/* ============================ fde_scenario（spec §21.1 修订版） ============================ */

/** 归一化分：Σ(分×权重)/Σ权重（分母 = 101，不是 100）。 */
export function normalizeScenarioScore(rawSum) {
  return round2(Number(rawSum || 0) / SCENARIO_WEIGHT_SUM);
}

/** 档位判定（按保留 2 位后的归一化分）。 */
export function scenarioGrade(score) {
  const s = round2(score);
  if (s >= SCENARIO_GRADE_PASS_MIN) return SCENARIO_GRADE_PASS;
  if (s >= SCENARIO_GRADE_SUPPLEMENT_MIN) return SCENARIO_GRADE_SUPPLEMENT;
  return SCENARIO_GRADE_REJECT;
}

function normalizeVetoes(raw, sceneIndex, warnings) {
  const input = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  const ids = [];
  for (const v of input) {
    const id = Number(v);
    if (SCENARIO_VETO_IDS.includes(id)) {
      if (!ids.includes(id)) ids.push(id);
    } else {
      warnings.push(`第 ${sceneIndex + 1} 个场景否决项（vetoes）含未知编号 ${String(v)}（有效 1–7），已忽略`);
    }
  }
  return ids.sort((a, b) => a - b);
}

/** 单场景评分（确定性；返回明细供 Markdown 附录）。 */
export function scoreScenario(raw = {}, index = 0) {
  const scene = isObj(raw) ? raw : {};
  const name = str(scene.name) || ('场景 ' + (index + 1));
  const gatesInput = isObj(scene.gates) ? scene.gates : scene; // 兼容旧扁平字段（v1.3 修订前）
  const gateState = {};
  const missing = [];
  for (const g of SCENARIO_GATES) {
    const ok = gatesInput[g.key] === true;
    gateState[g.key] = ok;
    if (!ok) missing.push(g.label);
  }
  const scoresInput = isObj(scene.scores) ? scene.scores : {};
  const scores = {};
  const weights = {};
  let rawSum = 0;
  for (const d of SCENARIO_DIMENSIONS) {
    let v = scoresInput[d.key];
    if (!finite(v)) v = SCENARIO_DEFAULT_SCORE;
    v = clamp(Number(v), SCENARIO_SCORE_MIN, SCENARIO_SCORE_MAX);
    scores[d.key] = v;
    weights[d.key] = d.weight;
    rawSum += v * d.weight;
  }
  const score = normalizeScenarioScore(rawSum);
  const vetoes = normalizeVetoes(scene.vetoes, index, []);
  const startable = missing.length === 0;
  const vetoed = vetoes.length > 0;
  const eligible = startable && !vetoed;
  const conclusion = !startable ? SCENARIO_NOT_STARTABLE : (vetoed ? SCENARIO_VETOED : scenarioGrade(score));
  const vetoLabels = vetoes.map((id) => (SCENARIO_VETOES.find((v) => v.id === id) || {}).label || ('否决项 ' + id));
  return {
    name,
    note: str(scene.note),
    startable,
    vetoed,
    eligible,
    missing,
    gates: gateState,
    vetoes,
    vetoLabels,
    scores,
    weights,
    rawSum,
    weightSum: SCENARIO_WEIGHT_SUM,
    score,
    grade: !startable ? SCENARIO_NOT_STARTABLE : (vetoed ? SCENARIO_VETOED : scenarioGrade(score)),
    conclusion,
  };
}

/** 排序：可进方案（gates 全 true 且无否决）优先 → 归一化分降序 → value 降序。 */
export function rankScenarios(ranked) {
  return (ranked || []).map((x, i) => ({ x, i })).sort((a, b) => {
    if (a.x.eligible !== b.x.eligible) return a.x.eligible ? -1 : 1;
    if (b.x.score !== a.x.score) return b.x.score - a.x.score;
    if (b.x.scores.value !== a.x.scores.value) return b.x.scores.value - a.x.scores.value;
    return a.i - b.i;
  }).map((e) => e.x);
}

function vetoTableLines(indent = '') {
  return SCENARIO_VETOES.map((v) => indent + v.id + '. ' + v.label);
}

/** 场景评估 Markdown（写死判定口径附录；示例客户一律用「某客户」）。 */
export function scenarioMarkdown(ranked, { title = '场景评估表' } = {}) {
  const lines = [
    '# ' + (str(title) || '场景评估表'),
    '',
    '> 生成时间：' + todayLocal() + '｜工具：FDE 工作站 `fde_scenario`（确定性计算，可复算）',
    '> 归一化口径：Σ(分值×权重)/**Σ权重(101)**；加权分只用于排序，不替代人的判断。',
    '> 四条硬门槛任一不满足 → 暂不启动；任一否决项命中 → 不进方案（例外需人签字）。',
    '',
    '## 一、评分结果（按启动优先级排序）',
    '',
    '| # | 场景 | 四条硬门槛 | 否决项 | 归一化分 | 档位/结论 | 缺项 |',
    '|---|---|---|---|---|---|---|',
  ];
  ranked.forEach((x, i) => {
    const gates = SCENARIO_GATES.map((g) => (x.gates[g.key] ? '✓' : '✗')).join(' ');
    const veto = x.vetoes.length ? x.vetoes.join('、') : '—';
    const grade = x.conclusion;
    const miss = x.missing.length ? x.missing.join('；') : (x.vetoed ? x.vetoLabels.join('；') : '—');
    lines.push('| ' + (i + 1) + ' | ' + cell(x.name) + ' | ' + gates + ' | ' + veto + ' | ' + x.score + ' | ' + cell(grade) + ' | ' + cell(miss) + ' |');
  });
  lines.push('');
  const eligible = ranked.filter((x) => x.eligible);
  const first = eligible[0] || null;
  let advice;
  if (!first) {
    advice = ranked.length
      ? '当前没有场景同时满足四条硬门槛且无否决项：先补前置条件/解除否决，不要进入方案阶段。'
      : '没有候选场景。';
  } else if (first.conclusion === SCENARIO_GRADE_PASS) {
    advice = `优先推进「${first.name}」（${first.conclusion}，归一化分 ${first.score}）；其余场景按上表排序作为候选。`;
  } else {
    advice = `最优场景「${first.name}」档位为「${first.conclusion}」（归一化分 ${first.score}）：先补证或做小 POC，不要直接进方案。`;
  }
  lines.push('**建议**：' + advice);
  const rejected = ranked.filter((x) => !x.eligible);
  if (rejected.length) {
    lines.push('');
    lines.push('**不可进方案场景**：');
    for (const x of rejected) {
      const why = !x.startable ? '缺门槛：' + x.missing.join('；') : '命中否决：' + x.vetoLabels.join('；');
      lines.push('- ' + x.name + '：' + why);
    }
  }
  const withNote = ranked.filter((x) => x.note);
  if (withNote.length) {
    lines.push('');
    lines.push('**备注**：');
    for (const x of withNote) lines.push('- ' + x.name + '：' + x.note);
  }
  lines.push('', '## 二、12 维评分明细（1–5，5 最好）', '');
  lines.push('| 维度 | 权重 | ' + ranked.map((x) => cell(x.name)).join(' | ') + ' |');
  lines.push('|---|---|' + ranked.map(() => '---').join('|') + '|');
  for (const d of SCENARIO_DIMENSIONS) {
    lines.push('| ' + cell(d.label) + ' | ' + d.weight + ' | ' + ranked.map((x) => x.scores[d.key]).join(' | ') + ' |');
  }
  lines.push('| **Σ(分×权重)** | **' + SCENARIO_WEIGHT_SUM + '** | ' + ranked.map((x) => x.rawSum).join(' | ') + ' |');
  lines.push('| **归一化分** | — | ' + ranked.map((x) => x.score).join(' | ') + ' |');
  lines.push('');
  lines.push('## 三、判定口径（写死在实现里，可复核）', '');
  lines.push('- 四条硬门槛（任一 false → 「' + SCENARIO_NOT_STARTABLE + '」）：' + SCENARIO_GATES.map((g) => g.label).join('；') + '。');
  lines.push('- 12 维权重：' + SCENARIO_DIMENSIONS.map((d) => d.key + '=' + d.weight).join('/') + '，**合计 ' + SCENARIO_WEIGHT_SUM + '**。');
  lines.push('- **归一化分 = Σ(分值×权重) / Σ权重(' + SCENARIO_WEIGHT_SUM + ')**；不得用固定除以 100（会把 3.56 抬成 3.60，档位误判）。');
  lines.push('- 档位：归一化分 ≥' + SCENARIO_GRADE_PASS_MIN + '「' + SCENARIO_GRADE_PASS + '」；'
    + SCENARIO_GRADE_SUPPLEMENT_MIN + '–' + SCENARIO_GRADE_PASS_MIN + '「' + SCENARIO_GRADE_SUPPLEMENT + '」；<'
    + SCENARIO_GRADE_SUPPLEMENT_MIN + '「' + SCENARIO_GRADE_REJECT + '」。');
  lines.push('- 排序：可进方案优先 → 归一化分降序 → 同分按 value（业务价值）降序。');
  lines.push('- 逐维必须写明依据；**空依据按 3 分封顶**（评分卡进入 `scoping` 门禁人工项 `criteria_scored`）。');
  lines.push('- 本表为方法口径，不构成对客户的承诺；场景最终由人确认。');
  lines.push('', '## 四、否决项清单（1–7，任一命中 → 不进方案，例外需人签字）', '');
  lines.push(...vetoTableLines());
  return lines.join('\n');
}

/** 空白评分表模板（action=template）。 */
export function scenarioTemplate() {
  const header = ['# 场景评估表（空白模板）', '',
    '> 工具：`fde_scenario`（action=template）；填写后用 `fde_scenario`（action=evaluate）复算。',
    '> 归一化口径：Σ(分值×权重)/**Σ权重(101)**；逐维必须写依据，空依据按 3 分封顶。',
    '> 示例客户一律写「某客户」，不写真实客户名。', '',
    '## 一、四条硬门槛（任一不满足 → 暂不启动）', ''];
  header.push(...SCENARIO_GATES.map((g) => '- [ ] ' + g.label));
  header.push('', '## 二、12 维评分卡（1–5，5 最好；每维必须写依据）', '');
  header.push('| # | 维度 | 权重 | 分值(1–5) | 依据（事实/数据/来源） |');
  header.push('|---|---|---:|---|---|');
  SCENARIO_DIMENSIONS.forEach((d, i) => header.push('| ' + (i + 1) + ' | ' + cell(d.label) + ' | ' + d.weight + ' |  |  |'));
  header.push('| — | **Σ(分×权重)** | **' + SCENARIO_WEIGHT_SUM + '** |  | **归一化分 = Σ/101（保留 2 位）** |');
  header.push('', '## 三、否决项（1–7，任一命中 → 不进方案，例外需人签字）', '');
  header.push(...vetoTableLines('- [ ] '));
  header.push('', '## 四、档位说明', '');
  header.push('- 归一化分 ≥' + SCENARIO_GRADE_PASS_MIN + ' 且 4 门槛全 true 且无否决 → 「' + SCENARIO_GRADE_PASS + '」。');
  header.push('- ' + SCENARIO_GRADE_SUPPLEMENT_MIN + '–' + SCENARIO_GRADE_PASS_MIN + ' → 「' + SCENARIO_GRADE_SUPPLEMENT + '」（补证或小 POC 后再评）。');
  header.push('- <' + SCENARIO_GRADE_SUPPLEMENT_MIN + ' → 「' + SCENARIO_GRADE_REJECT + '」。');
  header.push('- 四条硬门槛任一 false → 「' + SCENARIO_NOT_STARTABLE + '」；否决命中 → 「' + SCENARIO_VETOED + '」。');
  header.push('', '## 五、数据体检（每个场景各写一段）', '');
  header.push('- 数据在哪（系统/表/文件）：');
  header.push('- 谁提供、多久能拿到：');
  header.push('- 数据质量与口径（缺失/重复/口径不一）：');
  header.push('- 拿不到时的替代方案：');
  header.push('', '## 六、范围与边界（一期）', '');
  header.push('- 一期只做一个场景：');
  header.push('- 明确不做（不做什么）：');
  header.push('- 发起人投入承诺（每周/评审节奏）：');
  header.push('- 停止条件（什么情况下暂停/撤出）：');
  header.push('', '## 七、确认', '');
  header.push('- [ ] 4 条硬门槛逐条有证据');
  header.push('- [ ] 12 维评分逐维写了依据');
  header.push('- [ ] 场景与范围、优先级已与客户书面确认（人）');
  header.push('', '> 本模板为方法口径，不构成对外承诺。');
  return header.join('\n');
}

/**
 * fde_scenario 入口（纯函数，不写文件）。
 * @param {{action?: 'evaluate'|'template', scenarios?: object[], title?: string}} input
 */
export function evaluateScenario(input = {}) {
  const action = str(input.action) || 'evaluate';
  if (action === 'template') {
    return { ok: true, action: 'template', markdown: scenarioTemplate(), warnings: [] };
  }
  if (action !== 'evaluate') {
    return { ok: false, code: 'INVALID', reason: `未知 action：${action}（evaluate|template）` };
  }
  const list = Array.isArray(input.scenarios) ? input.scenarios : [];
  if (!list.length) return { ok: false, code: 'INVALID', reason: 'scenarios 不能为空：至少提供一个候选场景' };
  const warnings = [];
  if (list.length > 12) warnings.push('场景超过 12 个：建议先粗筛到 3–5 个再评分（本表仍全部计算）');
  const scored = [];
  for (let i = 0; i < list.length; i += 1) {
    const raw = isObj(list[i]) ? list[i] : {};
    if (!str(raw.name)) warnings.push(`第 ${i + 1} 个场景缺少 name，已用「场景 ${i + 1}」占位`);
    if (!isObj(raw.scores)) warnings.push(`第 ${i + 1} 个场景缺少 scores（12 维），缺失维度按 ${SCENARIO_DEFAULT_SCORE} 分计`);
    if (!isObj(raw.gates)) warnings.push(`第 ${i + 1} 个场景缺少 gates（4 条硬门槛），缺失项按 false 计`);
    const item = scoreScenario(raw, i);
    if (isObj(raw.vetoes) && !Array.isArray(raw.vetoes)) warnings.push(`第 ${i + 1} 个场景 vetoes 应为数组`);
    const vetoWarn = [];
    const vetoes = normalizeVetoes(raw.vetoes, i, vetoWarn);
    warnings.push(...vetoWarn);
    item.vetoes = vetoes;
    item.vetoLabels = vetoes.map((id) => (SCENARIO_VETOES.find((v) => v.id === id) || {}).label || ('否决项 ' + id));
    item.vetoed = vetoes.length > 0;
    item.eligible = item.startable && !item.vetoed;
    item.grade = !item.startable ? SCENARIO_NOT_STARTABLE : (item.vetoed ? SCENARIO_VETOED : scenarioGrade(item.score));
    item.conclusion = item.grade;
    scored.push(item);
  }
  const ranked = rankScenarios(scored);
  const markdown = scenarioMarkdown(ranked, { title: str(input.title) || '场景评估表' });
  return {
    ok: true,
    action: 'evaluate',
    ranked,
    markdown,
    warnings,
    formula: { weightSum: SCENARIO_WEIGHT_SUM, normalize: 'Σ(score×weight)/' + SCENARIO_WEIGHT_SUM },
    template: action === 'template' ? scenarioTemplate() : undefined,
  };
}

/* ============================ fde_quote（spec §21.2 修订版） ============================ */

/** 三点估算：te=(o+4m+p)/6；σ=(p-o)/6；P80=te+0.84σ（向上取 0.1 人天）。 */
export function threePointEstimate(optimistic, likely, pessimistic) {
  const o = Number(optimistic);
  const m = Number(likely);
  const p = Number(pessimistic);
  if (![o, m, p].every(Number.isFinite)) return null;
  const te = (o + 4 * m + p) / 6;
  const sigma = (p - o) / 6;
  const p80Raw = te + P80_Z * sigma;
  return {
    optimistic: o,
    likely: m,
    pessimistic: p,
    te: round2(te),
    sigma: round2(sigma),
    p80Raw,
    p80: ceilTenth(p80Raw),
  };
}

/** 解析 labor 明细：personDays 或三点估算；非法按 0/默认处理，不抛异常。 */
function normalizeLabor(labor, defaultRate, warnings) {
  const rows = [];
  const list = Array.isArray(labor) ? labor : [];
  list.forEach((raw, i) => {
    const item = isObj(raw) ? raw : {};
    const name = str(item.name) || ('人力 ' + (i + 1));
    const rate = finite(item.rate) && Number(item.rate) > 0 ? Number(item.rate) : defaultRate;
    const hasThree = ['optimistic', 'likely', 'pessimistic'].every((k) => finite(item[k]));
    let personDays = 0;
    let p50 = 0;
    let p80 = 0;
    let estimate = 'personDays';
    if (hasThree) {
      const tp = threePointEstimate(item.optimistic, item.likely, item.pessimistic);
      estimate = 'three-point';
      p50 = tp.te;
      p80 = tp.p80;
      personDays = p80;
    } else if (finite(item.personDays)) {
      personDays = Math.max(0, Number(item.personDays));
      p50 = personDays;
      p80 = personDays;
    } else {
      warnings.push(`labor[${i}]（${name}）缺少 personDays 或 optimistic/likely/pessimistic，按 0 人天计`);
    }
    rows.push({
      name,
      estimate,
      rate,
      personDays,
      p50PersonDays: p50,
      p80PersonDays: p80,
      amount: round2(personDays * rate),
    });
  });
  return rows;
}

/** 完整成本/报价计算（纯函数；金额单位人民币元，明细四舍五入到分）。 */
export function computeQuote(input = {}, pricingResult = null) {
  const loaded = pricingResult || loadPricing(input && input.pricingPath ? { pricingPath: input.pricingPath } : {});
  const pricing = loaded.pricing;
  const defaults = pricing.defaults;
  const warnings = (loaded.warnings || []).slice();

  const defaultRate = finite(input.defaultRate) && Number(input.defaultRate) > 0
    ? Number(input.defaultRate)
    : defaults.ratePerPersonDay;

  const marginPct = numOr(input.marginPct, defaults.marginPct);
  const taxPct = numOr(input.taxPct, defaults.taxPct);
  const discountPct = numOr(input.discountPct, defaults.discountPct);
  const contingencyPct = numOr(input.contingencyPct, defaults.contingencyPct);
  if (marginPct < 0 || marginPct >= 90) return { ok: false, code: 'INVALID', reason: 'marginPct 必须在 0–89.99 之间（否则目标价/上限价无意义）' };
  if (taxPct < 0 || taxPct >= 100) return { ok: false, code: 'INVALID', reason: 'taxPct 必须在 0–99.99 之间' };
  if (discountPct < 0 || discountPct >= 100) return { ok: false, code: 'INVALID', reason: 'discountPct 必须在 0–99.99 之间' };
  if (contingencyPct < 0) return { ok: false, code: 'INVALID', reason: 'contingencyPct 不能为负' };

  const laborRows = normalizeLabor(input.labor, defaultRate, warnings);
  const laborCost = round2(laborRows.reduce((s, r) => s + r.personDays * r.rate, 0));
  const totalPersonDays = round2(laborRows.reduce((s, r) => s + r.personDays, 0));
  const p50PersonDays = round2(laborRows.reduce((s, r) => s + r.p50PersonDays, 0));
  const p80PersonDays = totalPersonDays;
  const usedThreePoint = laborRows.some((r) => r.estimate === 'three-point');

  const nonLabor = {};
  const inputNonLabor = isObj(input.nonLabor) ? input.nonLabor : {};
  for (const k of NON_LABOR_KEYS) nonLabor[k.key] = Math.max(0, numOr(inputNonLabor[k.key], 0));
  /* 兼容 v1.3 修订前字段名：cloud → cloudToken（只做别名，不改变新版口径）。 */
  if (!finite(inputNonLabor.cloudToken) && finite(inputNonLabor.cloud)) nonLabor.cloudToken = Math.max(0, Number(inputNonLabor.cloud));
  const nonLaborTotal = round2(NON_LABOR_KEYS.reduce((s, k) => s + nonLabor[k.key], 0));

  const directCost = round2(laborCost + nonLaborTotal);
  const contingency = round2(directCost * contingencyPct / 100);
  const totalCost = round2(directCost + contingency);
  const targetExTax = totalCost / (1 - marginPct / 100);
  const target = round2(targetExTax * (1 + taxPct / 100));
  const final = round2(target * (1 - discountPct / 100));
  const floor = round2(totalCost * (1 + taxPct / 100));
  const ceiling = round2(totalCost / (1 - (marginPct + 10) / 100) * (1 + taxPct / 100));
  const finalExTax = final / (1 + taxPct / 100);
  const realizedMarginPct = finalExTax > 0 ? round2((finalExTax - totalCost) / finalExTax * 100) : 0;
  const marginAmount = round2(finalExTax - totalCost);

  const sweetSpotMin = numOr(defaults.sweetSpotMin, WARN_SWEET_MIN);
  const sweetSpotMax = numOr(defaults.sweetSpotMax, WARN_SWEET_MAX);

  /* ---- 警告（不阻断，spec §21.2） ---- */
  if (final < floor) warnings.push('报价低于成本底线（亏损）：final ' + money(final) + ' < floor ' + money(floor));
  if (realizedMarginPct < WARN_MARGIN_MIN) {
    warnings.push('毛利率低于定制交付经验区间下限（' + WARN_MARGIN_MIN + '%）：实现毛利率 ' + pct(realizedMarginPct) + '（经验区间 35%–50%，需人工确认）');
  }
  if (realizedMarginPct < WARN_MARGIN_SEVERE) {
    warnings.push('毛利严重偏低（< ' + WARN_MARGIN_SEVERE + '%）：实现毛利率 ' + pct(realizedMarginPct) + '，接近/低于成本，须人工复核');
  }
  if (final > sweetSpotMax) warnings.push('超出单兵/小团队 FDE 甜点区（' + money(sweetSpotMin) + '–' + money(sweetSpotMax) + '）：尾款/招采风险，建议拆阶段或提高预付款');
  const missingNonLabor = ['cloudToken', 'ops', 'compliance'].filter((k) => nonLabor[k] === 0);
  if (missingNonLabor.length) {
    warnings.push('云/推理、运维、合规可能漏项（AI 项目最常见吞利润项）：未列 ' + missingNonLabor.join('、'));
  }
  if (nonLabor.dataEval === 0) warnings.push('未列数据清洗/标注/评测集成本（dataEval=0）：AI 项目常低估 20%+，建议补测');
  if (contingencyPct < WARN_CONTINGENCY_MIN) warnings.push('风险预备费偏低：' + pct(contingencyPct) + ' < ' + WARN_CONTINGENCY_MIN + '%');
  const teamSize = numOr(input.teamSize, 0);
  const weeks = numOr(input.weeks, 0);
  if (teamSize > 0 && weeks > 0) {
    const needed = p80PersonDays / (weeks * PERSON_DAYS_PER_WEEK);
    if (needed > teamSize * WARN_TEAM_LOAD_FACTOR) {
      warnings.push('人天与周期不匹配：P80 总人天 ' + p80PersonDays + ' / (' + weeks + ' 周×5 天) = ' + round2(needed) + ' 人，超过团队 ' + teamSize + ' 人×' + WARN_TEAM_LOAD_FACTOR + '（' + round2(teamSize * WARN_TEAM_LOAD_FACTOR) + '）');
    }
  }
  if (directCost > 0 && nonLaborTotal / directCost > WARN_NON_LABOR_RATIO) {
    warnings.push('非人力成本为主（占比 ' + pct(nonLaborTotal / directCost * 100) + ' > ' + pct(WARN_NON_LABOR_RATIO * 100) + '）：按量项要设年度上限或实报实销');
  }
  if (!laborRows.length) warnings.push('未提供 labor 明细（人力成本为 0）：请补充人天或三点估算');

  const summary = {
    laborCost,
    nonLaborTotal,
    directCost,
    contingency,
    totalCost,
    floor,
    target,
    ceiling,
    final,
    realizedMarginPct,
    marginAmount,
    p50PersonDays,
    p80PersonDays,
    totalPersonDays,
    defaultRate,
    marginPct: round2(marginPct),
    taxPct: round2(taxPct),
    discountPct: round2(discountPct),
    contingencyPct: round2(contingencyPct),
    sweetSpotMin: round2(sweetSpotMin),
    sweetSpotMax: round2(sweetSpotMax),
    usedThreePoint,
  };
  const details = {
    labor: laborRows,
    nonLabor,
    pricing: {
      source: loaded.source,
      path: loaded.path,
      defaultRate: round2(defaults.ratePerPersonDay),
      currency: pricing.currency,
      disclaimer: pricing.disclaimer,
    },
  };
  return {
    ok: true,
    action: 'calculate',
    summary,
    warnings,
    details,
    markdown: quoteMarkdown({ summary, details, warnings, title: str(input.title), engagementId: str(input.engagementId) }),
  };
}

function quoteMarkdown({ summary: s, details, warnings, title, engagementId }) {
  const laborRows = details.labor;
  const nonLabor = details.nonLabor;
  const lines = [
    '# ' + (title || '成本测算与报价单'),
    '',
    '> 生成时间：' + todayLocal() + '｜工具：FDE 工作站 `fde_quote`（确定性计算，可复算）'
      + (engagementId ? '｜客户：' + engagementId : ''),
    '> ' + QUOTE_DISCLAIMER,
    '',
    '## 一、人力成本',
    '',
    '| 角色 | 估算方式 | P50 人天 | P80 计价人天 | 费率（元/人天） | 金额（元） |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of laborRows) {
    const how = r.estimate === 'three-point' ? '三点估算（P80=te+0.84σ）' : '直接人天';
    lines.push('| ' + cell(r.name) + ' | ' + how + ' | ' + r.p50PersonDays + ' | ' + r.personDays + ' | ' + money(r.rate) + ' | ' + money(r.amount) + ' |');
  }
  lines.push('| **人力小计** | — | ' + s.p50PersonDays + ' | ' + s.p80PersonDays + ' | | ' + money(s.laborCost) + ' |');
  lines.push('');
  if (s.usedThreePoint) {
    lines.push('> 三点估算：`te=(乐观+4×最可能+悲观)/6`，`σ=(悲观−乐观)/6`，计价人天按 **P80=te+0.84σ 向上取 0.1 人天**（P50=te 仅作参考）。');
    lines.push('');
  }
  lines.push('## 二、非人力成本', '');
  lines.push('| 成本项 | 金额（元） |');
  lines.push('|---|---|');
  for (const k of NON_LABOR_KEYS) lines.push('| ' + cell(k.label) + ' | ' + money(nonLabor[k.key]) + ' |');
  lines.push('| **非人力小计** | ' + money(s.nonLaborTotal) + ' |');
  lines.push('', '## 三、成本汇总', '');
  lines.push('| 口径 | 金额（元） | 说明 |');
  lines.push('|---|---|---|');
  lines.push('| 直接成本 | ' + money(s.directCost) + ' | 人力 + 非人力 |');
  lines.push('| 风险预备费（' + pct(s.contingencyPct) + '） | ' + money(s.contingency) + ' | directCost × ' + pct(s.contingencyPct) + ' |');
  lines.push('| **总成本** | ' + money(s.totalCost) + ' | directCost + 预备费 |');
  lines.push('');
  lines.push('## 四、报价测算（含税）', '');
  lines.push('| 口径 | 金额（元） | 说明 |');
  lines.push('|---|---|---|');
  lines.push('| 成本底线（0 毛利） | ' + money(s.floor) + ' | floor = 总成本 ×(1+税率 ' + pct(s.taxPct) + ') |');
  lines.push('| 目标报价 | ' + money(s.target) + ' | target = 总成本 /(1−毛利 ' + pct(s.marginPct) + ') ×(1+税率) |');
  lines.push('| 定价上限 | ' + money(s.ceiling) + ' | ceiling = 总成本 /(1−(毛利+' + pct(10) + ')) ×(1+税率) |');
  lines.push('| **本次报价（含折扣）** | ' + money(s.final) + ' | final = target ×(1−折扣 ' + pct(s.discountPct) + ') |');
  lines.push('| 毛利额（税前） | ' + money(s.marginAmount) + ' | final/(1+税率) − 总成本 |');
  lines.push('| 实现毛利率 | ' + pct(s.realizedMarginPct) + ' | (final/(1+税率) − 总成本) / (final/(1+税率)) |');
  lines.push('');
  lines.push('> 甜点区（方法默认）：' + money(s.sweetSpotMin) + ' – ' + money(s.sweetSpotMax) + '；费率为内部成本费率，按实际项目调整。');
  if (warnings.length) {
    lines.push('', '## 五、风险提示', '');
    for (const w of warnings) lines.push('- ⚠ ' + w);
  }
  const base = warnings.length ? 6 : 5;
  const ord = ['五', '六', '七', '八', '九'];
  lines.push('', '## ' + (warnings.length ? ord[base - 5] : '五') + '、假设与除外', '');
  lines.push('- 假设：客户侧数据/接口按期可用；需求范围以锁定场景为限。');
  lines.push('- 除外：客户内部系统改造、第三方许可与硬件采购、超出约定次数的变更。');
  lines.push('- 计价：人民币含税；税率为 ' + pct(s.taxPct) + '，若实际税档不同按实调整。');
  lines.push('- 本报价基于内部成本费率（默认 ' + money(s.defaultRate) + '/人天）；对外报价前必须由人复核。');
  lines.push('', '## ' + (warnings.length ? ord[base - 4] : '六') + '、变更单', '');
  lines.push('| 变更项 | 原因 | 增减人天 | 增减金额（元） | 确认人/日期 |');
  lines.push('|---|---|---|---|---|');
  lines.push('|  |  |  |  |  |');
  lines.push('', '## ' + (warnings.length ? ord[base - 3] : '七') + '、验收口径', '');
  lines.push('- 交付物：按方案与 Pilot Charter 约定的可检查产物（md/系统功能/数据结果）。');
  lines.push('- 验收方式：逐项对照验收清单，由客户指定验收人签字确认。');
  lines.push('- 付款节奏：按合同约定；建议预付款 + 里程碑 + 尾款，尾款与验收挂钩。');
  lines.push('', '> ' + (details.pricing && details.pricing.disclaimer ? details.pricing.disclaimer : QUOTE_DISCLAIMER));
  return lines.join('\n');
}

/** 空白成本测算与报价单模板（action=template）。 */
export function quoteTemplate(pricingResult = null) {
  const loaded = pricingResult || loadPricing({});
  const rates = loaded.pricing.rateCard;
  const d = loaded.pricing.defaults;
  const lines = [
    '# 成本测算与报价单（空白模板）',
    '',
    '> 工具：`fde_quote`（action=template）；填写后用 `fde_quote`（action=calculate）复算。示例客户一律写「某客户」。',
    '> ' + QUOTE_DISCLAIMER,
    '',
    '## 一、人力成本（支持三点估算）',
    '',
    '| 角色 | 人数 | 乐观 o | 最可能 m | 悲观 p | P50=te | P80 计价人天 | 费率（元/人天） | 金额（元） | 依据 |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rates) {
    lines.push('| ' + cell(r.label) + ' |  |  |  |  |  |  | ' + money(r.ratePerPersonDay) + ' |  |  |');
  }
  lines.push('|  |  |  |  |  |  |  |  |  |  |');
  lines.push('', '> 三点估算：`te=(o+4m+p)/6`，`σ=(p−o)/6`，计价按 **P80=te+0.84σ 向上取 0.1 人天**；直接填人天时 P50=P80=人天。');
  lines.push('> 费率（内部成本费率，方法默认值）：' + rates.map((r) => r.label + ' ' + money(r.ratePerPersonDay) + '/人天').join('；') + '。');
  lines.push('', '## 二、非人力成本', '');
  lines.push('| 成本项 | 金额（元） | 依据 | 封顶（按量项年度上限/实报实销） |');
  lines.push('|---|---|---|---|');
  for (const k of NON_LABOR_KEYS) lines.push('| ' + cell(k.label) + ' |  |  |  |');
  lines.push('| **非人力小计** |  |  |');
  lines.push('', '## 三、预备费、税费与报价参数', '');
  lines.push('- 风险预备费：' + pct(d.contingencyPct) + '（按直接成本）');
  lines.push('- 税率：' + pct(d.taxPct) + '（含税报价，按现行税目与财务确认）');
  lines.push('- 目标毛利率：' + pct(d.marginPct) + '（经验区间 35%–50%）；折扣：' + pct(d.discountPct));
  lines.push('- 甜点区（方法默认）：' + money(d.sweetSpotMin) + ' – ' + money(d.sweetSpotMax));
  lines.push('', '## 四、报价单结构', '');
  lines.push('- 报价区间：成本底线 / 目标报价 / 定价上限 / 本次报价（含折扣）');
  lines.push('- 报价范围：只做已锁定场景；范围外需求走变更单');
  lines.push('- 除外：客户内部系统改造、第三方许可与硬件采购、超次数变更、差旅超标准部分');
  lines.push('- 交付物：与方案/Pilot Charter 一致的可检查产物清单');
  lines.push('- 里程碑付款：预付款 %｜里程碑 %｜验收尾款 %');
  lines.push('- 假设与客户责任：数据提供方、接口开放时间、验收人、评审节奏');
  lines.push('- 验收与质保：验收口径 + 质保期与响应时限');
  lines.push('- 有效期：报价有效期（建议 30 天）');
  lines.push('', '## 五、变更单', '');
  lines.push('| 变更项 | 原因 | 增减人天 | 增减金额（元） | 确认人/日期 |');
  lines.push('|---|---|---|---|---|');
  lines.push('|  |  |  |  |  |');
  lines.push('', '> ' + (loaded.pricing.disclaimer || QUOTE_DISCLAIMER));
  return lines.join('\n');
}

/**
 * fde_quote 入口（纯函数，不写文件）。
 * @param {object} input spec §21.2 参数
 */
export function calculateQuote(input = {}) {
  const action = str(input.action) || 'calculate';
  if (action === 'template') {
    const loaded = loadPricing(input && input.pricingPath ? { pricingPath: input.pricingPath } : {});
    return { ok: true, action: 'template', markdown: quoteTemplate(loaded), warnings: (loaded.warnings || []).slice() };
  }
  if (action !== 'calculate') {
    return { ok: false, code: 'INVALID', reason: `未知 action：${action}（calculate|template）` };
  }
  return computeQuote(input);
}
