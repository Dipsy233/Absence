# DAZE / 发呆症

[English](README.md) | 中文

> AI moves fast. Humans watch.

DAZE 是一个面向 AI agent 的实时可视化观察器。它不试图让 agent 更聪明——
它让人*看见* agent 正在做什么。

```
Pi 运行 agent。
Daze 观察事件。
Stage 把事件变成人可以看的东西。
```

## 这个想法

桌子本来是人工作的地方。后来 AI 来了，起初是需要被帮助的那一方——能力不足、
做着做着就忘，所以人守在旁边：喂上下文、纠正错误、围绕它的缺陷设计工作流。

现在反过来了。agent 懂得更多、动得更快，在你读完一行代码之前就做完了。
没有什么可协助的，也没有下手的地方，于是人坐在桌前看着——看着一条没有断点
的命令流，假装跟得上，注意力悄悄散掉。这种半看不看的状态就是"发呆"。
**DAZE / 发呆症**围绕它构建，并朝两个相反的方向用力：

- **看懂它，并陪着它。** 把事件流压缩成人真正能看的东西——一张桌子、一台
  显示器、一张纸——让注意力有地方落。这就是 Stage：
  `Overview → Inspect → Stage → Replay`。
- **干脆不用盯着。** 收集这次运行真正做了什么，几秒钟内汇报——改了什么、
  跑了什么、什么失败了、什么需要你——于是你可以离开桌子，回来只看要点。
  这就是 Daze Report。

面板只是入口，从来不是内容的归宿——内容活在 Stage 里。而且**实时绝不拖慢
agent**：运行以真实速度播放，想慢下来是 Replay 的事。

## 两个视角

整个 UI 按"你在看谁的视角"切分：

|  | **左边** — 用户的视角 | **右边** — agent 的视角 |
|---|---|---|
| 文件 | 整个项目树 | 只有 agent 上下文里的文件 |
| 打开文件 | **整个文件**，从磁盘读 | **只有 agent 读过/改过的部分** |
| FILE 按钮 | `userFile` 槽位 | `agentFile` 槽位 |

两个槽位互相独立。如果 agent 读过某文件的 10–20 行，Agent Folder 会列出它，
它的 FILE 按钮也只显示这些行——而且读过 1–2 和 3–5 之后显示的是 1–5，中间
从不会被悄悄接上（中间没读过的行会变成显式的 `⋯ (line 6 — not in the
agent's context)` 标记，行号仍然和真实文件对得上）。

左边的树可以这样，是因为*用户*本来就有权读自己的项目；右边则从不假装比
agent 知道得更多。

### 文件版本

agent 碰过的每个文件，按状态记录版本，最旧在前，一种状态一个版本：

```
v0  read   1–5 行           ← 它到目前为止读过的全部内容的并集
v1  write  整个文件
v2  edit   整个文件
```

版本是*记录*下来的，不是推导出来的。文本在 agent 看到它的那一刻被捕获——
`read` 的切片来自模型实际收到的工具结果，`write` 来自它发出的参数，`edit`
来自把它的改动应用在它持有的那份文件上。之后磁盘上再发生什么（agent 改的
也好，别的什么改的也好）都改写不了更早的版本，因为没有任何东西指回源文件。

这一点很重要，因为 LLM 的上下文里确实留着这些旧版本，这也让 Agent Folder
适合回顾：展开一个文件，点任意版本，就能把那个确切的状态放上 Stage。一次
write 之后再读不会把文件回滚，v0（由读产生的部分内容）也永远不会和完整文件
版本一起进 Files → History 做 diff。

同一份版本历史也是 Daze Report 里**环路检测**的数据源：当更新的版本文本与
agent 已经持有过的某个状态逐字节相同——v0 的读快照，或某个更早的完整版本，
也就是 `v2 ≡ v0` 的形状——这次运行就有一个*文件版本环路*：agent 很可能改了
文件又把自己的改动撤销了。报告会在 Human attention 里说出来（"文件版本
震荡——agent 可能撤销了自己的修改"）。它的姊妹是*命令重试环路*：同一条命令
在一次运行里失败两次以上（"同一条命令多次失败"）。两者都纯从事件流读出，
没有 LLM，也不解析命令行——只有文本比较和失败计数——且都把人工关注抬到
*medium*，因为自我挫败的活动即使每一步都"成功"了也值得看一眼。带缺口的
部分 v0 永远不会被当作环路的基准，理由和它不进 Files → History 的 diff 一样。

尺度的两端还有两个事实也进人工关注：

- **项目外改动**（`low`）—— Daze 还监视项目的*父目录*（浅层，且绝不监视
  home 目录或盘根），所以 agent 在工作区之外做的修改不会被悄悄漏掉。项目外
  的改动在报告里有独立的 **Outside the project** 标题，在 Timeline 上标记为
  `OUTSIDE`，并把人工关注抬到 *low*。
- **留下的蛋还在跑**（`high`）—— 对话结束后还活着的进程是日常最强的信号：
  有一个没人盯着的东西还在跑，它现在以 high 说话。

## 布局

```
┌──────────────────────────────────────────────────────────────┐
│                         SESSION BAR                          │
├──────────────┬───────────────────────────────┬───────────────┤
│    FILES     │  [FILE DIFF REPLAY]  TABLE    │     AGENT     │
│  (用户视角)  │      [TERMINAL FILE LIVE]     │   (头像)      │
│              │                               │               │
├──────────────┤───────────────────────────────┤───────────────┤
│   HISTORY    │                               │  AGENT FOLDER │
│   (运行)     │            STAGE              │  (agent 视角) │
├──────────────┤                               ├───────────────┤
│   ACTIVITY   │  replay 控件，仅在回放时出现  │  AGENT EGGS   │
│  (选中运行)  │  chat dock：只有一行输入      │ 它启动的进程   │
└──────────────┴───────────────────────────────┴───────────────┘
```

