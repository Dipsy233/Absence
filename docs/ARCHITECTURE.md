# Architecture

Deep-dive documentation for Absence's internals. For an introduction and usage
guide, see the [README](../README.md).

## Architecture

```
Browser ──WebSocket──▶ Absence Server ──EventBus──▶ AcpAdapter ──▶ any ACP agent
   ▲                                                (pi-acp / codex-acp /      │
   │                                                 claude-code-acp / dsh / …) │
   └────────────── AbsenceEvent stream (file_read / file_edit / command / …) ┘
```

- `packages/core` — the shared `AbsenceEvent` + domain types. The only vocabulary
  the UI knows; it never learns which agent produced an event.
- `apps/server` — Fastify + WebSocket. There is exactly one driving path:
  `AcpAdapter` speaks the Agent Client Protocol to a profile from
  `agents/acp/profiles.ts` (or `~/.absence/agents.json`), and
  `AcpToolMapper` / `ToolRules` project `session/update` notifications into
  `AbsenceEvent`s by protocol `kind` and payload shape — never by a product
  name or a tool title. `MockAdapter` is a scripted fixture for development;
  `chokidar` watches the project for out-of-band changes.
  **Absence does not take over the agent's shell.** The ACP `execute` call
  opens a `ProcessWatcher` window and the OS reports the processes inside it;
  `ProcessWatcher` observes the process table (Job Object on Windows, eBPF on
  Linux, sampling elsewhere). Pi, Codex, DSH and any other ACP agent run inside
  their own terminal software with their own executor.
  A process is an egg when it appeared inside a command's window and its
  ancestor chain reaches Absence; eggs are reported at the root of each new
  subtree, and nothing is ever killed.
  Eggs are then **classified by behaviour, not by name** (`process/classify.ts`,
  with the command's own text parsed by `process/CommandIntent.ts`). A process is
  `primary` when it outlived its command, spawns its own processes, is a subject
  the command named (`./daemon.sh`, `python train.py`), was backgrounded or
  redirected by the command, or runs from the workspace. It is a `tool` when it
  comes from a tool directory, or is simply *ephemeral* — gone in a few tens of
  milliseconds with no children — which catches helpers wherever they live,
  without any directory list to keep in step. A transparent launcher (`nohup`,
  `setsid`, `time`, `env`) is passed through so the child it starts is the egg.
  The name prior in `process/priors.ts` is only a tiebreaker, never a verdict —
  a `cat` that outlived its command is still primary. The eggs panel lists
  primaries and folds tools into a count; Activity and the Report apply the same
  filter. One platform difference matters for attribution: on Linux a process
  can `exec` in place, so `nohup node ticker.mjs` reports twice under one pid —
  once as `nohup`, once as `node`. A pid alone therefore cannot mean "already
  handled"; the watcher keys on the **(pid, command line)** pair.
  Absence archives the `AbsenceEvent` stream it observed; the agent keeps its
  own conversation, and the opaque ACP resume handle is stored with the archive
  so a reopen can continue the agent's session.
  **Resource metrics (v0.4) bypass the event stream**: `process/ProcessMetrics`
  samples each egg's subtree for cumulative CPU and RSS on an adaptive cadence
  (2s→60s, chosen by concurrent primary count; a selected egg pins 2s) — Linux
  reads `/proc`, Windows asks CIM once, other platforms `ps` — in Prometheus
  shapes: counters and gauges, with `rate()` and averages derived client-side.
  Everything persists to SQLite through `storage/metrics.ts` as 30-minute binary
  chunks (Float32 CPU deltas + Uint32 RSS KiB), kept for 30 days. The newest 300
  frames ride the snapshot to new clients and are only the freshest tail: the
  dashboard merges them onto the persisted points, so a session closed and
  reopened later keeps its whole curve and the sampled silence stays a hole.
  The machine's own counters persist to `host_metric_chunks` next to the eggs,
  which is what lets the expanded dashboard draw the host as a dashed reference
  line for a session that is no longer live. Session averages accumulate
  separately in `egg_metric_summary`, independent of the in-memory ring, and are
  re-read from it when a session is reopened so they stay continuous. It
  reaches the UI over a `metrics` WS frame and
  `GET /api/sessions/:id/metrics`, consumed by the right-rail METRICS panel and
  the full-screen Stage dashboard (uplot). The dashboard's ranges live in
  `lib/metrics.ts` (`RANGES` / `rangeStart`) rather than in the component:
  only `all` anchors to the session's start, every other range is relative to
  now — anchoring them to the session too made 30m/1h collapse onto 1m's window
  whenever the session was younger than the range. Tools are not sampled per tick; they
  fold into one aggregate `tools` series, and an exit appends a final point
  from `WatchExit.cpuMs`.
  Two clocks on the dashboard are deliberately **not** wall time. "Observed
  for" is the selected egg's own lifetime (`startedAt` → `exitedAt`, frozen once
  it exits), because the question is how long that process ran. "Session
  duration" is *dwell* time: `Session.dwellMs` is the total accrued by earlier
  visits and `openedAt` marks this one, so leaving the project and returning
  later continues the clock instead of restarting it or counting the hours in
  between. The server accrues it (`AbsenceSession.dwellNow`) and writes it into
  the archive's `meta_json` on every meta flush, so a reopen resumes from it and
  a crash does not lose it.
