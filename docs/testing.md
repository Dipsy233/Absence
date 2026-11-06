# Testing and acceptance checks

[English](testing.md) | [简体中文](testing.zh-CN.md)

Absence has no unit-test framework. Acceptance behaviour is verified by standalone scripts run with `tsx`. The checks target process attribution, event projection, archive round-trips, metrics persistence and ACP transport: failures in these areas do not surface as type errors. [testing-strategy.md](testing-strategy.md) describes the layering and the reasons behind it; this document lists what runs, how it runs, and what a failure reports.

## Gates

```bash
npm run typecheck       # tsc across packages/core, apps/server, apps/web
npm run build           # production web build in dist/web
npm run check:offline   # all 34 offline check registrations
npm run check:acp-all   # 6 registered agent-layer checks, then the mock-agent simulation
npm run absence-sim     # end-to-end simulation (same runner as check:mock-agent)
npm run verify          # typecheck + build + check:offline
```

`npm run verify` is the pre-commit gate. CI (`.github/workflows/ci.yml`) runs `npm run typecheck --workspaces --if-present` and `npm run check:offline` on Node 22.23.4. `check:acp-all` and `absence-sim` are additional gates for changes to the agent layer; the simulation is not part of `check:offline`.

## Registration

`scripts/checks/groups.ts` is the single registration point. It defines 12 groups, 34 offline check registrations and 5 manual platform registrations. The registrations cover 37 distinct scripts: 32 offline and 5 manual, with two scripts registered in both the `eggs` and `session` groups. `run-offline.ts` and `run-group.ts` both read that file; `package.json` holds per-script aliases only. A script that is not registered runs only when invoked by path.

| Group | Scope | Offline checks |
|---|---|---|
| `report` | report fact engine, all-runs aggregate, markdown, formatting | 4: `check-report`, `check-chart-allrun`, `check-markdown`, `check-format` |
| `views` | face view models: replay row, playback state, feed folding, cost panel, vocabulary, view-mode fallback | 1: `check-views` |
| `history` | history rebuild, run grouping, sliding window, event cache | 2: `check-history`, `check-incremental` |
| `settings` | threshold normalization, i18n table completeness | 1: `check-settings` |
| `chimes` | chime policy branches | 1: `check-chimes` |
| `eggs` | process recognition, classification, filters, outside-change attribution, session isolation | 5: `check-eggs`, `check-classify`, `check-outside-attr`, `check-outside-scope`, `check-session-isolation` |
| `metrics` | sampling, ring, restart survival, ranges, egg lifetime | 5: `check-metrics`, `check-metrics-persist`, `check-metrics-ranges`, `check-metrics-restart`, `check-observed-lifetime` |
| `agent` | ACP contract, command forwarding, MCP events, catalog | 8: `check-capability-commands`, `check-mcp-events`, `check-acp`, `check-acp-lifecycle`, `check-acp-transport`, `check-acp-mapping`, `check-acp-proxy`, `check-agent-catalog` |
| `session` | archive storage, dwell clock, close, lifecycle, session isolation | 6: `check-storage`, `check-session-dwell`, `check-session-close`, `check-lifecycle`, `check-outside-scope`, `check-session-isolation` |
| `io` | fsdiff engine | 1: `check-fsdiff` |
| `pipeline` | full pipeline with a self-started server | 0 offline; platform: `check-e2e` |
| `docker` | container eggs | 0 offline; platform: `check-docker`, `check-docker-eggs` |

The `eggs` group also registers the manual checks `check-agentwatch` and `check-ebpf`.

Each registration carries a timeout, raised for checks that boot a server. The runners spawn one child process per script and treat a non-zero exit or a timeout as a failure.

## Running part of the suite

```bash
npm run check:group -- list                     # groups, checks and platform entries
npm run check:group -- report settings          # named groups
npm run check:group -- affected                 # groups owning files changed vs HEAD
npm run check:group -- affected --base main     # same, against a base ref
npm run check:group -- affected --all           # include platform checks
npm run check:process                           # eggs + agent + io, including platform checks
```

`affected` matches changed file paths, including untracked files, against each group's `paths` globs and its own check scripts. A change that matches no group is reported as covered by typecheck and the web build, and the command exits 0.

## Offline checks

34 registrations across 32 scripts. An offline check needs nothing beyond Node: no kernel observer binary, no docker, no elevated rights, and no pre-started server. A check can boot its own server on an ephemeral port with a private `ABSENCE_STATE_DIR`; the session checks, `check-metrics-restart` and `check-history` do this and remain offline.

Coverage by group:

- **Report and UI models**: run facts, all-runs aggregation, timelines, attention rules, markdown rendering, formatting, replay rows, feed folding, history rebuild and the incremental memo.
- **Settings and sound**: threshold normalization, i18n completeness, the branches of the chime policy.
- **Process eggs**: attribution from a fabricated process table, classification order, outside-change attribution and scope, session isolation, egg folding and retirement.
- **Metrics**: sampling output, ring behaviour, persistence, range selection, survival across a server restart, egg lifetime.
- **Agent layer**: ACP session contract, capability gating, transport, tool mapping, transparent proxy, catalog discovery and status, slash-command forwarding, and MCP events.
- **Session and storage**: legacy import, event round-trip, buffered drain, archive listing, dwell clock, close and lifecycle.
- **File diffs**: the fsdiff engine.

