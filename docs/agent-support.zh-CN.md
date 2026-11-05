# Agent 接入（ACP）

[English](agent-support.md) | [简体中文](agent-support.zh-CN.md)

Absence 是 ACP client。本文描述 agent 如何出现在选择器中、Absence 如何启动并驱动它，以及 ACP 更新如何变成 `AbsenceEvent`。系统结构见 [architecture.zh-CN.md](architecture.zh-CN.md)。

## 1. 唯一驱动路径

```text
AgentCatalog（profile 数据）
  → AcpAdapter（会话层）
  → AcpConnection（NDJSON JSON-RPC 传输）
  → ACP agent 进程
```

`AgentCatalog` 把一个 profile 解析成启动命令、就绪状态与可选的发现来源。`AcpAdapter` 启动进程并持有会话。`AcpConnection` 执行 `initialize`、`session/new` 或恢复、`session/prompt`、`session/cancel` 与 `session/close`。所有内置 agent 与自定义入口都使用这条路径。

`apps/server/src/agents/acp` 中没有按产品划分的 adapter 类。产品差异是 `profiles.ts` 中的数据与 `toolRules.json` 中的字段形状规则。`apps/server/src/agents/createAdapter.ts` 的 `createAdapter` 在 profile 为 ready 时返回 `AcpAdapter`，否则抛出 catalog 给出的就绪原因。非 ACP adapter 是检查使用的 `mock` fixture。

## 2. 发现顺序与回退

`AgentCatalog` 按以下顺序解析每个 profile，第一个命中项生效。

1. **显式 launch line**
   - `~/.absence/agents.json` 中的 `launch` 覆盖或自定义 `agents` 条目。
   - profile 的 `ABSENCE_*_BIN` 环境变量。
   - 旧版 `~/.absence/runtimes.json` 只读兼容，不写入。
2. **PATH 上的 ACP 可执行文件** — 依次解析 `discovery.acpBins`，例如 `pi-acp`、`codex-acp`。
3. **本地 `node_modules` 适配器** — 依次解析 `discovery.acpPackages`，入口默认 `dist/index.js`。搜索向上最多 5 层。
4. **agent CLI 自带 ACP 模式** — `discovery.cli` 加 `acpArgs`，例如 `gemini --acp`、`qwen --experimental-acp`、`dsh --profile acp`。
5. **npx 兜底** — 仅当 `ABSENCE_ALLOW_NPX=1` 或 `~/.absence/agents.json` 中 `allowNpx: true` 时启用。版本优先取 profile 的 `npxVersionEnv`，否则取 `npxVersion`。该行标注为临时下载。
6. **没有 ACP 入口** — agent CLI 存在但没有 ACP 入口时，状态为 `needs-adapter`；两者都不存在时，状态为 `unavailable`。

显式 launch line 优先于自动发现。显式命令找不到时，该行变为 `unavailable`，原因中给出命令。

选择器行为：

- `unavailable` 行与 `mock` fixture 不显示。
- `ready`、`needs-adapter` 与 `needs-auth` 行显示。
- 选择器没有 `allowNpx` 开关。该设置来自 `ABSENCE_ALLOW_NPX` 或 `agents.json` 的 `allowNpx` 字段；服务端 API 可以写入该字段，但选择器不暴露它。
- 选择器没有任意 profile 的 launch line 编辑控件。服务端 `POST /api/runtimes` 接受 launch 覆盖，但当前选择器不调用它。选择器中的编辑入口是自定义 ACP 表单，它写入一条 `agents` 条目。
- `npm run registry:sync` 把 ACP registry 写入 `~/.absence/registry.json`。服务端启动时不自动同步 registry。registry 条目通过 `npx`、`uvx` 或二进制启动；只有二进制存在或允许 npx 时才可启动。

## 3. 内置 profile

`apps/server/src/agents/acp/profiles.ts` 内置 7 条 profile。

