# Architecture

Deep-dive documentation for Absence's internals. For an introduction and usage
guide, see the [README](../README.md).

## Architecture

```
Browser ──WebSocket──▶ Absence Server ──EventBus──▶ AgentAdapter ──▶ Pi (SDK, in-process)
   ▲                                                                     │
   └────────────── AbsenceEvent stream (file_read / file_edit / command / …) ┘
```

- `packages/core` — the shared `AbsenceEvent` + domain types. The only vocabulary
  the UI knows; it never learns that Pi exists.
- `apps/server` — Fastify + WebSocket. `PiAdapter` wraps the Pi SDK and maps
  `AgentSessionEvent` → `AbsenceEvent`; `MockAdapter` replays a scripted run with no
  credentials; `chokidar` watches the project for out-of-band changes. **Absence owns
  the shell**: `process/AbsenceShell` wraps Pi's own local shell operations and
  registers them as custom `bash` / `powershell` tools (a custom tool shadows the
  built-in one by name, so `ABSENCE_PI_TOOLS` is untouched). Pi still executes every
  command — Absence only owns the boundary, which is what tells `ProcessWatcher` when
  a command ran, and puts a unique marker at the head of it so the shell Pi
  spawns for that command (and the launcher around it) can be recognised exactly
  rather than guessed from a name or a parent chain.
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
    browser/start-absence.sh   browser launcher (Linux / WSL)
    checks/               check-*.ts acceptance scripts
    wsl-pi-config.sh      point WSL pi at the Windows host's model services

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
  agents/                 AgentAdapter.ts (the runtime-agnostic boundary)
                          PiAdapter.ts  MockAdapter.ts  createAdapter.ts
  process/                AbsenceShell.ts (owns the shell)  ProcessWatcher.ts (eggs)
                          ProcessTable.ts (pid / ppid / command line / start time)
                          observer.ts (platform-neutral event shapes)
                          JobMonitor.ts + JobSidecar.ts (Windows kernel events)
                          EbpfObserver.ts (Linux kernel events)
                          CommandIntent.ts + classify.ts + priors.ts (primary vs tool)
  sessions/               SessionStore.ts  archive.ts (~/.absence/sessions)
  filesystem/             FileTree.ts  FileWatcher.ts (chokidar)
  events/                 EventBus.ts
  websocket/ws.ts   api/{projects,sessions}.ts   util/{diff,ids,language,paths}.ts
  config.ts  index.ts

apps/web/src/
  app/App.tsx
  components/
    layout/               the shell: SessionBar  LeftRail  Stage  RightRail
    stage/                where content goes: DeskStage  FileStage  DiffStage
                          TerminalStage  ThoughtStage  ProcessStage
                          StageWorld (the desk)  StageToolbar  ReplayBar
                          StageItemView.tsx  ReportOverlay.tsx (the Absence Report)
    agent/                Avatar.tsx (the WhaleBun character)  AgentPanel.tsx
                          AgentFolder.tsx  MediaAvatar.tsx (uploaded skins)
                          whalebun.css (generated)
    eggs/                 AgentEggsPanel.tsx (primaries; tools folded; running /
                          dead / all)
    files/  history/  activity/  chat/  ProjectPicker/  common/  Panel.tsx
  stores/                 session  file  stage  replay  chat  ui  reset
  hooks/                  useSessionSocket  useStage  useReplay  useNow
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

scripts/                  make-demo.mjs  wsl-pi-config.sh
  browser/                start-absence.bat  start-absence.sh (browser launchers)
  checks/                 check-history.ts  check-report.ts  check-eggs.ts
                          check-classify.ts  check-agentwatch.ts  check-ebpf.ts
                          gen-whalebun-css.mjs (regenerates whalebun.css)
```

## AbsenceEvent

The core UI understands exactly one structure:

```ts
type AbsenceEvent = {
  id: string;
  sessionId: string;
  timestamp: number;
  type:
    | "agent_start" | "agent_end" | "message"   | "thinking"
    | "tool_start"  | "tool_update" | "tool_end"
    | "file_read"   | "file_write"  | "file_edit" | "file_change"
    | "command"     | "search"      | "error";
  payload: unknown;
};
```

Three extensions over the original v0.1 spec:

- **`search`** — Pi's `grep` / `find` / `ls`, so searching is visible. It renders
  through the terminal view (one output surface for "the agent ran something").
- **`file_change`** — raw filesystem-watcher activity, for edits that happen
  outside the agent's own tools (bash, sed, …).
- **`process`** — an OS process the agent laid, reported by the process watcher
  (see Agent Eggs).

Context usage, status, model and the file tree ride a separate
`session_state` websocket message, so the event union stays clean.

## HTTP / WS API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects` | List projects under the root (`?root=` to override) |
| `GET` | `/api/sessions/history` | Saved sessions (Absence archives + Pi), newest first; `?path=` filters |
| `POST` | `/api/sessions` | `{ projectPath, agent?, resume? }` → create or reopen a session |
| `GET` | `/api/sessions/:id` | Session snapshot (session, files, chat, events, tree) |
| `GET` | `/api/sessions/:id/events` | Event history |
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
  loads, then silently falls back to the mock runtime with `Pi runtime
  unavailable`. As of writing, Electron **37.x bundles Node 22.21.1** (Electron
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
  root `node_modules`, which mixes platforms when the checkout is used from both
  WSL and Windows. The result is what electron-builder copies to
  `resources/node_modules`.
- **`make-icons.mjs`** draws `icon.png` / `icon.ico` / `tray.png` into
  `apps/desktop/assets/` — no image library, no committed binary. The generated
  icons are committed anyway so a fresh clone can build without this step.

The packaged app finds its pieces under `process.resourcesPath` instead of the
repo root (see `main.cjs`): `apps/server-bundle.cjs`, `dist/web`,
`node_modules`, and the native helpers under `native/`. The native observer path
is set explicitly via `ABSENCE_AGENTWATCH` / `ABSENCE_AGENTWATCH_LINUX`, because the
server's own path heuristic assumes a checkout layout.

