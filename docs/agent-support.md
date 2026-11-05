# Agent support (ACP)

[English](agent-support.md) | [简体中文](agent-support.zh-CN.md)

Absence is an ACP client. This document describes how an agent becomes available in the picker, how Absence starts and drives it, and how ACP updates become `AbsenceEvent`. System structure is covered in [architecture.md](architecture.md).

## 1. The single driver path

```text
AgentCatalog (profile data)
  → AcpAdapter (session layer)
  → AcpConnection (NDJSON JSON-RPC transport)
  → ACP agent process
```

`AgentCatalog` resolves a profile into a launch line, a readiness state and an optional discovery origin. `AcpAdapter` spawns the process and owns the session. `AcpConnection` performs `initialize`, `session/new` or resume, `session/prompt`, `session/cancel` and `session/close`. Every built-in agent and every custom entry uses this path.

`apps/server/src/agents/acp` contains no per-product adapter class. Product differences are data in `profiles.ts` and field-shape rules in `toolRules.json`. `createAdapter` in `apps/server/src/agents/createAdapter.ts` returns an `AcpAdapter` for a ready profile and throws the catalog's readiness reason otherwise. The non-ACP adapter is the `mock` fixture used by checks.

## 2. Discovery order and fallback

`AgentCatalog` resolves each profile in this order. The first matching entry is used.

1. **Explicit launch line**
   - A `launch` override or a custom `agents` entry in `~/.absence/agents.json`.
   - The profile's `ABSENCE_*_BIN` environment variable.
   - A legacy `~/.absence/runtimes.json` is read for compatibility and is not written.
2. **ACP binary on PATH** — each `discovery.acpBins` entry, for example `pi-acp` or `codex-acp`.
3. **Local `node_modules` adapter** — each `discovery.acpPackages` entry, with the entry point defaulting to `dist/index.js`. The search walks up to five parent directories.
4. **Agent CLI with a built-in ACP mode** — `discovery.cli` plus `acpArgs`, for example `gemini --acp`, `qwen --experimental-acp` or `dsh --profile acp`.
5. **npx fallback** — only when `ABSENCE_ALLOW_NPX=1` or `allowNpx: true` is set in `~/.absence/agents.json`. The version comes from the profile's `npxVersionEnv` when set, otherwise `npxVersion`. The row is marked as a temporary download.
6. **No ACP entry** — if the agent CLI exists but no ACP entry does, the state is `needs-adapter`. If neither exists, the state is `unavailable`.

An explicit launch line takes precedence over discovery. If the explicit command cannot be found, the row becomes `unavailable` with the failed command in the reason.

Picker behaviour:

- Rows with `unavailable` and the `mock` fixture are hidden.
- `ready`, `needs-adapter` and `needs-auth` rows are shown.
- The picker has no `allowNpx` toggle. The setting comes from `ABSENCE_ALLOW_NPX` or the `allowNpx` field in `agents.json`; the server API can write the field, but the picker does not expose it.
- The picker has no launch-line editor for arbitrary profiles. The server's `POST /api/runtimes` accepts launch overrides, but the current picker does not call it. The editing surface in the picker is the custom ACP form, which writes an `agents` entry.
- `npm run registry:sync` writes the ACP registry to `~/.absence/registry.json`. The server does not sync the registry at startup. Registry entries launch through `npx`, `uvx` or a binary and are startable only when the binary exists or npx is allowed.

## 3. Built-in profiles

Seven profiles ship in `apps/server/src/agents/acp/profiles.ts`.

