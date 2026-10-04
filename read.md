DAZE

«AI moves fast. Humans watch.

一个 Agent 工作可视化界面。

DAZE 不负责让 Agent 变聪明，只负责让人类看见 Agent 到底在干什么。»

---

1. 项目概述

1.1 项目名称

DAZE / 发呆症

中文名：发呆症
英文名：DAZE

DAZE 是一个面向 AI Agent 的实时工作可视化工具。

它不试图替代 IDE，也不是 Agent 管理平台、Workflow 平台或 Evaluation 平台。

DAZE 的核心体验是：

«坐在 Agent 旁边，看它工作。»

用户可以看到：

- Agent 当前正在做什么
- Agent 正在读取哪个文件
- Agent 读取了哪些代码
- Agent 修改了什么
- Agent 执行了什么命令
- Agent 当前 Plan
- Agent 的上下文使用情况
- Agent 当前状态
- Agent 与用户的对话

---

2. 产品理念

随着 Agent 能力提升，AI 的执行速度越来越快。

过去：

«人 → 写代码 → AI 辅助»

现在：

«人 → 给 Agent 一个任务 → Agent 自己连续工作»

问题也随之出现：

- 非专业用户不知道 Agent 到底在干什么
- 专业用户知道发生了什么，但 Agent 执行速度太快，看不过来
- 最终用户经常只是坐在电脑前，看着 Agent 输出，然后等待结果

DAZE 将这种体验直接产品化：

«你不用理解每一个动作。

你只需要坐下来，看它干活。»

因此 DAZE 的 UI 不应该像传统 Developer Dashboard。

它更接近：

«一个 Agent 的房间 / 工作桌 / 观察窗。»

---

3. v0.1 目标

v0.1 只验证一个核心闭环：

用户输入任务
      ↓
Agent 开始工作
      ↓
Agent 产生事件
      ↓
DAZE 捕获事件
      ↓
事件转换为统一格式
      ↓
实时推送给浏览器
      ↓
浏览器将事件视觉化

最终用户应该能够完成：

打开 DAZE
   ↓
选择项目
   ↓
启动 Agent
   ↓
输入任务
   ↓
Agent 开始工作
   ↓
看到文件读取
   ↓
看到 Terminal
   ↓
看到文件修改 Diff
   ↓
看到 Plan
   ↓
看到 Agent 状态变化
   ↓
Agent 完成任务

如果这个闭环完成，v0.1 即成功。

---

4. v0.1 明确不做

为了避免项目失控，以下功能全部不属于 v0.1。

Agent 能力

- 多 Agent
- Sub-agent
- Agent Workflow
- Agent DAG
- Agent 编排
- Agent Evaluation
- Agent Benchmark
- Agent 自动测试闭环

安全与治理

- Approval Gate
- Permission Gate
- 引用门禁
- Policy Engine
- Guardrail
- 企业权限
- 用户权限系统

数据

- 数据库存储
- 用户系统
- 云端 Session
- 项目同步
- 云端日志分析
- Analytics

AI 能力

- 自己实现 Agent Loop
- 自己实现 Tool Calling
- 自己实现 Context Management
- 自己实现 Compaction
- 自己实现 Retry
- 自己实现模型路由

UI

- Dashboard
- Metrics
- Token Analytics
- 多 Agent Dashboard
- Team Dashboard
- Workflow Editor

---

5. 核心架构

DAZE 不应该直接和 LLM API 强绑定。

第一版使用 Pi 作为 Agent Runtime。

整体架构：

                         DAZE
                          │
                          │
                 ┌────────▼────────┐
                 │   Daze Server   │
                 │                 │
                 │  Agent Adapter  │
                 └────────┬────────┘
                          │
                       Pi Adapter
                          │
                          ▼
                    ┌───────────┐
                    │    Pi     │
                    │           │
                    │ Agent     │
                    │ Tools     │
                    │ Files     │
                    │ Bash      │
                    │ LLM       │
                    └─────┬─────┘
                          │
                     Event Stream
                          │
                          ▼
                   Daze Event Bus
                          │
                 ┌────────┴────────┐
                 │                 │
              WebSocket         Event Log
                 │
                 ▼
              Browser
                 │
        ┌────────┼─────────┐
        ▼        ▼         ▼
      Files    Stage     Agent UI

---

6. 为什么使用 Pi

DAZE 不应该重新实现 Agent Runtime。

