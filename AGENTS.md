# AGENTS.md — 调研工作台 · FDE 工作站插件

> 一页规则，只写影响写法的、可机械判断的内容。工作区级规则见上一级目录的 `AGENTS.md`；详细设计见 `docs/01-spec.md`。

## 这个项目是什么

`dsh-fde`：跑在 DeepSeek Harness 里的单机插件，把「调研工作台」演进为 **FDE 工作站**——客户（engagement）沿 **8 个阶段**推进，任务（item）在看板泳道流转，注意力（attention）汇总需要人动作的事，会话（session）由看板按阶段模板发起并由 agent 回报，门禁（gate）用产物与人工确认共同把关。

- 宿主半：`index.js` + `src/host/`（工具、路由、提示词、技能注册、看板状态、资料库刷新、两个计算工具）。
- 客户端半：`src/ui/ui-panel.js`（**5 页签 + 页头设置入口**面板：今日/客户/资料/流程/文件；子页签见 `docs/01-spec.md` §8）→ `node build.mjs` 生成 `client.js`。
- 方法论与技能：`methods/`（8 篇）、`reference/`、`templates/`、`skills/`（**11 个 `fde-*` 编排技能**，含 v1.3 新增 `fde-scoping`；另 4 个方法库技能 + 1 个通用技能 `longdoc-brief`，长文一页纸（brief））。
- 状态：`research/.fde/board.json`（看板，属于**工作区**）；`research/.fde/fde-library.json`（资料库每日缓存）；`research/.fde/scys-fde.json`（生财社区缓存）；`research/.fde/scys-auth.json`（生财链接授权，0600，可由面板清除）。

## 技术栈

- 运行环境：DeepSeek Harness 0.2.0-rc.2（`engines.dsh: >=0.2.0-rc.2 <0.3.0`）；插件为纯 JS（ESM），**无编译、零新 npm 依赖**。
- 安装：官方机制 `dsh plugin --profile <name> add <spec>`（本地路径会以 link 方式挂载，也可用 npm/git/tarball）；`tools/install_profiles.py` 只做 preflight 与打印命令，**不直接改 profile 文件**。
- 许可：代码 MIT、方法/文档 CC BY 4.0（`LICENSE` / `LICENSE-docs`）；包名 `dsh-fde`，当前版本 `1.4.1`。
- 禁止 `import '@deepseek-ai/*'`；服务一律 `ctx.get(...)` 懒取 + 容错，服务缺失时静默降级、不影响插件启动。
- 面板只用 `--dsw-alias-*` 主题 token；不写 localStorage 作为事实源。

## 工具与技能（宿主注册）

| 类别 | 清单 |
|---|---|
| FDE 工具（11） | `fde_board` · `fde_engagement` · `fde_item` · `fde_attention` · `fde_brief` · `fde_harvest` · `fde_bid` · **`fde_library`**（feed/search/refresh）· **`fde_scenario`**（evaluate/template）· **`fde_quote`**（calculate/template）· `scys_fde`（生财情报，**兼容保留**） |
| 执行工具（5） | `rw_status` · `rw_scaffold` · `rw_export_pdf` · `rw_qa_pdf` · `rw_method`（只读/执行，不承担编排） |
| 编排技能（11） | `fde-engagement` / `fde-discovery` / `fde-meeting` / **`fde-scoping`** / `fde-solution` / `fde-pilot` / `fde-delivery` / `fde-adoption` / `fde-board` / `fde-harvest` / `fde-bid-radar` |
| 方法库技能（4） | `company-research` / `meeting-prep` / `proposal-forge` / `domain-model-partnership`（不独立触发） |
| 通用技能（1） | `longdoc-brief`（长文一页纸（brief）：阅读版 HTML + 传阅版；非 FDE 阶段技能，由 `fde-solution` / `fde-delivery` 长文产物引用） |

> 生财授权：三条路径按优先级——链接授权（面板保存到 `research/.fde/scys-auth.json`）→ `FDE_SCYS_TOKEN` → 兼容旧 token 文件；token 不写日志/不回显。
> 招采分工：`fde_bid` 只管「与客户关联」；全量检索/时间线/批次/成稿用 bid-intel 的 `bid_search / bid_timeline / bid_batches / bid_report`，不新增第二套检索语义。
> 计算工具：`fde_scenario` / `fde_quote` 是纯函数，不写文件/不写 board/不联网；返回 Markdown 由会话落盘。

