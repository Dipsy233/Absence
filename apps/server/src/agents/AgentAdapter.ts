import {
  createEvent,
  type CapabilityState,
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
  /**
   * Pi's tool allowlist (`ABSENCE_PI_TOOLS`), or undefined to use Pi's own
   * `defaultTools` selection. See `AbsenceConfig.piTools` for why the
   * difference matters to MCP servers with `exposure: "direct"`.
   */
  tools?: string[];
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
  /**
   * The MCP servers and skills this session has. Optional: a runtime with no
   * such concept omits it and the UI hides the panel. Pi reports it from
   * Absence's own discovery (capabilities/discover.ts) plus the tools its
   * extension registered; a live view, not a snapshot taken at start.
   */
  getCapabilities?(): CapabilityState | undefined;
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

  // --- approvals -------------------------------------------------------------
  /**
   * Answer an approval prompt the runtime raised (a `approval` event). The
   * `value` is one of the option values from that event. Resolves once the
   * runtime accepted the decision.
   */
  respondApproval?(id: string, value: string): Promise<void>;
  /** The runtime's current permission/sandbox setting, when it has one. */
  getPermission?(): { level: string; available: string[] };
  /**
   * Change the runtime's permission/sandbox setting for subsequent turns
   * (the sandbox the agent runs in). Returns the applied level.
   */
  setPermission?(level: string): Promise<string>;

  dispose(): void;
}

/** Base class with subscriber plumbing shared by adapters. */
export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly runtime: string;
  protected sessionId = "";
  protected cwd = "";
  private subscribers = new Set<(event: AbsenceEvent) => void>();

  // --- thinking stream coalescing -------------------------------------------
  //
  // Reasoning arrives one token at a time. Emitting a `thinking` event per
  // token floods the session window (MAX_SESSION_EVENTS) with per-character
  // events — one long thought could evict a whole run's history on its own —
  // and gave the Activity panel a row per character. The deltas are folded
  // here instead: the accumulated thought is re-emitted at most once per
  // THINK_EMIT_MS, and `flushThinking()` sends whatever is still held when the
  // thought ends (message_end / agent_end).
  private thinkingAcc = "";
  private thinkingDirty = false;
  private thinkingLastEmit = 0;

  // --- assistant message coalescing -----------------------------------------
  //
  // Text arrives the same way, and the payload carries the *whole message so
  // far*, so one event per token is quadratic in the size of the reply. Fold
  // the deltas here, emit at most once per MESSAGE_EMIT_MS, and let
  // `flushMessage()` send the final non-streaming event. Streaming events are
  // deliberately not archived (see SessionStore.persist): the archive keeps the
  // finished message, not every intermediate prefix of it.
  private messageAcc = "";
  private messageSinceEmit = "";
  private messageDirty = false;
  private messageLastEmit = 0;

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

  /** Clear the thought accumulator (a new message, a new prompt). */
  protected resetThinking(): void {
    this.thinkingAcc = "";
    this.thinkingDirty = false;
    this.thinkingLastEmit = Date.now();
  }

  /** Fold one reasoning delta in, emitting the thought so far at most every THINK_EMIT_MS. */
  protected emitThinkingDelta(delta: string): void {
    this.thinkingAcc += delta;
    this.thinkingDirty = true;
    const now = Date.now();
    if (now - this.thinkingLastEmit < THINK_EMIT_MS) return;
    this.thinkingLastEmit = now;
    this.thinkingDirty = false;
    this.emitAbsence("thinking", { content: this.thinkingAcc, delta, streaming: true });
  }

  /** Emit the tail of a thought the throttle still held, as the final (non-streaming) event. */
  protected flushThinking(): void {
    if (!this.thinkingDirty) return;
    this.thinkingDirty = false;
    this.emitAbsence("thinking", { content: this.thinkingAcc, streaming: false });
  }

  /** Clear the assistant accumulator (a new message, a new prompt). */
  protected resetMessage(): void {
    this.messageAcc = "";
    this.messageSinceEmit = "";
    this.messageDirty = false;
    // The first delta of a reply should appear immediately, not after a
    // throttle window with nothing on screen.
    this.messageLastEmit = 0;
  }

  /** Fold one assistant text delta in, emitting the message so far at most every MESSAGE_EMIT_MS. */
  protected emitMessageDelta(delta: string): void {
    this.messageAcc += delta;
    this.messageSinceEmit += delta;
    this.messageDirty = true;
    const now = Date.now();
    if (now - this.messageLastEmit < MESSAGE_EMIT_MS) return;
    this.messageLastEmit = now;
    this.messageDirty = false;
    const emitted = this.messageSinceEmit;
    this.messageSinceEmit = "";
    this.emitAbsence("message", {
      role: "assistant",
      content: this.messageAcc,
      delta: emitted,
      streaming: true,
    });
  }

  /**
   * Emit the finished assistant message as one non-streaming event.
   *
   * `finalText` is the runtime's authoritative copy when it has one (Pi's
   * `message_end`); without it the accumulated deltas are used (DSH's turn
   * settles without a message-end record). An empty/tool-only turn emits
   * nothing, so no empty chat bubble is appended.
   */
  protected flushMessage(finalText?: string): void {
    if (finalText !== undefined) this.messageAcc = finalText;
    const text = this.messageAcc;
    const shouldEmit = this.messageDirty || text.trim().length > 0;
    this.messageAcc = "";
    this.messageSinceEmit = "";
    this.messageDirty = false;
    this.messageLastEmit = Date.now();
    if (!shouldEmit || text.trim().length === 0) return;
    this.emitAbsence("message", { role: "assistant", content: text, streaming: false });
  }
}

/** How long a thought may grow before it is re-emitted as a `thinking` event. */
const THINK_EMIT_MS = 150;

/** How long an assistant message may grow before it is re-emitted as a `message` event. */
const MESSAGE_EMIT_MS = 100;
