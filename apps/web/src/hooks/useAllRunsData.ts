import { useEffect, useMemo, useState } from "react";
import type { AbsenceEvent, StatsTotals } from "@absence/core";
import * as api from "../lib/api";
import { buildAllRunsSlice, buildAllRunsTotals } from "../lib/allRuns";
import { buildRunFacts, renderRun } from "../lib/report";
import { useAttentionOptions } from "./useAttentionOptions";
import { useRunsStore } from "../stores/runsStore";
import { useSessionStore } from "../stores/sessionStore";
import type { HistoryRun } from "../types/history";
import type { RunFacts, RunReport } from "../types/report";

/**
 * The Chart face's "all runs" reading: every run in the session, aggregated.
 *
 * The events come from the archive's paged session endpoint (fresh for a live
 * session too — the server flushes its write buffer before answering), cut to
 * the run windows by `buildAllRunsSlice`, then reduced by the *same* engine
 * the single-run report uses (`buildRunFacts` + `renderRun`). No forked
 * derivation, no second opinion about what a run is.
 *
 * The four cumulative numbers (`totals`) come from the merged slice as well —
 * the runs in the merge, their events, their `usage` events.
 *
 * The attention verdict here is the settled one (facts.attention): the live
 * stall clock (`renderLive`'s `nowMs`) belongs to a single live run and would
 * read an idle gap between runs as a wedge, which it is not.
 *
 * Reloads when the run list changes (a run starts, ends, or grows its stored
 * range) and on a slow beat thereafter — 5s while a run is running, 15s once
 * settled. An aggregate moves at run speed, not at event speed.
 */
export interface AllRunsData {
  run?: HistoryRun;
  events: AbsenceEvent[];
  facts?: RunFacts;
  report?: RunReport;
  /** The merged slice as the four cumulative cards' `StatsTotals`. */
  totals?: StatsTotals;
  loading: boolean;
  error?: string;
}

const REFRESH_RUNNING_MS = 5_000;
const REFRESH_SETTLED_MS = 15_000;

let allRunsRequest = 0;

export function useAllRunsData(enabled: boolean): AllRunsData {
  const sessionId = useSessionStore((s) => s.session?.id);
  const runs = useRunsStore((s) => s.runs);
  const options = useAttentionOptions();
  const [events, setEvents] = useState<AbsenceEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const runsKey = runs.map((run) => `${run.id}:${run.status}:${run.toSeq}`).join("|");
  const running = runs.some((run) => run.status === "running");

  useEffect(() => {
    if (!enabled || !sessionId || runs.length === 0) return;
    let cancelled = false;
    const request = ++allRunsRequest;
    const load = async () => {
      setLoading(true);
      try {
        const all = await api.fetchAllSessionEvents(sessionId);
        if (cancelled || request !== allRunsRequest) return;
        setEvents(all);
        setError(undefined);
        setLoading(false);
      } catch (cause) {
        if (cancelled || request !== allRunsRequest) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), running ? REFRESH_RUNNING_MS : REFRESH_SETTLED_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // runsKey stands in for `runs`: identity churn without content change must
    // not retrigger a full session read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionId, runsKey, running]);

  const slice = useMemo(
    () => (enabled && events.length > 0 ? buildAllRunsSlice(events, runs) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, events, runsKey],
  );
  const facts = useMemo(
    () => (slice ? buildRunFacts(slice.events, slice.run, options) : undefined),
    [slice, options],
  );
  const report = useMemo(() => (facts ? renderRun(facts) : undefined), [facts]);
  const totals = useMemo(
    () => (slice ? buildAllRunsTotals(slice, runs) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slice, runsKey],
  );

  return {
    run: slice?.run,
    events: slice?.events ?? [],
    facts,
    report,
    totals,
    loading,
    error,
  };
}
