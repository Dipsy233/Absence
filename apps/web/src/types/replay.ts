import type { AgentStatus, DazeEvent } from "@daze/core";

/** Reconstructed file contents at a point in time. */
export type FileMap = Record<string, string>;

/** A checkpoint so seek does not replay from the first event (read02 §26–27). */
export interface ReplaySnapshot {
  /** Number of events already applied (events[0..index-1]). */
  index: number;
  timestamp: number;
  files: FileMap;
  agentStatus: AgentStatus;
  /** What the Stage was showing at this point. Without it, a seek that lands on
   *  a snapshot with no later action would show an empty Stage. */
  currentAction?: DazeEvent;
}

/** The state the Stage renders while in replay mode. */
export interface ReplayView {
  files: FileMap;
  agentStatus: AgentStatus;
  currentAction?: DazeEvent;
  appliedIndex: number;
  timestamp: number;
}

export type ReplayStatus = "idle" | "playing" | "paused";

export type ReplaySpeed = 0.25 | 0.5 | 1 | 2 | 5 | 10;

export const REPLAY_SPEEDS: ReplaySpeed[] = [0.25, 0.5, 1, 2, 5, 10];
