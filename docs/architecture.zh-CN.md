# 架构

[English](architecture.md) | [简体中文](architecture.zh-CN.md)

本文描述 Absence 的内部结构：事实如何从 agent 到达界面、归档、回放与 Absence Report。运行观察器与选择目标见 [observation.zh-CN.md](observation.zh-CN.md)。

## 1. 数据流

Absence 不驱动任何 agent。用户在自己的终端或编辑器中运行 agent 软件，Absence 通过三条只读通道观察同一条事件管线。

```text
     通道 A:转录尾随                    通道 B:ACP 代理
     尾随 agent 软件自己写的              编辑器 ACP client 指向代理,
     会话文件                             tap 投影同一份流量
              │                                  │
              └────────── AbsenceEvent ──────────┘
                              ▲
                              │ OS 事实
   ProcessWatcher(内核观察器 / 共享扫描)
   ExternalScanner · FileWatcher · DockerMonitor(非 Windows)
                              │
                              ▼
        ┌──────────────┬──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
   WebSocket      SQLite 归档      回放(Web)    Absence Report(Web)
        │              │
        ▼              ▼
   face / Stage   History / Agent Folder
```

转录尾随与代理 tap 把各自来源投影成 `AbsenceEvent`(共用 `AcpToolMapper` 的语义层);进程、文件与容器 watcher 直接写入 `AbsenceEvent`。`SessionStore` 把所有通道合并成一条有序事件流,通过 WebSocket 广播,并缓冲写入 SQLite。回放与 Absence Report 是 Web 端对该事件流某个切片的归约;服务端不计算它们。

会话是发现出来的,不由界面流程创建:挂载一份转录打开一个会话;代理会话把 agent spawn 进一个会话;在观测台选择一个进程打开仅 OS 的会话。所有会话都拒绝 prompt、abort、审批与命令流量,写回路由返回 403。唯一例外是开发与检查使用的 `mock` fixture。

## 2. 仓库结构与技术选型

根 workspace 包含 `packages/*`、`apps/server` 与 `apps/web`。`apps/desktop` 由根脚本通过 `npm --prefix apps/desktop ...` 管理,不是 workspace 成员。

| 领域 | 选型 |
|---|---|
| 服务端 | Fastify;归档与指标使用 `node:sqlite` |
| Web 客户端 | React 19、Vite、Tailwind、Zustand;代码视图使用 Monaco |
| 桌面壳 | Electron 37 与 electron-builder |
| 文件观察 | `chokidar` |
| 进程观察 | Windows 通过 `native/agentwatch` 使用 Job Object;Linux 通过 `native/agentwatch-linux` 使用 eBPF;兜底为进程表采样 |
| agent 内容 | pi 会话转录;通过代理的 stdio ACP(JSON-RPC 2.0,NDJSON 分帧) |

| 路径 | 职责 |
|---|---|
| `apps/server` | Fastify 服务端:观察通道、会话、归档、进程与文件观察、指标、WebSocket 与 HTTP API。 |
| `apps/web` | React/Vite 客户端:face、Stage 渲染、回放、Absence Report、文件历史、指标与观测台。 |
| `apps/desktop` | Electron 壳。在进程内运行同一 server,并加载同一份 web 构建。 |
| `packages/core` | 共享领域类型与契约:`AbsenceEvent`、会话类型、指标类型、run 与报告引擎。直接导出 TS 源码,没有构建步骤。 |
| `native/agentwatch` | Windows 进程观察助手:C 源码、预编译可执行文件与 `build.bat`。 |
| `native/agentwatch-linux` | Linux eBPF 观察助手:BPF C 源码、loader 与 `build.sh`。 |
| `scripts/checks` | 由 `tsx` 运行的独立验收检查。仓库没有单元测试框架。 |

## 3. 模块职责

### 3.1 观察通道 — `apps/server/src/observe`、`agents/acp`

