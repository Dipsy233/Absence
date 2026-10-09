import type { AgentStatus, DazeEvent } from "@daze/core";
import type { FileMap, ReplaySnapshot, ReplayView } from "../types/replay";
import { STAGE_EVENT_TYPES, isInstantSearch, statusFromEvent } from "./events";

const SNAPSHOT_EVERY = 25;
const SNAPSHOT_INTERVAL_MS = 5000;

/**
 * Apply one event to a mutable file map (read02 §44). Write/edit results are
 * authoritative whole-file contents; a read only seeds a path we know nothing
 * about, because reads return a slice.
 */
export function applyEventToFiles(files: FileMap, event: DazeEvent): void {
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
export function buildSnapshots(events: DazeEvent[]): ReplaySnapshot[] {
  const first = events[0];
  const snapshots: ReplaySnapshot[] = [
    { index: 0, timestamp: first?.timestamp ?? 0, files: {}, agentStatus: "listening" },
  ];
  if (events.length === 0) return snapshots;

  const files: FileMap = {};
  let status: AgentStatus = "listening";
  let currentAction: DazeEvent | undefined;
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
export function seek(events: DazeEvent[], snapshots: ReplaySnapshot[], t: number): ReplayView {
  let snapshot = snapshots[0]!;
  for (const candidate of snapshots) {
    if (candidate.timestamp <= t) snapshot = candidate;
    else break;
  }

  const files: FileMap = { ...snapshot.files };
  let status: AgentStatus = snapshot.agentStatus;
  let currentAction: DazeEvent | undefined = snapshot.currentAction;
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

export function timelineStart(events: DazeEvent[]): number {
  return events[0]?.timestamp ?? 0;
}

export function timelineEnd(events: DazeEvent[]): number {
  return events[events.length - 1]?.timestamp ?? 0;
}

export function nextEventTimestamp(events: DazeEvent[], t: number): number | undefined {
  for (const event of events) {
    if (event.timestamp > t) return event.timestamp;
  }
  return undefined;
}

export function prevEventTimestamp(events: DazeEvent[], t: number): number | undefined {
  let prev: number | undefined;
  for (const event of events) {
    if (event.timestamp < t) prev = event.timestamp;
    else break;
  }
  return prev;
}
