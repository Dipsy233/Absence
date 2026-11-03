# 界面（face）

[English](ui-faces.md) | [简体中文](ui-faces.zh-CN.md)

本文描述 `apps/web` 中的 Web 界面：三个可切换 face、Drip 浮层、共享外壳，以及渲染各部分的组件。文中说明每个元素是什么、显示什么、如何操作。路径以当前源码树为准。

## Face 与切换器

顶栏的 face 切换器包含三个按钮。每个按钮对应 `apps/web/src/lib/viewMode.ts` 中的一个 `ViewModeSpec`。

| Face | 源码中的 intent | 布局 |
|---|---|---|
| Rounds | Light — the agent leads, you follow | 桌面：头像、故事卡片、浮动窗口 |
| Monitor | Heavy — every trace on one screen | 三列：Activity、Stage、agent 栏 |
| Chart | The run is over — read what it amounted to | 整页报告 |

源码还为每个 face 记录了中文释义（查房陪诊、机器监护、病历报告）。切换器只显示英文 `name`。

`apps/web/src/app/App.tsx` 渲染 `apps/web/src/stores/viewModeStore.ts` 选中的 face。Monitor 是默认 face，也是任何没有分支的 mode 的兜底。持久化键为 `absence.viewMode`；旧版本写入的 `drip` 值会解析为 Monitor。

### Drip

Drip 是切换器旁的开关；face 切换器中没有它的按钮。其状态为 `viewModeStore.drip`。开启后，它在当前 face 上方打开一个浮动窗口；底下的 face 保持挂载并继续运行。关闭开关只关闭该窗口。Drip 从不作为 face 持久化。

- 桌面壳：第二个置顶透明窗口以 `?face=drip&session=<id>` 加载同一个应用，并挂载 `DripDesktop`。除球和卡片区域外，外壳让该窗口保持点击穿透。
- 浏览器：`DripPipHost` 打开 Document Picture-in-Picture 窗口，复制文档样式，并同步 `theme-*` / `scheme-*` 类。PiP 不可用或被阻止时，widget 在页面内渲染。
- 内容：`DripUI` 绘制 pill 与 card。pill 包含头像与注意力圆点。在浮动宿主中，它还包含 `run #n · runtime`、已用时长和 `R/S/E/$` 计数。card 包含 run 的 prompt、`Open Absence`、run 运行中的实时事件列表（最新八条）、run 结束后的最终回复，以及带 `Send` 或 `Stop` 的输入区。

## 源码位置

```
apps/web/src/app/App.tsx                       外壳、socket、提示音、face 分支
apps/web/src/lib/viewMode.ts                   三个 face 及其 intent
apps/web/src/stores/viewModeStore.ts           选中的 face 与 Drip 开关
apps/web/src/components/layout/FaceBar.tsx     共享顶栏

apps/web/src/ui/monitor/
  MonitorUI.tsx        三列布局与 ⏎ 约定
  MonitorLeft.tsx      Activity / Files / Attention 标签、run 选择器
  MonitorStage.tsx     Stage 页面、pin bar、世界线、输入行
  MonitorRight.tsx     AgentHead、Usage、Agent Eggs、Agent Folder
  MonitorChat.tsx      共享输入条的 Monitor 皮肤
  monitor.css          仅 Monitor 的布局规则

apps/web/src/ui/rounds/
  RoundsUI.tsx         桌面画布与窗口管理
  RoundsScene.tsx      头像与状态气泡
  RoundsStory.tsx      run 步骤的卡片链
  RoundsPeek.tsx       文件预览窗口
  RoundsDock.tsx       Files / Agent Folder / Agent Eggs / Run / Activity
  RoundsWindow.tsx     可拖拽、可缩放的窗口
  RoundsChat.tsx       共享输入条的 Rounds 皮肤
  useRoundsData.ts     该 face 的单一派生
  rounds.css           仅 Rounds 的规则

apps/web/src/ui/chart/
  ChartUI.tsx          hero、KPI、列表、证据、输入与输出
  ChartTimeline.tsx    报告的车道时间线
  ChartChat.tsx        报告的输入条
  chart.css            仅 Chart 的规则

apps/web/src/ui/drip/
  DripUI.tsx           pill 与 card
  DripPip.tsx          浏览器 Document PiP 宿主
  DripDesktop.tsx      桌面壳窗口
  drip.css             仅 Drip 的规则

apps/web/src/ui/shared/
  atoms.tsx            chip、dot、色调、run 状态词
  FaceChat.tsx         一条输入条，chrome 以皮肤传入
  Nixie.tsx            数字滚动与真空管渲染
  FaceRise.tsx         face 入场
  InkBoil.tsx          Ink 的线条沸腾滤镜源
  rideScroll.ts        贴边滚动条导轨
  shared.css           --mon-* 调色板、原子类、--desk-* 桥
  themes.css           全部风格与色系差异
  picker.css           项目选择器规则

apps/web/src/hooks/    useMonitorData.ts、useEggs.ts、useSessionSocket.ts、
                       useStage.ts、useReplay.ts、useSelectedRun.ts、
                       useRunAttention.ts、useAttentionNotices.ts
apps/web/src/lib/      history.ts、report.ts、events.ts、replay.ts、
                       metrics.ts、attention.ts、api.ts、uistyle.ts
apps/web/src/stores/   session、runs、files、stage、replay、metrics、ui、
                       chat、settings、uistyle、viewMode
```

