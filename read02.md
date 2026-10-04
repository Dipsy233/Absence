DAZE v0.2 开发文档

项目名称： DAZE / 发呆症
版本： v0.2
版本主题： Zoomable Agent Workspace
核心目标： 从“能看到 Agent”升级到“可以走近 Agent、查看 Agent 正在做什么”。

---

1. 产品定义

DAZE 是一个 AI Agent Observation Environment。

DAZE 不负责重新实现 Agent，不负责多 Agent 编排，也暂时不接入其他 Agent Runtime。

v0.2 只围绕一个核心问题：

«Agent 工作得太快，人类看不清怎么办？»

答案不是降低 Agent 的速度。

而是：

«Live 模式保持真实速度，用户想认真看的时候，可以进入 Stage、查看细节、回放历史。»

因此 DAZE v0.2 的核心体验是：

Overview
   ↓
Inspect
   ↓
Stage
   ↓
Replay

用户可以：

- 在 Overview 中快速了解整个 Session
- 点击任意 Panel 深入查看
- 把文件、Diff、Terminal 等内容放入 Stage
- 在 Stage 中集中观察
- 对已经发生的 Agent 行为进行 Replay
- 从文件或代码选区快速加入 Chat

---

2. v0.2 不做什么

为了避免产品逐渐变成普通 Agent Dashboard，本版本明确不做：

- 多 Agent
- 其他 Agent Runtime 接入
- Agent 编排
- Agent 权限管理
- Agent Team
- 云端 Agent
- 复杂数据库
- 企业级监控
- Agent 自动分析平台
- Live2D 正式实现
- 复杂 AI 总结
- 自动生成新的 Agent Plan
- 修改 Agent Runtime 的执行速度

特别强调：

«DAZE 是 Observer，不是 Orchestrator。»

Agent 仍然由 Pi 执行。

DAZE 只观察、记录、渲染和回放。

---

3. v0.2 核心设计原则

3.1 Overview → Inspect → Stage → Replay

这是整个 v0.2 的核心交互模型。

┌──────────────┐
│   Overview   │
└──────┬───────┘
       │ click
       ▼
┌──────────────┐
│   Inspect    │
└──────┬───────┘
       │ open
       ▼
┌──────────────┐
│    Stage     │
└──────┬───────┘
       │ replay
       ▼
┌──────────────┐
│    Replay    │
└──────────────┘

任何 Panel 都不是最终内容。

Panel 是入口。

Stage 才是最终内容的承载空间。

---

4. 产品空间结构

整体布局：

┌──────────────────────────────────────────────────────────────┐
│                         SESSION BAR                          │
├──────────────┬───────────────────────────────┬───────────────┤
│              │                               │               │
│    FILES     │                               │    AGENT      │
│              │                               │               │
│              │                               │               │
│   ACTIVITY   │            STAGE              │               │
│              │                               │               │
│              │          2D DESK              │               │
│              │                               │               │
│              │                               │               │
├──────────────┤                               ├───────────────┤
│              │                               │               │
│   REPLAY     │                               │     CHAT      │
│              │                               │               │
└──────────────┴───────────────────────────────┴───────────────┘

4.1 左侧

包含：

- Files
- Activity
- Replay

4.2 中央

包含：

- Stage

v0.2 Stage 默认可以使用现有的代码/事件可视化。

v0.2 开始引入 Desk Mode 的数据结构和交互基础，但正式 2D 桌面视觉可以在 v0.3 完成。

4.3 右侧

包含：

- Agent
- Chat

v0.2 Agent 仍然使用现有 Avatar / 状态表现。

Live2D 放到 v0.3。

---

5. Panel 的新定义

v0.2 最大的 UI 改变：

«Panel 不再是信息展示终点，而是一个可以进入的空间入口。»

例如：

FILES
────────────────

src/
  auth.ts
  api.ts
  app.ts

+ 18 files

这是 Overview。

