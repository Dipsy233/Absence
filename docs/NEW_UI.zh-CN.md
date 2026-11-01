# 新版 UI 说明 —— 四个 Faces

> 分支 `ui`。这份文档描述重构后的新版界面：四个命名的 face（Rounds / Monitor /
> Chart / Drip）。它回答三个问题：**每个 face 是什么、为什么
> 这样切、代码怎么组织**。先读这份，再读代码；交互细节的历史决策见
> [UI_FACES.md](UI_FACES.md)（Monitor 早期决策）与 [decoupling.md](decoupling.md)
> （观察器解耦的设计来源）。

---

## 1. 一句话总览

Absence 展示的是同一件事——一个 agent 在干活——但"合适的形状"取决于你为什么在看。
新版 UI 把界面切成四个以医院工作命名的 face：

| Face | 中文 | 给谁用 | 形态 |
|---|---|---|---|
| **Rounds** | 查房陪诊 | 跟着 agent 走 | 轻；avatar 领路，桌面隐喻，窗口随开随关 |
| **Monitor** | 机器监护 | 盯着、读 trace | 重；信息领路，三列满屏 |
| **Chart** | 病历报告 | 这轮跑完了 | 报告就是整页，时间线是脊柱 |
| **Drip** | 输液 | 你在做别的事 | 一张悬浮卡片（浏览器 PiP / 桌面壳置顶窗口），永远在顶 |

**Drip 不是第四个 face**：它是叠加在当前 face 上的开关（`viewModeStore.drip`），
不换页、不关底下的界面。所以切换器里只有三个按钮。

---

## 2. 演进脉络（git 历史）

新版 UI 是在这条分支上逐 face 长出来的，历史顺序大致是：

```
monitor → rounds → chart → drip → 共享层重构（本说明描述的现状）→ 删除 Classic
```

- **Monitor 先行**：`feat(monitor): ...` 系列建立了三列布局、`useMonitorData`
  单一派生、`.mon-root` 调色板和 `mon-*` 词汇表 —— 后来所有 face 的地基。
- **Rounds 随后**：`feat(rounds): ...` 数十个提交，从角色+气泡开始，长出
  dock、窗口系统、story 卡片链、live 活动页。
- **Chart 复用引擎**：`c732dbc feat(chart): read a run as a record` 起，报告页
  直接消费 Monitor 的事实引擎（`buildRunFacts`），`6665f2b` 把它搬进
  Monitor 的暗色调色板——从这一刻起"共享皮肤"成了显式需求。
- **Drip 最独立**：`feat(drip)/fix(drip)` 系列约 30 个提交，浏览器 PiP 窗口与
  桌面壳置顶窗口两套宿主，同一个 `DripUI`。
- **`77d1322`**：Attention 通告、一条顶栏（FaceBar）、Drip 开关进顶栏。
- **`234ccc4`**：共享层重构——`ui/shared/`、hooks 上提、派生统一、
  契约单源（`packages/core` 新增 `ws.ts`/`api.ts`），Chart 加对话条，
  设置入口进 FaceBar。
- **删除 Classic**：四个新 face 稳定后，切分前的旧布局连同专属组件
  （SessionBar/LeftRail/Stage/RightRail 等 17 个文件）与 classic 专用设置项
  （rail 面板排序、collapse-on-content）一起删除；Monitor 成为未知 mode 的
  兜底 face。

重构的直接动因：三个 face 各自手写同一批派生（eggs 计数、replay 当前行、
LIVE/REPLAY 判定、run 状态词），且互相从对方的目录里 import（rounds→monitor、
chart→monitor、旧 components→ui/monitor）。`git show 234ccc4 --stat` 里
+1636/−1258 的净减量大部分来自删重复。

---

## 3. 目录结构（现状）