| profile id | 产品 | 别名 | ACP 入口 / 启动方式 | 认证 | 覆盖变量 |
|---|---|---|---|---|---|
| `pi` | Pi | `pi-acp` | PATH `pi-acp`，本地包 `pi-acp`；只有 `pi` CLI 时为 `needs-adapter`；npx `pi-acp@0.0.34` | 不需要 | `ABSENCE_PI_ACP_BIN`；npx 版本 `ABSENCE_PI_ACP_VERSION` |
| `codex` | Codex | `codex-acp` | PATH `codex-acp`，本地包 `@zed-industries/codex-acp`；npx `@zed-industries/codex-acp@0.16.0` | 必须 | `ABSENCE_CODEX_ACP_BIN`；npx 版本 `ABSENCE_CODEX_ACP_VERSION` |
| `codex-acp-alt` | Codex，替代 ACP 包 | — | 无 PATH 二进制；本地包 `codex-acp`；显式路径、覆盖或 npx `codex-acp@1.11.0` | 必须 | `ABSENCE_CODEX_ACP_ALT_BIN`；npx 版本 `ABSENCE_CODEX_ACP_ALT_VERSION` |
| `dsh` | DSH（DeepSeek Harness） | — | CLI `dsh --profile <dshProfile>`；默认 profile 为 `acp` | 不需要 | `ABSENCE_DSH_BIN`、`ABSENCE_DSH_PROFILE`、`ABSENCE_DSH_HOME`、`ABSENCE_DSH_PROVIDER`、`ABSENCE_DSH_MODEL` |
| `claude-code` | Claude Code | — | PATH `claude-code-acp`，本地包 `@zed-industries/claude-code-acp`；只有 `claude` CLI 时为 `needs-adapter`；npx `@zed-industries/claude-code-acp` | 可选 | `ABSENCE_CLAUDE_ACP_BIN` |
| `qwen-code` | Qwen Code | — | CLI `qwen --experimental-acp` | 可选 | `ABSENCE_QWEN_ACP_BIN` |
| `gemini` | Gemini | `gemini-cli` | CLI `gemini --acp` | 可选 | `ABSENCE_GEMINI_ACP_BIN` |

profile 说明：

- `npxVersion` 只描述 npx 兜底。Absence 不固定已安装适配器的版本；已安装的包保持自身版本。
- Pi 本身不是 ACP server。`pi-acp` 是适配器；Absence 启动 PATH 或本地 `node_modules` 中已安装的 `pi-acp`。
- `codex-acp-alt` 对应替代 `codex-acp` 包，该包声明不同的会话能力。profile 未声明 PATH 二进制；其包名为 `codex-acp`，解析器的本地 `node_modules` 步骤适用。显式路径或覆盖也可以启动它。
- DSH profile 的说明提到已保存路径与 DSH Desktop 安装。当前解析器只实现 PATH、显式覆盖与 `ABSENCE_DSH_BIN`，不探测 DSH Desktop 安装目录。
- Claude Code 的 profile 从宿主环境转发 `ANTHROPIC_API_KEY` 与 `ANTHROPIC_BASE_URL`。Qwen Code 的 profile 从宿主环境转发 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 与 `OPENAI_MODEL`。

## 4. 就绪状态、认证与自定义入口

就绪状态：

| 状态 | 含义 |
|---|---|
| `ready` | 找到可执行的 ACP 入口。 |
| `needs-adapter` | agent CLI 存在，但没有 ACP 入口。该行带安装提示；Absence 不执行提示中的命令。 |
| `needs-auth` | 入口存在，但 profile 要求认证，且只读探测未找到凭据。 |
| `unavailable` | ACP 入口与 agent CLI 都不存在。该行在选择器中隐藏。 |

`finalize` 在 profile 的 `auth` 为 `required` 且探测结果为 `missing` 时，把 `ready` 改为 `needs-auth`。探测结果为 `unknown` 时保持 `ready`，并在状态原因中说明登录要求未知，直到 agent 给出答复。

认证状态来自对 agent 自身配置目录的只读探测：

| 状态 | 含义 |
|---|---|
| `configured` | 找到凭据文件或环境变量键。 |
| `missing` | 未找到凭据。 |
| `unknown` | 位置存在但无法读取，或该 agent 没有探测规则。 |
| `not-required` | profile 未声明认证要求。 |

探测位置：

| Agent | 目录 |
|---|---|
| Pi | `~/.pi/agent`，或 `PI_CODING_AGENT_DIR` |
| Codex | `~/.codex`，或 `CODEX_HOME` |
| Claude Code | `~/.claude`，或 `CLAUDE_CONFIG_DIR` |

探测检查文件是否存在以及声明的模型。它不读取凭据内容，不写入，也不修复或迁移 agent 配置。读取失败时结果为 `unknown`。

自定义 ACP 入口保存在 `~/.absence/agents.json`。catalog 目录默认为 `~/.absence`，可用 `ABSENCE_CATALOG_DIR` 改变；`agents.json` 与 `registry.json` 位于该目录。条目包含 `id`、`label`、`command`、`args`、`env` 与 `cwd`。服务端通过 `/api/agents` 下的 `GET`/`POST`/`PUT`/`DELETE` 提供 CRUD。任何会说 ACP 的可执行文件都可以这样接入，不需要修改代码。

## 5. 会话生命周期与能力门控

`AcpConnection.start()`：

1. 启动子进程，或使用传入的 transport。
2. 发送 `initialize`，携带 `protocolVersion: 1`、`clientInfo` 与 `clientCapabilities`。文件系统与终端能力默认为 false。
3. 检查协商版本。版本不为 1 时关闭连接。
4. 握手前的请求进入 FIFO 队列，握手后按序 flush。

