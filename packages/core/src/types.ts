/**
 * Shared domain types for Absence. Kept deliberately small for v0.1.
 */
import type { AbsenceEvent } from "./events";

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
   * Absence polls, which can miss short-lived processes. Absent when monitoring is
   * not in use at all.
   */
  processPrecision?: "exact" | "sampled";
}

/**
 * One row in the persisted session history (GET /api/sessions/history).
 *
 * A row can come from two places and they are merged: ABSENCE's own events archive
 * (so the Stage, Activity and file history come back) and Pi's session file (so
 * the model's conversation is resumed). Either may be absent.
 */
export interface SessionHistoryEntry {
  /** Stable key for the row. */
  id: string;
  /** ABSENCE's archive id — resume restores events, files and chat. */
  absenceSessionId?: string;
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
  /** True when ABSENCE has an events archive on disk for this session. */
  archived: boolean;
}

/** Content Absence remembers about a file the agent has touched (read.md §26). */
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
export interface AbsenceState {
  session: Session;
  agent: {
    status: AgentStatus;
    model?: string;
  };
  currentAction?: AbsenceEvent;
  files: FileState[];
  activity: AbsenceEvent[];
  chat: ChatMessage[];
  context?: ContextState;
  tree?: FileTreeNode;
}

/**
 * Where a session's events come from — the single field the UI uses to decide
 * how much of itself to offer.
 *
 * Absence is an observer first. A runtime it *drives* (`pi`, `codex`, `dsh`)
 * can also be asked to do things: send a prompt, answer an approval, switch a
 * model. A runtime it merely *watches* cannot — it is somebody else's process,
 * and pretending otherwise is how a viewer becomes an intrusive client.
 *
 * The distinction is deliberately not `runtime === "..."`: that would put the
 * list of supported agents back into the UI, which is exactly the coupling this
 * field exists to remove. `observe` works for any agent, at any version, with
 * no adapter at all (see docs/decoupling.md).
 */
export type SessionSource =
  | {
      /** Absence owns the child process and drives it through an adapter. */
      kind: "runtime";
      /** `pi` / `codex` / `dsh` / `mock`, or a plugin's name. */
      runtime: string;
    }
  | {
      /** Absence only watches an agent that somebody else started. */
      kind: "observe";
      /** The root process whose subtree is the agent's work. */
      targetPid: number;
      /** Human label for the observed agent (`pi`, `node app.js`, a pid). */
      label: string;
    };

/** The subset of a session the UI checks before offering an action. */
export function canDriveSession(source: SessionSource | undefined): boolean {
  // An older server that does not send `source` was always a driven runtime.
  return source === undefined || source.kind === "runtime";
}

/** Subset pushed over the wire when only runtime metadata changed. */
export interface SessionRuntimeState {
  session: Session;
  agent: {
    status: AgentStatus;
    model?: string;
  };
  /** Where the events come from. Absent from an older server: treat as driven. */
  source?: SessionSource;
  context?: ContextState;
  tree?: FileTreeNode;
  /**
   * The MCP servers and skills the runtime has (or could have). Optional:
   * a runtime that reports neither omits it, and the UI hides the panel.
   */
  capabilities?: CapabilityState;
}

/** One skill the runtime can load (a directory with a SKILL.md). */
export interface SkillInfo {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md. */
  filePath: string;
  /** `user` (home) or `project` (inside the session's workspace). */
  scope: string;
}

/** One MCP server, however the runtime reaches it. */
export interface McpServerInfo {
  name: string;
  /** `stdio` (a spawned process) or `http` (streamable HTTP). */
  type: string;
  /** Which config defined it: user, project, or another runtime's own file. */
  source?: string;
  /** How its tools reach the model (`codemode` / `deferred` / `direct` / `hidden`). */
  exposure?: string;
  enabled: boolean;
  description?: string;
  /** True once the runtime connected the server and registered its tools. */
  connected?: boolean;
  /** How many `mcp__<server>__*` tools the runtime registered. */
  toolCount?: number;
  /**
   * True when those tools are declared to the model directly (exposure
   * `direct`). A connected server with `declared: false` is reachable through
   * codemode or tool_search instead — connected, but not in the model's tool
   * list. Undefined when the runtime does not distinguish the two.
   */
  declared?: boolean;
}

/** What a session *can* do beyond its built-in tools: MCP servers and skills. */
export interface CapabilityState {
  skills: SkillInfo[];
  mcp: McpServerInfo[];
  /** Config problems worth telling the user about (bad entry, unreadable skill). */
  diagnostics: Array<{ type: string; message: string; path?: string }>;
}

/** Response body of GET /api/sessions/:id. */
export interface SessionSnapshot extends SessionRuntimeState {
  currentAction?: AbsenceEvent;
  files: FileState[];
  chat: ChatMessage[];
  events: AbsenceEvent[];
}

/**
 * One page of persisted events, oldest → newest.
 *
 * `nextBefore` is the cursor for the next older page: pass it back as
 * `?before=`. It is absent when this page already starts at the oldest event.
 */
export interface SessionEventPage {
  events: AbsenceEvent[];
  nextBefore?: number;
  hasMore: boolean;
}
