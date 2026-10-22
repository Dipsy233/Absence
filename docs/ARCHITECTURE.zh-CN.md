# 架构

Absence 内部实现的深入文档。介绍与使用方法见 [README](../README.zh-CN.md)。

```
Browser ──WebSocket──▶ Absence Server ──EventBus──▶ AgentAdapter ──▶ Pi (SDK, in-process)
   ▲                                                              ├─▶ Codex (app-server, JSON-RPC)
   │                                                              └─▶ DSH (dsh --profile acp, ACP/JSON-RPC)
   └──────────── AbsenceEvent stream (file_read / file_edit / command / …) ─┘
```

- `packages/core` — 共享的 `AbsenceEvent` + 领域类型。UI 认识的唯一词汇表；它
  永远不会知道 Pi、Codex 或 DSH 的存在。
- `apps/server` — Fastify + WebSocket。每个运行时是一个 `AgentAdapter`：
  `PiAdapter` 在进程内包装 Pi SDK，把 `AgentSessionEvent` 映射成
  `AbsenceEvent`；`CodexAdapter` 用 JSON-RPC 驱动 `codex app-server`，同样方式
  映射它的通知（`AppServerClient` 是传输层——选它而非 `codex exec --json`，因为
  app-server 带真实的 item id、call id 和时间戳）；`DshAdapter` 用 JSON-RPC/NDJSON
  驱动 `dsh --profile acp`（DSH 的自动化专用 Agent Client Protocol server，
  `DshClient` 是传输层）并映射它的 `session/update` 通知；`MockAdapter` 不需要
  凭据就能回放一段脚本化的运行；`chokidar` 监视项目的带外改动。**每个真实
  运行时里 Absence 都拥有 shell。** 对 Pi，`process/AbsenceShell` 包装 Pi 自己的
  本地 shell 操作，注册成自定义 `bash` / `powershell` 工具（自定义工具按名字
  遮蔽内建的，所以 `ABSENCE_PI_TOOLS` 不受影响）。对 Codex，`process/ExecServer`
  *就是* executor：Absence 起一个 loopback exec-server，用 `environment/add`
  注册并把 thread 固定到它，于是 Codex 把每条命令作为 `process/start` 交给
  Absence 去 spawn。对 DSH，每个 shell 工具调用打开一个 `ProcessWatcher` 窗口。
  无论哪种，Absence 都拥有命令边界，正是这个边界告诉
  `ProcessWatcher` 一条命令何时运行。Pi 用 `#` 注释给命令打标记；Codex 仅靠
  祖先链归因，而接管让这条链天然完整。`ProcessWatcher` 然后观察进程表。
  在 **Windows** 上它完全不采样：
  `native/agentwatch` 是一个小 helper，把 server 放进一个 **Job Object**，
  内核随后把每一次创建和退出实时上报。在 **Linux** 上它也不采样：
  `native/agentwatch-linux` 挂三个 eBPF tracepoint
  （`sched_process_fork/exec/exit` 外加 `sys_enter_execve` 拿 argv），从 ring
  buffer 上报同样的事件。活 20 毫秒的进程在两边都看得见——轮询永远看不见。
  在其他平台上，或 helper 启动不了时，观察器退回快照（Windows 上一次 CIM
  查询，其他平台 `ps`）。一个进程是 egg，当它出现在某条命令的窗口内、且祖先
  链能到 Absence；egg 报告在每棵新子树的根上，任何东西都不会被杀。
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
  会话文件（这样对话可以恢复），Absence 把它观察到的 `AbsenceEvent` 流归档在旁边。
- `apps/web` — React + Vite + Tailwind + Zustand + Monaco + Framer Motion。
  面板是入口，Stage 是内容的归宿；Absence Report 和 Agent Eggs 都是对同一条事件
  流的归约。

