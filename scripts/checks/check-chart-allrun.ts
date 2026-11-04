/**
 * Offline check for the Chart face's "all runs" aggregate and query lists.
 *   npx tsx scripts/checks/check-chart-allrun.ts
 *
 * Pins the rules the merged view relies on:
 *   - buildAllRunsSlice cuts exactly the run windows (by archive seq), keeps
 *     the pre-first-run events as the engine's known-file seed, and drops the
 *     idle gaps between runs from the slice (not from the timeline's axis)
 *   - the merged slice feeds the *same* engine: counts aggregate across runs,
 *     created-vs-modified is judged with the seed, the timeline rides one
 *     wall clock (a run-2 node's offset includes the gap between runs)
 *   - buildAllRunsTotals answers the four cumulative numbers from the merged
 *     slice — the merged runs' count, their events, their `usage` events —
 *     never from the archive-wide stats window; a `usage` event outside every
 *     run window must not leak in
 *   - listToolCalls pairs tool_start/tool_end on toolCallId, keeps an orphan
 *     end, and flags errors; listErrors reads the error events in order
 *
 * No server required: pure web-side derivations over fabricated events. Both
 * run scopes share the one mechanism: all-runs cuts run windows by archive
 * seq, single-run passes the selected run's window directly; the numbers must
 * follow the scope, never the archive-wide window.
 */
import { check, finish, section } from "./harness";
import { createEvent, emptyRunCounts, type AbsenceEvent, type RunSummary } from "@absence/core";
import { estimateTokens } from "../../packages/core/src/tokens";
import { buildAllRunsSlice, buildAllRunsTotals } from "../../apps/web/src/lib/allRuns";
import { listErrors, listToolCalls } from "../../apps/web/src/lib/runLists";
import { buildRunFacts, renderRun } from "../../apps/web/src/lib/report";
import type { HistoryRun } from "../../apps/web/src/types/history";

const SID = "sess_allrun_check";

let seq = 0;
const ev = <K extends AbsenceEvent["type"]>(
  type: K,
  payload: Extract<AbsenceEvent, { type: K }>["payload"],
  at: number,
): AbsenceEvent => {
  const event = createEvent(SID, type, payload) as AbsenceEvent;
  (event as { timestamp: number }).timestamp = at;
  (event as { seq: number }).seq = ++seq;
  return event;
};

// ── the fixture: one pre-run read, two runs, a 3s gap between them ──────────
const seedRead = ev("file_read", { path: "/a.ts" }, 1000); // seq 1 — before run 1
const run1Events = [
  ev("message", { role: "user", content: "p1" }, 2000), // seq 2
  ev("tool_start", { toolCallId: "c1", toolName: "bash", args: { command: "npm test" } }, 2010), // 3
  ev("tool_end", { toolCallId: "c1", toolName: "bash", isError: false }, 2020), // 4
  ev("message", { role: "assistant", content: "done 1" }, 2030), // 5
  ev("usage", { model: "mock-1", outputEst: 100, inputEst: 400, estimated: true }, 2040), // 6
];
const run2Events = [
  ev("message", { role: "user", content: "p2" }, 5000), // seq 7
  ev("file_write", { path: "/a.ts", content: "one\ntwo\n" }, 5010), // 8
  ev("tool_start", { toolCallId: "c2", toolName: "read", args: {} }, 5020), // 9
  ev("tool_end", { toolCallId: "c2", toolName: "read", isError: true }, 5040), // 10
  ev("error", { message: "boom" }, 5050), // 11
  ev("usage", { model: "mock-1", outputEst: 200, inputEst: null, estimated: true }, 5060), // 12
];
// seq 13: a usage event belonging to no run — the aggregate must not count it.
const strayUsage = ev("usage", { model: "mock-9", outputEst: 999_999, inputEst: 999_999, estimated: true }, 6000);
const allEvents = [seedRead, ...run1Events, ...run2Events, strayUsage];

const runs: RunSummary[] = [
  {
    id: "run_1",
    index: 1,
    prompt: "p1",
    startedAt: 2000,
    endedAt: 2060,
    status: "completed",
    fromSeq: 2,
    toSeq: 6,
    counts: { ...emptyRunCounts(), run: 1 },
  },
  {
    id: "run_2",
    index: 2,
    prompt: "p2",
    startedAt: 5000,
    endedAt: 5100,
    status: "completed",
    fromSeq: 7,
    toSeq: 12,
    counts: { ...emptyRunCounts(), edit: 1 },
  },
];

