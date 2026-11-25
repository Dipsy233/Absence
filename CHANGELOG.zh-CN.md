# Changelog

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

Absence 从 v0.2.0 到 v0.6.0 的版本索引。每条是摘要，完整说明在 `docs/releases/`
下。发布流程见 [releasing.md](docs/releasing.md)。

| 版本 | 主题 | 说明 |
| --- | --- | --- |
| v0.6.0 | 只做旁观：三条只读通道 | [v0.6.0](docs/releases/v0.6.0.zh-CN.md) |
| v0.5.5 | 空闲开销、报告接口与旁观契约 | [v0.5.5](docs/releases/v0.5.5.zh-CN.md) |
| v0.5.0 | ACP 接入层与界面重构 | [v0.5.0](docs/releases/v0.5.0.zh-CN.md) |
| v0.4.0 | 持久化、指标与验证 | [v0.4.0](docs/releases/v0.4.0.zh-CN.md) |
| v0.3.0 | Codex、DSH 与 shell 接管 | [v0.3.0](docs/releases/v0.3.0.zh-CN.md) |
| v0.2.0 | 个性化头像与 Agent Eggs 过滤 | [v0.2.0](docs/releases/v0.2.0.zh-CN.md) |

## v0.6.0 —— 只做旁观：旁观化重构

[v0.6.0 说明](docs/releases/v0.6.0.zh-CN.md)

Absence 不再启动、驱动或应答任何 agent，只做旁观：三条只读通道喂同一条事件管线，
所有写回路径被拒绝。

- 通道 `transcript` 尾随 pi 自己写的会话文件；通道 `acp-proxy` 把 agent spawn 进
  持久化的观察会话并旁听协议；通道 `os` 上报用户已启动进程的子树、文件、资源与
  容器。发现只列目标，不打开会话；选中目标才接入。
- ACP 驱动栈、agent 选择器、聊天、斜杠面板、审批按钮与 `/model` 已删除。
  `createAdapter` 只解析 mock 夹具，其他会话在写回路由上返回 403。
- 观测台就是正门：两栏（运行中的目标、历史），点击开始监控、再点一次即停止，
  运行中的行与历史行一样显示首个提示词。启动器不再存在。
- 历史以只读方式重开归档，不再 404；OS-only 观察升级出转录时把对话回填进同一个
  会话；pi 进程按 `--session <路径>`、`--session <id>` 或裸 `pi`（项目工作目录加
  最近写入）识别，且始终跟随它最后写入的文件。
- 内核观察绑定单个 pid：Windows 上 `agentwatch --target-pid` 把它收进自己的
  Job Object，Linux 上按祖先关系过滤全机 eBPF 流，进程表扫描作为回退。
- 一次 `edit` 工具调用只算一条 `file_edit` 事实；转录记录的 `durationMs` 在生成
  结束时关闭思考、或把命令放回它真正执行的时刻；run 边界跟随当前通道，折入转录时
  从活动爆发切回用户回合。
- SQLite schema v5 新增观察身份（`channel`、`external_id`）与
  `runs.boundary_source`，重新接入复用归档行，观察会话在
  `ABSENCE_ARCHIVE_SILENCE_MS` 无活动后自动归档。schema v7 新增
  `transcript_checkpoints`，重启后只有前缀 SHA-256 校验通过才继续尾随。
- `absence` 是无界面入口：`serve`、`ls`、`observe`、`open`、`unwatch` 与
  `proxy`。
- Windows 的 Docker 采集被强制关闭，没有任何环境变量可以打开。

## v0.5.5 —— 空闲开销、报告接口与旁观契约

[v0.5.5 说明](docs/releases/v0.5.5.zh-CN.md)

- 存活探测不再遍历进程表，进程表快照改由原生助手读取，不再走 PowerShell/CIM
  （386 行 17 ms，相对 1.19 秒 CPU）。Monaco 改为懒加载分块，主包从约 3.9 MB 降到
  约 750 KB，历史刷新只读归档尾部。
- Absence Report 引擎移入 `@absence/core`，`GET /api/sessions/:id/report[?run=<n>]`
  无需浏览器即可拿到同一份报告。空闲 run 不再每秒重算两次。
- `/model` 回归为端口动作，走 agent 的 `model` 配置项
  （`session/set_config_option`）；手输 `/model …` 仍按原文转发。
- 进程回收器已删除：Absence 只旁观，从不杀进程。关闭会话不再终止它驱动的命令
  子树。
- 桌面壳绑定稳定端口（记录值，其次 8848/8849/8850），`localStorage` 设置因此能
  持久化；全新安装以 glass/dark 启动。
- agent 可执行文件不再 spawn `where`；0 字节写入被捕捉；shell 创建的文件读作
  CREATE；选择器卡片、会话 id 与路径匹配已修复；回放后各面板跟随最新 run。

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
