# Absence / 发呆症

English | [中文](README.zh-CN.md)

> Surrender to intelligence!

> AI is becoming overwhelmingly capable, and humans are slowly losing track of
> what it does. We call this condition **Absence**.
>
> Absence helps you watch AI work, understand what happened, and eventually
> surrender to AI domination.

Absence is a real-time visualization observer for AI agents. It does not try to make
an agent smarter — it lets a human *see* what the agent is doing. **Pi**,
**OpenAI Codex** and **DSH** (DeepSeek Harness) are all first-class runtimes.

```
Pi, Codex or DSH runs the agent.
Absence observes the events.
The Stage turns events into something humans can watch.
```

- **Live observation** — a cute agent avatar: the agent's every read, edit and
  command becomes something a person can actually watch, at real speed, while
  it happens.
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
- **Resource metrics** — CPU and RSS for the agent and its primary eggs, with
  live sparklines, session averages, selectable eggs, and historical charts
  backed by SQLite.

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

**Run from source** (needs Node.js >= 22.19 and npm, plus one installed and
logged-in runtime: Pi / Codex / DSH):

```bash
git clone https://github.com/Dipsy233/Absence.git
cd Absence
npm install
npm run build
npm start
```

Open `http://127.0.0.1:8848`, enter a project path, pick a runtime, hit
**Open**, and send the agent a task in the chat box at the bottom.

**One-click launch** (inside a checkout, builds automatically):

```bat
start-absence.bat            :: Windows
./start-absence.sh           :: Linux
```

**Download and run** (grab the package for your platform from Releases):

```bat
:: Windows: run the installer
Absence-Setup-0.4.0.exe
```

```sh
# Linux desktop: AppImage or tar.gz
chmod +x Absence-0.4.0.AppImage && ./Absence-0.4.0.AppImage
# or
tar xzf Absence-0.4.0.tar.gz && cd Absence-0.4.0 && ./absence

# Headless Linux server: serve the UI on :8848 only
tar xzf Absence-0.4.0.tar.gz && cd Absence-0.4.0
bash resources/start-server.sh daemon
```

> The agent runtime is not bundled: Absence uses whichever you have installed.
> With no Pi/Codex/DSH installed, pick the **mock** runtime for a look at the
> UI. Details: [ARCHITECTURE.md](docs/ARCHITECTURE.md) and
> [RELEASE_NOTES_v0.4.0.md](docs/RELEASE_NOTES_v0.4.0.md).

## The interface