- **Session bar** — 会话 id、项目、模型、上下文用量、live/offline，以及选择
  项目的 *change* 按钮。旁边有一个配色循环按钮（`amber → blue → green`）：整套
  UI——面板、桌子世界、Monaco——从同一组 CSS 变量换肤，选择会被记住。正中间
  有一个 **DAZE** 切换按钮：打开后图层翻转，
  桌子——或切换后的 agent——以半透明、可点击穿透的 ghost 浮在内容页*前面*。
- **Files**（左）— 树 → 详情 → 历史。树会标记 agent 碰过的文件（`●`），
  并高亮当前在 Stage 上的文件。右键菜单：*Inspect / Open in Stage /
  View History / View Diff / Add to Chat / Explain this*。
- **History**（左）— 每个**运行**一行：从一次 prompt 到完成或被打断，最旧在
  上、最新在下。显示时间、状态（`running`/`done`/`stopped`/`error`）、时长、
  prompt，以及动作计数 `R` 读 · `S` 搜索 · `E` 改 · `C` 建 · `$` 命令。选中
  一个运行会过滤 Activity 面板；**⟲** 按钮把视图回滚到那次运行结束时的状态
  （见 Replay——DAZE 从不写项目，所以这只是回滚"你在看的东西"）。
- **Activity**（左）— 选中运行的动作，最旧在上。点一行把它放上 Stage；表头
  有 **▶ replay** 按钮，从头回放该运行。推理也被记录：一次 `thinking` 事件是
  一行 **THINK**，agent 自己的话和它导致的动作并排放在一起。低于 eggs 分类器
  `EPHEMERAL_MS`（300 ms，与把短命进程折成 helper 计数是同一个“只活了一着”
  标准）返回的 `find` / `ls` 是管道而不是动作——原始事件仍在流里（报告照常
  计数），但不进 Activity、也不占 Stage；耗时更久的搜索和任何 `grep` 照旧成
  行。没有记录耗时的搜索绝不当作瞬时。
- **Stage**（中间）— file、diff、terminal、thinking、desk 或 replay。桌子世界
  是默认页，永远作为背景绘制；FILE / DIFF / TERMINAL / LIVE 以略半透明的
  sheet 叠在上面。模式切换分三组：用户的（FILE / DIFF / REPLAY）、中间的
  **TABLE**（默认桌子页）、agent 的（TERMINAL / FILE / LIVE）。session bar
  正中的 **DAZE** 按钮会翻转这个图层：打开时，桌子——或切换后的 agent——
  以半透明、点击穿透的 ghost 浮在内容页*前面*。Chat 停靠在 Stage 底部，浮在
  Stage 之上而不占布局空间，所以中间永远不会被挤小：始终只有一行输入，历史
  以半透明层向上展开，最多占 Stage 的 30%，还有箭头可以吹到满高。输入框旁的
  开关可以把历史整个收起（只剩输入行），这个选择会被**记住**——跨默认页、
  其他视图和刷新。历史只在 Stage 停在默认桌子页时显示，所以钉住的视图不会
  被挤。
- **Agent**（右）— 头像，完全由事件流驱动。
- **Agent Folder**（右）— agent 眼里的项目：它上下文里的文件，最新在前，每个
  可展开成它持有过的版本。点文件看最新内容，点版本看那个确切的状态。
- **Agent Eggs**（右）— agent 创建的进程，有 `running` / `dead` / `all` 三个
  标签页和计数。egg 是 Daze 看到 agent 启动的进程：它留下的 dev server、一个
  守护进程、某个脚本的子进程。它的状态说明它后来怎样了，所以一条命令内部活
  过又死掉的进程也会被报告——`dead` 不是失败，是事实。点一个把它放上 Stage。
  只读：DAZE 报告 agent 启动了什么，从不杀掉任何 egg。

  Eggs **按行为分类，不按名字**：面板列出 *primary* 进程，把帮手折进一个计数
  （`folded 5 helpers: sleep, cat, …`）。命令的 `cat`、`grep`、`sleep`——以及
  agent 用来查看自己守护进程的查询工具，如 `ps`、`kill`——是帮手；命令真正
  启动的那一个守护进程是 primary。任何东西都不按文件名判断：当进程活得比
  启动它的命令久、自己又启动了进程、是命令点名的主体（`node ticker.mjs`）、
  被命令放到后台或重定向、或从工作区里运行时，它就是 primary。透明的启动器
  （`nohup`、`setsid`、`time`）被穿透，所以 `nohup node ticker.mjs` 显示为
  `node ticker.mjs`。同样的切分也过滤 Activity 面板和 Daze Report，帮手永远
  不会把 egg 埋掉。

## Agent 状态

完全从事件推导，所以反映的是现实而不是猜测：

```
listening → (thinking | speaking | reading | searching | editing | running | waiting) → listening
```

- `listening` — 还什么都没发生，或者上次运行已结束
- `speaking` — agent 正在给你写回复
- `reading` / `searching` / `editing` / `running` — Stage 显示那个动作期间保持，
  agent 一开始输出文本就退出
- `error` — 显示为 *confused*

运行结束、发出新 prompt、以及 **agent 一开始说话**时，Stage 会回到默认桌子页
——所以写完的文本永远不会被过期的文件或终端视图挡住。

## History & Replay

一个**运行**是一次 prompt 到 `agent_end`。运行同时是 History 和 Replay 的单位。

Replay 是重建出来的，不是录制的：**事件 + 状态快照**，从来不是视频。

- 回放缓冲区就是选中的那个运行
- 每 25 个事件或 5 秒一个快照；每个快照带文件内容、agent 状态**以及 Stage 当时
  在显示什么**，所以 seek 总是落在一个正确的帧上，而不是空白