Pi 已经负责：

- LLM 请求
- Agent Loop
- Tool Calling
- 文件读取
- 文件修改
- Shell
- Session
- Context
- Streaming
- Tool execution

DAZE 只负责：

«观察。»

Pi 是：

Worker

DAZE 是：

Observer

---

7. Adapter 架构

DAZE 不应该把 Pi 写死在核心代码中。

定义：

Agent Runtime
      │
      ▼
Agent Adapter
      │
      ▼
Daze Event

未来可以支持：

Pi
 │
 ├── PiAdapter
 │
Codex
 │
 ├── CodexAdapter
 │
Custom Agent
 │
 └── CustomAdapter

核心 UI 永远只认识 "DazeEvent"。

---

8. Daze Event

DAZE 的核心数据结构。

export type DazeEvent = {
  id: string
  sessionId: string
  timestamp: number

  type:
    | "agent_start"
    | "agent_end"
    | "message"
    | "thinking"
    | "tool_start"
    | "tool_update"
    | "tool_end"
    | "file_read"
    | "file_write"
    | "file_edit"
    | "command"
    | "error"

  payload: unknown
}

第一版不要设计得过于复杂。

事件的意义是：

«描述“刚刚发生了什么”。»

---

9. 推荐事件格式

Agent Start

{
  type: "agent_start",

  payload: {
    model: "..."
  }
}

Agent End

{
  type: "agent_end",

  payload: {
    reason: "completed"
  }
}

File Read

{
  type: "file_read",

  payload: {
    path: "src/app.ts",
    startLine: 42,
    endLine: 87,
    content: "..."
  }
}

File Edit

{
  type: "file_edit",

  payload: {
    path: "src/app.ts",

    before: "...",

    after: "...",

    diff: "..."
  }
}

Command

{
  type: "command",

  payload: {
    command: "npm test",

    stdout: "...",

    stderr: "...",

    exitCode: 0
  }
}

Message

{
  type: "message",

  payload: {
    role: "assistant",
    content: "I'm checking the authentication flow."
  }
}

---

10. Event Bus

Server 内部建立一个非常简单的 Event Bus。

Pi
 ↓
Adapter
 ↓
DazeEvent
 ↓
EventBus
 ↓
WebSocket

伪代码：

class DazeEventBus {
  subscribers = new Set<(event: DazeEvent) => void>()

  emit(event: DazeEvent) {
    for (const subscriber of this.subscribers) {
      subscriber(event)
    }
  }

  subscribe(fn) {
    this.subscribers.add(fn)

    return () => {
      this.subscribers.delete(fn)
    }
  }
}

第一版不需要 Redis。

不需要 Kafka。

不需要消息队列。

不需要数据库。

---

11. Browser 通信

使用 WebSocket。

Browser
   │
   │ WebSocket
   ▼
Daze Server
   │
   ▼
Event Bus
   │
   ▼
Pi

事件实时发送：

{
  "id": "evt_123",
  "sessionId": "sess_001",
  "timestamp": 1720000000,
  "type": "file_read",
  "payload": {
    "path": "src/app.ts",
    "startLine": 42,
    "endLine": 87
  }
}

浏览器收到之后更新本地 State。

---

12. Frontend State

推荐使用 React。

核心 State：

type DazeState = {
  session: {
    id: string
    projectPath: string
    startedAt: number
  }

  agent: {
    status:
      | "idle"
      | "thinking"
      | "reading"
      | "editing"
      | "running"
      | "waiting"
      | "error"

    model?: string
  }

  currentAction?: DazeEvent

  files: FileState[]

  activity: DazeEvent[]

  plan?: Plan

  chat: Message[]

  context?: {
    used: number
    total: number
  }
}

---

13. UI 总体布局

保持目前 HTML Demo 的布局。

┌────────────────────┬──────────────────────────────┬───────────────────┐
│                    │                              │                   │
│    SESSION INFO    │                              │      AGENT        │
│                    │                              │                   │
├────────────────────┤                              ├───────────────────┤
│                    │                              │                   │
│    FILE TREE       │          STAGE               │       DESK        │
│                    │                              │                   │
├────────────────────┤                              ├───────────────────┤
│                    │                              │                   │
│    ACTIVITY        │                              │       CHAT        │
│                    │                              │                   │
└────────────────────┴──────────────────────────────┴───────────────────┘

