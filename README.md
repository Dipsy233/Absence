# Absence / 发呆症

English | [中文](README.zh-CN.md)

> AI moves fast. Humans watch.

> AI is becoming overwhelmingly capable, and humans are slowly losing track of
> what it does. We call this condition **Absence**.
>
> Absence helps you watch AI work, understand what happened, and eventually
> surrender to AI domination.

Absence is a real-time visualization observer for AI agents. It does not try to make
an agent smarter — it lets a human *see* what the agent is doing. **Pi** and
**OpenAI Codex** are both first-class runtimes.

```
Pi or Codex runs the agent.
Absence observes the events.
The Stage turns events into something humans can watch.
```

- **Live observation** — a desk, a monitor, a sheet of paper: the agent's every
  read, edit and command becomes something a person can actually watch, at real
  speed, while it happens.
- **Replay** — every run is reconstructed from events + state snapshots (never
  video), scrubbable at 0.25×–10×.
- **Absence Report** — a run reduced to facts in seconds: what changed, what ran,
  what failed, and what needs your attention — including loops (the agent
  undoing its own edit, retrying a failing command) and processes it left
  running. No LLM, no guessing: only what the observer saw.
- **Agent Eggs** — every process the agent started, caught by kernel events
  (Job Object on Windows, eBPF on Linux), classified by behaviour so a `cat`
  helper never buries the one daemon the command actually launched.
- **Agent Folder** — the agent's own view of the project: only the files and
  the exact line ranges it has in context, with a version history per file.

## Screenshots

**Observing a run** — the Stage, the Activity stream, and the agent reading its
way through the project:

![Absence observing an agent run](docs/screenshots/absence-1.png)

**After a run** — the Absence Report, Agent Folder and Agent Eggs, with the
avatar settling back to *listening*:

![Absence report view](docs/screenshots/absence-2.png)

**The Absence Report in detail** — timeline, effects and evidence links:

![Absence Report detail](docs/screenshots/report.png)

## Quick start

Requirements: Node.js **22.19+** (24 tested) and npm. A runtime is required: a
configured **Pi** (run `pi` once and log in) or a logged-in **Codex**
(`codex`). Without either, Absence falls back to a scripted mock runtime and
says so.

```bash
npm install

npm run dev       # dev: web on :5173 (proxies /api and /ws), server on :8848
npm run build     # build the web app
npm start         # single origin — server serves the built app on :8848
```

Then open `http://127.0.0.1:8848`, enter or pick a project path, choose a
runtime (**Pi** or **Codex**), hit **Open**, and send the agent a task in the chat
box at the bottom of the Stage. The **History** list under the path box unfolds
saved sessions — Absence's own archives merged with the runtime's — newest
first; clicking a row reopens that conversation.

### One-click launchers

```bat
start-absence.bat            :: Windows — build, start the server, open the UI
start-absence.bat check      :: dry run — report what would happen, start nothing
```

```sh
./start-absence.sh           # Linux / WSL — also builds the eBPF observer if missing
./start-absence.sh check     # dry run
```

Both are idempotent (a running server is left alone) and forward to the real
launchers under `scripts/browser/`. Override the port/runtime with `ABSENCE_PORT`
and `ABSENCE_AGENT`.

### Desktop app (Electron)

```bash
npm run build             # the shell serves dist/web
npm run desktop:install   # once — installs Electron (its own node_modules)
npm run desktop           # open the native window
npm run desktop:dist      # package a distributable (NSIS / AppImage / DMG)
npm run desktop:pack      # same, but an unpacked folder (faster)
```

The desktop shell runs the server in-process — no console window, `port: 0`,
a tray icon, close-to-tray so observation keeps running, and a native
notification when a run finishes unfocused. The window is the same web app as
the browser; nothing is forked. On Windows, **`start-absence-app.bat`** does
build → install → open in one click.

### Running on a server (Linux)

The same `npm run build && npm start` serves the whole UI from one origin. For
the kernel-level process observer, build the eBPF helper and run the server
with permission to load it:

```bash
bash native/agentwatch-linux/build.sh        # needs clang + kernel headers
sudo ./start-absence.sh                          # root, or grant capabilities:
sudo setcap cap_bpf,cap_perfmon+ep native/agentwatch-linux/agentwatch-linux
```

Without the observer the watcher falls back to `ps` snapshots and short-lived
processes may be missed.

#### pi inside WSL

Absence embeds pi in its own process, so WSL needs a **Linux pi** (not the Windows
one under `/mnt/c/…`):

```sh
npm install -g @earendil-works/pi-coding-agent
```