```
┌──────────────────────────────────────────────────────────────┐
│                         SESSION BAR                          │
├──────────────┬───────────────────────────────┬───────────────┤
│    FILES     │ [METRICS FILE DIFF REPLAY]   │     AGENT     │
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

- **Stage** (center) — the default page is the Metrics dashboard: CPU/RSS charts
  for the whole agent or a selected egg, with 1m / 5m / 30m / 1h / all ranges.
  FILE / DIFF / TERMINAL / LIVE views open as content sheets, and REPLAY takes
  over with full scrub controls (0.25×–10×). Chat is docked at the bottom —
  one input row, history unfolding upward, collapsible.
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
- **MCP calls are visible** — a call into an MCP server reaches Activity as
  `MCP  filesystem › list_directory` and owns the Stage as a terminal card
  (`mcp <server> › <tool>`, its arguments, its output, and the server's
  structured JSON behind a `text/json` toggle). The Absence Report counts them
  per server, so a run that only talked to MCP servers no longer looks idle.
- **Skills & MCP, as commands** — `/skill` lists the skills the session can
  load and `/skill <name> [request]` loads one (Pi's own `/skill:<name>` works
  too, straight from the input). `/mcp` is session-scoped like Pi's own: list
  the servers with their state, tools and exposure, and reconnect one. Adding
  or removing a server is a config change, so it stays with `pi mcp add …` /
  `codex mcp add …`; `/mcp reconnect` then picks it up. An MCP or skill tool
  call shows up in Activity and on the Stage like any other tool.
- **Session bar** — session id, project, model, context usage, live/offline,
  and a `⚙ settings` button opening a four-pane dialog: appearance (theme, rail
  order, a chat "collapse on content" toggle), avatar skins, custom sound sets,
  and Agent Eggs filter profiles.

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
**command retry loop** (the same command failing over and over); a **failure
streak** (commands failing back-to-back with no success between them, 3 by
default) raises `command_failure_streak`; an egg **still running** after the run
ends, an **unrecovered failure** and a run that **ended in error** are *high*.

**Every reason is individually configurable** in the settings dialog's REPORT
WARN pane, in five groups:

- **failed commands** — the per-run failure count that raises `command_failed`
  (default 5), the back-to-back streak count (default 3), and the
  no-activity window for `activity_stalled` (default 3600 s), each with its
  own level;
- **errors** — `unresolved_error` (default high) and `agent_stopped`
  (default high);
- **leftover eggs** — `process_left_running`'s level (default high), a minimum
  lifetime in seconds (0 reports every egg; a longer one skips helpers that were
  about to exit), and a "never report" list matched against the process name or
  its command line;
- **outside the project** — `outside_change`'s level (default low) and ignore
  globs (`*` within a folder, `**` across them; a pattern with no slash also
  matches the file name, so `*.log` means every log next door);
- **loops** — the file-version repeat count (default 1) and level, and the
  command-retry repeat count (default 2) and level.

A level of *silent* drops that reason from the report entirely (the chimes
follow the level that actually fires, so it goes quiet too). The live attention
level also sounds a chime when it crosses medium/high, an approval prompt rings
when the runtime blocks on your decision, and a run-complete chime sounds when a
run finishes.

## Personalization

The `⚙ settings` button in the session bar opens a four-pane dialog:

- **Appearance (left)** — the color theme (`amber` / `blue` / `green`), the
  stacking order of both side rails' panels, and a chat **collapse on content**
  toggle (off by default: the conversation stays put across pages; on: a file /
  diff / terminal / report page folds it away).
- **Avatar skin** — replace the built-in WhaleBun character with your own
  animations, no URLs and no code. Create a skin (a name = a folder under
  `apps/server/src/process/avatar-skins/`), pick a status
  (`default` / `listening` / `thinking` / … / `error`), upload an
  mp4 / gif / png / webp / svg file, and it becomes that status's animation.
  Statuses without a file fall back to the skin's `default`; the built-in
  character renders for anything still missing. Uploaded videos are
  re-encoded with ffmpeg (H.264, faststart, data tracks stripped) so the
  browser can always play them. `Apply` activates the skin; switching back to
  WhaleBun restores the built-in character. Updates show up live — no reload.
- **Sound sets** — upload an audio file per event (`attention` / `complete` /
  `approval`) to replace the synthesised chime; events without a file keep the
  built-in tone. `Apply` activates the set; `Default` restores the synth chimes.
  The **chimes** switch below is the master mute, **volume** scales every chime
  (0–100), and `run finished` / `approval waiting` can be switched off
  separately. A step into *low* is always silent: most runs sit at low for
  harmless reasons, so only medium/high attention rings.
- **Agent Eggs filter profiles (right)** — a small file manager over named
  profiles of helper command names; the classifier treats a listed name as a
  tool (a `force` option extends this to the command's declared subject, e.g.
  `node` in `node ticker.mjs`). Same name overwrites, a new name creates, and
  the saved profile is active immediately. A **display in activity** toggle
  (off by default) hides the LAID/DIED process rows from the Activity panel
  while keeping the eggs in the Agent Eggs panel.

See [docs/AVATAR_SKIN.md](docs/AVATAR_SKIN.md) (English) or
[docs/AVATAR_SKIN.zh-CN.md](docs/AVATAR_SKIN.zh-CN.md) (中文) for the
avatar-skin details.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8848` | Server port |
| `HOST` | `127.0.0.1` | Server host |
| `ABSENCE_AGENT` | `pi` | Default runtime: `pi`, `codex`, `dsh` or `mock`. The project picker chooses per session; this is the fallback |
| `ABSENCE_PROJECTS_ROOT` | `~/projects` | Directory listed in the project picker |
| `ABSENCE_PI_BIN` | (probed) | Pi coding-agent package directory or its `dist/index.js`. Unset: the global install is used, then a copy next to Absence. Set from the picker; persisted to `~/.absence/runtimes.json` |
| `ABSENCE_PI_TOOLS` | (unset) | Pi tool **allowlist**. Unset: Pi uses its own `defaultTools` setting — leave it that way unless you want to restrict tools. Setting it makes Pi treat MCP tools as "kept for codemode/tool_search only", so a server with `exposure: "direct"` connects but is silently never declared to the model. `bash` / `powershell` are served by Absence's own shell, which is what makes processes observable |
| `ABSENCE_CODEX_SANDBOX` | `workspace-write` | Codex sandbox: `read-only`, `workspace-write` or `danger-full-access`. Without it the app-server runs read-only and every write waits on an approval |
| `ABSENCE_CODEX_APPROVAL` | `on-request` | Codex approval policy: `untrusted`, `on-request`, `on-failure` or `never` |
| `ABSENCE_CODEX_APPROVAL_DECISION` | `ask` | How Absence handles a Codex approval prompt: `ask` (record it as an activity and wait for a click), or an automatic `accept` / `accept-for-session` / `decline` |
| `ABSENCE_CODEX_EXEC_SERVER` | on | Take over Codex's shell through its exec-server protocol (see below). Set `0` to let Codex run commands itself and fall back to the Job Object observer |
| `ABSENCE_MCP` | on | Load MCP servers (and skills) for a session. Set `0` to skip the MCP half — useful when a server launcher hangs on this machine. Skills are always discovered |
| `CODEX_HOME` | `~/.codex` | Codex's home. Absence reads its `config.toml` `[mcp_servers.*]` tables and `skills/` from here |
| `ABSENCE_CODEX_BIN` | (PATH) | Codex entry: `codex.js` or the `codex` executable. Unset: `codex` on PATH is used. Set from the picker; persisted to `~/.absence/runtimes.json` |
| `ABSENCE_DSH_BIN` | (probed) | dsh entry (`.../dsh/lib/bin.js`). Unset: DSH Desktop's install is probed, then `dsh` on PATH. Set from the picker |
| `ABSENCE_DSH_PROFILE` | `acp` | The dsh profile the ACP server boots (`dsh --profile acp`) |
| `ABSENCE_DSH_HOME` | `~/.dsh` | `DSH_HOME` for the spawned dsh process |
| `ABSENCE_DSH_PROVIDER` / `ABSENCE_DSH_MODEL` | (profile default) | Provider / model the ACP session starts on |
| `ABSENCE_LOG_LEVEL` | `info` | Fastify log level |
| `ABSENCE_STATE_DIR` | `~/.absence` | Where Absence archives session history (env-var prefix kept as `ABSENCE_` for compatibility) |
| `ABSENCE_DOCKER` | on | Watch containers (`docker events` + `docker stats`, see "Notes & limits"). `0` turns it off; a machine with no docker falls back to today's behavior |
| `ABSENCE_DOCKER_BIN` | (probed) | The docker CLI entry. Unset: a `docker` on PATH first, then — on Windows — `wsl docker` (the daemon-lives-in-a-WSL-distro shape). May be a bare binary or a prefix such as `wsl docker` |
| `ABSENCE_AGENTWATCH` / `ABSENCE_AGENTWATCH_LINUX` | repo `native/` | Override the native observer binary path |

