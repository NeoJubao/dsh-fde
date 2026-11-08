# ADR 0004 · 开源就绪改造（Phase 0）：身份、许可、安装、隐私与授权

- 日期：2026-11-08
- 状态：已采纳（由插件作者授权 Lead 决定实现细节）
- 关联：`docs/01-spec.md` §1/§16、审查报告 `FDE工作站-深度审查与优化报告-20261108.md`（P0 清单）、`04-开源就绪.md`、`03-设计审查与ui-contract.md`
- 回滚：改造前快照 `.archive/research-workbench-pre-oss-20261108-2225.tar.gz`（141 文件 / 2.0 MB）；删 `research/.fde/` 可回退看板状态

## 背景

插件要开源分享。2026-11-08 审查发现：无 LICENSE、真实客户名与真人姓名进公开产物、安装脚本写死作者本机路径并绕过官方 `dsh plugin add`、无版本门禁、干净检出 `verify/all.mjs` 必红、npm 包缺 `tools/`/`build.mjs`/`verify/`、`methods/05` 引用无 LICENSE 的私有仓库。作者决定：**包名 `dsh-fde`；生财情报增加「链接授权」第三条路径；其余细节由实现方决定。**

## 决策

### D1. 包身份（改名，一次性）

| 项 | 旧 | 新 |
|---|---|---|
| npm 包名 | `@local/research-workbench` | **`dsh-fde`**（2026-11-08 查 npm registry 404，可用） |
| 版本 | `0.1.0` | **`1.3.0`**（与 README v1.3 对齐；后续按 SemVer） |
| 模块 id（`__ModuleLoader__.load`） | `@local/research-workbench` | `dsh-fde`（client-modules 要求与包名一致） |
| `cordis.patch.yml` insert id / name | `research-workbench` / `@local/...` | `dsh-fde` / `dsh-fde` |
| 侧栏面板 id（`sidebar.panellist` / `main` key） | `researchworkbench` | **保持不变**（已有用户习惯与验证断言，改它无收益） |

同步点（必须一次改全）：`src/ui/ui-panel.js:18`、`build.mjs:15-16`、`cordis.patch.yml:3`、`package.json:2`、`tools/install_profiles.py`、`index.js:2` 注释、`verify/fde-client.mjs:39`、`verify/client-static.mjs:28`、`verify/host-smoke.mjs:299`、README/AGENTS 标题。历史文档（`docs/adr/0001`、`docs/research/*`）不改，属历史记录。

### D2. 许可（代码与内容分开）

- **代码**（`index.js`、`src/**`、`tools/**`、`scripts/**`、`verify/**`、`build.mjs`、`icon.svg`）：**MIT**，根目录 `LICENSE`。
- **内容**（`methods/**`、`skills/**`、`templates/**`、`reference/**`、`docs/**`、README 正文）：**CC BY 4.0**，根目录 `LICENSE-docs` 注明，README「许可」节分别说明；引用他人内容（ASD-STE100、社区经验参数、catalog 外链）保留「来源与许可见原文」声明。
- `methods/05` 与 `scripts/md2docx.py`：**改写 ≠ 删除**——删除对私有仓库 `github.com/aineos-labs/FDE-skill`、`_external/` 的引用；`md2docx.py` 保留为「可选桥接」，只依赖调用方自备的 `build_docx.py` 契约，不再声称衍生自任何内部仓库。若上游主张权利，删除该脚本与方法即可（不阻塞主功能）。

### D3. 分发与安装（官方机制）

- 首发 **npm 公开发布**（`dsh-fde`），GitHub 作源码与 Issue 入口；`dsh-plugin` topic + format-1 索引 + awesome PR 在 Phase 1。
- 安装一律走官方：`dsh plugin --profile <name> add <spec>`（本地路径 / `dsh-fde` / git / tarball 均可）。`tools/install_profiles.py` **重写为 preflight 助手**：只检查 DSH 版本、Node 版本、工作区 `research/`，打印（并可选执行）官方命令；不再直接改 profile `package.json`/`pnpm-lock.yaml`/`node_modules`。
- 兼容门禁：`engines.dsh: ">=0.2.0-rc.2 <0.3.0"` + `engines.node: ">=20"`；`peerDependencies` 声明 `@deepseek-ai/dsh`（`optional: true`，避免 pnpm 重复安装宿主包），README 写明「当前版本按 peer 判兼容、下一版本按 engines.dsh」。
- `private` 移除；补 `license`/`repository`/`homepage`/`bugs`/`author`/`keywords`/`files`/`publishConfig`（`access: public`）。
- `files` 白名单修正：`index.js`、`client.js`、`cordis.patch.yml`、`src/host`、`methods`、`reference`（不含 samples）、`templates`、`scripts`、`skills`、`locale`、`icon.svg`、`LICENSE*`、`README.md`、`CHANGELOG.md`。`src/ui`、`build.mjs`、`verify/`、`tools/`、`docs/`（含 `docs/ui-contract/`）不进 npm 包，但进 GitHub 仓库（`docs/ui-contract/` 为开发者契约文档，发布面只走 README 链接）。

