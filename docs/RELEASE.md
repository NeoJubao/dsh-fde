# 发布手册（RELEASE.md）

> 目标读者：**Neo（唯一执行人）**。本文件是 `dsh-fde` 发布的唯一操作口径；命令都可复制，但**发布动作（`git push` / `git tag` / `npm publish`）只能由人执行**。
> 关联：`docs/adr/0004-open-source-readiness.md`（身份/许可/分发决策）、`docs/ui-contract/`（UI 契约，advisory）、`CHANGELOG.md`、`SECURITY.md`。
> 版本口径：`package.json.version` = README 顶部 `vX.Y.Z` = git tag `vX.Y.Z` = npm 上的版本，四处一致。

## 0. 红线（本文件不授权任何自动发布）

- **不自动发布**：`npm publish`、`git push`、`git tag` 只由人执行；CI 只做校验（`.github/workflows/verify.yml` 无发布 job）。
- **不发未过检的版本**：`scripts/release-preflight.mjs` 失败（exit 1）时不得发布。
- **不改已发布版本**：已上 npm 的版本号不得复用；修问题 → 升 patch 版重新发。
- **不泄露**：发布前必须确认 `verify/open-source.mjs` 的「发布集无客户词 / 无个人主目录路径」为 0 命中。
- **tag 与版本绑定**：`v1.3.0` 只能指向「通过全部检查 + 已发布到 npm 的那个 commit」。

## 1. 一条命令（推荐入口）

```bash
# 在插件根目录
node scripts/release-preflight.mjs
```

它会**串行**跑：README 版本 → 开源发布检查 → 打包内容 → 健康检查（+ UI 契约 advisory 只报不阻断），
全部通过后**打印**接下来的 `git` / `npm` 命令；任一硬检查失败则 `exit 1` 并指出失败步骤。
**它不联网、不发布、不改任何文件**（`verify/pack.mjs` 用临时 npm cache，不污染 `~/.npm`）。

## 2. 发布前清单（人工按序执行）

| # | 检查 | 命令 | 期望 | 阻断 |
|---|---|---|---|---|
| 1 | 构建产物一致 | `node build.mjs` | `built: client.js (NNN KB)`；`client.js` 与 `src/ui/ui-panel.js` 字节一致 | ✅ 阻断 |
| 2 | 全量验证 | `node verify/all.mjs` | 末尾 `✓ 全部验证通过`（含 UI 契约 advisory 步骤，它始终 exit 0） | ✅ 阻断 |
| 3 | 健康检查 | `node scripts/health-check.mjs` | `exit 0`；WARN 可接受（见 §7），**不能有 FAIL** | ✅ 阻断 |
| 4 | UI 契约 advisory | `node verify/ui-contract.mjs` | `exit 0`；记录 `drift N 项（A4/A5/A7/A8…）`——迁移期预期为红，**不阻断** | ⛔ 不阻断（记录） |
| 5 | 打包内容 | `node verify/pack.mjs` | 必需项全在；无 `samples` / `src/ui` / `verify` / `tools` / `docs` / 历史报告 | ✅ 阻断 |
| 6 | README 版本 | `node scripts/check-readme-version.mjs` | `✓ README 版本一致：vX.Y.Z ≡ package.json.version` | ✅ 阻断 |
| 7 | 开源身份/许可/隐私 | `node verify/open-source.mjs` | 66 项通过；客户词表 0 命中、个人主目录路径 0 命中 | ✅ 阻断 |
| 8 | 脱敏终扫（人工复核） | 见 §2.1 | 与上一条一致；抽查 `git status` 新增文件无客户信息 | ✅ 阻断 |
| 9 | CHANGELOG 已写本版 | 人工读 `CHANGELOG.md` | 有 `vX.Y.Z` 段：新增 / 变更 / 修复 / 破坏性变更 | ✅ 阻断 |
| 10 | git 提交与 tag | §4 | tag `vX.Y.Z` 与版本一致 | ✅ 阻断 |
| 11 | npm 发布 | §3 | `npm publish --access public` 成功 | ✅ 阻断 |
| 12 | 发布后验证 | §5 | 干净目录 `dsh plugin add dsh-fde` 成功、面板出现、`/fde/meta` 可达 | ✅ 阻断（失败→回滚 §6） |
| 13 | 发现渠道（可选） | format-1 索引 / awesome PR / `dsh-plugin` topic | 见 §8 | ⛔ 不阻断 |