| 模块 | 职责 |
|---|---|
| `observe/transcriptSources.ts` | 转录源 profile。当前只有一条(`pi`):watch 根目录、记录在会话上的 agent kind,以及会话目录的环境变量覆盖。 |
| `observe/parsers/pi.ts` | pi 转录记录 → `AbsenceEvent`,标记 `source: "transcript"`。 |
| `observe/Discovery.ts` | 尾随源根目录。每个文件三态:unknown(只解析 header)、attached(会话存在,回填后增量尾随)、missing(文件消失,行保留)。 |
| `observe/Targets.ts` | 由转录、进程表与代理注册表构建观测台的目标列表。构建列表不创建任何东西。 |
| `observe/watch.ts`、`observe/watchOs.ts` | 把目标键解析为通道,挂载会话并记录监控租约;进程表证明同一 agent 时,把转录折入已有的仅 OS 会话。 |
| `observe/leases.ts` | 租约持久化与恢复。 |
| `observe/ObserveAdapter.ts` | 所有非驱动会话使用的 no-op 适配器;`prompt()` 抛错,`abort()` 空操作。 |
| `agents/acp/AcpToolMapper.ts`、`ToolRules.ts`、`toolRules.json` | 按 ACP `kind` 与字段形状把工具调用投影成 `AbsenceEvent`;转录解析器与 projector 共用。 |
| `agents/acp/proxy/**` | 透明 ACP 代理:自己 spawn agent,原样转发字节,旁听同一份流量生成事件,注入 `ABSENCE_SESSION_ID` 获得精确进程归因,并经 `SessionStore.createObserved` 持久化(channel `acp-proxy`)。 |
| `agents/MockAdapter.ts` | 开发与检查使用的脚本化 fixture——Absence 仍然驱动的唯一运行时。 |

`createAdapter` 只解析 mock fixture。其他任何 kind 都产生观察会话;带 `resume` 的 POST 重开归档(回放、目录树、watcher),不 spawn 任何东西。

### 3.2 会话与归档 — `apps/server/src/sessions`

`SessionStore.ts` 持有实时会话状态:有序事件列表、当前 run、Stage 动作、聊天消息、文件状态、进程 watcher 与指标采样器。`storage/**` 负责持久化。内存状态是实时视图的来源;SQLite 是持久记录。

### 3.3 进程观察 — `apps/server/src/process`

`ProcessWatcher.ts` 把进程创建与退出转换成 `process` 事件,并归因到命令、egg 与会话。`JobMonitor.ts` 持有进程级的内核观察器:Windows 使用 `JobSidecar`,Linux 使用 `EbpfObserver`。`ExternalScanner.ts` 每四秒做一次全机扫描,把结果分发给所有观察会话。`ProcessScanner.ts` 按可执行文件签名与绝对 `--session` 转录路径匹配 pi 进程。`classify.ts` 判定进程是 primary egg 还是 helper。`DockerMonitor.ts` 与 `DockerEggs.ts` 覆盖非 Windows 主机的容器。`ProcessMetrics.ts` 与 `metricSample.ts` 采样资源使用;`storage/metrics.ts` 负责持久化。

### 3.4 文件观察 — `apps/server/src/filesystem`

`FileWatcher.ts` 用 `chokidar` 观察项目目录(depth 8)及其父目录(depth 2)。项目内的变化生成 `file_change` 事件;父目录中的变化标记为 `outside`。watcher 忽略 `node_modules`、`.git`、`dist` 等目录,以及二进制或压缩文件。

### 3.5 指标

指标不使用 `AbsenceEvent`。它每 5 秒按 wall clock 边界采样,通过独立 WebSocket 通道传输,并持久化到 SQLite。采样对象是整个 agent 树、每个 egg 子树、Docker 容器与主机。一个 frame 包含进程计数器、主机计数器、每个 egg 的汇总与精度标记。

### 3.6 HTTP 与 WebSocket — `apps/server/src/api`、`websocket`

HTTP 路由覆盖项目列表、观察(`/api/observe/sessions`、`/api/observe/targets`、`/api/observe/live`、`/api/observe/watch`、`/api/observe/unwatch`、`/api/observe/attach`)、代理会话、会话快照、分页事件、run 摘要、文件版本、文件内容与指标。写回路由(`prompt`、`abort`、`approval`、`command`)对除 mock fixture 外的所有会话返回 403。`POST /api/sessions` 重开归档或启动 fixture。

会话 WebSocket(`/ws/sessions/:id`)先发送 `snapshot`,随后发送批量 `event` 与 `session_state` 消息。事件帧按 50 ms 或 200 条合批。

### 3.7 Web 客户端 — `apps/web`

客户端渲染观测台、三个可切换 face 与一个浮层(见第 6 节)。它从 WebSocket 接收事件与会话状态,并从 HTTP API 读取历史、文件版本与指标。客户端只消费 `AbsenceEvent`,不区分产生事件的 agent。

### 3.8 桌面壳 — `apps/desktop`

见第 9 节。

## 4. 事件模型

`AbsenceEvent` 是会话 WebSocket 传输并存入归档的事件类型。类型定义在 `packages/core/src/events.ts`:

```ts
type AbsenceEventType =
  | "agent_start" | "agent_end" | "message" | "thinking"
  | "tool_start" | "tool_update" | "tool_end"
  | "file_read" | "file_write" | "file_edit" | "file_change"
  | "command" | "search" | "process" | "approval" | "mcp" | "error"
  | "usage";
```