点击：

auth.ts

进入：

┌─────────────────────────────┐
│ auth.ts                     │
│                             │
│  1 import jwt               │
│  2                           │
│  3 export async function... │
│  4                           │
│  ...                        │
│                             │
│  Last edited 12s ago        │
│                             │
│  [ Open in Stage ]          │
└─────────────────────────────┘

这属于 Inspect。

点击：

Open in Stage

进入：

Stage
────────────────────────────

auth.ts

1
2
3 export async function login()
4 {
5    ...
6 }

这属于 Stage。

---

6. 可缩放 Panel

v0.2 Panel 至少支持三级层级。

Level 1
Overview

    ↓

Level 2
Inspect

    ↓

Level 3
Stage

不要求所有 Panel 都完全相同。

不同内容可以有不同深度。

例如：

File

Files
  ↓
File Detail
  ↓
File History
  ↓
Diff
  ↓
Stage

Activity

Activity
  ↓
Event Detail
  ↓
Payload
  ↓
Stage

Replay

Replay
  ↓
Session Timeline
  ↓
Event
  ↓
Stage at timestamp

---

7. Files Panel

7.1 Overview

显示当前项目文件树。

示例：

FILES

▾ src
    app.ts
    auth.ts        ●
    api.ts
    middleware.ts

▾ components
    Button.tsx
    Header.tsx

+ 18 files

状态：

- "●" = 最近被 Agent 操作
- 高亮 = 当前 Stage 文件
- 动态状态 = 正在 read/edit

---

8. File State

type FileState = {
  path: string

  content?: string

  language?: string

  version: number

  status:
    | "idle"
    | "reading"
    | "editing"
    | "modified"

  lastRead?: {
    startLine: number
    endLine: number
  }

  lastModifiedAt?: number

  history: FileVersion[]
}

---

9. File History

点击文件以后可以查看：

auth.ts

VERSION HISTORY

v1   10:31:02
v2   10:31:08
v3   10:31:19
v4   10:31:31   ← current

点击某个版本：

v3 → v4

- const token = getToken()
+ const token = await refreshToken()

然后：

[ Open Diff in Stage ]

---

10. File → Stage

文件必须可以进入中央 Stage。

支持：

Click file
    ↓
Inspect
    ↓
Open in Stage

或者提供快速操作：

Open in Stage

进入后：

┌────────────────────────────────────────┐
│ auth.ts                                │
│────────────────────────────────────────│
│                                        │
│ 31 async function login() {            │
│ 32                                    │
│ 33   const token = await refresh(...) │
│ 34                                    │
│ 35 }                                   │
│                                        │
└────────────────────────────────────────┘

---

11. Stage

Stage 是 DAZE 的核心。

Stage 不应该是：

«一个更大的 Log Viewer。»

而应该是：

«Agent 当前工作的空间。»

v0.2 Stage 支持以下内容：

type StageMode =
  | "desk"
  | "file"
  | "diff"
  | "terminal"
  | "search"
  | "replay"

---

12. Stage 内容模型

type StageItem = {
  id: string

  type:
    | "file"
    | "diff"
    | "terminal"
    | "search"
    | "plan"

  title: string

  source?: {
    eventId?: string
    path?: string
  }

  createdAt: number
}

---

13. Stage 可以切换模式

顶部可以提供非常轻的模式切换：

LIVE     FILE     DIFF     TERMINAL     REPLAY

但不要设计成传统 Tab Dashboard。

当前模式必须有明显空间感。

例如：

LIVE

┌────────────────────────────────────┐
│                                    │
│             Agent Desk             │
│                                    │
│               auth.ts              │
│                                    │
└────────────────────────────────────┘

---

14. Live Stage

Live 是默认模式。

Agent 正在工作时：

● LIVE

Editing auth.ts

Stage 根据事件变化。

例如：

file_read

Stage：

打开 auth.ts
↓
滚动到目标行
↓
高亮目标区域

