# FDE 工作站 · 规格（spec）

> 状态：已确认（Neo，2026-11-03）｜ 依据：`docs/00-intent.md`｜ 计划：`docs/02-plan.md`｜ ADR：`docs/adr/0001-fde-workstation.md`
> 本规格是**唯一事实来源**：阶段、门禁、字段、路由、工具、面板结构以本文件为准；实现与测试都从这里派生。
> 版本：**v1.3.1**（包名 `dsh-fde`；2026-11-08 起改名与开源就绪，见 `docs/adr/0004-open-source-readiness.md`；v1/v1.2/v1.3 的演进标注保留为历史基线）

## 0. 一句话

在现有「调研工作台」插件内长出 FDE 工作站：**客户（engagement）** 沿 8 个阶段推进（v1.3；v1 为 7 个阶段），**任务（item）** 在 5 列看板流转，**注意力（attention）** 汇总所有需要人动作的事，**会话（session）** 由看板按阶段模板发起并由 agent 通过工具回报，**门禁（gate）** 用产物与人工确认共同把关。

## 1. 术语表（GLOSSARY）

| 术语 | 中文 | 定义 | 不叫 |
|---|---|---|---|
| engagement | 客户 | 一个客户经营单元，对应 `research/<dir>/` 一个目录 | 项目、商机 |
| item | 任务 | 一件有明确完成标准的工作，挂在客户上或独立存在 | 工单、ticket、卡片 |
| stage | 阶段 | engagement 在生命周期中的位置（8 个，v1.3 起） | 状态 |
| lane | 泳道 | item 在看板上的位置（5 个） | 列、栏目 |
| gate | 门禁 | 进入下一阶段前必须满足的检查集合（自动 + 人工） | 关卡、审批 |
| evidence | 证据 | A/B/C 分级的事实依据；A 官方一手、B 二手/推算、C 待现场核实 | 材料 |
| attention | 注意力 | 需要人决定/审阅/回答/解阻的事项，汇总到「今日」 | 待办、通知 |
| report | 回报 | agent 会话对一个 item 的进度/完成/受阻报告 | 日志 |
| proposal | 建议 | 规则引擎生成的候选动作，被人采纳或忽略后才执行 | 提醒、告警 |
| handoff | 交接 | 看板按阶段模板创建 DSH 会话并下发任务 | 启动 |
| autonomy | 自主性 | observe（只建议）/ assisted（建议+一键执行）/ auto（安全动作自动执行） | 权限 |

## 2. 阶段与门禁（单一事实来源）

### 2.1 engagement 阶段

固定顺序，不可跳阶（除 `force` 外）。定义只在 `src/host/fde-schema.js` 的 `ENGAGEMENT_STAGES` 中写一份，宿主 API、工具、提示词、面板全部从它派生。

| # | key | 中文 | 定义 | 门禁（进入该阶段前） |
|---|---|---|---|---|
| 1 | `lead` | 线索 | 已识别客户/机会，尚未研究 | `intake`：公司名 + 来源 + 下一步 |
| 2 | `discovery` | 研判 | 主体锁定、事实核查、KPI/痛点假设 | `discovery`：档案 + 事实核查清单 + KPI 假设 + 人工确认主体 |
| 3 | `meeting` | 会面 | 会面 Brief、底稿、合作地图 | `meeting`：Brief 文件 + 会面目标与对象层级 + 人工确认 |
| 4 | `solution` | 方案 | 正式方案、多版本、边界纪律 | `solution`：方案 md + "不做什么" + 人工确认可对外 |
| 5 | `pilot` | 试点 | 价值验证/POC，范围与成功指标 | `pilot`：试点方案 + 成功指标 + 客户确认（人工） |
| 6 | `delivery` | 交付 | 实施、验收、风险登记 | `delivery`：验收清单 + 里程碑 + 风险登记（人工） |
| 7 | `adoption` | 采用 | 培训、使用证据、价值证明、扩展地图 | `adoption`：使用/价值证据 + 培训完成 + 扩展地图（人工） |

终止状态（不在看板列中）：`archived` 归档、`lost` 流失。暂停用 `paused: true` 标记，不占终止状态。

### 2.2 门禁检查定义

门禁 = 自动检查（文件/字段）+ 人工确认（人勾选并留证据）。两类都通过才算 `pass`。允许 `force`（人明确覆盖），必须记录 `reason` 与 `by: "human"`。

| gate key | 自动检查（宿主计算） | 人工确认项（key） |
|---|---|---|
| `intake` | `company` 非空；`source` 非空；`nextAction.text` 非空 | — |
| `discovery` | 项目目录内匹配 `事实核查` 的 md ≥1；匹配 `KPI` 或 `痛点` 的 md ≥1；`00-项目档案.md` 存在 | `subject_locked` 主体已锁定；`evidence_graded` 事实已分级 |
| `meeting` | `meeting/` 下匹配 `Brief|brief` 的 md ≥1；`stakeholders` 至少 1 人 | `meeting_goal` 会面目标与对象层级已确认 |
| `solution` | `proposal/` 下 md ≥1；方案文本含「不做什么」或「边界」 | `solution_final` 方案已定稿可对外 |
| `pilot` | `pilot/` 下 md ≥1（或 old 项目 `proposal/` 含试点） | `pilot_scope` 范围与成功指标客户确认 |
| `delivery` | `delivery/` 下 md ≥1（或 `docs/`） | `acceptance` 验收清单；`milestones` 里程碑；`risks` 风险登记 |
| `adoption` | `adoption/` 下 md ≥1（或 `research/` 含价值证明） | `usage_evidence` 使用证据；`training` 培训完成；`expansion_map` 扩展地图 |

> 文件匹配规则：递归扫描项目目录；文件名或路径包含关键词、扩展名 `.md` 即算。扫描结果带 `path` 与 `modifiedAt`，作为证据展示。

### 2.3 item 泳道

| key | 中文 | 含义 |
|---|---|---|
| `inbox` | 收集箱 | 刚捕获、未分类，默认不显示在看板（显示在今日） |
| `todo` | 待办 | 已明确、未开始 |
| `doing` | 进行中 | 正在做（WIP 受限，默认上限 5） |
| `waiting` | 等外部 | 等客户/等上级/等材料，不由我们推进 |
| `review` | 待我审 | agent 或协作者已完成，等人审阅 |
| `done` | 已完成 | 有结果与证据 |
| `canceled` | 已取消 | 明确不做 |

看板默认显示 `todo / doing / waiting / review / done` 五列；`inbox` 在今日页处理。

### 2.4 item 类型

`research` 调研 / `meeting` 会面 / `solution` 方案 / `pilot` 试点 / `delivery` 交付 / `adoption` 采用 / `followup` 跟进 / `admin` 杂务。

## 3. 数据模型

状态文件：`<workspace>/research/.fde/board.json`（单文件，原子写：临时文件 + rename）。备份目录：`research/.fde/backups/board-<YYYYMMDD-HHmmss>.json`（覆盖写前保留最近 10 份）。

```jsonc
{
  "version": 1,
  "revision": 0,                      // 乐观并发：每次写 +1；写入带 expectedRevision
  "updatedAt": "ISO8601",
  "settings": {
    "autonomy": "observe",            // observe | assisted | auto
    "stallDays": 14,                   // 停滞判定
    "wipLimits": { "doing": 5 },
    "sources": { "folderWatch": true, "briefOnOpen": true, "bidWatch": false },
    "workdirs": ["research"]           // 预留：多个项目根
  },
  "engagements": [{
    "id": "eng_7f3a2b",               // eng_ + 6 hex
    "name": "某环境投资集团",         // 看板标题
    "company": "某环境投资集团有限公司", // 工商全称
    "shortName": "某环境",
    "dir": "某环境投资集团-20261013", // research 下目录名；无目录时为空
    "stage": "discovery",
    "stageSince": "ISO8601",
    "paused": false,
    "priority": "high",                // high | normal | low
    "owner": "Neo",
    "tags": ["水务", "国企"],
    "source": { "kind": "manual", "ref": "", "at": "ISO8601" }, // manual|import|folder|bid|agent
    "value": { "amount": 0, "currency": "CNY", "note": "" },
    "nextAction": { "text": "补 KPI 假设第三段", "due": "2026-11-10", "owner": "Neo" },
    "stakeholders": [
      { "name": "张三", "role": "董事长", "level": "top", "stance": "", "verified": false }
      // level: top 一把手 | vp 分管 | exec 执行层 | unknown
    ],
    "gateState": {                     // 每阶段门禁的人工确认与结果
      "lead": { "status": "pass", "checks": {}, "at": "ISO8601" },
      "discovery": {
        "status": "pending",           // pending | pass | failed | forced
        "checks": { "subject_locked": { "status": "pass", "evidence": "地址锚定：…", "at": "ISO8601" } },
        "forced": false, "reason": "", "at": "ISO8601"
      }
    },
    "attention": null,                 // 显式注意力，见 §5
    "sessionId": "",                   // 最近一次 handoff 的 DSH session
    "createdAt": "ISO8601",
    "adopted": false,                  // 是否从旧目录导入
    "timeline": [ { "at": "ISO8601", "kind": "stage|note|session|report|gate|created", "text": "", "by": "human|agent|system" } ]
  }],
  "items": [{
    "id": "itm_1a2b3c",
    "engagementId": "eng_7f3a2b",     // 可空（独立任务）
    "title": "补齐 KPI 假设",
    "type": "research",
    "stage": "doing",                  // inbox|todo|doing|waiting|review|done|canceled
    "priority": "normal",
    "due": "2026-11-10",              // 可空
    "owner": "agent",                  // human | agent | both
    "source": { "kind": "manual", "ref": "", "at": "ISO8601" },
    "autonomy": { "mode": "observe", "rule": "" },  // 该任务执行时的自主性
    "attention": null,                 // 显式注意力
    "reports": [ { "at": "ISO8601", "kind": "progress|ready|blocked|failed|dropped", "text": "", "artifacts": [] } ],
    "sessionId": "",
    "createdAt": "ISO8601",
    "history": [ { "at": "ISO8601", "kind": "created|moved|updated|report|attention", "text": "", "by": "human|agent|system" } ]
  }],
  "proposals": [{
    "id": "prp_9c8d7e",
    "ruleId": "stall",
    "engagementId": "eng_7f3a2b",
    "itemId": "",
    "kind": "nudge|create_item|start_session|update_next",
    "title": "某环境投资集团已停滞 16 天",
    "detail": "建议：安排一次跟进，或标记暂停",
    "payload": {},                     // 执行所需参数
    "status": "pending",               // pending | accepted | dismissed
    "createdAt": "ISO8601",
    "decidedAt": ""
  }],
  "activity": [ { "at": "ISO8601", "kind": "created|moved|gate|attention|report|adopt|proposal", "text": "", "engagementId": "", "itemId": "", "by": "human|agent|system" } ]
}
```

