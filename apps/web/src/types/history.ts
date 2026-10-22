import type { AbsenceEvent, RunCounts } from "@absence/core";

export type { RunCounts } from "@absence/core";

/**
 * One "run": from the user's prompt until the agent finished replying or the
 * user interrupted it. Each run is the unit of History and of Replay.
 */
export interface HistoryRun {
  id: string;
  /** 1-based number, shown as "#1". */
  index: number;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "completed" | "interrupted" | "error";
  /** Index range into the event array, inclusive. */
  fromIndex: number;
  toIndex: number;
  counts: RunCounts;
  /**
   * The run's start slid out of the event window, so only part of its events
   * are available. The row stays — History is a log, and dropping a run for
   * being old is how the panel came to show only the newest one — but its
   * counts and Stage content are partial. See `rebase` in lib/history.
   */
  partial?: boolean;
}

export type { AbsenceEvent };