```
apps/web/src/
  app/App.tsx                  壳：无 session → ProjectPicker；有 session → 按 mode 出 face
  lib/viewMode.ts              四个 face 的名字、意图、ready；localStorage 持久化
  stores/viewModeStore.ts      当前 mode + drip 开关

  ui/shared/                   ★ 共享层：任何 face 都可以用，但它绝不 import 任何 face
    atoms.tsx                    色调词汇（TONE_FOR_ROW/RUN_TONE）、Chip/Dot/Spark、
                                 相位词、注意力文案钩子
    shared.css                   --mon-* 调色板、mon-root/mon-shell/mon-bar、
                                 chip/dot/btn、termcard、模式开关、drip 开关、health 规则
    FaceChat.tsx                 一条 chat 输入条，chrome 是参数（FaceChatSkin）
  ui/monitor/                  Monitor face（monitor.css 只剩 Monitor 自己的 body）
  ui/rounds/                   Rounds face（rounds.css 建立在 shared.css 的词汇上）
  ui/chart/                    Chart face（chart.css 的 --ch-* 与 --mon-* 同源同值）
  ui/drip/                     Drip：DripUI（内容）+ DripPip（浏览器 PiP）+ DripDesktop（壳窗口）

  hooks/                       ★ 数据钩子层
    useMonitorData.ts            共享的 run 视图（monitor/rounds/chart 都读它）
    useEggs.ts                   eggs 唯一派生（rail 列表、rounds dock、badge 同源）
    useSessionSocket.ts          全 app 唯一的 new WebSocket
    useSelectedRun.ts / useRunAttention.ts / useStage.ts / useNow.ts …

  lib/                         ★ 纯派生层（可测试，无 React）
    history.ts                   run 分组、行构建（memoRunRows）、replayRowAt、
                                 playingState、feed 分组/折叠/锚点
    report.ts                    事实引擎（buildRunFacts）+ 报告渲染（renderRun/renderLive）
    metrics.ts                   指标派生（usageSummary 等）
    attention.ts                 注意力原因文案（唯一来源）
    api.ts                       全 app 唯一的 fetch

  stores/                      zustand：session/runs/metrics/file/stage/replay/chat/ui/settings

packages/core/src/             ★ 前后端共同编译的契约
  events.ts types.ts runs.ts metrics.ts files.ts knownLines.ts
  ws.ts                          WS 帧联合：SessionServerMessage / SessionClientMessage /
                                 TerminalServerMessage
  api.ts                         REST 载荷：RuntimeStatus、EggFilter*、AvatarSkin*、
                                 SoundSet*、FileContent、ResumeTarget
```

**依赖方向铁律**（`234ccc4` 之后 grep 可验证为零违反）：

```
ui/{monitor,rounds,chart,drip}  →  ui/shared, hooks/, lib/, stores/   ✓
ui/shared                       →  lib/, types/                        ✓（绝不反向）
lib/                            →  @absence/core, types/               ✓
apps/web                        →  apps/server：零                      ✓
apps/server                     →  apps/web：零                        ✓
两端共同指向                     →  @absence/core                       ✓
```

---

## 4. 数据流：一条链，没有旁路

```
server
  │  REST (apps/web/src/lib/api.ts —— 唯一 fetch 点)
  │  WS   (hooks/useSessionSocket.ts —— 唯一 new WebSocket 点)
  ▼
stores (zustand)   socket 帧扇出到 7 个 store；拉数据经 lib/api
  ▼
hooks              useSelectedRun → useMonitorData / useRoundsData
  ▼
faces              组件只吃 data prop，不做网络 IO、不碰 getState 之外的全局
```

要点：

- **socket 在 App.tsx 接线一次**，不 per-face。切换 face 不掉线、chime 不重响。
- **REST 拉取有守卫**：`runsStore.ensureLoaded(sessionId)` 是唯一的"空则拉一次"，
  三个调用方（monitor 左列、rounds Run 窗口、chart）不再
  各写一份条件判断。
- **帧契约受编译器约束**：`useSessionSocket` 的 `message` 标注为 core 的
  `SessionServerMessage`，server 的 `send()` 同样。新增帧两端不同步 = 两端同时
  编译错误。（重构前 client 手写了一份副本，里面还有一个 server 从不发送的
  `{type:"event"}` 死分支——这就是教训。）
- **replay 新鲜度是 store 的不变量**：`replayStore.refresh(events, label)` 负责
  判断快照是否落后、恢复光标与播放态；视图只调一行。

---

## 5. 各 Face

### Monitor（机器监护）—— 重的那个

三列：左（run 选择器 + 活动 feed / 项目树）、中（Stage：FILE/DIFF/TERMINAL/
METRICS/CHAT 页 + 世界线回放条）、右（agent、成本、Agent Folder、Agent Eggs）。

- **单一派生**：`useMonitorData` 是 run 事实的唯一来源，feed 的相位分组、
  顶栏的注意力 chip、rail 的判定读同一个对象，不可能互相矛盾。
