# FDE 工作站 · design.md（ui-contract v1 · 视觉规范）

> **状态**：v1（2026-11-08 Phase 1 并入 `docs/ui-contract/`）；迁移未完成（见 `README.md §6`）。
> **权威边界**：本文件管「视觉规则——用哪一级 token、哪种状态必须存在、什么不许做」。
> **本文件只写 token 名，不写值**；所有取值住在 `tokens.md`（`--fde-*` → `--dsw-alias-*` 映射表）。
> 结构（谁落在哪、什么不许放）见 `layout.md`；区域 id 见 `region-ids.mjs`。
> 依据：DSH `docs/web-styling.zh.md`（组件规则 11 条）、`docs/ui-radius.zh.md`（圆角尺度与嵌套几何）、
> `docs/ui-design-review-cases.zh.md`（整页审查：对齐/分组/密度/层级/状态/几何）。

---

## 0. 适用范围与前置判断

| 项 | 内容 |
|---|---|
| 适用 | FDE 面板内所有视觉表面：页面、卡片、表格、列表、看板列、抽屉、弹窗、空/错/载态 |
| 不适用 | 宿主自带的窗口 chrome、侧栏、右栏、设置页 |
| 前置 | **FDE 用 JS 注入 CSS，不受 CSS Modules 约束**。`ui-panel.js` 的 CSS 模板字符串是唯一入口，作用域 `.fde-root`。这不构成违规；需要替代 CSS Modules 的是：① 单一作用域（已有）② 单一 token 文件（`tokens.md`）③ 本文件的规则 + `audit-ui-contract.mjs` 的自动检查（后两者本轮补齐）。 |
| 不新造主题 | 功能组件与插件**不拥有明暗主题**：不写主题选择器、不写浅色/深色两套值、不拦截 `prefers-color-scheme`。明暗由宿主 token 解析。 |

---

## 1. 五条设计原则（本项目内的优先顺序）

1. **关系先于数值**：先看对齐轴、分组间距、层级，再看 token 是否合法。合法 token 不能抵消对齐错误；"只差几像素"不能排除高频错列（官方整页审查要求）。
2. **一个表面一种材质**：平面（页面/卡片/表格/行）用「底色 + 发丝线」；高层级（抽屉/弹窗/菜单/浮层/输入框）用「无描边 + elevation」。两者不叠加（`tokens.md` §4.3）。
3. **状态必须在同一屏可比较**：逾期、暂停、门禁未过、加载、失败、选中、禁用——同一事实在不同视图必须用**同一语义 token**，不能一个视图红色 chip、另一个视图无标记（现状缺陷见主报告 D16）。
4. **密度服从阅读**：一屏只回答一个问题；同屏重复数字/重复控件一律删（主报告 D4/D5）。
5. **可发现性优先于隐藏**：横滚、拖拽、可用动作必须有可见示能（渐隐/提示/常驻按钮），不得只靠手感。

---

## 2. 字体角色（只写 token 名）

| 角色 | token | 用途 | 约束 |
|---|---|---|---|
| 页面名 | `--fde-font-page-title` → `--dsw-font-l-20` | 每页唯一 | 一页最多 1 个 |
| 页面定位 | `--fde-font-page-subtitle` → `--dsw-font-xxs-12` | 页面名下一行 | 只写一句定位，不写统计 |
| 卡片/区块标题 | `--fde-font-section-title` → `--dsw-font-xxs-strong-12` | 卡头、区块名 | 不用来当页面名 |
| 行标题 | `--fde-font-row-title` → `--dsw-font-xs-strong-13` | 列表行、卡片名 | 可点击时整行可点 |
| 正文 | `--fde-font-body` → `--dsw-font-xs-13` | 说明、正文 | 跟随宿主 `--dsh-content-font-size` 计算，不写死 |
| 次级信息 | `--fde-font-meta` → `--dsw-font-xxs-12` | 时间、来源、标签 | 用 `--dsw-alias-label-secondary` |
| 三级/提示 | `--fde-font-hint` → `--dsw-font-xxxs-11` | 辅助说明 | 只用 `--dsw-alias-label-tertiary`，不得承载唯一关键信息 |
| 数字 | `--fde-font-stat` → `--dsw-font-m-18` | 统计值 | `font-variant-numeric: tabular-nums` |
| 代码/ID | `--fde-font-code` → `--dsw-font-markdown-code` | 路径、id、键名 | 不得作为唯一标签（必须配中文标签） |

**规则**

