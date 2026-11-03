import {
  createEvent,
  type AgentCapabilitiesSnapshot,
  type AgentCommandInfo,
  type AgentSessionInfo,
  type AgentSessionPort,
  type AgentStartContext as CoreAgentStartContext,
  type AuthMethodInfo,
  type CommandOption,
  type ConfigOptionSnapshot,
  type ConfigOptionValue,
  type ContextState,
  type AbsenceEvent,
  type AbsenceEventPayloadMap,
  type AbsenceEventType,
  type MonitorEvent,
  type MonitorFidelity,
  type MonitorSource,
  type PermissionAnswer,
  type PromptBlock,
  type SessionStatsInfo,
  type StopReason,
} from "@absence/core";
import type { ProcessWatcher } from "../process/ProcessWatcher";

/**
 * The legacy runtime boundary and its bridge to the new port.
 *
 * New code targets `AgentSessionPort` in `@absence/core`. This module is the
 * compatibility shell kept for v0.5.0: `AcpAdapter` (the only production
 * adapter) and `MockAdapter` still implement the legacy interface below, and
 * the SessionStore still talks to them through it. It has no new callers and
 * is scheduled for removal in the next release. The rest of Absence only ever
 * sees AbsenceEvent / MonitorEvent.
 */
/** Re-exported so existing imports keep working; new code uses `resumeHandle`. */
export type AgentStartContext = CoreAgentStartContext;

export interface AgentStartResult {
  model: string;
  /** True when the requested runtime was unavailable and we degraded. */
  degraded?: boolean;
}

/** Everything an adapter needs from the session that owns it. */
export interface AdapterOptions {
  /**
   * Present so a process the agent leaves running can be reported back as a
   * `process` event.
   */
  processWatcher?: ProcessWatcher;
  /**
   * Ask the owning session to push a new `session_state`. ACP updates that are
   * not AbsenceEvents (available commands, config options, auth state) use it
   * so the palette/auth UI does not wait for the next event.
   */
  onStateChange?: () => void;
}

/**
 * @deprecated Legacy adapter surface, kept in v0.5.0 as the compatibility shell
 * behind `AcpAdapter` and `MockAdapter`. It has no new callers and is scheduled
 * for removal in the next release; nothing new may depend on it. New code
 * targets `AgentSessionPort`.
 *
 * An automatic approval policy is a UI preference, not part of the agent
 * contract, and must never move into `AgentSessionPort`.
 */
export interface AgentAdapter {
  readonly runtime: string;
  start(ctx: AgentStartContext): Promise<AgentStartResult>;
  /** Resolves when the run finishes (matches Pi's prompt semantics). */
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(fn: (event: AbsenceEvent) => void): () => void;
  /** Context window usage, or undefined when the runtime cannot report it. */
  getContextUsage(): ContextState | undefined;
  /** The runtime's own persisted session file, when it keeps one. */
  getSessionFile?(): string | undefined;
  /** The runtime's own session id, when it has one. */
  getRuntimeSessionId?(): string | undefined;
  /** The child process Absence spawned for this runtime, when it owns one. */
  getAgentPid?(): number | undefined;

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
  /** Current thinking level and the levels this model supports, when it has one. */
  getThinking?(): { level: string; available: string[] } | undefined;
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

  // --- agent-provided command / auth surface (ACP) --------------------------
  /**
   * `/` commands the agent itself advertised. Absence forwards an advertised
   * command as a prompt unless it owns that name (`/model`, `/thinking`, …).
   */
  getAvailableCommands?(): AgentCommandInfo[];
  /** Authentication methods advertised during the runtime handshake. */
  getAuthMethods?(): AuthMethodInfo[];
  /** True when the agent is blocked on authentication before it can run. */
  isAuthRequired?(): boolean;
  /** Authenticate with one advertised method; resolves once it is usable. */
  authenticate?(methodId: string): Promise<void>;

  // --- approvals -------------------------------------------------------------
  /**
   * Answer an approval prompt the runtime raised (a `approval` event). The
   * `value` is one of the option values from that event. Resolves once the
   * runtime accepted the decision.
   */
  respondApproval?(id: string, value: string): Promise<void>;
  /** The runtime's current permission/sandbox setting, when it has one. */
  getPermission?(): { level: string; available: string[] } | undefined;
  /**
   * Change the runtime's permission/sandbox setting for subsequent turns
   * (the sandbox the agent runs in). Returns the applied level.
   */
  setPermission?(level: string): Promise<string>;

  dispose(): void;
}

/**
 * @deprecated Overrides for the legacy compatibility shim, removed together
 * with `AgentAdapter` in the next release.
 *
 * Optional overrides for the legacy compatibility shim. Everything the legacy
 * interface cannot express (arbitrary config selectors, monitor provenance)
 * is supplied here rather than guessed by the shim.
 */
