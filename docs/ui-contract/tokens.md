# FDE 工作站 · tokens.md（ui-contract v1 · token 权威）

> **状态**：v1（2026-11-08 Phase 1 并入 `docs/ui-contract/`）；迁移未完成（见 `README.md §6`）。
> **权威边界**：本文件是**取值权威**——所有颜色的值只在这里出现。`layout.md` 不写值，`design.md` 只写 token 名。
> **原则**：值来自宿主 `--dsw-alias-*`（语义别名），不复制静态色板；FDE 只允许**一层**本地语义变量 `--fde-*`，且必须是官方 token 的别名，不得承载新值。
> **证据**：源码 `src/ui/ui-panel.js:86-654`（CSS 模板，只读；行号截至 v1.3.0，源码改动后可能漂移）；浅/深计算值来自审查期离线 harness 实测（`ui-visual-probe.json`，30 次采样，不随仓库分发）；官方取值来自 `@deepseek-ai/dsh-client-ui-theme/lib/client.js` 内联 CSS（`body{…}` / `body[data-ds-dark-theme]{…}`）。
> **官方 version 基线**：DSH 0.2.0-rc.2 随包 theme；token 清单以本机包为准，宿主升级后需重跑 `audit-ui-contract.mjs` 并复核本文件。

---

## 0. 一句话

现状 **23 个 `--fde-*` 变量**（372 处引用）+ **24 个官方 alias**（71 处直接引用）+ **48 处 var() 回退值**；
但 **`--dsw-radius-*` / `--dsw-elevation-*` / `--dsw-font-*` 引用数都是 0** —— 也就是「颜色对了，几何和排版没接上」。
另一个致命点：`--fde-surface/2/3` 映射到的 `bg-layer-1/2/3` 在**浅色下同值**，浅色主题的所有表面层级塌成一片白。

---

## 1. 现状：`--fde-*` 全表（23 个，按引用次数排序）

> 「浅色/深色计算值」= harness 里 `getComputedStyle(.fde-root)` 的实测值（probe）。
> 「v1 处置」= ✅保留 / 🔁改映射 / ➕新增 / ❌删除 / ⚠️收拢。