section("estimateTokens — the estimate behind the usage events these totals read");
{
  // Moved from the removed check-stats (the cross-session aggregation it
  // pinned is gone; the estimator still feeds every `usage` event).
  check("ASCII is ~1 token per 4 chars", estimateTokens("abcdefgh") === 2, String(estimateTokens("abcdefgh")));
  check("CJK is ~1 token per char", estimateTokens("四个中文字") === 5, String(estimateTokens("四个中文字")));
  check("empty text is 0 tokens", estimateTokens("") === 0);
}

section("buildAllRunsSlice");
{
  const slice = buildAllRunsSlice(allEvents, runs);
  check("a slice is built", slice !== undefined);
  check(
    "the pre-run event seeds the engine but sits outside the run window",
    slice!.run.fromIndex === 1,
    `fromIndex=${slice!.run.fromIndex}`,
  );
  check(
    "the slice is seed + both runs, in order; the stray usage stays out",
    slice!.events.length === 12 && slice!.run.toIndex === 11,
    `events=${slice!.events.length} toIndex=${slice!.run.toIndex}`,
  );
  check("the synthetic run spans the wall clock", slice!.run.startedAt === 2000 && slice!.run.endedAt === 5100);
  check("counts sum over the runs", slice!.run.counts.run === 1 && slice!.run.counts.edit === 1);
  check("two clean runs aggregate to completed", slice!.run.status === "completed");

  const withError = buildAllRunsSlice(allEvents, [
    runs[0]!,
    { ...runs[1]!, status: "error" as const },
  ]);
  check("an errored run marks the aggregate", withError!.run.status === "error");

  const stillRunning = buildAllRunsSlice(allEvents, [
    runs[0]!,
    { ...runs[1]!, status: "running" as const, endedAt: undefined },
  ]);
  check("a running tail keeps the aggregate running", stillRunning!.run.status === "running");

  check(
    "events without archive positions refuse to slice",
    buildAllRunsSlice(
      allEvents.map((event) => {
        const copy = { ...event } as AbsenceEvent & { seq?: number };
        delete copy.seq;
        return copy;
      }),
      runs,
    ) === undefined,
  );
  check("no runs means no slice", buildAllRunsSlice(allEvents, []) === undefined);
}

section("the same engine, over every run");
{
  const slice = buildAllRunsSlice(allEvents, runs)!;
  const facts = buildRunFacts(slice.events, slice.run);
  check("commands aggregate across runs", facts.commands.total === 1, `total=${facts.commands.total}`);
  check("the failed read counts as an error event", facts.errors.total === 1);
  check(
    "the seed keeps created-vs-modified honest: /a.ts was read before run 1",
    facts.files.modified.includes("/a.ts") && !facts.files.created.includes("/a.ts"),
    JSON.stringify({ modified: facts.files.modified, created: facts.files.created }),
  );
  check("the reply is the last assistant message of the merged slice", facts.response === "done 1");

  const report = renderRun(facts);
  const writeNode = report.timeline.find((node) => node.kind === "write");
  check(
    "the timeline rides one wall clock: run 2's write carries the 3s gap in its offset",
    writeNode !== undefined && writeNode.offsetMs === 5010 - 2000,
    `offsetMs=${writeNode?.offsetMs}`,
  );
  const errorNode = report.timeline.find((node) => node.kind === "error");
  check(
    "a run-2 node never rewinds below run 1's span",
    errorNode !== undefined && errorNode.offsetMs === 5050 - 2000,
    `offsetMs=${errorNode?.offsetMs}`,
  );
}

