import type { AbsenceEvent, RunStatus, RunSummary, StatsTotals } from "@absence/core";
import { emptyRunCounts } from "@absence/core";
import type { HistoryRun } from "../types/history";

/**
 * The "all runs" reading of a session: every run's events, in wall-clock
 * order, presented to the report engine as one synthetic run.
 *
 * Runs share one wall clock, so no time base has to be invented: the synthetic
 * run starts at the first run's start, every event's offset falls out of its
 * absolute timestamp, and the silence between two runs shows as empty track.
 *
 * The slice keeps the events *before* the first run outside the run window
 * (they seed the engine's known-file set, so `created` vs `modified` is judged
 * exactly the way the single-run report judges it) and drops the events
 * *between* runs (idle-time watcher noise belongs to no run).
 *
 * The events must carry the archive's `seq` positions (the paged session
 * events API does); without them a run window cannot be cut exactly, and the
 * caller gets `undefined` rather than a guess.
 */
export interface AllRunsSlice {
  events: AbsenceEvent[];
  run: HistoryRun;
}

/** The synthetic run's id — never a real run id, so pick-reset logic treats it as a run change. */
export const ALL_RUNS_ID = "run_all";

export function buildAllRunsSlice(
  events: AbsenceEvent[],
  runs: RunSummary[],
): AllRunsSlice | undefined {
  if (runs.length === 0 || events.length === 0) return undefined;
  const sorted = [...runs].sort((a, b) => a.index - b.index);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  const inRun = (seq: number): boolean =>
    sorted.some((run) => seq >= run.fromSeq && seq <= run.toSeq);

  const seed: AbsenceEvent[] = [];
  const body: AbsenceEvent[] = [];
  for (const event of events) {
    const seq = event.seq;
    if (seq === undefined) return undefined;
    if (seq < first.fromSeq) seed.push(event);
    else if (inRun(seq)) body.push(event);
  }

  const merged = [...seed, ...body];
  const status: RunStatus = sorted.some((run) => run.status === "running")
    ? "running"
    : sorted.some((run) => run.status === "error")
      ? "error"
      : sorted.some((run) => run.status === "interrupted")
        ? "interrupted"
        : "completed";
  const counts = sorted.reduce((sum, run) => {
    sum.read += run.counts.read;
    sum.search += run.counts.search;
    sum.edit += run.counts.edit;
    sum.run += run.counts.run;
    sum.created += run.counts.created;
    return sum;
  }, emptyRunCounts());

  return {
    events: merged,
    run: {
      id: ALL_RUNS_ID,
      index: last.index,
      prompt: "",
      startedAt: first.startedAt,
      endedAt: last.endedAt,
      status,
      fromIndex: seed.length,
      toIndex: merged.length - 1,
      counts,
    },
  };
}

/**
 * The four cumulative numbers of one run scope, computed from that scope's
 * event window itself — never from the archive-wide stats window. The scope
 * is the caller's choice: the all-runs reading passes the merged slice and
 * every run in the session; the single-run reading passes the selected run's
 * own window. Events, errors and tokens count only what sits inside the
 * window (the seed context and the idle gaps contribute nothing). The shape
 * is the server's `StatsTotals` so the same KPI cards render it, and the same
 * no-data contract holds: counts may honestly be 0, derived values are `null`
 * when there is nothing to derive them from.
 */
export function buildAllRunsTotals(
  slice: AllRunsSlice,
  runs: Array<Pick<RunSummary, "status" | "startedAt" | "endedAt">>,
): StatsTotals {
  const body = slice.events.slice(slice.run.fromIndex, slice.run.toIndex + 1);
  let errorEvents = 0;
  let input: number | null = null;
  let output: number | null = null;
  for (const event of body) {
    if (event.type === "error") {
      errorEvents += 1;
      continue;
    }
    if (event.type !== "usage") continue;
    const payload = event.payload;
    output = (output ?? 0) + (Number.isFinite(payload.outputEst) ? Number(payload.outputEst) : 0);
    if (typeof payload.inputEst === "number" && Number.isFinite(payload.inputEst)) {
      input = (input ?? 0) + payload.inputEst;
    }
  }

  const errorRuns = runs.filter((run) => run.status === "error").length;
  let wall = 0;
  let ended = 0;
  for (const run of runs) {
    if (run.endedAt === undefined) continue;
    wall += Math.max(0, run.endedAt - run.startedAt);
    ended += 1;
  }

  return {
    sessions: 1,
    runs: runs.length,
    events: body.length,
    errorRuns,
    errorEvents,
    errorRate: runs.length > 0 ? errorRuns / runs.length : null,
    runWallMs: ended > 0 ? wall : null,
    tokens: { input, output },
  };
}
