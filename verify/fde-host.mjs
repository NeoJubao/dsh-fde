/**
 * FDE 工作站 · 宿主半单测（schema / store / rules / api / 工具与技能注册）
 *
 * 覆盖 spec §13 验收项 A1–A9（宿主部分）+ A10（工具域宿主侧）+ A12（技能注册函数）+ A14（health）；
 * 全程使用 os.tmpdir() 临时工作区，不读写真实 research/。
 *
 * 用法: node verify/fde-host.mjs
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  existsSync, rmSync, symlinkSync, statSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as schema from '../src/host/fde-schema.js';
import * as store from '../src/host/fde-store.js';
import * as rules from '../src/host/fde-rules.js';
import * as prompts from '../src/host/fde-prompts.js';
import * as api from '../src/host/fde-api.js';
import * as fdeBids from '../src/host/fde-bids.js';
import * as fdeCalc from '../src/host/fde-calc.js';

const __toUrl = (p) => (String(p).startsWith('file:') ? p : pathToFileURL(p).href);

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(__toUrl(join(PLUGIN, 'index.js')));

/* ---------------- 断言器 ---------------- */
const passed = [];
const failed = [];
const check = (name, cond, extra) => {
  if (cond) { passed.push(name); console.log('  ✓ ' + name); return true; }
  const detail = extra === undefined ? '' : ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400));
  failed.push(name + detail);
  console.log('  ✗ ' + name + detail);
  return false;
};
/* 环境能力缺失导致的未验证项：显式 SKIP（日志可见、汇总单列），既不算通过也不判失败。 */
const skipped = [];
const skip = (name, why) => {
  skipped.push(name + (why ? '（' + why + '）' : ''));
  console.log('  ⚠ SKIP ' + name + (why ? ' → ' + why : ''));
};
const section = (t) => console.log('\n── ' + t + ' ──');

/* ---------------- 临时工作区 ---------------- */
const ws = mkdtempSync(join(tmpdir(), 'fde-host-'));
const research = join(ws, 'research');
mkdirSync(research, { recursive: true });
const fixRoots = [];
const newRoot = (tag) => {
  const p = mkdtempSync(join(tmpdir(), 'fde-fix-' + tag + '-'));
  mkdirSync(join(p, 'research'), { recursive: true });
  fixRoots.push(p);
  return p;
};
const cleanup = () => {
  try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const r of fixRoots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } }
};
process.on('exit', cleanup);

const DAY = 86400000;
const isoDaysFromNow = (n) => new Date(Date.now() + n * DAY).toISOString();
const dateDaysFromNow = (n) => store.addDaysStr(n);

