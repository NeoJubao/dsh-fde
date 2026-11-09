# FDE 工作站 · UI 契约（ui-contract v1）

> **状态**：v1 已并入 `docs/ui-contract/`（2026-11-08 Phase 1）；**Phase 2 结构收敛已落地**（2026-11-09）：
> 导航 9 → 5 页签 + 页头设置入口、A7 页内重复控件清零，`audit-ui-contract.mjs` 8 项 **全部 PASS**（drift 0）。
> 尚未迁移的是 `data-region` 标注（0 处，按 `layout.md 附录 C` 的 7 步）与统一 page-header 等结构细节；
> 体检仍由 `verify/ui-contract.mjs` 以 **advisory** 方式记录（不阻断发布）。
> 契约正文是**仓库文档**（随 GitHub 仓库分发），不进 npm 包。

## 1. 四件套是什么

| 文件 | 管什么 | 权威性 |
|---|---|---|
| `layout.md` | **结构**：区域树 / 落位决策树 / 区域白名单（含每行「禁止放」）/ 页型 / 焦点位 / 内容路由 / 导航准入 / 非 happy path / 变更流程 / 反模式 + 附录 A as-built、B 映射、C 迁移清单 | 结构唯一权威；**不写颜色字号值** |
| `design.md` | **视觉规则**：五条原则 / 字体角色 / 间距节奏 / 表面与层级 / 几何 / 颜色语义 / 组件状态矩阵 / 图标文本 / 明暗 / 禁止清单 / 验收 | 视觉规则唯一权威；**只写 token 名不写值** |
| `tokens.md` | **取值**：现状 `--fde-*` 全表（含浅/深实测值、引用数、处置）+ 目标映射 + 官方 token 分组 + 替换清单 + 例外 | 取值唯一权威；颜色值只在这里 |
| `region-ids.md` + `region-ids.mjs` | **稳定 id**：22 个区域 + 白名单元数据 + 页型映射 + `region()` helper + 断言函数 | 代码可引用；与 `layout.md §2` 强制一致 |
| `audit-ui-contract.mjs` | **体检**：8 项自动检查，可执行、可失败（退出码 0/1/2，末尾 `AUDIT-JSON`） | advisory 入口：`verify/ui-contract.mjs`；迁移期红项不阻断发布 |
| `selftest/ui-panel.broken.js` | **自测 fixture**：迁移前源码 + 3 处故意违规（白名单外区域 / 裸 `#ff00ff` / 主题选择器）；**已按发布脱敏口径替换合成占位**（客户名/人名/地点 → 某集团/张三/某园区） | 证明「体检脚本能失败」（`--selftest` 预期 exit 1，8 项 FAIL） |

顺序是 **as-built → 规范**：先读 `layout.md 附录 A`（现状）与审查期证据（见 §7），再读 `layout.md §1–§10`（目标）。

## 2. 怎么跑（在插件根目录）

```bash
# 体检（默认读 src/ui/ui-panel.js；JSON 里的 source 是相对路径）
node docs/ui-contract/audit-ui-contract.mjs
node docs/ui-contract/audit-ui-contract.mjs --json

# advisory 汇总（被 verify/all.mjs 调用；始终 exit 0，只报 drift 数）
node verify/ui-contract.mjs

# 自测：证明「脚本能失败」（fixture 含 3 处故意违规，预期 exit 1）
node docs/ui-contract/audit-ui-contract.mjs --selftest
#   同一 fixture 也可显式指定（相对路径会先按 cwd、再按契约目录解析）：
node docs/ui-contract/audit-ui-contract.mjs --source docs/ui-contract/selftest/ui-panel.broken.js

# 指定别的源码 / 契约目录（迁移或对比用）
node docs/ui-contract/audit-ui-contract.mjs --source path/to/ui-panel.js --dir docs/ui-contract
```

退出码：`0` 全部通过 / `1` 有违规 / `2` 运行错误。advisory 包装 `verify/ui-contract.mjs` **始终 `0`**。

### 2.1 基线（2026-11-08 23:24 实测，迁移前源码）