> 顺序说明：本地全绿 → 提交 → tag → npm → 发布后验证。**先 tag 再 publish**，避免 npm 上出现「没有对应 commit 的版本」。

### 2.1 脱敏终扫（人工复核口径）

`verify/open-source.mjs` 已自动扫：发布集文本文件的客户词表（运行时从工作区 `research/` 目录名派生，**不回显名称**），以及**个人主目录绝对路径**（macOS 家目录前缀、Linux home 前缀）。人工只补两件：

- `git status --short` 看新增/改名文件里是否有真实客户名、人名、电话号码、内部项目名；
- 截图（`assets/screenshot-*.png`）里是否有真实客户名（应为「某集团」合成 fixture）。

## 3. npm 发布（命令示例，**不要自动执行**）

```bash
# 一次性：登录 + 确认权限（2FA 按账号设置）
npm login
npm whoami                      # 期望：你的 npm 用户名

# 版本号只改一次：先改 package.json.version 与 README 顶部、CHANGELOG
# 建议用 npm version 生成 commit + tag（也可手工 git tag，见 §4）
npm version patch --no-git-tag-version   # 例：1.3.0 → 1.3.1（不改 git）

# 干跑：确认要发布的文件清单（与 verify/pack.mjs 口径一致，约 60+ 文件）
npm publish --dry-run

# 正式发布（公开包；package.json 已带 publishConfig.access=public）
npm publish --access public
```

发布后核对 `https://www.npmjs.com/package/dsh-fde`：版本、README、license、`files` 内容。
`prepack` 会自动跑 `node build.mjs && node scripts/check-readme-version.mjs`（构建产物不一致会挡住发布）。

## 4. GitHub 建仓与推送（首次 / 每次）

```bash
# 首次（仓库尚不存在时；此工作区原本不是 git 仓库）
cd <拆分出来的 dsh-fde 目录>
git init -b main
git add -A
git commit -m "release: v1.3.0（首次开源发布）"
git remote add origin git@github.com:NeoJubao/dsh-fde.git
git push -u origin main

# 打 tag（版本必须与 package.json.version 一致）
git tag -a v1.3.0 -m "dsh-fde v1.3.0"
git push origin v1.3.0

# 后续每次发布
git add -A && git commit -m "release: v1.3.1"
git tag -a v1.3.1 -m "dsh-fde v1.3.1"
git push origin main --tags
```

GitHub Release：用 `CHANGELOG.md` 对应段落作正文；附件可选 `npm pack` 生成的 `dsh-fde-X.Y.Z.tgz`。

## 5. 发布后验证（必须做）

```bash
# 用一个隔离 profile 验证「陌生人能装」
dsh plugin --profile releasecheck add dsh-fde
dsh --profile releasecheck --dump-config | grep -A2 dsh-fde     # 期望能看到 bundle 层
dsh --profile releasecheck                                     # 启动后：侧栏出现「FDE 工作站」，九页签可开
dsh plugin --profile releasecheck remove dsh-fde                # 验证完清理

# 本地 tarball 等价验证（不依赖 registry）
npm pack && dsh plugin --profile releasecheck add ./dsh-fde-1.3.0.tgz
```

要点：`/fde/meta`、`/fde/board` 可达；客户页能「新建客户」；无 `research/` 时面板不白屏（空态 + 引导）。

## 6. 失败回滚（由轻到重）

| 场景 | 处置 | 注意 |
|---|---|---|
| 本地检查失败 | 修代码 → 重跑 `node scripts/release-preflight.mjs` | 不要跳过失败项 |
| npm 发错版本（未超过 72h） | `npm unpublish dsh-fde@X.Y.Z` | **72 小时内**、且该版本无其他包依赖；unpublish 后**版本号不能复用**，下次必须升版本 |
| npm 发错版本（超 72h 或不想删） | `npm deprecate dsh-fde@X.Y.Z "请升级到 X.Y.(Z+1)"` + 发新 patch | 首选这条：不破坏已安装用户，只用告警引导升级 |
| 用户装坏了 | `dsh plugin --profile <name> remove dsh-fde`，再装上一个可用版本 `dsh plugin add dsh-fde@X.Y.(Z-1)` | 客户端半刷新页面即可；宿主半需重启 |
| git tag 打错 commit | `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`，在正确 commit 重打 | 已经发布到 npm 的版本不要只删 tag——npm 上仍能安装，需配合 §3 升版本 |
| 看板状态异常 | 删工作区 `research/.fde/`（插件会自动重建）；`research/<客户>/` 不受影响 | 先在 `backups/` 留存一份 board.json |
| 需要整体回退插件 | 用上一个 git tag 的代码重新走 §2–§5 | 不 `git reset --hard` 已推送历史 |