| # | 变量 | 当前映射 | 浅色 | 深色 | 引用 | v1 处置 |
|---|---|---|---|---|---|---|
| 1 | `--fde-accent` | `--dsw-alias-state-business-primary` | `#4176e6` | `#7aaaff` | 53 | ✅ |
| 2 | `--fde-text-2` | `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` | 50 | ✅ |
| 3 | `--fde-border` | `--dsw-alias-border-l1` | `#0000000a` | `#ffffff0f` | 50 | 🔁 宽度改 0.5px（值不变） |
| 4 | `--fde-danger` | `--dsw-alias-state-error-primary` | `#ec1313` | `#f25a5a` | 33 | ✅（仅限点/底/描边，不做小字） |
| 5 | `--fde-surface-2` | `--dsw-alias-bg-layer-2` | `#fff` | `#2c2c2e` | 28 | 🔁 改 `--dsw-alias-bg-module-platform`（浅 `#f5f6f7` / 深 `#353638`） |
| 6 | `--fde-text` | `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` | 26 | ✅ |
| 7 | `--fde-text-3` | `--dsw-alias-label-tertiary` | `#81858c` | `#adb2b8` | 23 | ⚠️ 只用于辅助；不得承载唯一关键信息 |
| 8 | `--fde-warn` | `--dsw-alias-state-warn-primary` | `#f59e0b` | `#f59e0b` | 20 | ✅（底色/点） |
| 9 | `--fde-success` | `--dsw-alias-state-success-primary` | `#22c55e` | `#22c55e` | 19 | ⚠️ 不做小字文本色（对比度低） |
| 10 | `--fde-surface` | `--dsw-alias-bg-layer-1` | `#fff` | `#232324` | 18 | ✅ |
| 11 | `--fde-border-2` | `--dsw-alias-border-l2` | `#0000001a` | `#ffffff1f` | 15 | 🔁 宽度改 0.5px |
| 12 | `--fde-warn-text` | `--dsw-alias-state-warn-label` | `#dd8629` | `#dd8629` | 11 | ⚠️ 同上：不做小字正文；或改 `--dsw-alias-label-primary` + 色点 |
| 13 | `--fde-surface-3` | `--dsw-alias-bg-layer-3` | `#fff` | `#353638` | 7 | 🔁 改 `--dsw-alias-bg-overlay`（浅 `#e9ecf2` / 深 `#43454a`） |
| 14 | `--fde-hover` | `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` | 5 | ✅ |
| 15 | `--fde-idle` | `--dsw-alias-state-idle-primary` | `#d4d4d4` | `#545557` | 3 | ✅ |
| 16 | `--fde-focus` | `0 0 0 2px color-mix(--dsw-alias-state-business-primary 32%)` | — | — | 2 | 🔁 收敛为 `--fde-focus-ring`（见 §4.5） |
| 17 | `--fde-brand` | `--dsw-alias-brand-primary` | `#0f1115` | `#f9fafb` | 2 | ✅ |
| 18 | `--fde-on-brand` | `--dsw-alias-label-primary-inverted` | `#fff` | `#353638` | 2 | ✅ |
| 19 | `--fde-shadow` | **自造** `0 12px 32px color-mix(--dsw-alias-label-primary 16%)` | — | — | 2 | ❌ 删除，改用 `--dsw-elevation-panel` |
| 20 | `--fde-bg` | `--dsw-alias-bg-base` | `#fff` | `#151517` | 1 | ✅ |
| 21 | `--fde-scroll` | `--dsw-alias-scrollbar-bg-l2` | `#e5e5e5` | `#545557` | 1 | ⚠️ 自定义滚动条选择器应删，改共享滚动条 |
| 22 | `--fde-scroll-hover` | `--dsw-alias-scrollbar-hover-l2` | `#d4d4d4` | `#65676b` | 1 | ⚠️ 同上 |
| 23 | `--fde-active` | `--dsw-alias-interactive-bg-active` | `#2631481a` | `#ffffff24` | 0 | ✅（已定义未用；保留备用） |

**46 处**中性 solid 描边宽度是 `1px`（`audit A8` 实测），官方要求发丝线；`--fde-border`/`--fde-border-2` 本身值没问题，**问题在宽度**（见 §6.3）。

---

## 2. 目标：本地变量的三层结构

```
① 官方语义别名        --dsw-alias-*            （值权威在宿主 theme）
   └─ ② 本地语义层    --fde-*                   （只允许别名，不写新值）
        └─ ③ 组件局部   --fde-<component>-*     （只允许布局/几何/局部间距）
```

- **颜色**：只允许出现在 ① 与 ②；③ 不得出现颜色。
- **几何/间距**：允许出现在 ③（官方允许"组件可以定义局部自定义属性"），但必须来自 `design.md` 的间距/圆角角色。
- 任何新增 `--fde-*` 必须在本表登记「映射到哪个官方 token + 为什么需要」；不允许 `--fde-blue-2: #xxx` 这种第二套色板。

### 2.1 需要新增的本地变量（把散落的值/规则收成一处）

| 新变量 | 值（只在这里出现） | 替代 | 理由 |
|---|---|---|---|
| `--fde-hairline` | `0.5px` | 所有中性 solid 描边宽度 | 一处改全局；符合官方发丝线 |
| `--fde-focus-ring` | `0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 32%, transparent)` | 现 `--fde-focus` | 焦点环唯一来源（名称表达用途） |
| `--fde-space-1/2/3/4/6/8` | `4/8/12/16/24/32px` | 30+ 种 padding 组合 | 对应 `design.md` §3 |
| `--fde-radius-row/-control/-card/-panel` | `var(--dsw-radius-sm/md/xl/panel)` | 12 种裸圆角 | 角色 → 官方 token |
| `--fde-row-min-hit` | `24px` | 可点行最小高度 | WCAG 2.5.8 |
| `--fde-shadow-panel` | `var(--dsw-elevation-panel)` | `--fde-shadow`（自造） | 去掉自造阴影 |

