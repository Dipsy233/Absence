/**
 * Shared domain types for Daze. Kept deliberately small for v0.1.
 */
import type { DazeEvent } from "./events";

/** The agent's coarse state — drives the Avatar and status text. */
export type AgentStatus =
  | "listening"
  | "thinking"
  | "speaking"
  | "reading"
  | "searching"
  | "editing"
  | "running"
  | "waiting"
  | "error";

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
  /**
   * How the OS processes the agent lays are being observed. "exact" means the
   * kernel reports each creation and exit (Windows Job Object); "sampled" means
   * Daze polls, which can miss short-lived processes. Absent when monitoring is
   * not in use at all.
   */
  processPrecision?: "exact" | "sampled";
}

/**
 * One row in the persisted session history (GET /api/sessions/history).
 *
 * A row can come from two places and they are merged: DAZE's own events archive
 * (so the Stage, Activity and file history come back) and Pi's session file (so
 * the model's conversation is resumed). Either may be absent.
 */
export interface SessionHistoryEntry {
  /** Stable key for the row. */
  id: string;
  /** DAZE's archive id — resume restores events, files and chat. */
  dazeSessionId?: string;
  /** Pi's session file — resume reconnects the model's conversation. */
  piSessionFile?: string;
  piSessionId?: string;
  projectPath: string;
  projectName: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  firstPrompt?: string;
  runtime: "pi" | "mock" | string;
  /** True when DAZE has an events archive on disk for this session. */
  archived: boolean;
}

/** Content Daze remembers about a file the agent has touched (read.md §26). */
export interface FileState {
  path: string;
  content: string;
  version: number;
  lastRead?: { startLine: number; endLine: number };
  lastModified?: number;
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

/**
 * One selectable choice a chat command offers (the terminal-style palette).
 * Deliberately plain strings — the UI never learns about Pi's `Model` type.
 */
export interface CommandOption {
  /** The value to send back when the option is chosen. */
  value: string;
  label: string;
  description?: string;
  /** True for the currently active option (the active model, the current level). */
  active?: boolean;
}

/** Runtime-agnostic session statistics, surfaced by the `/session` command. */
export interface SessionStatsInfo {
  sessionId: string;
  sessionFile?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsed?: number;
  contextTotal?: number;
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
  tree?: FileTreeNode;
}

/** Response body of GET /api/sessions/:id. */
export interface SessionSnapshot extends SessionRuntimeState {
  currentAction?: DazeEvent;
  files: FileState[];
  chat: ChatMessage[];
  events: DazeEvent[];
}
