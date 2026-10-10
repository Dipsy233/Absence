import {
  createEvent,
  type CommandOption,
  type ContextState,
  type AbsenceEvent,
  type AbsenceEventPayloadMap,
  type AbsenceEventType,
  type SessionStatsInfo,
} from "@absence/core";
import type { ProcessWatcher } from "../process/ProcessWatcher";

/**
 * The runtime-agnostic boundary (read.md §7).
 *
 * Every agent runtime — Pi today, anything later — is reduced to this
 * interface. The rest of Absence only ever sees AbsenceEvent.
 */
export interface AgentStartContext {
  sessionId: string;
  cwd: string;
  model?: string;
  /** The runtime's own session file to resume, when reopening a conversation. */
  sessionFile?: string;
}

export interface AgentStartResult {
  model: string;
  /** True when the requested runtime was unavailable and we degraded. */
  degraded?: boolean;
}

/** Everything an adapter needs from the session that owns it. */
export interface AdapterOptions {
  /** Pi's built-in tool allowlist (`ABSENCE_PI_TOOLS`). */
  tools: string[];
  /**
   * Present when Absence owns the shell (see process/AbsenceShell), so a process the
   * agent leaves running can be reported back as a `process` event.
   */
  processWatcher?: ProcessWatcher;
}

export interface AgentAdapter {
  readonly runtime: string;
  start(ctx: AgentStartContext): Promise<AgentStartResult>;
  /** Resolves when the run finishes (matches Pi's prompt semantics). */
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(fn: (event: AbsenceEvent) => void): () => void;
  /** Context window usage, or undefined when the runtime cannot report it. */
  getContextUsage(): ContextState | undefined;
  /** The runtime's own persisted session file, when it keeps one (Pi does). */
  getSessionFile?(): string | undefined;
  /** The runtime's own session id, when it has one. */
  getRuntimeSessionId?(): string | undefined;

  // --- command surface (the terminal-style chat box) -------------------------
  // All optional: a runtime that cannot do something simply omits it, and the
  // command layer reports that back. DTOs are plain strings, never Pi types.

  /** Models the user could switch to. */
  listModels?(): Promise<CommandOption[]>;
  /**
   * Switch the active model. `value` is the chosen option's value
   * (`"provider/id"`); the adapter resolves it against its own model list, so a
   * provider or model id containing a slash is handled correctly. Returns the
   * new `provider/id`.
   */
  setModel?(value: string): Promise<string>;
  /** Current thinking level and the levels this model supports. */
  getThinking?(): { level: string; available: string[] };
  /** Set the thinking level. Returns the level actually applied. */
  setThinking?(level: string): Promise<string>;
  /** The session's display name, when it has one. */
  getSessionName?(): string | undefined;
  setSessionName?(name: string): void;
  /** Aggregate session statistics. */
  getSessionStats?(): SessionStatsInfo;
  /** Compact the context. Returns token counts before/after the summary. */
  compact?(instructions?: string): Promise<{ tokensBefore?: number; estimatedTokensAfter?: number }>;
  /** Export the session to disk. Returns the absolute path written. */
  exportSession?(format: "html" | "jsonl"): Promise<string>;
  /** True while the runtime is mid-run (mutating commands are refused). */
  isBusy?(): boolean;

  dispose(): void;
}

/** Base class with subscriber plumbing shared by adapters. */
export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly runtime: string;
  protected sessionId = "";
  protected cwd = "";
  private subscribers = new Set<(event: AbsenceEvent) => void>();

  abstract start(ctx: AgentStartContext): Promise<AgentStartResult>;
  abstract prompt(text: string): Promise<void>;
  abstract abort(): Promise<void>;
  abstract getContextUsage(): ContextState | undefined;
  abstract dispose(): void;

  subscribe(fn: (event: AbsenceEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  protected emit(event: AbsenceEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  /** Emit a AbsenceEvent for this session, with the payload type checked. */
  protected emitAbsence<K extends AbsenceEventType>(type: K, payload: AbsenceEventPayloadMap[K]): void {
    this.emit(createEvent(this.sessionId, type, payload));
  }
}
