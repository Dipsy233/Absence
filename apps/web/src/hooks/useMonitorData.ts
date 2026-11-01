import { useMemo } from "react";
import type { AbsenceEvent } from "@absence/core";
import { useSelectedRun } from "./useSelectedRun";
import { useLiveItem } from "./useStage";
import { useRunAttention } from "./useRunAttention";
import { activityRowsVersion, memoRunRows } from "../lib/history";
import { renderRun } from "../lib/report";
import { useIsObserved, useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { ActivityRow } from "../types/stage";
import type { Attention, RunFacts, RunReport } from "../types/report";
import type { HistoryRun } from "../types/history";

/**
 * Everything the Monitor draws, derived once per render pass.
 *
 * The expensive part — `buildRunFacts` and the live attention verdict — lives
 * in `useRunAttention` with the same 500ms clamp the chime uses, so a streamed
 * token updates the feed immediately (rows are incremental) while the phase /
 * attention verdict lags by at most half a second.
 */
export interface MonitorData {
  run?: HistoryRun;
  events: AbsenceEvent[];
  loading: boolean;
  /** Feed rows for the selected run, converted incrementally. */
  rows: ActivityRow[];
  facts?: RunFacts;
  /** The finished-run report rendered from the facts, or nothing while live. */
  report?: RunReport;
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

/**
 * One face-neutral aggregation over the selected run.
 *
 * It used to live under `ui/monitor/`, but chart and drip read it too — the
 * hook is the *shared* run view, not Monitor's property, so it sits beside the
 * other hooks. It composes stores and hooks only; it never touches the server.
 */
export function useMonitorData(): MonitorData {
  const { run, events, loading } = useSelectedRun();
  const displayInActivity = useSettingsStore((s) => s.displayInActivity);
  const observed = useIsObserved();
  const status = useSessionStore((s) => s.agent.status);

  // The rule (`settings || observed`): an observed session always shows
  // its process rows, because for a watched agent they are the whole story.
  const showProcessRows = displayInActivity || observed;

  const rows = useMemo(
    () => (run ? memoRunRows(events, run, showProcessRows) : []),
    [events, run, showProcessRows],
  );

  const { facts, attention, headline } = useRunAttention(run, events, status);

  // The finished-run report, rendered once per facts identity — chart and drip
  // both drew `renderRun(facts)` at their tops, so the derivation lives here.
  const report = useMemo(() => (facts ? renderRun(facts) : undefined), [facts]);

  /**
   * What the Stage follows while it is live: the agent's *current action*, not
   * the tail of the feed.
   *
   * This is the rule that makes a finished run rest on
   * a page instead of the last thing it happened to do. `currentAction` is
   * cleared the moment the agent speaks or the run ends (`clearsStage`), so
   * "there is nothing to follow right now" is a state this hook can report — a
   * feed tail can never say that, because the tail of a finished run is still a
   * row. Deriving from the tail is what pinned the centre column to the last
   * activity of every run that had ended.
   *
   * `useLiveItem` is the one shared derivation, so the faces
   * cannot disagree about what "the agent is doing now" means.
   */
  const liveItem = useLiveItem();

  return {
    run,
    events,
    loading,
    rows,
    facts,
    report,
    attention,
    liveHeadline: headline,
    liveEventId: liveItem?.source?.eventId,
    // Read after the rows memo above, so a fold that happened during this
    // render is counted in the version handed out with it.
    rowsVersion: activityRowsVersion(),
  };
}