/** 造客户目录与工件 */
function makeProject(dir, files = {}) {
  const base = join(research, dir);
  for (const d of ['raw', 'research', 'meeting', 'proposal', 'pilot', 'delivery', 'adoption']) {
    mkdirSync(join(base, d), { recursive: true });
  }
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(base, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return base;
}

/* ============================ A1 看板读取 ============================ */
section('A1 看板读取');
{
  const genEng = (id, name, stage, extra = {}) => Object.assign({
    id, name, company: name + '有限公司', shortName: '', dir: '',
    stage, stageSince: store.nowIso(), paused: false, priority: 'normal',
    owner: 'Neo', tags: [], source: { kind: 'manual', ref: '', at: store.nowIso() },
    value: { amount: 0, currency: 'CNY', note: '' },
    nextAction: { text: '补 KPI 假设', due: dateDaysFromNow(9), owner: 'Neo' },
    stakeholders: [], gateState: {}, attention: null, sessionId: '',
    createdAt: store.nowIso(), adopted: false, timeline: [],
  }, extra);
  const genItem = (id, title, lane, extra = {}) => Object.assign({
    id, engagementId: '', title, type: 'research', stage: lane, priority: 'normal',
    due: '', owner: 'human', source: { kind: 'manual', ref: '', at: store.nowIso() },
    autonomy: { mode: 'observe', rule: '' }, attention: null, reports: [],
    sessionId: '', createdAt: store.nowIso(), history: [],
  }, extra);
  const board = store.emptyBoard();
  board.engagements.push(genEng('eng_aaaaa1', '甲客户', 'lead'));
  board.engagements.push(genEng('eng_aaaaa2', '乙客户', 'discovery', { priority: 'high' }));
  board.items.push(genItem('itm_bbbbb1', '任务一', 'todo', { engagementId: 'eng_aaaaa1', due: dateDaysFromNow(5) }));
  board.items.push(genItem('itm_bbbbb2', '任务二', 'doing', { engagementId: 'eng_aaaaa2' }));
  board.items.push(genItem('itm_bbbbb3', '独立任务', 'waiting'));
  const w = store.writeBoard(ws, board);
  check('A1 预置 board 写入成功', w.ok, w.reason);
  const before = readFileSync(store.boardPath(ws), 'utf8');

  const r = api.board(ws);
  check('A1 GET board 返回 ok', r.ok === true, r.reason);
  check('A1 返回 2 个客户、3 个任务', r.board.engagements.length === 2 && r.board.items.length === 3,
    { e: r.board.engagements.length, i: r.board.items.length });
  check('A1 客户字段原样返回', r.board.engagements[0].name === '甲客户' && r.board.engagements[1].priority === 'high');
  check('A1 stats 计数正确', r.stats.engagements === 2 && r.stats.items === 3 && r.stats.active === 2,
    r.stats);
  check('A1 stats 按泳道/阶段计数', r.stats.byLane.doing === 1 && r.stats.byStage.lead === 1 && r.stats.byStage.discovery === 1, r.stats);
  check('A1 meta 含 8 阶段（顺序固定、order 连续 1–8）', r.meta.stages.length === 8 && r.meta.stages[0].key === 'lead' && r.meta.stages[7].key === 'adoption'
    && r.meta.stages.map((x) => x.order).join(',') === '1,2,3,4,5,6,7,8', r.meta.stages.map((x) => x.key + ':' + x.order));
  check('A1 meta.gates 按阶段 key 索引（面板按 stage 取）', typeof r.meta.gates === 'object' && !Array.isArray(r.meta.gates) && Object.keys(r.meta.gates).length === 8 && schema.ENGAGEMENT_STAGES.every((st) => r.meta.gates[st.key]), Object.keys(r.meta.gates));
  check('A1 meta.gates.lead 映射 intake 门禁', r.meta.gates.lead && r.meta.gates.lead.key === 'intake' && r.meta.gates.lead.stage === 'lead');
  check('A1 干净数据读取不写盘', readFileSync(store.boardPath(ws), 'utf8') === before);
}

/* ============================ A2 阶段门禁 ============================ */
section('A2 阶段门禁');
let eA2 = null;
{
  makeProject('甲客户-20260101', {
    '00-项目档案.md': '# 项目档案：甲客户\n',
    'research/事实核查清单.md': 'A 级事实若干',
    'research/KPI与痛点假设.md': '本节全部为假设',
  });
  const cr = api.engagement(ws, { action: 'create', patch: { name: '甲客户', company: '甲客户有限公司', dir: '甲客户-20260101', nextAction: { text: '补 KPI', due: dateDaysFromNow(3) }, source: { kind: 'manual' } } });
  check('A2 创建客户成功', cr.ok && cr.engagement.stage === 'lead', cr.reason);
  eA2 = cr.engagement;
  const blocked = api.engagement(ws, { action: 'move', id: eA2.id, patch: { stage: 'discovery' } });
  check('A2 门禁未过时 blocked:true', blocked.ok === false && blocked.blocked === true && blocked.code === 'BLOCKED', blocked);
  check('A2 missing 含人工项（自动检查已过）', Array.isArray(blocked.missing) && blocked.missing.length === 2 && blocked.missing.every((m) => m.type === 'manual'), blocked.missing);
  const g = api.gate(ws, {
    engagementId: eA2.id,
    stage: 'discovery',
    checks: {
      subject_locked: { status: 'pass', evidence: '地址锚定 + 三链验证通过' },
      evidence_graded: { status: 'pass', evidence: 'A/B/C 已分级' },
    },
  });
  check('A2 人工勾选后门禁 pass', g.ok === true && g.gate.passed === true && g.missing.length === 0, g.gate && g.gate.missing);
  const stageSince0 = null;
  const mv = api.engagement(ws, { action: 'move', id: eA2.id, patch: { stage: 'discovery' } });
  check('A2 满足后推进成功且 stageSince 更新', mv.ok === true && mv.engagement.stage === 'discovery' && mv.engagement.stageSince !== stageSince0 && Date.parse(mv.engagement.stageSince) > 0);
  check('A2 推进写入 timeline', (mv.engagement.timeline || []).some((t) => t.kind === 'stage' && t.text.includes('研判')));
}

/* ============================ A3 强制推进 ============================ */
section('A3 强制推进');
{
  const cr = api.engagement(ws, { action: 'create', patch: { name: '强制客户', company: '强制客户有限公司', nextAction: { text: '跟进', due: dateDaysFromNow(5) } } });
  const e = cr.engagement;
  const noReason = api.engagement(ws, { action: 'move', id: e.id, patch: { stage: 'discovery', force: true } });
  check('A3 force 缺 reason 被拒', noReason.ok === false, noReason.reason);
  const mv = api.engagement(ws, { action: 'move', id: e.id, patch: { stage: 'discovery', force: true, reason: '用户明确要求先推进' } });
  check('A3 force 推进成功', mv.ok === true && mv.engagement.stage === 'discovery', mv.reason);
  check('A3 gateState.forced=true 且留 reason', mv.engagement.gateState.discovery && mv.engagement.gateState.discovery.forced === true && mv.engagement.gateState.discovery.reason.includes('用户明确'), mv.engagement.gateState.discovery);
  check('A3 timeline 记录破例推进与原因（不出现 force 字样）', (mv.engagement.timeline || []).some((t) => t.text.includes('破例推进') && t.text.includes('用户明确要求先推进'))
    && !(mv.engagement.timeline || []).some((t) => /force/i.test(t.text)), (mv.engagement.timeline || []).map((t) => t.text));
  check('A3 破例推进缺原因的提示是人话', noReason.reason === '破例推进需要写明原因', noReason.reason);
  const jump = api.engagement(ws, { action: 'move', id: e.id, patch: { stage: 'solution' } });
  check('A3 非 force 不允许跳阶', jump.ok === false && jump.code === 'INVALID', jump.reason);

  /* 面板真实流程：先 /fde/gate force 放行，再 move（不带 force）也应通过 */
  const cr2 = api.engagement(ws, { action: 'create', patch: { name: '门禁强制客户', company: '门禁强制客户公司', nextAction: { text: '跟进', due: dateDaysFromNow(5) } } });
  const e2 = cr2.engagement;
  const gf = api.gate(ws, { engagementId: e2.id, stage: 'discovery', force: true, reason: '面板强制通过' });
  check('A3 /fde/gate force 记录 forced', gf.ok && gf.gate.status === 'forced', gf.reason);
  const mv2 = api.engagement(ws, { action: 'move', id: e2.id, patch: { stage: 'discovery' } });
  check('A3 门禁已 force 放行后 move 免 force 通过', mv2.ok && mv2.engagement.stage === 'discovery', mv2.reason);
  check('A3 强制记录保留在 gateState', mv2.engagement.gateState.discovery && mv2.engagement.gateState.discovery.forced === true);

  /* 回退（人工纠正）不校验门禁 */
  const back = api.engagement(ws, { action: 'move', id: e2.id, patch: { stage: 'lead' } });
  check('A3 阶段回退无需 force 且成功', back.ok && back.engagement.stage === 'lead', back.reason);
  check('A3 回退写入 timeline', (back.engagement.timeline || []).some((t) => t.text.includes('回退')));
}

/* ============================ A4 任务回报 ============================ */
section('A4 任务回报');
let itemA4 = null;
{
  const cr = api.item(ws, { action: 'create', patch: { title: '补齐 KPI 假设', type: 'research', stage: 'doing', engagementId: eA2.id } });
  check('A4 创建任务成功', cr.ok && cr.item.stage === 'doing', cr.reason);
  itemA4 = cr.item;
  const r1 = api.item(ws, { action: 'report', id: itemA4.id, kind: 'ready', text: '已完成 KPI 假设，见文件', artifacts: ['research/KPI与痛点假设.md'] });
  check('A4 report ready → review', r1.ok && r1.item.stage === 'review', r1 && r1.item && r1.item.stage);
  check('A4 reports 追加', r1.item.reports.length === 1 && r1.item.reports[0].kind === 'ready' && r1.item.reports[0].artifacts.length === 1);
  const r2 = api.item(ws, { action: 'report', id: itemA4.id, kind: 'blocked', text: '缺客户数据，等对方提供' });
  check('A4 report blocked → waiting', r2.ok && r2.item.stage === 'waiting', r2 && r2.item && r2.item.stage);
  check('A4 blocked 生成显式注意力', r2.item.attention && r2.item.attention.kind === 'blocked' && r2.attention.kind === 'blocked');
  const badKind = api.item(ws, { action: 'report', id: itemA4.id, kind: 'nope', text: 'x' });
  check('A4 非法 report.kind 被拒', badKind.ok === false && badKind.code === 'INVALID');
  const emptyText = api.item(ws, { action: 'report', id: itemA4.id, kind: 'progress', text: '' });
  check('A4 空回报文本被拒', emptyText.ok === false);
}

/* ============================ A5 注意力 ============================ */
section('A5 注意力');
{
  const cr = api.engagement(ws, { action: 'create', patch: { name: '逾期客户', company: '逾期客户有限公司', nextAction: { text: '跟进', due: '2020-01-01' }, priority: 'high' } });
  const eid = cr.engagement.id;
  const br = api.brief(ws);
  check('A5 brief 返回注意力列表', br.ok && Array.isArray(br.brief.attention) && br.brief.attention.length > 0);
  const overdue = br.brief.attention.find((a) => a.kind === 'overdue' && a.engagementId === eid);
  check('A5 逾期客户出现在 attention', !!overdue && overdue.days > 0, overdue);
  check('A5 注意力排序 blocked 先于 overdue', br.brief.attention.findIndex((a) => a.kind === 'blocked') < br.brief.attention.findIndex((a) => a.kind === 'overdue'), br.brief.attention.map((a) => a.kind));
  check('A5 注意力按 spec §5 顺序（rank 单调）', br.brief.attention.every((a, i, arr) => i === 0 || arr[i - 1].rank <= a.rank), br.brief.attention.map((a) => a.rank));
  api.engagement(ws, { action: 'update', id: eid, patch: { nextAction: { text: '跟进', due: dateDaysFromNow(6) } } });
  const br2 = api.brief(ws);
  check('A5 改期后逾期注意力消失', !br2.brief.attention.some((a) => a.kind === 'overdue' && a.engagementId === eid));
  const ask = api.attention(ws, { action: 'ask', target: 'engagement', id: eid, kind: 'decision', question: '是否先做试点？' });
  check('A5 ask 写入显式注意力', ask.ok && ask.attention.kind === 'decision');
  const br3 = api.brief(ws);
  check('A5 decision 出现在 attention', br3.brief.attention.some((a) => a.kind === 'decision' && a.engagementId === eid));
  const res = api.attention(ws, { action: 'resolve', target: 'engagement', id: eid, answer: '先做小范围试点' });
  check('A5 resolve 清空注意力', res.ok && res.attention === null && res.cleared === true);
  const br4 = api.brief(ws);
  check('A5 解决后 decision 消失', !br4.brief.attention.some((a) => a.kind === 'decision' && a.engagementId === eid));
}

/* ============================ A5+ 红线：agent 不得 resolve decision/blocked 注意力 ============================ */
section('A5+ 红线：agent 不得自行解决 decision/blocked 注意力（Phase 3 · F-20）');
{
  const cr = api.engagement(ws, { action: 'create', patch: { name: '红线客户', company: '红线客户有限公司', priority: 'high' } });
  const eid = cr.engagement.id;
  const askD = api.attention(ws, { action: 'ask', target: 'engagement', id: eid, kind: 'decision', question: '是否进入方案阶段？', by: 'agent' });
  check('A5+ agent 可以 ask（向人提问）', askD.ok && askD.attention.kind === 'decision');

  const resAgentDecision = api.attention(ws, { action: 'resolve', target: 'engagement', id: eid, answer: 'agent 自答', by: 'agent' });
  check('A5+ agent resolve decision → BLOCKED', resAgentDecision.ok === false && resAgentDecision.code === 'BLOCKED', resAgentDecision);
  const kept = api.brief(ws).brief.attention.some((a) => a.kind === 'decision' && a.engagementId === eid);
  check('A5+ 被拒后 decision 注意力仍保留（未被清除）', kept);

  api.attention(ws, { action: 'ask', target: 'engagement', id: eid, kind: 'blocked', question: '等对方确认范围', by: 'agent' });
  const resAgentBlocked = api.attention(ws, { action: 'resolve', target: 'engagement', id: eid, answer: 'agent 自答', by: 'agent' });
  check('A5+ agent resolve blocked → BLOCKED', resAgentBlocked.ok === false && resAgentBlocked.code === 'BLOCKED', resAgentBlocked);

  api.attention(ws, { action: 'ask', target: 'engagement', id: eid, kind: 'answer', question: '对方联系人是谁？', by: 'agent' });
  const resAgentAnswer = api.attention(ws, { action: 'resolve', target: 'engagement', id: eid, answer: '张三', by: 'agent' });
  check('A5+ agent 可记录 answer 类注意力的回答', resAgentAnswer.ok === true && resAgentAnswer.cleared === true, resAgentAnswer);

  api.attention(ws, { action: 'ask', target: 'engagement', id: eid, kind: 'question', question: '需要哪些数据？', by: 'agent' });
  const resAgentQuestion = api.attention(ws, { action: 'resolve', target: 'engagement', id: eid, answer: '清单见邮件', by: 'agent' });
  check('A5+ agent 可记录 question 类注意力的回答', resAgentQuestion.ok === true, resAgentQuestion);

  api.attention(ws, { action: 'ask', target: 'engagement', id: eid, kind: 'decision', question: '人确认是否进入方案阶段？', by: 'human' });
  const resHuman = api.attention(ws, { action: 'resolve', target: 'engagement', id: eid, answer: '人确认：进入方案', by: 'human' });
  check('A5+ 人（面板）可 resolve decision 注意力', resHuman.ok === true && resHuman.cleared === true, resHuman);
}

/* ============================ A6 导入 ============================ */
section('A6 导入旧项目');
{
  makeProject('导入客户-20260202', {
    '00-项目档案.md': '# 项目档案：导入客户（副标题）\n',
    'research/事实核查清单.md': 'A 级',
    'meeting/客户面谈Brief.md': 'Brief',
  });
  makeProject('历史目录-20260203', { 'research/旧方案.md': '方案' });
  mkdirSync(join(research, '素材目录'), { recursive: true });
  writeFileSync(join(research, '素材目录', 'a.html'), '<html></html>');
  const scan = api.adopt(ws, { action: 'scan' });
  check('A6 scan 返回候选', scan.ok && Array.isArray(scan.candidates));
  const cand = scan.candidates.find((c) => c.dir === '导入客户-20260202');
  check('A6 识别含档案的项目', !!cand && cand.kind === 'project' && cand.adopted === true, cand);
  check('A6 给建议阶段（会面）', cand.suggestedStage === 'meeting', cand && cand.suggestedStage);
  check('A6 素材目录不进候选', !scan.candidates.some((c) => c.dir === '素材目录'));
  check('A6 legacy 目录标记为 legacy', scan.candidates.some((c) => c.dir === '历史目录-20260203' && c.kind === 'legacy'));
  const ap = api.adopt(ws, { action: 'apply', dirs: ['导入客户-20260202', '历史目录-20260203'] });
  check('A6 apply 导入成功', ap.ok && ap.added.length === 2, ap && ap.added);
  check('A6 导入的客户 adopted=true 且 stage=建议阶段', ap.board.engagements.filter((e) => e.adopted).every((e) => e.adopted === true && schema.isStage(e.stage)));
  const ap2 = api.adopt(ws, { action: 'apply', dirs: ['导入客户-20260202'] });
  check('A6 再次 apply 不重复导入', ap2.ok && ap2.added.length === 0 && ap2.skipped.length === 1, ap2 && ap2.skipped);
  const scan2 = api.adopt(ws, { action: 'scan' });
  check('A6 scan 标记 alreadyImported', scan2.candidates.find((c) => c.dir === '导入客户-20260202').alreadyImported === true);
}

/* ============================ A7 建议 ============================ */
section('A7 提醒生成与处理（spec §6 / §22.2）');
{
  const bd = store.readBoard(ws).board;
  const e = bd.engagements.find((x) => x.id === eA2.id);
  const old = isoDaysFromNow(-20);
  e.stageSince = old;
  e.createdAt = old;
  e.timeline = [];
  /* 既没有进展（原 stall 规则的情形），也没定下一步（no_next 规则）。 */
  e.nextAction = { text: '', due: '', owner: '' };
  bd.settings.stallDays = 14;
  const w = store.writeBoard(ws, bd);
  check('A7 预置：没有进展且没定下一步的客户', w.ok, w.reason);
  const b1 = api.board(ws);
  /* stall 是 derived 规则（ADR 0010 D4）：不再生成提醒，由「待我处理·没有进展」覆盖。 */
  check('A7 stall 规则不再生成提醒（derived）', !b1.board.proposals.some((p) => p.ruleId === 'stall'), b1.board.proposals.map((p) => p.ruleId));
  check('A7 没有进展的情形仍在待我处理里（kind=stall）', b1.attention.some((a) => a.kind === 'stall' && a.engagementId === eA2.id), b1.attention.map((a) => a.kind));
  /* 「生成 → 采纳 → 24h 不重复」用仍会生成的 no_next 规则验证。 */
  const noNext = b1.board.proposals.filter((p) => p.ruleId === 'no_next' && p.engagementId === eA2.id);
  check('A7 no_next 规则生成 proposal', noNext.length === 1, b1.board.proposals.map((p) => p.ruleId));
  check('A7 proposal 有 id/kind/payload', /^prp_[0-9a-f]{6}$/.test(noNext[0].id) && noNext[0].kind === 'update_next' && !!noNext[0].payload);
  check('A7 提醒标题与详情是人话（不带「建议：」前缀）', noNext[0].title === '甲客户还没定下一步' && noNext[0].detail === '写清谁、做什么、什么时候', { title: noNext[0].title, detail: noNext[0].detail });
  const before = (api.board(ws).board.proposals.filter((p) => p.ruleId === 'no_next' && p.engagementId === eA2.id)).length;
  check('A7 条件仍在时再次读取不重复生成', before === 1, before);
  const acc = await api.proposal(ws, { id: noNext[0].id, action: 'accept' });
  check('A7 accept 成功并标记 accepted', acc.ok && acc.proposal.status === 'accepted' && acc.proposal.decidedAt, acc.reason);
  const engAfter = api.board(ws).board.engagements.find((x) => x.id === eA2.id);
  check('A7 accept 执行 payload（补了一条待确认的下一步）', String(engAfter.nextAction.text || '').includes('甲客户'), engAfter.nextAction);
  /* 让条件再次成立（又没有下一步了）：24 小时内不应重复生成同一条提醒。 */
  api.engagement(ws, { action: 'update', id: eA2.id, patch: { nextAction: { text: '', due: '' } } });
  const dup = api.board(ws).board.proposals.filter((p) => p.ruleId === 'no_next' && p.engagementId === eA2.id);
  check('A7 24h 内不重复生成', dup.length === before && dup.every((p) => p.status === 'accepted'), { before, now: dup.length, status: dup.map((p) => p.status) });
  const dismiss = api.board(ws).board.proposals.find((p) => p.status === 'pending');
  if (dismiss) {
    const dm = await api.proposal(ws, { id: dismiss.id, action: 'dismiss' });
    check('A7 dismiss 标记 dismissed', dm.ok && dm.proposal.status === 'dismissed');
    check('A7 人点「知道了」不算自动失效（没有 expired 标记）', dm.proposal.expired !== true, dm.proposal);
  }
  const again = await api.proposal(ws, { id: noNext[0].id, action: 'accept' });
  check('A7 已处理提醒再处理 → CONFLICT', again.ok === false && again.code === 'CONFLICT');
  check('A7 已处理提醒的原因是人话（不带 status= 枚举）', again.reason === '这条提醒已经处理过了', again.reason);
  /* 后续用例沿用「有下一步」的甲客户。 */
  api.engagement(ws, { action: 'update', id: eA2.id, patch: { nextAction: { text: '跟进', due: dateDaysFromNow(10) } } });
}

/* ============================ 回报其余语义 + sync + start_session 建议 ============================ */
section('回报其余语义 / sync / start_session 建议');
{
  const it = api.item(ws, { action: 'create', patch: { title: '失败与丢弃测试', stage: 'doing', engagementId: eA2.id } });
  const rf = api.item(ws, { action: 'report', id: it.item.id, kind: 'failed', text: '接口不通' });
  check('report failed 保持 doing 并生成注意力', rf.ok && rf.item.stage === 'doing' && rf.item.attention && rf.item.attention.kind === 'blocked', rf.item && rf.item.stage);
  const rd = api.item(ws, { action: 'report', id: it.item.id, kind: 'dropped', text: '范围外，不做了' });
  check('report dropped → canceled', rd.ok && rd.item.stage === 'canceled');
  const rp = api.item(ws, { action: 'report', id: it.item.id, kind: 'progress', text: '进度 50%' });
  check('report progress 不改泳道', rp.ok && rp.item.stage === 'canceled');
  const at = api.attention(ws, { action: 'list' });
  check('attention list 可用', at.ok && Array.isArray(at.list) && at.list.length > 0, at.list && at.list.slice(0, 2).map((a) => a.kind));

  const sy = api.sync(ws);
  check('sync 返回刷新结果', sy.ok && sy.refreshed && Array.isArray(sy.refreshed.engagements) && !!sy.refreshed.scannedAt, sy.refreshed);
  check('sync 后 board 仍可读', sy.ok && !!sy.board && sy.board.engagements.length > 0);
  const sy2 = api.sync(ws, { engagementId: 'eng_ffffff' });
  check('sync 不存在客户 → NOT_FOUND', sy2.ok === false && sy2.code === 'NOT_FOUND');

  /* 材料已齐 + 在本阶段 > 7 天：原 gate_ready 规则的情形。它是 derived 规则，不再生成提醒，
   * 由「待我处理·等你确认」覆盖（ADR 0010 D4）。 */
  makeProject('会话客户-20260303', {
    '00-项目档案.md': '# 项目档案：会话客户\n',
    'research/事实核查清单.md': 'A 级',
    'research/KPI与痛点假设.md': '假设',
  });
  const cr = api.engagement(ws, { action: 'create', patch: { name: '会话客户', company: '会话客户有限公司', dir: '会话客户-20260303', nextAction: { text: '补材料', due: dateDaysFromNow(6) }, source: { kind: 'manual' } } });
  const bd = store.readBoard(ws).board;
  const ee = bd.engagements.find((x) => x.id === cr.engagement.id);
  ee.stageSince = isoDaysFromNow(-8);
  store.writeBoard(ws, bd);
  const br = api.board(ws);
  check('gate_ready 规则不再生成提醒（derived）', !br.board.proposals.some((p) => p.ruleId === 'gate_ready'), br.board.proposals.map((p) => p.ruleId));
  const gateAtt = br.attention.find((a) => a.kind === 'gate' && a.engagementId === ee.id);
  check('材料已齐的情形在待我处理里（等你确认，句子不带前缀）',
    !!gateAtt && gateAtt.text === '会话客户进入「研判」的材料已齐，还有 2 项等你确认' && gateAtt.detail === '主体已锁定、事实已分级',
    gateAtt && { text: gateAtt.text, detail: gateAtt.detail });

  /* start_session 类提醒：会面快到了（meeting_soon）→ accept 创建会话并保留会话记录 */
  const meetItem = api.item(ws, { action: 'create', patch: { title: '和王总见面', type: 'meeting', stage: 'todo', due: dateDaysFromNow(1), engagementId: ee.id } }).item;
  const br2 = api.board(ws);
  const got = br2.board.proposals.find((p) => p.ruleId === 'meeting_soon' && p.itemId === meetItem.id);
  check('meeting_soon 规则生成 start_session 提醒', !!got && got.kind === 'start_session' && got.status === 'pending', br2.board.proposals.map((p) => p.ruleId));
  check('meeting_soon 标题与详情是人话',
    !!got && got.title === `会面快到了：和王总见面（${dateDaysFromNow(1)}）` && got.detail === '可以交给 AI 先准备会面材料', got && { title: got.title, detail: got.detail });
  const accepted = await api.proposal(ws, { id: got.id, action: 'accept' }, { handoff: async () => ({ ok: true, sessionId: 'sess-meet-1' }) });
  check('start_session accept 创建会话', accepted.ok && accepted.proposal.status === 'accepted' && accepted.sessionId === 'sess-meet-1', accepted.reason);
  const afterItem = api.board(ws).board.items.find((x) => x.id === meetItem.id);
  check('accept 后会话记录未被旧对象覆盖', afterItem.sessionId === 'sess-meet-1' && (afterItem.history || []).some((h) => h.text === '交给 AI 准备会面材料'),
    { sessionId: afterItem.sessionId, history: (afterItem.history || []).map((h) => h.text) });
  check('交给 AI 的记录不含会话编号与英文目的', !(afterItem.history || []).some((h) => /sess-|session|（meeting）/.test(h.text)), (afterItem.history || []).map((h) => h.text));
  const p2 = api.proposal(ws, { id: got.id, action: 'accept' }, { handoff: async () => ({ ok: true, sessionId: 'x' }) });
  check('已处理提醒重复处理 → CONFLICT', (await p2).ok === false);
}

/* ============================ 复盘草稿（fde_harvest） ============================ */
section('复盘草稿写入');
{
  const r = api.harvest(ws, { engagementId: eA2.id, text: '这次判断失误在主体锁定太晚，下次先做地址锚定。', targets: ['pitfall', 'method'] });
  check('harvest 返回 draftPath', r.ok && typeof r.draftPath === 'string', r.reason);
  check('草稿落在 research/.fde/drafts/', r.ok && r.draftPath.startsWith(join(research, '.fde', 'drafts')), r.draftPath);
  check('草稿文件存在且含正文与脱敏说明', r.ok && existsSync(r.draftPath) && readFileSync(r.draftPath, 'utf8').includes('这次判断失误') && readFileSync(r.draftPath, 'utf8').includes('脱敏'));
  check('草稿不写客户卷正文（未新增项目文件）', !existsSync(join(research, '甲客户-20260101', '复盘.md')));
  const bad = api.harvest(ws, { text: '' });
  check('harvest 空文本被拒', bad.ok === false && bad.code === 'INVALID');
  const badEng = api.harvest(ws, { engagementId: 'eng_ffffff', text: 'x' });
  check('harvest 不存在客户 → NOT_FOUND', badEng.ok === false && badEng.code === 'NOT_FOUND');
}

/* ============================ A8 路径与引用安全 ============================ */
section('A8 路径与引用安全');
{
  const t1 = api.engagement(ws, { action: 'create', patch: { name: '穿越', dir: '../../etc' } });
  check('A8 dir=../../etc 被拒', t1.ok === false && t1.code === 'INVALID', t1.reason);
  const t2 = api.engagement(ws, { action: 'create', patch: { name: '绝对路径', dir: '/etc/passwd' } });
  check('A8 绝对路径 dir 被拒', t2.ok === false && t2.code === 'INVALID', t2.reason);
  const t3 = api.adopt(ws, { action: 'apply', dirs: ['../../etc'] });
  check('A8 adopt dirs 穿越被 rejected', t3.ok === true && t3.rejected.length === 1 && t3.added.length === 0, t3.rejected);
  const t4 = api.item(ws, { action: 'create', patch: { title: 'x', engagementId: 'eng_ffffff' } });
  check('A8 item 引用不存在客户被拒', t4.ok === false && t4.code === 'INVALID', t4.reason);
  const t5 = api.engagement(ws, { action: 'move', id: 'eng_ffffff', patch: { stage: 'discovery' } });
  check('A8 不存在的客户 → NOT_FOUND', t5.ok === false && t5.code === 'NOT_FOUND');
  const t6 = await api.handoff(ws, { target: 'engagement', id: 'eng_ffffff' }, {});
  check('A8 handoff 不存在客户 → NOT_FOUND', t6.ok === false && t6.code === 'NOT_FOUND', t6);
  const bare = api.item(ws, { action: 'create', patch: { title: '无证据任务', stage: 'doing', engagementId: eA2.id } });
  const t7 = api.item(ws, { action: 'move', id: bare.item.id, patch: { stage: 'done' } });
  check('A8 进 done 缺证据被拦', t7.ok === false && t7.blocked === true && t7.missing.length === 1, t7.reason);
  const bd = store.readBoard(ws).board;
  bd.engagements[0].stage = 'bogus';
  const t8 = store.validateBoard(bd);
  check('A8 非法阶段写盘被拒', t8.ok === false);
  const t9 = store.validateBoard(Object.assign(store.emptyBoard(), { engagements: [{ id: 'eng_aaaaa1', name: 'x', stage: 'lead', priority: 'normal', paused: false, dir: '../x' }] }));
  check('A8 非法 dir 写盘被拒', t9.ok === false);
}

/* ============================ A9 原子写与备份 ============================ */
section('A9 原子写与备份');
{
  const beforeCount = store.listBackups(ws).length;
  const bd = store.readBoard(ws).board;
  bd.settings.stallDays = 15;
  const w1 = store.writeBoard(ws, bd);
  check('A9 正常写入成功', w1.ok, w1.reason);
  check('A9 写前生成备份', store.listBackups(ws).length >= 1 && store.listBackups(ws).length <= store.MAX_BACKUPS, store.listBackups(ws).length);
  const good = readFileSync(store.boardPath(ws), 'utf8');

  const bad = store.readBoard(ws).board;
  bad.engagements.push({ id: 'eng_zzzzz1', name: '坏', stage: 'nope', priority: 'normal', paused: false });
  const w2 = store.writeBoard(ws, bad);
  check('A9 非法 board 写入被拒', w2.ok === false);
  check('A9 写入失败不破坏旧 board', readFileSync(store.boardPath(ws), 'utf8') === good);
  check('A9 无临时文件残留', !readdirSync(store.fdeDir(ws)).some((f) => f.includes('.tmp')));
  /* Phase 3 · 审查 F-15：临时文件 wx 独占创建 + mode 0600；rename 后 board 权限应为 0600。 */
  const boardStat = lstatSync(store.boardPath(ws));
  const boardMode = boardStat.mode & 0o777;
  /* 跨平台：落盘结果是普通文件，不是符号链接（wx 创建 + rename 不跟随预置链）。 */
  check('A9 board 落盘为普通文件（非符号链接）', boardStat.isFile() && !boardStat.isSymbolicLink());
  /* NTFS 不承载 POSIX 权限位（stat 恒 0o666）：win32 显式 SKIP 并记录，不伪装成「已验证」。 */
  if (process.platform === 'win32') {
    skip('A9 board 落盘权限 0600（wx 独占 + mode）', 'win32 无 POSIX 权限位，由 Linux/macOS 断言');
  } else {
    check('A9 board 落盘权限 0600（wx 独占 + mode）', boardMode === 0o600, '0o' + boardMode.toString(8));
  }
  check('A9 备份上限 ≤10', store.listBackups(ws).length <= store.MAX_BACKUPS);
  check('A9 board 版本校验（高版本拒绝）', (() => {
    const p = store.boardPath(ws);
    const data = JSON.parse(readFileSync(p, 'utf8'));
    data.version = 99;
    writeFileSync(p, JSON.stringify(data));
    const r = store.readBoard(ws);
    const back = JSON.parse(good);
    writeFileSync(p, JSON.stringify(back));
    return r.ok === false && r.code === 'CONFLICT';
  })());
  check('A9 备份文件存在且可解析', store.listBackups(ws).every((b) => { try { JSON.parse(readFileSync(b.path, 'utf8')); return true; } catch { return false; } }));
}

/* ============================ 工件扫描与缓存 ============================ */
section('工件扫描与 TTL 缓存（spec §4）');
{
  const s1 = store.scanProjectArtifacts(ws, '甲客户-20260101', { force: true });
  check('扫描返回工件与 mtime', s1.exists && s1.files.length >= 3 && s1.files.every((f) => !!f.modifiedAt && !!f.rel));
  const s2 = store.scanProjectArtifacts(ws, '甲客户-20260101');
  check('TTL 内命中缓存', s2.source === 'cache', s2.source);
  const s3 = store.scanProjectArtifacts(ws, '甲客户-20260101', { force: true });
  check('force 重新扫描', s3.source === 'scan');
  const m = store.matchArtifacts(s1.files, { match: '事实核查' });
  check('工件关键词匹配', m.ok && m.hits.length === 1 && m.hits[0].rel.includes('事实核查'));
  const ttl = store.DEFAULT_CACHE_TTL_MS;
  check('默认 TTL=5s', ttl === 5000);
  store.clearScanCache();
}

/* ============================ schema（单一事实来源） ============================ */
section('schema 单一事实来源（spec §2 / §16.5）');
{
  check('8 个阶段 key 正确（meeting 与 solution 之间插入 scoping）', schema.STAGE_KEYS.join(',') === 'lead,discovery,meeting,scoping,solution,pilot,delivery,adoption', schema.STAGE_KEYS.join(','));
  check('终止状态 2 个', schema.TERMINAL_KEYS.join(',') === 'archived,lost');
  check('可推进泳道 5 列', schema.BOARD_LANES.join(',') === 'todo,doing,waiting,review,done');
  check('8 个门禁 key 正确（新增 scoping）', schema.GATE_KEYS.join(',') === 'intake,discovery,meeting,scoping,solution,pilot,delivery,adoption', schema.GATE_KEYS.join(','));
  check('8 个注意力 kind 且顺序符合 §5', schema.ATTENTION_ORDER.join(',') === 'blocked,decision,review,answer,overdue,gate,stall,proposal');
  check('8 条规则（§6 + §17.6 bid_signal）', schema.RULE_IDS.join(',') === 'stall,due_soon,overdue,no_next,gate_ready,meeting_soon,review_lag,bid_signal');
  check('招采关系 4 类（buyer→winner→candidate→mention）', schema.BID_RELATION_KEYS.join(',') === 'buyer,winner,candidate,mention');
  check('默认 sources.bidWatch=true 且 bidSignalDays=30',
    schema.DEFAULT_SETTINGS.sources.bidWatch === true && schema.DEFAULT_SETTINGS.bidSignalDays === 30);
  check('item 类型 9 个（含 scoping）', schema.ITEM_TYPE_KEYS.length === 9 && schema.isItemType('scoping'), schema.ITEM_TYPE_KEYS);
  check('自主性 3 档', schema.AUTONOMY_KEYS.join(',') === 'observe,assisted,auto');
  check('阶段→门禁映射', schema.ENGAGEMENT_STAGES.every((s) => s.gate === s.key || s.gate === 'intake'));
  check('门禁人工项与 spec §20.2 一致（scoping 6 项 / solution 2 项）', JSON.stringify({
    discovery: schema.GATES.discovery.manual.map((c) => c.key),
    meeting: schema.GATES.meeting.manual.map((c) => c.key),
    scoping: schema.GATES.scoping.manual.map((c) => c.key),
    solution: schema.GATES.solution.manual.map((c) => c.key),
    pilot: schema.GATES.pilot.manual.map((c) => c.key),
    delivery: schema.GATES.delivery.manual.map((c) => c.key),
    adoption: schema.GATES.adoption.manual.map((c) => c.key),
  }) === JSON.stringify({
    discovery: ['subject_locked', 'evidence_graded'],
    meeting: ['meeting_goal'],
    scoping: ['sponsor_named', 'integration_14d', 'poc_90d', 'usage_measurable', 'criteria_scored', 'scenario_locked'],
    solution: ['solution_final', 'pricing_confirmed'],
    pilot: ['pilot_scope'],
    delivery: ['acceptance', 'milestones', 'risks'],
    adoption: ['usage_evidence', 'training', 'expansion_map'],
  }));
  check('nextStage 顺序推进（meeting→scoping→solution）', schema.nextStage('lead') === 'discovery'
    && schema.nextStage('meeting') === 'scoping' && schema.nextStage('scoping') === 'solution' && schema.nextStage('adoption') === '');
  check('schema meta 自洽（8 阶段 + 8 门禁 + playbook）', schema.meta().stages.length === schema.ENGAGEMENT_STAGES.length
    && schema.meta().gateList.length === 8 && schema.meta().stages.every((x) => x.playbook && Array.isArray(x.playbook.tools) && x.playbook.tools.length > 0));
  check('playbook 工具 kind 枚举合法且覆盖 8 阶段', schema.ENGAGEMENT_STAGES.every((st) => st.playbook.tools.every((t) => schema.PLAYBOOK_TOOL_KINDS.includes(t.kind))));
  check('每阶段 playbook 含 fde_library + 至少一个 library 来源组',
    schema.ENGAGEMENT_STAGES.every((st) => st.playbook.tools.some((t) => t.kind === 'tool' && t.name === 'fde_library')
      && st.playbook.tools.some((t) => t.kind === 'library')));
  check('playbook 字段齐全（goal/inputs/activities/outputs/tools/pitfalls）',
    schema.ENGAGEMENT_STAGES.every((st) => {
      const p = st.playbook || {};
      return typeof p.goal === 'string' && p.goal.length > 5
        && Array.isArray(p.inputs) && p.inputs.length > 0
        && Array.isArray(p.activities) && p.activities.length > 0
        && Array.isArray(p.outputs) && p.outputs.length > 0
        && Array.isArray(p.pitfalls) && p.pitfalls.length > 0;
    }));
  check('solution 门禁含成本/报价自动项 + pricing_confirmed 人工项',
    ['cost', 'quote'].every((k) => schema.GATES.solution.auto.some((c) => c.key === k))
      && schema.GATES.solution.manual.some((c) => c.key === 'pricing_confirmed'));
  check('scoping 门禁含场景自动项 + 四条硬门槛人工项',
    schema.GATES.scoping.auto.some((c) => c.key === 'scenario')
      && ['sponsor_named', 'integration_14d', 'poc_90d', 'usage_measurable'].every((k) => schema.GATES.scoping.manual.some((c) => c.key === k)));
}

/* ============================ 门禁评估细节 ============================ */
section('门禁评估（自动 + 人工）');
{
  const bd = store.readBoard(ws).board;
  const e = bd.engagements.find((x) => x.dir === '导入客户-20260202');
  check('导入客户带 forced 历史门禁（gateState 按阶段 key）', !!e && e.gateState.lead && e.gateState.lead.forced === true && e.gateState.lead.status === 'forced');
  const g = rules.evaluateGate(ws, e, 'meeting', {});
  check('会面门禁：Brief 自动项通过', g.auto.find((c) => c.key === 'brief').ok === true, g.auto);
  check('会面门禁：干系人自动项失败', g.auto.find((c) => c.key === 'stakeholders').ok === false);
  check('会面门禁：status=pending 且 missing 有项', g.status === 'pending' && g.missing.length >= 2, g);
  check('evaluateGate 未知 gate 返回 null', rules.evaluateGate(ws, e, 'nope', {}) === null);
}

/* ============================ prompts（spec §9） ============================ */
section('handoff 提示词（spec §9）');
{
  const bd = store.readBoard(ws).board;
  const e = bd.engagements.find((x) => x.id === eA2.id);
  const p = prompts.buildPrompt('engagement', { root: ws, engagement: e, intent: 'stage', gate: null, stayDays: 3 });
  check('提示词含编排声明与红线', p.includes('编排声明') && p.includes('不要自行推进') && p.includes('对外发送'));
  check('提示词含客户上下文', p.includes(e.name) && p.includes('research/') && p.includes('下一步'));
  check('提示词含技能与产物落盘', p.includes('skill') && p.includes('产物落盘') && p.includes('research/'));
  check('提示词含回报协议', p.includes('fde_item') && p.includes('300 字'));
  const pi = prompts.buildPrompt('item', { root: ws, item: itemA4, engagement: e, intent: 'stage' });
  check('item 提示词含任务与回报', pi.includes(itemA4.title) && pi.includes('fde_item') && pi.includes(itemA4.id));
  const gate = rules.evaluateGate(ws, e, 'solution', {});
  const pg = prompts.buildPrompt('engagement', { root: ws, engagement: e, intent: 'gate', gate });
  check('gate intent 提示词含推进条件与缺口（界面用词）', pg.includes('推进条件：') && pg.includes('还差什么：') && pg.includes('补齐推进条件需要的材料'), pg.slice(0, 400));
  /* 「不要说门禁、泳道…」那一行本身会列出这些词，核对时先去掉它。 */
  const sansWordsLine = (t) => t.split('\n').filter((l) => !l.startsWith('- 对用户说话')).join('\n');
  const oldWords = /门禁|泳道|注意力|intent=|客户卷/;
  check('提示词上下文不再用门禁 / 泳道 / 注意力 / intent= 等内部说法',
    !oldWords.test(sansWordsLine(p)) && !oldWords.test(sansWordsLine(pi)) && !oldWords.test(sansWordsLine(pg)),
    [p, pi, pg].map((t) => sansWordsLine(t).split('\n').filter((l) => oldWords.test(l))).flat());
  check('提示词带「对用户说话」的用词提示', p.includes('对用户说话用界面上的词') && pi.includes('对用户说话用界面上的词'));
  const draft = prompts.harvestDraft({ text: '复盘内容', engagement: e, targets: ['pitfall'] });
  check('复盘草稿含脱敏边界', draft.includes('脱敏') && draft.includes('未审草稿'));
}

/* ============================ A14 health ============================ */
section('A14 health 自检');
{
  const h = api.health(ws, { skills: { available: true, registered: 13 } });
  check('health 返回 checks 列表', h.ok === true && Array.isArray(h.checks) && h.checks.length >= 6, h.checks);
  check('health 无明显 fail（干净工作区）', h.checks.every((c) => c.status !== 'fail'), h.checks.filter((c) => c.status === 'fail'));
  check('health 含看板数据/技能/备份项', [api.HEALTH_NAMES.boardReadable, api.HEALTH_NAMES.skills, api.HEALTH_NAMES.backups].every((n) => h.checks.some((c) => c.name === n)), h.checks.map((c) => c.name));
  check('health 检查项名称与说明是人话（不出现状态文件名 / 内部模块名）',
    h.checks.every((c) => !/board|schema|skills|json|bid-intel|mtime|version/i.test(c.name + ' ' + c.detail)), h.checks.map((c) => c.name + '｜' + c.detail));
  check('health 技能项说明含注册数量', h.checks.some((c) => c.name === api.HEALTH_NAMES.skills && c.status === 'ok' && c.detail === '技能已注册 13 个'), h.checks.find((c) => c.name === api.HEALTH_NAMES.skills));
  const p = store.boardPath(ws);
  const good = readFileSync(p, 'utf8');
  writeFileSync(p, '{ 坏掉的 json');
  const h2 = api.health(ws, {});
  check('health 破坏 board 后返回失败项而非抛异常', h2.ok === true && h2.healthy === false && h2.checks.some((c) => c.status === 'fail'), h2.checks && h2.checks[0]);
  const broken = api.board(ws);
  check('board 路由层对损坏 JSON 返回 CONFLICT', broken.ok === false && broken.code === 'CONFLICT');
  writeFileSync(p, good);
}

/* ============================ 设置与自主性 ============================ */
section('设置与自主性（spec §6）');
{
  const s1 = api.settings(ws, { patch: { autonomy: 'assisted', stallDays: 10, wipLimits: { doing: 3 } } });
  check('settings 修改成功', s1.ok && s1.settings.autonomy === 'assisted' && s1.settings.stallDays === 10 && s1.settings.wipLimits.doing === 3, s1.reason);
  const s2 = api.settings(ws, { patch: { autonomy: 'god' } });
  check('非法 autonomy 被拒', s2.ok === false && s2.code === 'INVALID');
  const s3 = api.settings(ws, { patch: { stallDays: 0 } });
  check('非法 stallDays 被拒', s3.ok === false);
  api.settings(ws, { patch: { autonomy: 'observe' } });
  const observe = api.applySafeProposals(ws, api.board(ws).board);
  check('observe 模式不自动执行', observe.ok && observe.applied.length === 0 && observe.mode === 'observe');
  api.settings(ws, { patch: { autonomy: 'assisted' } });
  const b = api.board(ws);
  const assisted = api.applySafeProposals(ws, b.board);
  check('assisted 模式执行安全建议', assisted.ok && assisted.mode === 'assisted', assisted);
  api.settings(ws, { patch: { autonomy: 'observe' } });

  /* ADR 0006：演示模式一键清除位（只读示例，不写盘） */
  const dm0 = api.board(ws);
  check('默认 settings.demoDismissed=false（空看板可显示示例）',
    dm0.ok && dm0.board.settings.demoDismissed === false, dm0.board && dm0.board.settings && dm0.board.settings.demoDismissed);
  check('meta.defaults.settings.demoDismissed=false（客户端 normalizeMeta 拍平为 settingsDefaults）',
    api.meta().meta.defaults.settings.demoDismissed === false);
  const dm1 = api.settings(ws, { patch: { demoDismissed: true } });
  check('settings.demoDismissed=true 持久化 + appliedKeys 记录',
    dm1.ok && dm1.settings.demoDismissed === true && dm1.appliedKeys.includes('demoDismissed'), dm1.reason);
  const dm2 = api.board(ws);
  check('board 读回 demoDismissed=true（清除后不再显示示例）',
    dm2.ok && dm2.board.settings.demoDismissed === true);
  const dm3 = api.settings(ws, { patch: { demoDismissed: 'yes' } });
  check('非法 demoDismissed 被拒（必须布尔）', dm3.ok === false && dm3.code === 'INVALID', dm3.code);
  const dm4 = api.settings(ws, { patch: { demoDismissed: false } });
  check('demoDismissed 可重置为 false（设置页「重新查看示例」）',
    dm4.ok && dm4.settings.demoDismissed === false);
}

/* ============================ 模拟 bidIntel 服务（§17 测试用，不读真实 42MB 索引） ============================ */
/**
 * 假服务：与 bid-intel store.search 同语义的最小实现（buyer/company 命中 + match 标签）。
 * 支持 getRecord / dataMeta().mtime 变更（测缓存失效）。
 */
function makeFakeBidIntel(records) {
  const state = { records: records.slice(), mtime: 1000, calls: [], nextId: 0 };
  const norm = (v) => String(v || '').replace(/\s+/g, '').replace(/[（(]/g, '(').replace(/[）)]/g, ')').toLowerCase();
  const hay = (r) => norm([r.title, r.buyer, r.winner, r.project_no, (r.candidates || []).map((c) => (c && c.name) || '').join(' '), r.excerpt].join(' '));
  function search(o = {}) {
    state.calls.push(Object.assign({}, o));
    const q = norm(o.q || '');
    const limit = Math.min(Number(o.limit) || 50, 2000);
    const offset = Math.max(0, Number(o.offset) || 0);
    let hits = [];
    for (const r of state.records) {
      if (o.from && r.date && r.date < o.from) continue;
      if (o.to && r.date && r.date > o.to) continue;
      if (o.source && r.source !== o.source) continue;
      let tag = '';
      if (!q) tag = 'all';
      else if (o.mode === 'company') {
        if (norm(r.winner).includes(q) || (r.candidates || []).some((c) => norm(c && c.name).includes(q))) tag = '直接中标/候选';
        else if (hay(r).includes(q)) tag = '文中提及';
      } else if (o.mode === 'buyer') {
        if (norm(r.buyer).includes(q)) tag = 'buyer';
      } else if (o.mode === 'title') {
        if (norm(r.title).includes(q)) tag = 'title';
      } else if (hay(r).includes(q)) tag = 'any';
      if (tag) hits.push({ r, tag });
    }
    const direct = hits.filter((h) => h.tag === '直接中标/候选').length;
    const mentioned = hits.filter((h) => h.tag === '文中提及').length;
    const items = hits.slice(offset, offset + limit).map((h) => Object.assign({}, h.r, { match: h.tag }));
    return { total: hits.length, direct, mentioned, offset, limit, items, facets: { byYear: {} } };
  }
  const service = {
    version: 1,
    _state: state,
    dataMeta: () => ({ file: 'fake-notices.jsonl', mtime: state.mtime, bytes: 1024, records: state.records.length, missing: false }),
    stats: () => ({
      records: state.records.length, missing: false, file: 'fake-notices.jsonl', bytes: 1024,
      sources: [{ name: 'aecc-ebidding', count: state.records.length }],
      years: { '2026': state.records.length }, withWinner: 1, withBuyer: state.records.length, withAmount: 2,
      dateRange: ['2025-01-01', '2026-12-31'], generatedAt: new Date().toISOString(),
    }),
    search,
    timeline: (o = {}) => {
      const q = norm(o.q || '');
      const hits = state.records.filter((r) => hay(r).includes(q));
      const byMonth = {};
      for (const r of hits) { const m = String(r.date || '').slice(0, 7) || '未知'; byMonth[m] = (byMonth[m] || 0) + 1; }
      return { byMonth, total: hits.length, items: hits.slice(0, 20) };
    },
    batches: () => ({ clusters: [] }),
    report: () => '# fake report',
    getRecord: (id) => state.records.find((r) => r.id === String(id)) || null,
    _bumpMtime() { state.mtime += 1; state.records = state.records.slice(); },
    _push(rec) { state.records.push(rec); state.mtime += 1; },
    _calls() { return state.calls.slice(); },
    _resetCalls() { state.calls = []; },
  };
  return service;
}

/** 造一条招采公告（日期用本地 YYYY-MM-DD）。 */
function bidRecord(patch) {
  const base = {
    id: 'aecc-ebidding:test:' + (bidRecord._n = (bidRecord._n || 0) + 1),
    source: 'aecc-ebidding', channel: 'test', kind: '招标公告',
    url: 'https://example.invalid/' + bidRecord._n,
    date: dateDaysFromNow(-3), title: '测试公告', project_no: 'P-1',
    buyer: '甲单位', winner: '', candidates: [], amounts: [], excerpt: '',
  };
  return Object.assign(base, patch || {});
}

const fakeBid = makeFakeBidIntel([
  bidRecord({ id: 'bid:r1', kind: '招标公告', title: '某试验台招标公告', buyer: '某重型装备研究院', date: dateDaysFromNow(-3), amounts: ['预算 100 万元'] }),
  bidRecord({ id: 'bid:r2', kind: '中标结果公告', title: '某试验台中标结果公告', buyer: '某重型装备研究院', winner: '某科技股份有限公司', date: dateDaysFromNow(-5), amounts: ['中标 99 万元'] }),
  bidRecord({ id: 'bid:r3', kind: '中标候选人公示', title: '某连接器中标候选人公示', buyer: '某采购单位', candidates: [{ name: '某科技股份有限公司', rank: 1 }], date: dateDaysFromNow(-6), amounts: [] }),
  bidRecord({ id: 'bid:r4', kind: '询价公告', title: '配套件询价公告', buyer: '其他单位', date: dateDaysFromNow(-60), excerpt: '某重型装备研究院参与询价' }),
  bidRecord({ id: 'bid:r5', kind: '采购公告', title: '某重型装备研究院设备采购公告', buyer: '某重型装备研究院', date: dateDaysFromNow(-40), amounts: [] }),
]);

/* ============================ 工具与 HTTP 同实现（A10 宿主部分） ============================ */
section('工具注册 / schema / 工具↔路由一致性（A10 宿主部分）');
const captured = { tools: [], routes: [], sections: [], skills: [], handoffCalls: [] };
const registryWs = [{ id: 'ws-fde', path: ws, updatedAt: new Date().toISOString() }];
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { try { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
  get(n) {
    if (n === 'tools') return { register: (d) => captured.tools.push(d) };
    if (n === 'webServer') return { register: (d) => { captured.routes.push(d); return () => {}; } };
    if (n === 'systemPrompt') return { section: (d) => captured.sections.push(d), getSectionOrder: () => 2950 };
    if (n === 'workspaceRegistry') {
      return {
        current: () => ({ id: 'ws-fde', path: ws }),
        list: () => registryWs,
      };
    }
    if (n === 'sessionController') {
      return {
        current: () => ({ workspaceId: 'ws-fde' }),
        create: async (target) => { captured.handoffCalls.push({ target }); return { sessionId: 'fde-session-1' }; },
        prompt: async () => true,
        openWorkspacePath: async () => ({ ok: true }),
      };
    }
    if (n === 'skills') return { register: (d) => { captured.skills.push(d); return () => {}; } };
    if (n === 'bidIntel') return fakeBid;
    return undefined;
  },
};
try { mod.apply(fakeCtx); check('apply 不抛异常', true); } catch (e) { check('apply 不抛异常', false, String(e && e.message)); }

{
  const names = captured.tools.map((t) => t.name);
  const fdeNames = ['fde_board', 'fde_engagement', 'fde_item', 'fde_attention', 'fde_brief', 'fde_harvest'];
  check('6 个 FDE 工具全部注册', fdeNames.every((n) => names.includes(n)), names);
  check('旧 5 个工具仍注册（兼容）', ['rw_status', 'rw_scaffold', 'rw_export_pdf', 'rw_qa_pdf', 'rw_method'].every((n) => names.includes(n)));
  const bad = [];
  for (const t of captured.tools.filter((x) => fdeNames.includes(x.name))) {
    if (!t.description || t.description.length < 30) bad.push(t.name + ' 描述过短');
    if (!t.description.includes('FDE')) bad.push(t.name + ' 描述未标注 FDE');
    if (!t.parameters || t.parameters.type !== 'object') bad.push(t.name + ' 缺少 parameters');
    if (typeof t.execute !== 'function') bad.push(t.name + ' 缺少 execute');
    if (typeof t.presentCall !== 'function') bad.push(t.name + ' 缺少 presentCall');
    if (!t.output || typeof t.output.render !== 'function') bad.push(t.name + ' 缺少 output.render');
  }
  check('FDE 工具 schema 合法（中文描述/参数/execute/presentCall/render）', bad.length === 0, bad);

  /* 参数校验：不抛异常、返回 {ok:false, reason} */
  const tBoard = captured.tools.find((t) => t.name === 'fde_board');
  const tEng = captured.tools.find((t) => t.name === 'fde_engagement');
  const tItem = captured.tools.find((t) => t.name === 'fde_item');
  const tHarvest = captured.tools.find((t) => t.name === 'fde_harvest');
  const r1 = await tBoard.execute({ view: 'engagement', id: 'eng_ffffff', root: ws });
  check('fde_board 不存在客户 → ok:false 不抛异常', r1 && r1.ok === false && r1.code === 'NOT_FOUND', r1);
  const r2 = await tEng.execute({ action: 'nope', root: ws });
  check('fde_engagement 未知 action → ok:false', r2 && r2.ok === false, r2);
  const r3 = await tItem.execute({ action: 'report', id: 'itm_ffffff', kind: 'ready', text: 'x', root: ws });
  check('fde_item 不存在任务 → ok:false', r3 && r3.ok === false && r3.code === 'NOT_FOUND', r3);
  const r4 = await tHarvest.execute({ text: '', root: ws });
  check('fde_harvest 空 text → ok:false', r4 && r4.ok === false, r4);
  const r5 = await tBoard.execute({ view: 'board', root: ws });
  check('fde_board 读看板成功', r5 && r5.ok === true && !!r5.board && r5.text.includes('FDE 看板'), r5 && r5.text && r5.text.slice(0, 80));

  /* HTTP 路由 ↔ 工具同实现：同一 board 数据 */
  const callRoute = async (pathWithQuery, method = 'GET', body) => {
    const path = pathWithQuery.split('?')[0];
    const route = captured.routes.find((r) => r.path === path);
    if (!route) return { status: 599, payload: { ok: false, reason: '路由未注册：' + path } };
    let status = 200; let payload = null;
    const headers = method === 'POST' ? { 'content-type': 'application/json' } : {};
    const req = { method, url: pathWithQuery, headers, on() {}, destroy() {} };
    const res = {
      set statusCode(v) { status = v; },
      get statusCode() { return status; },
      setHeader() {},
      end(txt) { try { payload = JSON.parse(txt); } catch { payload = { raw: txt }; } },
    };
    if (method === 'POST') {
      const chunks = [Buffer.from(JSON.stringify(body || {}))];
      req.on = (ev, cb) => { if (ev === 'data') chunks.forEach(cb); if (ev === 'end') cb(); return req; };
    }
    await route.handler(req, res);
    return { status, payload };
  };
  const httpBoard = await callRoute('/research-workbench/api/fde/board?root=' + encodeURIComponent(ws));
  check('fde/board 路由可用', httpBoard.status === 200 && httpBoard.payload.ok === true, httpBoard.payload && httpBoard.payload.reason);
  check('工具与路由返回同一 board', httpBoard.payload.board.engagements.length === r5.board.engagements.length,
    { http: httpBoard.payload.board.engagements.length, tool: r5.board.engagements.length });
  const httpMeta = await callRoute('/research-workbench/api/fde/meta');
  check('fde/meta 路由返回 8 阶段定义与 playbook', httpMeta.payload.ok && httpMeta.payload.meta.stages.length === 8
    && !!httpMeta.payload.meta.gates && httpMeta.payload.meta.stages.every((x) => x.playbook && x.playbook.goal));

  /* handoff：会话创建 + 提示词 + sessionId 写回 */
  const target = api.board(ws).board.engagements.find((e) => schema.isStage(e.stage));
  const ho = await callRoute('/research-workbench/api/fde/handoff', 'POST', { target: 'engagement', id: target.id, root: ws });
  check('fde/handoff 路由创建会话', ho.payload.ok === true && ho.payload.sessionId === 'fde-session-1', ho.payload && ho.payload.reason);
  check('handoff 提示词随响应返回', typeof ho.payload.prompt === 'string' && ho.payload.prompt.includes('FDE 工作站'));
  check('handoff 选定工作区（优先当前工作区）', ho.payload.workspace === 'ws-fde', ho.payload.workspace);
  const after = api.board(ws).board.engagements.find((e) => e.id === target.id);
  check('handoff 写回 sessionId 与 timeline', after.sessionId === 'fde-session-1' && (after.timeline || []).some((t) => t.kind === 'session'));

  /* 会话服务不可用时降级：返回 ok:false + prompt（供剪贴板） */
  const noSessionCtx = { ...fakeCtx, get: (n) => (n === 'sessionController' ? undefined : fakeCtx.get(n)) };
  const mod2 = await import(__toUrl(join(PLUGIN, 'index.js')) + '?degraded=1');
  const captured2 = { routes: [] };
  mod2.apply({
    logger: { info() {}, warn() {}, error() {} },
    effect: fakeCtx.effect,
    get(n) {
      if (n === 'webServer') return { register: (d) => { captured2.routes.push(d); return () => {}; } };
      if (n === 'tools') return { register: () => () => {} };
      if (n === 'systemPrompt') return { section: () => {}, getSectionOrder: () => 2950 };
      if (n === 'workspaceRegistry') return { list: () => [{ id: 'ws-fde', path: ws }] };
      if (n === 'skills') return undefined;
      return undefined;
    },
  });
  const degradedRoute = captured2.routes.find((r) => r.path === '/research-workbench/api/fde/handoff');
  let degraded = null;
  if (degradedRoute) {
    degraded = await (async () => {
      let status = 200; let payload = null;
      const req = {
        method: 'POST', url: '/research-workbench/api/fde/handoff', headers: { 'content-type': 'application/json' },
        on(ev, cb) { if (ev === 'data') cb(Buffer.from(JSON.stringify({ target: 'engagement', id: target.id, root: ws }))); if (ev === 'end') cb(); return req; },
        destroy() {},
      };
      const res = { set statusCode(v) { status = v; }, get statusCode() { return status; }, setHeader() {}, end(t) { try { payload = JSON.parse(t); } catch { payload = { raw: t }; } } };
      await degradedRoute.handler(req, res);
      return { status, payload };
    })();
  }
  check('无会话服务时 handoff 降级返回 200 + prompt', degraded && degraded.status === 200 && degraded.payload.ok === false && typeof degraded.payload.prompt === 'string' && degraded.payload.prompt.length > 100, degraded && degraded.payload);

  /* 技能注册：实读插件 skills/，注册项合法；空目录不报错 */
  const diskSkills = api.discoverSkills(join(PLUGIN, 'skills'));
  check('skills/ 技能可被发现', Array.isArray(diskSkills) && diskSkills.length >= 1, diskSkills.length);
  check('技能注册数量与发现数量一致', captured.skills.length === diskSkills.length, { registered: captured.skills.length, found: diskSkills.length });
  const badSkill = captured.skills.filter((s) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name) || !s.description || typeof s.content !== 'string' || typeof s.source !== 'string' || !s.source || !s.resourceBase || s.resourceBase.kind !== 'directory');
  check('注册项满足 register() 校验（kebab 名/描述/内容/source/resourceBase）', badSkill.length === 0, badSkill.map((s) => s.name));
  check('技能 content 为正文（不含 frontmatter 分隔符）', captured.skills.every((s) => !s.content.startsWith('---\n')));
  const emptyDir = mkdtempSync(join(tmpdir(), 'fde-skills-'));
  check('空 skills 目录返回空数组不报错', Array.isArray(api.discoverSkills(emptyDir)) && api.discoverSkills(emptyDir).length === 0);
  rmSync(emptyDir, { recursive: true, force: true });
  const fm = api.parseSkillFrontmatter('---\nname: fde-x\ndescription: 触发时机说明\n---\n\n# 正文\n');
  check('frontmatter 极简解析正确', fm.frontmatter.name === 'fde-x' && fm.frontmatter.description === '触发时机说明' && fm.body.includes('# 正文'));

  /* 系统提示词：旧规则保留 + FDE 增量 */
  const promptText = (captured.sections[0] && captured.sections[0].text) || '';
  const mustOld = ['默认只交付', '不要主动导出 PDF', '地址锚定', '三链验证', '候选人 ≠ 中标人', 'rw_scaffold'];
  const mustNew = ['FDE 编排者声明', '阶段门禁', '回报协议', '红线', 'fde_board', 'fde_attention', 'observe'];
  check('提示词保留全部旧铁律', mustOld.every((m) => promptText.includes(m)), mustOld.filter((m) => !promptText.includes(m)));
  check('提示词增量含 FDE 编排者声明/门禁/回报协议/工具', mustNew.every((m) => promptText.includes(m)), mustNew.filter((m) => !promptText.includes(m)));
  check('只注册 1 段系统提示词（替换而非新增）', captured.sections.length === 1);
}

/* ============================ 审计修复回归（F1–F8，task-8） ============================ */
section('审计修复回归 F1–F8（task-8）');
{
  /* 直接驱动 HTTP 路由（面板人类入口），与工具入口对照。 */
  const callFde = async (path, body) => {
    const route = captured.routes.find((r) => r.path === '/research-workbench/api/fde/' + path);
    if (!route) return { status: 599, payload: { ok: false, reason: '路由未注册：' + path } };
    let status = 200;
    let payload = null;
    let raw = '';
    const req = {
      method: 'POST', url: '/research-workbench/api/fde/' + path,
      headers: { 'content-type': 'application/json' },
      on(ev, cb) { if (ev === 'data') cb(Buffer.from(JSON.stringify(Object.assign({}, body || {}, { root: ws })))); if (ev === 'end') cb(); return req; },
      destroy() {},
    };
    const res = {
      set statusCode(v) { status = v; },
      get statusCode() { return status; },
      setHeader() {},
      end(t) { raw = String(t ?? ''); try { payload = JSON.parse(raw); } catch { payload = { raw }; } },
    };
    await route.handler(req, res);
    return { status, payload };
  };
  const tEng = captured.tools.find((x) => x.name === 'fde_engagement');
  const tItem = captured.tools.find((x) => x.name === 'fde_item');
  const tAttn = captured.tools.find((x) => x.name === 'fde_attention');
  const tBrief = captured.tools.find((x) => x.name === 'fde_brief');
  const tHarvest = captured.tools.find((x) => x.name === 'fde_harvest');
  const tBoard = captured.tools.find((x) => x.name === 'fde_board');

  /* F1：agent 工具拒绝 move/archive/gate 写；只读 gate 允许；by 如实留痕 */
  const made = await tEng.execute({ action: 'create', name: '红线回归客户', company: '红线回归有限公司', root: ws });
  const rid = made.engagement.id;
  const mvTool = await tEng.execute({ action: 'move', id: rid, patch: { stage: 'discovery', force: true, reason: 'agent 自行决定' }, root: ws });
  check('F1 工具 move（含 force）被拒 BLOCKED', mvTool.ok === false && mvTool.code === 'BLOCKED' && typeof mvTool.reason === 'string', mvTool);
  const arTool = await tEng.execute({ action: 'archive', id: rid, root: ws });
  check('F1 工具 archive 被拒 BLOCKED', arTool.ok === false && arTool.code === 'BLOCKED', arTool);
  const gtwTool = await tEng.execute({ action: 'gate', id: rid, patch: { stage: 'discovery', checks: { subject_locked: { status: 'pass', evidence: 'x' } }, force: true, reason: 'agent' }, root: ws });
  check('F1/F5 工具 gate 勾选/force 被拒 BLOCKED', gtwTool.ok === false && gtwTool.code === 'BLOCKED', gtwTool);
  const ridStage = api.board(ws).board.engagements.find((e) => e.id === rid);
  check('F1 工具被拒后阶段/gateState 未变', ridStage.stage === 'lead' && !ridStage.gateState.discovery, { stage: ridStage.stage, gateState: ridStage.gateState });
  const groTool = await tEng.execute({ action: 'gate', id: rid, patch: { stage: 'discovery' }, root: ws });
  check('F5 工具 gate 只读评估允许', groTool.ok === true && groTool.gate && groTool.gate.key === 'discovery', groTool && groTool.text);
  const createdTl = (api.board(ws).board.engagements.find((e) => e.id === rid).timeline || []).find((x) => x.kind === 'created');
  check('F1 工具创建客户 timeline by=agent', createdTl && createdTl.by === 'agent', createdTl);
  const humanMove = await callFde('engagement', { action: 'move', id: rid, patch: { stage: 'discovery', force: true, reason: '人工强制推进' } });
  const ridAfter = api.board(ws).board.engagements.find((e) => e.id === rid);
  check('F1 人类 HTTP 路径 move 成功且 timeline by=human',
    humanMove.payload.ok === true && ridAfter.stage === 'discovery' && (ridAfter.timeline || []).slice(-1)[0].by === 'human',
    { status: humanMove.status, stage: ridAfter.stage, last: (ridAfter.timeline || []).slice(-1)[0] });
  const humanGate = await callFde('gate', { engagementId: rid, stage: 'discovery', checks: { subject_locked: { status: 'pass', evidence: '人已确认' } } });
  check('F5 人类 HTTP 路径 gate 勾选落盘', humanGate.payload.ok === true && humanGate.payload.gate && humanGate.payload.gate.manual.some((m) => m.key === 'subject_locked' && m.status === 'pass'));

  /* F2：engagement handoff 自动建/复用执行任务，提示词带 itemId */
  const ho = await callFde('handoff', { target: 'engagement', id: rid });
  const itemId = ho.payload.itemId;
  check('F2 handoff 返回执行任务 itemId', ho.payload.ok === true && /^itm_[0-9a-f]{6}$/.test(String(itemId)), ho.payload && ho.payload.reason);
  check('F2 提示词含 itemId 且回报指令带 id', String(ho.payload.prompt || '').includes(String(itemId)) && /fde_item[^\n]*id=/.test(String(ho.payload.prompt || '')), String(ho.payload.prompt || '').slice(-260));
  const execItem = api.board(ws).board.items.find((x) => x.id === itemId);
  /* spec §22.9：标题里的阶段是「要进入的那个阶段」（与推进条件同一个阶段） */
  const execEng = api.board(ws).board.engagements.find((x) => x.id === rid);
  const execTarget = schema.stageLabel(schema.nextStage(execEng.stage) || execEng.stage);
  check('F2 执行任务字段（doing/agent/title 含要进入的阶段名/source.kind=agent）',
    execItem && execItem.stage === 'doing' && execItem.owner === 'agent' && execItem.source && execItem.source.kind === 'agent' && execItem.title.includes('「' + execTarget + '」'),
    execItem && { stage: execItem.stage, owner: execItem.owner, title: execItem.title, expect: execTarget });
  const ho2 = await callFde('handoff', { target: 'engagement', id: rid });
  check('F2 再次 handoff 复用同一执行任务', ho2.payload.ok === true && ho2.payload.itemId === itemId && ho2.payload.reusedItem === true, { first: itemId, second: ho2.payload.itemId, reused: ho2.payload.reusedItem });

  /* F3：CAS——旧快照安全跳过 + 显式 expectedRevision 冲突 + revision 自增 */
  const ws3 = newRoot('cas');
  const e3 = api.engagement(ws3, { action: 'create', patch: { name: 'CAS客户', company: 'CAS有限公司' } }).engagement;
  const stale = store.readBoard(ws3).board;
  const it3 = api.item(ws3, { action: 'create', patch: { title: '并发写入任务', stage: 'doing', engagementId: e3.id } }).item;
  const wStale = store.writeBoard(ws3, stale);
  const after3 = store.readBoard(ws3).board;
  check('F3 旧快照写回不丢并发数据（staleSkipped）', wStale.ok === true && wStale.staleSkipped === true && after3.items.some((x) => x.id === it3.id),
    { ok: wStale.ok, skipped: wStale.staleSkipped, items: after3.items.length });
  const stale2 = store.readBoard(ws3).board;
  api.item(ws3, { action: 'create', patch: { title: '并发写入任务2', stage: 'todo' } });
  const wConflict = store.writeBoard(ws3, stale2, { expectedRevision: stale2.revision });
  check('F3 显式 expectedRevision 不匹配 → CONFLICT 且不覆盖', wConflict.ok === false && wConflict.code === 'CONFLICT', wConflict);
  check('F3 revision 自增存在且单调', Number.isInteger(after3.revision) && after3.revision >= 2, after3.revision);
  /* GET /board 的 proposal 持久化不得覆盖并发写：读快照 → 并发写 → 走 board() 刷新路径 */
  const ws3b = newRoot('cas-board');
  const eb = api.engagement(ws3b, { action: 'create', patch: { name: '并发看板客户', company: '并发看板有限公司', nextAction: { text: '', due: '' } } }).engagement;
  const snap = store.readBoard(ws3b).board; // GET 进入时快照（无 proposal）
  api.item(ws3b, { action: 'create', patch: { title: '并发任务', stage: 'doing', engagementId: eb.id } }); // 期间 agent 写
  // 模拟 refreshAndPersist：把快照上的 proposals 合并进最新 board（实现内部就是重读后求值）
  const fresh = store.readBoard(ws3b).board;
  const added = rules.refreshProposals(ws3b, fresh, {});
  const wb = store.writeBoard(ws3b, fresh, { expectedRevision: fresh.revision });
  const after3b = store.readBoard(ws3b).board;
  check('F3 读路径 proposals 落盘不覆盖并发写（基于最新 board）',
    wb.ok === true && after3b.items.some((x) => x.title === '并发任务') && snap.items.length === 0 && added.added.length <= 8,
    { writeOk: wb.ok, items: after3b.items.length, proposeAdded: added.added.length });

  /* F4：apply=true 不把派生 artifacts 写进 board.json */
  const ws4 = newRoot('pollute');
  api.engagement(ws4, { action: 'create', patch: { name: '污染回归客户', company: '污染回归有限公司', nextAction: { text: '', due: '' } } });
  api.board(ws4); // 生成 no_next 建议
  api.settings(ws4, { patch: { autonomy: 'assisted' } });
  const b4 = api.board(ws4); // 响应副本带 artifacts
  const ap4 = api.applySafeProposals(ws4, b4.board);
  const raw4 = JSON.parse(readFileSync(store.boardPath(ws4), 'utf8'));
  check('F4 apply 不写派生 artifacts 到状态文件',
    ap4.ok === true && raw4.engagements.every((x) => !Object.prototype.hasOwnProperty.call(x, 'artifacts')),
    { applied: ap4.ok, hasDerived: raw4.engagements.some((x) => 'artifacts' in x) });
  /* 工具入口只接受已注册工作区（fakeCtx 只注册了主临时工作区），这里用主 ws 验证
   * fde_brief(apply=true) 同样不把响应副本里的派生 artifacts 写回 file。 */
  api.settings(ws, { patch: { autonomy: 'assisted' } });
  const tBriefApply = await tBrief.execute({ apply: true, root: ws });
  const rawMain = JSON.parse(readFileSync(store.boardPath(ws), 'utf8'));
  api.settings(ws, { patch: { autonomy: 'observe' } });
  const rawMain2 = JSON.parse(readFileSync(store.boardPath(ws), 'utf8'));
  check('F4 工具 fde_brief(apply=true) 同样不写派生字段',
    tBriefApply.ok === true && rawMain2.engagements.every((x) => !Object.prototype.hasOwnProperty.call(x, 'artifacts')),
    { ok: tBriefApply.ok, reason: tBriefApply.reason, derived: rawMain.engagements.some((x) => 'artifacts' in x) });

  /* F6：research 下符号链接目录不得导入 / 不得读工作区外 */
  const ws6 = newRoot('symlink');
  const outside = newRoot('outside');
  const outDir = join(outside, 'proposal');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'outside-secret.md'), '工作区外文件：这里写了「不做什么」边界。');
  let symlinkOk = true;
  try { symlinkSync(outside, join(ws6, 'research', 'linked-fix')); }
  catch (e) {
    // Windows 默认策略下普通用户无权创建 symlink（需管理员或开发者模式）
    const code = e && e.code;
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES') symlinkOk = false;
    else throw e;
  }
  if (!symlinkOk) {
    skip('F6 符号链接目录不导入、不读工作区外', '当前环境不允许创建 symlink，未验证');
    skip('F6 scan 不把符号链接目录列为候选', '同上');
  } else {
  const ap6 = api.adopt(ws6, { action: 'apply', dirs: ['linked-fix'] });
  const eng6 = api.board(ws6).board.engagements.find((e) => e.dir === 'linked-fix');
  let readOutside = false;
  if (eng6) {
    const g6 = api.gate(ws6, { engagementId: eng6.id, stage: 'solution' });
    const boundary = g6.ok && g6.gate && g6.gate.auto.find((c) => c.key === 'boundary');
    readOutside = !!(boundary && boundary.ok);
  }
  check('F6 符号链接目录不导入、不读工作区外',
    ap6.ok === true && ap6.added.length === 0 && ap6.rejected.length === 1 && !readOutside,
    { added: ap6.added.length, rejected: ap6.rejected, readOutside });
  const scan6 = api.adopt(ws6, { action: 'scan' });
  check('F6 scan 不把符号链接目录列为候选', !scan6.candidates.some((c) => c.dir === 'linked-fix'));
  }

  /* F7：暂停客户不产生 stall/gate 派生注意力（overdue/显式注意力保留） */
  const ws7 = newRoot('paused');
  const ep = api.engagement(ws7, { action: 'create', patch: { name: '暂停回归客户', company: '暂停回归有限公司', nextAction: { text: '等消息', due: dateDaysFromNow(5) } } }).engagement;
  api.engagement(ws7, { action: 'update', id: ep.id, patch: { paused: true } });
  {
    const b = store.readBoard(ws7).board;
    const x = b.engagements.find((y) => y.id === ep.id);
    x.stageSince = isoDaysFromNow(-30);
    x.createdAt = isoDaysFromNow(-30);
    x.timeline = [];
    store.writeBoard(ws7, b);
  }
  const br7 = api.brief(ws7);
  const pausedAtt = br7.brief.attention.filter((a) => a.engagementId === ep.id).map((a) => a.kind);
  check('F7 暂停客户无 stall/gate 派生注意力', pausedAtt.length === 0, pausedAtt);

  /* F8：所有工具错误结果统一带 reason（保留 text） */
  const f8cases = [
    ['fde_engagement 未知 action', tEng, { action: 'nope', root: ws }],
    ['fde_item 未知 id', tItem, { action: 'report', id: 'itm_000000', kind: 'ready', text: 'x', root: ws }],
    ['fde_board 未知客户', tBoard, { view: 'engagement', id: 'eng_000000', root: ws }],
    ['fde_attention 未知 id', tAttn, { action: 'ask', target: 'engagement', id: 'eng_000000', question: 'q', root: ws }],
    ['fde_harvest 空 text', tHarvest, { text: '', root: ws }],
    ['fde_item 删除被拒', tItem, { action: 'delete', id: 'itm_000000', root: ws }],
  ];
  const badReason = [];
  for (const [name, tool, args] of f8cases) {
    let r = null;
    let threw = false;
    try { r = await tool.execute(args); } catch { threw = true; }
    if (threw || !r || r.ok !== false || typeof r.reason !== 'string' || !r.reason) badReason.push(name);
  }
  check('F8 所有工具错误结果带 reason（不抛异常）', badReason.length === 0, badReason);
  const briefErr = await tBrief.execute({ root: join(ws, 'research', '不存在的工作区') });
  check('F8 工具非法 root 也带 reason', briefErr && briefErr.ok === false && typeof briefErr.reason === 'string', briefErr);
}

