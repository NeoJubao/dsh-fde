# FDE 工作站 · region-ids（ui-contract v1 · 区域 id 清单）

> 机器可读版本：`region-ids.mjs`（同目录）。**本文件与它必须一致**；`audit-ui-contract.mjs` 只校验
> `layout.md §2` 与 `region-ids.mjs` 的一致性，本文件是给人看的索引。
> 为什么没有 `RegionId` 联合类型：FDE 是零构建纯 JS（`build.mjs` 只做拼接），没有 tsc。
> 因此用「常量 + helper + Node 断言」替代编译期约束：
> `REGION_IDS`（稳定 id）→ `REGION_META`（白名单两列）→ `region()`（渲染出口）→ `audit A1`（可执行断言）。

## 1. 稳定 id（22 个）

| # | id | 中文 | 出现在哪 | 允许页型 | 备注 |
|---|---|---|---|---|---|
| 1 | `root` | 面板根 | `FdeApp` 最外层 | 全部 | 主题变量作用域 |
| 2 | `page-header` | 页面头 | 壳层 | 全部 | 唯一全局控件位（刷新/自主性/设置） |
| 3 | `nav` | 主导航 | 壳层 | 全部 | 目标 5 页签 + 分组 |
| 4 | `status` | 页级状态条 | 壳层 | 全部 | 载/错/空/降级/陈旧 |
| 5 | `content` | 内容容器 | 壳层 | 全部 | 唯一页级滚动容器 |
| 6 | `toolbar` | 视图工具栏 | 工作台/台账 | workbench/ledger | 搜索/筛选/模式切换 |
| 7 | `primary` | 主内容 | 各视图 | 全部 | 主对象 |
| 8 | `aside` | 次内容 | 今日/工作台/参考 | inbox/workbench/reference | 每页 ≤1 |
| 9 | `drawer` | 焦点槽 | `DrawerShell` | focus | 单对象切面 |
| 10 | `drawer-head` | 焦点槽头 | `DrawerShell` | focus | 面包屑返回 + 关闭 |
| 11 | `drawer-body` | 焦点槽正文 | `DrawerShell` | focus | 块容器 |
| 12 | `drawer-foot` | 焦点槽操作条 | `DrawerShell` | focus | 主操作唯一 |
| 13 | `dialog` | 确认弹窗 | `ConfirmDialog` | focus | 二级焦点 |
| 14 | `block-overview` | 概览块 | 客户抽屉 | focus | |
| 15 | `block-gate` | 门禁块 | 客户抽屉 | focus | |
| 16 | `block-next` | 下一步块 | 客户抽屉 | focus | |
| 17 | `block-stakeholders` | 干系人块 | 客户抽屉 | focus | 默认折叠 |
| 18 | `block-artifacts` | 工件块 | 客户抽屉 | focus | 默认折叠 |
| 19 | `block-bids` | 招采块 | 客户抽屉 | focus | 默认折叠 |
| 20 | `block-timeline` | 时间线块 | 客户抽屉 | focus | 默认折叠 |
| 21 | `block-items` | 关联任务块 | 客户抽屉 | focus | |
| 22 | `block-report` | 回报块 | 任务抽屉 | focus | |

## 2. 怎么用（迁移后）

```js
import { REGION_IDS, region } from './region-ids.mjs';

// 壳层
h('div', { className: 'fde-root' },
  h('header', region(REGION_IDS.PAGE_HEADER, { className: 'fde-top' }), …),
  h('nav',    region(REGION_IDS.NAV, { className: 'fde-nav-wrap' }), …),
  h('main',   region(REGION_IDS.CONTENT, { className: 'fde-main' }), viewNode()));

// 视图
h('div', region(REGION_IDS.PRIMARY, { className: 'fde-view' }), …);

// 抽屉
h('div', region(REGION_IDS.DRAWER, { className: 'fde-drawer' }), …);
```

三条硬规则：

1. **只通过 helper 产出 `data-region`**，不手写字符串（`audit A1` 检查「区域名 ⊆ 白名单」，手写也能被查到，但下一步会加「是否走 helper」的静态检查）。
2. **id 不得重命名**：已发布 id 只能废弃 + 新增别名，一个版本后再删（layout.md §9.6）。
3. **新增 id 要四处同步**：`region-ids.mjs`（REGION_IDS + REGION_META）→ `layout.md §2` → `layout.md §4` 页型集合 → 本文件。

## 3. 断言与运行

```bash
# 契约自检（layout.md §2 ↔ region-ids.mjs，含「禁止放」列非空）
node audit-ui-contract.mjs --json | tail -1

# 渲染期断言（迁移后用）
node -e "import('./region-ids.mjs').then(m=>{m.assertRegionId('page-header'); console.log('ok')})"

# 页型校验（迁移后用）
node -e "import('./region-ids.mjs').then(m=>console.log(m.checkRegionForPage('inbox','toolbar')))"
# -> { allowed: false, reason: '页型 inbox 不允许区域 toolbar（layout.md §4）' }
```

## 4. 与官方类型化做法的差异（如实说明）

| 官方/典型做法 | FDE v1 做法 | 差距与补偿 |
|---|---|---|
| TS 联合类型 `type RegionId = …` 编译期约束 | `REGION_IDS` 常量 + `assertRegionId()` 运行期断言 | 运行期才报错；由 audit A1 在 CI 里提前拦 |
| 组件 props 只接受 RegionId | `region(id, attrs)` helper + `data-region` 属性 | 无法阻止绕过 helper 写裸字符串；靠 grep 检查（下一版加） |
| CSS Modules 保证局部类名 | `data-region` + `.fde-root` 作用域 | 作用域已在；类名仍是全局，靠 `.fde-` 前缀约定 |
| 生成式类型文件 | 手写常量 | 22 个 id 规模小，手写可接受；新增时靠 §2 三处同步 |

## 5. 迁移状态

| 项 | 状态 |
|---|---|
| 注册表（22 个 id + 白名单 + 页型映射） | ✅ 完成 |
| `layout.md §2` 与注册表一致 | ✅ audit A1 PASS |
| 源码 `data-region` 标注 | ❌ **0 处**（迁移前预期；见 layout.md 附录 C 的 7 步） |
| 渲染期断言接入 | ❌ 待迁移 |
| CI 接入 | ❌ 待 Lead 决定（本轮只出脚本） |
