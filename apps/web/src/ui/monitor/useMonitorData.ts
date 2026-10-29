import { useMemo } from "react";
import { isAgentBusy, type AbsenceEvent } from "@absence/core";
import { useSelectedRun } from "../../hooks/useSelectedRun";
import { useLiveItem } from "../../hooks/useStage";
import { useNow } from "../../hooks/useNow";
import { useAttentionOptions } from "../../hooks/useAttentionOptions";
import { buildRunFacts, renderLive } from "../../lib/report";
import { memoRunRows } from "../../lib/history";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { ActivityRow, StageItem } from "../../types/stage";
import type { Attention, RunFacts } from "../../types/report";
import type { HistoryRun } from "../../types/history";

/**
 * Everything the Monitor draws, derived once per render pass.
 *
 * The expensive part is `buildRunFacts` — it walks the whole run — and it is
 * clamped to twice a second (the same budget the attention chime uses). A
 * streamed token therefore updates the feed immediately (rows are incremental)
 * while the phase / attention verdict lags by at most 500 ms, which is
 * indistinguishable from live and keeps the frame cheap.
 */
export interface MonitorData {
  run?: HistoryRun;
  events: AbsenceEvent[];
  loading: boolean;
  /** Feed rows for the selected run, converted incrementally. */
  rows: ActivityRow[];
  facts?: RunFacts;
  attention: Attention;
  /** The live "what is it doing" sentence, only while the run is in flight. */
  liveHeadline?: string;
  /**
   * What the Stage shows while it follows the agent.
   *
   * The store's `currentAction` is cleared the moment the agent speaks or the
   * run ends, which left the live Stage on "Waiting for the first activity…"
   * while the feed beside it listed twenty rows. Following means "the newest
   * thing in this run", so the tail of the feed is the answer — and after the
   * run ends that is the last thing the agent actually did, which is what a
   * reader who was watching wants to keep seeing.
   */
  liveItem?: StageItem;
  /** The event behind `liveItem`, so the feed can mark the row it is showing. */
  liveEventId?: string;
  /**
   * How many rows there are *now*.
   *
   * `memoRunRows` returns the same array it keeps appending to (that is what
   * makes it incremental), so a consumer that memoises on `rows` sees one
   * identity forever and never recomputes — which is exactly how the feed
   * stayed empty until the run ended. Any derivation over the rows must depend
   * on this counter instead of on the array.
   */
  rowsVersion: number;
  busy: boolean;
  observed: boolean;
}

const NO_ATTENTION: Attention = { level: "none", reasons: [], evidence: [] };

/** Recompute facts at most this often (ms). */
const FACTS_INTERVAL_MS = 500;

export function useMonitorData(): MonitorData {
  const { run, events, loading } = useSelectedRun();
  const attentionOptions = useAttentionOptions();
  const displayInActivity = useSettingsStore((s) => s.displayInActivity);
  const status = useSessionStore((s) => s.agent.status);
  const observed = useIsObserved();
  const tick = useNow(FACTS_INTERVAL_MS);

  const rows = useMemo(
    () => (run ? memoRunRows(events, run, true) : []),
    [events, run, displayInActivity],
  );

  // `tick` is a dependency on purpose: the facts object is derived from a
  // mutating event array, so nothing else here would change identity.
  const facts = useMemo(() => {
    void tick;
    if (!run) return undefined;
    try {
      return buildRunFacts(events, run, attentionOptions);
    } catch {
      // A partially-built run (a snapshot that arrived mid-stream) must not
      // take the whole Monitor down; the feed still works without the facts.
      return undefined;
    }
  }, [run?.id, run?.status, events, tick, attentionOptions]);

  /**
   * What the Stage follows while it is live: the agent's *current action*, not
   * the tail of the feed.
   *
   * This is Classic's rule, and it is the one that makes a finished run rest on
   * a page instead of the last thing it happened to do. `currentAction` is
   * cleared the moment the agent speaks or the run ends (`clearsStage`), so
   * "there is nothing to follow right now" is a state this hook can report — a
   * feed tail can never say that, because the tail of a finished run is still a
   * row. Deriving from the tail is what pinned the centre column to the last
   * activity of every run that had ended.
   *
   * `useLiveItem` is the same derivation Classic's Stage uses, so the two faces
   * cannot disagree about what "the agent is doing now" means.
   */
  const liveItem = useLiveItem();

  const running = run?.status === "running";
  const busy = isAgentBusy(status);
  const live = useMemo(
    () => (facts && running ? renderLive(facts, { busy, status }, attentionOptions) : undefined),
    [facts, running, busy, status, attentionOptions],
  );

  return {
    run,
    events,
    loading,
    rows,
    facts,
    attention: live?.attention ?? facts?.attention ?? NO_ATTENTION,
    liveHeadline: live?.headline,
    liveItem,
    liveEventId: liveItem?.source?.eventId,
    rowsVersion: rows.length,
    busy,
    observed,
  };
}
