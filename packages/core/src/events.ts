/**
 * DazeEvent — the single data structure the whole UI understands.
 *
 * The core UI must never know about Pi. Everything is expressed as a
 * "DazeEvent": a description of "what just happened".
 *
 * Note: this union is the read.md §8 list plus one small, documented
 * extension — `file_change` — used to surface raw filesystem watcher
 * activity (Phase 5). The payload shape stays flat and simple.
 */

export interface AgentStartPayload {
  model: string;
}

export interface AgentEndPayload {
  reason: "completed" | "aborted" | "error" | string;
}

export interface MessagePayload {
  role: "user" | "assistant" | "system";
  content: string;
  /** Present while the assistant message is still streaming. */
  delta?: string;
  streaming?: boolean;
}

export interface ThinkingPayload {
  content: string;
  delta?: string;
  streaming?: boolean;
}

export interface ToolStartPayload {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolUpdatePayload {
  toolCallId: string;
  toolName: string;
  partial: unknown;
}

export interface ToolEndPayload {
  toolCallId: string;
  toolName: string;
  isError: boolean;
}

export interface FileReadPayload {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  language?: string;
}

export interface FileWritePayload {
  path: string;
  content: string;
}

export interface FileEditPayload {
  path: string;
  before: string;
  after: string;
  diff: string;
}

export interface FileChangePayload {
  path: string;
  kind: "created" | "modified" | "deleted";
}

export interface CommandPayload {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** v0.2: a search/listing action (Pi's grep / find / ls tools). */
export interface SearchPayload {
  tool: "grep" | "find" | "ls" | string;
  /** The pattern or target being looked for. */
  query: string;
  /** Path scope, when the tool scoped the search. */
  scope?: string;
  /** Number of matching lines or files. */
  matches: number;
  /** Raw result text, truncated. */
  output: string;
}

export interface ErrorPayload {
  message: string;
}

/**
 * Maps each event type to its payload shape. Consumers narrow by `type`.
 */
export interface DazeEventPayloadMap {
  agent_start: AgentStartPayload;
  agent_end: AgentEndPayload;
  message: MessagePayload;
  thinking: ThinkingPayload;
  tool_start: ToolStartPayload;
  tool_update: ToolUpdatePayload;
  tool_end: ToolEndPayload;
  file_read: FileReadPayload;
  file_write: FileWritePayload;
  file_edit: FileEditPayload;
  file_change: FileChangePayload;
  command: CommandPayload;
  search: SearchPayload;
  error: ErrorPayload;
}

export type DazeEventType = keyof DazeEventPayloadMap;

export const DAZE_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "message",
  "thinking",
  "tool_start",
  "tool_update",
  "tool_end",
  "file_read",
  "file_write",
  "file_edit",
  "file_change",
  "command",
  "search",
  "error",
] as const satisfies readonly DazeEventType[];

/** Discriminated union of every DazeEvent. */
export type DazeEvent = {
  [K in DazeEventType]: {
    id: string;
    sessionId: string;
    timestamp: number;
    type: K;
    payload: DazeEventPayloadMap[K];
  };
}[DazeEventType];

/** A DazeEvent of a specific type. */
export type DazeEventOf<K extends DazeEventType> = Extract<DazeEvent, { type: K }>;

let counter = 0;

/** Monotonic + random event id, e.g. "evt_8f92c1_17". */
export function newEventId(): string {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `evt_${rand}_${counter}`;
}

/**
 * Create a fully-formed DazeEvent for a given type. The payload type is
 * enforced against the event type.
 */
export function createEvent<K extends DazeEventType>(
  sessionId: string,
  type: K,
  payload: DazeEventPayloadMap[K],
): DazeEventOf<K> {
  return {
    id: newEventId(),
    sessionId,
    timestamp: Date.now(),
    type,
    payload,
  } as DazeEventOf<K>;
}
