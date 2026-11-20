# FDE 工作站 · 实施计划（plan）

> 依据：`docs/01-spec.md`（含 intent 引用）｜ 状态：进行中｜ 更新：2026-11-03
> 执行方式：多 agent 并行，按文件归属切分写入范围；宿主与客户端以本计划 + spec 为准，不做二次设计。

## 0. 全局约束（从 spec 原样抄）

- 零新依赖、不 import `@deepseek-ai/*`；复用 `makeGuard` 与 `paths.*`；状态只写 `research/.fde/`；阶段定义单点；原子写 + 备份；旧能力全保留；验证脚本同步更新。
- 默认 md 交付；PDF/DOCX 仅按需；不自动推进门禁、不对外发送、不改客户卷定稿。

## 1. 文件清单与归属

| 工作流 | 文件 | 新建/改 | 负责 | 说明 |
|---|---|---|---|---|
| A 宿主 | `src/host/fde-schema.js` | 新建 | host-dev | 阶段/泳道/门禁/规则/注意力定义，唯一来源 |
| A 宿主 | `src/host/fde-store.js` | 新建 | host-dev | board 读写、备份、原子写、adopt、工件扫描 + 缓存 |
| A 宿主 | `src/host/fde-rules.js` | 新建 | host-dev | 派生注意力 + proposals（去重、24h） |
| A 宿主 | `src/host/fde-prompts.js` | 新建 | host-dev | handoff 提示词模板（按阶段/intent） |
| A 宿主 | `src/host/fde-api.js` | 新建 | host-dev | 纯函数业务层（路由与工具共用） |
| A 宿主 | `index.js` | 改 | host-dev | 新路由注册、6 工具、skills 注册、系统提示词升级、handoff 工作区修复 |
| A 宿主 | `verify/fde-host.mjs` | 新建 | host-dev | schema/store/rules/api 单测（临时工作区） |
| A 宿主 | `verify/host-smoke.mjs`、`verify/security.mjs` | 改 | host-dev | 路由数量与新增路由断言 |
| B 客户端 | `src/ui/ui-panel.js` | 改（重构） | client-dev | 六视图 + 抽屉 + 拖拽 + 兼容页 |
| B 客户端 | `client.js` | 由 build 生成 | client-dev | `node build.mjs` |
| B 客户端 | `verify/client-static.mjs` | 改 | client-dev | 更新字面量断言，补六视图/兼容页检查 |
| B 客户端 | `verify/fde-client.mjs` | 新建 | client-dev | API 前缀、token、无宿主包、组件存在性 |
| C 技能/文档 | `skills/fde-*/SKILL.md`（9 个） | 新建 | docs-dev | 按 spec §10；注册由宿主完成 |
| C 技能/文档 | `skills/{company-research,meeting-prep,proposal-forge,domain-model-partnership}/SKILL.md` | 改 | docs-dev | 降为方法库，指向 FDE 流程 |
| C 技能/文档 | `AGENTS.md`、`REVIEW.md` | 新建 | docs-dev | 一页规则 / 审查分级 |
| C 技能/文档 | `docs/evaluation.md` | 新建 | Lead | 三源评估与取舍 |
| C 技能/文档 | `docs/adr/0001-fde-workstation.md` | 新建 | docs-dev | 关键决策记录 |
| C 技能/文档 | `docs/retros/` 模板与首篇 | 新建 | docs-dev | 复盘模板 + 本次构建复盘（收尾） |
| C 技能/文档 | `scripts/health-check.mjs` | 新建 | docs-dev | 行为式自检（文件/状态/schema/技能） |
| C 技能/文档 | `README.md` | 改 | docs-dev | 新 IA、安装、重启说明 |
| D 验证 | `verify/all.mjs` | 改 | Lead | 汇总新测试 |
| D 验证 | 全量 `node verify/all.mjs` + `node build.mjs` + health-check | 运行 | Lead + verifier | 最终验收 |

> 写入范围以本表为准；跨范围改动先报 Lead。`index.js` 只有 host-dev 写；`client.js`/`ui-panel.js` 只有 client-dev 写；`docs/01-spec.md` 只有 Lead 写。

## 2. 任务与顺序

### T1 宿主内核（host-dev）
- 接口：新建 `fde-schema.js`/`fde-store.js`/`fde-rules.js`/`fde-prompts.js`/`fde-api.js`；按 spec §3–§7 实现；路由与工具共用 `fde-api.js`。
- 集成：`index.js` 注册 11 条新路由、6 个工具、skills 注册、提示词；修复 handoff workspace 选择。
- 测试：`verify/fde-host.mjs` 覆盖 A1–A9、A10（宿主部分）、A12（注册函数）。
- 完成标准：`node verify/fde-host.mjs` 全绿；`node verify/host-smoke.mjs` 全绿；无新依赖。

### T2 看板面板（client-dev）
- 接口：按 spec §8；从 `/fde/meta` 取阶段定义；`/fde/board`、`/fde/brief`、`/fde/engagement`、`/fde/item`、`/fde/gate`、`/fde/adopt`、`/fde/handoff`、`/fde/proposal`、`/fde/settings`、`/fde/health`。
- 兼容：启动探测 `/fde/meta`，404 → 兼容页 + 经典五页签入口；轮询 10–15s。
- 视觉：主题 token、明暗主题、空态/加载/失败、拖拽 + 键盘可达。
- 测试：`verify/client-static.mjs` 更新 + `verify/fde-client.mjs` 新建。
- 完成标准：`node build.mjs && node verify/client-static.mjs && node verify/fde-client.mjs` 全绿；源码与产物一致。

### T3 技能与文档（docs-dev）
- 9 个 FDE skills（frontmatter name/description 合法、正文按 spec §10）；4 个旧 skill 改为方法库入口；AGENTS.md / REVIEW.md / ADR / 复盘模板 / README；health-check 脚本。
- 完成标准：`node scripts/health-check.mjs` 全绿（允许「宿主未重启」为 warn）；9 个 SKILL.md frontmatter 校验通过。

