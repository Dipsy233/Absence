import { useMemo, useRef } from "react";
import { isAgentBusy, type AbsenceEvent } from "@absence/core";
import { useSelectedRun } from "../../hooks/useSelectedRun";
import { useLiveItem } from "../../hooks/useStage";
import { useNow } from "../../hooks/useNow";
import { useAttentionOptions } from "../../hooks/useAttentionOptions";
import { buildRunFacts, renderLive } from "../../lib/report";
import { activityRowsVersion, memoRunRows } from "../../lib/history";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { ActivityRow } from "../../types/stage";
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
  /** The event behind the item the Stage is following. */
  liveEventId?: string;
  /**
   * A real version over the rows.
   *
   * `memoRunRows` returns the same array it keeps appending to (that is what
   * makes it incremental), so a consumer that memoises on `rows` sees one
   * identity forever. Array length is not a version either: a streamed thought
   * folds into the row it continues, so the length does not move while the
   * row's text does. This counter is bumped by the row builder on every
   * in-place mutation, and any derivation over the rows must depend on it.
   */
  rowsVersion: number;
}

const NO_ATTENTION: Attention = { level: "none", reasons: [], evidence: [] };

/** Recompute facts at most this often (ms). */
const FACTS_INTERVAL_MS = 500;

export function useMonitorData(): MonitorData {
  const { run, events, loading } = useSelectedRun();
  const attentionOptions = useAttentionOptions();
  const displayInActivity = useSettingsStore((s) => s.displayInActivity);
  const observed = useIsObserved();
  const status = useSessionStore((s) => s.agent.status);
  const tick = useNow(FACTS_INTERVAL_MS);

  // Classic's rule (`settings || observed`): an observed session always shows
  // its process rows, because for a watched agent they are the whole story.
  const showProcessRows = displayInActivity || observed;

  const rows = useMemo(
    () => (run ? memoRunRows(events, run, showProcessRows) : []),
    [events, run, showProcessRows],
  );

  /**
   * `tick` really is the throttle — and the latest events reach the engine
   * through a ref for the same reason.
   *
   * The session store hands out a new `events` array with every socket batch
   * (one per ~50 ms), so keeping `events` in the dependency list recomputed the
   * whole run twenty times a second — the "clamped to 500 ms" this module
   * promises was not happening. Depending on `tick` alone recomputes exactly
   * twice a second (plus when the run or the attention settings change),
   * reading the freshest events through the ref.
   */
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const facts = useMemo(() => {
    void tick;
    if (!run) return undefined;
    try {
      return buildRunFacts(eventsRef.current, run, attentionOptions);
    } catch {
      // A partially-built run (a snapshot that arrived mid-stream) must not
      // take the whole Monitor down; the feed still works without the facts.
      return undefined;
    }
  }, [run?.id, run?.status, tick, attentionOptions]);

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
    liveEventId: liveItem?.source?.eventId,
    // Read after the rows memo above, so a fold that happened during this
    // render is counted in the version handed out with it.
    rowsVersion: activityRowsVersion(),
  };
}
