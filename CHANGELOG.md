# 更新日志

本文件记录 `dsh-fde`（FDE 工作站）的用户可见变化。版本号遵循 SemVer；插件市场与 `dsh plugin add` 以 `package.json` 的版本为准。

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
