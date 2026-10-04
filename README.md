# DAZE / 发呆症

> AI moves fast. Humans watch.

DAZE is a real-time visualization observer for AI agents. It does not try to make
an agent smarter — it lets a human *see* what the agent is doing.

```
Pi runs the agent.
Daze observes the events.
The Stage turns events into something humans can watch.
```

## What you get

A single screen, three columns:

| Column | Panels |
|---|---|
| left | **Session** info, **Files** tree, **Activity** timeline |
| center | **Stage** — file reads, edit diffs, terminal output |
| right | **Agent** avatar, **Plan** paper, **Chat** |

The agent runtime is Pi. DAZE never talks to an LLM directly; it subscribes to the
agent's event stream, translates it into a runtime-agnostic `DazeEvent`, and the UI
renders those events. Swap Pi for another runtime by writing one adapter.

## Architecture

```
Browser ──WebSocket──▶ Daze Server ──EventBus──▶ AgentAdapter ──▶ Pi (SDK, in-process)
   ▲                                                                     │
   └────────────── DazeEvent stream (file_read / file_edit / command / …) ┘
```

- `packages/core` — shared `DazeEvent` + domain types (the only vocabulary the UI knows).
- `apps/server` — Fastify + WebSocket. `PiAdapter` wraps the Pi SDK and maps
  `AgentSessionEvent` → `DazeEvent`; `MockAdapter` replays a scripted run with no
  credentials; `chokidar` also watches the project directory for out-of-band changes.
- `apps/web` — React + Vite + Tailwind + Zustand + Monaco + Framer Motion.

## Requirements

- Node.js **22.19+** (24 tested) and npm.
- Optional: a configured Pi (run `pi` once and log in) for the real agent. Without
  credentials DAZE automatically falls back to the mock runtime.

## Install

```bash
npm install
```

## Run

Development (server + web with hot reload):

```bash
npm run dev
# web:    http://localhost:5173
# server: http://localhost:8787
```

Production (single origin — server serves the built web app):

```bash
npm run build
npm start
# open http://localhost:8787
```

Then: enter a project path (or pick one from the list), choose a runtime, and hit
**Open**. Send the agent a task in the Chat panel and watch the Stage.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Server port |
| `HOST` | `127.0.0.1` | Server host |
| `DAZE_AGENT` | `pi` | Default runtime: `pi` or `mock` |
| `DAZE_PROJECTS_ROOT` | `~/projects` | Directory listed in the project picker |
| `DAZE_PI_TOOLS` | `read,bash,edit,write,grep,find,ls` | Pi built-in tools to enable |
| `DAZE_LOG_LEVEL` | `info` | Fastify log level |

## DazeEvent

The core UI understands exactly one structure:

```ts
type DazeEvent = {
  id: string;
  sessionId: string;
  timestamp: number;
  type:
    | "agent_start" | "agent_end" | "message" | "thinking"
    | "tool_start"  | "tool_update" | "tool_end"
    | "file_read"   | "file_write"  | "file_edit" | "file_change"
    | "command"     | "error";
  payload: unknown;
};
```

`file_change` is a small extension over the original spec, used to surface raw
filesystem-watcher activity. Context usage / status / model / plan / tree ride a
separate `session_state` websocket message so the event type stays clean.

## HTTP / WS API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects` | List projects under the root (`?root=` to override) |
| `POST` | `/api/sessions` | `{ projectPath, agent? }` → create a session |
| `GET` | `/api/sessions/:id` | Session snapshot |
| `GET` | `/api/sessions/:id/events` | Event history |
| `POST` | `/api/sessions/:id/prompt` | `{ prompt }` → send to the agent |
| `POST` | `/api/sessions/:id/abort` | Interrupt the run |
| `DELETE` | `/api/sessions/:id` | Dispose the session |
| `WS` | `/ws/sessions/:id` | `{type:"snapshot"}` then `{type:"event"}` / `{type:"session_state"}` |

## Local model (OpenAI-compatible server)

DAZE only talks to Pi, and Pi talks to any OpenAI-compatible endpoint — so a local
model works with no code changes. Example: Qwen3-4B served by the `server_qwen.py`
script in `E:\0down\ml\qwen3-4B` (supports streaming + tool calling).

1. Start the model server:

   ```bat
   E:\0down\ml\qwen3-4B\serve_qwen.bat --port 8000
   ```

2. Register it with Pi in `~/.pi/agent/models.json`:

   ```json
   {
     "providers": {
       "qwen-local": {
         "baseUrl": "http://127.0.0.1:8000/v1",
         "api": "openai-completions",
         "apiKey": "local",
         "models": [
           {
             "id": "qwen3-4b",
             "name": "Qwen3 4B (local)",
             "input": ["text"],
             "contextWindow": 40960,
             "maxTokens": 4096,
             "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
             "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens" }
           }
         ]
       }
     }
   }
   ```

3. (Optional) make it the default in `~/.pi/agent/settings.json`:

   ```json
   { "defaultProvider": "qwen-local", "defaultModel": "qwen3-4b" }
   ```

4. Verify with `pi --list-models`, then start DAZE and open a project.

`DAZE_PI_TOOLS` controls which Pi tools the agent gets. A small model may need a
reduced set, e.g. `DAZE_PI_TOOLS=read,bash,edit,write`.

## Notes

- Sessions are in-memory only (v0.1); refresh loses them.
- DAZE is an observer. It never modifies the project except through the agent.
- The avatar is a CSS/SVG placeholder driven by `agent.status`; swap it for
  sprites or Live2D later without touching the state machine.
- Pi has no dedicated delete tool — deleting a file must go through `bash rm`. When
  an agent instead writes empty content, the file is *truncated, not deleted*; DAZE
  labels such events **EMPTIED** (with a byte count) so a fake deletion is obvious.
