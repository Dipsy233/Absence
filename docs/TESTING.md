# Testing & checks

DAZE has no unit-test framework; instead it ships a set of **acceptance check
scripts** (`scripts/checks/`), each a standalone harness that pins the rules
that are easy to get silently wrong. For architecture background, see
[ARCHITECTURE.md](ARCHITECTURE.md).

```bash
node scripts/make-demo.mjs [dir] [--force]   # scaffold a demo project
npm run check:report                         # Daze Report engine (no server needed)
npm run check:eggs                           # process detection (no server, nothing spawned)
npm run check:classify                       # command intent + primary/tool split
npm run check:process                        # the three process harnesses together
npm run check:history                        # needs the DAZE server running
npx tsx scripts/checks/check-agentwatch.ts   # kernel process observer (Windows)
npx tsx scripts/checks/check-ebpf.ts         # kernel process observer (Linux)
node scripts/gen-heti-css.mjs                # regenerate the avatar's stylesheet
```

The CI workflow (`.github/workflows/ci.yml`) runs the typecheck and the offline
harnesses (eggs, classify, report) on every push and pull request.
`check:history` and the two kernel-observer checks need a live server or kernel
access, so they stay manual.

`make-demo.mjs` writes a small project shaped so ordinary prompts exercise every
panel: reads with line ranges, a runnable `npm test`, a `TODO.md` for the agent to
read, and `notes.txt` for the delete-vs-truncate case. The mock runtime runs its
shell command for real, so a mock run also lays an egg — which is how the Agent
Eggs panel is exercised without Pi credentials.

`check-history.ts` runs **58 checks** against a live mock session: run grouping,
per-run activity scoping, deterministic stage item ids, snapshot seek, the Stage
returning to its default page, search→terminal mapping, thinking capture (a
streamed thought stays one Stage item, so replay does not re-mount it), the two
independent FILE slots, read accumulation and gap markers, per-version recording,
and the created file count.

`check-report.ts` is a pure harness (no server) for the Daze Report engine: a
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
decides what is ours, the marker Daze puts on its own shells decides what is
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
the command that laid them, and that Daze's own marked shell is never an egg.

`check-ebpf.ts` does the same for the Linux observer: it starts
`agentwatch-linux`, drives the real `ProcessWatcher`, and asserts that
short-lived children are all caught with their command line and attributed to
the command that laid them.