### 3.1 校验规则

- `id` 唯一；`engagementId` 必须存在于 engagements（items）；`proposals` 引用必须存在或置空。
- `stage` 必须是 schema 中定义的 key；非法值拒绝写入并返回 `{ok:false, reason}`。
- 所有 `at` 为 ISO8601 字符串；`due` 为 `YYYY-MM-DD` 或空。
- `activity` 只保留最近 300 条；`timeline` 每客户保留最近 200 条。
- 写盘前备份现有 board；写入失败不破坏旧文件。
- 文件不存在时 `ensureBoard()` 生成空 board（不自动导入）。

## 4. 宿主 API 契约

统一前缀 `/research-workbench/api/fde/`。所有请求同源校验沿用现有守卫；路径参数只接受 board 内的 id，不拼接用户路径。

| 方法 | 路径 | 用途 | 请求 | 响应 |
|---|---|---|---|---|
| GET | `board` | 看板全量 | `?view=board|brief` | `{ok, board, meta, stats}` |
| GET | `brief` | 今日简报 | — | `{ok, brief}` |
| POST | `engagement` | 客户增改移 | `{action, id?, patch?}` | `{ok, engagement, board?}` |
| POST | `item` | 任务增改移/回报 | `{action, id?, patch?}` | `{ok, item, board?}` |
| POST | `attention` | 提问/解决 | `{action:'ask'|'resolve', target:'engagement'|'item', id, question?, kind?, answer?}` | `{ok, attention}` |
| POST | `gate` | 门禁评估/放行 | `{engagementId, stage?, force?, reason?, checks?}` | `{ok, gate, missing[]}` |
| POST | `adopt` | 扫描/导入旧项目 | `{action:'scan'|'apply', dirs?}` | `{ok, candidates?, board?}` |
| POST | `handoff` | 按阶段发起会话 | `{target:'engagement'|'item', id, intent?}` | `{ok, sessionId, prompt}` |
| POST | `proposal` | 采纳/忽略建议 | `{id, action:'accept'|'dismiss'}` | `{ok, board?}` |
| POST | `settings` | 修改设置 | `{patch}` | `{ok, settings}` |
| POST | `sync` | 重扫工件/刷新派生数据 | `{engagementId?}` | `{ok, board, refreshed}` |
| GET | `health` | 自检 | — | `{ok, checks:[{name, status, detail}]}` |
| GET | `meta` | 阶段/泳道/门禁定义 | — | `{ok, meta}` |

**错误契约**：所有路由失败返回 `{ok:false, reason, code?}`（`code` 取 `INVALID` / `BLOCKED` / `NOT_FOUND` / `CONFLICT` / `INTERNAL`），HTTP 状态码 400/409/404/500 对应；不得返回堆栈。

**缓存**：`board`/`brief`/`sync` 的派生扫描按「目录 mtime + 文件数 + board mtime」签名做进程内 TTL 缓存（默认 5 秒，`settings.cacheTtlMs` 可调）；写操作清空缓存。禁止每次请求全树递归 212MB。

### 4.1 关键语义

- **移动阶段**：`engagement action=move` 必须过门禁；门禁未过时返回 `{ok:false, blocked:true, missing}`，面板显示缺项；带 `force:true, reason` 可强制，`gateState` 记 `forced`。
- **移动泳道**：`item action=move` 直接移动；进入 `done` 要求至少 1 条 `report` 或人工 `evidence` 文本，否则返回缺证据提示（可 `force`）。
- **回报**：`item action=report {kind, text, artifacts?}`；`ready` 自动把 item 移到 `review`；`blocked` 移到 `waiting` 并生成 attention；`failed` 保持 `doing` 并生成 attention；`dropped` 移到 `canceled`。agent 只能操作自己会话关联的 item（v1 由工具层校验 `sessionId` 可选匹配，失败仅警告不阻断）。
- **注意力**：`attention action=ask` 在 engagement/item 上写 `attention = {kind, question, askedAt, askedBy}`；`resolve` 清空并记录答案。派生注意力（逾期/停滞/待审）不写入文件，读取时计算。
- **采纳建议**：`accept` 时按 `payload` 执行（`create_item`/`start_session` 等）；`observe` 模式下也允许人工采纳。
- **handoff**：创建会话（复用现有 `sessionController.create` + `prompt`），提示词见 §9；成功后写 `sessionId` 与 timeline。工作区选择：优先当前会话/工作区，其次 `updatedAt` 最新；不得在多工作区时盲选最新（现有缺陷，见 `docs/research/current-workbench.md` §1.4）。**目标为客户时自动创建/复用一个执行任务（item）并把 itemId 写进提示词**，否则回报指令无法定位对象（闭环断点）。
- **并发写**：board 带 `revision`，写入做乐观并发校验。显式传入 `expectedRevision` 且不匹配 → `{ok:false, code:'CONFLICT'}`；未显式传参但内存快照 revision 落后于磁盘 → 安全跳过写入（`{ok:true, staleSkipped:true}`），不得覆盖并发写。读-算-写路径写前重读磁盘合并；派生数据（工件摘要/派生注意力）不得写进 board；`brief apply` 只写真实状态变更。
- **审计留痕**：timeline/activity 的 `by` 如实记 `human`（HTTP 面板）或 `agent`（工具调用），不得硬编码。
- **health**：校验 board 可读、备份目录存在、skills 可注册、目录可写、schema 版本匹配；返回逐项状态。

## 5. 注意力模型

派生规则（读取时计算，不去重写文件），按优先级排序：

| 序 | kind | 条件 | 文案 | 动作 |
|---|---|---|---|---|
| 1 | `blocked` | item.attention.kind=blocked 或 report.kind=blocked | 「受阻：…」 | 打开抽屉 / 解决 |
| 2 | `decision` | engagement.attention / item.attention kind=decision | 「需要决定：…」 | 回答 / 采纳 |
| 3 | `review` | item.stage=review | 「待审阅：…」 | 通过 / 退回 |
| 4 | `answer` | attention.kind=answer | 「需要回答：…」 | 回答 |
| 5 | `overdue` | nextAction.due 或 item.due < 今天 | 「逾期 N 天：…」 | 改期 / 完成 |
| 6 | `gate` | 当前阶段自动检查全过、人工项缺失、阶段停留 > 7 天 | 「门禁待确认：…」 | 去确认 |
| 7 | `stall` | 活跃阶段停留 > stallDays 且无近期活动 | 「停滞 N 天」 | 跟进 / 暂停 |
| 8 | `proposal` | proposals.status=pending（observe 模式） | 建议标题 | 采纳 / 忽略 |

排序：blocked > decision > review > answer > overdue > gate > stall > proposal；同级按到期日升序，再按优先级。

## 6. 自主性策略

| 模式 | 规则生成 | 自动动作 | 人工确认 |
|---|---|---|---|
| `observe`（默认） | 生成 proposals，展示「待采纳」 | 无 | 全部 |
| `assisted` | 同 observe | 安全动作可一键执行：建 item、改 nextAction、标逾期 | 门禁、对外材料、删除/归档 |
| `auto` | 同 observe | 自动执行安全动作：建 item、改 nextAction、提醒 | 门禁、对外材料、删除/归档、阶段推进 |

**硬红线（任何模式都不自动）**：推进 engagement 阶段、通过门禁、标记交付/验收完成、导出/发送对外材料、删除客户或任务、修改客户卷定稿文件。这些操作只能由人执行；agent 可以准备、建议、提醒。

规则清单（v1，`src/host/fde-rules.js`）：

| ruleId | 条件 | 生成 |
|---|---|---|
| `stall` | 活跃阶段停留 > stallDays | nudge：跟进或暂停 |
| `due_soon` | nextAction 或 item 2 天内到期 | nudge：提醒 |
| `overdue` | 已逾期 | update_next：改期/完成 |
| `no_next` | 无 nextAction | update_next：补下一步 |
| `gate_ready` | 自动检查全过、人工缺失、停留 > 7 天 | start_session：补齐门禁 |
| `meeting_soon` | 有 meeting 类 item 48 小时内到期 | start_session：会面材料 |
| `review_lag` | review 停留 > 3 天 | nudge：尽快审阅 |

规则只在「读取 board / 生成 brief / 手动刷新」时求值（无后台定时器，避免第二套自动引擎）；同一规则对同一对象 24 小时内不重复生成。

## 7. agent 工具契约

v1 新增 6 个工具，全部调用与宿主路由相同的宿主函数（一份实现，两个调用方）。
> v1.3 追加：FDE 工具共 **11 个**（原 7 个 + `fde_library`/`fde_scenario`/`fde_quote` + 兼容保留 `scys_fde`），见 §19.5、§21；宿主注册工具总数 16（rw_* 5 + FDE 11）。参数与返回：

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `fde_board` | `{view?: 'board'|'brief'|'engagement'|'item', id?, engagementId?, stage?, limit?}` | 结构化数据 + `{hint}` | 读；brief 含注意力、到期、建议 |
| `fde_engagement` | `{action:'create'|'update'|'move'|'gate'|'archive', id?, patch?, force?, reason?}` | `{ok, engagement, missing?}` | **move/archive/门禁勾选与 force 只能由人执行**：工具层对 agent 直接拒绝（`code:BLOCKED`），gate 只读评估允许。阶段推进/归档必须由人在面板操作 |
| `fde_item` | `{action:'create'|'update'|'move'|'report', id?, patch?, report?}` | `{ok, item, attention?}` | report 触发 §4.1 语义；**delete 不提供**：删除只能由人在面板执行（红线） |
| `fde_attention` | `{action:'ask'|'resolve'|'list', target?, id?, question?, kind?, answer?}` | `{ok, attention, list?}` | agent 提问的唯一通道 |
| `fde_brief` | `{period?: 'today'|'week', apply?: boolean}` | `{ok, brief, proposals}` | `apply=true` 时按自主性模式执行安全动作 |
| `fde_harvest` | `{engagementId?, itemId?, text, targets?: ('pitfall'|'method'|'skill')[]}` | `{ok, draftPath}` | 复盘草稿写入 `research/.fde/drafts/`（状态区，可回滚），并给出「移到 docs/retros/ 或客户卷」的沉淀建议；发布由人执行 |

所有工具：参数校验失败返回 `{ok:false, reason}`；不抛异常；不写客户卷定稿文件；不越过 §6 红线。工具描述用中文，写清触发时机与边界。

## 8. 面板信息架构

侧边栏图标保持 `researchworkbench`（沿用已注册 key，避免新增安装），标题改「FDE 工作站」。
> v1.3 覆盖：主面板为 **9 个页签**——今日 / 看板 / 客户 / **流程** / **资料库** / 招采 / 工件 / 方法 / 设置（第 8 页签「生财」已由「资料库」替换），详见 §19.6、§20.5。以下 v1 六页签描述保留为历史基线。