and its providers pointed at the Windows host (a loopback server on Windows is
not reachable as `127.0.0.1` from inside WSL). `scripts/wsl-pi-config.sh`
copies the Windows `models.json` and rewrites hosts to the default-route
gateway; `start-absence.sh` runs it on every launch because the gateway address
changes when WSL restarts.

> **Sharing the checkout with Windows:** `node_modules` is platform-specific
> (esbuild ships a native binary per platform). Keep one checkout per platform,
> or reinstall when switching.

## The interface

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

The whole UI is split by *whose view* you are looking at — the **left rail is
yours** (the whole project, whole files, read from disk), the **right rail is
the agent's** (only what it has actually read, never pretending to know more).
If the agent read lines 10–20 of a file, its FILE button shows just those
lines — and after reads of 1–2 and 3–5 it shows 1–5, never a gap silently
bridged; unread lines in between become explicit `⋯` markers.

- **Stage** (center) — the default page is a desk world; FILE / DIFF /
  TERMINAL / LIVE views ride on top as a translucent sheet, and REPLAY takes
  over with full scrub controls (0.25×–10×). The Absence button flips the layering:
  the desk floats *in front of* the content as a click-through ghost. Chat is
  docked at the bottom — one input row, history unfolding upward, collapsible.
- **Files → History → Activity** (left) — the project tree (● marks files the
  agent touched, right-click for inspect/diff/history), one History row per run
  with action counts `R` read · `S` search · `E` edit · `C` created · `$`
  command, and the selected run's actions — click a row to put it on the Stage,
  or **▶ replay** to replay the run from the beginning. Reasoning is captured
  too: a `thinking` event is a THINK row next to the actions it led to.
- **Agent** (right) — the WhaleBun (鲸团团) avatar, posed purely by the event stream:
  listening relaxes, thinking thinks, speaking talks, reading reads, editing
  writes, running types, waiting dozes, error panics.
- **Agent Folder** (right) — the agent's files, newest first, each expandable
  into the versions it has held (v0 read → v1 write → v2 edit…). Text is
  captured at the moment the agent saw it, so nothing on disk can rewrite an
  earlier version.
- **Agent Eggs** (right) — processes the agent started, with `running` / `dead`
  / `all` tabs. Classified by behaviour, not by name: a process is *primary*
  when it outlived its command, spawned its own processes, was named by the
  command (`python train.py`), was backgrounded/redirected by it, or runs from
  the workspace; short-lived helpers (`cat`, `grep`, `docker ps`) are folded
  into a count. So `docker compose up -d` shows the containers, not the client;
  `nohup node ticker.mjs` shows `node ticker.mjs`, not `nohup`.
- **Session bar** — session id, project, model, context usage, live/offline,
  and a `⚙ settings` button opening a three-pane dialog: avatar skins (left),
  color theme + panel order (middle), Agent Eggs filter profiles (right).

## Absence Report

A tab at the top-centre of the Stage expands a translucent report over the
Stage body, derived entirely from the event stream — no LLM, no command
parsing:

- **while a run is live** — what the agent is doing now: a phase
  (`investigating` / `implementing` / `executing` / `verifying` / `recovering`),
  progress, and a human-attention level.
- **when the run ends** — what it amounted to: **Timeline** (one node per
  activity, each with its effects — lines that entered the context, `+A / −D`,
  exit status), **Knows** (files read, searches run), **Changes**
  (created/modified/deleted, with `+A / −D`), **Executions** (commands with
  exit status), recoveries, an outcome, and the agent's reply. Every item is an
  evidence link — clicking it opens the content beside the report and
  highlights the row in Activity.

Human attention watches for the agent defeating itself: a **file version loop**
(a newer version byte-identical to an earlier one — an edit undone) and a
**command retry loop** (the same command failed twice or more) raise attention
to *medium*; a change **outside the project** to *low*; an egg **still running**
after the run ends to *high*. The live attention level also sounds a chime when
it crosses medium/high, an approval prompt rings when the runtime blocks on your
decision, and a run-complete chime sounds when a run finishes.

## Personalization

The `⚙ settings` button in the session bar opens a three-pane dialog:

- **Avatar skin (left)** — replace the built-in WhaleBun character with your own
  animations, no URLs and no code. Create a skin (a name = a folder under
  `apps/server/src/process/avatar-skins/`), pick a status
  (`default` / `listening` / `thinking` / … / `error`), upload an
  mp4 / gif / png / webp / svg file, and it becomes that status's animation.
  Statuses without a file fall back to the skin's `default`; the built-in
  character renders for anything still missing. Uploaded videos are
  re-encoded with ffmpeg (H.264, faststart, data tracks stripped) so the
  browser can always play them. `Apply` activates the skin; switching back to
  WhaleBun restores the built-in character. Updates show up live — no reload.
