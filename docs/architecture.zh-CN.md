# 架构

[English](architecture.md) | [简体中文](architecture.zh-CN.md)

本文描述 Absence 的内部结构与机制：agent 进程如何变成事件流，事件如何被存储，以及界面、回放与 Absence Report 如何消费这些事件。agent 的安装与协议接入见 [agent-support.zh-CN.md](agent-support.zh-CN.md)。

## 1. 数据流

Absence 启动一个 ACP agent，或附着到一个已经运行的 agent。两种情况下，服务端都收集三类事实，把它们转换成 `AbsenceEvent`，再分发给界面、归档、回放与报告。

```text
Agent 进程（任意 ACP agent）
    │  通过 stdio 传输 ACP session/update（NDJSON JSON-RPC）
    ▼
AcpConnection → AcpSession / AcpAdapter
    │
    ├── projector（AcpToolMapper + ToolRules）─────────┐
    │                                                 ▼
    │                                          AbsenceEvent
    │                                                 │
OS 事实                                                │
    ProcessWatcher（Job Object / eBPF / 快照采样）──────┤
    FileWatcher ───────────────────────────────────────┤
                                                       │
            ┌──────────────────┬───────────────┬────────┴──────────┐
            ▼                  ▼               ▼                   ▼
       WebSocket          SQLite 归档      回放（Web）    Absence Report（Web）
            │                  │
            ▼                  ▼
      face / Stage      History / Agent Folder
```

projector 读取 `session/update` 并写入 `AbsenceEvent`。进程与文件 watcher 直接写入 `AbsenceEvent`。`SessionStore` 把两个来源合并成一条有序事件流，通过 WebSocket 广播，并缓冲写入 SQLite。回放与 Absence Report 是 Web 端对该事件流某个切片的归约；服务端不计算它们。

会话通过 ACP adapter 驱动：Absence 拥有子进程，并发送 `session/new`、`session/prompt`、审批响应与 `/auth`。

## 2. 仓库结构

根 workspace 包含 `packages/*`、`apps/server` 与 `apps/web`。`apps/desktop` 由根脚本以 `npm --prefix apps/desktop ...` 管理，不属于 workspace 成员。

| 路径 | 职责 |
|---|---|
| `apps/server` | Fastify 服务端：ACP 接入、会话、归档、进程与文件观察、指标、WebSocket 与 HTTP API。 |
| `apps/web` | React/Vite 客户端：face、Stage 渲染、回放、Absence Report、文件历史、指标与项目选择器。 |
| `apps/desktop` | Electron 壳。在进程内运行同一 server，并加载同一份 web 构建。 |
| `packages/core` | 共享领域类型与事件契约：`AbsenceEvent`、会话类型、指标类型、已知行工具。直接导出 TS 源码，没有构建步骤。 |
| `native/agentwatch` | Windows 进程观察助手：C 源码、预编译可执行文件与 `build.bat`。 |
| `native/agentwatch-linux` | Linux eBPF 观察助手：BPF C 源码、loader 与 `build.sh`。 |
| `scripts/checks` | 由 `tsx` 运行的独立验收检查。仓库没有单元测试框架。 |

## 3. 模块职责

### 3.1 ACP 接入 — `apps/server/src/agents/acp`

| 模块 | 职责 |
|---|---|
| `AgentCatalog.ts`、`profiles.ts` | 解析本机存在哪些 agent、它们的启动数据、就绪状态与只读配置探测。 |
| `AcpConnection.ts`、`protocol/**` | stdio 传输与 JSON-RPC/NDJSON 分帧；`initialize`、会话方法、请求路由。 |
| `AcpAdapter.ts`、`AcpSession.ts` | 会话生命周期：启动进程、打开或恢复会话、发送 prompt、取消回合、应答审批。 |
| `AcpToolMapper.ts`、`ToolRules.ts`、`toolRules.json` | 按 ACP `kind` 与字段形状把工具调用投影成 `AbsenceEvent`。 |
| `AcpPermissionBridge.ts`、`AcpAuth.ts`、`AcpConfigOptions.ts` | 审批转发、认证桥接与配置项。 |
| `proxy/**` | 透明 ACP 代理：在外部 client 与 agent 之间原样转发行，同时旁听同一份流量生成事件。 |

