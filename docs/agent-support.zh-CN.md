# Agent 接入

[English](agent-support.md) | [简体中文](agent-support.zh-CN.md)

本文说明 Absence 如何观察每种支持的 agent、各通道能看到与看不到什么，以及通道如何配置。系统结构见 [architecture.zh-CN.md](architecture.zh-CN.md)，启动与选择目标见 [observation.zh-CN.md](observation.zh-CN.md)。

## 1. 通道与 agent

除代理通道外，Absence 不启动任何 agent，不发送提示词，也不应答权限请求。

| 通道 | agent | 内容 | 进程归因 |
|---|---|---|---|
| `transcript` | Pi | 消息、思考、工具调用与结果、文件写入与编辑、模型切换、用量、回合边界 | pi 可执行文件签名加绝对 `--session` 路径；默认 `pi` 按项目 `cwd` 与最后写入的转录绑定 |
| `acp-proxy` | 任意 ACP agent | 协议携带的全部内容，含审批与 MCP 调用 | 代理自己 spawn agent 并注入 `ABSENCE_SESSION_ID`，内核观察器精确报告 |
| `os` | 任意进程 | 进程、文件与资源；不含对话内容 | 用户选择的 pid 与启动时间，或进程表证明的绑定 |

三条通道都不适用的 agent 不可观察。除 pi 的格式外，Absence 不解析任何私有格式。

## 2. Pi 转录

### 2.1 来源

转录源定义在 `apps/server/src/observe/transcriptSources.ts`，当前只有一条 profile：

| 属性 | 值 |
|---|---|
| watch 根目录 | `~/.pi/agent/sessions` |
| 目录覆盖 | `PI_CODING_AGENT_DIR`，其后追加 `sessions` |
| 会话目录覆盖 | `PI_CODING_AGENT_SESSION_DIR`（优先于目录覆盖） |
| 测试覆盖 | `ABSENCE_OBSERVE_PI_ROOT` |
| 记录在会话上的 agent kind | `pi` |

只有位于源根目录内的 `.jsonl` 文件会被观察。

### 2.2 记录映射

解析器是 `apps/server/src/observe/parsers/pi.ts`。格式为 pi 自身的持久化格式，文档在 `docs.pi.dev/latest/session-format.md`；pi 开源，格式可审计。所有事实标记 `source: "transcript"`。

| pi 记录 | Absence 事件 | 保真度 |
|---|---|---|
| `session` header（`id`、`cwd`） | 无。提供外部身份与项目路径 | — |
| `message` 且 `role: "user"` | `message`（`role: user`） | `reported` |
| `message` 且 `role: "assistant"`，`text` 块 | `message`（`role: assistant`） | `reported` |
| `message` 且 `role: "assistant"`，`thinking` 块 | `thinking` | `reported` |
| `message` 且 `role: "assistant"`，`toolCall` 块 | `tool_start`，打点在生成结束时 | `reported` |
| `message` 且 `role: "toolResult"` | `tool_end` 与映射后的事实 | `reported` |
| `message` 且 `role: "assistant"`，`stopReason` ≠ `toolUse` | `agent_end`，有 token 数据时随后 `usage` | `inferred` / `reported` |
| `message` 且 `role: "assistant"`，回合首条记录 | `agent_start` | `inferred` |
| `model_change` | `message`（`role: system`），内容为模型名 | `reported` |
| `compaction`、`branch_summary`、`custom_message` | `message`（`role: system`），内容为摘要文本 | `reported` |
| `system` 消息、`usage`、`context_edit`、`label`、`custom`、`session_info`、`thinking_level_change` | 无 | — |

工具结果经共享的 `AcpToolMapper` 映射，因此转录产出的事实形状与 ACP 会话一致。`write` 与 `edit` 直接由参数映射，避免 mapper 的写入路径重复报告同一次写入；`edit` 见 2.4 节。

转录自己的时钟被如实带出，因为它们是“这次活动何时真正结束”的唯一记录：

| 记录字段 | 计时对象 | 落点 |
|---|---|---|
| `assistant.timestamp` | 生成**开始** | 该记录的事件起点 |
| `assistant.durationMs` | 生成耗时 | `thinking` / `message` 事件的 `endedAt`、每条 `tool_start` 的时间戳，以及 `agent_end` / `usage` 的时间戳 |
| `toolResult.timestamp` | 工具返回的时刻 | `tool_end` 的时间戳 |
| `toolResult.durationMs` | 工具自身的执行时长 | `tool_end.durationMs`；报告把命令放在 `timestamp - durationMs` |

一条 assistant 记录把一次思考、一次回复和它的工具调用标成同一次生成，因此没有时长的话，模型还在思考时 Shell 就已经在跑了。

### 2.3 回合边界

`stopReason` 取值为 `stop`、`toolUse`、`error`、`aborted`、`length`。`toolUse` 保持回合打开，其他值以 `agent_end` 关闭回合，时间戳取该记录**生成结束**的时刻而不是开始时刻。原因映射为 run 状态：`aborted` 为 `interrupted`，`error` 为 `error`，其余为 `completed`。

