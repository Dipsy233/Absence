# 架构

Absence 内部实现的深入文档。定位与用法见 [README](../README.md)；agent 接入的
细节见 [AGENT_SUPPORT.md](AGENT_SUPPORT.md)；这条解耦路线的来龙去脉见
[decoupling.md](decoupling.md) 与 [reference/r.txt](reference/r.txt)。

> 文档语言：自 v0.5.0 起本文以中文为准（原先的 `ARCHITECTURE.zh-CN.md`
> 已合并删除）。

## 一句话

**Agent 的接口由 agent 自己的终端软件提供。Absence 不给 agent 提供接口、不处理
agent 的请求：它启动 agent、用标准 ACP 协议与它对话、把发生的事投影成事件并
归档。不读它的配置（只读探测除外），不接管它的 shell，不实现它的 `/` 命令。**

```
                  ┌───────────────────────────────┐
  Browser ──WS──▶ │ Absence Server                │
                  │  SessionStore                 │
                  │    ├─ AcpAdapter ── ACP ──────┼──▶ 任意 ACP agent 进程
                  │    ├─ ProcessWatcher（OS）     │      (pi-acp / codex-acp /
                  │    └─ FileWatcher（OS）        │       claude-code-acp / dsh / …)
                  └───────────────────────────────┘
```

## 分层

### 1. 启动层 —— `agents/acp/AgentCatalog.ts` + `profiles.ts`

- profile 是**数据不是代码**：launch line、发现规则、只读探测位置、认证提示。
  新增一个 agent = 加一行数据，不是加一个 adapter 类。
- 发现顺序（回答"这台机器装了什么"）：
  1. 显式 launch line：`~/.absence/agents.json`（自定义条目或覆盖）、旧版
     `~/.absence/runtimes.json`（只读兼容）、`ABSENCE_*_BIN` 环境变量；
  2. 已安装的 ACP 入口：PATH 上的可执行文件（`pi-acp`、`codex-acp`……）或项目
     `node_modules` 里的适配器包（`dist/index.js`）；
  3. 只有 agent CLI：该行标记 `needs-adapter`，**不**自动退到 npx；
  4. `npx` 仅在用户显式允许时（`ABSENCE_ALLOW_NPX=1` 或 agents.json 里
     `"allowNpx": true`），并在 UI 标注为临时下载。
- Absence 从不替用户安装任何东西。

### 2. 传输层 —— `agents/acp/AcpConnection.ts` + `protocol/**` + `proxy/**`

- stdio + NDJSON JSON-RPC 的通用 ACP client transport，不绑定任何具体 agent。
- 握手：`initialize({ protocolVersion, clientCapabilities })`。**不声明**
  `fs.readTextFile/writeTextFile` 与 `terminal` 能力——agent 自己读写文件、自己
  跑命令，执行路径与用户在终端里直接用完全一致。
- `session/new` 传 `mcpServers: []`：agent 照常读自己的 MCP 配置。
- `proxy/**` 是透明代理模式：插在外部 ACP client 与 agent 之间原样转发字节，
  同时旁听进同一条事件流。

### 3. 会话兼容层 —— `AcpAdapter` / `AcpSession` / `AcpAuth` / `AcpPermissionBridge` / `AcpConfigOptions`

- 能力门控生命周期：`session/resume`、`session/load`、`session/close` 只在
  `initialize` 声明了对应能力时才发送；prompt block 按声明的
  `promptCapabilities` 裁剪。
- 取消顺序：`cancel` 先把所有挂起的 permission 答成 `cancelled`，再发
  `session/cancel`；agent 不理会时由看门狗了结回合（约 10s），并把"被强制了结"
  如实报成错误，而不是悄悄吞掉。
- 审批：`session/request_permission` → UI 的 `approval` 事件 →
  `respondPermission` 把用户选中的 option id **原样**回传。没有自动决策路径。
- 认证：`initialize` 返回的 `authMethods` 展示给用户；`/auth <methodId>` 调 ACP
  的 `authenticate`。登录态由 agent 自己处理。
- **遗留兼容壳**：`agents/AgentAdapter.ts`（`AgentAdapter` 接口、`BaseAdapter`、
  `toAgentSessionPort` shim）在 v0.5.0 仍然保留——`AcpAdapter` 与 `MockAdapter`
  经由它接入 `SessionStore`。它没有新增调用方，计划下一版移除；`toAgentSessionPort`
  目前没有任何生产调用方。这是刻意的过渡态，不是"漏删"。

### 4. 投影层 —— `monitor/projector.ts` + `AcpToolMapper` + `ToolRules`

- 只投影，从不向 agent 要东西、从不补协议没发的字段。
- `tool_call` 按 **`kind` 和载荷形状** 投影成 `AbsenceEvent`：`ToolRules` /
  `toolRules.json` 是数据表，只认字段形状（有没有 `command`、`old_string` …），
  **不认工具标题，不按产品名分支**。