## 7. 已知 WARN / 不阻断项（发布说明里如实写）

| 项 | 说明 |
|---|---|
| `health-check` 的 2 类 WARN | ① `verify/audit-report.md` 历史证据含个人主目录路径（该文件不进仓库，按设计保留）；②「宿主是否已重启」无法从文件判断 |
| 干净检出（无 `../research`）的 WARN | 招采雷达索引 / 资料库缓存 / 社区缓存 / 看板状态缺失，全部 WARN；`acceptance-audit` 的「真实工作区只读扫描」整段跳过 |
| UI 契约 drift | `verify/ui-contract.mjs` 报告 A4/A5/A7/A8 FAIL（迁移期预期），advisory 不阻断；迁移计划见 `docs/ui-contract/README.md §6` |
| 未在真实宿主验证的项 | 面板渲染、`dsh plugin add` 真安装、生财链接授权流程——发布前由人按 §5 验证 |

## 8. 发现渠道（首发之后，可选）

1. **format-1 插件索引**：静态托管 `index.json`（`format:1`）+ 图标；每版本给 `source` 与 `engines.dsh`。字段见 DSH 官方 `plugin-market-index` 文档。
2. **awesome-dsh-plugin**：向列表提 PR（一个 YAML 条目）；收录硬门槛是声明 `dsh.bundle`（本插件已满足）。
3. **GitHub topic**：仓库加 `dsh-plugin` topic，便于检索。

## 9. 发布前需人工确认（逐条打勾）

- [ ] 本次是 **patch / minor / major**？依据 SemVer（新增能力=minor，修 bug=patch，破坏兼容=major）
- [ ] `CHANGELOG.md` 的 `vX.Y.Z` 段已写（新增 / 变更 / 修复 / 破坏性变更 / 升级指引）
- [ ] `package.json.version` = README 顶部版本 = `CHANGELOG` 标题版本 = 计划 tag（四处一致）
- [ ] `node scripts/release-preflight.mjs` exit 0（记录输出摘要到发布记录）
- [ ] `node verify/ui-contract.mjs` 的 drift 数已记录（与上次比较，只减不增）
- [ ] 脱敏：`verify/open-source.mjs` 客户词 0 命中 + 人工看 `git status` 新增文件
- [ ] 许可：`LICENSE`（MIT）/ `LICENSE-docs`（CC BY 4.0）未被改动或已按规则更新
- [ ] 真实宿主：重启 DSH 后九页签、客户抽屉、设置页各看一眼（截图留档）
- [ ] npm 账号：`npm whoami` 正确、2FA 可用、`publishConfig.access=public` 生效
- [ ] 回滚路径：知道当前上一个可用版本号（`dsh plugin add dsh-fde@<上一版>` 能装回）
- [ ] 发布说明：GitHub Release 正文（用 CHANGELOG 段落）+ 已知限制（本文件 §7）
- [ ] 对外沟通：谁需要知道（README、Release、群/私信模板），**不要**在公开渠道贴客户名

## 10. 发布记录模板（每次复制一段，追加到 `CHANGELOG.md` 顶部或内部发布台账）

```md
## vX.Y.Z（YYYY-MM-DD）

- 类型：patch / minor / major
- 清单：build ✓ / verify-all ✓ / health ✓（WARN n）/ ui-contract drift n / pack ✓（n 文件）/ readme-version ✓ / open-source ✓（66 项）/ 脱敏 ✓
- commit：<sha> ｜ tag：vX.Y.Z ｜ npm：dsh-fde@X.Y.Z ｜ tarball：dsh-fde-X.Y.Z.tgz
- 发布后验证：干净 profile add ✓ / 面板九页签 ✓ / `/fde/meta` ✓ / 卸载 ✓
- 已知问题/回滚点：见 RELEASE.md §7；上一可用版本 X.Y.(Z-1)
- 执行人：Neo ｜ 时间：YYYY-MM-DD HH:MM
```
