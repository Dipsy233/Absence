# DAZE / 发呆症

> AI moves fast. Humans watch.

DAZE is a real-time visualization observer for AI agents. It does not try to make
an agent smarter — it lets a human *see* what the agent is doing.

```
Pi runs the agent.
Daze observes the events.
The Stage turns events into something humans can watch.
```

## The idea

The desk used to be where a person worked. Then the AI arrived, and at first it
was the one who needed help — barely competent, forgetting mid-task, so the
human stayed close: feeding it context, correcting it, designing the workflow
around its faults.

Now it is the other way round. The agent knows more, moves faster, and finishes
before you can read a line of it. There is nothing left to assist and nowhere to
put your hands, so the human sits at the desk and watches — eyes on an unbroken
stream of commands, pretending to follow, attention quietly scattering. That
half-watching is the daze. **DAZE / 发呆症** is built around it, and pulls in two
opposite directions:

- **Understand it, and stay with it.** Compress the event stream into something
  a person can actually watch — a desk, a monitor, a sheet of paper — so
  attention has somewhere to land. This is the Stage:
  `Overview → Inspect → Stage → Replay`.
- **Stop needing to watch at all.** Collect what the run really did and report
  it in seconds — what changed, what ran, what failed, what needs you — so you
  can leave the desk and come back to the gist. This is the Daze Report.

Panels are entry points, never the final content — the Stage is where content
lives. And **live never slows the agent down**: the run plays at real speed, and
slowing down is what Replay is for.

## Two perspectives

The whole UI is split by *whose view* you are looking at:

|  | **Left** — the user's view | **Right** — the agent's view |
|---|---|---|
| Files | the whole project tree | only files the agent has in context |
| Opening a file | the **whole file**, read from disk | **only what the agent read/edited** |
| The FILE button | the `userFile` slot | the `agentFile` slot |

The two slots are independent. If the agent read lines 10–20 of a file, the
Agent Folder lists it and its FILE button shows just those lines — and after two
reads of 1–2 and 3–5 it shows 1–5, never a gap silently bridged (unread lines in
between become explicit `⋯ (line 6 — not in the agent's context)` markers so the
numbering still matches the real file).

The left tree can do this because a *user* is allowed to read their own project;
the right side never pretends to know more than the agent does.

### File versions

Each file the agent touches records **one version per state**, oldest first:

```
v0  read   lines 1–5        ← the union of everything it has read so far
v1  write  whole file
v2  edit   whole file
```

Versions are *recorded*, not derived. The text is captured at the moment the
agent saw it — the `read` slice comes from the tool result the model actually
received, a `write` from the argument it sent, an `edit` from applying its own
edits to the file it held. Later changes on disk (by the agent or anything else)
can never rewrite an earlier version, because nothing points back at the source
file.

