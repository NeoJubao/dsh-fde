---
name: fde-bid-radar
description: 当要查某单位采购史或中标情况、找招标机会、判断竞争格局、会面前补采购证据，或客户看板里问「这家最近招过什么」时使用；FDE 只管客户关联层，深挖用 bid_* 工具。
---

# fde-bid-radar · 招采雷达（客户关联层）

> 定位：把招采雷达（bid-intel 本地索引）接到客户经营上——**谁招过什么、谁中标、最近有什么招标信号**；产出是「与客户关联的证据与跟进项」，不是第二套招采平台。
> 依赖：bid-intel 通过只读服务 `bidIntel` 提供数据；未装载/未升级时 FDE 全部招采功能返回 `available:false`，本技能**降级说明并停止检索**，不编造数据。
> 铁律（先读）：**候选人 ≠ 中标人**；**批次/专项是推断，不是公告明示**；**金额只引原文，不换算、不求和**；数据缺口如实说明。

## 一、触发时机

- 「某集团/某院最近招过什么」「这家中过哪些标」「这家和谁在竞争」。
- 找招标机会：客户或其上级近期发布招标/采购/询价/竞争性谈判公告。
- 会面前补采购证据（由 `fde-meeting` 引用）；写方案要历史成交与竞争格局（由 `fde-solution` 引用）。
- 看板客户卡片/抽屉显示「招采 N」徽章，用户点开问详情；今日出现 `bid_signal` 建议。
- 不触发：要全量统计或成稿报告（用 `bid_report`）、要导入任意链接（用 `bid_import_url`）、要改招采索引或采集（用 `bid_collect`）。

## 二、输入

| 输入 | 必填 | 说明 |
|---|---|---|
| 客户 id（engagementId） | match/link/promote 必填 | 先 `fde_board` 查 id，不猜 |
| 检索词 q / 模式 mode | 泛查时必填 | mode：buyer（采购单位）/ company（公司）/ title / any |
| 时间范围 from/to | 否 | 公告日期（YYYY-MM-DD），不是抓取日期 |
| 来源 source | 否 | aecc-ebidding / avic-eavic / avic-avicbid / norinco-ebuy / cssc 等 |
| 关系 relation | 否 | buyer / winner / candidate / mention；link 时可覆盖自动分类 |
| 备注 note | 否 | 关联理由（一句话），随 link 落盘 |
| 数据可用性 | 是 | `fde_bid match` 返回的 `available`；false 时按降级处理 |

## 三、执行步骤（逐条可检查）

1. **确认服务可用**：先 `fde_bid {action:'match', engagementId}`（或面板招采页签）。返回 `available:false` → 明确告知「招采雷达未就绪（bid-intel 未装载或未升级）」，改用公开渠道检索并标 C 级；**不得编造条数或公告**。检查：回复里有可用性结论，没有假装查到数据。
2. **检索**：有客户用 match（自动拼 company/shortName/name/dir/keywords，去重后最多 8 个查询词）；泛查用 `fde_bid {action:'search', q, mode, from, to, source}`；需要全量/时间线时用会话工具 `bid_search` / `bid_timeline`（同一数据语义）。检查：结果含 id/title/date/url/relation。
3. **按 relation 分类**：优先级 buyer（该单位发布的采购）→ winner（客户是中标人）→ candidate（候选人，**不是中标**）→ mention（全文提及）；并按 kind 标 `tender`（招标/采购/询价/竞争性谈判）与 `award`（中标/成交/结果）。检查：每条都带 relation 与 tender/award 标记；candidate 不得写成中标。
4. **建关联**：对客户 `fde_bid {action:'link', engagementId, bidId, relation?, note?}`；同一 bidId 重复 link 幂等；撤回用 `unlink`。检查：board 的 `bidWatch.links` 出现该条、timeline 有 `by` 留痕（agent/human 如实）。
5. **提升为跟进**：`fde_bid {action:'promote', engagementId, bidId}` 建任务「跟进招标：<title>」（type=followup、stage=todo、带 bidRefs）。检查：返回 item，且 item.bidRefs 有该公告；没有重复建任务。
6. **信号处理**：今日里的 `bid_signal` proposal 只代表「发现招采信号」（近 30 天、招标类、buyer/mention）；**需人采纳**才建任务，observe 模式不自动建。检查：没有替人采纳、没有自行建任务。
7. **深挖不在 FDE 重写**：时间线用 `bid_timeline`；批次/专项用 `bid_batches`（推断，须向用户说明）；成稿用 `bid_report`（保留「方法与局限」）。检查：没有在 FDE 里另写检索/批次规则。
8. **汇报**：≤300 字 + 链接（或落盘文件路径），写清四件事——各关系命中数（buyer/winner/candidate/mention）、时间范围、最相关 3 条、数据缺口。长清单写 md 到客户卷。检查：汇报里 candidate 与 winner 分开计数、金额未求和。
9. **口径复核**：总数与分项自检；同一公告多来源去重后计数；金额只原文引用；期间口径以公告日期为准。检查：数字自洽，缺口有说明。

## 四、产物与路径

| 产物 | 路径 | 命名规则 |
|---|---|---|
| 客户关联 | board 内 `engagement.bidWatch.links` | 由 `fde_bid link` 写，禁止手改 |
| 跟进任务 | board 内 items（含 `bidRefs`） | 由 `fde_bid promote` 建 |
| 招采证据摘录 | `research/<客户>/research/招采记录-<YYYYMMDD>.md` | 只抄原文关键字段 + 来源 URL |
| 深挖报告 | `research/<客户>/research/招采报告-<YYYYMMDD>.md` | `bid_report` 生成后再加工，保留方法与局限 |
| 缺口/未证实清单 | 并入 `research/<客户>/research/事实核查清单.md` 的「招采证据」小节 | 标 C 级与未采集平台 |

## 五、边界（不做什么）

- 不把 **mention（文中提及）** 当成交或客户项目；不把 **candidate** 当 winner。
- 不臆断关联公司：名称相近、同园区、同集团都不足以认定；主体归属仍走 `fde-discovery` 三链验证。
- 不把批次/专项当公告明示；不把「推断的专项」写进对外材料的确定结论。
- 不换算、不求和、不折算金额（币种与口径不一，只引原文）；不做成交金额统计。
- 不修改 bid-intel 索引、不触发采集、不导入链接（那是 bid-intel 的工具职责）；FDE 只做关联层。
- 不自动对外发送、不把未核实招采信息写进对客材料；对外引用先由人确认。
- 数据缺口必须说清：涉密/内部采购、未公开全文的询价结果、限流未采全的平台，都不在索引内。

## 六、相关工具与技能

- `fde_bid`（FDE 第 7 个工具）：`search/match/link/unlink/promote/timeline`；不可用时返回 `{ok:false, code:'UNAVAILABLE'}`，不抛异常。
- bid-intel 工具（深挖）：`bid_search`、`bid_timeline`、`bid_batches`、`bid_report`、`bid_collect`、`bid_import_url`。
- `fde-discovery`（主体锁定与证据分级）、`fde-meeting`（会面前的采购证据）、`fde-solution`（历史成交与竞争格局）、`fde-board`（看板操作与「招采 N」徽章口径）。
- 契约与决策：`docs/01-spec.md` §17、`docs/adr/0002-bid-intel-integration.md`；数据源现状见 `reference/数据源清单.md`。
