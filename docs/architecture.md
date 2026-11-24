# Architecture

[English](architecture.md) | [简体中文](architecture.zh-CN.md)

This document describes the internal structure of Absence: how facts travel from an agent to the interface, the archive, replay and the Absence Report. Running the observer and choosing targets is described in [observation.md](observation.md).

## 1. Data flow

Absence drives no agent. The user runs the agent software in their own terminal or editor; Absence observes the same event pipeline through three read-only channels.

```text
     channel A: transcript tail        channel B: ACP proxy
     follows the session files         an ACP client points at the
     the agent software writes         proxy; the tap projects traffic
              │                                  │
              └────────── AbsenceEvent ──────────┘
                              ▲
                              │ OS facts
   ProcessWatcher (kernel observer / shared scan)
   ExternalScanner · FileWatcher · DockerMonitor (non-Windows)
                              │
                              ▼
        ┌──────────────┬──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
   WebSocket      SQLite archive   Replay (web)   Absence Report (web)
        │              │
        ▼              ▼
   face / Stage   History / Agent Folder
```

The transcript tail and the proxy tap project their sources into `AbsenceEvent` (sharing the `AcpToolMapper` semantics); the process, file and container watchers write `AbsenceEvent` directly. `SessionStore` merges every channel into one ordered stream, broadcasts it over WebSocket and buffers it into SQLite. Replay and the Absence Report are client-side reductions over a slice of that stream; the server does not compute them.

A session is discovered, not created by a UI flow. Attaching a transcript opens a session; a proxy session spawns its agent into a session; a process chosen on the board opens an OS-only session. Every session refuses prompt, abort, approval and command traffic with HTTP 403. The only exception is the `mock` fixture used by development and checks.

## 2. Repository layout and technology

The root workspace contains `packages/*`, `apps/server` and `apps/web`. `apps/desktop` is managed by root scripts through `npm --prefix apps/desktop ...` and is not a workspace member.

| Area | Choice |
|---|---|
| Server | Fastify; `node:sqlite` for the archive and metrics |
| Web client | React 19, Vite, Tailwind, Zustand; Monaco for code views |
| Desktop shell | Electron 37 and electron-builder |
| File observation | `chokidar` |
| Process observation | Windows: Job Object through `native/agentwatch`; Linux: eBPF through `native/agentwatch-linux`. A chosen external agent is adopted into its own Job Object (`--target-pid`) or filtered out of the machine-wide eBPF stream by ancestry; no proxy is involved and no agent is started. Fallback: process-table sampling |
| Agent content | pi session transcripts; ACP over stdio (JSON-RPC 2.0, NDJSON framing) through the proxy |

| Path | Responsibility |
|---|---|
| `apps/server` | Fastify server: observation channels, sessions, archive, process and file observation, metrics, WebSocket and HTTP API. |
| `apps/web` | React/Vite client: faces, Stage rendering, replay, Absence Report, file history, metrics and the observation board. |
| `apps/desktop` | Electron shell. Runs the same server in-process and loads the same web build. |
| `packages/core` | Shared domain types and contracts: `AbsenceEvent`, session types, metric types, run and report engines. Exported as TS source with no build step. |
| `native/agentwatch` | Windows process observer: C source, prebuilt binary and `build.bat`. |
| `native/agentwatch-linux` | Linux eBPF observer: BPF C source, loader and `build.sh`. |
| `scripts/checks` | Standalone acceptance checks run by `tsx`. The repository has no unit-test framework. |

## 3. Module responsibilities

### 3.1 Observation channels — `apps/server/src/observe`, `agents/acp`

| Module | Responsibility |
|---|---|
| `observe/transcriptSources.ts` | Source profiles. One entry (`pi`): watch roots, the agent kind recorded on sessions, and the environment overrides for its session directory. |
| `observe/parsers/pi.ts` | pi transcript records to `AbsenceEvent`, tagged `source: "transcript"`. |
| `observe/Discovery.ts` | Tails the source roots. Three states per file: unknown (header parsed only), attached (session exists, backfill then incremental tail) and missing (file gone, row kept). |
| `observe/Targets.ts` | Builds the board's target list from transcripts, the process table and the proxy registry. Building the list creates nothing. |
| `observe/watch.ts`, `observe/watchOs.ts` | Resolve a target key to a channel, attach the session and record a monitor lease. Also fold a transcript into an existing OS-only session when the process table proves they are the same agent. |
| `observe/leases.ts` | Lease persistence and restoration. |
| `observe/ObserveAdapter.ts` | No-op adapter used by every non-driven session; `prompt()` throws and `abort()` does nothing. |
| `agents/acp/AcpToolMapper.ts`, `ToolRules.ts`, `toolRules.json` | Map a tool call to `AbsenceEvent` by ACP `kind` and field shape; shared by the transcript parser and the projector. |
| `agents/acp/proxy/**` | Transparent ACP proxy: spawns the agent, forwards bytes unchanged, taps the same traffic for events, injects `ABSENCE_SESSION_ID` for exact process attribution and persists through `SessionStore.createObserved` (channel `acp-proxy`). |
| `agents/MockAdapter.ts` | Scripted fixture for development and checks — the only runtime Absence still drives. |

