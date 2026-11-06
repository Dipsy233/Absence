# Testing strategy

[English](testing-strategy.md) | [简体中文](testing-strategy.zh-CN.md)

[testing.md](testing.md) lists the checks and the commands that run them. This document describes the layering: what each layer establishes, what it does not, and why the checks are split by the environment they need.

## Approach

The repository has no unit-test framework and no coverage target. The check suite pins behaviours that have failed before, or that fail without producing a type error: which process a command laid, whether a container became an egg, whether a metrics series survives a restart, whether a tool-call payload is mapped without inventing fields. Rules inside a system boundary are kept pure and driven with fabricated data. Behaviour at the boundary runs against real processes, real files, real servers, real kernel helpers and docker.

Each check is a standalone script and a standalone process. It runs alone, prints its own result, and exits with its own status.

## Storage module layering

SQLite access is spread across four files in `apps/server/src/sessions/storage/`:

| File | Role |
|---|---|
| `db.ts` | Opens the connection (`node:sqlite` `DatabaseSync`), sets WAL and pragmas, defines the schema and migrations, and writes and reads session events. `openDatabase()` is exported here. |
| `files.ts` | `FileIndex` receives the open handle and prepares its own statements for the `file_versions` table. |
| `runs.ts` | `RunIndex` receives the open handle and prepares its own statements for the `runs` table and `store_meta`. |
| `metrics.ts` | Prepares metric chunk, host chunk and egg summary statements, and deletes; it calls `openDatabase()` directly. |

A storage change can therefore touch any of the four. `check-storage` exercises the archive seam as a whole: legacy import, event round-trip, buffered drain, archive listing and importer idempotence. The check is an in-process offline check with a private `ABSENCE_STATE_DIR`, not a per-file test.

## Layers

The 32 offline scripts fall into three layers, plus the ACP family. The 5 manual scripts form the last layer. Two offline scripts are registered in two groups, so the registry holds 34 offline registrations over 32 scripts.

| Layer | What it needs | Checks | What it establishes |
|---|---|---|---|
| 1. Pure | Fabricated process tables and event arrays; no process spawned, no file written | 14: `eggs`, `classify`, `outside-attr`, `report`, `chart-allrun`, `markdown`, `format`, `views`, `chimes`, `settings`, `capability-commands`, `mcp-events`, `incremental`, `metrics-ranges` | Attribution, classification, report reduction, view models and policy branches, driven by data alone |
| 2. Isolated I/O | A temporary directory and `ABSENCE_STATE_DIR`; production storage, watcher and diff modules imported in-process | 5: `storage`, `metrics`, `metrics-persist`, `fsdiff`, `outside-scope` | Archive and metrics round-trips against real SQLite files and real file watching, without touching the user archive |
| 3. Self-hosting | An ephemeral port and an isolated state directory; the check starts and kills the real server | 7: `history`, `lifecycle`, `metrics-restart`, `observed-lifetime`, `session-close`, `session-dwell`, `session-isolation` | Server lifecycle, session close, dwell accounting, history over HTTP, metrics after restart, isolation between sessions |
| ACP family | A scripted fixture agent and child processes in temporary directories; no server | 6: `acp`, `acp-lifecycle`, `acp-transport`, `acp-mapping`, `acp-proxy`, `agent-catalog` | The ACP contract: capabilities, transport, mapping, proxy, catalog discovery |
| 4. Manual | A kernel observer helper, a docker daemon, or a full server plus mock session | 5: `agentwatch`, `ebpf`, `docker`, `docker-eggs`, `e2e` | Kernel-level process capture, container eggs, and the full pipeline in one run |

14 + 5 + 7 + 6 = 32 offline scripts. With the 5 manual scripts, the registry covers 37 distinct scripts and 39 registrations.

Layer 1 pushes the system call to the boundary so the middle of the code becomes a pure function. `check-eggs` feeds a fabricated process table into the real attribution code:

```ts
check("a process that appeared since the last look is a candidate", candidates.includes(1002));
check("the shell Absence drove is not an egg",                     !claimed.includes(1001));
```

`candidatePids`, `attributeProcesses` and `buildEggs` take data, so the command window, the ancestor chain and the rule that an orphan is not guessed are verified without spawning anything.

Layer 2 depends on import order. The state directory has to be redirected before the storage module is loaded, which is why these checks use a dynamic import:

```ts
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "absence-metrics-"));
process.env.ABSENCE_STATE_DIR = stateDir;          // before the module is loaded
const { appendMetricsFrame } = await import("../../apps/server/src/sessions/storage/metrics");
```

A static import would open the module against the user archive.

Layer 3 checks act as clients of a server they started themselves. They need nothing pre-existing: the port is ephemeral, the state directory is private, and the server is killed in cleanup. CI does not install a kernel observer binary; the `ci.yml` comment states that the watcher falls back to process-table sampling, so these checks assert the session, archive and metrics behaviour that does not depend on the kernel helper.

The ACP family drives a fixture agent; product-agent behaviour is outside its scope. It establishes how Absence handles the protocol, not how Pi, Codex, Claude Code, Qwen Code, Gemini or DSH behave. The mock-agent runner adds end-to-end coverage on top of the same protocol: a real server launches the mock agent as a child process, and the resulting events are read over the WebSocket and from SQLite. That simulation is a separate gate (`check:mock-agent`, alias `absence-sim`) and is not in `check:offline`.

## What the layers do not cover

- **Kernel and docker paths.** `check-agentwatch` exits 0 with an explanation outside Windows, and `check-ebpf` does the same outside Linux. A pass on another platform does not exercise the job-object or eBPF path. Docker container eggs are verified only with a reachable daemon.
- **Product agent behaviour.** The ACP checks and the simulation use a scripted fixture agent. They do not verify a vendor agent's own tool payloads or sandboxing.
- **UI rendering.** The repository has no browser test runner. UI behaviour is covered at the view-model level by `check-views`; CSS, layout and the desktop shell are not covered by checks.

## Failure readability

`scripts/checks/harness.ts` is 51 lines with four exports: `check`, `finish`, `section`, `waitFor`.

1. The label states the product rule in plain words, for example `"the shell Absence drove is not an egg"`.
2. `detail` carries the actual value, so a failing line shows what was observed.
3. The block comment names the regression the check pins.

`finish()` exits non-zero when any check failed and also when no check ran, so a script that asserts nothing cannot pass. Because each script is its own process, the runner consumes its exit status directly. Output formats and runner messages are listed in [testing.md](testing.md#failure-signals).

## Numbers

| Item | Value | Source |
|---|---|---|
| Registered entries | 39 | `scripts/checks/groups.ts` |
| Distinct registered scripts | 37 | `scripts/checks/groups.ts` |
| Offline registrations | 34 | `checks` entries in `groups.ts` |
| Distinct offline scripts | 32 | `checks` entries in `groups.ts` |
| Manual checks | 5 | `platform` entries in `groups.ts` |
| Groups | 12 | `GROUPS` in `groups.ts` |
| Mock-agent scenarios | 14 | `scripts/mock-agent/scenarios/` |
| Harness | 51 lines, 4 exports | `scripts/checks/harness.ts` |
| CI | typecheck + `check:offline` | `.github/workflows/ci.yml` |
| Pre-commit gate | `npm run verify` | root `package.json` |

## Pointers

- [testing.md](testing.md): every registered check and how to run it.
- [architecture.md](architecture.md): the event pipeline these checks exercise.
