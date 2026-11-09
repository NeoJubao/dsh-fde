# 更新日志

本文件记录 `dsh-fde`（FDE 工作站）的用户可见变化。版本号遵循 SemVer；插件市场与 `dsh plugin add` 以 `package.json` 的版本为准。

## 1.3.1 — 2026-11-09（仓库内部发布准备，未单独发布到 npm）

发布卫生修复（不改变功能）：

- 移除误提交的 `scripts/__pycache__/`（Python 字节码）；`.gitignore` 与 `verify/pack.mjs` 增加拦截。
- 版本断言改为从 `package.json` 单一来源读取（`pack.mjs` / `open-source.mjs`），避免发版时漏改。
- README 明确 npm 安装方式已可用。

## 1.5.0 — 2026-11-09

首次上手：只读演示模式 + 一键清除（ADR 0006）。

- **空工作区自动进入演示模式**：内置示例数据（4 个示例客户跨 4 阶段、3 个任务、2 条注意力、4 条活动，名字统一带「（示例）」），只读覆盖层，**不写 board、不创建客户卷**。
- **只读拦截**：演示期间所有写操作（拖拽/新建/注意力/门禁/启动会话/抽屉操作）被集中拦截并给行内提示，不发出任何写请求。
- **一键清除**：「开始使用（清除示例）」→ `POST /fde/settings {patch:{demoDismissed:true}}` 持久化，示例不再出现；清除后空态给三步引导（新建客户 / 导入现有项目 / 重新查看示例）。
- **重新查看**：设置页「演示数据」卡可写回 `demoDismissed:false`（仅真实看板为空时显示示例；有真实数据时不干扰）。
- **文档**：新增 [10 分钟上手教程](docs/GETTING-STARTED.md) 与 [开发者教程](docs/DEVELOPING.md)（1.4.1 已完成仓库侧，本版随 npm 一起发布）；README 链接/图片改绝对地址（npm 页面可渲染）。

## 1.4.1 — 2026-11-09（仓库内部，未单独发布到 npm）

文档与 npm 页面修复（不改变功能）：

- README 的图片与仓库内链接改为绝对地址，npm 页面可正常渲染（此前相对路径在 npm 上 404）。
- README 安装方式恢复「npm 优先」（1.4.0 已发布），补上手教程与开发者教程入口。
- 新增 `docs/GETTING-STARTED.md`（10 分钟上手）与 `docs/DEVELOPING.md`（扩展/测试/发布）。

## 1.4.0 — 2026-11-09

信息架构收敛（ADR 0005），并汇总此前已进仓库、但未随 1.3.0 上 npm 的加固与视觉对齐：

- **导航 9 → 5 页签 + 页头设置入口**：今日 / 客户 / 资料 / 流程 / 文件；客户页内「看板·客户 / 看板·任务 / 客户清单」，资料页内「资料库 / 招采」，流程页内「8 阶段流程 / 方法库 / 技能与模板」；设置改为页头齿轮，旧状态值回落「今日」，无死路由。
- **A7 重复全局控件清零**：页内重复的「刷新 / 自主性徽章」删除，只保留壳层一处；块级刷新保留。
- **宿主内核加固**（Phase 3）：`rw_*` 子进程优先 `ctx.subprocess`（不可用时脱敏 `execFile` + 显式 cwd）；`rw_export_pdf` / `rw_qa_pdf` 路径锁定工作区；JSON 响应 `Cache-Control: no-store` + `nosniff`；`presentCall.kind` 归一到官方枚举；board 原子写 `wx` + `0600`；agent 不得自行 resolve `decision` / `blocked` 注意力。
- **客户端加固**：请求 8s 超时（慢路由按路径放宽）、隐藏页暂停轮询 + 恢复补拉、GET 在途去重；React key 告警清零；正文基准接 `--dsh-content-font-size`。
- **视觉对齐 DSH 官方 token**：中性描边 0.5px（spinner 豁免）、圆角/胶囊/材质/`:hover`/字号接 `--dsw-radius-*` / `--dsw-elevation-*` / `@media (hover:hover)`；ui-contract 体检 drift 0。
- **ui-contract v1 并入仓库**（`docs/ui-contract/`）：结构 / 视觉 / 取值 / 区域 id / 可执行体检 + 自测 fixture；`verify/ui-contract.mjs` advisory 接入 `verify/all`。
- **发布手册与预检**：`docs/RELEASE.md`、`scripts/release-preflight.mjs`。
- **发布卫生**：移除 `__pycache__`；版本断言改为从 `package.json` 单一来源读取；npm 安装方式已在 README 标注可用。

## 1.3.0 — 2026-11-08（首个开源版本）

开源就绪改造（决策见 `docs/adr/0004-open-source-readiness.md`）：

- **改名与发布**：包名 `@local/research-workbench` → `dsh-fde`，版本 `0.1.0` → `1.3.0`；补 `license`/`repository`/`engines.dsh`/`peerDependencies`/`keywords`/`publishConfig`；`private` 移除，可通过 npm 公开发布。
- **许可**：代码 MIT、方法与文档 CC BY 4.0，见 `LICENSE` 与 `LICENSE-docs`。
- **安装**：安装方式改为 DSH 官方机制 `dsh plugin --profile <name> add <spec>`；`tools/install_profiles.py` 改为 preflight 助手，不再直接改写 profile 清单/锁文件。
- **隐私**：清除公开产物中的真实客户名、真人姓名与联系方式（示例统一为「某集团有限公司 / 张三」）；旧版 `docs-workbench.md` 与测试 PDF 样本移出发布集。
- **生财情报**：新增**链接授权**路径（面板「设置 → 生财情报授权」粘贴授权链接或 token，存本机 `research/.fde/scys-auth.json`），并保留环境变量与旧 token 文件两条兼容路径；token 不回显、不写日志。
- **首启**：客户页与任务看板新增「新建客户 / 新建任务」入口；空态可直接开店。
- **修复**：方法页技能列表为空、逾期状态在表格/今日不可见（`.fde-warn` 死类）、工件页按钮嵌套导致 HTML 非法、打开会话被误判失败并重复重试。
- **界面**：今日页去重（删除页内重复的刷新/自主性控件与重复数字）、待处理按类型分组折叠；看板列宽自适应并新增横向滚动提示；适配宿主的窗口 chrome 顶部留白（macOS 桌面）。
- **验证**：干净检出（无 `../research`）也能跑通 `node verify/all.mjs`；新增 `verify/open-source.mjs` 与 GitHub Actions。

## 1.2.0 — 2026-11-04

- 新增生财 FDE 情报（`scys_fde` 工具与缓存，只读）。
- 新增 `fde_scoping` 场景阶段相关能力的基础。

## 1.1.0 — 2026-11-03

- 并入招采雷达客户关联层（`fde_bid`：匹配 / 关联 / 提升为跟进任务）。
- 看板卡片显示招采匹配徽章。

## 1.0.0 — 2026-11-03

- FDE 工作站首个版本：8 阶段客户生命周期、任务看板、注意力、今日简报、门禁、会话 handoff、11 个编排技能与 8 篇方法。