- 每条事件带 `source`（`acp` / `os` / …）与 `fidelity`：
  `exact`（协议原样携带）/ `reported`（agent 自报未核实）/
  `inferred`（Absence 由协议字段推出的显示兜底）/ `unknown`（协议没发，明说未知，
  不猜）。
- 生命周期保真：一个 tool call 恰好一条 `tool_start`、一条 `tool_end`，重复的终态
  更新被忽略；不存在的行号范围不会从内容行数里"发明"出来。

### 5. 会话归档 —— `sessions/SessionStore.ts` + `sessions/storage/**`

- 历史**只来自 Absence 自己的归档**（SQLite，`~/.absence/absence.db`，
  `ABSENCE_STATE_DIR` 可改根目录）。不读、不合并任何 agent 的私有会话文件。
- agent 的不透明 ACP resume handle 随归档一起存（历史列名 `piSessionFile` /
  `piSessionId`，兼容保留，见字段注释），重开会话时凭 `absenceSessionId` 即可
  恢复 agent 侧上下文。
- 事件分页读取：`GET /api/sessions/:id/events?before=&limit=`、
  `/runs/:index/events`；归档删除与保留策略（`ABSENCE_SESSION_RETENTION_DAYS` /
  `ABSENCE_MAX_ARCHIVED_SESSIONS`，默认全保留）。
- 旧 JSONL 归档（`~/.absence/sessions/`）首次启动时一次性导入 SQLite。

### 6. UI —— `apps/web`

- React + Vite + Tailwind + Zustand。UI 只懂 `AbsenceEvent` 一个词表，永远不知道
  事件是哪个 agent 产的。
- **探测式选择器**：项目/agent 选择器渲染的是 `GET /api/runtimes` 的探测行
  （状态 `可启动/缺适配器/需登录`、来源、发现的入口、声明的模型、适配器安装
  提示），方格布局，最后一个格子永远是 **"+"** 自定义 ACP 入口（写入
  `~/.absence/agents.json`）。未安装的 agent 不占格子。
- **提示流**：选中 agent 的事实（认证状态、模型来源、launch 覆盖等）以与其他
  提示同级的 note 形式流入，而不是弹窗或硬编码分支。
- **命令面板是补全器**：只列 agent 经 `available_commands_update` 广告的命令 +
  Absence 唯一的本地动作 `/auth`；回车后整行作为 prompt 原文转发。
- 其余面孔（Stage / Replay / Report / Eggs / Metrics / Agent Folder）不变，它们是
  同一事件流的不同归约。

## 只转发原则

| 功能 | 谁负责 |
|---|---|
| `/model`、`/skill`、`/mcp`、`/compact` 等 `/` 命令 | agent：整行原文进 `session/prompt`；Absence 不解析不实现 |
| `/auth <methodId>` | Absence：ACP `authenticate`，唯一的本地动作 |
| 模型 / thinking 档位 / mode 切换 | agent 的 `configOptions`，UI 按 schema 画选择器，`session/set_config_option` 回写 |
| 审批 | agent 问，用户答，`respondPermission` 原样回传 |
| 登录 | agent 的 `authMethods` + `authenticate` |
| MCP / skill 配置 | agent 自己（它的 `/` 命令或它自己的 CLI）；Absence 不碰 |

`SessionStore.forwardCommand(text)` 的实现就是一行 `this.prompt(text)`。
服务端没有任何按命令名分支的逻辑（`/auth` 除外）。

## 只读配置策略

- `AgentCatalog` 的 `inspect` 只读探测 agent 自己的配置目录（`~/.pi/agent`、
  `~/.codex`、`~/.claude`），用于 picker 里显示"已声明模型"与"凭据存在性"。
  **从不写入、从不修复、从不迁移**；读不到就是 `unknown`，不是猜。
- Absence 自己持久化的只有两类文件，都在 `~/.absence/`：**自己的**归档
  （SQLite）与**自己的**启动覆盖（`agents.json` / `runtimes.json`）。
- 已知例外（既有行为，记为限制）：头像皮肤 / 提示音 / egg 过滤器写在
  `apps/server/src/process/` 下的安装目录里（`avatar-skins/`、`sound-sets/`、
  `egg-filters/`）。打包成只读 asar 后上传会失败——这是 Absence 自己的数据，
  与 agent 配置无关，但存放位置待下一版迁到 `~/.absence/`。

## 边界与已知保真度限制

- **ACP 的报告义务是 SHOULD 不是 MUST**：`kind` 缺省为 `other`，`locations`
  只是 display metadata。"agent 看到的精确行段"在 agent 不报时只能标
  `unknown`，Absence 不补。
- **`kind=other` 的归类**靠通用形状规则兜底，个别 agent 的怪形状可能归类不到。
- **进程归因**：`kind=execute` 的 pending→completed 窗口 + 命令行匹配。单条
  命令精确；多条并发且命令行对不上时偶尔归错（落入兜底归因，不丢）。