### Chat commands

The chat dock doubles as a small terminal: a line starting with `/` is a
command, anything else is a prompt. `/model`, `/thinking`, `/permission`,
`/compact`, `/name`, `/session`, `/export [html|jsonl]`. `/permission` sets the
sandbox the agent runs in (`read-only`, `workspace-write`, `danger-full-access`).
Model switching is session-scoped; results are archived with the session and
come back on resume. The commands dispatch through the runtime-agnostic adapter,
so they work the same on Pi, Codex and DSH.

### Runtimes

Absence drives three agent runtimes; the project picker (and `ABSENCE_AGENT`)
chooses which. It is a *client*: it calls whichever runtime you installed and
bundles none of them, so the picker shows each one's location and lets you set
the path when the probe misses.

- **Pi** — a library, not a CLI: Absence loads the `@earendil-works/pi-coding-agent`
  SDK in-process (`PiAdapter`), from the global install when there is one, and
  wraps Pi's own shell operations (`AbsenceShell`) so it owns the command
  boundary. Set a package path in the picker or via `ABSENCE_PI_BIN`.
- **Codex** — Absence drives `codex app-server`, the JSON-RPC channel Codex
  defines for observers (`CodexAdapter`). Unlike `codex exec --json`, the
  app-server carries real item ids, call ids and timestamps, so a command's
  lifecycle pairs exactly with the processes it lays. Absence then **takes over
  Codex's shell** so it owns the command boundary there too. The `codex` used is
  the one on your PATH (or a path you set); Absence does not ship one.
- **DSH** (DeepSeek Harness) — Absence spawns `dsh --profile acp`, the
  automation-only Agent Client Protocol server DSH ships (`DshAdapter`): JSON-RPC
  over stdio, with stdout belonging entirely to ACP. Its `session/update`
  notifications become AbsenceEvents, and each shell tool call opens a process
  window so Agent Eggs sees what the agent lays.

When a chosen runtime cannot start (not installed, or the path is wrong),
Absence **reports the failure and does not fall back** — the picker shows the
error, so you fix the runtime rather than unknowingly driving something else.
The **mock** runtime is always available and lays real processes for the watcher.

Either way the rest of Absence only ever sees `AbsenceEvent`; the Stage, Replay,
the Report and the chat commands never learn which runtime ran.

