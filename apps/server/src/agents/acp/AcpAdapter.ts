import {
  type AgentCommandInfo,
  type ApprovalOption,
  type AuthMethodInfo,
  type CapabilityState,
  type CommandOption,
  type ContextState,
  type AbsenceEventPayloadMap,
  type AbsenceEventType,
  type SessionStatsInfo,
} from "@absence/core";
import { AcpConnection, AcpRpcError, type AcpConfigOption } from "./AcpConnection";
import { AcpToolMapper, type MappedEvent } from "./AcpToolMapper";
import { resolveTool, textOfToolContent } from "./ToolRules";
import type { AgentProfile } from "./profiles";
import { discoverCapabilities } from "../../capabilities/discover";
import { BaseAdapter, type AdapterOptions, type AgentStartContext, type AgentStartResult } from "../AgentAdapter";

/**
 * The one ACP adapter.
 *
 * Every agent Absence drives speaks Agent Client Protocol; the only thing that
 * differs between them is how you start them. That difference lives in an
 * `AgentProfile` (profiles.ts / AgentCatalog.ts), so this class is generic:
 *
 *   ACP `kind`        → AbsenceEvent
 *   read              → file_read
 *   edit / move/del   → file_edit / file_write / file_change
 *   execute           → command (+ a ProcessWatcher window, so the shell's
 *                       children are attributed to this exact call)
 *   search            → search
 *   fetch (mcp__…)    → mcp
 *   other             → shape rules (toolRules.json), still no agent names
 *
 * Nothing here reads a product's config file, replaces its shell, or interprets
 * its slash commands. Commands go to `session/prompt`; approvals come back
 * through `session/request_permission`; models come from the agent's own
 * `configOptions`. If ACP has it, Absence forwards it; if it does not, Absence
 * does not invent it.
 */
