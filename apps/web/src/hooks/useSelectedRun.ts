import { useEffect, useMemo } from "react";
import type { AbsenceEvent, RunSummary } from "@absence/core";
import type { HistoryRun } from "../types/history";
import { memoBuildHistory } from "../lib/history";
import { useEvents, useSessionStore } from "../stores/sessionStore";
import { useRunsStore } from "../stores/runsStore";
import { useUiStore } from "../stores/uiStore";

export interface SelectedRun {
  run?: HistoryRun;
  events: AbsenceEvent[];
  loading: boolean;
}

/**
 * The run the Stage/Activity is showing, and the events it can be built from.
 *
 * A running run uses the live event window (so streamed rows keep appearing).
 * A historical run is fetched by index from the run API, one run at a time;
 * History never has to load the whole session to be browsable.
 */
export function useSelectedRun(): SelectedRun {
  const liveEvents = useEvents();
  const runs = useRunsStore((s) => s.runs);
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const loaded = useRunsStore((s) => s.selectedEvents);
  const eventsLoading = useRunsStore((s) => s.eventsLoading);
  const loadRunEvents = useRunsStore((s) => s.loadRunEvents);
  const sessionId = useSessionStore((s) => s.session?.id);

  const selected = useMemo<RunSummary | undefined>(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[runs.length - 1],
    [runs, selectedRunId],
  );

  // The live window's last run is the one still being written. Its server
  // summary is authoritative for id/index/counts; the derived run supplies the
  // array indices the row builder needs.
  const liveRuns = useMemo(() => memoBuildHistory(liveEvents), [liveEvents]);
  const liveDerived = liveRuns[liveRuns.length - 1];
  const isLive =
    selected !== undefined &&
    selected.id === runs[runs.length - 1]?.id &&
    selected.status === "running";

  const historicalEvents =
    selected && loaded?.runId === selected.id ? loaded.events : [];

  useEffect(() => {
    if (!sessionId || !selected || isLive) return;
    if (loaded?.runId === selected.id) return;
    void loadRunEvents(sessionId, selected);
  }, [
    sessionId,
    selected?.id,
    selected?.fromSeq,
    selected?.toSeq,
    isLive,
    loaded?.runId,
    loadRunEvents,
  ]);

  if (!selected) {
    // The run list can arrive a frame after the live stream. Keep Activity
    // usable during that gap by showing the derived live run.
    if (liveDerived) return { run: liveDerived, events: liveEvents, loading: false };
    return { events: [], loading: false };
  }

  if (isLive) {
    const run: HistoryRun = {
      id: selected.id,
      index: selected.index,
      prompt: selected.prompt,
      startedAt: selected.startedAt,
      endedAt: selected.endedAt,
      status: selected.status,
      fromIndex: liveDerived?.fromIndex ?? 0,
      toIndex: liveDerived?.toIndex ?? -1,
      counts: selected.counts,
    };
    return { run, events: liveEvents, loading: false };
  }

  const run: HistoryRun = {
    id: selected.id,
    index: selected.index,
    prompt: selected.prompt,
    startedAt: selected.startedAt,
    endedAt: selected.endedAt,
    status: selected.status,
    fromIndex: 0,
    toIndex: historicalEvents.length - 1,
    counts: selected.counts,
    partial: selected.partial,
  };
  return {
    run,
    events: historicalEvents,
    loading: eventsLoading && historicalEvents.length === 0,
  };
}