```
absence/                     npm workspaces: packages/*  apps/server  apps/web
  dist/                   全部构建产物（git 忽略），一个地方：
    web/                    构建好的 UI（apps/web → vite outDir）
    desktop/build/          server bundle + 就位的生产 node_modules
    desktop/release/        打包出的应用（便携目录 / 安装器）
  tsconfig.base.json      strict, noUncheckedIndexedAccess
  native/agentwatch/      Windows 进程观察器（Job Object，预编译随库提交）
  native/agentwatch-linux/ Linux 进程观察器（eBPF，预编译随库提交）
  start-absence.bat          以下启动器的转发快捷方式
  start-absence-app.bat      （每个只有一行——真正的逻辑在被启动的代码那边，
  start-absence.sh            不在根目录）
  scripts/
    browser/start-absence.bat  Windows 浏览器启动器
    browser/start-absence.sh   Linux 浏览器启动器
    checks/               check-*.ts 验收脚本

apps/desktop/             Electron 外壳（不是 workspace；自己的 node_modules）
  main.cjs                在进程内跑 server，开窗口，托盘
  start-absence-app.bat      Windows 桌面启动器
  assets/tray.png         托盘图标
  scripts/                仅桌面使用的构建工具：
    bundle-server.mjs       把 server + core 编成一个 CJS 文件
    stage-desktop.mjs       打包 + 为打包安装生产依赖
    make-icons.mjs          画 icon.png / icon.ico / tray.png

packages/core/src/        events.ts（AbsenceEvent + payload map）  types.ts  index.ts

apps/server/src/
  agents/                 AgentAdapter.ts（运行时无关的边界）
                          PiAdapter.ts  CodexAdapter.ts  CodexCommands.ts
                          DshAdapter.ts（DeepSeek Harness over ACP）
                          AppServerClient.ts（codex app-server JSON-RPC）
                          DshClient.ts（dsh ACP JSON-RPC/NDJSON）
                          PiBin.ts  CodexBin.ts（定位用户的运行时）
                          MockAdapter.ts  createAdapter.ts
  process/                AbsenceShell.ts（拥有 Pi 的 shell）  ProcessWatcher.ts（eggs）
                          ExecServer.ts（拥有 Codex 的 shell：exec-server）
                          ShellEnvironment.ts（Codex env_policy）  CodexShell.ts（去壳）
                          ProcessTable.ts（pid / ppid / 命令行 / 启动时间）
                          observer.ts（平台中立的事件形状）
                          JobMonitor.ts + JobSidecar.ts（Windows 内核事件）
                          EbpfObserver.ts（Linux 内核事件）
                          CommandIntent.ts + classify.ts + priors.ts（primary/tool）
  runtimes/config.ts      运行时路径（~/.absence/runtimes.json）
  sessions/               SessionStore.ts  archive.ts（门面）
                          storage/db.ts（SQLite ~/.absence/absence.db；sessions、events、runs）
                          storage/runs.ts（History 的增量 run 索引）
                          storage/legacyPaths.ts（~/.absence/sessions）
  filesystem/             FileTree.ts  FileWatcher.ts（chokidar）
  events/                 EventBus.ts
  websocket/ws.ts   api/{projects,sessions,runtimes,sounds,avatarSkins,eggFilter}.ts
                    util/{diff,ids,language,paths}.ts
  config.ts  index.ts

apps/web/src/
  app/App.tsx
  components/
    layout/               外壳：SessionBar  LeftRail  Stage  RightRail
    stage/                内容的去处：DeskStage  FileStage  DiffStage
                          TerminalStage  ThoughtStage  ProcessStage
                          ApprovalStage  StageWorld（桌子）  StageToolbar
                          ReplayBar  StageItemView.tsx  ReportOverlay.tsx（Absence Report）
    agent/                Avatar.tsx（WhaleBun 角色）  AgentPanel.tsx
                          AgentFolder.tsx  MediaAvatar.tsx（上传的皮肤）
                          whalebun.css（生成）
    eggs/                 AgentEggsPanel.tsx（primary；tool 折叠；running /
                          dead / all）
    files/  history/  activity/  chat/  ProjectPicker/  common/  Panel.tsx
  stores/                 session  file  stage  replay  chat  ui  settings  reset
  hooks/                  useSessionSocket  useStage  useReplay  useNow
                          useSounds
  lib/                    events（事件 → Stage 项 / Activity 行）
                          report（Absence Report 引擎）   eggs（进程 → eggs）
                          replay  history  context  commands  agent  format  …
  types/                  stage  history  replay  report  chat  file
  index.css

apps/web/public/whalebun/     头像的 PNG 部件（16：body, head, hair, ahoge,
                          tail, hands, feet, 7 张脸）

apps/server/src/process/
  egg-filters/            Agent Eggs 过滤配置文件（命名的 JSON 文件；分类器读
                          激活的那份；active.json 指向它）——在设置弹窗管理：
                          侧栏 `+` 新建空 profile（PUT 空名单，不改变激活项），
                          编辑后 Apply（PUT）保存并激活
  avatar-skins/           用户上传的形象皮肤（每个形象一个文件夹，文件名
                          <状态>.<扩展名>；active.json）——在设置弹窗管理，
                          通过 /avatar/<状态> 提供

scripts/                  make-demo.mjs
  browser/                start-absence.bat  start-absence.sh（浏览器启动器）
  checks/                 check-history.ts  check-report.ts  check-eggs.ts
                          check-classify.ts  check-agentwatch.ts  check-ebpf.ts
                          check-codex.ts  check-codexshell.ts  check-shellenv.ts
                          check-execserver.ts  check-fsdiff.ts
                          harness.ts  run-offline.ts（共享 harness + 统一 runner）
                          gen-whalebun-css.mjs（重新生成头像样式表）
```

