---
name: fde-engagement
description: 当用户问「今天该做什么」「客户到哪一步了」、要接手新客户、推进阶段或准备周会时使用；它是 FDE 客户经营的总入口。
---

# fde-engagement · 客户经营与今日行动

> 定位：FDE 流程的**总入口**。读看板 → 排优先级 → 补下一步 → 建议阶段推进 → 交给 AI 开会话；具体阶段产物由 `fde-discovery` / `fde-meeting` / `fde-solution` 等技能承接。
> 工具：`fde_board` / `fde_engagement` / `fde_brief` / `fde_item`。DSH 未重启时这些工具不存在——只读 `research/.fde/board.json` 或界面，并如实说「看板功能未生效」，不得假装状态存在。
> 对用户说话的用词：工具名、参数名、阶段 key 照写；其余用界面上的词——客户（engagement）、任务（item）、待我处理（attention）、提醒（proposal）、推进条件（gate）、破例推进（force）、AI 权限（autonomy）、交给 AI（handoff）、进展（report）、状态（lane）、关键人（stakeholders）、记录（timeline）、客户文件夹（客户卷）。

## 阶段总览（v1.3 起 8 阶段）

`lead 线索 → discovery 研判 → meeting 会面 → scoping 场景 → solution 方案 → pilot 试点 → delivery 交付 → adoption 采用`（终止：`archived` 归档 / `lost` 流失）。固定顺序不可跳阶（人工破例推进 `force` 除外）；每个阶段的推进条件 = 材料（系统自动核对）+ 需要人确认的项。

> 推进条件属于**要进入的那个阶段**：客户停在某一列，表示这一列的材料已经有了，手上在做的是进入下一列需要的材料。所以选技能看「要进入的阶段」——客户在 `lead` 时，要补的是 `discovery` 的材料，用 `fde-discovery`；已在最后一个阶段时用当前阶段的技能。面板里点「交给 AI」发出的任务说明已经按这个规则选好技能。

| 阶段 | 主责技能 | 关键产物 |
|---|---|---|
| `lead` | 本技能 | `00-项目档案.md` |
| `discovery` | `fde-discovery` | 主体锁定 / 事实核查清单 / KPI 假设 |
| `meeting` | `fde-meeting` | Brief / 研判底稿 / 合作地图 / 会后记录 |
| `scoping` | `fde-scoping`（v1.3 新增） | `scoping/场景评估表.md`、数据可得性清单、范围边界 |
| `solution` | `fde-solution` | 方案 / 成本测算 / 报价单 |
| `pilot` | `fde-pilot` | Pilot Charter 六项 + 指标与确认 |
| `delivery` | `fde-delivery` | 实施计划 / 验收清单 / 变更单 |
| `adoption` | `fde-adoption` | 使用证据 / 价值证明 / 扩展地图 |

**工具与资料库入口**：全程工具 `fde_board` / `fde_brief` / `fde_attention`；两个计算工具——`fde_scenario`（scoping 评估）、`fde_quote`（solution 成本与报价）；资料查 `fde_library`（权威资料/开源/方法模板/社区动态，每日刷新，A/B/C 分级）。`scys_fde` 保留兼容（界面入口已并入「情报 → 资料库」）。

## 一、触发时机

- 「今天该做什么」「先处理谁」「这周重点」→ 读今日/本周简报。
- 「客户 X 到哪一步了」「要不要推进」「下一步找谁」→ 读该客户的阶段与推进条件还缺什么。
- 「新来一个客户/线索」→ 建客户（`fde_engagement {action:'create'}`），进入 `lead`。
- 「客户没动静了」→ 查已经多少天没有进展、下一步是什么，给跟进或暂停建议。
- 「这个客户要不要暂停/归档」「AI 权限设成哪一档」→ 给建议与理由，由人决定。
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

