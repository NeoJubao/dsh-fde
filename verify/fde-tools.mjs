/**
 * FDE 交付工具单测（spec §21，v1.3 修订版）：`fde_scenario` / `fde_quote`
 *
 * 纯函数 + 工具层双覆盖：
 * - fde_scenario：4 条硬门槛、12 维归一化加权分（权重合计 101，**不得除以 100**）、
 *   1–7 否决项、档位（≥3.6 / 3.2–3.6 / <3.2）、排序、template；
 * - fde_quote：三点估算 P80/P50、10 步公式（固定输入断言到分）、7 项非人力、
 *   亏损/低毛利/严重低毛利/甜点区/漏项/预备费/人天不匹配/非人力占比警告、template；
 * - 定价配置：缺失/损坏回退 + warning，自定义配置生效；
 * - 工具不写文件、不写 board、不联网（调用前后文件内容与 mtime 不变；global fetch 0 次）。
 *
 * 不联网、不写真实 research/。
 * 用法: node verify/fde-tools.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as calc from '../src/host/fde-calc.js';

const __toUrl = (p) => (String(p).startsWith('file:') ? p : pathToFileURL(p).href);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ---------------- 断言器 / 临时目录 ---------------- */
const passed = [];
const failed = [];
const check = (name, cond, extra) => {
  if (cond) { passed.push(name); console.log('  ✓ ' + name); return true; }
  const detail = extra === undefined ? '' : ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 500));
  failed.push(name + detail);
  console.log('  ✗ ' + name + detail);
  return false;
};
const section = (t) => console.log('\n── ' + t + ' ──');

const tempDirs = [];
const newTemp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); tempDirs.push(d); return d; };
const newWs = () => {
  const d = newTemp('rw-tools-ws-');
  mkdirSync(join(d, 'research', '.fde'), { recursive: true });
  return d;
};
const cleanup = () => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } };
process.on('exit', cleanup);

/* 全局网络护栏：本文件的工具应完全不触网 */
const realFetch = globalThis.fetch;
let globalFetchCalls = 0;
globalThis.fetch = () => { globalFetchCalls += 1; return Promise.reject(new Error('测试禁止真实网络请求')); };
process.on('exit', () => { globalThis.fetch = realFetch; });

/* 合法定价配置（临时文件；避免受插件 reference 下真实配置是否存在影响） */
function pricingFixture(patch = {}) {
  const base = JSON.parse(JSON.stringify(calc.DEFAULT_PRICING));
  base.notes = [
    '费率为内部成本费率，不是对外报价；对外报价 = 成本 ÷ (1 − 毛利)。',
  ];
  return Object.assign(base, patch, { defaults: Object.assign({}, base.defaults, (patch && patch.defaults) || {}) });
}
const pricingDir = newTemp('rw-tools-pricing-');
const pricingPath = join(pricingDir, 'fde-pricing.json');
writeFileSync(pricingPath, JSON.stringify(pricingFixture(), null, 2), 'utf8');

/* 固定输入（spec §21.2 示例口径：一行直接人天 + 一行三点估算） */
const BASE_QUOTE = {
  action: 'calculate',
  labor: [
    { name: 'FDE/算法', personDays: 20, rate: 1200 },
    { name: '数据与评测', optimistic: 8, likely: 10, pessimistic: 15, rate: 940 },
  ],
  defaultRate: 940,
  nonLabor: { dataEval: 10000, cloudToken: 2000, compliance: 3000, ops: 2000, travel: 1000, quality: 2000, other: 0 },
  contingencyPct: 15, taxPct: 6, marginPct: 35, discountPct: 0, teamSize: 3, weeks: 12,
  pricingPath,
};
const q0 = calc.calculateQuote(BASE_QUOTE);

/* 场景夹具：12 维分值使 Σ(分×权重)=360（若错误地除以 100 会得到 3.60） */
const SCORES_360 = { value: 5, pain: 4, data: 3, tech: 3, accept: 3, compliance: 4, roi: 3, readiness: 3, delivery: 3, reuse: 3, alternative: 4, timing: 3 };
const GATES_OK = { sponsor: true, integration14d: true, prod90d: true, measurable: true };

