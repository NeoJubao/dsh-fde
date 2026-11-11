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
  check('A3 timeline 记录 force', (mv.engagement.timeline || []).some((t) => t.text.includes('force')));
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
section('A7 建议生成与采纳');
{
  const bd = store.readBoard(ws).board;
  const e = bd.engagements.find((x) => x.id === eA2.id);
  const old = isoDaysFromNow(-20);
  e.stageSince = old;
  e.createdAt = old;
  e.timeline = [];
  e.nextAction = { text: '跟进', due: dateDaysFromNow(10), owner: '' };
  bd.settings.stallDays = 14;
  const w = store.writeBoard(ws, bd);
  check('A7 预置停滞客户', w.ok, w.reason);
  const b1 = api.board(ws);
  const stall = b1.board.proposals.filter((p) => p.ruleId === 'stall' && p.engagementId === eA2.id);
  check('A7 stall 规则生成 proposal', stall.length === 1, b1.board.proposals.map((p) => p.ruleId));
  check('A7 proposal 有 id/kind/payload', /^prp_[0-9a-f]{6}$/.test(stall[0].id) && stall[0].kind === 'nudge' && !!stall[0].payload);
  const before = (api.board(ws).board.proposals.filter((p) => p.ruleId === 'stall' && p.engagementId === eA2.id)).length;
  const acc = await api.proposal(ws, { id: stall[0].id, action: 'accept' });
  check('A7 accept 成功并标记 accepted', acc.ok && acc.proposal.status === 'accepted' && acc.proposal.decidedAt, acc.reason);
  const engAfter = api.board(ws).board.engagements.find((x) => x.id === eA2.id);
  check('A7 accept 执行 payload（nextAction.due 被改）', engAfter.nextAction.due === dateDaysFromNow(2), engAfter.nextAction);
  const dup = api.board(ws).board.proposals.filter((p) => p.ruleId === 'stall' && p.engagementId === eA2.id);
  check('A7 24h 内不重复生成', dup.length === before, { before, now: dup.length });
  const dismiss = api.board(ws).board.proposals.find((p) => p.status === 'pending');
  if (dismiss) {
    const dm = await api.proposal(ws, { id: dismiss.id, action: 'dismiss' });
    check('A7 dismiss 标记 dismissed', dm.ok && dm.proposal.status === 'dismissed');
  }
  const again = await api.proposal(ws, { id: stall[0].id, action: 'accept' });
  check('A7 已处理建议再采纳 → CONFLICT', again.ok === false && again.code === 'CONFLICT');
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

  /* start_session 建议：补齐自动检查 + 停留 > 7 天 → gate_ready → accept 创建会话并保留会话记录 */
  makeProject('会话客户-20260303', {
    '00-项目档案.md': '# 项目档案：会话客户\n',
    'research/事实核查清单.md': 'A 级',
    'research/KPI与痛点假设.md': '假设',
  });
  const cr = api.engagement(ws, { action: 'create', patch: { name: '会话客户', company: '会话客户有限公司', dir: '会话客户-20260303', nextAction: { text: '补门禁', due: dateDaysFromNow(6) }, source: { kind: 'manual' } } });
  const bd = store.readBoard(ws).board;
  const ee = bd.engagements.find((x) => x.id === cr.engagement.id);
  ee.stageSince = isoDaysFromNow(-8);
  store.writeBoard(ws, bd);
  const br = api.board(ws);
  const got = br.board.proposals.find((p) => p.ruleId === 'gate_ready' && p.engagementId === ee.id);
  check('gate_ready 规则生成 start_session 建议', !!got && got.kind === 'start_session', br.board.proposals.map((p) => p.ruleId));
  const accepted = await api.proposal(ws, { id: got.id, action: 'accept' }, { handoff: async () => ({ ok: true, sessionId: 'sess-gate-1' }) });
  check('start_session accept 创建会话', accepted.ok && accepted.proposal.status === 'accepted' && accepted.sessionId === 'sess-gate-1', accepted.reason);
  const afterEng = api.board(ws).board.engagements.find((x) => x.id === ee.id);
  check('accept 后会话记录未被旧对象覆盖', afterEng.sessionId === 'sess-gate-1' && (afterEng.timeline || []).some((t) => t.kind === 'session'), { sessionId: afterEng.sessionId, timeline: (afterEng.timeline || []).length });
  const p2 = api.proposal(ws, { id: got.id, action: 'accept' }, { handoff: async () => ({ ok: true, sessionId: 'x' }) });
  check('已采纳建议重复采纳 → CONFLICT', (await p2).ok === false);
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
  check('gate intent 提示词含缺口', pg.includes('门禁缺口') && pg.includes('门禁'));
  const draft = prompts.harvestDraft({ text: '复盘内容', engagement: e, targets: ['pitfall'] });
  check('复盘草稿含脱敏边界', draft.includes('脱敏') && draft.includes('未审草稿'));
}

/* ============================ A14 health ============================ */
section('A14 health 自检');
{
  const h = api.health(ws, { skills: { available: true, registered: 13 } });
  check('health 返回 checks 列表', h.ok === true && Array.isArray(h.checks) && h.checks.length >= 6, h.checks);
  check('health 无明显 fail（干净工作区）', h.checks.every((c) => c.status !== 'fail'), h.checks.filter((c) => c.status === 'fail'));
  check('health 含 board/skills/备份项', ['board 可读', 'skills 注册', '备份目录'].every((n) => h.checks.some((c) => c.name === n)), h.checks.map((c) => c.name));
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
  const badSkill = captured.skills.filter((s) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name) || !s.description || typeof s.content !== 'string' || !s.resourceBase || s.resourceBase.kind !== 'directory');
  check('注册项满足 register() 校验（kebab 名/描述/内容/resourceBase）', badSkill.length === 0, badSkill.map((s) => s.name));
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
  check('F2 执行任务字段（doing/agent/title 含阶段名/source.kind=agent）',
    execItem && execItem.stage === 'doing' && execItem.owner === 'agent' && execItem.source && execItem.source.kind === 'agent' && execItem.title.includes('研判'),
    execItem && { stage: execItem.stage, owner: execItem.owner, title: execItem.title });
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
