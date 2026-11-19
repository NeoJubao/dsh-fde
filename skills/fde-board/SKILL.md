---
name: fde-board
description: 当要操作看板（移动客户阶段或任务状态、建任务、处理「待我处理」和提醒）、导入已有客户文件夹、调整 AI 权限或查看运行状态（健康检查）时使用。
---

# fde-board · 看板与任务操作

> 定位：FDE 看板的**唯一操作入口**。所有客户与任务的状态变更都走这里，状态只存一处。阶段定义、推进条件（工具里叫 gate）、「待我处理」的规则以 `docs/01-spec.md` 与 `src/host/fde-schema.js` 为准（v1.3 起 **8 阶段**，含 `scoping` 场景），本技能不另写一套。
> 铁律：看板是唯一编排者——不平行维护第二套 md 状态表、不开第二套流程引擎。
> 界面位置（给用户指路时用）：主页签是 今日 / 客户 / 资料 / 流程 / 情报，设置在页头齿轮。看板在「客户 → 看板」，旁边还有「列表」「任务」两个子页签。点客户卡片打开客户抽屉，顺序是 下一步 → 推进到下一阶段 → 关键人 → 资料 → 招采 → 记录。
> 对用户说话的用词：工具名、参数名、阶段 key 照写；其余用界面上的词——客户、任务、待我处理（attention）、提醒（proposal）、推进条件（gate）、破例推进（force）、AI 权限（autonomy）、交给 AI（handoff）、进展（report）、状态（lane）、关键人、记录（timeline）。

## 一、触发时机

- 「把客户移到会面阶段」「这个任务标记完成/卡住了」「建个任务」。
- 「处理一下待我处理的事」「这条提醒帮我建个跟进任务」「这条提醒知道了」。
- 「把已有文件夹导进看板」「调一下 AI 权限」「看看运行状态 / 健康检查」。
- 「看板备份/回滚」→ 备份在 `research/.fde/backups/`，回滚由人确认后执行。
- 「这条招采记录关联一下/加入跟进」→ `fde_bid action=link|promote`（可逆，agent 可做）。
- 「资料库有什么/刷新一下资料」→ `fde_library action=feed|search|refresh`（只读策展目录 + 每日指标/社区摘要）。
- 「算一下场景分/成本报价」→ `fde_scenario` / `fde_quote`（纯计算，不写 board、不写客户卷）。
- 不触发：写阶段产物（交给对应阶段技能）、改插件代码（那是开发任务）。

## 二、输入

| 输入 | 必填 | 说明 |
|---|---|---|
| 操作对象 | 是 | 客户 id / 任务 id（先 `fde_board` 查，不猜 id） |
| 动作 | 是 | move / create / update / report / attention / adopt / settings / proposal / bid-link / bid-promote / library / scenario / quote |
| 理由与证据 | 是 | 阶段推进要说明推进条件还缺什么；破例推进（`force`）必须写 `reason` |
| 人是否已确认 | 是 | 涉及推进条件、删除、对外发送的操作必须人工确认 |

## 三、执行步骤（逐条可检查）

1. **先读后写**：`fde_board` 取最新 board（含 `updatedAt`、`version`），确认对象存在且状态。检查：写操作前有读，id 来自返回结果。
2. **从 meta 读阶段**：8 个阶段（`lead → discovery → meeting → scoping → solution → pilot → delivery → adoption`）与推进条件一律从 `/fde/meta` 取，**不硬编码阶段数**；旧 7 阶段 board 可正常读，不自动改写阶段。检查：移动前确认目标阶段 key 在 meta 中。
3. **操作任务**：`fde_item` create/update/move；进 `done` 至少要有 1 条进展（report）或人工 evidence；`report` 的 kind 决定后续（ready→`review` 待验收、blocked→`waiting` 等对方并进「待我处理」、failed→`doing` 进行中并进「待我处理」、dropped→`canceled` 已取消）。检查：done 有证据，blocked 有「等谁/等什么」。
4. **移动客户阶段**：先 `fde_engagement {action:'gate'}` 看推进条件还缺什么 → 把缺口告诉人 → 人确认后 `action:'move'`；破例推进（`force:true`）必须带 `reason` 并标注人工覆盖。界面上对应客户抽屉的「推进到下一阶段」：条件全部满足时主按钮是「进入「下一阶段」」，否则是「交给 AI 准备材料」，次级入口「破例推进」要写原因。检查：没有 agent 自决的 move。
5. **处理「待我处理」**：用 `fde_attention ask` 提问（只问必须由人回答的），用 `resolve` 记录答案；系统推算出来的条目（已逾期、没有进展、等你确认、待验收等）不写入文件，也不用手改 board。检查：每个 ask 有明确问题与对象。
6. **处理提醒**：`fde_brief` 看 proposals（界面叫「提醒」，只有四类：快到期 / 没定下一步 / 会面快到了 / 新招采公告）→ 人决定 → `proposal {action:'accept'|'dismiss'}`。`accept` 对应界面按钮「建跟进任务」（新招采公告）和「交给 AI 准备」（会面快到了）；`dismiss` 对应「知道了」；快到期、没定下一步的按钮是「去处理」，只打开客户或任务，不改提醒状态。`observe` 模式下也允许人这样处理。检查：没有自动把提醒全部 accept。
7. **导入现有项目**：`adopt {action:'scan'}` 先看候选（识别含 `00-项目档案.md` 的目录与 legacy 目录，给建议阶段）→ 人确认后 `apply`；重复导入要拒。界面入口是「客户 → 列表 → 导入已有文件夹」。检查：扫描结果经人过目，未自动写入。
8. **改设置与 AI 权限**：`settings {patch}` 改 `autonomy` / `stallDays` / `wipLimits` / 规则开关。界面在页头齿轮的设置里，分 AI 权限 / 提醒 / 数据来源 / 示例数据 / 运行状态 五组。AI 权限两档：`observe`「只提醒，由我决定」、`assisted`「小事可以直接处理」（`auto` 与它行为相同）。调高 AI 权限须人明确同意；改完说明改了哪几项。检查：`autonomy` 变更有人确认记录。
9. **做健康检查**：`GET /fde/health`（界面：设置 → 运行状态）看 board 可读、备份目录、skills 注册、目录可写、schema 版本；异常先报告不动数据。检查：异常有逐项原因，不是一句「检查失败」。
10. **处理写冲突**：写失败（`CONFLICT`/版本不符）先重读 board 再重试，不覆盖他人正在改的内容。检查：没有盲目重试覆盖。

