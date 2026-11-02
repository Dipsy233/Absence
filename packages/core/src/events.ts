/**
 * AbsenceEvent — the single data structure the whole UI understands.
 *
 * The core UI must never know about Pi. Everything is expressed as a
 * "AbsenceEvent": a description of "what just happened".
 *
 * Note: this union is the read.md §8 list plus three small, documented
 * extensions — `search` (Pi's grep/find/ls, so searching is visible),
 * `file_change` (raw filesystem watcher activity, Phase 5) and `process`
 * (an OS process the agent laid via the shell, v0.3). The payload shape
 * stays flat and simple.
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
  /**
   * The agent did not report a line (`locations.line`). `startLine`/`endLine`
   * are a display fallback (1..content lines), not an asserted range; the UI
   * must say "range unknown" instead of presenting them as precise.
   */
  rangeKnown?: false;
}

export interface FileWritePayload {
  path: string;
  content: string;
}

export interface FileEditPayload {
  path: string;
  /**
   * The path exactly as the agent reported it. `pathRelative` is true when
   * that was a relative path, which Absence preserves instead of inventing an
   * absolute or project-relative one.
   */
  pathRelative?: boolean;
  before: string;
  after: string;
  diff: string;
  /**
   * True when `before`/`after` are the whole file; false when they are only
   * the ACP diff snippet and the whole file could not be reconstructed. The
   * event is still a real edit; consumers must not treat the snippet as the
   * file's complete content. Absent when the caller did not state it.
   */
  fullContent?: boolean;
}

export interface FileChangePayload {
  path: string;
  kind: "created" | "modified" | "deleted";
  /**
   * The change happened outside the project root. The watcher only covers the
   * project, so these are rare — but a small model sometimes edits a file it
   * should not (another project, a temp directory), and that is exactly what a
   * human wants to hear about.
   */
  outside?: boolean;
  /**
   * The OS saw a change the agent already reported through a tool call. It is
   * real evidence, but not a second act: Activity hides it, so one edit does
   * not become two rows.
   */
  echo?: true;
}

export interface CommandPayload {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * False when the protocol did not carry a real exit code (`rawOutput`). `exitCode`
   * is then a status-derived fallback (1 failed / 0 OK), not the exact code —
   * the UI must say "exit code unknown". Absent means the code was reported.
   */
  exitCodeKnown?: false;
  /**
   * The agent referenced a terminal (`terminal/create`) instead of reporting
   * raw output. Carried through verbatim as a reference; Absence does not
   * resolve it, inspect its process, or turn it into an egg.
   */
  terminalId?: string;
  /**
   * The output hit Absence's accumulation cap and the tail is missing. The
   * event is still the real prefix, not a complete result.
   */
  truncated?: true;
  /**
   * The user denied the permission request: the command was never executed.
   * `exitCode`/`exitCodeKnown` are kept for protocol compatibility, but the UI
   * must not present this as a real exit status, and execution counters skip it.
   */
  permissionDenied?: true;
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
  /** How long the tool took, when the adapter knows (a tool-call window). */
  durationMs?: number;
}

/** v0.3: an OS process the agent laid — a shell command's surviving child. */
export interface ProcessPayload {
  pid: number;
  ppid: number;
  /** Executable name, e.g. "node", "npm", "esbuild". */
  name: string;
  commandLine: string;
  status: "running" | "exited";
  /** When Absence first saw it alive — within a second of the real start. */
  startedAt: number;
  exitedAt?: number;
  /**
   * The process's exit code, once it has exited — present only when the OS
   * reported one. An observed agent's command can therefore say whether it
   * failed (`bash -c 'exit 7'`) instead of looking identical to a success,
   * which is what Absence could see before this field existed.
   */
  exitCode?: number;
  /** Descendants rolled into this egg (Absence reports the roots only). */
  children: number;
  /** The shell command that laid it. */
  command?: string;
  /**
   * The daemon's full container id, on a container egg only. Real processes
   * have no such field. The archive keeps it so a resumed session can ask the
   * daemon about the container without re-parsing `commandLine`.
   */
  containerId?: string;
  /**
   * `primary` is a process worth tracking on its own (a daemon, server, script,
   * build root); `tool` is a short-lived helper such as `cat`, `grep` or `sleep`.
   * The UI folds tools into a count instead of listing each one.
   */
  kind?: "primary" | "tool";
  /** Why it was classified that way, for a tooltip. */
  kindReason?: string;
  /**
   * The egg is being retired from the live view: it exited, and the watcher
   * keeps only the most recent finished eggs so a long computer-use session
   * cannot grow the set without bound. Recipients should drop the pid rather
   * than update it. The raw record stays in the archive, and the Report still
   * counts it.
   */
  retired?: true;
}

/**
 * v0.4: a call into an MCP server (`mcp__<server>__<tool>`).
 *
 * MCP calls already arrive as `tool_start`/`tool_end`, but those carry no
 * result and no notion of which server a tool belongs to — so a person watching
 * could not tell an MCP call from a built-in one, nor see what came back. This
 * event is the first-class form: the server and tool names split out, the
 * arguments and result as text, and how it ended.
 *
 * It is emitted *in addition to* the tool events (never instead of them), so
 * pairing, status and the existing Activity rows keep working unchanged.
 */