- **Docker 容器**在 daemon VM 里，Job Object / eBPF 都够不到，走
  `docker events` + `docker stats` 的守护进程报告。
- **MCP 显示**：`mcp__<server>__<tool>` 命名约定能拆开就显示成
  `MCP server › tool`；没有的 agent 只能显示成普通工具调用。
- **Codex Windows 沙箱**的子进程是否逃出 Job Object 取决于 agent 实现，以实测为准。
- `ProcessWatcher.noteMarker`：仅为内核验收检查（check-agentwatch /
  check-docker*）服务，生产代码不调用（详见 [TESTING.md](TESTING.md)）。

## 三层事件模型

```
Layer 0  OS 事实流 —— 必需，零耦合，永远可用
         进程出现/退出、文件创建/修改/删除
         来源：ProcessWatcher（Job Object / eBPF / 采样兜底）、FileWatcher
Layer 1  终端流量镜像 —— 低耦合，通用（pty 旁路字节流，不解析）
Layer 2  ACP 语义事件 —— 可选，协议层
         tool_start / file_read / mcp / thinking / approval …
```

**核心不变量：Layer 2 缺失时 Stage 依然可用。**

`absence watch`（observe 模式）不连 agent、不建 adapter：删掉
`apps/server/src/agents/` 整个目录后它仍然可用（`check:observer` 钉住这条）。

## AbsenceEvent

跨 WebSocket 的只有这一个事件union：

```ts
type AbsenceEventType =
  | "agent_start" | "agent_end" | "message"   | "thinking"
  | "tool_start"  | "tool_update" | "tool_end"
  | "file_read"   | "file_write"  | "file_edit" | "file_change"
  | "command"     | "search"      | "process"   | "approval" | "mcp" | "error";
```

模型、上下文用量、agent 广告的命令与认证方法走独立的 `session_state` 消息，
不进事件流。

## HTTP / WS API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/projects` | 列出项目根下的项目（`?root=` 覆盖） |
| `GET` | `/api/sessions/history` | 归档会话列表（仅 Absence 归档），支持 `path/search/runtime/since/until` 过滤与 `limit/cursor` 分页 |
| `POST` | `/api/sessions` | `{ projectPath, agent?, resume? }` 新建或重开会话 |
| `POST` | `/api/sessions/observe` | observe 模式：观察一个已有进程 |
| `GET` | `/api/sessions/:id` | 会话快照（会话、文件、聊天、文件树、run 摘要、最新事件尾） |
| `GET` | `/api/sessions/:id/events?before=&limit=` | 归档事件分页（`{ events, nextBefore, hasMore }`） |
| `GET` | `/api/sessions/:id/runs` · `/runs/:index` · `/runs/:index/events` | History 的 run 摘要与单 run 事件 |
| `GET` | `/api/sessions/:id/file-versions` · `/file-versions/index` · `/file-versions/content` | 文件版本索引与内容 |
| `GET` | `/api/sessions/:id/file?path=` | 读项目文件（拒绝项目外路径，512KB 上限） |
| `POST` | `/api/sessions/:id/prompt` | `{ prompt }` 发给 agent |
| `POST` | `/api/sessions/:id/abort` | 中断当前 run |
| `POST` | `/api/sessions/:id/approval` | 回答审批（原样回传 option id） |
| `POST` | `/api/sessions/:id/command` | `{ text }` 原文转发；`{ name: "auth", args }` 走 ACP `authenticate` |
| `POST` | `/api/sessions/:id/close` · `DELETE /api/sessions/:id` · `DELETE /api/sessions/:id/archive` | 结束会话 / 释放 / 删归档 |
| `GET`/`POST` | `/api/runtimes` | 探测式选择器的行数据；保存 launch 覆盖与 `allowNpx` |
| `GET`/`POST`/`DELETE` | `/api/agents/…` | 自定义 ACP 入口（agents.json）增删查 |
| `GET` | `/api/sessions/:id/metrics` 等 | 进程指标（见 `api/metrics.ts`） |
| `WS` | `/ws/sessions/:id` | `{type:"snapshot"}` 后推 `{type:"event"}` / `{type:"session_state"}` |

v0.5.0 删除了 `GET /api/sessions/:id/commands/:name/options`（命令选项由 agent 的
`configOptions` / `available_commands_update` 承载）。

## 桌面壳

Electron 壳（`apps/desktop/`，非 workspace）把同一 server 跑在进程内、加载同一份
web 构建。Electron 必须捆绑 Node ≥ 22.19（`node:sqlite`、部分 ACP agent 的
`engines`）；当前 Electron 37.x 捆绑 Node 22.21.1。打包脚本
（`bundle-server.mjs` / `stage-desktop.mjs` / `make-icons.mjs`）见文件头注释。