```
PASS A1  区域名 ⊆ 白名单 / layout.md §2 与注册表一致（22 个区域）
PASS A2  无写死色值（回退值除外）—— 48 处 var() 回退待收拢
PASS A3  无主题选择器
FAIL A4  :hover 位于 @media (hover: hover) 内 —— 24 处全部在外
FAIL A5  字号 ⊆ 官方 type scale —— 13 种字号，7 种越界
PASS A6  每页型 空/错/载 三态（存在性通过；质量项见 layout.md §8）
FAIL A7  重复全局控件 —— 6 处页内重复（今日/看板/客户/工件/方法 + 自主性）
FAIL A8  几何 token —— 105 项：圆角越界 45 / 缺 corner-shape 9 / 1px 描边 47 / dashed 1.5px 2 / 材质 2
INFO A1b 源码 data-region 标注 0 处（迁移前预期）
```

> 基线会随源码改动小幅漂移（数字与行号都变），以当次 `audit` / `verify/ui-contract.mjs` 输出为准，不要抄报告数字。
> 自测 fixture 是**冻结**的迁移前源码（102 项 A8），只用于证明脚本能失败，不跟随源码更新；除 3 处故意违规外，其余内容按发布脱敏口径处理过（无真实客户名/人名）。

**迁移进度（2026-11-09 观测）**：A4（`:hover` 包裹）、A5（字号 13 → 6 种）、A7（页内重复全局控件清零）、
A8（几何/材质 token）均已 PASS，drift **0**；`data-region` 仍为 0 处（结构标注迁移未开始）。以当次输出为准。

## 3. 8 项检查各查什么

| id | 检查 | 判定 | 迁移后期望 |
|---|---|---|---|
| A1 | 区域名 ⊆ 白名单；`layout.md §2` 与 `region-ids.mjs` 一一对应；每行「禁止放」非空 | 硬失败 | PASS + 源码标注 >0 |
| A2 | CSS/内联样式无裸色值（只允许 `var(--token, 回退)`） | 硬失败 | PASS（回退收进 tokens） |
| A3 | 无 `prefers-color-scheme` / `data-ds-dark-theme` 等主题选择器 | 硬失败 | PASS |
| A4 | 每个 `:hover` 都在 `@media (hover: hover)` 内 | 硬失败 | PASS |
| A5 | `font-size` ∈ 11/12/13/14/16/18/20/24 | 硬失败 | PASS |
| A6 | 每个页型组件至少出现一次 Loading / Empty / Error 组件 | 硬失败 | PASS（质量由人工） |
| A7 | 页内不得重复壳层全局控件（刷新/自主性） | 硬失败 | PASS |
| A8 | 圆角 ∈ 6 档 token（或 50%/999px + corner-shape）；中性 solid 描边 0.5px；高层级表面不叠 border+elevation | 硬失败 | PASS |

## 4. 没自动化、必须人工的

1. **决策树 totality**：新需求是否走到唯一区域（`layout.md §1`）——靠 PR 里的「落位记录」一行。
2. **明暗 × 宽/中/窄 × 空/错/载 截图矩阵**（`design.md §11`）。
3. **焦点陷阱 / 键盘遍历 / 抽屉返回路径**（`layout.md §5`）。
4. **同屏控件重复的语义判断**（A7 只数「刷新/自主性」，其他重复要人看）。
5. **对比度**（状态色当小字正文这类，需按用途判断；数值可用离线 harness probe 复核）。
6. **真实宿主渲染**（窗口 chrome 避让、用户字号、右栏挤压）——需人工重启 DSH 后截图。

## 5. 与 ui-contract 方法的对应（审查期对标调研 §4.5 的七步；该报告不随仓库分发）

| 步 | 产出 | 状态 |
|---|---|---|
| 1 量现状 | `layout.md 附录 A` + 审查期截图/DOM 度量（不随仓库分发，见 §7） | ✅ |
| 2 config.md | 起点判 C（有视觉实践、无结构规范）；路径表见本文件 §1 | ✅（信息在本文件，未单列 `config.md`） |
| 3 layout.md | `layout.md`（§1–§10 + 附录 A/B/C） | ✅ |
| 4 design.md + token 文件 | `design.md` + `tokens.md`（目标 `src/ui/tokens.css` 尚未建，迁移第 2 批做） | ✅ 文档 / ⏳ 落地 |
| 5 资产层 | `region-ids.mjs`（REGION_IDS + REGION_META + `region()`） | ✅ |
| 6 强制层 | `verify/ui-contract.mjs`（advisory）已接入 `verify/all.mjs`；`AGENTS.md`「改 UI 先看 layout.md」待补 | ✅ advisory / ⏳ 强制 |
| 7 体检脚本 | `audit-ui-contract.mjs`（8 项 + `--selftest` 自测） | ✅ |

