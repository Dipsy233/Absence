# Agent support

[English](agent-support.md) | [简体中文](agent-support.zh-CN.md)

This document describes how Absence observes each supported agent, what each channel can and cannot see, and how the channels are configured. System structure is described in [architecture.md](architecture.md); starting and selecting targets is described in [observation.md](observation.md).

## 1. Channels and agents

Absence never starts an agent outside the proxy channel, never sends a prompt, and never answers a permission request.

| Channel | Agents | Content | Process attribution |
|---|---|---|---|
| `transcript` | Pi | Messages, thinking, tool calls and results, file writes and edits, model changes, usage, turn boundaries | Signature match on the pi executable plus the absolute `--session` path; a default `pi` run binds by project `cwd` and the transcript it wrote last |
| `acp-proxy` | Any ACP agent | Everything the protocol carries, including approvals and MCP calls | The proxy spawns the agent, injects `ABSENCE_SESSION_ID`, and the kernel observer reports it exactly |
| `os` | Any process | Processes, files and resources; no conversation content | The pid and its start time, chosen by the user or proven by the process table |

An agent with none of these channels is not observable. Absence does not parse any format other than pi's.

## 2. Pi transcripts

### 2.1 Source

The transcript source is defined in `apps/server/src/observe/transcriptSources.ts`. One profile exists:

| Property | Value |
|---|---|
| Watch root | `~/.pi/agent/sessions` |
| Directory override | `PI_CODING_AGENT_DIR`, with `sessions` appended |
| Session-directory override | `PI_CODING_AGENT_SESSION_DIR` (wins over the directory override) |
| Test override | `ABSENCE_OBSERVE_PI_ROOT` |
| Agent kind recorded on sessions | `pi` |

A file is watched only when it is a `.jsonl` file inside a source root.

### 2.2 Record mapping

The parser is `apps/server/src/observe/parsers/pi.ts`. The format is pi's own persistence, documented at `docs.pi.dev/latest/session-format.md`; pi is open source, so the format is auditable. Every fact is tagged `source: "transcript"`.

| pi record | Absence event | Fidelity |
|---|---|---|
| `session` header (`id`, `cwd`) | None. Supplies the external identity and project path. | — |
| `message` with `role: "user"` | `message` (`role: user`) | `reported` |
| `message` with `role: "assistant"`, `text` block | `message` (`role: assistant`) | `reported` |
| `message` with `role: "assistant"`, `thinking` block | `thinking` | `reported` |
| `message` with `role: "assistant"`, `toolCall` block | `tool_start` | `reported` |
| `message` with `role: "toolResult"` | `tool_end` plus the mapped fact | `reported` |
| `message` with `role: "assistant"`, `stopReason` ≠ `toolUse` | `agent_end`, then `usage` when tokens were reported | `inferred` / `reported` |
| `message` with `role: "assistant"`, first record of a turn | `agent_start` | `inferred` |
| `model_change` | `message` (`role: system`) naming the model | `reported` |
| `compaction`, `branch_summary`, `custom_message` | `message` (`role: system`) with the summary text | `reported` |
| `system` message, `usage`, `context_edit`, `label`, `custom`, `session_info`, `thinking_level_change` | None | — |

Tool results are mapped through the shared `AcpToolMapper`, so a transcript produces the same fact shapes an ACP session does. `write` and `edit` are mapped directly from their arguments, because the mapper's write path would otherwise report the same write twice.

### 2.3 Turn boundaries

`stopReason` values are `stop`, `toolUse`, `error`, `aborted` and `length`. `toolUse` keeps the turn open; every other value closes it with `agent_end`. The reason becomes the run status: `aborted` is `interrupted`, `error` is `error`, everything else is `completed`.

A run opens on a user message. A transcript whose file begins inside a turn opens its first run with `boundarySource: "attach"` and `truncatedBefore: true`, an empty prompt and no invented content.

### 2.4 Usage

