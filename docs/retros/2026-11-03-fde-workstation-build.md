# 复盘：FDE 工作站构建（2026-11-03）

- 日期：2026-11-03
- 类型：项目复盘（插件重构）
- 影响：现有调研工作台 → FDE 工作站（宿主内核 + 六视图面板 + 9 技能 + 治理文档 + 独立审计）
- 状态：**v1 已交付；F1–F8 已修复，第二轮独立审计 395/395 全绿（P0/P1/P2=0）**
- 相关：`docs/00-intent.md`、`docs/01-spec.md`、`docs/02-plan.md`、`docs/adr/0001-fde-workstation.md`、`verify/audit-report.md`

## 一、做了什么（按时间，事实）

| 时间 | 动作 | 结果/证据 |
|---|---|---|
| 14:26 | 立项：抓取 ainative.jubao.ai 全站、克隆 dsh-superagent、盘点现有插件 | `docs/research/handbook-extract.md`、`superagent-extract.md`、`current-workbench.md` |
| 14:32 | 写 intent / spec / plan（先文档后代码） | `docs/00-intent.md`、`01-spec.md`、`02-plan.md` |
| 14:34 | 快照现有插件 | `.archive/research-workbench-baseline-20261103-143539.tar.gz` |
| 14:38 | 三路并行开发：宿主内核 / 六视图面板 / 技能与治理文档 | 5 个宿主模块 ~3100 行；面板 4534 行；9 技能 + AGENTS/REVIEW/ADR/health-check |
| 14:52 | 首次集成验证 | `verify/all.mjs` 全绿（fde-host 158 / client-static 49 / fde-client 66 / client-runtime 82 / pack 7） |
| 15:00 | 解决两个环境问题：npm 缓存 EPERM（pack 测试改临时 cache）、宿主生效方式（plugin_manager 禁用→启用触发 live reload） | `verify/pack.mjs`；`/fde/meta` 由 404 → 401（路由挂载、守卫生效） |
| 15:04 | 看板初始化：adopt scan → apply 导入 9 个客户；每条设「核对导入信息」下一步 | `research/.fde/board.json`；`fde_board` 工具实测可读 |
| 15:06 | 独立审计（verifier，未参与实现）：374 条独立断言 | `verify/acceptance-audit.mjs`、`verify/audit-report.md`；P0=0、P1=3、P2=5 |
| 15:10–15:25 | 修 F1–F8（红线代码化 / handoff 闭环 / CAS / 派生污染 / 路径守卫） | `verify/host-fix-report.md`；fde-host 181/181、acceptance-audit 395/395 |
| 15:26 | 第二次 live reload + 红线实测（工具 archive 被拒）+ board revision 迁移 | `research/.fde/board.json` revision=1；`verify/all.mjs` 10 步全绿 |
| 15:30–16:00 | 招采雷达并入（v1.1）：只读服务 `bidIntel` + 客户匹配/关联/提升/信号 + 第 7 页签「招采」+ `fde-bid-radar` 技能与招采口径（host-dev/client-dev/docs-dev 并行） | **已完成并 live 验证**：`fde_bid match` 某研究院=≈1730（采样 53）、`search 某超算公司`=6 条、0 命中客户优雅降级；第三轮审计 450/450、P0/P1/P2=0；verify/all 全绿 |

## 二、为什么这么做（当时判断与事后回看）

| 决策 | 当时依据 | 事后回看 |
|---|---|---|
| superagent 走「设计借鉴 + 自研」（路线③） | 21/21 peer 要 0.2.1-alpha.2、本机 0.2.0-rc.2 会被兼容性预检拒绝；场景也不匹配 | 正确：自研约 3100 行宿主即覆盖所需语义，零新依赖 |
| 在现有插件内演进，不新建包 | 复用 12 条路由的安全栈、methods/scripts、profile link 安装链 | 正确，但 index.js 增至 1423 行，后续应拆 routes/tools |
| 状态用单 JSON + 原子写 | 单机、数据量小、可读可回滚 | 基本正确，但**漏了 revision/CAS**（审计 F3），轮询+agent 并发会丢更新 |
| 技能用 `ctx.skills.register` 运行时注册 | 单一来源、随插件升级 | 正确且 live reload 后已验证出现 13 个技能 |
| 默认自主性 observe + 硬红线 | 高后果场景先建议后执行 | 方向正确，但**红线只写在提示词、没代码化**（审计 F1），工具仍可 force 推进 |
| 假设「宿主改动必须重启」 | 现有 README 的自述 | 错：`plugin_manager` 禁用→启用可触发 profile 重组与模块重载，本次实测免重启生效 |