/* ============================ 招采雷达集成（spec §17） ============================ */
section('招采雷达集成 §17 · 查询词/分类/匹配/缓存/关联/信号/降级');
{
  /* ---------- 查询词生成（§17.3 + Lead 实测变体要求） ---------- */
  const engVariant = {
    id: 'eng_bid_1', name: '某重型装备研究院（某所）体系部-20261013', company: '',
    shortName: '某所', dir: '某重型装备研究院（某所）体系部-20261013',
    bidWatch: { enabled: true, keywords: ['航空发动机'], links: [], lastMatchAt: '' },
  };
  const queries = fdeBids.queriesFor(engVariant);
  check('§17 查询词含 company 回填（从 name 推断工商名）', queries[0] === '某重型装备研究院', queries);
  check('§17 查询词含括号 token（某所）', queries.includes('某所'), queries);
  check('§17 查询词含 bidWatch.keywords', queries.includes('航空发动机'), queries);
  check('§17 查询词去重且 ≤10', new Set(queries.map((x) => fdeBids.normalizeText(x))).size === queries.length && queries.length <= fdeBids.MAX_QUERIES, queries);
  check('§17 目录名去年份（不含 20261013 的变体存在）', queries.some((q) => q.includes('体系部') && !q.includes('20261013')), queries);
  check('§17 无 company 时从 name 推断', fdeBids.inferCompany('某科技股份有限公司-20261026') === '某科技股份有限公司');
  check('§17 无公司标记的标题不臆造公司', fdeBids.inferCompany('legacy-project') === '');

  /* ---------- 分类（§17.3）：buyer → winner → candidate → mention；候选人≠中标 ---------- */
  const recBuyer = { id: 'b1', kind: '招标公告', title: 't', buyer: '某重型装备研究院', winner: '', candidates: [], excerpt: '' };
  const recWinner = { id: 'b2', kind: '中标结果公告', title: 't', buyer: '其他单位', winner: '某科技股份有限公司', candidates: [], excerpt: '' };
  const recCand = { id: 'b3', kind: '中标候选人公示', title: 't', buyer: '其他单位', winner: '', candidates: [{ name: '某科技股份有限公司', rank: 1 }], excerpt: '' };
  const recMention = { id: 'b4', kind: '询价公告', title: 't', buyer: '其他单位', winner: '', candidates: [], excerpt: '某重型装备研究院参与' };
  const clsBuyer = fdeBids.classifyRecord(recBuyer, ['某重型装备研究院']);
  const clsWinner = fdeBids.classifyRecord(recWinner, ['某科技']);
  const clsCand = fdeBids.classifyRecord(recCand, ['某科技']);
  const clsMention = fdeBids.classifyRecord(recMention, ['某重型装备研究院']);
  check('§17 分类 buyer（采购方）', clsBuyer.relation === 'buyer' && clsBuyer.tender === true && clsBuyer.award === false, clsBuyer);
  check('§17 分类 winner（客户中标）', clsWinner.relation === 'winner' && clsWinner.award === true, clsWinner);
  check('§17 分类 candidate（候选人）', clsCand.relation === 'candidate', clsCand);
  check('§17 候选人公示不算中标（award=false）', clsCand.award === false, clsCand);
  check('§17 分类 mention（全文提及）', clsMention.relation === 'mention' && clsMention.tender === true, clsMention);
  check('§17 关系优先级 buyer 先于 winner（同一记录 buyer 命中时按 buyer）',
    fdeBids.classifyRecord({ id: 'x', kind: '中标结果公告', buyer: '甲', winner: '乙', candidates: [], title: 't' }, ['甲', '乙']).relation === 'buyer');
  const itemNorm = fdeBids.normalizeItem(recWinner, ['某科技']);
  check('§17 金额只保留原文（数组，不求和/不换算）',
    Array.isArray(itemNorm.amounts) && !('amountSum' in itemNorm) && !('amountTotal' in itemNorm), itemNorm.amounts);

  /* ---------- 匹配：去重 / 日期倒序 / 统计 / 缓存（§17.3 / 验收 4） ---------- */
  const engMatch = { id: 'eng_match_1', name: '某重型装备研究院', company: '某重型装备研究院', bidWatch: { enabled: true, keywords: [], links: [], lastMatchAt: '' } };
  fdeBids.clearBidCache();
  fakeBid._resetCalls();
  const m1 = fdeBids.matchEngagement(fakeBid, engMatch, {});
  const ids = m1.items.map((x) => x.id);
  check('§17 匹配按 record.id 去重', new Set(ids).size === ids.length, ids);
  check('§17 匹配按日期倒序', m1.items.every((x, i, arr) => i === 0 || String(arr[i - 1].date) >= String(x.date)), m1.items.map((x) => x.date));
  check('§17 匹配统计 total/tender/award/candidate/latest 齐全',
    m1.available === true && m1.total === m1.items.length && m1.tender >= 1 && m1.award >= 1 && m1.candidate === 0 && /^\d{4}-\d{2}-\d{2}$/.test(m1.latest), m1.stats || { total: m1.total, tender: m1.tender, award: m1.award, latest: m1.latest });
  check('§17 匹配返回 queries/queryHits/sample 便于解释', Array.isArray(m1.queries) && m1.queries.length > 0 && Array.isArray(m1.queryHits) && m1.sample.length > 0);
  const callsFirst = fakeBid._calls().length;
  fakeBid._resetCalls();
  const m2 = fdeBids.matchEngagement(fakeBid, engMatch, {});
  check('§17 匹配缓存命中（5 分钟内不再检索）', m2.cached === true && fakeBid._calls().length === 0, { calls: fakeBid._calls().length, first: callsFirst });
  fakeBid._resetCalls();
  const m3 = fdeBids.matchEngagement(fakeBid, engMatch, { refresh: true });
  check('§17 refresh 强制失效缓存', m3.cached === false && fakeBid._calls().length > 0, fakeBid._calls().length);
  /* 缓存口径（与验收一致）：engagement 级 TTL 命中优先；refresh 强制重新检索，数据更新后能看到新公告。 */
  const beforeTotal = m2.total;
  fakeBid._push(bidRecord({ id: 'bid:r-new', kind: '招标公告', title: '新增招标公告', buyer: '某重型装备研究院', date: dateDaysFromNow(-1) }));
  fakeBid._resetCalls();
  const m4cached = fdeBids.matchEngagement(fakeBid, engMatch, {});
  check('§17 TTL 内仍命中缓存（数据更新需 refresh 或 TTL 到期）', m4cached.cached === true && m4cached.total === beforeTotal && fakeBid._calls().length === 0, { cached: m4cached.cached, calls: fakeBid._calls().length });
  fakeBid._resetCalls();
  const m4 = fdeBids.matchEngagement(fakeBid, engMatch, { refresh: true });
  check('§17 refresh 立即失效缓存且能看到新公告', m4.cached === false && fakeBid._calls().length > 0 && m4.total > beforeTotal, { calls: fakeBid._calls().length, total: m4.total });
  const engNoHit = { id: 'eng_no_hit', name: '完全不存在的单位名称', company: '', bidWatch: { enabled: true, keywords: [], links: [], lastMatchAt: '' } };
  const mNoHit = fdeBids.matchEngagement(fakeBid, engNoHit, { refresh: true });
  check('§17 0 命中不是错误（available:true/total:0）', mNoHit.available === true && mNoHit.total === 0 && Array.isArray(mNoHit.items), mNoHit.reason);
  check('§17 0 命中时 approxTotal=0', mNoHit.approxTotal === 0, mNoHit.approxTotal);

  /* approxTotal（spec §17.3 口径）：= 各查询词 search.total 的最大值；total 是采样去重数。 */
  const sampled = fdeBids.matchEngagement(fakeBid, engMatch, { refresh: true, perQueryLimit: 1, limit: 2 });
  const maxQueryTotal = sampled.queryHits.reduce((mx, h) => Math.max(mx, Number(h.total) || 0), 0);
  check('§17 approxTotal=各查询 search.total 最大值', sampled.approxTotal === maxQueryTotal && maxQueryTotal > 0,
    { approxTotal: sampled.approxTotal, maxQueryTotal });
  check('§17 采样 total ≤ approxTotal（有命中时）', sampled.total <= sampled.approxTotal,
    { total: sampled.total, approxTotal: sampled.approxTotal });
  check('§17 items 仍按采样上限截断（不影响 approxTotal）', sampled.items.length <= 2, sampled.items.length);

  /* ---------- 关联 / 取消关联 / 提升为任务（§17.4 / 验收 3） ---------- */
  const wsBid = newRoot('bids');
  registryWs.push({ id: 'ws-bids', path: wsBid, updatedAt: new Date().toISOString() });
  const crBid = api.engagement(wsBid, { action: 'create', patch: { name: '招采测试客户', company: '某重型装备研究院', nextAction: { text: '跟进', due: dateDaysFromNow(5) } } });
  const bidEng = crBid.engagement;
  const linkOp = { bidIntel: fakeBid };
  const link1 = api.bidLink(wsBid, { engagementId: bidEng.id, bidId: 'bid:r1', relation: 'buyer', note: '招标公告' }, linkOp);
  check('§17 link 写入 engagement.bidWatch.links', link1.ok === true && link1.link && link1.link.bidId === 'bid:r1', link1.reason);
  const boardAfterLink = api.board(wsBid, { bidIntel: fakeBid }).board;
  const engAfterLink = boardAfterLink.engagements.find((e) => e.id === bidEng.id);
  check('§17 link 落盘且 timeline by=human',
    engAfterLink.bidWatch.links.length === 1 && (engAfterLink.timeline || []).slice(-1)[0].by === 'human',
    { links: engAfterLink.bidWatch.links.length, last: (engAfterLink.timeline || []).slice(-1)[0] });
  const link2 = api.bidLink(wsBid, { engagementId: bidEng.id, bidId: 'bid:r1', relation: 'buyer' }, linkOp);
  check('§17 link 幂等（同 bidId 不重复插入）', link2.ok === true && link2.changed === false && api.board(wsBid, linkOp).board.engagements.find((e) => e.id === bidEng.id).bidWatch.links.length === 1, link2);
  const linkAgent = api.bidLink(wsBid, { engagementId: bidEng.id, bidId: 'bid:r2', relation: 'winner', by: 'agent' }, linkOp);
  check('§17 link by 如实（agent 来源记 agent）', linkAgent.ok === true && linkAgent.link.by === 'agent', linkAgent.link);
  const unlink1 = api.bidUnlink(wsBid, { engagementId: bidEng.id, bidId: 'bid:r2' }, linkOp);
  const unlink2 = api.bidUnlink(wsBid, { engagementId: bidEng.id, bidId: 'bid:r2' }, linkOp);
  check('§17 unlink 生效且幂等', unlink1.ok === true && unlink1.changed === true && unlink2.ok === true && unlink2.changed === false, { unlink1, unlink2 });
  const promote = api.bidPromote(wsBid, { engagementId: bidEng.id, bidId: 'bid:r2', by: 'agent' }, linkOp);
  check('§17 promote 建 item 且带 bidRefs', promote.ok === true && promote.item && promote.item.bidRefs && promote.item.bidRefs[0].bidId === 'bid:r2', promote.reason);
  check('§17 promote item 字段（标题/type=followup/stage=todo/关联客户）',
    promote.item.title.startsWith('跟进招标：') && promote.item.type === 'followup' && promote.item.stage === 'todo' && promote.item.engagementId === bidEng.id,
    promote.item && { title: promote.item.title, type: promote.item.type, stage: promote.item.stage });
  check('§17 promote 同时写入 link', promote.link && promote.link.bidId === 'bid:r2', promote.link);
  const promoteBoard = api.board(wsBid, linkOp).board;
  check('§17 promote 的 item 落盘且 linked 可读',
    promoteBoard.items.some((x) => x.id === promote.item.id && (x.bidRefs || []).length === 1) &&
    promoteBoard.engagements.find((e) => e.id === bidEng.id).bidWatch.links.some((l) => l.bidId === 'bid:r2'));
  const promoteMiss = api.bidPromote(wsBid, { engagementId: bidEng.id, bidId: 'bid:不存在' }, linkOp);
  check('§17 promote 未知公告 → NOT_FOUND', promoteMiss.ok === false && promoteMiss.code === 'NOT_FOUND', promoteMiss.reason);
  const linkMiss = api.bidLink(wsBid, { engagementId: 'eng_000000', bidId: 'bid:r1' }, linkOp);
  check('§17 link 未知客户 → NOT_FOUND', linkMiss.ok === false && linkMiss.code === 'NOT_FOUND');

  /* ---------- board/brief 派生 bids 摘要与全局 bidStats（§17.2） ---------- */
  const bdBid = api.board(wsBid, { bidIntel: fakeBid });
  const bidSummary = bdBid.board.engagements.find((e) => e.id === bidEng.id).bids;
  check('§17 board 每客户附 bids 摘要', bidSummary && bidSummary.available === true && typeof bidSummary.total === 'number' && Array.isArray(bidSummary.queries) && Array.isArray(bidSummary.matches), bidSummary);
  check('§17 board 每客户 bids.matches ≤5', (bidSummary.matches || []).length <= 5);
  check('§17 board 每客户 bids 摘要带 approxTotal（≥采样 total）',
    typeof bidSummary.approxTotal === 'number' && bidSummary.approxTotal >= bidSummary.total,
    { approxTotal: bidSummary.approxTotal, total: bidSummary.total });
  const boardBidsQuick = api.board(wsBid, { bidIntel: fakeBid }).bidStats;
  check('§17 board 顶层 bidStats 不受 approxTotal 影响（仍有 records/engagedCount）',
    boardBidsQuick && boardBidsQuick.available === true && boardBidsQuick.records > 0 && boardBidsQuick.engagedCount >= 1, boardBidsQuick);
  check('§17 board 顶层 bidStats（available/records/dateRange/engagedCount）',
    bdBid.bidStats && bdBid.bidStats.available === true && bdBid.bidStats.records > 0 && Array.isArray(bdBid.bidStats.dateRange) && bdBid.bidStats.engagedCount >= 1, bdBid.bidStats);
  const brBid = api.brief(wsBid, { bidIntel: fakeBid });
  check('§17 brief 带 bidStats', brBid.ok === true && brBid.brief.bidStats && brBid.brief.bidStats.available === true, brBid.brief && brBid.brief.bidStats);
  const bdNoSvc = api.board(wsBid, { bidIntel: null });
  const noSvcSummary = bdNoSvc.board.engagements[0].bids;
  check('§17 服务缺失：board 200 且 bids.available=false（不报错）',
    bdNoSvc.ok === true && noSvcSummary && noSvcSummary.available === false && bdNoSvc.bidStats.available === false, noSvcSummary);
  const statsNoSvc = api.bidsStats(wsBid, { bidIntel: null });
  check('§17 服务缺失：bidsStats available:false 不抛', statsNoSvc.ok === true && statsNoSvc.available === false, statsNoSvc.reason);
  const searchNoSvc = api.bidsSearch(wsBid, { q: 'x' }, { bidIntel: null });
  check('§17 服务缺失：bidsSearch 降级不抛', searchNoSvc.ok === true && searchNoSvc.available === false);

  /* ---------- 检索（§17.4）：给 engagementId 时逐项附 relation ---------- */
  const searchWithEng = api.bidsSearch(wsBid, { q: '某重型装备研究院', mode: 'buyer', limit: 10, engagementId: bidEng.id }, linkOp);
  check('§17 bidsSearch 返回 items 且附 relation',
    searchWithEng.ok === true && searchWithEng.available === true && searchWithEng.total > 0 &&
    searchWithEng.items.every((x) => typeof x.relation === 'string'), searchWithEng.items && searchWithEng.items.map((x) => x.relation));
  const searchPlain = api.bidsSearch(wsBid, { q: '某科技', mode: 'company', limit: 5 }, linkOp);
  check('§17 bidsSearch 不传客户时不强加 relation', searchPlain.ok === true && searchPlain.items.every((x) => x.relation === undefined));

  /* ---------- bid_signal 规则（§17.6 / 验收 5） ---------- */
  const fakeSignal = makeFakeBidIntel([
    bidRecord({ id: 'sig:1', kind: '招标公告', title: '信号公告一', buyer: '信号采购单位', date: dateDaysFromNow(-2) }),
    bidRecord({ id: 'sig:2', kind: '采购公告', title: '信号公告二', buyer: '信号采购单位', date: dateDaysFromNow(-4) }),
    bidRecord({ id: 'sig:3', kind: '询价公告', title: '信号公告三', buyer: '信号采购单位', date: dateDaysFromNow(-6) }),
    bidRecord({ id: 'sig:4', kind: '竞争性谈判公告', title: '信号公告四', buyer: '信号采购单位', date: dateDaysFromNow(-8) }),
    bidRecord({ id: 'sig:5', kind: '招标公告', title: '过期信号', buyer: '信号采购单位', date: dateDaysFromNow(-60) }),
    bidRecord({ id: 'sig:6', kind: '中标候选人公示', title: '候选信号（不算招标）', buyer: '信号采购单位', candidates: [{ name: '某公司', rank: 1 }], date: dateDaysFromNow(-3) }),
  ]);
  const wsSignal = newRoot('signal');
  const sigEng = api.engagement(wsSignal, { action: 'create', patch: { name: '信号单位', company: '信号采购单位', nextAction: { text: '跟进', due: dateDaysFromNow(5) } } }).engagement;
  const sigBoard1 = api.board(wsSignal, { bidIntel: fakeSignal });
  const sigProps1 = sigBoard1.board.proposals.filter((p) => p.ruleId === 'bid_signal' && p.engagementId === sigEng.id);
  check('§17 bid_signal 生成（仅近 30 天招标类、按客户）', sigProps1.length >= 1 && sigProps1.length <= 3, sigProps1.map((p) => p.payload && p.payload.bidId));
  check('§17 bid_signal 不含过期/非招标公告',
    !sigProps1.some((p) => ['sig:5', 'sig:6'].includes(p.payload && p.payload.bidId)), sigProps1.map((p) => p.payload && p.payload.bidId));
  check('§17 bid_signal payload 完整（bidId/title/date/url/relation）',
    sigProps1.every((p) => p.payload && p.payload.bidId && p.payload.title && p.payload.relation), sigProps1[0] && sigProps1[0].payload);
  check('§17 bid_signal 每客户每轮最多 3 条', sigProps1.length <= 3, sigProps1.length);
  const sigBoard2 = api.board(wsSignal, { bidIntel: fakeSignal });
  const sigCount2 = sigBoard2.board.proposals.filter((p) => p.ruleId === 'bid_signal' && p.engagementId === sigEng.id).length;
  check('§17 bid_signal 去重（同 bidId 不重复生成）', sigCount2 === sigProps1.length, { first: sigProps1.length, second: sigCount2 });
  /* dismissed 30 天内不重复 */
  const dismissTarget = sigProps1[0];
  const dm = await api.proposal(wsSignal, { id: dismissTarget.id, action: 'dismiss' }, {});
  check('§17 测试预置：dismiss 成功', dm.ok === true, dm.reason);
  const sigBoard3 = api.board(wsSignal, { bidIntel: fakeSignal });
  const reCreated = sigBoard3.board.proposals.some((p) => p.ruleId === 'bid_signal' && p.engagementId === sigEng.id &&
    p.payload && p.payload.bidId === dismissTarget.payload.bidId && p.id !== dismissTarget.id);
  check('§17 dismissed 30 天内不再生成同 bid 信号', reCreated === false, { dismissedBid: dismissTarget.payload.bidId });
  /* accept → 建 item（带 bidRefs），且不再重复生成 */
  const acceptTarget = sigBoard3.board.proposals.find((p) => p.ruleId === 'bid_signal' && p.engagementId === sigEng.id && p.status === 'pending');
  if (acceptTarget) {
    const acc = await api.proposal(wsSignal, { id: acceptTarget.id, action: 'accept' }, {});
    check('§17 accept bid_signal → 建跟进任务（type=followup + bidRefs）',
      acc.ok === true && acc.applied && acc.applied.item, acc.reason);
    const accItem = api.board(wsSignal, { bidIntel: fakeSignal }).board.items.find((x) => x.id === (acc.applied && acc.applied.item));
    check('§17 bid_signal 生成的 item 带 bidRefs 且标题含「跟进招标」',
      accItem && (accItem.bidRefs || []).length === 1 && accItem.title.includes('跟进招标'), accItem && { title: accItem.title, bidRefs: accItem.bidRefs });
    const after = api.board(wsSignal, { bidIntel: fakeSignal }).board.proposals.filter((p) => p.ruleId === 'bid_signal' && p.engagementId === sigEng.id && p.status === 'pending' && p.payload.bidId === acceptTarget.payload.bidId);
    check('§17 accepted 后不重复生成同 bid 信号', after.length === 0);
  } else {
    check('§17 accept bid_signal → 建跟进任务（type=followup + bidRefs）', false, '测试前置：没有 pending bid_signal');
    check('§17 bid_signal 生成的 item 带 bidRefs 且标题含「跟进招标」', false);
    check('§17 accepted 后不重复生成同 bid 信号', false);
  }
  /* paused 客户不生成 */
  const wsPausedBid = newRoot('bid-paused');
  const pEng = api.engagement(wsPausedBid, { action: 'create', patch: { name: '暂停信号单位', company: '信号采购单位' } }).engagement;
  api.engagement(wsPausedBid, { action: 'update', id: pEng.id, patch: { paused: true } });
  const pausedProposals = api.board(wsPausedBid, { bidIntel: fakeSignal }).board.proposals.filter((p) => p.ruleId === 'bid_signal');
  check('§17 paused 客户不生成 bid_signal', pausedProposals.length === 0, pausedProposals.length);
  /* 规则开关关闭 */
  const wsOff = newRoot('bid-off');
  api.settings(wsOff, { patch: { sources: { bidWatch: false } } });
  api.engagement(wsOff, { action: 'create', patch: { name: '关闭开关单位', company: '信号采购单位' } });
  const offProposals = api.board(wsOff, { bidIntel: fakeSignal }).board.proposals.filter((p) => p.ruleId === 'bid_signal');
  check('§17 settings.sources.bidWatch=false 时不生成信号', offProposals.length === 0, offProposals.length);
  /* 客户关闭 bidWatch.enabled */
  const wsDisabledEng = newRoot('bid-eng-off');
  const dEng = api.engagement(wsDisabledEng, { action: 'create', patch: { name: '关闭客户雷达', company: '信号采购单位' } }).engagement;
  api.engagement(wsDisabledEng, { action: 'update', id: dEng.id, patch: { bidWatch: { enabled: false } } });
  const engOffProps = api.board(wsDisabledEng, { bidIntel: fakeSignal }).board.proposals.filter((p) => p.ruleId === 'bid_signal');
  const engOffSummary = api.board(wsDisabledEng, { bidIntel: fakeSignal }).board.engagements.find((e) => e.id === dEng.id).bids;
  check('§17 客户级 bidWatch.enabled=false：不生成信号且摘要 available:false', engOffProps.length === 0 && engOffSummary.available === false, { props: engOffProps.length, summary: engOffSummary });

  /* ---------- fde_bid 工具（§17.5） ---------- */
  const tBid = captured.tools.find((x) => x.name === 'fde_bid');
  check('§17 第 7 个 FDE 工具已注册', !!tBid && tBid.parameters.type === 'object' && typeof tBid.execute === 'function');
  const promptText17 = (captured.sections[0] && captured.sections[0].text) || '';
  check('§17 系统提示词【技能与方法】含 fde-bid-radar 与 fde-scoping（共 11 个 FDE 技能）',
    promptText17.includes('fde-bid-radar') && ['fde-engagement', 'fde-discovery', 'fde-meeting', 'fde-scoping', 'fde-solution', 'fde-pilot', 'fde-delivery', 'fde-adoption', 'fde-board', 'fde-harvest', 'fde-bid-radar']
      .every((n) => promptText17.includes(n)), '缺：' + ['fde-bid-radar', 'fde-scoping'].filter((n) => !promptText17.includes(n)).join(','));
  check('§17 fde_bid action 枚举含 search/match/link/unlink/promote/timeline',
    JSON.stringify(tBid.parameters.properties.action.enum) === JSON.stringify(['search', 'match', 'link', 'unlink', 'promote', 'timeline']));
  const tBidMatch = await tBid.execute({ action: 'match', engagementId: bidEng.id, root: wsBid });
  check('§17 fde_bid.match 可执行（返回统计与列表）',
    tBidMatch.ok === true && tBidMatch.available === true && tBidMatch.stats && Array.isArray(tBidMatch.items) && tBidMatch.text.includes('候选人≠中标人'), tBidMatch.text && tBidMatch.text.slice(0, 120));
  check('§17 fde_bid.match 统计带 approxTotal（≥采样 total）',
    typeof tBidMatch.stats.approxTotal === 'number' && tBidMatch.stats.approxTotal >= tBidMatch.stats.total,
    { approxTotal: tBidMatch.stats.approxTotal, total: tBidMatch.stats.total });
  check('§17 fde_bid.match 文案为「相关 ≈N（采样 M 条）」',
    /相关\s*≈\d+（采样\s*\d+\s*条）/.test(String(tBidMatch.text || '')), tBidMatch.text && tBidMatch.text.split('\n')[0]);
  check('§17 fde_bid.match 提示全量深挖入口（近似量级时）',
    tBidMatch.stats.approxTotal === tBidMatch.stats.total || /bid_search|bid_timeline/.test(String(tBidMatch.text || '')), tBidMatch.text && tBidMatch.text.slice(0, 200));
  const tBidSearch = await tBid.execute({ action: 'search', q: '某科技', mode: 'company', root: wsBid });
  check('§17 fde_bid.search 可执行', tBidSearch.ok === true && tBidSearch.available === true && tBidSearch.total > 0);
  const tBidTimeline = await tBid.execute({ action: 'timeline', q: '某重型装备研究院', mode: 'buyer', root: wsBid });
  check('§17 fde_bid.timeline 可执行', tBidTimeline.ok === true && tBidTimeline.available === true);
  const tBidLink = await tBid.execute({ action: 'link', engagementId: bidEng.id, bidId: 'bid:r5', relation: 'buyer', root: wsBid });
  check('§17 fde_bid.link 允许 agent（by=agent 留痕）', tBidLink.ok === true && tBidLink.link && tBidLink.link.by === 'agent', tBidLink);
  const tBidPromote = await tBid.execute({ action: 'promote', engagementId: bidEng.id, bidId: 'bid:r1', root: wsBid });
  check('§17 fde_bid.promote 建跟进任务', tBidPromote.ok === true && tBidPromote.item && tBidPromote.item.bidRefs.length === 1);
  const tBidBad = await tBid.execute({ action: 'nope', root: wsBid });
  check('§17 fde_bid 未知 action → ok:false + reason', tBidBad.ok === false && typeof tBidBad.reason === 'string');

  /* ---------- 服务缺失：工具/路由降级为 UNAVAILABLE（不抛） ---------- */
  const noBidCtx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: () => () => {},
    get(n) {
      if (n === 'webServer') return { register: (d) => { capturedBidRoutes.push(d); return () => {}; } };
      if (n === 'tools') return { register: (d) => { capturedBidTools.push(d); } };
      if (n === 'systemPrompt') return { section: () => {}, getSectionOrder: () => 2950 };
      if (n === 'workspaceRegistry') return { list: () => [{ id: 'ws-fde', path: ws }] };
      return undefined;
    },
  };
  const capturedBidRoutes = [];
  const capturedBidTools = [];
  const modBid = await import(__toUrl(join(PLUGIN, 'index.js')) + '?bid-degraded=1');
  modBid.apply(noBidCtx);
  const tBidDegraded = capturedBidTools.find((x) => x.name === 'fde_bid');
  const wsEngId = (api.board(ws).board.engagements[0] || {}).id;
  const degradedMatch = tBidDegraded ? await tBidDegraded.execute({ action: 'match', engagementId: wsEngId, root: ws }) : null;
  check('§17 服务缺失：fde_bid 返回 code=UNAVAILABLE 且不抛',
    degradedMatch && degradedMatch.ok === false && degradedMatch.code === 'UNAVAILABLE' && typeof degradedMatch.reason === 'string',
    degradedMatch && { code: degradedMatch.code, reason: degradedMatch.reason });
  const bidStatsRoute = capturedBidRoutes.find((r) => r.path === '/research-workbench/api/fde/bids/stats');
  let degradedHttp = null;
  if (bidStatsRoute) {
    let status = 200; let payload = null;
    const req = { method: 'GET', url: '/research-workbench/api/fde/bids/stats?root=' + encodeURIComponent(ws), headers: {}, on() {}, destroy() {} };
    const res = { set statusCode(v) { status = v; }, get statusCode() { return status; }, setHeader() {}, end(t) { try { payload = JSON.parse(t); } catch { payload = { raw: t }; } } };
    await bidStatsRoute.handler(req, res);
    degradedHttp = { status, payload };
  }
  check('§17 服务缺失：GET /bids/stats → 200 + available:false（不 500）',
    degradedHttp && degradedHttp.status === 200 && degradedHttp.payload.ok === true && degradedHttp.payload.available === false,
    degradedHttp && degradedHttp.payload);
}