### T4 集成验证（Lead + verifier）
- 合并后全量：`node build.mjs && node verify/all.mjs && node scripts/health-check.mjs`；API 冒烟（如宿主已重启）；面板静态 + 运行时渲染检查；真实页面可见性按环境如实报告。
- 收尾：更新 README/计划状态/复盘；交付说明（安装、重启、回滚）。

## 3. 接口契约冻结

- spec §3–§9 为冻结契约；实现中发现契约缺陷，先改 spec 再改代码（Lead 决策）。
- 错误契约统一 `{ok:false, reason, code}`；成功统一 `{ok:true, ...}`。

## 4. 验证与交付

- 验证命令（写进 AGENTS.md 与 README）：`node build.mjs`、`node verify/all.mjs`、`node scripts/health-check.mjs`。
- 交付物：插件代码 + 文档 + 技能 + 验证报告 + 重启说明 + 回滚方法（删除 `research/.fde/` 或回滚 tar 快照）。
- 快照：改动前已备份 `.archive/research-workbench-baseline-20261103-143539.tar.gz`。

## 5. 风险与回滚

- 宿主改动需重启；先交付可验证的静态/单测，再让用户重启验证。
- 面板单文件变大：分区注释 + 静态断言；后续可按视图拆源文件（build.mjs 支持扩展）。
- 写入冲突：严格按文件归属；跨文件改动先协调。
- 回滚：`tar -xzf .archive/research-workbench-baseline-*.tar.gz -C <工作区根>`（先确认工作区）并删除 `research/.fde/`。

## 6. 执行结果（2026-11-03）

| 工作流 | 状态 | 交付 | 验证 |
|---|---|---|---|
| T1 宿主内核（host-dev） | ✅ 完成 | `src/host/fde-{schema,store,rules,prompts,api}.js`（约 3100 行）、`index.js` 集成（13 路由 + 6 工具 + 技能注册 + 提示词 + handoff 修复） | `fde-host` 158 断言、host-smoke 25 路由·11 工具、security 33 项 |
| T2 看板面板（client-dev） | ✅ 完成 | `src/ui/ui-panel.js`（4534 行 → client.js 236.7KB）：六视图 + 客户/任务抽屉 + 兼容页/经典模式 + 拖拽/键盘 | client-static 49、fde-client 66、client-runtime 82、pack 7 |
| T3 技能与文档（docs-dev） | ✅ 完成 | 9 个 fde 技能 + 4 个方法库定位 + AGENTS/REVIEW/ADR/复盘模板 + health-check(293 行) + README 重写 | health-check 9 OK/2 WARN（重启状态不可判） |
| T4 集成验证（Lead） | ✅ 完成 | verify/all.mjs 纳入 fde-host/fde-client/health-check；pack.mjs 修复 npm 缓存权限导致的误报；agent 工具 delete 红线加固；harvest 落盘决策（§7 已同步）；README 状态更新 | `node verify/all.mjs` → **全部验证通过**（9 个步骤） |
| 独立审计（verifier） | ✅ 两轮完成 | `verify/acceptance-audit.mjs`（395 条）+ `verify/audit-report.md` | 第一轮 P0=0/P1=3/P2=5；修复后第二轮 395/395 全绿、P0/P1/P2=0 |
| 审计修复（host-dev） | ✅ 完成 | F1–F8 全修（红线代码化/handoff itemId/CAS/派生污染/路径守卫） | `verify/host-fix-report.md`；fde-host 181/181 |

### 6.1 环境与生效（实测）

- **无需重启即可生效**：用 `plugin_manager set_plugin` 对本插件执行「禁用→启用」（`application: applied`）触发 profile 重组与模块重载，新宿主代码立即生效；已实测 `/research-workbench/api/fde/meta` 由 404 变为 401（路由存在、守卫生效），6 个 `fde_*` 工具与 9 个 `fde-*` 技能已注册，`fde_board` 工具读到初始化后的看板。此路径已写入 README §三。
- **看板初始化**：`adopt scan` → `adopt apply` 导入 9 个客户（8 个项目 + 1 个 legacy 目录），阶段取扫描建议（会面 4 / 方案 4 / 试点 1），每条下一步设为「核对导入信息（主体/阶段/下一步）」（+3 天）；`research/.fde/board.json` 首次生成，历史门禁按 forced 留痕。
- **回滚**：删除 `research/.fde/` 或解包 `.archive/research-workbench-baseline-20261103-143539.tar.gz`。
- **未完成/受限**：真实浏览器渲染与暗色主题未做页面级验证（无可用的已认证浏览器自动化；按验证纪律不索取凭据）；客户端需刷新页面后可见新面板。

## 7. v1.1 追加：招采雷达并入（2026-11-03）

**范围**：把 `@local/bid-intel`（本地索引实测 24,208 条）以「只读服务 + 客户关联层」并入 FDE，不合并代码/数据（决策见 `docs/adr/0002-bid-intel-integration.md`，契约见 `docs/01-spec.md` §17）。

| 工作流 | 交付 | 验证 |
|---|---|---|
| 宿主（host-dev） | bid-intel `ctx.provide('bidIntel')`；`src/host/fde-bids.js`（查询词变体/分类/匹配/缓存/link/unlink/promote）；schema 的 bidWatch/bid_signal；fde-api 派生 bids/bidStats + 7 个 bids 业务函数；7 条路由；第 7 工具 `fde_bid`；提示词招采口径 | fde-host 259、host-smoke 32 路由/12 工具、security 42 |
| 面板（client-dev） | 第 7 页签「招采」（概况/检索/结果/客户匹配/导入链接）；客户抽屉招采区（徽章/Top5/加入跟进/关联/取消/刷新）；卡片「招采 N」徽章；设置开关；不可用降级 | client-static 59、fde-client 84、client-runtime 112 |
| 技能文档（docs-dev） | 新 `fde-bid-radar` + 4 技能增补；README 招采节/七视图/10 技能；AGENTS 工具与口径；health-check 招采索引项 | health-check 10 OK/4 WARN（WARN 均非缺陷） |
| 独立审计（verifier） | 第三轮 §17 断言（服务契约/降级/匹配/link/promote/信号/路由/面板/红线） | acceptance-audit **450/450、P0/P1/P2=0** |
| 集成（Lead） | 双插件 live reload；真实数据实测；收尾小改（approxTotal 量级口径） | `fde_bid match` 某研究所≈1730（采样53）；`search` 关键词命中 6；0 命中优雅降级；verify/all 全绿 |

