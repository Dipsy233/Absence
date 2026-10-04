# DAZE / 发呆症

> AI moves fast. Humans watch.

DAZE is a real-time visualization observer for AI agents. It does not try to make
an agent smarter — it lets a human *see* what the agent is doing.

```
Pi runs the agent.
Daze observes the events.
The Stage turns events into something humans can watch.
```

## The idea

An agent finishes in seconds, so a human watching the output either can't follow
it or can't remember it. DAZE answers that with four steps:

```
Overview  →  Inspect  →  Stage  →  Replay
```

Panels are entry points, never the final content — the Stage is where content
lives. And **live never slows the agent down**: the run plays at real speed, and
slowing down is what Replay is for.

## Two perspectives

The whole UI is split by *whose view* you are looking at:

|  | **Left** — the user's view | **Right** — the agent's view |
|---|---|---|
| Files | the whole project tree | only files the agent has in context |
| Opening a file | the **whole file**, read from disk | **only what the agent read/edited** |
| The FILE button | the `userFile` slot | the `agentFile` slot |

The two slots are independent. If the agent read lines 10–20 of a file, the
Agent Folder lists it and its FILE button shows just those lines — and after two
reads of 1–2 and 3–5 it shows 1–5, never a gap silently bridged (unread lines in
between become explicit `⋯ (line 6 — not in the agent's context)` markers so the
numbering still matches the real file).

The left tree can do this because a *user* is allowed to read their own project;
the right side never pretends to know more than the agent does.

### File versions

Each file the agent touches records **one version per state**, oldest first:

```
v0  read   lines 1–5        ← the union of everything it has read so far
v1  write  whole file
v2  edit   whole file
```

Versions are *recorded*, not derived. The text is captured at the moment the
agent saw it — the `read` slice comes from the tool result the model actually
received, a `write` from the argument it sent, an `edit` from applying its own
edits to the file it held. Later changes on disk (by the agent or anything else)
can never rewrite an earlier version, because nothing points back at the source
file.

