import {
  type AbsenceEvent,
  type AgentCapabilitiesSnapshot,
  type AgentCommandInfo,
  type AgentSessionInfo,
  type AgentSessionPort,
  type AgentStartContext,
  type AuthMethodInfo,
  type AuthSnapshot,
  type CommandOption,
  type ConfigOptionSnapshot,
  type ConfigOptionValue,
  type ContextState,
  type MonitorEvent,
  type MonitorFidelity,
  type PermissionAnswer,
  type PromptBlock,
  type SessionStatsInfo,
  type StopReason,
} from "@absence/core";
import { AcpAuth } from "./AcpAuth";
import { AcpConfigOptions, humanModelName } from "./AcpConfigOptions";
import { AcpPermissionBridge, type PermissionPrompt } from "./AcpPermissionBridge";
import { AcpSession } from "./AcpSession";
import type { AgentProfile } from "./profiles";
import { createMonitorBus } from "../../monitor/MonitorBus";
import {
  BaseAdapter,
  type AdapterOptions,
} from "../AgentAdapter";

/**
 * The ACP client's session layer.
 *
 * This class is the compatibility boundary between the generic
 * `AgentSessionPort` (`@absence/core`) and the deprecated `AgentAdapter`
 * interface that the current session store still calls. The port is the real
 * surface: start / prompt / cancel / close / subscribe / capabilities /
 * configOptions / commands / auth / respondPermission. The legacy methods
 * below (text `prompt`, `abort`, `dispose`, `respondApproval`, model helpers)
 * only exist so existing callers compile until P5 removes them; they delegate
 * to the same port and add no new behaviour.
 *
 * Division of labour:
 *
 *   AcpSession           transport, capability-gated session lifecycle, turns,
 *                        prompt-capability trimming, cancel watchdog
 *   AcpPermissionBridge  `session/request_permission` ↔ the UI's answer
 *   AcpAuth              advertised login methods and the deferred session
 *   AcpConfigOptions     the agent's own selectors, refreshed from the agent
 *   AcpMonitorProjector  P3 projection: `session/update` → `MonitorEvent`
 *
 * No product name, private tool vocabulary, `/` command or approval policy
 * lives here. Absence forwards; the agent decides.
 */
