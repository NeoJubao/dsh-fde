# ADR-0002：招采雷达并入 FDE 工作站的方式

- 状态：已采纳｜日期：2026-11-03｜决策人：Neo（需求）/ Lead（方案）｜相关：`docs/01-spec.md` §17、`docs/01-spec.md` §7、ADR-0001
- 背景：用户要求「招采雷达并入 FDE 工作站」。招采雷达（`@local/bid-intel`）已是独立 DSH 插件：24,156 条本地招投标索引（`data/notices.jsonl`，约 42MB）、`/bidintel/api/*` 路由、6 个 agent 工具、5 个面板视图。

## 决定

1. **不合并代码、不搬数据**：保持 `@local/bid-intel` 独立插件与单一数据源；FDE 通过新增的**只读 host 服务 `bidIntel`**（`ctx.provide('bidIntel', {...})`）调用它的 `stats/search/timeline/batches/report`。
2. **FDE 只做「客户关联层」**：匹配（buyer/winner/candidate/mention）、关联（bid links）、提升为跟进任务（promote）、招标信号建议（bid_signal）；**不重写检索/批次/报告语义**，深挖仍用 `bid_search/bid_batches/bid_report`。
3. **确定性匹配，不用模型**：查询词来自客户名称/简称/目录/关键词，检索后按规则分类；金额只展示原文不求和（口径不一）；候选人与中标人严格区分。
4. **降级优先**：bid-intel 未装载/未升级（无 `bidIntel` 服务）时，FDE 全部 bids 功能返回 `available:false`，面板显示「招采雷达未就绪」，其余功能不受影响。
5. **数据不落 FDE 状态**：匹配结果是派生缓存（TTL 5 分钟，签名=数据 mtime），只有用户/agent 明确 `link` 的公告写入 `engagement.bidWatch.links`。

## 为什么没选别的

| 方案 | 没选的原因 |
|---|---|
| 把 bid-intel 代码/数据并入 FDE 插件 | 42MB 索引与采集/解析代码重复维护；两个插件都装在同一 profile，合并只会让 FDE 包变大、让数据源更新变复杂 |
| FDE 面板直接调 `/bidintel/api/*` | 面板能调，但宿主工具、规则、看板徽章也需要数据；只做前端集成等于「贴了个链接」 |
| FDE 直接读 `notices.jsonl` 并复制 search 逻辑 | 两套检索语义会漂移（ONE-DEFINITION 违规），且要自己维护解析、批次、金额口径 |
| 把 FDE 状态并回 bid-intel | 招采是「情报源」，FDE 是「经营状态」，方向相反；会让 bid-intel 反向依赖客户模型 |

## 后果

- **好处**：单一数据源；FDE 与 bid-intel 可独立升级；服务缺失可降级；匹配口径可测试、可解释。
- **代价**：需要改 bid-intel `index.js` 增加 `ctx.provide`（约 20 行，向后兼容）；两个插件需一起 live reload 才完整生效；跨插件只读服务属于进程内契约，升级时需保持 `version: 1`。
- **重新考虑条件**：若出现第二个消费方需要写招采数据、或需要跨进程/多机部署，再评估把 `bidIntel` 升级为独立服务或 MCP。

## 验证

- bid-intel：`node verify/all.mjs` 不回归；服务提供不改变既有路由/工具。
- FDE：`fde-host` 新增匹配/分类/链接/信号/降级断言；`verify/all.mjs` 与 `verify/acceptance-audit.mjs` 全绿。
- 真实数据：对 9 个已导入客户跑 match，某研究院/某交通投资集团等应命中招采记录；live reload 后 `fde_bid` 工具实测。