That matters because an LLM's context really does keep the earlier versions, and
it makes the Agent Folder useful for looking back: expand a file and click any
version to put that exact state on the Stage. A read after a write does not roll
the file back, and v0 (partial, from reads) is never diffed against full-file
versions in Files → History.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│                         SESSION BAR                          │
├──────────────┬───────────────────────────────┬───────────────┤
│    FILES     │  [FILE DIFF REPLAY]  TABLE    │     AGENT     │
│  (user view) │        [TERMINAL FILE LIVE]   │    (avatar)   │
│              │                               │               │
├──────────────┤───────────────────────────────├───────────────┤
│   HISTORY    │                               │ AGENT FOLDER  │
│   (runs)     │            STAGE              │ (agent view)  │
├──────────────┤                               ├───────────────┤
│   ACTIVITY   │                               │               │
│  (selected   │  replay controls, only while  │     CHAT      │
│     run)     │  replaying                    │               │
└──────────────┴───────────────────────────────┴───────────────┘
```

- **Session bar** — session id, project, model, context usage, live/offline, and
  a *change* button to pick another project.
- **Files** (left) — tree → detail → history. The tree marks files the agent has
  touched (`●`) and highlights the file currently on the Stage. Right-click for
  *Inspect / Open in Stage / View History / View Diff / Add to Chat / Explain this*.
- **History** (left) — one row per **run**: prompt to completion or interruption,
  oldest first with the newest at the bottom. Shows time, status
  (`running`/`done`/`stopped`/`error`), duration, the prompt, and action counts
  `R` read · `S` search · `E` edit · `C` created · `$` command. Selecting a run
  filters the Activity panel; the **⟲** button rolls the view back to the state
  at the end of that run (see Replay — DAZE never writes to the project, so this
  is a view-only revert).
- **Activity** (left) — the selected run's actions, oldest first. Click a row to
  put it on the Stage; its header has a **▶ replay** button that replays that run.
- **Stage** (center) — file, diff, terminal, desk or replay. The mode switcher
  has three groups: the user's (FILE / DIFF / REPLAY), **TABLE** in the middle
  for the default desk page, and the agent's (TERMINAL / FILE / LIVE).
- **Agent** (right) — the avatar, driven purely by the event stream.
- **Agent Folder** (right) — the agent's view of the project: the files in its
  context, newest first, each expandable into the versions it has held. Click a
  file for its newest content, or a version for that exact state.
- **Chat** (right) — talk to the agent, with explicit attached context.

## Agent status

Derived entirely from events, so it reflects reality rather than a guess:

```
listening → (thinking | speaking | reading | searching | editing | running | waiting) → listening
```

- `listening` — nothing has happened yet, or the last run finished
- `speaking` — the agent is writing text back to you
- `reading` / `searching` / `editing` / `running` — held while the Stage shows
  that action, and exited as soon as the agent starts emitting text
- `error` — shown as *confused*

When a run ends, the Stage returns to its default desk page.

## History & Replay

A **run** is one prompt through to `agent_end`. Runs are the unit of both History
and Replay.

Replay is reconstructed, not recorded: **events + state snapshots**, never video.

- the replay buffer is the selected run
- snapshots every 25 events or 5 seconds; each carries the file contents, the
  agent status **and what the Stage was showing**, so a seek always lands on a
  correct frame instead of an empty one
- seek takes the nearest snapshot and applies the remaining events
- controls (play / pause / step / seek / 0.25×–10×) live inside the Stage, below
  the animated area so dragging the scrubber is never interrupted

Opening a run two ways:

- **▶ replay** in the Activity header — replay it from the beginning
- **⟲** in the History row — roll back to the state at the **end** of the run

Both are view-only. DAZE is an observer, so "rollback" means restoring what you
are looking at, never rewriting the project.

## Architecture

```
Browser ──WebSocket──▶ Daze Server ──EventBus──▶ AgentAdapter ──▶ Pi (SDK, in-process)
   ▲                                                                     │
   └────────────── DazeEvent stream (file_read / file_edit / command / …) ┘
```

- `packages/core` — the shared `DazeEvent` + domain types. The only vocabulary
  the UI knows; it never learns that Pi exists.
- `apps/server` — Fastify + WebSocket. `PiAdapter` wraps the Pi SDK and maps
  `AgentSessionEvent` → `DazeEvent`; `MockAdapter` replays a scripted run with no
  credentials; `chokidar` watches the project for out-of-band changes.
- `apps/web` — React + Vite + Tailwind + Zustand + Monaco + Framer Motion.

```
packages/core/src      events.ts  types.ts
apps/server/src        agents/ (AgentAdapter, PiAdapter, MockAdapter)
                       api/  events/  filesystem/  sessions/  websocket/  util/
apps/web/src           app/  components/{layout,files,history,activity,stage,agent,chat,common}
                       stores/ (session, file, stage, replay, chat, ui)
                       hooks/  lib/  types/
scripts/               make-demo.mjs  check-history.ts
```

## Requirements

- Node.js **22.19+** (24 tested) and npm.
- Optional: a configured Pi (run `pi` once and log in) for the real agent. Without
  credentials DAZE falls back to the mock runtime and says so (`degraded · mock`).

## Install & run

```bash
npm install

