# UI faces

[English](ui-faces.md) | [简体中文](ui-faces.zh-CN.md)

This document describes the web interface in `apps/web`: the three switchable
faces, the Drip overlay, the shared shell, and the components that render each
part. It states what each element is, what it displays, and how it is operated.
Paths refer to the current source tree.

## Faces and the switcher

The face switcher in the top bar contains three buttons. Each button is one
`ViewModeSpec` in `apps/web/src/lib/viewMode.ts`.

| Face | Intent in source | Layout |
|---|---|---|
| Rounds | Light — the agent leads, you follow | Desktop: avatar, story cards, floating windows |
| Monitor | Heavy — every trace on one screen | Three columns: Activity, Stage, agent rail |
| Chart | The run is over — read what it amounted to | One full-page report |

The source also records a Chinese term for each face (查房陪诊, 机器监护,
病历报告). The switcher displays the English `name` only.

`apps/web/src/app/App.tsx` renders the face selected by
`apps/web/src/stores/viewModeStore.ts`. Monitor is the default and the
fall-through for any mode without a branch. The stored value is
`absence.viewMode`; a stored `drip` value from an older build resolves to
Monitor.

### Drip

Drip is a toggle beside the face switcher; it has no button in the face
switcher. Its state is `viewModeStore.drip`. Turning it on opens a floating
window over the current face; the face underneath remains mounted and live.
Turning it off closes only that window. Drip is never stored as a face.

- Desktop shell: a second always-on-top, transparent window loads the same app
  with `?face=drip&session=<id>` and mounts `DripDesktop`. The shell keeps the
  window click-through except over the pill and the card.
- Browser: `DripPipHost` opens a Document Picture-in-Picture window, copies the
  document styles, and mirrors the `theme-*` / `scheme-*` classes. When PiP is
  unavailable or blocked, the widget renders inside the page.
- Content: `DripUI` draws a pill and a card. The pill contains the avatar and
  an attention dot. In the floating hosts it also contains the current
  `run #n · runtime`, the elapsed time, and the `R/S/E/$` counts. The card
  contains the run prompt, `Open Absence`, the live event list (newest eight)
  while the run is running, the final reply when it has settled, and a composer
  with `Send` or `Stop`.

## Where things live

```
apps/web/src/app/App.tsx                       shell, socket, chimes, face branches
apps/web/src/lib/viewMode.ts                   the three faces and their intent
apps/web/src/stores/viewModeStore.ts           selected face and Drip toggle
apps/web/src/components/layout/FaceBar.tsx     the shared top bar

apps/web/src/ui/monitor/
  MonitorUI.tsx        three columns and the ⏎ contract
  MonitorLeft.tsx      Activity / Files / Attention tabs, run selector
  MonitorStage.tsx     Stage pages, pin bar, world line, input row
  MonitorRight.tsx     AgentHead, Usage, Agent Eggs, Agent Folder
  MonitorChat.tsx      the Monitor skin of the shared input bar
  monitor.css          Monitor-only layout rules

apps/web/src/ui/rounds/
  RoundsUI.tsx         desktop canvas and window manager
  RoundsScene.tsx      avatar and status bubble
  RoundsStory.tsx      run steps as a card chain
  RoundsPeek.tsx       file preview window
  RoundsDock.tsx       Files / Agent Folder / Agent Eggs / Run / Activity
  RoundsWindow.tsx     draggable, resizable window
  RoundsChat.tsx       the Rounds skin of the shared input bar
  useRoundsData.ts     the face's single derivation
  rounds.css           Rounds-only rules

apps/web/src/ui/chart/
  ChartUI.tsx          hero, KPIs, lists, evidence, input/output
  ChartTimeline.tsx    the report's lane timeline
  ChartChat.tsx        the report's input bar
  StatsKpiCards.tsx    the run scope's four cumulative KPI cards
  chart.css            Chart-only rules

apps/web/src/ui/drip/
  DripUI.tsx           pill and card
  DripPip.tsx          browser Document PiP host
  DripDesktop.tsx      desktop shell window
  drip.css             Drip-only rules

apps/web/src/ui/shared/
  atoms.tsx            chips, dots, tones, run words
  FaceChat.tsx         one input bar, chrome passed as a skin
  Nixie.tsx            scramble/tube number renderer
  FaceRise.tsx         face entrance
  InkBoil.tsx          Ink's line-boil filter source
  rideScroll.ts        border-riding scrollbar rail
  shared.css           the --mon-* palette, atoms, the --desk-* bridge
  themes.css           all style and scheme differences
  picker.css           project picker rules

apps/web/src/hooks/    useMonitorData.ts, useEggs.ts, useSessionSocket.ts,
                       useStage.ts, useReplay.ts, useSelectedRun.ts,
                       useRunAttention.ts, useAttentionNotices.ts
apps/web/src/lib/      history.ts, report.ts, events.ts, replay.ts,
                       metrics.ts, attention.ts, api.ts, uistyle.ts
apps/web/src/stores/   session, runs, files, stage, replay, metrics, ui,
                       chat, settings, uistyle, viewMode
```

