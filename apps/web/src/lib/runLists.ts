import type { AbsenceEvent } from "@absence/core";
import type { HistoryRun } from "../types/history";

/**
 * The Chart query panel's two listable fact rows, derived from the same event
 * slice the report engine reads (`run.fromIndex`..`run.toIndex`). No pairing
 * cleverness beyond the protocol's own `toolCallId`: a start opens a row, its
 * end closes it; an end whose start fell outside the window still lists.
 *
 * The no-data contract is the report's own: an empty list means "none in this
 * run", and the panel says so — nothing here invents a value.
 */

/** One tool call, in the order the agent started it. */
export interface ToolCallRow {
  /** The start event's id, or the end's when only the end is in the window. */
  eventId: string;
  toolCallId: string;
  toolName: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  isError: boolean;
  /** Started but not (yet) ended inside the window. */
  running: boolean;
  evidence: string[];
}

export function listToolCalls(events: AbsenceEvent[], run: HistoryRun): ToolCallRow[] {
  const slice = events.slice(run.fromIndex, run.toIndex + 1);
  const open = new Map<string, ToolCallRow>();
  const rows: ToolCallRow[] = [];
  for (const event of slice) {
    if (event.type === "tool_start") {
      const { toolCallId, toolName } = event.payload;
      if (!toolCallId || open.has(toolCallId)) continue;
      const row: ToolCallRow = {
        eventId: event.id,
        toolCallId,
        toolName,
        startedAt: event.timestamp,
        isError: false,
        running: true,
        evidence: [event.id],
      };
      open.set(toolCallId, row);
      rows.push(row);
    } else if (event.type === "tool_end") {
      const { toolCallId, toolName, isError } = event.payload;
      const row = open.get(toolCallId);
      if (row) {
        row.endedAt = event.timestamp;
        row.durationMs = Math.max(0, event.timestamp - (row.startedAt ?? event.timestamp));
        row.isError = isError === true;
        row.running = false;
        row.evidence.push(event.id);
      } else {
        rows.push({
          eventId: event.id,
          toolCallId,
          toolName,
          endedAt: event.timestamp,
          isError: isError === true,
          running: false,
          evidence: [event.id],
        });
      }
    }
  }
  return rows;
}

/** One error event, in the order it happened. */
export interface ErrorRow {
  eventId: string;
  message: string;
  at: number;
}

export function listErrors(events: AbsenceEvent[], run: HistoryRun): ErrorRow[] {
  const slice = events.slice(run.fromIndex, run.toIndex + 1);
  const rows: ErrorRow[] = [];
  for (const event of slice) {
    if (event.type !== "error") continue;
    rows.push({ eventId: event.id, message: event.payload.message, at: event.timestamp });
  }
  return rows;
}