---

15. File Read 的 Stage 行为

Agent：

read_file(
  path="src/auth.ts",
  startLine=42,
  endLine=87
)

DAZE：

Stage

src/auth.ts

42  const token = ...
43
44  async function refresh() {
45      ...
46  }
47
48  ...

自动：

1. 打开文件
2. 滚动到 42
3. 高亮 42-87
4. 保持短暂停留
5. 等待下一事件

注意：

«Live 模式不需要为了人类阅读而人为暂停 Agent。»

动画只影响视觉表现，不影响 Agent Runtime。

---

16. File Edit 的 Stage 行为

Agent 修改文件：

before

变成：

after

Stage 播放：

OLD
 ↓
DELETE
 ↓
INSERT
 ↓
FINAL

例如：

- const token = getToken()
+ const token = await refreshToken()

动画结束以后显示最终代码。

---

17. Terminal Stage

当 Agent 执行：

npm test

Stage 自动切换：

┌────────────────────────────────────┐
│ $ npm test                         │
│                                    │
│ running tests...                   │
│                                    │
│ ✓ auth                             │
│ ✓ api                              │
│ ✓ middleware                       │
│                                    │
│ 3 passed                           │
└────────────────────────────────────┘

---

18. Activity Panel

Activity 是：

«Agent 行为目录。»

而不是最终内容。

例如：

ACTIVITY

10:31:02  READ    auth.ts
10:31:05  SEARCH  refreshToken
10:31:08  READ    middleware.ts
10:31:11  EDIT    auth.ts
10:31:17  RUN     npm test
10:31:21  ERROR   test failed
10:31:25  EDIT    auth.ts
10:31:31  RUN     npm test
10:31:38  ✓       success

---

19. Activity → Stage

点击：

EDIT auth.ts

Stage 必须跳转到对应事件。

如果事件包含 Diff：

Stage
  ↓
Diff

如果事件包含 File Read：

Stage
  ↓
File
  ↓
target lines

如果事件包含 Command：

Stage
  ↓
Terminal

因此：

«Activity 是目录，Stage 是内容。»

---

20. Replay

Replay 是 v0.2 的第二核心能力。

Replay 不保存视频。

Replay 保存：

«Event Timeline + State Snapshot»

---

21. Replay Timeline

REPLAY

00:00  Agent started
00:02  Read auth.ts
00:05  Search refreshToken
00:08  Read middleware.ts
00:11  Edit auth.ts
00:17  npm test
00:21  Test failed
00:25  Edit auth.ts
00:31  npm test
00:38  Success

────────────────●──────────────
                00:21

---

22. Replay Controls

最小版本：

◀      ▶      ■

0.25x
0.5x
1x
2x
5x
10x

支持：

- Play
- Pause
- Stop
- Seek
- Speed
- Step Forward
- Step Backward

---

23. Replay 与 Live 的区别

Live

真实 Agent 时间

Agent 有多快：

«DAZE 就多快。»

Replay

用户时间

用户可以：

0.25x
0.5x
1x
2x
5x
10x

因此：

«Live 不降速，Replay 才降速。»

这是产品必须保持的原则。

---

24. Replay Event Model

type ReplayEvent = {
  id: string

  timestamp: number

  type: DazeEvent["type"]

  payload: unknown

  snapshot?: {
    files?: Record<string, string>
    stage?: StageState
  }
}

---

25. Replay State

type ReplayState = {
  sessionId: string

  status:
    | "idle"
    | "playing"
    | "paused"

  currentTime: number

  duration: number

  speed: number

  events: ReplayEvent[]
}

---

26. Replay Seek

用户拖动：

00:00 ───────────●──────────── 00:38
                  00:21

系统：

1. 找到最近 Snapshot
2. 恢复 Snapshot
3. 从 Snapshot 开始重新应用 Event
4. 恢复到目标时间
5. 更新 Stage

