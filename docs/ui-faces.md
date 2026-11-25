# UI faces

[English](ui-faces.md) | [简体中文](ui-faces.zh-CN.md)

This document describes the web interface in `apps/web`: the observation board, the three switchable faces, the Drip overlay, the shared shell and the components that render each part. Paths are repository-relative.

## 1. Entry and navigation

`apps/web/src/app/App.tsx` renders one of two things:

| Condition | Rendered |
|---|---|
| No session open | The observation board (`components/Observatory/Observatory.tsx`) |
| A session open | The selected face, defaulting to Monitor |

The address bar carries the panel path `/s/<sessionId>`. Opening the app on that URL restores the panel; browser back and forward move between the board and panels without a reload. A stale link whose archive no longer exists fails silently and leaves the board in place.

The board polls every four seconds while visible. It has two columns:

| Column | Content | Action |
|---|---|---|
| Running | Running agents: watched sessions and running targets, with channel, last activity, fact count and first prompt | Click a row to start monitoring and open its panel |
| History | Archived sessions and exited transcripts, with runtime, message count and first prompt | Open the archive as a read-only replay, or delete it |

A running row shows `backfilling…` while a backfill runs and `transcript diverged; re-watch to continue` when the stored checkpoint no longer matches the transcript. There is no per-row stop control: monitoring ends from the panel, whose `change` button drops the lease and closes the live session; the target then returns to the Running column as watchable and the archive remains.

## 2. Faces and the switcher

The top bar's switcher contains three buttons. Each is one `ViewModeSpec` in `apps/web/src/lib/viewMode.ts`.

| Face | Intent in source | Layout |
|---|---|---|
| Rounds | Light — the agent leads, the user follows | Desktop: character, story cards, floating windows |
| Monitor | Heavy — the run's traces on one screen | Three columns: feed, Stage, agent rail |
| Chart | The run is over — read what it amounted to | Full-page report |

The source records a Chinese term for each face (查房陪诊, 机器监护, 病历报告). The switcher displays the English `name` only.

`apps/web/src/app/App.tsx` renders the face selected by `apps/web/src/stores/viewModeStore.ts`. Monitor is the default and the fall-through for any mode without a branch. The stored value is `absence.viewMode`; a stored `drip` value from an older build resolves to Monitor.

## 3. The shared top bar

`apps/web/src/components/layout/FaceBar.tsx` renders one bar for all faces. From left to right:

| Element | Content |
|---|---|
| Clock | Current time, updated every second |
| Session card | Agent runtime and session id |
| Project path | The session's project directory |
| Drip toggle | IV-bag icon; opens or closes the floating card |
| Face switcher | Rounds, Monitor, Chart |
| Context meter | Used and total context tokens with a bar |
| Connection chip | `online` or `offline` |
| Settings | Opens the settings dialog |
| `change` | Drops the monitor lease, closes the live session and returns to the board |
| Window controls | Desktop shell only |

The bar carries no run content. The run belongs to the face.

## 4. Drip

Drip is a toggle beside the face switcher; it is not a face. Its state is `viewModeStore.drip` and is never persisted. When on, a floating window opens over the current face and the face underneath stays mounted.

- Desktop shell: a second always-on-top transparent window loads the same app with `?face=drip&session=<id>` and mounts `DripDesktop`. The window is click-through except over the pill and the card.
- Browser: `DripPipHost` opens a Document Picture-in-Picture window, copies the document styles and mirrors the `theme-*` / `scheme-*` classes. When PiP is unavailable or blocked, the widget renders inside the page.
- Content: `DripUI` draws a pill and a card. The pill contains the avatar and an attention dot; in the floating hosts it also shows `run #n · runtime`, elapsed time and `R/S/E/$` counts. The card contains the run prompt, `Open Absence`, the newest eight live events while the run is running, and the final reply once it has settled.

## 5. Source layout

```text
apps/web/src/app/App.tsx                       shell, socket, chimes, face branches
apps/web/src/lib/viewMode.ts                   the three faces and their intent
apps/web/src/stores/viewModeStore.ts           selected face and Drip toggle
apps/web/src/components/Observatory/           the observation board
apps/web/src/components/layout/FaceBar.tsx     the shared top bar

apps/web/src/ui/monitor/
  MonitorUI.tsx        three columns and the ⏎ contract
  MonitorLeft.tsx      Activity / Files / Attention tabs, run selector
  MonitorStage.tsx     Stage pages, pin bar, timeline
  MonitorRight.tsx     Agent Head, Usage, Agent Eggs, Agent Folder
  activityViews.ts     file, diff and terminal views of one pinned event
  monitor.css          Monitor-only layout rules

apps/web/src/ui/rounds/
  RoundsUI.tsx         desktop canvas and window management
  RoundsScene.tsx      character and status bubble
  RoundsStory.tsx      card chain of run steps
  RoundsPeek.tsx       file preview window
  RoundsDock.tsx       Files / Agent Folder / Agent Eggs / Run / Activity
  RoundsWindow.tsx     draggable, resizable window
  useRoundsData.ts     this face's single derivation
  rounds.css           Rounds-only rules

apps/web/src/ui/chart/
  ChartUI.tsx          hero, KPIs, lists, evidence, timeline
  ChartTimeline.tsx    the report's lane timeline
  StatsKpiCards.tsx    four cumulative KPI cards

apps/web/src/ui/drip/
  DripUI.tsx           pill and card
  DripPip.tsx          browser Document PiP host
  DripDesktop.tsx      desktop-shell window

apps/web/src/components/stage/                  Stage views per event kind
apps/web/src/components/chat/ChatThread.tsx     the conversation, read-only
apps/web/src/components/metrics/                Usage and the metrics dashboard
apps/web/src/components/files/                  project tree and file history
apps/web/src/components/attention/              attention notices
apps/web/src/components/common/SettingsDialog.tsx
apps/web/src/ui/shared/                         tokens, themes, atoms, motion
```