每条事件携带 `source` 与 `fidelity`:

| `source` | 来源 |
|---|---|
| `acp` | ACP `session/update`(mock fixture 的 projector)。 |
| `acp-proxy` | 通过透明代理观察到的 ACP 流量。 |
| `os` | 进程或文件观察。 |
| `transcript` | 从 agent 写下的会话转录投影出的事实(通道 A)。 |
| `unknown` | 未记录来源。 |

| `fidelity` | 含义 |
|---|---|
| `exact` | 协议原样携带,或由 OS 读取。 |
| `reported` | agent 自报,未经独立核实。 |
| `inferred` | Absence 由协议字段推出的显示兜底。 |
| `unknown` | 协议或 OS 未提供该字段。 |

模型、上下文用量、agent 广告的命令与认证方法通过 `session_state` 消息传输,不进入事件流。指标走独立通道。

`usage` 由转录通道在回合关闭时发出,每个 run 至多一条,且只在转录上报了 token 数时发出。它携带 `outputEst`(该回合 assistant 记录 `output` 之和)、`contextUsed`(该回合出现过的最大 `input + cacheRead + cacheWrite`)、模型名与 `estimated: true`。ACP 代理通道不发出 `usage` 事件,因为代理协议不携带 token 记账。该事件为 run 范围的 token 合计提供数据,不属于展示活动,因此不进入 Activity 流。`packages/core/src/tokens.ts` 的启发式估算供客户端在没有上报数值时使用。

观察层次:

| 层 | 内容 | 可用性 |
|---|---|---|
| OS 事实 | 进程创建与退出;文件创建、修改与删除。 | 始终尝试。观察器可用时使用内核事件;否则使用快照采样。 |
| ACP 语义 | 工具调用、文件、命令、MCP 调用、审批、思考与消息。 | ACP 客户端经代理转发时可用。缺失字段保持 `unknown`。 |
| 转录语义 | 同一组类别,由 pi 会话记录投影。 | pi 转录挂载时可用。 |

内容通道缺失时界面仍然可用:OS 事实仍可生成 Activity 行、Agent Eggs、文件变化与报告。

## 5. 存储

一个 SQLite 数据库 `~/.absence/absence.db` 同时保存归档与指标。`ABSENCE_STATE_DIR` 改变数据库与归档根目录。`db.ts` 以 WAL、`synchronous=NORMAL`、busy timeout 与外键打开数据库,持有 schema 与迁移,并通过 `openDatabase()` 暴露共享句柄。

SQLite 访问分布在四个模块:

| 模块 | 直接访问 SQLite 的工作 |
|---|---|
| `sessions/storage/db.ts` | 打开、pragma、schema、迁移、事件缓冲与分页读取。 |
| `sessions/storage/files.ts` | 准备并写入 `file_versions`;读取版本索引与内容。 |
| `sessions/storage/runs.ts` | 维护 `runs` 索引,读取单个 run 的事件范围。 |
| `sessions/storage/metrics.ts` | 写入、读取与过期 `metric_chunks`、`egg_metric_summary` 与 `host_metric_chunks`。 |

表(schema v7):

| 表 | 内容 |
|---|---|
| `store_meta` | schema 版本与存储级元数据。 |
| `sessions` | 每个归档会话一行:项目、时间戳、runtime(agent kind)、模型、消息数、首条 prompt,以及 re-attach 依赖的观察身份(`channel` + `external_id`)。 |
| `transcript_checkpoints` | 每个会话已消费的转录字节偏移与已消费前缀的 SHA-256,与事件同事务写入,用于重启后续采。 |
| `events` | 有序事件,含 `seq`、payload、`source` 与 `fidelity`。 |
| `runs` | run 索引:事件范围、prompt、开始与结束、状态、计数与 `boundary_source`。 |
| `file_versions` | 完整与部分文件版本,含来源、行范围与已知行数据。 |
| `metric_chunks` | 每个 egg 的指标 chunk,以二进制数组打包。 |
| `egg_metric_summary` | 每个 egg 的首末样本、CPU 基线与终值、RSS 积分、样本数。 |
| `host_metric_chunks` | 主机指标 chunk,使用相同的打包结构。 |
| `watch_leases` | 监控租约:目标键、会话、通道、身份、文件、pid 与启动时间。 |

归档写入缓冲 50 ms,并以一个事务提交,因此一次进程或文件事件突发只产生一次提交。`drainArchive()` 在 dispose 时冲刷。

保留策略:

| 范围 | 策略 |
|---|---|
| 实时事件列表 | 内存中最多保留 `MAX_SESSION_EVENTS` = 10,000 条事件。流式消息与思考增量不落盘。 |
| 归档会话 | 默认全部保留。`ABSENCE_SESSION_RETENTION_DAYS` 与 `ABSENCE_MAX_ARCHIVED_SESSIONS` 增加按天与按数量的过期策略;两者默认均为 0(全部保留)。 |
| 指标 | 默认保留 30 天。`ABSENCE_METRICS_RETENTION_DAYS=0` 全部保留。过期每天运行一次。 |
| 指标 chunk | 每个 chunk 覆盖 30 分钟 wall time;每 15 秒 flush 一次。 |
| Agent Eggs | 运行中的 egg 始终保留。已结束的 egg 超过 `ABSENCE_MAX_EGGS`(默认 200)后,按退出时间淘汰最旧的,并带 `retired: true` 从实时面板移除。归档中的 `process` 事件不删除。 |
| 观察会话 | 无 viewer、无租约的观察在 `ABSENCE_ARCHIVE_SILENCE_MS`(默认 30 分钟)后归档;有租约的按 `ABSENCE_LEASE_SILENCE_MS`(默认 2 小时)。正在回填或有 viewer 连接的会话跳过。 |

文件版本与 run 事件分开存储,因此 Agent Folder 与 File History 无需加载某个 run 即可工作。写入或编辑追加一个完整版本。连续读取累积成一个部分 v0 版本。读取未报告行范围时,Absence 会尝试用磁盘核实一个:把返回文本定位到文件里,精确且唯一的匹配即得出该次读取的行坐标。匹配有歧义、文件缺失或读取已过期时,版本保留 `rangeKnown=false`,界面将范围显示为 unknown。

## 6. Web 渲染层

客户端使用 React 19、Vite、Tailwind 与 Zustand。`useMonitorData` 在每个渲染周期为选中的 run 派生 Activity 行、`RunFacts`、完成态 `RunReport`、实时注意力与实时 headline。Chart face 与 Monitor face 消费同一份派生结果。

face:

| face | 内容 |
|---|---|
| Rounds | 桌面场景:角色、故事卡片,以及 Files、Agent Folder、Agent Eggs、Run、Activity 的 dock 窗口。 |
| Monitor | 三列:Activity/Files/Attention 信息流、中央 Stage,以及 Agent Head/Usage/Agent Eggs/Agent Folder。 |
| Chart | 整页 Absence Report:结论、KPI、时间线、Changes、Executions、Knows、Tool calls、Errors、Attention 与证据预览。 |
| Drip | 独立于 face 切换器的浮层卡片:run 运行中显示实时事件,结束后显示最终回复。 |

`ViewMode` 为 `rounds | monitor | chart | drip`;切换器暴露前三个。Drip 作为开关存储。默认 face 是 Monitor;未知或过期的存储值解析为 Monitor。

Stage 行为:

- `SessionStore.applyToState` 决定哪条事件拥有 Stage。`message` 清空 Stage 并把 agent 状态设为 `speaking`;`process` 不拥有 Stage。
- Web 客户端在 `apps/web/src/lib/events.ts` 与 `apps/web/src/components/stage/StageItemView.tsx` 中把事件转换成 file、diff、terminal、thought、speech、process 与 approval 卡片。
- Monitor 的 Stage 有 `METRICS` 与 `CHAT` 两个页面标签,外加 pinned 的活动视图。Activity 卡片按 follow、pin 或 replay 状态显示。Stage 不提供 `FILE`、`DIFF` 或 `TERMINAL` 标签条。
- `activityViews.ts` 从一个 pinned 事件派生 file、diff 与 terminal 视图。

Absence Report 完全由 Web 端的 `apps/web/src/lib/report.ts` 计算,输入是一个 run 的事件切片(`run.fromIndex` 到 `run.toIndex`)。它是确定性归约,不调用模型,不解析命令语义。命令文本仅用于把 `tool_start` 与 `tool_end` 配对。缺失退出码记为 `exitCodeKnown=false`。

## 7. 回放

回放由 run 事件与周期快照重建。

- 每 25 个事件或每 5 秒做一次快照,以先到者为准。
- 快照保存事件索引、时间戳、文件 map、agent 状态与当前 Stage 动作。
- 文件重建:`file_write` 覆盖文件;`file_edit` 应用 `after`;`file_read` 只在路径仍未知时作为初始内容;`file_change deleted` 删除路径。
- `seek` 选择时间戳不晚于目标时间的最近快照,再应用余下事件到目标时间。
- 播放按 80 ms tick 推进。速度选项为 `0.25 / 0.5 / 1 / 2 / 5 / 10`。到 run 末尾自动暂停。
- Monitor Stage 底部时间线有 Model(模型的思考与发言)、Tools(工具调用,含 MCP)、Shell(命令执行)三条独立轨道,点击即 seek。Rounds 的故事卡片与 Monitor 的 feed 行点击时同样 seek。