## 阶段（v1.3 起 8 个，不硬编码）

`lead 线索 → discovery 研判 → meeting 会面 → scoping 场景 → solution 方案 → pilot 试点 → delivery 交付 → adoption 采用`（终止：`archived` / `lost`）。固定顺序、不可跳阶（人工 `force` 除外）。

- `scoping` 门禁：场景评估产物 + 四条硬门槛（有姓名发起人 / 14 天首次对接 / 90 天生产上线 / 使用可测）+ 12 维评分依据。
- `solution` 门禁：在原有检查上增加成本测算 `cost`、报价单/SOW `quote` 与人工项 `pricing_confirmed`。
- 阶段/泳道/门禁 key 只在 `src/host/fde-schema.js` 定义一次；面板、抽屉、handoff 从 `/fde/meta` 派生。

## 常用命令（在插件根目录执行）

| 命令 | 正常输出 |
|---|---|
| `node build.mjs` | `built: client.js (NN.N KB)`，且 `client.js` 与 `src/ui/ui-panel.js` 字节一致 |
| `node verify/all.mjs` | 逐项 `✓`，末尾 `✓ 全部验证通过`；失败打印 `✗` 与原因 |
| `node scripts/health-check.mjs` | 逐项 `OK/WARN/FAIL` + JSON 摘要，末尾 `✓ 健康检查通过（exit 0）`；有 FAIL 时 exit 1 |
| `node verify/fde-host.mjs` | 断言逐项 PASS |
| `node verify/fde-library-host.mjs` | 资料库宿主单测（mock，不联网）逐项 PASS |
| `node verify/fde-tools.mjs` | 两个计算工具公式/警告/模板单测逐项 PASS |
| `node verify/fde-scys-host.mjs` | 生财 FDE 情报宿主单测（mock，不联网）逐项 PASS |
| `node verify/host-smoke.mjs` | 路由数 ≥ 约定值并逐条冒烟 |
| `python3 tools/install_profiles.py` | preflight（只读）并打印官方 `dsh plugin --profile … add …` 命令；加 `--run` 才执行，禁止直接改 profile 文件 |
| `node scripts/check-readme-version.mjs` | README 顶部版本与 `package.json.version` 一致（否则 exit 1） |
| `node verify/open-source.mjs` | 开源发布检查（包名/许可/字段/白名单/无客户词/无绝对路径/无主题选择器） |
| `node verify/ui-contract.mjs` | UI 契约 advisory：打印 PASS/FAIL 与 `drift N 项`，**始终 exit 0**（迁移期不阻断） |
| `node scripts/release-preflight.mjs` | 发布预检：串行跑 README 版本 / 开源检查 / 打包 / 健康检查（+UI advisory），通过后打印发布命令；失败 exit 1 |

## 文档在哪

| 路径 | 内容 |
|---|---|
| `docs/00-intent.md` | 为什么做、约束、不做什么、成功指标 |
| `docs/01-spec.md` | **唯一事实来源**：阶段/门禁/数据模型/路由/工具/面板/硬约束（含 §17 招采、§18 生财、§19 资料库、§20 流程 v2、§21 两个计算工具） |
| `docs/02-plan.md` | 实施计划、文件归属、验证与回滚 |
| `docs/adr/` | 关键决策（`0001` 工作站、`0002` 招采、`0003` 资料库与流程 v2）；改主意新写一篇，不修改旧文 |
| `docs/retros/` | 复盘模板与复盘（方法沉淀） |
| `docs/ui-contract/` | **UI 契约 v1**：`layout.md` 结构 / `design.md` 视觉 / `tokens.md` 取值 / `region-ids.mjs` 区域 id / `audit-ui-contract.mjs` 8 项体检（迁移中，advisory） |
| `docs/RELEASE.md` | 发布手册：发布前清单、npm/git 命令、回滚、人工确认项 |
| `docs/research/` | 侦察底稿，只读参考（`fde-library/` 四路研究 + 目录 JSON） |
| `methods/` | 00 流程 · 01 核查 · 02 KPI · 03 合作地图 · 04 领域模型 · 05 对外文档 · 06 场景选择 · 07 成本报价 |
| `templates/` | 项目档案 · 场景评估表 · 成本测算与报价单 |
| `reference/` | 数据源 · 雷区 · 文档模板 · PDF 核查 · `fde-pricing.json` · `fde-library/catalog.json` |
| `skills/` | `fde-*` 编排技能；旧 4 个技能是方法库，不独立触发 |
| `research/<客户>/` | 客户卷（工作区级事实与产物，不迁入插件目录） |

