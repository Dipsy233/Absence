# Changelog

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

Absence releases from v0.2.0 through v0.6.0. Each entry is a summary; the full
notes are under `docs/releases/`. The release process is described in
[releasing.md](docs/releasing.md).

| Version | Focus | Notes |
| --- | --- | --- |
| v0.6.0 | Observation only: three read-only channels | [v0.6.0](docs/releases/v0.6.0.md) |
| v0.5.5 | Idle cost, report endpoint and the observing contract | [v0.5.5](docs/releases/v0.5.5.md) |
| v0.5.0 | ACP access layer and UI rebuild | [v0.5.0](docs/releases/v0.5.0.md) |
| v0.4.0 | Persistence, metrics and verification | [v0.4.0](docs/releases/v0.4.0.md) |
| v0.3.0 | Codex, DSH and shell takeover | [v0.3.0](docs/releases/v0.3.0.md) |
| v0.2.0 | Personal avatars and Agent Eggs filters | [v0.2.0](docs/releases/v0.2.0.md) |

## v0.6.0 — Observation only: the observer refactor

[v0.6.0 notes](docs/releases/v0.6.0.md)

Absence no longer starts, drives or answers for any agent. It is a pure
observer: three read-only channels feed one event pipeline, and every
write-back path is refused.

- Channel `transcript` tails the session files pi writes on its own; channel
  `acp-proxy` forks its agent into a persisted observed session and taps the
  protocol; channel `os` reports the process subtree, files, resources and
  containers of a process the user already started. Discovery lists targets
  without opening a session; choosing one attaches it.
- The ACP drive stack, the agent picker, the chat, the slash palette, approval
  buttons and `/model` were removed. `createAdapter` resolves only the mock
  fixture, and every other session answers 403 on the write-back routes.
- The board is the front door: two columns (running targets, history), a click
  to monitor that becomes a click to stop, and a running row that shows its
  first prompt like a history row. A launcher no longer exists.
- History reopens an archive read-only instead of returning 404, an OS-only
  watch that gains a transcript backfills the conversation into the same
  session, and a pi process is identified by `--session <path>`,
  `--session <id>` or a bare `pi` (project cwd plus latest write) — always
  following the file it wrote last.
- Kernel observation binds one pid: `agentwatch --target-pid` adopts it into
  its own Job Object on Windows, the machine-wide eBPF stream is filtered by
  ancestry on Linux, and the table sweep remains the fallback.
- One `edit` tool call is one `file_edit` fact; a transcript record's
  `durationMs` closes a thought or places a command where it ran; runs follow
  the channel feeding the session, switching from activity bursts to user
  turns when a transcript folds in.
- SQLite schema v5 adds the observation identity (`channel`, `external_id`)
  and `runs.boundary_source`, so re-attach reuses an archive row and an
  observed session archives after `ABSENCE_ARCHIVE_SILENCE_MS` of silence.
  Schema v7 adds `transcript_checkpoints`, so a restart resumes tailing only
  after the prefix's SHA-256 verifies.
- `absence` is a headless entry point: `serve`, `ls`, `observe`, `open`,
  `unwatch` and `proxy`.
- Windows Docker capture is force-disabled; no environment variable enables it.

## v0.5.5 — Idle cost, report endpoint and the observing contract

[v0.5.5 notes](docs/releases/v0.5.5.md)

- Liveness probing stops walking the process table, and the table snapshot is
  read by the native helper instead of PowerShell/CIM (17 ms for 386 rows
  against 1.19 s of CPU). Monaco loads as a lazy chunk, the main bundle drops
  from ~3.9 MB to ~750 KB, and history refresh reads only the archive tail.
- The Absence Report engine moved to `@absence/core`, and
  `GET /api/sessions/:id/report[?run=<n>]` returns the same report without a
  browser. An idle run is no longer reduced twice a second.
- `/model` returns as a port action over the agent's `model` config option
  (`session/set_config_option`); a typed `/model …` line is still forwarded.