`apps/server/src/agents/createAdapter.ts` 中的 `createAdapter` 是会话层使用的入口。profile 为 ready 时返回 `AcpAdapter`，否则抛出 catalog 给出的就绪原因。非 ACP adapter 是检查使用的 `mock` fixture。

### 3.2 会话与归档 — `apps/server/src/sessions`

`SessionStore.ts` 持有实时会话状态：有序事件列表、当前 run、Stage 动作、聊天消息、文件状态、进程 watcher 与指标采样器。`storage/**` 负责持久化。实时状态的权威来源是内存中的 `SessionStore`；SQLite 只负责持久化。

### 3.3 进程观察 — `apps/server/src/process`

`ProcessWatcher.ts` 把进程创建与退出转换成 `process` 事件，并归因到命令、egg 与会话。`JobMonitor.ts` 持有进程级的内核观察器，Windows 选择 `JobSidecar`，Linux 选择 `EbpfObserver`。`classify.ts` 判定进程是 primary egg 还是 helper。`DockerMonitor.ts` 与 `DockerEggs.ts` 覆盖容器。`ProcessMetrics.ts` 与 `metricSample.ts` 采样资源使用；`storage/metrics.ts` 负责持久化。

### 3.4 文件观察 — `apps/server/src/filesystem`

`FileWatcher.ts` 用 `chokidar` 观察项目目录（depth 8）及其父目录（depth 2）。项目内的变化生成 `file_change` 事件；父目录中的变化标记为 `outside`。watcher 忽略 `node_modules`、`.git`、`dist` 等目录，以及二进制或压缩文件。

### 3.5 指标

指标数据不使用 `AbsenceEvent`。它每 5 秒按 wall clock 边界采样，通过独立 WebSocket 通道传输，并持久化到 SQLite。采样对象是整个 agent 树、每个 egg 子树、Docker 容器与主机。一个 frame 包含进程计数器、主机计数器、每个 egg 的汇总与精度标记。

### 3.6 HTTP 与 WebSocket — `apps/server/src/api`、`apps/server/src/websocket`

HTTP API 提供项目列表、会话创建与观察、会话快照、分页事件、run 摘要、文件版本、文件内容、prompt、审批、命令、指标与 agent catalog 管理。会话 WebSocket 先发送 `snapshot`，随后发送批量 `event` 与 `session_state` 消息。另一个终端 WebSocket 暴露 PTY 字节镜像。事件帧按 50 ms 或 200 条合批。

### 3.7 Web 客户端 — `apps/web`

客户端渲染三个可切换 face 与一个浮层，见第 6 节。它从 WebSocket 接收事件与会话状态，并从 HTTP API 读取历史、文件版本与指标。客户端不知道事件由哪个 agent 产生；它只消费 `AbsenceEvent`。

### 3.8 桌面壳 — `apps/desktop`

见第 9 节。

## 4. 事件模型

`AbsenceEvent` 是会话 WebSocket 传输并存入归档的事件类型。事件类型定义在 `packages/core/src/events.ts`：

```ts
type AbsenceEventType =
  | "agent_start" | "agent_end" | "message" | "thinking"
  | "tool_start" | "tool_update" | "tool_end"
  | "file_read" | "file_write" | "file_edit" | "file_change"
  | "command" | "search" | "process" | "approval" | "mcp" | "error"
  | "usage";
```

每条事件携带 `source` 与 `fidelity`：

| `source` | 来源 |
|---|---|
| `acp` | ACP `session/update`。 |
| `acp-proxy` | 通过透明代理观察到的 ACP 流量。 |
| `os` | 进程或文件观察。 |
| `unknown` | 未记录来源。 |

| `fidelity` | 含义 |
|---|---|
| `exact` | 协议原样携带，或由 OS 读取。 |
| `reported` | agent 自报，未经独立核实。 |
| `inferred` | Absence 由协议字段推出的显示兜底。 |
| `unknown` | 协议或 OS 未提供该字段。 |