### D4. 隐私脱敏（发布前硬门槛）

- 公开产物（客户端 bundle、文档、方法、fixture、README、截图）中**不得出现真实客户名、真人姓名、联系方式、金额**；统一替换为「某集团有限公司」「张三」「某集团」。
- `reference/samples/*.pdf`（1.53 MiB，测试证据）移出插件目录（工作区 `_external/fde-pdf-samples/`），`reference/PDF兼容性核查.md` 改为文字步骤。
- `docs-workbench.md`（v0 旧文档、含客户名、与 v1.3 冲突）从插件目录移除（归档到 `.archive/fde-legacy-docs/`）。
- `docs/research/`、`verify/*-report.md` 不进开源仓库（拆分时排除），本地保留。
- 验收：脚本全仓复扫 0 命中（客户词表 / 个人主目录绝对路径 / 手机号 / 邮箱 / token 模式）；`health-check` 的绝对路径检查范围扩到发布清单全部文本。

### D5. 生财情报：三条授权路径（作者指定）

按优先级解析，**不做静默回退到第三方私有文件**以外的新依赖：

| # | 路径 | 机制 | 说明 |
|---|---|---|---|
| 1 | **链接授权（推荐）** | 面板「设置 → 生财情报授权」粘贴授权链接或 `access_token` → `POST /fde/scys/auth` → 存 `research/.fde/scys-auth.json`（`0600`，仅本机，可一键清除） | 用户显式动作；链接中若含 `token`/`access_token` 参数自动提取；token 不回显、不写日志 |
| 2 | 环境变量 | `FDE_SCYS_TOKEN` | CI / 无面板场景 |
| 3 | 兼容旧 token 文件 | 只读 `~/.dsh/mcp/scys-mcp/tokens.json` | 标记「兼容路径」，README 标明不属 DSH 官方契约 |

- 三路径都失败 → `code=UNAUTHORIZED`，面板显示「去授权」入口；任何路径都不在日志/错误里输出 token。
- 面板授权区显示：当前来源（链接授权 / 环境变量 / 兼容文件 / 未授权）、过期时间（若有）、清除按钮、授权说明链接。

### D6. 干净检出可验证

- `verify/acceptance-audit.mjs` 对 `../research` 的依赖改为可选：不存在时记 `WARN` 并跳过「真实工作区只读扫描」段；`FDE_WORKSPACE` 可指向 fixture。
- `health-check` 对缺 `research/`、缺 bid-intel、缺缓存只 WARN，不 FAIL（已如此，补断言）。
- CI（GitHub Actions，Node 24）：`node verify/all.mjs` + `node scripts/health-check.mjs` + `npm pack --dry-run` 内容断言 + README/package 版本一致性检查。

### D7. 首启与功能 bug（同期修）

- 客户页 page-header 增加「新建客户」主操作（`POST /fde/engagement {action:'create', patch:{...}}`）；空态文案与按钮指向它；任务模式补「新建任务」。
- 修 4 个 bug：方法页技能被 board meta 覆盖（保留 skills）、`.fde-warn` 死类、工件页 `<button>` 嵌套、`openSession(): void` 被当 boolean。
- 三件半天见效：今日去重（删页内重复刷新/自主性徽章与重复数字）、看板横滚示能 + 列宽自适应（先不改 8 列结构）、`.fde-warn`。

### D8. 导航 9→5：本轮不做（明确延后）

IA 合并是 L 级改动、影响使用习惯，且需要先落 ui-contract 再改。本轮只交付 `layout.md` 契约与 mock；**Phase 2 实施**。理由与验收见审查报告路线图。

## 后果

- 正面：可合法开源、外部可安装、隐私风险清零、首启可用、生财授权可控。
- 负面/代价：改名后旧 `link:` 安装需重新 `dsh plugin add`；本地 `install_profiles.py` 行为改变（只 preflight）；`docs-workbench.md` 与样例 PDF 从插件目录移出（归档保留）；导航结构本轮不变，设计问题仍在 Phase 2 解决。
- 需要人工验证：真实宿主重启后面板渲染、`dsh plugin add` 真安装、面板授权流程（本轮只做静态 + harness 验证）。

## 实施契约（给并行开发者）

见 `plugin-audit/fde-v2/06-实施/01-实施规格.md`（身份/许可/脱敏/UI/发布的具体文件与验收）。
