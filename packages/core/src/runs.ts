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
}

/**
 * Events that open a run in a session Absence only observes. Everything the OS
 * reports about the agent's work qualifies; a driven runtime opens its run with
 * a user message instead.
 */
export const OBSERVED_OPENING_EVENT_TYPES = new Set<AbsenceEvent["type"]>([
  "process",
  "file_change",
  "file_write",
  "file_edit",
  "file_read",
  "command",
  "search",
  "mcp",
  "tool_start",
  "thinking",
]);

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

/**
 * Whether a window has no driven-runtime marker (`agent_start` / a user
 * message). An observed session opens its runs from activity instead. Shared by
 * the web history builder and the server's legacy run rebuild so both group the
 * same stream the same way.
 */
export function isObservedStream(events: AbsenceEvent[]): boolean {
  for (const event of events) {
    if (event.type === "agent_start") return false;
    if (event.type === "message" && event.payload.role === "user") return false;
  }
  return events.length > 0;
}