export class AcpAdapter extends BaseAdapter {
  readonly runtime: string;
  private connection?: AcpConnection;
  private acpSessionId?: string;
  private model: string;
  private aborted = false;
  private busy = false;
  private usage?: { used: number; total?: number };
  private mapper?: AcpToolMapper;
  private configOptions?: AcpConfigOption[];
  /** Present only when the profile opted into the shared discovery scan. */
  private capabilities?: CapabilityState;
  private sessionTitle?: string;
  private availableCommands: AgentCommandInfo[] = [];
  private authMethods: AuthMethodInfo[] = [];
  private authRequired = false;
  /** Where a session should be created once `authenticate` succeeds. */
  private pendingSession?: { cwd: string; sessionFile?: string };
  private agentCapabilities: Record<string, unknown> = {};
  /** Rejects the in-flight `session/prompt` when the abort watchdog fires. */
  private forceAbort?: () => void;
  private abortTimer?: NodeJS.Timeout;
  /** Throttled in-progress text per tool call (`tool_update`). */
  private readonly toolUpdates = new Map<string, { at: number; text: string }>();
  /** Tool calls whose permission card was answered with a reject option. */
  private readonly deniedCalls = new Set<string>();
  /** Tool facts per call id, so a bare update still knows what it is updating. */
  private toolFacts = new Map<
    string,
    {
      name: string;
      kind?: string;
      rawInput?: unknown;
      locations?: Array<{ path?: string; line?: number }>;
      content?: unknown;
      rawOutput?: unknown;
    }
  >();
  /** The ProcessWatcher command window each in-flight shell call opened. */
  private commandWindows = new Map<string, number>();
  private pendingApprovals = new Map<string, (value: string) => void>();
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
  }

  async start(ctx: AgentStartContext): Promise<AgentStartResult> {
    this.sessionId = ctx.sessionId;
    this.cwd = ctx.cwd;
    this.mapper = new AcpToolMapper(ctx.cwd);
    // Declare the session before spawning: the agent may lay a process before
    // `session/new` returns, and the watcher filters kernel events by this id.
    this.options.processWatcher?.beginSession(ctx.sessionId);

    const connection = new AcpConnection({
      launch: this.profile.launch,
      cwd: ctx.cwd,
      env: {
        // The marker every shell child inherits, so the watcher can attribute
        // the processes this agent lays to this Absence session.
        ABSENCE_SESSION_ID: ctx.sessionId,
        ...(this.profile.launch.env ?? {}),
      },
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onErrorOutput: () => {
        /* stderr is diagnostics; the ACP stream is the truth */
      },
    });
    this.connection = connection;

    const init = await connection.start();
    this.agentCapabilities = init.agentCapabilities ?? {};
    this.authMethods = normalizeAuthMethods(init.authMethods);

    const session = await this.openSession(ctx.cwd, ctx.sessionFile, connection);
    if (session) {
      this.acpSessionId = session.sessionId;
      this.configOptions = session.configOptions;
      this.model = this.modelFromConfigOptions(session.configOptions) ?? this.profile.label;
    }

    // ACP carries no catalog request, so Absence reads only what the agent
    // itself sends (`mcp__*` tool calls, available_commands). A profile may
    // additionally opt into the shared file scan for its skills/MCP panel;
    // that is a data policy on the profile, not a branch on a product name.
    if (this.profile.discoverCapabilities) this.capabilities = this.discover(this.cwd);
    return { model: this.model };
  }

  getCapabilities(): CapabilityState | undefined {
    return this.capabilities;
  }

  /** The shared cross-runtime scan, mapped to the shape `session_state` carries. */
  private discover(cwd: string): CapabilityState {
    const discovered = discoverCapabilities({ cwd });
    return {
      skills: discovered.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        scope: skill.scope,
      })),
      mcp: discovered.mcpServers.map((server) => ({
        name: server.name,
        type: server.type,
        source: server.source,
        exposure: server.exposure,
        enabled: server.enabled !== false,
        description: server.description,
      })),
      diagnostics: [...discovered.diagnostics],
    };
  }

  getContextUsage(): ContextState | undefined {
    if (!this.usage) return undefined;
    return { used: this.usage.used, total: this.usage.total ?? 0 };
  }

  getSessionFile(): string | undefined {
    return this.acpSessionId;
  }

  getRuntimeSessionId(): string | undefined {
    return this.acpSessionId;
  }

  /** True when the agent advertised a capability in `initialize`. */
  hasAgentCapability(name: string): boolean {
    return this.agentCapabilities[name] === true;
  }

  /** The login methods the agent reported. */
  getAuthMethods(): AuthMethodInfo[] {
    return this.authMethods;
  }

  /** True when a session could not be created until `authenticate` succeeds. */
  isAuthRequired(): boolean {
    return this.authRequired;
  }

  /**
   * Authenticate with one advertised method, then create the deferred session.
   * A failure is wrapped with the method and the agent's message, so the chat
   * shows something actionable instead of leaving the session blocked.
   */
  async authenticate(methodId: string): Promise<void> {
    const connection = this.connection;
    if (!connection) throw new Error(`${this.runtime} is not connected`);
    const method = this.authMethods.find((entry) => entry.id === methodId);
    if (!method) {
      const available = this.authMethods.map((entry) => entry.id).join(", ") || "(none)";
      throw new Error(
        `Unknown authentication method "${methodId}". Available: ${available}.`,
      );
    }
    try {
      await connection.authenticate(methodId);
    } catch (error) {
      throw new Error(`Authentication with "${methodId}" failed: ${errorMessage(error)}`);
    }
    this.authRequired = false;
    const pending = this.pendingSession;
    if (!pending) return;
    const session = await this.openSession(pending.cwd, pending.sessionFile, connection, false);
    if (!session) throw new Error(`${this.runtime} still requires authentication after "${methodId}".`);
    this.acpSessionId = session.sessionId;
    this.configOptions = session.configOptions;
    this.model = this.modelFromConfigOptions(session.configOptions) ?? this.profile.label;
    this.pendingSession = undefined;
    this.options.onStateChange?.();
  }

  private async openSession(
    cwd: string,
    sessionFile: string | undefined,
    connection: AcpConnection,
    deferAuth = true,
  ): Promise<Awaited<ReturnType<AcpConnection["newSession"]>> | undefined> {
    try {
      return sessionFile
        ? await connection.resumeSession(sessionFile, cwd).catch(() => connection.newSession(cwd))
        : await connection.newSession(cwd);
    } catch (error) {
      if (!isAuthRequiredError(error)) throw error;
      if (this.authMethods.length === 0) {
        throw new Error(
          `${this.runtime} requires authentication but advertised no auth methods.`,
        );
      }
      if (!deferAuth) throw error;
      // Keep the connection alive so `/auth <methodId>` can complete the
      // handshake; the adapter reports `authRequired` to the session state.
      this.pendingSession = { cwd, sessionFile };
      this.authRequired = true;
      return undefined;
    }
  }

  /** The `/` commands the agent advertised — the source of the command palette. */
  getAvailableCommands(): AgentCommandInfo[] {
    return this.availableCommands;
  }

  /** The title the agent attached to the session, when it sent one. */
  getSessionName(): string | undefined {
    return this.sessionTitle;
  }

  isBusy(): boolean {
    return this.busy;
  }

  async prompt(text: string): Promise<void> {
    const connection = this.connection;
    const sessionId = this.acpSessionId;
    if (this.authRequired) {
      const methods = this.authMethods.map((method) => method.id).join(", ") || "(none advertised)";
      throw new Error(
        `${this.runtime} requires authentication — run /auth <methodId>. Available: ${methods}.`,
      );
    }
    if (!connection || !sessionId) throw new Error(`${this.runtime} session not started`);
    if (!connection.isAlive()) throw new Error(`${this.runtime} agent has exited`);
    this.aborted = false;
    this.busy = true;
    this.resetMessage();
    this.resetThinking();
    this.stats.userMessages += 1;
    this.emitAbsence("agent_start", { model: this.model });

    let forcedAbort = false;
    const promptPromise = connection.prompt(sessionId, [{ type: "text", text }]);
    const guarded = new Promise<{ stopReason?: string }>((resolve, reject) => {
      this.forceAbort = () => {
        forcedAbort = true;
        reject(new ForceAbortError());
      };
      promptPromise.then(resolve, reject);
    });

    try {
      // Everything goes through session/prompt — including `/` commands, which
      // the agent itself recognises. Absence does not pre-parse them.
      const { stopReason } = await guarded;
      this.flushMessage();
      this.flushThinking();
      this.emitAbsence("agent_end", { reason: stopReasonToReason(stopReason, this.aborted) });
    } catch (error) {
      this.flushMessage();
      this.flushThinking();
      if (forcedAbort || error instanceof ForceAbortError) {
        // The watchdog settled the run because the agent never answered
        // `session/cancel`; do not add an `error` row on top of the abort.
        this.emitAbsence("agent_end", { reason: "aborted" });
      } else {
        this.emitAbsence("error", { message: errorMessage(error) });
        this.emitAbsence("agent_end", { reason: "error" });
      }
    } finally {
      this.clearAbortWatch();
      this.forceAbort = undefined;
      // A turn that ends without a terminal `tool_call_update` (cancel, agent
      // crash) must not leave a command window open: the watcher would keep
      // attributing the next turn's processes to the old command.
      this.closeAllCommandWindows();
      this.toolFacts.clear();
      this.toolUpdates.clear();
      this.deniedCalls.clear();
      this.busy = false;
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    const connection = this.connection;
    if (!connection || !this.acpSessionId) return;
    connection.cancel(this.acpSessionId);
    if (!this.busy || !this.forceAbort) return;
    // A cancelled prompt should settle with `stopReason: cancelled`; some
    // agents never answer. Bound the wait so the UI cannot sit on "running".
    this.clearAbortWatch();
    this.abortTimer = setTimeout(() => {
      this.abortTimer = undefined;
      this.forceAbortNow();
    }, ABORT_TIMEOUT_MS);
  }

  async listModels(): Promise<CommandOption[]> {
    const options = this.modelOptions();
    if (options.length === 0) {
      return [{ value: this.model, label: this.model, description: "reported by the agent", active: true }];
    }
    const current = this.modelFromConfigOptions(this.configOptions);
    return options.map((option) => ({
      value: option.value,
      label: option.name || option.value,
      description: option.group ?? option.description,
      active: option.value === current,
    }));
  }

  async setModel(value: string): Promise<string> {
    const connection = this.connection;
    const sessionId = this.acpSessionId;
    if (!connection || !sessionId) throw new Error(`${this.runtime} session not started`);
    // The option's own id, not the literal "model": ACP lets an agent name it
    // anything (`model`, `model_id`, …) as long as its category is `model`.
    const option = this.configOption("model");
    await this.setConfigOption(option?.id ?? "model", value);
    this.model = humanModelName(value);
    return this.model;
  }

  /**
   * Thought level / approval mode, exactly as the agent exposes them: an ACP
   * config option whose category is `thought_level` or `mode`. When the agent
   * has no such option the method is absent, and the command layer says so —
   * Absence never pretends to own a setting the agent does not have.
   */
  getConfigOption(category: "thought_level" | "mode"): { id: string; level: string; available: string[] } | undefined {
    const option = this.configOption(category);
    if (!option) return undefined;
    return { id: option.id, level: String(option.currentValue ?? ""), available: flattenOptionValues(option) };
  }

  async setConfigOption(id: string, value: string): Promise<void> {
    const connection = this.connection;
    const sessionId = this.acpSessionId;
    if (!connection || !sessionId) throw new Error(`${this.runtime} session not started`);
    const result = await connection.setConfigOption(sessionId, id, value);
    // ACP requires the response to carry the *complete* config state. Take it
    // so a set without a following `config_option_update` is not stale here.
    if (Array.isArray(result)) this.configOptions = result as AcpConfigOption[];
  }

  /**
   * The command surface's thinking / permission commands, answered from the
   * agent's own config options. ACP categories `thought_level` and `mode` are
   * exactly what `/thinking` and `/permission` mean; when an agent does not
   * expose one, the method returns undefined and the command layer says so.
   */
  getThinking(): { level: string; available: string[] } | undefined {
    const option = this.getConfigOption("thought_level");
    return option ? { level: option.level, available: option.available } : undefined;
  }

  async setThinking(level: string): Promise<string> {
    const option = this.getConfigOption("thought_level");
    if (!option) throw new Error(`${this.runtime} has no thought_level config option`);
    await this.setConfigOption(option.id, level);
    return level;
  }

  getPermission(): { level: string; available: string[] } | undefined {
    const option = this.getConfigOption("mode");
    return option ? { level: option.level, available: option.available } : undefined;
  }

  async setPermission(level: string): Promise<string> {
    const option = this.getConfigOption("mode");
    if (!option) throw new Error(`${this.runtime} has no mode config option`);
    await this.setConfigOption(option.id, level);
    return level;
  }

  getSessionStats(): SessionStatsInfo {
    return {
      sessionId: this.acpSessionId ?? this.sessionId,
      userMessages: this.stats.userMessages,
      assistantMessages: this.stats.assistantMessages,
      toolCalls: this.stats.toolCalls,
      tokens: { ...this.stats.tokens, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextUsed: this.usage?.used,
      contextTotal: this.usage?.total,
    };
  }

  async respondApproval(id: string, value: string): Promise<void> {
    this.pendingApprovals.get(id)?.(value);
  }

  dispose(): void {
    this.aborted = true;
    this.clearAbortWatch();
    this.forceAbort?.();
    for (const [, resolve] of this.pendingApprovals) resolve("cancel");
    this.pendingApprovals.clear();
    this.deniedCalls.clear();
    this.closeAllCommandWindows();
    const connection = this.connection;
    const sessionId = this.acpSessionId;
    if (connection && sessionId) void connection.closeSession(sessionId);
    connection?.dispose();
    this.connection = undefined;
    this.acpSessionId = undefined;
  }

  /** Stop the cancel watchdog once the prompt has settled or been torn down. */
  private clearAbortWatch(): void {
    if (this.abortTimer !== undefined) {
      clearTimeout(this.abortTimer);
      this.abortTimer = undefined;
    }
  }

  /** Settle the run as aborted and drop the connection the agent left hanging. */
  private forceAbortNow(): void {
    this.forceAbort?.();
    this.connection?.dispose();
    this.connection = undefined;
    this.acpSessionId = undefined;
    this.closeAllCommandWindows();
  }

  // --------------------------------------------------------------------------

  private onNotification(method: string, params: any): void {
    if (method !== "session/update") return;
    const update = params?.update;
    if (!update || typeof update !== "object") return;
    const emit = <K extends AbsenceEventType>(type: K, payload: AbsenceEventPayloadMap[K]) =>
      this.emitAbsence(type, payload);

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOfContentBlock(update.content);
        if (text.length === 0) break;
        const messageId = String(update.messageId ?? "");
        if (messageId && messageId !== this.countedMessageId) {
          this.countedMessageId = messageId;
          this.stats.assistantMessages += 1;
        }
        this.emitMessageDelta(text);
        break;
      }

      case "agent_thought_chunk": {
        const text = textOfContentBlock(update.content);
        if (text.length === 0) break;
        this.emitThinkingDelta(text);
        break;
      }

      case "tool_call": {
        this.stats.toolCalls += 1;
        const callId = String(update.toolCallId);
        const name = String(update.title ?? update.kind ?? "tool");
        const rawInput = parseRawInput(update.rawInput);
        const facts = {
          toolCallId: callId,
          name,
          kind: update.kind,
          rawInput,
          status: update.status,
          locations: update.locations,
          content: update.content,
          rawOutput: update.rawOutput,
        };
        this.toolFacts.set(callId, {
          name,
          kind: update.kind,
          rawInput,
          locations: update.locations,
          content: update.content,
          rawOutput: update.rawOutput,
        });
        emit("tool_start", { toolCallId: callId, toolName: name, args: rawInput ?? {} });

        // Some agents send a single `tool_call` already marked completed/failed
        // (no update follows). Complete it now instead of leaving a window open
        // until the turn ends.
        if (isTerminalStatus(update.status)) {
          this.completeTool(callId, update, name, rawInput, update.status);
          break;
        }

        // A shell call opens a command window now, so the watcher can attribute
        // the processes it lays to this exact tool call — the same begin/end
        // contract every other runtime path uses.
        const resolved = this.mapper?.resolve(facts);
        if (resolved?.kind === "execute" && resolved.command) {
          const windowId = this.options.processWatcher?.begin(resolved.command, this.cwd);
          if (windowId !== undefined) this.commandWindows.set(callId, windowId);
        }
        break;
      }

      case "tool_call_update": {
        // ACP sends progress updates too (pending → in_progress → completed).
        // Only a terminal status ends the call; treating in_progress as an end
        // would emit two tool_end rows and map a result that has no content yet.
        const callId = String(update.toolCallId);
        const known = this.toolFacts.get(callId);
        const name = String(update.title ?? known?.name ?? "tool");
        const rawInput = parseRawInput(update.rawInput ?? known?.rawInput);
        if (!isTerminalStatus(update.status)) {
          this.emitToolUpdate(callId, name, update, rawInput, update.kind ?? known?.kind);
          break;
        }
        this.completeTool(callId, update, name, rawInput, update.status, update.kind ?? known?.kind, known);
        break;
      }

      case "usage_update": {
        const used = toNumber(update.used);
        const total = toNumber(update.size);
        if (used > 0 || total > 0) this.usage = { used, total: total || undefined };
        break;
      }

      case "config_option_update": {
        if (Array.isArray(update.configOptions)) {
          this.configOptions = update.configOptions as AcpConfigOption[];
          this.options.onStateChange?.();
        }
        break;
      }

      case "available_commands_update": {
        if (Array.isArray(update.availableCommands)) {
          this.availableCommands = update.availableCommands
            .map((entry: any) => ({
              name: String(entry?.name ?? ""),
              description: entry?.description ? String(entry.description) : undefined,
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
        break; // plan, current_mode — not first-class events
    }
  }

  /**
   * In-progress ACP updates carry the text a long-running command has produced.
   * Emit it as `tool_update`, throttled per call; the final `command` event
   * still carries the complete output.
   */
  private emitToolUpdate(
    callId: string,
    name: string,
    update: any,
    rawInput: unknown,
    kind?: string,
  ): void {
    const text = textOfToolContent(update.content) || textOfToolContent(update.rawOutput);
    if (text.length === 0) return;
    const resolved = this.mapper?.resolve({
      toolCallId: callId,
      name,
      kind,
      rawInput,
      status: update.status,
      locations: update.locations,
    });
    if (resolved?.kind !== "execute") return;
    const now = Date.now();
    const previous = this.toolUpdates.get(callId);
    if (previous && now - previous.at < TOOL_UPDATE_MS) {
      previous.text = text;
      return;
    }
    this.toolUpdates.set(callId, { at: now, text });
    this.emitAbsence("tool_update", {
      toolCallId: callId,
      toolName: name,
      // The Stage/Activity only treat this as live command output when it says
      // it is an execute call; other runtimes' tool updates stay untouched.
      partial: { kind: "execute", command: resolved.command ?? "", text },
    });
  }

  private async mapCompleted(facts: Parameters<AcpToolMapper["mapCompleted"]>[0]): Promise<void> {
    const mapper = this.mapper;
    if (!mapper) return;
    try {
      const events = await mapper.mapCompleted(facts);
      for (const event of events) this.emitMapped(event);
    } catch (error) {
      this.emitAbsence("error", { message: errorMessage(error) });
    }
  }

  private emitMapped(event: MappedEvent): void {
    this.emitAbsence(event.type, event.payload as never);
  }

  /** Emit the closing half of a tool call, close its window and map the result. */
  private completeTool(
    callId: string,
    update: any,
    name: string,
    rawInput: unknown,
    status: unknown,
    kind?: string,
    known?: { locations?: Array<{ path?: string; line?: number }>; content?: unknown; rawOutput?: unknown },
  ): void {
    const failed = status === "failed";
    const facts = {
      toolCallId: callId,
      name,
      kind,
      rawInput,
      status: String(status ?? ""),
      // ACP updates carry only changed fields, so a path reported on the
      // initial `tool_call` must survive a terminal update that omits it.
      locations: update.locations ?? known?.locations,
      content: update.content ?? known?.content,
      rawOutput: update.rawOutput ?? known?.rawOutput,
      permissionDenied: this.deniedCalls.has(callId),
    };
    this.closeCommandWindow(callId);
    this.toolUpdates.delete(callId);
    this.deniedCalls.delete(callId);
    this.emitAbsence("tool_end", { toolCallId: callId, toolName: name, isError: failed });
    this.toolFacts.delete(callId);
    // A failed call still produced something (often stderr text): report it
    // as a command/file event rather than dropping the evidence.
    void this.mapCompleted(facts);
  }

  private closeCommandWindow(callId: string): void {
    const windowId = this.commandWindows.get(callId);
    if (windowId === undefined) return;
    this.commandWindows.delete(callId);
    this.options.processWatcher?.end(windowId);
  }

  private closeAllCommandWindows(): void {
    for (const windowId of this.commandWindows.values()) this.options.processWatcher?.end(windowId);
    this.commandWindows.clear();
  }

  /**
   * Answer an agent-to-client request. Permission is the one every agent asks;
   * anything else is refused explicitly so the agent is never left waiting.
   */
  private onRequest(method: string, params: any): unknown | Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return this.requestPermission(params);
      default:
        throw new Error(`unsupported request: ${method}`);
    }
  }

  private requestPermission(params: any): Promise<unknown> {
    const id = `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const toolCall = params?.toolCall ?? {};
    const options = permissionOptions(params?.options);
    const title = String(toolCall.title ?? toolCall.toolCallId ?? "Run a tool");

    // Register the resolver *before* emitting the event: a subscriber may
    // answer synchronously, and an answer that arrives before the map has an
    // entry would be dropped, leaving the agent blocked forever.
    const rawOptions = Array.isArray(params?.options)
      ? (params.options as Array<{ optionId?: string; kind?: string }>)
      : [];
    const callId = toolCall.toolCallId !== undefined ? String(toolCall.toolCallId) : "";
    const answer = new Promise<unknown>((resolve) => {
      this.pendingApprovals.set(id, (value) => {
        this.pendingApprovals.delete(id);
        if (permissionDeniedOption(value, rawOptions) && callId) {
          // The agent will report the call as failed; remembering the answer
          // lets the mapper say "never executed" instead of inferring failure.
          this.deniedCalls.add(callId);
        }
        if (value === "cancel") resolve({ outcome: { outcome: "cancelled" } });
        else resolve({ outcome: { outcome: "selected", optionId: value } });
      });
    });

    this.emitAbsence("approval", {
      id,
      kind: "command",
      title,
      detail: formatToolCallDetail(toolCall),
      itemId: toolCall.toolCallId ? String(toolCall.toolCallId) : undefined,
      options,
    });
    return answer;
  }

  private configOption(id: string): AcpConfigOption | undefined {
    return (this.configOptions ?? []).find((option) => option.id === id || option.category === id);
  }

  private modelFromConfigOptions(options: AcpConfigOption[] | undefined): string | undefined {
    const model = (options ?? []).find((option) => option.id === "model" || option.category === "model");
    if (!model || model.currentValue === undefined) return undefined;
    return humanModelName(String(model.currentValue));
  }

  private modelOptions(): Array<{ value: string; name?: string; description?: string; group?: string }> {
    const model = this.configOption("model");
    if (!model || !Array.isArray(model.options)) return [];
    const out: Array<{ value: string; name?: string; description?: string; group?: string }> = [];
    for (const entry of model.options) {
      if ("value" in entry) out.push({ value: entry.value, name: entry.name, description: entry.description });
      else if ("options" in entry && Array.isArray(entry.options)) {
        for (const inner of entry.options) {
          out.push({ value: inner.value, name: inner.name, description: inner.description, group: entry.name });
        }
      }
    }
    return out;
  }
}

function flattenOptionValues(option: AcpConfigOption): string[] {
  if (!Array.isArray(option.options)) return [];
  const out: string[] = [];
  for (const entry of option.options) {
    if ("value" in entry) out.push(entry.value);
    else if ("options" in entry && Array.isArray(entry.options)) {
      for (const inner of entry.options) out.push(inner.value);
    }
  }
  return out;
}

/** ACP's model value can be a JSON `[provider, model]` pair, or plain text. */
function humanModelName(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2) return `${parsed[0]}/${parsed[1]}`;
  } catch {
    // not JSON; fall through
  }
  return value;
}

/** Map ACP's stopReason to an Absence agent_end reason. */
function stopReasonToReason(stopReason: string | undefined, aborted: boolean): string {
  if (aborted) return "aborted";
  switch (stopReason) {
    case "cancelled":
      return "aborted";
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      return "error";
    default:
      return "completed";
  }
}

/** The choices a permission card offers, from ACP's own options. */
function permissionOptions(options: unknown): ApprovalOption[] {
  const list = Array.isArray(options) ? (options as Array<{ optionId?: string; name?: string; kind?: string }>) : [];
  if (list.length === 0) {
    return [
      { value: "allow-once", label: "Allow once", tone: "accept" },
      { value: "reject-once", label: "Deny", tone: "decline" },
    ];
  }
  return list
    .filter((option) => typeof option.optionId === "string")
    .map((option) => ({
      value: option.optionId as string,
      label: option.name || option.optionId || "Choose",
      tone: toneForAcpKind(option.kind),
    }));
}

function toneForAcpKind(kind: string | undefined): ApprovalOption["tone"] {
  switch (kind) {
    case "allow_once":
      return "accept";
    case "allow_always":
      return "accept-session";
    case "reject_once":
      return "decline";
    case "reject_always":
      return "cancel";
    default:
      return "accept";
  }
}

function formatToolCallDetail(toolCall: any): string {
  const lines: string[] = [];
  if (toolCall.title) lines.push(String(toolCall.title));
  if (toolCall.rawInput !== undefined) {
    lines.push(typeof toolCall.rawInput === "string" ? toolCall.rawInput : JSON.stringify(toolCall.rawInput, null, 2));
  }
  for (const location of (toolCall.locations ?? []) as Array<{ path?: string }>) {
    if (location.path) lines.push(location.path);
  }
  return lines.length > 0 ? lines.join("\n") : "(no detail)";
}

function textOfContentBlock(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  const block = content as { type?: string; text?: unknown };
  if (block.type === "text") return String(block.text ?? "");
  return "";
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** ACP's terminal tool-call statuses. */
function isTerminalStatus(status: unknown): boolean {
  const value = String(status ?? "");
  return value === "completed" || value === "failed";
}

/**
 * Some adapters send `rawInput` as a JSON string rather than an object. Parse it
 * generically so the shape rules see the same fields for every agent.
 */
function parseRawInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{")) return value;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How long the cancel watchdog waits before forcing the turn to settle. */
const ABORT_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.ABSENCE_ACP_ABORT_TIMEOUT_MS) || 10_000,
);

/** How often an in-progress execute call may emit `tool_update`. */
const TOOL_UPDATE_MS = 150;

class ForceAbortError extends Error {
  constructor() {
    super("ACP turn aborted by watchdog");
    this.name = "ForceAbortError";
  }
}

/**
 * ACP's `auth_required` error is not typed in the protocol's JSON-RPC body
 * consistently across agents: some send a message, some put the methods in
 * `data.authMethods`. Accept both, but do not treat an unrelated -32000 as auth.
 */
function isAuthRequiredError(error: unknown): boolean {
  const message = errorMessage(error);
  if (/auth[_ ]?required|authentication required|not authenticated|login required/i.test(message)) {
    return true;
  }
  if (error instanceof AcpRpcError && error.data && typeof error.data === "object") {
    const record = error.data as Record<string, unknown>;
    return Array.isArray(record.authMethods);
  }
  return false;
}

/**
 * Whether the selected permission option means "do not run it". ACP's `kind`
 * is authoritative; the slug fallback covers adapters that omit kind.
 */
function permissionDeniedOption(
  value: string,
  options: Array<{ optionId?: string; kind?: string }>,
): boolean {
  if (value === "cancel" || value === "reject-once" || value === "reject-always") return true;
  const selected = options.find((option) => option.optionId === value);
  return selected?.kind === "reject_once" || selected?.kind === "reject_always";
}

function normalizeAuthMethods(value: unknown): AuthMethodInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) return [];
    return [
      {
        id,
        name: typeof record.name === "string" ? record.name : id,
        ...(typeof record.description === "string"
          ? { description: record.description }
          : {}),
      },
    ];
  });
}

/** Re-exported so a caller can classify without constructing an adapter. */
export { resolveTool };