### 8.1 今日（Today）
- 顶部：问候 + 一句话战况（活跃客户 N、待处理 M、今日到期 K、逾期 J）+ 自主性徽章 + 刷新。
- 左栏「待我处理」：注意力列表（kind 徽章 + 标题 + 客户 + 时间 + 两个动作按钮）；空态显示「今天没有需要你处理的事」。
- 右栏「建议」：proposals 列表（采纳/忽略）；「今日焦点」：按优先级/到期取前 3 个客户；「最近活动」：10 条。

### 8.2 看板（Board）
- 工具栏：模式切换（客户/任务）、搜索、优先级筛选、自主性徽章。
- 客户模式：7 列（lead→adoption，含空列），列头显示阶段名 + 数量 + WIP 提示；卡片可拖拽移动；未过门禁的拖拽弹出缺项确认；卡片内容：名称、优先级点、停留天数、下一步 + 到期、注意力点、门禁进度点、工件数。
- 任务模式：5 列（todo/doing/waiting/review/done），按客户筛选，WIP 限制提示；卡片可拖拽。
- 卡片点击 → 右侧抽屉。

### 8.3 客户（Customers）
- 列表/表格：名称、阶段、优先级、下一步、到期、停留天数、注意力；搜索与筛选；「导入现有项目」按钮（adopt scan）。
- 点击 → 抽屉。

### 8.4 工件（Artifacts）
- 按客户/阶段分组列出 md/pdf/docx；显示路径、修改时间、状态；操作：Finder 显示 / 打开 / 导出 PDF（沿用现有路由）。
- 顶部「素材」区沿用原素材能力（散落文件盘点）。

### 8.5 方法（Methods）
- 保留原「方法」页：methods/reference/skills 列表与点开即读。
- 新增「技能」区：列出 FDE skills 名称、描述、触发时机。

### 8.6 设置（Settings）
- 自主性（observe/assisted/auto，说明差异与红线）。
- 停滞天数、WIP 上限、规则开关。
- 健康检查：运行 `/health` 展示逐项状态。
- 兼容提示：宿主未重启时显示「新功能需重启 DSH 后生效」并给出可操作说明（不白屏）。

### 8.7 抽屉（Drawer）
- 客户抽屉：阶段步进条（可点击推进，受门禁）、门禁清单（自动项 + 人工勾选 + 证据输入）、下一步编辑、干系人表、工件列表、时间线、按钮：启动会话 / 编辑 / 暂停 / 归档。
- 任务抽屉：标题/类型/泳道/优先级/到期/归属、回报历史、关联会话、按钮：启动会话 / 回报（人工）/ 删除（确认）。

### 8.8 视觉与交互约束
- 只用 `--dsw-alias-*` 主题 token；明暗主题都可读；圆角/间距/字号与宿主管理页一致。
- 拖拽用 HTML5 DnD；键盘可达：卡片可 Tab 聚焦，Enter 打开抽屉，Alt+方向键移动泳道。
- 所有破坏性操作二次确认；错误以行内提示展示，不弹 alert。
- 空态、加载态、失败态都要有；失败态显示原因与重试。

## 9. 会话交接（handoff）提示词

按目标阶段生成任务提示，固定包含：①角色与唯一编排声明；②客户上下文（名称、目录、阶段、缺的门禁、下一步）；③要加载的技能与方法；④产物落盘路径与命名；⑤回报要求（用 `fde_item report`，≤300 字摘要 + 文件路径）。模板放 `src/host/fde-prompts.js`，按 stage/intent 生成。

示例（discovery）：

```
你是 FDE 工作站的执行会话，负责客户「{name}」的研判阶段。
工作区：{root}｜客户目录：{dir}
当前缺口：{missing}
先读技能 fde-discovery 与方法文件 methods/00-调研执行流程.md，按「先锁主体、再研究特征」执行：
1) 补主体锁定结论（地址锚定 + 三链验证）…
2) 事实分级（A/B/C）写入 research/事实核查清单.md
3) KPI 假设写入 research/KPI与痛点假设.md
完成后调用 fde_item action=report（id={itemId}，kind=ready，text≤300 字，artifacts=[…]），不要自行推进阶段门禁。
```

> 客户目标的 handoff 由宿主先创建一个执行任务并把 `itemId` 写进提示词；没有 item 的回报一律视为无效。

## 10. agent skills（v1 为 9 个；v1.3 起 11 个，新增 `fde-scoping`；另有 1 个通用技能 `longdoc-brief`）

全部放插件 `skills/<name>/SKILL.md`，由宿主在 apply 时通过 `ctx.get('skills').register()` 注册为 runtime skill；服务不可用时降级为系统提示词列出路径。每个 skill 必须有 `name`/`description` 前置元数据，正文写触发时机、输入、步骤、产物路径、边界。

| skill | 触发 | 产物 | 边界 |
|---|---|---|---|
| `fde-engagement` | 进入 FDE 工作、问「今天该做什么/客户到哪一步」 | 看板操作、简报、阶段推进建议 | 不自动过门禁 |
| `fde-discovery` | 调研某客户、锁主体、KPI 假设 | 事实核查清单、KPI 假设 | 证据不足标 C，不做事实陈述 |
| `fde-meeting` | 准备会面、见某人 | Brief、底稿、合作地图 | 对象分层；不报价 |
| `fde-solution` | 出方案、合作地图、领域模型分工 | 方案 md、多版本 | 边界纪律必写 |
| `fde-pilot` | 试点设计、POC、成功指标 | 试点方案、验收口径 | 范围控制，不承诺资源 |
| `fde-delivery` | 交付实施、验收、风险 | 实施计划、验收清单、风险登记 | 变更走确认 |
| `fde-adoption` | 培训、使用证据、扩展 | 价值证明、扩展地图 | 证据 A/B/C |
| `fde-board` | 操作看板、周会、导入项目 | 状态更新、周报 | 唯一编排者；不并行开第二套流程 |
| `fde-harvest` | 复盘、事故、方法沉淀 | 复盘 md、坑卡草案 | 脱敏；不写死客户信息到方法论 |
| `fde-bid-radar`（v1.1 追加） | 查某单位采购史/中标、找招标机会、会面前补采购证据 | 招采匹配、关联公告、跟进任务 | 候选人≠中标人；批次是推断；金额只引原文；数据缺口如实说 |
| `fde-scoping`（v1.3 追加） | 需求收敛、场景选择、数据体检、范围与发起人确认 | 场景评估表、数据可得性清单、范围边界 | 四条硬门槛不过不启动；评分须带依据；门禁只有人能过 |
| `longdoc-brief`（通用，非 FDE 阶段技能） | 长文（≥5 节）交付、要一页纸 / 传阅版 / 阅读版 | 一页纸、阅读版 HTML、A4 传阅版 | 一页纸是摘要不是标准说明；成品不放自评分数与认证声明；不默认导 PDF |

现有 4 个 skill（company-research / meeting-prep / proposal-forge / domain-model-partnership）保留为「方法库」，由 FDE skills 引用，不重复触发。

`longdoc-brief` 是通用一页纸技能（非 FDE 阶段技能），由 `fde-solution` / `fde-delivery` 的长文产物引用；插件注册时与其他技能一起注册，未重载前不出现。

## 11. 兼容与迁移

- **不迁移目录**：`research/<客户>/` 原样保留；board 通过 `dir` 关联。
- **旧路由/工具/页签全部保留**：旧五页签内容并入新 IA（项目→客户、产物→工件、素材→工件内、方法→方法）。
- **宿主未重启**：客户端启动探测 `/fde/meta`；404 时显示兼容页并保留旧面板入口（`经典模式` 按钮），不白屏。
- **首次启用**：board 为空 → 今日页引导「扫描现有项目 → 确认导入」，不自动写入。
- **升级**：`board.version` 更高时拒绝写入并提示；版本相同直接读。
- **可回滚**：删除 `research/.fde/` 即回到旧工作台（旧功能不依赖该目录）。

## 12. 非目标（v1 明确不做）

IM/邮件接入、定时后台任务、多用户与权限系统、金额预测、自动对外发送、自动修改客户卷定稿、看板图表统计（只做计数）、移动端适配、多语言。

## 13. 验收标准

每条可一对一写成测试：

1. **A1 看板读取**：给定含 2 客户 3 任务的 board 文件，`GET board` 返回同样的对象与 `meta`，`stats` 计数正确。
2. **A2 阶段门禁**：`discovery` 未满足自动检查时 `move` 返回 `blocked:true` 与 `missing` 列表；满足后成功且 `stageSince` 更新。
3. **A3 强制推进**：`move {force:true, reason}` 成功，`gateState.<stage>.forced=true` 且 timeline 有记录。
4. **A4 任务回报**：`item action=report kind=ready` 后任务进入 `review` 且 reports 追加；`blocked` 进入 `waiting` 且生成 attention。
5. **A5 注意力**：逾期客户出现在 brief 的 attention 中且排序正确；解决后消失。
6. **A6 导入**：`adopt scan` 识别含 `00-项目档案.md` 的目录并给建议阶段；`apply` 后进入 board 且不重复导入。
7. **A7 建议**：`stall` 规则对停滞客户生成 proposal；`accept` 后执行 payload 并标记 accepted；24h 内不重复。
8. **A8 路径安全**：`dir` 含 `../` 或绝对路径时被拒绝。
9. **A9 原子写**：写入失败时不破坏旧 board，备份文件存在。
10. **A10 工具域**：6 个工具注册成功且 schema 合法（v1 历史条目；v1.3 起为 16 个工具/11 个 FDE 工具，见 §19.5/§21）；工具调用与 HTTP 调用结果一致。
11. **A11 面板**：模块 id 正确；6 页签存在（v1 历史；v1.3 为 9 页签，见 §20.5）；只引用主题 token；无 Harness Client 包导入；API 路径统一前缀。
12. **A12 技能**：9 个 SKILL.md 有合法前置元数据（v1 历史；v1.3 为 11 个 FDE 技能 + 4 个方法库）；宿主注册失败时降级不报错。
13. **A13 兼容**：宿主缺失 `/fde/meta` 时面板显示兼容页；旧 `rw_*` 工具与旧路由仍可用。
14. **A14 健康检查**：`/health` 全绿；人为破坏 board 后返回失败项而不是抛异常。

## 14. 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 宿主改动需重启，用户未重启 | 高 | 新面板调旧宿主 | 兼容页 + 经典模式 + 明确重启提示 |
| 单文件 client.js 变大后难维护 | 中 | 改一处坏一处 | 分区注释 + 静态测试 + 组件拆分约定 |
| board 状态与磁盘目录漂移 | 中 | 工件视图不准 | sync 时重扫；不做双向写；目录是工件的事实来源 |
| 规则引擎提示噪音过多 | 中 | 人忽略注意力 | 默认 observe、去重、上限 8 条、可逐条关闭 |
| 现有项目误导入 | 低 | 看板脏 | 导入需人工确认；可归档/删除 |
| 删除/归档误操作 | 低 | 数据丢失 | 二次确认 + 写前备份 + 不删目录 |