Each assistant record carries `input`, `output`, `cacheRead`, `cacheWrite` and `reasoning`. At the end of a turn the parser emits one `usage` event with the summed output, the maximum context occupancy (`input + cacheRead + cacheWrite`) and the model. Values come from the transcript and the payload is marked `estimated: true`.

### 2.5 Tree semantics

pi records form a tree through `id`/`parentId`. The parser processes records in file order, which is the order the user experienced; branches are not replayed. `context_edit` rewrites the model's view and is not applied.

### 2.6 Degradation

| Condition | Behaviour |
|---|---|
| A line is not JSON | Counted as malformed, skipped |
| A `toolResult` has no matching `toolCall` | Counted as an orphan result, skipped |
| A record type is unknown | Skipped silently |
| The file is missing | The row is kept and marked `missing`; nothing is read |
| The file exceeds 200 MiB | Observation starts at the current end of the file |

## 3. ACP proxy

### 3.1 Starting a proxy session

```bash
npx tsx apps/server/src/cli.ts proxy --project /path/to/project --label pi-acp -- pi-acp
```

The client's stdin/stdout carry the ACP JSON-RPC stream; Absence writes its own messages to stderr only. The proxy can also be started over HTTP, which returns a localhost endpoint for a client to connect to:

```text
POST /api/acp-proxy/sessions
{ "command": ["pi-acp"], "cwd": "/path/to/project", "label": "pi-acp" }
```

`GET /api/acp-proxy/sessions` lists proxy sessions; `DELETE /api/acp-proxy/sessions/:id` closes one.

### 3.2 Forwarding and tapping

The proxy forwards each line unchanged before it parses it. The tap reads the parsed message, publishes `MonitorEvent`s tagged `source: "acp-proxy"` and never writes to either transport. Non-JSON lines are recorded as diagnostics; a permission request that is never answered is reported rather than answered.

### 3.3 Session persistence

When observation is enabled, the proxy creates an observed session through `SessionStore.createObserved` with channel `acp-proxy`. The agent process receives `ABSENCE_SESSION_ID` naming that session, so the kernel observer attributes its processes exactly. If the session cannot be created, the proxy still forwards and records a diagnostic.

### 3.4 Projection

`apps/server/src/monitor/projector.ts` projects ACP `session/update` messages:

| `sessionUpdate` | Result |
|---|---|
| `agent_message_chunk` | `message` (`role: assistant`, streaming) |
| `agent_thought_chunk` | `thinking` (streaming) |
| `tool_call` | `tool_start`, then `tool_end` and the mapped fact at the terminal update |
| `tool_call_update` | Throttled `tool_update` while running; `tool_end` and the mapped fact at the terminal update |
| `plan` | `message` (`role: system`) with the plan entries as JSON |
| `current_mode_update` | `message` (`role: system`) with the mode id |
| `usage_update` | No event; updates the context counters |
| `config_option_update`, `available_commands_update`, `session_info_update` | No event; updates session state |

A `session/prompt` request from the client is projected as a user `message` and opens a run. The agent's response to that prompt closes the run with the final message and `agent_end`; no usage is invented.

### 3.5 Tool mapping

Tool calls are mapped by ACP `kind` and, when `kind` is missing or `other`, by field shape through `ToolRules` and `toolRules.json`. Rules never branch on tool title or product name.

| Resolved kind | Event | Notes |
|---|---|---|
| `read` | `file_read` | Path from raw input, `locations` or a diff block; content from ACP or read from disk (`source: os`, `fidelity: exact`); line range from `locations` or raw `offset`/`limit`, otherwise `rangeKnown: false` |
| `edit` with content and no prior content | `file_write` | Content from raw `content` or `new_string`, or read from disk |
| `edit`, other shapes | `file_edit` | `before`/`after` from a diff block or raw values; `fullContent: false` when the file cannot be reconstructed |
| `delete` | `file_change` (`kind: deleted`) | |
| `move` | `file_change` (`kind: modified`) | |
| `execute` | `command` | Command from `rawInput`, then the ACP `title` for display only; output from aggregated output, stdout/stderr, streaming terminal output or content; exit code from reported fields, otherwise `exitCodeKnown: false`; `permissionDenied: true` when refused |
| `search` | `search` | `grep` when a query is present, otherwise `find`; output truncated to 4,000 characters |
| `mcp__<server>__<tool>` | `mcp` | Emitted regardless of `kind`; result truncated to 20,000 characters |
| `fetch`, `think`, `other` | No mapped event | `tool_start` and `tool_end` are kept; no payload is invented |