**真实数据要点**（详见 `docs/evaluation.md` §12.3）：索引以行业招采专区为主，两个客户命中量级 ≈1730；其余多数客户在索引中 0 命中——按数据事实展示，不虚构；「候选人≠中标人」「批次是推断」「金额只引原文」三条口径已进入提示词、技能与面板文案。

**生效**：bid-intel 与 FDE 两个插件均经 plugin_manager「禁用→启用」重载后生效；面板需刷新页面。

**限制**：匹配是确定性规则（名称差异大/别名未收录会漏，可补 `bidWatch.keywords`）；采样列表不是精确对账总数（面板同时显示「≈量级（采样 M）」）；真实浏览器渲染与真实采集后的 TTL 刷新未在本机验证。

---

## 3. v1.2 生财 FDE 情报模块（2026-11-04）

> 依据 spec §18。**先文档后代码**已完成（spec §18 与本节）。执行方式：宿主 / 客户端两条并行，写入范围互不重叠；Lead 做文档、集成与最终验收。

### 3.1 文件清单与归属

| 工作流 | 文件 | 新建/改 | 负责 | 说明 |
|---|---|---|---|---|
| A 宿主 | `src/host/fde-scys.js` | 新建 | host-dev | 凭证读取、MCP JSON-RPC 客户端、7 查询抓取、归一化、feed 原子读写、每天一次门控、单飞刷新 |
| A 宿主 | `index.js` | 改 | host-dev | 2 条路由（`scys/feed`、`scys/refresh`）+ 工具 `scys_fde` + 启动定时器（ctx.effect 清理） |
| A 宿主 | `verify/fde-scys-host.mjs` | 新建 | host-dev | mock fetch 单测：归一化/去重/摘要截断/日期门控/失败保留/未授权/损坏 JSON |
| A 宿主 | `verify/security.mjs`、`verify/host-smoke.mjs` | 改 | host-dev | 路由数量与路径断言同步 |
| B 客户端 | `src/ui/ui-panel.js` | 改 | client-dev | 第 8 视图 `ScysView` + nav 项 + 文案 + CSS + 数据拉取/刷新 |
| B 客户端 | `client.js` | 由 build 生成 | client-dev | `node build.mjs` |
| B 客户端 | `verify/client-static.mjs`、`verify/fde-client.mjs`、`verify/client-runtime.mjs` | 改 | client-dev | 新视图/新导航/新 API 断言 |
| C 集成 | `verify/all.mjs`、`scripts/health-check.mjs` | 改 | Lead | 汇总新测试；health 增生财 feed 检查项（warn 不 fail） |
| C 文档 | `README.md`、`AGENTS.md` | 改 | Lead | 模块说明、更新节奏、token 边界 |
| C 验收 | 真实联网冒烟、面板可见性、`node verify/all.mjs` | 运行 | Lead + verifier | 记录条数/耗时/日期；如实报告 |

### 3.2 任务

- **T5 宿主（host-dev）· 已完成 2026-11-04**：`fde-scys.js`（779 行）、`index.js` 2 路由 + `scys_fde` 工具 + 定时器、`verify/fde-scys-host.mjs`（92 项 mock，不联网）；security 48 项、host-smoke 34 项全绿。真实冒烟后补充「非 post 类相关性过滤」+ `stats.filteredOut`。
- **T6 客户端（client-dev）· 已完成 2026-11-04**：第 8 视图 `ScysView`（+379 行）、nav/文案/CSS、build 后 client.js 299.1 KB；client-static 70 项、fde-client 95 项、client-runtime 133 项全绿。
- **T7 集成验收（Lead）· 已完成 2026-11-04**：`verify/all.mjs`（新增 fde-scys-host 步骤）全绿；health-check 生财检查项 OK；真实冒烟两次（原始 51 条 → 过滤后 28 条 + filteredOut 23，7/7 查询，10.6–10.7s）；README/AGENTS/spec 回写；独立审计 P0/P1/P2=0。**未做**：真实浏览器渲染（需重载插件 + 刷新页面）。

---

## 8. v1.3：FDE 资料库 + 流程 v2（2026-11-04）

> 依据：`docs/01-spec.md` §19–§21、`docs/adr/0003-fde-library-and-process-v2.md`。**先文档后代码已满足**（spec/ADR 先落盘）。
> 执行方式：Lead 做目录策展、集成与验收；host-dev / client-dev / docs-dev 三线并行，写入范围互不重叠；研究底稿在 `docs/research/fde-library/`。

### 8.1 文件清单与归属

