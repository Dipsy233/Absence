# Architecture

[English](architecture.md) | [简体中文](architecture.zh-CN.md)

This document describes the internal structure of Absence and the mechanisms that connect an agent process to the interface, the archive, replay and the Absence Report. Agent installation and protocol onboarding are covered in [agent-support.md](agent-support.md).

## 1. Data flow

Absence starts an ACP agent, or attaches to an agent that already runs. In both cases the server collects three kinds of facts, converts them into `AbsenceEvent`, and distributes that event stream to the interface, the archive, replay and the report.

```text
Agent process (any ACP agent)
    │  ACP session/update over stdio (NDJSON JSON-RPC)
    ▼
AcpConnection → AcpSession / AcpAdapter
    │
    ├── projector (AcpToolMapper + ToolRules) ────────┐
    │                                                 ▼
    │                                          AbsenceEvent
    │                                                 │
OS facts                                                │
    ProcessWatcher (Job Object / eBPF / sampling) ──────┤
    FileWatcher ────────────────────────────────────────┤
                                                        │
            ┌──────────────────┬───────────────┬────────┴──────────┐
            ▼                  ▼               ▼                   ▼
       WebSocket         SQLite archive   Replay (web)     Absence Report (web)
            │                  │
            ▼                  ▼
      faces / Stage     History / Agent Folder
```

The projector reads `session/update` and writes `AbsenceEvent`. Process and file watchers write `AbsenceEvent` directly. `SessionStore` merges both sources into one ordered stream, broadcasts it over the WebSocket, and buffers it for SQLite. Replay and the Absence Report are web-side reductions over a slice of that stream; the server does not compute them.

A session is driven through the ACP adapter: Absence owns the child process and sends `session/new`, `session/prompt`, approval responses and `/auth`.

## 2. Repository layout and stack

The root workspace contains `packages/*`, `apps/server` and `apps/web`. `apps/desktop` is managed by root scripts with `npm --prefix apps/desktop ...` and is not a workspace member.

Main technology choices:

| Area | Choice |
|---|---|
| Server | Fastify; `node:sqlite` for the archive and metrics |
| Web client | React 19, Vite, Tailwind and Zustand; Monaco for code views |
| Desktop shell | Electron 37 and electron-builder |
| File observation | `chokidar` |
| Process observation | Windows Job Object through `native/agentwatch`; Linux eBPF through `native/agentwatch-linux`; process-table sampling as the fallback |
| Agent access | ACP over stdio, JSON-RPC 2.0 with NDJSON framing |

| Path | Responsibility |
|---|---|
| `apps/server` | Fastify server: ACP access, sessions, archive, process and file observation, metrics, WebSocket and HTTP API. |
| `apps/web` | React/Vite client: faces, Stage rendering, replay, Absence Report, file history, metrics and the project picker. |
| `apps/desktop` | Electron shell. Runs the same server in-process and loads the same web build. |
| `packages/core` | Shared domain types and the event contract: `AbsenceEvent`, session types, metrics types, known-line helpers. It exports TypeScript sources directly and has no build step. |
| `native/agentwatch` | Windows process observer: C source, prebuilt executable and `build.bat`. |
| `native/agentwatch-linux` | Linux eBPF observer: BPF C source, loader and `build.sh`. |
| `scripts/checks` | Standalone acceptance checks run with `tsx`. There is no unit-test framework. |

## 3. Modules and responsibilities

### 3.1 ACP access — `apps/server/src/agents/acp`

| Module | Responsibility |
|---|---|
| `AgentCatalog.ts`, `profiles.ts` | Resolve which agents exist on the host, their launch data, readiness state and read-only configuration inspection. |
| `AcpConnection.ts`, `protocol/**` | stdio transport and JSON-RPC/NDJSON framing; `initialize`, session methods, request routing. |
| `AcpAdapter.ts`, `AcpSession.ts` | Session lifecycle: start the process, open or resume a session, send prompts, cancel turns, answer permissions. |
| `AcpToolMapper.ts`, `ToolRules.ts`, `toolRules.json` | Project ACP tool calls into `AbsenceEvent` by ACP `kind` and field shape. |
| `AcpPermissionBridge.ts`, `AcpAuth.ts`, `AcpConfigOptions.ts` | Approval forwarding, authentication bridging and configuration options. |
| `proxy/**` | Transparent ACP proxy: forwards raw lines between an external client and an agent, and taps the same traffic for events. |

`createAdapter` in `apps/server/src/agents/createAdapter.ts` is the entry point used by the session layer. It returns an `AcpAdapter` for a ready profile and throws the catalog's readiness reason otherwise. The non-ACP adapter is the `mock` fixture used by checks.

### 3.2 Sessions and archive — `apps/server/src/sessions`