A tool call produces exactly one `tool_start` and one `tool_end`. A repeated terminal update is ignored. Every `tool_start` / `tool_update` / `tool_end` carries the agent's own `kind` and `title` verbatim alongside the display `toolName`.

A call that changes a file is never dropped. When the protocol says `edit` but no content is readable, the post-state is read from disk and recorded as `file_write` (`source: os`); when the disk cannot be read either, a `file_change` remains. An empty-content write creates a zero-byte file and is a real write.

### 3.6 Approvals

Only `session/request_permission` becomes an `approval` event. The event carries the options the agent offered. The answer is produced wherever the agent really runs — the editor client for a proxied session, the agent's own terminal otherwise — and the resulting events record what was answered. The web client renders the card read-only.

### 3.7 Command windows

An `execute` tool call opens a `ProcessWatcher` command window and the terminal update closes it. Processes reported inside the window are attributed to that command, which produces command-level Agent Eggs. The window carries the tool call id, and both the `command` event and every observed `process` event carry the same `toolCallId`, so the feed merges one command with its own processes into a single row.

The shell that executes a command string (`bash -c "…"`, `pwsh -Command "…"`) is the command itself and does not become an egg; its children are re-rooted and classified on their own shape. A daemon the command leaves behind does become an egg. A shell the agent starts deliberately (`bash daemon.sh`, without `-c`) takes part in classification normally.

## 4. OS-only observation

A process chosen on the board opens a session with channel `os`. The session samples the process subtree it is bound to: processes, files and resources. It has no conversation content.

Activity is recorded as runs with `boundarySource: "activity-burst"`; a burst closes after `RUN_BURST_IDLE_MS` (90 s) without a fact, and retiring the session closes an open burst rather than leaving it `running`. When a transcript later proves to belong to the same pid, it is folded into the same session and the session records both channels. The run index then switches from bursts to user turns and rebuilds the rows already written, which were labelled by their first event (`usage`, `tool_end`) instead of a prompt.

## 5. Binding a transcript to a process

Absence binds a transcript to a pid only on evidence:

| Evidence | Binding |
|---|---|
| The pi command line names the transcript (`--session <file>`) | Exact match on the absolute path |
| A default `pi` process (no `--session`) | Project `cwd` must match the transcript header's `cwd`, and the process is paired with the file it wrote **last**: a transcript born just after the process started, or any older transcript the process resumed, competes by latest write |
| Anything ambiguous | Not bound: two processes with the same cwd, two equally recent files, or either side's cwd unknown still bind nothing |

A reused pid is a different process: identity is the pair (pid, start time).

## 6. Windows and Docker

Windows does not capture Docker containers. `DockerMonitor` is disabled, no Docker or WSL daemon is probed and `ABSENCE_DOCKER=1` does not enable it. Docker commands in a transcript remain ordinary command facts.

## 7. Development fixtures

| Fixture | Purpose |
|---|---|
| `scripts/mock-agent/agent.mjs` | A scripted ACP agent that needs no model or credentials. Used by `check:acp-proxy` and by the proxy path in checks. |
| `apps/server/src/agents/MockAdapter.ts` | The only runtime Absence drives; opened through `POST /api/sessions` with `agent: "mock"`. Used by `check:e2e`. |
| `scripts/checks/fixtures/` | Transcript and protocol fixtures for the offline checks. |

`scripts/mock-agent/run.ts` still starts sessions through the removed ACP profile path and does not run against this build; `npm run absence-sim` is therefore not a usable gate. `npm run check:acp-all` (mapping and proxy) and `npm run check:e2e` cover the agent layer.