- `apps/web` — React + Vite + Tailwind + Zustand + Monaco + Framer Motion. The
  panels are entry points and the Stage is where content lives; the Absence Report
  and Agent Eggs are both reductions of the same event stream. Chat renders the
  agent's replies as Markdown through a hand-written parser (`lib/markdown.ts` →
  `components/common/Markdown.tsx`): it produces a typed tree that is rendered as
  React elements, so no HTML string ever reaches the DOM and no sanitiser is
  needed. Paths and links in a reply open the file on the Stage, and the header
  toggle shows the raw text when the rendering gets in the way.

```
absence/                     npm workspaces: packages/*  apps/server  apps/web
  dist/                   ALL build output (git ignored), one place:
    web/                    the built UI (apps/web → vite outDir)
    desktop/build/          server bundle + staged production node_modules
    desktop/release/        packaged app (portable folder / installer)
  tsconfig.base.json      strict, noUncheckedIndexedAccess
  native/agentwatch/      Windows process observer (Job Object, committed prebuilt)
  native/agentwatch-linux/ Linux process observer (eBPF, committed prebuilt)
  start-absence.bat          shortcuts that forward to the launchers below
  start-absence-app.bat      (thin, one line each — the real logic lives with
  start-absence.sh           the code it launches, not at the root)
  scripts/
    browser/start-absence.bat  browser launcher (Windows)
    browser/start-absence.sh   browser launcher (Linux)
    checks/               check-*.ts acceptance scripts (harness.ts shared,
    run-offline.ts        run-offline.ts runs every offline check)

apps/desktop/             Electron shell (not a workspace; own node_modules)
  main.cjs                runs the server in-process, opens the window, tray
  start-absence-app.bat      desktop launcher (Windows)
  assets/tray.png         tray icon
  scripts/                desktop-only build tooling:
    bundle-server.mjs       compile the server + core to one CJS file
    stage-desktop.mjs       bundle + install prod deps for packaging
    make-icons.mjs          draw icon.png / icon.ico / tray.png

packages/core/src/        events.ts (AbsenceEvent + payload map)  types.ts  index.ts

apps/server/src/
  agents/                 AgentAdapter.ts (legacy bridge kept for MockAdapter)
                          createAdapter.ts (profile lookup → AcpAdapter)
                          registry.ts (the fixture registration door)
                          MockAdapter.ts (scripted fixture)
                          acp/  AcpAdapter.ts (the one client)
                                AcpConnection.ts + protocol/** (JSON-RPC/NDJSON)
                                AcpSession.ts  AcpPermissionBridge.ts  AcpAuth.ts
                                AcpConfigOptions.ts  AcpToolMapper.ts  ToolRules.ts
                                AgentCatalog.ts  profiles.ts
                                proxy/** (transparent ACP proxy mode)
  process/                ProcessWatcher.ts (eggs)
                          CommandLine.ts (shell-wrapper parsing for display)
                          ProcessTable.ts (pid / ppid / command line / start time)
                          observer.ts (platform-neutral event shapes)
                          JobMonitor.ts + JobSidecar.ts (Windows kernel events)
                          EbpfObserver.ts (Linux kernel events)
                          CommandIntent.ts + classify.ts + priors.ts (primary vs tool)
  runtimes/config.ts      launch-line overrides (~/.absence/runtimes.json)
  sessions/               SessionStore.ts  archive.ts (facade)
                          storage/db.ts (SQLite ~/.absence/absence.db; sessions, events, runs)
                          storage/runs.ts (incremental run index for History)
                          storage/files.ts (incremental file-version index)
                          storage/metrics.ts (SQLite metric chunks and summaries)
                          storage/legacyPaths.ts (~/.absence/sessions)
  filesystem/             FileTree.ts  FileWatcher.ts (chokidar)
  events/                 EventBus.ts
  websocket/ws.ts   api/{projects,sessions,runtimes,sounds,avatarSkins,eggFilter}.ts
                    util/{diff,ids,language,paths}.ts
  config.ts  index.ts

apps/web/src/
  app/App.tsx
  components/
    layout/               the shell: SessionBar  LeftRail  Stage  RightRail
    stage/                where content goes: MetricsDashboard  FileStage  DiffStage
                          TerminalStage  ThoughtStage  ProcessStage
                          ApprovalStage  StageToolbar
                          ReplayBar  StageItemView.tsx  ReportOverlay.tsx (the Absence Report)
    agent/                Avatar.tsx (the WhaleBun character)  AgentPanel.tsx
                          AgentFolder.tsx  MediaAvatar.tsx (uploaded skins)
                          whalebun.css (generated)
    eggs/                 AgentEggsPanel.tsx (primaries; tools folded; running /
                          dead / all)
    files/  history/  activity/  chat/  ProjectPicker/  Panel.tsx
    common/               SettingsDialog.tsx (the four-pane dialog)  AvatarSkinPane
                          SoundPane  EggFilterPane  Markdown.tsx (chat rich text)
  stores/                 session  file  stage  replay  chat  ui  settings  reset
  hooks/                  useSessionSocket  useStage  useReplay  useNow
                          useSounds
  lib/                    events (event → Stage item / Activity row)
                          report (the Absence Report engine)   eggs (process → eggs)
                          markdown (the chat's Markdown reader)
                          replay  history  context  commands  agent  format  …
  types/                  stage  history  replay  report  chat  file
  index.css

apps/web/public/whalebun/     the avatar's PNG parts (16: body, head, hair, ahoge,
                          tail, hands, feet, 7 faces)

apps/server/src/process/
  egg-filters/            Agent Eggs filter profiles (named JSON files; the
                          classifier reads the active one; active.json points
                          at it)  — managed from the Settings dialog
  avatar-skins/           user-uploaded avatar skins (one folder per skin,
                          files named <status>.<ext>; active.json) — managed
                          from the Settings dialog, served at /avatar/<status>

scripts/                  make-demo.mjs
  browser/                start-absence.bat  start-absence.sh (browser launchers)
  checks/                 check-history.ts  check-report.ts  check-eggs.ts
                          check-classify.ts  check-agentwatch.ts  check-ebpf.ts
                          check-acp.ts  check-acp-lifecycle.ts  check-acp-transport.ts
                          check-acp-mapping.ts  check-acp-proxy.ts
                          check-agent-catalog.ts  check-fsdiff.ts  check-metrics.ts
                          check-incremental.ts  check-outside-attr.ts
                          harness.ts  run-offline.ts (shared harness + runner)
                          gen-whalebun.css.mjs (regenerates whalebun.css)
```