## 顶栏（FaceBar）

`FaceBar` 由三个 face 共用。从左到右显示：

- `ABSENCE` 与每秒更新的时钟；
- `runtime · session id` 卡片；
- 项目路径；
- Drip 开关（`DripBagIcon`），紧挨在 face 切换器左侧；
- `Rounds / Monitor / Chart` 切换器；
- context 仪表：已用 token、进度条、总量；
- `online` 或 `offline` 连接 chip；
- `⚙` 设置、`Change`（离开当前会话）、窗口按钮。

顶栏说明当前打开的是哪个会话、它在哪个目录工作。run 的状态与时长属于 face：Rounds 放在桌面上，Monitor 放在 run 选择器里，Chart 放在 hero 中。

## Monitor

Monitor 在 `.mon-root` 内分为三列。

### 左列

三个标签：

- `Activity`：所选 run 的事件行。行按 phase 分组；连续相同动作折叠为一行并带 `×N` 计数；`START` 与 `END` 固定在滚动 feed 的上下。点击行把该事件放上 Stage。回放中点击是 scrub。右键菜单提供 `Open in Stage` 与 `Add event to Chat`。
- `Files`：从磁盘读取的项目树。右键菜单提供 `Inspect`、`Open in Stage`、`View History`、`View Diff`、`Add to Chat`、`Explain this`。
- `Attention`：报告中的注意力记录。点击一条会切到 `Activity`、聚焦对应事件行，并打开它的 Stage item。

标签上方是 run 选择器。收起状态显示 `#index · status — prompt` 与 `R/S/E/$` 计数。展开列表显示每个 run 的事件数、时长、开始时间、计数与 prompt。`Activity` 还显示每分钟事件脉冲，底部显示 run 状态、已用时长与活动数。

### 中央：Stage

页头显示 chip、标题、副标题与页面标签。页面标签只有 `METRICS` 与 `CHAT`（`TAB_LABEL` 中为 `Metrics` / `Chat`）。

活动页没有标签。它是默认页，渲染 feed、pin 或 replay 选中的时刻：

- replay：`replayStore.currentTime` 对应的 item；
- pinned：固定的 `StageItem`；
- following：agent 的当前动作，来自 `sessionStore.currentAction`；
- following 且没有当前动作：静止页。

静止页是 `stageStore.restingPage`，即读者最后选择的页面（`METRICS` 或 `CHAT`）。读者从未选择时为 `CHAT`。因此 run 结束后默认停在 `CHAT`。

页面通过 `StageItemView` 渲染一张卡片：`FileStage`、`DiffStage`、`TerminalStage`、`ThoughtStage`、`SpeechStage`、`ProcessStage` 或 `ApprovalStage`，取决于事件。`activityViews` 派生所选事件可用的读法（file、diff、terminal）；事件自身的 kind 决定显示哪一种。界面没有 FILE / DIFF / TERMINAL 切换条。

pin bar 出现在两种情况：

- 固定时刻：`Pinned at {time} — every panel shows this moment` 与 `Back to live ⏎`；
- 回放：`REPLAY` chip 与 `Replaying — the page follows the run's own clock, {time} in`。