run 由用户消息打开。文件在回合中间开始时，首个 run 标记 `boundarySource: "attach"` 与 `truncatedBefore: true`，prompt 为空，不编造内容。

### 2.4 编辑

pi 的 edit 工具携带的是针对同一个文件的一组替换。这次调用是一次活动，因此只产生一条 `file_edit` 事件，绝不按替换逐条产出：逐条产出会让 feed 出现五行相同的记录，时间戳全部相同、且每行都把片段当成整文件。

调用仍然新鲜（实时尾随）时，会从磁盘按顺序重放每个替换来还原整文件的前后状态——工具已经写入结果时反向重放，尚未写入时正向重放——并携带 `fullContent: true`，会话的文件状态因此推进到真实内容。

较早的记录（回填）不做还原：今天的文件已不是那次编辑产出的文件。它同样只产出一条事件，携带上报的片段与合并后的 diff，标记 `fullContent: false`，不改动文件状态。

### 2.5 用量

每条 assistant 记录携带 `input`、`output`、`cacheRead`、`cacheWrite` 与 `reasoning`。回合结束时解析器发出一条 `usage` 事件，包含输出合计、context 占用最大值（`input + cacheRead + cacheWrite`）与模型名。数值来自转录，payload 标记 `estimated: true`。

### 2.6 树语义

pi 记录通过 `id`/`parentId` 构成树。解析器按文件顺序处理，即用户实际经历的次序；不回放分支。`context_edit` 改写模型视角，不应用。

### 2.7 降级

| 情况 | 行为 |
|---|---|
| 行不是 JSON | 计入 malformed，跳过 |
| `toolResult` 无匹配的 `toolCall` | 计入 orphan result，跳过 |
| 记录类型未知 | 静默跳过 |
| 文件缺失 | 行保留并标记 `missing`，不读取 |
| 文件超过 200 MiB | 从文件当前末尾开始观察 |

## 3. ACP 代理

### 3.1 启动代理会话

```bash
npx tsx apps/server/src/cli.ts proxy --project /path/to/project --label pi-acp -- pi-acp
```

客户端的 stdin/stdout 承载 ACP JSON-RPC 流，Absence 自身的信息只写 stderr。也可以通过 HTTP 启动代理会话，返回一个 localhost 端点供客户端连接：

```text
POST /api/acp-proxy/sessions
{ "command": ["pi-acp"], "cwd": "/path/to/project", "label": "pi-acp" }
```

`GET /api/acp-proxy/sessions` 列出代理会话；`DELETE /api/acp-proxy/sessions/:id` 关闭一个。

### 3.2 转发与旁听

代理先把每一行原样转发，再解析。tap 读取已解析的消息，发布标记 `source: "acp-proxy"` 的 `MonitorEvent`，从不向任一传输写入。非 JSON 行记为诊断；始终未获应答的权限请求被记录，而不是代为应答。

### 3.3 会话持久化

观察启用时，代理通过 `SessionStore.createObserved` 创建 channel 为 `acp-proxy` 的观察会话。agent 进程收到指向该会话的 `ABSENCE_SESSION_ID`，内核观察器因此精确归因其进程。会话创建失败时，代理继续转发并记录诊断。

### 3.4 投影

`apps/server/src/monitor/projector.ts` 投影 ACP `session/update` 消息：

| `sessionUpdate` | 结果 |
|---|---|
| `agent_message_chunk` | `message`（`role: assistant`，流式） |
| `agent_thought_chunk` | `thinking`（流式） |
| `tool_call` | `tool_start`；终态时 `tool_end` 与映射事实 |
| `tool_call_update` | 运行中节流的 `tool_update`；终态时 `tool_end` 与映射事实 |
| `plan` | `message`（`role: system`），内容为 plan entries 的 JSON |
| `current_mode_update` | `message`（`role: system`），内容为 mode id |
| `usage_update` | 不生成事件；更新 context 计数 |
| `config_option_update`、`available_commands_update`、`session_info_update` | 不生成事件；更新会话状态 |

客户端发来的 `session/prompt` 请求被投影为用户 `message` 并打开 run。agent 对该 prompt 的应答以最终消息与 `agent_end` 关闭 run，不编造用量。

### 3.5 工具映射

工具调用按 ACP `kind` 映射；`kind` 缺失或为 `other` 时按字段形状经 `ToolRules` 与 `toolRules.json` 判定。规则不按工具标题或产品名分支。

