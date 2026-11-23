# Testing and acceptance checks

[English](testing.md) | [简体中文](testing.zh-CN.md)

Absence has no unit-test framework. Acceptance behaviour is verified by standalone scripts run with `tsx`. The checks target process attribution, event projection, archive round-trips, metrics persistence and observation-channel behaviour: failures in these areas do not surface as type errors. [testing-strategy.md](testing-strategy.md) describes the layering and the reasons for it.

## 1. Gates

```bash
npm run typecheck       # tsc across packages/core, apps/server, apps/web
npm run build           # production web build in dist/web
npm run check:offline   # all registered offline checks
npm run verify          # typecheck + build + check:offline
```

`npm run verify` is the pre-commit gate. CI (`.github/workflows/ci.yml`) runs `npm run typecheck --workspaces --if-present` and `npm run check:offline` on Node 22.23.4.

The agent layer has two additional gates:

```bash
npm run check:acp-all   # check:acp-mapping + check:acp-proxy
npm run check:e2e       # a real server with a mock session (manual platform check)
```

`npm run absence-sim` (`scripts/mock-agent/run.ts`) still opens sessions through the removed ACP profile path and fails on this build; it is not a usable gate.

## 2. Registration

`scripts/checks/groups.ts` is the single registration point. It defines 13 groups, 37 offline registrations over 35 scripts, and 5 manual platform registrations. Two scripts are registered in both the `eggs` and `session` groups. `run-offline.ts` and `run-group.ts` both read that file; `package.json` holds per-script aliases only.

| Group | Scope | Offline checks |
|---|---|---|
| `report` | report fact engine, all-runs aggregate, markdown, formatting | 4: `check-report`, `check-chart-allrun`, `check-markdown`, `check-format` |
| `views` | face view models: replay row, playback state, feed folding, cost panel, vocabulary, view-mode fallback | 1: `check-views` |
| `history` | history rebuild, run grouping, sliding window, event cache | 2: `check-history`, `check-incremental` |
| `settings` | threshold normalization, i18n table completeness | 1: `check-settings` |
| `chimes` | chime policy branches | 1: `check-chimes` |
| `eggs` | process recognition, classification, filters, outside-change attribution, session isolation | 6: `check-eggs`, `check-agentwatch-external`, `check-classify`, `check-outside-attr`, `check-outside-scope`, `check-session-isolation` |
| `metrics` | sampling, ring, restart survival, ranges, egg lifetime | 5: `check-metrics`, `check-metrics-persist`, `check-metrics-ranges`, `check-metrics-restart`, `check-observed-lifetime` |
| `agent` | tool mapping, MCP events, proxy | 3: `check-mcp-events`, `check-acp-mapping`, `check-acp-proxy` |
| `session` | archive storage, dwell clock, close, lifecycle, session isolation | 6: `check-storage`, `check-session-dwell`, `check-session-close`, `check-lifecycle`, `check-outside-scope`, `check-session-isolation` |
| `observe` | transcript discovery, target selection, leases, OS-only watch, mid-session attach, resume, proxy persistence, CLI | 7: `check-observe-board`, `check-observe-watch`, `check-observe-os`, `check-cli-observe`, `check-observe-midway`, `check-observe-transcript`, `check-observe-proxy` |
| `io` | fsdiff engine | 1: `check-fsdiff` |
| `pipeline` | full pipeline with a self-started server | 0 offline; platform: `check-e2e` |
| `docker` | container eggs | 0 offline; platform: `check-docker`, `check-docker-eggs` |

The `eggs` group also registers the manual checks `check-agentwatch` and `check-ebpf`.

Each registration carries a timeout, raised for checks that boot a server. The runners spawn one child process per script and treat a non-zero exit or a timeout as a failure.

## 3. Running part of the suite

```bash
npm run check:group -- list                     # groups, checks and platform entries
npm run check:group -- report settings          # named groups
npm run check:group -- affected                 # groups owning files changed vs HEAD
npm run check:group -- affected --base main     # same, against a base ref
npm run check:group -- affected --all           # include platform checks
npm run check:process                           # eggs + agent + io, including platform checks
```

`affected` matches changed file paths, including untracked files, against each group's `paths` globs and its own check scripts. A change that matches no group is reported as covered by typecheck and the web build, and the command exits 0.

## 4. Offline checks

An offline check needs nothing beyond Node: no kernel observer binary, no docker, no elevated rights and no pre-started server. A check may boot its own server on an ephemeral port with a private `ABSENCE_STATE_DIR`.

