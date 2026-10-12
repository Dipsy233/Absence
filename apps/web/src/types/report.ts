import type { AgentStatus } from "@absence/core";

/**
 * Absence Report — deterministic facts derived from a run's AbsenceEvents.
 *
 * No LLM, no command parsing: the report compresses the Activity the observer
 * already recorded.
 *
 * These are web-side view/derivation types (like types/history.ts and
 * types/replay.ts); the server never computes them.
 */

export type AttentionLevel = "none" | "low" | "medium" | "high";

export type AttentionReason =
  | "command_failed"
  | "command_failure_streak"
  | "activity_stalled"
  | "unresolved_error"
  | "agent_waiting"
  | "agent_stopped"
  | "no_progress"
  | "external_change"
  | "process_left_running"
  | "outside_change"
  | "file_version_loop"
  | "command_retry_loop";

/**
 * A loop the observer saw: the agent repeating itself without effect. Detected
 * purely from the event stream — no LLM, no command parsing.
 */
export interface LoopFact {
  kind: "file_version_loop" | "command_retry_loop";
  /** For file_version_loop: the path whose versions oscillated. */
  path?: string;
  /** For command_retry_loop: the command text that kept failing. */
  command?: string;
  /** How many times the loop closed (versions reverted, failures repeated). */
  count: number;
  evidence: string[];
}

/** A watcher change outside the project root — the agent has no business there. */
export interface OutsideChangeFact {
  path: string;
  count: number;
  evidence: string[];
}

export interface Attention {
  level: AttentionLevel;
  reasons: AttentionReason[];
  /** AbsenceEvent ids that justify the level (for a future "Why?" → Activity jump). */
  evidence: string[];
}

/** A coarse, compressed phase — an interpretation, not a fact (doc §11). */
export type PhaseType = "investigating" | "implementing" | "executing" | "verifying" | "recovering";

export interface Phase {
  type: PhaseType;
  at: number;
  eventId: string;
}

export type CommandStatus = "running" | "success" | "failed" | "unknown";

/** A shell command observed during the run (paired from tool_start/tool_end). */
export interface CommandFact {
  /** The `command` event id, or the `tool_end` id when the tool errored (no command event). */
  eventId: string;
  toolCallId?: string;
  toolName: string;
  command: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  exitCode?: number;
  status: CommandStatus;
  evidence: string[];
}

/** What happened to one file during the run. */
export interface FileFact {
  path: string;
  firstSeenAt: number;
  lastSeenAt: number;
  read: boolean;
  agentWrite: boolean;
  agentEdit: boolean;
  /** Changed by the watcher, not attributable to the agent's own write/edit. */
  externalChange: boolean;
  additions: number;
  deletions: number;
  evidence: string[];
}

/** A process the agent laid during the run (v0.3). */
export interface ProcessFact {
  pid: number;
  name: string;
  commandLine: string;
  /** The shell command that laid it. */
  command?: string;
  startedAt: number;
  exitedAt?: number;
  /** Descendants rolled into it. */
  children: number;
  /** Still running when the run ended. */
  running: boolean;
  /** Primary (tracked) or tool (a helper, folded into a count). */
  kind: "primary" | "tool";
  /** Why it was classified that way. */
  kindReason?: string;
  evidence: string[];
}

/** A failure that was followed by activity and a later successful command (doc §22). */
export interface Recovery {
  failedCommandId: string;
  recoveryEvents: string[];
  successfulCommandId?: string;
  hadEdit: boolean;
}

export type RunOutcome =
  | "completed"
  | "completed_with_warnings"
  | "failed"
  | "stopped"
  | "no_change";

/** What kind of activity a timeline node records. */
export type TimelineKind =
  | "start"
  | "think"
  | "read"
  | "search"
  | "edit"
  | "write"
  | "run"
  | "process"
  | "observe"
  | "error"
  | "end";

/**
 * One node on the run's world line: an activity in the order it happened, plus
 * what it actually caused. The effect is read off the event stream only — a
 * command that started and never ended is "still running", but Absence never
 * parses a command line to guess that it *meant* to start a server.
 */
export interface TimelineNode {
  /** The event behind this node: its evidence link and its Stage content. */
  eventId: string;
  kind: TimelineKind;
  at: number;
  /** Milliseconds from the start of the run (the axis label). */
  offsetMs: number;
  /** Short verb shown on the node. */
  action: string;
  /** The thing acted on: a path, a command, a query, a model. */
  subject: string;
  /** What it caused, in the observer's words. Empty when nothing changed. */
  effects: string[];
}

/** The fact layer: one run reduced to what is true, with no prose. */
export interface RunFacts {
  runId: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;