| 解析后的 kind | 事件 | 说明 |
|---|---|---|
| `read` | `file_read` | 路径来自 raw input、`locations` 或 diff 块；内容来自 ACP，或从磁盘读取（`source: os`、`fidelity: exact`）；行范围来自 `locations` 或 raw `offset`/`limit`，否则 `rangeKnown: false` |
| `edit` 且带内容、无旧内容 | `file_write` | 内容来自 raw `content` 或 `new_string`，或从磁盘读取 |
| `edit` 其他形状 | `file_edit` | `before`/`after` 来自 diff 块或 raw 值；无法重建文件时 `fullContent: false` |
| `delete` | `file_change`（`kind: deleted`） | |
| `move` | `file_change`（`kind: modified`） | |
| `execute` | `command` | 命令来自 `rawInput`，其次为仅用于展示的 ACP `title`；输出来自聚合输出、stdout/stderr、流式终端输出或 content；退出码来自上报字段，否则 `exitCodeKnown: false`；被拒绝时 `permissionDenied: true` |
| `search` | `search` | 有 query 时为 `grep`，否则为 `find`；输出截断至 4,000 字符 |
| `mcp__<server>__<tool>` | `mcp` | 无论 `kind` 都生成；结果截断至 20,000 字符 |
| `fetch`、`think`、`other` | 不生成映射事件 | 保留 `tool_start` 与 `tool_end`，不编造 payload |

一个工具调用恰好产生一条 `tool_start` 与一条 `tool_end`；重复的终态更新被忽略。每条 `tool_start` / `tool_update` / `tool_end` 原样携带 agent 的 `kind` 与 `title`，与用于展示的 `toolName` 并列。

改变文件的调用不会被丢弃。协议称 `edit` 但读不到内容时，从磁盘读取 post-state 记为 `file_write`（`source: os`）；磁盘也读不到时保留一条 `file_change`。空内容的写创建 0 字节文件，是真实的写。

### 3.6 审批

只有 `session/request_permission` 转为 `approval` 事件。事件携带 agent 提供的选项。应答发生在 agent 真正运行的地方——代理会话是编辑器客户端，其他情况是 agent 自己的终端界面——由后续事件记录应答结果。Web 客户端只读渲染该卡片。

### 3.7 命令窗口

`execute` 工具调用打开 `ProcessWatcher` 命令窗口，终态更新关闭它。窗口内上报的进程归因到该命令，由此产生命令级 Agent Eggs。窗口携带工具调用 id，`command` 事件与每条观察到的 `process` 事件都带同一个 `toolCallId`，feed 因此把一条命令与其进程合并为一行。

执行命令字符串的 shell（`bash -c "…"`、`pwsh -Command "…"`）就是命令本身，不成为 egg；它的子进程重新生根并按自身形态分类。命令留下的 daemon 会成为 egg。agent 有意启动的 shell（`bash daemon.sh`，无 `-c`）照常参与分类。

## 4. 仅 OS 观察

在观测台选择的进程打开 channel 为 `os` 的会话。会话采样其绑定的进程子树：进程、文件与资源，不含对话内容。

活动记为 `boundarySource: "activity-burst"` 的 run；无新事实 90 秒（`RUN_BURST_IDLE_MS`）后关闭该 burst；会话被回收时也会关闭未完成 burst，不再留下 `running` 行。若之后转录被证明属于同一 pid，转录折入同一会话，会话记录两个通道；run 索引同时从 burst 切回用户轮次，并重建已写入的行——它们此前按首个事件命名（`usage`、`tool_end`），而不是 prompt。

## 5. 转录与进程的绑定

Absence 只在有证据时把转录绑定到 pid：

| 证据 | 绑定 |
|---|---|
| pi 命令行点名转录（`--session <文件>`） | 绝对路径精确匹配 |
| 默认 `pi` 进程（无 `--session`） | 项目 `cwd` 必须等于转录 header 的 `cwd`，并与进程**最后写入**的文件配对：进程启动后新生的转录，或进程恢复的旧转录，都按最后写入时间竞争 |
| 任何歧义 | 不绑定：同一 cwd 的两个进程、两个同样新的文件，或任一方 cwd 未知，都不绑定 |

复用的 pid 是不同进程：身份是（pid，启动时间）对。

## 6. Windows 与 Docker

Windows 不捕获 Docker 容器。`DockerMonitor` 被禁用，不探测 Docker 或 WSL daemon，`ABSENCE_DOCKER=1` 也不会启用。转录中的 Docker 命令仍作为普通命令事实保留。

## 7. 开发 fixture

| fixture | 用途 |
|---|---|
| `scripts/mock-agent/agent.mjs` | 按 ACP 协议应答的脚本化 agent，不需要模型或凭据。`check:acp-proxy` 与检查中的代理路径使用它 |
| `apps/server/src/agents/MockAdapter.ts` | Absence 仍然驱动的唯一运行时；通过 `POST /api/sessions` 并指定 `agent: "mock"` 打开。`check:e2e` 使用它 |
| `scripts/checks/fixtures/` | 离线检查使用的转录与协议 fixture |

`scripts/mock-agent/run.ts` 仍通过已移除的 ACP profile 路径创建会话，在本构建上无法运行，因此 `npm run absence-sim` 不是可用的门禁。agent 层由 `npm run check:acp-all`（mapping 与 proxy）与 `npm run check:e2e` 覆盖。