/* ================= 1. 常量与归一化口径（spec §21.1 / §21.5-1） ================= */
section('1. 场景评估常量与归一化口径');
{
  check('12 维权重合计 = 101（不是 100）', calc.SCENARIO_WEIGHT_SUM === 101 && calc.SCENARIO_DIMENSIONS.length === 12,
    { sum: calc.SCENARIO_WEIGHT_SUM, dims: calc.SCENARIO_DIMENSIONS.length });
  const weights = calc.SCENARIO_DIMENSIONS.map((d) => d.key + '=' + d.weight).join(',');
  check('12 维 key/权重与 spec §21.1 一致',
    weights === 'value=18,pain=10,data=14,tech=12,accept=10,compliance=8,roi=8,readiness=7,delivery=6,reuse=4,alternative=3,timing=1', weights);
  check('归一化 = Σ(分×权重)/Σ权重（360 → 3.56，不是 3.60）',
    calc.normalizeScenarioScore(360) === 3.56 && calc.normalizeScenarioScore(101) === 1 && calc.normalizeScenarioScore(505) === 5,
    calc.normalizeScenarioScore(360));
  check('档位阈值为 3.6 / 3.2', calc.SCENARIO_GRADE_PASS_MIN === 3.6 && calc.SCENARIO_GRADE_SUPPLEMENT_MIN === 3.2
    && calc.scenarioGrade(3.6) === '进方案' && calc.scenarioGrade(3.59) === '补证/小 POC' && calc.scenarioGrade(3.2) === '补证/小 POC'
    && calc.scenarioGrade(3.19) === '拒绝或转咨询');
  check('否决项 1–7 齐全', calc.SCENARIO_VETO_IDS.join(',') === '1,2,3,4,5,6,7');
  check('非人力 7 项与 spec §21.2 一致', calc.NON_LABOR_KEY_LIST.join(',') === 'dataEval,cloudToken,compliance,ops,travel,quality,other');
}