| Profile id | Product | Aliases | ACP entry / launch | Auth | Override env |
|---|---|---|---|---|---|
| `pi` | Pi | `pi-acp` | PATH `pi-acp`, local package `pi-acp`; CLI `pi` alone gives `needs-adapter`; npx `pi-acp@0.0.34` | none | `ABSENCE_PI_ACP_BIN`; npx version `ABSENCE_PI_ACP_VERSION` |
| `codex` | Codex | `codex-acp` | PATH `codex-acp`, local package `@zed-industries/codex-acp`; npx `@zed-industries/codex-acp@0.16.0` | required | `ABSENCE_CODEX_ACP_BIN`; npx version `ABSENCE_CODEX_ACP_VERSION` |
| `codex-acp-alt` | Codex, alternative ACP package | — | No PATH binary; local package `codex-acp`; explicit path, override or npx `codex-acp@1.11.0` | required | `ABSENCE_CODEX_ACP_ALT_BIN`; npx version `ABSENCE_CODEX_ACP_ALT_VERSION` |
| `dsh` | DSH (DeepSeek Harness) | — | CLI `dsh --profile <dshProfile>`; default profile `acp` | none | `ABSENCE_DSH_BIN`, `ABSENCE_DSH_PROFILE`, `ABSENCE_DSH_HOME`, `ABSENCE_DSH_PROVIDER`, `ABSENCE_DSH_MODEL` |
| `claude-code` | Claude Code | — | PATH `claude-code-acp`, local package `@zed-industries/claude-code-acp`; CLI `claude` alone gives `needs-adapter`; npx `@zed-industries/claude-code-acp` | optional | `ABSENCE_CLAUDE_ACP_BIN` |
| `qwen-code` | Qwen Code | — | CLI `qwen --experimental-acp` | optional | `ABSENCE_QWEN_ACP_BIN` |
| `gemini` | Gemini | `gemini-cli` | CLI `gemini --acp` | optional | `ABSENCE_GEMINI_ACP_BIN` |

Profile notes:

- `npxVersion` describes only the npx fallback. Absence does not pin the version of an adapter that is already installed; the installed package keeps its own version.
- Pi is not an ACP server. `pi-acp` is the adapter; Absence starts an installed `pi-acp` from PATH or local `node_modules`.
- `codex-acp-alt` exists for the alternative `codex-acp` package, which declares different session capabilities. The profile declares no PATH binary; its package name is `codex-acp`, and the resolver's local `node_modules` step applies. An explicit path or override also starts it.
- The DSH profile note mentions a saved path and a DSH Desktop install. The current resolver implements PATH, an explicit override and `ABSENCE_DSH_BIN`; it does not probe a DSH Desktop installation directory.
- Claude Code's profile forwards `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` from the host environment. Qwen Code's profile forwards `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_MODEL`.

## 4. Readiness, authentication and custom entries

Readiness states:

| State | Meaning |
|---|---|
| `ready` | An executable ACP entry was found. |
| `needs-adapter` | The agent CLI exists, but no ACP entry does. The row carries an install hint; Absence does not run it. |
| `needs-auth` | The entry exists, but the profile requires authentication and the read-only inspection found no credentials. |
| `unavailable` | Neither an ACP entry nor the agent CLI was found. The row is hidden from the picker. |

`finalize` changes a `ready` row to `needs-auth` when the profile's `auth` is `required` and inspection returns `missing`. When inspection returns `unknown`, the row stays `ready` and the state reason says the sign-in requirement is unknown until the agent answers.

Authentication status comes from read-only inspection of the agent's own configuration directory:

| Status | Meaning |
|---|---|
| `configured` | A credential file or environment key was found. |
| `missing` | No credential was found. |
| `unknown` | The location exists but cannot be read, or the agent has no inspect rule. |
| `not-required` | The profile declares no authentication requirement. |

Inspection locations:

| Agent | Directory |
|---|---|
| Pi | `~/.pi/agent`, or `PI_CODING_AGENT_DIR` |
| Codex | `~/.codex`, or `CODEX_HOME` |
| Claude Code | `~/.claude`, or `CLAUDE_CONFIG_DIR` |

Inspection checks file presence and declared models. It does not read credential contents, does not write, and does not repair or migrate agent configuration. A read failure produces `unknown`.

Custom ACP entries live in `~/.absence/agents.json`. The catalog directory defaults to `~/.absence` and can be changed with `ABSENCE_CATALOG_DIR`; `agents.json` and `registry.json` live there. An entry has `id`, `label`, `command`, `args`, `env` and `cwd`. The server exposes CRUD through `GET`/`POST`/`PUT`/`DELETE` under `/api/agents`. Any executable that speaks ACP can be added this way; no code change is required.

## 5. Session lifecycle and capability gating

`AcpConnection.start()`:

1. Spawns the child process or uses an injected transport.
2. Sends `initialize` with `protocolVersion: 1`, `clientInfo` and `clientCapabilities`. File-system and terminal capabilities are false by default.
3. Checks the negotiated version. A version other than 1 closes the connection.
4. Queues requests received before the handshake in FIFO order and flushes them after it.