- 字号必须来自上表；**不得新增字号**（现状 13 种字号里 7 种不在官方 scale，见 `tokens.md` §6）。
- 字号与行高必须配对：优先用 `--dsw-font-*` 的 **shorthand**（自带行高），只有确需覆盖时才成对声明。
- 行内半像素字号（如 `10.5/11.5/12.5`）一律消除，向上/向下就近落到角色（由 `tokens.md` §6 给映射表）。
- 字重只用 400 / 500 / 600 / 650 四档（650 是现状主用；统一后保留 500/600）。

---

## 3. 间距节奏（只写 token 名）

| token | 角色 |
|---|---|
| `--fde-space-1` | 图标与文字之间、行内紧凑元素 |
| `--fde-space-2` | 同一组内元素之间（表单 label↔控件、chip 行） |
| `--fde-space-3` | 组内块之间（列表行之间、卡片内容段） |
| `--fde-space-4` | 卡片内边距、组间距 |
| `--fde-space-6` | 卡片之间、分区间（页级） |
| `--fde-space-8` | 页面级边距、大分区之间 |

**规则**

- **组内间距 < 组间间距**（官方空间分组）：同组元素用 `--fde-space-1/2`，组间用 `--fde-space-4/6`；现状「卡片内 Section 间距 ≈ 卡片之间间距」必须修正。
- 一屏内只允许上表 6 个间距值；不得出现 5/7/9/11/14 这类临时值（现状 30+ 种 padding 组合）。
- 对齐轴只认三种：文字起点轴、控件边缘轴、图标中心轴。跨分区的文字列必须共轴（看板列头/卡片标题/卡片第一行文字共左轴；列表的操作列共右轴）。

---

## 4. 表面、层级与材质（只写 token 名）

### 4.1 表面层级

| 角色 | token | 用途 |
|---|---|---|
| 页面底 | `--fde-bg` → `--dsw-alias-bg-base` | 面板背景 |
| 卡片/表头/工具栏底 | `--fde-surface` → `--dsw-alias-bg-layer-1` | 内容卡片 |
| 次级表面（行、输入、chips、看板列底） | `--fde-surface-2` → **`--dsw-alias-bg-module-platform`** | 与卡片区分 |
| 三级表面（选中、hover 底、计数徽章） | `--fde-surface-3` → **`--dsw-alias-bg-overlay`** | 与次级区分 |
| 悬停/按下底 | `--dsw-alias-interactive-bg-hover` / `-active` | 交互反馈 |

> **必须修的关键一条**：现映射的 `--dsw-alias-bg-layer-1/2/3` 在浅色主题下**同值**（都是白），导致浅色下卡片、表头、行、导航底全部与页面同色，层级只能靠 4% 透明描边撑住（截图与计算值均可复现）。因此 surface-2/3 改映射到上面两个 token（浅色下才出现真实层级）。深色下原映射本来就分层，改后仍成立。

### 4.2 发丝线与描边

- 平面中性描边/分割线一律 `--fde-hairline`（宽度值只在 `tokens.md §2.1`）；**不得使用非发丝线宽度**的中性 solid（现状 46 处）。
- 虚线分隔（列表行、设置行）保持 dashed 细线（宽度见 `tokens.md`）；状态色描边（错误/警告面板）保持真描边，不走发丝线。
- 表格的纵向分隔线不使用；横向分隔线用发丝线。

### 4.3 高层级表面（drawer / modal / tooltip / menu / 输入框）

- 一律 `border: 0`（或仅状态色描边）+ `--dsw-elevation-panel`（drawer/modal）/ `--dsw-elevation-prominent`（菜单、浮层）/ `--dsw-elevation-soft`（输入框）。
- **禁止 border + elevation 配对**（现状 drawer/modal 两者都有；官方 elevation spec 会拒绝）。
- 遮罩用 `--dsw-alias-bg-mask-1`，不模糊背景（宿主 `--dsw-mask-blur: none`）。
- 菜单/选择器不得自造材质；FDE 目前无自造菜单（好），未来也不得加。

### 4.4 阴影

- 只允许 elevation token，禁止自造阴影（现状 `--fde-shadow` 是自造值，`tokens.md §1` 有记录）。
- 卡片不加阴影（平面材质）；拖动中的卡片可用 `--dsw-elevation-panel` 表示抬起。

---

## 5. 几何（只写 token 名）