export interface LegacyAgentPortOptions {
  capabilities?: Partial<AgentCapabilitiesSnapshot>;
  configOptions?: () => ConfigOptionSnapshot[];
  setConfigOption?: (id: string, value: ConfigOptionValue) => Promise<void>;
  monitorSource?: MonitorSource;
  monitorFidelity?: MonitorFidelity;
}

/**
 * @deprecated Bridge kept for v0.5.0 compatibility. It has no production
 * caller — the only adapter is `AcpAdapter`, which implements
 * `AgentSessionPort` natively — and is scheduled for removal in the next
 * release. Nothing new may call it.
 *
 * Minimal legacy → `AgentSessionPort` shim.
 *
 * The shim owns no runtime semantics: it forwards text prompts, lifecycle
 * calls and permission answers, and maps the legacy event stream into
 * `MonitorEvent`. It deliberately exposes no automatic approval path — the
 * UI's `PermissionAnswer` is forwarded verbatim.
 */
export function toAgentSessionPort(
  adapter: AgentAdapter,
  options: LegacyAgentPortOptions = {},
): AgentSessionPort {
  const monitorSource = options.monitorSource ?? "legacy";
  const monitorFidelity = options.monitorFidelity ?? "reported";

  const capabilities = (): AgentCapabilitiesSnapshot => {
    const hasSessionHandle = typeof adapter.getSessionFile === "function";
    const base: AgentCapabilitiesSnapshot = {
      protocolVersion: 0,
      loadSession: hasSessionHandle,
      resumeSession: hasSessionHandle,
      closeSession: true,
      prompt: { image: false, audio: false, embeddedContext: false },
      auth: { logout: false },
      mcp: { http: false, sse: false },
      source: "legacy-adapter",
    };
    const override = options.capabilities;
    return {
      ...base,
      ...override,
      prompt: { ...base.prompt, ...(override?.prompt ?? {}) },
      auth: { ...base.auth, ...(override?.auth ?? {}) },
      mcp: { ...base.mcp, ...(override?.mcp ?? {}) },
    };
  };

  return {
    runtime: adapter.runtime,

    async start(ctx) {
      const sessionFile = ctx.resumeHandle ?? ctx.sessionFile;
      const legacyContext: AgentStartContext = {
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        ...(ctx.model !== undefined ? { model: ctx.model } : {}),
        ...(sessionFile !== undefined ? { sessionFile } : {}),
      };
      const result = await adapter.start(legacyContext);
      const runtimeSessionId = adapter.getRuntimeSessionId?.();
      const resumeHandle = adapter.getSessionFile?.();
      return {
        model: result.model,
        ...(result.degraded !== undefined ? { degraded: result.degraded } : {}),
        ...(runtimeSessionId !== undefined ? { runtimeSessionId } : {}),
        ...(resumeHandle !== undefined ? { resumeHandle } : {}),
      };
    },

    async prompt(blocks) {
      await adapter.prompt(promptText(blocks));
      // The legacy contract has no StopReason; a resolved prompt is a turn end.
      return "end_turn";
    },

    cancel: () => adapter.abort(),
    close: async () => {
      adapter.dispose();
    },

    subscribe(listener) {
      return adapter.subscribe((event) => {
        const monitorEvent: MonitorEvent = {
          sessionId: event.sessionId,
          at: event.timestamp,
          source: monitorSource,
          fidelity: monitorFidelity,
          event,
        };
        listener(monitorEvent);
      });
    },

    capabilities,
    configOptions: () => options.configOptions?.() ?? [],
    async setConfigOption(id, value) {
      if (!options.setConfigOption) {
        throw new Error(
          `legacy adapter "${adapter.runtime}" cannot set config option "${id}"`,
        );
      }
      await options.setConfigOption(id, value);
    },

    commands: () => adapter.getAvailableCommands?.() ?? [],
    auth: () => ({
      required: adapter.isAuthRequired?.() === true,
      methods: adapter.getAuthMethods?.() ?? [],
    }),

    async authenticate(methodId) {
      if (!adapter.authenticate) {
        throw new Error(`legacy adapter "${adapter.runtime}" cannot authenticate`);
      }
      await adapter.authenticate(methodId);
    },

    async respondPermission(requestId, answer) {
      if (!adapter.respondApproval) {
        throw new Error(`legacy adapter "${adapter.runtime}" has no permission bridge`);
      }
      const value: string =
        answer.outcome === "selected" ? answer.optionId : "cancel";
      await adapter.respondApproval(requestId, value);
    },
  };
}

/** Legacy adapters only understand text; refuse a block they would silently drop. */
function promptText(blocks: PromptBlock[]): string {
  if (blocks.some((block) => block.type !== "text")) {
    throw new Error("legacy adapters accept text prompts only");
  }
  return blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");
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