1. **读状态**：调用 `fde_brief`（period=today 或 week），确认三样东西：待我处理的条目（`attention[]`）、已逾期的事、还没处理的提醒（pending proposals）。界面上对应「今日」的四块：待我处理 / 提醒 / 今天跟进 / 最近动态。检查：返回含 `attention[]` 与 `stats`；为空则报告「看板未初始化或本周无待办」，不编造。
2. **排优先级**：按 blocked 卡住了 > decision 等你决定 > review 待验收 > answer 等你回复 > overdue 已逾期 > gate 等你确认 > stall 没有进展 > proposal 提醒 排序，同级按到期日升序；对用户说分类时用中文标签。提醒只有四类：快到期 / 没定下一步 / 会面快到了 / 新招采公告。检查：给用户的清单是排序后的前 N 条，不是全量罗列。
3. **建新客户**：`fde_engagement {action:'create'}`，至少填 `company`、`source.kind`、`nextAction.text`（`lead` 阶段推进条件 `intake` 里系统自动核对的三项）。检查：这三项全部满足，缺项如实报。
4. **补下一步**：每个活跃客户必须有 `nextAction`，格式是「一个动作 + 一个可检查产物 + 到期日」，例如「补 KPI 假设第三段 → KPI与痛点假设.md，11-10」。检查：无空 `text`，无「继续跟进」这类不可检查表述。
5. **建议阶段推进（只建议，不代跑）**：先 `fde_engagement {action:'gate'}` 看推进条件还缺什么 → 把缺口告诉人（界面上是客户抽屉里「推进到下一阶段」的清单）→ 人确认后才 `action:'move'`；破例推进（`force:true`）必须带 `reason` 并注明人工覆盖。检查：没有任何一次 move 是 agent 自行决定的。
6. **交给 AI 开会话**：按阶段选意图（调研/会面材料/方案/复盘），用 `fde_board` 或界面上的「交给 AI」（客户抽屉里是「交给 AI 准备材料」）创建会话；提示词里只交代「读计划执行，不要重新规划」。检查：handoff 返回 `sessionId`，并写进该客户的记录（timeline）。
7. **收进展**：会话结束前要求 `fde_item {action:'report'}`（kind=progress/ready/blocked/failed，≤300 字 + artifacts 路径）。检查：每个交出去的会话都有一条进展（report），或明确说明未完成及原因。
8. **出周会摘要**：`fde_brief {period:'week'}` 后手工整理 5 行内摘要（活跃数 / 卡点 / 本周交付 / 需人决策 / 下周建议）。检查：摘要落盘或写进会话，不只口头说。

9. **收尾自检**：把本次所有「已安排」写成看板里的客户或任务（含负责人 owner 与到期日）；只存在于对话里的承诺不算安排。检查：没有口头待办留在会话中。

## 四、产物与路径

| 产物 | 路径 | 命名规则 |
|---|---|---|
| 看板状态 | `research/.fde/board.json` | 由工具写，禁止手改 |
| 备份 | `research/.fde/backups/board-<YYYYMMDD-HHmmss>.json` | 工具自动保留最近 10 份 |
| 客户卷 | `research/<客户简称>-<YYYYMMDD>/` | 沿用现有目录，不迁移 |
| 周会摘要 | 会话内；需要归档时进客户卷 `internal/` | `周会摘要-<YYYYMMDD>.md` |

## 五、边界（不做什么）

- 不自动推进阶段、不自行确认推进条件、不自行标记交付/验收完成——推进条件只能由人确认。
- 不新建第二套流程：不手写 md 状态表替代 board，不平行维护另一份客户名单。
- 不删除客户、不归档客户、不改 `research/<客户>/` 下的定稿文件。
- 不擅自调高 AI 权限（`observe`「只提醒，由我决定」→ `assisted`/`auto`「小事可以直接处理」）——这是设置项（页头齿轮 → AI 权限），需人明确同意。
- 不把提醒写成「已安排」：提醒（proposal）在人处理之前不得当事实陈述。
- 不在缺 `nextAction` 的情况下把客户留在活跃阶段——先补下一步，再谈推进。
- 不替客户或上级写「已同意」类记录；确认以书面/邮件为准。

## 六、相关方法与旧技能

- `methods/00-调研执行流程.md` —— 端到端流程与落盘；`methods/06`（场景选择）、`methods/07`（成本报价）分别对应 `scoping` 与 `solution`。
- `reference/雷区清单.md` —— 已踩过的坑（按主体归属、称谓、数字口径、方案商务、排版、现场纪律、插件开发分类）与交付前终检。
- `docs/01-spec.md` §2 阶段与门禁、§5 注意力模型、§6 自主性策略（这三节用的是代码与数据里的叫法）；§22 是 v2.0 的界面用词与结构。
- 旧技能 `company-research` / `meeting-prep` / `proposal-forge` 是**方法库**，由本技能与下层阶段技能引用，不独立自动触发。
- 11 个编排技能（`fde-*`）由本技能按阶段分流；工具口径见 `docs/01-spec.md` §7、§19–§21。
