import type { AgentStatus } from "@absence/core";

/** Mood drives the avatar. */
export type AgentMood = "calm" | "focused" | "confused" | "busy" | "tired" | "happy";

export interface AgentVisualState {
  status: AgentStatus;
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
    default:
      return "calm";
  }
}

export function statusLabel(status: AgentStatus): string {
  return status === "error" ? "confused" : status;
}