不能每次都从 session 第一个事件开始重放。

否则长 Session 会越来越慢。

---

27. Snapshot 策略

v0.2 可以先采用简单策略：

每 N 个事件

或者：

每 5 秒

创建一个 Snapshot。

例如：

00:00 snapshot
00:05 snapshot
00:10 snapshot
00:15 snapshot
...

---

28. 右键上下文操作

文件和代码内容支持 Context Menu。

例如：

auth.ts

右键：

┌──────────────────────┐
│ Open                 │
│ Open in Stage        │
│ View History         │
│ View Diff            │
│ ──────────────────── │
│ Add file to Chat     │
│ Explain this         │
└──────────────────────┘

---

29. Selection Context Menu

用户选中代码：

const token = await refreshToken()

右键：

Add selection to Chat

Chat 自动得到：

@auth.ts:31

const token = await refreshToken()

然后用户可以继续输入：

为什么这里要 refreshToken？

---

30. Chat Context

定义：

type ChatContext = {
  type:
    | "file"
    | "selection"
    | "event"
    | "diff"

  path?: string

  startLine?: number

  endLine?: number

  content?: string

  eventId?: string
}

Chat 不负责自动决定上下文。

由用户明确添加。

---

31. Agent Panel

v0.2 保持简单。

显示：

AGENT

● WORKING

Editing auth.ts

────────────────

Thinking
Reading
Editing
Running
Waiting
Error
Done

Agent 状态由 Event Stream 推导。

---

32. Agent State

type AgentStatus =
  | "idle"
  | "thinking"
  | "reading"
  | "searching"
  | "editing"
  | "running"
  | "waiting"
  | "error"
  | "completed"

---

33. Live2D 暂不实现，但预留状态接口

虽然 v0.2 不做正式 Live2D，但前端 Agent 状态必须独立出来。

type AgentVisualState = {
  status: AgentStatus

  action?: string

  mood?:
    | "calm"
    | "focused"
    | "confused"
    | "busy"
    | "tired"
    | "happy"
}

这样 v0.3 可以直接接入：

AgentStatus
      ↓
Live2D Controller
      ↓
Animation

而不用修改 Agent Runtime。

---

34. Desk Mode

v0.2 开始为未来 2D Desk 做架构准备。

正式视觉放到 v0.3。

Desk 数据模型：

type DeskState = {
  items: DeskItem[]

  camera?: {
    x: number
    y: number
    zoom: number
  }
}

Desk Item：

type DeskItem = {
  id: string

  type:
    | "file"
    | "terminal"
    | "paper"
    | "plan"
    | "cursor"

  position: {
    x: number
    y: number
  }

  rotation?: number

  sourceId?: string
}

---

35. 文件进入桌面

未来正式实现：

Files
  │
  │ click
  ▼
auth.ts
  │
  │ Open in Stage
  ▼
Stage
  │
  ▼
Desk

        ┌─────────────┐
        │ auth.ts     │
        │             │
        │ code...     │
        └─────────────┘

文件不是简单“切换 Tab”。

它可以成为：

«桌面上的一个物件。»

---

36. v0.2 的视觉要求

整体视觉不要做成：

- Grafana
- Datadog
- Jira
- VS Code Dashboard
- Agent monitoring dashboard

应该更接近：

«一个安静的、略带生活感的数字工作空间。»

关键词：

quiet
observational
spatial
minimal
slightly playful
cinematic

---

37. 不要过度使用卡片

不要：

┌──────┐ ┌──────┐ ┌──────┐
│ Card │ │ Card │ │ Card │
└──────┘ └──────┘ └──────┘

而应该：

FILES            STAGE             AGENT

文件              空间               人物

                    ↓

                 DETAILS

Panel 更像：

«房间中的区域»

而不是：

«Dashboard Card。»

---

38. Frontend Architecture

继续使用：