## Top bar (FaceBar)

`FaceBar` is shared by all three faces. From left to right it displays:

- `ABSENCE`, and a clock that updates every second;
- a `runtime · session id` card;
- the project path;
- the Drip toggle (`DripBagIcon`), immediately left of the face switcher;
- the `Rounds / Monitor / Chart` switcher;
- the context meter: used tokens, a progress bar, and the total;
- an `online` or `offline` connection chip;
- `⚙` Settings, `Change` (leave the session), and the window controls.

The bar states which session is open and where it works. The run's status and
duration belong to the face: Rounds shows them on the desktop, Monitor in the
run selector, Chart in its hero.

## Monitor

Monitor is three columns inside `.mon-root`.

### Left column

Three tabs:

- `Activity`: the selected run's rows. Rows are grouped under phase headers;
  consecutive identical actions fold into one row with a `×N` count; `START`
  and `END` are pinned above and below the scrolling feed. Clicking a row puts
  that event on the Stage. In a replay a click scrubs to that event. The
  context menu offers `Open in Stage` and `Add event to Chat`.
- `Files`: the project tree, read from disk. The context menu offers `Inspect`,
  `Open in Stage`, `View History`, `View Diff`, `Add to Chat`, and
  `Explain this`.
- `Attention`: the report's attention records. Clicking one switches to
  `Activity`, focuses the event row, and opens its Stage item.

Above the tabs is the run selector. The closed state reads
`#index · status — prompt` and shows the `R/S/E/$` counts. The open list shows
each run's event count, duration, start time, counts, and prompt. `Activity`
also has an events-per-minute pulse and a footer with the run status, elapsed
time, and activity count.

### Centre: the Stage

The header displays a chip, a title, a subtitle, and the page tabs. The only
tabs are `METRICS` and `CHAT` (`Metrics` / `Chat` in `TAB_LABEL`).

The activity page has no tab. It is the default page and renders the moment
that the feed, a pin, or a replay selects:

- replay: the item at `replayStore.currentTime`;
- pinned: the pinned `StageItem`;
- following: the agent's current action, from `sessionStore.currentAction`;
- following with no current action: the resting page.

The resting page is `stageStore.restingPage`, which is the last page the reader
chose (`METRICS` or `CHAT`). It is `CHAT` when the reader has not chosen one.
`CHAT` is therefore the page a finished run rests on by default.

The page renders one card through `StageItemView`: `FileStage`, `DiffStage`,
`TerminalStage`, `ThoughtStage`, `SpeechStage`, `ProcessStage`, or
`ApprovalStage`, depending on the event. `activityViews` derives the
available readings of the selected event (file, diff, terminal); the event's
own kind decides which reading is shown. There is no FILE / DIFF / TERMINAL
switch strip.

The pin bar appears in two cases:

- a pinned moment: `Pinned at {time} — every panel shows this moment` and
  `Back to live ⏎`;
- a replay: a `REPLAY` chip and `Replaying — the page follows the run's own
  clock, {time} in`.

The footer is the run's world line: one lane each for `Model` (think and speak),
`Tools` (tool calls, including MCP), and `Shell` (command execution). Only lanes
with marks are drawn. A block sits at the activity's offset and its width runs
to the next activity on its own track. Clicking the track seeks; the first
click in live enters replay. The controls are `‹` (one activity back),
`⏸`/`▶`, `›` (one activity forward), the speed chip
(`0.25× / 0.5× / 1× / 2× / 5× / 10×`), and `◉` (back to live).