/* ================= 2. fde_scenario：归一化回归 / 门槛 / 否决 / 档位 / 排序 ================= */
section('2. fde_scenario（§21.5-1）');
{
  /* —— 归一化回归：360 / 101 = 3.56；若除以 100 会变 3.60（档位从补证误判为进方案）—— */
  const rA = calc.evaluateScenario({ action: 'evaluate', scenarios: [{ name: 'A 场景', gates: GATES_OK, scores: SCORES_360, vetoes: [] }] });
  const a0 = rA.ranked[0];
  check('Evaluate 归一化回归：Σ(分×权重)=360、weightSum=101、score=3.56（≠3.60）',
    rA.ok === true && a0.rawSum === 360 && a0.weightSum === 101 && a0.score === 3.56 && a0.score !== 3.6,
    { rawSum: a0.rawSum, score: a0.score });
  check('归一化回归：档位=「补证/小 POC」（不是「进方案」）', a0.conclusion === '补证/小 POC' && a0.eligible === true, a0.conclusion);
  check('返回值含 formula.normalize 且声明除以 101', rA.formula && rA.formula.weightSum === 101
    && /101/.test(rA.formula.normalize) && !/\/100/.test(rA.formula.normalize), rA.formula);
  check('markdown 附录写明「不得除以 100」与 12 维权重',
    rA.markdown.includes('除以 100') && rA.markdown.includes('value=18') && rA.markdown.includes('Σ(分值×权重)'));

  /* —— 档位边界：364 → 3.60 进方案；363 → 3.59 补证 —— */
  const raw364 = { value: 5, pain: 4, data: 4, tech: 3, accept: 3, compliance: 3, roi: 3, readiness: 3, delivery: 3, reuse: 3, alternative: 3, timing: 4 };
  const raw363 = { value: 5, pain: 4, data: 3, tech: 3, accept: 4, compliance: 3, roi: 3, readiness: 3, delivery: 3, reuse: 3, alternative: 4, timing: 4 };
  const r364 = calc.scoreScenario({ name: '364', gates: GATES_OK, scores: raw364, vetoes: [] });
  const r363 = calc.scoreScenario({ name: '363', gates: GATES_OK, scores: raw363, vetoes: [] });
  check('364/101 = 3.60 → 进方案', r364.rawSum === 364 && r364.score === 3.6 && r364.conclusion === '进方案', { raw: r364.rawSum, score: r364.score });
  check('363/101 = 3.59 → 补证/小 POC', r363.rawSum === 363 && r363.score === 3.59 && r363.conclusion === '补证/小 POC', { raw: r363.rawSum, score: r363.score });

  /* —— 四条硬门槛：任一 false → 暂不启动并列出缺项 —— */
  const rGate = calc.evaluateScenario({
    action: 'evaluate',
    scenarios: [{
      name: '缺门槛场景',
      gates: { sponsor: false, integration14d: true, prod90d: false, measurable: true },
      scores: SCORES_360,
    }],
  });
  const g0 = rGate.ranked[0];
  check('四条硬门槛任一 false → startable=false / 暂不启动', g0.startable === false && g0.conclusion === '暂不启动（补前置条件）', g0.conclusion);
  check('列出缺失门槛（发起人 + 90 天上线）', g0.missing.length === 2
    && g0.missing.some((x) => x.includes('发起人')) && g0.missing.some((x) => x.includes('90 天')), g0.missing);

  /* —— 否决项：任一命中 → 不进方案（例外需人签字），且排到可进方案之后 —— */
  const rVeto = calc.evaluateScenario({
    action: 'evaluate',
    scenarios: [{ name: '否决场景', gates: GATES_OK, scores: SCORES_360, vetoes: [2, 9] }],
  });
  const v0 = rVeto.ranked[0];
  check('否决项命中 → 不进方案（例外需人签字）', v0.vetoed === true && v0.eligible === false && v0.conclusion === '不进方案（例外需人签字）', v0.conclusion);
  check('否决项编号与文案（2=合规或安全禁止）', v0.vetoes.join(',') === '2' && v0.vetoLabels[0].includes('合规'), v0.vetoLabels);
  check('未知否决编号被忽略并给 warning', rVeto.warnings.some((w) => w.includes('否决')), rVeto.warnings);

  /* —— 排序：可进方案优先 → 分数降序 → value 降序 —— */
  const rRank = calc.evaluateScenario({
    action: 'evaluate',
    scenarios: [
      { name: '低分可进', gates: GATES_OK, scores: { value: 3, pain: 3, data: 3, tech: 3, accept: 3, compliance: 3, roi: 3, readiness: 3, delivery: 3, reuse: 3, alternative: 3, timing: 3 } },
      { name: '高分但缺门槛', gates: { sponsor: false, integration14d: true, prod90d: true, measurable: true }, scores: { value: 5, pain: 5, data: 5, tech: 5, accept: 5, compliance: 5, roi: 5, readiness: 5, delivery: 5, reuse: 5, alternative: 5, timing: 5 } },
      { name: '高分有否决', gates: GATES_OK, scores: { value: 5, pain: 5, data: 5, tech: 5, accept: 5, compliance: 5, roi: 5, readiness: 5, delivery: 5, reuse: 5, alternative: 5, timing: 5 }, vetoes: [1] },
      { name: '高分可进', gates: GATES_OK, scores: { value: 5, pain: 5, data: 5, tech: 5, accept: 5, compliance: 5, roi: 5, readiness: 5, delivery: 5, reuse: 5, alternative: 5, timing: 5 } },
    ],
  });
  const order = rRank.ranked.map((x) => x.name);
  check('排序：可进方案优先，再按归一化分降序', order[0] === '高分可进' && order[1] === '低分可进'
    && order.slice(2).sort().join(',') === ['高分但缺门槛', '高分有否决'].sort().join(','), order);

  /* —— 同分按 value 降序：value 高者在前（构造同 rawSum）—— */
  const sameA = { value: 3, pain: 3, data: 3, tech: 3, accept: 3, compliance: 3, roi: 3, readiness: 3, delivery: 3, reuse: 3, alternative: 3, timing: 3 }; // 303
  const sameB = { value: 5, pain: 1, data: 2, tech: 3, accept: 3, compliance: 3, roi: 3, readiness: 3, delivery: 3, reuse: 3, alternative: 3, timing: 1 }; // 303
  const rTie = calc.evaluateScenario({ action: 'evaluate', scenarios: [{ name: '同分低价值', gates: GATES_OK, scores: sameA }, { name: '同分高价值', gates: GATES_OK, scores: sameB }] });
  check('同分按 value 降序（同 rawSum=303，value 5 在前）',
    rTie.ranked[0].rawSum === rTie.ranked[1].rawSum && rTie.ranked[0].scores.value === 5 && rTie.ranked[0].name === '同分高价值',
    rTie.ranked.map((x) => x.name + ':' + x.scores.value + ':' + x.rawSum));

  /* —— 非法 action / 空 scenarios / 缺字段容错 —— */
  check('未知 action → INVALID，不抛异常', calc.evaluateScenario({ action: 'nope' }).ok === false
    && calc.evaluateScenario({ action: 'nope' }).code === 'INVALID');
  check('scenarios 为空 → INVALID', calc.evaluateScenario({ action: 'evaluate', scenarios: [] }).ok === false);
  const rPartial = calc.evaluateScenario({ action: 'evaluate', scenarios: [{ name: '只给一半分值', gates: GATES_OK, scores: { value: 5 } }] });
  check('缺失维度按 3 分计、超出 1–5 被夹紧（不抛异常）',
    rPartial.ok === true && rPartial.ranked[0].scores.value === 5 && rPartial.ranked[0].scores.pain === 3, rPartial.ranked[0].scores);

  /* —— template —— */
  const tpl = calc.evaluateScenario({ action: 'template' });
  check('template 返回空白评分表（12 维 + 4 门槛 + 否决项 + 依据列 + 档位说明 + 101）',
    tpl.ok === true && tpl.action === 'template'
      && ['12 维', '四条硬门槛', '否决项', '依据', '档位', '101', '归一化'].every((k) => tpl.markdown.includes(k)), tpl.markdown && tpl.markdown.slice(0, 100));
  check('template 不包含真实客户名（示例口径）', /某客户/.test(tpl.markdown));
}