## Manual platform checks

5 scripts, registered under `platform` in `groups.ts`. They never run in `check:offline`; an `affected` run skips them unless `--all` is passed, and `check:group -- list` prints them as manual.

| Check | Requirement | What it verifies |
|---|---|---|
| `check-agentwatch` | Windows and the `agentwatch` helper | The Job Object observer reports short-lived children, with command line and attribution |
| `check-ebpf` | Linux, the `agentwatch-linux` helper, and the permissions it needs | The eBPF observer reports short-lived children with command line and attribution |
| `check-docker` | Windows and a docker daemon reachable through WSL | What the Job Object observer sees when an agent drives docker, and where its boundary sits |
| `check-docker-eggs` | A reachable docker daemon (PATH, or a WSL distro on Windows) | Command window to container start event to attributed egg, `docker stats` resources, exit code, and re-attach on session resume |
| `check-e2e` | Nothing beyond Node, but it starts a real server and a mock session | Command events, eggs, container eggs when docker is reachable, metrics frames and SQLite persistence in one run |

`check-agentwatch` exits 0 with an explanation on non-Windows platforms; `check-ebpf` does the same on non-Linux platforms, and `check-docker` does the same outside Windows. A pass result on another platform does not exercise the kernel path or the Windows docker path. `check-docker-eggs` exits non-zero when no docker is reachable.

The kernel and docker checks call `ProcessWatcher.noteMarker` to label processes they start. Production code does not call it.

## ACP family and the mock-agent simulation

`npm run check:acp-all` runs seven steps in this order:

```text
check:acp → check:acp-lifecycle → check:acp-transport → check:acp-mapping
→ check:acp-proxy → check:agent-catalog → check:mock-agent
```

The first six are registered offline checks from the `agent` group. The seventh is a different runner.

`scripts/mock-agent/agent.mjs` is a scripted agent that speaks ACP; it needs no model and no credentials. `scripts/mock-agent/run.ts` builds a throwaway home, state directory and workspace per scenario, starts the real server with a custom ACP profile that launches the mock agent as a real child process, reads the resulting events over the session WebSocket and from SQLite, and checks each scenario's `expect` block. It writes `agent-trace.ndjson` and `absence-events.jsonl` side by side under `--out`.

There are 14 scenarios under `scripts/mock-agent/scenarios/`: cold start, streaming thought, file operations, command retry, long output, multi-turn, cancel mid-turn, concurrent tools, process tree, agent event shapes, diff snippet fidelity, partial-read fidelity, overlapping executes, and rejected approval.

```bash
npm run absence-sim                          # every scenario (= npm run check:mock-agent)
npm run mock:agent -- --list                 # list scenarios
npm run mock:agent -- --scenario 03-file-ops
```

The simulation is not registered in `groups.ts` and is not part of `check:offline`. Its gate entries are `check:mock-agent` and its alias `absence-sim`.

## Failure signals

Every check imports `scripts/checks/harness.ts` (51 lines, four exports: `check`, `finish`, `section`, `waitFor`).

- `check(label, condition, detail)` prints `ok   <label>` or `FAIL <label>  — <detail>`.
- `finish()` prints `<passed>/<total> checks passed` and exits 1 when any check failed. It also exits 1 when zero checks ran, so a script that asserts nothing cannot pass.
- `run-offline.ts` prints `all 34 offline checks passed`, or `<n> check script(s) failed`; a killed script is reported with its name and the timeout from `groups.ts`.
- `run-group.ts` prints `<n> check script(s) passed across <m> group(s)`, or `<n> check script(s) failed`.

A check script is one process. Its exit status is the signal the runners consume, so one failing script cannot be hidden by another script's summary.

## Writing a check

1. Add `scripts/checks/check-<area>.ts` and import `check`, `finish` and, when useful, `section` and `waitFor` from the harness.
2. Register it in `groups.ts`: an entry in the group's `checks` with a timeout, or in its `platform` list when it needs a kernel helper, docker or a pre-started server. Add the source paths it exercises to the group's `paths` so `affected` selects it.
3. Run it by path (`npx tsx scripts/checks/check-<area>.ts`), then through `npm run check:offline` or `npm run check:group -- <group>`.

A check's label states the rule in plain words, its `detail` carries the actual value, and its block comment names the regression it pins. Checks that redirect a state directory set `ABSENCE_STATE_DIR` before importing the storage modules; the import-order reason is in [testing-strategy.md](testing-strategy.md).

## Developer helpers

- `npm run probe:acp -- <scenario>` runs one collection pass and prints the events; `ABSENCE_ACP_BIN` points it at a real agent.
- `npm run registry:sync` fetches the ACP registry into `~/.absence/registry.json`.
- `npm run release:notes -- v<version>` drafts release notes from the commit history.