- seek 取最近的快照，然后应用剩余的事件
- 控件（play / pause / step / seek / 0.25×–10×）在 Stage 内部、动画区下方，
  这样拖动进度条不会被干扰

打开一个运行有两种方式：

- Activity 表头的 **▶ replay** — 从头回放
- History 行内的 **⟲** — 回滚到那次运行**结束时**的状态

两者都只作用于视图。DAZE 是观察者，所以"回滚"指的是恢复你在看的东西，
从不改写项目。

## Daze Report

Stage 顶部中央的一个标签页，把半透明的 **Daze Report** 展开盖住 Stage 主体。
它完全从事件流推导——没有 LLM，没有解析命令行——回答两个问题：

- **运行进行中** — *agent 现在在干什么？* 一个阶段
  （`investigating` / `implementing` / `executing` / `verifying` / `recovering`）、
  进度、以及一个人工关注等级。
- **运行结束后** — *这次运行干成了什么？* 四个部分：**Timeline**（把运行画成
  一条水平世界线：按发生顺序每个活动一个节点，节点下面是它造成的东西——读
  会说哪些行进了上下文，改说 `+A / −D`，命令说退出状态，没结束的 shell 工具
  说还有一个进程在跑；点节点在报告左侧的窗格里打开它，效果就在旁边，diff /
  输出 / 推理一键可达）、**Knows**（读过的文件和跑过的搜索——agent 学到了
  什么）、**Changes**（创建/修改/观察到/删除的文件，带 `+A / −D`），以及
  **Executions**（它跑过的命令，带退出状态），另有 recoveries、一个结论、带
  理由的人工关注等级，和这次运行 agent 自己的回复。人工关注还会盯着 agent
  自己拆自己的台：**文件版本环路**（新版本与 v0 或更早版本逐字节相同——
  `v2 ≡ v0` 的形状，改动被撤销了）和**命令重试环路**（同一条命令在一次运行
  里失败两次以上）。两者都是纯归约——文本比较和失败计数——并把关注等级抬
  到 medium。在尺度的两端：**项目外**的改动（浅层监视父目录）是低级关注事实，
  有独立的报告标题；运行结束后**还在跑的蛋**是 high。

它跟随 History 里选中的运行（默认最新）。引擎在 `apps/web/src/lib/report.ts`：
一次运行的 `DazeEvent` 被归约为 `RunFacts`，然后 Live 或 Run 报告**只从这些
事实渲染**。它从不报告 agent *说*自己做了什么——只报告观察者看见的。两条
刻意的规则：失败从 `bash` / `powershell` 工具结果读取（一个失败的工具不发
`command` 事件），观察者自己的改动被对账，所以 agent 写的文件永远不会同时
被算成外部改动。Timeline 遵守同样的规则：它从流上读取效果，从不解析命令行去
猜它*想*启动什么服务，连续的推理增量折叠成它们本来的那一个念头。agent 留下
的进程和任何事实一样：它在 Timeline 上成为一个 `LAID` 节点，如果运行结束时
它还活着就抬高*人工关注*。每一项都是证据链接——点文件、搜索或命令，内容在
报告左侧的窗格里打开，同时高亮 Activity 里匹配的行，所以不出报告就能跟上
证据。报告是压缩的 Activity，不是另一套事实，所以 Replay 以后可以共用同一层
事实。

## 架构

```
Browser ──WebSocket──▶ Daze Server ──EventBus──▶ AgentAdapter ──▶ Pi (SDK, in-process)
   ▲                                                                     │
   └──────────── DazeEvent stream (file_read / file_edit / command / …) ─┘
```

- `packages/core` — 共享的 `DazeEvent` + 领域类型。UI 认识的唯一词汇表；它
  永远不会知道 Pi 的存在。
- `apps/server` — Fastify + WebSocket。`PiAdapter` 包装 Pi SDK，把
  `AgentSessionEvent` 映射成 `DazeEvent`；`MockAdapter` 不需要凭据就能回放
  一段脚本化的运行；`chokidar` 监视项目的带外改动。**Daze 拥有 shell**：
  `process/DazeShell` 包装 Pi 自己的本地 shell 操作，注册成自定义
  `bash` / `powershell` 工具（自定义工具按名字遮蔽内建的，所以 `DAZE_PI_TOOLS`
  不受影响）。Pi 照样执行每条命令——Daze 只拥有边界，正是这个边界告诉
  `ProcessWatcher` 一条命令何时运行，并在它头部放一个唯一标记，让 Pi 为这条
  命令生成的 shell（和它外面的启动器）能被精确识别，而不是靠名字或父进程链
  去猜。`ProcessWatcher` 然后观察进程表。在 **Windows** 上它完全不采样：
  `native/agentwatch` 是一个小 helper，把 server 放进一个 **Job Object**，
  内核随后把每一次创建和退出实时上报。在 **Linux** 上它也不采样：
  `native/agentwatch-linux` 挂三个 eBPF tracepoint
  （`sched_process_fork/exec/exit` 外加 `sys_enter_execve` 拿 argv），从 ring
  buffer 上报同样的事件。活 20 毫秒的进程在两边都看得见——轮询永远看不见。
  在其他平台上，或 helper 启动不了时，观察器退回快照（Windows 上一次 CIM
  查询，其他平台 `ps`）。一个进程是 egg，当它出现在某条命令的窗口内、且祖先
  链能到 Daze；egg 报告在每棵新子树的根上，任何东西都不会被杀。
  Eggs 然后**按行为分类，不按名字**（`process/classify.ts`，配合
  `process/CommandIntent.ts` 解析命令自身的文本）。进程活得比命令久、会自己
  生进程、是命令点名的主体（`./daemon.sh`、`python train.py`）、被命令放到
  后台或重定向、或从工作区运行时，它是 `primary`。它来自工具目录，或者只是
  *ephemeral*——几十毫秒内消失且没有孩子——时，它是 `tool`，这在不维护任何
  目录清单的情况下抓到所有地方的帮手，比如 Pi 自己的 `fd.exe`。透明的启动器
  （`nohup`、`setsid`、`time`、`env`）被穿透，它启动的孩子才是 egg。
  `process/priors.ts` 里的名字先验只是平票时的裁决，从来不是判决——活得比
  命令久的 `cat` 依然是 primary。eggs 面板列出 primary、把 tool 折成计数；
  Activity 和 Report 应用同样的过滤。有一个平台差异对归属很重要：Linux 上
  进程可以原地 `exec`，所以 `nohup node ticker.mjs` 在同一个 pid 下上报两次
  ——一次是 `nohup`，一次是 `node`。所以 pid 单独不能表示"已处理过"；观察器
  以 **(pid, 命令行)** 对为键，第二个事件按它本来的新进程来判。Pi 保留自己的
  会话文件（这样对话可以恢复），Daze 把它观察到的 `DazeEvent` 流归档在旁边。