The negotiated ACP protocol version is always 1 (`ACP_PROTOCOL_VERSION = 1`, `SUPPORTED_PROTOCOL_VERSIONS = [1]` in `apps/server/src/agents/acp/protocol/version.ts`).

Session methods:

- `session/new` sends `{ cwd, mcpServers: [] }`. The agent reads its own MCP configuration.
- Resume calls `session/resume` if the agent declared it, otherwise `session/load` if declared. If neither is declared, `AcpUnsupportedCapabilityError` is thrown and `AcpSession.open` falls back to `session/new`.
- `session/close` is sent only when declared, is awaited before the pipe is destroyed, and is idempotent.
- Prompt blocks are trimmed to the declared `promptCapabilities`. Image, audio and resource blocks that were not declared are not sent.
- Agent-to-client requests for `fs/read_text_file`, `fs/write_text_file` and `terminal/*` receive a JSON-RPC error because the corresponding capabilities were not declared. Unknown requests receive `-32601`.
- `AcpAdapter.start` calls `processWatcher.beginSession(sessionId)` before spawning the process, so process observation filters by session.

## 6. Event projection

Projection starts at `AcpMonitorProjector.projectUpdate` in `apps/server/src/monitor/projector.ts`.

| ACP `session/update.sessionUpdate` | Result |
|---|---|
| `agent_message_chunk` | `message` event with `role: assistant`, `streaming: true` and a `delta`. A startup chunk received while `promptActive=false` is dropped so that a `## Skills` banner is not treated as a speaking turn. |
| `agent_thought_chunk` | `thinking` event with `streaming: true` and a `delta`. |
| `tool_call` | First occurrence emits `tool_start`; the terminal state emits `tool_end` plus a mapped event. |
| `tool_call_update` | Non-terminal updates emit a throttled `tool_update`; the terminal update emits `tool_end` plus a mapped event. If no `tool_call` was seen, a `tool_start` with `source: reported` is added. |
| `plan` | `message` with `role: system`, whose content is the JSON of the plan entries. |
| `current_mode_update` | `message` with `role: system`, whose content is the mode id; missing values are marked `unknown`. |
| `usage_update` | No event. Updates `context.used/total`. |
| `config_option_update` | No event. Updates `AcpConfigOptions`. |
| `available_commands_update` | No event. Updates the command completion list. |
| `session_info_update` | No event. Records the title. |

Tool-call mapping uses the ACP `kind` and the field shape. When `kind` is missing or `other`, `ToolRules` and `toolRules.json` decide by field shape. The rules do not branch on tool title or product name.

| Resolved kind | Event | Rule |
|---|---|---|
| `read` | `file_read` | Path from raw input, `locations` or a diff block. Content from the ACP content block; when absent, read from disk with `source: "os"` and `fidelity: "exact"`. Line range from `locations.line` or raw `offset`/`limit`; otherwise `rangeKnown: false`. |
| `edit` with content and no old content | `file_write` | Content from raw `content` or `new_string`; read from disk when absent. |
| `edit`, other shapes | `file_edit` | `before`/`after` from the ACP diff block or raw old/new values. A complete file can be rebuilt from disk; if not, `fullContent: false`. |
| `delete` | `file_change` with `kind: "deleted"` | Path from the resolved fields. |
| `move` | `file_change` with `kind: "modified"` | Path from the resolved fields. |
| `execute` | `command` | Command precedence: `rawInput` command fields, then the ACP `title` when the call is `execute` and `rawInput` carries none (a display fallback, never a classification). Output precedence: `rawOutput.aggregatedOutput`, then `rawOutput.stdout`/`stderr`, then streamed `_meta.terminal_output.data`, then accumulated `content` chunks. Exit-code precedence: `rawOutput.exitCode`/`exit_code`/`code`, then a nested object, then `_meta.terminal_exit`. Missing codes set `exitCodeKnown: false`. Rejection sets `permissionDenied: true`. A terminal block is carried as `terminalId`. |
| `search` | `search` | Tool is `grep` when a query exists, otherwise `find`. Match count is non-empty lines. Output is truncated at 4,000 characters. |
| `mcp__<server>__<tool>` | `mcp` | Emitted regardless of `kind`, with args, result, structured content and `isError`. Result is truncated at 20,000 characters. |
| `fetch`, `think`, `other` | No mapped event | Only `tool_start` and `tool_end` are kept. No payload is invented. |

