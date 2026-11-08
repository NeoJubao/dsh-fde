---
name: fde-engagement
description: 当用户问「今天该做什么」「客户到哪一步了」、要接手新客户、推进阶段或准备周会时使用；它是 FDE 客户经营的总入口。
---

# fde-engagement · 客户经营与今日行动

> 定位：FDE 流程的**总入口**。读看板 → 排优先级 → 补下一步 → 建议阶段推进 → 发起会话；具体阶段产物由 `fde-discovery` / `fde-meeting` / `fde-solution` 等技能承接。
> 工具：`fde_board` / `fde_engagement` / `fde_brief` / `fde_item`。宿主未重启时这些工具不存在——只读 `research/.fde/board.json` 或面板，并如实说「看板功能未生效」，不得假装状态存在。

## 阶段总览（v1.3 起 8 阶段）

`lead 线索 → discovery 研判 → meeting 会面 → scoping 场景 → solution 方案 → pilot 试点 → delivery 交付 → adoption 采用`（终止：`archived` 归档 / `lost` 流失）。固定顺序不可跳阶（人工 `force` 除外）；门禁 = 自动产物检查 + 人工确认。

| 阶段 | 主责技能 | 关键产物 |
|---|---|---|
| `lead` | 本技能 | `00-项目档案.md` |
| `discovery` | `fde-discovery` | 主体锁定 / 事实核查清单 / KPI 假设 |
| `meeting` | `fde-meeting` | Brief / 研判底稿 / 合作地图 / 会后记录 |
| `scoping` | `fde-scoping`（v1.3 新增） | `scoping/场景评估.md`、数据可得性清单、范围与边界 |
| `solution` | `fde-solution` | 方案 / 成本测算表 / 报价单 |
| `pilot` | `fde-pilot` | Pilot Charter 六项 + 指标与确认 |
| `delivery` | `fde-delivery` | 实施计划 / 验收清单 / 变更单 |
| `adoption` | `fde-adoption` | 使用证据 / 价值证明 / 扩展地图 |

**工具与资料库入口**：全程工具 `fde_board` / `fde_brief` / `fde_attention`；两件「算得清」的工具——`fde_scenario`（scoping 评估）、`fde_quote`（solution 成本与报价）；资料查 `fde_library`（权威资料/开源/方法模板/社区动态，每日刷新，A/B/C 分级）。`scys_fde` 保留兼容（面板入口已并入资料库）。

## 一、触发时机

- 「今天该做什么」「先处理谁」「这周重点」→ 读今日/本周简报。
- 「客户 X 到哪一步了」「要不要推进」「下一步找谁」→ 读单客户与门禁缺口。
- 「新来一个客户/线索」→ 建 engagement，进入 `lead`。
- 「客户没动静了」→ 查停滞与下一动作，给跟进或暂停建议。
- 「这个客户要不要暂停/归档」「自主性设成什么」→ 给建议与理由，由人决定。
- 「先做哪个场景」「数据拿不拿得到」→ 分流 `fde-scoping`；「多少钱/怎么报价」→ 分流 `fde-solution`（`fde_quote`）。
- 「找几篇权威资料/方法模板」→ 用 `fde_library`（按来源组/阶段/A-B-C 筛）。
- 不触发：写调研底稿、会面材料、场景评估、正式方案 → 交给对应下层技能。

## 二、输入

| 输入 | 必填 | 说明 |
|---|---|---|
| 客户名/公司全称 | 是 | 新客户用工商全称，简称单独记 `shortName` |
| 来源 | 是 | manual / import / folder / bid / agent，写清谁介绍、哪天 |
| 现状 | 否 | 已有会话、最近材料、上次会面结论 |
| 约束 | 否 | 时间窗口、关系禁忌、不能碰的单位和人 |

## 三、执行步骤（逐条可检查）