The input row is one line: `Ask about this moment, or / for commands`. It has
no expand toggle; the conversation is the Stage's `CHAT` page. Typing `/` opens
the command palette.

### Right column

Four sections, separated by hairlines:

- `AgentHead`: an 88px avatar tile, the status word (`LIVE` or `REPLAY` beside
  it), one sentence describing the status, and `attention · level`;
- `Usage`: current CPU and memory, session average, peak, sparkline or gauge;
  the scope follows the selected egg;
- `Agent Eggs`: `running / dead / all` filters, a search field
  (`name, command, pid…`), and one row per primary process with name, pid,
  command, elapsed time, and child count. The `▤` button opens `METRICS` scoped to
  that egg. Helpers are folded into a count and a name summary. The panel is
  read-only;
- `Agent Folder`: files the agent has read, written, or edited, sorted by
  modification time. Each row shows the last three version chips; expanding it
  lists every version with source (`read` / `write` / `edit`), completeness,
  line range, and timestamp. Clicking a version opens it on the Stage.

### Keyboard

| Key | Action |
|---|---|
| `⏎` | Back to live, unless focus is in an input, textarea, or select |
| `Esc` | Close a context menu or dropdown |

No keyboard shortcut opens the report. `⌘R` / `Ctrl+R` are not report
shortcuts; the report is the Chart face.

## Rounds

Rounds is a desktop canvas inside `.rounds-root`.

- `RoundsScene`: the avatar and a status bubble above it. The bubble shows the
  status word and one line naming the current subject (`Reading {path}`,
  `Editing {path}`, `Running {command}`, `Reasoning`, `Watching {name}`,
  `Waiting for you`). Clicking the stage returns to live when a pin or a replay
  holds the view.
- `RoundsStory`: the run's steps as a horizontal card chain, one card per
  activity row. The first `START` pair is folded into one card: the user
  prompt carries the model as its meta line. `END` keeps its own card.
  Clicking a card pins it while live and seeks to it during a replay, and
  opens the event's child window; clicking the same card again closes it. The
  header shows `LIVE` or `REPLAY`, the run index and status, the step count, the
  counts, and `Back to live`.
- Wallpaper: `ChatThread` with the bubble layout, rendered transparent on the
  right above the story.
- `RoundsDock`: five shortcuts. `Files`, `Agent Folder`, `Agent Eggs`, `Run`,
  and `Activity`. Badges show the folder count, the running egg count, and the
  activity count. There is no `Metrics` shortcut: metrics open from an egg row,
  scoped to that egg.
- Windows: `RoundsWindow` is draggable by its title bar, resizable from its
  corner, closable, and stacks by focus. Top-level windows are 440×430; child
  windows are 580×470. `FilePanel`, `Agent Folder`, `Agent Eggs`, and `Run`
  open as top-level windows. A file's content, a version, an event, and an
  egg's metrics open as child windows.
- The live activity window opens while the agent is busy, the face is live,
  and the run is following. It shows the newest row with a Stage item and reuses
  one window. The `Activity` dock icon or the window's `✕` turns it off. It is
  absent while a pin or a replay holds the view.
- `AttentionStack`: notice cards in the top-left corner. Clicking a card opens
  the event's window; an event with no Stage item opens the `Run` window.
  Cards can be dismissed individually or all at once.
- `RoundsChat`: one rounded input line. The slash button sits inside the box;
  `Stop` is the only filled control while the agent runs.

Opening a file or a version in a Rounds window is a read. It does not pin the
Stage and does not start a replay.

## Chart

Chart is one page: the Absence Report for the selected run. It reads
`useMonitorData.report` and `useMonitorData.facts`, the same facts Monitor
uses.

- Hero: an app icon, the outcome chip, `run #{index}`, the runtime, the duration,
  the activity count, the headline, `Started` and `Ended` times, and a run
  switcher.