/* ================= 3. fde_quote：三点估算 / 公式 / 汇总（§21.5-2） ================= */
section('3. fde_quote 公式（固定输入断言到分）');
{
  const s = q0.summary || {};
  check('三点估算：te=(8+40+15)/6=10.5、σ=7/6、P80=te+0.84σ=11.48 → 向上取 0.1 = 11.5',
    q0.details.labor[1].estimate === 'three-point' && q0.details.labor[1].p50PersonDays === 10.5
      && q0.details.labor[1].p80PersonDays === 11.5 && q0.details.labor[1].personDays === 11.5,
    q0.details.labor[1]);
  check('直接人天行：P50=P80=personDays', q0.details.labor[0].p50PersonDays === 20 && q0.details.labor[0].p80PersonDays === 20
    && q0.details.labor[0].personDays === 20);
  check('laborCost = Σ(计价人天×费率) = 20×1200 + 11.5×940 = 34810 元', s.laborCost === 34810, s.laborCost);
  check('nonLaborTotal = 20000（7 项求和）', s.nonLaborTotal === 20000, s.nonLaborTotal);
  check('directCost = 54810', s.directCost === 54810, s.directCost);
  check('contingency = directCost×15% = 8221.50', s.contingency === 8221.5, s.contingency);
  check('totalCost = 63031.50', s.totalCost === 63031.5, s.totalCost);
  check('floor = totalCost×1.06 = 66813.39', s.floor === 66813.39, s.floor);
  check('target = totalCost/(1−35%)×1.06 = 102789.83', s.target === 102789.83, s.target);
  check('final = target×(1−0%) = 102789.83', s.final === 102789.83, s.final);
  check('ceiling = totalCost/(1−45%)×1.06 = 121478.89', s.ceiling === 121478.89, s.ceiling);
  check('realizedMarginPct = 35.00 / marginAmount = 33940.04', s.realizedMarginPct === 35 && s.marginAmount === 33940.04,
    { margin: s.realizedMarginPct, amount: s.marginAmount });
  check('汇总含 P50/P80 总人天（30.5 / 31.5）', s.p50PersonDays === 30.5 && s.p80PersonDays === 31.5, { p50: s.p50PersonDays, p80: s.p80PersonDays });
  check('summary 字段齐全（spec §21.2 全部键）',
    ['laborCost', 'nonLaborTotal', 'directCost', 'contingency', 'totalCost', 'floor', 'target', 'ceiling', 'final', 'realizedMarginPct', 'marginAmount']
      .every((k) => Number.isFinite(s[k])), Object.keys(s));
  check('正常场景无风险警告（定价配置存在时）', Array.isArray(q0.warnings) && q0.warnings.length === 0, q0.warnings);
  check('markdown 含成本明细/报价测算/假设与除外/变更单/验收口径/免责',
    ['成本汇总', '报价测算', '假设与除外', '变更单', '验收口径', '不构成对外报价'].every((k) => q0.markdown.includes(k)));
  check('三点估算：o=m=p=10 → σ=0、P80=10（不因浮点误差进位到 10.1）',
    calc.threePointEstimate(10, 10, 10).p80 === 10 && calc.threePointEstimate(10, 10, 10).sigma === 0);
  check('P80 向上取 0.1 边界：te+0.84σ=11.5 仍是 11.5；11.48 → 11.5',
    calc.ceilTenth(11.5) === 11.5 && calc.ceilTenth(11.48) === 11.5 && calc.ceilTenth(11.41) === 11.5 && calc.ceilTenth(10) === 10);
}