`tool_end` sets `isError` from `status === "failed"`. A tool call produces exactly one `tool_start` and one `tool_end`; duplicate terminal updates are ignored.

The `execute` window also drives process attribution. The projector calls `ProcessWatcher.begin(command, cwd, toolCallId)` when an `execute` tool call appears and `end` at its terminal state. Processes reported during that window are attributed to the command, which is how command-scoped Agent Eggs are produced. The window carries the ACP tool call id as its `ref`, and both the `command` event and every `process` event it observed carry that id as `toolCallId` — the join key the feed uses to fold one command and its own processes into one action row, instead of a RUN row per child-count update beside the command's row.

The command's own executor is not an egg. The shell the runtime spawned to run the command string (`bash -c "…"`, `pwsh -Command "…"`) *is* the command the `command` event already reports; one shell egg per tool call turned the Agent Eggs panel into a command log. Like a marked shell it stays owned so its descendants attribute, and it is never registered as a parent egg: its children re-root and are judged on their own, so a daemon the command laid still becomes an egg while the `ls`/`cat` it ran along the way still classify as tools. A shell the agent started deliberately (`bash daemon.sh`, no `-c`) is judged like any other process.

Tool and file events are also assistant-message boundaries: `AcpAdapter` closes the open thought *and* the open reply before publishing any non-streaming event, so text on either side of a tool call is two messages, each stamped with its own start.

OS-watcher facts are tagged where they are created: `process`, `file_change` and the derived `file_write`/`file_edit` carry `source: "os"` and `fidelity: "exact"` instead of an `unknown` default. A shell write is one action, not two: when the disk diff will derive a content event from the same change, the raw `file_change` is marked `echo: true` (Activity hides it, the Report does not count it twice), and a `file_change kind: "modified"` proves the file existed, so the derived write is a modification, not a creation.

## 7. Approvals and `/auth`

Approvals:

- Only `session/request_permission` becomes an `approval` event.
- `AcpPermissionBridge.request` keeps the options supplied by the agent.
- `respondPermission` returns the user's selected `optionId` verbatim as the ACP outcome.
- Selecting a reject option records the tool call id, and the mapped event carries `permissionDenied`.
- Cancelling a turn calls `permissions.cancelAll()` first, waits one frame so the JSON-RPC response is written, then calls `session.cancelTurn()`.
- After `session/cancel`, a watchdog waits 10 seconds by default (`ABSENCE_ACP_ABORT_TIMEOUT_MS`) before settling the turn and reporting an `error`.
- There is no automatic approval policy. The server forwards the user's choice.

Authentication:

- `initialize.authMethods` supplies the options shown for `/auth`.
- `/auth <methodId>` calls ACP `authenticate` and then reopens the blocked session.
- Absence does not read tokens, fill credentials or proxy an OAuth flow. It performs only the read-only inspection described in section 4.
- Any other `/…` line is sent as a prompt. `SessionStore.forwardCommand(text)` is `this.prompt(text)`. The command panel combines commands advertised through `available_commands_update` with the local `/auth` action.

## 8. Approaches that do not work

Dedicated adapters per product do not work as a general integration strategy:

- The Codex adapter drove the private `codex app-server` protocol and intercepted its shell. The DSH adapter carried its own ACP client. The Pi adapter loaded the Pi SDK in-process and wrapped Pi's bash and PowerShell operations.
- Each implementation needed its own transport, command normalization and shell handling. A private protocol is outside Absence's control, so every product change required a matching adapter change. The same lifecycle, permission and event-mapping logic was repeated per product, and shell takeover made Absence responsible for semantics that belong to the agent.
- The ACP path replaces these implementations with profile data and one generic connection. A product that ships an ACP entry requires no Absence code; a product without one needs an adapter package or a custom `agents.json` entry.

## 9. Development aids

- `npm run probe:acp -- <scenario>` drives the collection pipeline with a scripted fixture agent and prints each `AbsenceEvent`. Point it at a real agent with `ABSENCE_ACP_BIN`.
- `npm run check:agent-catalog` checks discovery order, readiness states, the `+` cell and registry behaviour.
- `scripts/acp-fixture/fake-agent.mjs` is a scripted agent that speaks the real ACP protocol and needs no model or credentials. The `check:acp*` checks and the simulation use it as their target.
</content>
</file_path>
</invoke>
</invoke>
