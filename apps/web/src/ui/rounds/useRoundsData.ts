import { useMemo } from "react";
import type { AgentStatus } from "@absence/core";
import { countEggs } from "../../lib/eggs";
import { activityRowsVersion, memoRunRows } from "../../lib/history";
import { useSelectedRun } from "../../hooks/useSelectedRun";
import { useRunAttention } from "../../hooks/useRunAttention";
import { useStageView } from "../../hooks/useStage";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useFileStore } from "../../stores/fileStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { ActivityRow, StageItem, StageMode } from "../../types/stage";
import type { Attention } from "../../types/report";

/**
 * Everything the Rounds face draws, derived once per render pass.
 *
 * The same discipline as Monitor's `useMonitorData`: one derivation, shared
 * pure libraries (`memoRunRows`, the stores), no second source of truth — and
 * no server coupling, because everything here is already pushed over the one
 * session socket and the existing REST endpoints.
 *
 * Rounds reads a *narrative* off that data: the scene needs one "what is it
 * doing now" sentence, the peek needs the file the agent is in and how far
 * through it, the story needs the run's steps as cards. None of that is state;
 * all of it is this pass.
 */
export interface RoundsData {
  run?: ReturnType<typeof useSelectedRun>["run"];
  events: Awaited<ReturnType<typeof useSelectedRun>>["events"];
  loading: boolean;
  /** Feed rows for the selected run, converted incrementally. */
  rows: ActivityRow[];
  /** A real version over `rows` (see memoRunRows' mutation counter). */
  rowsVersion: number;
  /** What the Stage column is showing right now (live, pinned, or replay). */
  item?: StageItem;
  /** Live, pinned, or replay — the reader's chosen view of the Stage. */
  mode: StageMode;
  following: boolean;
  /** The agent's own status (listening, reading, …). */
  status: AgentStatus;
  /** The file the agent is looking at: the live view, else the last read. */
  peek?: StageItem;
  /** The run's human-attention verdict — what the notice cards are raised from. */
  attention: Attention;
  /** Counts behind the dock's badges. */
  badges: { folder: number; eggs: number; activity: number };
}

export function useRoundsData(): RoundsData {
  const { run, events, loading } = useSelectedRun();
  const displayInActivity = useSettingsStore((s) => s.displayInActivity);
  const observed = useIsObserved();
  const status = useSessionStore((s) => s.agent.status);
  const eggVersion = useSessionStore((s) => s.eggState.version);
  const files = useFileStore((s) => s.files);
  const { item, following, mode } = useStageView();
  const { attention } = useRunAttention(run, events, status);

  const showProcessRows = displayInActivity || observed;
  const rows = useMemo(
    () => (run ? memoRunRows(events, run, showProcessRows) : []),
    [events, run, showProcessRows],
  );
  const rowsVersion = activityRowsVersion();

  /**
   * The peek: the file the agent is looking at. Live (or replay) that is the
   * current action when it is a read; pinned, the pinned item itself; and when
   * the current action is not a file at all, the run's most recent read — the
   * last thing the agent had open stays on screen instead of an empty panel.
   */
  const peek = useMemo(() => {
    void rowsVersion;
    const asFile = (item: StageItem | undefined) =>
      item && item.payload.kind === "file" ? item : undefined;
    return asFile(item) ?? asFile(lastReadItem(rows));
  }, [item, rows, rowsVersion]);

  const eggsMap = useSessionStore.getState().eggState.eggs;
  const eggCounts = useMemo(() => countEggs(Object.values(eggsMap)), [eggsMap, eggVersion]);
  const folderCount = Object.keys(files).length;

  return {
    run,
    events,
    loading,
    rows,
    rowsVersion,
    item,
    mode,
    following,
    status,
    peek,
    attention,
    badges: { folder: folderCount, eggs: eggCounts.running, activity: rows.length },
  };
}

/** The last read in the run — the fallback peek (see `peek` above). */
function lastReadItem(rows: ActivityRow[]): StageItem | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const item = rows[i]!.stageItem;
    if (item && item.payload.kind === "file") return item;
  }
  return undefined;
}