回滚：停用插件（或删除 `research/.fde/`），旧工作台功能不受影响。

## 15. 证据与出处

- 阶段/门禁/注意力/自主性设计：综合 `docs/research/superagent-extract.md` 与 `docs/research/handbook-extract.md`。
- 产品形态与流程：`docs/00-intent.md`、`docs/evaluation.md`。
- 现有实现约束：`docs/research/current-workbench.md`。

## 16. 实施硬约束（违反即打回）

1. **零新依赖**：宿主半与客户端半都不得新增 npm 运行时依赖；不得 `import '@deepseek-ai/*'`。服务一律 `svcOf(ctx, name)` 懒取 + 容错。
2. **复用安全栈**：所有新路由必须走现有 `makeGuard`（方法白名单 → 同源/回环 fence → JSON 限制）与 `paths.*`（`safeRoot`/`safeProjectPath`/`safeDirName`）；不得把 query 直接 `resolve()` 后读写；不得出工作区。
3. **状态落点唯一**：只写 `research/.fde/`；不写 `research/<客户>/` 正文（handoff 除外，由会话写）；不写 localStorage 作为事实源。
4. **原子写 + 先备份**：board 写前备份、临时文件 + rename；写失败保留旧文件。删除/归档只改 board，不删目录。
5. **单一事实来源**：阶段/泳道/门禁 key 只在 `src/host/fde-schema.js` 定义一次；客户端不得硬编码阶段顺序（从 `/meta` 读）；宿主提示词、工具描述、路由校验都从 schema 派生。加对齐测试。
6. **验证同步**：新增路由要同步 `verify/security.mjs`（现写死 12 条）与 `verify/host-smoke.mjs`；改面板文案要同步 `verify/client-static.mjs` 字面量；`verify/all.mjs` 加入新测试。
7. **时间口径**：存储用 ISO8601（UTC）；展示与「今天」按本地时区计算；目录名日期一律本地日期（修现有 `toISOString` 缺陷）。
8. **性能**：派生扫描走 TTL 缓存（§4）；不得在轮询路径上重复全树递归；面板轮询 ≥10 秒。
9. **技能注册**：`ctx.get('skills')` 存在时注册 `skills/*/SKILL.md`（name/description/content + resourceBase 目录）；不存在时静默降级，不影响插件启动。
10. **兼容与降级**：旧 5 工具、12 路由、`handoff`、`reveal` 三通道、`hasSession:false` 剪贴板降级全部保留。
11. **文档与产物**：实质改动先有 spec/plan；完成后更新 `README.md`、`AGENTS.md`、`docs/`、系统提示词；长产物落盘。
12. **不得把现状当回归**：测试红了先判断是实现坏了还是断言过期；过期断言要同步改，不能为了变绿删测试。

## 17. 招采雷达集成（v1.1，2026-11-03 追加）

> 目标：把 `@local/bid-intel`（招采雷达，本地索引实测 24,208 条）并入 FDE 工作站：客户抽屉能看到「这家单位/公司什么时候招过什么、谁中标、最近有什么招标信号」，看板与今日能据此产生建议，agent 工具能检索与关联。
> 依赖方向：**FDE 依赖 bid-intel 的只读服务，不反向依赖**；bid-intel 未装载/未升级时 FDE 全量降级，不报错、不白屏。

### 17.1 bid-intel 对外契约（新增，只读）

bid-intel 在 apply 时执行 `ctx.provide('bidIntel', service)`，service 必须包含：

| 方法 | 签名 | 说明 |
|---|---|---|
| `version` | `1` | 契约版本；FDE 只接受 `1` |
| `dataMeta()` | `{file, mtime, bytes, records, missing}` | 索引文件元信息（缓存签名用） |
| `stats()` | 同 `bid-intel/src/host/store.js#stats` | 总条数/来源/年份/覆盖率 |
| `search(opts)` | `opts{mode, q, from, to, source, limit, offset}` → `{total, direct, mentioned, items, facets}` | 检索 |
| `timeline(opts)` | 同 store | 按月聚合 |
| `batches(opts)` | 同 store | 批次推断（推断口径，不得当公告明示） |
| `report(opts, meta)` | markdown 字符串 | 报告生成 |

`dataMeta().mtime + records` 是 FDE 匹配缓存的失效键。服务不可用（未装载/旧版本）时 FDE 所有 bids 路由返回 `{ok:true, available:false, reason}`，panel 显示「招采雷达未就绪（bid-intel 未装载或未升级）」，不报错。

### 17.2 engagement / item 新增字段

```jsonc
// engagement
"bidWatch": {
  "enabled": true,                 // 默认 true；暂停/归档客户不参与信号
  "keywords": [],                  // 额外关键词（可选）
  "links": [                       // 人/agent 明确关联的公告（持久化）
    { "bidId": "aecc-ebidding:...", "title": "", "date": "2026-04-28", "url": "https://...",
      "relation": "buyer|winner|candidate|mention|tender", "note": "", "linkedAt": "ISO8601", "by": "human|agent" }
  ],
  "lastMatchAt": "ISO8601"
}
// item 追加
"bidRefs": [ { "bidId": "", "title": "", "date": "", "url": "", "relation": "" } ]
```

派生数据（不落盘）：board/brief 响应中每个 engagement 追加 `bids: {available, total, tender, award, candidate, latest, matches[≤5], queries[]}`；全局 `bidStats: {available, records, dateRange, engagedCount}`。

### 17.3 匹配与分类（确定性，不用模型）

- 查询词：`company`（全称）、`shortName`、`name`、`dir` 去年份后缀、`bidWatch.keywords`；去噪（长度≥2、去「有限公司/集团/研究院」等后缀后仍≥2 才保留），最多 8 个。
- 每个查询词调 `search({mode:'buyer'})` 与 `search({mode:'company'})`，各取 limit 50；按 `record.id` 合并去重。
- 关系分类优先级：`buyer`（该单位发布的采购）→ `winner`（我们的客户是中标人）→ `candidate`（候选人，**不是中标**）→ `mention`（全文提及）；`kind` 含招标/采购/询价/竞争性谈判 → 标 `tender:true`，含 中标/成交/结果 → `award:true`。
- 输出按日期倒序；统计 `total/tender/award/candidate/latest`。**不对金额做求和**（金额原始文本口径不一，只原样展示）。另返回 `approxTotal`＝各查询 `search.total` 的最大值（索引中该客户的量级）；面板/工具展示「相关 ≈approxTotal（采样 total 条）」，**不把采样数当总量**。
- 缓存：分两级——① 单查询搜索缓存以 `dataMeta().mtime` 为失效键；② engagement 匹配摘要缓存 key = engagement.id + queries 签名，TTL 5 分钟，`POST /fde/bids/refresh` 或面板「刷新」强制失效。采集到新数据后最多 5 分钟内摘要可能滞后，属可接受口径（面板 stats 显示索引更新时间）。

### 17.4 新增路由（挂在 `/research-workbench/api/fde/`，全走 makeGuard）

| 方法 | 路径 | 请求/响应 |
|---|---|---|
| GET | `bids/stats` | `{ok, available, stats, dataMeta}` |
| GET | `bids/search` | `?q&mode&from&to&source&limit&engagementId?` → `{ok, available, total, items, facets, relation?}`；给 engagementId 时每项附 `relation` |
| GET | `bids/match` | `?engagementId&refresh=1` → `{ok, available, stats, queries, items(≤50), linked}` |
| POST | `bids/link` | `{engagementId, itemId?, bidId, relation?, note?}` → 写 links + timeline（`by` 如实） |
| POST | `bids/unlink` | `{engagementId, bidId}` |
| POST | `bids/promote` | `{engagementId, bidId}` → 建 item「跟进招标：<title>」（stage=todo/type=followup）+ item.bidRefs + link，返回 `{item, link}` |
| POST | `bids/refresh` | `{engagementId?}` → 清缓存并返回最新 match |

`bids/search` 的 `mode` 缺省 `any`；返回条数 ≤50；未命中返回空数组，不报错。

### 17.5 工具 `fde_bid`（第 7 个 FDE 工具）

`{action:'search'|'match'|'link'|'unlink'|'promote'|'timeline', engagementId?, itemId?, bidId?, q?, mode?, from?, to?, relation?, note?, limit?}`

- `search/match`：只读，返回紧凑列表（≤20）＋总数＋口径提示「候选人≠中标人」。
- `link/unlink/promote`：允许 agent（附加/可逆；`by:'agent'` 留痕）；promote 建 item 属安全动作。
- 招采雷达不可用时返回 `{ok:false, reason:'招采雷达未就绪', code:'UNAVAILABLE'}`，不抛异常。
- 会话里做全量深挖仍用 bid-intel 的 `bid_search / bid_batches / bid_report`；FDE 的 `fde_bid` 只管「与客户关联」这一层。**不新增第二套检索语义**。

### 17.6 规则 `bid_signal`

`settings.sources.bidWatch === true` 时，对每个活跃且未暂停客户（有查询词）检索近 `bidSignalDays`（默认 30 天）：
- 命中「招标/采购/询价/竞争性谈判」类公告且关系为 buyer/mention → 生成 proposal `bid_signal`：「发现招采信号：<buyer> 发布《title》（date）」payload `{kind:'create_item', engagementId, bidId, ...}`；
- 同一 engagement+bidId 已有 pending/accepted proposal → 跳过；dismissed → 30 天内不再生成；
- 每次刷新最多新增 3 条/客户，总数仍受 pending 上限 8 约束；
- 只生成建议，不自动建任务（observe）；assisted/auto 下属安全动作可执行。

### 17.7 面板

- **新增第 7 个页签「招采」**：数据概况（总条数/日期区间/来源）+ 检索（q、模式、时间、来源）+ 结果列表（关系徽章：招标/中标/候选/提及；采购单位/中标人/日期/金额原文）+ 按客户匹配概览；「导入链接」在 bid-intel 路由可用时显示（失败隐藏）。
- **客户抽屉新增「招采雷达」区**：统计徽章（相关 ≈N（采样 M）/ 招标 A / 中标 B / 候选 C / 最近日期）；匹配列表 Top5，每条可「加入跟进」「关联」「查看原文」；已关联列表可取消关联；刷新按钮。
- **看板卡片**：有匹配时显示 `招采 N` 小徽章（tooltip 含最近日期）；`bids.available=false` 时不显示，不占位。
- **今日**：bid_signal 以 proposal 形式出现（与其它建议同一交互）；顶部战况不新增数字，避免噪音。
- **设置**：数据源区已有「招标雷达」开关（默认改为开），显示数据区间与条数；关闭后不生成信号。