> 文档引用用反引号路径，不要用 `@path`（会把整份读进上下文）。

## 工作流程（硬规则）

1. **先 spec 后代码**：实质改动先在 `docs/01-spec.md` 或 ADR/plan 里有一条；遇到契约缺陷先改 spec 再改代码（Lead 决策）。
2. **改前备份**：改插件代码/客户卷前确认有 `.archive/` 快照；写 board 由工具自动备份；不覆盖已有定稿。
3. **md 优先**：调研/会面/方案/复盘一律先写 md；PDF/DOCX 仅在用户明确要求时生成到 `exports/`；不手改 PDF/DOCX。
4. **客户资料分层**：公开结论进客户卷；私人判断、话术、竞争评估不进客户卷定稿；涉密信息不进任何会进插件仓的文件。
5. **状态落点唯一**：只写 `research/.fde/`；不写 `research/<客户>/` 正文（会话 handoff 除外），不用 localStorage 当事实源。
6. **定义单点**：阶段/泳道/门禁 key 只在 `src/host/fde-schema.js` 定义一次；面板从 `/fde/meta` 读，宿主提示词、工具描述从 schema 派生。
7. **验证同步**：新增路由同步 `verify/security.mjs` 与 `verify/host-smoke.mjs`；改面板文案同步 `verify/client-static.mjs`；`verify/all.mjs` 加入新测试；不删测试凑绿。
8. **技能格式**：`skills/*/SKILL.md` 必须有 `name`（与目录同名、kebab-case）与单行 `description`（写触发时机）；正文写触发/输入/步骤/产物/边界/相关方法。
9. **长产物落盘**：底稿/方案/复盘写文件，回报消息 ≤300 字并给路径。
10. **看板唯一编排**：客户经营流程由 FDE 看板驱动；`rw_*` 是执行工具，不平行启动第二套流程。
11. **招采口径**：候选人 ≠ 中标人；批次/专项是推断不是公告明示；金额只引原文，不换算、不求和；数据缺口（涉密/未公开/未采集平台）如实说明。
12. **资料库口径**：目录人工策展、随插件发布；每日只刷 GitHub 指标与社区摘要，**不抓任意网页正文**；A/B/C 分级不得改写（B/C 不得标成 A）；社区内容是摘要非全文，原帖以链接为准；不写任何外部平台。
13. **场景口径**：12 维权重合计 **101**，归一化 `Σ(分×权重) ÷ 101`（不得 ÷100）；四条硬门槛任一 false 不启动；否决项例外只能人签字；门禁只有人能过。
14. **定价口径**：费率/毛利率/合规费用/甜点区一律标「方法默认值/经验区间，待验证」，**不得写成行业标准**；token 价格报价前现查官方定价页；对外报价由人复核（红线不变）。

## 禁区（CRITICAL）

- 不 `git reset --hard` / `rebase` / `force push` / `amend`；不删 `.git`。
- 不删除、不移动 `research/<客户>/` 下任何目录与文件；不批量改动历史文件。
- 不手改 `research/.fde/board.json`；不改 `research/.fde/` 之外的状态文件。
- 不手写/不重启 DSH profile 配置（`~/.dsh/profiles/*`）；宿主改动由用户手动重启生效。
- 不为「看起来完成」而自动对外发送、自动过门禁、自动推进阶段、自动删除/归档客户。
- 不新增运行时依赖、不引入第二套流程引擎、不复刻 superagent 的 Source/Thread/Executor 全栈。
- 不把个人电脑的主目录绝对路径、客户真名/金额/人名写进文档、技能、README、示例（示例用「某集团」）。
- 不把密钥、令牌、连接串写进代码、文档、客户卷。
- 不抓任意网页正文进资料库、不缓存全文/图片；不把社区摘要当原文引用。
- 不把费率/毛利率/合规费用包装成行业标准；不手改 `reference/fde-library/catalog.json`（Lead 策展）。
