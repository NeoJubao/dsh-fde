# 开发者教程：给 `dsh-fde` 加功能

> 面向想改代码/加功能的人（人或 AI 协作者）。先读 [AGENTS.md](../AGENTS.md)（规则）、[docs/01-spec.md](01-spec.md)（契约）、[docs/ui-contract/layout.md](ui-contract/layout.md)（界面落位）。
> 用户教程见 [GETTING-STARTED.md](GETTING-STARTED.md)。

## 0. 两个半：你改的是哪一边

| 半边 | 文件 | 生效方式 | 改它通常因为 |
|---|---|---|---|
| **宿主半** | `index.js`、`src/host/**` | 重启 DSH（或插件禁用→启用） | 工具、路由、提示词、状态/计算、技能注册 |
| **客户端半** | `src/ui/ui-panel.js` → `node build.mjs` → `client.js` | 刷新页面 | 面板/抽屉/样式/交互 |
| **内容** | `methods/`、`skills/`、`templates/`、`reference/` | 宿主读取（技能随宿主半） | 方法、技能、模板、资料目录 |

**不要手改 `client.js`**：它是 `ui-panel.js` 的构建产物，验证会检查字节一致。

## 1. 环境与自检

```bash
# 以本地路径安装（官方机制；不要手改 ~/.dsh/profiles）
dsh plugin --profile web add /path/to/dsh-fde

# 改客户端后
node build.mjs        # 打印 built: client.js (NN.N KB)，并断言字节一致

# 提交前
node verify/all.mjs   # 全量：宿主冒烟/安全/内核/工具/面板/开源/打包/自检
node scripts/health-check.mjs
```

开发循环：

- 宿主半：改 `index.js` / `src/host/*` → 重启 DSH（或插件管理里禁用→启用）→ 看日志/调用工具。
- 客户端半：改 `src/ui/ui-panel.js` → `node build.mjs` → 刷新页面；没有真实宿主时用离线 harness 看渲染（见 §6）。

## 2. 目录地图（改之前先定位）

```
index.js                宿主入口：路由注册、工具注册、技能注册、系统提示词、定时器
src/host/
  fde-schema.js         阶段/泳道/门禁/注意力/规则等 key 的唯一定义处
  fde-store.js          board 读写：备份 → 原子写 → revision 乐观并发
  fde-api.js            业务函数（board/brief/engagement/item/attention/gate/…）
  fde-rules.js          派生注意力、统计、proposals 规则
  fde-bids.js           招采雷达客户关联层（只读消费 bid-intel）
  fde-library.js        资料库目录 + GitHub 指标/社区刷新
  fde-scys.js           生财情报三路授权 + 只读 feed
  fde-calc.js           fde_scenario / fde_quote 纯计算
  fde-prompts.js        系统提示词
  paths.js / store.js   路径安全 / 旧调研工作台扫描
  subprocess.js         子进程执行层（ctx.subprocess 优先，脱敏回退）
src/ui/ui-panel.js      客户端半（5 页签；无 JSX，h() + CSS 模板字符串）
docs/                   规格、ADR、UI 契约、发布手册、本教程
verify/                 验证脚本（见 §5）
```

## 3. 三条扩展路径

### 3.1 加一个 agent 工具（宿主半）

1. `index.js` 的 `registerTools()` 里 `tools.register({ name, description, parameters, output, execute, presentCall })`。
2. 业务逻辑放 `src/host/*` 的纯函数（不要写在 `index.js`），参数校验失败返回 `{ ok:false, reason }`，**不抛异常**。
3. `presentCall.kind` 只能是官方枚举：`read | edit | delete | move | search | execute | fetch | other`。
4. 红线：涉及阶段推进/门禁/归档/对外发送的工具，必须经 `agentGuard` 拦截（参考 `fde_engagement` / `fde_attention`）。
5. 测试：`verify/host-smoke.mjs` 断言工具已注册且枚举合法；业务函数测试放对应 `verify/fde-*.mjs`。
6. 文档：`docs/01-spec.md` §7 工具契约 + `README.md` 工具表 + `AGENTS.md` 工具清单同步。

### 3.2 加一条 HTTP 路由（宿主半）

1. 在 `index.js` 的 `registerRoutes()` 里用 `fdeRoute('name', { methods, json, http200 }, handler)`；不要自己写 `webServer.register`（守卫/错误映射统一走 `makeGuard`）。
2. 路由数断言在 `verify/security.mjs`（总数）与 `verify/host-smoke.mjs`（逐条冒烟），加路由必须同步。
3. 所有路径参数先过 `paths.root`/`safeRoot`/`safeProjectPath`/`resolveInsideRoot`，越界回 400/403。
4. 返回值沿用 `{ ok, reason?, code? }`；业务降级用 `http200: true` + `{ ok:false, code }`。
5. 面板调用：`src/ui/ui-panel.js` 的 `fdeGet` / `fdePost`（超时/去重已封装），不要另起 `fetch`。

### 3.3 加一个页内视图/子页签（客户端半）

先过 `docs/ui-contract/layout.md` §1 落位决策树，再看 §2 区域白名单。**不新增顶级页签**（导航固定 5 项）。