/* ============================ v1.3：8 阶段门禁 / 资料库 / 两个计算工具 ============================ */
section('v1.3 8 阶段门禁（meeting → scoping → solution）');
{
  const ws13 = newRoot('v13-gates');
  const dir13 = '场景客户-20260101';
  const proj13 = join(ws13, 'research', dir13);
  for (const d of ['scoping', 'proposal', 'meeting']) mkdirSync(join(proj13, d), { recursive: true });
  const cr = api.engagement(ws13, {
    action: 'create',
    patch: { name: '场景客户', company: '场景客户有限公司', dir: dir13, nextAction: { text: '收敛场景', due: dateDaysFromNow(3) } },
  });
  const e13 = cr.engagement;
  api.engagement(ws13, { action: 'move', id: e13.id, patch: { stage: 'discovery', force: true, reason: '测试预置' } });
  api.engagement(ws13, { action: 'move', id: e13.id, patch: { stage: 'meeting', force: true, reason: '测试预置' } });
  check('（预置）客户已到 meeting', api.board(ws13).board.engagements.find((x) => x.id === e13.id).stage === 'meeting');

  /* meeting → scoping：缺场景评估 + 6 项人工 */
  const blockedS = api.engagement(ws13, { action: 'move', id: e13.id, patch: { stage: 'scoping' } });
  check('meeting → scoping 缺场景评估/人工项 → BLOCKED', blockedS.ok === false && blockedS.code === 'BLOCKED' && blockedS.blocked === true, blockedS.reason);
  check('scoping missing = 1 自动（scenario）+ 6 人工', Array.isArray(blockedS.missing) && blockedS.missing.length === 7
    && blockedS.missing.filter((m) => m.type === 'auto').map((m) => m.key).join(',') === 'scenario'
    && blockedS.missing.filter((m) => m.type === 'manual').length === 6, blockedS.missing && blockedS.missing.map((m) => m.type + ':' + m.key));

  store.clearScanCache();
  writeFileSync(join(proj13, 'scoping', '场景评估表.md'), '# 场景评估表\n\nTQM 审核整改\n');
  store.clearScanCache();
  const scopingChecks = {
    sponsor_named: { status: 'pass', evidence: '王总（生产副总），每周投入' },
    integration_14d: { status: 'pass', evidence: 'MES 只读接口 10 天可通' },
    poc_90d: { status: 'pass', evidence: '90 天上线审核整改闭环' },
    usage_measurable: { status: 'pass', evidence: '质检员 30 人，每日 20 单' },
    criteria_scored: { status: 'pass', evidence: '12 维评分卡已打分，逐维写依据' },
    scenario_locked: { status: 'pass', evidence: '场景与范围已书面确认' },
  };
  const gs = api.gate(ws13, { engagementId: e13.id, stage: 'scoping', checks: scopingChecks });
  check('补齐后 scoping 门禁 pass', gs.ok === true && gs.gate.passed === true && gs.missing.length === 0, gs.gate && gs.gate.missing);
  const mvS = api.engagement(ws13, { action: 'move', id: e13.id, patch: { stage: 'scoping' } });
  check('补齐后 meeting → scoping 成功', mvS.ok === true && mvS.engagement.stage === 'scoping', mvS.reason);

  /* scoping → pilot 跳阶必须被拒 */
  const skip = api.engagement(ws13, { action: 'move', id: e13.id, patch: { stage: 'pilot' } });
  check('scoping → pilot 跳阶被拒（INVALID，提示下一阶段 solution）', skip.ok === false && skip.code === 'INVALID' && String(skip.reason).includes('方案'), skip.reason);

  /* scoping → solution：缺成本/报价 */
  const blockedQ = api.engagement(ws13, { action: 'move', id: e13.id, patch: { stage: 'solution' } });
  check('scoping → solution 缺成本/报价 → BLOCKED', blockedQ.ok === false && blockedQ.code === 'BLOCKED', blockedQ.reason);
  const qMissing = (blockedQ.missing || []).map((m) => m.key);
  check('solution missing 含 cost/quote/pricing_confirmed',
    ['cost', 'quote', 'pricing_confirmed'].every((k) => qMissing.includes(k)), qMissing);
  store.clearScanCache();
  writeFileSync(join(proj13, 'proposal', '建设方案.md'), '# 建设方案\n\n## 边界\n\n不做什么：不做 ERP 改造。\n');
  store.clearScanCache();
  const gHalf = api.gate(ws13, { engagementId: e13.id, stage: 'solution' });
  check('仅补方案：proposal/boundary 通过，cost/quote 仍缺',
    gHalf.gate.auto.find((c) => c.key === 'proposal').ok === true
      && gHalf.gate.auto.find((c) => c.key === 'boundary').ok === true
      && gHalf.gate.auto.find((c) => c.key === 'cost').ok === false
      && gHalf.gate.auto.find((c) => c.key === 'quote').ok === false,
    gHalf.gate.auto.map((c) => c.key + ':' + c.ok));
  writeFileSync(join(proj13, 'proposal', '成本测算.md'), '# 成本测算\n');
  writeFileSync(join(proj13, 'proposal', '报价单.md'), '# 报价单\n');
  store.clearScanCache();
  const gFull = api.gate(ws13, {
    engagementId: e13.id,
    stage: 'solution',
    checks: {
      solution_final: { status: 'pass', evidence: '方案已定稿' },
      pricing_confirmed: { status: 'pass', evidence: '成本与报价已复核，假设/除外/变更条款已列明' },
    },
  });
  check('补齐成本/报价 + 人工项后 solution 门禁 pass', gFull.ok === true && gFull.gate.passed === true, gFull.gate && gFull.gate.missing);
  const mvQ = api.engagement(ws13, { action: 'move', id: e13.id, patch: { stage: 'solution' } });
  check('补齐后 scoping → solution 成功', mvQ.ok === true && mvQ.engagement.stage === 'solution', mvQ.reason);
}
{
  /* 旧 board（7 阶段客户）可正常读取，不自动改写阶段 */
  const wsOld = newRoot('v13-old');
  const b = store.emptyBoard();
  b.engagements.push({
    id: 'eng_0a0001', name: '旧客户', company: '旧客户有限公司', shortName: '', dir: '',
    stage: 'solution', stageSince: store.nowIso(), paused: false, priority: 'normal',
    owner: 'Neo', tags: [], source: { kind: 'manual', ref: '', at: store.nowIso() },
    value: { amount: 0, currency: 'CNY', note: '' },
    nextAction: { text: '继续', due: dateDaysFromNow(5), owner: 'Neo' },
    stakeholders: [], gateState: {}, attention: null, sessionId: '',
    createdAt: store.nowIso(), adopted: false, timeline: [],
  });
  store.writeBoard(wsOld, b);
  const rOld = api.board(wsOld);
  check('旧 board（stage=solution）可读且阶段不被改写', rOld.ok === true
    && rOld.board.engagements[0].stage === 'solution' && rOld.meta.stages.length === 8, rOld.board.engagements[0] && rOld.board.engagements[0].stage);
}

