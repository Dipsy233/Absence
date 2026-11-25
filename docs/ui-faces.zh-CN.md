# 界面（face）

[English](ui-faces.md) | [简体中文](ui-faces.zh-CN.md)

本文描述 `apps/web` 中的 Web 界面：观测台、三个可切换 face、Drip 浮层、共享外壳，以及渲染各部分的组件。路径为仓库相对路径。

## 1. 入口与导航

`apps/web/src/app/App.tsx` 渲染以下两者之一：

| 条件 | 渲染 |
|---|---|
| 未打开会话 | 观测台（`components/Observatory/Observatory.tsx`） |
| 已打开会话 | 选中的 face，默认为 Monitor |

地址栏承载面板路径 `/s/<sessionId>`。在该 URL 上打开应用会恢复该面板；浏览器前进与后退在观测台与面板之间切换，无需重新加载。归档已删除的过期链接静默失败，留在观测台。

观测台在页面可见时每四秒轮询一次，分为两列：

| 列 | 内容 | 操作 |
|---|---|---|
| 正在运行 | 运行中的智能体：已监控会话与运行中目标，含通道、最近活动、事实数与首条 prompt | 点击一行开始监控并打开面板 |
| 历史 | 已归档会话与已退出转录，含 runtime、消息数与首条 prompt | 以只读回放方式打开归档，或删除它 |

运行中的行在回填期间显示 `backfilling…`，在保存的 checkpoint 与转录不匹配时显示 `transcript diverged; re-watch to continue`。没有逐行的停止控件：监控在面板内结束，面板的 `change` 按钮撤销租约并关闭实时会话；目标随后以可监控状态回到正在运行列，归档保留。

## 2. Face 与切换器

顶栏切换器包含三个按钮，每个对应 `apps/web/src/lib/viewMode.ts` 中的一个 `ViewModeSpec`。

| Face | 源码中的 intent | 布局 |
|---|---|---|
| Rounds | Light — the agent leads, the user follows | 桌面：角色、故事卡片、浮动窗口 |
| Monitor | Heavy — the run's traces on one screen | 三列：信息流、Stage、agent 栏 |
| Chart | The run is over — read what it amounted to | 整页报告 |

源码为每个 face 记录中文释义（查房陪诊、机器监护、病历报告）。切换器只显示英文 `name`。

`apps/web/src/app/App.tsx` 渲染 `apps/web/src/stores/viewModeStore.ts` 选中的 face。Monitor 是默认 face，也是任何无分支 mode 的兜底。持久化键为 `absence.viewMode`；旧版本写入的 `drip` 值解析为 Monitor。

## 3. 共享顶栏

`apps/web/src/components/layout/FaceBar.tsx` 为所有 face 渲染同一个顶栏。从左到右：

| 元素 | 内容 |
|---|---|
| 时钟 | 当前时间，每秒更新 |
| 会话卡 | agent runtime 与会话 id |
| 项目路径 | 会话的项目目录 |
| Drip 开关 | 输液袋图标；打开或关闭浮层卡片 |
| face 切换器 | Rounds、Monitor、Chart |
| context 计量 | 已用与总量 token，含进度条 |
| 连接标记 | `online` 或 `offline` |
| 设置 | 打开设置对话框 |
| `change` | 撤销监控租约，关闭实时会话并返回观测台 |
| 窗口按钮 | 仅桌面壳 |

顶栏不承载 run 内容。run 属于 face。

## 4. Drip

Drip 是切换器旁的开关，不是 face。状态为 `viewModeStore.drip`，不持久化。开启时在当前 face 上方打开浮动窗口，底下的 face 保持挂载。

- 桌面壳：第二个置顶透明窗口以 `?face=drip&session=<id>` 加载同一应用并挂载 `DripDesktop`。除胶囊与卡片区域外，窗口点击穿透。
- 浏览器：`DripPipHost` 打开 Document Picture-in-Picture 窗口，复制文档样式并镜像 `theme-*` / `scheme-*` 类。PiP 不可用或被阻止时，组件在页面内渲染。
- 内容：`DripUI` 绘制胶囊与卡片。胶囊含头像与注意力圆点；在浮动宿主中另显示 `run #n · runtime`、已用时长与 `R/S/E/$` 计数。卡片含 run 的 prompt、`Open Absence`、运行中最新的八条实时事件，以及结束后的最终回复。

## 5. 源码位置

```text
apps/web/src/app/App.tsx                       外壳、socket、提示音、face 分支
apps/web/src/lib/viewMode.ts                   三个 face 及其 intent
apps/web/src/stores/viewModeStore.ts           选中的 face 与 Drip 开关
apps/web/src/components/Observatory/           观测台
apps/web/src/components/layout/FaceBar.tsx     共享顶栏

apps/web/src/ui/monitor/
  MonitorUI.tsx        三列布局与 ⏎ 约定
  MonitorLeft.tsx      Activity / Files / Attention 标签、run 选择器
  MonitorStage.tsx     Stage 页面、pin bar、时间线
  MonitorRight.tsx     Agent Head、Usage、Agent Eggs、Agent Folder
  activityViews.ts     一个 pinned 事件的 file、diff 与 terminal 视图
  monitor.css          仅 Monitor 的布局规则

apps/web/src/ui/rounds/
  RoundsUI.tsx         桌面画布与窗口管理
  RoundsScene.tsx      角色与状态气泡
  RoundsStory.tsx      run 步骤的卡片链
  RoundsPeek.tsx       文件预览窗口
  RoundsDock.tsx       Files / Agent Folder / Agent Eggs / Run / Activity
  RoundsWindow.tsx     可拖拽、可缩放的窗口
  useRoundsData.ts     该 face 的单一派生
  rounds.css           仅 Rounds 的规则

apps/web/src/ui/chart/
  ChartUI.tsx          hero、KPI、列表、证据、时间线
  ChartTimeline.tsx    报告的车道时间线
  StatsKpiCards.tsx    四张累计 KPI 卡

apps/web/src/ui/drip/
  DripUI.tsx           胶囊与卡片
  DripPip.tsx          浏览器 Document PiP 宿主
  DripDesktop.tsx      桌面壳窗口

apps/web/src/components/stage/                  按事件类型渲染的 Stage 视图
apps/web/src/components/chat/ChatThread.tsx     对话，只读
apps/web/src/components/metrics/                Usage 与指标面板
apps/web/src/components/files/                  项目树与文件历史
apps/web/src/components/attention/              注意力提示
apps/web/src/components/common/SettingsDialog.tsx
apps/web/src/ui/shared/                         token、主题、原子组件、动效
```