### 桌面外壳（原生窗口）

Absence 可以作为原生应用运行而不是浏览器标签页。`apps/desktop` 是一个 Electron
外壳，以**独立进程**运行 server——没有 spawn 的子进程，没有控制台窗口，
`port: 0` 让操作系统挑一个空闲端口，没有要配置的东西也不会冲突。窗口随后
加载浏览器会加载的同一个构建好的 web 应用；UI 没有被分叉。

```bash
npm run build           # 外壳伺服 dist/web
npm run desktop:install # 一次——安装 Electron（自己的 node_modules）
npm run desktop         # 打开原生窗口
npm run desktop:dev     # DevTools 开；Vite dev server 在时就用它
```

在 Windows 上，仓库根目录的 **`start-absence-app.bat`** 一键完成所有事
（构建 → 缺外壳就装 → 开窗口）；加 `check` 是干跑。它只有一行，转发到
`apps/desktop/start-absence-app.bat`，桌面启动器真正住在那里。浏览器启动器
不变，仍然是浏览器使用场景的正确选择。

外壳比浏览器多出的东西：一个没有地址栏和标签页的单窗口、没有原生标题栏——
窗口由 `frame: false` 打开，最小化 / 最大化 / 关闭由页面自绘（`WindowControls`，
经 preload 的 IPC 桥驱动真实窗口），顶栏就是拖拽区域、托盘图标、关到
托盘让观察继续跑、没有端口。真正退出走托盘菜单（或 Ctrl+Q）；关窗口只是
隐藏。

三件需要知道的事：

- **Electron 必须捆绑 Node ≥ 22.19。** Electron 带自己的 Node，被拥有的
  运行时才是跑进程内 server 和 Pi 的东西——不是 `PATH` 上的 `node`。Pi 的包
  声明 `engines.node >= 22.19`，并从 `node:fs` 导入 `globSync`，这只在
  Node 22 之后存在。在旧的 Electron 上外壳能加载，然后会话以
  `pi runtime could not start` 失败（不再静默退回 mock），提示运行时不可用。
  截至撰写，Electron **37.x 捆绑 Node
  22.21.1**（Electron 33 捆绑 Node 20.18，太老）。升级 Electron 时，看发行
  说明里捆绑的 Node，别只看版本号。
- **Electron 单独安装**，装进 `apps/desktop/node_modules`（故意*不是*
  workspace 成员）。它带自己的 `tsx` + esbuild，这样 Windows 外壳永远不会捡
  到根 `node_modules` 里别的平台构建的 esbuild——正是跨平台共用
  checkout 时的平台分裂。
- **桌面外壳和浏览器是同一个应用。** 浏览器里成立的（Replay、Absence Report、
  Agent Eggs）在窗口里都成立，因为是同一个 web 构建、通过同样的 `/api` 和
  `/ws` 对话同一个 server。