## The ACP boundary (`agents/acp/`)

Every agent is one profile plus one client. There is no per-product adapter,
protocol, shell takeover, skills/MCP scan or approval policy.

```
AgentAdapter (legacy bridge)
  └─ AcpAdapter ── AcpConnection ──(stdio NDJSON, JSON-RPC)── <profile launch line>
        │                                                        (pi-acp, codex-acp,
        │                                                         claude-code-acp, dsh, …)
        ├─ AcpSession            lifecycle, turns, cancel watchdog
        ├─ AcpPermissionBridge   session/request_permission ↔ the UI's answer
        ├─ AcpAuth               advertised login methods, deferred session
        ├─ AcpConfigOptions      the agent's own selectors
        └─ AcpToolMapper         session/update → AbsenceEvent
```

- **Profiles are data** (`agents/acp/profiles.ts` + `~/.absence/agents.json` +
  the optional ACP registry cache). A launch line, its env, its prerequisites and
  its auth hint live there; a new agent adds a row, not a code branch.
- **Capability-gated lifecycle** — `session/resume`, `session/load` and
  `session/close` are only sent when `initialize` declared them. Prompt blocks
  are trimmed to the declared `promptCapabilities`.
- **Projection by protocol, not by product** — `AcpToolMapper` uses ACP `kind`
  first and a shape table (`ToolRules.ts` / `toolRules.json`) when the agent
  omits it. No rule matches a tool title or an agent name.