### 17.8 新增/更新技能与文档

- 新技能 `fde-bid-radar`：触发时机（查某单位采购史/中标情况、找招标机会、判断竞争格局、会面前补采购证据）；步骤（search→分类→match→link/promote→回报）；口径铁律（候选人≠中标人、批次是推断、金额原文不换算、数据缺口如实说明）；边界（不臆断、不把提及当成交、不自动对外）。
- 更新 `fde-discovery`（用招采雷达补采购记录证据）、`fde-meeting`（会面前查对方近期采购与中标人）、`fde-solution`（竞争格局/历史成交）、`fde-board`（link/promote 操作）。
- 系统提示词追加：`fde_bid` 工具说明 + 招采口径三条 + 「FDE 只做客户关联层，深挖用 bid_*」。
- README/AGENTS/health-check 同步（health 增「招采雷达服务」检查项：服务可用且 records>0 为 ok，否则 warn 不 fail）。

### 17.9 验收（叠加在 §13 之上）

1. `bids/stats` 可用时返回 records>0；bid-intel 服务缺失时 available:false 且所有 bids 路由 200（不 500）。
2. 匹配分类正确：buyer/winner/candidate/mention 四类，tender/award 标记正确；重复记录去重。
3. 链接/取消链接/提升为任务：写 board、`by` 如实、timeline/activity 有记录；promote 的 item 带 bidRefs。
4. 缓存：单查询搜索缓存随数据 mtime 更新；engagement 匹配摘要在 TTL（5 分钟）内可命中缓存，`refresh` 立即失效并反映新数据。
5. bid_signal：只对近 30 天招标类、只生成 proposal、同 bid 不重复、dismissed 30 天内不重复、paused/archived 客户不生成。
6. 面板：第 7 页签存在；客户抽屉有招采区；卡片徽章条件显示；服务不可用时不白屏。
7. 红线不变：链接/提升可 agent 做；阶段推进/门禁/删除/对外仍只人做。
8. `node verify/all.mjs` 与 `verify/acceptance-audit.mjs` 全绿（新增断言并入相应套件）。

## 18. 生财 FDE 情报（v1.2，2026-11-04 追加）

> 目标：在 FDE 工作站内新增第 8 个页签「生财」，展示**生财有术社区里关于 FDE 的最新内容**（帖子 / 公众号推文 / 航海与大会 / 手册），**每天自动更新一次**。
> 语义：只读情报层——不写入生财、不替人判断、不替代 `fde_bid` 招采层。内容为社区公开摘要，原帖以链接为准。

### 18.1 数据源与凭证

- MCP endpoint：`https://mcp.scys.com/shengcai-web/mcp`（Streamable HTTP，JSON-RPC 2.0）。
- 凭证（**三路授权，按优先级解析**）：
  1. **链接授权（推荐）**：面板「设置 → 生财情报授权」粘贴授权链接或 `access_token` → `POST /fde/scys/auth` → 宿主存 `<workspace>/research/.fde/scys-auth.json`（`0600`，仅本机，可一键清除）；链接里的 `token` / `access_token` / `code` 查询参数或 `#token=` 片段由宿主自动提取。
  2. **环境变量**：`FDE_SCYS_TOKEN`（可选 `FDE_SCYS_TOKEN_EXPIRES_AT`，ISO8601 过期时间）。
  3. **兼容旧 token 文件**：只读 `~/.dsh/mcp/scys-mcp/tokens.json` 的 `access_token`（由已安装的 `dsh-plugin-scys-mcp` 维护 OAuth 轮换）。标记为「兼容路径」，**不属 DSH 官方契约**，不推荐；**不自实现 refresh_token 刷新**（避免与 MCP 插件竞争轮换）。
  - 不变量：token 不出现在响应/日志/错误/面板文本里，只放在 `Authorization: Bearer` 头；三路都失败、文件损坏或 token 过期 → `UNAUTHORIZED`，立即报错、不静默回退；写授权文件失败不破坏旧授权；清除后立即回落到下一来源。
  - 状态接口：`GET /fde/scys/auth` → `{ok, auth:{available, source:'link'|'env'|'compat'|'none', expiresAt}}`；`POST /fde/scys/auth` body `{token?|url?, clear?}` 返回同上（同路径，HTTP 恒 200，错误 `{ok:false, reason}`）。
  - 兼容旧状态目录可用 `SCYS_MCP_STATE_DIR` 环境变量覆盖（与 MCP 插件一致，便于测试）。
- 调用协议：`initialize`（protocolVersion `2025-06-18`）→ `notifications/initialized` → `tools/call`；每次刷新新建握手，不复用 session（简单、可靠、量小）。
- **只调用只读工具**：`searchTopic` / `searchTrustedContent` / `activitySearch` / `searchNavigatorContent` / `activityManualSearch`。任何写操作（点赞/投锚/评论/收藏/发帖/关注）一律不允许。

### 18.2 抓取查询（固定清单，代码常量）

| # | 工具 | 参数 | 归一 kind |
|---|---|---|---|
| 1 | `searchTopic` | `{keyword:'FDE', pageSize:20, displayMode:2}` | post |
| 2 | `searchTopic` | `{keyword:'Forward Deployed', pageSize:20, displayMode:2}` | post |
| 3 | `searchTopic` | `{keyword:'前沿部署工程师', pageSize:20, displayMode:2}` | post |
| 4 | `searchTrustedContent` | `{keyword:'FDE', pageSize:10}` | wechat |
| 5 | `activitySearch` | `{keyword:'FDE', pageSize:10}` | activity |
| 6 | `searchNavigatorContent` | `{keyword:'FDE', pageSize:10}` | navigator |
| 7 | `activityManualSearch` | `{keyword:'FDE', pageSize:10}` | manual |

- 每个 query 独立执行、独立记错：单个失败/超时不阻断整体，结果写 `queries[i].error`。
- 串行执行；单 query 超时 15s，整体预算 90s。
- 合并去重键：post 用 `topicDTO.entityId`；其余用各工具 item 的稳定 id（`itemId`/`contentId`/`id`），都没有时用 url 兜底。
- **串行与限流（实测 2026-11-04）**：7 个查询严格串行，相邻请求间隔 ≥1000ms。MCP 可能返回 `MCP_RATE_LIMITED`（`dimension=USER`，带 `retryAfterSeconds`）：按提示等待后重试一次，仍失败记 `queries[i].error`，不影响其它查询。`activityManualSearch` 最容易触发限流。
- **字段差异（实测）**：`searchNavigatorContent` 无 `total`，用 `items.length` 计数；`activitySearch` 对关键词 `FDE` 可能返回 0 条（正常，记 `count:0`，不视为错误）；`searchTrustedContent` 的 `publishedAt` 为本地时间字符串 `YYYY-MM-DD HH:mm:ss`（无时区），归一化时按本地时间解析；其 `total` 是全文匹配量级（实测 954），只展示取回的前 N 条，不把 total 当条数。
- **非 post 类相关性过滤（2026-11-04 真实冒烟后修正）**：实测 `activityManualSearch`、`searchNavigatorContent`、`searchTrustedContent` 的 keyword 匹配较宽松（`activityManualSearch` 对 `FDE` 几乎不生效，返回抖音/小红书等无关手册；navigator 混入无关夜话；trusted 混入无关推文），而 `searchTopic` 高度精确。因此对 `wechat` / `navigator` / `manual`（`activity` 同样适用）做轻量判定：`title + summary` 任一含 `FDE`（不区分大小写）、`Forward Deployed`、`前沿部署`、`部署工程师` 才保留；`post` 类不过滤。被过滤条数记入 `stats.filteredOut`（诊断用）。

### 18.3 feed 数据模型（`research/.fde/scys-fde.json`）

```jsonc
{
  "version": 1,
  "date": "2026-11-04",                 // 本地日期，用于「每天一次」判定
  "fetchedAt": "2026-11-04T12:30:00.000Z",
  "ok": true,
  "lastError": null,
  "stats": { "total": 0, "post": 0, "wechat": 0, "activity": 0, "navigator": 0, "manual": 0, "new": 0, "filteredOut": 0 },
  "queries": [ { "tool": "searchTopic", "q": "FDE", "ok": true, "count": 20, "error": null, "ms": 1200 } ],
  "items": [
    {
      "id": "xq:10000000000000001",
      "kind": "post",
      "title": "某 FDE 主题帖子（示例标题）",
      "summary": "示例摘要：不超过 200 字的纯文本……",
      "author": "某作者",
      "authorAvatar": "https://…",
      "url": "https://example.com/article/10000000000000001",
      "publishedAt": "2026-01-01T00:00:00.000Z",
      "tags": ["精华"],
      "stats": { "like": 0, "comment": 0, "read": 0, "coin": 0, "favorite": 0 },
      "isNew": true
    }
  ]
}
```

- `summary` ≤200 字纯文本（去 HTML 标签、高亮标签、markdown 标记）。
- `tags` 取值：`精华`（isDigested）、`热门`（like≥100）、`问答`（type=`q&a`）。
- `isNew`：本次刷新中不在上一版 feed 里的条目为 true（只反映最近一次刷新；旧牌不残留）。
- 存储：原子写（tmp + rename）；文件损坏 → 视为空 feed 并重建，不抛错；不写备份（缓存类数据）。

### 18.4 每天一次（更新节奏）

- 需要刷新判定：feed 不存在，或 `feed.date !== 本地今天`，或显式 `force`。
- 宿主启动后 20s 检查一次；此后每 30 分钟检查；命中则后台串行刷新（模块内 `refreshing` 单飞标记）。
- 成功 → 写 feed（`date`=今天）。失败 → 保留旧 feed，写 `lastError`，**当天最多重试 3 次**（网络不可用时避免反复请求）。
- `POST /scys/refresh` 强制刷新（不受每天一次限制，受单飞约束）。
- 定时器由 `ctx.effect(() => dispose, 'research-workbench: scys timer')` 注册清理；插件卸载即停。

### 18.5 路由（挂在 `/research-workbench/api/fde/`，全走 makeGuard）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `scys/feed` | `{ok, feed, today, stale, refreshing, code?, reason?}`；feed 缺失返回 `{ok:true, feed:null, stale:true}` |
| POST | `scys/refresh` | `{force?}` → 执行一次刷新后返回同上结构 |

- `UNAUTHORIZED`：token 缺失/过期 → `{ok:false, code:'UNAUTHORIZED', reason:'生财有术 MCP 授权已过期，请在 DSH 中重新授权'}`，同时带上次 feed。
- `UNAVAILABLE`：网络/HTTP 失败 → `{ok:false, code:'UNAVAILABLE', reason}`，同时带上次 feed。

### 18.6 工具 `scys_fde`（第 8 个 FDE 工具）