窗口也反映 agent 在干什么：运行进行中标题变成
`Absence — <项目>（<状态>）`，运行结束回落到 `Absence — idle`。运行结束而窗口没有
焦点时，一条原生通知说明这件事。托盘 tooltip 显示有几个会话在跑。浏览器（和
窗口）里 Absence 还会发声：两声铃，WebAudio API 合成，页面被交互过之前静音。
**完成铃**在运行带着活动结束时响（中止不响）；**关注铃**在实时人工关注等级
跨入或跨出 medium/high 时响——high 是急促的三声，medium 是柔和的两声。Report
的**命令失败警告**（`command_failed`）默认在单次运行里失败命令达到 5 条时才
提升关注等级（等级 `low`）；**连续失败串**（`command_failure_streak`）在命令
一条接一条失败、中间没有成功、达到默认 3 条时触发（等级 `medium`）；
**activity time 告警**（`activity_stalled`）在运行中的会话超过默认 3600 秒
没有任何事件时触发（等级 `medium`）。阈值与警告等级（none / low / medium /
high）在设置弹窗的 REPORT WARN 栏可自定义，未恢复的失败始终是 *high*，
不受阈值影响。

### 打包可分发的应用

`apps/desktop/start-absence-app.bat` 从 checkout 运行外壳，这需要磁盘上有仓库、
`node_modules` 和 `tsx`。要把 Absence 变成能交给别人的东西——一个没有仓库、
没有 Node 的安装器——用打包脚本：

```bash
npm run desktop:dist   # 构建 web、就位 server、产出安装器
npm run desktop:pack   # 同样，但输出未打包目录（更快，没有安装器）
```

Windows 上会往 `dist/desktop/release/` 写一个 NSIS 安装器；Linux 是 AppImage，
macOS 是 DMG。有三件生成的产物值得知道（都在 `apps/desktop/scripts/` 下，
因为它们只属于桌面）：

- **`bundle-server.mjs`** 把 ABSENCE 自己的 server（和 `@absence/core`）编成
  `dist/desktop/build/server.cjs`。发货的应用没有 `tsx`，TypeScript 无法在
  运行时加载。第三方包保持 *external*，从一个裁剪过的 `node_modules` 解析
  ——尤其是 `@earendil-works/pi-coding-agent`，它带一个 `.wasm` 资产并动态
  加载自己的部分，打包它会弄坏它。
- **`stage-desktop.mjs`** 运行那个 bundle，并把 server 的生产依赖
  （`npm install --omit=dev`）装进 `dist/desktop/build/node_modules`。它是
  全新安装而不是过滤根 `node_modules`——后者在跨平台共用 checkout 时会把
  平台混在一起。结果就是 electron-builder 拷贝到
  `resources/node_modules` 的东西。
- **`make-icons.mjs`** 往 `apps/desktop/assets/` 画 `icon.png` / `icon.ico` /
  `tray.png`——没有图像库，没有提交的二进制生成步骤。生成的图标还是提交的，
  这样全新的 clone 不用这一步也能构建。

打包后的应用在 `process.resourcesPath` 下找它的部件（见 `main.cjs`）：
`apps/server-bundle.cjs`、`dist/web`、`node_modules`，以及 `native/` 下的
原生 helper。原生观察器路径用 `ABSENCE_AGENTWATCH` / `ABSENCE_AGENTWATCH_LINUX`
显式设置，因为 server 自己的路径启发假设的是 checkout 布局。

## Codex（`CodexAdapter`）

Pi 是内嵌的，所以 Absence 通过包装 Pi 的工具操作来控制 shell。Codex 是独立
进程，用它自己的协议驱动——观察路径也因此不同。

```
AgentAdapter
  └─ CodexAdapter ── AppServerClient ──(stdio JSON-RPC)── codex app-server
        │                                                     │
        │  environment/add(exe-server URL)                   │  process/start
        │  thread & turn environments ───────────────────────┘
        ▼
  CodexExecServer（loopback WebSocket，JSON-RPC）
        │  spawn(argv)  ← Absence 就是 executor
        ▼
  命令，作为 Absence 自己的子进程，位于 Job/eBPF 窗口内
```