Coverage by area:

| Area | Checks | What is established |
|---|---|---|
| Report and view models | `check-report`, `check-chart-allrun`, `check-markdown`, `check-format`, `check-views`, `check-history`, `check-incremental` | Run facts, all-runs totals, timeline, attention rules, Markdown rendering, formatting, replay row, feed folding, history rebuild and incremental memoization |
| Settings and sound | `check-settings`, `check-chimes` | Threshold normalization, i18n completeness, chime policy branches |
| Process eggs | `check-eggs`, `check-classify`, `check-outside-attr`, `check-outside-scope`, `check-session-isolation`, `check-agentwatch-external` | Attribution from a synthetic process table, classification order, outside-change attribution, session isolation, egg folding and retirement, external scanner pairing |
| Metrics | `check-metrics`, `check-metrics-persist`, `check-metrics-ranges`, `check-metrics-restart`, `check-observed-lifetime` | Sampling output, ring behaviour, persistence, range selection, survival across a server restart, egg lifetime |
| Agent layer | `check-mcp-events`, `check-acp-mapping`, `check-acp-proxy` | Tool mapping by kind and shape, MCP events, proxy forwarding, tap projection, diagnostics, proxy CLI exit |
| Sessions and storage | `check-storage`, `check-session-dwell`, `check-session-close`, `check-lifecycle` | Legacy archive import, event round-trip, buffer drain, archive listing, dwell clock, close and lifecycle |
| Observation | `check-observe-board`, `check-observe-watch`, `check-observe-os`, `check-cli-observe`, `check-observe-midway`, `check-observe-transcript`, `check-observe-proxy` | Discovery without auto-attach, target selection and leases, restart recovery, transcript checkpoint resume, prefix divergence, OS-only watch and upgrade, mid-session attach, backfill integrity, refusal to drive, CLI bind guard and token handling |
| File diff | `check-fsdiff` | The diff engine |

## 5. Manual platform checks

Five scripts are registered in a group's `platform` list. They are excluded from `check:offline`; `affected` skips them unless `--all` is passed.

| Check | Requires | Establishes |
|---|---|---|
| `check-agentwatch` | Windows and the `agentwatch` helper | The Job Object observer reports short-lived child processes with command line and attribution |
| `check-ebpf` | Linux, the `agentwatch-linux` helper and its privileges | The eBPF observer reports short-lived child processes with command line and attribution |
| `check-docker` | A reachable docker daemon | What the kernel observer sees and where its boundary lies when an agent drives docker |
| `check-docker-eggs` | A reachable docker daemon | Container start events from a command window, attributed eggs, `docker stats` resources, exit codes and re-attach on session resume |
| `check-e2e` | Node only; starts a real server and a mock session | Command events, eggs, metric frames and SQLite persistence within one run |

`check-agentwatch` exits 0 with a message on non-Windows platforms; `check-ebpf` does the same on non-Linux platforms; `check-docker` does the same on non-Windows platforms. A pass on another platform does not cover the kernel path or the Windows docker path. `check-docker-eggs` exits non-zero when no docker daemon is reachable.

The kernel and docker checks call `ProcessWatcher.noteMarker` to mark the processes they start. Production code does not call it.

## 6. Failure output

Every check uses `scripts/checks/harness.ts`, which exports `check`, `finish`, `section` and `waitFor`.

- `check(label, condition, detail)` prints `ok   <label>` or `FAIL <label>  — <detail>`.
- `finish()` prints `<passed>/<total> checks passed`; the exit code is 1 when any check failed or when no check ran.
- `run-offline.ts` prints `all <n> offline checks passed`, or `<n> check script(s) failed`; a killed script is reported with its name and the timeout from `groups.ts`.
- `run-group.ts` prints `<n> check script(s) passed across <m> group(s)`, or `<n> check script(s) failed`.

Each check script is a separate process and the runner consumes its exit code, so one failing script is not masked by another's summary.

## 7. Writing a check

1. Create `scripts/checks/check-<area>.ts`.
2. Import `check`, `section` and `finish` from `./harness`.
3. Set environment variables such as `ABSENCE_STATE_DIR` before importing server modules, using dynamic `import()` after the assignment.
4. Register the script in `scripts/checks/groups.ts` with its group, paths and timeout.
5. Add a per-script alias to `package.json` only when the script is run on its own often.

Checks that spawn a server set `ABSENCE_OBSERVE=0` unless they test observation, and always use a private `ABSENCE_STATE_DIR`.