11. **说明改了什么**：每次写操作后说明「改了什么、为什么、影响谁」；批量操作按条列出。检查：说明能复述成一句可核对的话。

12. **关联招采公告、核对条数**：`fde_bid action=link` 关联公告、`action=promote` 建「跟进招标」任务（可逆、agent 可做，`by` 留痕）；客户卡片上的招采条数 = 匹配公告总数（招标/中标/候选/提及合计，按 relation 分开展示），`available:false` 时不显示条数、不写「0 条」。检查：条数与 match 统计一致，未把候选计入中标。

13. **用资料库与计算工具**：`fde_library` 只读策展目录 + 每日刷新的 GitHub 指标/社区摘要（`feed`/`search`/`refresh`），catalog 缺失返回 `UNAVAILABLE` 不白屏；`fde_scenario`/`fde_quote` 只返回计算与 Markdown，**不写 board、不写客户卷**，产物由会话落盘。检查：资料条目 A/B/C 级别未被改写；计算工具的 `warnings` 已转述给人。

## 四、产物与路径

| 产物 | 路径 | 命名规则 |
|---|---|---|
| 看板状态 | `research/.fde/board.json` | 工具写；`version:1` |
| 写前备份 | `research/.fde/backups/board-<YYYYMMDD-HHmmss>.json` | 最近 10 份 |
| 状态变更记录 | board 内 `timeline` / `activity` | 截断上限 200 / 300 条 |
| 健康检查 | 设置 → 运行状态，或 `/fde/health` | 逐项 name/status/detail |
| 资料库缓存 | `research/.fde/fde-library.json` | 每日自动刷新（catalog 指标 + 社区摘要）；缺失不影响看板 |

## 五、边界（不做什么）

- 不手工编辑 `board.json`；状态只通过工具或界面写（工具会备份、原子写）。
- 不自动推进阶段、不自行确认推进条件、不自动调高 AI 权限、不替人 accept 提醒。
- 不删除客户目录、不删除项目文件；归档/删除只改 board 状态并二次确认。
- 不新建第二套看板或 md 状态表作为事实源；不复刻 superagent 的 Source/Thread/Executor 体系。
- 不绕过守卫：路由只接受 board 内 id，不拼接用户路径；不在 query 里传任意路径。
- 不把 `research/.fde/board.json` 放进对外材料；它含内部分析。
- 不把客户卡片上的招采条数解释为成交或机会数：它只是匹配公告数；服务未就绪时写「未就绪」，不写 0。

## 六、相关方法与旧技能

- `docs/01-spec.md` §2 阶段与门禁、§3 数据模型、§4 API 契约、§5 注意力、§6 自主性、§19 资料库、§20 流程 v2（8 阶段）、§21 两个计算工具；§22 是 v2.0 的界面用词与结构（§2/§5/§6 的标题用的是代码与数据里的叫法）。
- `reference/雷区清单.md`（防误操作与状态漂移）。
- 旧的 `rw_status` 降级为**只读执行工具**（看进展），不再承担阶段推进；由本技能编排，不独立触发流程。
- `fde-bid-radar`（招采检索与口径）、`docs/01-spec.md` §17（招采契约：匹配/关联/提升/信号）。
- `fde-scoping`（`scoping` 阶段产物）、`methods/06`/`methods/07`（场景选择、成本报价）；`fde_library`（资料库只读入口）。
