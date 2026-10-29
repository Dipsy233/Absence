import { useMemo } from "react";
import { isAgentBusy, type AbsenceEvent } from "@absence/core";
import { useSelectedRun } from "../../hooks/useSelectedRun";
import { useNow } from "../../hooks/useNow";
import { useAttentionOptions } from "../../hooks/useAttentionOptions";
import { buildRunFacts, renderLive } from "../../lib/report";
import { memoRunRows } from "../../lib/history";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { ActivityRow } from "../../types/stage";
import type { Attention, PhaseType, RunFacts } from "../../types/report";
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
  /** Phase headers keyed by the event id that opened each phase. */
  phaseAt: Map<string, PhaseType>;
  facts?: RunFacts;
  attention: Attention;
  phase?: PhaseType;
  /** The live "what is it doing" sentence, only while the run is in flight. */
  liveHeadline?: string;
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

  const phaseAt = useMemo(() => {
    const map = new Map<string, PhaseType>();
    for (const phase of facts?.phases ?? []) map.set(phase.eventId, phase.type);
    return map;
  }, [facts]);

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
    phaseAt,
    facts,
    attention: live?.attention ?? facts?.attention ?? NO_ATTENTION,
    phase: facts?.currentPhase,
    liveHeadline: live?.headline,
    busy,
    observed,
  };
}
