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

## Unreleased — the observer refactor (`re` branch)

Absence no longer starts, drives or answers for any agent. It is a pure
observer: three read-only channels feed one event pipeline, and every
write-back path is refused.

- Channel A — transcript tails: `observe/` tails the session files agent
  software writes on its own (pi format; `ABSENCE_OBSERVE_PI_ROOT` override).
  Discovery lists targets without opening a session; selecting one
  (`POST /api/observe/watch`, or `absence observe`) attaches it with full
  backfill. `ABSENCE_AUTO_ATTACH=1` restores recency-based auto-attach.
- Channel B — the ACP proxy: a proxy session spawns its agent into a
  persisted observed session (channel `acp-proxy`), injects
  `ABSENCE_SESSION_ID` for exact kernel attribution, and projects the
  client's prompt as the run boundary.
- Channel C — OS observation: a shared machine-wide scanner (`ExternalScanner`)
  dispatches every observed transcript its bound process subtree; default-pi
  runs bind by unambiguous 1:1 pairing scoped by process cwd, and always to the
  transcript the process wrote last — a session resumed mid-run (`-c`, the
  resume picker) is followed on its new file, never the one it started with.
- History is readable again: a history row (or a `/s/<id>` deep link) reopens
  its archive read-only instead of 404ing, and an OS-only watch that gains a
  transcript backfills the conversation — its archive's process facts are not
  mistaken for transcript history and warmed away.
- Runs follow the channel that now feeds the session: folding a transcript
  into a process watch switches the run index from activity bursts to user
  turns, rebuilds the rows already written (they were labelled "usage" /
  "tool_end" by their first event), and stops the burst timer from closing a
  turn the agent is still writing. Retiring a burst session closes its open
  run instead of leaving a `running` row nobody will ever finish.
- External process observation at the kernel level: selecting a running pi
  attaches a dedicated kernel observer to that pid. On Windows an
  `agentwatch --target-pid <pid>` adopts the process into its own Job
  Object; on Linux the machine-wide eBPF stream is filtered by ancestry.
  The process subtree is reported as events rather than sampled. The user
  continues to run pi in their own terminal; Absence is neither parent nor
  proxy (`process/TargetedObserver.ts`). Falls back to the table sweep
  when no kernel observer can attach.
- The web app is the Observatory: it lists transcripts, proxies and history
  and never launches an agent. The chat input, slash palette, approval
  buttons, `/model` switching and every "+ Chat" affordance are gone; the
  approval card is read-only.
- The ACP drive stack (AcpAdapter / AcpConnection / AcpSession / permission
  bridge / auth / config options / AgentCatalog / profiles) was removed.
  `createAdapter` resolves only the mock fixture; every other session is
  observed and answers 403 on the write-back routes.
- SQLite schema v5: `sessions.channel`/`external_id` (the observation
  identity), `runs.boundary_source`. Re-attach after a restart reuses the
  archive row instead of duplicating it; observed sessions archive
  automatically after `ABSENCE_ARCHIVE_SILENCE_MS` of silence with no viewer.
- Windows Docker capture is force-disabled (no WSL daemon probing, no env
  re-enable); non-Windows container attribution works from transcript command
  windows.
- Mid-session attachment is honest: backfill streams in chunks (a record may
  span chunks), the first run is marked `attach`/`truncatedBefore` with no
  invented prompt, and appends during a backfill are read once at the end.
- SQLite schema v7: `transcript_checkpoints` stores the consumed byte offset
  and a SHA-256 of the prefix in the same transaction as the events. A restart
  resumes only after the prefix verifies, so offline appends are recovered
  without duplicating history; a rewritten or truncated transcript stops the
  merge and the board shows `transcriptResumeBlocked`.

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