---

14. Panel 1：Session Info

显示：

DAZE

12:42:31

session
sess_8f92c1

project
~/projects/my-app

model
Claude / ...

context
82k / 128k

v0.1 不需要复杂图表。

只需要让用户知道：

«“我现在在看哪个 Agent。”»

---

15. Panel 2：File Tree

显示当前项目目录。

例如：

my-app/

├── src/
│   ├── app.ts
│   ├── auth.ts
│   ├── api.ts
│   └── utils.ts
│
├── package.json
├── README.md
└── tsconfig.json

当 Agent 当前正在读取：

src/auth.ts

文件高亮。

---

16. Panel 3：Activity

这是事件时间线。

例如：

12:42:31  READ
src/app.ts
42–87

12:42:34  READ
src/auth.ts
1–62

12:42:38  RUN
npm test

12:42:42  EDIT
src/auth.ts

12:42:45  READ
src/api.ts

最新事件位于顶部。

---

17. Panel 4：Stage

这是 DAZE 最重要的 UI。

Stage 不是普通 Log。

它应该把 Agent 行为转换成视觉内容。

---

File Read

事件：

file_read
src/app.ts
42–87

Stage：

┌─────────────────────────────────────┐
│ src/app.ts                    42–87 │
│                                     │
│ 40  import ...                      │
│ 41                                  │
│ 42  const result = await fetch()    │
│ 43  const data = await result.json()│
│ 44                                  │
│ 45  return transform(data)          │
│                                     │
│             ─────────               │
│             Agent 正在阅读          │
└─────────────────────────────────────┘

---

18. File Edit

Agent 修改文件时：

1. 显示旧文件
2. 显示 Diff
3. 动画播放修改
4. 更新最终文件

例如：

- const result = await fetch(url)
+ const response = await fetch(url)

- return transform(result)
+ return transform(response)

动画不要太快。

建议：

300ms - 1000ms

让用户真的能看到变化。

---

19. Command

Agent 执行 Shell：

┌─────────────────────────────────────┐
│ $ npm test                           │
│                                     │
│ > my-app@1.0.0 test                 │
│ > vitest                             │
│                                     │
│ ✓ auth.test.ts                      │
│ ✓ api.test.ts                       │
│ ✓ app.test.ts                       │
│                                     │
│ Tests: 12 passed                    │
└─────────────────────────────────────┘

---

20. Agent 状态

Agent 状态不应该只显示文字。

它应该影响 Agent Avatar。

idle
  ↓
Agent 坐着

thinking
  ↓
趴桌子 / 发呆

reading
  ↓
拿文件

editing
  ↓
敲键盘

running
  ↓
盯 Terminal

waiting
  ↓
趴着

error
  ↓
抬头 / 困惑

---

21. Agent Avatar

v0.1 不需要真正的 Live2D 系统。

第一版：

状态机
   ↓
静态 / 动态 Sprite

例如：

type AgentMood =
  | "idle"
  | "thinking"
  | "reading"
  | "typing"
  | "running"
  | "error"

先用：

- PNG
- GIF
- CSS animation
- 简单 sprite

实现。

未来再替换成 Live2D。

---

22. Desk

右中区域模拟 Agent 工作桌。

桌面包含：

Agent
Monitor
Keyboard
Paper
Plan
Coffee

Plan 可以是一张真实的纸。

例如：

┌────────────────────┐
│ PLAN               │
│                    │
│ ✓ inspect project  │
│ ✓ find auth bug    │
│ ○ fix auth         │
│ ○ run tests        │
│                    │
└────────────────────┘

Plan 第一版只做：

«展示。»

不要让 Daze 自己成为 Planner。

---

23. Chat

右下角：

┌─────────────────────────────┐
│ Agent                       │
│                             │
│ I'm checking the auth flow. │
│                             │
│ You                         │
│ Why did you open this file? │
│                             │
├─────────────────────────────┤
│ Ask the agent...          ↑ │
└─────────────────────────────┘

Chat 负责向 Agent 发送：

prompt

Agent 的 streaming message 实时显示。

---

24. Session

v0.1 每次打开项目创建一个 Session。

type Session = {
  id: string

  projectPath: string

  startedAt: number

  agentRuntime: "pi"

  model?: string
}

第一版 Session 可以只存在内存。

刷新页面之后可以暂时丢失。

---

25. Project

