# Architecture

Deep-dive documentation for Absence's internals. For an introduction and usage
guide, see the [README](../README.md).

## Architecture

```
Browser ──WebSocket──▶ Absence Server ──EventBus──▶ AgentAdapter ──▶ Pi (SDK, in-process)
   ▲                                                              ├─▶ Codex (app-server, JSON-RPC)
   │                                                              └─▶ DSH (dsh --profile acp, ACP/JSON-RPC)
   └────────────── AbsenceEvent stream (file_read / file_edit / command / …) ┘
```

- `packages/core` — the shared `AbsenceEvent` + domain types. The only vocabulary
  the UI knows; it never learns that Pi, Codex or DSH exists.
- `apps/server` — Fastify + WebSocket. Each runtime is one `AgentAdapter`:
  `PiAdapter` wraps the Pi SDK in-process and maps `AgentSessionEvent` →
  `AbsenceEvent`; `CodexAdapter` drives `codex app-server` over JSON-RPC and maps
  its notifications the same way (`AppServerClient` is the transport — chosen over
  `codex exec --json` because the app-server carries real item ids, call ids and
  timestamps); `DshAdapter` drives `dsh --profile acp`, DSH's automation-only
  Agent Client Protocol server, over JSON-RPC/NDJSON stdio (`DshClient` is the
  transport) and maps its `session/update` notifications; `MockAdapter` replays a
  scripted run with no credentials;
  `chokidar` watches the project for out-of-band changes. **Absence owns the
  shell in every real runtime.** For Pi, `process/AbsenceShell` wraps Pi's own
  local shell operations and registers them as custom `bash` / `powershell` tools
  (a custom tool shadows the built-in one by name, so `ABSENCE_PI_TOOLS` is
  untouched). For Codex, `process/ExecServer` *is* the executor: Absence starts a
  loopback exec-server, registers it with `environment/add` and pins the thread to
  it, so Codex hands every command to Absence as a `process/start` to spawn. For
  DSH, each shell tool call opens a `ProcessWatcher` window. Either
  way Absence owns the command boundary, which is what tells `ProcessWatcher` when
  a command ran. Pi marks the command with a `#` comment; Codex is attributed by
  ancestry alone, which the takeover makes complete; DSH is attributed by the
  window.
  `ProcessWatcher` then observes the process table. On **Windows** it does not
  sample it at all: `native/agentwatch` is a small helper that puts the server
  into a **Job Object**, and the kernel then reports every creation and exit as
  it happens. On **Linux** it does not sample either: `native/agentwatch-linux`
  attaches three eBPF tracepoints (`sched_process_fork/exec/exit` plus
  `sys_enter_execve` for argv) and reports the same events from a ring buffer. A
  process that lives 20 ms is seen like any other on both — polling could never
  see it. On other platforms, or if the helper cannot start, the watcher falls
  back to snapshots (one CIM query on Windows, `ps` elsewhere). A process is an egg
  when it appeared inside a command's window and its ancestor chain reaches Absence;
  eggs are reported at the root of each new subtree, and nothing is ever killed.
  Eggs are then **classified by behaviour, not by name** (`process/classify.ts`,
  with the command's own text parsed by `process/CommandIntent.ts`). A process is
  `primary` when it outlived its command, spawns its own processes, is a subject
  the command named (`./daemon.sh`, `python train.py`), was backgrounded or
  redirected by the command, or runs from the workspace. It is a `tool` when it
  comes from a tool directory, or is simply *ephemeral* — gone in a few tens of
  milliseconds with no children — which catches helpers wherever they live, such
  as Pi's own `fd.exe`, without any directory list to keep in step. A transparent
  launcher (`nohup`, `setsid`, `time`, `env`) is passed through so the child it
  starts is the egg. The name prior in `process/priors.ts` is only a tiebreaker,
  never a verdict — a `cat` that outlived its command is still primary. The eggs
  panel lists primaries and folds tools into a count; Activity and the Report
  apply the same filter. One platform difference matters for attribution: on
  Linux a process can `exec` in place, so `nohup node ticker.mjs` reports twice
  under one pid — once as `nohup`, once as `node`. A pid alone therefore cannot
  mean "already handled"; the watcher keys on the **(pid, command line)** pair, so
  the second event is judged as the new process it is. Pi keeps
  its own session file (so a conversation can be resumed) and Absence archives the
  `AbsenceEvent` stream it observed alongside it.
- `apps/web` — React + Vite + Tailwind + Zustand + Monaco + Framer Motion. The
  panels are entry points and the Stage is where content lives; the Absence Report
  and Agent Eggs are both reductions of the same event stream.

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
  capabilities/           discover.ts (skills + MCP, one scan for every runtime)
                          piResources.ts (skills → Pi's loader, MCP → Pi's extension)
                          manage.ts (create/import/delete skills, edit mcp.json)
  agents/                 AgentAdapter.ts (the runtime-agnostic boundary)
                          PiAdapter.ts  CodexAdapter.ts  CodexCommands.ts
                          DshAdapter.ts (DeepSeek Harness over ACP)
                          AppServerClient.ts (codex app-server JSON-RPC)
                          DshClient.ts (dsh ACP JSON-RPC/NDJSON)
                          PiBin.ts  CodexBin.ts (locate the user's runtime)
                          MockAdapter.ts  createAdapter.ts
  process/                AbsenceShell.ts (owns Pi's shell)  ProcessWatcher.ts (eggs)
                          ExecServer.ts (owns Codex's shell: the exec-server)
                          ShellEnvironment.ts (Codex env_policy)  CodexShell.ts (unwrap)
                          ProcessTable.ts (pid / ppid / command line / start time)
                          observer.ts (platform-neutral event shapes)
                          JobMonitor.ts + JobSidecar.ts (Windows kernel events)
                          EbpfObserver.ts (Linux kernel events)
                          CommandIntent.ts + classify.ts + priors.ts (primary vs tool)
  runtimes/config.ts      runtime paths (~/.absence/runtimes.json)
  sessions/               SessionStore.ts  archive.ts (facade)
                          storage/db.ts (SQLite ~/.absence/absence.db; sessions, events, runs)
                          storage/runs.ts (incremental run index for History)
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
    stage/                where content goes: DeskStage  FileStage  DiffStage
                          TerminalStage  ThoughtStage  ProcessStage
                          ApprovalStage  StageWorld (the desk)  StageToolbar
                          ReplayBar  StageItemView.tsx  ReportOverlay.tsx (the Absence Report)
    agent/                Avatar.tsx (the WhaleBun character)  AgentPanel.tsx
                          AgentFolder.tsx  MediaAvatar.tsx (uploaded skins)
                          whalebun.css (generated)
    eggs/                 AgentEggsPanel.tsx (primaries; tools folded; running /
                          dead / all)
    files/  history/  activity/  chat/  ProjectPicker/  Panel.tsx
    common/               SettingsDialog.tsx (the four-pane dialog)  AvatarSkinPane
                          SoundPane  EggFilterPane
  stores/                 session  file  stage  replay  chat  ui  settings  reset
  hooks/                  useSessionSocket  useStage  useReplay  useNow
                          useSounds
  lib/                    events (event → Stage item / Activity row)
                          report (the Absence Report engine)   eggs (process → eggs)
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
                          check-codex.ts  check-codexshell.ts  check-shellenv.ts
                          check-execserver.ts  check-fsdiff.ts
                          harness.ts  run-offline.ts (shared harness + runner)
                          gen-whalebun-css.mjs (regenerates whalebun.css)
```

## Codex (`CodexAdapter`)

Pi is embedded, so Absence controls the shell by wrapping Pi's tool operations.
Codex is a separate process, driven over its own protocol — and the observation
path is correspondingly different.

```
AgentAdapter
  └─ CodexAdapter ── AppServerClient ──(stdio JSON-RPC)── codex app-server
        │                                                     │
        │  environment/add(exe-server URL)                   │  process/start
        │  thread & turn environments ───────────────────────┘
        ▼
  CodexExecServer (loopback WebSocket, JSON-RPC)
        │  spawn(argv)  ← Absence is the executor
        ▼
  the command, Absence's own child inside the Job/eBPF window
```

- **Transport** — `AppServerClient` speaks newline-delimited JSON-RPC to
  `codex app-server`. The app-server (not `codex exec --json`) is used because it
  carries real item ids, call ids and `startedAtMs`/`completedAtMs`; the SDK's
  `--json` transport regenerates item ids and drops call ids and timestamps, so a
  command's lifecycle could not be paired with the processes it lays.
- **Shell takeover** — `CodexExecServer` is a small JSON-RPC server on loopback.
  `CodexAdapter.start` starts it, registers it with `environment/add` and puts it
  in the thread's `environments`, so Codex executes every command through it. It
  implements `process/start` (spawn), `process/read`/`write`, `process/terminate`
  and `process/signal` (interrupt), and drives `ProcessWatcher.begin/end` so eggs
  attribute exactly as they do for Pi.
- **PTY** — `process/start` with `tty: true` allocates a real PTY through
  `node-pty` (ConPTY on Windows); otherwise plain pipes. This mirrors Codex, which
  defaults to pipes and only allocates a PTY when the model asks.
- **Environment** — the executor builds the command's environment from the
  request's `env_policy` (`ShellEnvironment.ts`, a faithful port of Codex's
  `shell_environment::create_env`), then lets the request's sparse `env` win.
- **Display** — `CodexShell.ts` undoes Codex's shell wrapper (the `pwsh -Command
  "…"`, `bash -lc "…"`, `cmd /c …` and the UTF-8 preamble) so commands and eggs
  show what the model wrote.
- **Approvals** — Codex's `item/…/requestApproval` server-to-client requests are
  surfaced as `approval` events and answered by `respondApproval` (or
  automatically, per `ABSENCE_CODEX_APPROVAL_DECISION`).

## DSH (`DshAdapter`)

DSH (DeepSeek Harness) is a separate process like Codex, but it exposes a
different channel: an **automation-only Agent Client Protocol server** reached by
running `dsh --profile acp`.

```
AgentAdapter
  └─ DshAdapter ── DshClient ──(stdio NDJSON, JSON-RPC)── dsh --profile acp
        │                                                      │
        │  session/update notifications ──────────────────────┘
        │  session/request_permission (client callback)
        ▼
  AbsenceEvents (message / thinking / tool_* / file_* / command / process / approval)
```

- **Transport** — `DshClient` speaks newline-delimited JSON-RPC over the child's
  stdio. ACP (the Agent Client Protocol, the same wire format Zed's SDK uses)
  hands the whole turn over as `session/update` notifications; stdout belongs
  entirely to ACP, so there is no TUI to scrape.
- **Mapping** — `agent_message_chunk` → `message` (streamed), `agent_thought_chunk`
  → `thinking`, `tool_call`/`tool_call_update` → `tool_start`/`tool_end` plus the
  first-class `file_read`/`file_write`/`file_edit`/`command`/`search` derived from
  the tool name and its arguments, `usage_update` → context usage. DSH wraps read
  results in `<path>…<content>NN: line…`; the adapter unwraps them so `file_read`
  carries plain text like Pi's.
- **Agent Eggs** — each shell tool call (`pwsh` etc.) opens a `ProcessWatcher`
  window (`begin` on `tool_call`, `end` on `tool_call_update`), so the processes
  the command lays fold into one egg attributed to that command.
- **Approvals** — DSH's `session/request_permission` request is surfaced as an
  `approval` event; the chosen ACP option id is sent back.
- **Locating dsh** — `ABSENCE_DSH_BIN` / a saved path wins, then the DSH Desktop
  install, then a `dsh` on PATH. A `.cmd`/`.bat` wrapper is run through the shell
  (Windows cannot spawn it directly).

## Skills and MCP (`capabilities/`)

Both are **cross-runtime formats**, not vendor features, so Absence owns
discovery once and each adapter consumes it:

| | Format | Where every runtime looks |
|---|---|---|
| Skill | a directory with `SKILL.md` (`name` + `description` frontmatter, the [Agent Skills](https://agentskills.io) spec) | `~/.agents/skills`, `~/.pi/agent/skills`, `~/.codex/skills`, `~/.dsh/skills`, `<project>/.agents/skills` (ancestors up to the repo root), `<project>/.pi/skills` |
| MCP | an `mcpServers` entry (`command`/`args`/`env`, or `url`/`headers`) | `~/.pi/agent/mcp.json`, `<project>/.pi/mcp.json`; Codex's `~/.codex/config.toml` `[mcp_servers.*]` (converted by a small TOML reader) |

`capabilities/discover.ts` reads those files and returns `skills` + `mcpServers`
+ diagnostics. It executes nothing. `AgentAdapter.getCapabilities()` returns the
result as `CapabilityState`, which rides `session_state` to the web app.
`capabilities/manage.ts` is the writable half, reached from the chat dock as
`/skill` and `/mcp` (where Pi and Codex also put them) rather than from a
Settings pane — see "Chat commands".

What each adapter does with it:

- **Pi** — the deciding detail: **`createAgentSession` does not load the CLI's
  built-in extensions.** A naive embedding therefore loses `mcp`, `codemode` and
  `tool_search` (so `mcp.json` is never read and no `mcp__<server>__<tool>` ever
  exists), and the `~/.agents/skills` locations are only reached by the CLI's
  package manager. `capabilities/piResources.ts` supplies them:
  `DefaultResourceLoader.extensionFactories` gets `createCodemodeExtension()`,
  `createToolSearchExtension()` and `createMcpExtension()`; discovered skills are
  injected through `skillsOverride`; Codex-only servers are registered with
  `pi.registerMcpServer`. The adapter then calls **`session.bindExtensions({})`**
  — the MCP extension connects on `session_start`, which only fires once bindings
  exist. Every member is probed, so an older or newer installed Pi degrades to
  the previous behaviour instead of failing to start. `ABSENCE_MCP=0` skips the
  MCP half.
- **Codex** — reads the same files itself and exposes both over the app-server it
  already speaks: `skills/list` and `mcpServerStatus/list`. Those requests win
  when they work (Codex resolves plugin skills and layered config); the file scan
  is the fallback for older app-server builds.
- **DSH** — discovery over `<DSH_HOME>/skills`; its tool calls (MCP-backed or not)
  already arrive as `tool_call`, so they render on the Stage unchanged.

One trap is worth recording, because it looks like "Absence cannot connect to
MCP". Pi's `_isActivatable` keeps an MCP tool that a session's allowlist does not
name registered — but only lets it become *active* (declared to the model) for
non-`direct` exposure. `ABSENCE_PI_TOOLS` used to default to
`read,bash,edit,write,grep,find,ls`, so every session carried an allowlist: a
`direct` server connected, registered its tools, and was never declared. The
variable is now unset by default and `createAgentSession` receives no `tools`,
so Pi's own `defaultTools` selection applies and `direct` works as documented.
`scripts/dev/probe-absence-mcp.ts` reproduces the end-to-end check against a
live server.

MCP tool calls need **no new event type**: Pi's `createMcpExtension` registers
its tools through the normal pipeline, so a call arrives as
`tool_execution_start` / `tool_execution_end` with the tool named
`mcp__<server>__<tool>` and lands in the Activity stream like `read` or `bash`.
A connected server's tools are counted from the runtime's own registry
(`getAllTools`), which is why the panel's "connected / tools" figures can change
during a run.

## Runtime paths (client, not vendor)

Absence bundles no runtime. `agents/PiBin.ts` and `agents/CodexBin.ts` resolve
what to run and report the source (`configured` / `env` / `global` / `path` /
`bundled` / `none`); `runtimes/config.ts` persists overrides to
`~/.absence/runtimes.json`, editable from the project picker. When a chosen
runtime cannot start (not installed, wrong path), the session fails with a clear
message — there is **no fallback to the mock runtime**.

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
- **`approval`** — the runtime (Codex) asking the user for permission; recorded as
  an `APPROVE?` activity and answered from the Stage.
- **`mcp`** — a call into an MCP server, reported *in addition to* its
  `tool_start`/`tool_end` pair. Those carry no result and no notion of a server,
  so a person watching could not tell an MCP call from a built-in one. The event
  splits `mcp__<server>__<tool>` back apart and carries the arguments, the
  result text, the server's `structuredContent` and how it ended. Activity shows
  `MCP  filesystem › list_directory` (and `MCP!` when the server said no); the
  Stage renders it through the terminal view — `mcp <server> › <tool>` with an
  `mcp` chip, the arguments, the output, and a text/json toggle when the server
  returned structured content. Pi (`tool_execution_end` for `mcp__*`), Codex
  (`McpToolCall` items) and DSH (a `mcp__*` tool name) all emit it, so the run
  looks the same whichever runtime produced it. The Absence Report folds them per
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

`session_state` also carries `capabilities` (skills + MCP servers), which is
what `/skill` completes from and what `/mcp list` reports; it updates live as
servers connect.

The file endpoint refuses paths outside the project, refuses non-files, caps size
at 512 KB and rejects binaries.

## Chat commands

The chat dock at the bottom of the Stage doubles as a small terminal. A line
starting with `/` is a command; anything else is an ordinary prompt. The `/`
button on the left of the input opens a filterable palette above it — ↑/↓ to
move, Enter or click to run, Esc to clear.

| Command | What it does |
|---|---|
| `/model [provider/id]` | List and switch the model |
| `/thinking [level]` | Show or set the thinking level |
| `/compact [instructions]` | Compact the conversation context |
| `/name [name]` | Set the session display name |
| `/session` | Show session info and stats |
| `/export [html\|jsonl]` | Export the session under `~/.absence/exports/` |
| `/skill [name]` | List the skills the session can load; `/skill <name> [request]` loads one. Pi adds `/skill:<name>`, which the input passes straight through as a prompt |
| `/mcp [subcommand]` | `list` (default) · `reconnect [server]` — the session-scoped surface only |

`/skill` and `/mcp` match the runtimes' own commands. A skill is *loaded* by
naming it (`/skill:demo-skill fix the flaky test`), not configured in a dialog.
`/mcp` is session-scoped exactly like Pi's: list and reconnect. Adding,
removing, enabling or disabling a server edits the shared `mcp.json`, which
every runtime deliberately keeps outside the session — `pi mcp add …`,
`codex mcp add …`, or a file edit, then `/mcp reconnect` here applies it (the
transport belongs to Pi's MCP extension, so Absence reloads the session's
extensions — which re-emits `session_start` and makes the extension redial —
and reports the state that follows). The input completes skill names after
`/skill:`.

Switching the model is **session-scoped** — Pi's global default is left alone.
Results are printed back into the chat as system messages and archived with the
session, so they come back on resume.

Commands dispatch through the runtime-agnostic `AgentAdapter`, so a different
runtime only has to implement those few methods (the web UI does not change).
Pi's own built-in slash commands live in its interactive TUI rather than the
SDK, so these are mapped onto SDK calls (`setModel`, `setThinkingLevel`,
`compact`, `setSessionName`, `getSessionStats`, `exportToHtml`/`exportToJsonl`)
rather than delegated to Pi.

## Desktop shell internals

What the Electron shell adds over the browser, and what packaging produces:

- **Electron must bundle Node ≥ 22.19.** Electron ships its own Node, and the
  owned runtime is what runs the in-process server and Pi — not the `node` on
  `PATH`. Pi's package declares `engines.node >= 22.19` and imports `globSync`
  from `node:fs`, which only exists from Node 22. On an older Electron the shell
  loads, then the session fails with `pi runtime could not start` (it no longer
  silently falls back to the mock runtime). As of writing, Electron **37.x
  bundles Node 22.21.1** (Electron
  33 bundles Node 20.18, which is too old). If you bump Electron, check the
  bundled Node in the release notes, not just the version number.
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
  *external* and are resolved from a pruned `node_modules` instead — notably
  `@earendil-works/pi-coding-agent`, which ships a `.wasm` asset and loads
  parts of itself dynamically, so bundling it would break it.
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

