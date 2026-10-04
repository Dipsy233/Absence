import type { DazeEvent } from "@daze/core";
import type { HistoryRun, RunCounts } from "../types/history";

/**
 * Group the event stream into runs (read02-style sessions split by user input).
 * A run starts at a user message and ends at `agent_end`; if a new user message
 * arrives first, the previous run was interrupted.
 */
export function buildHistory(events: DazeEvent[]): HistoryRun[] {
  const runs: HistoryRun[] = [];
  let start: { from: number; prompt: string; startedAt: number } | null = null;

  const flush = (toIndex: number, endedAt: number | undefined, status: HistoryRun["status"]) => {
    if (!start) return;
    runs.push({
      id: `run_${runs.length + 1}`,
      index: runs.length + 1,
      prompt: start.prompt,
      startedAt: start.startedAt,
      endedAt,
      status,
      fromIndex: start.from,
      toIndex,
      counts: countRange(events, start.from, toIndex),
    });
    start = null;
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "message" && event.payload.role === "user") {
      if (start) flush(i - 1, undefined, "interrupted");
      start = { from: i, prompt: event.payload.content, startedAt: event.timestamp };
    } else if (event.type === "agent_end" && start) {
      const reason = String(event.payload.reason);
      flush(i, event.timestamp, reason === "aborted" ? "interrupted" : reason === "error" ? "error" : "completed");
    }
  }

  if (start) flush(events.length - 1, undefined, "running");
  return runs;
}

function countRange(events: DazeEvent[], from: number, to: number): RunCounts {
  const counts: RunCounts = { read: 0, search: 0, edit: 0, run: 0 };
  for (let i = from; i <= to && i < events.length; i++) {
    switch (events[i]!.type) {
      case "file_read":
        counts.read += 1;
        break;
      case "search":
        counts.search += 1;
        break;
      case "file_write":
      case "file_edit":
        counts.edit += 1;
        break;
      case "command":
        counts.run += 1;
        break;
      default:
        break;
    }
  }
  return counts;
}

/** The events belonging to a run. */
export function runEvents(events: DazeEvent[], run: HistoryRun): DazeEvent[] {
  return events.slice(run.fromIndex, run.toIndex + 1);
}

/** The selected run, falling back to the newest one. */
export function pickRun(runs: HistoryRun[], selectedId: string | undefined): HistoryRun | undefined {
  if (selectedId) {
    const found = runs.find((run) => run.id === selectedId);
    if (found) return found;
  }
  return runs[runs.length - 1];
}