`{action:'feed'|'refresh', limit?, kind?, q?}`
- `feed`：读缓存 feed，返回紧凑列表（≤limit，默认 20）+ 统计 + `fetchedAt` + 口径提示（来源生财 MCP、摘要非全文、链接查看原文）。
- `refresh`：触发刷新并返回结果摘要（agent 可主动更新，不等后台定时器）。
- 无授权/无网络时返回 `{ok:false, code, reason}`，不抛异常。

### 18.7 面板（第 8 页签「生财」）

- 导航顺序：今日 / 看板 / 客户 / 招采 / **生财** / 工件 / 方法 / 设置。
- 顶部：数据日期 + 最后更新相对时间 + 条数 + 刷新按钮；`ok:false` 时显示错误行（含重新授权提示）。
- 筛选：类型 chip（全部 / 帖子 / 公众号 / 航海大会 / 手册）+ 关键词搜索 + 排序（最新 / 最热）。
- 卡片：kind badge + 标题（外链新窗口）+ 作者·相对时间 + 摘要（2–3 行截断）+ 标签（精华/热门/新）+ 互动数字（赞/评/读）。
- 空态：未授权 / 未刷新（可点刷新）/ 抓取失败 + 上次成功时间；数据日期不是今天时提示「今日尚未更新，宿主会自动更新」。
- 链接安全：`window.open(url, '_blank', 'noopener,noreferrer')`；仅接受 `https?://` 开头的 URL。

### 18.8 不做什么（边界）

- 不调用生财写接口（点赞/投锚/评论/收藏/发帖/关注）——这批操作永远人工。
- 不缓存全文/图片，只存 ≤200 字摘要 + 链接。
- v1 不做「一键存为客户线索/任务」（跨域写入需另行立项）。
- token 不写入任何日志/文件/前端。
- 不替代 `fde_bid`，不改 bid-intel 契约。

### 18.9 验收

1. 未授权（tokens.json 缺失/过期）：`scys/feed` 返回 `feed:null`、`refresh` 返回 `code:UNAUTHORIZED`；面板显示未授权空态，不白屏、不阻塞其它视图。
2. 同一自然日：两次 `maybeRefresh` 只抓 1 次；`force` 可再抓；失败后当天最多重试 3 次。
3. feed 原子写；损坏 JSON 自动重建；刷新失败保留旧 feed。
4. 归一化：7 个 query 结果合并去重；`summary` 去 HTML、≤200 字；tags 与新标记正确。
5. 定时器随插件卸载清理。
6. 面板：第 8 页签存在；刷新按钮触发 POST；类型/搜索/排序可用；外链新窗口。
7. `node build.mjs` 后 client.js 与源码一致；`verify/fde-scys-host.mjs`、`verify/client-static.mjs`、`verify/security.mjs`、`verify/host-smoke.mjs`、`node verify/all.mjs` 全绿。
8. 真实联网冒烟由 Lead 执行并记录（条数/耗时/日期）；无网络环境以 mock 测试为准并如实说明。

## 19. FDE 资料库（v1.3，2026-11-04 追加）

> 目标：把第 8 个页签「生财」升级为**「资料库」**：权威资料（国外官方一手 + 国内官方一手）、开源工具（GitHub）、方法与模板、社区动态（生财，保留为来源之一）统一入口；**重点推荐标注**、**每日更新**、可按来源/阶段/关键词筛选。
> 定位：**只读资料层**——不替代 `fde_bid` 招采层，不替代 `methods/` 内部方法库，不写任何外部平台，不自动对外发送。
> v1.3 起：面板不再有「生财」页签；`scys_fde` 工具与缓存**保留兼容**，生财内容并入资料库「社区动态」来源。

### 19.1 资料目录（策展层，随插件发布）

- 文件：`reference/fde-library/catalog.json`（UTF-8，单文件；由调研结果人工策展生成，改目录需发版或人工编辑）。
- 测试/诊断可用环境变量 `FDE_LIBRARY_CATALOG_PATH` 覆盖目录路径；**生产默认路径不变**，面板/工具不得依赖该变量。
- 顶层：`{version, updatedAt, notes[], groups[], items[]}`。
- `groups`（来源组，面板一级筛选）：

| key | 中文 | 说明 |
|---|---|---|
| `intl-official` | 国外官方 | OpenAI/Anthropic/Google/Microsoft/Palantir 等官方一手 |
| `cn-official` | 国内官方 | 腾讯云/阿里云/字节/华为云/百度等官方一手 |
| `opensource` | 开源工具 | GitHub 仓库（指标每日刷新） |
| `method` | 方法与模板 | 方法论、清单、模板、报告（含内部可公开方法） |
| `community` | 社区动态 | 生财 FDE 情报（来自 `scys-fde.json` 缓存，非策展） |

- `items[]` 字段（策展条目）：

```jsonc
{
  "id": "openai-practical-guide-agents",   // 稳定唯一，kebab-case；社区条目为 community:<scys id>
  "group": "intl-official",                // groups.key
  "kind": "doc|whitepaper|guide|playbook|blog|course|report|case|job|repo|template",
  "lang": "en|zh",
  "title": "A practical guide to building agents",
  "publisher": "OpenAI",                   // 发布方；repo 为 owner/name
  "url": "https://…",                      // http(s) 绝对地址
  "authority": "A|B|C",                    // A 官方一手；B 二手/媒体；C 社区/未核实
  "stages": ["scoping", "solution"],       // 适用 FDE 阶段；全流程用 ["all"]
  "topics": ["agent", "生命周期"],
  "summary": "中文摘要，≤120 字",
  "why": "为什么值得收录 / 怎么用，≤80 字",
  "featured": true,                        // 是否进「本期重点推荐」
  "featuredRank": 1,                       // 可选：人工策展位（数字小者优先，仅对 recommend=star 生效）
  "recommend": "star|recommend|backup",    // 重点推荐 / 推荐 / 备选
  "addedAt": "2026-11-04",
  "verifiedAt": "2026-11-04",              // 最近一次核实日期
  "httpStatus": 200,                       // 策展时实测；社区动态无此字段
  "note": "",                              // 可选：付费墙/需登录/中文转载等
  "repo": "openai/openai-agents-python",   // opensource / method 组中的开源课程与示例集；用于每日指标刷新
  "track": true,                           // 仅 opensource：是否参与每日 GitHub 指标刷新（默认 true，≤30 个）
  "staticMeta": { "stars": 0, "forks": 0, "license": "", "language": "", "pushedAt": "" }
}
```

- 规则：`id` 唯一；`url` 必须 `http(s)://`；同一 URL 不重复收录；`authority=A` 必须是官方域或官方账号；媒体/转载一律 B；`summary`/`why` 不得编造，未读全文的条目标 `note:"仅标题级核实"`。
- 目录规模预期：官方一手 ≥25、国内官方 ≥15、开源 ≥25、方法/模板 ≥8（首版 5 条，2026-11-04 补 3 条后达标）；社区动态由缓存动态生成（不写进 catalog）。

### 19.2 每日刷新（宿主）

- 刷新内容：① GitHub 指标（`items[].repo && track`）→ `staticMeta` 覆盖为实测 `stars/forks/license/language/pushedAt`；② 社区动态（读 `research/.fde/scys-fde.json`，映射为 `group:"community"` 条目）；③ 策展条目的 `isNew`（与上一版缓存比对）与 `updated`（GitHub 指标变化）标记。
- GitHub：`GET https://api.github.com/repos/{owner}/{name}`，`User-Agent: research-workbench/0.1`，`Accept: application/vnd.github+json`，单请求超时 10s，并发 ≤3；**不携带 token**；单日 ≤30 个仓库。
  - 失败（403/429/网络）不阻断整体：保留 `staticMeta` 旧值，`sources.github.errors[]` 记录；`feed.ok` 仍为 true，`feed.warnings[]` 提示「GitHub 指标未更新」。
- 社区：只读 `scys-fde.json`（不重复调用 MCP）；取 `items` 映射：`id:"community:"+x.id`、`group:"community"`、`kind:"post"`、`authority:"C"`、`stages:["all"]`、`summary`、`url`、`publishedAt`、`stats`、`tags`。缓存缺失时社区来源为空，不报错。
- 每日一次：缓存缺失 / `feed.date !== 本地今天` / `force` 时刷新；宿主启动后 20s 检查、此后每 30 分钟检查；单飞；失败保留旧 feed，当天最多重试 3 次。
- 原子写：`tmp + rename`；损坏 JSON 视为空缓存；不写备份（缓存类）。
- **不刷新任意网页正文**：策展条目的内容只在发版/人工编辑时更新，避免不可控抓取与版权风险。

### 19.3 缓存数据模型（`research/.fde/fde-library.json`）

```jsonc
{
  "version": 1,
  "date": "2026-11-04",                       // 本地日期，用于每日一次判定
  "fetchedAt": "2026-11-04T13:30:00.000Z",
  "ok": true,
  "lastError": null,
  "catalogVersion": 1,
  "catalogUpdatedAt": "2026-11-04",
  "stats": { "total": 0, "intlOfficial": 0, "cnOfficial": 0, "opensource": 0, "method": 0, "community": 0, "featured": 0, "new": 0, "updated": 0 },
  "sources": [
    { "key": "catalog", "ok": true, "items": 0, "error": null },
    { "key": "github", "ok": true, "requested": 0, "okCount": 0, "errors": [] },
    { "key": "community", "ok": true, "items": 0, "date": "2026-11-04", "error": null }
  ],
  "warnings": [],
  "items": [ /* catalog item + liveMeta + isNew/updated + community 动态字段 */ ],
  "featured": ["id", "…"]                     // 重点推荐排序后的 id（≤12）
}
```

- `items[]` 在策展字段之外追加：`liveMeta`（GitHub 实测）、`isNew`（本次新增或 `addedAt` 在 7 天内）、`updated`（GitHub 指标变化）、`community` 动态字段（`author/publishedAt/stats/tags`）。
- 重点推荐排序：`recommend=star` 优先 → **`featuredRank`（人工策展位，数字小者优先；可选字段）** → `featured=true` → 权威性 A>B>C → `addedAt` 新近 → `stages` 覆盖阶段数 → stars 降序；同一来源组至少 1 条，总 ≤12。`featuredRank` 用于确保 FDE 专属资料/工具进入「本期重点推荐」，不受通用工具 star 数挤压。

### 19.4 路由（挂在 `/research-workbench/api/fde/`，走 makeGuard；业务降级 HTTP 恒 200）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `library/feed` | `{ok, feed, today, stale, refreshing, code?, reason?}`；无缓存 `{ok:true, feed:null, stale:true}` |
| POST | `library/refresh` | `{force?}` → 刷新后同上结构 |

- `UNAVAILABLE`：catalog 缺失/不可读 → `{ok:false, code:'UNAVAILABLE', reason:'资料目录缺失'}`，同时带旧 feed。
- GitHub/社区失败不返回 `ok:false`，只写 `sources` 与 `warnings`（资料库主体仍可用）。