1. **读状态**：调用 `fde_brief`（period=today 或 week），确认三样东西：注意力条目、逾期项、pending proposals。检查：返回含 `attention[]` 与 `stats`；为空则报告「看板未初始化或本周无待办」，不编造。
2. **排优先级**：按 blocked > decision > review > answer > overdue > gate > stall > proposal 排序，同级按到期日升序。检查：给用户的清单是排序后的前 N 条，不是全量罗列。
3. **新客户入库**：`fde_engagement {action:'create'}`，至少填 `company`、`source.kind`、`nextAction.text`（门禁 `intake` 的三项自动检查）。检查：`intake` 自动项全过，缺项如实报。
4. **补下一步**：每个活跃客户必须有 `nextAction`，格式是「一个动作 + 一个可检查产物 + 到期日」，例如「补 KPI 假设第三段 → KPI与痛点假设.md，11-10」。检查：无空 `text`，无「继续跟进」这类不可检查表述。
5. **阶段推进（只建议，不代跑）**：先 `fde_engagement {action:'gate'}` 看缺什么 → 把缺口回给人 → 人确认后才 `action:'move'`；`force` 必须带 `reason` 并注明人工覆盖。检查：没有任何一次 move 是 agent 自行决定的。
6. **发起会话**：按阶段选意图（调研/会面材料/方案/复盘），用 `fde_board` 或面板 handoff 创建会话；提示词里只交代「读计划执行，不要重新规划」。检查：handoff 返回 `sessionId`，并写入 timeline。
7. **收回报**：会话结束前要求 `fde_item {action:'report'}`（kind=progress/ready/blocked/failed，≤300 字 + artifacts 路径）。检查：每个发起的会话都有 report，或明确说明未完成及原因。
8. **周会视图**：`fde_brief {period:'week'}` 后手工整理 5 行内摘要（活跃数 / 卡点 / 本周交付 / 需人决策 / 下周建议）。检查：摘要落盘或写进会话，不只口头说。

9. **收尾自检**：把本次所有「已安排」回写成 board 里的 engagement/item（含 owner 与到期）；只存在于对话里的承诺不算安排。检查：没有口头待办留在会话中。

## 四、产物与路径

| 产物 | 路径 | 命名规则 |
|---|---|---|
| 看板状态 | `research/.fde/board.json` | 由工具写，禁止手改 |
| 备份 | `research/.fde/backups/board-<YYYYMMDD-HHmmss>.json` | 工具自动保留最近 10 份 |
| 客户卷 | `research/<客户简称>-<YYYYMMDD>/` | 沿用现有目录，不迁移 |
| 周会摘要 | 会话内；需要归档时进客户卷 `internal/` | `周会摘要-<YYYYMMDD>.md` |

## 五、边界（不做什么）

- 不自动推进阶段、不自动通过门禁、不自行标记交付/验收完成——门禁只有人能过。
- 不新建第二套流程：不手写 md 状态表替代 board，不平行维护另一份客户清单。
- 不删除客户、不归档客户、不改 `research/<客户>/` 下的定稿文件。
- 不擅自提高自主性（observe → assisted/auto）——这是设置项，需人明确同意。
- 不把「建议」写成「已安排」：proposal 未被人采纳前不得当事实陈述。
- 不在缺 `nextAction` 的情况下把客户留在活跃阶段——先补下一步，再谈推进。
- 不替客户或上级写「已同意」类记录；确认以书面/邮件为准。

## 六、相关方法与旧技能

- `methods/00-调研执行流程.md` —— 端到端流程与落盘；`methods/06`（场景选择）、`methods/07`（成本报价）分别对应 `scoping` 与 `solution`。
- `reference/雷区清单.md` —— 29 条已踩过的坑与交付前终检。
- `docs/01-spec.md` §2 阶段与门禁、§5 注意力模型、§6 自主性策略。
- 旧技能 `company-research` / `meeting-prep` / `proposal-forge` / `domain-model-partnership` 是**方法库**，由本技能与下层阶段技能引用，不独立自动触发。
- 11 个编排技能（`fde-*`）由本技能按阶段分流；工具口径见 `docs/01-spec.md` §7、§19–§21。
