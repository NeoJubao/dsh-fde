# 安全策略

## 报告问题

**不要公开提 Issue 报告安全问题。** 请用以下任一方式私下联系维护者：

- GitHub Security Advisories（仓库 → Security → Report a vulnerability）；
- 或发邮件到仓库 `package.json` 中 `author` 的 GitHub 主页所示联系方式。

请在报告中包含：影响版本、复现步骤、影响面（能否读写工作区外文件 / 是否能触发对外发送 / 是否需要本机访问）、以及建议修复方向。

## 适用范围与信任边界

`dsh-fde` 是一个**本机单机插件**，不是网络服务。它的安全模型建立在以下边界上：

1. **DSH 会话鉴权**：所有 HTTP 路由经 `connection.admit` 守卫；无 connection 服务时退化为「仅本机回环 Host/Origin」的来源检查（`index.js` 的 `makeGuard`）。不要把 DSH 的 `webServer` 暴露到公网——它本身不提供认证。
2. **工作区隔离**：路由与工具的路径参数经过工作区白名单（`workspaceRegistry`）与 `realpath` 前缀校验；看板写入在工作区 `research/.fde/` 内，备份 + 原子写 + revision 乐观并发。
3. **agent 红线**：模型只能准备、建议、提问；推进阶段、通过门禁、归档客户、对外发送材料、改客户定稿文件只能由人在面板执行（`src/host/fde-api.js` 的 `agentGuard`）。
4. **凭据**：生财情报的 token 存在本机 `<workspace>/research/.fde/scys-auth.json`（0600）或环境变量 `FDE_SCYS_TOKEN`；token 不写日志、不回显、只进 `Authorization` 头。不要在 Issue/截图/日志里粘贴 token。

## 已知限制（不属于漏洞，但请知悉）

- `rw_export_pdf` / `rw_qa_pdf` / `rw_scaffold` 会调用本机 `python3`/`bash` 子进程，继承当前用户环境；仅在你信任的会话与工作区使用。
- 同一工作区允许多个 DSH 实例同时读写时，看板依靠 revision 乐观并发保护，但**没有跨进程文件锁**；建议一个工作区只开一个写入实例。
- 插件不抓取任意网页正文、不调用生财写接口、不上传客户数据；唯一可选外联是资料库的 GitHub 指标（无 token）与生财 MCP（需显式授权）。

## 支持版本

仅当前 `1.x` 版本接收安全修复；宿主兼容范围见 `package.json` 的 `engines.dsh` 与 `peerDependencies`。