`createAdapter` resolves only the mock fixture. Any other kind produces an observed session; a POST carrying `resume` reopens an archive (replay, project tree, watchers) and spawns nothing. `GET /api/sessions/:id` uses the same replay path when the id is archived, so a History row or a `/s/<id>` deep link is a place, not a 404.

### 3.2 Sessions and archive — `apps/server/src/sessions`

`SessionStore.ts` holds live session state: the ordered event list, the current run, the Stage action, chat messages, file state, process watchers and metric samplers. `storage/**` persists it. In-memory state is authoritative for the live view; SQLite is the durable record.

Each session also has a mode in the run index. A transcript or proxy session derives runs from user turns: a user message opens one, `agent_end` closes it, and a transcript that attaches mid-turn opens a `boundarySource: "attach"` run with no invented prompt. An OS-only watch has no user turns to read, so it segments activity bursts on silence instead. Folding a transcript into that watch switches the index back to user turns, clears the burst idle timer, and rebuilds the rows already written — before the switch they are labelled by their first event (`usage`, `tool_end`), not by a prompt.

### 3.3 Process observation — `apps/server/src/process`

`ProcessWatcher.ts` turns process creation and exit into `process` events and attributes them to commands, eggs and sessions. `JobMonitor.ts` owns the process-wide kernel observer: `JobSidecar` on Windows, `EbpfObserver` on Linux. `TargetedObserver.ts` builds a dedicated kernel observer for the external pid a user picks on the board: on Windows an `agentwatch --target-pid <pid>` adopts it into its own Job Object, on Linux the machine-wide eBPF stream is filtered by ancestry; if it cannot attach, it falls back to the table sweep. `ExternalScanner.ts` performs one machine-wide scan every four seconds and dispatches the result to every observed session. `ProcessScanner.ts` matches pi processes by executable signature and the absolute `--session` transcript path. A default `pi` (no `--session`) is paired with a transcript only by project `cwd` plus its latest write, so a session resumed inside the process is followed on the new file; the process table carries each cwd from the native observer on Windows and `/proc` on Linux. `classify.ts` decides whether a process is a primary egg or a helper. `DockerMonitor.ts` and `DockerEggs.ts` cover containers on non-Windows hosts. `ProcessMetrics.ts` and `metricSample.ts` sample resource use; `storage/metrics.ts` persists it.

### 3.4 File observation — `apps/server/src/filesystem`

`FileWatcher.ts` watches the project directory with `chokidar` (depth 8) and its parent directory (depth 2). Changes inside the project produce `file_change` events; changes in the parent are marked `outside`. The watcher ignores `node_modules`, `.git`, `dist` and similar directories, and binary or archive files.

### 3.5 Metrics

Metrics are not `AbsenceEvent`s. They are sampled every five seconds on wall-clock boundaries, streamed on a separate WebSocket channel and persisted to SQLite. Sampling covers the agent tree, each egg subtree, Docker containers and the host. A frame carries process counters, host counters, per-egg summaries and a precision flag.

### 3.6 HTTP and WebSocket — `apps/server/src/api`, `websocket`

HTTP routes cover the project list, observation (`/api/observe/sessions`, `/api/observe/targets`, `/api/observe/live`, `/api/observe/watch`, `/api/observe/unwatch`, `/api/observe/attach`), proxy sessions, session snapshots, paged events, run summaries, file versions, file content and metrics. The write-back routes (`prompt`, `abort`, `approval`, `command`) answer 403 for every session except the mock fixture. `POST /api/sessions` reopens an archive or starts the fixture; `GET /api/sessions/:id` reopens an archived id read-only, which is what History and `/s/<id>` deep links use.