That matters because an LLM's context really does keep the earlier versions, and
it makes the Agent Folder useful for looking back: expand a file and click any
version to put that exact state on the Stage. A read after a write does not roll
the file back, and v0 (partial, from reads) is never diffed against full-file
versions in Files → History.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│                         SESSION BAR                          │
├──────────────┬───────────────────────────────┬───────────────┤
│    FILES     │  [FILE DIFF REPLAY]  TABLE    │     AGENT     │
│  (user view) │        [TERMINAL FILE LIVE]   │    (avatar)   │
│              │                               │               │
├──────────────┤───────────────────────────────├───────────────┤
│   HISTORY    │                               │ AGENT FOLDER  │
│   (runs)     │            STAGE              │ (agent view)  │
├──────────────┤                               ├───────────────┤
│   ACTIVITY   │  replay controls, only while  │  AGENT EGGS   │
│  (selected   │  replaying                    │  processes it │
│     run)     │  chat dock: one input row     │   left running│
└──────────────┴───────────────────────────────┴───────────────┘
```

- **Session bar** — session id, project, model, context usage, live/offline, and
  a *change* button to pick another project.
- **Files** (left) — tree → detail → history. The tree marks files the agent has
  touched (`●`) and highlights the file currently on the Stage. Right-click for
  *Inspect / Open in Stage / View History / View Diff / Add to Chat / Explain this*.
- **History** (left) — one row per **run**: prompt to completion or interruption,
  oldest first with the newest at the bottom. Shows time, status
  (`running`/`done`/`stopped`/`error`), duration, the prompt, and action counts
  `R` read · `S` search · `E` edit · `C` created · `$` command. Selecting a run
  filters the Activity panel; the **⟲** button rolls the view back to the state
  at the end of that run (see Replay — DAZE never writes to the project, so this
  is a view-only revert).
- **Activity** (left) — the selected run's actions, oldest first. Click a row to
  put it on the Stage; its header has a **▶ replay** button that replays that run.
  Reasoning is captured too: a `thinking` event is a **THINK** row, so the
  agent's own words sit next to the actions they led to.
- **Stage** (center) — file, diff, terminal, thinking, desk or replay. The desk world is
  the default page and is always drawn as the background; FILE / DIFF /
  TERMINAL / LIVE ride on top of it as a slightly translucent sheet. The mode
  switcher has three groups: the user's (FILE / DIFF / REPLAY), **TABLE** in the
  middle for the default desk page, and the agent's (TERMINAL / FILE / LIVE).
  Chat is docked at the bottom of the Stage. It floats over the Stage rather
  than taking layout space, so the middle never shrinks: one input row always,
  with the history unfolding upward as a translucent layer at most 30% of the
  Stage, and an arrow to blow it up to full height. A toggle next to the input
  collapses the history entirely (just the input row), and that choice is
  **remembered** — across visits to the default page, other views, and reloads.
  The history only shows while the Stage is on the default desk page, so a
  pinned view is never crowded.
- **Agent** (right) — the avatar, driven purely by the event stream.
- **Agent Folder** (right) — the agent's view of the project: the files in its
  context, newest first, each expandable into the versions it has held. Click a
  file for its newest content, or a version for that exact state.
- **Agent Eggs** (right) — the processes the agent created, with `running` /
  `dead` / `all` tabs and a count. An egg is a process Daze saw the agent start:
  a dev server it left behind, a daemon it ran, a script's child. Its status says
  what became of it, so a process that lived and died inside one long command is
  still reported — `dead` is not a failure, it is a fact. Click one to see it on
  the Stage. Read-only: DAZE reports what the agent started, it never kills an egg.

  Eggs are **classified by behaviour, not by name**: the panel lists *primary*
  processes and folds the helpers into a count (`folded 5 helpers: sleep, cat, …`).
  A command's `cat`, `grep` and `sleep` — and the query tools an agent uses to
  check its own daemons, like `ps` and `kill` — are helpers; the one daemon the
  command actually started is primary. Nothing is judged by its file name: the
  process is primary when it outlived the command that laid it, started
  processes of its own, is a subject the command named (`node ticker.mjs`), was
  backgrounded or redirected by the command, or runs from the workspace. A
  transparent launcher (`nohup`, `setsid`, `time`) is passed through, so
  `nohup node ticker.mjs` reads as `node ticker.mjs`. The same split filters the
  Activity panel and the Daze Report, so helpers never bury the egg.

## Agent status

Derived entirely from events, so it reflects reality rather than a guess:

```
listening → (thinking | speaking | reading | searching | editing | running | waiting) → listening
```

- `listening` — nothing has happened yet, or the last run finished
- `speaking` — the agent is writing text back to you
- `reading` / `searching` / `editing` / `running` — held while the Stage shows
  that action, and exited as soon as the agent starts emitting text
- `error` — shown as *confused*

The Stage returns to its default desk page when a run ends, when a new prompt is
sent, and **as soon as the agent starts speaking** — so finished text is never
hidden behind a stale file or terminal view.

## History & Replay

A **run** is one prompt through to `agent_end`. Runs are the unit of both History
and Replay.

Replay is reconstructed, not recorded: **events + state snapshots**, never video.

- the replay buffer is the selected run
- snapshots every 25 events or 5 seconds; each carries the file contents, the
  agent status **and what the Stage was showing**, so a seek always lands on a
  correct frame instead of an empty one
- seek takes the nearest snapshot and applies the remaining events
- controls (play / pause / step / seek / 0.25×–10×) live inside the Stage, below
  the animated area so dragging the scrubber is never interrupted

Opening a run two ways:

- **▶ replay** in the Activity header — replay it from the beginning
- **⟲** in the History row — roll back to the state at the **end** of the run

Both are view-only. DAZE is an observer, so "rollback" means restoring what you
are looking at, never rewriting the project.

## Daze Report

A tab at the top-centre of the Stage expands a translucent **Daze Report** over
the Stage body. It is derived entirely from the event stream — no LLM, no
command parsing — and answers two questions:

- **while a run is live** — *what is the agent doing now?* A phase
  (`investigating` / `implementing` / `executing` / `verifying` / `recovering`),
  progress, and a human-attention level.
- **when the run ends** — *what did this run amount to?* Four sections:
  **Timeline** (the run as a horizontal world line: one node per activity in the
  order it happened, with what it caused under each node — a read says which
  lines entered the context, an edit its `+A / −D`, a command its exit status, a
  shell tool that never ended that a process is still running; clicking a node
  opens it in a pane to the left of the report, beside its effects, so the
  diff/output/reasoning is one click away), **Knows** (files read and searches
  run — what the agent learned), **Changes** (files created/modified/observed/
  deleted, with `+A / −D`), and **Executions** (the commands it ran, with exit
  status), plus recoveries, an outcome, human attention with reasons, and the
  agent's own reply for the run.

It follows the run selected in History (newest by default). The engine is`apps/web/src/lib/report.ts`: a run's `DazeEvent`s are reduced to `RunFacts`,
then a Live or Run report is rendered **from those facts only**. It never
reports what the agent *said* it did — only what the observer saw. Two
deliberate rules: failures are read from the `bash`/`powershell` tool results
(a failed tool emits no `command` event), and the watcher's own changes are
reconciled so a file the agent wrote is never also counted as an external
change. The Timeline follows the same rule: it reads effects off the stream and
never parses a command line to guess that it *meant* to start a service, and
consecutive reasoning deltas collapse into the one thought they are. A process
the agent left running is a fact like any other: it becomes a `LAID` node on the
Timeline and raises *human attention* if it is still alive when the run ends.
Every item is an evidence link — clicking a file, search or command
opens its content in a pane to the left of the report and highlights the
matching row in Activity, so you can follow the evidence without leaving the
report. The report is compressed Activity, not a second set of facts, so Replay
can share the same fact layer later.

## Architecture

```
Browser ──WebSocket──▶ Daze Server ──EventBus──▶ AgentAdapter ──▶ Pi (SDK, in-process)
   ▲                                                                     │
   └────────────── DazeEvent stream (file_read / file_edit / command / …) ┘
