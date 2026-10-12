# Release v0.3.0 — Codex Support / 兼容 Codex

**OpenAI Codex joins Pi as a first-class runtime · shell takeover via the
exec-server protocol · real PTY support · approval prompts as activities**

> 中文说明见下方的“后续提交（post-v0.3.0，未发版）”一节，覆盖 DSH 运行时、
> 可配置报告警告、音效集等 v0.3.0 之后的全部变更。

Absence could already watch Pi run. v0.3.0 makes it watch **Codex** too — and it
does not just read Codex's event stream, it *takes over Codex's shell* so the
process observer sees exactly what the agent spawns, on Windows and Linux alike.

---

## ✨ Highlights / 亮点

### 🤖 Codex is a first-class runtime
Pick **Codex** in the project picker (or set `ABSENCE_AGENT=codex`) and Absence
drives `codex app-server`, the JSON-RPC channel Codex defines for observers.
Unlike `codex exec --json`, the app-server carries real item ids, call ids and
timestamps, so a command's lifecycle pairs exactly with the processes it lays.

Everything the UI already does works unchanged: the Stage, Activity, Replay, the
Absence Report, Agent Eggs, Agent Folder, the chat commands (`/model`,
`/thinking`, `/permission`, …). The web app never learns that Codex exists — it
still speaks only `AbsenceEvent`.

### 🐚 Absence takes over Codex's shell
Pi's shell is Absence's own (`AbsenceShell`), which is what lets Absence see
every process a Pi command lays. Codex runs in its own process, so the same trick
is not available — but Codex exposes an **exec-server** it delegates execution to.
Absence starts a loopback exec-server, registers it with `environment/add`, and
pins the thread to it. Codex then hands every command to Absence as a
`process/start`, and **Absence spawns it itself**.

That fixes the two things that made Codex observation unreliable:

- **A command can no longer escape the observer.** A detached launch
  (`Start-Process`, a background daemon) used to go through the shell
  (`explorer.exe`), outside the Job Object, and vanished. Now it is Absence's own
  child — inside the job, seen and attributed like any other.
- **An exit can no longer be missed.** The exit is observed first-hand as the
  child closes, instead of depending on a kernel message that a burst-killed
  process tree can drop.

Set `ABSENCE_CODEX_EXEC_SERVER=0` to roll back to Codex's own executor (the
observer still runs, just with the old limits).

### 🖥️ Real PTY, exactly like Codex
Codex allocates a PTY only when the model asks for `tty: true`; otherwise it uses
plain pipes. Absence does the same — a real PTY through **node-pty (ConPTY on
Windows)** for `tty: true`, plain pipes otherwise. A PTY merges stdout and stderr
into one stream and delivers Ctrl+C written to it, so an interactive command
behaves exactly as it would natively.

### ⛔ Ctrl+C now works
Codex never writes Ctrl+C to a non-PTY stdin — it calls `process.interrupt()`,
which arrives as `process/signal { signal: "interrupt" }`. Absence answers with a
process-tree kill, which is what Ctrl+C means to a command in a real console.
Before this, the request fell through and the agent reported "Ctrl+C did
nothing".

### 🌱 The command's environment is Codex's environment
Codex sends an `env_policy` (inherit / exclude / set / include-only) plus a sparse
`env`; Absence runs that policy over its own environment exactly as Codex's
`shell_environment::create_env` does, then lets the request's `env` win. This is
what keeps `PATH` and `PATHEXT` present, so `node ticker.mjs` resolves `node` the
same way it does natively. (Taking the environment from the sparse `env` alone
was the early bug where `node` was "not recognized".)

### 🪟 Linux parity
The takeover is what makes Codex observation work on Linux too. There the
observer is eBPF and reports no environment marker, so a process is attributed by
its ancestry alone — which the takeover makes complete by construction. Both
platforms now capture the same eggs the same way.

### 🔔 Approval prompts are activities
An approval prompt is no longer forced onto the Stage. It arrives as an ordinary
`APPROVE?` activity row (with a chime, because the agent is blocked on you), and
opening it shows the request verbatim with the runtime's own options. Nothing is
pushed in front of what you were already looking at.