模型、上下文用量、agent 广告的命令与认证方法通过 `session_state` 消息传输，不进入事件流。指标走独立通道。

`usage` 是每个 run 一条、在 run 结束时发出的事件。它携带该 run 的 token 估算：
`outputEst`（由最终 assistant 文本长度估算）、`inputEst`（上报的 context 窗口在本
run 期间的增量，减去输出侧——运行时未上报 context 时为 `null`）、context 占用与
模型名。每个数字都是估算值，payload 以 `estimated: true` 声明。Absence 不解析模型
响应，因此拿不到真实 token 数；估算是启发式（CJK ≈ 每字 1 token，其他文本 ≈ 每
4 字符 1 token，见 `packages/core/src/tokens.ts`）。该事件是 run 范围 token 合计的
数据管道，不是展示用活动：它不进入 Activity 流。

观察层次：

| 层 | 内容 | 可用性 |
|---|---|---|
| OS 事实 | 进程创建与退出；文件创建、修改与删除。 | 始终尝试。助手可用时使用内核事件；否则使用快照采样。 |
| 终端镜像 | Absence 以 PTY 启动 agent 时复制的原始 stdout/stderr 字节，不解析。 | 仅当 Absence 以 PTY 启动 agent 时存在。当前 Web 客户端未连接终端 WebSocket。 |
| ACP 语义 | 工具调用、文件、命令、MCP 调用、审批、思考与消息。 | agent 上报时可用。缺失字段保持 `unknown`。 |

ACP 层缺失时界面仍可用：OS 事实仍可生成 Activity 行、Agent Eggs、文件变化与报告。

## 5. 存储

一个 SQLite 数据库 `~/.absence/absence.db` 同时保存归档与指标。`ABSENCE_STATE_DIR` 改变数据库与归档根目录。`agents.json` 与 `registry.json` 属于 catalog 文件；它们位于 `ABSENCE_CATALOG_DIR` 或 `~/.absence` 下，不受 `ABSENCE_STATE_DIR` 影响。`db.ts` 以 WAL、`synchronous=NORMAL`、busy timeout 与外键打开数据库，持有 schema 与迁移，并通过 `openDatabase()` 暴露共享句柄。

SQLite 访问不只发生在 `db.ts`：

| 模块 | 直接访问 SQLite 的工作 |
|---|---|
| `sessions/storage/db.ts` | 打开、pragma、schema、迁移、事件缓冲与分页读取。 |
| `sessions/storage/files.ts` | 准备并写入 `file_versions`；读取版本索引与内容。 |
| `sessions/storage/runs.ts` | 维护 `runs` 索引，读取单个 run 的事件范围。 |
| `sessions/storage/metrics.ts` | 写入、读取与过期 `metric_chunks`、`egg_metric_summary` 与 `host_metric_chunks`。 |

表：

| 表 | 内容 |
|---|---|
| `store_meta` | schema 版本与存储级元数据。 |
| `sessions` | 每个归档会话一行：项目、时间戳、runtime、模型、消息数、首条 prompt 与不透明 ACP resume handle。 |
| `events` | 有序事件，含 `seq`、payload、`source` 与 `fidelity`。 |
| `runs` | run 索引：事件范围、prompt、开始与结束、状态与计数。 |
| `file_versions` | 完整与部分文件版本，含来源、行范围与已知行数据。 |
| `metric_chunks` | 每个 egg 的指标 chunk，以二进制数组打包。 |
| `egg_metric_summary` | 每个 egg 的首末样本、CPU 基线与终值、RSS 积分、样本数。 |
| `host_metric_chunks` | 主机指标 chunk，使用相同的打包结构。 |

归档写入缓冲 50 ms，并以一个事务提交。一次进程或文件事件突发因此只产生一次提交。`drainArchive()` 在 dispose 时冲刷。

保留策略：