底部是 run 的世界线：`Think`、`Files`、`Shell` 各一条 lane。只绘制有标记的 lane。块位于活动偏移处，宽度延伸到下一个活动。点击轨道会 seek；在 live 中第一次点击进入 replay。控件为 `‹`（后退一个活动）、`⏸`/`▶`、`›`（前进一个活动）、速度 chip（`0.25× / 0.5× / 1× / 2× / 5× / 10×`）、`◉`（回到 live）。

输入行为一行：`Ask about this moment, or / for commands`。它没有展开开关；对话是 Stage 的 `CHAT` 页。输入 `/` 打开命令面板。

### 右列

四个分区，用 hairline 分隔：

- `AgentHead`：88px 头像 tile、状态词（旁边是 `LIVE` 或 `REPLAY`）、一句状态说明、`attention · level`；
- `Usage`：当前 CPU 与内存、会话平均、峰值、sparkline 或 gauge；作用域跟随所选 egg；
- `Agent Eggs`：`running / dead / all` 过滤、搜索框（`name, command, pid…`），以及每个 primary 进程一行：名称、pid、命令、存活时长、子进程数。`▤` 按钮打开作用域为该 egg 的 `METRICS`。helper 折叠为计数与名称摘要。面板只读；
- `Agent Folder`：agent 读过、写过或编辑过的文件，按修改时间排序。每行显示最近三个版本 chip；展开后列出全部版本及其来源（`read` / `write` / `edit`）、完整性、行范围与时间。点击版本会在 Stage 打开它。

### 键盘

| 按键 | 动作 |
|---|---|
| `⏎` | 回到 live；焦点在 input、textarea 或 select 时不生效 |
| `Esc` | 关闭右键菜单或下拉菜单 |

没有打开报告的快捷键。`⌘R` / `Ctrl+R` 不打开报告；报告就是 Chart face。

## Rounds

Rounds 是 `.rounds-root` 内的桌面画布。

- `RoundsScene`：头像与其上方的状态气泡。气泡显示状态词和一行当前对象说明（`Reading {path}`、`Editing {path}`、`Running {command}`、`Reasoning`、`Watching {name}`、`Waiting for you`）。pin 或 replay 持有视图时，点击舞台回到 live。
- `RoundsStory`：run 的步骤横向卡片链，每个活动行一张卡。最前面的 `START` 对折叠为一张卡：用户 prompt 的卡片把模型作为 meta 行。`END` 保留自己的卡片。点击卡片在 live 时固定它，在 replay 时 seek 到它。页头显示 `LIVE` 或 `REPLAY`、run 序号与状态、步骤数、计数与 `Back to live`。
- 壁纸：采用气泡布局的 `ChatThread`，在故事上方的右侧透明渲染。
- `RoundsDock`：五个快捷入口。`Files`、`Agent Folder`、`Agent Eggs`、`Run`、`Activity`。徽标显示文件夹数、运行中的 egg 数与活动数。没有 `Metrics` 快捷入口：指标从 egg 行打开，作用域为该 egg。
- 窗口：`RoundsWindow` 可通过标题栏拖拽、通过角柄缩放、关闭，并按焦点堆叠。顶层窗口为 440×430；子窗口为 580×470。`FilePanel`、`Agent Folder`、`Agent Eggs`、`Run` 作为顶层窗口打开。文件内容、版本、事件、egg 指标作为子窗口打开。
- 实时活动窗口在 agent 忙碌、face 处于 live 且 run 处于 following 时自动打开。它显示带 Stage item 的最新行，并复用同一个窗口。`Activity` dock 图标或窗口的 `✕` 关闭它。pin 或 replay 持有视图时不显示。
- `AttentionStack`：左上角的通知卡片。点击卡片打开对应事件的窗口；没有 Stage item 的事件打开 `Run` 窗口。卡片可单独或全部关闭。
- `RoundsChat`：一条圆角输入行。slash 按钮在框内；agent 运行时只有 `Stop` 带填充。

在 Rounds 窗口中打开文件或版本属于阅读操作。它不固定 Stage，也不启动回放。

## Chart

Chart 是一页：所选 run 的 Absence Report。它读取 `useMonitorData.report` 与 `useMonitorData.facts`，与 Monitor 使用同一套事实。

