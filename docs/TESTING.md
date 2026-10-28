# Testing & checks

Absence has no unit-test framework; instead it ships a set of **acceptance check
scripts** (`scripts/checks/`), each a standalone harness that pins the rules
that are easy to get silently wrong. For architecture background, see
[ARCHITECTURE.md](ARCHITECTURE.md); for why it is built this way, see
[TESTING-STRATEGY.md](TESTING-STRATEGY.md).

Why not vitest/jest: what is hard in Absence is not a pure function but
**observing a real operating system** — which process a command laid, whether a
container became an egg, whether a curve survives a restart. Those cannot be
faked without deleting the thing worth testing. So the checks are layered by
what environment they need, and the top two layers are run manually.

```
tier 4  full pipeline   check-e2e — boots its own server + mock session
tier 3  real I/O        real WebSocket / SQLite / kernel observer / docker
tier 2  isolated I/O    a throwaway temp dir, never the user's archive
tier 1  pure            fake process tables and event arrays, nothing spawned
```

Only **tier 1 and tier 2** run in CI (`npm run check:offline`). Tiers 3 and 4
need a live server, kernel access, elevated rights or docker, so they stay
manual and are listed below as *live*.

## The gate

```bash
node scripts/make-demo.mjs [dir] [--force]   # scaffold a demo project (default: ./absence-demo)
npm run check:offline                        # every offline check in one go (what CI runs)
npm run verify                               # typecheck + web build + every offline check
```

`npm run verify` is the complete pre-commit gate. A single check is always one
command:

```bash
npx tsx scripts/checks/check-<name>.ts
```

### Tier 1 — pure (no server, no spawning, no credentials)

```bash
npm run check:eggs             # process detection: command window, ancestry, marker, orphans
npm run check:classify         # command intent + primary/tool split
npm run check:report           # Absence Report engine + the loop/attention rules
npm run check:markdown         # the chat's Markdown reader
npm run check:fsdiff           # the file-diff engine
npm run check:codex            # Codex command parsing + approval decisions
npm run check:codexshell       # undoing Codex's shell wrapper
npm run check:shellenv         # Codex env_policy → the command's environment
npm run check:chimes           # when an attention change is audible
npm run check:settings         # the settings store's load/normalise rules
npm run check:observer         # the decoupling contract (observe vs drive)
npm run check:capabilities     # skills + MCP discovery, and Pi's own loader
npm run check:capability-commands  # the /skill and /mcp chat commands
npm run check:mcp              # an MCP call reaches Activity and the Stage
```

### Tier 2 — isolated I/O (SQLite / fs in a throwaway directory)

```bash
npm run check:storage          # SQLite session store: import, round-trip, filters
npm run check:metrics          # metric chunks, resampling, the exited-egg rule
npm run check:metrics-persist  # eggs + the host series come back from SQLite
npm run check:metrics-ranges   # each dashboard range is its own window
npm run check:incremental      # incremental folding == a full rebuild
npm run check:execserver       # Codex exec-server over a real loopback WebSocket
npx tsx scripts/checks/check-outside-attr.ts  # outside-change attribution
```

### Tier 3 — live (needs a running server, kernel access, or docker)

```bash
npx tsx scripts/checks/check-history.ts        # the web client against a live mock session
npx tsx scripts/checks/check-lifecycle.ts      # `absence serve` orphan/port lifecycle
npx tsx scripts/checks/check-agentwatch.ts     # kernel process observer (Windows)
npx tsx scripts/checks/check-ebpf.ts           # kernel process observer (Linux)
npx tsx scripts/checks/check-docker.ts         # process boundary of docker commands
npx tsx scripts/checks/check-docker-eggs.ts    # container eggs: attribution + stats + resume
npx tsx scripts/checks/check-metrics-restart.ts    # the curve survives a server restart
npx tsx scripts/checks/check-session-close.ts      # "change project" leaves the session
npx tsx scripts/checks/check-session-dwell.ts      # duration is dwell time
npx tsx scripts/checks/check-observed-lifetime.ts  # "observed for" is the process's lifetime
```

### Tier 4 — full pipeline

```bash
npm run check:e2e              # boots its own server + mock session, no model
```

Other:

```bash
npm run check:process          # every process harness together (observer checks self-skip off-platform)
npm run bench:incremental      # a timing report (not an assertion), prints the speedup
node scripts/gen-whalebun-css.mjs            # regenerate the avatar's stylesheet
```

## How a check is written

All tier-1 and tier-2 checks share `scripts/checks/harness.ts`:

```ts
check(label, condition, detail?)   // prints "ok" or "FAIL <label> — <detail>", counts
section(title)                     // a readable header between groups
waitFor(predicate, timeoutMs?)     // poll with a deadline, for async checks
finish(name?)                      // prints "N/M passed", exits non-zero on failure
```

Three habits make a failure readable:

- **The label is the product rule, in plain words** — `"the shell Absence drove
  is not an egg"`, not `assertEquals(claimed.length, 2)`. A red line names the
  rule that broke.
- **`detail` carries the actual value** — `\`got ${primary.length}\`` — so a
  failure shows what happened, not only that something did.
- **The comment above a block says which bug it pins.** Most checks were a real
  regression once; `check-chimes.ts` puts it plainly: *"every branch below was a
  bug once — a step into low rang when it should have been silent"*.

A check that needs the real database sets its own state dir **before** importing
the module, which is why it uses a dynamic `import()`:

```ts
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "absence-metrics-"));
process.env.ABSENCE_STATE_DIR = stateDir;      // must precede the import
const { appendMetricsFrame } = await import(".../storage/metrics");
```

Two checks predate the harness and print their own `PASS`/`FAIL` (`assert()`):
`check-history.ts` and (with `node:assert/strict`) `check-metrics*.ts`,
`check-storage.ts`, `check-metrics-restart.ts`. They exit non-zero the same way.
### Adding a check

Write `scripts/checks/check-<name>.ts` using the harness, add it to the
`OFFLINE` array in `scripts/checks/run-offline.ts`, and add an `npm run` alias
if it is worth typing. Neither `package.json`'s aliases nor the CI workflow need
to change for CI to pick it up — the list lives in exactly one place.

The CI workflow (`.github/workflows/ci.yml`) runs the workspace typechecks and
`npm run check:offline` on every push and pull request, on Node 22 to match
`engines.node`.

## What each check pins down

`make-demo.mjs` writes a small project shaped so ordinary prompts exercise every
panel: reads with line ranges, a runnable `npm test`, a `TODO.md` for the agent to
read, and `notes.txt` for the delete-vs-truncate case. The mock runtime runs its
shell command for real, so a mock run also lays an egg — which is how the Agent
Eggs panel is exercised without Pi credentials.

### Pipeline & session (live)

`check-e2e.ts` is the fast answer to *"did the whole pipeline survive my
change"*: one command, ~30 s, no model. It boots a real server on an ephemeral
port with an isolated state dir, opens a **mock** session, and drives it with a
scripted prompt (`$ `-prefixed lines — `MockAdapter` runs each through the same
`AbsenceShell` a real agent uses). It then asserts the whole chain: command
events → process eggs (Job Object) → container eggs (docker events, when docker
is reachable) → metrics frames → SQLite persistence. Without docker it falls
back to a plain `node` process egg and says so in its output.

`check-history.ts` runs **75 assertions** against a live mock session: the
paginated events API and its cursor, the run index, run grouping, per-run
activity scoping, deterministic stage item ids (a random id used to freeze the
replay Stage), snapshot seek, the Stage returning to its default page,
search→terminal mapping, thinking capture (a streamed thought stays one Stage
item, so replay does not re-mount it), the two independent FILE slots, read
accumulation and gap markers, per-version recording, and the created file count.

`check-lifecycle.ts` pins a real incident: a dev server orphaned when its parent
npm died kept running wedged — listening, 0% CPU, answering no request — and
held port 8848 until it was killed by hand. The server must notice that nobody
is above it and leave: stdin EOF exits it (the cheapest "parent is gone"
signal), a dead parent pid is caught by the liveness watchdog (speeded up here
through `ABSENCE_ORPHAN_TICK_MS`), and a second server on an occupied port fails
with instructions instead of a bare `EADDRINUSE` stack.

`check-execserver.ts` drives the real Codex exec-server over a loopback
WebSocket: `initialize`, then `process/start`/`output`/`exited`/`closed`, a
`tty: true` command streaming on the `pty` stream and stopping on a written
Ctrl+C, and `process/signal interrupt` stopping a running command first-hand.

### Metrics & sessions

`check-metrics.ts` verifies metric chunk round-tripping, resampling at a
different step, session averages, and the rule that an exited egg does not
extend its lifetime or keep accumulating resources.

`check-metrics-persist.ts` verifies the dashboard's history path: eggs and the
machine's own counters (the dashed host line) come back from SQLite, and a
window with no samples returns no points, read through the same call the UI
makes. No server is started — it appends, flushes, and reads back in one
process, which is why it is an offline check while the restart case below is not.

