# Release v0.3.0 — Codex Support / 兼容 Codex

**OpenAI Codex joins Pi as a first-class runtime · shell takeover via the
exec-server protocol · real PTY support · approval prompts as activities**

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

---

**Codex, watched the same way Pi is.**