协商的 ACP 协议版本恒为 1（`apps/server/src/agents/acp/protocol/version.ts` 中 `ACP_PROTOCOL_VERSION = 1`，`SUPPORTED_PROTOCOL_VERSIONS = [1]`）。

会话方法：

- `session/new` 发送 `{ cwd, mcpServers: [] }`。agent 读取自己的 MCP 配置。
- 恢复时，agent 声明 `session/resume` 则调用它，否则在声明时调用 `session/load`。两者都未声明时抛出 `AcpUnsupportedCapabilityError`，`AcpSession.open` 回退到 `session/new`。
- `session/close` 只在声明时发送，在管道销毁前 await，且可重复调用。
- prompt block 按声明的 `promptCapabilities` 裁剪。未声明的 image、audio 与 resource block 不发送。
- agent 发往 client 的 `fs/read_text_file`、`fs/write_text_file` 与 `terminal/*` 请求，因未声明对应能力而返回 JSON-RPC error。未知请求返回 `-32601`。
- `AcpAdapter.start` 在启动进程前调用 `processWatcher.beginSession(sessionId)`，使进程观察按会话过滤。

## 6. 事件投影

投影入口是 `apps/server/src/monitor/projector.ts` 中的 `AcpMonitorProjector.projectUpdate`。

| ACP `session/update.sessionUpdate` | 结果 |
|---|---|
| `agent_message_chunk` | `message` 事件，`role: assistant`，`streaming: true`，带 `delta`。`promptActive=false` 时收到的启动 chunk 被丢弃，避免把 `## Skills` 横幅当成说话回合。 |
| `agent_thought_chunk` | `thinking` 事件，`streaming: true`，带 `delta`。 |
| `tool_call` | 首次出现发出 `tool_start`；终态发出 `tool_end` 与映射事件。 |
| `tool_call_update` | 非终态发出节流的 `tool_update`；终态发出 `tool_end` 与映射事件。未见过 `tool_call` 时补一条 `source: reported` 的 `tool_start`。 |
| `plan` | `message`，`role: system`，内容为 plan entries 的 JSON。 |
| `current_mode_update` | `message`，`role: system`，内容为 mode id；缺失值标记 `unknown`。 |
| `usage_update` | 不生成事件。更新 `context.used/total`。 |
| `config_option_update` | 不生成事件。更新 `AcpConfigOptions`。 |
| `available_commands_update` | 不生成事件。更新命令补全列表。 |
| `session_info_update` | 不生成事件。记录标题。 |

工具调用映射依据 ACP `kind` 与字段形状。`kind` 缺失或为 `other` 时，由 `ToolRules` 与 `toolRules.json` 按字段形状判定。规则不按工具标题或产品名分支。

| 解析后的 kind | 事件 | 规则 |
|---|---|---|
| `read` | `file_read` | 路径来自 raw input、`locations` 或 diff block。内容来自 ACP content block；缺失时从磁盘读取，标记 `source: "os"`、`fidelity: "exact"`。行范围来自 `locations.line` 或 raw `offset`/`limit`，否则 `rangeKnown: false`。 |
| `edit` 且带 content、无旧内容 | `file_write` | 内容来自 raw `content` 或 `new_string`；缺失时从磁盘读取。 |
| `edit` 其他形状 | `file_edit` | `before`/`after` 来自 ACP diff block 或 raw 旧值/新值。可从磁盘重建完整文件；无法重建时 `fullContent: false`。 |
| `delete` | `file_change`，`kind: "deleted"` | 路径来自解析结果。 |
| `move` | `file_change`，`kind: "modified"` | 路径来自解析结果。 |
| `execute` | `command` | 命令优先级：`rawInput` 的命令字段，然后当调用为 `execute` 且 `rawInput` 无命令时使用 ACP `title`（仅展示兜底，不参与分类）。输出优先级：`rawOutput.aggregatedOutput`，然后 `rawOutput.stdout`/`stderr`，然后流式的 `_meta.terminal_output.data`，然后累积的 `content` chunk。退出码优先级：`rawOutput.exitCode`/`exit_code`/`code`，然后嵌套对象，然后 `_meta.terminal_exit`。缺失时 `exitCodeKnown: false`。被拒绝时 `permissionDenied: true`。terminal block 作为 `terminalId` 原样携带。 |
| `search` | `search` | 有 query 时 tool 为 `grep`，否则为 `find`。matches 为非空行数。输出截断至 4,000 字符。 |
| `mcp__<server>__<tool>` | `mcp` | 无论 `kind` 都生成，携带 args、result、structured 与 `isError`。result 截断至 20,000 字符。 |
| `fetch`、`think`、`other` | 不生成映射事件 | 只保留 `tool_start` 与 `tool_end`。不编造 payload。 |

