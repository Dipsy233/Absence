# Testing & checks

Absence has no unit-test framework; instead it ships a set of **acceptance check
scripts** (`scripts/checks/`), each a standalone harness that pins the rules
that are easy to get silently wrong. For architecture background, see
[ARCHITECTURE.md](ARCHITECTURE.md).

```bash
node scripts/make-demo.mjs [dir] [--force]   # scaffold a demo project (default: ./absence-demo)
npm run check:offline                        # run every offline check in one go
npm run verify                               # typecheck + web build + every offline check
npm run check:report                         # Absence Report engine (no server needed)
npm run check:eggs                           # process detection (no server, nothing spawned)
npm run check:classify                       # command intent + primary/tool split
npm run check:codex                          # Codex command parsing + approvals (pure)
npm run check:codexshell                     # undoing Codex's shell wrapper (pure)
npm run check:shellenv                       # Codex env_policy → command env (pure)
npm run check:execserver                     # Codex exec-server over a real WebSocket
npm run check:fsdiff                         # the file-diff engine (pure)
npm run check:process                        # every process harness together
                                             # (observer checks self-skip off-platform)
npm run check:history                        # needs the Absence server running
npm run check:metrics                        # SQLite metric storage and exit boundaries
npm run check:incremental                    # incremental folding and sliding-window state
npx tsx scripts/checks/check-outside-attr.ts # outside-change attribution
npx tsx scripts/checks/check-agentwatch.ts   # kernel process observer (Windows)
npx tsx scripts/checks/check-ebpf.ts         # kernel process observer (Linux)
npx tsx scripts/checks/check-docker.ts       # process boundary of docker commands (Windows + WSL docker)
npx tsx scripts/checks/check-docker-eggs.ts  # container eggs: attribution + stats metrics + resume
npx tsx scripts/checks/check-e2e.ts          # full pipeline: boots its own server + mock session, no model
node scripts/gen-whalebun-css.mjs            # regenerate the avatar's stylesheet
```

All offline checks share `scripts/checks/harness.ts` (`check()` / `finish()` /
`waitFor()`), and `npm run check:offline` runs them one by one — the list of
offline scripts is registered in exactly one place,
`scripts/checks/run-offline.ts`, so a new check script only needs to be written
and added to that array; neither `package.json` nor the CI workflow changes.
`npm run verify` adds the workspace typechecks and production web build before
the offline checks, making it the complete pre-commit gate.

The CI workflow (`.github/workflows/ci.yml`) runs the typecheck and
`npm run check:offline` (every offline harness, see `run-offline.ts`) on every
push and pull request, on Node 22 to match `engines.node`. `check:history` and
the two kernel-observer checks need a live server or kernel access, so they
stay manual.

`make-demo.mjs` writes a small project shaped so ordinary prompts exercise every
panel: reads with line ranges, a runnable `npm test`, a `TODO.md` for the agent to
read, and `notes.txt` for the delete-vs-truncate case. The mock runtime runs its
shell command for real, so a mock run also lays an egg — which is how the Agent
Eggs panel is exercised without Pi credentials.

`check-history.ts` runs **80 assertions** against a live mock session: run grouping,
per-run activity scoping, deterministic stage item ids, snapshot seek, the Stage
returning to its default page, search→terminal mapping, thinking capture (a
streamed thought stays one Stage item, so replay does not re-mount it), the two
independent FILE slots, read accumulation and gap markers, per-version recording,
and the created file count.

`check-metrics.ts` verifies metric chunk round-tripping, resampling at a
different step, session averages, and the rule that an exited egg does not
extend its lifetime or keep accumulating resources.

`check-incremental.ts` verifies that eggs, History, and Activity remain
consistent with a full rebuild while the event window slides, and pins
per-event work away from a window-sized product.

`check-outside-attr.ts` verifies that only write-semantic tools attribute
outside changes, path-shaped arguments do not treat file contents as paths, and
Windows path casing/separators resolve to the same file.

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
still-running egg (high) outranks an outside change (low).

`check-eggs.ts` is the pure harness for process detection (no server, nothing
spawned): the command window decides what is a candidate, the ancestor chain
decides what is ours, the marker Absence puts on its own shells decides what is
plumbing, an orphan is refused rather than guessed at, a subtree collapses to its
root with its descendants counted, and the eggs panel folds repeated pids into one
egg with `running` / `dead` / `all` filters.

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
rule that keeps `PATH` and `PATHEXT` present.

`check-execserver.ts` drives the real exec-server over a loopback WebSocket:
`initialize`, then `process/start`/`output`/`exited`/`closed`, a `tty: true`
command streaming on the `pty` stream and stopping on a written Ctrl+C, and
`process/signal interrupt` stopping a running command first-hand.

`check-fsdiff.ts` is the pure harness for the file-diff engine.