---

## 3. 官方 token 分组与本项目用到的角色

> 全部取自 `@deepseek-ai/dsh-client-ui-theme/lib/client.js`。本项目**只允许**使用下表 token；不在表内的官方 token 需在本文件追加登记。

### 3.1 表面（surface）

| 官方 token | 浅色 | 深色 | 本项目角色 |
|---|---|---|---|
| `--dsw-alias-bg-base` | `#fff` | `#151517` | 页面底 `--fde-bg` |
| `--dsw-alias-bg-layer-1` | `#fff` | `#232324` | 卡片 `--fde-surface` |
| `--dsw-alias-bg-module-platform` | `#f5f6f7` | `#353638` | **次级表面 `--fde-surface-2`（改映射）** |
| `--dsw-alias-bg-overlay` | `#e9ecf2` | `#43454a` | **三级表面 `--fde-surface-3`（改映射）** |
| `--dsw-alias-bg-layer-3` | `#fff` | `#353638` | 与 module-platform 深色同值；浅色不可用 → 弃用在本项目 |
| `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` | 悬停底 `--fde-hover` |
| `--dsw-alias-interactive-bg-active` | `#2631481a` | `#ffffff24` | 按下底 `--fde-active` |
| `--dsw-alias-bg-mask-1` | `#0000003d` | `#00000080` | 抽屉/弹窗遮罩（已是） |
| `--dsw-alias-settings-card-fill` | `bg-layer-2`（浅 = 白） | 同 | **不可用于卡片**（浅色下也塌陷）；仅设置页范式参考 |

### 3.2 描边与分割

| 官方 token | 浅色 | 深色 | 角色 |
|---|---|---|---|
| `--dsw-alias-border-l1` | `#0000000a` | `#ffffff0f` | 平面发丝线 `--fde-border` |
| `--dsw-alias-border-l2` | `#0000001a` | `#ffffff1f` | 强一点的分隔/输入框 `--fde-border-2` |
| `--dsw-elevation-stroke-color` | `border-l4` | `border-l3` | 只被 elevation 内部引用，不单独用 |
| `--dsw-elevation-stroke` | `0 0 0 .5px var(--dsw-elevation-stroke-color)` | 同 | elevation 的第一层描边 |

### 3.3 文字

| 官方 token | 浅色 | 深色 | 角色 |
|---|---|---|---|
| `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` | 主文字 |
| `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` | 次级 |
| `--dsw-alias-label-tertiary` | `#81858c` | `#adb2b8` | 三级（仅辅助） |
| `--dsw-alias-link` | `#4176e6` | `#7aaaff` | 链接 |
| `--dsw-alias-label-primary-inverted` | `#fff` | `#353638` | 主按钮文字 |

### 3.4 语义状态

| 官方 token | 浅色 | 深色 | 允许用法 |
|---|---|---|---|
| `--dsw-alias-state-business-primary` | `#4176e6` | `#7aaaff` | 选中、进度、链接、焦点环 |
| `--dsw-alias-state-success-primary` | `#22c55e` | `#22c55e` | 通过色点/浅底；**不做小字正文**（2.28:1） |
| `--dsw-alias-state-warn-primary` | `#f59e0b` | `#f59e0b` | 警告浅底、色点 |
| `--dsw-alias-state-warn-label` | `#dd8629` | `#dd8629` | 警告文字（**仅 ≥16px 或非唯一信息**；2.79:1） |
| `--dsw-alias-state-error-primary` | `#ec1313` | `#f25a5a` | 错误描边/文字/色点 |
| `--dsw-alias-state-idle-primary` | `#d4d4d4` | `#545557` | 低优先级、禁用 |

