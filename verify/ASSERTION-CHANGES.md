# 验证断言变更记录（Phase 0 · 开源改造）

> 依据：`docs/adr/0004-open-source-readiness.md` 与 `plugin-audit/fde-v2/06-实施/01-实施规格.md` §4/§6。
> 纪律：**只同步过期断言、只补新断言**；不放宽、不删除既有断言。每条改动给原因与验证方式。
> 记录人：impl-release ｜ 日期 2026-11-08

## 一、身份同步（ADR 0004 D1：包名/模块 id `dsh-fde`）

| 文件 | 改动 | 原因 |
|---|---|---|
| `verify/fde-client.mjs` | `id: '@local/research-workbench'` → `id: 'dsh-fde'` | 包与 client-modules 模块 id 统一改名；侧栏 panel id 仍由后续断言守 `researchworkbench` |
| `verify/client-static.mjs` | 同上 | 同上 |
| `verify/host-smoke.mjs` | client.js 模块 id 断言 → `dsh-fde`，并补「侧栏 panel id 仍是 `researchworkbench`」 | 同上；补断言防误改面板 id |
| `verify/host-smoke.mjs` | 新增 inject 断言：含 `tools/systemPrompt/workspaceRegistry/sessionController`、**不含** `webServer` | Lead 改为 `webServer` 可选挂载（`ctx.inject(['webServer'], …)`），非 Web 组合也能激活 |
| `verify/security.mjs` | 路由数 36 → 37；注释同步「旧 12 + FDE 13 + 招采 7 + 生财 3（feed/refresh/auth）+ 资料库 2」 | 新增 `GET/POST /fde/scys/auth`（ADR 0004 D5） |

## 二、契约断言同步（路由/依赖/文档口径）

| 文件 | 改动 | 原因 |
|---|---|---|
| `verify/security.mjs` | 新增 `scys/auth` 断言：无 cookie 401 / GET 状态形状 / POST 非 JSON 415 / 链接无 token → 200+INVALID / 链接提取 access_token / 响应不回显 token / 落盘 `research/.fde/scys-auth.json` / `clear` 删除并回落来源 | 授权契约不变量（实施规格 §5）；只写临时工作区 |
| `verify/acceptance-audit.mjs` | FDE 路由 24 → 25；`36 路由` 三处 → `37`；新增 `scys/auth` 存在性/GET/POST/DELETE 405/无 token INVALID 断言 | 同路由新增；保持独立验收口径 |
| `verify/acceptance-audit.mjs` | 依赖断言：由「无 dependencies / peerDependencies」改为「无 dependencies；peerDependencies 仅允许 optional 的 `@deepseek-ai/dsh`」 | ADR 0004 D3 明确声明可选 peer，避免 pnpm 重复安装宿主包 |
| `verify/acceptance-audit.mjs` | 「生财页签已移除」由「`生财` 出现 ≤2 次」改为「无 ScysView/tabScys，且 `生财` 只出现在资料库社区来源与设置页『生财情报授权』上下文」 | 实施规格 §2.8 新增设置页授权卡片；仍禁止旧页签组件 |
| `verify/acceptance-audit.mjs` | README 文档断言「9 页签」→「九视图」（兼容「9 页签」） | README 开源重写后的表述（面板九视图），语义等价 |
| `verify/acceptance-audit.mjs` | §13「真实工作区只读 adopt scan」改为**可选段**：无 `../research` 时打印 WARN 跳过；支持 `FDE_WORKSPACE` 指定工作区 | ADR 0004 D6：干净检出/CI 必须可验证，不因缺工作区判失败 |
| `verify/acceptance-audit.mjs` | 注释与检查名去掉个人主目录绝对路径字面量（改为「个人主目录绝对路径」） | 发布集隐私硬门槛（ADR D4）；检查逻辑不变 |
| `verify/host-smoke.mjs` | bid 检索 fixture 关键词「航发」→「招标」 | 脱敏清单 C2：测试 fixture 不得含真实行业主体名 |
| `verify/pack.mjs` | 按新 `files` 白名单重写：必需项（入口/宿主/方法/技能/模板/参考/脚本/locale/许可/README）+ 禁止项（samples、src/ui、verify、tools、docs、examples、assets、build.mjs、docs-workbench、`*-report.md`、PDF）+ 包名/版本断言 | ADR 0004 D3/D4；防发布包夹带测试与历史内容 |
| `verify/all.mjs` | 必备文件加入 `LICENSE`、`LICENSE-docs`、`CHANGELOG.md`、`locale/zh.json`；加入示例与 3 张 README 截图 | 实施规格 §4.2 与发布配套（§4.7/§4.8） |
| `verify/all.mjs` | 新增「README 版本一致性」与「开源发布检查（open-source.mjs）」两步 | 实施规格 §4.3/§4.6；一键验证覆盖开源门禁 |
| `scripts/health-check.mjs` | REQUIRED 增至 28 项（+4 个开源身份文件）；「交付文本无绝对路径」扫描范围扩到 `methods/reference/templates/examples/locale/CHANGELOG`；失败/WARN 文案去掉路径字面量 | 实施规格 §6 指派；ADR D4 检查范围扩大；避免脚本自身成为命中源 |