`check-metrics-restart.ts` (live, ~90 s) boots a real server, runs a workload,
**restarts the server**, and reads the same session back — the curve and the
host line must still be there. This is the case `check-metrics-persist.ts`
cannot reach.

`check-metrics-ranges.ts` imports the dashboard's own `RANGES` / `rangeStart`
(rather than copying them) and pins that 30m, 1h and `all` are their own
windows on a *young* session — the case where all three used to collapse onto
1m's few seconds — while the window stays stable inside a step and moves when
the step turns over.

`check-session-close.ts` (live, ~45 s) pins "change project" as *leaving* the
session: after `POST /api/sessions/:id/close` the sample count stops growing
(an in-flight sample is dropped, not written), the recorded samples survive, and
reopening the session restores them.

`check-session-dwell.ts` (live, ~25 s) pins session duration as *dwell* time:
open → watch → leave → come back continues the clock, the gap while closed is
not counted, and the original creation time survives.

`check-observed-lifetime.ts` (live, ~40 s) pins "observed for" as the process's
own lifetime: an egg's clock starts at its `startedAt`, stops at `exitedAt`, and
the recorded lifetime does not keep growing after the process ends.

`check-incremental.ts` verifies that eggs, History, and Activity remain
consistent with a full rebuild while the event window slides, and pins
per-event work away from a window-sized product. `check-incremental-bench.ts`
is its timing counterpart: it prints old vs. new ms/event and the speedup, and
asserts nothing — it exists to make a regression visible, not to gate a commit.

`check-storage.ts` pins the SQLite seam the rest of the server relies on: the
legacy JSONL archive imports once and streaming prefixes are dropped,
`readEvents` rebuilds the full `AbsenceEvent` envelope rather than the payload
alone, new writes round-trip and a batch flushes on drain, `listArchives` filters
by project path, and re-running the importer does not duplicate events.

### Processes & containers

`check-eggs.ts` is the pure harness for process detection (no server, nothing
spawned): the command window decides what is a candidate, the ancestor chain
decides what is ours, the marker Absence puts on its own shells decides what is
plumbing, an orphan is refused rather than guessed at, a subtree collapses to its
root with its descendants counted, and the eggs panel folds repeated pids into one
egg with `running` / `dead` / `all` filters. The trick is that it feeds a
**fabricated process table** into the real `candidatePids` / `attributeProcesses`
/ `buildEggs`, so the risky attribution logic is testable in milliseconds.

