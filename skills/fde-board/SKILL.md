---
name: fde-board
description: 当要操作看板（移动客户阶段/任务泳道、建任务、处理注意力、采纳建议）、导入现有项目、切换自主性或跑健康检查时使用。
---

# fde-board · 看板与工单操作

> 定位：FDE 看板的**唯一操作入口**。所有客户与任务状态变更走这里，保证「一处状态、一份事实」。阶段定义、门禁、注意力规则以 `docs/01-spec.md` 与宿主 schema 为准（v1.3 起 **8 阶段**，含 `scoping` 场景），本技能不另写一套。
> 铁律：看板是唯一编排者——不平行维护第二套 md 状态表、不开第二套流程引擎。

## 一、触发时机

- 「把客户移到会面阶段」「这个任务标记完成/受阻」「建个任务」。
- 「处理一下待我审」「采纳这条建议」「忽略这个提醒」。
- 「把已有项目导进看板」「设置自主性」「健康检查」。
- 「看板备份/回滚」→ 备份在 `research/.fde/backups/`，回滚由人确认后执行。
- 「这条招采记录关联一下/加入跟进」→ `fde_bid action=link|promote`（可逆，agent 可做）。
- 「资料库有什么/刷新一下资料」→ `fde_library action=feed|search|refresh`（只读策展目录 + 每日指标/社区摘要）。
- 「算一下场景分/成本报价」→ `fde_scenario` / `fde_quote`（纯计算，不写 board、不写客户卷）。
- 不触发：写阶段产物（交给对应阶段技能）、改宿主代码（那是开发任务）。

## 二、输入

| 输入 | 必填 | 说明 |
|---|---|---|
| 操作对象 | 是 | engagement id / item id（先 `fde_board` 查，不猜 id） |
| 动作 | 是 | move / create / update / report / attention / adopt / settings / proposal / bid-link / bid-promote / library / scenario / quote |
| 理由与证据 | 是 | 阶段推进要说明门禁缺口；force 必须写 reason |
| 人是否已确认 | 是 | 涉及门禁、删除、对外发送的操作必须人工确认 |

## 三、执行步骤（逐条可检查）

1. **先读后写**：`fde_board` 取最新 board（含 `updatedAt`、`version`），确认对象存在且状态。检查：写操作前有读，id 来自返回结果。
2. **阶段从 meta 读**：8 个阶段（`lead → discovery → meeting → scoping → solution → pilot → delivery → adoption`）与门禁一律从 `/fde/meta` 取，**不硬编码阶段数**；旧 7 阶段 board 可正常读，不自动改写阶段。检查：移动前确认目标阶段 key 在 meta 中。
3. **任务操作**：`fde_item` create/update/move；进 `done` 至少要有 1 条 report 或人工 evidence；`report` 的 kind 决定后续（ready→review、blocked→waiting+注意力、failed→doing+注意力、dropped→canceled）。检查：done 有证据，blocked 有「等谁/等什么」。
4. **客户阶段操作**：先 `fde_engagement {action:'gate'}` 评估缺口 → 把缺口给人 → 人确认后 `action:'move'`；`force:true` 必须带 `reason` 并标注人工覆盖。检查：没有 agent 自决的 move。
5. **注意力处理**：用 `fde_attention ask` 提问（只问真正需要人回答的）、`resolve` 记录答案；派生注意力不写入文件、不用手改 board。检查：每个 ask 有明确问题与对象。
6. **建议处理**：`fde_brief` 看 proposals → 人决定 → `proposal {action:'accept'|'dismiss'}`；observe 模式下也允许人采纳。检查：没有自动全部采纳。
7. **导入现有项目**：`adopt {action:'scan'}` 先看候选（识别含 `00-项目档案.md` 的目录与 legacy 目录，给建议阶段）→ 人确认后 `apply`；重复导入要拒。检查：扫描结果经人过目，未自动写入。
8. **设置与自主性**：`settings {patch}` 改 autonomy / stallDays / wipLimits / 规则开关；提高自主性须人明确同意；改完回报差异。检查：autonomy 变更有人确认记录。
9. **健康检查**：`GET /fde/health`（或面板设置页）看 board 可读、备份目录、skills 注册、目录可写、schema 版本；异常先报告不动数据。检查：异常有逐项原因，不是一句「检查失败」。
10. **冲突处理**：写失败（`CONFLICT`/版本不符）先重读 board 再重试，不覆盖他人正在改的内容。检查：没有盲目重试覆盖。

11. **操作回报**：每次写操作回报「改了什么、为什么、影响谁」；批量操作按条列出。检查：回报能复述成一句可核对的话。

12. **招采关联与徽章**：`fde_bid action=link` 关联公告、`action=promote` 建「跟进招标」任务（可逆、agent 可做，`by` 留痕）；卡片「招采 N」= 匹配公告总数（招标/中标/候选/提及合计，按 relation 分开展示），`available:false` 时不显示徽章、不写「0 条」。检查：徽章数字与 match 统计一致，未把候选计入中标。

13. **资料库与计算工具**：`fde_library` 只读策展目录 + 每日刷新的 GitHub 指标/社区摘要（`feed`/`search`/`refresh`），catalog 缺失返回 `UNAVAILABLE` 不白屏；`fde_scenario`/`fde_quote` 只返回计算与 Markdown，**不写 board、不写客户卷**，产物由会话落盘。检查：资料条目 A/B/C 级别未被改写；计算工具的 `warnings` 已转述给人。

## 四、产物与路径

| 产物 | 路径 | 命名规则 |
|---|---|---|
| 看板状态 | `research/.fde/board.json` | 工具写；`version:1` |
| 写前备份 | `research/.fde/backups/board-<YYYYMMDD-HHmmss>.json` | 最近 10 份 |
| 状态变更记录 | board 内 `timeline` / `activity` | 截断上限 200 / 300 条 |
| 健康检查 | 面板设置页或 `/fde/health` | 逐项 name/status/detail |
| 资料库缓存 | `research/.fde/fde-library.json` | 宿主每日刷新（catalog 指标 + 社区摘要）；缺失不影响看板 |

## 五、边界（不做什么）

- 不手工编辑 `board.json`；状态只通过工具/面板写（工具会备份、原子写）。
- 不自动推进阶段、不自动过门禁、不自动提升自主性、不自动采纳建议。
- 不删除客户目录、不删除项目文件；归档/删除只改 board 状态并二次确认。
- 不新建第二套看板或 md 状态表作为事实源；不复刻 superagent 的 Source/Thread/Executor 体系。
- 不绕过守卫：路由只接受 board 内 id，不拼接用户路径；不在 query 里传任意路径。
- 不把 `research/.fde/board.json` 放进对外材料；它含内部分析。
- 不把「招采 N」徽章解释为成交或机会数：它只是匹配公告数；服务未就绪时显示「未就绪」而不是 0。

## 六、相关方法与旧技能

- `docs/01-spec.md` §2 阶段与门禁、§3 数据模型、§4 API 契约、§5 注意力、§6 自主性、§19 资料库、§20 流程 v2（8 阶段）、§21 两个计算工具。
- `reference/雷区清单.md`（防误操作与状态漂移）。
- 旧的 `rw_status` 降级为**只读执行工具**（看进展），不再承担阶段推进；由本技能编排，不独立触发流程。
- `fde-bid-radar`（招采检索与口径）、`docs/01-spec.md` §17（招采契约：匹配/关联/提升/信号）。
- `fde-scoping`（`scoping` 阶段产物）、`methods/06`/`methods/07`（场景选择、成本报价）；`fde_library`（资料库只读入口）。