export interface McpPayload {
  /** The MCP server's name, as configured (`filesystem`). */
  server: string;
  /**
   * The tool as the server names it (`list_directory`), and `namespace` when
   * the server groups its tools (`search_tools`).
   */
  tool: string;
  namespace?: string;
  /** The full tool name the model called: `mcp__<server>__<tool>`. */
  toolName: string;
  /** The call's id, so the Stage card can pair with the tool_start row. */
  toolCallId: string;
  /** The arguments the model passed, as JSON text. */
  args: string;
  /** What the server returned, as text (the model-facing content). */
  result: string;
  /** Structured content, when the server returned any, as JSON text. */
  structured?: string;
  /** False for a successful call; true when the tool reported an error. */
  isError: boolean;
  durationMs?: number;
  /** How the model reached the tool (`direct` / `codemode` / `deferred`). */
  exposure?: string;
}

export interface ErrorPayload {
  message: string;
}

/**
 * One selectable choice on an approval prompt. `value` is what the adapter
 * sends back to the runtime (a decision slug); `label` is what the user reads.
 */
export interface ApprovalOption {
  value: string;
  label: string;
  /** How the button is coloured. */
  tone: "accept" | "accept-session" | "decline" | "cancel";
}

/**
 * A runtime asking the user for permission to do something — the Codex
 * app-server's `item/commandExecution/requestApproval` / `requestApproval`
 * prompts, surfaced as a first-class event.
 *
 * The agent is blocked until one of `options` is answered (see
 * `Session.respondApproval`). The Stage shows `detail` verbatim so the user
 * reads exactly what is being approved, not a paraphrase.
 */
export interface ApprovalPayload {
  /** The runtime's own request id, echoed back when a decision is made. */
  id: string;
  /** What kind of action is under review. */
  kind: "command" | "file_change" | "permissions" | string;
  /** A short title for the card and the Activity row. */
  title: string;
  /** The full request text, shown verbatim on the Stage. */
  detail: string;
  /** Why the runtime is asking (network access, extra write root, …). */
  reason?: string;
  /** The command's working directory, when the request names one. */
  cwd?: string;
  /** The runtime item this prompt belongs to, for pairing with the Stage. */
  itemId?: string;
  /** The choices the user may pick. Never empty. */
  options: ApprovalOption[];
}

/**
 * Maps each event type to its payload shape. Consumers narrow by `type`.
 */
export interface AbsenceEventPayloadMap {
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
  process: ProcessPayload;
  approval: ApprovalPayload;
  mcp: McpPayload;
  error: ErrorPayload;
}

export type AbsenceEventType = keyof AbsenceEventPayloadMap;

export const ABSENCE_EVENT_TYPES = [
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
  "process",
  "approval",
  "mcp",
  "error",
] as const satisfies readonly AbsenceEventType[];

/** Discriminated union of every AbsenceEvent. */
export type AbsenceEvent = {
  [K in AbsenceEventType]: {
    id: string;
    sessionId: string;
    timestamp: number;
    type: K;
    payload: AbsenceEventPayloadMap[K];
  };
}[AbsenceEventType];

/** A AbsenceEvent of a specific type. */
export type AbsenceEventOf<K extends AbsenceEventType> = Extract<AbsenceEvent, { type: K }>;

let counter = 0;

/** Monotonic + random event id, e.g. "evt_8f92c1_17". */
export function newEventId(): string {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `evt_${rand}_${counter}`;
}

/**
 * Create a fully-formed AbsenceEvent for a given type. The payload type is
 * enforced against the event type.
 */
export function createEvent<K extends AbsenceEventType>(
  sessionId: string,
  type: K,
  payload: AbsenceEventPayloadMap[K],
): AbsenceEventOf<K> {
  return {
    id: newEventId(),
    sessionId,
    timestamp: Date.now(),
    type,
    payload,
  } as AbsenceEventOf<K>;
}

/**
 * True for the throttled live view of a value the runtime re-sends in full:
 * `message` / `thinking` with `streaming: true`.
 *
 * These are useful over the socket (the UI redraws the partial text) but are
 * not durable facts: each one carries the whole value so far, so storing every
 * update is quadratic in the size of a reply. The archive stores the final
 * non-streaming event instead. Shared by the writer and the legacy importer so
 * both make the same cut.
 */
export function isStreamingEvent(event: AbsenceEvent): boolean {
  return (
    (event.type === "message" || event.type === "thinking") &&
    event.payload.streaming === true
  );
}

/**
 * How many events one session keeps in memory. The server and the web client
 * must agree: a larger client window than the server's is a lie — the client
 * would cache the tail of an already-truncated stream and quietly show less
 * history than it claims. One constant, one cut.
 *
 * Truncation drops the *oldest* events. Anything folded from the stream for
 * display (the egg list, Activity rows) must therefore be maintained
 * incrementally, or it shrinks as the window slides — see `sessionStore`.
 *
 * The size is a whole-session budget, not a session-tail budget. At 1000 a
 * single long run — a dev server streaming `process` and `file_change` events —
 * filled the window on its own, so History showed the last run or two and the
 * earlier ones were gone. A run's events cannot be summarised away without
 * losing what the Stage, Activity and the Report rebuild from, so the window
 * has to be large enough to hold a real session. 10k events is roughly a few
 * MB of JSON per session in memory, and the archive on disk is unbounded.
 */
export const MAX_SESSION_EVENTS = 10_000;

/**
 * Below this lifetime a process is a helper by *shape* alone: nothing that is
 * a daemon or a build finishes this fast. Measured from the OS start and exit
 * times, so no directory or name list is involved.
 *
 * One standard for "lived only a blink" across Absence — the classifier (an
 * instant `cat` is a tool, not an act) and the web client (an instant search is
 * a blink in the Activity feed, not a row) must agree on it, so it lives here
 * rather than in either app.
 */
export const EPHEMERAL_MS = 300;