`check-classify.ts` is the pure harness for the primary/tool split: the command's
subjects are read from its text (`./daemon.sh`, `python train.py`, `powershell
-File run.ps1`) while an inline interpreter stays a tool, a query tool with a
redirect is not a subject, and classification is structural — a `cat` that
outlived its command is primary, a short git-bash helper is a tool, a process
inside the workspace is primary, and an ephemeral process from an unknown
directory (`fd.exe` in Pi's own bin) is a tool.

`check-agentwatch.ts` exercises the Windows observer for real: it starts the
helper against the test process, drives the real `ProcessWatcher`, and asserts
that short-lived children are all caught, carry a command line, are attributed to
the command that laid them, and that Absence's own marked shell is never an egg.

`check-ebpf.ts` does the same for the Linux observer: it starts
`agentwatch-linux`, drives the real `ProcessWatcher`, and asserts that
short-lived children are all caught with their command line and attributed to
the command that laid them — and that an unmarked process is still captured
while a session id is set (the Linux attribution rule).

`check-docker.ts` pins the process boundary of docker commands (Windows + WSL
docker): what the Job Object / eBPF observer sees around `docker run`, so the
client and the container are not confused with each other.

`check-docker-eggs.ts` pins container eggs end to end: a container start event is
credited to the command whose own words predicted it (`--name`, image, compose
project label), a foreign container landing in the same window is not,
stats become the container's metrics, and a resumed session re-attaches to the
containers it laid while exited ones are corrected from the daemon's own state.

### Report, rules & chat surface

`check-report.ts` is a pure harness (no server) for the Absence Report engine: a
failed tool with no `command` event still counts as a failed command, recovery
consumes a failure only after intervening activity, agent writes are never
double-counted as observed changes, `created` is relative to earlier runs,
phases resolve to `verifying` after a recovery, and the Timeline lists one node
per activity in event order with its effect (a streamed thought stays one node,
an unfinished shell tool reads as a running process, and an egg laid during the
run becomes a `LAID` node — with a still-running egg raising attention to
high). It also pins the loop rules: a write that restores the read state is a
`file_version_loop` at medium attention, a gapped read state is never a loop
baseline, a twice-failed command is a `command_retry_loop` that names the
command, one failure is not a loop, a change outside the project is an
`outside_change` fact at low attention marked `OUTSIDE` on the Timeline, and a
still-running egg (high) outranks an outside change (low). A settled run with a
`FindingRecord` replays the record instead of re-judging, and the record's
hash chain verifies while a doctored one breaks.

`check-outside-attr.ts` verifies that only write-semantic tools attribute
outside changes, path-shaped arguments do not treat file contents as paths, and
Windows path casing/separators resolve to the same file.

`check-chimes.ts` pins `attentionChimeFor` — the whole policy for when an
attention change is audible — without an `AudioContext`. Every branch was a bug
once: a step into `low` rang when it should have been silent, or a release out
of `high` went quiet with it.

`check-settings.ts` pins that a stale or partial `localStorage` entry loads into
a complete, sane Settings: defaults fill in, unknown values are normalised, and
the rail orders and chat toggles stay well-formed. It stubs a minimal
`localStorage` so the store module's import-time read works outside a browser.

`check-markdown.ts` is the pure harness for the Chat panel's Markdown reader: the
block and inline constructs agents actually emit (headings, nested lists, task
lists, tables, fenced code) parse, while a half-written construct — an
unterminated fence, `**`, `[` — degrades to text instead of swallowing the rest
of a streaming reply. It also pins what must *not* become markup: arithmetic
(`2 * 3 * 4`), `snake_case`, raw HTML, and `javascript:` links all stay literal,
which is what makes rendering the tree safe without an HTML sanitizer.

### Runtimes: Codex, capabilities, decoupling

`check-codex.ts` is the pure harness for the Codex command layer: reading a
read/search/list out of Codex's own `commandActions` (with a text fallback), and
the approval decisions and options derived from Codex's `availableDecisions`.

`check-codexshell.ts` pins undoing Codex's shell wrapper: `pwsh -Command "…"`
(with the UTF-8 preamble), `bash -lc "…"`, `cmd /c …`, multi-flag forms and a
quoted exe path all reduce to the model's command; a non-shell invocation is
left alone.

`check-shellenv.ts` pins the environment build: Codex's `env_policy`
(inherit / default excludes / custom excludes / set / include-only) is applied
to the executor's own environment, then the request's sparse `env` wins — the
rule that keeps `PATH` and `PATHEXT` present, so `node ticker.mjs` resolves
`node` as it does natively.

`check-capabilities.ts` builds a throwaway HOME with a `skills/` directory and an
`mcpServers` config, then reads them back through the real discovery code and
through Pi's own loader: every skills location is searched and ancestors stop at
the repo root, a skill without a description is reported rather than silently
dropped, `mcp.json` project entries override user entries by name, Codex's
`[mcp_servers.*]` TOML is read into the same shape, Pi's `DefaultResourceLoader`
receives the discovered skills with the MCP extension in the factory list, the
Pi tool allowlist cannot silently disable direct MCP tools, MCP can be switched
off, and the writable half used by the runtimes' own config tools round-trips.

`check-capability-commands.ts` pins the `/skill` and `/mcp` chat commands: the
command registry, skill invocation routing, `/mcp` list and reconnect wording
against a fabricated capability list, and the `pi mcp add` guidance in the
empty state. No server is dialled — the surface is session-scoped on purpose,
matching Pi's own `/mcp`, because adding or removing a server edits the shared
`mcp.json` and stays outside the session.

`check-mcp-events.ts` pins MCP call visibility: an MCP call must reach Activity
and the Stage as a first-class action, not vanish as an anonymous tool event. It
feeds the shapes the adapters actually emit (Pi's `mcp__<server>__<tool>`, Codex's
`mcpToolCall`) through `eventToActivityRow` / `eventToStageItem` / `statusForTool`
and checks the row, the terminal card, the status, and the replay path — without
a live MCP server.

`check-observer.ts` is the offline half of the decoupling contract in
[decoupling.md](decoupling.md), whose standard is: *delete
`apps/server/src/agents/` entirely — does `absence watch` still work?* It pins
that a session declaring itself `observe` cannot be driven (while an older server
omitting `source` is treated as driven, never a regression in the field), that
nothing is registered until the shipped adapters are imported, that the CLI's
watch parser is standalone (`--pid`, `--project`, `--label`, pass-through `--
command`), that an observed session's rows come from the OS rather than a
runtime, that only the observed tree is reported, that an observed stream still
forms runs, that the terminal mirror is bounded/coalesced/replayable, that
commands are read off the command line, that exit codes survive the observer,
and that Pi and Codex transcript tool calls pair and classify the same way.

### File diff

`check-fsdiff.ts` is the pure harness for the file-diff engine.