| 工作流 | 文件 | 新建/改 | 负责 | 说明 |
|---|---|---|---|---|
| A 宿主 | `src/host/fde-library.js` | 新建 | host-dev | catalog 加载/校验、GitHub 指标刷新、社区映射、diff（isNew/updated）、featured 排序、日刷新门控、原子写 |
| A 宿主 | `src/host/fde-calc.js` | 新建 | host-dev | `fde_scenario` / `fde_quote` 纯函数 + 定价配置加载 + Markdown 渲染 |
| A 宿主 | `src/host/fde-schema.js` | 改 | host-dev | 8 阶段（新增 `scoping`）、`scoping` 门禁、`solution` 加成本/报价项、阶段 playbook、item 类型 |
| A 宿主 | `src/host/fde-prompts.js` | 改 | host-dev | `scoping` handoff 模板；其他阶段提示补成本/报价/场景 |
| A 宿主 | `index.js` | 改 | host-dev | 2 条 library 路由、3 个工具（`fde_library`/`fde_scenario`/`fde_quote`）、定时器、系统提示词、工具计数日志 |
| A 宿主 | `verify/fde-library-host.mjs` | 新建 | host-dev | mock fetch：catalog 校验/GitHub 合并/失败降级/diff/日门控/损坏缓存；不联网 |
| A 宿主 | `verify/fde-tools.mjs` | 新建 | host-dev | `fde_scenario`/`fde_quote` 公式、警告、template；不写文件、不联网 |
| A 宿主 | `verify/security.mjs`、`verify/host-smoke.mjs` | 改 | host-dev | 路由/工具计数与路径断言同步 |
| B 客户端 | `src/ui/ui-panel.js` | 改 | client-dev | 9 页签（流程/资料库替换生财）、`LibraryView`、`ProcessView`、`MethodsView` 支持 `initialName`、文案与 CSS |
| B 客户端 | `client.js` | 由 build 生成 | client-dev | `node build.mjs` |
| B 客户端 | `verify/client-static.mjs`、`verify/fde-client.mjs`、`verify/client-runtime.mjs` | 改 | client-dev | 九视图/资料库/流程/8 列看板断言；生财断言改为「已移除」 |
| C 目录 | `reference/fde-library/catalog.json` | 新建 | Lead | 从研究 JSON 合成：id 唯一、URL/枚举校验、A/B/C、阶段、推荐排序 |
| C 目录 | `reference/fde-pricing.json` | 新建 | docs-dev | 费率卡/默认值/甜点区/免责声明（spec §21.3） |
| C 文档 | `docs/research/fde-library/00-综述.md` | 新建 | Lead | 四路研究综述：资料版图、流程模型对照、取舍、缺口 |
| C 文档 | `skills/fde-scoping/SKILL.md` | 新建 | docs-dev | 第 11 个 FDE 技能 |
| C 文档 | `skills/fde-{engagement,meeting,solution,pilot,board}/SKILL.md` | 改 | docs-dev | 8 阶段、场景、成本报价、工具 |
| C 文档 | `methods/06-场景选择与数据体检.md`、`methods/07-成本评估与报价.md` | 新建 | docs-dev | 方法正文（引用研究结论与来源） |
| C 文档 | `templates/场景评估表.md`、`templates/成本测算与报价单.md` | 新建 | docs-dev | 可直接套用 |
| C 文档 | `README.md`、`AGENTS.md`、`scripts/health-check.mjs` | 改 | docs-dev | 9 页签/资料库/新工具/健康检查项 |
| D 集成 | `verify/all.mjs` | 改 | Lead | 纳入 `fde-library-host`、`fde-tools` |
| D 集成 | 全量验证 + 真实联网冒烟 + 面板刷新可见性 | 运行 | Lead + verifier | 记录条数/耗时/日期；如实报告 |
| E 审计 | `verify/acceptance-audit.mjs` | 改 | verifier | v1.3 断言（资料库/8 阶段/两个工具/红线/一致性） |

> 写入范围以本表为准；`index.js` 只有 host-dev 写；`client.js`/`ui-panel.js` 只有 client-dev 写；`docs/01-spec.md` 只有 Lead 写；catalog 只有 Lead 写。

### 8.2 任务

- **T8 宿主（host-dev）**：按 spec §19–§21 实现 `fde-library.js`、`fde-calc.js`、schema/prompts/index 集成；新增 2 路由 + 3 工具；测试 `fde-library-host.mjs`、`fde-tools.mjs`；security/host-smoke 计数同步。完成标准：各单测全绿、`node verify/host-smoke.mjs` 全绿、无新依赖、不联网测试。
- **T9 面板（client-dev）**：九页签；`LibraryView`（重点推荐/来源组/阶段筛选/搜索/仅看推荐/刷新/降级）；`ProcessView`（8 阶段步进/详情/工具矩阵/跳方法页）；看板 8 列；生财页签移除。完成标准：`node build.mjs && node verify/client-static.mjs && node verify/fde-client.mjs && node verify/client-runtime.mjs` 全绿；源码与产物一致。
- **T10 文档（docs-dev）**：新技能/方法/模板/定价配置/README/AGENTS/health-check。完成标准：`node scripts/health-check.mjs` 全绿（允许宿主未重启为 WARN）；SKILL frontmatter 合法。
- **T11 目录（Lead）**：研究 JSON 校验 → catalog 合成 → 抽样核对 URL/枚举；catalog 规模与统计一致。
- **T12 集成验收（Lead）**：`node build.mjs && node verify/all.mjs && node scripts/health-check.mjs`；真实 `/fde/library/feed` 联网冒烟（记录 GitHub/社区条数与降级情况）；插件禁用→启用重载后检查新路由/工具/技能；刷新页面可见性按环境如实报告。
- **T13 独立审计（verifier）**：按 spec §19.8/§20.7/§21.5 与红线复核；输出 PASS/问题清单。

### 8.3 顺序与依赖

1. T8 + T9 可并行（文件不重叠；client 用 spec 字段 + mock fixture，不等 catalog 最终内容）。
2. T10 依赖研究底稿（已完成）与 spec；可与 T8/T9 并行。
3. T11 依赖四路研究 JSON 齐备；catalog 落盘后 client 可做真实数据冒烟（可选）。
4. T12 在 T8–T11 全部完成后执行；T13 在 T12 之后。

### 8.4 验证命令

`node build.mjs`；`node verify/all.mjs`；`node scripts/health-check.mjs`；`node verify/fde-library-host.mjs`；`node verify/fde-tools.mjs`；`node verify/host-smoke.mjs`；`node verify/security.mjs`。

### 8.5 风险与回滚