  files: {
    read: string[];
    /** Agent wrote a path unseen before this run. */
    created: string[];
    /** Agent wrote/edited a path that already existed. */
    modified: string[];
    /** Removed via the watcher (Pi has no delete tool). */
    deleted: string[];
    /** Watcher changes not attributable to the agent. */
    observed: string[];
    byPath: Record<string, FileFact>;
  };

  commands: { total: number; running: number; succeeded: number; failed: number; unknown: number };
  commandFacts: CommandFact[];

  /** The processes the agent laid this run, and how many it left running. */
  processes: { laid: number; runningAtEnd: number; tools: number; byPid: Record<number, ProcessFact> };

  errors: { total: number; unresolved: number; evidence: string[] };

  changes: { additions: number; deletions: number };

  counts: { reads: number; searches: number; edits: number; writes: number };

  /** What the agent learned this run (reads + searches). */
  knowledge: RunKnowledge;

  phases: Phase[];
  currentPhase: PhaseType;
  recoveries: Recovery[];

  /** Repeated self-defeating activity: reverted file versions, retried failures. */
  loops: LoopFact[];

  /** The longest run of back-to-back command failures (the streak warning). */
  failureStreak: { count: number; evidence: string[] };

  /** Watcher changes outside the project root (folded per path). */
  outsideChanges: OutsideChangeFact[];

  /** The run as an ordered world line — the Activity order, with effects. */
  timeline: TimelineNode[];

  attention: Attention;
  outcome: RunOutcome;

  /** The agent's final reply text for this run, if it said anything. */
  response?: string;

  lastActivityAt: number;
  evidence: string[];
}

export interface FileDelta {
  path: string;
  evidence: string[];
}

/** A file the agent inspected (ranges merged across reads of the same path). */
export interface ReadKnowledge {
  path: string;
  startLine: number;
  endLine: number;
  evidence: string[];
}

/** A search / listing the agent ran. */
export interface SearchKnowledge {
  tool: string;
  query: string;
  scope?: string;
  matches: number;
  evidence: string[];
}

export interface RunKnowledge {
  reads: ReadKnowledge[];
  searches: SearchKnowledge[];
}

/** Running view (doc §12). */
export interface LiveReport {
  phase: PhaseType;
  headline: string;
  details: string[];
  progress: { filesRead: number; filesChanged: number; commands: number };
  attention: Attention;
}

/** Completed view (doc §20). */
export interface RunReport {
  runId: string;
  durationMs: number;
  outcome: RunOutcome;
  headline: string;
  /** What the agent learned this run. */
  knows: RunKnowledge;
  changes: {
    created: FileDelta[];
    modified: FileDelta[];
    deleted: FileDelta[];
    observed: FileDelta[];
    additions: number;
    deletions: number;
  };
  /** The commands the agent executed, in order. */
  executions: CommandFact[];
  execution: { commands: number; succeeded: number; failed: number; unknown: number };
  /** The processes the agent laid, in the order it laid them. */
  processes: ProcessFact[];
  /** How many of them were still running when the run ended. */
  processesRunning: number;
  recoveries: Recovery[];
  /** Watcher changes outside the project root. */
  outsideChanges: OutsideChangeFact[];
  loops: LoopFact[];
  failureStreak: { count: number; evidence: string[] };
  attention: Attention;
  /** The run as an ordered world line — the Activity order, with effects. */
  timeline: TimelineNode[];
  /** What the agent said at the end of the run. */
  response?: string;
  evidence: string[];
}

/** `busy`/`status` come from the live session (the event stream cannot say "waiting"). */
export interface RenderLiveOptions {
  busy?: boolean;
  status?: AgentStatus;
  /** The current clock, so the live view can flag a stalled run. */
  nowMs?: number;
}

/**
 * How loudly failed commands should ring the human-attention bell. The report
 * only raises the `command_failed` reason once at least `commandFailThreshold`
 * commands have failed in the run, and then only to `commandFailLevel`.
 * Defaults live in the settings store (5, "low"); "none" silences the reason.
 */
export interface ReportAttentionOptions {
  commandFailThreshold?: number;
  commandFailLevel?: AttentionLevel;
  /** How many commands must fail *in a row* before the streak warning fires. */
  commandStreakThreshold?: number;
  /** The attention level a failure-streak warning raises. */
  commandStreakLevel?: AttentionLevel;
  /** How long (seconds) the agent may sit on one action before the stall warning fires. */
  activityStallThreshold?: number;
  /** The attention level a stall warning raises. */
  activityStallLevel?: AttentionLevel;
}
