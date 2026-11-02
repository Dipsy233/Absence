# 解耦：Absence 只做观察与转发

> 分支 `acp2`。P0–P6 落地后的最终形态：一个 ACP 客户端 + 一个观察器，
> 没有第二种驱动路径。

## 一句话

**Agent 的接口由 agent 自己的终端软件提供。Absence 启动它、用 ACP 和它对话、
把发生的事投影成事件；不读它的配置，不接管它的 shell，不实现它的 `/` 命令。**

```
                  ┌───────────────────────────────┐
  Browser ──WS──▶ │ Absence Server                │
                  │  SessionStore                 │
                  │    ├─ AcpAdapter ── ACP ──────┼──▶ 任意 ACP agent 进程
                  │    ├─ ProcessWatcher（OS）     │      (pi-acp / codex-acp /
                  │    └─ FileWatcher（OS）        │       claude-code-acp / dsh / …)
                  └───────────────────────────────┘
```

## 三层事件模型

```
Layer 0  OS 事实流 —— 必需，零耦合，永远可用
         进程出现/退出、文件创建/修改/删除
         来源：ProcessWatcher（Job Object / eBPF）、FileWatcher
         精度标注：exact（内核事件）/ sampled（轮询）

Layer 1  终端流量镜像 —— 低耦合，通用
         agent 进程写出的原始 stdout/stderr 字节流（pty 旁路），不解析内容

Layer 2  ACP 语义事件 —— 可选，协议层
         tool_start / file_read / mcp / thinking / approval …
         来源：AcpAdapter 的 MonitorEvent 投影
```

**核心不变量：Layer 2 缺失时，Stage 依然可用、依然好看。**

## 唯一驱动路径

1. `AgentCatalog` 从数据里解析出一个 profile（`~/.absence/agents.json` →
   shipped data → ACP registry 缓存），启动命令就是 profile 的 launch line。
2. `AcpAdapter` 起进程、`initialize`、`session/new`（或在 agent 声明
   `resume`/`load` 时恢复）、`session/prompt`、`session/cancel`、`session/close`。
3. `AcpToolMapper` / `ToolRules` 把 ACP 的 `tool_call` 按 **kind 和形状**
   投影成 AbsenceEvent；`ToolRules` 只认字段形状和内容类型，不认标题或产品名。
4. 审批是 `session/request_permission` → UI 的 `approval` 事件 →
   `respondPermission` 把用户选中的 option id **原样**回传。没有自动决策。

没有 `PiAdapter`、`CodexAdapter`、`DshAdapter`，也没有 `ABSENCE_LEGACY_*`
开关；没有永久回退路径。

## `/` 命令：删功能，不删入口

`/model`、`/skill`、`/skill:<name>`、`/mcp` 以及 agent 自己 advertise 的
任何命令，都不再由 Absence 解析：

- 输入框照常接受 `/` 开头的行；
- 命令面板只做补全：列出 agent `available_commands_update` 里的命令，
  再加上 Absence 唯一的本地动作 `/auth`；
- 回车后整行文本作为 prompt 发给 agent，由它决定认不认；
- 服务端 `SessionStore.forwardCommand(text)` 只有一行：
  `this.prompt(text)`。`/auth` 走 ACP 的 `authenticate`。

因此 agent 新增/改名命令时，Absence 不需要改代码，也不会“吃掉”一条它不认识的
斜杠命令。

## 审批

- UI 展示 agent 给出的 options；
- 用户的选择经 `respondPermission` 逐字转成 ACP outcome；
- `approvalAutomatic` 之类只可能是 UI 偏好，服务端不替用户决策。

## observe 模式不受影响

`absence watch` 不连 agent、不建 adapter：

- `ProcessWatcher` 以被观察 pid 为根，只报告它新起的子树；
- `FileWatcher` 观察项目目录；
- 如果找到 agent 自己的 transcript，就把它记录的 tool call 变成事件
  （这是观察能力，不是驱动能力）。

把 `apps/server/src/agents/` 整个目录删掉，`absence watch` 仍然能用。

## 删掉了什么

| 模块 | 原职责 |
|---|---|
| `agents/PiAdapter.ts` | 进程内加载 Pi SDK，接管其 shell |
| `agents/CodexAdapter.ts` `AppServerClient.ts` `CodexCommands.ts` `CodexBin.ts` | 驱动 `codex app-server` 私有协议 |
| `agents/DshAdapter.ts` `DshClient.ts` | DSH 专用 ACP 客户端（已泛化为 `AcpConnection`） |
| `agents/PiBin.ts` | 定位 Pi SDK |
| `process/AbsenceShell.ts` | 包装 Pi 的 bash/powershell 操作 |
| `process/ExecServer.ts` `CodexShell.ts` `ShellEnvironment.ts` | Codex exec-server 接管、env_policy、去壳 |
| `capabilities/discover.ts` `manage.ts` `piResources.ts` | 读写 agent 的 mcp.json / skills / config.toml |
| `api/sessions.ts` 的 Pi session-file 合并 | 读 Pi 私有会话文件补历史 |

`process/CodexShell.ts` 里通用的 shell 去壳逻辑保留为
`process/CommandLine.ts`：观察器靠它把 `bash -lc "…"` 还原成模型真正执行的命令，
这是 Layer 0 的显示质量，不是产品耦合。

## 判断标准

1. `apps/server/src` 里没有 `pi` / `codex` / `dsh` 的**名字分支**；
   `profiles.ts` 的数据除外。
2. 没有 `@earendil-works/pi-coding-agent` 的 import。
3. ACP 层不出现 `codex app-server`。
4. 历史只来自 Absence 自己的归档；resume 用归档里的 ACP handle。
5. 把 `agents/` 删掉，`absence watch` 仍可用。

## 检查

`check-acp` / `check-acp-lifecycle` / `check-acp-transport` /
`check-acp-mapping` / `check-acp-proxy` / `check-agent-catalog` /
`check:mock-agent` / `check:observer` 覆盖上面每一条。