`SessionStore.ts` owns live session state: the ordered event list, current run, Stage action, chat messages, file state, process watcher and metrics sampler. `storage/**` persists that state. The in-memory store is the source of live state; SQLite provides persistence.

### 3.3 Process observation — `apps/server/src/process`

`ProcessWatcher.ts` turns process creation and exit into `process` events and attributes them to commands, eggs and sessions. `JobMonitor.ts` owns the process-wide kernel observer and picks `JobSidecar` on Windows, `EbpfObserver` on Linux. `classify.ts` decides whether a process is a primary egg or a helper. `DockerMonitor.ts` and `DockerEggs.ts` cover containers. `ProcessMetrics.ts` and `metricSample.ts` sample resource usage; `storage/metrics.ts` persists it.

### 3.4 File observation — `apps/server/src/filesystem`

`FileWatcher.ts` watches the project tree (depth 8) and its parent directory (depth 2) with `chokidar`. Changes inside the project become `file_change` events. Changes in the parent are marked `outside`. The watcher ignores directories such as `node_modules`, `.git` and `dist`, and binary or compressed files.

### 3.5 Metrics

Metrics do not use `AbsenceEvent`. They are sampled every five seconds on a wall-clock boundary, streamed on their own WebSocket channel, and persisted in SQLite. Sampling covers the whole agent tree, each egg subtree, Docker containers and the host. A frame carries process counters, host counters, per-egg rollups and a precision marker.

### 3.6 HTTP and WebSocket — `apps/server/src/api`, `apps/server/src/websocket`

The HTTP API exposes projects, session creation and observation, session snapshots, paged events, run summaries, file versions, file contents, prompts, approvals, commands, metrics and agent catalog management. The session WebSocket sends a `snapshot` first, then batched `event` and `session_state` messages. A separate terminal WebSocket exposes the PTY byte mirror. Event frames are batched at 50 ms or 200 events.

### 3.7 Web client — `apps/web`

The client renders three switchable faces and one overlay; see section 6. It receives events and session state from the WebSocket and reads history, file versions and metrics from the HTTP API. It consumes `AbsenceEvent` without distinguishing which agent produced an event.

### 3.8 Desktop shell — `apps/desktop`

See section 9.

## 4. Event model

`AbsenceEvent` is the event type sent over the session WebSocket and stored in the archive. Its types are defined in `packages/core/src/events.ts`:

```ts
type AbsenceEventType =
  | "agent_start" | "agent_end" | "message" | "thinking"
  | "tool_start" | "tool_update" | "tool_end"
  | "file_read" | "file_write" | "file_edit" | "file_change"
  | "command" | "search" | "process" | "approval" | "mcp" | "error"
  | "usage";
```

Each event carries `source` and `fidelity`:

| `source` | Origin |
|---|---|
| `acp` | ACP `session/update`. |
| `acp-proxy` | ACP traffic observed through the transparent proxy. |
| `os` | Process or file observation. |
| `unknown` | Origin not recorded. |

| `fidelity` | Meaning |
|---|---|
| `exact` | Carried by the protocol, or read from the OS. |
| `reported` | Reported by the agent without independent verification. |
| `inferred` | Derived by Absence from protocol fields as a display fallback. |
| `unknown` | The protocol or OS did not provide the field. |

Model, context usage, advertised commands and authentication methods travel in `session_state` messages and do not enter the event stream. Metrics travel on their own channel.