section('v1.3 提示词：scoping / 成本报价要点');
{
  const eShell = { id: 'eng_shell', name: '某客户', stage: 'scoping', dir: '', nextAction: { text: '收敛场景' } };
  const pScoping = prompts.buildPrompt('engagement', { root: ws, engagement: eShell, intent: 'stage' });
  check('scoping handoff 含 fde_scoping + fde_scenario + 场景评估表产物',
    pScoping.includes('fde-scoping') && pScoping.includes('fde_scenario') && pScoping.includes('场景评估表')
      && pScoping.includes('四条硬门槛'), pScoping.slice(0, 120));
  check('scoping handoff 含 12 维/否决项口径', /12 维/.test(pScoping) && /否决/.test(pScoping));
  const pSol = prompts.buildPrompt('engagement', { root: ws, engagement: Object.assign({}, eShell, { stage: 'solution' }), intent: 'stage' });
  check('solution handoff 含 fde_quote + 成本测算/报价单产物', pSol.includes('fde_quote') && pSol.includes('成本测算') && pSol.includes('报价单'));
  const pMeet = prompts.buildPrompt('engagement', { root: ws, engagement: Object.assign({}, eShell, { stage: 'meeting' }), intent: 'stage' });
  check('meeting handoff 含会后交接场景评估', pMeet.includes('场景') && pMeet.includes('需求池'));
  const pPilot = prompts.buildPrompt('engagement', { root: ws, engagement: Object.assign({}, eShell, { stage: 'pilot' }), intent: 'stage' });
  check('pilot handoff 含 Charter 三条时间门限', pPilot.includes('14 天') && pPilot.includes('90 天') && pPilot.includes('120 天'));
}

section('v1.3 第 9–11 个 FDE 工具（资料库 / 场景评估 / 成本报价）');
{
  const tLib = captured.tools.find((x) => x.name === 'fde_library');
  const tScn = captured.tools.find((x) => x.name === 'fde_scenario');
  const tQuote = captured.tools.find((x) => x.name === 'fde_quote');
  check('已注册 fde_library / fde_scenario / fde_quote', !!tLib && !!tScn && !!tQuote);
  check('三个新工具 schema 合法（参数/execute/presentCall/render）',
    [tLib, tScn, tQuote].every((t) => t && t.parameters && t.parameters.type === 'object' && typeof t.execute === 'function'
      && typeof t.presentCall === 'function' && t.output && typeof t.output.render === 'function'));
  check('fde_scenario 参数含 evaluate|template', JSON.stringify(tScn.parameters.properties.action.enum) === JSON.stringify(['evaluate', 'template']));
  check('fde_quote 参数含 calculate|template 与 labor/nonLabor/contingencyPct',
    JSON.stringify(tQuote.parameters.properties.action.enum) === JSON.stringify(['calculate', 'template'])
      && !!tQuote.parameters.properties.labor && !!tQuote.parameters.properties.nonLabor && !!tQuote.parameters.properties.contingencyPct);
  check('fde_library 参数含 feed|search|refresh', JSON.stringify(tLib.parameters.properties.action.enum) === JSON.stringify(['feed', 'search', 'refresh']));

  /* —— 12 维归一化回归：权重合计 101，Σ/101；不得除以 100（3.56 不能被抬成 3.60）—— */
  const scoresA = { value: 5, pain: 4, data: 3, tech: 3, accept: 3, compliance: 4, roi: 3, readiness: 3, delivery: 3, reuse: 3, alternative: 4, timing: 3 };
  const outA = await tScn.execute({
    action: 'evaluate',
    scenarios: [{ name: 'A 场景', gates: { sponsor: true, integration14d: true, prod90d: true, measurable: true }, scores: scoresA, vetoes: [] }],
  });
  const rA = (outA.ranked || [])[0] || {};
  check('归一化回归：rawSum=360、weightSum=101、score=3.56（不是 3.60）',
    outA.ok === true && rA.rawSum === 360 && outA.formula && outA.formula.weightSum === 101
      && rA.score === 3.56 && rA.score !== 3.6, { rawSum: rA.rawSum, score: rA.score, formula: outA.formula });
  check('归一化回归：档位从「进方案」降为「补证/小 POC」', rA.conclusion === '补证/小 POC' && rA.conclusion !== '进方案', rA.conclusion);
  check('12 维权重合计常量 = 101（不是 100）', fdeCalc.SCENARIO_WEIGHT_SUM === 101 && fdeCalc.SCENARIO_DIMENSIONS.length === 12);

  /* triggers：gates 缺项 / 否决 / template */
  const outGate = await tScn.execute({
    action: 'evaluate',
    scenarios: [{
      name: '缺发起人', gates: { sponsor: false, integration14d: true, prod90d: true, measurable: true }, scores: scoresA,
    }],
  });
  check('gates 任一 false → 暂不启动并列出缺项', outGate.ok === true
    && outGate.ranked[0].conclusion === '暂不启动（补前置条件）'
    && outGate.ranked[0].missing.some((x) => x.includes('发起人')), outGate.ranked[0]);
  const outVeto = await tScn.execute({
    action: 'evaluate',
    scenarios: [{ name: '否决场景', gates: { sponsor: true, integration14d: true, prod90d: true, measurable: true }, scores: scoresA, vetoes: [3] }],
  });
  check('否决项命中 → 不进方案（例外需人签字）', outVeto.ranked[0].conclusion === '不进方案（例外需人签字）'
    && outVeto.ranked[0].vetoes[0] === 3 && outVeto.ranked[0].eligible === false, outVeto.ranked[0]);
  const outTpl = await tScn.execute({ action: 'template' });
  check('scenario template 为空白评分表（12 维 + 4 门槛 + 否决项 + 依据列 + 档位）',
    outTpl.ok === true && outTpl.markdown.includes('12 维') && outTpl.markdown.includes('否决项')
      && outTpl.markdown.includes('101') && outTpl.markdown.includes('依据') && outTpl.markdown.includes('3.6'), outTpl.markdown && outTpl.markdown.slice(0, 80));

  /* —— fde_quote：三点估算 P80 / 公式 / 警告 —— */
  const q = await tQuote.execute({
    action: 'calculate', title: '测试项目',
    labor: [
      { name: 'FDE/算法', personDays: 20, rate: 1200 },
      { name: '数据与评测', optimistic: 8, likely: 10, pessimistic: 15, rate: 940 },
    ],
    defaultRate: 940,
    nonLabor: { dataEval: 10000, cloudToken: 2000, compliance: 3000, ops: 2000, travel: 1000, quality: 2000, other: 0 },
    contingencyPct: 15, taxPct: 6, marginPct: 35, discountPct: 0, teamSize: 3, weeks: 12,
  });
  const qs = q.summary || {};
  check('quote 三点估算：P50=10.5 / P80 计价=11.5 人天', q.ok === true
    && q.details.labor[1].p50PersonDays === 10.5 && q.details.labor[1].personDays === 11.5
    && q.details.labor[1].estimate === 'three-point', q.details && q.details.labor[1]);
  check('quote 公式与 spec §21.2 一致（固定输入断言到分）',
    qs.laborCost === 34810 && qs.nonLaborTotal === 20000 && qs.directCost === 54810
      && qs.contingency === 8221.5 && qs.totalCost === 63031.5 && qs.floor === 66813.39
      && qs.target === 102789.83 && qs.final === 102789.83 && qs.ceiling === 121478.89
      && qs.realizedMarginPct === 35 && qs.marginAmount === 33940.04, qs);
  check('quote 汇总含 P50/P80 总人天', qs.p50PersonDays === 30.5 && qs.p80PersonDays === 31.5, { p50: qs.p50PersonDays, p80: qs.p80PersonDays });
  check('quote 正常场景不误报亏损/甜点区/人天不匹配警告',
    !(q.warnings || []).some((w) => /亏损|甜点区|人天与周期不匹配/.test(w)), q.warnings);
  const qTpl = await tQuote.execute({ action: 'template' });
  check('quote template 含三点估算/数据与评测/云与推理/里程碑/变更单',
    qTpl.ok === true && qTpl.markdown.includes('三点估算') && qTpl.markdown.includes('数据与评测')
      && qTpl.markdown.includes('云与推理') && qTpl.markdown.includes('变更单'), qTpl.markdown && qTpl.markdown.slice(0, 80));

  /* 工具不写文件/不写 board：调用前后 board 与 .fde 目录不变 */
  const boardFile = store.boardPath(ws);
  const beforeBoard = existsSync(boardFile) ? readFileSync(boardFile, 'utf8') : null;
  const fdeDir = join(ws, 'research', '.fde');
  const beforeFde = existsSync(fdeDir) ? readdirSync(fdeDir).sort().join(',') : '';
  await tScn.execute({ action: 'template' });
  await tQuote.execute({ action: 'template' });
  await tScn.execute({ action: 'evaluate', scenarios: [{ name: 'X', gates: { sponsor: true, integration14d: true, prod90d: true, measurable: true }, scores: scoresA }] });
  await tQuote.execute({ action: 'calculate', labor: [{ name: 'a', personDays: 1, rate: 1000 }] });
  const afterBoard = existsSync(boardFile) ? readFileSync(boardFile, 'utf8') : null;
  const afterFde = existsSync(fdeDir) ? readdirSync(fdeDir).sort().join(',') : '';
  check('fde_scenario / fde_quote 不写文件、不写 board（mtime 内容不变）', beforeBoard === afterBoard && beforeFde === afterFde);

  /* 资料库工具：无缓存/无 catalog 都返回结构化降级，不抛异常 */
  const libOut = await tLib.execute({ action: 'feed', root: ws });
  check('fde_library 无缓存/catalog 缺失时结构化降级（不抛异常）',
    (libOut.ok === true && libOut.feed === null && libOut.stale === true)
      || (libOut.ok === false && libOut.code === 'UNAVAILABLE' && typeof libOut.reason === 'string'),
    { ok: libOut.ok, code: libOut.code, feed: libOut.feed, reason: libOut.reason });
  const libTpl = await tLib.execute({ action: 'template', root: ws });
  check('fde_library 未知 action → ok:false/INVALID', libTpl.ok === false && libTpl.code === 'INVALID');

  /* 资料库路由已注册（GET feed / POST refresh，http200 降级） */
  const feedRoute = captured.routes.find((r) => r.path === '/research-workbench/api/fde/library/feed');
  const refreshRoute = captured.routes.find((r) => r.path === '/research-workbench/api/fde/library/refresh');
  check('已注册 library/feed 与 library/refresh 路由', !!feedRoute && !!refreshRoute);
  const r13 = await (async () => {
    if (!feedRoute) return null;
    let status = 200; let payload = null;
    const req = { method: 'GET', url: '/research-workbench/api/fde/library/feed?root=' + encodeURIComponent(ws), headers: {}, on() {}, destroy() {} };
    const res = { set statusCode(v) { status = v; }, get statusCode() { return status; }, setHeader() {}, end(t) { try { payload = JSON.parse(t); } catch { payload = { raw: t }; } } };
    await feedRoute.handler(req, res);
    return { status, payload };
  })();
  check('GET library/feed → HTTP 200（无缓存 feed:null 或 catalog 缺失 UNAVAILABLE）',
    r13 && r13.status === 200 && (('feed' in r13.payload) || r13.payload.code === 'UNAVAILABLE'),
    r13 && { status: r13.status, ok: r13.payload.ok, code: r13.payload.code });
  const promptText13 = (captured.sections[0] && captured.sections[0].text) || '';
  check('系统提示词含 8 阶段/资料库/场景/报价口径',
    promptText13.includes('8 个阶段') && promptText13.includes('fde_library') && promptText13.includes('fde_scenario')
      && promptText13.includes('fde_quote') && promptText13.includes('不得除以 100') && promptText13.includes('资料库')
      && promptText13.includes('场景'), '缺失关键约定');
}

/* ============================ v2.0 可交付版（spec §22 / ADR 0010） ============================ */
/** 本地日期往后 n 天的正午（时间旅行用；避开夏令时与零点边界）。 */
const noonPlus = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d.getTime(); };
const pendingOf = (b) => (b.proposals || []).filter((p) => p.status === 'pending');

section('v2.0 §22.1 用词：schema 里给人看的文本（key / 结构 / 判定逻辑不变）');
{
  const m = schema.meta();
  check('任务状态标签 7 个', m.lanes.map((l) => l.label).join('/') === '待整理/待开始/进行中/等对方/待验收/已完成/已取消', m.lanes.map((l) => l.label));
  check('任务状态说明是平实短句（不出现 WIP / agent）', m.lanes.every((l) => l.definition && !/WIP|agent/i.test(l.definition)), m.lanes.map((l) => l.definition));
  check('待我处理分类标签 8 个', m.attentionKinds.map((a) => a.label).join('/') === '卡住了/等你决定/待验收/等你回复/已逾期/等你确认/没有进展/提醒', m.attentionKinds.map((a) => a.label));
  check('attentionKinds 保留 text 字段（meta 形状不变），不再带「种类：」前缀', m.attentionKinds.every((a) => a.text === ''), m.attentionKinds.map((a) => a.text));
  check('AI 权限：三档 key 保留；observe「只提醒，由我决定」，assisted / auto 同为「小事可以直接处理」',
    m.autonomyModes.map((a) => a.key + ':' + a.label).join('|') === 'observe:只提醒，由我决定|assisted:小事可以直接处理|auto:小事可以直接处理', m.autonomyModes.map((a) => a.label));
  check('AI 权限说明如实写明「小事」范围，且不含 item / nextAction / 门禁',
    m.autonomyModes.every((a) => !/item|nextAction|门禁/.test(a.label + a.definition))
      && ['assisted', 'auto'].every((k) => { const d = m.autonomyModes.find((a) => a.key === k).definition; return d.includes('补一条待确认的下一步') && d.includes('为新招采公告建跟进任务') && d.includes('其余都要你决定'); }),
    m.autonomyModes.map((a) => a.definition));
  check('只能由你决定的事 6 条', JSON.stringify(m.redLines) === JSON.stringify(['推进客户阶段', '确认推进条件', '标记交付或验收完成', '导出或发送对外材料', '删除客户或任务', '修改客户文件夹里的定稿文件']), m.redLines);
  check('推进条件名称统一为「进入「<阶段名>」的条件」', m.gateList.every((g) => g.label === `进入「${schema.stageLabel(g.stage)}」的条件`), m.gateList.map((g) => g.label));
  const gateTexts = m.gateList.flatMap((g) => [g.label, ...g.auto.map((c) => c.label), ...g.manual.map((c) => c.label)]);
  const gateBad = /门禁|准入|\bmd\b|非空|≥|(scoping|meeting|proposal|pilot|delivery|adoption|research|docs)\/|SOW|nextAction|干系人/;
  check('推进条件的检查项名称是人话（无文件匹配规则 / 目录 / 英文字段）', gateTexts.every((t) => t && !gateBad.test(t)), gateTexts.filter((t) => gateBad.test(t)));
  check('材料类检查项的名称符合约定', JSON.stringify(m.gateList.flatMap((g) => g.auto.map((c) => c.key + '=' + c.label))) === JSON.stringify([
    'company=写了公司全称', 'source=写了线索来源', 'next_action=定了下一步',
    'archive=有项目档案', 'factcheck=有事实核查清单', 'kpi=有 KPI 或痛点假设',
    'brief=有会面 Brief', 'stakeholders=至少登记 1 位关键人',
    'scenario=有场景评估表',
    'proposal=有方案文档', 'boundary=方案里写明了不做什么', 'cost=有成本测算', 'quote=有报价单或工作说明书',
    'pilot_md=有试点方案', 'delivery_md=有交付文档', 'adoption_evidence=有使用或价值证据',
  ]), m.gateList.flatMap((g) => g.auto.map((c) => c.key + '=' + c.label)));
  check('四条硬门槛与 12 维评分的口径保留；delivery / adoption 的确认项补成完整短句',
    schema.GATES.scoping.manual.map((c) => c.label).join('|') === '有姓名的业务发起人（愿意每周投入，非礼节性挂名）|14 天内可完成首次数据/系统对接|90 天内可生产上线并使用|使用行为可测量（有明确人群与频次）|12 维评分卡已打分并逐维写明依据（空依据按 3 分封顶）|场景与范围、优先级已与客户书面确认'
      && schema.GATES.delivery.manual.map((c) => c.label).join('|') === '验收清单已和客户确认|里程碑已排定|风险登记已建立'
      && schema.GATES.adoption.manual.map((c) => c.label).join('|') === '使用证据已收集|培训已完成|扩展地图已画出');
  /* 判定逻辑快照：与改写前逐字一致（type / field / alternatives / match / min 一个字都没动）。 */
  const logic = JSON.stringify(Object.values(schema.GATES).map((g) => [g.key, g.stage,
    g.auto.map((c) => [c.key, c.type, c.field || '', c.alternatives || null, c.min == null ? null : c.min]),
    g.manual.map((c) => c.key)]));
  check('检查项的判定逻辑未变（type / field / alternatives / min 快照）', logic === '[["intake","lead",[["company","field","company",null,null],["source","field","source.kind",null,null],["next_action","field","nextAction.text",null,null]],[]],["discovery","discovery",[["archive","archive","",null,null],["factcheck","artifact","",[{"match":"事实核查"}],1],["kpi","artifact","",[{"match":"KPI|痛点"}],1]],["subject_locked","evidence_graded"]],["meeting","meeting",[["brief","artifact","",[{"dir":"meeting","match":"Brief|brief"}],1],["stakeholders","stakeholders","",null,1]],["meeting_goal"]],["scoping","scoping",[["scenario","artifact","",[{"dir":"scoping","match":"场景"},{"dir":"meeting","match":"场景"}],1]],["sponsor_named","integration_14d","poc_90d","usage_measurable","criteria_scored","scenario_locked"]],["solution","solution",[["proposal","artifact","",[{"dir":"proposal"}],1],["boundary","content","",[{"dir":"proposal","match":"不做什么|边界"}],null],["cost","artifact","",[{"dir":"proposal","match":"成本"},{"match":"成本"}],1],["quote","artifact","",[{"match":"报价|SOW|工作说明书"}],1]],["solution_final","pricing_confirmed"]],["pilot","pilot",[["pilot_md","artifact","",[{"dir":"pilot"},{"dir":"proposal","match":"试点|POC|pilot"}],1]],["pilot_scope"]],["delivery","delivery",[["delivery_md","artifact","",[{"dir":"delivery"},{"dir":"docs"}],1]],["acceptance","milestones","risks"]],["adoption","adoption",[["adoption_evidence","artifact","",[{"dir":"adoption"},{"dir":"research","match":"价值|使用证据|培训|扩展"}],1]],["usage_evidence","training","expansion_map"]]]', logic);
  check('meta 的检查项仍只输出 key / label / type（missingText 不外露）', m.gateList.every((g) => g.auto.every((c) => Object.keys(c).join(',') === 'key,label,type') && g.manual.every((c) => Object.keys(c).join(',') === 'key,label')));

  check('规则仍是 8 条，其中 4 条标 derived', m.rules.length === 8 && m.rules.filter((r) => r.derived === true).map((r) => r.ruleId).join(',') === 'stall,overdue,gate_ready,review_lag'
    && schema.DERIVED_RULE_IDS.join(',') === 'stall,overdue,gate_ready,review_lag' && schema.isDerivedRule('stall') && !schema.isDerivedRule('no_next'), m.rules.map((r) => r.ruleId + ':' + !!r.derived));
  check('规则名称', m.rules.map((r) => r.label).join('/') === '没有进展/快到期/已逾期/没定下一步/等你确认/会面快到了/验收拖延/新招采公告', m.rules.map((r) => r.label));
  const ruleBad = /nextAction|\bitem\b|settings|bidWatch|bidSignalDays|stallDays|\breview\b|\bmeeting\b|门禁|会话/;
  check('规则的条件与说明是人话，说明不以「建议：」开头', m.rules.every((r) => !ruleBad.test(r.condition + ' ' + r.detail) && !/^建议/.test(r.detail)), m.rules.filter((r) => ruleBad.test(r.condition + ' ' + r.detail) || /^建议/.test(r.detail)).map((r) => r.ruleId));
  check('招采关系说明不含 Markdown 星号与英文括注', m.bidRelations.every((r) => !/\*|buyer|winner|candidate|mention/.test(r.definition)), m.bidRelations.map((r) => r.definition));

  const pbTexts = schema.ENGAGEMENT_STAGES.flatMap((st) => [st.playbook.goal, ...st.playbook.inputs, ...st.playbook.activities, ...st.playbook.pitfalls, ...st.playbook.tools.map((t) => t.label)]);
  const pbBad = /fde_|rw_|fde-|nextAction|company \/|门禁|干系人|客户卷|agent|\.json|raw\/|curl|pdftotext/;
  check('阶段指南的句子与工具标签不含字段名 / 工具函数名 / 旧词', pbTexts.every((t) => t && !pbBad.test(t)), pbTexts.filter((t) => pbBad.test(t)));
  /* 技能 / 工具 / 资料库来源组的 name 是程序标识，未动；方法指针只换了两处悬空的（试点：文档模板库 → 07 + 06；采用：00 → 01）。 */
  check('阶段指南 tools[].name：程序标识未变，只换了悬空的方法指针', JSON.stringify(schema.ENGAGEMENT_STAGES.map((st) => st.playbook.tools.map((t) => t.kind + ':' + t.name)))
    === '[["skill:fde-engagement","method:00-调研执行流程.md","template:项目档案模板.md","tool:fde_board","tool:fde_library","library:method"],["skill:fde-discovery","method:01-事实核查协议.md","method:02-KPI与痛点假设法.md","method:数据源清单.md","tool:fde_bid","tool:fde_library","library:intl-official"],["skill:fde-meeting","method:03-合作地图构建法.md","method:文档模板库.md","tool:fde_bid","tool:fde_library","library:cn-official"],["skill:fde-scoping","method:06-场景选择与数据体检.md","template:场景评估表.md","tool:fde_scenario","tool:fde_library","library:opensource"],["skill:fde-solution","method:07-成本评估与报价.md","method:04-领域模型合作方法论.md","template:成本测算与报价单.md","tool:fde_quote","tool:fde_library","library:intl-official"],["skill:fde-pilot","method:03-合作地图构建法.md","method:07-成本评估与报价.md","method:06-场景选择与数据体检.md","tool:fde_library","library:opensource"],["skill:fde-delivery","method:05-正式对外文档交付（DOCX·公文版式）.md","tool:rw_export_pdf","tool:rw_qa_pdf","tool:fde_library","library:method"],["skill:fde-adoption","method:01-事实核查协议.md","tool:fde_harvest","tool:fde_library","library:community"]]');
  const act = (k) => schema.ENGAGEMENT_STAGES.find((st) => st.key === k).playbook.activities.join('\n');
  check('方法口径的数字未变（四条硬门槛 / 12 维归一化 / 14·90·120 天 / P80 / 15%·35%·6%）',
    act('scoping').includes('四条硬门槛（有姓名发起人 / 14 天首次集成 / 90 天上线 / 使用可测）') && act('scoping').includes('Σ(分×权重)/Σ权重') && act('scoping').includes('空依据按 3 分封顶')
      && act('solution').includes('三点估算 P80 计价人天') && act('solution').includes('预备费 15%、毛利 35%、税 6%')
      && act('pilot').includes('首次集成 ≤14 天、上线 ≤90 天、撤出 ≤120 天'));
  check('默认值不被写成行业标准', !pbTexts.some((t) => /行业标准|行业惯例/.test(t)));
}

