import type { AgentStatus, AbsenceEvent } from "@absence/core";
import type { FileMap, ReplaySnapshot, ReplayView } from "../types/replay";
import { STAGE_EVENT_TYPES, isInstantSearch, statusFromEvent } from "./events";

const SNAPSHOT_EVERY = 25;
const SNAPSHOT_INTERVAL_MS = 5000;

/**
 * Apply one event to a mutable file map (read02 §44). Write/edit results are
 * authoritative whole-file contents; a read only seeds a path we know nothing
 * about, because reads return a slice.
 */
export function applyEventToFiles(files: FileMap, event: AbsenceEvent): void {
  switch (event.type) {
    case "file_write":
      files[event.payload.path] = event.payload.content;
      break;
    case "file_edit":
      files[event.payload.path] = event.payload.after;
      break;
    case "file_read":
      if (files[event.payload.path] === undefined) {
        files[event.payload.path] = event.payload.content;
      }
      break;
    case "file_change":
      if (event.payload.kind === "deleted") delete files[event.payload.path];
      break;
    default:
      break;
  }
}

/** Checkpoints every N events or 5 seconds (read02 §27). */
export function buildSnapshots(events: AbsenceEvent[]): ReplaySnapshot[] {
  const first = events[0];
  const snapshots: ReplaySnapshot[] = [
    { index: 0, timestamp: first?.timestamp ?? 0, files: {}, agentStatus: "listening" },
  ];
  if (events.length === 0) return snapshots;

  const files: FileMap = {};
  let status: AgentStatus = "listening";
  let currentAction: AbsenceEvent | undefined;
  let nextByTime = (first?.timestamp ?? 0) + SNAPSHOT_INTERVAL_MS;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    applyEventToFiles(files, event);
    const derived = statusFromEvent(event);
    if (derived) status = derived;
    if (STAGE_EVENT_TYPES.has(event.type) && !isInstantSearch(event)) currentAction = event;

    const byCount = (i + 1) % SNAPSHOT_EVERY === 0;
    const byTime = event.timestamp >= nextByTime;
    if (byCount || byTime) {
      snapshots.push({
        index: i + 1,
        timestamp: event.timestamp,
        files: { ...files },
        agentStatus: status,
        currentAction,
      });
      if (byTime) nextByTime = event.timestamp + SNAPSHOT_INTERVAL_MS;
    }
  }
  return snapshots;
}

/**
 * Reconstruct the world at timestamp `t`: nearest snapshot, then apply the
 * remaining events (read02 §26). Never replays from the very first event.
 */
export function seek(events: AbsenceEvent[], snapshots: ReplaySnapshot[], t: number): ReplayView {
  let snapshot = snapshots[0]!;
  for (const candidate of snapshots) {
    if (candidate.timestamp <= t) snapshot = candidate;
    else break;
  }

  const files: FileMap = { ...snapshot.files };
  let status: AgentStatus = snapshot.agentStatus;
  let currentAction: AbsenceEvent | undefined = snapshot.currentAction;
  let appliedIndex = snapshot.index;

  for (let i = snapshot.index; i < events.length; i++) {
    const event = events[i]!;
    if (event.timestamp > t) break;
    applyEventToFiles(files, event);
    const derived = statusFromEvent(event);
    if (derived) status = derived;
    if (STAGE_EVENT_TYPES.has(event.type) && !isInstantSearch(event)) currentAction = event;
    appliedIndex = i + 1;
  }

  return { files, agentStatus: status, currentAction, appliedIndex, timestamp: t };
}

export function timelineStart(events: AbsenceEvent[]): number {
  return events[0]?.timestamp ?? 0;
}

export function timelineEnd(events: AbsenceEvent[]): number {
  return events[events.length - 1]?.timestamp ?? 0;
}

/**
 * Whether an event opens a moment the Stage can draw.
 *
 * This is the cut `seek` uses for `currentAction` (a stage event, and not an
 * instant search), minus continuations: a streamed thought re-reports as one
 * `thinking` event per token batch, and an egg re-reports on every child-count
 * change. A step means "show me the next thing the agent did", so it lands on
 * the *first* event of each activity and never on a re-report — one press, one
 * new moment on the Stage, instead of two or three presses that only move
 * between the hidden updates in between.
 */
function opensMoment(event: AbsenceEvent, previous: AbsenceEvent | undefined): boolean {
  if (!STAGE_EVENT_TYPES.has(event.type) || isInstantSearch(event)) return false;
  if (event.type === "thinking" && previous?.type === "thinking") return false;
  return true;
}

/** The start of the first activity after `t`, or undefined past the last one. */
export function nextEventTimestamp(events: AbsenceEvent[], t: number): number | undefined {
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.timestamp <= t) continue;
    if (opensMoment(events[i]!, events[i - 1])) return events[i]!.timestamp;
  }
  return undefined;
}

/** The start of the last activity before `t`, or undefined before the first. */
export function prevEventTimestamp(events: AbsenceEvent[], t: number): number | undefined {
  let prev: number | undefined;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.timestamp >= t) break;
    if (opensMoment(event, events[i - 1])) prev = event.timestamp;
  }
  return prev;
}