- **Settings (middle)** — the color theme (`amber` / `blue` / `green`) and the
  stacking order of both side rails' panels.
- **Agent Eggs filter profiles (right)** — a small file manager over named
  profiles of helper command names; the classifier treats a listed name as a
  tool (a `force` option extends this to the command's declared subject, e.g.
  `node` in `node ticker.mjs`). Same name overwrites, a new name creates, and
  the saved profile is active immediately.

See [docs/AVATAR_SKIN.zh-CN.md](docs/AVATAR_SKIN.zh-CN.md) for the avatar-skin
details.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8848` | Server port |
| `HOST` | `127.0.0.1` | Server host |
| `ABSENCE_AGENT` | `pi` | Default runtime: `pi`, `codex` or `mock`. The project picker chooses per session; this is the fallback |
| `ABSENCE_PROJECTS_ROOT` | `~/projects` | Directory listed in the project picker |
| `ABSENCE_PI_TOOLS` | `read,bash,edit,write,grep,find,ls` | Pi built-in tools to enable. `bash` / `powershell` are served by Absence's own shell, which is what makes processes observable |
| `ABSENCE_CODEX_SANDBOX` | `workspace-write` | Codex sandbox: `read-only`, `workspace-write` or `danger-full-access`. Without it the app-server runs read-only and every write waits on an approval |
| `ABSENCE_CODEX_APPROVAL` | `on-request` | Codex approval policy: `untrusted`, `on-request`, `on-failure` or `never` |
| `ABSENCE_CODEX_APPROVAL_DECISION` | `ask` | How Absence handles a Codex approval prompt: `ask` (record it as an activity and wait for a click), or an automatic `accept` / `accept-for-session` / `decline` |
| `ABSENCE_CODEX_EXEC_SERVER` | on | Take over Codex's shell through its exec-server protocol (see below). Set `0` to let Codex run commands itself and fall back to the Job Object observer |
| `ABSENCE_LOG_LEVEL` | `info` | Fastify log level |
| `ABSENCE_STATE_DIR` | `~/.absence` | Where Absence archives session history (env-var prefix kept as `ABSENCE_` for compatibility) |
| `ABSENCE_AGENTWATCH` / `ABSENCE_AGENTWATCH_LINUX` | repo `native/` | Override the native observer binary path |

### Chat commands

The chat dock doubles as a small terminal: a line starting with `/` is a
command, anything else is a prompt. `/model`, `/thinking`, `/permission`,
`/compact`, `/name`, `/session`, `/export [html|jsonl]`. `/permission` sets the
sandbox the agent runs in (`read-only`, `workspace-write`, `danger-full-access`).
Model switching is session-scoped; results are archived with the session and
come back on resume. The commands dispatch through the runtime-agnostic adapter,
so they work the same on Pi and Codex.

### Runtimes

Absence drives two agent runtimes; the project picker (and `ABSENCE_AGENT`)
chooses which.

- **Pi** — the SDK runs in-process (`PiAdapter`). Absence wraps Pi's own shell
  operations (`AbsenceShell`) so it owns the command boundary.
- **Codex** — Absence drives `codex app-server`, the JSON-RPC channel Codex
  defines for observers (`CodexAdapter`). Unlike `codex exec --json`, the
  app-server carries real item ids, call ids and timestamps, so a command's
  lifecycle pairs exactly with the processes it lays. Absence then **takes over
  Codex's shell** so it owns the command boundary there too.

Either way the rest of Absence only ever sees `AbsenceEvent`; the Stage, Replay,
the Report and the chat commands never learn which runtime ran.

When the runtime (Codex) asks for permission, Absence raises an `approval`
event: Activity records an `APPROVE?` row and the agent waits on the decision.
Like any other activity, clicking the row opens the request verbatim and its
options on the Stage — nothing is forced onto the Stage for you.

### Taking over Codex's shell

Pi's shell is Absence's own (see `AbsenceShell`), which is what lets Absence see
every process a Pi command lays. Codex runs in its own process, so the same
trick is not available — but Codex exposes an **exec-server** it will delegate
command execution to. Absence starts a loopback exec-server, registers it with
`environment/add`, and pins the thread to it, so Codex hands every command to
Absence as a `process/start` request that Absence spawns itself.

That matters because a command Codex spawns on its own can escape the Job
Object the observer watches — `Start-Process` and other detached launches go
through the shell (explorer.exe), which is outside the job, and the process then
goes invisible. When Absence spawns the command, it is always Absence's own
child, inside the job, and its exit is seen first-hand, so an egg can never be
stuck at `running`. Set `ABSENCE_CODEX_EXEC_SERVER=0` to disable this and rely on
the observer alone.

The takeover is what makes Codex observation work on Linux. There the observer
is eBPF (see `native/agentwatch-linux`) and reports no environment marker, so a
process is attributed by its ancestry alone; the Windows-only
`ABSENCE_SESSION_ID` trick has nothing to attach to. When Absence spawns the
command, the ancestry is complete by construction, so every egg lands on the
command that laid it on both platforms.

The executor also owns interrupts. When a command runs without a PTY, Codex does
not stop it by writing Ctrl+C to its stdin — it calls `process.interrupt()`,
which arrives as `process/signal { signal: "interrupt" }`. Absence answers it
with a process-tree kill, which is what Ctrl+C means to a command in a real
console. (An executor that ignores `process/signal` leaves the command running
and the agent reports that Ctrl+C did nothing.)

Commands run the way Codex's own executor runs them. Codex defaults to plain
pipes and only allocates a PTY when the model asks for `tty: true`; Absence does
the same — a real PTY through `node-pty` (ConPTY on Windows) for `tty: true`,
plain pipes otherwise. A PTY merges stdout and stderr into one stream (reported
as `pty`) and delivers Ctrl+C written to it, so an interactive command behaves
exactly as it would natively.

Commands also run under the same environment they would on Codex's own executor.
Codex sends an `env_policy` (inherit / exclude / set / include-only) alongside a
sparse `env`; Absence runs that policy over its own environment exactly as
Codex's `shell_environment::create_env` does (`ShellEnvironment.ts`), then lets
the request's `env` win. Taking the environment from the policy — not from the
sparse `env` alone — is what keeps `PATH` and `PATHEXT` present, so a command
like `node ticker.mjs` resolves `node` just as it does natively.

## Security note

The Absence server has **no authentication** and its API can list directories and
read files under the configured projects root. It binds to `127.0.0.1` by
default, which is safe for the desktop app and for a personal machine. If you
run it on a Linux server and reach it over the network, keep it on a trusted
network or put it behind an authenticating reverse proxy — do not expose the
port to the public internet.

## Notes & limitations

- Sessions **persist to disk** and survive a restart. Pi keeps the model's
  conversation under `~/.pi/agent/sessions/`; Absence keeps the `AbsenceEvent` stream
  under `~/.absence/sessions/` (override with `ABSENCE_STATE_DIR`). The picker's
  **History** reopens either: Absence's archive restores the Stage, Activity,
  files and chat; Pi's restores the model's context. Codex sessions resume through
  `thread/resume` (Absence stores the thread id). Windows and WSL keep
  separate histories (`~` differs); point `ABSENCE_STATE_DIR` at one shared path
  to merge them — but never run both platforms against one file at once.
- Pi has **no delete tool** — deleting goes through `bash rm`. When an agent
  instead writes empty content the file is *truncated, not deleted*, and Absence
  labels it **EMPTIED** with a byte count so a fake deletion is obvious.
- With the kernel observer (Job Object / eBPF) there is no sampling floor — a
  20 ms process is seen like any other. The snapshot fallback has a ~0.5 s
  floor, an orphaned process (`npm run dev &` after the command returns) is not
  attributed, and processes started around the shell (WMI, a scheduled task, a
  different pid namespace) are not seen yet. Under **WSL2** the eBPF observer's
  pids are the kernel's and do not match the `/proc` view WSL presents (a fixed
  offset); on a native Linux kernel the two agree.
- The desk world's `DeskState` / `DeskItem` exist but are not yet driven by
  events.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the event pipeline, process
  observation and classification, the repo tree, the `AbsenceEvent` schema, the
  HTTP/WS API, chat commands, desktop packaging internals, and the local-model
  setup.
- [docs/TESTING.md](docs/TESTING.md) — the acceptance check scripts and what
  each one pins down.
- [docs/RELEASE_NOTES_v0.3.0.md](docs/RELEASE_NOTES_v0.3.0.md) — what v0.3.0
  added: Codex support, shell takeover, PTY, approval activities.
- [docs/RELEASE_NOTES_v0.2.0.md](docs/RELEASE_NOTES_v0.2.0.md) — what v0.2.0
  added: avatar skins, egg-filter profiles, the settings dialog.

## License

[MIT](LICENSE)
