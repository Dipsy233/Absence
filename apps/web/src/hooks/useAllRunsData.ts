import { useEffect, useMemo, useRef, useState } from "react";
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
 * Events load once per session, in full, and after that only the tail is
 * appended: each beat asks the archive for the pages after the last `seq` we
 * hold, so a long session costs the new events, not the whole history, on
 * every refresh — 5s while a run is running, 15s once settled. An aggregate
 * moves at run speed, not at event speed. A failed catch-up drops the cursor,
 * so the next beat falls back to a full read instead of silently missing
 * events.
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
const PAGE_LIMIT = 2_000;

export function useAllRunsData(enabled: boolean): AllRunsData {
  const sessionId = useSessionStore((s) => s.session?.id);
  const runs = useRunsStore((s) => s.runs);
  const options = useAttentionOptions();
  const [events, setEvents] = useState<AbsenceEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const runsKey = runs.map((run) => `${run.id}:${run.status}:${run.toSeq}`).join("|");
  const running = runs.some((run) => run.status === "running");

  /** The seq the archive was read up to; undefined = next read is a full one. */
  const cursorRef = useRef<number | undefined>(undefined);
  /** Fresh for this effect instance: stale async results must not land. */
  const requestRef = useRef(0);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    cursorRef.current = undefined;
    const request = ++requestRef.current;
    const load = async () => {
      setLoading(true);
      try {
        let after = cursorRef.current;
        if (after === undefined) {
          // First read for this session (or recovering from an error): the
          // whole history, paged forward.
          const all = await api.fetchAllSessionEvents(sessionId);
          if (requestRef.current !== request) return;
          const last = all[all.length - 1];
          cursorRef.current = last?.seq ?? 0;
          setEvents(all);
        } else {
          const fresh: AbsenceEvent[] = [];
          for (;;) {
            const page = await api.fetchSessionEventsPage(sessionId, { after, limit: PAGE_LIMIT });
            if (requestRef.current !== request) return;
            fresh.push(...page.events);
            if (!page.hasMore || page.nextAfter === undefined) break;
            after = page.nextAfter;
          }
          if (fresh.length > 0) {
            const last = fresh[fresh.length - 1];
            cursorRef.current = last?.seq ?? cursorRef.current;
            setEvents((previous) => [...previous, ...fresh]);
          }
        }
        setError(undefined);
        setLoading(false);
      } catch (cause) {
        if (requestRef.current !== request) return;
        // Drop the cursor: a failed incremental read's position is not
        // trustworthy, and a full read is the safe recovery.
        cursorRef.current = undefined;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), running ? REFRESH_RUNNING_MS : REFRESH_SETTLED_MS);
    return () => {
      requestRef.current += 1;
      clearInterval(timer);
    };
  }, [enabled, sessionId, running]);

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