npm run dev     # dev: web on :5173 (proxies /api and /ws), server on :8787
npm run build   # build the web app
npm start       # single origin — server serves the built app on :8787
```

Then enter a project path (or pick one), choose a runtime, hit **Open**, and send
the agent a task in Chat.

### One-click launcher (Windows)

Double-click **`start-daze.bat`** to start the local model server, start the DAZE
server, and open the UI.

```bat
start-daze.bat            :: start everything
start-daze.bat rebuild    :: force a web rebuild first
start-daze.bat check      :: dry run — report what is up, start nothing
```

Idempotent: anything already listening is left alone, and if the local model
cannot be started it falls back to the mock runtime. Override with
`DAZE_MODEL_DIR`, `DAZE_MODEL_PORT`, `DAZE_PORT`, `DAZE_AGENT`. Close the two
spawned windows to stop everything.

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
    | "agent_start" | "agent_end" | "message"   | "thinking"
    | "tool_start"  | "tool_update" | "tool_end"
    | "file_read"   | "file_write"  | "file_edit" | "file_change"
    | "command"     | "search"      | "error";
  payload: unknown;
};
```

Two extensions over the original v0.1 spec:

- **`search`** — Pi's `grep` / `find` / `ls`, so searching is visible. It renders
  through the terminal view (one output surface for "the agent ran something").
- **`file_change`** — raw filesystem-watcher activity, for edits that happen
  outside the agent's own tools (bash, sed, …).

Context usage, status, model, plan and the file tree ride a separate
`session_state` websocket message, so the event union stays clean.

## HTTP / WS API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects` | List projects under the root (`?root=` to override) |
| `POST` | `/api/sessions` | `{ projectPath, agent? }` → create a session |
| `GET` | `/api/sessions/:id` | Session snapshot (session, files, chat, events, tree, plan) |
| `GET` | `/api/sessions/:id/events` | Event history |
| `GET` | `/api/sessions/:id/file?path=` | Read a project file (the user view) |
| `POST` | `/api/sessions/:id/prompt` | `{ prompt }` → send to the agent |
| `POST` | `/api/sessions/:id/abort` | Interrupt the run |
| `DELETE` | `/api/sessions/:id` | Dispose the session |
| `WS` | `/ws/sessions/:id` | `{type:"snapshot"}` then `{type:"event"}` / `{type:"session_state"}` |

The file endpoint refuses paths outside the project, refuses non-files, caps size
at 512 KB and rejects binaries.

## Local model

DAZE only talks to Pi, and Pi talks to any OpenAI-compatible endpoint — so a local
model works with no code changes. Example: Qwen3-4B served by `server_qwen.py` in
`E:\0down\ml\qwen3-4B` (streaming + tool calling).

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

4. Verify with `pi --list-models`, then start DAZE.

A 4B model is not reliable at choosing tools. `DAZE_PI_TOOLS` narrows the set
(e.g. `DAZE_PI_TOOLS=read,bash,edit,write`), and the mock runtime is better for
exercising the UI.

## Testing

```bash
node scripts/make-demo.mjs [dir] [--force]   # scaffold a demo project
npx tsx scripts/check-history.ts             # needs the server running
```

`make-demo.mjs` writes a small project shaped so ordinary prompts exercise every
panel: reads with line ranges, a runnable `npm test`, a `TODO.md` checklist (the
plan shows on the desk), and `notes.txt` for the delete-vs-truncate case.

`check-history.ts` runs **52 checks** against a live mock session: run grouping,
per-run activity scoping, deterministic stage item ids, snapshot seek, the Stage
returning to its default page, search→terminal mapping, the two independent FILE
slots, read accumulation and gap markers, per-version recording, and the created
file count.

## Notes & limitations

- Sessions are **in-memory only**; refreshing or restarting loses them.
- DAZE is an **observer**. It never drives the agent; the only thing it reads
  outside the event stream is a project file you explicitly asked to open.
- Pi has **no delete tool** — deleting must go through `bash rm`. When an agent
  instead writes empty content the file is *truncated, not deleted*, and DAZE
  labels it **EMPTIED** with a byte count so a fake deletion is obvious.
- The Plan panel is gone; the plan now shows as a paper on the desk in the Stage.
- The avatar is a CSS/SVG placeholder driven by status; Live2D is a v0.3 item and
  the `AgentVisualState` seam is already there.
- The 2D desk is a placeholder; `DeskState` / `DeskItem` exist but the visuals
  are v0.3.