## 6. Monitor

三列。

**左列**（`MonitorLeft.tsx`）有三个标签与一个 run 选择器：

| 标签 | 内容 |
|---|---|
| Activity | 按阶段分组的 run 事件，连续的 `process` 更新折叠为一行并计数 |
| Files | 该 run 读过、创建或修改的每个文件与数量 |
| Attention | 该 run 需要人处理的原因，读取自持久化的 run |

run 选择器列出会话的全部 run，切换时整个 face 一起切换。

**中列**（`MonitorStage.tsx`）显示 Stage，含 `Metrics` 与 `Chat` 两个页面标签，以及 pinned 活动视图：

| 状态 | 内容 |
|---|---|
| Following | 正在进行的动作；新事实到达时页面回到实时 |
| Pinned | 被点击行对应的活动；pin bar 标明该时刻并提供 `Back to live ⏎` |
| Replay | 页面按 run 自己的时钟推进；bar 报告回放偏移 |
| `Metrics` | 指标面板：会话、主机与选中 egg 的 CPU、内存与进程数 |
| `Chat` | 对话，只读，含角色标签与可选的 Markdown 渲染 |

焦点不在输入框、textarea 或 select 时，`⏎` 返回实时。点击当前标签同样返回实时。

Stage 按事件类型渲染一种视图：file、diff、terminal、thought、speech、process、error 与 approval。审批卡片只读，并说明该请求已在别处应答。

Stage 下方是时间线：Model、Tools、Shell 三条轨道，覆盖 run 的时长。点击节点即 seek；回放以 80 ms tick、0.25× 至 10× 推进。每段的宽度就是它自己的活动时长——思考结束于转录上报的生成结束，命令结束于工具上报的执行时长——模型思考时 Shell 轨道保持安静。

**右列**（`MonitorRight.tsx`）包含：

| 区段 | 内容 |
|---|---|
| Agent Head | 头像、状态词与一句当前状态的说明；LIVE/REPLAY 标记；注意力等级 |
| Usage | 来自共享 `components/metrics/Usage` 的 context 与成本汇总 |
| Agent Eggs | agent 启动的进程，可过滤，含运行时长、子进程数、资源入口与折叠的 helper |
| Agent Folder | agent 的文件，最新在前，可展开为版本；点击版本在 Stage 打开 |

## 7. Rounds

Rounds 把 run 渲染成桌面。

- 角色在左侧，带状态气泡。
- 对话作为壁纸线程浮在右侧，采用气泡布局：用户在右，agent 在左。
- 故事以卡片链横跨宽度，每个 run 步骤一张；点击卡片即 seek。
- 底部 dock 以浮动窗口打开 Files、Agent Folder、Agent Eggs、Run 与 Activity。窗口可拖拽、可缩放；从窗口内部打开的窗口使用更小的尺寸。
- run 运行期间，agent 的动作会打开一个活动窗口。

## 8. Chart

Chart 是单个 run 或会话全部 run 的 Absence Report。

| 元素 | 内容 |
|---|---|
| Hero | 标题、run 选择器（含 `all runs`）、runtime、时长、活动数、开始与结束 |
| KPI 行 | 八张卡片：Knows、Changes、Executions、Attention，随后是所选范围的 Run count、Events、Errors 与估算 token |
| 时间线 | 报告的车道时间线；点击节点显示其证据 |
| 侧栏 | 标签：Changes、Executions、Knows、Tool calls、Errors、Attention |
| run 选择器 | `all runs` 把对象从单个 run 扩展为会话的全部 run |
| 证据预览 | 选中节点的 Stage 视图 |
| 输入与输出 | run 的请求（prompt）与回复（最终回复） |

报告由 `apps/web/src/lib/report.ts` 在客户端计算，是对 run 事件的确定性归约。它不调用模型，不解析命令语义。缺失的退出码显示为未知。

## 9. 设置

对话框有四个面板：

| 面板 | 控件 |
|---|---|
| Appearance | 语言、风格（`nixie` / `ink` / `glass`）、色系（`dark` / `light`）、对话 Markdown 渲染 |
| Report | 注意力阈值：每个 run 的失败命令数、连续失败数、静默秒数、遗留进程、项目外改动 |
| Personalization | 头像皮肤管理器与声音集管理器 |
| Agent Eggs | helper 名称过滤与 egg 过滤 profile |

## 10. 键盘与指针

| 输入 | 效果 |
|---|---|
| `⏎` | 返回实时；焦点在输入框、textarea 或 select 时除外 |
| 点击行 | 在 Stage 上 pin 该活动 |
| 点击时间线节点 | 把回放游标 seek 到该节点 |
| 点击故事卡片 | 把回放游标 seek 到该卡片 |
| 拖拽窗口标题栏 | 移动窗口（Rounds） |
| 拖拽窗口角 | 缩放窗口（Rounds） |
