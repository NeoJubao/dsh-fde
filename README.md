# FDE 工作站（`dsh-fde`）· DSH 插件

[![verify](https://github.com/NeoJubao/dsh-fde/actions/workflows/verify.yml/badge.svg)](https://github.com/NeoJubao/dsh-fde/actions/workflows/verify.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![docs: CC BY 4.0](https://img.shields.io/badge/docs-CC_BY_4.0-lightgrey.svg)](LICENSE-docs)

> 把「客户经营」从线索到采用做成**一屏可看、可推进、可验证、可复盘**的作战台：客户看板 + 今日注意力 + 8 阶段门禁 + 任务泳道 + FDE 方法库 + 资料库 + 招采关联。
> 跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里，中文界面，纯 JS，零运行时依赖。
> **版本：v1.4.0** ｜ 宿主：DSH `0.2.0-rc.2` ｜ 许可：代码 MIT / 内容 CC BY 4.0

![今日视图](assets/screenshot-today.png)

**它解决什么**：FDE / 解决方案 / 售前同学真正的问题是「客户一大把，今天该推谁、卡在哪、还差什么材料、agent 做完了没有」。这个插件把这些状态从人的脑子里外化成**可检查的数据**：

- **客户（engagement）** 沿 **8 个阶段**推进：线索 → 研判 → 会面 → **场景** → 方案 → 试点 → 交付 → 采用；阶段间有**门禁**（产物自动检查 + 人工确认），**agent 不能自行过门禁**。
- **任务（item）** 在 5 列看板流转：待办 / 进行中 / 等外部 / 待我审 / 已完成。
- **注意力（attention）** 汇总真正需要人决定、审阅、回答、解阻的事，推到「今日」；其余不打扰。
- **会话（session）** 由看板按阶段模板发起（handoff），agent 执行中通过 `fde_*` 工具回报进度、产物与受阻。
- **方法与技能**：8 篇 FDE 方法 + 16 个技能（11 个 `fde-*` 编排技能 + 4 个方法库 + 长文一页纸），方法随插件分发、可离线读。

## 安装

前置：DSH `0.2.0-rc.2`（含 Web GUI），Node ≥ 20。

```bash
# 方式一：GitHub 直装（当前可用）
git clone https://github.com/NeoJubao/dsh-fde.git
dsh plugin --profile web add ./dsh-fde

# 方式二：npm 包（已发布于 npm，推荐）
dsh plugin --profile web add dsh-fde

# 方式三：tarball
npm pack ./dsh-fde && dsh plugin --profile web add ./dsh-fde-1.4.0.tgz
```

安装后**重启 DSH**（或在「设置 → 插件」里对 `dsh-fde` 禁用→启用一次），侧栏出现「FDE 工作站」入口。客户端改动只需刷新页面。

安装助手（可选，只做 preflight，不手改 profile）：

```bash
python3 tools/install_profiles.py          # 检查环境并打印官方安装命令
python3 tools/install_profiles.py --run    # 实际执行 dsh plugin add
```

卸载：`dsh plugin --profile web remove dsh-fde`。回滚看板状态：删除工作区 `research/.fde/`（客户卷 `research/<客户>/` 不受影响）。

## 首次使用（3 分钟）

1. 打开侧栏「FDE 工作站」→「客户」→ **新建客户**（或「导入现有项目」扫描 `research/` 下已有目录）。
2. 在「今日」看注意力与建议；在「客户」→「看板 · 客户」拖动卡片推进阶段（**门禁未过会在抽屉里列出缺项**）。
3. 需要 agent 执行时，在客户抽屉点「启动会话」——它会带着阶段模板开始，并用 `fde_*` 工具回报。
4. 想看方法论：左侧「流程」页内「8 阶段流程 / 方法库 / 技能与模板」；想查采购/中标：客户抽屉的「招采」区，或「资料」页的「招采」子页签。

工作区约定：客户卷在 `<workspace>/research/<客户>/`；插件状态在 `<workspace>/research/.fde/`（看板 + 缓存 + 备份，**只由插件读写**）。插件不会把客户数据发到任何外部服务；唯一可选外联是「资料库」的 GitHub 指标（无 token）与「生财情报」（需你显式授权，见下）。

## 生财情报授权（三选一，按优先级）

「设置 → 生财情报授权」：

1. **链接授权（推荐）**：在生财 MCP 授权页拿到授权链接或 `access_token`，粘贴保存。插件存在本机 `<workspace>/research/.fde/scys-auth.json`（0600），可一键清除；token 不回显、不写日志。
2. **环境变量**：`FDE_SCYS_TOKEN`（可选 `FDE_SCYS_TOKEN_EXPIRES_AT`）。
3. **兼容旧文件**：只读 `~/.dsh/mcp/scys-mcp/tokens.json`（旧 scys-mcp 插件维护，不属 DSH 官方契约，不推荐）。

都未授权时，情报功能显示 `UNAUTHORIZED + 去授权`，不影响其它功能。

## 它做什么 / 不做什么

**做**：客户生命周期状态、任务看板、注意力与今日简报、阶段门禁、会话交接、FDE 方法库与技能、资料库、招采关联、场景评估与成本报价两个可复算工具（`fde_scenario` / `fde_quote`）。

**不做**（边界纪律）：不是 CRM（不管金额预测 / 合同 / 回款）；不是 IM；不做多 agent 调度；不做云端多租户；**不自动推进阶段、不自动过门禁、不自动对外发送、不自动删除/归档客户**；不把客户数据上传到任何外部服务；不改写客户卷定稿。

## 工具与技能

| 类别 | 清单 |
|---|---|
| FDE 编排工具（11） | `fde_board` · `fde_engagement` · `fde_item` · `fde_attention` · `fde_brief` · `fde_harvest` · `fde_bid` · `fde_library` · `fde_scenario` · `fde_quote` · `scys_fde` |
| 执行工具（5） | `rw_status` · `rw_scaffold` · `rw_export_pdf` · `rw_qa_pdf` · `rw_method` |
| 编排技能（11） | `fde-engagement` / `fde-discovery` / `fde-meeting` / `fde-scoping` / `fde-solution` / `fde-pilot` / `fde-delivery` / `fde-adoption` / `fde-board` / `fde-harvest` / `fde-bid-radar` |
| 方法库技能（4） | `company-research` / `meeting-prep` / `proposal-forge` / `domain-model-partnership` |
| 通用技能（1） | `longdoc-brief`：长文压成一页纸（阅读版 + 传阅版） |

## 面板（5 页签 + 页内子页签）

导航只保留 5 个页签，细粒度视图收进页内子页签；设置不占页签，走页头齿轮入口（结构契约见 [`docs/ui-contract/layout.md`](docs/ui-contract/layout.md) §7）。

| 页签 | 页内子页签 | 做什么 |
|---|---|---|
| **今日** | — | 战况、待我处理（注意力，按类型分组）、建议、今日焦点、最近活动 |
| **客户** | 看板 · 客户 / 看板 · 任务 / 客户清单 | 客户 8 阶段看板、任务 5 泳道看板（拖拽推进，未过门禁弹缺项）、客户表与筛选、导入现有项目、**新建客户/任务** |
| **资料** | 资料库 / 招采 | 资料库：权威资料、开源工具、方法模板、社区动态；招采：本地招采索引检索（招标/中标/候选/提及）、按客户匹配 |
| **流程** | 8 阶段流程 / 方法库 / 技能与模板 | 阶段地图（目标 / 输入 / 关键动作 / 交付物 / 工具 / 常见坑 / 门禁）、方法/参考全文、方法模板与 FDE 技能清单 |
| **文件** | — | 按客户/阶段聚合 md/pdf/docx，Finder 定位、按需导出 PDF、重扫工件 |
| **设置** | —（页头齿轮） | 自主性、停滞阈值、WIP 上限、数据源开关、生财授权、健康检查 |

> 迁移兼容：旧 state 值（`board` / `library` / `bids` / `artifacts` / `methods` / `settings`）会被映射到新页签（未知值回落「今日」），不会白屏。

![客户看板](assets/screenshot-board.png)

![资料库](assets/screenshot-library.png)

## UI 契约（ui-contract）

面板的**结构 / 视觉 / 取值**写在 [`docs/ui-contract/`](docs/ui-contract/)，改界面前先读它（不是自由发挥，也不是「重画一套皮」）：

- **结构**：[`layout.md`](docs/ui-contract/layout.md) —— 区域树、落位决策树、22 个区域白名单（每行写「禁止放什么」）、页型、焦点位、导航准入、附录 C 迁移清单；
- **视觉**：[`design.md`](docs/ui-contract/design.md) —— 五条原则、字体/间距/表面/几何/颜色语义与视觉禁止清单（只写 token 名，不写值）；
- **取值**：[`tokens.md`](docs/ui-contract/tokens.md) —— `--fde-*` 现状全表与目标映射、官方 token 分组、逐项替换清单；
- **区域 id**：[`region-ids.md`](docs/ui-contract/region-ids.md) + `region-ids.mjs` —— 22 个稳定 id、`region()` helper 与页型校验。

```bash
node docs/ui-contract/audit-ui-contract.mjs   # 8 项体检（可失败；--selftest 证明脚本能失败）
node verify/ui-contract.mjs                   # advisory 汇总：始终 exit 0，只报 drift 数
```

**迁移状态（如实）**：契约是**目标态**，当前面板是 as-built。已接入 advisory 体检（`verify/all.mjs` 会跑，但**不阻断**发布），迁移期已知 drift：A4 `:hover` 未包媒体查询 / A5 字号 13 种 / A7 页内重复全局控件 / A8 几何未接官方 token；`data-region` 标注 0 处。分批计划见 [`docs/ui-contract/README.md`](docs/ui-contract/README.md) §6。

---

## 兼容性与依赖


| 项 | 要求 |
|---|---|
| DSH | `0.2.0-rc.2`（`engines.dsh: >=0.2.0-rc.2 <0.3.0`；当前版本按 `peerDependencies` 判兼容） |
| Node | ≥ 20 |
| 运行时依赖 | **零**（不 import `@deepseek-ai/*`，服务一律 `ctx.get()` 懒取、缺失降级） |
| 可选：招采雷达 | 独立插件 `bid-intel` 提供只读 `bidIntel` 服务；未安装时招采功能显示「未就绪」，不报错 |
| 可选：PDF/DOCX 导出 | `python3` + `weasyprint` + `poppler`（`make-pdf.sh`）；DOCX 需自备兼容 `build_docx.py` 契约的生成器（`scripts/md2docx.py --skill-dir`），否则只交 md |

> 插件源码更新后：宿主半（`index.js` / `src/host/`）需重启 DSH（或禁用→启用）；客户端半（`client.js`）刷新页面即可。

## 仓库结构与验证

```
index.js / src/host/      宿主半（工具、路由、提示词、技能注册、看板状态、资料库、计算工具）
src/ui/ui-panel.js        客户端半（面板源码）→ node build.mjs → client.js
methods/ skills/ templates/ reference/   方法与技能（随包分发，可离线读）
docs/                     规格（01-spec）、ADR、复盘、研究底稿（docs/research 不随开源仓库分发）
verify/                   一键验证（干净检出也能跑）
tools/install_profiles.py 安装 preflight 助手
examples/                 合成示例客户（演示用，不含真实数据）
```

```bash
node build.mjs               # 生成 client.js，并校验与源码一致
node verify/all.mjs          # 全量验证（宿主冒烟 / 安全 / 内核 / 工具 / 面板 / 打包 / 自检）
node scripts/health-check.mjs
node scripts/check-readme-version.mjs
```

## 隐私与安全

- 客户数据只在本机工作区：插件读 `research/`、写 `research/.fde/`；不向外部发送客户内容。
- 路由有来源守卫（`connection.admit`，缺失时本机 Host/Origin fence）+ 方法白名单 + JSON 限制；路径经过白名单与 `realpath` 校验；看板写入采用备份 + 原子写 + revision 乐观并发。
- **红线**：agent 不能推进阶段、过门禁、归档客户、对外发送材料；这些只能由人在面板执行。
- 生财授权 token 只存本机授权文件（0600）或环境变量；不写日志、不回显。
- 发现安全问题请走 `SECURITY.md`，不要公开提 Issue。

## 许可

- **代码**（`index.js`、`src/`、`tools/`、`scripts/`、`verify/`、`build.mjs`）：**MIT**，见 [`LICENSE`](LICENSE)。
- **方法与文档**（`methods/`、`skills/`、`templates/`、`reference/`、`docs/`、README 正文）：**CC BY 4.0**，见 [`LICENSE-docs`](LICENSE-docs)。
- 第三方内容（ASD-STE100 摘要、生财经验参数、资料库外链）的来源与许可见 `LICENSE-docs` 末节。

## 文档

- 规格：[`docs/01-spec.md`](docs/01-spec.md)（唯一事实来源）
- 决策：[`docs/adr/`](docs/adr/)（0001 工作站 / 0002 招采 / 0003 资料库与流程 v2 / 0004 开源就绪）
- UI 契约：[`docs/ui-contract/`](docs/ui-contract/)（结构 / 视觉 / 取值 / 区域 id / 8 项体检；迁移中）
- 发布：[`docs/RELEASE.md`](docs/RELEASE.md)（发布前清单、npm/git 命令、回滚、人工确认）
- 方法与技能：[`methods/`](methods/)、[`skills/`](skills/)
- 贡献：[`CONTRIBUTING.md`](CONTRIBUTING.md)、审查规则 [`REVIEW.md`](REVIEW.md)、给 AI 协作者 [`AGENTS.md`](AGENTS.md)

## 不构成什么

报价、评分、门禁与规则均为**方法默认值与实践总结**，不构成行业标准、法律意见或对外承诺；对外报价、客户交付与合规判断须由人复核。

---

**状态**：可安装的开发者预览版；宿主兼容范围见「兼容性与依赖」，后续按 SemVer 发布。