### 3.5 层级阴影（高层级表面只用这 3 个）

| 官方 token | 组成（值） | 用途 |
|---|---|---|
| `--dsw-elevation-panel` | stroke + `0 3px 8px #00000008` + `0 0 16px #00000005` | 抽屉、对话框 |
| `--dsw-elevation-prominent` | stroke + `0 3px 8px #0000000a` + `0 0 20px #0000000d` | 菜单、浮层、拖动卡片 |
| `--dsw-elevation-soft` | stroke + `0 4px 16px #00000008` + `0 0 24px #00000008` | 输入框、选择器 |

规则：用了 elevation 就 `border: 0`；不得再叠中性 border（官方 elevation spec 会拒绝）。

### 3.6 圆角（6 档，不允许新增）

| 官方 token | 值 | 本项目角色 |
|---|---|---|
| `--dsw-radius-xs` | 4px | 行内小件、计数徽章、键帽 |
| `--dsw-radius-sm` | 8px | chip、小按钮、分段项、紧凑行 |
| `--dsw-radius-md` | 12px | 标准按钮/输入/选择器、列表行 |
| `--dsw-radius-lg` | 16px | 多行 cell、嵌套表单组 |
| `--dsw-radius-xl` | 20px | 内容卡片、推荐卡、抽屉内块 |
| `--dsw-radius-panel` | 28px | 抽屉、模态、主面板 |

正圆 `50%` / 胶囊 `999px` 保留，但每个必须在同一条规则里配 `corner-shape: round`。

### 3.7 排版（官方有配对行高，优先直接用 shorthand）

| 官方 token | 值（含行高） | 本项目角色 |
|---|---|---|
| `--dsw-font-xxxs-11` | `11px/14px` | 提示、辅助 meta |
| `--dsw-font-xxs-12` | `12px/18px` | 次级 meta、页面定位、区块标题（strong 变体） |
| `--dsw-font-xs-13` | `13px/20px` | 正文、行标题（strong 变体） |
| `--dsw-font-s-14` | `14px/22px` | 强调正文、表单值 |
| `--dsw-font-m-18` | `500 16px/28px` | 统计值 |
| `--dsw-font-l-20` | `500 20px/28px` | 页面名 |
| `--dsw-font-xl-24` | `600 24px/32px` | 空态主标题（可选） |
| `--dsw-font-markdown-code` | 等宽 | 代码、路径、id |
| `--dsh-content-font-size` | 宿主注入 | **正文基准必须读它**（现状写死） |

---

## 4. 映射与替换：从现状到 v1

### 4.1 表面（必须改的两处）

```css
/* 现状（浅色三档全部塌成 #fff） */
--fde-surface-2: var(--dsw-alias-bg-layer-2, #f5f6f7);
--fde-surface-3: var(--dsw-alias-bg-layer-3, #ebeef2);

/* v1 */
--fde-surface-2: var(--dsw-alias-bg-module-platform, #f5f6f7); /* 浅 #f5f6f7 / 深 #353638 */
--fde-surface-3: var(--dsw-alias-bg-overlay, #e9ecf2);         /* 浅 #e9ecf2 / 深 #43454a */
```

影响面（用这些变量的组件）：导航底、输入/选择器底、chip 底、表格头、看板列底、文件行、消息条、列表 hover 前的底色。改后浅色下才出现「页面白 / 卡片白 / 次级灰 / 三级深灰」四层——现状只有两层（白 + 4% 描边）。

### 4.2 发丝线

```css
--fde-hairline: 0.5px;
/* 所有 border: 1px solid var(--fde-border) → 0.5px solid var(--fde-border) */
```

现状：46 处中性 solid 描边为 1px（`audit A8`）。dashed 保持 1px；状态色描边保持 1px。

### 4.3 高层级表面