回放范围:

| 重建 | 不重建 |
|---|---|
| 文件内容、agent 状态、当前 Stage 动作。 | 指标曲线、Agent Eggs 面板、容器状态。 |

指标与 egg 是独立的实时视图。本版本没有终端字节流。

## 8. 进程观察

内核观察器在 server 进程内创建一次,早于任何会话存在。Windows 使用 `native/agentwatch` 把 server 进程放入 Job Object,并报告后代进程的创建与退出。Linux 使用 `native/agentwatch-linux` 的 eBPF tracepoint,需要 `CAP_BPF`/`CAP_PERFMON` 或 root。

助手不可用,或根进程不在 Job Object 内时,`ProcessWatcher` 退化为进程表快照。Windows 优先使用 `agentwatch table` 命令(Toolhelp 遍历,约几十毫秒),helper 不在时才退到 PowerShell `Get-CimInstance Win32_Process`;其他平台使用 `ps`。采样下限约为 0.5 秒,指标精度标记为 `sampled`。来自已持有句柄的内核数值标记为 `exact`。

归因:

- 驱动会话的 projector 在出现 `kind=execute` 的 `tool_call` 时开启命令窗口,在终态更新时关闭。内核事件按祖先链认领;命令窗口决定事件属于哪条命令。
- 上报的进程是子树根。后代计入 `children`,不单独成为 egg。
- 父链断裂或父 pid 未知的孤儿进程不被认领。
- 观察会话的转录工具调用只在事实年轻于十秒时开启命令窗口;回填的历史命令不归因当前进程、文件或容器。
- 仅 OS 的会话只采样绑定到的进程子树,不把其他进程归到自己名下。

分类(`classify.ts`)按以下顺序判定:活过命令、有子进程、被命令点名、被后台化并重定向、来自工具安装目录、从工作区运行、生命周期短于 300 ms、名字命中短命工具先验且年龄小于 2 秒,其余为未分类。primary 进程成为 Agent Eggs;helper 折叠为计数与名字摘要。

Docker 容器运行在 daemon VM 内,Job Object 与 eBPF 都无法触及。非 Windows 主机上 `DockerMonitor` 从 `docker events` 读取生命周期,从 `docker stats` 读取资源。在命令窗口内启动的容器以合成 pid(≥1,000,000,000)成为 egg;窗口外启动的容器不归因。

**Windows 不捕获 Docker 容器。** `DockerMonitor` 被禁用,不探测 Docker 或 WSL daemon,`ABSENCE_DOCKER=1` 也不会启用。转录中的 Docker 命令仍作为普通命令事实保留。

## 9. 桌面打包

`apps/desktop` 是 Electron 壳,使用 Electron 37 与 electron-builder。`main.cjs` 在同一进程内启动 server,因此应用只有一套生命周期,也不会产生额外的控制台窗口。源码目录通过 `tsx` 加载 server;打包版本加载 `apps/server-bundle.cjs`。

打包阶段装入打包后的 server、它的运行时 `node_modules`、`dist/web` 中的 web 构建与一个启动脚本。Windows 包加入 `native/agentwatch/agentwatch.exe`;Linux 包加入 `native/agentwatch-linux/agentwatch-linux`。web 构建与浏览器使用的构建相同。

Electron 必须捆绑 Node 22.19 或更高版本,因为 server 使用 `node:sqlite`。仓库通过 `engines` 与 `.nvmrc` 固定 Node 版本。

Drip 在桌面壳中作为独立的透明置顶窗口打开。在浏览器构建中,它使用 Document Picture-in-Picture。

## 10. 边界

- ACP 的上报义务为 `SHOULD`;协议不要求 `MUST`。`kind` 缺失时变成 `other`;`locations` 缺失时读取范围标记为 unknown,除非返回文本与磁盘文件精确且唯一地匹配。Absence 不猜测缺失字段。
- `kind` 缺失或无法使用的工具调用走 `ToolRules` 的字段形状规则。部分工具载荷无法按形状归类。
- 并发命令的命令行不匹配时,进程归因可能出错。兜底策略保留该进程,不丢弃。
- 快照模式可能漏掉短命进程。
- Codex 的 Windows 沙箱是否把子进程留在 Job Object 内取决于 agent 实现。Absence 不对这一点作断言。