React
TypeScript
Vite
Tailwind
Zustand
Monaco Editor
Framer Motion

推荐结构：

apps/web/src/

├── app/
│   ├── App.tsx
│   └── routes.ts
│
├── components/
│   ├── layout/
│   │   ├── SessionBar.tsx
│   │   ├── LeftRail.tsx
│   │   ├── Stage.tsx
│   │   └── RightRail.tsx
│   │
│   ├── files/
│   │   ├── FilePanel.tsx
│   │   ├── FileTree.tsx
│   │   ├── FileDetail.tsx
│   │   └── FileHistory.tsx
│   │
│   ├── activity/
│   │   ├── ActivityPanel.tsx
│   │   └── ActivityItem.tsx
│   │
│   ├── stage/
│   │   ├── Stage.tsx
│   │   ├── StageToolbar.tsx
│   │   ├── FileStage.tsx
│   │   ├── DiffStage.tsx
│   │   ├── TerminalStage.tsx
│   │   └── DeskStage.tsx
│   │
│   ├── replay/
│   │   ├── ReplayPanel.tsx
│   │   ├── ReplayTimeline.tsx
│   │   └── ReplayControls.tsx
│   │
│   ├── agent/
│   │   └── AgentPanel.tsx
│   │
│   └── chat/
│       ├── ChatPanel.tsx
│       └── ContextChip.tsx
│
├── stores/
│   ├── sessionStore.ts
│   ├── fileStore.ts
│   ├── stageStore.ts
│   ├── replayStore.ts
│   └── chatStore.ts
│
├── hooks/
│   ├── useDazeEvents.ts
│   ├── useStage.ts
│   └── useReplay.ts
│
└── types/
    ├── events.ts
    ├── file.ts
    ├── stage.ts
    └── replay.ts

---

39. Stage Store

type StageState = {
  mode: StageMode

  activeItem?: StageItem

  items: StageItem[]

  history: StageItem[]
}

核心操作：

openStage(item)

closeStage()

replaceStage(item)

pushStage(item)

goBack()

goForward()

---

40. Stage Navigation

Stage 必须支持：

File
 ↓
Diff
 ↓
Replay
 ↓
File

用户不能因为打开一个细节就迷路。

因此 Stage 应该维护：

navigation stack

例如：

[
  File(auth.ts),
  Diff(auth.ts:v3→v4),
  Event(EDIT),
]

Back：

Diff

再 Back：

File

---

41. Event Bus

继续沿用 v0.1：

class DazeEventBus {
  subscribers = new Set<
    (event: DazeEvent) => void
  >()

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

---

42. WebSocket

继续：

Pi
 ↓
Daze Server
 ↓
Event Bus
 ↓
WebSocket
 ↓
Browser

Browser 收到：

DazeEvent

然后分别更新：

Event
 ↓
Activity
 ↓
Files
 ↓
Stage
 ↓
Agent
 ↓
Replay

---

43. Event → UI 映射

Event| Activity| Files| Stage| Agent
"agent_start"| ✓| | | ✓
"agent_end"| ✓| | | ✓
"file_read"| ✓| ✓| ✓| ✓
"file_write"| ✓| ✓| ✓| ✓
"file_edit"| ✓| ✓| ✓| ✓
"command"| ✓| | ✓| ✓
"error"| ✓| | ✓| ✓
"message"| | | | ✓

---

44. v0.2 数据流