- The process reaper was removed: Absence observes, it never kills. Closing a
  session no longer terminates the command subtree it drove.
- The desktop shell binds a stable port (remembered, then 8848/8849/8850), so
  `localStorage`-scoped settings persist; a fresh install starts glass/dark.
- Agent executables resolve without spawning `where`; empty-file writes are
  captured; a shell-created file reads as CREATE; the picker card, its session
  id and its path matching are fixed; panels follow the newest run after a
  replay.

## v0.5.0 — ACP access layer and UI rebuild

[v0.5.0 notes](docs/releases/v0.5.0.md)

- Agents run through one ACP access layer (`AgentCatalog` → `AcpAdapter` →
  `AcpConnection`). Built-in profiles: Pi, Codex, Codex ACP alt, DSH, Claude
  Code, Qwen Code and Gemini. Custom agents are data entries in
  `~/.absence/agents.json`.
- The picker probes installed agents and reports `ready`, `needs-adapter`,
  `needs-auth` or `unavailable`; the last cell adds a custom ACP entry.
- Slash commands are forwarded verbatim; `/auth` is the only local command.
  Approvals return the agent's option id unchanged.
- Events carry `source` and `fidelity` (`exact`, `reported`, `inferred`,
  `unknown`); missing protocol fields are not filled in.
- Three faces (Rounds, Monitor, Chart) plus the Drip overlay; Monitor is the
  default. Settings has Appearance, Report WARN, Personalization and Agent Eggs
  filter panes.
- SQLite archive with paged replay, archive deletion and session retention;
  metrics, Agent Eggs, Agent Folder, replay and Absence Report use the archived
  events.
- Docker container eggs and the transparent ACP proxy are available.
- Windows releases include a portable ZIP.
- Removed: per-product adapters (`PiAdapter`, `CodexAdapter`, `DshAdapter`),
  `codex app-server`, exec-server shell takeover, `AbsenceShell`, `ExecServer`,
  `CodexShell`, `ShellEnvironment`, capability configuration management, Pi
  private session merging, local slash commands and the Classic layout.

## v0.4.0 — Persistence, metrics and verification

[v0.4.0 notes](docs/releases/v0.4.0.md)

- Sessions, events, runs and file versions moved to SQLite at
  `~/.absence/absence.db`; legacy JSONL archives were imported once.
- History is indexed incrementally and Activity loads by run.
- CPU/RSS metrics cover the agent's primary eggs, with a live ring, SQLite
  chunks and 30-day retention.
- Agent file views preserve unread line gaps and switch between recorded
  versions.
- `npm run verify` runs typechecks, the production web build and all offline
  checks.
- At v0.4.0 the Stage used METRICS as its default page with FILE / DIFF /
  TERMINAL / LIVE content views; v0.5.0 replaced that layout with the faces.

## v0.3.0 — Codex, DSH and shell takeover

[v0.3.0 notes](docs/releases/v0.3.0.md)

- Codex joined Pi, driven through `codex app-server`.
- DSH joined through its ACP server (`dsh --profile acp`).
- Absence took over Codex's shell through a loopback exec-server.
- Real PTY support with Ctrl+C handling.
- Approvals became activity rows.
- Absence Report attention thresholds and levels became configurable, and
  custom sound sets were added.
- Runtime discovery and `~/.absence/runtimes.json` were added, and Settings
  gained four panes.
- The Codex app-server client, exec-server takeover, `AbsenceShell`,
  `ExecServer`, `CodexShell`, `ShellEnvironment` and the dedicated Codex and
  DSH adapters were removed in v0.5.0.

## v0.2.0 — Personal avatars and Agent Eggs filters

[v0.2.0 notes](docs/releases/v0.2.0.md)

- The built-in character was renamed WhaleBun.
- Avatar skins supported per-status uploads of mp4, gif, png, webp and svg,
  with server-side ffmpeg re-encoding.
- Agent Eggs filter profiles folded named helper commands into counts.
- The Settings dialog had three panes at v0.2.0; its layout changed in v0.3.0
  and v0.5.0.