## 6. 迁移状态与下一步（as-built → 目标态）

| 项 | 状态 |
|---|---|
| 区域注册表（22 个 + 白名单 + 页型映射） | ✅ 完成 |
| `layout.md §2` ↔ 注册表一致（audit A1） | ✅ PASS |
| 源码 `data-region` 标注 | ❌ 0 处（按 `layout.md 附录 C` 的 7 步迁移） |
| 字号登记（A5） | ✅ 已迁移（13 种 → 6 种合法字号，2026-11-08 23:31 PASS） |
| hover 包裹（A4） | ✅ 已迁移（`:hover` 全部包进 `@media (hover: hover)`，23:31 PASS） |
| 页内重复全局控件（A7） | ✅ 已迁移（Phase 2：删除今日/看板/客户/文件/方法页内刷新与看板页内自主性徽章，只留壳层一处；块级刷新按设计保留；`A7 PASS`） |
| 几何/材质 token 替换（A8） | ✅ 已迁移（2026-11-08：圆角 45→0、胶囊 9/9、描边 47→1（spinner 豁免）、`:hover` 24→0、字号 13→6 种；A8 PASS） |
| 导航收敛 9 → 5 页签 + 页头设置入口（layout.md §7） | ✅ 已迁移（Phase 2：今日/客户/资料/流程/文件 + 齿轮设置；客户三态、资料两态、流程三态；旧 state 值回落今日） |
| 统一 page-header / 抽屉 L2 返回 / 设置保存位 | ⏳ Phase 2 后续（本轮只动导航与页内子页签，未重排页头/抽屉） |

**分批建议**（按 `03-设计审查与ui-contract.md` 的 P0/P1 清单，报告不随仓库分发）：

1. **第 1 批（S，1–2 天）**：~~A4 hover 包裹~~ ✅ 已完成；**A7 删页内刷新/自主性**（剩项）；`.fde-warn` 死类；首启「新建客户」入口（P0，Phase 0 已做，见 ADR 0004 D7）。
2. **第 2 批（S–M，2–4 天）**：~~A5 字号~~ ✅ 已完成；~~A8 圆角/描边/材质替换~~ ✅ 已完成（`tokens.md §4/§6` 机械替换；如后续需要独立 `tokens.css` 再拆）。
3. **第 3 批（M–L，Phase 2）**：~~nav 9→5 页签 + 页内子页签~~ ✅ 已完成（2026-11-09，见上方迁移状态）；剩统一 page-header、抽屉层级、设置保存位。
4. **贯穿**：每加一个区域先改 `layout.md §2` + `region-ids.mjs` + 附录 C，再跑 `audit`（A1 会挡不一致）。

## 7. 来源、边界与如实声明

- **只读插件源码**：契约在 Phase 1 前是对源码的只读测绘；并入后也只读，不改 `src/`。
- **没有在真实宿主验证**：现状截图与度量来自离线 harness（审查期）；真实宿主渲染（窗口 chrome 避让、用户字号、右栏挤压）需人工重启后复核。
- **审查期证据不随仓库分发**：`02-现状与截图证据.md`、`screens/`、`raw/ui-visual-probe.json`、改造后 `mock/` 属审查产物（在审查仓库，不在插件仓库）；文档中以「审查期证据」标注。
- **行号有版本性**：文中 `ui-panel.js:NNN` 行号截至 2026-11-08 / v1.3.0，源码改动后会漂移；以当前 `audit` 输出的 `line N` 为准。
- **A6 是存在性检查**：不代表三态质量达标（质量清单在 `layout.md §8`）。
- **token 清单有版本性**：官方 token 取自本机 DSH 0.2.0-rc.2 包，宿主升级后需复核 `tokens.md §3/§7.3`。
- **无客户真名**：本目录所有示例与 mock 均用「某集团 / 某 XX 集团」等泛称。