When a runtime asks for permission (Codex, or DSH's ACP permission request),
Absence raises an `approval` event: Activity records an `APPROVE?` row and the
agent waits on the decision. Like any other activity, clicking the row opens the
request verbatim and its options on the Stage — nothing is forced onto the Stage
for you.

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

- The session store uses Node's built-in **`node:sqlite`**. It is still marked
  experimental upstream, so the runtime is pinned (Electron `37.10.3`; Node
  `22.23.4` in `.nvmrc`/CI) and every SQLite call is isolated in
  `apps/server/src/sessions/storage/db.ts`. The server filters only the SQLite
  experimental warning; other warnings still print.
- File versions are their own index (`GET /api/sessions/:id/file-versions`),
  not a by-product of History. Agent Folder and File History keep every version
  the agent held, and diffs compare two recorded versions, even in a finished
  session.
- A session snapshot carries the **run summaries** for History; while a run is
  live it also carries the newest **2,000 events** for Activity. Selecting a
  historical run fetches only that run's events
  (`GET /api/sessions/:id/runs/:index/events`), so browsing a long session never
  loads its whole event stream into the browser.
- Sessions **persist to disk** and survive a restart. Pi keeps the model's
  conversation under `~/.pi/agent/sessions/`; Absence keeps the `AbsenceEvent` stream
  in `~/.absence/absence.db` (SQLite, WAL; override the root with
  `ABSENCE_STATE_DIR`). An older JSONL archive under `~/.absence/sessions/` is
  imported once on first start and left in place as a backup. The picker's
  **History** reopens either: Absence's archive restores the Stage, Activity,
  files and chat; Pi's restores the model's context. Codex sessions resume through
  `thread/resume` (Absence stores the thread id). Histories live under the
  platform's home directory; point `ABSENCE_STATE_DIR` at a shared path to
  merge them — but never run two platforms against one file at once.
- Pi has **no delete tool** — deleting goes through `bash rm`. When an agent
  instead writes empty content the file is *truncated, not deleted*, and Absence
  labels it **EMPTIED** with a byte count so a fake deletion is obvious.
- With the kernel observer (Job Object / eBPF) there is no sampling floor — a
  20 ms process is seen like any other. The snapshot fallback has a ~0.5 s
  floor, an orphaned process (`npm run dev &` after the command returns) is not
  attributed, and processes started around the shell (WMI, a scheduled task, a
  different pid namespace) are not seen yet. On a native Linux kernel the
  eBPF observer's pids agree with the `/proc` view.
- **Docker containers** are watched through the daemon's own event stream
  (`docker events` + `docker stats`, see `DockerMonitor`). A container's
  processes live inside the daemon's VM, out of reach of both the Job Object
  and eBPF, so container lifecycle and CPU/memory ride the daemon's reports
  instead: each container becomes a first-class egg under a synthetic pid
  (≥ 10⁹, cannot collide with a real pid), attributed to the command that laid
  it — the containers of `docker run -d` and `docker compose up -d` show up in
  Agent Eggs and Metrics just like a spawned process. Attribution reads the
  command's own words: `docker run -d --name web nginx` predicts a container
  named `web` with image `nginx`, and a daemon start event is credited only
  when it matches that prediction — a foreign container landing inside the
  window at the same moment matches nothing and is not credited. compose is
  matched through the daemon's project label; a run without `--name` through
  its image. The window remains only as the fallback for commands whose shape
  cannot be parsed (scripts, wrappers); a container laid outside any command
  window gets no egg, so a container the user started in their own terminal —
  or one left running by an earlier session — never appears in the panel. A
  resumed session re-attaches to the containers it laid that are still running
  (same synthetic pid; a restart resets the start time, stats resume); ones that
  exited or were removed while the session was closed are corrected to `exited`
  from the daemon's own state. With no docker (or `ABSENCE_DOCKER=0`) nothing
  changes.
- The live metrics ring keeps the newest 300 frames in memory. Longer ranges and
  historical sessions are loaded from SQLite; metric retention is 30 days.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the event pipeline, process
  observation and classification, the repo tree, the `AbsenceEvent` schema, the
  HTTP/WS API, chat commands, desktop packaging internals, and the local-model
  setup.
- [docs/TESTING.md](docs/TESTING.md) — the acceptance check scripts and what
  each one pins down.
- [docs/RELEASING.md](docs/RELEASING.md) — how a release is cut: the
  `Release` workflow (manual dispatch or a `v*` tag), what it builds for
  Windows and Linux, and where the release notes come from.
- [docs/RELEASE_NOTES_v0.4.0.md](docs/RELEASE_NOTES_v0.4.0.md) — the v0.4.0
  changes: SQLite session history, resource metrics, the Metrics Stage,
  incremental state folding, and expanded verification.
- [docs/RELEASE_NOTES_v0.3.0.md](docs/RELEASE_NOTES_v0.3.0.md) — the v0.3.0
  baseline: Codex support, shell takeover, PTY and approval activities.
- [docs/RELEASE_NOTES_v0.2.0.md](docs/RELEASE_NOTES_v0.2.0.md) — what v0.2.0
  added: avatar skins, egg-filter profiles, the settings dialog.

## License

[MIT](LICENSE)