- `apps/web` — React + Vite + Tailwind + Zustand + Monaco + Framer Motion。
  面板是入口，Stage 是内容的归宿；Daze Report 和 Agent Eggs 都是对同一条事件
  流的归约。

```
daze/                     npm workspaces: packages/*  apps/server  apps/web
  dist/                   全部构建产物（git 忽略），一个地方：
    web/                    构建好的 UI（apps/web → vite outDir）
    desktop/build/          server bundle + 就位的生产 node_modules
    desktop/release/        打包出的应用（便携目录 / 安装器）
  tsconfig.base.json      strict, noUncheckedIndexedAccess
  native/agentwatch/      Windows 进程观察器（Job Object，预编译随库提交）
  native/agentwatch-linux/ Linux 进程观察器（eBPF，预编译随库提交）
  start-daze.bat          以下启动器的转发快捷方式
  start-daze-app.bat      （每个只有一行——真正的逻辑在被启动的代码那边，
  start-daze.sh            不在根目录）
  scripts/
    browser/start-daze.bat  Windows 浏览器启动器
    browser/start-daze.sh   Linux / WSL 浏览器启动器
    checks/               check-*.ts 验收脚本
    wsl-pi-config.sh      让 WSL 里的 pi 指向 Windows 宿主的模型服务

apps/desktop/             Electron 外壳（不是 workspace；自己的 node_modules）
  main.cjs                在进程内跑 server，开窗口，托盘
  start-daze-app.bat      Windows 桌面启动器
  assets/tray.png         托盘图标
  scripts/                仅桌面使用的构建工具：
    bundle-server.mjs       把 server + core 编成一个 CJS 文件
    stage-desktop.mjs       打包 + 为打包安装生产依赖
    make-icons.mjs          画 icon.png / icon.ico / tray.png

packages/core/src/        events.ts（DazeEvent + payload map）  types.ts  index.ts

apps/server/src/
  agents/                 AgentAdapter.ts（运行时无关的边界）
                          PiAdapter.ts  MockAdapter.ts  createAdapter.ts
  process/                DazeShell.ts（拥有 shell）  ProcessWatcher.ts（eggs）
                          ProcessTable.ts（pid / ppid / 命令行 / 启动时间）
                          observer.ts（平台中立的事件形状）
                          JobMonitor.ts + JobSidecar.ts（Windows 内核事件）
                          EbpfObserver.ts（Linux 内核事件）
                          CommandIntent.ts + classify.ts + priors.ts（primary/tool）
  sessions/               SessionStore.ts  archive.ts（~/.daze/sessions）
  filesystem/             FileTree.ts  FileWatcher.ts（chokidar）
  events/                 EventBus.ts
  websocket/ws.ts   api/{projects,sessions}.ts   util/{diff,ids,language,paths}.ts
  config.ts  index.ts

apps/web/src/
  app/App.tsx
  components/
    layout/               外壳：SessionBar  LeftRail  Stage  RightRail
    stage/                内容的去处：DeskStage  FileStage  DiffStage
                          TerminalStage  ThoughtStage  ProcessStage
                          StageWorld（桌子）  StageToolbar  ReplayBar
                          StageItemView.tsx  ReportOverlay.tsx（Daze Report）
    agent/                Avatar.tsx（Heti 角色）  AgentPanel.tsx
                          AgentFolder.tsx  heti.css（生成）
    eggs/                 AgentEggsPanel.tsx（primary；tool 折叠；running /
                          dead / all）
    files/  history/  activity/  chat/  ProjectPicker/  common/  Panel.tsx
  stores/                 session  file  stage  replay  chat  ui  reset
  hooks/                  useSessionSocket  useStage  useReplay  useNow
  lib/                    events（事件 → Stage 项 / Activity 行）
                          report（Daze Report 引擎）   eggs（进程 → eggs）
                          replay  history  context  commands  agent  format  …
  types/                  stage  history  replay  report  chat  file
  index.css

apps/web/public/heti/     头像的 PNG 部件（16：body, head, hair, ahoge,
                          tail, hands, feet, 7 张脸）

scripts/                  make-demo.mjs  wsl-pi-config.sh
  browser/                start-daze.bat  start-daze.sh（浏览器启动器）
  checks/                 check-history.ts  check-report.ts  check-eggs.ts
                          check-classify.ts  check-agentwatch.ts  check-ebpf.ts
                          gen-heti-css.mjs（重新生成头像样式表）
```

## 环境要求

- Node.js **22.19+**（测过 24）和 npm。
- 可选：一个配置好的 Pi（跑一次 `pi` 并登录）作为真 agent。没有凭据时 DAZE
  退回 mock 运行时并明说（`degraded · mock`）。

## 安装与运行