`usage` is one event per run, emitted when the run closes. It carries the run's
token estimates: `outputEst` (from the finished assistant text's length),
`inputEst` (the reported context window's growth across the run, minus that
output — `null` when the runtime reported no context usage), the context
occupancy, and the model name. Every value is an estimate and the payload marks it
with `estimated: true`. Absence does not parse model responses, so real token
counts are unavailable; the estimate uses a heuristic (CJK ≈ 1 token per
character, other text ≈ 1 token per 4 characters, see
`packages/core/src/tokens.ts`). The event feeds run-scope token totals and is not a
displayed activity, so it is excluded from the Activity feed.

Observation layers:

| Layer | Content | Availability |
|---|---|---|
| OS facts | Process creation and exit, file creation, modification and deletion. | Always attempted. Kernel events when a helper is available; snapshot sampling otherwise. |
| Terminal mirror | Raw stdout/stderr bytes from an agent started by Absence in a PTY. Not parsed. | Only when Absence starts the agent in a PTY. The current web client does not connect to the terminal WebSocket. |
| ACP semantics | Tool calls, files, commands, MCP calls, approvals, thinking and messages. | When the agent reports them. Missing fields stay `unknown`. |

When the ACP layer is absent, the interface remains usable: OS facts still produce Activity rows, Agent Eggs, file changes and a report.

## 5. Storage

One SQLite database, `~/.absence/absence.db`, holds the archive and metrics. `ABSENCE_STATE_DIR` changes the database and archive root. `agents.json` and `registry.json` are catalog files; they live under `ABSENCE_CATALOG_DIR` or `~/.absence`, not under `ABSENCE_STATE_DIR`. `db.ts` opens the database with WAL, `synchronous=NORMAL`, a busy timeout and foreign keys, owns the schema and migrations, and exposes the shared handle through `openDatabase()`.

SQLite access is spread across several modules:

| Module | Direct SQLite work |
|---|---|
| `sessions/storage/db.ts` | Open, pragmas, schema, migrations, event buffering and page reads. |
| `sessions/storage/files.ts` | Prepare and write `file_versions`; read the version index and contents. |
| `sessions/storage/runs.ts` | Maintain the `runs` index and read per-run event ranges. |
| `sessions/storage/metrics.ts` | Insert, read and expire `metric_chunks`, `egg_metric_summary` and `host_metric_chunks`. |

Tables:

| Table | Content |
|---|---|
| `store_meta` | Schema version and store-level metadata. |
| `sessions` | One row per archived session: project, timestamps, runtime, model, message count, first prompt and an opaque ACP resume handle. |
| `events` | Ordered events with `seq`, payload, `source` and `fidelity`. |
| `runs` | Run index: event range, prompt, start and end, status and counts. |
| `file_versions` | Complete and partial file versions, with source, line range and known-line data. |
| `metric_chunks` | Per-egg metric chunks, packed as binary arrays. |
| `egg_metric_summary` | Per-egg first and last sample, CPU base and end, RSS integral, sample count. |
| `host_metric_chunks` | Host metric chunks in the same packed shape. |

Archive writes are buffered for 50 ms and committed in one transaction, so a burst of process or file events costs one commit. `drainArchive()` flushes on dispose.

Retention:

| Scope | Policy |
|---|---|
| Live event list | Capped at `MAX_SESSION_EVENTS` = 10,000 events in memory. Streamed message and thinking deltas are not archived. |
| Archived sessions | Kept by default. `ABSENCE_SESSION_RETENTION_DAYS` and `ABSENCE_MAX_ARCHIVED_SESSIONS` add day-based and count-based expiry; both default to 0 (keep all). |
| Metrics | 30 days by default. `ABSENCE_METRICS_RETENTION_DAYS=0` keeps all. Expiry runs once a day. |
| Metric chunks | 30 minutes of wall time per chunk; flushed every 15 seconds. |
| Agent Eggs | Running eggs are always kept. Finished eggs beyond `ABSENCE_MAX_EGGS` (default 200) are retired from the live panel, oldest exit first, with `retired: true`. Archived `process` events are not removed. |
| Terminal mirror | 256 KB ring buffer, 60 ms batching, streamed only. |

File versions are stored separately from run events, so Agent Folder and File History work without loading a run. A write or edit appends a complete version. Consecutive reads accumulate into one partial v0 version. When a read reports no line range, Absence tries to verify one against the file on disk: the returned text is located in the file, and an exact, unique match yields the read's line coordinates. An ambiguous match, a missing file, or a stale read keeps `rangeKnown=false`, and the UI shows the range as unknown.

## 6. Web rendering layer

The client uses React 19, Vite, Tailwind and Zustand. `useMonitorData` derives the selected run's Activity rows, `RunFacts`, the finished `RunReport`, live attention and the live headline once per render pass. The Chart face and the Monitor face consume the same derivation.

Faces:

| Face | Content |
|---|---|
| Rounds | A desktop scene: character, story cards and dock windows for Files, Agent Folder, Agent Eggs and the current run. |
| Monitor | Three columns: Activity/Files/Attention feed, central Stage, and Agent Head/Usage/Agent Eggs/Agent Folder. |
| Chart | Full-page Absence Report: outcome, KPIs, timeline, Changes, Executions, Knows, Attention and an evidence preview. |
| Drip | An overlay toggled independently of the face switcher. A compact card with live events, the final reply and a composer. |

`ViewMode` is `rounds | monitor | chart | drip`; the switcher exposes the first three. Drip is stored as a toggle. The default face is Monitor; an unknown or stale stored value resolves to Monitor.

Stage behaviour:

- `SessionStore.applyToState` decides which event owns the Stage. `message` clears the Stage and sets the agent state to `speaking`; `process` never owns the Stage.
- The web client converts events to file, diff, terminal, thought, speech, process and approval cards in `apps/web/src/lib/events.ts` and `apps/web/src/components/stage/StageItemView.tsx`.
- Monitor's Stage has two page tabs, `METRICS` and `CHAT`. Activity cards follow the follow, pin or replay state. The Stage has no `FILE`, `DIFF` or `TERMINAL` tab strip.
- `activityViews.ts` derives the file, diff and terminal views from one pinned event.

Absence Report is computed entirely in the web client by `apps/web/src/lib/report.ts` over the event slice of one run (`run.fromIndex` to `run.toIndex`). It is a deterministic reduction with no LLM call and no command parsing. Command text pairs `tool_start` with `tool_end`. Missing exit codes are stored as `exitCodeKnown=false`.

## 7. Replay

Replay rebuilds a run from its events and periodic snapshots.

- A snapshot is taken every 25 events or every 5 seconds, whichever comes first.
- A snapshot stores the event index, timestamp, file map, agent status and current Stage action.
- File reconstruction: `file_write` replaces the file; `file_edit` applies `after`; `file_read` seeds only a path that is still unknown; `file_change deleted` removes the path.
- `seek` selects the latest snapshot whose timestamp is not later than the target, then applies the remaining events up to the target time.
- Playback advances on an 80 ms tick. Speeds are `0.25 / 0.5 / 1 / 2 / 5 / 10`. Playback pauses at the end of the run.
- The Monitor Stage timeline has three independent tracks — Model (the agent's think and speak), Tools (tool calls, including MCP), and Shell (command execution) — and seeks on click. Rounds story cards and Monitor feed rows also seek when clicked.

Replay scope:

| Reconstructed | Not reconstructed |
|---|---|
| File contents, agent status, current Stage action. | Metric curves, the Agent Eggs panel, PTY terminal bytes. |

Metrics and eggs are separate live views. The terminal mirror is not replayed.

## 8. Process observation

`JobMonitor` is created once per server process, before any session exists. On Windows it uses `native/agentwatch` to place the server process in a Job Object and reports descendant creation and exit. On Linux it uses `native/agentwatch-linux` eBPF tracepoints, which require `CAP_BPF`/`CAP_PERFMON` or root.

When the helper is unavailable, or when a root process is outside the Job Object, `ProcessWatcher` falls back to process-table snapshots. On Windows the snapshot uses PowerShell `Get-CimInstance Win32_Process`; elsewhere it uses `ps`. The fallback has a sampling floor of about 0.5 seconds, and the metric precision is marked `sampled`. Kernel-sourced values are marked `exact` when they come from a held handle.

Attribution:

- Driven sessions: the projector opens a command window when a `tool_call` of `kind=execute` appears and closes it at the terminal update. Kernel events are claimed by ancestry; the command window decides which command they belong to.
- A reported process is a subtree root. Descendants are counted in `children` and do not become separate eggs.
- Orphaned processes, with a broken parent chain or unknown parent pid, are not claimed.

Classification (`classify.ts`) checks, in order: outlived its command, has children, named by the command, backgrounded and redirected, installed tool directory, runs from the workspace, lifetime under 300 ms, short-lived name prior under 2 seconds, otherwise unclassified. Primary processes become Agent Eggs; helpers fold into a count and name summary.

Docker containers run inside the daemon VM, outside both the Job Object and eBPF. `DockerMonitor` reads lifecycle from `docker events` and resources from `docker stats`. Containers started inside a command window become egg entries with a synthetic pid at or above 1,000,000,000. Containers started outside a command window are not attributed.

## 9. Desktop packaging

`apps/desktop` is an Electron shell with Electron 37 and electron-builder. `main.cjs` starts the server in the same process, so the app has one lifecycle and no child console window. A source tree loads the server through `tsx`; a packaged build loads `apps/server-bundle.cjs`.

Packaging stages the bundled server, its runtime `node_modules`, the built web app from `dist/web` and a launcher script. The Windows package adds `native/agentwatch/agentwatch.exe`; the Linux package adds `native/agentwatch-linux/agentwatch-linux`. The web build is the same one a browser uses.

Electron must bundle Node 22.19 or later because the server uses `node:sqlite`. The repository pins Node through `engines` and `.nvmrc`.

Drip opens as a separate transparent, always-on-top window in the desktop shell. In a browser build it uses Document Picture-in-Picture.

## 10. Boundaries

- ACP reporting is `SHOULD`; the protocol does not require `MUST`. A missing `kind` becomes `other`; missing `locations` leave the read range unknown unless the returned text matches the file on disk exactly and uniquely, which verifies the range. Absence does not guess missing fields.
- Tool calls with a missing or unhelpful `kind` go through field-shape rules in `ToolRules`. Some tool payloads cannot be classified by shape.
- Process attribution for concurrent commands can misattribute when command lines do not match. The fallback keeps the process.
- Short-lived processes can be missed in snapshot mode.
- Whether Codex's Windows sandbox keeps child processes inside the Job Object depends on the agent implementation. Absence does not assert it.