- **catalog 质量**：研究条目可能含失效/二手链接 → Lead 逐条校验 JSON（id 唯一/URL/枚举），抽样 curl；不合格剔除或降级 B/C，不硬凑条数。
- **GitHub 限流**：无 token 每小时 60 次；每日只刷 ≤30 个 `track` 仓库，失败降级保留旧值并展示状态。
- **8 阶段回归**：看板列/抽屉/handoff 必须从 meta 派生；测试同步更新，不删测试凑绿。
- **存量客户门禁**：`solution` 新增自动项可能显示缺项 → 文档写明补材料或人工 force 留痕；不自动改写 stage。
- **回滚**：`tar -xzf .archive/research-workbench-pre-v13-20261104-211704.tar.gz -C <workspace>`（先确认工作区）；删除 `research/.fde/fde-library.json`（缓存类）。

### 8.6 执行结果（2026-11-04）

| 工作流 | 状态 | 交付 | 验证 |
|---|---|---|---|
| T8 宿主（host-dev） | ✅ | `fde-library.js`（839 行）、`fde-calc.js`（824 行）、schema 8 阶段/门禁/playbook、prompts scoping、index 2 路由 + 3 工具 + 定时器 + 提示词；`fde-host`/`fde-scys-host`/`security`/`host-smoke` 同步 | `fde-host` 303、`fde-library-host` 96、`fde-tools` 74、`fde-scys-host` 92、security 52、host-smoke 36 路由/16 工具，全绿 |
| T9 面板（client-dev） | ✅ | `ui-panel.js` 九页签 + `LibraryView` + `ProcessView` + MethodsView initialName + 8 列看板；移除生财页签/ScysView；`client.js` 328.7KB 与源码一致 | client-static 86、fde-client 109、client-runtime 166，全绿 |
| T10 文档（docs-dev） | ✅ | 定价配置、方法 06/07、模板 2 个、`fde-scoping` + 6 技能更新、README/AGENTS/health-check | `health-check` 16 OK / 2 WARN / 0 FAIL（WARN=历史绝对路径、宿主未重载） |
| T11 目录（Lead） | ✅ | 四路研究底稿 + `00-综述.md`；`catalog.json` 108 条（官方 60 / 开源 40 / 方法 8）、A 92 / B 16、featured 32、featuredRank 11、track 24；id/url 唯一、枚举/URL 校验 0 错 | 真实 GitHub API 抽样复验；105→108 条后 health-check OK |
| T12 集成（Lead） | ✅ | `build` + `verify/all`（含新增 fde-library-host/fde-tools 步骤）+ health；真实联网刷新资料库缓存；`/fde/meta`/工具在 node 层验证 | `verify/all.mjs` **全部验证通过**；真实 refresh：136 条（108 策展 + 28 社区），24 仓库中 23 成功、1 个 403 限流降级保留旧值并给 warning |
| T13 审计（verifier） | ✅ | `acceptance-audit.mjs` 更新 + v1.3 断言 **170 条**；`audit-report.md` §9 | **670/670 全绿、P0=0 / P1=0 / P2=3**（O13 缓存瞬时口径、O15 health 建议、O16 validateCatalog 未校验 featuredRank/track 上限；O10/O11/O12/O14 已解决） |

**关键口径修正（研究→实现）**：研究报告的评分卡权重合计为 101（不是 100），且三个示例的加权和把 ROI 权重 8 计为 7；实现按「权重表逐维重算 ÷101」得到 3.60 / 3.10 / 4.25（方法 06 已列勘误），`fde_scenario` 用测试钉住「不得 ÷100」。费率/毛利率/甜点区全部标方法默认值/经验区间，不冒充行业标准。

**生效**：宿主/面板改动需重载插件（重启 DSH，或在插件管理里对本插件禁用→启用一次）；面板需刷新页面。真实浏览器渲染未在本机完成页面级验证（如实报告）。

**回滚**：`.archive/research-workbench-pre-v13-20261104-211704.tar.gz`；删除 `research/.fde/fde-library.json`（缓存类）即可重刷。

---

## 9. Phase 0：开源就绪改造（2026-11-08，ADR 0004）

> 决策与理由见 `docs/adr/0004-open-source-readiness.md`；实施契约见工作区 `plugin-audit/fde-v2/06-实施/01-实施规格.md`。
> 回滚：`.archive/research-workbench-pre-oss-20261108-2225.tar.gz`。

| # | 文件/范围 | 改动 | 归属 |
|---|---|---|---|
| 9.1 | `package.json` / `LICENSE` / `LICENSE-docs` / `cordis.patch.yml` / `tools/install_profiles.py` / `README.md` / `CHANGELOG.md` / `locale/*` | 改名 `dsh-fde` v1.3.0、MIT + CC BY 4.0、engines/peer/files、官方安装说明、发布元数据 | Lead |
| 9.2 | `src/ui/ui-panel.js` / `client.js` / `build.mjs` | 模块 id 改名；首启「新建客户/任务」；4 个功能 bug；今日去重；看板横滚示能 + 列宽；生财授权 UI | `impl-ui` |
| 9.3 | `index.js` / `src/host/fde-scys.js` | 生财三路授权（链接授权/环境变量/兼容 token 文件）+ 路由与工具口径；`webServer` 可选 inject | Lead |
| 9.4 | `docs/**` / `methods/**` / `skills/**` / `reference/**`（samples 移出）/ `docs-workbench.md` / verify fixtures | 脱敏、methods/05 改写去私有仓、旧文档移出、客户数据复扫 | `impl-sanitize` |
| 9.5 | `verify/**`（除 fde-host/client-runtime fixture）/ `.github/**` / `.gitignore` / `examples/**` | 干净检出可验证、CI、演示数据、发布包检查 | `impl-release` |

验收：`node build.mjs` 字节一致；`node verify/all.mjs` 全绿；干净副本（无 `../research`）`verify/all.mjs` 全绿；`health-check` 0 FAIL；`npm pack --dry-run` 包内容 ≤1.2 MiB 且无 samples/双份源码；全仓脱敏复扫 0 命中；harness 截图复跑确认 UI 改动；真实宿主重启后人工验收（未做，如实标注）。

---

## 10. v1.7 资料页重构与内嵌预览（2026-11-11，ADR 0008）

