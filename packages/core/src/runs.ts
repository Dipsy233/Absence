import type { AbsenceEvent } from "./events";

/** What one run did, as History shows it. */
export interface RunCounts {
  read: number;
  search: number;
  edit: number;
  run: number;
  /** Files created during this run. */
  created: number;
}

export type RunStatus = "running" | "completed" | "interrupted" | "error";

/**
 * One run, stored as a summary rather than as the events themselves.
 *
 * `fromSeq`/`toSeq` are the store's sequence numbers, inclusive. History needs
 * only these summaries; the events for a run are fetched when it is selected.
 */
export interface RunSummary {
  /** Stable row id, `run_<index>`. */
  id: string;
  /** 1-based number, shown as "#1". */
  index: number;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  fromSeq: number;
  toSeq: number;
  counts: RunCounts;
  /** The run was reconstructed from a partial event set (legacy import). */
  partial?: boolean;
  /**
   * How many stored events the run spans (`toSeq - fromSeq + 1`), so an outline
   * can size a run — and decide how to page it — without loading its events.
   */
  eventCount?: number;
}

/** One event's contribution to a run's counts. */
export function applyRunCount(
  counts: RunCounts,
  event: AbsenceEvent,
  touched: Set<string>,
): void {
  switch (event.type) {
    case "file_read":
      counts.read += 1;
      touched.add(event.payload.path);
      break;
    case "file_edit":
      counts.edit += 1;
      touched.add(event.payload.path);
      break;
    case "file_write": {
      counts.edit += 1;
      const path = event.payload.path;
      // A write to a path nobody had seen before is a new file.
      if (!touched.has(path)) counts.created += 1;
      touched.add(path);
      break;
    }
    case "file_change":
      if (event.payload.kind === "created") counts.created += 1;
      touched.add(event.payload.path);
      break;
    case "search":
      counts.search += 1;
      break;
    case "command":
      counts.run += 1;
      break;
    default:
      break;
  }
}

/** A fresh all-zero counts object. */
export function emptyRunCounts(): RunCounts {
  return { read: 0, search: 0, edit: 0, run: 0, created: 0 };
}
