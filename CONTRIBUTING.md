# 贡献指南

感谢参与。这个项目是「方法 + 插件」的混合体：代码要能安装运行，内容（方法/技能）要能被非工程师读懂。

## 开始之前

- 先读 [`README.md`](README.md) 的边界与 [`AGENTS.md`](AGENTS.md)（给 AI 协作者的规则，人也适用）。
- 涉及行为变更的 PR：先开 Issue 说明场景与验收，再写代码。**先 spec 后代码**：契约变更先改 `docs/01-spec.md` 或新增 ADR。
- 小修复可以直接 PR，但要在描述里写清「改了什么、为什么、怎么验证」。

## 本地开发

```bash
# 1) 以本地路径安装（官方机制，不手改 profile）
dsh plugin --profile web add /path/to/dsh-fde

# 2) 构建客户端产物（改 src/ui 后必须）
node build.mjs

# 3) 全量验证（提交前必跑）
node verify/all.mjs
node scripts/health-check.mjs
```

- 宿主半改动（`index.js`、`src/host/`）：重启 DSH（或插件禁用→启用）后生效。
- 客户端半（`src/ui/ui-panel.js`）：`node build.mjs` 后刷新页面；`client.js` 是生成产物，**不要手改**。
- 改面板请用离线 harness 看真渲染：`plugin-audit/fde-v2/harness`（仓库内历史审计工具，不随 npm 包发布），或直接在 DSH 里打开面板。
- 不要新增运行时依赖；宿主服务用 `ctx.get()` 懒取并在缺失时降级。

## 提交规范

- 一次提交只做一件事；标题写「改了什么」，正文写「为什么 / 怎么验证」。
- 涉及 `research/` 工作区数据的改动不要提交；测试数据用 `examples/` 或临时目录。
- 不要提交真实客户名、人名、联系方式、金额、token、个人主目录路径。
- 更新 `CHANGELOG.md` 的「未发布」小节（如果本次有用户可见变化）。

## 内容贡献（methods / skills / templates）

- 方法要写清：适用场景 / 输入 / 步骤 / 产物 / 边界 / 相关方法；不写行业标准口吻，标注「方法默认值，待验证」。
- 技能（`skills/*/SKILL.md`）必须有 `name`（与目录同名、kebab-case）与单行中文 `description`；正文含触发/输入/步骤/产物/边界。
- 引用外部材料要标来源与许可；不要复制受版权保护的原文。

## 审查与合并

- 所有 PR 需要至少一次人工审查；安全相关（路由/路径/凭据/红线）与数据结构变更需要两人。
- 本项目是单人维护的开源项目，响应可能不及时；急事请在 Issue 里 @ 维护者。

## 许可

提交即表示你同意以本项目的许可（代码 MIT、内容 CC BY 4.0，见 `LICENSE` 与 `LICENSE-docs`）发布你的贡献。