`tool_end` 的 `isError` 来自 `status === "failed"`。一个工具调用恰好产生一条 `tool_start` 与一条 `tool_end`；重复的终态更新被忽略。

`execute` 窗口同时驱动进程归因。projector 在出现 `execute` 工具调用时调用 `ProcessWatcher.begin(command, cwd, toolCallId)`，在终态调用 `end`。该窗口内上报的进程归因到这条命令，命令级的 Agent Eggs 由此产生。窗口携带 ACP 工具调用 id 作为 `ref`，`command` 事件与其观察到的每条 `process` 事件都以 `toolCallId` 携带同一个 id —— 这是 feed 把一条命令与它自己的进程折叠成一个动作行的关联键，避免每次子进程计数更新都多出一行 RUN 与命令行并列。

命令自身的执行器不是 egg。runtime 为执行命令字符串而启动的 shell（`bash -c "…"`、`pwsh -Command "…"`）就是 `command` 事件已经上报的那条命令；每条工具调用都产出一个 shell egg 会把 Agent Eggs 面板变成命令日志。它像被标记的 shell 一样保持 owned 以便后代归因，但绝不注册为父 egg：它的子进程重新生根、按自身形态判定——命令真正留下的 daemon 仍是 egg，沿路的 `ls`/`cat` 仍按 tool 分类。agent 有意启动的 shell（`bash daemon.sh`，无 `-c`）照常参与判定。

工具与文件事件同时是 assistant 消息的边界：`AcpAdapter` 在发布任何非流式事件前关闭打开中的思考*和*回复，因此工具调用两侧的文本是两条消息，各自带有自己的起始时间。

OS 观察者的事实就地标注：`process`、`file_change` 与派生的 `file_write`/`file_edit` 携带 `source: "os"`、`fidelity: "exact"`，而不是依赖 `unknown` 默认值。shell 写文件是一个动作而不是两个：当磁盘 diff 会从同一次变化派生内容事件时，原始 `file_change` 被标为 `echo: true`（Activity 隐藏它，Report 不重复计数）；`file_change kind: "modified"` 证明文件已存在，因此派生的写入是修改而不是新建。

## 7. 审批与 `/auth`

审批：

- 只有 `session/request_permission` 转为 `approval` 事件。
- `AcpPermissionBridge.request` 保留 agent 给出的选项。
- `respondPermission` 把用户选中的 `optionId` 原样作为 ACP outcome 回传。
- 选择拒绝类选项时记录 tool call id，映射事件带 `permissionDenied`。
- 取消回合先调用 `permissions.cancelAll()`，等待一帧以确保 JSON-RPC 响应写出，再调用 `session.cancelTurn()`。
- `session/cancel` 后，看门狗默认等待 10 秒（`ABSENCE_ACP_ABORT_TIMEOUT_MS`），超时后结算回合并报 `error`。
- 没有自动审批策略。服务端转发用户的选择。

认证：

- `initialize.authMethods` 提供 `/auth` 的选项。
- `/auth <methodId>` 调用 ACP `authenticate`，然后重开被阻塞的会话。
- Absence 不读取 token，不代填凭据，不代理 OAuth 流程。它只执行第 4 节描述的只读探测。
- 其他 `/…` 行作为 prompt 发送。`SessionStore.forwardCommand(text)` 的实现是 `this.prompt(text)`。命令面板合并 `available_commands_update` 广告的命令与本地 `/auth` 动作。

## 8. 无效的接入方式

按产品编写专用 adapter 作为通用接入策略无效：

- Codex adapter 驱动私有的 `codex app-server` 协议并拦截其 shell。DSH adapter 自带 ACP client。Pi adapter 在进程内加载 Pi SDK，并包装 Pi 的 bash 与 PowerShell 操作。
- 每种实现都需要自己的传输、命令规整与 shell 处理。私有协议不在 Absence 的控制范围内，产品每次变更都需要对应的 adapter 变更。同一套生命周期、权限与事件映射逻辑按产品重复实现，shell 接管又让 Absence 承担了属于 agent 的语义。
- ACP 路径用 profile 数据与一个通用连接替代这些实现。自带 ACP 入口的产品不需要 Absence 代码；没有 ACP 入口的产品需要适配器包，或一条自定义 `agents.json` 条目。

## 9. 开发辅助

- `npm run probe:acp -- <scenario>` 用脚本化 fixture agent 驱动采集管道，并打印每条 `AbsenceEvent`。用 `ABSENCE_ACP_BIN` 指向真实 agent。
- `npm run check:agent-catalog` 检查发现顺序、就绪状态、`+` 格子与 registry 行为。
- `scripts/acp-fixture/fake-agent.mjs` 是一个按真实 ACP 协议通信的脚本化 agent，不需要模型或凭据。`check:acp*` 检查与仿真以它为驱动对象。
</content>
</invoke>
</file_path>
</invoke>