- **传输** — `AppServerClient` 对 `codex app-server` 说换行分隔的 JSON-RPC。
  之所以用 app-server（而非 `codex exec --json`）：它带真实的 item id、call id
  和 `startedAtMs`/`completedAtMs`；SDK 的 `--json` 传输会重新生成 item id、
  丢掉 call id 和时间戳，命令的生命周期就无法与它拉起的进程配对。
- **shell 接管** — `CodexExecServer` 是 loopback 上的一个小 JSON-RPC 服务。
  `CodexAdapter.start` 起它、用 `environment/add` 注册，并放进 thread 的
  `environments`，于是 Codex 的每条命令都经它执行。它实现 `process/start`
  （spawn）、`process/read`/`write`、`process/terminate` 和 `process/signal`
  （interrupt），并驱动 `ProcessWatcher.begin/end`，让蛋的归因和 Pi 完全一致。
- **PTY** — `process/start` 带 `tty: true` 时通过 `node-pty`（Windows 上
  ConPTY）开真 PTY；否则普通管道。这与 Codex 一致——它默认管道，只在模型要求
  时分配 PTY。
- **环境** — executor 用请求的 `env_policy` 构建命令环境
  （`ShellEnvironment.ts`，忠实移植 Codex 的
  `shell_environment::create_env`），再让请求的稀疏 `env` 覆盖。
- **显示** — `CodexShell.ts` 去掉 Codex 的 shell 外壳（`pwsh -Command "…"`、
  `bash -lc "…"`、`cmd /c …` 和 UTF-8 前导），让命令和蛋显示模型实际写的东西。
- **审批** — Codex 的 `item/…/requestApproval` 服务端向客户端请求被呈现为
  `approval` 事件，由 `respondApproval` 应答（或按
  `ABSENCE_CODEX_APPROVAL_DECISION` 自动应答）。

## DSH（`DshAdapter`）

DSH（DeepSeek Harness）像 Codex 一样是独立进程，但它暴露的通道不同：一个
**自动化专用的 Agent Client Protocol server**，通过运行 `dsh --profile acp` 接入。

```
AgentAdapter
  └─ DshAdapter ── DshClient ──(stdio NDJSON, JSON-RPC)── dsh --profile acp
        │                                                      │
        │  session/update 通知 ───────────────────────────────┘
        │  session/request_permission（客户端回调）
        ▼
  AbsenceEvents (message / thinking / tool_* / file_* / command / process / approval)
```

- **传输** — `DshClient` 通过子进程 stdio 收发换行分隔的 JSON-RPC。ACP（Agent
  Client Protocol，Zed SDK 用的同一种线格式）把整个 turn 作为 `session/update`
  通知交出；stdout 完全属于 ACP，没有 TUI 可抓。
- **映射** — `agent_message_chunk` → `message`（流式），`agent_thought_chunk` →
  `thinking`，`tool_call`/`tool_call_update` → `tool_start`/`tool_end`，并根据
  工具名和参数派生出 `file_read`/`file_write`/`file_edit`/`command`/`search`，
  `usage_update` → 上下文用量。DSH 把 read 结果包在 `<path>…<content>NN: line…`
  里；适配器把它剥掉，让 `file_read` 像 Pi 一样只带纯文本。
- **Agent Eggs** — 每个 shell 工具调用（`pwsh` 等）打开一个 `ProcessWatcher` 窗口
  （`tool_call` 时 `begin`，`tool_call_update` 时 `end`），于是命令拉起的进程
  折叠成一个归给该命令的蛋。
- **审批** — DSH 的 `session/request_permission` 请求被呈现为 `approval` 事件；
  选中的 ACP option id 被回送。
- **MCP 调用** — 若工具名是 `mcp__<server>__<tool>` 形式，会额外发出 `mcp` 事件，
  在 Activity 和 Stage 上像其他运行一样显示（与 Pi、Codex 的呈现一致）。
- **定位 dsh** — `ABSENCE_DSH_BIN` / 保存的路径优先，然后是 DSH Desktop 安装，
  最后是 PATH 里的 `dsh`。`.cmd`/`.bat` 外壳会走 shell 执行（Windows 无法直接
  spawn）。

## Skills 与 MCP（`capabilities/`）

两者都是**跨运行时的格式**，不是某个厂商的功能，所以 Absence 统一做一次发现，
各适配器各自消费：