export class AcpAdapter extends BaseAdapter implements AgentSessionPort {
  readonly runtime: string;
  private model: string;
  private session?: AcpSession;
  private readonly bus = createMonitorBus();
  private readonly authState = new AcpAuth();
  private readonly config = new AcpConfigOptions();
  private readonly permissions: AcpPermissionBridge;
  private readonly listeners = new Set<(event: AbsenceEvent | MonitorEvent) => void>();
  private usage?: { used: number; total?: number };
  private sessionTitle?: string;
  private availableCommands: AgentCommandInfo[] = [];
  private aborted = false;
  private closed = false;
  private countedMessageId = "";
  private stats = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0, total: 0 },
  };

  constructor(
    private readonly profile: AgentProfile,
    private readonly options: AdapterOptions = {},
  ) {
    super();
    this.runtime = profile.id;
    this.model = profile.label;
    this.permissions = new AcpPermissionBridge({
      onPrompt: (prompt) => this.emitApproval(prompt),
    });
    this.bus.subscribe((event) => this.dispatch(event));
  }

  // --- AgentSessionPort ------------------------------------------------------

  async start(ctx: AgentStartContext): Promise<AgentSessionInfo> {
    this.sessionId = ctx.sessionId;
    this.cwd = ctx.cwd;
    // Declare the session before spawning: the agent may lay a process before
    // `session/new` returns, and the watcher filters kernel events by this id.
    this.options.processWatcher?.beginSession(ctx.sessionId);

    const session = new AcpSession({
      profile: this.profile,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      processWatcher: this.options.processWatcher,
      config: this.config,
      auth: this.authState,
      permissions: this.permissions,
      onStateUpdate: (update) => this.onSessionUpdate(update),
      onProjected: (events) => this.onProjected(events),
      onError: (message) => this.emitAbsence("error", { message }),
    });
    this.session = session;

    try {
      // `sessionFile` is the deprecated legacy spelling of the same handle.
      const { degraded } = await session.start(ctx.resumeHandle ?? ctx.sessionFile);
      this.model = this.config.modelName() ?? this.profile.label;
      const runtimeSessionId = session.sessionId;
      return {
        model: this.model,
        ...(runtimeSessionId !== undefined
          ? { runtimeSessionId, resumeHandle: runtimeSessionId }
          : {}),
        ...(degraded ? { degraded: true } : {}),
      };
    } catch (error) {
      this.session = undefined;
      await session.close();
      throw error;
    }
  }

  prompt(blocks: PromptBlock[]): Promise<StopReason>;
  prompt(text: string): Promise<void>;
  async prompt(input: PromptBlock[] | string): Promise<StopReason | void> {
    const legacy = typeof input === "string";
    const blocks: PromptBlock[] = legacy ? [{ type: "text", text: input }] : input;
    const reason = await this.runTurn(blocks, legacy);
    if (!legacy) return reason;
  }

  /**
   * Answer every pending permission `cancelled`, then send `session/cancel`.
   * The order is a protocol invariant: an agent waiting on a card must be
   * released before it is interrupted.
   */
  async cancel(): Promise<void> {
    this.aborted = true;
    await this.permissions.cancelAll();
    await this.session?.cancelTurn();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.aborted = true;
    // A pending card belongs to the closing turn; release it first.
    await this.permissions.cancelAll();
    const session = this.session;
    this.session = undefined;
    if (session) await session.close();
  }

  override subscribe(listener: (event: AbsenceEvent) => void): () => void;
  override subscribe(listener: (event: MonitorEvent) => void): () => void;
  override subscribe(listener: (event: any) => void): () => void {
    const entry = listener as (event: AbsenceEvent | MonitorEvent) => void;
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  capabilities(): AgentCapabilitiesSnapshot {
    return this.session?.capabilitiesSnapshot() ?? emptyCapabilities();
  }

  configOptions(): ConfigOptionSnapshot[] {
    return this.config.snapshots();
  }

  async setConfigOption(id: string, value: ConfigOptionValue): Promise<void> {
    const session = this.session;
    if (!session) throw new Error(`${this.runtime} session not started`);
    await session.setConfigOption(id, value);
    this.options.onStateChange?.();
  }

  /** The agent's own `/` commands; Absence never adds one of its own. */
  commands(): AgentCommandInfo[] {
    return [...this.availableCommands];
  }

  async authenticate(methodId: string): Promise<void> {
    const session = this.session;
    if (!session) throw new Error(`${this.runtime} is not connected`);
    await session.authenticate(methodId);
    this.model = this.config.modelName() ?? this.profile.label;
    this.options.onStateChange?.();
  }

  async respondPermission(requestId: string, answer: PermissionAnswer): Promise<void> {
    if (!this.permissions.respond(requestId, answer)) {
      throw new Error(`Unknown or already answered permission request "${requestId}".`);
    }
  }

  /** The advertised login methods and whether the session is blocked. */
  auth(): AuthSnapshot {
    return this.authState.snapshot();
  }

  // --- deprecated AgentAdapter compatibility ---------------------------------

  /** `abort` is the legacy name for `cancel`. */
  async abort(): Promise<void> {
    await this.cancel();
  }

  /** Legacy teardown; `close()` awaits `session/close` before dropping the pipe. */
  dispose(): Promise<void> {
    return this.close();
  }

  getContextUsage(): ContextState | undefined {
    if (!this.usage) return undefined;
    return { used: this.usage.used, total: this.usage.total ?? 0 };
  }

  getSessionFile(): string | undefined {
    return this.session?.sessionId;
  }

  getRuntimeSessionId(): string | undefined {
    return this.session?.sessionId;
  }

  getAgentPid(): number | undefined {
    return this.session?.pid;
  }

  getAvailableCommands(): AgentCommandInfo[] {
    return this.commands();
  }

  getSessionName(): string | undefined {
    return this.sessionTitle;
  }

  getAuthMethods(): AuthMethodInfo[] {
    return this.authState.getMethods();
  }

  isAuthRequired(): boolean {
    return this.authState.isRequired;
  }

  isBusy(): boolean {
    return this.session?.isBusy() ?? false;
  }

  /** @deprecated legacy approval answer; the port uses `respondPermission`. */
  async respondApproval(id: string, value: string): Promise<void> {
    this.permissions.respond(
      id,
      value === "cancel"
        ? { outcome: "cancelled" }
        : { outcome: "selected", optionId: value },
    );
  }

  async listModels(): Promise<CommandOption[]> {
    const choices = this.config.modelChoices();
    if (choices.length === 0) {
      return [
        {
          value: this.model,
          label: this.model,
          description: "reported by the agent",
          active: true,
        },
      ];
    }
    const current = this.config.modelName();
    return choices.map((option) => ({
      value: option.value,
      label: option.name || option.value,
      description: option.group ?? option.description,
      active: option.value === current,
    }));
  }

  async setModel(value: string): Promise<string> {
    const option = this.config.find("model");
    await this.setConfigOption(option?.id ?? "model", value);
    this.model = humanModelName(value);
    return this.model;
  }

  getThinking(): { level: string; available: string[] } | undefined {
    const option = this.config.find("thought_level");
    if (!option) return undefined;
    return {
      level: String(option.currentValue ?? ""),
      available: this.config.values("thought_level"),
    };
  }

  async setThinking(level: string): Promise<string> {
    const option = this.config.find("thought_level");
    if (!option) throw new Error(`${this.runtime} has no thought_level config option`);
    await this.setConfigOption(option.id, level);
    return level;
  }

  getPermission(): { level: string; available: string[] } | undefined {
    const option = this.config.find("mode");
    if (!option) return undefined;
    return {
      level: String(option.currentValue ?? ""),
      available: this.config.values("mode"),
    };
  }

  async setPermission(level: string): Promise<string> {
    const option = this.config.find("mode");
    if (!option) throw new Error(`${this.runtime} has no mode config option`);
    await this.setConfigOption(option.id, level);
    return level;
  }

  getSessionStats(): SessionStatsInfo {
    return {
      sessionId: this.session?.sessionId ?? this.sessionId,
      userMessages: this.stats.userMessages,
      assistantMessages: this.stats.assistantMessages,
      toolCalls: this.stats.toolCalls,
      tokens: { ...this.stats.tokens, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextUsed: this.usage?.used,
      contextTotal: this.usage?.total,
    };
  }

  // --------------------------------------------------------------------------

  private async runTurn(
    blocks: PromptBlock[],
    legacy: boolean,
  ): Promise<StopReason | undefined> {
    const session = this.session;
    if (!session) throw new Error(`${this.runtime} session not started`);
    session.ensurePromptable();

    this.aborted = false;
    this.resetMessage();
    this.resetThinking();
    this.stats.userMessages += 1;
    this.emitAbsence("agent_start", { model: this.model });

    try {
      const reason = await session.prompt(blocks);
      this.flushMessage();
      this.flushThinking();
      this.emitAbsence("agent_end", {
        reason: stopReasonToReason(reason, this.aborted),
      });
      return reason;
    } catch (error) {
      this.flushMessage();
      this.flushThinking();
      if (this.aborted) {
        // A watchdog settled the run; do not add an `error` row on top.
        this.emitAbsence("agent_end", { reason: "aborted" });
      } else {
        this.emitAbsence("error", { message: messageOf(error) });
        this.emitAbsence("agent_end", { reason: "error" });
        if (!legacy) throw error;
      }
      return undefined;
    }
  }

  /** Session state the projector does not own (it is not a monitor fact). */
  private onSessionUpdate(update: any): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const messageId = String(update.messageId ?? "");
        if (messageId && messageId !== this.countedMessageId) {
          this.countedMessageId = messageId;
          this.stats.assistantMessages += 1;
        }
        break;
      }

      case "tool_call":
        this.stats.toolCalls += 1;
        break;

      case "usage_update": {
        const used = toNumber(update.used);
        const total = toNumber(update.size);
        if (used > 0 || total > 0) this.usage = { used, total: total || undefined };
        break;
      }

      case "config_option_update": {
        if (this.config.fromUpdate(update)) this.options.onStateChange?.();
        break;
      }

      case "available_commands_update": {
        if (Array.isArray(update.availableCommands)) {
          this.availableCommands = update.availableCommands
            .map((entry: any) => ({
              name: String(entry?.name ?? ""),
              ...(entry?.description ? { description: String(entry.description) } : {}),
            }))
            .filter((entry: { name: string }) => entry.name.length > 0);
          this.options.onStateChange?.();
        }
        break;
      }

      case "session_info_update": {
        if (typeof update.title === "string") {
          this.sessionTitle = update.title;
          this.options.onStateChange?.();
        }
        break;
      }

      default:
        break; // plan / current_mode are projected, not session state
    }
  }

  /**
   * Projector events are already provenance-tagged. Streaming text/thinking
   * still goes through the legacy coalescer so the archive keeps one finished
   * message instead of every prefix; everything else is published untouched.
   */
  private onProjected(events: MonitorEvent[]): void {
    for (const event of events) {
      const payload = event.event.payload as {
        streaming?: boolean;
        delta?: string;
        content?: string;
      };
      if (event.event.type === "message" && payload.streaming === true) {
        this.emitMessageDelta(String(payload.delta ?? payload.content ?? ""));
        continue;
      }
      if (event.event.type === "thinking" && payload.streaming === true) {
        this.emitThinkingDelta(String(payload.delta ?? payload.content ?? ""));
        continue;
      }
      this.bus.publish(event);
    }
  }

  /** Tag an adapter-originated event with the monitor provenance. */
  protected override emit(event: AbsenceEvent): void {
    this.bus.publish({
      sessionId: event.sessionId,
      at: event.timestamp,
      source: "acp",
      fidelity: fidelityOf(event),
      event,
    });
  }

  /**
   * Deliver one monitor fact. The legacy `AgentAdapter` subscriber expects a
   * flat `AbsenceEvent`; the port subscriber expects a `MonitorEvent`. The
   * bridged value carries both, which is the whole point of this class being
   * the deprecated interface's compatibility layer.
   */
  private dispatch(event: MonitorEvent): void {
    const bridged: AbsenceEvent & MonitorEvent = {
      ...event.event,
      at: event.at,
      source: event.source,
      fidelity: event.fidelity,
      event: event.event,
    };
    for (const listener of [...this.listeners]) listener(bridged);
  }

  private emitApproval(prompt: PermissionPrompt): void {
    this.emitAbsence("approval", {
      id: prompt.requestId,
      kind: "command",
      title: prompt.title,
      detail: prompt.detail,
      ...(prompt.itemId !== undefined ? { itemId: prompt.itemId } : {}),
      options: prompt.options,
    });
  }
}

function emptyCapabilities(): AgentCapabilitiesSnapshot {
  return {
    protocolVersion: 0,
    loadSession: false,
    resumeSession: false,
    closeSession: false,
    prompt: { image: false, audio: false, embeddedContext: false },
    auth: { logout: false },
    mcp: { http: false, sse: false },
    source: "acp-client",
  };
}

function fidelityOf(event: AbsenceEvent): MonitorFidelity {
  switch (event.type) {
    case "message":
    case "thinking":
    case "approval":
      return "exact";
    case "agent_start":
      return "inferred";
    case "agent_end":
    case "error":
      return "reported";
    default:
      return "reported";
  }
}

/** Map ACP's stopReason to the legacy `agent_end` reason vocabulary. */
function stopReasonToReason(reason: StopReason, aborted: boolean): string {
  if (aborted || reason === "cancelled") return "aborted";
  switch (reason) {
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      return "error";
    default:
      return "completed";
  }
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