## 三、遇到了什么（现象 → 处理 → 根因）

| 现象 | 当时处理 | 根因 |
|---|---|---|
| `verify/all.mjs` 的 pack 检查红（npm EPERM） | pack.mjs 改用临时 `npm_config_cache` | `~/.npm` 缓存被其他账户写过；环境问题不是代码问题 |
| 面板同事未落盘 11 分钟，疑似卡住 | 发消息要求增量落盘、先兼容页 | 大文件一次写风险高；分块落盘 + 早期跑构建 |
| 旧测试写死「恰好 12 条路由」「22 条 UI 字面量」 | 两位开发同步更新断言 | 测试把现状当契约；需要「断言同步」纪律 |
| 独立审计发现 agent 可 force 推进/归档，且 timeline 记 `by:"human"` | 工具层拒绝 + by 如实传递（F1） | 红线只在提示词，未在代码层；留痕字段硬编码 |
| 审计发现 GET /board 的 proposal 写回会用旧快照覆盖并发写 | 加 revision + CAS，写前重读合并（F3） | 单 JSON 简化时低估了「轮询 + 会话并发」这一正常用法 |
| engagement handoff 提示词要求 report 但无 itemId | handoff 自动建/复用执行 item 并写进提示词（F2） | 提示词与工具契约没有端到端对齐测试 |
| 无法验证真实 GUI 渲染 | 如实报告限制；用迷你 React + 静态断言覆盖 | 本机 GUI 需认证 URL；按验证纪律不索取凭据 |
| live reload 后新工具立刻出现在本会话 | 用 `fde_board` 实测读看板 | 插件管理禁用→启用会触发模块重载 |

## 四、下次怎么做

| 行动 | 负责人 | 截止 | 状态 |
|---|---|---|---|
| F1–F8 修复并以 `acceptance-audit.mjs` 全绿为门 | host-dev | 本次 | 已完成（395/395） |
| 修复后做第二次 live reload + `fde_board`/红线实测 | Lead | 本次 | 已完成 |
| v1.1 招采雷达并入：contract→host→client→audit→live 实测 | Lead + 3 队友 + verifier | 2026-11-03 | 已完成（450/450，live 实测通过） |
| 把 `acceptance-audit.mjs` 纳入 `verify/all.mjs`（作为独立审计门） | Lead | 本次 | 已完成 |
| 给 `board` 写路径补 CAS 回归测试（读快照→并发写→不丢） | host-dev | 本次 | 已完成（acceptance-audit 与 fde-host 覆盖） |
| 拆 `index.js` 为 `fde-routes.js` / `fde-tools.js` | 后续 | 下一次迭代 | 待排 |
| 真实浏览器验证（用户刷新后手动确认明暗主题与拖拽） | 用户 | 重启/刷新后 | 待确认 |

## 五、Harness 反馈（六类）

| 类别 | 这次的问题 | 改哪里 | 状态 |
|---|---|---|---|
| 导航 | 文档分散在 `docs/`、`methods/`、`research/`，新会话找入口慢 | `AGENTS.md`（两级）、`README.md` 目录表 | 已建 |
| 自动检查 | 既有 verify 把路由数/文案写死；审计能力此前没有 | `verify/all.mjs` 纳入 fde-host/fde-client/health-check；`acceptance-audit.mjs` 作独立门 | 部分完成 |
| 规则与审查 | 实现者自测全绿仍漏掉 3 个 P1 | `REVIEW.md` + 独立 verifier 任务模式；审计脚本进验收入口 | 已建立机制 |
| 权限与护栏 | agent 工具可 force 推进阶段/归档；红线只在提示词 | `index.js` fde_engagement 工具层拒绝 + `by` 如实留痕；`docs/01-spec.md` §7 | 修复中 |
| 工具与开销 | 客户端单文件 236KB；轮询 12s；宿主 1423 行单文件 | `build.mjs` 支持多源拼接；拆 routes/tools；轮询参数进 settings | 待排 |
| 信息获取 | `web_fetch` 外网失败需 curl；GUI 认证无法自动化 | `AGENTS.md` 已写；验证边界写进 README | 已记录 |
