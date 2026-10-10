import type { AbsenceEvent } from "@absence/core";

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
}

export interface RunCounts {
  read: number;
  search: number;
  edit: number;
  run: number;
  /** Files created during this run. */
  created: number;
}

export type { AbsenceEvent };