用户启动 DAZE 时选择：

~/projects/my-project

Server 保存：

type Project = {
  path: string
  name: string
}

第一版只支持：

«本地项目。»

---

26. File State

为了支持视觉化，需要保存 Agent 最近看到的文件内容。

type FileState = {
  path: string

  content: string

  version: number

  lastRead?: {
    startLine: number
    endLine: number
  }

  lastModified?: number
}

---

27. 文件变动

监听两种来源：

Agent Tool Event

例如：

edit src/app.ts

Filesystem Watcher

例如：

src/app.ts changed

建议两者都支持。

原因：

Agent 可能通过：

edit tool

修改文件，也可能通过：

bash
sed
python
cat > file

修改文件。

因此：

Agent Events
      +
Filesystem Watcher
      ↓
File State

---

28. Diff

使用标准 diff library。

输入：

before
after

输出：

@@
- old code
+ new code

然后 Stage 负责动画。

不要让 Adapter 负责动画。

---

29. Context

第一版只显示：

82k / 128k

如果 Agent Runtime 能提供：

contextUsage

直接显示。

如果不能：

«显示 "—"»

不要为了这个功能自己重写 Tokenizer。

---

30. Plan

Plan 来源优先级：

Agent Runtime
      ↓
Session metadata
      ↓
Markdown / TODO
      ↓
None

第一版甚至可以只支持：

TODO.md

或者 Pi 已有的计划信息。

DAZE 只负责展示。

---

31. Server API

最小 API：

GET /api/projects

返回项目列表。

POST /api/sessions

创建 Session。

GET /api/sessions/:id

获得 Session 状态。

POST /api/sessions/:id/prompt

向 Agent 发送 Prompt。

GET /api/sessions/:id/events

获取历史事件。

WS /ws/sessions/:id

实时事件。

---

32. Prompt API

POST /api/sessions/:id/prompt

{
  "prompt": "帮我看看这个项目为什么启动不了"
}

Server：

HTTP
 ↓
Session
 ↓
Pi
 ↓
Agent

---

33. WebSocket Event

Server → Browser：

{
  "type": "event",

  "event": {
    "id": "evt_123",
    "sessionId": "sess_001",
    "timestamp": 1720000000,
    "type": "file_read",
    "payload": {
      "path": "src/app.ts",
      "startLine": 42,
      "endLine": 87
    }
  }
}

---

34. 推荐技术栈

Frontend

React
TypeScript
Vite
Tailwind CSS
Monaco Editor
Framer Motion

Monaco 用于：

- 文件
- Code
- Diff

Framer Motion 用于：

- Stage 动画
- Panel transition
- Agent UI
- Diff animation

---

Backend

Node.js
TypeScript
Fastify / Hono
WebSocket

---

Agent

Pi

---

Filesystem

Node fs
chokidar

---

State

前端：

Zustand

第一版 Server：

In-memory

---

35. 推荐项目结构

daze/
│
├── apps/
│
│   ├── web/
│   │   ├── src/
│   │   │   ├── components/
│   │   │   │   ├── SessionInfo/
│   │   │   │   ├── FileTree/
│   │   │   │   ├── Activity/
│   │   │   │   ├── Stage/
│   │   │   │   ├── Agent/
│   │   │   │   ├── Desk/
│   │   │   │   └── Chat/
│   │   │   │
│   │   │   ├── stores/
│   │   │   ├── hooks/
│   │   │   └── App.tsx
│   │   │
│   │   └── package.json
│   │
│   └── server/
│       ├── src/
│       │   ├── agents/
│       │   │   ├── AgentAdapter.ts
│       │   │   └── PiAdapter.ts
│       │   │
│       │   ├── events/
│       │   │   ├── EventBus.ts
│       │   │   └── types.ts
│       │   │
│       │   ├── sessions/
│       │   ├── filesystem/
│       │   ├── websocket/
│       │   └── index.ts
│       │
│       └── package.json
│
├── packages/
│   └── core/
│       └── src/
│           ├── events.ts
│           ├── session.ts
│           └── types.ts
│
├── package.json
└── README.md

---

36. 开发阶段

Phase 0 — UI

目标：

«先把 HTML Demo 做成 React。»

不接 Agent。

使用 Mock Event：

agent_start
↓
file_read
↓
file_read
↓
command
↓
file_edit
↓
agent_end

实现完整视觉效果。

---