- **live 跟随、pin 停留**：未钉住时 Stage 跟着 agent 走（`useLiveItem`）；
  点击行即钉住，⏎ 回 live。
- **feed 的阅读视图在 lib**：`groupFeedRows / feedAnchors / stripFeedAnchors`
  （lib/history）做相位分组、状态重报折叠、START/END 锚点剥离——组件只排版。
- 文件：`MonitorUI/MonitorLeft/MonitorStage/MonitorRight/MonitorChat`，
  `MonitorChat` 是 `FaceChat` 的 mon 皮肤包装。

### Rounds（查房陪诊）—— 轻的那个

桌面隐喻：角色站在左半屏，story 卡片链是时间；dock 在右缘开文件/文件夹/eggs/
run 窗口，live 活动页只在 agent 跑的时候自己弹出。

- 窗口是 Rounds 自己的（`RoundsUI` 管理开合/层叠），打开的是**记录**而非 Stage：
  点一个版本在窗口里看那份内容，不钉、不回放。
- **badge 与列表同源**：dock 上的 eggs 徽标和 eggs 窗口的列表都读 `useEggs`，
  helper 折叠口径一致（重构前 badge 数的是全部 eggs、列表数的是 primary，两边
  能对不上）。
- 文件：`RoundsUI/RoundsScene/RoundsStory/RoundsPeek/RoundsDock/RoundsWindow/
  RoundsChat/useRoundsData`。

### Chart（病历报告）—— 跑完之后

整页是一份病历：hero（结果/时长/活动数 + run 切换）、四个 KPI、时间线车道
（READ/EDIT/RUN/…）、证据列表，点任何数字/车道块跳到它背后的事件。

- **没有第二份引擎**：报告读 `useMonitorData.report`（内部 `renderRun(facts)`），
  与 Monitor 同一套事实，只是换成"读记录"的排版。
- **对话条**（`ChartChat`）：报告页滚动、输入条不滚，固定在底部；空报告页
  （"先给 agent 一个任务"）也带这条——那个页面上唯一该做的事就是发任务。
- 文件：`ChartUI/ChartTimeline/ChartChat`。

### Drip（输液）—— 你在做别的事

一张卡：当前轮次、耗时、R/S/E/$ 计数，点开成对话/预览。两个宿主：

- **浏览器**：Document PiP 窗口（`DripPip`，负责请求窗口、拷贝样式、按内容
  高度回传 resize）；
- **桌面壳**：第二个置顶窗口（`DripDesktop`，`?face=drip&session=<id>` 加载
  同一个 app，透明、可拖拽、点击穿透）。

两者都不含业务数据，全部透传给 `DripUI`。顶栏的 IV-bag 开关只管这个窗口的
显隐，从不换 face。

### Classic（旧版，已删除）

Classic 曾是切分前的布局（`SessionBar + LeftRail/Stage/RightRail` 三等分
rail + desk 世界），在重构期间作为"已知良好的回退"保留。四个新 face 稳定后，
它连同 17 个专属组件与 classic 专用设置项一起被删除。曾由它承载的共享件
（StageItemView、Avatar、ChatThread、FilePanel、MetricsDashboard、
SettingsDialog）在共享层重构时就已上移为真正的共享组件，不随它消失；
`localStorage` 里的旧 `viewMode=classic` 值会因 `isViewMode()` 校验失败自动
回落到 Monitor，无需迁移代码。

---

## 6. 共享层：face 之间靠什么协作

| 件 | 位置 | 说明 |
|---|---|---|
| 顶栏 | `components/layout/FaceBar.tsx` | 时间、termcard、项目路径、Drip 开关、face 切换器、context 仪表、online、**⚙ 设置、change**、窗口按钮。三个新 face 共用 |
| chat 条 | `ui/shared/FaceChat.tsx` | 同一个状态机（useChatInput）、同一个 `/` 面板、同样的 send/stop/run 三态；`FaceChatSkin` 是全部差异 |
| 原子/词汇 | `ui/shared/atoms.tsx` | `mon-chip--*` 色调、Chip/Dot/Spark、相位词、RUN_TONE/RUN_WORD |
| 调色板 | `ui/shared/shared.css` | `--mon-*` 单一来源 + `--desk-*` 桥（见下） |
| 成本面板 | `components/metrics/Usage.tsx` | monitor 右栏与 rounds eggs 窗口渲染同一个；派生在 `lib/metrics.usageSummary` |
| 设置 | `components/common/SettingsDialog.tsx` | 落在 face 根节点内（FaceBar 的兄弟节点），由 face 的 `--desk-*` 桥上皮肤 |