/* ================= 4. fde_quote 警告（§21.2 / §21.5-2） ================= */
section('4. fde_quote 警告触发（不阻断）');
{
  const q = (patch) => calc.calculateQuote(Object.assign({}, BASE_QUOTE, patch));
  const has = (r, re) => (r.warnings || []).some((w) => re.test(w));

  const loss = q({ discountPct: 45 });
  check('final < floor → 亏损警告', loss.summary.final === 56534.41 && loss.summary.floor === 66813.39
    && has(loss, /亏损/), { final: loss.summary.final, warnings: loss.warnings });
  check('realizedMarginPct < 20 → 低毛利警告；< 10 另标严重',
    has(loss, /低于定制交付经验区间下限/) && has(loss, /严重偏低/), loss.warnings);

  const low = q({ discountPct: 20 });
  check('18.75% < 20% → 低毛利警告（但不标严重）',
    low.summary.realizedMarginPct === 18.75 && has(low, /低于定制交付经验区间下限/) && !has(low, /严重偏低/), low.warnings);

  const severe = q({ discountPct: 33 });
  check('2.99% < 10% → 严重低毛利警告', severe.summary.realizedMarginPct === 2.99 && has(severe, /严重偏低/), severe.warnings);

  const sweet = calc.calculateQuote({
    action: 'calculate', pricingPath,
    labor: [{ name: '大项目', personDays: 200, rate: 1200 }],
    nonLabor: { dataEval: 10000, cloudToken: 2000, compliance: 3000, ops: 2000, travel: 1000, quality: 2000, other: 0 },
    contingencyPct: 15, taxPct: 6, marginPct: 35, discountPct: 0, teamSize: 3, weeks: 12,
  });
  check('final > sweetSpotMax（20 万）→ 甜点区/尾款风险警告', sweet.summary.final === 487600 && has(sweet, /甜点区/), sweet.warnings);

  const missing = q({ nonLabor: {} });
  check('cloudToken/ops/compliance = 0 → 漏项警告（AI 项目吞利润项）', has(missing, /漏项/) && has(missing, /cloudToken/), missing.warnings);
  check('dataEval = 0 → 数据清洗/标注/评测集漏项警告', has(missing, /数据清洗/), missing.warnings);

  const lowCont = q({ contingencyPct: 5 });
  check('contingencyPct < 10 → 预备费偏低警告', has(lowCont, /预备费偏低/), lowCont.warnings);

  const mismatch = q({ weeks: 2, teamSize: 1 });
  check('P80 总人天 /(weeks×5) > teamSize×1.2 → 人天与周期不匹配警告', has(mismatch, /人天与周期不匹配/), mismatch.warnings);

  const nonlabor = calc.calculateQuote({
    action: 'calculate', pricingPath,
    labor: [{ name: '少量人力', personDays: 10, rate: 1000 }],
    nonLabor: { dataEval: 20000, cloudToken: 10000, compliance: 5000, ops: 5000, travel: 0, quality: 0, other: 0 },
    contingencyPct: 15, taxPct: 6, marginPct: 35, discountPct: 0,
  });
  check('非人力占比 > 40% → 年度上限/实报实销警告', has(nonlabor, /非人力成本为主/), nonlabor.warnings);
  check('非人力成本为主时报价公式仍按 totalCost 计算', nonlabor.summary.totalCost === 57500, nonlabor.summary.totalCost);

  check('marginPct ≥ 90 / 非法税率 → INVALID 不抛异常',
    calc.calculateQuote(Object.assign({}, BASE_QUOTE, { marginPct: 90 })).code === 'INVALID'
      && calc.calculateQuote(Object.assign({}, BASE_QUOTE, { taxPct: 100 })).code === 'INVALID'
      && calc.calculateQuote(Object.assign({}, BASE_QUOTE, { discountPct: -1 })).code === 'INVALID');
}