### 19.5 工具 `fde_library`（第 9 个 FDE 工具）

`{action:'feed'|'search'|'refresh', group?, kind?, stage?, q?, featured?, limit?, root?}`

- `feed`：读缓存，返回统计 + 紧凑条目（默认 20，≤50）；`search`：在 `feed/s` 基础上按 group/kind/stage/q/featured 过滤；`refresh`：触发刷新并返回摘要。
- 每条摘要行：`[来源组/类型/A|B|C] 标题 — 发布方｜适用阶段｜一句话价值｜URL`。
- 无缓存/未授权类问题返回 `{ok:false, code, reason}` 不抛异常；**不调用任何外部写接口**。
- 口径提示：资料目录人工策展；GitHub 指标为抓取时快照；社区动态为摘要非全文；A/B/C 分级。

### 19.6 面板（第 5 页签「资料库」，替换「生财」）

导航顺序：今日 / 看板 / 客户 / **流程** / **资料库** / 招采 / 工件 / 方法 / 设置（9 项）。

- 顶部卡：标题「FDE 资料库」+ 副标题「权威资料 · 开源工具 · 方法模板 · 社区动态；目录人工策展，GitHub 指标与社区每日更新」；数据日期、更新于、总条数、来源组计数、刷新按钮。
- **本期重点推荐**：`feed.featured` 前 6 条横向卡片（★ 重点推荐徽章 + 来源组 + 类型 + A/B/C + 标题 + 一句话价值 + 阶段 chips + 外链）。
- 工具栏：来源组分段（全部/国外官方/国内官方/开源工具/方法与模板/社区动态）+ 类型筛选 + 适用阶段筛选（8 阶段）+ 关键词搜索 + 「仅看重点推荐」开关 + 排序（推荐/最新/热度）。
- 卡片：标题外链、发布方/作者、类型与权威性徽章、适用阶段 chips、摘要（≤3 行）、开源条目显示 `★ stars · license · 推送时间`、`新`/`更新`/`★重点推荐` 徽章、`查看原文` 按钮。
- 降级/空态：刷新失败但有旧数据 → 黄色提示行（含上次成功时间）；无缓存 → 空态 + 刷新按钮；筛选无结果 → 空态；catalog 缺失 → 错误行（不白屏，不阻塞其它视图）。
- 链接安全：`window.open(url,'_blank','noopener,noreferrer')`；仅接受 `^https?://`；标题/摘要一律按纯文本渲染。

### 19.7 边界（不做什么）

- 不抓取任意网页正文、不缓存全文/图片；只存摘要 + 链接（策展摘要 ≤120 字，社区摘要 ≤200 字）。
- 不自动收录/删除资料；策展条目变更走人工编辑 + 发版。
- 不调用外部写接口、不自动对外发送。
- 不替代 `fde_bid`（招采）与 `methods/`（内部方法）；不把 B/C 级资料标成 A。
- 不改 `research/<客户>/` 与 `board.json`。

### 19.8 验收

1. catalog 合法：id 唯一、url 为 http(s)、group/kind/authority/stages 枚举合法、featured/recommend 计数与统计一致。
2. 无缓存时 `library/feed` 返回 `{ok:true, feed:null, stale:true}`；面板空态可刷新。
3. 刷新后用 mock 工作区断言：GitHub 指标合并成功；单个仓库 403 时其它条目正常、`sources.github.errors` 有记录、`feed.ok=true`。
4. 每日一次门控：同日两次 `maybeRefresh` 只刷 1 次；`force` 可再刷；失败保留旧 feed，当天最多 3 次。
5. 社区动态来自 `scys-fde.json`，缓存缺失不报错。
6. `isNew`/`updated` 正确；featured 排序符合 §19.3。
7. 面板：第 5 页签「资料库」存在；生财页签不存在；重点推荐区、来源组/阶段筛选、搜索、仅看重点推荐、刷新、外链安全、降级态均可用。
8. `node verify/all.mjs` 全绿（含新增 `fde-library-host.mjs`）。

## 20. 流程 v2：8 阶段与阶段工具矩阵（v1.3，2026-11-04 追加）

> 目标：把当前 7 阶段补成**可执行的 8 阶段**，每阶段写清输入/动作/交付物/门禁/工具/常见坑；重点补上「场景与范围」和「成本与报价」两个真实痛点。
> 本节覆盖 §2.1 的阶段表与 §8 的导航结构；其余条款与 §2、§3 兼容。

### 20.1 engagement 阶段（v1.3 调整为 8 个）

| # | key | 中文 | 定义 | 门禁 |
|---|---|---|---|---|
| 1 | `lead` | 线索 | 已识别客户/机会，尚未研究 | `intake` |
| 2 | `discovery` | 研判 | 主体锁定、事实核查、KPI/痛点假设 | `discovery` |
| 3 | `meeting` | 会面 | Brief、底稿、合作地图、需求清单 | `meeting` |
| 4 | `scoping` | 场景 | 需求收敛、场景选择、数据体检、范围与发起人确认 | `scoping`（新增） |
| 5 | `solution` | 方案 | 方案、成本测算、报价单/SOW、边界纪律 | `solution`（加成本/报价检查） |
| 6 | `pilot` | 试点 | Pilot Charter、成功指标、验收口径、价值验证 | `pilot` |
| 7 | `delivery` | 交付 | 实施、验收、风险登记、最小文档集 | `delivery` |
| 8 | `adoption` | 采用 | 培训、使用证据、价值证明、扩展地图 | `adoption` |

- 固定顺序、不可跳阶（人工 `force` 除外）；`stageSince` 语义不变；终止状态不变。
- 迁移：新阶段只影响**进入该阶段**的门禁；已在 `solution` 及之后阶段的客户不降级。其 `solution` 门禁若缺成本/报价项，按 §20.2 补材料，或由人 `force` 并写原因。

### 20.2 门禁变更（`src/host/fde-schema.js`）

**新增 `scoping` 门禁**（进入 `scoping` 前）：

| 类型 | key | 检查 |
|---|---|---|
| auto | `scenario` | 项目目录内匹配「场景」的 md ≥1（建议 `scoping/场景评估表.md`；也接受历史 `meeting/` 下的场景选择表） |
| manual | `sponsor_named` | 有姓名的业务发起人（愿意每周投入，非礼节性挂名） |
| manual | `integration_14d` | 14 天内可完成首次数据/系统对接 |
| manual | `poc_90d` | 90 天内可生产上线并使用 |
| manual | `usage_measurable` | 使用行为可测量（有明确人群与频次） |
| manual | `criteria_scored` | 12 维评分卡已打分并逐维写明依据（空依据按 3 分封顶） |
| manual | `scenario_locked` | 场景与范围、优先级已与客户书面确认 |

> 四条硬门槛（发起人 / 14 天 / 90 天 / 可测）来自 FDE 实战口径：任何一条不满足就不启动；`fde_scenario` 工具按同一口径判定。

**`solution` 门禁新增**：

| 类型 | key | 检查 |
|---|---|---|
| auto | `cost` | 成本测算 md ≥1（`proposal/` 或文件名含「成本」） |
| auto | `quote` | 报价单/SOW md ≥1（文件名含「报价」「SOW」「工作说明书」） |
| manual | `pricing_confirmed` | 成本与报价已复核，假设/除外/变更条款已列明 |

**`pilot` 门禁人工项语义收紧**（不新增 key）：`pilot_scope` 覆盖「Pilot Charter（首次集成 ≤14 天、上线 ≤90 天、撤出 ≤120 天）+ 基线 + 成功指标 + 验收口径 + 失败退出条件 + 转正式判据」六项。
**`delivery` 门禁**保持，最小文档集纳入交付清单（Discovery Brief / Pilot Charter / ADR / Go-live Checklist / Incident Runbook / Handoff Pack；人作为验收附件检查）。

### 20.3 阶段 playbook（schema 扩展，面板从 `/meta` 读）

`ENGAGEMENT_STAGES` 每项新增 `playbook` 对象，`meta()` 原样返回：

```jsonc
"playbook": {
  "goal": "一句话目标",
  "inputs": ["输入1", "输入2"],
  "activities": ["关键动作1", "…"],
  "outputs": ["交付物1（建议路径）", "…"],
  "tools": [
    { "kind": "skill", "name": "fde-scoping", "label": "fde-scoping 技能" },
    { "kind": "method", "name": "06-场景选择与数据体检.md", "label": "场景选择与数据体检" },
    { "kind": "template", "name": "场景评估表.md", "label": "场景评估表" },
    { "kind": "tool", "name": "fde_scenario", "label": "场景评估器" }
  ],
  "pitfalls": ["常见坑1", "…"]
}
```

工具 kind 枚举：`skill` / `method` / `template` / `tool` / `library`。工具矩阵必须覆盖 §20.1 的 8 个阶段；`fde_board`/`fde_brief`/`fde_attention` 作为全程工具不逐阶段重复，`fde_library` 在每阶段至少出现一次（按阶段给不同来源组）。

### 20.4 新阶段相关产物

- item 类型新增 `scoping`（场景）；`ITEM_TYPES` 返回给面板。
- handoff 提示词新增 `scoping` 模板（`src/host/fde-prompts.js`）：目标 = 产出场景评估表 + 数据可得性清单 + 范围边界；必须用 `fde_scenario` 按四条硬门槛判定；不自行推进门禁。
- 新技能 `skills/fde-scoping/SKILL.md`（第 11 个 FDE 技能）：触发时机、输入、步骤（需求池→四条硬门槛→评分→数据体检→范围/发起人→回报）、产物路径、边界。
- 方法：`methods/06-场景选择与数据体检.md`、`methods/07-成本评估与报价.md`。
- 模板：`templates/场景评估表.md`、`templates/成本测算与报价单.md`。
- 更新技能：`fde-meeting`（会后交接待场景评估）、`fde-solution`（成本/报价必做）、`fde-board`（8 阶段、工具）、`fde-engagement`（总览加两节）、`fde-pilot`（Charter 三条时间门限）。

### 20.5 面板（新增第 4 页签「流程」）

- 顶部：8 阶段横向步进条（阶段名 + 当前客户数 + 门禁状态点）；点击切换阶段详情。
- 阶段详情卡：目标、输入、关键动作、交付物、工具（按 kind 分组的 chips）、常见坑、门禁清单（auto/manual）。
- 工具 chips 交互：`method`/`template` 点击 → 跳转「方法」页并直接打开该文件（`MethodsView` 支持 `initialName`）；`skill`/`tool` 点击 → 展示一行「在会话中这样用」示例（复制按钮）。
- 底部「阶段 × 工具」矩阵表（8 行 × 工具列，只读）。
- 空态：meta 缺 playbook 时显示「宿主未升级，请重启/重载插件」；不白屏。

### 20.6 兼容与迁移