**`--desk-*` 桥**是整个复用策略的支点：Monitor/Rounds/Chart 复用的 desk 世界
组件（StageItemView、MetricsDashboard、SettingsDialog…）用 tailwind 的
`desk-*` 类书写，而 `shared.css` 在 `.mon-root` 下把这些 token 重新指向当前
face 的调色板——**复用的视图自动穿上 face 的皮肤，不需要 fork**。设置弹窗
因此必须渲染在 face 根节点内：portal 到 `document.body` 会逃出 `.mon-root`，
桥就失效了。

**调色板的边界**：monitor.css 只剩 Monitor 自己的 body（三列、feed、时间线、
chat dock、右栏）；所有跨 face 的类都在 shared.css。rounds.css 引用
`mon-*` 词汇但从不 import monitor.css。

---

## 7. 契约层（packages/core）

core 是纯类型 + 平台无关纯函数：无 Node API、无 React、无构建产物依赖。
双端 import，单一来源。

- **`ws.ts`** —— `SessionServerMessage`（snapshot/events/metrics/session_state/
  error）、`SessionClientMessage`（metrics_subscribe）、`TerminalServerMessage`
  （output/ended/unavailable/error）。事件批帧由 server 侧 50ms/200 条窗口
  合并（`websocket/ws.ts`），client 每 batch 只做一次 store 更新。
- **`api.ts`** —— 设置面板相关 REST 载荷。此前这些 shape 在 server 路由旁和
  client fetch 旁各写一份、靠人工同步。
- **`files.ts → types/file.ts`** —— web 的 `FileVersion` 是
  `Omit<FileVersionInfo, "path" | "knownLines">`，字段漂移从类型上不可能。

**有意保留的双模型**（不是漂移）：`types/history.ts` 的 `HistoryRun`
（客户端在滑动窗口内重建，`fromIndex/toIndex`）vs core 的 `RunSummary`
（服务端持久化序列号 run，`fromSeq/toSeq`）。

---

## 8. 设计决策速查

| 决策 | 为什么 |
|---|---|
| face 各自整页，共享的是顶栏+原子，不是布局组件 | 三个 face 的正确形状互斥（轻/重/报告），强行抽"布局框架"会制造假共享 |
| `ui/shared` 不 import 任何 face | 共享层被四个 face 依赖；反向 import 会形成环（重构前 `chart → FaceBar → ui/monitor` 就是这种链） |
| 派生放 lib，不放组件 | `replayRowAt`、`playingState`、`groupFeedRows` 都是纯函数；`scripts/checks/check-history.ts` 就在直接 import `lib/history` 测它的派生（75 条断言） |
| 一个 store 一份派生（useEggs、ensureLoaded、refresh） | 重复实现不仅费行数，还会口径分叉（badge 事件） |
| socket/chime 在 App.tsx 接线一次 | face 是页面，连接是窗口的 |
| Drip 是开关不是 mode | 它从不替换底下的 face；mode 切换器里没有它 |
| Monitor 是兜底 face | 未知/未就绪的 mode 一律回落到信息最全的一屏；`localStorage` 旧值由 `isViewMode()` 校验自动回落 |

---

## 9. 怎么改 / 怎么加

**给某个 face 加一段 UI**：先问这段 UI 是不是别的 face 也会用——是，放
`ui/shared`（组件）或 `lib/`（派生）；不是，留在 face 目录里。不要从别的
face 目录 import。

**改 WS / REST 契约**：先改 `packages/core/src/{ws,api}.ts`，两端编译器会
把没跟上的那一边标红。不要在 server 路由或 client fetch 旁再声明 shape。

**加一个新 face**：`lib/viewMode.ts` 加 `ViewModeSpec`；`App.tsx` 加分支；
目录 `ui/<name>/`，皮肤类名用 `--mon-*` token（在 shared.css 或自己的 css 里
消费，不定义新调色板）。键盘契约、socket 接线、数据钩子都是现成的。

**验证**：`npm run typecheck`（core / server / web 三个 workspace）→ `npm run build` → `npm run check:offline`
（离线检查套件，含 history/report/incremental/eggs/classify）。
