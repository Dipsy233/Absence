/**
 * Shared domain types for Daze. Kept deliberately small for v0.1.
 */
import type { DazeEvent } from "./events";

/** The agent's coarse state — drives the Avatar and status text. */
export type AgentStatus =
  | "idle"
  | "thinking"
  | "speaking"
  | "reading"
  | "searching"
  | "editing"
  | "running"
  | "waiting"
  | "error"
  | "completed";

/** True while the agent is actively working (i.e. not settled). */
export function isAgentBusy(status: AgentStatus): boolean {
  return (
    status === "thinking" ||
    status === "speaking" ||
    status === "reading" ||
    status === "searching" ||
    status === "editing" ||
    status === "running" ||
    status === "waiting"
  );
}

export interface Project {
  path: string;
  name: string;
}

/** One open workspace observed by a session (read.md §24). */
export interface Session {
  id: string;
  projectPath: string;
  projectName: string;
  startedAt: number;
  agentRuntime: "pi" | "mock" | string;
  model?: string;
  status: AgentStatus;
  /** True when we fell back to the mock runtime because Pi was unavailable. */
  degraded?: boolean;
}

/** Content Daze remembers about a file the agent has touched (read.md §26). */
export interface FileState {
  path: string;
  content: string;
  version: number;
  lastRead?: { startLine: number; endLine: number };
  lastModified?: number;
}

export interface PlanItem {
  text: string;
  done: boolean;
}

/** Plan is display-only. Daze never becomes the planner (read.md §30). */
export interface Plan {
  title?: string;
  items: PlanItem[];
  source?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  streaming?: boolean;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}

export interface ContextState {
  used: number | null;
  total: number | null;
}

/** The frontend's view of a session (read.md §12). */
export interface DazeState {
  session: Session;
  agent: {
    status: AgentStatus;
    model?: string;
  };
  currentAction?: DazeEvent;
  files: FileState[];
  activity: DazeEvent[];
  plan?: Plan;
  chat: ChatMessage[];
  context?: ContextState;
  tree?: FileTreeNode;
}

/** Subset pushed over the wire when only runtime metadata changed. */
export interface SessionRuntimeState {
  session: Session;
  agent: {
    status: AgentStatus;
    model?: string;
  };
  context?: ContextState;
  plan?: Plan;
  tree?: FileTreeNode;
}

/** Response body of GET /api/sessions/:id. */
export interface SessionSnapshot extends SessionRuntimeState {
  currentAction?: DazeEvent;
  files: FileState[];
  chat: ChatMessage[];
  events: DazeEvent[];
}