- **Cancel ordering** — `cancel` answers every pending permission `cancelled`
  before it sends `session/cancel`; a watchdog settles a turn when the agent
  ignores the request.
- **Approvals** — the agent's options are surfaced as an `approval` event and
  `respondPermission` echoes the selected option id verbatim. There is no
  auto-accept/decline path in the contract.
- **`/` commands** — forwarded as prompt text, verbatim. Absence does not parse
  or implement `/model`, `/skill`, `/skill:<name>` or `/mcp`; the agent decides.
  `/auth` is the one ACP port action Absence performs (`authenticate`).
- **Proxy mode** — `agents/acp/proxy/**` relays bytes untouched between an
  external ACP client and its agent, and taps them into the same event stream.

## Runtime paths (launch lines, not vendor binaries)

Absence bundles no runtime. `runtimes/config.ts` persists a profile id →
launch-line map to `~/.absence/runtimes.json`, editable from the project picker;
`AgentCatalog` resolves it over the shipped data and any user entries. When a
chosen profile cannot start (not installed, wrong path), the session fails with
a clear message — there is **no fallback to the mock runtime**.

## History and resume

History is Absence's own archive (SQLite). No agent-private session file is read
or merged. The agent's opaque ACP resume handle is stored with the archive and
reused on reopen, so the client resumes by `absenceSessionId` alone.

## AbsenceEvent

The core UI understands exactly one structure — the event union below. Whatever
runtime produced an update, only these types ever cross the WebSocket:

```ts
type AbsenceEventType =
  | "agent_start" | "agent_end" | "message"   | "thinking"
  | "tool_start"  | "tool_update" | "tool_end"
  | "file_read"   | "file_write"  | "file_edit" | "file_change"
  | "command"     | "search"      | "process"   | "approval" | "mcp" | "error";
```

Extensions over the original v0.1 spec:

- **`search`** — `grep` / `find` / `ls`, so searching is visible. It renders
  through the terminal view (one output surface for "the agent ran something").
- **`file_change`** — raw filesystem-watcher activity, for edits that happen
  outside the agent's own tools (bash, sed, …).
- **`process`** — an OS process the agent laid, reported by the process watcher
  (see Agent Eggs).
