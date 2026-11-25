# Running the observer

[English](observation.md) | [简体中文](observation.zh-CN.md)

This document describes how Absence is started, how a target is chosen, and what an observation can and cannot recover when it begins after the agent has already been running. Module structure is described in [architecture.md](architecture.md).

## Process model

Absence is one server process. It serves the web app, the HTTP API and the session WebSocket on one address. The desktop shell starts the same server in its own process; a headless host runs the same server without a desktop.

The agent is never a child of Absence except through the proxy channel. The user starts the agent in its own terminal or editor, and Absence reads what that agent writes and starts.

```text
agent terminal ──writes transcript──▶ transcript tail ─┐
ACP client ──▶ absence proxy ──▶ agent ──tap──────────┼──▶ event pipeline ──▶ web, archive
OS: process table, kernel observer, file watcher ─────┘
```

## Starting

```bash
npx tsx apps/server/src/cli.ts serve            # 127.0.0.1:8848
npx tsx apps/server/src/cli.ts serve --port 9000 --open
```

`npm start` runs the same entry point. The first page is the observation board.

### Remote access

The server refuses to bind a non-loopback address without `ABSENCE_TOKEN`; the process exits with a message naming the variable. With a token set, the client sends it as `?token=<value>` or an `x-absence-token` header. A token authenticates requests and does not encrypt them, so a network bind requires TLS termination in front of the server.

An SSH tunnel keeps the bind on loopback:

```bash
ssh -N -L 8848:127.0.0.1:8848 user@agent-host
```

## Choosing a target

The board has two columns:

| Column | Content | Action |
|---|---|---|
| Running | Running agents: watched sessions and running targets | Click a row to start monitoring and open its panel |
| History | Archived sessions and exited transcripts | Open the archive as a read-only replay, or delete it |

Monitoring ends from inside the panel: its `change` button drops the monitor lease and closes the live session, and the target returns to the Running column as watchable. The archive remains.

A target key is stable across restarts:

| Key | Identity |
|---|---|
| `transcript:<absolute file>` | The transcript file |
| `proc:<pid>@<startedAtMs>` | The pid together with its start time |
| `proxy:<session id>` | The proxy session id |

Discovery lists targets; it creates no session, no watcher and no sampler. `POST /api/observe/watch` creates the session and records a monitor lease. The CLI performs the same action:

```bash
npx tsx apps/server/src/cli.ts ls
npx tsx apps/server/src/cli.ts observe --session /abs/path/session.jsonl
npx tsx apps/server/src/cli.ts observe --pid 12345
```

`--pid` selects only targets Absence has already matched; it does not monitor an arbitrary process. A pid alone is refused when two targets name it, and `--cwd` is refused when several targets work in that directory.

Selecting a transcript target that a **running pi** writes binds that process and observes it over the kernel-grade OS channel (a dedicated Job Object on Windows, the machine-wide eBPF stream filtered by ancestry on Linux), and folds the transcript's conversation into the same session. The user continues to run pi in their own terminal; Absence is neither parent nor proxy. Selecting a transcript whose agent has exited replays its history.

A `pi` process names its conversation in one of three ways, and Absence resolves them in that order:

| Command line | Binding |
|---|---|
| `--session <absolute path>` | That exact transcript file. On Windows the extended-length form `\?\C:\…` pi uses for long paths is stripped before comparing. |
| `--session <id>` | The transcript whose header carries that id — the process writes it itself, so the command line names no file. |
| No `--session` (a default `pi`, or `-c` resumed from the picker) | Project `cwd` plus the file the process wrote **last**: among the files it has written while it ran, only the most recent can be its current session. |

