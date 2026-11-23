# Absence

[English](README.md) | [简体中文](README.zh-CN.md)

**Surrender to intelligence**

AI advances faster than human thought can follow. People fall behind an agent's line of thought and sit idle; this project calls that condition Absence.

Absence is a read-only visual observer for AI agents. The agent runs in its own terminal or editor, unchanged. Absence watches the records that agent software already writes and the processes it already starts, then renders what happened and keeps a reviewable archive.

## What it shows

- **The action in progress.** The Stage renders the current fact: a file read, a diff, a command with output and exit code, an approval request, an MCP call. The Activity feed keeps the chronological record of the same run.
- **The agent's view of the project.** Agent Folder lists files the agent read, wrote or edited, with read ranges and complete versions. The project tree beside it is read from disk.
- **What the run cost and left behind.** Resource metrics cover the agent tree, each egg, Docker containers and the host. Agent Eggs groups the processes the agent started, classified by behaviour.
- **A run after it ends.** Sessions are archived in SQLite. History reopens an archived session; replay rebuilds file contents, agent state and the current Stage action from the event stream and periodic snapshots.
- **The Absence Report.** A deterministic reduction of one run: timeline, changes, executions, known facts, attention items and a conclusion. It runs in the client, calls no model and does not interpret command text.

## Observation channels

Absence never starts, prompts, cancels or answers an agent. Three read-only channels feed one event pipeline:

| Channel | Source | Coverage |
|---|---|---|
| `transcript` | The session files pi writes under its own session directory | Messages, thinking, tool calls and results, file writes and edits, usage, turn boundaries |
| `acp-proxy` | An ACP client pointed at `absence proxy`, which forwards bytes unchanged and taps them | Everything the protocol carries, with exact process attribution |
| `os` | Process table scanning, kernel observers, file watching, Docker events on non-Windows hosts | Processes, files, resources, containers; no conversation content |

## Supported agents

- **Pi** — transcript tailing. This is the only private format Absence parses; pi is open source, and the format is documented at `docs.pi.dev/latest/session-format.md`.
- **Any ACP agent** — through the transparent proxy, when the client supports configuring an ACP endpoint.
- **Any other agent** — OS-only observation: processes, files and resources, with no conversation content.

## Requirements

Node.js 22.19 or newer and npm. Absence bundles no agent runtime.

## Run from a source tree

```bash
git clone https://github.com/Dipsy233/Absence.git
cd Absence
npm ci
npm run build
npx tsx apps/server/src/cli.ts serve
```

The server listens on `127.0.0.1:8848`. The observation board is the first page. Selecting a target starts monitoring it; the panel URL is `/s/<sessionId>`.

Development runs the server and the Vite dev server together with `npm run dev`. `start-absence.sh` and `start-absence.bat` install dependencies, rebuild the web app when it is stale, start the server and open the browser.

### Command line

| Command | Effect |
|---|---|
| `serve [--port N] [--host H] [--open]` | Start the server (the default command) |
| `ls [--json]` | List the targets this host can monitor |
| `observe (--pid P \| --session FILE \| --cwd DIR \| --latest)` | Select a target, record a monitor lease and print its panel URL |
| `open <sessionId>` | Print the panel URL of a session |
| `unwatch <sessionId>` | Drop a monitor lease; the archive stays |
| `proxy [--project DIR] [--label NAME] -- <command> …` | Forward an ACP client to an agent and tap the traffic |

`ls`, `observe`, `open` and `unwatch` read `ABSENCE_URL` and `ABSENCE_TOKEN` when they address a running server.

### Remote access

The server refuses to bind a non-loopback address without `ABSENCE_TOKEN`. A token does not encrypt traffic; use an SSH tunnel or a TLS reverse proxy.

```bash
ssh -N -L 8848:127.0.0.1:8848 user@agent-host
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8848` / `127.0.0.1` | Listen address |
| `ABSENCE_TOKEN` | unset | Required for a non-loopback bind; accepted as `?token=` or `x-absence-token` |
| `ABSENCE_STATE_DIR` | `~/.absence` | Archive, metrics and monitor leases |
| `ABSENCE_OBSERVE` | `1` | `0` disables the observation subsystem |
| `ABSENCE_AUTO_ATTACH` | `0` | `1` attaches recently written transcripts without a selection |
| `ABSENCE_OBSERVE_PI_ROOT` | unset | Overrides the pi session directory (tests) |
| `ABSENCE_ARCHIVE_SILENCE_MS` | `1800000` | Silence before an unleased observation is archived; `0` disables |
| `ABSENCE_LEASE_SILENCE_MS` | `7200000` | Silence before a leased observation is archived; `0` keeps it |
| `ABSENCE_ARCHIVE_SWEEP_MS` | `60000` | Idle sweep interval |
| `ABSENCE_SESSION_RETENTION_DAYS` | `0` | Archive retention by age; `0` keeps all |
| `ABSENCE_MAX_ARCHIVED_SESSIONS` | `0` | Archive retention by count; `0` keeps all |
| `ABSENCE_METRICS_RETENTION_DAYS` | `30` | Metric retention |
| `ABSENCE_MAX_EGGS` | `200` | Retained finished eggs per session |
| `ABSENCE_DOCKER` | on except Windows | Docker container observation |
| `ABSENCE_WEB_DIST` | `dist/web` | Directory served as the web app |

## Documentation

[docs/index.md](docs/index.md) indexes every document with its purpose, audience and language pairing. Common starting points:

- [docs/observation.md](docs/observation.md) — running the server, selecting targets, mid-session semantics.
- [docs/architecture.md](docs/architecture.md) — event flow, modules, storage and API.
- [docs/ui-faces.md](docs/ui-faces.md) — the three faces, Drip and the observation board.

## License

MIT. See [LICENSE](LICENSE).