section("buildAllRunsTotals — the four numbers come from the merged slice");
{
  const slice = buildAllRunsSlice(allEvents, runs)!;
  const totals = buildAllRunsTotals(slice, runs);
  check("run count is the merged runs, not an archive window", totals.runs === 2);
  check("the aggregate covers its one session", totals.sessions === 1);
  check(
    "events count only the run windows (seed and stray excluded)",
    totals.events === 11,
    `events=${totals.events}`,
  );
  check("error events count only the run windows", totals.errorEvents === 1);
  check("no errored run is an honest 0%, not null", totals.errorRate === 0);
  check("wall time sums the ended runs", totals.runWallMs === 60 + 100, `wall=${totals.runWallMs}`);
  check(
    "tokens count only the merged runs' usage — the stray 999k event stays out",
    totals.tokens.output === 300 && totals.tokens.input === 400,
    JSON.stringify(totals.tokens),
  );

  const errored = buildAllRunsTotals(slice, [runs[0]!, { ...runs[1]!, status: "error" as const }]);
  check("the error rate reads the merged runs' statuses", errored.errorRate === 0.5 && errored.errorRuns === 1);

  // The same function over a one-run slice is that run's own numbers — the
  // scope follows the runs handed in, so a single-run reading is unaffected.
  const one = buildAllRunsTotals(buildAllRunsSlice(allEvents, [runs[0]!])!, [runs[0]!]);
  check(
    "a one-run scope yields that run's numbers",
    one.runs === 1 && one.events === 5 && one.tokens.output === 100 && one.tokens.input === 400,
    JSON.stringify({ runs: one.runs, events: one.events, tokens: one.tokens }),
  );

  // The single-run reading builds the same totals from the run's own window
  // directly — no archive seqs needed. The scope differs, the mechanism and
  // the contract don't.
  const run1Window: { events: AbsenceEvent[]; run: HistoryRun } = {
    events: run1Events,
    run: {
      id: "run_1",
      index: 1,
      prompt: "p1",
      startedAt: 2000,
      endedAt: 2060,
      status: "completed",
      fromIndex: 0,
      toIndex: run1Events.length - 1,
      counts: { ...emptyRunCounts(), run: 1 },
    },
  };
  const single = buildAllRunsTotals(run1Window, [run1Window.run]);
  check("single run: run count is 1", single.runs === 1);
  check(
    "single run: events and tokens are that run's window only",
    single.events === 5 && single.tokens.output === 100 && single.tokens.input === 400,
    JSON.stringify({ events: single.events, tokens: single.tokens }),
  );
  check("single run: a clean run is an honest 0%", single.errorRate === 0);
  const erroredSingle = buildAllRunsTotals(run1Window, [{ ...run1Window.run, status: "error" as const }]);
  check("single run: an errored run reads 100%", erroredSingle.errorRate === 1);
  const runningSingle = buildAllRunsTotals(run1Window, [
    { ...run1Window.run, status: "running" as const, endedAt: undefined },
  ]);
  check("single run: a running run has no wall time yet", runningSingle.runWallMs === null);
}

section("listToolCalls");
{
  const slice = buildAllRunsSlice(allEvents, runs)!;
  const calls = listToolCalls(slice.events, slice.run);
  check("every tool call lists, not only shell commands", calls.length === 2, `calls=${calls.length}`);
  const bash = calls.find((call) => call.toolCallId === "c1")!;
  check("a paired call carries its duration", bash.durationMs === 10 && !bash.isError && !bash.running);
  check("start and end are both evidence", bash.evidence.length === 2);
  const read = calls.find((call) => call.toolCallId === "c2")!;
  check("an errored end flags the call", read.isError && read.durationMs === 20);

  // What-if for pairing edges: run 2's window extended to cover two more
  // events — an unpaired start (still open) and an orphan end.
  const open = ev("tool_start", { toolCallId: "c3", toolName: "grep", args: {} }, 5060); // 14
  const orphanEnd = ev("tool_end", { toolCallId: "c9", toolName: "bash", isError: false }, 5070); // 15
  const tail = buildAllRunsSlice([...allEvents, open, orphanEnd], [
    runs[0]!,
    { ...runs[1]!, toSeq: 15 },
  ])!;
  const rows = listToolCalls(tail.events, tail.run);
  const c3 = rows.find((call) => call.toolCallId === "c3")!;
  const c9 = rows.find((call) => call.toolCallId === "c9")!;
  check("an open start reads as running", c3.running === true && c3.durationMs === undefined);
  check("an orphan end still lists", c9 !== undefined && !c9.running && c9.durationMs === undefined);
}

section("listErrors");
{
  const slice = buildAllRunsSlice(allEvents, runs)!;
  const rows = listErrors(slice.events, slice.run);
  check("error events list in order", rows.length === 1 && rows[0]!.message === "boom");
  check("an error row carries its timestamp", rows[0]!.at === 5050);

  const single = buildAllRunsSlice(allEvents, [runs[0]!]);
  check(
    "one run's slice drops the other run's errors",
    listErrors(single!.events, single!.run).length === 0,
  );
}

finish("check-chart-allrun");