| | 格式 | 各运行时共同查找的位置 |
|---|---|---|
| Skill | 含 `SKILL.md` 的目录（`name` + `description` frontmatter，[Agent Skills](https://agentskills.io) 规范） | `~/.agents/skills`、`~/.pi/agent/skills`、`~/.codex/skills`、`~/.dsh/skills`、`<project>/.agents/skills`（向上直到 git 仓库根）、`<project>/.pi/skills` |
| MCP | 一个 `mcpServers` 条目（`command`/`args`/`env`，或 `url`/`headers`） | `~/.pi/agent/mcp.json`、`<project>/.pi/mcp.json`；Codex 的 `~/.codex/config.toml` `[mcp_servers.*]`（由一个小 TOML 读取器转换） |

`capabilities/discover.ts` 读这些文件，返回 `skills` + `mcpServers` + 诊断。
它不执行任何东西。`AgentAdapter.getCapabilities()` 把结果作为 `CapabilityState`
返回，随 `session_state` 推到前端。可写的那一半在 `capabilities/manage.ts`，通过
聊天输入框的 `/skill` 和 `/mcp` 命令访问（和 Pi、Codex 同一位置），详见
"Chat commands"。

各适配器怎么用：

- **Pi** — 关键细节：**`createAgentSession` 不会加载 CLI 的内置扩展。** 朴素地
  嵌入会丢掉 `mcp`、`codemode`、`tool_search`（于是 `mcp.json` 永远不会被读，
  `mcp__<server>__<tool>` 也永远不会存在），而 `~/.agents/skills` 这些位置只有
  CLI 的 package manager 才会走到。`capabilities/piResources.ts` 把它们补上：
  `DefaultResourceLoader.extensionFactories` 里放
  `createCodemodeExtension()`、`createToolSearchExtension()`、`createMcpExtension()`；
  发现的 skill 通过 `skillsOverride` 注入；只有 Codex 有的 server 用
  `pi.registerMcpServer` 注册。随后适配器调用 **`session.bindExtensions({})`**——
  MCP 扩展在 `session_start` 时才连接，而这个事件只有绑定了扩展才会触发。每个
  成员都做了探测，所以用户装的是更旧/更新的 Pi 时会退回原有行为，而不是启动失败。
  `ABSENCE_MCP=0` 可跳过 MCP 部分。
- **Codex** — Codex 自己读同样的文件，并通过它已经在说的 app-server 暴露两者：
  `skills/list` 与 `mcpServerStatus/list`。这两个请求成功时以它们为准（Codex 能
  解析 plugin skill 与分层配置）；文件扫描是旧版 app-server 的回退。
- **DSH** — 对 `<DSH_HOME>/skills` 做发现；它的工具调用（无论是否由 MCP 支撑）
  本来就以 `tool_call` 到来，照常渲染。

MCP 工具调用**不需要新的事件类型**：Pi 的 `createMcpExtension` 走正常的工具管线
注册工具，所以一次调用就是 `tool_execution_start` / `tool_execution_end`，工具名
为 `mcp__<server>__<tool>`，像 `read`、`bash` 一样进入 Activity。已连接 server 的
工具数来自运行时自己的注册表（`getAllTools`），所以面板上的 "connected / tools"
数字可以在一次运行中变化。

## 运行时路径（客户端，不是供应商）

Absence 不打包任何运行时。`agents/PiBin.ts` 和 `agents/CodexBin.ts` 解析要运行
什么并报告来源（`configured` / `env` / `global` / `path` / `bundled` / `none`）；
`runtimes/config.ts` 把覆盖持久化到 `~/.absence/runtimes.json`，可在项目选择器里
编辑。选中的运行时启动不了时（未安装、路径错），会话以清晰的错误失败——**不回退
到 mock 运行时**。

## AbsenceEvent

核心 UI 只认识一种结构——下面的事件联合。无论哪个运行时产生的更新，只有这些
类型会跨过 WebSocket：

```ts
type AbsenceEventType =
  | "agent_start" | "agent_end" | "message"   | "thinking"
  | "tool_start"  | "tool_update" | "tool_end"
  | "file_read"   | "file_write"  | "file_edit" | "file_change"
  | "command"     | "search"      | "process"   | "approval" | "error";
```

对原始 v0.1 规约的扩展：

- **`search`** — `grep` / `find` / `ls`，所以搜索可见。它经终端视图渲染
  （"agent 跑了点什么"只有一个输出面）。
- **`file_change`** — 文件监视器的原始活动，给 agent 自己的工具（bash、
  sed、…）之外的改动用。
- **`process`** — agent 培育的一个 OS 进程，由进程观察器报告（见 Agent
  Eggs）。
- **`approval`** — 运行时（Codex）向用户请求提权；记为一条 `APPROVE?` activity，
  在 Stage 上应答。

上下文用量、状态、模型和文件树走单独的 `session_state` websocket 消息，所以
事件联合保持干净。

## HTTP / WS API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/projects` | 列出根目录下的项目（`?root=` 覆盖） |
| `GET` | `/api/sessions/history` | 保存的会话（Absence 归档 + Pi），最新在前；`?path=` 过滤 |
| `POST` | `/api/sessions` | `{ projectPath, agent?, resume? }` → 创建或重开会话 |
| `GET` | `/api/sessions/:id` | 会话快照（session、files、chat、tree、run 摘要、最新 2,000 条事件；`?eventLimit=`） |
| `GET` | `/api/sessions/:id/runs` | History 的 run 摘要（不含事件 payload） |
| `GET` | `/api/sessions/:id/runs/:index/events` | 选中某个 run 时获取它的摘要和事件 |
| `GET` | `/api/sessions/:id/events?before=&limit=` | 持久化事件分页（`{ events, nextBefore, hasMore }`，页内按时间正序；`before` 是排他的 seq 游标） |
| `GET` | `/api/sessions/:id/file?path=` | 读项目文件（用户视角） |
| `POST` | `/api/sessions/:id/prompt` | `{ prompt }` → 发给 agent |
| `POST` | `/api/sessions/:id/abort` | 打断运行 |
| `GET` | `/api/sessions/:id/commands/:name/options` | 需要选择的命令的选项列表（`model`、`thinking`） |
| `POST` | `/api/sessions/:id/command` | `{ name, args? }` → 执行聊天命令 |
| `DELETE` | `/api/sessions/:id` | 释放会话 |
| `GET` | `/api/egg-filter` | Agent Eggs 过滤配置文件：列表、激活项及其名单 |
| `PUT` | `/api/egg-filter/:name` | `{ names, force? }` → 保存配置文件（覆盖/新建）并激活 |
| `POST` | `/api/egg-filter/:name/activate` | 激活已保存的配置文件 |
| `DELETE` | `/api/egg-filter/:name` | 删除配置文件 |
| `GET` | `/api/avatar-skins` | 形象皮肤：文件夹、激活项及其文件 |
| `POST` | `/api/avatar-skins/:name` | 创建空的形象文件夹 |
| `PUT` | `/api/avatar-skins/:name/files?status=&filename=` | 原始文件字节 → 存为该状态的动画（视频用 ffmpeg 转码） |
| `DELETE` | `/api/avatar-skins/:name/files/:status` | 清除一个状态 |
| `DELETE` | `/api/avatar-skins/:name` | 删除形象文件夹 |
| `POST` | `/api/avatar-skins/:name/activate` | 激活形象（空名 = 内置 WhaleBun） |
| `GET` | `/avatar/:status` | 激活形象在某个状态的媒体（支持 206 Range；404 = 未上传） |
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
| `/export [html\|jsonl]` | 把会话导出到 `~/.absence/exports/` |

切换模型是**会话级**的——Pi 的全局默认不动。结果作为系统消息打印回聊天并随
会话归档，所以恢复时会回来。

命令经运行时无关的 `AgentAdapter` 分发，所以换一个运行时只需实现这几个方法
（web UI 不变）。Pi 自己的内建斜杠命令住在它的交互式 TUI 里而不是 SDK，所以
这些被映射到 SDK 调用（`setModel`、`setThinkingLevel`、`compact`、
`setSessionName`、`getSessionStats`、`exportToHtml`/`exportToJsonl`）而不是
委托给 Pi。