/* ================= 5. fde_quote template ================= */
section('5. fde_quote template（空白成本测算与报价单）');
{
  const tpl = calc.calculateQuote({ action: 'template', pricingPath });
  check('template 返回 Markdown 且含成本项/报价结构/三点估算说明',
    tpl.ok === true && tpl.action === 'template'
      && ['三点估算', '数据与评测', '云与推理', '合规', '运维', '差旅', '质保', '预备费', '税', '依据', '封顶',
        '范围', '除外', '交付物', '里程碑付款', '假设与客户责任', '变更单', '验收与质保', '有效期']
        .every((k) => tpl.markdown.includes(k)), tpl.markdown && tpl.markdown.slice(0, 120));
  check('template 含方法默认值免责声明与「某客户」示例口径', /不构成对外报价/.test(tpl.markdown) && /某客户/.test(tpl.markdown));
}

/* ================= 6. 定价配置（§21.3 / §21.5-4） ================= */
section('6. 定价配置加载（缺失/损坏/自定义）');
{
  const missingPath = join(newTemp('rw-tools-nopricing-'), 'fde-pricing.json');
  const lp = calc.loadPricing({ pricingPath: missingPath });
  check('配置缺失 → 内置默认值 + warning', lp.source === 'default' && lp.warnings.some((w) => w.includes('定价配置缺失'))
    && lp.pricing.defaults.ratePerPersonDay === 940 && lp.pricing.defaults.contingencyPct === 15
    && lp.pricing.defaults.marginPct === 35 && lp.pricing.defaults.sweetSpotMax === 200000, lp.pricing.defaults);
  const qMissing = calc.calculateQuote({ action: 'calculate', pricingPath: missingPath, labor: [{ name: 'x', personDays: 10 }] });
  check('缺失配置时报价仍用默认费率 940 且 warnings 提示',
    qMissing.ok === true && qMissing.summary.defaultRate === 940 && qMissing.summary.laborCost === 9400
      && qMissing.warnings.some((w) => w.includes('定价配置缺失')), qMissing.summary);

  const corruptDir = newTemp('rw-tools-badpricing-');
  const corruptPath = join(corruptDir, 'bad.json');
  writeFileSync(corruptPath, '{ not json', 'utf8');
  const lpc = calc.loadPricing({ pricingPath: corruptPath });
  check('配置损坏 → 内置默认值 + warning', lpc.source === 'default' && lpc.warnings.some((w) => w.includes('损坏'))
    && lpc.pricing.defaults.ratePerPersonDay === 940, lpc.warnings);

  const customDir = newTemp('rw-tools-custompricing-');
  const customPath = join(customDir, 'fde-pricing.json');
  writeFileSync(customPath, JSON.stringify({
    version: 2, updatedAt: '2026-11-04', currency: 'CNY',
    defaults: { ratePerPersonDay: 1000, contingencyPct: 10, taxPct: 3, marginPct: 50, discountPct: 0, sweetSpotMin: 50000, sweetSpotMax: 999999 },
    rateCard: [{ key: 'fde', label: 'FDE', ratePerPersonDay: 1500 }],
    notes: [], disclaimer: '自定义配置免责声明',
  }, null, 2), 'utf8');
  const lpcCustom = calc.loadPricing({ pricingPath: customPath });
  check('自定义配置生效（费率/预备费/毛利/税率/甜点区）',
    lpcCustom.source === 'file' && lpcCustom.pricing.defaults.ratePerPersonDay === 1000
      && lpcCustom.pricing.defaults.contingencyPct === 10 && lpcCustom.pricing.defaults.marginPct === 50
      && lpcCustom.pricing.defaults.taxPct === 3 && lpcCustom.pricing.defaults.sweetSpotMax === 999999, lpcCustom.pricing.defaults);
  const qCustom = calc.calculateQuote({ action: 'calculate', pricingPath: customPath, labor: [{ name: 'x', personDays: 10 }] });
  check('自定义配置驱动报价：labor 10000 / contingency 1000 / total 11000 / final 22660',
    qCustom.summary.laborCost === 10000 && qCustom.summary.contingency === 1000
      && qCustom.summary.totalCost === 11000 && qCustom.summary.final === 22660, qCustom.summary);

  const partialDir = newTemp('rw-tools-partialpricing-');
  const partialPath = join(partialDir, 'fde-pricing.json');
  writeFileSync(partialPath, JSON.stringify({ version: 1, defaults: { ratePerPersonDay: 880, marginPct: '坏值' }, rateCard: [] }), 'utf8');
  const lpPartial = calc.loadPricing({ pricingPath: partialPath });
  check('配置字段非法/rateCard 为空 → 回退默认并 warning',
    lpPartial.pricing.defaults.ratePerPersonDay === 880 && lpPartial.pricing.defaults.marginPct === 35
      && lpPartial.pricing.rateCard.length >= 1 && lpPartial.warnings.some((w) => w.includes('回退')), lpPartial.warnings);
}