```css
/* 现状 */ .fde-drawer{ border-left:1px solid var(--fde-border); box-shadow: var(--fde-shadow); }
/* v1   */ .fde-drawer{ border:0; box-shadow: var(--dsw-elevation-panel); }
/* 现状 */ .fde-modal { border:1px solid var(--fde-border); box-shadow: var(--fde-shadow); }
/* v1   */ .fde-modal { border:0; box-shadow: var(--dsw-elevation-prominent); }
/* 输入框：border → elevation-soft */
.fde-input,.fde-select,.fde-textarea{ border:0; box-shadow: var(--dsw-elevation-soft); }
```

### 4.4 圆角（角色 → token）

| 现状值 | 出现在 | 目标 |
|---|---|---|
| `999px` | 自主性徽章、chip | `999px` + `corner-shape: round`（保留胶囊） |
| `50%` | 色点、spinner、步进数字 | `50%` + `corner-shape: round` |
| `5px` | 键帽、行内 code | `--dsw-radius-xs` |
| `6px` | 注意力 kind、招采关系徽章、资料库徽章 | `--dsw-radius-xs`（H20）或 sm |
| `7px` | 小按钮、分段项、流程工具 chip | `--dsw-radius-sm` |
| `8px` | 标准按钮、输入、选择器、导航分段 | `--dsw-radius-md` |
| `9px` | 计数徽章、文件行、矩阵、消息条 | `--dsw-radius-sm`/`md`（按角色） |
| `10px` | 导航轨道、错误条、统计卡、招采行、块 | `--dsw-radius-md`/`lg` |
| `11px` | 资料库卡片、推荐卡 | `--dsw-radius-xl` |
| `12px` | 内容卡、看板列、表格容器 | `--dsw-radius-xl` |
| `14px` | 模态、兼容卡 | `--dsw-radius-lg`/`xl` |

> 映射按**角色**重选，不机械替换：官方明确「不要把同一个旧圆角的所有出现位置机械映射到同一新 token」。

### 4.5 焦点环

现状：`:focus-visible{outline:none; box-shadow: var(--fde-focus)}`，值 = `0 0 0 2px color-mix(business 32%)`。
v1：保留结构，改名 `--fde-focus-ring` 并只在此处定义；`:focus` 与 `:focus-visible` 行为一致；焦点环不得被裁切（抽屉/滚动容器要留内边距）。

---

## 5. 48 处回退值怎么收

现状 48 处 `var(--dsw-alias-*, #fallback)` 的 fallback 是静态色板值（`audit A2` 计为「允许但需收拢」）。三种可选方案：

| 方案 | 做法 | 优点 | 缺点 | 建议 |
|---|---|---|---|---|
| A（推荐） | 保留回退，但把 48 处收进一个 `tokens.css` 的 `:where(.fde-root)` 块：`--fde-*` 每行只写一次回退 | 宿主缺 token 时仍可渲染；一处可查 | 需要新增一个样式入口（纯 JS 项目可用字符串拼接） | ✅ 与「单一 token 文件」目标一致 |
| B | 全部删回退，依赖宿主必有 token | 最符合官方字面 | 老宿主/桌面端差异会变成透明或黑块 | 不推荐 |
| C | 保留现状散落 | 零改动 | 48 处不可维护、无法一处换肤 | 不推荐 |

> 官方规则原文：功能组件「不得复制静态色板值或写入颜色字面量」。回退值严格说属于复制静态色板；本项目按 A 方案把它降级为「显式、集中、有注释的兼容层」，并在 README 兼容矩阵里说明。

---

## 6. 逐项替换清单（自动检查口径）

### 6.1 字号（13 种 → 8 种角色）