The session WebSocket (`/ws/sessions/:id`) sends a `snapshot` first, then batched `event` and `session_state` messages. Event frames are batched at 50 ms or 200 events.

### 3.7 Web client — `apps/web`

The client renders the observation board, three switchable faces and one overlay (section 6). It receives events and session state over the WebSocket and reads history, file versions and metrics over HTTP. It consumes `AbsenceEvent` only and does not distinguish the agent that produced it.

### 3.8 Desktop shell — `apps/desktop`

See section 9.

## 4. Event model

`AbsenceEvent` is the type the session WebSocket transports and the archive stores. Types are defined in `packages/core/src/events.ts`:

```ts
type AbsenceEventType =
  | "agent_start" | "agent_end" | "message" | "thinking"
  | "tool_start" | "tool_update" | "tool_end"
  | "file_read" | "file_write" | "file_edit" | "file_change"
  | "command" | "search" | "process" | "approval" | "mcp" | "error"
  | "usage";
```

Every event carries `source` and `fidelity`:

| `source` | Origin |
|---|---|
| `acp` | ACP `session/update` (the mock fixture's projector). |
| `acp-proxy` | ACP traffic observed through the transparent proxy. |
| `os` | Process or file observation. |
| `transcript` | A fact projected from a session transcript the agent wrote (channel A). |
| `unknown` | No recorded source. |

| `fidelity` | Meaning |
|---|---|
| `exact` | Carried verbatim by the protocol, or read from the OS. |
| `reported` | Self-reported by the agent, not independently verified. |
| `inferred` | A display fallback derived from protocol fields. |
| `unknown` | The protocol or OS did not provide the field. |

Model, context usage, advertised commands and authentication methods travel in `session_state` messages, not in the event stream. Metrics use their own channel.

`usage` is emitted once per run by the transcript channel when a turn closes, and only when the transcript reported token counts. It carries `outputEst` (the summed `output` of the turn's assistant records), `contextUsed` (the largest `input + cacheRead + cacheWrite` seen in the turn), the model name and `estimated: true`. The ACP proxy channel emits no `usage` event, because the proxy protocol carries no token accounting. The event feeds run-scoped token totals and is not part of the activity feed. Heuristic estimators in `packages/core/src/tokens.ts` are used by the client where no reported figure exists.

Observation layers:

| Layer | Content | Availability |
|---|---|---|
| OS facts | Process creation and exit; file creation, modification and deletion. | Always attempted. Kernel events when the observer is available; snapshot sampling otherwise. |
| ACP semantics | Tool calls, files, commands, MCP calls, approvals, thinking and messages. | When an ACP client routes through the proxy. Missing fields stay `unknown`. |
| Transcript semantics | The same categories, projected from pi's session records. | When a pi transcript is attached. |

When a content channel is absent the interface still works: OS facts still produce Activity rows, Agent Eggs, file changes and a report.

## 5. Storage

One SQLite database, `~/.absence/absence.db`, holds the archive and the metrics. `ABSENCE_STATE_DIR` moves the database and archive root. `db.ts` opens the database with WAL, `synchronous=NORMAL`, a busy timeout and foreign keys; it owns the schema and migrations and exposes the shared handle through `openDatabase()`.

SQLite access is split across four modules:

| Module | Direct SQLite work |
|---|---|
| `sessions/storage/db.ts` | Open, pragmas, schema, migrations, event buffering and paged reads. |
| `sessions/storage/files.ts` | Prepares and writes `file_versions`; reads version indexes and content. |
| `sessions/storage/runs.ts` | Maintains the `runs` index and reads one run's event range. |
| `sessions/storage/metrics.ts` | Writes, reads and expires `metric_chunks`, `egg_metric_summary` and `host_metric_chunks`. |

Tables (schema v7):

| Table | Content |
|---|---|
| `store_meta` | Schema version and store-level metadata. |
| `sessions` | One row per archived session: project, timestamps, runtime (agent kind), model, message count, first prompt, and the observation identity (`channel` + `external_id`) that re-attach resolves. |
| `transcript_checkpoints` | Per session, the consumed transcript byte offset and the SHA-256 of the consumed prefix. Written in the same transaction as the events; used to resume after a restart. |
| `events` | Ordered events with `seq`, payload, `source` and `fidelity`. |
| `runs` | Run index: event range, prompt, start and end, status, counts and `boundary_source` (`user-message`, `attach`, `activity-burst`). A session that moves from OS-only to transcript observation rebuilds these rows on the user-turn boundaries. |
| `file_versions` | Complete and partial file versions with source, line range and known-line data. |
| `metric_chunks` | Per-egg metric chunks packed as binary arrays. |
| `egg_metric_summary` | Per-egg first and last sample, CPU baseline and final value, RSS integral and sample count. |
| `host_metric_chunks` | Host metric chunks with the same packing. |
| `watch_leases` | Monitor leases: target key, session, channel, identity, file, pid and start time. |

Archive writes are buffered for 50 ms and committed in one transaction, so a burst of process or file events costs one commit. `drainArchive()` flushes on dispose.

Retention:

| Scope | Policy |
|---|---|
| Live event list | At most `MAX_SESSION_EVENTS` = 10,000 events in memory. Streaming message and thinking deltas are not persisted. |
| Archived sessions | Kept by default. `ABSENCE_SESSION_RETENTION_DAYS` and `ABSENCE_MAX_ARCHIVED_SESSIONS` add age and count expiry; both default to 0 (keep everything). |
| Metrics | Kept 30 days by default. `ABSENCE_METRICS_RETENTION_DAYS=0` keeps everything. Expiry runs daily. |
| Metric chunks | One chunk covers 30 minutes of wall time; flushed every 15 seconds. |
| Agent Eggs | Running eggs are always retained. Finished eggs beyond `ABSENCE_MAX_EGGS` (default 200) are retired oldest-first by exit time and leave the live panel with `retired: true`. Archived `process` events are not deleted. |
| Observation sessions | An unleased observation with no viewer is archived after `ABSENCE_ARCHIVE_SILENCE_MS` (default 30 min); a leased one after `ABSENCE_LEASE_SILENCE_MS` (default 2 h). Sessions being backfilled or with a connected viewer are skipped. |

File versions and run events are stored separately, so Agent Folder and File History work without loading a run. A write or edit appends a complete version. Consecutive reads accumulate into a partial v0 version. When a read reports no line range, Absence attempts to verify one against the file on disk: an exact, unique match of the returned text yields the read's line coordinates. Ambiguous matches, missing files and stale reads keep `rangeKnown=false` and the interface shows the range as unknown.

## 6. Web rendering layer

The client uses React 19, Vite, Tailwind and Zustand. `useMonitorData` derives, per render cycle, the Activity rows, `RunFacts`, the finished `RunReport`, live attention and the live headline for the selected run. The Chart and Monitor faces consume the same derivation.

Faces:

| Face | Content |
|---|---|
| Rounds | Desktop scene: character, story cards, and dock windows for Files, Agent Folder, Agent Eggs, Run and Activity. |
| Monitor | Three columns: Activity/Files/Attention feed, centre Stage, and Agent Head/Usage/Agent Eggs/Agent Folder. |
| Chart | Full-page Absence Report: conclusion, KPIs, timeline, Changes, Executions, Knows, Tool calls, Errors, Attention and evidence preview. |
| Drip | A floating card toggled independently of the face switcher: live events while the run works, the final reply when it settles. |

`ViewMode` is `rounds | monitor | chart | drip`; the switcher exposes the first three. Drip is stored as a toggle. The default face is Monitor; an unknown or stale stored value resolves to Monitor.

Stage behaviour:

- `SessionStore.applyToState` decides which event owns the Stage. A `message` clears the Stage and sets the agent state to `speaking`; `process` does not own the Stage.
- The client turns events into file, diff, terminal, thought, speech, process and approval cards in `apps/web/src/lib/events.ts` and `apps/web/src/components/stage/StageItemView.tsx`.
- Monitor's Stage has two page tabs, `METRICS` and `CHAT`, plus the pinned activity view. Activity cards reflect follow, pin or replay state. The Stage has no `FILE`, `DIFF` or `TERMINAL` tab strip.
- `activityViews.ts` derives file, diff and terminal views from one pinned event.

The Absence Report is computed entirely in the client by `apps/web/src/lib/report.ts` from one run's event slice (`run.fromIndex` to `run.toIndex`). It is a deterministic reduction: no model call, no command-text interpretation. Command text is used only to pair `tool_start` with `tool_end`. A missing exit code is recorded as `exitCodeKnown=false`.

## 7. Replay

Replay rebuilds state from run events and periodic snapshots.

- A snapshot is taken every 25 events or every 5 seconds, whichever comes first.
- A snapshot holds the event index, timestamp, file map, agent state and current Stage action.
- File reconstruction: `file_write` replaces the file; `file_edit` applies `after`; `file_read` supplies initial content only when the path is still unknown; `file_change deleted` removes the path.
- `seek` selects the nearest snapshot at or before the target time, then applies the remaining events up to it.
- Playback advances on an 80 ms tick. Speeds are `0.25 / 0.5 / 1 / 2 / 5 / 10`. Playback pauses at the end of the run.
- The Monitor Stage timeline has three tracks — Model (thinking and speaking), Tools (tool calls, including MCP) and Shell (command execution); clicking seeks. Rounds story cards and Monitor feed rows also seek when clicked.

Replay scope:

| Rebuilt | Not rebuilt |
|---|---|
| File contents, agent state, current Stage action. | Metric curves, Agent Eggs panel, container state. |

Metrics and eggs are separate live views. There is no terminal byte stream in this build.

## 8. Process observation

The kernel observer is created once per server process, before any session exists. On Windows, `native/agentwatch` places the server process in a Job Object and reports descendant process creation and exit. On Linux, `native/agentwatch-linux` attaches eBPF tracepoints and requires `CAP_BPF`/`CAP_PERFMON` or root.

When the observer is unavailable, or the root process is outside the Job Object, `ProcessWatcher` falls back to process-table snapshots. On Windows it prefers the `agentwatch table` command (Toolhelp traversal, tens of milliseconds) and falls back to PowerShell `Get-CimInstance Win32_Process`; other platforms use `ps`. The sampling floor is about 0.5 s and the metric precision is marked `sampled`. Kernel values read from held handles are marked `exact`.

Attribution:

- A driven session's projector opens a command window on a `tool_call` with `kind=execute` and closes it on the terminal update. Kernel events are claimed through the ancestor chain; the command window decides which command an event belongs to.
- A reported process is a subtree root. Descendants count as `children` and do not become separate eggs.
- Orphan processes with a broken parent chain or an unknown parent pid are not claimed.
- For an observed session, the transcript's own tool calls open command windows only when the fact is younger than ten seconds; a backfilled historical command never credits today's processes, files or containers.
- An OS-only session samples the process subtree it was bound to and attributes nothing else to itself.

Classification (`classify.ts`) decides in this order: outlived the command, has children, named by the command, backgrounded with redirection, launched from a tool install directory, runs from the workspace, lives under 300 ms, name matches a short-lived tool prior and is under 2 s; everything else is unclassified. Primary processes become Agent Eggs; helpers fold into counts and a name summary.

Docker containers run inside the daemon's VM, where neither the Job Object nor eBPF can reach them. On non-Windows hosts `DockerMonitor` reads lifecycle from `docker events` and resources from `docker stats`. A container started inside a command window becomes an egg with a synthetic pid (≥1,000,000,000); a container started outside a window is not attributed.

**Windows does not capture Docker containers.** `DockerMonitor` is disabled, no Docker or WSL daemon is probed and `ABSENCE_DOCKER=1` does not enable it. Docker commands in a transcript remain ordinary command facts.

## 9. Desktop packaging

`apps/desktop` is an Electron shell built with Electron 37 and electron-builder. `main.cjs` starts the server in the same process, so the application has one lifecycle and no extra console window. From a source tree the server loads through `tsx`; a packaged build loads `apps/server-bundle.cjs`.

The packaging step includes the bundled server, its runtime `node_modules`, the web build from `dist/web` and a start script. The Windows package adds `native/agentwatch/agentwatch.exe`; the Linux package adds `native/agentwatch-linux/agentwatch-linux`. The web build is the same one the browser uses.

Electron must bundle Node 22.19 or newer because the server uses `node:sqlite`. The repository pins the Node version through `engines` and `.nvmrc`.

Drip opens as a separate transparent always-on-top window in the desktop shell. In the browser build it uses Document Picture-in-Picture.

## 10. Boundaries

- ACP reporting obligations are `SHOULD`, not `MUST`. A missing `kind` becomes `other`; a missing `locations` leaves the read range unknown unless the returned text matches the disk file exactly and uniquely. Absence does not guess missing fields.
- Tool calls with a missing or unusable `kind` go through the `ToolRules` field-shape rules. Some payloads cannot be classified by shape.
- When concurrent commands have similar command lines, process attribution can be wrong. The fallback keeps the process rather than dropping it.
- Snapshot mode can miss short-lived processes.
- Whether Codex's Windows sandbox keeps child processes inside the Job Object depends on the agent implementation. Absence makes no claim about it.