> 触发：用户反馈「资料管理还是很麻烦、文件列表信息太多、调研类信息混入、希望预览并复用 DSH 已有能力」。
> 决策与边界见 `docs/adr/0008-资料页重构与内嵌预览.md`；契约见 `docs/01-spec.md` §8.3 / §8.5。

| # | 范围 | 改动 | 验证 |
|---|---|---|---|
| 10.1 | `src/ui/ui-panel.js` / `client.js` | 导航更名（文件→资料、资料→情报）与调序；资料页 master-detail（最近/按客户、搜索、类型筛选、原始素材开关、排序）；行内操作收敛；md 预览渲染器；PDF/图片/HTML 快照/Office 预览；上传与未关联素材折叠 | `node build.mjs` 字节一致；`node verify/all.mjs` 全绿 |
| 10.2 | `verify/client-static.mjs`、`verify/fde-client.mjs`、`verify/client-runtime.mjs`、`verify/acceptance-audit.mjs` | 断言同步 v1.7 IA 与预览能力；括号平衡检查改为 `new Function` 编译；运行时 React shim 补 `useMemo`；招采/资料库场景改走「情报」页 | `node verify/all.mjs` 全绿（含独立审计 677 项） |
| 10.3 | `docs/01-spec.md`、`docs/adr/0008-*.md`、`CHANGELOG.md`、`README.md`、`AGENTS.md`、`package.json` | 契约/决策/版本（1.7.0）同步 | `node scripts/check-readme-version.mjs`；`node scripts/health-check.mjs` 0 FAIL |
| 10.4 | dev 实例（DSH_HOME=.dsh-dev，port 65110） | 真机逐类型预览（md/pdf/图片/html/office）、筛选/搜索/按客户、全屏/Esc、上传面板、素材折叠 |
| 10.5 | 客户端（追加） | 试用 DSH 原生右侧预览后按用户取舍回退：点资料不跳会话，预览留在面板内；保留切换面板的页签/筛选记忆 | 真机验证（点行不切主面板、md/PDF 面板内预览、返回状态保留）；`verify/all.mjs` 全绿 |
 截图 `.ux-audit/shots/v17-*.png`；独立 agent 验收报告 `.ux-audit/reports/v17-acceptance.md` |

**已知限制（如实标注）**：Office 预览依赖「当前工作区至少一个会话」作为宿主授权作用域，无会话时降级为系统应用打开；HTML 快照为静态 sandbox 渲染（不执行脚本、相对资源可能缺失）；文本 >40 万字符截断提示；桌面端安装副本需用户替换/更新插件并刷新页面（本仓库只产生产物，不改 profile）。

**回滚**：`git checkout -- client.js src/ui/ui-panel.js` 后重跑 `node build.mjs`；无宿主路由/数据迁移，回滚不影响 board 与客户卷。

| 10.6 | 客户端（追加） | 按用户指示移除经典模式：删 `ClassicApp`/旧五页签与 `.rw-*` 视觉、页头/设置页/未就绪页三个入口、62 个失去引用的 DICT key；未就绪页精简为「重试 + 重启说明」；宿主旧路由暂留 | `node build.mjs`；`node verify/all.mjs` 全绿（断言改为「经典模式已移除」）；真机无经典入口 |

---

## 11. v2.0 可交付版（2026-11-19，ADR 0010）

> 触发：用户要求「整体进行一次重构……去掉无用说明、改掉用户不懂的晦涩文字、最大程度简化用户操作，达到可交付的标准状态」。
> 决策与边界见 `docs/adr/0010-v2-可交付版.md`；契约见 `docs/01-spec.md` §22（§1 / §5 / §6 / §8 的旧表述以 §22 为准）。
> 改前快照：工作区 `.archive/dsh-fde-pre-v2-20261119-143501.tar.gz`；分支 `feature/v2-delivery-refactor`。

### 11.1 重构前的事实（重构前截图 + 代码核对）

| # | 现象 | 证据 |
|---|---|---|
| 1 | 11 个文案 key 直接显示在界面（看板卡片、客户列表表头、设置页标题、资料库类型等） | 扫描 `t('key')` 与字典：`boardNoNext` `customersStage` `customersPriority` `tabSettings` `settingsAutonomy` `settingsAutonomyDesc` `methodsSkills` `bidRelNotice` `board` `converted` `noSession`；另 `libKind*` 动态 key 整组缺失 |
| 2 | 界面显示规则编号、对象编号、检查项 key、字段名、接口路径、状态文件名 | 今日页 `stall` / `due_soon`；抽屉 `eng_…`、`subject_locked`；流程页 `company / source / nextAction`、`/fde/meta` |
| 3 | 同一逾期事项在今日页出现三次 | `derivedAttention` 把待处理提醒并入注意力，面板又单独渲染「建议」栏；`overdue` 规则与派生逾期重复 |
| 4 | 提醒不过期、标题天数不更新，上限 8 条会被旧提醒占满 | `refreshProposals` 只追加；`proposalRecentlyExists` 对 pending 永久去重 |
| 5 | 「采纳」对 `stall` / `due_soon` / `review_lag` 是空操作 | `executeProposal` 只处理 `create_item` 与带 `patch` 的提醒 |
| 6 | 设置页两个开关没有效果；自主性两档实现相同 | `folderWatch` / `briefOnOpen` 在宿主无读取点；`applySafeProposals` 只区分 `observe` 与其它 |
| 7 | 客户抽屉：推进条件默认「未评估」、四个保存按钮、主操作在底部 | 重构前抽屉截图 |
| 8 | 8 列看板在 1440 宽下第 8 列被截断，用两行文字解释操作 | 重构前看板截图 |

### 11.2 工作项