| 范围 | 策略 |
|---|---|
| 实时事件列表 | 内存中最多保留 `MAX_SESSION_EVENTS` = 10,000 条事件。流式消息与思考增量不落盘。 |
| 归档会话 | 默认全部保留。`ABSENCE_SESSION_RETENTION_DAYS` 与 `ABSENCE_MAX_ARCHIVED_SESSIONS` 增加按天与按数量的过期策略；两者默认均为 0（全部保留）。 |
| 指标 | 默认保留 30 天。`ABSENCE_METRICS_RETENTION_DAYS=0` 全部保留。过期每天运行一次。 |
| 指标 chunk | 每个 chunk 覆盖 30 分钟 wall time；每 15 秒 flush 一次。 |
| Agent Eggs | 运行中的 egg 始终保留。已结束的 egg 超过 `ABSENCE_MAX_EGGS`（默认 200）后，按退出时间淘汰最旧的，并带 `retired: true` 从实时面板移除。归档中的 `process` 事件不删除。 |
| 终端镜像 | 256 KB ring buffer，60 ms 合批，仅流式传输。 |

文件版本与 run 事件分开存储，因此 Agent Folder 与 File History 无需加载某个 run 即可工作。写入或编辑追加一个完整版本。连续读取累积成一个部分 v0 版本。读取未报告行范围时，Absence 会尝试用磁盘核实一个：把返回文本定位到文件里，精确且唯一的匹配即得出该次读取的行坐标。匹配有歧义、文件缺失或读取已过期时，版本保留 `rangeKnown=false`，界面将范围显示为 unknown。

## 6. Web 渲染层

客户端使用 React 19、Vite、Tailwind 与 Zustand。`useMonitorData` 在每个渲染周期为选中的 run 派生 Activity 行、`RunFacts`、完成态 `RunReport`、实时注意力与实时 headline。Chart face 与 Monitor face 消费同一份派生结果。

face：

| face | 内容 |
|---|---|
| Rounds | 桌面场景：角色、故事卡片，以及 Files、Agent Folder、Agent Eggs 与当前 run 的 dock 窗口。 |
| Monitor | 三列：Activity/Files/Attention 信息流、中央 Stage，以及 Agent Head/Usage/Agent Eggs/Agent Folder。 |
| Chart | 整页 Absence Report：结论、KPI、时间线、Changes、Executions、Knows、Attention 与证据预览。 |
| Drip | 独立于 face 切换器的浮层开关。紧凑卡片包含实时事件、最终回复与输入框。 |

`ViewMode` 为 `rounds | monitor | chart | drip`；切换器只暴露前三个。Drip 作为开关存储。默认 face 是 Monitor；未知或过期的存储值解析为 Monitor。

Stage 行为：

- `SessionStore.applyToState` 决定哪条事件拥有 Stage。`message` 清空 Stage 并把 agent 状态设为 `speaking`；`process` 不拥有 Stage。
- Web 客户端在 `apps/web/src/lib/events.ts` 与 `apps/web/src/components/stage/StageItemView.tsx` 中把事件转换成 file、diff、terminal、thought、speech、process 与 approval 卡片。
- Monitor 的 Stage 有两个页面标签：`METRICS` 与 `CHAT`。Activity 卡片按 follow、pin 或 replay 状态显示。没有 `FILE`、`DIFF` 或 `TERMINAL` 标签条。
- `activityViews.ts` 从一个 pinned 事件派生 file、diff 与 terminal 视图。

Absence Report 完全由 Web 端的 `apps/web/src/lib/report.ts` 计算，输入是一个 run 的事件切片（`run.fromIndex` 到 `run.toIndex`）。它是确定性归约，不调用 LLM，不解析命令。命令文本仅用于把 `tool_start` 与 `tool_end` 配对。缺失退出码记为 `exitCodeKnown=false`。

## 7. 回放

回放由 run 事件与周期快照重建。

- 每 25 个事件或每 5 秒做一次快照，以先到者为准。
- 快照保存事件索引、时间戳、文件 map、agent 状态与当前 Stage 动作。
- 文件重建：`file_write` 覆盖文件；`file_edit` 应用 `after`；`file_read` 只在路径仍未知时作为初始内容；`file_change deleted` 删除路径。
- `seek` 选择时间戳不晚于目标时间的最近快照，再应用余下事件到目标时间。
- 播放按 80 ms tick 推进。速度选项为 `0.25 / 0.5 / 1 / 2 / 5 / 10`。到 run 末尾自动暂停。
- Monitor Stage 底部时间线有 Model（模型的思考与发言）、Tools（工具调用，含 MCP）、Shell（命令执行）三条独立轨道，点击即 seek。Rounds 的故事卡片与 Monitor 的 feed 行点击时同样 seek。