/* ================= 7. 工具层：index.js 注册 / 不写文件 / 不联网（§21.4 / §21.5-3、5） ================= */
section('7. 工具层（注册 / 不写文件 / 不联网）');
let tools = null;
{
  const mod = await import(__toUrl(join(ROOT, 'index.js')));
  tools = [];
  const mod2 = { sections: [] };
  mod.apply({
    logger: { info() {}, warn() {}, error() {} },
    effect() { return () => {}; },
    get(n) {
      if (n === 'tools') return { register(d) { tools.push(d); return () => {}; } };
      if (n === 'systemPrompt') return { section(d) { mod2.sections.push(d); }, getSectionOrder: () => 2950 };
      return undefined;
    },
  });
  const tScn = tools.find((t) => t.name === 'fde_scenario');
  const tQuote = tools.find((t) => t.name === 'fde_quote');
  check('注册 fde_scenario / fde_quote 两个工具', !!tScn && !!tQuote);
  check('工具 schema：action 枚举 + parameters + execute + presentCall + render',
    tScn && JSON.stringify(tScn.parameters.properties.action.enum) === JSON.stringify(['evaluate', 'template'])
      && tQuote && JSON.stringify(tQuote.parameters.properties.action.enum) === JSON.stringify(['calculate', 'template'])
      && [tScn, tQuote].every((t) => t.parameters.type === 'object' && typeof t.execute === 'function'
        && typeof t.presentCall === 'function' && t.output && typeof t.output.render === 'function'));
  check('系统提示词含两个工具与「不构成对外报价」口径',
    mod2.sections[0] && /fde_scenario/.test(mod2.sections[0].text) && /fde_quote/.test(mod2.sections[0].text)
      && /不构成对外报价/.test(mod2.sections[0].text) && /归一化/.test(mod2.sections[0].text));

  /* 工具层 evaluate：归一化回归数字在工具返回中同样成立 */
  const outS = await tScn.execute({ action: 'evaluate', scenarios: [{ name: 'A', gates: GATES_OK, scores: SCORES_360 }] });
  check('工具 evaluate：ranked[0].score=3.56 / conclusion=补证/小 POC / formula.weightSum=101',
    outS.ok === true && outS.ranked[0].score === 3.56 && outS.ranked[0].conclusion === '补证/小 POC'
      && outS.formula.weightSum === 101, { score: outS.ranked && outS.ranked[0] && outS.ranked[0].score });
  check('工具 evaluate 文本含归一化口径与「不得除以 100」', outS.text.includes('归一化') && outS.text.includes('不得除以 100'));
  const outTpl = await tScn.execute({ action: 'template' });
  check('工具 template 返回空白评分表', outTpl.ok === true && outTpl.action === 'template' && outTpl.markdown.includes('否决项'));

  const outQ = await tQuote.execute({
    action: 'calculate', title: '某客户 AI 场景', labor: BASE_QUOTE.labor, defaultRate: 940,
    nonLabor: BASE_QUOTE.nonLabor, contingencyPct: 15, taxPct: 6, marginPct: 35, discountPct: 0, teamSize: 3, weeks: 12,
  });
  const outSummary = (outQ.summary) || {};
  check('工具 calculate：summary 数字与模块一致（到分）', outQ.ok === true && outSummary.laborCost === 34810
    && outSummary.totalCost === 63031.5 && outSummary.final === 102789.83 && outSummary.realizedMarginPct === 35, outSummary);
  check('工具 calculate 文本含「不构成对外报价」与 markdown 字段', outQ.text.includes('不构成对外报价') && typeof outQ.markdown === 'string'
    && outQ.markdown.includes('变更单'));
  const outQTpl = await tQuote.execute({ action: 'template' });
  check('工具 template 返回空白成本测算与报价单', outQTpl.ok === true && outQTpl.markdown.includes('三点估算') && outQTpl.markdown.includes('变更单'));

  /* 不写文件 / 不写 board：调用前后 board.json 与 research/.fde 目录内容一致 */
  const ws = newWs();
  const boardFile = join(ws, 'research', '.fde', 'board.json');
  writeFileSync(boardFile, JSON.stringify({ version: 1, revision: 0, engagements: [], items: [] }), 'utf8');
  const beforeBytes = readFileSync(boardFile, 'utf8');
  const beforeMtime = statSync(boardFile).mtimeMs;
  const beforeFiles = readdirSync(join(ws, 'research', '.fde')).sort().join(',');
  await tScn.execute({ action: 'template' });
  await tScn.execute({ action: 'evaluate', scenarios: [{ name: 'X', gates: GATES_OK, scores: SCORES_360 }] });
  await tQuote.execute({ action: 'template' });
  await tQuote.execute({ action: 'calculate', labor: [{ name: 'a', personDays: 1, rate: 1000 }] });
  check('工具不写文件/不写 board（内容与 mtime 不变、.fde 目录无新增）',
    readFileSync(boardFile, 'utf8') === beforeBytes && statSync(boardFile).mtimeMs === beforeMtime
      && readdirSync(join(ws, 'research', '.fde')).sort().join(',') === beforeFiles);
  check('工具不联网（global fetch 调用次数 0）', globalFetchCalls === 0, globalFetchCalls);
  check('未知 action 返回 ok:false/INVALID，不抛异常',
    (await tScn.execute({ action: 'nope' })).code === 'INVALID' && (await tQuote.execute({ action: 'nope' })).code === 'INVALID');
}

/* ---------------- 汇总 ---------------- */
console.log('\n=== 通过 ' + passed.length + ' 项 ===');
if (failed.length) {
  console.log('\n=== 失败 ' + failed.length + ' 项 ===');
  for (const f of failed) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('FDE 交付工具单测全部通过（纯计算、未联网）。');
}
cleanup();