```bash
npm install

npm run dev       # dev：web 在 :5173（代理 /api 和 /ws），server 在 :8848
npm run build     # 构建 web 应用
npm start         # 单源——server 在 :8848 上伺服构建好的应用

npm run desktop:install   # 一次——Electron 外壳，在 apps/desktop
npm run desktop           # 同一个应用，以原生窗口打开（见下）
```

然后输入项目路径（或选一个），选运行时，点 **Open**，在 Stage 底部的聊天框里
给 agent 发任务。路径框下面的 **History** 列表展开保存的会话——DAZE 自己的
归档合并 Pi 的，最新在前；输入路径可以过滤，点一行重新打开那段对话。

### 桌面外壳（原生窗口）

DAZE 可以作为原生应用运行而不是浏览器标签页。`apps/desktop` 是一个 Electron
外壳，以**独立进程**运行 server——没有 spawn 的子进程，没有控制台窗口，
`port: 0` 让操作系统挑一个空闲端口，没有要配置的东西也不会冲突。窗口随后
加载浏览器会加载的同一个构建好的 web 应用；UI 没有被分叉。

```bash
npm run build           # 外壳伺服 dist/web
npm run desktop:install # 一次——安装 Electron（自己的 node_modules）
npm run desktop         # 打开原生窗口
npm run desktop:dev     # DevTools 开；Vite dev server 在时就用它
```

在 Windows 上，仓库根目录的 **`start-daze-app.bat`** 一键完成所有事
（构建 → 缺外壳就装 → 开窗口）；加 `check` 是干跑。它只有一行，转发到
`apps/desktop/start-daze-app.bat`，桌面启动器真正住在那里。浏览器启动器
不变，对 WSL / eBPF 工作流仍然是正确的选择。

外壳比浏览器多出的东西：一个没有地址栏和标签页的单窗口、没有原生标题栏——
窗口由 `frame: false` 打开，最小化 / 最大化 / 关闭由页面自绘（`WindowControls`，
经 preload 的 IPC 桥驱动真实窗口），顶栏就是拖拽区域、托盘图标、关到
托盘让观察继续跑、没有端口。真正退出走托盘菜单（或 Ctrl+Q）；关窗口只是
隐藏。

三件需要知道的事：

- **Electron 必须捆绑 Node ≥ 22.19。** Electron 带自己的 Node，被拥有的
  运行时才是跑进程内 server 和 Pi 的东西——不是 `PATH` 上的 `node`。Pi 的包
  声明 `engines.node >= 22.19`，并从 `node:fs` 导入 `globSync`，这只在
  Node 22 之后存在。在旧的 Electron 上外壳能加载，然后静默退回 mock 运行时，
  显示 `Pi runtime unavailable`。截至撰写，Electron **37.x 捆绑 Node
  22.21.1**（Electron 33 捆绑 Node 20.18，太老）。升级 Electron 时，看发行
  说明里捆绑的 Node，别只看版本号。
- **Electron 单独安装**，装进 `apps/desktop/node_modules`（故意*不是*
  workspace 成员）。它带自己的 `tsx` + esbuild，这样 Windows 外壳永远不会捡
  到根 `node_modules` 里 Linux 构建的 esbuild——正是下面 WSL 一节警告的平台
  分裂。
- **桌面外壳和浏览器是同一个应用。** 浏览器里成立的（Replay、Daze Report、
  Agent Eggs）在窗口里都成立，因为是同一个 web 构建、通过同样的 `/api` 和
  `/ws` 对话同一个 server。

窗口也反映 agent 在干什么：运行进行中标题变成
`DAZE — <项目>（<状态>）`，运行结束回落到 `DAZE — idle`。运行结束而窗口没有
焦点时，一条原生通知说明这件事。托盘 tooltip 显示有几个会话在跑。浏览器（和
窗口）里 Daze 还会发声：两声铃，WebAudio API 合成，页面被交互过之前静音。
**完成铃**在运行带着活动结束时响（中止不响）；**关注铃**在实时人工关注等级
跨入或跨出 medium/high 时响——high 是急促的三声，medium 是柔和的两声。

### 打包可分发的应用

`apps/desktop/start-daze-app.bat` 从 checkout 运行外壳，这需要磁盘上有仓库、
`node_modules` 和 `tsx`。要把 DAZE 变成能交给别人的东西——一个没有仓库、
没有 Node 的安装器——用打包脚本：

```bash
npm run desktop:dist   # 构建 web、就位 server、产出安装器
npm run desktop:pack   # 同样，但输出未打包目录（更快，没有安装器）
```

Windows 上会往 `dist/desktop/release/` 写一个 NSIS 安装器；Linux 是 AppImage，
macOS 是 DMG。有三件生成的产物值得知道（都在 `apps/desktop/scripts/` 下，
因为它们只属于桌面）：

- **`bundle-server.mjs`** 把 DAZE 自己的 server（和 `@daze/core`）编成
  `dist/desktop/build/server.cjs`。发货的应用没有 `tsx`，TypeScript 无法在
  运行时加载。第三方包保持 *external*，从一个裁剪过的 `node_modules` 解析
  ——尤其是 `@earendil-works/pi-coding-agent`，它带一个 `.wasm` 资产并动态
  加载自己的部分，打包它会弄坏它。
- **`stage-desktop.mjs`** 运行那个 bundle，并把 server 的生产依赖
  （`npm install --omit=dev`）装进 `dist/desktop/build/node_modules`。它是
  全新安装而不是过滤根 `node_modules`——后者在 checkout 同时被 WSL 和
  Windows 使用时会把平台混在一起。结果就是 electron-builder 拷贝到
  `resources/node_modules` 的东西。
- **`make-icons.mjs`** 往 `apps/desktop/assets/` 画 `icon.png` / `icon.ico` /
  `tray.png`——没有图像库，没有提交的二进制生成步骤。生成的图标还是提交的，
  这样全新的 clone 不用这一步也能构建。