| 角色 | token | 用途 |
|---|---|---|
| 行内小件（徽章、键帽、计数） | `--dsw-radius-xs` | H≤20 小控件 |
| 紧凑控件（小按钮、分段项、chip） | `--dsw-radius-sm` | H20–28 |
| 标准控件（按钮、输入、选择器、列表行） | `--dsw-radius-md` | H32–40 |
| 分组内容（多行 cell、嵌套表单组） | `--dsw-radius-lg` | |
| 内容卡片 | `--dsw-radius-xl` | 设置卡片、推荐卡、抽屉内块 |
| 面板/对话框 | `--dsw-radius-panel` | 抽屉、模态 |

**规则**

- 只用上表 6 档 + 两个例外（正圆 `50%`、胶囊 `999px`）。现状使用 12 种圆角值，其中 7 种越界（`tokens.md` §6）。
- **每个正圆/胶囊半径必须在同一规则里配对 `corner-shape: round`**（现状 9 处全缺）。
- 嵌套几何按官方三种关系处理：同心内缩（内层 = 外层 − 内缩）、贴边填色（由外层裁切）、独立子容器（按自身用途选档）。现状「卡片 12 / 卡内块 10 / 块内按钮 8」不是同一套尺度，重构时按角色重选，不机械相减。
- 尺寸角色：小按钮/输入为紧凑档，标准按钮/输入为标准档，整行可点区域高度 ≥ `--fde-row-min-hit`（WCAG 2.5.8 最小命中区）。

---

## 6. 颜色语义（只写 token 名）

| 语义 | token | 允许 | 禁止 |
|---|---|---|---|
| 主文字 | `--dsw-alias-label-primary` | 标题、行标题、正文 | — |
| 次级文字 | `--dsw-alias-label-secondary` | 说明、meta、表格非主列 | 不用 tertiary 替代它 |
| 三级文字 | `--dsw-alias-label-tertiary` | 纯辅助（时间、占位） | **不得**承载唯一关键信息（如逾期、失败原因） |
| 品牌/链接 | `--dsw-alias-link` / `--dsw-alias-state-business-primary` | 链接、选中指示 | 不用于整块底色 |
| 危险 | `--dsw-alias-state-error-primary` | 错误描边/色点/文字 | 大面积底色 |
| 警告 | `--dsw-alias-state-warn-primary`（底）/ `--dsw-alias-state-warn-label`（文字） | 警告 chip、门禁提示 | **不得**把小字号正文直接用 warn-label（对比度不足，见主报告 D18） |
| 成功 | `--dsw-alias-state-success-primary` | 通过、已确认 | 同上：不直接当小字文本色 |
| 中性/空闲 | `--dsw-alias-state-idle-primary` | 低优先级点、禁用 | — |

**状态色使用规则（本项目补充）**

1. 状态 = 「色点 + 中文标签」或「浅底 chip + 主文字色」，**不是**「彩色小字」。小于 `--fde-font-meta` 的文本一律用 label-* 系列。
2. 同一语义只有一个色：逾期/失败 = error；待审/门禁 = warn；完成 = success；进行 = business。跨视图必须一致（现状看板用 danger chip、客户表无标记）。
3. 禁止用颜色作为唯一区分（A/B/C 权威等级、优先级都要有文字/形状）。

---

## 7. 组件清单与状态矩阵

> 现状已有 15 个共享组件（`Btn/Chip/Card/Section/Empty/Loading/ErrorLine/MsgLine/Field/TextInput/TextArea/Select/Checkbox/Dot/AutonomyBadge/Stat/PriorityTag/KeyHint`），本契约不重造，只补规则与缺口。