| # | 范围 | 改动 | 验证 |
|---|---|---|---|
| 11.2.1 | `docs/adr/0010-*.md`、`docs/01-spec.md` §22、本节 | 决策、契约、计划先行 | 文档评审 |
| 11.2.2 | `src/host/fde-schema.js`、`fde-rules.js`、`fde-api.js`、`fde-prompts.js`、`index.js`（提示词与返回文本） | D1/D4/D11/D12：给人看的文本改写；四条规则标 `derived`；提醒自动失效与标题更新；系统提示词加用词约定 | `verify/fde-host.mjs`、`acceptance-audit.mjs`、`host-smoke.mjs`、`security.mjs` |
| 11.2.3 | `src/ui/ui-panel.js`、`client.js`、`build.mjs` | D2/D3/D5–D10：字典重写与补齐、今日去重、看板与卡片、客户抽屉重排、流程与设置收敛、页头；构建期字典完整性校验 | `node build.mjs`；`verify/client-static.mjs`、`fde-client.mjs`、`client-runtime.mjs`；离线 harness 截图逐页复核 |
| 11.2.4 | `skills/**`、`methods/**`、`templates/**` | 与新界面对不上的页签名、按钮名、用词同步；不改方法口径 | `scripts/health-check.mjs`、`verify/open-source.mjs` |
| 11.2.5 | `README.md`、`CHANGELOG.md`、`AGENTS.md`、`docs/GETTING-STARTED.md`、`docs/ui-contract/`、`assets/`、`package.json`、`locale/` | 版本 2.0.0；上手教程与截图换成新界面；键盘操作说明移入教程 | `scripts/check-readme-version.mjs`、`scripts/release-preflight.mjs` |
| 11.2.6 | DSH 0.2.1 规范核对 | 对照本机 `@deepseek-ai/dsh@0.2.1-rc.5` 的清单、客户端注入、主题 token、技能与工具注册约定，记录差异并修复可在插件内解决的项 | 审计结论写入本节 11.5 |

### 11.3 验收

1. `node build.mjs` 通过（含字典完整性校验）；`node verify/all.mjs` 全绿；`node scripts/health-check.mjs` 0 FAIL。
2. 面板源码的中文文案里没有 ADR 0010 D1「不再出现」一栏的词，也没有内部标识。
3. 离线 harness 在 1440×900 与 1180×800 下逐页截图：今日、客户（看板 / 列表 / 任务）、客户抽屉、任务抽屉、资料、流程、情报、设置、空工作区、示例数据；明暗主题各一套今日与看板。
4. 存量看板读取：四条 `derived` 规则的待处理提醒被自动关闭，其它数据不变；`board.json` 结构版本不变。
5. 真实 DSH 重启后的人工验收由用户执行（本次不重启 DSH、不改 profile）。

### 11.4 回滚

解包 `.archive/dsh-fde-pre-v2-20261119-143501.tar.gz`，或切回 `main`。数据无迁移；被自动关闭的提醒在旧版本里表现为「已忽略」。

### 11.5 执行结果（2026-11-19）

| 工作项 | 状态 | 交付 | 验证 |
|---|---|---|---|
| 11.2.1 文档先行 | ✅ | `docs/adr/0010-v2-可交付版.md`（D1–D16）、`docs/01-spec.md` §22（含 §22.7 DSH 0.2.1 约定、§22.9 交给 AI 用哪个阶段的做法）、本节 | — |
| 11.2.2 宿主 | ✅ | 给人看的文本全部改写；四条规则标 `derived`；提醒「求值 → 失效与更新 → 生成 → 清理」；`stats.todo`；新模块 `src/host/tool-output.js`；`inject` 缩到 `tools` + `systemPrompt`；技能带 `source`；`/reveal` 传 `signal`；新建任务负责人空值；交接任务标题；删除个人目录兜底 | `fde-host` 318 → 478；`host-smoke` 55；`security` 70；`fde-scys-host` 110 → 115；`acceptance-audit` 669 → 682，全过 |
| 11.2.3 面板 | ✅ | 字典重写（改 308、补 28、删 51）；今日去重与按钮；看板列宽与卡片；客户抽屉 / 任务抽屉重排；流程页；设置页改了就存；页头；未就绪页；`appUrl()`；样式约定；清理 42 条无引用样式与 15 个无引用函数；`build.mjs` 两项检查（`tools/panel-checks.mjs`） | `client-static` 105 → 132；`fde-client` 122；`client-runtime` 191 → 234，全过；界面契约 8/8、漂移 0（基线 2） |
| 11.2.4 技能与方法 | ✅ | 16 个技能、7 篇方法、2 个模板、2 份参考：指路与用词对齐；否决项编号与实现对齐；产物文件名统一；悬空引用清理；简写标准速查里的符合度声明模板删除 | `health-check` 技能三项 OK；`open-source` 66；`fde-tools` 74 |
| 11.2.5 文档与发布件 | ✅ | `README.md`、`CHANGELOG.md`、`AGENTS.md`、`docs/GETTING-STARTED.md`、`docs/DEVELOPING.md`、`docs/ui-contract/`、`examples/README.md`、`locale/`、`package.json`（2.0.0、`engines.dsh <0.3.0-0`）、`assets/` 8 张新截图 | `check-readme-version`；`pack` 41 |
| 11.2.6 DSH 0.2.1 核对 | ✅ | 只读审计 4 个 P1 全部修复并有断言；P2 中的版本上界、接口地址、样式约定、图标尺寸、样式标签、外链校验、`DSH_HOME` 已修；其余列入 11.6 | 宿主子代理用官方包实测：16 个技能可加载、工具返回值零拒绝 |

| 11.2.7 独立审查与收尾 | ✅ | 请独立审查读完整份改动：没有会报错或写坏数据的问题，指出 9 条行为缺陷，全部修复——抽屉与设置页的草稿被别处更新冲掉、旧记录显示替换误伤用户写的标题、没开成会话时不给那段话、只多空格也算改动、流程页停在上次跳转的阶段、按提醒处理覆盖已写的下一步、导入结果提示、文案检查的引号盲区。核对其中一条时发现「交给 AI 给错了做法」（ADR 0010 D16 / spec §22.9），一并改正：做法跟着要补的材料走，看板卡片与抽屉读同一组条件 | `fde-host` 478 → 492；`client-runtime` 234 → 245；`fde-client` 122 → 123；`acceptance-audit` 682 → 696 |