- hero：应用图标、outcome chip、`run #{index}`、runtime、时长、活动数、headline、`Started` 与 `Ended` 时间，以及 run 切换器。
- 四个 KPI：`Knows`（文件数、context 中行数、搜索数）、`Changes`（文件数、`+additions / −deletions`、modified 与 created 计数）、`Executions`（命令数、succeeded、failed、unknown）、`Attention`（等级、触发数、high / medium / low）。
- 时间线：四条 lane，`Think`、`Read`、`Edit`、`Shell`。活动是标记，宽度延伸到下一个活动；egg 画成从 laid 到 died 的跨度。点击标记或列表行选中其证据；悬停预览指针下的时刻。
- 列表：`Changes`（modified、created、deleted、observed、项目外）、`Executions`（命令、退出码、失败、权限拒绝）、`Knows`（带行范围的读取、带命中数的搜索）。每行选中其证据。
- `Attention` 按钮：展开带逐条等级的原因列表。关闭时，窗格显示所选事件的预览，或提示选择块或行。
- 证据窗格：所选事件的 `StageItemView`，以及其效果行。
- 输入与输出窗格：`Request`（run 的 prompt）与 `Response`（最终回复）。
- 底部：`ChartChat`，固定在底部的共享输入条。

界面没有 FILE / DIFF / TERMINAL 切换条，也没有报告浮层。报告就是该 face。

## 共享外壳与数据流

- `App.tsx` 负责会话 socket 与提示音。切换 face 不会重连，也不会重响某个 run 的提示音。
- `useMonitorData` 是所选 run 的单一派生：事件、行、`RunFacts`、渲染后的报告、注意力、实时 headline。Monitor、Chart、Drip 读取它。Rounds 读取 `useRoundsData`，它使用相同的 store 与库。`buildRunFacts` 与注意力判定限制为 500ms；feed 行增量更新。
- 共享输入是 `ui/shared/FaceChat.tsx` 与 `components/chat/useChatInput`。每个 face 只提供皮肤：类名、占位文案，以及 slash 按钮是否在框内。`/` 面板、context chip、`Send` / `Stop` / `Run` 三态在各 face 中一致。
- 复用视图（`StageItemView`、`MetricsDashboard`、`FilePanel`、Markdown 渲染器、`SettingsDialog`）按 `--desk-*` token 书写。`.mon-root` 把这些 token 重新指向当前 face 的调色板。因此 `SettingsDialog` 必须渲染在 face 根节点内；portal 到 `document.body` 会逃出桥接范围。
- 两个文件视图：左侧 `Files` 标签是磁盘上的项目；右侧 `Agent Folder` 是 agent 记录过的版本。Rounds 通过 `Files` 与 `Agent Folder` 窗口提供两者。

## 项目选择器

没有会话时，`App.tsx` 渲染 `ProjectPicker`。它包含：

- `ABSENCE` 品牌与 `重新探测`；
- `项目路径` 输入与 `打开`；
- `最近` 项目列表；
- 本机发现行的 `Agent` 方格。每行显示 `可启动` / `缺适配器` / `需登录`、发现来源与路径、声明模型、认证状态、能力与安装提示。最后一格是 `+`，用于自定义 ACP 入口；
- 选中行的提示流：认证、模型来源、launch 覆盖、npx 临时下载；
- `历史` 会话；点击恢复；
- `自定义 ACP` 对话框：`id`、`label`、`command`、`args`、`env`、`cwd`。

选择器的区块标签在源码中是中文硬编码。选择器没有 launch line 编辑器，也没有 `allowNpx` 开关。

## 设置

`SettingsDialog` 是四栏横向弹窗：

1. `APPEARANCE`：语言、主题（`nixie` / `ink` / `glass`）、色系（`dark` / `light`）、聊天 Markdown 开关；
2. `REPORT WARN`：失败命令、连续失败、无活动、遗留 egg、项目外变化、循环的阈值与等级；
3. `Personalization`：`AVATAR SKIN` 在上，提示音组管理在下；
4. `EGGS FILTER`：服务端 egg 过滤档案，支持创建、编辑、应用、激活、删除，以及 `display in activity`。

外观规则见 [ui-style-interface.zh-CN.md](ui-style-interface.zh-CN.md)；头像皮肤见 [avatar-skin.zh-CN.md](avatar-skin.zh-CN.md)。

## 界面范围

- 回放重建文件内容、agent 状态与当前 Stage 动作。它不重建指标曲线或 Agent Eggs 面板。
- Agent Eggs 面板列出进程；它没有杀进程操作。
- 对比度、焦点、动效与控件状态底线见 [ui-style-interface.zh-CN.md](ui-style-interface.zh-CN.md)。