# ADR-0001：在现有调研工作台插件内演进出 FDE 工作站

- 状态：已采纳（2026-11-03）
- 决策人：Neo
- 相关：[`docs/00-intent.md`](../00-intent.md)、[`docs/01-spec.md`](../01-spec.md)、[`docs/02-plan.md`](../02-plan.md)、[`docs/research/superagent-extract.md`](../research/superagent-extract.md)、[`docs/research/handbook-extract.md`](../research/handbook-extract.md)、[`docs/research/current-workbench.md`](../research/current-workbench.md)

## 背景

现有 `@local/research-workbench` 是个「一次性调研工具」：能立项、抓取、出会面材料与方案，但项目之间是孤岛，没有统一状态、优先级、门禁和复盘；每次都要重新组织工作，人无法一眼判断「今天该处理谁、卡在哪、还差什么」。

要做的是把它变成组织客户全生命周期的 FDE 工作站（线索 → 研判 → 会面 → 方案 → 试点 → 交付 → 采用），同时是看板、待办、工单内核和方法执行器。当时的约束：

- **运行时**：DSH 0.2.0-rc.2，单机单用户；插件纯 JS、`link:` 安装、**零新依赖**、不得 `import '@deepseek-ai/*'`。
- **已有资产**：5 个 `rw_*` 工具、12 条路由、五页签面板、`methods/` 7 类方法、4 个技能、`verify/` 验证链，全部要继续可用。
- **数据**：`research/` 下已有 100+ 客户目录，**不能迁移、不能改结构**；宿主改动需重启 DSH 才生效，客户端可热更新。
- **参照物**：`dsh-superagent-prototype`（工单/注意力/授权内核）与 AI Native 手册（intent/spec/plan/ADR/retro/REVIEW 六件套、进化回路）。

## 决定

1. **在现有插件内演进**，不新建插件、不 fork 一份新仓库：在 `index.js` + `src/host/` 上长出 FDE 内核，面板从五页签重做为六视图。
2. **借鉴 superagent 内核，不移植其代码**：借「工单阶段判定、注意力优先级、授权/自主性、效果队列语义、面板三问信息架构」这些**零依赖设计资产**；执行器、Source/Thread、SQLite/worker slot、GitHub/PR 链全部不引入，用 DSH 现有 `sessionController` / `workspaceRegistry` / `webServer` 实现。
3. **技能走 `ctx.get('skills').register()` 运行时注册**：读 `skills/*/SKILL.md`，解析 frontmatter 后注册；服务不存在时静默降级为系统提示词列出路径，不阻塞插件启动。
4. **状态只落 `research/.fde/board.json`**（工作区侧）：`version: 1`、原子写（临时文件 + rename）、写前备份（保留 10 份）；旧目录只通过 `dir` 关联，不迁移。
5. **旧 `rw_*` 降级为执行工具，FDE 看板是唯一编排者**：不并行启动第二套流程引擎；旧路由/工具/页签能力全部保留，作为兼容与底层动作。

## 为什么没选别的

| 方案 | 没选的原因 |
|---|---|
| **直接安装 `dsh-superagent`** | 实测 21/21 个 peer 要求 `^0.2.1-alpha.2`，本机是 `0.2.0-rc.2`，DSH 兼容性预检直接拒绝挂载；加豁免会引入第二套框架实例（`cordis@4.0.5-alpha.1` vs `4.0.4`）与 123MB 依赖。它面向「一个 GitHub 仓库的编码 agent」，要求 `danger-full-access`，会接管执行器 Session、改进程级 `PATH`/git 配置，与「在现有 Web GUI 里加一个看板」不是一个量级；其 GitHub/Feishu Source 绑定在本机也无用武之地。详见 `docs/research/superagent-extract.md` §6。 |
| **独立新插件** | 会重复 `methods/`、`reference/`、`skills/`、`verify/`、安装链与侧边栏入口；两套面板与两套状态并存，用户要维护两个 `link:` 包，且旧工作台能力要么复制要么弃用，与「旧能力全保留」的约束冲突。 |
| **纯文档方案**（只写流程/模板，不上看板） | 状态不落盘、注意力不可见、会话不能回报；仍回到「状态只在人脑子里」的老问题，intent 里定义的指标（看板覆盖率、注意力命中率、会话闭环率）一个都观测不到。 |
| **fork superagent 源码改造** | 移植成本高：执行器/状态层与 `0.2.1-alpha.2`、`cordis@4.0.5-alpha.1` 深度绑定；越搬越把版本耦合带进来，违背零新依赖与「不复制 Source/Thread/Executor 全套」。 |

## 后果

**好处**

- 旧工作台零迁移继续可用，回滚只需删除 `research/.fde/`；客户卷不受影响。
- 零新依赖、纯 JS，符合 link: 安装与零构建约束；前端构建仍只有 `node build.mjs`（拷贝）。
- 阶段/门禁/注意力/自主性有唯一事实来源（`src/host/fde-schema.js`），宿主、工具、提示词、面板全部派生，可对齐测试。
- 方法论资产（methods/reference/skills）直接变成可加载 skill 与固定产物链，不重复建设。

**代价**

- 宿主侧改动**必须重启 DSH** 才生效；未重启时面板要显示兼容页，不能白屏（已在 spec §11 要求）。
- 面板仍是单文件 `ui-panel.js` → `client.js` 拷贝，六视图后文件变大，改一处要跑静态/准运行时测试兜底。
- 需要维护 `board.json` 的版本兼容与备份策略；board 与磁盘目录可能漂移，靠 `sync` 重扫缓解，不做双向写。
- 借用了 superagent 的概念但没借实现，规则引擎与注意力模型要自己维护（无后台定时器，只在读取时求值）。

**什么情况下重新考虑**

- DSH 升级到 ≥ `0.2.1-alpha.2` 且 `dsh-superagent` 提供可兼容安装时，重新评估「装它当 Source/编排后端」；
- 单机单用户不再成立（多协作者/多租户）时，`research/.fde/` 单文件状态需要换成带权限的服务端存储；
- 面板拆源文件、`ui-panel.js` 超过维护阈值时，按 `build.mjs` 扩展拆成多文件（不改插件形态）。