| 组件 | 必须有的状态 | 规则 |
|---|---|---|
| `Btn` | default / hover / focus-visible / active / disabled / loading | 变体只允许 `primary`（每屏/每槽 ≤1）、默认、`ghost`、`danger`；高度只用两档（紧凑/标准）；hover 包在 `@media (hover: hover)`；loading 时保留原宽度 |
| `Chip` | default / `on`(选中) / 状态色 | 胶囊形必须配 `corner-shape: round`；状态 chip 的文字用语义色仅当对比度达标，否则用 label 色 + 色点 |
| `Input/Select/TextArea` | default / hover / focus / disabled / error | 用 elevation-soft 而非描边；focus 用统一焦点环 `--fde-focus-ring`；placeholder 用 tertiary |
| `Checkbox` | default / hover / focus / disabled / checked | 命中区 ≥ 行高，视觉尺寸不放大 |
| `Card` | default / selected（可选） | 平面材质；内边距 `--fde-space-4`；不加阴影 |
| `Section` | default | 标题 + 右侧动作 ≤1；标题与内容间距 < 卡间距 |
| `Table` | default / row-hover / row-selected / empty | 表头用次级表面；行分隔发丝线；整行可点需 `role=button` + Enter/Space |
| `List row`（注意力/建议/活动） | default / hover / focus / 处理中 | 整行是唯一可点区；右侧只放 1 个主操作 + 溢出菜单 |
| `Board card` | default / hover / dragging / paused / overdue | 卡片信息 ≤ 2 行 meta；数字必须带单位（「工件 1」而非「工 1」）；列头有一处图例 |
| `Stepper`（阶段） | default / done / current / paused | 只表达「走到哪」；进度用文案「第 5/8 阶段」 |
| `Gate item` | pass / missing / unreviewed | 三态要有文字，不只色点 |
| `Drawer` | open / closing | elevation 材质、无描边；头部/底部固定，body 唯一滚动；焦点陷阱 |
| `Modal` | open | 同 drawer；遮罩不模糊；危险操作双确认 |
| `Toast/MsgLine` | ok / warn / err | 失败必须给可恢复动作；不用 toast 承载必须阅读的错误 |
| `Empty` | default / filtered / onboarding | 三种文案不同；onboarding 必须给主行动 |
| `Loading` | default / inline | 超过 1s 才出现；骨架优先 |
| `ErrorLine` | page / block / inline | 三级：页级替换 primary、块级占位、行内提示；都必须有原因 + 恢复动作 |

**状态必须放一起比较**：同一屏内同时出现的状态（选中 + hover + 禁用）要能认出分组与对齐关系（官方整页审查要求）。

---

## 8. 图标与文本

- 现状无图标库，使用字符符号（`⌕ ▤ › ⋯ ✓ ✕ ◎`）。规则：符号是装饰，必须 `aria-hidden`；**不得**让符号成为唯一可理解标签（例如操作菜单必须是「⋯ 更多操作」，不是裸「⋯」）。
- 中文优先：内部 id（`ruleId`、门禁 key、`pilot_md`）不得直接进正文；必须配中文解释或收进 title/详情。现状建议列与门禁块直接显示英文 key（主报告 D5/D11）。
- 按钮文案用动词短语（「推进到试点」「保存人工确认」）；同名不同动作必须改名（现状两个「保存人工确认/保存下一步」并列）。

---

## 9. 明暗主题

1. 不写主题选择器（已合规，`audit A3` PASS）。
2. 两套主题必须各自成立：明暗都要检查**表面层级是否仍可分辨**（当前浅色下不成立，见 §4.1）。
3. 状态色在深色下对比度更高（现状深色更好），不要把明色值写死。
4. 半透明色只用 `color-mix` 与 token 组合，不新增静态色。

---

## 10. 视觉禁止清单（每条对应一条自动检查或人工项）

| # | 禁止 | 自动检查 |
|---|---|---|
| V1 | 写裸色值（`#hex`/`rgb()`），只允许 `var(--token, 回退)` 且回退集中在 tokens 文件 | A2 |
| V2 | 写主题选择器 | A3 |
| V3 | `:hover` 不在 `@media (hover: hover)` 内 | A4 |
| V4 | 新增字号/半像素字号 | A5 |
| V5 | 越界圆角（不在 6 档 + 50%/999px） | A8 |
| V6 | 正圆/胶囊不配 `corner-shape: round` | A8 |
| V7 | 中性 solid 描边不是发丝线宽度 | A8 |
| V8 | 高层级表面同时用描边 + elevation；自造阴影 | A8（部分）+ 人工 |
| V9 | 状态色当小字正文（对比度不足） | 人工 |
| V10 | 用颜色作为唯一区分 | 人工 |
| V11 | 同屏重复全局控件 / 重复同一组数字 | A7 + 人工 |
| V12 | 空态删除结构、错误态占满屏无恢复动作 | 人工（A6 只查存在性） |

---

## 11. 验收方式

- **自动**：`node audit-ui-contract.mjs`（A1–A8）。
- **人工（每轮 UI 改动）**：明/暗 × 宽/中/窄 × 空/错/载 的截图矩阵；关系清单（对齐轴、空间分组、层级、状态、几何）逐项记录「已检查无新增问题 / 已修复并复查 / 发现但未修复 / 未检查」。
- **对比基线**：审查期现状截图（18 张）与改造后静态 mock（2 张）；均属审查产物，不随本仓库分发。