- Four KPIs: `Knows` (files, lines in context, searches), `Changes` (files,
  `+additions / −deletions`, modified and created counts), `Executions`
  (commands, succeeded, failed, unknown), `Attention` (level, trigger count,
  high / medium / low).
- Timeline: three tracks, `Model`, `Tools`, and `Shell`. Activities are marks
  whose width runs to the next activity on the same track. Clicking a mark or a
  row selects its evidence; hovering previews the moment under the pointer.
- Lists: `Changes` (modified, created, deleted, observed, outside the
  project), `Executions` (command, exit code, failure, permission denial),
  and `Knows` (reads with line ranges, searches with hit counts). Each row
  selects its evidence.
- `Attention` button: expands the reason list with a level per reason. When it
  is closed, the pane shows the selected event's preview or a prompt to pick a
  block or row.
- Evidence pane: `StageItemView` of the selected event, with its effects line.
- Input and output pane: `Request` (the run prompt) and `Response` (the final
  reply).
- Footer: `ChartChat`, the shared input bar fixed at the bottom.

There is no FILE / DIFF / TERMINAL switch strip and no report overlay. The
report is this face.

## Shared shell and data flow

- `App.tsx` owns the session socket and the chimes. Switching faces does not
  reconnect and does not replay a run's chimes.
- `useMonitorData` is the single derivation of the selected run: events,
  rows, `RunFacts`, the rendered report, attention, and the live headline.
  Monitor, Chart, and Drip read it. Rounds reads `useRoundsData`, which uses the
  same stores and libraries. `buildRunFacts` and the attention verdict are
  clamped to 500 ms; feed rows update incrementally.
- The shared input is `ui/shared/FaceChat.tsx` over `components/chat/useChatInput`.
  Each face supplies only a skin: class names, placeholder, and whether the
  slash button sits inside the box. The `/` palette, context chips, and
  `Send` / `Stop` / `Run` states are the same in every face.
- Reused views (`StageItemView`, `MetricsDashboard`, `FilePanel`, the Markdown
  renderer, `SettingsDialog`) are written against `--desk-*` tokens. `.mon-root`
  re-points those tokens at the current face's palette. `SettingsDialog` must
  therefore render inside the face root; a portal to `document.body` would
  escape the bridge.
- Two file views: the left `Files` tab is the project on disk. The right
  `Agent Folder` is the agent's recorded versions. Rounds provides both through
  its `Files` and `Agent Folder` windows.

## Project picker

With no session, `App.tsx` renders `ProjectPicker`. It contains:

- the `ABSENCE` brand and `重新探测`;
- `项目路径` input and `打开`;
- `最近` project list;
- `Agent` tiles for the rows discovered on this machine. Each row shows
  `可启动` / `缺适配器` / `需登录`, its discovery source and path, declared
  models, auth status, capabilities, and install hints. The last tile is `+`
  for a custom ACP entry;
- a detail hint stream for the selected row: auth, model source, launch
  override, and temporary npx download;
- `历史` sessions; clicking one resumes it;
- a `自定义 ACP` dialog with `id`, `label`, `command`, `args`, `env`, and `cwd`.

The picker's section labels are Chinese literals in the current source. The
picker has no launch-line editor and no `allowNpx` switch.

## Settings

`SettingsDialog` is a four-pane horizontal dialog:

1. `APPEARANCE`: language, theme (`nixie` / `ink` / `glass`), scheme
   (`dark` / `light`), and the chat Markdown switch;
2. `REPORT WARN`: thresholds and levels for failed commands, consecutive
   failures, inactivity, leftover eggs, outside changes, and loops;
3. `Personalization`: `AVATAR SKIN` above the sound-set manager;
4. `EGGS FILTER`: the server's egg-filter profiles, with create, edit, apply,
   activate, delete, and `display in activity`.

The appearance rules are in [ui-style-interface.md](ui-style-interface.md);
avatar skins are in [avatar-skin.md](avatar-skin.md).

## Scope of the interface

- Replay rebuilds file content, agent status, and the current Stage action. It
  does not rebuild metrics curves or the Agent Eggs panel.
- The Agent Eggs panel lists processes; it has no kill action.
- Contrast, focus, motion, and control-state floors are specified in
  [ui-style-interface.md](ui-style-interface.md).
