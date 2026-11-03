# Changelog

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

Absence releases from v0.2.0 through v0.5.0. Each entry is a summary; the full
notes are under `docs/releases/`. The release process is described in
[releasing.md](docs/releasing.md).

| Version | Focus | Notes |
| --- | --- | --- |
| v0.5.0 | ACP access layer and UI rebuild | [v0.5.0](docs/releases/v0.5.0.md) |
| v0.4.0 | Persistence, metrics and verification | [v0.4.0](docs/releases/v0.4.0.md) |
| v0.3.0 | Codex, DSH and shell takeover | [v0.3.0](docs/releases/v0.3.0.md) |
| v0.2.0 | Personal avatars and Agent Eggs filters | [v0.2.0](docs/releases/v0.2.0.md) |

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
- Docker container eggs, `absence watch` observe mode and the transparent ACP
  proxy are available.
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