回放范围：

| 重建 | 不重建 |
|---|---|
| 文件内容、agent 状态、当前 Stage 动作。 | 指标曲线、Agent Eggs 面板、PTY 终端字节。 |

指标与 egg 是独立的实时视图。终端镜像不参与回放。

## 8. 进程观察

`JobMonitor` 在 server 进程内创建一次，早于任何会话存在。Windows 使用 `native/agentwatch` 把 server 进程放入 Job Object，并报告后代进程的创建与退出。Linux 使用 `native/agentwatch-linux` 的 eBPF tracepoint，需要 `CAP_BPF`/`CAP_PERFMON` 或 root。

助手不可用，或根进程不在 Job Object 内时，`ProcessWatcher` 退化为进程表快照。Windows 使用 PowerShell `Get-CimInstance Win32_Process`，其他平台使用 `ps`。采样下限约为 0.5 秒，指标精度标记为 `sampled`。来自已持有句柄的内核数值标记为 `exact`。

归因：

- 驱动会话：projector 在出现 `kind=execute` 的 `tool_call` 时开启命令窗口，在终态更新时关闭。内核事件按祖先链认领；命令窗口决定事件属于哪条命令。
- 上报的进程是子树根。后代计入 `children`，不单独成为 egg。
- 父链断裂或父 pid 未知的孤儿进程不被认领。

分类（`classify.ts`）按以下顺序判定：活过命令、有子进程、被命令点名、被后台化并重定向、来自工具安装目录、从工作区运行、生命周期短于 300 ms、名字命中短命工具先验且年龄小于 2 秒，其余为未分类。primary 进程成为 Agent Eggs；helper 折叠为计数与名字摘要。

Docker 容器运行在 daemon VM 内，Job Object 与 eBPF 都无法触及。`DockerMonitor` 从 `docker events` 读取生命周期，从 `docker stats` 读取资源。在命令窗口内启动的容器以合成 pid（≥1,000,000,000）成为 egg；窗口外启动的容器不归因。

## 9. 桌面打包

`apps/desktop` 是 Electron 壳，使用 Electron 37 与 electron-builder。`main.cjs` 在同一进程内启动 server，因此应用只有一套生命周期，也不会产生额外的控制台窗口。开发检出通过 `tsx` 加载 server；打包版本加载 `apps/server-bundle.cjs`。

打包阶段装入打包后的 server、它的运行时 `node_modules`、`dist/web` 中的 web 构建与一个启动脚本。Windows 包额外加入 `native/agentwatch/agentwatch.exe`；Linux 包额外加入 `native/agentwatch-linux/agentwatch-linux`。web 构建与浏览器使用的构建相同。

Electron 必须捆绑 Node 22.19 或更高版本，因为 server 使用 `node:sqlite`。仓库通过 `engines` 与 `.nvmrc` 固定 Node 版本。

Drip 在桌面壳中作为独立的透明置顶窗口打开。在浏览器构建中，它使用 Document Picture-in-Picture。

## 10. 边界

- ACP 的上报义务为 `SHOULD`；协议不要求 `MUST`。`kind` 缺失时变成 `other`；`locations` 缺失时读取范围标记为 unknown，除非返回文本与磁盘文件精确且唯一地匹配——那会核实出范围。Absence 不猜测缺失字段。
- `kind` 缺失或无法使用的工具调用走 `ToolRules` 的字段形状规则。部分工具载荷无法按形状归类。
- 并发命令的命令行不匹配时，进程归因可能出错。兜底策略保留该进程，不丢弃。
- 快照模式可能漏掉短命进程。
- Codex 的 Windows 沙箱是否把子进程留在 Job Object 内取决于 agent 实现。Absence 不对这一点作断言。
</content>
</file_path>
</invoke>
