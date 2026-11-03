/**
 * Shared domain types for Absence. Kept deliberately small for v0.1.
 */
import type { AbsenceEvent } from "./events";
import type { MetricsFrame } from "./metrics";
import type { RunSummary } from "./runs";

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
   * How long this session had been open *before* the current visit, in ms.
   *
   * A session is dwell time, not wall time: leaving the project and coming back
   * later must continue the clock rather than restart it or count the hours in
   * between. This is the accrued total; add `openedAt` → now for the live value.
   */
  dwellMs?: number;
  /**
   * When the current visit opened. Absent for a session that is not open (or an
   * older server), in which case the session is not accumulating dwell time.
   */
  openedAt?: number;
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
  /**
   * Historical field names (pre-ACP), kept so old archives keep loading: since
   * v0.5.0 they carry the agent's generic ACP resume handle and its runtime
   * session id — resume reconnects the model's conversation through them.
   */
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

/** One range the agent actually read, as reported by its protocol. */
export interface ObservedRange {
  startLine?: number;
  endLine?: number;
  content: string;
  /** False when no range is known; true when the agent declared one. */
  rangeKnown?: boolean;
}

/** Content Absence remembers about a file the agent has touched (read.md §26). */
export interface FileState {
  path: string;
  /**
   * The last *whole-file* content Absence knows: a write/edit, or a baseline
   * read from disk when the agent only reported a slice. Never the slice itself.
   */
  content: string;
  version: number;
  lastRead?: { startLine?: number; endLine?: number; rangeKnown?: boolean };
  /** What the agent reported reading, kept separately from the whole file. */
  observedRanges?: ObservedRange[];
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
 * Where a session's events come from. Absence owns the child process and
 * drives it through an ACP adapter; `runtime` names the profile so the UI can
 * label the session without hard-coding the supported-agent list.
 */
export type SessionSource = {
  /** Absence owns the child process and drives it through an adapter. */
  kind: "runtime";
  /** `pi` / `codex` / `dsh` / `mock`, or a plugin's name. */
  runtime: string;
};

/** One `/` command the agent itself advertised over ACP. */
export interface AgentCommandInfo {
  name: string;
  description?: string;
}

/** One ACP authentication method advertised during `initialize`. */
export interface AuthMethodInfo {
  id: string;
  name: string;
  description?: string;
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
  /** `/` commands the agent advertised; the palette merges these with Absence's own. */
  agentCommands?: AgentCommandInfo[];
  /** ACP authentication methods, when the agent advertised any. */
  authMethods?: AuthMethodInfo[];
  /** True when the agent requires authentication before a session can be created. */
  authRequired?: boolean;
}

/** Response body of GET /api/sessions/:id. */
export interface SessionSnapshot extends SessionRuntimeState {
  currentAction?: AbsenceEvent;
  files: FileState[];
  chat: ChatMessage[];
  events: AbsenceEvent[];
  /** Persisted process lifecycle events used to restore the Eggs panel. */
  processEvents?: AbsenceEvent[];
  /** Run summaries for History; no event payloads. */
  runs?: RunSummary[];
  /**
   * The newest resource-metric frames, so a client that reconnects has a chart
   * immediately instead of waiting for the next tick. Older frames come from
   * GET /api/sessions/:id/metrics.
   */
  metrics?: MetricsFrame[];
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

/**
 * One forward page of persisted events, oldest → newest (GET /events?after=).
 *
 * `nextAfter` is the cursor for the next newer page: pass it back as `?after=`.
 * It is absent when this page already reaches the newest event. This is the
 * resume/catch-up direction: a client that holds `lastSeq` asks for everything
 * after it instead of re-downloading a whole snapshot.
 */
export interface SessionEventForwardPage {
  events: AbsenceEvent[];
  nextAfter?: number;
  hasMore: boolean;
}

/**
 * Cursor key for GET /api/sessions/history pagination, encoding the sort key
 * (updatedAt) and the id tie-break of the last row of the previous page.
 */
export type SessionHistoryCursor = string;

/** One page of the persisted session history, newest first. */
export interface SessionHistoryPage {
  entries: SessionHistoryEntry[];
  /** Cursor for the next older page; absent when this page is the last one. */
  nextCursor?: SessionHistoryCursor;
  hasMore: boolean;
}

/**
 * Filters for the persisted session history. `search` is a substring match
 * over project name, project path and first prompt; `runtime` is exact;
 * `since`/`until` bound `updatedAt` inclusively.
 */
export interface SessionHistoryQuery {
  /** Exact project path (the original `?path=` filter, kept for compat). */
  path?: string;
  search?: string;
  runtime?: string;
  since?: number;
  until?: number;
  limit?: number;
  cursor?: SessionHistoryCursor;
}