打包后的应用在 `process.resourcesPath` 下找它的部件（见 `main.cjs`）：
`apps/server-bundle.cjs`、`dist/web`、`node_modules`，以及 `native/` 下的
原生 helper。原生观察器路径用 `DAZE_AGENTWATCH` / `DAZE_AGENTWATCH_LINUX`
显式设置，因为 server 自己的路径启发假设的是 checkout 布局。

### 一键启动器（Windows）

双击仓库根目录的 **`start-daze.bat`**：构建 web 应用、启动 DAZE server、
打开 UI。它转发到 `scripts/browser/start-daze.bat`，浏览器启动器真正住在
那里。web 应用每次都会重新构建：server 只伺服 `dist/web`，不重新构建的话，
无论 `src` 里改了什么，你看到的都是一次陈旧的构建。

```bat
start-daze.bat            :: 构建并启动（转发到 scripts\browser\）
start-daze.bat check      :: 干跑——报告会发生什么，什么都不启动
```

幂等：已经在监听的 DAZE server 不动。用 `DAZE_PORT` 和 `DAZE_AGENT` 覆盖。
关掉 spawn 出来的 `DAZE server` 窗口即停止。

### 一键启动器（Linux / WSL）

仓库根目录的 **`start-daze.sh`** 在 Linux 和 WSL 上做同样的事：转发到
`scripts/browser/start-daze.sh`，后者在 eBPF 观察器缺失时构建它、配置 WSL
里的 pi、重建 web 应用、启动 server、打开 UI。WSL 上装了 `wslview` 的话，
Windows 浏览器通过它打开。

```sh
./start-daze.sh            # 构建并启动（转发到 scripts/browser/）
./start-daze.sh check      # 干跑——报告会发生什么，什么都不启动
```

#### WSL 里的 pi

Daze 把 pi 嵌在**自己的进程里**（SDK，不是 `pi` 命令），所以 Daze 跑在 WSL
时，pi 也跑在 WSL，它的 shell 工具是 Linux 的——`/bin/bash`，没有 Git Bash，
没有 MSYS 的 pid 分裂。有两件事要满足：

1. **Linux 的 pi，不是 Windows 的。** 装进 WSL：

   ```sh
   npm install -g @earendil-works/pi-coding-agent
   ```

   不装的话，`which pi` 找到的是 `/mnt/c/…` 下的 Windows 安装，那是一个
   Windows 脚本。

2. **Provider 指向 Windows 宿主。** 绑定在 Windows 回环上的模型 server 从
   WSL 里以 `127.0.0.1` 是**够不到**的——WSL 里那个地址是 WSL 自己。Windows
   宿主是默认路由的网关：

   ```sh
   ip route show | grep -i default | awk '{ print $3 }'
   ```

   `scripts/wsl-pi-config.sh` 从 Windows 的 pi 配置拷贝 `models.json`，把每个
   `127.0.0.1` / `localhost` 主机改写成那个网关。
   `scripts/browser/start-daze.sh` 每次启动都跑它，因为 WSL 重启后地址会变。
   要指向别的来源，把 `DAZE_WIN_PI_DIR` 设成 Windows 的 `.pi/agent` 目录。

两者就位后，WSL 里的 `pi --list-models` 显示和 Windows pi 相同的 provider，
会话的 bash 工具跑成一个 eBPF 观察器看得见的 Linux 进程。

#### 与 Windows 共用 checkout

仓库在 Windows 盘上（`/mnt/…`）且 Windows 和 WSL 都用时，`node_modules` 是
**平台相关的**（esbuild 每个平台带一个原生二进制），一个目录没法同时伺服
两边。在这里安装会替换掉 Windows 的那个。如果你两边都开发，留一个 Windows
checkout 和一个 WSL checkout，或者切换时用
`rm -rf node_modules && npm install` 重装。

## 配置

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `PORT` | `8848` | Server 端口 |
| `HOST` | `127.0.0.1` | Server 主机 |
| `DAZE_AGENT` | `pi` | 默认运行时：`pi` 或 `mock` |
| `DAZE_PROJECTS_ROOT` | `~/projects` | 项目选择器列出的目录 |
| `DAZE_PI_TOOLS` | `read,bash,edit,write,grep,find,ls` | 启用的 Pi 内建工具。`bash` / `powershell` 由 Daze 自己的 shell 提供（见架构），这正是进程可被观察的原因 |
| `DAZE_LOG_LEVEL` | `info` | Fastify 日志级别 |
| `DAZE_STATE_DIR` | `~/.daze` | Daze 归档会话历史的位置 |

## DazeEvent

核心 UI 只认识一种结构：

```ts
type DazeEvent = {
  id: string;
  sessionId: string;
  timestamp: number;
  type:
    | "agent_start" | "agent_end" | "message"   | "thinking"
    | "tool_start"  | "tool_update" | "tool_end"
    | "file_read"   | "file_write"  | "file_edit" | "file_change"
    | "command"     | "search"      | "error";
  payload: unknown;
};
```

对原始 v0.1 规约的三个扩展：

- **`search`** — Pi 的 `grep` / `find` / `ls`，所以搜索可见。它经终端视图渲染
  （"agent 跑了点什么"只有一个输出面）。
- **`file_change`** — 文件监视器的原始活动，给 agent 自己的工具（bash、
  sed、…）之外的改动用。
- **`process`** — agent 培育的一个 OS 进程，由进程观察器报告（见 Agent
  Eggs）。

上下文用量、状态、模型和文件树走单独的 `session_state` websocket 消息，所以
事件联合保持干净。