                   Pi
                   │
                   ▼
              DazeEvent
                   │
                   ▼
               EventBus
                   │
          ┌────────┼────────┐
          ▼        ▼        ▼
       Activity   Files    Replay
          │        │        │
          └────────┼────────┘
                   ▼
                 Stage
                   │
          ┌────────┴────────┐
          ▼                 ▼
       Agent              Chat

---

45. 关键产品约束

Constraint 1

Agent 的真实速度不能被 UI 限制。

Agent speed ≠ Animation speed

---

Constraint 2

Replay 不得依赖录屏。

Replay = Event + State

不是：

Replay = Video

---

Constraint 3

Stage 不是 Log Viewer。

Stage 必须根据事件产生对应视觉：

READ  → File
EDIT  → Diff
BASH  → Terminal
SEARCH → Search
REPLAY → Historical Stage

---

Constraint 4

Panel 是入口，不是终点。

---

Constraint 5

Chat 不是主角。

---

46. v0.2 Acceptance Criteria

Files

- [ ] 可以查看项目文件树
- [ ] 当前 Agent 操作文件有状态
- [ ] 点击文件进入 Inspect
- [ ] 文件可以打开到 Stage
- [ ] 可以查看文件历史
- [ ] 可以查看 Diff

Activity

- [ ] 所有 Agent 操作进入 Activity
- [ ] Activity 可以点击
- [ ] 点击后 Stage 跳转到对应事件
- [ ] Event 与 Stage 时间点保持一致

Stage

- [ ] 支持 File
- [ ] 支持 Diff
- [ ] 支持 Terminal
- [ ] 支持 Live
- [ ] 支持 Replay
- [ ] 支持 Stage navigation
- [ ] 支持 Back

Replay

- [ ] Session 可以回放
- [ ] 可以 Play/Pause
- [ ] 可以 Seek
- [ ] 可以调整速度
- [ ] 可以定位 Event
- [ ] Seek 后 Stage 状态正确恢复

Chat

- [ ] 文件可以添加到 Chat
- [ ] 代码选区可以添加到 Chat
- [ ] Event 可以添加到 Chat
- [ ] Chat 显示上下文来源

---

47. v0.2 完成后的用户体验

用户打开 DAZE。

第一眼：

«Agent 正在工作。»

不用阅读几十行 Log。

他看到：

● Working

Reading auth.ts

然后 Agent 很快完成了。

用户没看清。

他点：

Replay

于是：

00:00 ───────●──────────── 00:38

把速度调到：

0.5x

看到 Agent：

Read auth.ts
↓
Search refreshToken
↓
Read middleware.ts
↓
Edit auth.ts
↓
npm test

他点：

Edit auth.ts

Stage 自动打开 Diff。

然后他选中：

await refreshToken()

右键：

Add selection to Chat

Chat：

@auth.ts:33

为什么这里需要 refreshToken？

到这里，DAZE 的完整闭环就成立了：

WATCH
  ↓
ZOOM
  ↓
INSPECT
  ↓
REPLAY
  ↓
ASK

---

48. v0.3 预留方向

v0.3 不继续堆 Dashboard 功能。

主题：

«DAZE becomes alive.»

核心：

1. 真实 2D Desk

Top-down desk

2. Agent Live2D

Thinking
Reading
Editing
Running
Waiting
Error
Success

3. 文件成为桌面物件

auth.ts
   ↓
飞到桌面

4. Stage 动画

File appears
↓
Scroll
↓
Highlight
↓
Edit
↓
Diff
↓
Final

5. Agent 与桌面产生关系

例如：

Agent reading paper
Agent typing
Agent looking at terminal
Agent waiting
Agent looking at user

最终形成：

«一个 Agent 坐在桌子前工作的数字工作室。»

---

49. 最终产品方向

DAZE 不应该最终变成：

«Agent Dashboard»

也不应该变成：

«Agent IDE»

更不应该变成：

«Agent Management Platform»

它应该成为：

«Agent 工作的可视化空间。»

最终用户打开 DAZE，不是为了看指标。

而是：

«打开一扇窗，看 AI 在里面工作。»

---

50. DAZE v0.2 一句话

«v0.1：我能看到 Agent。»

«v0.2：我可以走近 Agent。»

«v0.3：我可以坐在桌边，看它工作。»

«v0.5：我可以把它刚才的工作重新看一遍。»

最终：

«DAZE — AI moves fast. Humans watch.»