### 🧹 The panel shows *your* command, not the wrapper
The egg panel and command events show the command the model wrote, not Codex's
shell wrapper. `pwsh.exe -Command "try { … } catch {}\nnode ticker.mjs"` is
displayed as `node ticker.mjs`, and the same for `bash -lc "…"`.

---

## 🔧 Also in this release

- **Agent Eggs exit fix (Windows):** the Job-Object completion port can drop an
  `EXIT_PROCESS` message when a whole tree is killed at once. The observer now
  also waits on each process handle (`RegisterWaitForSingleObject`), a kernel
  signal that cannot be lost.
- **Session attribution corrected:** an environment marker is now only used to
  *exclude* another session's processes, never as a requirement — the fix that
  made Linux capture work.
- **More checks:** `check-codex`, `check-execserver`, `check-shellenv`,
  `check-codexshell`, `check-fsdiff`, plus new eBPF/agentwatch regressions.

---

# 后续提交（post-v0.3.0，未发版）/ Changes after v0.3.0

以下是 v0.3.0 文档写成之后合入的全部变更（提交 `791d4e5` → `772430a`），
发版时此节应拆成 v0.4.0 的 release notes。

## 🐳 DSH — the third runtime (DeepSeek Harness over ACP)

`dsh` joins Pi and Codex as a first-class runtime. Absence spawns
`dsh --profile acp` — DSH's automation-only Agent Client Protocol server — and
drives it over JSON-RPC/NDJSON stdio (`DshClient` is the transport,
`DshAdapter` maps `session/update` notifications to `AbsenceEvent`s).

- Message / thinking / tool / file / command / search events all map, and
  `usage_update` becomes context usage.
- DSH's read results are unwrapped: the `<path>…<content>NN: line…` wrapper is
  stripped so a `file_read` looks exactly like Pi's plain-text shape.
- Every shell tool call opens a `ProcessWatcher` window (`begin` on
  `tool_call`, `end` on `tool_call_update`), so Agent Eggs sees the processes
  the agent lays.
- `session/request_permission` surfaces as an `approval` event; the chosen ACP
  option id is sent back.
- Location order: `ABSENCE_DSH_BIN` / saved path → DSH Desktop install →
  `dsh` on PATH. Config: `ABSENCE_DSH_BIN` / `_PROFILE` / `_HOME` /
  `_PROVIDER` / `_MODEL`.

## 🔔 Report attention is configurable

- `command_failed` now fires only after a configurable number of failed
  commands in one run (default 5) and raises a configurable level.
- New `command_failure_streak` reason: N back-to-back failures with no success
  between them (default 3, level medium).
- New `activity_stalled` reason: no event at all for N seconds while the run is
  live (default 3600 s, level medium).
- All thresholds and levels are configurable in the Settings dialog's
  **REPORT WARN** pane (levels: none / low / medium / high); an unrecovered
  failure stays *high* regardless of thresholds.

## 🎵 Custom sound sets

Modeled on avatar skins: upload audio per event (`attention` / `complete` /
`approval`) in the Settings dialog to replace the synthesized WebAudio chimes.
Events without a file keep the built-in chime.

- Server: `process/sounds.ts` (`sound-sets/<set>/<event>.<ext>` +
  `active.json`), `api/sounds.ts`, the active set served at `/sound/<event>`
  with HTTP Range (`?set=` auditions a specific set).
- Web: `SoundPane.tsx` (preview / clear / activate), playback through
  `lib/sounds.ts` with coverage polling, wired via `useSounds`.

## 🏠 Absence is a client of *your* runtimes

Absence no longer assumes any runtime location — it locates what you have and
shows it in the picker:

- **Pi:** `agents/PiBin.ts` resolves the `@earendil-works/pi-coding-agent`
  package as configured path > `ABSENCE_PI_BIN` > the global npm install > the
  copy resolved from Absence's tree, reporting the source and version. The SDK
  is loaded through `loadPiSdk()` instead of a bare specifier.