## HTTP / WS API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/projects` | 列出根目录下的项目（`?root=` 覆盖） |
| `GET` | `/api/sessions/history` | 保存的会话（Daze 归档 + Pi），最新在前；`?path=` 过滤 |
| `POST` | `/api/sessions` | `{ projectPath, agent?, resume? }` → 创建或重开会话 |
| `GET` | `/api/sessions/:id` | 会话快照（session、files、chat、events、tree） |
| `GET` | `/api/sessions/:id/events` | 事件历史 |
| `GET` | `/api/sessions/:id/file?path=` | 读项目文件（用户视角） |
| `POST` | `/api/sessions/:id/prompt` | `{ prompt }` → 发给 agent |
| `POST` | `/api/sessions/:id/abort` | 打断运行 |
| `GET` | `/api/sessions/:id/commands/:name/options` | 需要选择的命令的选项列表（`model`、`thinking`） |
| `POST` | `/api/sessions/:id/command` | `{ name, args? }` → 执行聊天命令 |
| `DELETE` | `/api/sessions/:id` | 释放会话 |
| `WS` | `/ws/sessions/:id` | `{type:"snapshot"}` 然后 `{type:"event"}` / `{type:"session_state"}` |

文件端点拒绝项目外的路径、拒绝非文件、上限 512 KB、拒绝二进制。

## 聊天命令

Stage 底部的 chat dock 兼作一个小终端。以 `/` 开头的行是命令；其他都是普通
prompt。输入框左侧的 `/` 按钮在上方打开可过滤的面板——↑/↓ 移动，Enter 或
点击执行，Esc 清除。

| 命令 | 作用 |
|---|---|
| `/model [provider/id]` | 列出并切换模型 |
| `/thinking [level]` | 显示或设置 thinking 级别 |
| `/compact [instructions]` | 压缩会话上下文 |
| `/name [name]` | 设置会话显示名 |
| `/session` | 显示会话信息和统计 |
| `/export [html\|jsonl]` | 把会话导出到 `~/.daze/exports/` |

切换模型是**会话级**的——Pi 的全局默认不动。结果作为系统消息打印回聊天并随
会话归档，所以恢复时会回来。

命令经运行时无关的 `AgentAdapter` 分发，所以换一个运行时只需实现这几个方法
（web UI 不变）。Pi 自己的内建斜杠命令住在它的交互式 TUI 里而不是 SDK，所以
这些被映射到 SDK 调用（`setModel`、`setThinkingLevel`、`compact`、
`setSessionName`、`getSessionStats`、`exportToHtml`/`exportToJsonl`）而不是
委托给 Pi。

## 本地模型

DAZE 只和 Pi 说话，Pi 和任何 OpenAI 兼容端点说话——所以本地模型不需要改代码、
不需要单独的启动路径。例：`E:\0down\ml\qwen3-4B` 里 `server_qwen.py` 伺服的
Qwen3-4B（流式 + 工具调用）。模型 server 手动启动，不由 DAZE 启动。

1. 启动模型 server：

   ```bat
   E:\0down\ml\qwen3-4B\serve_qwen.bat --port 8000
   ```

2. 在 `~/.pi/agent/models.json` 里向 Pi 注册：

   ```json
   {
     "providers": {
       "qwen-local": {
         "baseUrl": "http://127.0.0.1:8000/v1",
         "api": "openai-completions",
         "apiKey": "local",
         "models": [
           {
             "id": "qwen3-4b",
             "name": "Qwen3 4B (local)",
             "input": ["text"],
             "contextWindow": 40960,
             "maxTokens": 4096,
             "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
             "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens" }
           }
         ]
       }
     }
   }
   ```

3. （可选）在 `~/.pi/agent/settings.json` 里设为默认：

   ```json
   { "defaultProvider": "qwen-local", "defaultModel": "qwen3-4b" }
   ```

4. 用 `pi --list-models` 验证，然后启动 DAZE。

4B 的模型选工具并不可靠。`DAZE_PI_TOOLS` 可以收窄集合（如
`DAZE_PI_TOOLS=read,bash,edit,write`），练 UI 用 mock 运行时更合适。

## 测试

```bash
node scripts/make-demo.mjs [dir] [--force]   # 搭一个 demo 项目
npx tsx scripts/checks/check-history.ts      # 需要 server 在跑
npx tsx scripts/checks/check-report.ts       # Daze Report 引擎（不需要 server）
npx tsx scripts/checks/check-eggs.ts         # 进程检测（无 server，不 spawn）
npx tsx scripts/checks/check-classify.ts     # 命令意图 + primary/tool 切分
npx tsx scripts/checks/check-agentwatch.ts   # 内核进程观察器（Windows）
npx tsx scripts/checks/check-ebpf.ts         # 内核进程观察器（Linux）
node scripts/gen-heti-css.mjs                # 重新生成头像样式表
```

`npm run check:process` 把三个进程相关的 harness 一起跑。

`make-demo.mjs` 写一个小项目，形状让普通 prompt 练到每个面板：带行区间的读、
能跑的 `npm test`、给 agent 读的 `TODO.md`、以及留给删除 vs 截断情形的
`notes.txt`。mock 运行时真的跑它的 shell 命令，所以一次 mock 运行也会下一只
蛋——这就是没有 Pi 凭据也能练 Agent Eggs 面板的方法。

`check-history.ts` 对一个 live mock 会话跑 **56 项检查**：运行分组、每运行的
Activity 范围、确定的 stage 项 id、快照 seek、Stage 回到默认页、搜索→终端
映射、thinking 捕获（一条流式念头保持为一个 Stage 项，所以 replay 不会重新
挂载它）、两个独立的 FILE 槽位、读累积与缺口标记、逐版本记录、新建文件计数。

