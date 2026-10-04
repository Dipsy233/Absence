import type { AgentStatus } from "@daze/core";

/** Mood drives the avatar; v0.3 can feed the same shape to Live2D (read02 §33). */
export type AgentMood = "calm" | "focused" | "confused" | "busy" | "tired" | "happy";

export interface AgentVisualState {
  status: AgentStatus;
  /** Short description of the current action, e.g. "Editing auth.ts". */
  action?: string;
  mood?: AgentMood;
}

export function moodFor(status: AgentStatus): AgentMood {
  switch (status) {
    case "thinking":
    case "reading":
    case "searching":
    case "speaking":
      return "focused";
    case "editing":
    case "running":
      return "busy";
    case "waiting":
      return "tired";
    case "error":
      return "confused";
    case "completed":
      return "happy";
    default:
      return "calm";
  }
}

/** The states shown in the Agent panel legend (read02 §31). */
export const AGENT_STATUSES: AgentStatus[] = [
  "thinking",
  "speaking",
  "reading",
  "searching",
  "editing",
  "running",
  "waiting",
  "error",
  "completed",
];

export function statusLabel(status: AgentStatus): string {
  switch (status) {
    case "idle":
      return "idle";
    case "completed":
      return "done";
    case "error":
      return "confused";
    default:
      return status;
  }
}