## 三、新增验证件（非既有断言改动）

| 文件 | 作用 |
|---|---|
| `verify/open-source.mjs` | 开源发布检查：包名/版本/许可字段、exports/cordis 一致性、files 白名单、README 安装命令与许可节、README 版本一致、发布集无个人绝对路径、客户词表复扫（有 `research/` 时启用，干净检出不判红）、`client.js` 与源码字节一致 |
| `scripts/check-readme-version.mjs` | README 版本标识（顶部优先，末尾声明兜底）与 `package.json.version` 一致 |
| `.github/workflows/verify.yml` | CI（Node 24）：build → verify/all → health-check → npm pack 断言 → README 版本检查 |
| `.gitignore` | 发布集排除项（依赖/临时/样本/证据报告/外部来源），不忽略工作区 `research/` |
| `examples/research/某集团-20260101/` + `examples/README.md` | 合成演示客户卷与 adopt 导入说明（不含真实信息） |
| `assets/screenshot-*.png` | README 截图（来自离线 harness 的合成 fixture） |

## 四、本次验证命令与结果（插件根目录）

| # | 命令 | 结果 |
|---|---|---|
| a | `node build.mjs` | `built: client.js (350.0 KB)`；`client.js` 与 `src/ui/ui-panel.js` 字节一致 |
| a | `node verify/all.mjs`（真实工作区） | `✓ 全部验证通过`（独立审计 677 断言 / 0 失败） |
| b | 干净副本：`rsync -a --exclude=node_modules research-workbench-plugin/ /tmp/fde-clean/plugin/` 后 `cd /tmp/fde-clean/plugin && node verify/all.mjs` | `✓ 全部验证通过`（该副本无 `../research`） |
| b′ | 干净副本 + `FDE_WORKSPACE=<工作区> node verify/acceptance-audit.mjs` | 677 断言 / 0 失败（证明 `FDE_WORKSPACE` 可用） |
| c | `node scripts/health-check.mjs` | exit 0（仅缓存/宿主未重启类 WARN） |
| d | `npm pack --dry-run --json --cache /tmp/npmcache2` | `dsh-fde@1.3.0`；67 个文件；tarball 403,285 B（≈394 KB）、unpacked 1,337,427 B（≈1.34 MB）；必需项齐、禁止项 0 |
| e | `node scripts/check-readme-version.mjs` | `README 顶部 v1.3.0 ≡ package.json.version 1.3.0` |
| f | `ruby -ryaml` 解析 `.github/workflows/verify.yml` | YAML 合法；job/step 名齐全（未真跑 GitHub） |

## 五、Phase 3 · 宿主内核加固（impl-host，2026-11-08）

> 依据：`plugin-audit/fde-v2/06-实施/01-实施规格.md`、`01-规范符合度.md` F-04/F-05/F-10/F-13/F-15/F-20。
> 只补断言、不放宽不删除既有断言。

| 文件 | 改动 | 原因 |
|---|---|---|
| `verify/security.mjs` | 请求替身记录响应头；新增 7 条断言：200/401/405/415 响应均有 `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`、200 仍声明 JSON Content-Type、405 保留 `Allow` | Phase 3 第 3 项：`json()` 统一补安全响应头（审查 F-13），并对齐官方 `/api`、`open-in-app` 路由的响应语义 |
| `verify/host-smoke.mjs` | 替身 ctx 增加 `subprocess` 服务替身；新增 11 条断言：presentCall.kind 属官方枚举（16 工具）、rw_export_pdf/rw_qa_pdf 拒绝工作区外绝对路径/`..`/符号链接、缺失文件 ok:false、主路径走 `ctx.subprocess.spawn`（argv[0]=resolveExecutable 结果、显式 cwd/stdio/graceMs）、`scrubbedEnv` 剔除 DSH_/凭据变量并保留 PATH/proxy、服务缺失回退 execFile（脱敏 env + 显式 cwd）、服务失败回退并标 fallbackFrom | Phase 3 第 1/2/4 项：子进程官方服务优先 + 脱敏回退（审查 F-04）、工具路径包含性（F-04）、`presentCall.kind` 枚举（F-10） |
| `verify/fde-host.mjs` | 新增 A5+ 一节 7 条断言：agent `resolve` decision/blocked → BLOCKED 且注意力保留、answer/question 可写、人可 resolve decision；A9 新增 1 条断言：board 落盘权限 0600 | Phase 3 第 5/6 项：原子写 `{flag:'wx',mode:0o600}`（F-15）、agent 不得自行解决 decision/blocked 注意力（F-20） |
| `verify/pack.mjs` | 打包必需清单新增 `src/host/subprocess.js` | 新增宿主模块属于运行必需，防止 `files` 白名单回归时漏打包（审查 F-04 的发布面） |
| `verify/host-smoke.mjs` | 冒烟清理段改为「先清理、再按 fail 退出」；`_pw-clean` 纳入清理前缀 | 失败时也不残留临时项目/符号链接，避免下一次运行 EEXIST（测试卫生，不改变断言） |

> 未改动/未放宽任何既有断言；`verify/acceptance-audit.mjs`（非本任务范围）未改，回归中确认全绿。