- 新阶段 key 只在 schema 定义一次；面板列数、抽屉阶段步进、handoff 均从 meta 派生（现有代码不得再硬编码 7）。
- 旧 board 无需迁移；新阶段只对新推进生效。已有 `scoping` 需求的客户按 §20.2 补材料。
- 旧「生财」页签与 `scys_fde` 工具保留兼容（工具仍可用；面板入口移除，由资料库「社区动态」承接）。
- 回滚：停用插件或解包 `.archive/research-workbench-pre-v13-*.tar.gz`；`research/.fde/board.json` 不因升级被重写（首次写入前自动备份）。

### 20.7 验收

1. `/fde/meta` 返回 8 阶段（含 `scoping`，order 连续 1–8）与每阶段 `playbook`（字段齐全、tools 非空）。
2. 移动 `meeting → scoping` 时缺场景评估/人工四项 → `blocked` 且 `missing` 列出；补齐后成功。
3. `scoping → solution` 不跳阶；`solution` 门禁缺成本/报价 → blocked；补齐后成功。
4. 旧 board（7 阶段客户）可正常读取；不自动改写阶段。
5. 面板：9 页签；流程页可切阶段、工具 chips 可跳方法页；看板列数为 8；资料库页为第 5 项且生财不存在。
6. `verify/fde-host.mjs`、`verify/fde-client.mjs`、`verify/client-static.mjs`、`verify/client-runtime.mjs`、`verify/acceptance-audit.mjs` 同步更新并通过。

## 21. 两个交付工具：`fde_scenario` 与 `fde_quote`（v1.3，2026-11-04 追加）

> 两个**纯函数计算工具**（不写文件、不写 board、不联网）：把「场景选择」与「成本/报价」从拍脑袋变成可复核的计算。实现共享 `src/host/fde-calc.js`，工具层只做参数校验与文本渲染。

### 21.1 `fde_scenario`（场景选择评估）

参数：
```jsonc
{ "action": "evaluate|template",
  "scenarios": [{
    "name": "TQM 审核整改",
    "gates": { "sponsor": true, "integration14d": true, "prod90d": true, "measurable": true },
    "scores": { "value": 4, "pain": 4, "data": 3, "tech": 4, "accept": 3, "compliance": 4,
                "roi": 4, "readiness": 3, "delivery": 3, "reuse": 4, "alternative": 3, "timing": 4 },
    "vetoes": [],
    "note": ""
  }] }
```

- `gates` 四条硬门槛（来自某制造企业场景选择实践 + 作者实践经验口径，待验证）：**有姓名业务发起人 / 14 天内可完成首次数据或系统对接 / 90 天内可生产上线 / 使用行为可测量**。任一为 false → 结论「暂不启动（补前置条件）」并列出缺项，不进方案。
- `scores` 12 维（1–5，5 最好），权重如下（原始权重合计 **101**，工具必须按 `Σ(分值×权重)/Σ权重` **归一化**计算，不得用固定除以 100 的公式）：

| key | 维度 | 权重 | 说明 |
|---|---|---:|---|
| `value` | 业务价值与可量化收益 | 18 | 有口径/目标值才给高分 |
| `pain` | 痛点强度与频率 | 10 | 每天/每单发生 |
| `data` | 数据就绪度 | 14 | 可得、有权限、有评测基础 |
| `tech` | 技术可行性 | 12 | 同类实践可预期 |
| `accept` | 可验收性 | 10 | 有基线/口径 |
| `compliance` | 合规与安全 | 8 | 数据等级与路径清晰 |
| `roi` | 投资回报与预算匹配 | 8 | 预算明确、ROI 可算 |
| `readiness` | 客户就绪度 | 7 | 发起人/决策人有推动力 |
| `delivery` | 交付与集成风险 | 6 | **分值越高=风险越低** |
| `reuse` | 可复制性 | 4 | 跨部门/跨客户复用 |
| `alternative` | 替代方案成本（build/buy） | 3 | 自研有明显优势才高分 |
| `timing` | 时间窗与见效速度 | 1 | 4–6 周可见效 |

- `vetoes`：1–7 的否决项编号（清单见 `methods/06-场景选择与数据体检.md`：数据不可得/合规禁止/验收不可定义/无预算无决策人/只做 Demo/接口不开放/坏流程拒绝 redesign 等）。任一命中 → 结论「不进方案（例外需人签字）」。
- 档位（归一化分）：≥3.6 且 gates 全 true 且无否决 → 「进方案」；3.2–3.6 → 「补证/小 POC」；<3.2 → 「拒绝或转咨询」。
- 排序：gates 全 true 且无否决优先，再按归一化分降序；同分按 `value` 降序。
- 返回：`{ok, ranked[], markdown, template?}`；`action=template` 返回空白评分表 Markdown（12 维 + 4 门槛 + 否决项 + 依据列 + 档位说明）。

### 21.2 `fde_quote`（成本测算与报价）

参数：
```jsonc
{ "action": "calculate|template", "engagementId": "", "title": "",
  "labor": [
    { "name": "FDE/算法", "personDays": 20 },
    { "name": "数据与评测", "optimistic": 8, "likely": 10, "pessimistic": 15 }
  ],
  "defaultRate": 940,
  "nonLabor": { "dataEval": 0, "cloudToken": 0, "compliance": 0, "ops": 0, "travel": 0, "quality": 0, "other": 0 },
  "contingencyPct": 15, "taxPct": 6, "marginPct": 35, "discountPct": 0,
  "teamSize": 3, "weeks": 12 }
```
金额单位：人民币元；费率默认取 `reference/fde-pricing.json` 的 `defaults.ratePerPersonDay`（940，来自 2026-11-04 某项目内部核算口径，可改；**这是内部成本费率，不是对外报价**）。

计算（按顺序，全部返回明细）：
1. 每行人天：给 `optimistic/likely/pessimistic` 时用三点估算 `te=(o+4m+p)/6`、`σ=(p-o)/6`，**计价按 P80=te+0.84σ（向上取 0.1 人天）**，同时记录 P50=te；否则直接用 `personDays`。
2. `laborCost = Σ(计价人天 × rate || defaultRate)`
3. `nonLaborTotal = dataEval + cloudToken + compliance + ops + travel + quality + other`
4. `directCost = laborCost + nonLaborTotal`
5. `contingency = directCost × contingencyPct%`
6. `totalCost = directCost + contingency`
7. `targetExTax = totalCost / (1 − marginPct%)`；`target = targetExTax × (1 + taxPct%)`
8. `final = target × (1 − discountPct%)`
9. `floor = totalCost × (1 + taxPct%)`（0 毛利底线）；`ceiling = totalCost / (1 − (marginPct+10)%) × (1 + taxPct%)`
10. `realizedMarginPct = (final/(1+taxPct%) − totalCost) / (final/(1+taxPct%)) × 100`

返回：`{ok, summary{laborCost,nonLaborTotal,directCost,contingency,totalCost,floor,target,ceiling,final,realizedMarginPct,marginAmount,p50PersonDays?,p80PersonDays?}, warnings[], markdown}`。

警告（`warnings[]`，不阻断）：
- `final < floor`：报价低于成本（亏损）。
- `realizedMarginPct < 20`：低于定制交付经验区间（35%–50%）下限；`< 10` 标严重。
- `final > sweetSpotMax`（默认 200000）：超出单兵/小团队 FDE 甜点区（5–20 万），尾款/招采风险；建议拆阶段或提高预付款。
- `cloudToken === 0 || ops === 0 || compliance === 0`：云/推理、运维、合规可能漏项（AI 项目最常见吞利润项）。
- `dataEval === 0`：数据清洗/标注/评测集成本未列（AI 项目常低估 20%+，经验口径）。
- `contingencyPct < 10`：风险预备费偏低。
- `teamSize && weeks`：`P80 总人天 / (weeks×5) > teamSize × 1.2` → 人天与周期不匹配。
- 非人力项占比 > 40%：提示「非人力成本为主，按量项要设年度上限或实报实销」。

`action=template` 返回空白模板 Markdown：成本测算表（含数据与评测、云与 token、合规、运维、差旅、质保、预备费、税、依据、封顶列）+ 报价单结构（范围/除外、交付物、里程碑付款、假设与客户责任、变更单、验收与质保、有效期）+ 三点估算说明。

### 21.3 定价配置 `reference/fde-pricing.json`

```jsonc
{ "version": 1, "updatedAt": "2026-11-04", "currency": "CNY",
  "defaults": { "ratePerPersonDay": 940, "contingencyPct": 15, "taxPct": 6, "marginPct": 35, "discountPct": 0, "sweetSpotMin": 50000, "sweetSpotMax": 200000 },
  "rateCard": [
    { "key": "fde", "label": "FDE/交付负责人", "ratePerPersonDay": 1200 },
    { "key": "engineer", "label": "工程师", "ratePerPersonDay": 940 },
    { "key": "data", "label": "数据/评测", "ratePerPersonDay": 800 },
    { "key": "pm", "label": "项目管理", "ratePerPersonDay": 1100 }
  ],
  "notes": [
    "费率为内部成本费率，不是对外报价；对外报价 = 成本 ÷ (1 − 毛利)。",
    "毛利率 35%–50% 为经验区间（待验证）；低于 20% 需人工确认。",
    "5–20 万为单兵/小团队 FDE 甜点区（作者实践经验区间，B/C 级，非行业统计；待验证）。",
    "税率按现行税目与财务确认，工具默认 6% 仅为示例。"
  ],
  "disclaimer": "费率为方法默认值，按实际项目调整；不构成对外报价。" }
```

- 配置只读加载，缺失/损坏时用内置默认值并在返回 `warnings` 提示。
- 费率、甜点区、毛利率是**方法默认值**，不是权威数据；对外报价必须由人确认（红线不变）。

### 21.4 边界

- 工具不写客户卷、不写 board、不生成 PDF/DOCX、不对外发送；`markdown` 由会话落盘到 `research/<客户>/proposal/` 或 `scoping/`。
- 不替代人的定价判断；输出必须带「方法默认值/假设」提示。
- 工具返回的 Markdown 不包含真实客户名（模板示例用「某客户」），除非调用方显式传入。

### 21.5 验收

1. `fde_scenario`：四条硬门槛任一 false → 不启动结论与缺项；12 维**归一化**加权分/档位/否决项/排序符合 §21.1（含「权重合计 101 时不得除以 100」的回归断言）；template 可返回空白表。
2. `fde_quote`：公式与 §21.2 一致（用固定输入断言数字，含三点估算 P80 与 P50）；亏损/低毛利/甜点区/漏项/人天不匹配/非人力占比警告触发正确；template 可返回空白表。
3. 工具均不写文件、不写 board（调用前后文件 mtime 不变）。
4. `reference/fde-pricing.json` 缺失时用默认值且给出 warning。
5. `verify/fde-tools.mjs` 新增并通过；无需联网。