1. 在 `ui-panel.js` 里写 `function XxxView(props)`，用 `h()`；样式只加在 CSS 模板字符串里，只用 `--dsw-alias-*` / `--fde-*`。
2. 挂到对应页签的页内子页签（`KnowledgePage` / `ProcessPage` / `CustomersPage` 的 `PageTabs`），不要往 `navItems` 里加。
3. 空态/加载/失败态都要有（`Loading` / `Empty` / `ErrorLine` 原语）；操作失败用行内提示，不用 `alert`。
4. 新区域先改 `docs/ui-contract/layout.md` §2 + `region-ids.mjs`，否则 `verify/ui-contract.mjs` 会报 A1。
5. 测试：`verify/client-static.mjs`（静态结构/文案）、`verify/fde-client.mjs`（九项面板断言）、`verify/client-runtime.mjs`（迷你 React 渲染 + 交互）都要过；断言过时要同步，不许放宽。
6. `node docs/ui-contract/audit-ui-contract.mjs` 应保持 8 项 PASS；`verify/ui-contract.mjs` 的 drift 数不能涨。

## 4. 改契约：先文档后代码

实质性改动先写文档，再写代码：

1. 行为/数据/接口变更 → `docs/01-spec.md` 对应章节；
2. 难以回头的决定 → 新增 `docs/adr/000N-*.md`（不改旧 ADR）；
3. 界面结构变更 → `docs/ui-contract/layout.md` §2 + `region-ids.mjs`；
4. 实施计划/归属 → `docs/02-plan.md`。

小的 bug 修复在提交说明写 `Trivial: 原因` 即可。

## 5. 测试矩阵（提交前跑 `node verify/all.mjs`）

| 脚本 | 覆盖 |
|---|---|
| `verify/host-smoke.mjs` | 插件形状、路由/工具注册、工具 kind 枚举、子进程主/回退路径、路径越界拒绝 |
| `verify/security.mjs` | 路由守卫（方法白名单、同源/回环、415、no-store/nosniff）、鉴权降级 |
| `verify/fde-host.mjs` | 宿主内核：schema/store/CAS/门禁/红线/注意力/原子写 |
| `verify/fde-scys-host.mjs` | 生财三路授权、feed 刷新/失败保留/重试上限（mock，不联网） |
| `verify/fde-library-host.mjs` | 资料库目录校验、GitHub 刷新（mock，不联网） |
| `verify/fde-tools.mjs` | `fde_scenario` / `fde_quote` 公式与警告 |
| `verify/acceptance-audit.mjs` | 独立审计：spec 契约对照（当前 677 项断言） |
| `verify/client-static.mjs` | 面板静态结构/文案/token 纪律 |
| `verify/fde-client.mjs` | 面板关键组件/九项验收 |
| `verify/client-runtime.mjs` | 迷你 React 渲染 + 交互（mock slots/remote） |
| `verify/open-source.mjs` | 发布门禁：身份/许可/files 白名单/隐私/构建一致 |
| `verify/pack.mjs` | `npm pack --dry-run` 内容断言 |
| `verify/ui-contract.mjs` | UI 契约 advisory（drift 数，恒 exit 0） |
| `scripts/health-check.mjs` | 工作区/缓存/技能/绝对路径/产物一致 |

> 干净检出（无 `../research`）也要能过：`verify/acceptance-audit.mjs` 会按 WARN 跳过真实工作区扫描。

## 6. 没有真实宿主时怎么看界面

审查期留下了一个离线 harness（在仓库外的审查目录 `plugin-audit/fde-v2/harness/`，不随插件发布）：

```bash
cd plugin-audit/fde-v2/harness
node make-fixture.mjs      # 合成 fixture 工作区
python3 shoot.py           # 截图到 ../screens/
python3 probe.py           # DOM 度量
```

它直接加载 `ui-panel.js` 源码、伪造 `slots`/`uiWorkspace`、用插件自己的宿主业务层跑合成数据；改完面板用它截图**亲眼看过**再提交。真实宿主行为（登录态、窗口 chrome、用户字号）仍需重启后人工验收。

## 7. 发布

流程见 [docs/RELEASE.md](RELEASE.md)；一条命令做预检：

```bash
node scripts/release-preflight.mjs   # README 版本 / open-source / pack / health / UI advisory
```

顺序：改版本 → 更新 CHANGELOG/README 版本 → 提交 → `git tag -a vX.Y.Z` → 推送 → GitHub Release → `npm publish --access public`（账号 2FA）→ 验证 `npm view` 与干净安装。

## 8. 常见坑

- **忘了 `node build.mjs`**：`verify/all` 的「客户端产物一致」会红。
- **改了导航/页签**：`verify/acceptance-audit.mjs` 的 5 页签断言与 `verify/fde-client.mjs` 会红；断言要同步口径，不许放宽。
- **加路由没同步计数**：`verify/security.mjs` 的「路由数」断言会红。
- **工具返回抛异常**：工具层错误要返回 `{ ok:false, reason }`，抛异常会变成宿主错误。
- **样式写死颜色/圆角/字号**：`verify/client-static.mjs` 与 `docs/ui-contract` 体检会报；只用 token。
- **改 `cordis.patch.yml` 的 name**：必须是包名 `dsh-fde`，否则 bundle 装不上。
- **在 `client.js` 上手改**：会被下一次 `build.mjs` 覆盖，且验证会红。