Phase 1 — Event System

实现：

DazeEvent
EventBus
WebSocket

先让：

Mock Agent
 ↓
Event Bus
 ↓
Browser

跑通。

---

Phase 2 — Pi Adapter

接入 Pi。

实现：

Pi event
 ↓
PiAdapter
 ↓
DazeEvent

第一批只支持：

agent_start
agent_end
message
tool_start
tool_end

---

Phase 3 — File Visualization

实现：

file_read
file_edit
file_write

重点完成：

«文件读取 → Stage»

和：

«文件修改 → Diff Animation»

---

Phase 4 — Terminal

实现：

command

Stage 显示：

«Terminal»

---

Phase 5 — Filesystem

增加：

chokidar

监听：

file added
file changed
file deleted

左下 Activity 显示：

MODIFIED
src/app.ts

CREATED
src/foo.ts

DELETED
src/old.ts

---

Phase 6 — Agent Avatar

根据：

agent.status

切换：

idle
thinking
reading
editing
running
error

---

Phase 7 — Chat

接入：

POST /sessions/:id/prompt

实现 streaming。

---

37. MVP 验收标准

DAZE v0.1 必须能够完成：

1. 打开项目
2. 创建 Session
3. 启动 Pi
4. 输入 Prompt
5. Agent 开始工作
6. UI 显示 Agent 状态
7. Agent 读取文件
8. Stage 显示文件
9. Agent 执行命令
10. Stage 显示 Terminal
11. Agent 修改文件
12. Stage 播放 Diff
13. Activity 显示事件
14. File Tree 更新
15. Agent 完成
16. Avatar 回到 idle

只要这 16 件事跑通：

«DAZE v0.1 完成。»

---

38. 设计原则

Principle 1

Daze is an observer.

DAZE 不应该干涉 Agent。

---

Principle 2

Events first.

任何视觉效果都应该由 Event 驱动。

---

Principle 3

Runtime agnostic.

UI 不应该知道 Pi。

---

Principle 4

Visual over textual.

不要只显示：

Reading file...

而应该：

真的把文件拿出来。

---

Principle 5

Slow the Agent down for humans.

Agent 可以 100ms 内完成一个动作。

但 DAZE 不一定要 100ms 内播放完。

DAZE 的目的不是显示所有数据。

而是：

«让人看得懂。»

因此可以对事件做视觉节流。

例如：

Agent:
read a
read b
read c
read d
read e

UI 可以：

a
 ↓
b
 ↓
c
 ↓
d
 ↓
e

每个停留 300–800ms。

---

39. 不要做“实时日志播放器”

这是一个重要区别。

错误方向：

Agent Logs
──────────────
12:01 read
12:01 read
12:01 read
12:01 read
12:01 edit
12:01 bash
...

正确方向：

Agent 工作现场

┌──────────────────────────────┐
│                              │
│         src/auth.ts          │
│                              │
│       42 ───────────         │
│       43 const token...      │
│       44 ...                 │
│                              │
│       Agent 正在阅读         │
│                              │
└──────────────────────────────┘

Logs 是数据。

Stage 是体验。

DAZE 应该重点做后者。

---

40. 未来版本

只有当 v0.1 验证核心体验之后，才考虑：

v0.2

- Session history
- Event replay
- 更完整 Diff
- Git changes
- 搜索文件
- 多种 Agent Adapter

v0.3

- Live2D
- Agent workspace
- 更完整 Desk
- Plan animation
- Event timeline scrubber

v0.4

- Codex Adapter
- Claude Code Adapter
- OpenAI Agents Adapter
- Remote Agent

更远以后

- 多 Agent
- Agent collaboration
- Agent replay
- Agent comparison
- Agent analytics

---

41. 最终产品形态

DAZE 最终不应该让用户感觉：

«“我打开了一个 Agent Dashboard。”»

而应该感觉：

«“我打开了一扇窗。”»

窗里面：

             Agent
               │
          ┌────┴────┐
          │  Desk   │
          │         │
          │  Plan   │
          └─────────┘

       它在工作。

       你在看。

这就是 DAZE。

---

42. 一句话架构

«Pi runs the agent.
Daze observes the events.
The Stage turns events into something humans can watch.»

或者中文：

«Pi 负责干活，Daze 负责看，Stage 负责把“干活”变成一场可以看的东西。»

这应该成为整个项目的架构边界。