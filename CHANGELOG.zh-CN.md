# Changelog

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

Absence 从 v0.2.0 到 v0.5.0 的版本索引。每条是摘要，完整说明在 `docs/releases/`
下。发布流程见 [releasing.md](docs/releasing.md)。

| 版本 | 主题 | 说明 |
| --- | --- | --- |
| v0.5.0 | ACP 接入层与界面重构 | [v0.5.0](docs/releases/v0.5.0.zh-CN.md) |
| v0.4.0 | 持久化、指标与验证 | [v0.4.0](docs/releases/v0.4.0.zh-CN.md) |
| v0.3.0 | Codex、DSH 与 shell 接管 | [v0.3.0](docs/releases/v0.3.0.zh-CN.md) |
| v0.2.0 | 个性化头像与 Agent Eggs 过滤 | [v0.2.0](docs/releases/v0.2.0.zh-CN.md) |

## v0.5.0 —— ACP 接入层与界面重构

[v0.5.0 发布说明](docs/releases/v0.5.0.zh-CN.md)

- agent 通过单一 ACP 接入层运行（`AgentCatalog` → `AcpAdapter` →
  `AcpConnection`）。内置 profile：Pi、Codex、Codex ACP 替代包、DSH、
  Claude Code、Qwen Code、Gemini。自定义 agent 是
  `~/.absence/agents.json` 中的数据条目。
- 选择器探测本机 agent，显示 `ready`、`needs-adapter`、`needs-auth` 或
  `unavailable`；最后一格用于添加自定义 ACP 条目。
- 斜杠命令按原文转发；`/auth` 是唯一的本地命令。审批原样回传 agent 给出的
  option id。
- 事件带 `source` 与 `fidelity`（`exact`、`reported`、`inferred`、`unknown`）；
  缺失的协议字段不补值。
- 三个 face（Rounds、Monitor、Chart）与 Drip 浮层；默认 Monitor。Settings 有
  Appearance、Report WARN、Personalization 与 Agent Eggs 过滤四栏。
- SQLite 归档支持分页回放、归档删除与会话保留；指标、Agent Eggs、Agent Folder、
  Replay 与 Absence Report 使用归档事件。
- 提供 Docker 容器蛋与透明 ACP 代理。
- Windows 发布包含免安装 ZIP。
- 移除：各产品专用适配器（`PiAdapter`、`CodexAdapter`、`DshAdapter`）、
  `codex app-server`、exec-server shell 接管、`AbsenceShell`、`ExecServer`、
  `CodexShell`、`ShellEnvironment`、capabilities 配置管理、Pi 私有会话合并、
  本地斜杠命令与 Classic 布局。

## v0.4.0 —— 持久化、指标与验证

[v0.4.0 发布说明](docs/releases/v0.4.0.zh-CN.md)

- 会话、事件、run 与文件版本迁移到 `~/.absence/absence.db`；旧 JSONL 归档一次性
  导入。
- History 增量索引，Activity 按 run 加载。
- CPU/RSS 指标覆盖 agent 的主 egg，带实时 ring、SQLite chunk 与 30 天保留。
- Agent 文件视图保留未读行段缺口，并可在已记录版本之间切换。
- `npm run verify` 运行类型检查、生产 web 构建与全部离线检查。
- v0.4.0 的 Stage 以 METRICS 为默认页，并带 FILE / DIFF / TERMINAL / LIVE
  内容视图；v0.5.0 用 face 取代了该布局。

## v0.3.0 —— Codex、DSH 与 shell 接管

[v0.3.0 发布说明](docs/releases/v0.3.0.zh-CN.md)

- Codex 加入 Pi，通过 `codex app-server` 驱动。
- DSH 通过它的 ACP server（`dsh --profile acp`）加入。
- Absence 通过 loopback exec-server 接管 Codex 的 shell。
- 支持真实 PTY，并处理 Ctrl+C。
- 审批成为 activity 行。
- Absence Report 的注意力阈值与等级可配置，并新增自定义音效集。
- 新增运行时发现与 `~/.absence/runtimes.json`，Settings 增至四栏。
- Codex app-server 客户端、exec-server 接管、`AbsenceShell`、`ExecServer`、
  `CodexShell`、`ShellEnvironment` 以及 Codex 与 DSH 专用适配器已在 v0.5.0
  移除。

## v0.2.0 —— 个性化头像与 Agent Eggs 过滤

[v0.2.0 发布说明](docs/releases/v0.2.0.zh-CN.md)

- 内置角色更名为 WhaleBun。
- 头像皮肤支持按状态上传 mp4、gif、png、webp、svg，并在服务端用 ffmpeg 重编码。
- Agent Eggs 过滤档案把命名的辅助命令折叠为计数。
- v0.2.0 的 Settings 对话框有三栏；其布局在 v0.3.0 与 v0.5.0 有变化。