## 6. Monitor

Three columns.

**Left column** (`MonitorLeft.tsx`) has three tabs and a run selector:

| Tab | Content |
|---|---|
| Activity | The run's events in order, grouped by phase, with consecutive `process` updates folded into one row and a count |
| Files | Every file the run read, created or modified, with a count |
| Attention | The reasons the run needs a human, read from the persisted run |

The run selector lists the session's runs and switches the whole face to one of them.

**Centre column** (`MonitorStage.tsx`) shows the Stage. It has two page tabs, `Metrics` and `Chat`, plus the pinned activity view:

| State | Content |
|---|---|
| Following | The action in progress; the page returns to live as new facts arrive |
| Pinned | The activity whose row was clicked; the pin bar states the moment and offers `Back to live ⏎` |
| Replay | The page walks the run's own clock; the bar reports the replay offset |
| `Metrics` | The metrics dashboard: CPU, memory and process counts for the session, host and selected egg |
| `Chat` | The conversation, read-only, with role labels and optional Markdown rendering |

`⏎` returns to live unless focus is in an input, textarea or select. Clicking the active tab also returns to live.

The Stage renders one view per event kind: file, diff, terminal, thought, speech, process, error and approval. The approval card is read-only and states that the request was answered elsewhere.

Below the Stage is the timeline: three tracks (Model, Tools, Shell) over the run's duration. Clicking a node seeks; playback advances on an 80 ms tick at 0.25× to 10×. A mark's width is its own duration — a thought ends at the generation end its transcript reported, a command at its tool's reported duration — so the Shell track goes quiet while the model thinks.

**Right column** (`MonitorRight.tsx`) contains:

| Section | Content |
|---|---|
| Agent Head | Avatar, status word and one plain sentence about the current status; a LIVE/REPLAY chip; the attention level |
| Usage | Context and cost summary from the shared `components/metrics/Usage` |
| Agent Eggs | Processes the agent started, filterable, with running time, children, resource link and folded helpers |
| Agent Folder | The agent's files, newest first, expandable into versions; clicking a version opens it on the Stage |

## 7. Rounds

Rounds renders the run as a desktop.

- The character stands on the left with a status bubble.
- The conversation floats as a wallpaper thread on the right, using bubbles with the user on the right and the agent on the left.
- The story runs across the width as a chain of cards, one per run step; clicking a card seeks.
- The dock at the bottom opens Files, Agent Folder, Agent Eggs, Run and Activity as floating windows. Windows can be dragged and resized; windows opened from inside another window use a smaller size.
- The agent's own actions open an activity window while the run is working.

## 8. Chart

Chart is the Absence Report for one run, or for every run in the session.

| Element | Content |
|---|---|
| Hero | Headline, run selector (including `all runs`), runtime, duration, activity count, start and end |
| KPI row | Eight cards: Knows, Changes, Executions, Attention, then Run count, Events, Errors and estimated tokens for the selection's scope |
| Timeline | The report's lane timeline; clicking a node reveals its evidence |
| Rail | Tabs: Changes, Executions, Knows, Tool calls, Errors, Attention |
| Run selector | `all runs` widens the subject from one run to every run in the session |
| Evidence preview | The Stage view of the selected node |
| Input and output | The run's request (prompt) and response (final reply) |

The report is computed in the client by `apps/web/src/lib/report.ts` as a deterministic reduction over the run's events. It calls no model and does not interpret command text. A missing exit code is shown as unknown.

## 9. Settings

The dialog has four panes:

| Pane | Controls |
|---|---|
| Appearance | Language, style (`nixie` / `ink` / `glass`), colour scheme (`dark` / `light`), chat Markdown rendering |
| Report | Attention thresholds: failed commands per run, consecutive failures, idle seconds, processes left running, outside changes |
| Personalization | Avatar skin manager and sound-set manager |
| Agent Eggs | Helper-name filters and egg filter profiles |

## 10. Keyboard and pointer

| Input | Effect |
|---|---|
| `⏎` | Back to live, unless focus is in an input, textarea or select |
| Row click | Pin that activity on the Stage |
| Timeline node click | Seek the replay cursor to that node |
| Story card click | Seek the replay cursor to that card |
| Drag a window's title bar | Move the window (Rounds) |
| Drag a window's corner | Resize the window (Rounds) |