```

- `packages/core` — the shared `DazeEvent` + domain types. The only vocabulary
  the UI knows; it never learns that Pi exists.
- `apps/server` — Fastify + WebSocket. `PiAdapter` wraps the Pi SDK and maps
  `AgentSessionEvent` → `DazeEvent`; `MockAdapter` replays a scripted run with no
  credentials; `chokidar` watches the project for out-of-band changes. **Daze owns
  the shell**: `process/DazeShell` wraps Pi's own local shell operations and
  registers them as custom `bash` / `powershell` tools (a custom tool shadows the
  built-in one by name, so `DAZE_PI_TOOLS` is untouched). Pi still executes every
  command — Daze only owns the boundary, which is what tells `ProcessWatcher` when
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
  when it appeared inside a command's window and its ancestor chain reaches Daze;
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
  its own session file (so a conversation can be resumed) and Daze archives the
  `DazeEvent` stream it observed alongside it.
- `apps/web` — React + Vite + Tailwind + Zustand + Monaco + Framer Motion. The
  panels are entry points and the Stage is where content lives; the Daze Report
  and Agent Eggs are both reductions of the same event stream.

```
daze/                     npm workspaces: apps/*  packages/*
  start-daze.bat          one-click launcher (Windows)
  start-daze.sh           one-click launcher (Linux / WSL)
  tsconfig.base.json      strict, noUncheckedIndexedAccess
  native/agentwatch/      Windows process observer (Job Object, committed prebuilt)
  native/agentwatch-linux/ Linux process observer (eBPF, committed prebuilt)
  scripts/wsl-pi-config.sh point WSL pi at the Windows host's model services

packages/core/src/        events.ts (DazeEvent + payload map)  types.ts  index.ts

apps/server/src/
  agents/                 AgentAdapter.ts (the runtime-agnostic boundary)
                          PiAdapter.ts  MockAdapter.ts  createAdapter.ts
  process/                DazeShell.ts (owns the shell)  ProcessWatcher.ts (eggs)
                          ProcessTable.ts (pid / ppid / command line / start time)
                          observer.ts (platform-neutral event shapes)
                          JobMonitor.ts + JobSidecar.ts (Windows kernel events)
                          EbpfObserver.ts (Linux kernel events)
                          CommandIntent.ts + classify.ts + priors.ts (primary vs tool)
  sessions/               SessionStore.ts  archive.ts (~/.daze/sessions)
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
                          StageItemView.tsx  ReportOverlay.tsx (the Daze Report)
    agent/                Avatar.tsx (the Heti character)  AgentPanel.tsx
                          AgentFolder.tsx  heti.css (generated)
    eggs/                 AgentEggsPanel.tsx (primaries; tools folded; running /
                          dead / all)
    files/  history/  activity/  chat/  ProjectPicker/  common/  Panel.tsx
  stores/                 session  file  stage  replay  chat  ui  reset
  hooks/                  useSessionSocket  useStage  useReplay  useNow
  lib/                    events (event → Stage item / Activity row)
                          report (the Daze Report engine)   eggs (process → eggs)
                          replay  history  context  commands  agent  format  …
  types/                  stage  history  replay  report  chat  file
  index.css

apps/web/public/heti/     the avatar's PNG parts (16: body, head, hair, ahoge,
                          tail, hands, feet, 7 faces)

scripts/                  make-demo.mjs  check-history.ts  check-report.ts
                          check-eggs.ts  check-classify.ts  check-agentwatch.ts
                          check-ebpf.ts  wsl-pi-config.sh
                          gen-heti-css.mjs (regenerates heti.css)
```

## Requirements

- Node.js **22.19+** (24 tested) and npm.
- Optional: a configured Pi (run `pi` once and log in) for the real agent. Without
  credentials DAZE falls back to the mock runtime and says so (`degraded · mock`).

## Install & run

```bash
npm install

npm run dev     # dev: web on :5173 (proxies /api and /ws), server on :8848
npm run build   # build the web app
npm start       # single origin — server serves the built app on :8848
```

Then enter a project path (or pick one), choose a runtime, hit **Open**, and send
the agent a task in the chat box at the bottom of the Stage. The **History** list
under the path box unfolds the saved sessions — DAZE's own archives merged with
Pi's — newest first; typing a path filters it to that project, and clicking a row
reopens that conversation.

### One-click launcher (Windows)

Double-click **`start-daze.bat`** to build the web app, start the DAZE server, and
open the UI. The web app is rebuilt every time: the server only serves
`apps/web/dist`, so a stale build is what you would otherwise see no matter what
changed in `src`.

```bat
start-daze.bat            :: build and start
start-daze.bat check      :: dry run — report what would happen, start nothing
```

Idempotent: a DAZE server already listening is left alone. Override with
`DAZE_PORT` and `DAZE_AGENT`. Close the spawned `DAZE server` window to stop.

### One-click launcher (Linux / WSL)

**`start-daze.sh`** does the same on Linux and in WSL: it builds the eBPF
observer if it is missing, configures the pi inside WSL, rebuilds the web app,
starts the server, and opens the UI. On WSL the Windows browser is opened through
`wslview` when it is installed.

```sh
./start-daze.sh            # build and start
./start-daze.sh check      # dry run — report what would happen, start nothing
```

#### pi inside WSL

Daze embeds pi **in its own process** (the SDK, not the `pi` command), so when
Daze runs in WSL, pi runs in WSL and its shell tools are Linux — `/bin/bash`, no
Git Bash, no MSYS pid split. Two things are needed for that to work:

1. **A Linux pi, not the Windows one.** Install it in WSL:

   ```sh
   npm install -g @earendil-works/pi-coding-agent
   ```

   Without it, `which pi` finds the Windows install under `/mnt/c/…`, which is a
   Windows script.

2. **Providers pointed at the Windows host.** A model server bound to the
   Windows loopback is *not* reachable from WSL as `127.0.0.1` — inside WSL that
   address is WSL itself. The Windows host is the default route's gateway:

   ```sh
   ip route show | grep -i default | awk '{ print $3 }'
   ```

   `scripts/wsl-pi-config.sh` copies `models.json` from the Windows pi config and
   rewrites every `127.0.0.1` / `localhost` host to that gateway. `start-daze.sh`
   runs it on every launch, because the address changes when WSL restarts. To
   point at a different source, set `DAZE_WIN_PI_DIR` to the Windows
   `.pi/agent` directory.

With both in place, `pi --list-models` inside WSL shows the same providers the
Windows pi does, and a session's bash tool runs as a Linux process that the eBPF
observer sees.

#### Sharing the checkout with Windows

When the repository lives on a Windows drive (`/mnt/…`) and both Windows and WSL
use it, `node_modules` is **platform-specific** (esbuild ships a native binary per
platform), so a single directory cannot serve both. Installing here replaces the
Windows one. If you develop on both sides, keep a Windows checkout and a WSL
checkout, or reinstall as you switch with
`rm -rf node_modules && npm install`.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8848` | Server port |
| `HOST` | `127.0.0.1` | Server host |
| `DAZE_AGENT` | `pi` | Default runtime: `pi` or `mock` |
| `DAZE_PROJECTS_ROOT` | `~/projects` | Directory listed in the project picker |
| `DAZE_PI_TOOLS` | `read,bash,edit,write,grep,find,ls` | Pi built-in tools to enable. `bash` / `powershell` are served by Daze's own shell (see Architecture), which is what makes processes observable |
| `DAZE_LOG_LEVEL` | `info` | Fastify log level |
| `DAZE_STATE_DIR` | `~/.daze` | Where Daze archives session history |

## DazeEvent

The core UI understands exactly one structure:

```ts
type DazeEvent = {
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
| `GET` | `/api/sessions/history` | Saved sessions (Daze archives + Pi), newest first; `?path=` filters |
| `POST` | `/api/sessions` | `{ projectPath, agent?, resume? }` → create or reopen a session |
| `GET` | `/api/sessions/:id` | Session snapshot (session, files, chat, events, tree) |
| `GET` | `/api/sessions/:id/events` | Event history |
| `GET` | `/api/sessions/:id/file?path=` | Read a project file (the user view) |
| `POST` | `/api/sessions/:id/prompt` | `{ prompt }` → send to the agent |
| `POST` | `/api/sessions/:id/abort` | Interrupt the run |
| `GET` | `/api/sessions/:id/commands/:name/options` | Choice list for a command that needs one (`model`, `thinking`) |
| `POST` | `/api/sessions/:id/command` | `{ name, args? }` → run a chat command |
| `DELETE` | `/api/sessions/:id` | Dispose the session |
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
| `/export [html\|jsonl]` | Export the session under `~/.daze/exports/` |

Switching the model is **session-scoped** — Pi's global default is left alone.
Results are printed back into the chat as system messages and archived with the
session, so they come back on resume.

Commands dispatch through the runtime-agnostic `AgentAdapter`, so a different
runtime only has to implement those few methods (the web UI does not change).
Pi's own built-in slash commands live in its interactive TUI rather than the
SDK, so these are mapped onto SDK calls (`setModel`, `setThinkingLevel`,
`compact`, `setSessionName`, `getSessionStats`, `exportToHtml`/`exportToJsonl`)
rather than delegated to Pi.

## Local model

DAZE only talks to Pi, and Pi talks to any OpenAI-compatible endpoint — so a local
model works with no code changes and no separate launcher path. Example: Qwen3-4B
served by `server_qwen.py` in `E:\0down\ml\qwen3-4B` (streaming + tool calling).
The model server is started by hand, not by DAZE.

1. Start the model server:

   ```bat
   E:\0down\ml\qwen3-4B\serve_qwen.bat --port 8000
   ```

2. Register it with Pi in `~/.pi/agent/models.json`:

   ```json
   {
     "providers": {
       "qwen-local": {
         "baseUrl": "http://127.0.0.1:8000/v1",
         "api": "openai-completions",
         "apiKey": "local",
         "models": [
           {
             "id": "qwen3-4b",
             "name": "Qwen3 4B (local)",
             "input": ["text"],
             "contextWindow": 40960,
             "maxTokens": 4096,
             "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
             "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens" }
           }
         ]
       }
     }
   }
   ```

3. (Optional) make it the default in `~/.pi/agent/settings.json`:

   ```json
   { "defaultProvider": "qwen-local", "defaultModel": "qwen3-4b" }
   ```

4. Verify with `pi --list-models`, then start DAZE.

A 4B model is not reliable at choosing tools. `DAZE_PI_TOOLS` narrows the set
(e.g. `DAZE_PI_TOOLS=read,bash,edit,write`), and the mock runtime is better for
exercising the UI.

## Testing

```bash
node scripts/make-demo.mjs [dir] [--force]   # scaffold a demo project
npx tsx scripts/check-history.ts             # needs the server running
npx tsx scripts/check-report.ts              # Daze Report engine (no server needed)
npx tsx scripts/check-eggs.ts                # process detection (no server, nothing spawned)
npx tsx scripts/check-classify.ts            # command intent + primary/tool split
npx tsx scripts/check-agentwatch.ts          # kernel process observer (Windows)
npx tsx scripts/check-ebpf.ts                # kernel process observer (Linux)
node scripts/gen-heti-css.mjs                # regenerate the avatar's stylesheet
```

`npm run check:process` runs the three process harnesses together.

`make-demo.mjs` writes a small project shaped so ordinary prompts exercise every
panel: reads with line ranges, a runnable `npm test`, a `TODO.md` for the agent to
read, and `notes.txt` for the delete-vs-truncate case. The mock runtime runs its
shell command for real, so a mock run also lays an egg — which is how the Agent
Eggs panel is exercised without Pi credentials.

`check-history.ts` runs **56 checks** against a live mock session: run grouping,
per-run activity scoping, deterministic stage item ids, snapshot seek, the Stage
returning to its default page, search→terminal mapping, thinking capture (a
streamed thought stays one Stage item, so replay does not re-mount it), the two
independent FILE slots, read accumulation and gap markers, per-version recording,
and the created file count.

`check-report.ts` is a pure harness (no server) for the Daze Report engine: a
failed tool with no `command` event still counts as a failed command, recovery
consumes a failure only after intervening activity, agent writes are never
double-counted as observed changes, `created` is relative to earlier runs,
phases resolve to `verifying` after a recovery, and the Timeline lists one node
per activity in event order with its effect (a streamed thought stays one node,
an unfinished shell tool reads as a running process, and an egg laid during the
run becomes a `LAID` node — with a still-running egg raising human attention).

`check-eggs.ts` is the pure harness for process detection (no server, nothing
spawned): the command window decides what is a candidate, the ancestor chain
decides what is ours, the marker Daze puts on its own shells decides what is
plumbing, an orphan is refused rather than guessed at, a subtree collapses to its
root with its descendants counted, and the eggs panel folds repeated pids into one
egg with `running` / `dead` / `all` filters.

`check-classify.ts` is the pure harness for the primary/tool split: the command's
subjects are read from its text (`./daemon.sh`, `python train.py`, `powershell
-File run.ps1`) while an inline interpreter stays a tool, a query tool with a
redirect is not a subject, and classification is structural — a `cat` that
outlived its command is primary, a short git-bash helper is a tool, a process
inside the workspace is primary, and an ephemeral process from an unknown
directory (`fd.exe` in Pi's own bin) is a tool.

`check-agentwatch.ts` exercises the Windows observer for real: it starts the
helper against the test process, drives the real `ProcessWatcher`, and asserts
that short-lived children are all caught, carry a command line, are attributed to
the command that laid them, and that Daze's own marked shell is never an egg.

`check-ebpf.ts` does the same for the Linux observer: it starts
`agentwatch-linux`, drives the real `ProcessWatcher`, and asserts that
short-lived children are all caught with their command line and attributed to
the command that laid them.

## Notes & limitations

- Sessions **persist to disk** and survive a restart. Pi keeps the model's
  conversation under `~/.pi/agent/sessions/`; Daze keeps the `DazeEvent` stream it
  observed under `~/.daze/sessions/` (override with `DAZE_STATE_DIR`). The
  picker's **History** reopens either: Daze's archive restores the Stage,
  Activity, files and chat; Pi's restores the model's context. Only the `pi`
  runtime writes a Pi session file — a `mock` session is restored from Daze's
  archive alone. Because `~` is the platform's home, **Windows and WSL keep
  separate histories**: `C:\Users\<you>\.daze\sessions\` and
  `/root/.daze/sessions/` (or `/home/<you>/…`). They do not see each other's
  sessions. Point `DAZE_STATE_DIR` at one shared path to merge them, but do not
  run both platforms at once — the archive is appended to and re-headered, so two
  writers on one file can corrupt it.
- DAZE is an **observer**. It never drives the agent; the only thing it reads
  outside the event stream is a project file you explicitly asked to open.
- Pi has **no delete tool** — deleting must go through `bash rm`. When an agent
  instead writes empty content the file is *truncated, not deleted*, and DAZE
  labels it **EMPTIED** with a byte count so a fake deletion is obvious.
- An **egg** is a process Daze watched the agent start. Daze reports the root of
  each new process tree and rolls the descendants into a `+N` count; it looks
  *through* the shell it drove and the launcher around it — recognised exactly,
  by the marker on the command — so an agent's own `bash daemon.sh` is reported
  like anything else. It never kills anything. On **Windows**, `native/agentwatch`
  puts the server into a Job Object and the kernel reports every creation and
  exit; on **Linux**, `native/agentwatch-linux` attaches eBPF tracepoints and does
  the same. Either way there is no sampling floor and a 20 ms process is seen like
  any other. On other platforms, or when a helper cannot start, the watcher falls
  back to snapshots and **sampling has a floor**: one snapshot costs ~0.5s, so
  anything living under ~0.5s may be missed. Two further honest limits: a process
  orphaned from a shell Daze drove (`npm run dev &` after the command returns) is
  not attributed, because attributing every orphan swept in unrelated processes
  from elsewhere on the machine; and processes an agent starts *around* the shell
  — through WMI, a scheduled task or a service on Windows, or a different pid
  namespace on Linux — are not seen until a user-SID / namespace fallback is
  added. Ports and listeners are the obvious next fact to attach.
- Pi has **no plan concept**; Daze used to read a checklist out of `TODO.md`, and
  that panel is now the Agent Eggs panel.
- The avatar is the **Heti** character (a plush whale-suit figure) reconstructed
  from PNG parts in `apps/web/public/heti/` and posed by status through the same
  `AgentVisualState` seam — `listening` relaxes, `thinking` thinks, `speaking`
  talks, `reading`/`searching` read, `editing` writes, `running` types, `waiting`
  dozes, `error` panics. Its stylesheet (`agent/heti.css`) is generated from the
  standalone page by `scripts/gen-heti-css.mjs` and scoped under `.heti-root`, so
  it never leaks into the rest of the app. Live2D is still a v0.3 item.
- The desk is the SVG world from `daze-table.html` (`stage/StageWorld.tsx`),
  drawn as the Stage's persistent default background; the camera frames the
  object the current action touches, and content views are translucent overlays
  on top of it. `DeskState` / `DeskItem` exist but are not yet driven by events.