- **Codex / DSH:** `GET` / `POST /api/runtimes` plus `~/.absence/runtimes.json`
  persist binary paths; `ABSENCE_CODEX_BIN` seeds Codex. The picker gained a
  **runtime paths** panel with an availability dot per runtime.
- **No silent fallback:** if the requested runtime cannot start (not installed,
  wrong path, no credentials) the session fails with a clear error the picker
  shows — never a silent mock. Spawn failures (ENOENT) are handled events, not
  server crashes.

## 💬 Chat dock rework

- The conversation stays above the Stage at all times (z-order fixed so the
  report / file / diff / terminal sheets never cover it).
- New Settings → **APPEARANCE** toggle *collapse on content* (default off): by
  default the chat stays exactly as the user left it across pages; when on, a
  content page folds the history away.

## ⚙️ Settings dialog: four panes

The dialog is now **APPEARANCE | REPORT WARN | PERSONALIZATION | EGGS FILTER**:

- APPEARANCE: theme, panel order, *collapse on content*.
- REPORT WARN: the three warnings above, each with a threshold and a level.
- PERSONALIZATION: avatar skin + sound sets stacked in one column, each half
  scrolling independently (apply buttons no longer covered).
- EGGS FILTER: profile management reworked to match the avatar-skin layout
  (sidebar + `+` new, editing label, one-line bottom band), plus a
  *display in activity* toggle (default off) that hides the LAID/DIED process
  rows from the Activity panel while keeping the eggs in Agent Eggs.

## 🚀 Launchers build only what changed

`start-absence.bat` / `.sh` and the desktop launcher now rebuild only when the
output is older than a source file (mtime check over the web sources, not just
an existence check); `--force` rebuilds anyway. The native observer build
scripts do the same.

## 🧪 Test infrastructure rework

- The eleven check scripts share one harness (`scripts/checks/harness.ts`):
  `check()` / `finish()` / `waitFor()` replace eleven copy-pasted counter
  blocks.
- `npm run check:offline` runs every offline check in one process-spawning
  pass; the script list is registered only in
  `scripts/checks/run-offline.ts`, so a new check touches exactly one place.
- CI runs `check:offline` on **Node 22**, matching `engines.node` (it ran on
  Node 20 before, which violates the ≥ 22.19 requirement).
- `check-report.ts` grew to **72 checks** (stall, streak, timeline effects,
  version/retry loops, outside change ranking) and `check-history.ts` to
  **63 assertions**.
- `make-demo.mjs` defaults to `./absence-demo` instead of a hardcoded absolute
  path.

## 📚 Docs

- `docs/AVATAR_SKIN.md` (this release adds the English version;
  `AVATAR_SKIN.zh-CN.md` existed since v0.2.0).
- ARCHITECTURE / TESTING / README refreshed against the tree: the DSH adapter,
  the new API modules (`eggFilter.ts`, `sounds.ts`), the new stage components
  and stores, and the check-script inventory.

## 📡 New HTTP API

None. v0.3.0 is a runtime addition; the existing API is unchanged.

## 📦 Upgrade notes

- **Restart the server** and hard-refresh the browser (`Ctrl+Shift+R`).
- To use Codex: have `codex` installed and logged in, then pick it in the project
  picker or set `ABSENCE_AGENT=codex`. `ABSENCE_CODEX_SANDBOX`,
  `ABSENCE_CODEX_APPROVAL` and `ABSENCE_CODEX_APPROVAL_DECISION` tune the sandbox,
  the approval policy and how prompts are answered.
- New dependency: `node-pty` (native, ships prebuilt binaries) for `tty: true`.
- Linux: rebuild the eBPF observer if you build from source; the committed
  prebuilt is unchanged by Codex support.

## 📚 Docs

- [README](../README.md) — new runtime and Codex sections
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — the exec-server takeover and the
  Codex adapter
- [docs/TESTING.md](TESTING.md) — the Codex acceptance checks
- [docs/AVATAR_SKIN.md](AVATAR_SKIN.md) — avatar skins (English;
  [中文](AVATAR_SKIN.zh-CN.md))

---

**Codex, watched the same way Pi is.**