- **`approval`** — the agent asking the user for permission; recorded as
  an `APPROVE?` activity and answered from the Stage verbatim.
- **`mcp`** — a call into an MCP server, reported *in addition to* its
  `tool_start`/`tool_end` pair. Those carry no result and no notion of a server,
  so a person watching could not tell an MCP call from a built-in one. The event
  splits `mcp__<server>__<tool>` back apart and carries the arguments, the
  result text, the server's `structuredContent` and how it ended. Activity shows
  `MCP  filesystem › list_directory` (and `MCP!` when the server said no); the
  Stage renders it through the terminal view — `mcp <server> › <tool>` with an
  `mcp` chip, the arguments, the output, and a text/json toggle when the server
  returned structured content. Any ACP agent that reports an `mcp__*` tool call
  emits it, so the run looks the same whichever agent produced it. The Absence
  Report folds them per
  server — calls, failures, tools — because an MCP-heavy run would otherwise
  look idle: it changed no files and ran no shell commands.

Context usage, status, model and the file tree ride a separate
`session_state` websocket message, so the event union stays clean.

## HTTP / WS API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects` | List projects under the root (`?root=` to override) |
| `GET` | `/api/sessions/history` | Saved sessions (Absence archives + Pi), newest first; `?path=` filters |
| `POST` | `/api/sessions` | `{ projectPath, agent?, resume? }` → create or reopen a session |
| `GET` | `/api/sessions/:id` | Session snapshot (session, files, chat, tree, run summaries, newest 2,000 events; `?eventLimit=`) |
| `GET` | `/api/sessions/:id/file-versions` | Every recorded file version (Agent Folder / File History), independent of events |
| `GET` | `/api/sessions/:id/runs` | Run summaries for History (no event payloads) |
| `GET` | `/api/sessions/:id/runs/:index/events` | One run's summary and events, fetched when History selects it |
| `GET` | `/api/sessions/:id/events?before=&limit=` | Persisted events page (`{ events, nextBefore, hasMore }`, oldest → newest; `before` is an exclusive seq cursor) |
| `GET` | `/api/sessions/:id/file?path=` | Read a project file (the user view) |
| `POST` | `/api/sessions/:id/prompt` | `{ prompt }` → send to the agent |
| `POST` | `/api/sessions/:id/abort` | Interrupt the run |
| `GET` | `/api/sessions/:id/commands/:name/options` | Choice list for a command that needs one (`model`, `thinking`) |
| `POST` | `/api/sessions/:id/command` | `{ name, args? }` → run a chat command |
| `DELETE` | `/api/sessions/:id` | Dispose the session |
| `GET` | `/api/egg-filter` | Agent Eggs filter profiles: the list, the active name and its names |
| `PUT` | `/api/egg-filter/:name` | `{ names, force? }` → save a profile (overwrite/create) and activate it |
| `POST` | `/api/egg-filter/:name/activate` | Activate a saved profile |
| `DELETE` | `/api/egg-filter/:name` | Delete a profile |
| `GET` | `/api/avatar-skins` | Avatar skins: folders, the active one and its files |
| `POST` | `/api/avatar-skins/:name` | Create an empty skin folder |
| `PUT` | `/api/avatar-skins/:name/files?status=&filename=` | Raw file bytes → store as that status's animation (videos re-encoded with ffmpeg) |
| `DELETE` | `/api/avatar-skins/:name/files/:status` | Clear one status |
| `DELETE` | `/api/avatar-skins/:name` | Delete a skin folder |
| `POST` | `/api/avatar-skins/:name/activate` | Activate a skin (empty name = built-in WhaleBun) |
| `GET` | `/avatar/:status` | The active skin's media for a status (206 Range supported; 404 = no upload) |
| `WS` | `/ws/sessions/:id` | `{type:"snapshot"}` then `{type:"event"}` / `{type:"session_state"}` |

`session_state` also carries the agent's advertised `agentCommands` and auth
methods, so the palette only lists what the agent itself exposes.