A long-lived `pi` that resumes another conversation is therefore followed on the file it writes now — never the one it started with. Ambiguity (two processes, two equally recent files, or either side's working directory unknown) still binds nothing, and a process that has not written anything yet stays a process row.

A process row is identified by its working directory, with the pid beside it: `proc:<pid>@<startedAtMs>` is what the board *uses*, not what it shows.

`ABSENCE_AUTO_ATTACH=1` restores the earlier behaviour in which a transcript written in the last ten minutes attaches without a selection.

## Monitor leases

A lease records that the user chose to monitor a session.

| Property | Behaviour |
|---|---|
| Persistence | Stored in SQLite; restored at boot |
| Tab close | Does not remove the lease |
| `unwatch` / the board's ✕ | Removes the lease; the archive stays |
| Idle sweep | Leased sessions use `ABSENCE_LEASE_SILENCE_MS` (default 2 h), unleased observations use `ABSENCE_ARCHIVE_SILENCE_MS` (default 30 min); a session being backfilled or watched by a connected viewer is skipped |
| Effect of archiving | Watchers and sampling stop; the archive and its identity remain |

## Mid-session attachment

The observer may attach after the agent has already worked. What it recovers depends on the channel.

| Channel | Before attachment | After attachment |
|---|---|---|
| `transcript` | Every complete record already in the file is delivered in file order. A real user message remains a real run boundary. When the file begins inside a turn, the first run is marked `boundarySource: "attach"` with `truncatedBefore: true` and an empty prompt; no prompt is invented. | The same parser continues from the byte offset; a record without a terminating newline is read after the writer finishes it. |
| `os` | Only processes present and attributable at attachment time. Exited short-lived processes, past samples and past conversation are not recoverable. | The process subtree is followed at the kernel level: Windows adopts the chosen process into its own Job Object (`agentwatch --target-pid`); Linux filters the machine-wide eBPF stream by ancestry. Creations and exits are reported as events, without polling. When neither can attach, observation degrades to process-table sampling. With no transcript to read, activity is recorded as runs with `boundarySource: "activity-burst"`; once a transcript is folded into the same session, run boundaries switch back to user turns and the burst rows are rebuilt from the archive. |
| `acp-proxy` | Not a way to attach to an existing terminal process. Traffic that did not pass through the proxy is not available. | Only facts carried by the proxied connection are recorded. |

### Backfill and live tail

A transcript backfill reads the file from byte 0 in bounded chunks and yields between chunks, so the board and sockets stay responsive. A single JSON record may span chunks; the reader continues until it reaches a newline. A file larger than 200 MiB is observed from its end rather than backfilled, and the row does not claim otherwise.

Appends that arrive during a backfill are read once when the backfill finishes. Concurrent attach requests for one file share one session.

### Restart continuity

Schema v7 stores a `transcript_checkpoints` row per session: the consumed byte offset and a SHA-256 of the consumed prefix, written in the same transaction as the events.

| Situation | Behaviour |
|---|---|
| Prefix matches the stored digest | Reading resumes at the stored offset. History is not delivered twice; records appended while the server was stopped are delivered. |
| Prefix was rewritten or truncated | The observer stops merging, records nothing further and the board shows `transcriptResumeBlocked`; the user re-selects the target to start a new observation |
| No checkpoint (an archive from an earlier schema) | The parser reads from byte 0 and discards what it parses, then tails live facts |

## Known limits

| Limit | Consequence |
|---|---|
| Transcripts over 200 MiB | No full backfill; observation starts at the current end of the file |
| OS-only observation | Conversation content and metrics before attachment do not exist |
| Kernel observer unavailable | Process observation falls back to process-table sampling, which can miss short-lived processes; metrics report precision `sampled` |
| External agent is not a server descendant | The server's own Job Object cannot see it; Windows instead forms a dedicated Job Object on the chosen pid, Linux reuses the machine-wide eBPF stream. Requires the same user's rights over the target; a non-nestable job or missing rights degrades to sampling (`sampled`). |
| Windows | Docker container capture is disabled; container events are not recorded |
| Unmatched transcripts | A transcript and a process are bound only on explicit evidence (`--session` path) or an unambiguous one-to-one pairing scoped by project `cwd`; the pairing follows the process's latest write, and ambiguity leaves them unbound |