section('v2.0 §22.3 待我处理：不带前缀的完整句子 + question 字段');
{
  const w = newRoot('v2-attn');
  const mk = (name, extra = {}) => api.engagement(w, { action: 'create', patch: Object.assign({ name, company: name + '有限公司', nextAction: { text: '跟进', due: dateDaysFromNow(9) } }, extra) }).engagement;
  const eOver = mk('某集团', { nextAction: { text: '确认方案范围', due: dateDaysFromNow(-2) } });
  const eDec = mk('某研究院');
  api.attention(w, { action: 'ask', target: 'engagement', id: eDec.id, kind: 'decision', question: '是否先做试点？', by: 'agent' });
  const eBlk = mk('某公司');
  api.attention(w, { action: 'ask', target: 'engagement', id: eBlk.id, kind: 'blocked', question: '等对方给数据' });
  const eAns = mk('某单位');
  api.attention(w, { action: 'ask', target: 'engagement', id: eAns.id, kind: 'answer', question: '预算口径是什么？', by: 'agent' });
  const eStall = mk('某工厂');
  const itReview = api.item(w, { action: 'create', patch: { title: '会面 Brief', stage: 'review', engagementId: eOver.id } }).item;
  const itOver = api.item(w, { action: 'create', patch: { title: '整理名片', stage: 'todo', due: dateDaysFromNow(-3) } }).item;
  const itBlk = api.item(w, { action: 'create', patch: { title: '拉数据', stage: 'doing', engagementId: eDec.id } }).item;
  api.item(w, { action: 'report', id: itBlk.id, kind: 'blocked', text: '接口不通', by: 'agent' });
  {
    const b = store.readBoard(w).board;
    const x = b.engagements.find((y) => y.id === eStall.id);
    x.stageSince = isoDaysFromNow(-19); x.createdAt = isoDaysFromNow(-19); x.timeline = [];
    store.writeBoard(w, b);
  }
  const list = api.board(w).attention;
  const one = (kind, pred) => list.find((a) => a.kind === kind && pred(a)) || {};
  const aOver = one('overdue', (a) => a.engagementId === eOver.id && !a.itemId);
  check('客户下一步逾期：「<客户>的下一步已逾期 N 天：<下一步>」', aOver.text === '某集团的下一步已逾期 2 天：确认方案范围' && aOver.detail === '确认方案范围' && aOver.days === 2, aOver.text);
  const aDec = one('decision', (a) => a.engagementId === eDec.id && !a.itemId);
  check('客户等你决定：句子带问题，question / detail 放问题原文', aDec.text === '某研究院等你决定：是否先做试点？' && aDec.question === '是否先做试点？' && aDec.detail === '是否先做试点？', aDec);
  const aBlk = one('blocked', (a) => a.engagementId === eBlk.id && !a.itemId);
  check('客户卡住了', aBlk.text === '某公司卡住了：等对方给数据' && aBlk.question === '等对方给数据', aBlk.text);
  const aAns = one('answer', (a) => a.engagementId === eAns.id);
  check('客户等你回复', aAns.text === '某单位等你回复：预算口径是什么？' && aAns.question === '预算口径是什么？', aAns.text);
  const aStall = one('stall', (a) => a.engagementId === eStall.id);
  check('没有进展：「<客户>已 N 天没有进展」，detail「在「<阶段>」已 M 天」', aStall.text === '某工厂已 19 天没有进展' && aStall.detail === '在「线索」已 19 天' && aStall.days === 19, { text: aStall.text, detail: aStall.detail });
  const aRev = one('review', (a) => a.itemId === itReview.id);
  check('任务待验收：detail 放所属客户名', aRev.text === '任务「会面 Brief」做完了，等你验收' && aRev.detail === '某集团' && aRev.question === '', aRev);
  const aItOver = one('overdue', (a) => a.itemId === itOver.id);
  check('任务逾期：独立任务的 detail 为空串（不写「独立任务」）', aItOver.text === '任务「整理名片」已逾期 3 天' && aItOver.detail === '', aItOver);
  const aItBlk = one('blocked', (a) => a.itemId === itBlk.id);
  check('任务卡住了：句子带问题', aItBlk.text === '任务「拉数据」卡住了：接口不通' && aItBlk.question === '接口不通' && aItBlk.detail === '接口不通', aItBlk.text);
  check('每条都有 question 字段（没有提问时为空串），title 与 text 相同', list.every((a) => typeof a.question === 'string' && a.title === a.text));
  check('没有任何一条带旧的「种类：」前缀或「独立任务」',
    list.every((a) => !/^(受阻|需要决定|待审阅|需要回答|逾期|门禁待确认|停滞)/.test(a.text) && !/｜|独立任务/.test(a.text + a.detail)), list.map((a) => a.text));
  check('其它字段形状不变', list.every((a) => ['kind', 'rank', 'text', 'title', 'detail', 'engagementId', 'engagementName', 'itemId', 'itemTitle', 'due', 'days', 'priority', 'actions', 'target'].every((k) => k in a)));
  check('排序规则不变（rank 单调不减）', list.every((a, i) => i === 0 || list[i - 1].rank <= a.rank), list.map((a) => a.kind));
}

section('v2.0 §22.2 提醒：derived 不生成 / 存量失效 / applySafeProposals 跳过');
{
  /* 四种 derived 情形同时成立：没有进展、已逾期（客户 + 任务）、材料已齐等确认、验收拖延。 */
  const w = newRoot('v2-derived');
  const proj = join(w, 'research', '材料齐客户-20260101');
  mkdirSync(join(proj, 'research'), { recursive: true });
  writeFileSync(join(proj, '00-项目档案.md'), '# 项目档案：材料齐客户\n');
  writeFileSync(join(proj, 'research', '事实核查清单.md'), 'A 级');
  writeFileSync(join(proj, 'research', 'KPI与痛点假设.md'), '假设');
  api.engagement(w, { action: 'create', patch: { name: '材料齐客户', company: '材料齐客户有限公司', dir: '材料齐客户-20260101', nextAction: { text: '等确认', due: dateDaysFromNow(9) }, source: { kind: 'manual' } } });
  api.engagement(w, { action: 'create', patch: { name: '老客户', company: '老客户有限公司', nextAction: { text: '跟进', due: dateDaysFromNow(-5) } } });
  const itReview = api.item(w, { action: 'create', patch: { title: '等验收的任务', stage: 'review' } }).item;
  api.item(w, { action: 'create', patch: { title: '过期的任务', stage: 'todo', due: dateDaysFromNow(-4) } });
  {
    const b = store.readBoard(w).board;
    for (const x of b.engagements) { x.stageSince = isoDaysFromNow(-30); x.createdAt = isoDaysFromNow(-30); x.timeline = []; }
    const r = b.items.find((x) => x.id === itReview.id);
    r.createdAt = isoDaysFromNow(-6); r.history = [];
    const wr = store.writeBoard(w, b);
    check('（预置）derived 情形看板写盘成功', wr.ok, wr.reason);
  }
  const r1 = api.board(w);
  const kinds = new Set(r1.attention.map((a) => a.kind));
  check('（预置）四种情形都在待我处理里：没有进展 / 已逾期 / 等你确认 / 待验收', ['stall', 'overdue', 'gate', 'review'].every((k) => kinds.has(k)), [...kinds]);
  check('derived 规则不生成提醒（客户级与任务级的 overdue 都不生成）',
    r1.board.proposals.length === 0 && r1.proposalsAdded === 0, r1.board.proposals.map((p) => p.ruleId));
  check('待我处理里没有与之重复的提醒', !r1.attention.some((a) => a.kind === 'proposal'));

  /* 存量看板：v1.x 留下的 derived 待处理提醒。 */
  const w2 = newRoot('v2-legacy');
  const eL = api.engagement(w2, { action: 'create', patch: { name: '存量客户', company: '存量客户有限公司', nextAction: { text: '跟进', due: dateDaysFromNow(-3) } } }).engagement;
  {
    const b = store.readBoard(w2).board;
    b.settings.autonomy = 'assisted';
    const legacy = (id, ruleId, kind) => ({
      id, ruleId, engagementId: eL.id, itemId: '', kind, title: '存量客户 的旧提醒（' + id + '）', detail: '建议：改期或标记完成（跟进）',
      payload: { patch: { nextAction: { due: dateDaysFromNow(2) } } }, status: 'pending', createdAt: store.nowIso(), decidedAt: '',
    });
    b.proposals.push(legacy('prp_0a0001', 'overdue', 'update_next'), legacy('prp_0a0002', 'stall', 'nudge'));
    const wr = store.writeBoard(w2, b);
    check('（预置）存量看板带两条 derived 待处理提醒（safe:true）', wr.ok && schema.ruleDef('overdue').safe === true && schema.ruleDef('stall').safe === true, wr.reason);
  }
  const actBefore = store.readBoard(w2).board.activity.length;
  const ap = api.applySafeProposals(w2);
  check('applySafeProposals 跳过存量 derived 提醒（assisted 档）',
    ap.ok && ap.mode === 'assisted' && ap.applied.length === 0 && ['prp_0a0001', 'prp_0a0002'].every((id) => ap.skipped.includes(id)), { applied: ap.applied, skipped: ap.skipped });
  check('跳过后客户的下一步没有被改期', store.readBoard(w2).board.engagements.find((x) => x.id === eL.id).nextAction.due === dateDaysFromNow(-3));
  const rL = api.board(w2);
  const legacyAfter = rL.board.proposals.filter((p) => ['prp_0a0001', 'prp_0a0002'].includes(p.id));
  check('存量 derived 提醒在首次刷新时自动失效（dismissed + expired:true + decidedAt）',
    legacyAfter.length === 2 && legacyAfter.every((p) => p.status === 'dismissed' && p.expired === true && !!p.decidedAt) && rL.proposalsExpired === 2, legacyAfter.map((p) => [p.status, p.expired]));
  check('自动失效不写最近动态', store.readBoard(w2).board.activity.length === actBefore, { before: actBefore, after: store.readBoard(w2).board.activity.length });
  check('失效后这件事仍由待我处理·已逾期覆盖', rL.attention.some((a) => a.kind === 'overdue' && a.engagementId === eL.id) && !rL.attention.some((a) => a.kind === 'proposal'));

  /* AI 权限的「小事」范围（spec §22.4）：no_next 补下一步；due_soon 只标记知道了；start_session 永不自动。 */
  const w3 = newRoot('v2-safe');
  const eNo = api.engagement(w3, { action: 'create', patch: { name: '没定客户', company: '没定客户有限公司', nextAction: { text: '', due: '' } } }).engagement;
  const eDue = api.engagement(w3, { action: 'create', patch: { name: '快到客户', company: '快到客户有限公司', nextAction: { text: '发方案', due: dateDaysFromNow(1) } } }).engagement;
  const itMeet = api.item(w3, { action: 'create', patch: { title: '见李总', type: 'meeting', stage: 'todo', due: dateDaysFromNow(1), engagementId: eDue.id } }).item;
  api.board(w3);
  const obs = api.applySafeProposals(w3);
  check('observe 档：不直接处理任何提醒', obs.ok && obs.mode === 'observe' && obs.applied.length === 0 && obs.skipped.length === 3, obs);
  for (const mode of ['assisted']) api.settings(w3, { patch: { autonomy: mode } });
  const as = api.applySafeProposals(w3);
  const b3 = store.readBoard(w3).board;
  const st = (ruleId) => b3.proposals.find((p) => p.ruleId === ruleId).status;
  check('assisted 档：补下一步 + 标记快到期为知道了；会面快到了留给人',
    as.ok && as.applied.length === 2 && st('no_next') === 'accepted' && st('due_soon') === 'accepted' && st('meeting_soon') === 'pending'
      && b3.engagements.find((x) => x.id === eNo.id).nextAction.text === '确认没定客户的下一步'
      && !b3.items.find((x) => x.id === itMeet.id).sessionId, { applied: as.applied, skipped: as.skipped });
  const acts = b3.activity.map((a) => a.text);
  check('直接处理写的最近动态是人话（不出现 assisted / auto 字样）',
    acts.includes('AI 已直接处理：没定客户还没定下一步') && acts.includes('AI 已标记为知道了：快到客户的下一步明天到期：发方案') && !acts.some((t) => /assisted|auto|observe|安全建议/.test(t)), acts);
  /* auto 与 assisted 行为相同。 */
  const w4 = newRoot('v2-auto');
  api.engagement(w4, { action: 'create', patch: { name: '自动客户', company: '自动客户有限公司', nextAction: { text: '', due: '' } } });
  api.board(w4);
  api.settings(w4, { patch: { autonomy: 'auto' } });
  const au = api.applySafeProposals(w4);
  check('auto 档与 assisted 行为相同（保存时不改写已有的 auto）', au.ok && au.mode === 'auto' && au.applied.length === 1 && store.readBoard(w4).board.settings.autonomy === 'auto', au);
}

section('v2.0 §22.2 提醒：条件消失自动失效 / 标题随天数更新 / 先失效再生成 / 无变化不写盘');
{
  /* ---- 条件消失 → 自动失效，不写 activity / timeline ---- */
  const w = newRoot('v2-expire');
  const mk = (name) => api.engagement(w, { action: 'create', patch: { name, company: name + '有限公司', nextAction: { text: '', due: '' } } }).engagement;
  const eFix = mk('补了下一步的客户');
  const ePause = mk('暂停的客户');
  const eArch = mk('归档的客户');
  const itTerm = api.item(w, { action: 'create', patch: { title: '归档客户名下的任务', stage: 'todo', due: dateDaysFromNow(1), engagementId: eArch.id } }).item;
  const g1 = api.board(w);
  const pOf = (b, eid) => b.proposals.find((p) => p.ruleId === 'no_next' && p.engagementId === eid);
  const first = [eFix, ePause, eArch].map((e) => Object.assign({}, pOf(g1.board, e.id)));
  const pItem1 = g1.board.proposals.find((p) => p.ruleId === 'due_soon' && p.itemId === itTerm.id);
  check('（预置）三家客户各有一条「没定下一步」提醒 + 一条任务快到期提醒', first.every((p) => p.status === 'pending') && !!pItem1 && g1.proposalsAdded === 4, g1.board.proposals.map((p) => p.ruleId));
  api.engagement(w, { action: 'update', id: eFix.id, patch: { nextAction: { text: '约王总见面', due: dateDaysFromNow(10) } } });
  api.engagement(w, { action: 'update', id: ePause.id, patch: { paused: true } });
  api.engagement(w, { action: 'archive', id: eArch.id, patch: { reason: '客户取消了' } });
  const snap = store.readBoard(w).board;
  const tlSum = (b) => b.engagements.reduce((n, e) => n + (e.timeline || []).length, 0) + b.items.reduce((n, it) => n + (it.history || []).length, 0);
  const g2 = api.board(w);
  const after = [eFix, ePause, eArch].map((e) => pOf(g2.board, e.id));
  check('条件消失（补了下一步 / 已暂停 / 已归档）→ 自动失效：dismissed + expired:true + decidedAt',
    after.every((p) => p.status === 'dismissed' && p.expired === true && !!p.decidedAt), after.map((p) => [p.status, p.expired, p.decidedAt]));
  const pItem2 = g2.board.proposals.find((p) => p.id === pItem1.id);
  check('已归档客户名下任务的提醒同样失效', pItem2.status === 'dismissed' && pItem2.expired === true && g2.proposalsExpired === 4, { status: pItem2.status, expired: g2.proposalsExpired });
  check('自动失效不改 id / createdAt / 标题', after.every((p, i) => p.id === first[i].id && p.createdAt === first[i].createdAt && p.title === first[i].title));
  const disk = store.readBoard(w).board;
  check('自动失效不写 activity / timeline / history', disk.activity.length === snap.activity.length && tlSum(disk) === tlSum(snap), { act: [snap.activity.length, disk.activity.length], tl: [tlSum(snap), tlSum(disk)] });
  check('失效已落盘（只读请求有失效时也会写盘）', disk.proposals.filter((p) => p.expired === true).length === 4 && disk.revision === snap.revision + 1, { rev: [snap.revision, disk.revision] });
  check('失效的提醒不再出现在待我处理里', !g2.attention.some((a) => a.kind === 'proposal'));
  /* 24 小时去重窗口：条件立刻又成立，也不马上重新生成；过了窗口才生成。 */
  api.engagement(w, { action: 'update', id: eFix.id, patch: { nextAction: { text: '', due: '' } } });
  const g3 = api.board(w);
  check('自动失效的提醒同样计入 24 小时去重窗口', g3.board.proposals.filter((p) => p.ruleId === 'no_next' && p.engagementId === eFix.id).length === 1 && g3.proposalsAdded === 0, g3.proposalsAdded);
  {
    const b = store.readBoard(w).board;
    const r = rules.refreshProposals(w, b, { now: Date.now() + 25 * 3600 * 1000 });
    check('过了去重窗口，条件仍在则重新生成', r.added.length === 1 && r.added[0].ruleId === 'no_next' && r.added[0].engagementId === eFix.id && r.added[0].status === 'pending', r.added.map((p) => p.ruleId));
  }

  /* ---- 条件仍在：标题随天数更新（原地改，不改 id / createdAt） ---- */
  const wT = newRoot('v2-retitle');
  const eD = api.engagement(wT, { action: 'create', patch: { name: '到期客户', company: '到期客户有限公司', nextAction: { text: '确认方案范围', due: dateDaysFromNow(2) } } }).engagement;
  const itD = api.item(wT, { action: 'create', patch: { title: '写周报', stage: 'todo', due: dateDaysFromNow(2) } }).item;
  const d1 = api.board(wT);
  const pe = Object.assign({}, d1.board.proposals.find((p) => p.ruleId === 'due_soon' && p.engagementId === eD.id && !p.itemId));
  const pi2 = Object.assign({}, d1.board.proposals.find((p) => p.ruleId === 'due_soon' && p.itemId === itD.id));
  check('快到期提醒的标题（客户 / 任务），详情为空串',
    pe.title === '到期客户的下一步 2 天后到期：确认方案范围' && pe.detail === '' && pi2.title === '任务「写周报」2 天后到期' && pi2.detail === '', { e: pe.title, i: pi2.title });
  {
    const b = store.readBoard(wT).board;
    const cur = (id) => b.proposals.find((p) => p.id === id);
    const r = rules.refreshProposals(wT, b, { now: noonPlus(1) });
    check('过一天：标题原地更新为「明天到期」（不新建、不失效、不改 id / createdAt）',
      r.updated === 2 && r.added.length === 0 && r.expired === 0 && cur(pe.id).title === '到期客户的下一步明天到期：确认方案范围' && cur(pi2.id).title === '任务「写周报」明天到期'
        && cur(pe.id).createdAt === pe.createdAt && cur(pe.id).status === 'pending', { r: [r.added.length, r.expired, r.updated], t: cur(pe.id).title });
    const r2 = rules.refreshProposals(wT, b, { now: noonPlus(2) });
    check('再过一天：「今天到期」', r2.updated === 2 && cur(pe.id).title === '到期客户的下一步今天到期：确认方案范围' && cur(pi2.id).title === '任务「写周报」今天到期', cur(pe.id).title);
    const r2b = rules.refreshProposals(wT, b, { now: noonPlus(2) });
    check('同一天再刷新：没有任何变化', r2b.added.length === 0 && r2b.expired === 0 && r2b.updated === 0, r2b);
    const r3 = rules.refreshProposals(wT, b, { now: noonPlus(3) });
    check('过了到期日：快到期提醒自动失效，且不生成 overdue 提醒',
      r3.expired === 2 && r3.added.length === 0 && cur(pe.id).status === 'dismissed' && cur(pe.id).expired === true && !b.proposals.some((p) => p.ruleId === 'overdue'), r3);
    const att = rules.derivedAttention(wT, b, { now: noonPlus(3) });
    check('逾期后改由待我处理覆盖', att.some((a) => a.kind === 'overdue' && a.engagementId === eD.id && a.text === '到期客户的下一步已逾期 1 天：确认方案范围')
      && att.some((a) => a.kind === 'overdue' && a.itemId === itD.id && a.text === '任务「写周报」已逾期 1 天'), att.map((a) => a.text));
  }
  /* 经 API：改了到期日 → 标题更新也算「有变化」，要落盘。 */
  api.engagement(wT, { action: 'update', id: eD.id, patch: { nextAction: { text: '确认方案范围', due: dateDaysFromNow(1) } } });
  const revBefore = store.readBoard(wT).board.revision;
  const d2 = api.board(wT);
  const diskT = store.readBoard(wT).board;
  check('标题更新会落盘（只有 updated 也写盘）', d2.proposalsUpdated === 1 && d2.proposalsAdded === 0 && d2.proposalsExpired === 0
    && diskT.proposals.find((p) => p.id === pe.id).title === '到期客户的下一步明天到期：确认方案范围' && diskT.revision === revBefore + 1, { updated: d2.proposalsUpdated, rev: [revBefore, diskT.revision] });

  /* ---- 无变化时不写盘（只读请求不应每次都写文件） ---- */
  const fileBefore = readFileSync(store.boardPath(wT), 'utf8');
  const backupsBefore = store.listBackups(wT).length;
  const n1 = api.board(wT);
  const n2 = api.brief(wT);
  const n3 = api.attention(wT, { action: 'list' });
  const n4 = api.sync(wT);
  check('没有变化时读取不写盘（board / brief / attention list / sync，文件逐字节不变、不产生新备份）',
    n1.ok && n1.proposalsAdded === 0 && n1.proposalsExpired === 0 && n1.proposalsUpdated === 0 && n2.ok && n3.ok && n4.ok
      && n4.refreshed.proposalsAdded === 0 && n4.refreshed.proposalsExpired === 0 && n4.refreshed.proposalsUpdated === 0
      && readFileSync(store.boardPath(wT), 'utf8') === fileBefore && store.listBackups(wT).length === backupsBefore);

  /* ---- 先失效、再生成：过期的先腾出名额，新条件在同一次刷新里就能出现 ---- */
  const wO = newRoot('v2-order');
  const engs = [];
  for (let i = 0; i < 9; i += 1) engs.push(api.engagement(wO, { action: 'create', patch: { name: '名额客户' + i, company: '名额客户' + i + '有限公司', nextAction: { text: '', due: '' } } }).engagement);
  const c1 = api.board(wO);
  check('（预置）待处理上限 8 条：第 9 家客户暂时没有提醒', pendingOf(c1.board).length === schema.MAX_PENDING_PROPOSALS && !c1.board.proposals.some((p) => p.engagementId === engs[8].id), pendingOf(c1.board).length);
  for (const e of engs.slice(0, 3)) api.engagement(wO, { action: 'update', id: e.id, patch: { nextAction: { text: '已约时间', due: dateDaysFromNow(10) } } });
  const c2 = api.board(wO);
  check('同一次刷新：3 条失效腾出名额，第 9 家客户的提醒随即生成',
    c2.proposalsExpired === 3 && c2.proposalsAdded === 1 && c2.board.proposals.some((p) => p.engagementId === engs[8].id && p.status === 'pending') && pendingOf(c2.board).length === 6,
    { expired: c2.proposalsExpired, added: c2.proposalsAdded, pending: pendingOf(c2.board).length });
  const c3 = api.board(wO);
  check('本次刚成立的条件不会被误判为失效（紧接着再刷新，没有任何变化）',
    c3.proposalsExpired === 0 && c3.proposalsAdded === 0 && c3.proposalsUpdated === 0 && pendingOf(c3.board).length === 6
      && c3.board.proposals.find((p) => p.engagementId === engs[8].id).status === 'pending');
}