`check-report.ts` 是 Daze Report 引擎的纯 harness（无 server）：没有
`command` 事件的失败工具仍计为一次失败命令，recovery 只在中间还有活动时消费
一次失败，agent 的写入从不同时被计成观察到的改动，`created` 相对更早的运行，
phase 在 recovery 之后落到 `verifying`，Timeline 按事件顺序每个活动一个节点
带它的效果（一条流式念头保持一个节点，没结束的 shell 工具读成在跑的进程，
运行期间下的蛋成为 `LAID` 节点——还活着的蛋把关注抬到 high）。它还钉住了环路
规则：把读状态写回去是一次 `file_version_loop`、关注 medium，带缺口的读状态
永远不是环路基准，失败两次的同一条命令是一次带命令文本的 `command_retry_loop`，
失败一次不算环路，项目外的改动是一次 `outside_change`、低级关注、Timeline 上
标 `OUTSIDE`，而还在跑的蛋（high）压过项目外改动（low）。

`check-eggs.ts` 是进程检测的纯 harness（无 server，不 spawn 任何东西）：
命令窗口决定谁是候选，祖先链决定谁是我们的，Daze 放在自己 shell 上的标记
决定什么是管道，孤儿被拒绝而不是猜测，子树折叠到根并数出后代，eggs 面板把
重复的 pid 折成一个 egg，带 `running` / `dead` / `all` 过滤。

`check-classify.ts` 是 primary/tool 切分的纯 harness：命令的主体从文本读出
（`./daemon.sh`、`python train.py`、`powershell -File run.ps1`），内联解释器
仍是 tool，带重定向的查询工具不是主体，分类是结构性的——活得比命令久的
`cat` 是 primary，短命的 git-bash 帮手是 tool，工作区内的进程是 primary，
来自未知目录的 ephemeral 进程（Pi 自己 bin 里的 `fd.exe`）是 tool。

`check-agentwatch.ts` 真刀真枪地练 Windows 观察器：对着测试进程启动 helper，
驱动真实的 `ProcessWatcher`，断言短命的孩子全被抓到、带命令行、归属到培育它
的命令，而且 Daze 自己带标记的 shell 永远不是 egg。

`check-ebpf.ts` 对 Linux 观察器做同样的事：启动 `agentwatch-linux`，驱动真实
的 `ProcessWatcher`，断言短命的孩子全被抓到、带命令行、归属到培育它们的
命令。

## 注记与限制

- 会话**持久化到磁盘**，重启后还在。Pi 把模型的对话放在
  `~/.pi/agent/sessions/`；Daze 把它观察到的 `DazeEvent` 流放在
  `~/.daze/sessions/`（用 `DAZE_STATE_DIR` 覆盖）。选择器的 **History** 两种
  都能重开：Daze 的归档恢复 Stage、Activity、文件和聊天；Pi 的恢复模型上下文。
  只有 `pi` 运行时写 Pi 会话文件——`mock` 会话只从 Daze 的归档恢复。因为
  `~` 是平台的家目录，**Windows 和 WSL 保存各自的历史**：
  `C:\Users\<你>\.daze\sessions\` 和 `/root/.daze/sessions/`（或
  `/home/<你>/…`）。互相看不见。把 `DAZE_STATE_DIR` 指到同一个共享路径可以
  合并，但不要两边同时跑——归档是追加且重写文件头的，一个文件上两个写入者
  会写坏它。
- DAZE 是**观察者**。它从不驱动 agent；它在事件流之外读的唯一东西，是你明确
  要求打开的一个项目文件。
- Pi **没有删除工具**——删除必须走 `bash rm`。当 agent 改为写入空内容时，文件
  是*被截断，不是被删除*，DAZE 会标 **EMPTIED** 加字节数，让假删除一眼可见。
- **egg** 是 Daze 看到 agent 启动的进程。Daze 报告每棵新进程树的根，把后代
  折进 `+N` 计数；它*看穿*它驱动的 shell 和外面的启动器——靠命令上的标记精确
  识别——所以 agent 自己的 `bash daemon.sh` 和别的任何东西一样被报告。它从不
  杀任何东西。**Windows** 上 `native/agentwatch` 把 server 放进 Job Object，
  内核上报每次创建和退出；**Linux** 上 `native/agentwatch-linux` 挂 eBPF
  tracepoint 做同样的事。任何一种都没有采样下限，20 ms 的进程和任何进程一样
  被看见。其他平台上，或 helper 启动不了时，观察器退回快照，**采样有下限**：
  一次快照约 0.5 秒，所以活在 ~0.5 秒以下的可能漏掉。还有两条诚实的限制：从
  Daze 驱动的 shell 孤立出来的进程（命令返回后的 `npm run dev &`）不会被归属，
  因为把每个孤儿都认领进来会扫进机器上别处的无关进程；agent *绕过* shell 启动
  的进程——Windows 上走 WMI、计划任务或服务，Linux 上走别的 pid namespace——
  在加入 user-SID / namespace 回退之前看不见。端口和监听是最明显的下一个
  事实。
- Pi **没有 plan 概念**；Daze 曾从 `TODO.md` 读清单，那个面板现在是 Agent
  Eggs 面板。
- 头像是 **Heti** 角色（一个鲸鱼布偶装的人形），从 `apps/web/public/heti/`
  的 PNG 部件重建，经同一个 `AgentVisualState` 接口按状态摆姿势——
  `listening` 放松，`thinking` 思考，`speaking` 说话，`reading`/`searching`
  阅读，`editing` 书写，`running` 打字，`waiting` 打盹，`error` 慌张。它的
  样式表（`agent/heti.css`）由 `scripts/gen-heti-css.mjs` 从独立页面生成，并
  收纳在 `.heti-root` 之下，所以绝不会泄漏进应用的其他部分。Live2D 仍是
  v0.3 的事项。
- 桌子是 `daze-table.html` 的 SVG 世界（`stage/StageWorld.tsx`），作为 Stage
  的持久默认背景绘制；镜头框住当前动作触碰的对象，内容视图是它上面半透明的
  叠层。`DeskState` / `DeskItem` 存在但尚未被事件驱动。