`node verify/all.mjs`：全部验证通过。`node scripts/health-check.mjs`：14 OK / 4 WARN / 0 FAIL（WARN 与基线相同：缓存日期、历史审计报告里的路径、重启状态）。`node scripts/release-preflight.mjs`：通过（只检查，不发布）。

**桌面端 0.2.2-rc.5 实测（提交后追加）**：桌面端应用自带的运行时比命令行版新一个小版本。把它的官方包取到临时目录（不改应用），在真实的 cordis 上下文里装上插件：16 个工具通过真实的工具服务注册、经原生执行器逐个执行，无一被判出错；16 个技能经真实的技能服务加载通过；`engines.dsh` 范围按它的比较规则满足；路由注册函数签名、前端模块加载约定与 0.2.1 相同；面板向 DSH 注册的那段代码与 1.7.0 相比只改了名称。没有覆盖的仍是真实应用里的整体走查。

**试用后的三处调整（2026-11-20）**：① 阶段条被压扁、客户列表被裁掉——页面区块默认不再纵向压缩，补了矮窗口下的检查方法；② 方法库移出「领域模型合作」（方法 + 技能），换成「试点、交付与采用」，技能 16 → 15；③ 方法与参考文档脱敏（10 个文件、63 处，规则与口径不变）。见 ADR 0010 D17、spec §22.10。新方法和脱敏后的文档只做了自查和发布检查，没有请人逐篇读过。

**独立审查没有看到的范围（如实）**：`fde-schema.js` 与 `fde-prompts.js` 的完整差异、`fde-scys.js` 的授权目录改动、资料库 / 招采 / 资料页与文件预览的实现、样式与窄屏、文档与技能的改动、spec §22 与实现的逐条比对。这些只有自测和截图核对。

**界面核对方式**：离线渲染环境（面板源码 + 插件自己的 DSH 侧实现 + 合成工作区）逐页截图，1440×900 与 1180×800，今日与看板另有暗色。实施中靠截图发现了两处测试没覆盖到的缺陷（抽屉打开不核对推进条件、页面里残留的文案 key）。

**没有做的验证（如实）**：没有重启真实 DSH 做整体验收（按工作区规则不重启 DSH、不改 profile）；没有在 Windows 上重跑；没有用真实工作区的看板做写入测试（只读统计过其中记录文本的句式，用于显示替换的规则）。

**对存量数据的影响**：首次打开后，`stall` / `overdue` / `gate_ready` / `review_lag` 留下的待处理提醒会被自动关闭（标记 `expired`），条件已不成立的其它提醒同理；这次刷新会写一次盘（写前照常备份）。其余数据不变。

### 11.6 Backlog（本次不做）

- 拆分 `src/ui/ui-panel.js`（现 7500 行）：保持零构建依赖的前提下，用 `build.mjs` 按顺序拼接多个源文件；需要同步 6 个读取源码路径的验证脚本。
- 方法库缺口（部分已补）：试点、交付、采用的方法与四份骨架已补（`methods/04-试点交付与采用.md`，ADR 0010 D17）；`methods/00` 标题写「端到端」但只覆盖到出方案，还没改；实施计划没有单独的骨架文件。
- DSH 0.2.1 的新能力（未采用）：`ctx.connection.fetch.register`（路由自带鉴权，可替换自写守卫）；`plugins.bundle.config` / `activation`（把设置与首次引导放进官方「插件」页）；工具 `execute(args, exec)`（取消信号、按会话取工作区根与只读模式）；`ctx.locale`（界面多语言）；`ctx.credentials`（替代工作区里的授权文件）。
- 上一轮审计遗留、本次未动：GET 读路径在提醒有变化时会写盘（已做到无变化不写）；上传上限 300MB；面板字号仍有写死的 px（界面契约 A5 已在刻度内）。
- 离线渲染环境在仓库外（`plugin-audit/fde-v2/harness/`），v2 起需要按 `docs/DEVELOPING.md` §6 的说明补三处才能正确渲染；可考虑收进仓库的 `verify/` 下并接入 `verify/all.mjs` 做截图冒烟。
- 清理面板已不调用的旧路由（`/status`、`/projects`、`/scaffold`），见 ADR 0009 后果一节。
- `settings.sources.folderWatch` / `briefOnOpen` 两个无效字段从默认设置中移除（需要结构版本与校验同步）。

### 11.7 需要人确认的事项

1. **方法与参考文档里的具体数字和地名**（已处理，2026-11-20）。按所有者的决定脱敏：`methods/00`–`03`、`reference/雷区清单.md`、`reference/数据源清单.md` 等 10 个文件；`methods/04` 领域模型一篇整体移出。`methods/06` 的三个示例场景本来就标了「方法示例，不对应任何真实客户」，没有动。`docs/` 下的工程文档（规格、评估、复盘）里还有带行业描述的示例称呼，这次没有逐篇处理。
2. **按旧模板填过的场景评估表**。否决项编号 4、5、6 的含义在本版对齐了实现；工作区里有 1 份按旧模板建的 `scoping/场景评估.md`，复用前要重新核对编号。
3. **提交与发布**。改动都在分支 `feature/v2-delivery-refactor` 的工作树里，未提交；npm 发布、打 tag、推送都没有做。
4. **真实 DSH 验收**。重启 DSH 后按 `docs/GETTING-STARTED.md` 走一遍，重点看：技能能否加载、今日的提醒数量、打开客户抽屉是否直接显示推进条件、新建任务、设置改了就存、点「交给 AI 准备材料」后 AI 拿到的是不是要进入的那个阶段的做法。
5. **导入的客户放在哪一列**。工作区里现有的客户都是从文件夹导入的，是按「文件夹里有没有这个阶段的材料」放列的；当前列自己的条件没有通过记录（例如放在「方案」但可能还没有成本测算、报价单）。2.0 起交给 AI 准备的是进入下一列的材料，同时会在给 AI 的话里写明当前列还缺什么。哪几家放得太靠后、要不要拖回前一列，需要你看一眼决定（往回拖不需要条件）。