section('v2.0 §22.2 提醒：过期记录清理 / 问候语 / 交给 AI 自动建的任务');
{
  /* ---- 已处理或已失效超过保留期的提醒不再留在看板数据里（只在已有其它变更时顺带清理） ---- */
  const wP = newRoot('v2-prune');
  const eP = api.engagement(wP, { action: 'create', patch: { name: '清理客户', company: '清理客户有限公司', nextAction: { text: '', due: '' } } }).engagement;
  api.board(wP);
  const bP = store.readBoard(wP).board;
  const dayMs = 86400000;
  const old = (days, status, extra) => Object.assign({
    id: 'prp_old' + days + status, ruleId: 'no_next', engagementId: 'eng_gone', itemId: '', kind: 'update_next',
    title: '旧提醒', detail: '', payload: {}, status,
    createdAt: new Date(Date.now() - days * dayMs).toISOString(), decidedAt: new Date(Date.now() - days * dayMs).toISOString(),
  }, extra || {});
  bP.proposals.push(old(200, 'dismissed'), old(120, 'accepted'), old(10, 'dismissed'), old(300, 'pending', { engagementId: eP.id, id: 'prp_oldpending' }));
  const quiet = rules.refreshProposals(wP, JSON.parse(JSON.stringify(Object.assign({}, bP, { proposals: bP.proposals.filter((p) => p.id !== 'prp_oldpending') }))));
  check('没有其它变更时不清理（不因清理单独写盘）', quiet.added.length === 0 && quiet.expired === 0 && quiet.updated === 0 && quiet.pruned === 0, quiet);
  const rP = rules.refreshProposals(wP, bP);
  const ids = bP.proposals.map((p) => p.id);
  check('有其它变更时顺带清理：超过保留期的已处理 / 已失效提醒被移除，近期的保留',
    rP.pruned === 2 && !ids.includes('prp_old200dismissed') && !ids.includes('prp_old120accepted') && ids.includes('prp_old10dismissed'),
    { pruned: rP.pruned, ids });
  check('待处理的提醒不会被清理（哪怕创建很久）', bP.proposals.filter((p) => p.status === 'pending').length >= 1 && typeof rP.expired === 'number');

  /* ---- 客户全部暂停时，问候语不应说「还没有客户」 ---- */
  const wG = newRoot('v2-greet');
  const eG = api.engagement(wG, { action: 'create', patch: { name: '暂停客户', company: '暂停客户有限公司', nextAction: { text: '下季度再联系', due: dateDaysFromNow(60) } } }).engagement;
  api.engagement(wG, { action: 'update', id: eG.id, patch: { paused: true } });
  const brG = api.brief(wG).brief;
  check('客户都暂停时问候语不说「还没有客户」', !/还没有客户/.test(brG.greeting), brG.greeting);
  const brEmpty = api.brief(newRoot('v2-greet-empty')).brief;
  check('确实没有客户时才说「还没有客户」', /还没有客户/.test(brEmpty.greeting), brEmpty.greeting);

  /* ---- 交给 AI 自动建的任务：标题说人话；v1 标题的在办任务照样复用 ---- */
  const wH = newRoot('v2-handoff-title');
  const eH = api.engagement(wH, { action: 'create', patch: { name: '交接客户', company: '交接客户有限公司', nextAction: { text: '补材料', due: dateDaysFromNow(5) } } }).engagement;
  const mockH = { handoff: async () => ({ ok: true, sessionId: 'session-test-1' }) };
  const h1 = await api.handoff(wH, { target: 'engagement', id: eH.id }, mockH);
  check('交给 AI 自动建的任务标题：准备进入「要进入的阶段」：客户名',
    h1.ok && h1.item && h1.item.title === '准备进入「' + schema.stageLabel(schema.nextStage(eH.stage)) + '」：交接客户' && !/执行任务/.test(h1.item.title), h1.item && h1.item.title);
  const h2 = await api.handoff(wH, { target: 'engagement', id: eH.id }, mockH);
  check('再次交给 AI：复用同一个在办任务', h2.ok && h2.reusedItem === true && h2.itemId === h1.itemId, { reused: h2.reusedItem });
  const wL = newRoot('v2-handoff-legacy');
  const eL = api.engagement(wL, { action: 'create', patch: { name: '旧标题客户', company: '旧标题客户有限公司', nextAction: { text: '补材料', due: dateDaysFromNow(5) } } }).engagement;
  const bL = store.readBoard(wL).board;
  bL.items.push({
    id: 'itm_a1b2c3', engagementId: eL.id, title: '执行任务：' + schema.stageLabel(eL.stage) + ' · 旧标题客户', type: 'followup', stage: 'doing',
    priority: 'normal', due: '', owner: 'agent', source: { kind: 'agent', ref: 'handoff', at: new Date().toISOString() },
    autonomy: { mode: 'observe', rule: 'handoff' }, attention: null, reports: [], sessionId: '', createdAt: new Date().toISOString(), history: [],
  });
  const wrL = store.writeBoard(wL, bL);
  check('（预置）写入 v1 标题的在办任务', !!(wrL && wrL.ok !== false), wrL);
  const h3 = await api.handoff(wL, { target: 'engagement', id: eL.id }, mockH);
  check('v1 标题的在办任务照样复用，不重复建', h3.ok && h3.reusedItem === true && h3.itemId === 'itm_a1b2c3', { reused: h3.reusedItem, itemId: h3.itemId });
}

section('v2.0 D16 交给 AI：做法跟着要补的材料走（spec §22.9）');
{
  const mockS = { handoff: async () => ({ ok: true, sessionId: 'session-test-d16' }) };
  const mk = (root, name, extra) => api.engagement(root, { action: 'create', patch: Object.assign({ name, company: name + '有限公司', source: { kind: 'manual', ref: '老客户介绍' }, nextAction: { text: '补材料', due: dateDaysFromNow(5) } }, extra || {}) }).engagement;

  /* 线索列的客户：差的是「研判」的材料，AI 拿到的应该是研判的做法 */
  const w1 = newRoot('v2-d16-lead');
  const e1 = mk(w1, '做法客户');
  const r1 = await api.handoff(w1, { target: 'engagement', id: e1.id }, mockS);
  const p1 = String(r1.prompt || '');
  check('线索列交给 AI：用研判的技能与产物', r1.ok && p1.includes('`fde-discovery`') && p1.includes('事实核查清单') && !p1.includes('`fde-engagement`'), p1.slice(0, 200));
  check('线索列交给 AI：说明是为进入「研判」准备材料，并写明当前阶段', p1.includes('准备进入「研判」阶段需要的材料') && p1.includes('当前阶段：线索'), p1.slice(0, 200));
  check('线索列交给 AI：推进条件与做法是同一个阶段', /推进条件：进入「研判」的条件/.test(p1), (p1.match(/推进条件：[^\n]*/) || [''])[0]);
  check('线索列交给 AI：任务类型是「调研」', r1.item && r1.item.type === 'research', r1.item && r1.item.type);

  /* 最后一个阶段：没有下一阶段，用当前阶段的做法，标题不变 */
  const w2 = newRoot('v2-d16-last');
  const e2 = mk(w2, '采用客户');
  const b2 = store.readBoard(w2).board;
  b2.engagements.find((x) => x.id === e2.id).stage = 'adoption';
  store.writeBoard(w2, b2);
  const r2 = await api.handoff(w2, { target: 'engagement', id: e2.id }, mockS);
  check('最后一个阶段交给 AI：用当前阶段的做法，标题是「推进「采用」」', r2.ok && String(r2.prompt).includes('`fde-adoption`') && r2.item.title === '推进「采用」：采用客户', r2.item && r2.item.title);

  /* 指定准备会面：用会面的做法 */
  const w3 = newRoot('v2-d16-meeting');
  const e3 = mk(w3, '会面客户');
  const r3 = await api.handoff(w3, { target: 'engagement', id: e3.id, intent: 'meeting' }, mockS);
  check('指定准备会面：用会面的技能', r3.ok && String(r3.prompt).includes('`fde-meeting`'), String(r3.prompt).slice(0, 160));

  /* 导入的客户：当前阶段没有通过记录、材料又不全时，提示词多一行，不让 AI 自行补做 */
  const w4 = newRoot('v2-d16-door');
  const e4 = mk(w4, '导入客户');
  const b4 = store.readBoard(w4).board;
  const x4 = b4.engagements.find((x) => x.id === e4.id);
  x4.stage = 'solution'; x4.adopted = true; x4.gateState = {};
  store.writeBoard(w4, b4);
  const r4 = await api.handoff(w4, { target: 'engagement', id: e4.id }, mockS);
  const p4 = String(r4.prompt || '');
  check('当前阶段缺材料：提示词说明「方案」阶段自己还缺什么', r4.ok && /「方案」阶段自己的材料还缺：/.test(p4) && /不要自行补做/.test(p4), (p4.match(/- 注意：[^\n]*/) || ['（没有这一行）'])[0]);
  check('当前阶段缺材料：做法仍是要进入的阶段（试点）', p4.includes('`fde-pilot`'), p4.slice(0, 160));
  /* 当前阶段已有通过记录：不多这一行 */
  const b4b = store.readBoard(w4).board;
  b4b.engagements.find((x) => x.id === e4.id).gateState = { solution: { status: 'forced', forced: true, checks: {}, reason: '测试', at: new Date().toISOString() } };
  store.writeBoard(w4, b4b);
  const r4b = await api.handoff(w4, { target: 'engagement', id: e4.id }, mockS);
  check('当前阶段已有通过记录：不提示缺材料', r4b.ok && !/阶段自己的材料还缺/.test(String(r4b.prompt)), (String(r4b.prompt).match(/- 注意：[^\n]*/) || ['（没有这一行）'])[0]);
  check('评估当前阶段的材料不写盘（只多一次任务写入）', store.readBoard(w4).board.engagements.find((x) => x.id === e4.id).gateState.solution.status === 'forced');

  /* 任务的交接：按任务类型选技能 */
  const pItem = prompts.buildPrompt('item', { root: w1, item: { id: 'itm_aa11bb', title: '核对主体', type: 'research', stage: 'todo' }, engagement: Object.assign({}, e1, { stage: 'solution' }), intent: 'stage' });
  check('任务交接：类型是「调研」时用研判的技能', pItem.includes('`fde-discovery`') && !pItem.includes('`fde-solution`'), pItem.slice(0, 160));
  const pItem2 = prompts.buildPrompt('item', { root: w1, item: { id: 'itm_aa11bc', title: '回电话', type: 'followup', stage: 'todo' }, engagement: Object.assign({}, e1, { stage: 'meeting' }), intent: 'stage', workStage: 'scoping' });
  check('任务交接：类型不是阶段时按客户要进入的阶段', pItem2.includes('`fde-scoping`'), pItem2.slice(0, 160));

  /* 按提醒处理：人已经写了下一步，就不拿占位文字去盖 */
  const w5 = newRoot('v2-d16-next');
  const e5 = api.engagement(w5, { action: 'create', patch: { name: '下一步客户', company: '下一步客户有限公司' } }).engagement;
  const br5 = api.brief(w5);
  const pr5 = (store.readBoard(w5).board.proposals || []).find((x) => x.engagementId === e5.id && x.kind === 'update_next' && x.status === 'pending');
  check('（预置）没定下一步的客户有一条待处理提醒', !!pr5, { brief: !!br5, n: (store.readBoard(w5).board.proposals || []).length });
  if (pr5) {
    const b5 = store.readBoard(w5).board;
    b5.engagements.find((x) => x.id === e5.id).nextAction = { text: '周三前约到信息部访谈', due: '', owner: '' };
    store.writeBoard(w5, b5);
    /* 不经过读取刷新，直接按提醒处理（模拟提醒还没来得及失效的窗口） */
    const b5b = store.readBoard(w5).board;
    const out5 = api.__test && api.__test.executeProposal ? api.__test.executeProposal(b5b, b5b.proposals.find((x) => x.id === pr5.id), new Date().toISOString(), 'human') : null;
    if (out5) {
      check('按提醒处理不覆盖人已写的下一步', b5b.engagements.find((x) => x.id === e5.id).nextAction.text === '周三前约到信息部访谈', b5b.engagements.find((x) => x.id === e5.id).nextAction);
    } else {
      const acc = api.proposal(w5, { id: pr5.id, action: 'accept' });
      const after = store.readBoard(w5).board.engagements.find((x) => x.id === e5.id).nextAction;
      check('按提醒处理不覆盖人已写的下一步', after.text === '周三前约到信息部访谈', { accept: acc && (acc.ok === false ? acc.reason : 'ok'), after });
    }
  }
}

section('v2.0 新建任务：负责人留空不报错（面板「新建任务」对话框的提交形状）');
{
  const wN = newRoot('v2-create-item');
  const blank = api.item(wN, { action: 'create', patch: { title: '整理会后跟进清单', type: 'research', priority: 'normal', owner: '', due: '', engagementId: '', stage: 'todo' } });
  check('负责人留空：创建成功，默认由我负责', blank.ok === true && blank.item && blank.item.owner === 'human', { ok: blank.ok, reason: blank.reason, owner: blank.item && blank.item.owner });
  const ai = api.item(wN, { action: 'create', patch: { title: '让 AI 先查资料', type: 'research', priority: 'normal', owner: 'agent', due: '', engagementId: '', stage: 'todo' } });
  check('负责人选 AI：创建成功', ai.ok === true && ai.item.owner === 'agent', { ok: ai.ok, reason: ai.reason });
  const bad = api.item(wN, { action: 'create', patch: { title: '填了人名', owner: '张三' } });
  check('负责人不是三个选项之一：拒绝，原因说明可选项', bad.ok === false && /我（human）/.test(String(bad.reason)), bad.reason);
}

section('v2.0 §22.2 提醒：新招采公告只按时间失效');
{
  const wB = newRoot('v2-bid');
  const svc = makeFakeBidIntel([
    bidRecord({ id: 'v2sig:1', kind: '招标公告', title: '试验台采购', buyer: '某采购单位甲', date: dateDaysFromNow(-2) }),
    bidRecord({ id: 'v2sig:2', kind: '采购公告', title: '传感器采购', buyer: '某采购单位甲', date: dateDaysFromNow(-4) }),
    bidRecord({ id: 'v2sig:3', kind: '询价公告', title: '配套件询价', buyer: '某采购单位甲', date: dateDaysFromNow(-6) }),
  ]);
  const eB = api.engagement(wB, { action: 'create', patch: { name: '招采客户', company: '某采购单位甲', nextAction: { text: '跟进', due: dateDaysFromNow(9) } } }).engagement;
  const s1 = api.board(wB, { bidIntel: svc });
  const sig = s1.board.proposals.filter((p) => p.ruleId === 'bid_signal').map((p) => Object.assign({}, p));
  check('（预置）生成 3 条新招采公告提醒', sig.length === 3 && sig.every((p) => p.status === 'pending' && p.kind === 'create_item'), sig.map((p) => p.payload.bidId));
  check('新招采公告提醒的标题与详情',
    sig.every((p) => p.title === `某采购单位甲发布了新公告：《${p.payload.title}》（${p.payload.date}）` && p.detail === '可以建一个跟进任务，确认是否和这家客户有关。候选人不等于中标人。'), sig.map((p) => p.title));
  const stillPending = (r) => r.board.proposals.filter((p) => p.ruleId === 'bid_signal' && p.status === 'pending').length;
  const s2 = api.board(wB, { bidIntel: null });
  check('招采雷达不可用：已有提醒不失效', stillPending(s2) === 3 && s2.proposalsExpired === 0, { pending: stillPending(s2), expired: s2.proposalsExpired });
  api.settings(wB, { patch: { sources: { bidWatch: false } } });
  const s3 = api.board(wB, { bidIntel: svc });
  check('关闭招采关注：已有提醒不失效', stillPending(s3) === 3 && s3.proposalsExpired === 0, { pending: stillPending(s3), expired: s3.proposalsExpired });
  api.settings(wB, { patch: { sources: { bidWatch: true } } });
  {
    const b = store.readBoard(wB).board;
    const ps = sig.map((x) => b.proposals.find((p) => p.id === x.id));
    ps[0].createdAt = isoDaysFromNow(-61); /* 超过 30 × 2 天 */
    ps[1].createdAt = isoDaysFromNow(-59); /* 没超过 */
    ps[2].title = '发现招采信号：某采购单位甲 发布《配套件询价》（旧文案）';
    ps[2].detail = '建议：建跟进任务，确认公告是否与客户经营相关（候选人≠中标人；批次为推断）';
    const wr = store.writeBoard(wB, b);
    check('（预置）改写提醒的创建时间与旧文案', wr.ok, wr.reason);
  }
  const s4 = api.board(wB, { bidIntel: null }); /* 服务不可用时，时间到了照样失效 */
  const byId = (r, id) => r.board.proposals.find((p) => p.id === id);
  check('超过 bidSignalDays × 2 天未处理 → 自动失效（服务不可用也按时间）', byId(s4, sig[0].id).status === 'dismissed' && byId(s4, sig[0].id).expired === true, byId(s4, sig[0].id));
  check('没超期的不失效', byId(s4, sig[1].id).status === 'pending' && byId(s4, sig[2].id).status === 'pending');
  check('存量旧文案的招采提醒：标题与详情按新说法原地更新',
    byId(s4, sig[2].id).title === sig[2].title && byId(s4, sig[2].id).detail === sig[2].detail && byId(s4, sig[2].id).id === sig[2].id && s4.proposalsUpdated === 1, byId(s4, sig[2].id).title);
  const s5 = api.board(wB, { bidIntel: svc });
  check('失效后不会立刻为同一条公告重新生成', s5.board.proposals.filter((p) => p.ruleId === 'bid_signal' && p.payload.bidId === sig[0].payload.bidId).length === 1, s5.board.proposals.map((p) => p.payload && p.payload.bidId));
  /* bidSignalDays 取设置值：改成 10 天 → 20 天前创建的就超期。 */
  api.settings(wB, { patch: { bidSignalDays: 10 } });
  const s6 = api.board(wB, { bidIntel: null });
  check('失效期限跟随设置里的回看天数（× 2）', byId(s6, sig[1].id).status === 'dismissed' && byId(s6, sig[1].id).expired === true && byId(s6, sig[2].id).status === 'pending', byId(s6, sig[1].id).status);
  /* 客户暂停后，这家客户的提醒（含招采）不再挂着。 */
  api.engagement(wB, { action: 'update', id: eB.id, patch: { paused: true } });
  const s7 = api.board(wB, { bidIntel: svc });
  check('客户已暂停：这家客户的招采提醒失效', byId(s7, sig[2].id).status === 'dismissed' && byId(s7, sig[2].id).expired === true && stillPending(s7) === 0, byId(s7, sig[2].id).status);
}

section('v2.0 §22.3 待我处理的数量不含提醒（stats.todo / 简报文案 / 工具文本）');
{
  const w = newRoot('v2-todo');
  registryWs.push({ id: 'ws-v2-todo', path: w, updatedAt: new Date().toISOString() });
  check('空看板的问候语', api.brief(w).brief.greeting === '还没有客户：新建一个，或导入已有文件夹', api.brief(w).brief.greeting);
  const eA = api.engagement(w, { action: 'create', patch: { name: '逾期的客户', company: '逾期的客户有限公司', nextAction: { text: '跟进', due: dateDaysFromNow(-1) } } }).engagement;
  api.engagement(w, { action: 'create', patch: { name: '没定的客户', company: '没定的客户有限公司', nextAction: { text: '', due: '' } } });
  const r = api.board(w, { view: 'brief' });
  const todo = r.attention.filter((a) => a.kind !== 'proposal').length;
  check('stats.todo 不含提醒；stats.attention 保持原口径（含提醒）',
    todo === 1 && r.stats.todo === 1 && r.stats.attention === r.attention.length && r.stats.attention === 2 && r.attention.some((a) => a.kind === 'proposal'), r.stats);
  check('简报 headline / greeting 只算必须处理的事',
    r.brief.stats.todo === 1 && r.brief.headline === '在跟客户 2 个 · 待我处理 1 件 · 今天到期 0 · 已逾期 1' && r.brief.greeting === '今天有 1 件事等你处理', { headline: r.brief.headline, greeting: r.brief.greeting });
  check('brief.attention / brief.proposals 形状不变（attention 仍含 proposal 种类）',
    r.brief.attention.length === r.attention.length && r.brief.attention.some((a) => a.kind === 'proposal' && !!a.proposalId && a.ruleId === 'no_next')
      && r.brief.proposals.length === 1 && r.brief.proposals[0].ruleId === 'no_next');
  api.engagement(w, { action: 'update', id: eA.id, patch: { nextAction: { text: '跟进', due: dateDaysFromNow(9) } } });
  const b2 = api.brief(w).brief;
  check('只剩提醒时：今天没有等你处理的事', b2.stats.todo === 0 && b2.greeting === '今天没有等你处理的事' && b2.attention.some((a) => a.kind === 'proposal'), b2.greeting);
  const tBoard = captured.tools.find((x) => x.name === 'fde_board');
  const tAttn = captured.tools.find((x) => x.name === 'fde_attention');
  const outBrief = await tBoard.execute({ view: 'brief', root: w });
  const outBoard = await tBoard.execute({ view: 'board', root: w });
  const outList = await tAttn.execute({ action: 'list', root: w });
  const toolBad = /\[proposal\]|\[overdue\]|no_next|id=prp_|注意力|【建议】|待采纳|门禁|泳道|normal/;
  check('工具文本：待我处理与提醒分开计数，分类 / 优先级用中文名',
    outBrief.ok && outBrief.text.includes('【待我处理】0 件') && outBrief.text.includes('【提醒】1 条') && outBrief.text.includes('[没定下一步] 没定的客户还没定下一步')
      && outBoard.ok && outBoard.text.includes('待我处理 0') && outBoard.text.includes('提醒 1') && outBoard.text.includes('优先级 中')
      && outList.ok && outList.text.includes('提醒 1 条') && outList.text.includes('[提醒]')
      && ![outBrief.text, outBoard.text, outList.text].some((t) => toolBad.test(t)), [outBrief.text, outBoard.text, outList.text].join('\n---\n'));
  const promptText = (captured.sections[0] && captured.sections[0].text) || '';
  const lines = promptText.split('\n');
  const at = lines.findIndex((l) => l.startsWith('【对用户说话的用词】'));
  let end = at;
  while (end >= 0 && end < lines.length && lines[end] !== '') end += 1;
  const words = at >= 0 ? lines.slice(at, end) : [];
  check('系统提示词有「对用户说话的用词」一节（≤8 行）', at >= 0 && words.length >= 3 && words.length <= 8, words.length);
  const wordsText = words.join('\n');
  check('用词一节给出对照并列出不要说的词',
    ['engagement → 客户', 'item → 任务', '门禁 → 推进条件', '注意力 → 待我处理', '建议 → 提醒', '泳道 → 状态', '回报 → 进展', '自主性 → AI 权限', '工具名、参数名照旧',
      '不要对用户说 engagement、item、gate、门禁、注意力、泳道、回报、自主性、工件'].every((x) => wordsText.includes(x))
      && wordsText.includes(schema.ITEM_LANES.map((l) => l.label).join(' / ')) && wordsText.includes(schema.ATTENTION_KINDS.map((x) => x.label).join(' / ')), wordsText);
  check('系统提示词里的状态名与红线跟随 schema（不再出现旧状态名）',
    promptText.includes('`ready` → 待验收') && promptText.includes('`blocked` → 等对方') && schema.RED_LINES.every((x) => promptText.includes(x))
      && !/待我审|等外部|修改客户卷定稿文件|通过门禁 ③/.test(promptText));
}

section('v2.0 D11 推进条件的缺项原因与失败原因是人话');
{
  const w = newRoot('v2-gate');
  const e0 = { id: 'eng_0b0001', name: '某客户', company: '', source: {}, nextAction: {}, stakeholders: [], dir: '', gateState: {}, stage: 'lead' };
  const detailOf = (e, gk, key) => rules.evaluateGate(w, e, gk, {}).auto.find((c) => c.key === key).detail;
  check('字段类缺项', detailOf(e0, 'intake', 'company') === '还没写公司全称' && detailOf(e0, 'intake', 'source') === '还没写线索来源' && detailOf(e0, 'intake', 'next_action') === '还没定下一步');
  check('没有关联文件夹：材料类统一说「没法核对」',
    detailOf(e0, 'discovery', 'archive') === '这家客户还没有关联文件夹，没法核对材料' && detailOf(e0, 'discovery', 'factcheck') === '这家客户还没有关联文件夹，没法核对材料'
      && detailOf(e0, 'solution', 'boundary') === '这家客户还没有关联文件夹，没法核对方案内容');
  check('关键人不足', detailOf(e0, 'meeting', 'stakeholders') === '只登记了 0 位关键人，至少需要 1 位', detailOf(e0, 'meeting', 'stakeholders'));
  mkdirSync(join(w, 'research', '空客户-20260101'), { recursive: true });
  const e1 = Object.assign({}, e0, { dir: '空客户-20260101' });
  check('有文件夹但没材料：逐项说缺什么',
    detailOf(e1, 'discovery', 'archive') === '客户文件夹里没有项目档案' && detailOf(e1, 'discovery', 'factcheck') === '还没找到事实核查清单' && detailOf(e1, 'discovery', 'kpi') === '还没找到 KPI 或痛点假设'
      && detailOf(e1, 'meeting', 'brief') === '还没找到会面 Brief' && detailOf(e1, 'scoping', 'scenario') === '还没找到场景评估表' && detailOf(e1, 'solution', 'proposal') === '还没找到方案文档'
      && detailOf(e1, 'solution', 'boundary') === '方案里还没写明不做什么' && detailOf(e1, 'solution', 'cost') === '还没找到成本测算' && detailOf(e1, 'solution', 'quote') === '还没找到报价单或工作说明书'
      && detailOf(e1, 'pilot', 'pilot_md') === '还没找到试点方案' && detailOf(e1, 'delivery', 'delivery_md') === '还没找到交付文档' && detailOf(e1, 'adoption', 'adoption_evidence') === '还没找到使用或价值证据');
  const allDetails = schema.GATE_KEYS.flatMap((gk) => [e0, e1].flatMap((e) => rules.evaluateGate(w, e, gk, {}).auto.filter((c) => !c.ok).map((c) => c.detail)));
  const detailBad = /[|/]|nextAction|source\.kind|\bmd\b|工件|干系人|未知|未填写|正文|目录/;
  check('缺项原因不含字段路径 / 目录规则 / 正则', allDetails.length > 0 && allDetails.every((t) => t && !detailBad.test(t)), allDetails.filter((t) => !t || detailBad.test(t)));

  const cr = api.engagement(w, { action: 'create', patch: { name: '拦截客户', company: '拦截客户有限公司', nextAction: { text: '跟进', due: dateDaysFromNow(5) } } }).engagement;
  const bl = api.engagement(w, { action: 'move', id: cr.id, patch: { stage: 'discovery' } });
  check('推进被拦的原因：说进不了哪个阶段、还差几项', bl.code === 'BLOCKED' && bl.blocked === true && bl.reason.startsWith('还不能进入「研判」：还差 5 项') && !/门禁|gate/.test(bl.reason), bl.reason);
  const jump = api.engagement(w, { action: 'move', id: cr.id, patch: { stage: 'solution' } });
  check('跳阶被拒的原因', jump.code === 'INVALID' && jump.reason.includes('不能跳过阶段') && jump.reason.includes('「研判」') && jump.reason.includes('破例推进') && !/force/.test(jump.reason), jump.reason);
  const gf = api.gate(w, { engagementId: cr.id, stage: 'discovery', force: true });
  check('破例推进没写原因', gf.ok === false && gf.reason === '破例推进需要写明原因', gf.reason);
  const nf = api.engagement(w, { action: 'update', id: 'eng_ffffff', patch: { name: 'x' } });
  check('客户不存在的原因不带对象编号', nf.code === 'NOT_FOUND' && nf.reason === '找不到这家客户，请刷新后再试', nf.reason);
  const nfi = api.item(w, { action: 'update', id: 'itm_ffffff', patch: { title: 'x' } });
  check('任务不存在的原因不带对象编号', nfi.code === 'NOT_FOUND' && nfi.reason === '找不到这个任务，请刷新后再试', nfi.reason);
  const dupDir = api.engagement(w, { action: 'create', patch: { name: '占用文件夹的客户', dir: '空客户-20260101' } });
  const dup2 = api.engagement(w, { action: 'create', patch: { name: '重复的客户', dir: '空客户-20260101' } });
  check('文件夹已被别的客户关联', dupDir.ok === true && dup2.ok === false && dup2.reason === '这个文件夹已经关联了别的客户：空客户-20260101', dup2.reason);
  const it = api.item(w, { action: 'create', patch: { title: '没写结果的任务', stage: 'doing' } }).item;
  const dn = api.item(w, { action: 'move', id: it.id, patch: { stage: 'done' } });
  check('移入已完成缺结果说明', dn.blocked === true && dn.reason.includes('移入「已完成」前，请先写一句结果说明') && dn.missing[0].label === '结果说明' && !/回报|force|证据文本/.test(dn.reason), dn.reason);
  const ar = api.engagement(w, { action: 'archive', id: cr.id });
  const mvTerm = api.engagement(w, { action: 'move', id: cr.id, patch: { stage: 'discovery' } });
  check('终止状态不能再调整阶段', ar.ok === true && mvTerm.code === 'CONFLICT' && mvTerm.reason === '这家客户已归档或已流失，不能再调整阶段', mvTerm.reason);
  const np = await api.proposal(w, { id: 'prp_ffffff', action: 'dismiss' });
  check('提醒不存在的原因', np.code === 'NOT_FOUND' && np.reason === '找不到这条提醒，可能已经处理过了；请刷新后再试', np.reason);
}

