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

## 未发布 —— 旁观化重构（`re` 分支）

Absence 不再启动、驱动或应答任何 agent，只做旁观：三条只读通道喂同一条事件管线，
所有写回路径被拒绝。

- 通道 A 转录尾随：`observe/` 尾随 agent 自己写的会话文件（pi 格式，
  `ABSENCE_OBSERVE_PI_ROOT` 可覆盖根目录）。发现只列目标，不创建会话；选中目标
  （`POST /api/observe/watch` 或 CLI `absence observe`）才回填并开始监控；
  `ABSENCE_AUTO_ATTACH=1` 恢复按近期活跃度自动挂载。
- 通道 B ACP 代理：代理会话把 agent spawn 进持久化的观察会话（`acp-proxy`），注入
  `ABSENCE_SESSION_ID` 精确归因，把客户端提示词投影为 run 边界。
- 通道 C OS 旁观：共享的全机扫描器（`ExternalScanner`）给每个观察会话分发其绑定的
  进程子树；默认 pi 只按无歧义的 1:1 配对绑定，并以进程工作目录限定项目范围；
  绑定始终跟随进程最后写入的转录——运行中切换过会话（`-c`、会话选择器）的
  进程不会再被错配回它启动时的那个文件。
- 历史重新可读：历史行或 `/s/<id>` 深链会以只读方式重开归档，不再 404；
  OS-only 观察升级出转录时会把对话回填进去，归档里的进程事实不会被误当成
  转录历史而被“预热”掉。
- 时间线泳道重新带上各自的时长：转录 assistant 记录的 `durationMs` 在生成结束时
  关闭思考/回复，`toolResult` 的 `durationMs` 把命令放回真正执行的时刻，Shell
  泳道不再盖住模型的思考时间。
- run 边界跟随当前通道：给进程观察折入转录后，run 索引从“活动爆发”切回用户
  轮次，并重建已写入的行（它们此前按首个事件命名成 “usage” / “tool_end”）；
  同时停掉 burst 定时器，避免把 agent 仍在写的轮次提前关掉；burst 会话被回收时
  关闭其未完成 run，不再留下永远 `running` 的行。
- 外部进程的内核级观察：在观测台选中一个运行中的 pi，则对该 pid 建立专用内核
  观察者。Windows 用 `agentwatch --target-pid <pid>` 把该进程接管进独立 Job
  Object；Linux 用机器级 eBPF 流按祖先过滤。进程子树按事件报告，不做轮询。用户
  继续在自己终端运行 pi；Absence 不是父进程，也不是代理
  （`process/TargetedObserver.ts`）。无法接管内核观察者时退化为进程表扫描。
- Web 即观测台：列出转录、代理与历史，不启动任何 agent；聊天输入、斜杠面板、审批
  按钮、`/model` 切换与所有「+ Chat」入口均已移除，审批卡只读。
- ACP 驱动栈（AcpAdapter / AcpConnection / AcpSession / 权限桥 / 认证 / 配置项 /
  AgentCatalog / profiles）已删除；`createAdapter` 只解析 mock fixture，其他会话一律
  旁观，写回路由返回 403。
- SQLite schema v5：`sessions.channel`/`external_id`（观察身份）与
  `runs.boundary_source`；重启后 re-attach 复用归档行；无 viewer 的观察会话静默
  `ABSENCE_ARCHIVE_SILENCE_MS` 后自动归档。
- Windows 强制关闭 Docker 容器捕获（不探测 WSL、不能用环境变量重新开启）；非 Windows
  由转录命令窗口归因。
- 中途挂载诚实：回填分块流式（单条记录可跨块），首个 run 标 `attach`/`truncatedBefore`
  且不编造提示词，回填期间追加的记录在收尾时补读一次。
- SQLite schema v7：`transcript_checkpoints` 与事件同事务保存已消费字节偏移和前缀
  SHA-256；重启校验前缀一致才从断点续读，停服期间的追加补上且不重复；转录被改写或
  截断时停止合并，观测台显示 `transcriptResumeBlocked`。

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