The file endpoint refuses paths outside the project, refuses non-files, caps size
at 512 KB and rejects binaries.

## Chat commands

The chat dock at the bottom of the Stage doubles as a small terminal. A line
starting with `/` is **still a normal prompt**: the agent owns its meaning.
Absence does not parse or implement `/model`, `/skill`, `/skill:<name>`, `/mcp`
or any other product command. The line is forwarded verbatim, and the agent
decides whether it recognises it.

The `/` button opens a filterable palette above the input. It is a completer,
not an interpreter: it lists exactly the commands the agent advertised
(`available_commands_update`) plus the one ACP action Absence performs:

| Command | Who owns it |
|---|---|
| `/auth [methodId]` | Absence: the ACP `authenticate` call, with the methods the agent advertised. |
| anything the agent advertises (`/compact`, `/review`, …) | The agent: the whole line is sent as prompt text. |
| `/model`, `/skill`, `/mcp`, an unknown `/foo` | The agent: still forwarded as prompt text; Absence never drops the line. |

`SessionStore.forwardCommand(text)` is the whole implementation — it records the
line as a user message and sends it as a prompt. Results come back as ordinary
run events and are archived with the session, so they return on resume.

## Desktop shell internals

What the Electron shell adds over the browser, and what packaging produces:

- **Electron must bundle Node ≥ 22.19.** Electron ships its own Node, and it is
  what runs the in-process server — not the `node` on `PATH`. Some ACP agents
  declare `engines.node >= 22.19` and import `globSync` from `node:fs`, which
  only exists from Node 22. On an older Electron the shell loads, then the
  session fails with a readable runtime error (there is no silent fallback to
  the mock runtime). As of writing, Electron **37.x bundles Node 22.21.1**
  (Electron 33 bundles Node 20.18, which is too old). If you bump Electron,
  check the bundled Node in the release notes, not just the version number.
- **Electron is installed separately**, into `apps/desktop/node_modules` (it is
  deliberately *not* a workspace member). It carries its own `tsx` + esbuild so
  the Windows shell never picks up the Linux-built `esbuild` in the root
  `node_modules`.
- **The desktop shell and the browser are the same app.** Anything true in the
  browser (Replay, the Absence Report, Agent Eggs) is true in the window, because
  it is the same web build talking to the same server over the same `/api` and
  `/ws`.

The packaging scripts (`npm run desktop:dist` / `desktop:pack`) produce three
generated pieces (all under `apps/desktop/scripts/`, because they are
desktop-only):

- **`bundle-server.mjs`** compiles ABSENCE's own server (and `@absence/core`)
  into `dist/desktop/build/server.cjs`. A shipped app has no `tsx`, so the
  TypeScript can no longer be loaded at runtime. Third-party packages stay
  *external* and are resolved from a pruned `node_modules` instead, because some
  of them ship assets (`.wasm`) or load parts of themselves dynamically, so
  bundling them would break them.
- **`stage-desktop.mjs`** runs that bundle and installs the server's
  production dependencies (`npm install --omit=dev`) into
  `dist/desktop/build/node_modules`. It installs fresh rather than filtering the
  root `node_modules`, which mixes platforms when one checkout is shared
  between platforms. The result is what electron-builder copies to
  `resources/node_modules`.
- **`make-icons.mjs`** draws `icon.png` / `icon.ico` / `tray.png` into
  `apps/desktop/assets/` — no image library, no committed binary. The generated
  icons are committed anyway so a fresh clone can build without this step.

The packaged app finds its pieces under `process.resourcesPath` instead of the
repo root (see `main.cjs`): `apps/server-bundle.cjs`, `dist/web`,
`node_modules`, and the native helpers under `native/`. The native observer path
is set explicitly via `ABSENCE_AGENTWATCH` / `ABSENCE_AGENTWATCH_LINUX`, because the
server's own path heuristic assumes a checkout layout.