section('v2.0 §22.6 新写入的记录文本：不含内部标识');
{
  const w = newRoot('v2-records');
  const proj = join(w, 'research', '记录客户-20260101');
  mkdirSync(join(proj, 'research'), { recursive: true });
  writeFileSync(join(proj, '00-项目档案.md'), '# 项目档案：记录客户\n');
  writeFileSync(join(proj, 'research', '事实核查清单.md'), 'A 级');
  writeFileSync(join(proj, 'research', 'KPI与痛点假设.md'), '假设');
  const legacyDir = join(w, 'research', '旧项目-20250101');
  mkdirSync(join(legacyDir, 'meeting'), { recursive: true });
  writeFileSync(join(legacyDir, '00-项目档案.md'), '# 项目档案：旧项目\n');
  writeFileSync(join(legacyDir, 'meeting', '面谈Brief.md'), 'Brief');
  const svc = makeFakeBidIntel([bidRecord({ id: 'rec:1', kind: '招标公告', title: '设备采购公告', buyer: '记录客户有限公司', date: dateDaysFromNow(-2) })]);
  const mockHandoff = { handoff: async () => ({ ok: true, sessionId: 'sess-rec-1' }) };

  const e = api.engagement(w, { action: 'create', patch: { name: '记录客户', company: '记录客户有限公司', dir: '记录客户-20260101', nextAction: { text: '', due: '' }, source: { kind: 'manual' } } }).engagement;
  api.board(w, { bidIntel: svc }); /* 生成 no_next + 新招采公告提醒 */
  api.engagement(w, { action: 'update', id: e.id, patch: { priority: 'high', nextAction: { text: '约见面', due: dateDaysFromNow(6) }, stakeholders: [{ name: '王总', role: '副总' }] } });
  api.gate(w, { engagementId: e.id, stage: 'discovery', checks: { subject_locked: { status: 'pass', evidence: '三链验证' }, evidence_graded: { status: 'pass' } } });
  api.gate(w, { engagementId: e.id, stage: 'discovery', checks: { evidence_graded: { status: 'pending' } } });
  api.gate(w, { engagementId: e.id, stage: 'discovery', force: true, reason: '客户催得急，先往下走' });
  api.engagement(w, { action: 'move', id: e.id, patch: { stage: 'discovery' } });
  api.engagement(w, { action: 'move', id: e.id, patch: { stage: 'meeting', force: true, reason: '已口头约好会面' } });
  api.engagement(w, { action: 'move', id: e.id, patch: { stage: 'discovery' } });
  const it = api.item(w, { action: 'create', patch: { title: '补事实核查', stage: 'todo', engagementId: e.id } }).item;
  api.item(w, { action: 'update', id: it.id, patch: { priority: 'high', due: dateDaysFromNow(4) } });
  api.item(w, { action: 'move', id: it.id, patch: { stage: 'doing' } });
  for (const kind of ['progress', 'blocked', 'failed', 'ready']) api.item(w, { action: 'report', id: it.id, kind, text: '这一步的情况说明', by: 'agent' });
  api.item(w, { action: 'move', id: it.id, patch: { stage: 'done', evidence: '清单已交给客户' } });
  const it2 = api.item(w, { action: 'create', patch: { title: '范围外的活', stage: 'doing', engagementId: e.id } }).item;
  api.item(w, { action: 'report', id: it2.id, kind: 'dropped', text: '客户说不要了', by: 'agent' });
  for (const kind of ['decision', 'blocked', 'answer', 'question']) {
    api.attention(w, { action: 'ask', target: 'engagement', id: e.id, kind, question: '这件事怎么办？', by: 'agent' });
    api.attention(w, { action: 'resolve', target: 'engagement', id: e.id, answer: '按原计划' });
  }
  const it3 = api.item(w, { action: 'create', patch: { title: '准备会面材料', type: 'meeting', stage: 'todo', engagementId: e.id } }).item;
  api.attention(w, { action: 'ask', target: 'item', id: it3.id, kind: 'decision', question: '用哪一版方案？' });
  api.attention(w, { action: 'resolve', target: 'item', id: it3.id, answer: '用第二版' });
  await api.handoff(w, { target: 'engagement', id: e.id, intent: 'gate' }, mockHandoff);
  await api.handoff(w, { target: 'item', id: it3.id, intent: 'meeting' }, mockHandoff);
  const pend = () => api.board(w, { bidIntel: svc }).board.proposals.filter((p) => p.status === 'pending');
  const bidP = pend().find((p) => p.ruleId === 'bid_signal');
  if (bidP) await api.proposal(w, { id: bidP.id, action: 'accept' });
  api.engagement(w, { action: 'create', patch: { name: '另一家客户', company: '另一家客户有限公司', nextAction: { text: '', due: '' } } });
  const noNextP = pend().find((p) => p.ruleId === 'no_next');
  if (noNextP) await api.proposal(w, { id: noNextP.id, action: 'dismiss' });
  api.engagement(w, { action: 'create', patch: { name: '第三家客户', company: '第三家客户有限公司', nextAction: { text: '', due: '' } } });
  api.board(w, { bidIntel: svc });
  api.settings(w, { patch: { autonomy: 'assisted', stallDays: 21 } });
  api.applySafeProposals(w);
  api.adopt(w, { action: 'apply', dirs: ['旧项目-20250101'] });
  api.bidLink(w, { engagementId: e.id, bidId: 'rec:1', relation: 'buyer' }, { bidIntel: svc });
  api.bidUnlink(w, { engagementId: e.id, bidId: 'rec:1' }, { bidIntel: svc });
  api.bidPromote(w, { engagementId: e.id, bidId: 'rec:1' }, { bidIntel: svc });
  api.bidsRefresh(w, { engagementId: e.id }, { bidIntel: svc });
  api.harvest(w, { engagementId: e.id, text: '这次的教训是先锁主体。' });
  api.item(w, { action: 'delete', id: it2.id });
  api.engagement(w, { action: 'archive', id: e.id, patch: { reason: '演练结束' } });

  const b = store.readBoard(w).board;
  const texts = [
    ...b.activity.map((a) => a.text),
    ...b.engagements.flatMap((x) => (x.timeline || []).map((t) => t.text)),
    ...b.items.flatMap((x) => (x.history || []).map((t) => t.text)),
  ];
  const forbid = /stall|due_soon|no_next|gate_ready|meeting_soon|review_lag|bid_signal|subject_locked|evidence_graded|intake|sess-|session|rec:1|eng_[0-9a-f]{6}|itm_[0-9a-f]{6}|prp_[0-9a-f]{6}|[（(](ready|blocked|progress|failed|dropped|decision|answer|question|forced|force|stage|gate|meeting|high|normal|low|assisted|auto|observe)[）):：]|泳道|门禁|注意力|回报|干系人|采纳建议|忽略建议|发起会话|force|handoff|nextAction|stakeholders|bidWatch|autonomy|stallDays|priority/i;
  check('（预置）演练写出了足够多的记录', texts.length >= 45, texts.length);
  check('新写入的 timeline / activity / history 不含规则编号、检查项 key、门禁 key、会话编号、对象编号、泳道 key、英文枚举与旧词',
    texts.every((t) => t && !forbid.test(t)), texts.filter((t) => !t || forbid.test(t)));
  const has = (t) => texts.includes(t);
  check('记录文本抽查：客户', has('新建客户') && has('更新了：优先级、下一步、关键人') && has('确认了推进条件：主体已锁定、事实已分级') && has('取消了推进条件的确认：事实已分级')
    && has('破例推进到「研判」：客户催得急，先往下走') && has('记录客户破例推进到「研判」') && has('阶段：研判 → 会面（破例推进：已口头约好会面）') && has('阶段回退：会面 → 研判（人工纠正）'),
    texts.filter((t) => /更新了|推进条件|破例|阶段/.test(t)));
  check('记录文本抽查：任务与进展', has('状态：待开始 → 进行中') && has('更新了：优先级、到期日') && has('更新了进展：这一步的情况说明') && has('卡住了：这一步的情况说明') && has('没做成：这一步的情况说明')
    && has('做完了，等验收：这一步的情况说明') && has('任务「补事实核查」做完了，等验收') && has('结果说明：清单已交给客户') && has('任务「补事实核查」改为「已完成」') && has('任务「范围外的活」不做了'),
    texts.filter((t) => /状态：|进展|卡住|没做成|做完|结果说明|不做了/.test(t)));
  check('记录文本抽查：提问', has('AI 提了一个需要你决定的问题：这件事怎么办？') && has('AI 报告卡住了：这件事怎么办？') && has('AI 提了一个需要你回复的问题：这件事怎么办？') && has('AI 提了一个问题：这件事怎么办？')
    && has('记下一个要决定的问题：用哪一版方案？') && has('已决定：按原计划') && has('卡点已解除：按原计划') && has('已回复：按原计划') && has('记录客户等你决定：这件事怎么办？') && has('任务「准备会面材料」等你决定：用哪一版方案？'),
    texts.filter((t) => /问题|卡住|卡点|已决定|已回复|等你/.test(t)));
  check('记录文本抽查：交给 AI / 提醒 / 导入 / 设置', has('交给 AI 补齐材料') && has('记录客户已交给 AI') && has('交给 AI 准备会面材料') && has('任务「准备会面材料」已交给 AI') && has('交给 AI 时自动创建')
    && has('由提醒创建') && texts.some((t) => t.startsWith('建了跟进任务：跟进招标：设备采购公告')) && texts.some((t) => t.startsWith('已按提醒处理：记录客户有限公司发布了新公告：《设备采购公告》'))
    && has('不再提醒：另一家客户还没定下一步') && has('AI 已直接处理：第三家客户还没定下一步') && has('已按提醒处理：第三家客户还没定下一步')
    && has('从已有文件夹导入，放在「会面」阶段') && has('导入时已过「线索」阶段，推进条件视为满足') && has('导入时已过「研判」阶段，推进条件视为满足')
    && has('修改了设置：AI 权限、没有进展的天数') && has('关联招采公告：设备采购公告') && has('取消关联招采公告：设备采购公告') && has('由招采公告创建') && has('写了复盘草稿：记录客户'),
    texts.filter((t) => /交给 AI|提醒|导入|设置|招采|复盘|由.*创建/.test(t)));
}

/* ============================ DSH 0.2.1 兼容性 ============================ */
section('DSH 0.2.1 兼容性：技能注册带 source');
{
  check('每个注册的技能对象 source 是非空字符串（dsh-skill 加载时校验）',
    captured.skills.length > 0 && captured.skills.every((s) => typeof s.source === 'string' && s.source.length > 0), captured.skills.filter((s) => typeof s.source !== 'string' || !s.source).map((s) => s.name));
  check('运行时注册的技能 source 取 runtime（SkillSource 的既定取值）', captured.skills.every((s) => s.source === 'runtime'), [...new Set(captured.skills.map((s) => s.source))]);
  check('discoverSkills 产出的对象带 source', api.discoverSkills(join(PLUGIN, 'skills')).every((s) => s.source === 'runtime'));
  check('/fde/meta 的 skills 摘要形状不变（name / description / path）', api.meta().meta.skills.every((s) => Object.keys(s).join(',') === 'name,description,path'));
}

section('DSH 0.2.1 兼容性：工具返回值是无损 JSON（统一出口）');
{
  const { isDeepStrictEqual } = await import('node:util');
  const toolOutput = await import(__toUrl(join(PLUGIN, 'src', 'host', 'tool-output.js')));
  const lossless = (v) => isDeepStrictEqual(JSON.parse(JSON.stringify(v)), v);

  /* 出口函数本身 */
  const dirty = { a: 1, b: undefined, c: [1, undefined, NaN, () => 1], d: { e: Infinity, f: -0, g: null, h: undefined }, when: new Date(0), big: 10n, fn() {}, [Symbol('s')]: 1 };
  dirty.self = dirty;
  const clean = toolOutput.toLosslessJson(dirty);
  check('出口：剔除 undefined 键 / 数组里的 undefined 转 null / 非有限数字转 null / -0 转 0 / 环引用断开',
    isDeepStrictEqual(clean, { a: 1, c: [1, null, null, null], d: { e: null, f: 0, g: null }, when: '1970-01-01T00:00:00.000Z', big: '10', self: null }) && Object.is(clean.d.f, 0), clean);
  check('出口：规整后的值与 JSON 往返深度相等；原值不满足（反例）', lossless(clean) && !lossless({ code: undefined, reason: undefined }) && !lossless({ n: NaN }));
  check('出口：不改入参', 'b' in dirty && dirty.c.length === 4 && Number.isNaN(dirty.c[2]) && dirty.self === dirty);
  // eslint-disable-next-line no-sparse-arrays
  check('出口：稀疏数组补 null，顶层 undefined 返回 null', isDeepStrictEqual(toolOutput.toLosslessJson([1, , 3]), [1, null, 3]) && toolOutput.toLosslessJson(undefined) === null);
  const proto = toolOutput.toLosslessJson(JSON.parse('{"__proto__": {"x": 1}, "y": 2}'));
  check('出口：__proto__ 键按数据属性保留，不改原型', Object.getPrototypeOf(proto) === Object.prototype && Object.prototype.hasOwnProperty.call(proto, '__proto__') && proto.y === 2);
  const describe = (e) => ({ ok: false, reason: '操作失败：' + e.message, text: '操作失败：' + e.message, extra: undefined });
  const gSync = toolOutput.guardTool({ name: 't', execute() { throw new Error('同步炸了'); } }, describe);
  const gAsync = toolOutput.guardTool({ name: 't', execute: async () => { throw new Error('异步炸了'); } }, describe);
  const gValue = toolOutput.guardTool({ name: 't', keep: 1, execute: (a) => ({ ok: true, echo: a, code: undefined, n: 1 / 0 }) }, describe);
  const rs = await gSync.execute({});
  const ra = await gAsync.execute({});
  const rv = await gValue.execute({ x: 1 });
  check('出口：execute 同步抛错 / Promise 拒绝都转成 {ok:false, reason}，不向外抛',
    rs.ok === false && rs.reason === '操作失败：同步炸了' && ra.ok === false && ra.reason === '操作失败：异步炸了' && lossless(rs) && lossless(ra), { rs, ra });
  check('出口：正常返回值被规整，工具定义的其它字段原样保留', isDeepStrictEqual(rv, { ok: true, echo: { x: 1 }, n: null }) && gValue.keep === 1 && gValue.name === 't');

  /* 16 个工具各调至少一次（现有测试替身）：返回值必须与 JSON 往返深度相等。 */
  const anyEng = api.board(ws).board.engagements.find((e) => schema.isStage(e.stage));
  const scoresA = { value: 5, pain: 4, data: 3, tech: 3, accept: 3, compliance: 4, roi: 3, readiness: 3, delivery: 3, reuse: 3, alternative: 4, timing: 3 };
  const calls = [
    ['rw_status', { root: ws }],
    ['rw_scaffold', { company: '出口测试公司', root: ws }],
    ['rw_export_pdf', { md: '不存在的文件.md', root: ws }],
    ['rw_qa_pdf', { pdf: '不存在的文件.pdf', root: ws }],
    ['rw_method', {}],
    ['rw_method', { name: '流程' }],
    ['fde_board', { view: 'board', root: ws }],
    ['fde_board', { view: 'brief', root: ws }],
    ['fde_board', { view: 'engagement', root: ws }],
    ['fde_board', { view: 'engagement', id: anyEng.id, root: ws }],
    ['fde_board', { view: 'item', root: ws }],
    ['fde_engagement', { action: 'create', name: '出口测试客户', company: '出口测试客户有限公司', root: ws }],
    ['fde_engagement', { action: 'gate', id: anyEng.id, patch: { stage: 'discovery' }, root: ws }],
    ['fde_engagement', { action: 'move', id: anyEng.id, patch: { stage: 'discovery' }, root: ws }],
    ['fde_item', { action: 'create', title: '出口测试任务', root: ws }],
    ['fde_item', { action: 'report', id: 'itm_000000', kind: 'ready', text: 'x', root: ws }],
    ['fde_attention', { action: 'list', root: ws }],
    ['fde_attention', { action: 'ask', target: 'engagement', id: anyEng.id, kind: 'question', question: '出口测试提问', root: ws }],
    ['fde_brief', { root: ws }],
    ['fde_harvest', { text: '出口测试复盘', root: ws }],
    ['fde_bid', { action: 'search', q: '某科技', mode: 'company', root: ws }],
    ['fde_bid', { action: 'match', engagementId: anyEng.id, root: ws }],
    ['fde_bid', { action: 'nope', root: ws }],
    ['scys_fde', { action: 'feed', root: ws }],
    ['scys_fde', { action: 'nope', root: ws }],
    ['fde_library', { action: 'feed', root: ws }],
    ['fde_library', { action: 'search', q: 'FDE', root: ws }],
    ['fde_scenario', { action: 'template' }],
    ['fde_scenario', { action: 'evaluate', scenarios: [{ name: 'X', gates: { sponsor: true, integration14d: true, prod90d: true, measurable: true }, scores: scoresA }] }],
    ['fde_quote', { action: 'template' }],
    ['fde_quote', { action: 'calculate', labor: [{ name: 'a', personDays: 1, rate: 1000 }] }],
  ];
  const bad = [];
  const called = new Set();
  for (const [toolName, args] of calls) {
    const tool = captured.tools.find((t) => t.name === toolName);
    let out = null;
    try { out = await tool.execute(args); } catch (e) { bad.push(toolName + ' 抛错：' + String(e && e.message)); continue; }
    called.add(toolName);
    if (!out || typeof out !== 'object' || Array.isArray(out)) { bad.push(toolName + ' 返回的不是对象'); continue; }
    if (!lossless(out)) bad.push(toolName + '(' + JSON.stringify(args).slice(0, 60) + ') 含 undefined / 非有限数字');
    if (typeof out.text !== 'string') bad.push(toolName + ' 缺 text（render 需要）');
  }
  check('16 个工具都调到了', called.size === 16 && captured.tools.length === 16, [...called]);
  check('16 个工具的返回值都是无损 JSON（JSON 往返后与原值深度相等）', bad.length === 0, bad);
  const scysOut = await captured.tools.find((t) => t.name === 'scys_fde').execute({ action: 'feed', root: ws });
  check('scys_fde feed 的返回值不再带值为 undefined 的 code / reason 键',
    Object.entries(scysOut).every(([, v]) => v !== undefined) && (!('code' in scysOut) || typeof scysOut.code === 'string'), Object.keys(scysOut));
}

section('DSH 0.2.1 兼容性：工具不抛异常（非法根路径 / 缺参数）');
{
  const badRoot = join(ws, 'research', '不存在的工作区根');
  const cases = [
    ['rw_status 非法根', 'rw_status', { root: badRoot }],
    ['rw_scaffold 非法根', 'rw_scaffold', { company: '某集团有限公司', root: badRoot }],
    ['rw_status 文件系统根', 'rw_status', { root: '/' }],
    ['rw_scaffold 未注册的工作区', 'rw_scaffold', { company: '某集团有限公司', root: tmpdir() }],
  ];
  const wrong = [];
  for (const [label, toolName, args] of cases) {
    const tool = captured.tools.find((t) => t.name === toolName);
    let out = null;
    let threw = '';
    try { out = await tool.execute(args); } catch (e) { threw = String(e && e.message); }
    if (threw || !out || out.ok !== false || typeof out.reason !== 'string' || !out.reason || typeof out.text !== 'string') wrong.push(label + ' → ' + (threw ? '抛错：' + threw : JSON.stringify(out).slice(0, 120)));
  }
  check('rw_status / rw_scaffold 传入非法根路径：返回 {ok:false, reason}，不抛 PathError', wrong.length === 0, wrong);
  const invalid = await captured.tools.find((t) => t.name === 'rw_status').execute({ root: badRoot });
  check('非法根路径的原因是人话，并带 code=INVALID', invalid.code === 'INVALID' && invalid.reason === '路径不合法：工作区根不存在', invalid);
  check('非法根路径没有创建任何目录', !existsSync(badRoot));
  const loose = [];
  for (const [label, toolName, args] of [['rw_method 无参数', 'rw_method', undefined], ['rw_method name 不是字符串', 'rw_method', { name: 123 }], ['rw_status 无参数', 'rw_status', undefined]]) {
    let out = null;
    let threw = '';
    try { out = await captured.tools.find((t) => t.name === toolName).execute(args); } catch (e) { threw = String(e && e.message); }
    if (threw || !out || typeof out.text !== 'string') loose.push(label + ' → ' + (threw || JSON.stringify(out).slice(0, 100)));
  }
  check('rw_method / rw_status 缺参数或参数类型不对也不抛', loose.length === 0, loose);
}

section('方法指针：提示词与阶段指南都指向有对应内容的文件');
{
  const missing = [];
  for (const [stage, g] of Object.entries(prompts.STAGE_GUIDES)) {
    for (const m of g.methods || []) if (!existsSync(join(PLUGIN, m))) missing.push(stage + ' → ' + m);
  }
  check('STAGE_GUIDES.methods 的每个路径都存在', missing.length === 0, missing);
  const pbMissing = [];
  for (const st of schema.ENGAGEMENT_STAGES) {
    for (const t of st.playbook.tools) {
      if (t.kind === 'method' && !['methods', 'reference'].some((d) => existsSync(join(PLUGIN, d, t.name)))) pbMissing.push(st.key + ' → ' + t.name);
      if (t.kind === 'template' && !existsSync(join(PLUGIN, 'templates', t.name))) pbMissing.push(st.key + ' → ' + t.name);
    }
  }
  check('阶段指南里的方法 / 模板名都能找到文件', pbMissing.length === 0, pbMissing);
  const G = prompts.STAGE_GUIDES;
  check('试点：指向成本评估与报价（里程碑付款、转正条件）与场景选择（14 天 / 90 天），不再指向文档模板库',
    G.pilot.methods.includes('methods/07-成本评估与报价.md') && G.pilot.methods.includes('methods/06-场景选择与数据体检.md') && !G.pilot.methods.includes('reference/文档模板库.md'), G.pilot.methods);
  check('交付：指向成本评估与报价（变更、验收与质保）与成本测算与报价单模板，不再指向调研执行流程',
    G.delivery.methods.includes('methods/07-成本评估与报价.md') && G.delivery.methods.includes('templates/成本测算与报价单.md') && !G.delivery.methods.includes('methods/00-调研执行流程.md'), G.delivery.methods);
  check('采用：指向事实核查协议（证据分级与数字自检），不再指向调研执行流程',
    G.adoption.methods.includes('methods/01-事实核查协议.md') && !G.adoption.methods.includes('methods/00-调研执行流程.md'), G.adoption.methods);
  const pbMethods = (k) => schema.ENGAGEMENT_STAGES.find((st) => st.key === k).playbook.tools.filter((t) => t.kind === 'method').map((t) => t.name);
  check('阶段指南同步：试点不再列文档模板库，采用不再列调研执行流程',
    pbMethods('pilot').includes('07-成本评估与报价.md') && pbMethods('pilot').includes('06-场景选择与数据体检.md') && !pbMethods('pilot').includes('文档模板库.md')
      && pbMethods('adoption').includes('01-事实核查协议.md') && !pbMethods('adoption').includes('00-调研执行流程.md'), { pilot: pbMethods('pilot'), adoption: pbMethods('adoption') });
  /* 新指针不是悬空的：目标文件里确有对应内容。 */
  const read = (rel) => readFileSync(join(PLUGIN, rel), 'utf8');
  const m07 = read('methods/07-成本评估与报价.md');
  const m06 = read('methods/06-场景选择与数据体检.md');
  const m01 = read('methods/01-事实核查协议.md');
  const tpl = read('templates/成本测算与报价单.md');
  check('目标文件里确有对应内容', /里程碑付款/.test(m07) && /试点/.test(m07) && /转正式/.test(m07) && /变更单/.test(m07) && /验收与质保/.test(m07)
    && /14 天/.test(m06) && /90 天/.test(m06) && /证据分级/.test(m01) && /数字自检/.test(m01) && /里程碑与付款/.test(tpl) && /变更机制/.test(tpl));
  const pPilot = prompts.buildPrompt('engagement', { root: ws, engagement: { id: 'eng_shell', name: '某客户', stage: 'pilot', dir: '', nextAction: {} }, intent: 'stage' });
  check('试点交接提示词的【方法文件】列出新指针', pPilot.includes('- methods/07-成本评估与报价.md') && pPilot.includes('- methods/06-场景选择与数据体检.md') && !pPilot.includes('文档模板库'));
}

/* ============================ 汇总 ============================ */
console.log('\n=== 汇总 ===');
console.log(`通过 ${passed.length} 项，失败 ${failed.length} 项` + (skipped.length ? `，跳过 ${skipped.length} 项` : ''));
if (skipped.length) {
  console.log('\n跳过项（环境限制，未验证）：');
  for (const s of skipped) console.log('  ⚠ SKIP ' + s);
}
if (failed.length) {
  console.log('\n失败项：');
  for (const f of failed) console.log('  ✗ ' + f);
  console.log('\nFDE 宿主测试失败。');
  process.exit(1);
}
console.log('FDE 宿主测试全部通过。');