| 现状字号 | 出现次数（audit A5） | 去向 |
|---|---|---|
| 10px | 1 | `--dsw-font-xxxs-11` |
| 10.5px | 17 | `--dsw-font-xxxs-11` |
| 11px | 4 | `--dsw-font-xxxs-11` |
| 11.5px | 38 | `--dsw-font-xxxs-11` 或 `--dsw-font-xxs-12`（按角色） |
| 12px | 27 | `--dsw-font-xxs-12` |
| 12.5px | 19 | `--dsw-font-xs-13`（行标题/正文） |
| 13px | 13 | `--dsw-font-xs-13` |
| 13.5px | 1 | `--dsw-font-s-14` |
| 14px | 2 | `--dsw-font-s-14` |
| 15px | 2 | `--dsw-font-s-14` |
| 16px | 2 | `--dsw-font-base-16` |
| 19px | 1 | `--dsw-font-m-18` |
| 20px | 2 | `--dsw-font-l-20` |

### 6.2 行高

现状 13 种行高（比值 + 一个固定值），依赖 `.fde-root` 的 `line-height:1.6` 继承。v1：**不再全局设 ratio**；每个文本角色用官方 shorthand（自带行高），只有长正文允许 `line-height` 覆盖且必须与该角色配对。

### 6.3 几何（`audit A8` 的 102 项）

| 类别 | 数量 | 处置 |
|---|---|---|
| 圆角越界（不在 4/8/12/16/20/28） | 43 | §4.4 表逐项映射 |
| 圆/胶囊缺 `corner-shape: round` | 9 | 每条规则补 `corner-shape: round` |
| 中性 solid 描边 1px | 46 | `--fde-hairline` |
| dashed 1.5px | 2 | 改回 1px |
| 高层级表面 border+elevation | 2 | §4.3 |
| 自造阴影 | 1 | 删 `--fde-shadow` |

### 6.4 颜色

- 裸色值：**0**（`audit A2` PASS）——这是现状做得好的一点，保持。
- 主题选择器：**0**（`audit A3` PASS）——保持。
- 唯一要改的是 `--fde-surface-2/3` 的**映射目标**（§4.1），不是新增色。

---

## 7. 检查、例外与未验证

### 7.1 自动检查覆盖

| 检查 | 本文件对应 | 状态 |
|---|---|---|
| A2 无裸色值 | §5 | 现状 PASS（48 处回退待收拢） |
| A3 无主题选择器 | §0/§4 | 现状 PASS |
| A5 字号 ⊆ scale | §6.1 | 现状 FAIL（7 种越界） |
| A8 几何 token | §4.2/§4.3/§4.4/§6.3 | 现状 FAIL（102 项） |
| A1 layout 表 ↔ 注册表 | 与 `region-ids.mjs` 同步 | 现状 PASS |

### 7.2 允许的例外（写出来，避免下次被当违规）

1. **spinner 圆环** 2px 描边：官方对 spinner 有显式豁免，保留。
2. **dashed 分隔** 1px：官方要求已满足，不需要发丝线。
3. **状态色描边** 1px（错误/警告面板）：保留真描边。
4. **经典模式 `.rw-*`**：旧五页签保留原视觉（`ui-panel.js:610-653`），不纳入 v1 视觉规范；但它是 UI 代码，`audit` 会一并统计（A5/A8），基线数字里已包含。

### 7.3 未验证/待验证

1. **真实宿主渲染**：所有浅/深计算值来自离线 harness，不是真实 DSH 窗口；真实宿主还会注入窗口 chrome 变量与用户字号，需人工重启后复核。
2. **官方 token 清单版本**：取自本机 `dsh-client-ui-theme` 编译产物；宿主升级可能新增/改值，需重跑 `audit-ui-contract.mjs` 并复核 §3 表。
3. **`--dsw-alias-bg-overlay` 在深色/浅色下的实际观感**：数值已核，未做截图对比（改映射后需补明暗两套截图）。
4. **官方 elevation 与宿主菜单材质叠加**：FDE 无自造菜单，暂不涉及；若未来加菜单需复核 `--dsw-menu-surface-fill` 与 backdrop filter。
