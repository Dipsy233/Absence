import path from "node:path";
import {
  type ApprovalOption,
  type CapabilityState,
  type CommandOption,
  type ContextState,
  type AbsenceEventPayloadMap,
  type AbsenceEventType,
  type SessionStatsInfo,
} from "@absence/core";
import { AppServerClient, type ThreadInfo, type AppServerModel } from "./AppServerClient";
import { BaseAdapter, type AdapterOptions, type AgentStartContext, type AgentStartResult } from "./AgentAdapter";
import { commandActionsFromItem, parseReadCommand } from "./CodexCommands";
import { unwrapCommandText } from "../process/CodexShell";
import { CodexExecServer } from "../process/ExecServer";
import { readFileSafe } from "../filesystem/FileTree";
import { config } from "../config";
import { discoverCapabilities } from "../capabilities/discover";
import { languageFromPath } from "../util/language";
import { toPosix } from "../util/paths";

/**
 * Drives Codex through `codex app-server` — the JSON-RPC channel Codex
 * defines for exactly this kind of observer.
 *
 * Why not the official SDK (`codex exec --json`): that transport regenerates
 * item ids and drops call ids and real timestamps, so a command's true
 * lifecycle cannot be paired with the processes it lays. The app-server
 * protocol carries, per command item:
 *
 *   item/started   { startedAtMs, item: { id, command, cwd, processId } }
 *   item/completed { completedAtMs, item: { ... same id, exit_code } }
 *
 * The startedAtMs/completedAtMs pair is what drives ProcessWatcher's command
 * windows (the Codex counterpart of Pi's pre-spawn begin()), and the env
 * marker below (shell_environment_policy.set) is what tags every process the
 * command tree lays with the Absence session.
 */
export class CodexAdapter extends BaseAdapter {
  readonly runtime = "codex";
  private client?: AppServerClient;
  private thread?: ThreadInfo;
  private model = "codex";
  private aborted = false;
  private busy = false;
  /** The turn currently streaming, for interrupt. */
  private activeTurnId?: string;
  private usage?: { used: number };
  private threadName?: string;
  /** Skills and MCP servers for this thread (see warmCapabilities). */
  private capabilities?: CapabilityState;
  /**
   * The `effort` currently applied to this thread. Seeded from the configured
   * model's default, then kept in sync by setThinking.
   */
  private effort?: string;
  /** Last `model/list` payload, keyed by slug — for getThinking's options. */
  private modelCatalog?: Map<string, AppServerModel>;
  /** The sandbox this thread runs in, echoed by getPermission and changed by setPermission. */
  private sandbox = config.codexSandbox;
  /** Approval prompts waiting for a user decision, keyed by the event id. */
  private pendingApprovals = new Map<string, (value: string) => void>();
  /**
   * Absence's own exec-server, when it took over Codex's shell. Codex hands
   * every command to it (see `CodexExecServer`), so Absence spawns the process
   * itself and is not at the mercy of a job escape or a lost exit message.
   */
  private execServer?: CodexExecServer;
  /** The environment id the thread is pinned to, when the takeover is on. */
  private environmentId?: string;
  private stats = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0, total: 0 },
  };

  constructor(private readonly options: AdapterOptions) {
    super();
  }

  async start(ctx: AgentStartContext): Promise<AgentStartResult> {
    this.sessionId = ctx.sessionId;
    this.cwd = ctx.cwd;

    this.client = new AppServerClient({
      cwd: ctx.cwd,
      // A path configured from the picker (or ABSENCE_CODEX_BIN) overrides the
      // package-resolved default inside AppServerClient.
      codexEntry: config.codexBin,
      env: {
        ...process.env,
        // Straight into the server's own env: thread/start's `config` map
        // carries it the rest of the way (below), and this covers anything
        // the server spawns outside a thread's shell policy.
        ABSENCE_SESSION_ID: ctx.sessionId,
      },
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onErrorOutput: () => {
        /* stderr is diagnostics; the event stream is the truth */
      },
    });
    await this.client.start();

    // Take over the shell before the thread starts, so the very first turn
    // already runs through Absence. A failure here is not fatal: the session
    // falls back to Codex's own executor and the Job Object observer, exactly
    // as it worked before this hook existed.
    await this.startExecServer(ctx);

    const environments =
      this.environmentId !== undefined ? [{ environmentId: this.environmentId, cwd: ctx.cwd }] : undefined;

    const thread = await this.client.startThread({
      cwd: ctx.cwd,
      resumeThreadId: ctx.sessionFile,
      // The env marker: every shell child Codex spawns inherits this, and
      // agentwatch reads it at process creation (see native/agentwatch).
      config: { shell_environment_policy: { set: { ABSENCE_SESSION_ID: ctx.sessionId } } },
      // Pin the thread to Absence's exec-server (new threads; a resumed thread
      // gets the same environment on its first turn, see prompt()).
      environments,
      // Without an explicit sandbox the app-server runs read-only, and every
      // write the agent attempts stalls on an approval. Match the Codex TUI:
      // workspace-write by default, answered automatically (see onRequest).
      sandbox: this.sandbox,
      approvalPolicy: config.codexApproval,
    });
    this.thread = thread;
    this.options.processWatcher?.beginSession(ctx.sessionId);
    this.model = `${thread.modelProvider}/${thread.model}`;
    // Warm the catalog so /thinking can answer from the active model's own
    // advertised efforts without a round trip. A failure here is harmless:
    // getThinking falls back to the model's configured default.
    await this.warmModelCatalog();
    // Skills and MCP servers: Codex reads the same two file formats Pi does
    // (`~/.codex/skills`, `~/.agents/skills`, `config.toml`'s `mcp_servers`)
    // and exposes both over the app-server it is already speaking. Asking
    // Codex itself beats re-reading its config, because Codex resolves plugin
    // skills and layered config that a file scan cannot see.
    await this.warmCapabilities();
    return { model: this.model };
  }

  /**
   * Ask the app-server for the session's skills (`skills/list`) and MCP
   * servers (`mcpServerStatus/list`). Both requests are best effort: an older
   * Codex that does not know a method answers with a JSON-RPC error, and the
   * fallback is Absence's own discovery over the same files.
   */
  private async warmCapabilities(): Promise<void> {
    if (!this.client) return;
    const discovered = discoverCapabilities({ cwd: this.cwd, codexHome: config.codexHome });
    const skills: CapabilityState["skills"] = discovered.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      scope: skill.scope,
    }));
    const mcp: CapabilityState["mcp"] = discovered.mcpServers.map((server) => ({
      name: server.name,
      type: server.type,
      source: server.source === "codex" ? "codex" : server.source,
      exposure: server.exposure,
      enabled: server.enabled !== false,
      description: server.description,
    }));
    const diagnostics: CapabilityState["diagnostics"] = [...discovered.diagnostics];

    try {
      // `skills/list` wants cwds; the thread's own cwd is the one in play.
      const result = await this.client.requestMethod("skills/list", { cwds: [this.cwd] });
      const entry = Array.isArray(result?.data) ? result.data[0] : undefined;
      if (entry && Array.isArray(entry.skills) && entry.skills.length > 0) {
        skills.length = 0;
        for (const skill of entry.skills as Array<Record<string, unknown>>) {
          if (skill.enabled === false) continue;
          skills.push({
            name: String(skill.name ?? ""),
            description: String(skill.description ?? skill.shortDescription ?? ""),
            filePath: String(skill.path ?? ""),
            scope: String(skill.scope ?? "codex"),
          });
        }
      }
      if (entry && Array.isArray(entry.errors)) {
        for (const error of entry.errors as Array<Record<string, unknown>>) {
          diagnostics.push({
            type: "error",
            message: String(error.message ?? "skill error"),
            path: error.path !== undefined ? String(error.path) : undefined,
          });
        }
      }
    } catch {
      // `skills/list` is newer than some app-server builds; discovery stands.
    }

    try {
      const result = await this.client.requestMethod("mcpServerStatus/list", {
        threadId: this.thread?.threadId,
        detail: "toolsAndAuthOnly",
      });
      const servers = Array.isArray(result?.data) ? (result.data as Array<Record<string, unknown>>) : undefined;
      if (servers && servers.length > 0) {
        mcp.length = 0;
        for (const server of servers) {
          const tools = (server.tools ?? {}) as Record<string, unknown>;
          const status = server.runtimeStatus as Record<string, unknown> | undefined;
          mcp.push({
            name: String(server.name ?? ""),
            type: server.httpOrigin ? "http" : "stdio",
            source: server.pluginId ? "plugin" : "codex",
            enabled: true,
            connected: status?.state === "ready" || status?.connected === true,
            toolCount: Object.keys(tools).length,
          });
        }
      }
    } catch {
      // Same: keep what the file scan found.
    }

    this.capabilities = { skills, mcp, diagnostics };
  }

  /**
   * Re-read skills and MCP server state (`/mcp reconnect`).
   *
   * Codex owns its MCP connections, so Absence asks the app-server again rather
   * than touching a transport it does not hold; a server Codex marked failed is
   * dialled on the next call, which is also how Codex itself behaves.
   */
  async reloadExtensions(): Promise<void> {
    await this.warmCapabilities();
  }

  getCapabilities(): CapabilityState | undefined {
    return this.capabilities;
  }

  /**
   * Start Absence's exec-server and register it, so Codex hands every command
   * to Absence to spawn. Returns quietly (leaving `environmentId` unset, which
   * means "use Codex's own executor") when the takeover is disabled or the
   * app-server refuses the environment.
   */
  private async startExecServer(ctx: AgentStartContext): Promise<void> {
    if (!config.codexExecServer || !this.client) return;
    const server = new CodexExecServer({
      processWatcher: this.options.processWatcher,
      shell: this.shellInfo(),
      // The command is spawned by Absence now, not by Codex's shell policy, so
      // the session marker is injected here instead of through
      // shell_environment_policy. It keeps agentwatch's env-based attribution
      // working for anything the command itself spawns outside our process tree.
      env: { ABSENCE_SESSION_ID: ctx.sessionId },
    });
    try {
      const url = await server.listen();
      const environmentId = `absence-${ctx.sessionId}`;
      await this.client.addEnvironment(environmentId, url);
      this.execServer = server;
      this.environmentId = environmentId;
    } catch {
      // No takeover: fall back to Codex's executor (and the Job Object observer).
      server.close();
      this.execServer = undefined;
      this.environmentId = undefined;
    }
  }

  /** The shell Codex should believe the environment offers, by platform. */
  private shellInfo(): { name: string; path: string } {
    if (process.platform === "win32") return { name: "powershell", path: "pwsh.exe" };
    return { name: "bash", path: "/bin/bash" };
  }

  /** Fetch and cache model/list; swallow failures (the picker degrades). */
  private async warmModelCatalog(): Promise<void> {
    if (!this.client || this.modelCatalog) return;
    try {
      const models = await this.client.listModels();
      this.modelCatalog = new Map(models.map((model) => [model.model, model]));
      this.effort ??= this.defaultEffortFor(this.thread?.model);
    } catch {
      // Provider refused the list; getThinking stays on the config default.
    }
  }

  getContextUsage(): ContextState | undefined {
    if (!this.usage) return undefined;
    return { used: this.usage.used, total: 0 };
  }

  getSessionFile(): string | undefined {
    // The thread id is what thread/resume takes; Codex's rollout path is kept
    // for the session history to display.
    return this.thread?.threadId;
  }

  getRuntimeSessionId(): string | undefined {
    return this.thread?.threadId;
  }

  getSessionName(): string | undefined {
    return this.threadName;
  }

  setSessionName(name: string): void {
    this.threadName = name;
  }

  isBusy(): boolean {
    return this.busy;
  }

  async prompt(text: string): Promise<void> {
    const client = this.client;
    const thread = this.thread;
    if (!client || !thread) throw new Error("Codex thread not started");
    if (!client.isAlive()) throw new Error("codex app-server has exited");
    this.aborted = false;
    this.busy = true;
    this.stats.userMessages += 1;
    this.emitAbsence("agent_start", { model: this.model });
    try {
      const environments =
        this.environmentId !== undefined ? [{ environmentId: this.environmentId, cwd: this.cwd }] : undefined;
      this.activeTurnId = await client.runTurn(thread.threadId, text, environments);
      // Completion arrives as turn/completed / turn/failed notifications,
      // handled in onNotification. This promise only means "accepted".
      await this.waitForTurnEnd();
    } catch (error) {
      this.emitAbsence("error", { message: errorMessage(error) });
      this.emitAbsence("agent_end", { reason: "error" });
    } finally {
      this.busy = false;
      this.activeTurnId = undefined;
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    const client = this.client;
    const thread = this.thread;
    if (!client || !thread || !this.activeTurnId) return;
    try {
      await client.interruptTurn(thread.threadId, this.activeTurnId);
    } catch {
      // The turn may already be over; the notifications settle the state.
    }
  }

  async listModels(): Promise<CommandOption[]> {
    // Codex does expose a model list (`model/list`). When config.toml sets
    // `model_catalog_json` — the way an external switcher injects its catalog —
    // Codex serves that file verbatim, so this list is the final Codex
    // configuration, not the upstream OpenAI catalog. Values are Codex's own
    // slugs (e.g. "hy3"), matching config.toml exactly.
    if (!this.client || !this.thread) {
      return this.currentModelOption();
    }
    try {
      const models = await this.client.listModels();
      this.modelCatalog = new Map(models.map((model) => [model.model, model]));
      this.effort ??= this.defaultEffortFor(this.thread.model);
      const current = this.thread.model;
      if (models.length === 0) return this.currentModelOption();
      return models.map((model) => ({
        value: model.model,
        label: model.displayName || model.model,
        description: model.description || this.thread?.modelProvider,
        active: model.model === current,
      }));
    } catch {
      // A gateway-managed provider can refuse model/list; keep the picker
      // honest by reporting the configured model alone.
      return this.currentModelOption();
    }
  }

  /** Switch the model for subsequent turns (slug, matching config.toml). */
  async setModel(value: string): Promise<string> {
    const client = this.client;
    const thread = this.thread;
    if (!client || !thread) throw new Error("Codex thread not started");
    await client.updateThreadSettings(thread.threadId, { model: value });
    thread.model = value;
    this.model = `${thread.modelProvider}/${value}`;
    // Each model advertises its own efforts; follow the newly selected one.
    this.effort = this.defaultEffortFor(value);
    return value;
  }

  /**
   * Codex's reasoning effort, as the terminal sees it (`/thinking`). The level
   * and options are Codex's own slugs ("none", "low", "high", …), taken from
   * the active model's entry in `model/list`, matching config.toml's
   * `model_reasoning_effort`.
   */
  getThinking(): { level: string; available: string[] } {
    const available = this.effortsFor(this.thread?.model);
    const level = this.effort ?? this.defaultEffortFor(this.thread?.model) ?? available[0] ?? "medium";
    return { level, available: available.length > 0 ? available : [level] };
  }

  /** Set the reasoning effort for subsequent turns. Returns the applied level. */
  async setThinking(level: string): Promise<string> {
    const client = this.client;
    const thread = this.thread;
    if (!client || !thread) throw new Error("Codex thread not started");
    const normalized = level.trim().toLowerCase();
    const available = this.effortsFor(thread.model);
    if (available.length > 0 && !available.includes(normalized)) {
      throw new Error(`Unsupported effort "${level}" for ${thread.model}. Options: ${available.join(", ")}.`);
    }
    await client.updateThreadSettings(thread.threadId, { effort: normalized });
    this.effort = normalized;
    return normalized;
  }

  /** The efforts the given model advertises, from the cached catalog. */
  private effortsFor(slug: string | undefined): string[] {
    if (!slug) return [];
    const entry = this.modelCatalog?.get(slug);
    return (entry?.supportedReasoningEfforts ?? [])
      .map((support) => support.reasoningEffort)
      .filter((effort): effort is string => typeof effort === "string" && effort.length > 0);
  }

  /** The model's own default effort, from the cached catalog. */
  private defaultEffortFor(slug: string | undefined): string | undefined {
    if (!slug) return undefined;
    return this.modelCatalog?.get(slug)?.defaultReasoningEffort;
  }

  /** The single option that truthfully reports the configured model. */
  private currentModelOption(): CommandOption[] {
    const slug = this.thread?.model ?? "codex";
    return [
      {
        value: slug,
        label: slug,
        description: "configured in ~/.codex/config.toml",
        active: true,
      },
    ];
  }

  getSessionStats(): SessionStatsInfo {
    return {
      sessionId: this.thread?.threadId ?? this.sessionId,
      sessionFile: this.thread?.path,
      userMessages: this.stats.userMessages,
      assistantMessages: this.stats.assistantMessages,
      toolCalls: this.stats.toolCalls,
      tokens: { ...this.stats.tokens, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    };
  }

  dispose(): void {
    this.aborted = true;
    this.resolveTurnEnd?.();
    this.resolveTurnEnd = undefined;
    // Unblock any approval still waiting so the request handler can settle.
    for (const [, resolve] of this.pendingApprovals) resolve("cancel");
    this.pendingApprovals.clear();
    // Stop the exec-server first: it may still hold managed processes, and it
    // reports their exits through the watcher.
    this.execServer?.close();
    this.execServer = undefined;
    this.environmentId = undefined;
    this.client?.dispose();
    this.client = undefined;
    this.thread = undefined;
  }

  // --------------------------------------------------------------------------

  /** Resolves when turn/completed or turn/failed lands (or dispose). */
  private resolveTurnEnd?: () => void;
  private rejectTurnEnd?: (error: Error) => void;

  private waitForTurnEnd(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveTurnEnd = resolve;
      this.rejectTurnEnd = reject;
    });
  }

  /**
   * Answer a server-to-client request. Codex asks the client for approval —
   * `item/commandExecution/requestApproval` for a shell command,
   * `item/fileChange/requestApproval` for a patch, and
   * `item/permissions/requestApproval` for extra sandbox permissions. The
   * terminal answers these with a keypress; Absence surfaces the request as an
   * `approval` event and waits for the user's decision (or answers from config
   * when the policy is set to automatic).
   *
   * The returned promise deliberately blocks the request until a decision
   * arrives: the server keeps the item paused meanwhile, which is exactly what
   * the Stage shows.
   */
  private onRequest(method: string, params: any): unknown {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return this.requestApproval({
          kind: "command",
          title: params?.command ? truncate(String(params.command), 80) : "Run a command",
          detail: String(params?.command ?? "(no command text)"),
          reason: params?.reason ? String(params.reason) : undefined,
          cwd: params?.cwd ? String(params.cwd) : undefined,
          itemId: params?.itemId ? String(params.itemId) : undefined,
          available: params?.availableDecisions,
        });
      case "item/fileChange/requestApproval":
        return this.requestApproval({
          kind: "file_change",
          title: "Apply file changes",
          detail: formatPermissionDetail(params),
          reason: params?.reason ? String(params.reason) : undefined,
          itemId: params?.itemId ? String(params.itemId) : undefined,
          available: params?.availableDecisions,
        });
      case "item/permissions/requestApproval":
        return this.requestPermissionApproval(params);
      default:
        // Unknown request: throw so AppServerClient answers with a JSON-RPC
        // error instead of leaving the server waiting.
        throw new Error(`unsupported request: ${method}`);
    }
  }

  /**
   * Raise an approval prompt and resolve with the decision the user picks (or
   * the configured default when running automatic). The id is stable per
   * request so the Stage card and the eventual decision pair up.
   */
  private requestApproval(request: {
    kind: string;
    title: string;
    detail: string;
    reason?: string;
    cwd?: string;
    itemId?: string;
    available: unknown;
  }): Promise<{ decision: string }> {
    const id = `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const options = approvalOptions(request.available);
    // Automatic mode answers at once — the card is not needed.
    if (this.approvalAutomatic()) {
      return Promise.resolve({ decision: this.approvalDecision(request.available) });
    }
    this.emitAbsence("approval", {
      id,
      kind: request.kind,
      title: request.title,
      detail: request.detail,
      reason: request.reason,
      cwd: request.cwd,
      itemId: request.itemId,
      options,
    });
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, (value) => {
        this.pendingApprovals.delete(id);
        resolve({ decision: value });
      });
    });
  }

  /**
   * The permissions prompt shares the request/grant shape, so the user's choice
   * is either "grant what was asked" or "decline".
   */
  private requestPermissionApproval(params: any): Promise<unknown> {
    const id = `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const requested = params?.permissions ?? {};
    if (this.approvalAutomatic()) {
      return Promise.resolve(
        this.approvalDeclined()
          ? { permissions: {}, scope: "turn" }
          : { permissions: requested, scope: "turn" },
      );
    }
    this.emitAbsence("approval", {
      id,
      kind: "permissions",
      title: "Grant extra permissions",
      detail: formatPermissionDetail(params),
      reason: params?.reason ? String(params.reason) : undefined,
      cwd: params?.cwd ? String(params.cwd) : undefined,
      itemId: params?.itemId ? String(params.itemId) : undefined,
      options: [
        { value: "accept", label: "Grant", tone: "accept" },
        { value: "decline", label: "Deny", tone: "decline" },
      ],
    });
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, (value) => {
        this.pendingApprovals.delete(id);
        resolve(value === "decline" ? { permissions: {}, scope: "turn" } : { permissions: requested, scope: "turn" });
      });
    });
  }

  /**
   * Answer an approval the user picked on the Stage. Resolves the waiting
   * request (see onRequest); a no-op when the id is unknown (already answered,
   * or the turn ended).
   */
  async respondApproval(id: string, value: string): Promise<void> {
    this.pendingApprovals.get(id)?.(value);
  }

  /** The sandbox Codex is currently running in, as the terminal sees it. */
  getPermission(): { level: string; available: string[] } {
    return { level: this.sandbox, available: [...PERMISSION_LEVELS] };
  }

  /**
   * Switch the sandbox for subsequent turns via `thread/settings/update`
   * (`sandboxPolicy`), so running state and history are untouched. The current
   * turn, if any, is unaffected — the change lands on the next one.
   */
  async setPermission(level: string): Promise<string> {
    const normalized = level.trim().toLowerCase();
    if (!PERMISSION_LEVELS.includes(normalized as (typeof PERMISSION_LEVELS)[number])) {
      throw new Error(`Unknown permission level "${level}". Options: ${PERMISSION_LEVELS.join(", ")}.`);
    }
    const client = this.client;
    const thread = this.thread;
    if (!client || !thread) throw new Error("Codex thread not started");
    await client.updateThreadSettings(thread.threadId, { sandboxMode: normalized });
    this.sandbox = normalized;
    return this.sandbox;
  }

  private approvalAutomatic(): boolean {
    const decision = config.codexApprovalDecision;
    return decision === "accept" || decision === "accept-for-session" || decision === "decline";
  }

  private approvalDeclined(): boolean {
    return isDeclineDecision(config.codexApprovalDecision);
  }

  /**
   * The decision to send back, honouring the configured policy. `available
   * decisions` is Codex's own ordered list; when present and the policy asks
   * for a session-scoped grant, prefer that so repeated writes stop prompting.
   */
  private approvalDecision(availableDecisions: unknown): string {
    return chooseApprovalDecision(config.codexApprovalDecision, availableDecisions);
  }

  private onNotification(method: string, params: any): void {
    const emit = <K extends AbsenceEventType>(type: K, payload: AbsenceEventPayloadMap[K]) =>
      this.emitAbsence(type, payload);

    switch (method) {
      case "thread/tokenUsage/updated": {
        const usage = params?.last ?? params;
        const input = toNumber(usage?.input_tokens ?? usage?.inputTokens);
        const output = toNumber(usage?.output_tokens ?? usage?.outputTokens);
        if (input > 0 || output > 0) {
          this.stats.tokens = { input, output, total: input + output };
          this.usage = { used: input };
        }
        break;
      }

      case "turn/started":
        break; // agent_start was already emitted by prompt()

      case "turn/completed": {
        this.resolveTurnEnd?.();
        this.resolveTurnEnd = undefined;
        emit("agent_end", { reason: this.aborted ? "aborted" : "completed" });
        break;
      }

      case "turn/failed": {
        const message = params?.error?.message ?? "turn failed";
        this.rejectTurnEnd?.(new Error(message));
        this.resolveTurnEnd = undefined;
        this.rejectTurnEnd = undefined;
        emit("error", { message });
        emit("agent_end", { reason: "error" });
        break;
      }

      case "item/started": {
        const item = params?.item;
        if (!item) break;
        // The real spawn timestamp: this is when the command began, not when
        // the notification arrived. ProcessWatcher opens its window here.
        const startedAtMs = toNumber(params?.startedAtMs) || Date.now();
        switch (item.type) {
          case "commandExecution": {
            this.stats.toolCalls += 1;
            const command = unwrapShell(String(item.command ?? ""));
            const beginId = this.options.processWatcher?.begin(command, item.cwd ?? this.cwd, startedAtMs);
            if (beginId !== undefined) this.watcherBeginId = beginId;
            // Codex tells us what the command IS via `commandActions` (its own
            // parse, the same one the TUI and approvals use). Present a read as
            // the `read` tool, a search as `grep`, a listing as `ls` — otherwise
            // the agent looks like it is "running" while it reads, and
            // AgentFolder never captures the file.
            const tool = toolNameForCommand(item);
            emit("tool_start", {
              toolCallId: item.id,
              toolName: tool,
              args: tool === "bash" ? { command } : { command, actions: item.commandActions },
            });
            break;
          }
          case "fileChange": {
            this.stats.toolCalls += 1;
            // Snapshot the files before the patch lands on disk, so the
            // file_edit event can carry a real before/after pair (and the
            // Stage can render a diff with line numbers, as Pi's does).
            this.captureFilesBefore(item.id, item.changes);
            emit("tool_start", { toolCallId: item.id, toolName: "edit", args: { changes: item.changes } });
            break;
          }
          case "webSearch": {
            this.stats.toolCalls += 1;
            emit("tool_start", { toolCallId: item.id, toolName: "web_search", args: { query: item.query } });
            break;
          }
          case "mcpToolCall": {
            this.stats.toolCalls += 1;
            // Codex names the server and tool explicitly; the tool name the
            // rest of Absence uses is Pi's `mcp__<server>__<tool>` form, so an
            // MCP call looks the same whichever runtime produced it.
            emit("tool_start", {
              toolCallId: item.id,
              toolName: mcpToolName(item.server, item.tool),
              args: item.arguments ?? {},
            });
            break;
          }
          default:
            break;
        }
        break;
      }

      case "item/completed": {
        const item = params?.item;
        if (!item) break;
        const completedAtMs = toNumber(params?.completedAtMs) || Date.now();
        switch (item.type) {
          case "commandExecution": {
            const command = unwrapShell(String(item.command ?? ""));
            const tool = toolNameForCommand(item);
            if (tool !== "bash") {
              // Codex declared what this command does. Turn each action into the
              // first-class event it deserves: a read becomes `file_read` (so
              // AgentFolder captures the file and the status becomes "reading"),
              // a listing/search becomes `search`.
              void this.mapCommandActions(item);
              emit("tool_end", { toolCallId: item.id, toolName: tool, isError: item.status === "failed" });
              this.closeWatcherWindow(completedAtMs);
              break;
            }
            this.emitAbsence("command", {
              command,
              stdout: String(item.aggregatedOutput ?? ""),
              stderr: "",
              exitCode: item.exitCode ?? (item.status === "failed" ? 1 : 0),
            });
            emit("tool_end", { toolCallId: item.id, toolName: "bash", isError: item.status === "failed" });
            this.closeWatcherWindow(completedAtMs);
            break;
          }
          case "fileChange": {
            emit("tool_end", { toolCallId: item.id, toolName: "edit", isError: item.status === "failed" });
            this.closeWatcherWindow(completedAtMs);
            void this.mapFileChange(item);
            break;
          }
          case "webSearch": {
            emit("search", {
              tool: "web_search",
              query: String(item.query ?? ""),
              scope: "web",
              matches: 0,
              output: "",
            });
            emit("tool_end", { toolCallId: item.id, toolName: "web_search", isError: false });
            break;
          }
          case "mcpToolCall": {
            emit("tool_end", {
              toolCallId: item.id,
              toolName: mcpToolName(item.server, item.tool),
              isError: item.status === "failed",
            });
            emit("mcp", {
              server: String(item.server ?? ""),
              tool: String(item.tool ?? ""),
              toolName: mcpToolName(item.server, item.tool),
              toolCallId: String(item.id ?? ""),
              args: safeJson(item.arguments ?? {}),
              result: mcpResultText(item.result),
              isError: item.status === "failed",
              durationMs: toNumber(item.durationMs) || undefined,
            });
            if (item.error) {
              emit("error", { message: `MCP ${String(item.server)}/${String(item.tool)}: ${String(item.error)}` });
            }
            break;
          }
          case "agentMessage": {
            const text = String(item.text ?? "");
            if (text.trim().length > 0) {
              this.stats.assistantMessages += 1;
              emit("message", { role: "assistant", content: text, streaming: false });
            }
            break;
          }
          case "reasoning": {
            const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n").trim();
            if (text.length > 0) {
              emit("thinking", { content: text, streaming: false });
            }
            break;
          }
          case "error": {
            emit("error", { message: String(item.message ?? "error") });
            break;
          }
          default:
            break;
        }
        break;
      }

      case "error": {
        emit("error", { message: String(params?.message ?? "stream error") });
        break;
      }

      default:
        break; // thread/status/changed, token deltas we already count, etc.
    }
  }

  /** The watcher window of the command that just completed. */
  private watcherBeginId?: number;

  private closeWatcherWindow(_completedAtMs: number): void {
    if (this.watcherBeginId === undefined) return;
    // end() takes the window id; the completion timestamp is implicit in the
    // watcher's own clock (notifications arrive within milliseconds).
    this.options.processWatcher?.end(this.watcherBeginId);
    this.watcherBeginId = undefined;
  }

  /**
   * A finished patch becomes file_write / file_edit events. Codex reports
   * which files changed and how (add/delete/update), not the contents, so the
   * result is read back from disk — and the previous version comes from the
   * snapshot taken at item/started (see captureFilesBefore).
   */
  private async mapFileChange(item: any): Promise<void> {
    if (item.status !== "completed") return;
    const changes: Array<{ path: string; kind: "add" | "delete" | "update" }> = item.changes ?? [];
    for (const change of changes) {
      if (change.kind === "delete") continue; // FileWatcher reports removals
      const abs = path.isAbsolute(change.path) ? change.path : path.join(this.cwd, change.path);
      const display = this.display(change.path);
      const before = this.pendingBefore.get(beforeKey(item.id, change.path)) ?? "";
      this.pendingBefore.delete(beforeKey(item.id, change.path));
      try {
        const content = (await readFileSafe(abs)) ?? "";
        if (change.kind === "add") {
          this.emitAbsence("file_write", { path: display, content });
        } else {
          // diff is left empty on purpose: the Stage generates a unified diff
          // with real line-number hunks from the before/after pair.
          this.emitAbsence("file_edit", { path: display, before, after: content, diff: "" });
        }
      } catch (error) {
        this.emitAbsence("error", { message: errorMessage(error) });
      }
    }
  }

  /** File contents snapshotted before a patch applies, keyed per item+path. */
  private pendingBefore = new Map<string, string>();

  /**
   * Read each file a patch is about to touch, before Codex writes it. The
   * item/completed handler fires after the write, so disk already holds the
   * new content there — the before side must be captured here.
   */
  private captureFilesBefore(itemId: unknown, changes: unknown): void {
    const list = Array.isArray(changes) ? changes : [];
    for (const change of list) {
      const changePath = (change as { path?: unknown } | undefined)?.path;
      if (typeof changePath !== "string" || changePath.length === 0) continue;
      const abs = path.isAbsolute(changePath) ? changePath : path.join(this.cwd, changePath);
      void readFileSafe(abs)
        .then((content) => {
          if (content) this.pendingBefore.set(beforeKey(itemId, changePath), content);
        })
        .catch(() => {
          /* unreadable before the patch: the diff falls back to additions-only */
        });
    }
  }

  /**
   * Codex's own declaration of what a command does becomes Absence's
   * first-class events. `commandActions` is the parse Codex already made for
   * the TUI and approvals, so this is the authoritative answer, not a guess:
   *
   *   read      → file_read   (AgentFolder captures it, status becomes "reading")
   *   listFiles → search      (a directory listing)
   *   search    → search      (grep / rg / findstr)
   *
   * When the app-server did not send the field, fall back to parsing the
   * command text for a read.
   */
  private async mapCommandActions(item: any): Promise<void> {
    if (item.status !== "completed") return;
    const actions = commandActionsFromItem(item);
    if (actions === undefined) {
      // Older app-server: recover a read from the command text instead.
      const read = parseReadCommand(unwrapShell(String(item.command ?? "")));
      if (read) this.emitRead(item, read.path);
      return;
    }

    for (const read of actions.reads) {
      this.emitRead(item, read.path);
    }
    for (const list of actions.lists) {
      this.emitListing(item, list.path);
    }
    for (const search of actions.searches) {
      this.emitSearch(item, search.query, search.path);
    }
  }

  /** A Codex `read` action → a `file_read` event, the shape Pi's read produces. */
  private emitRead(item: any, actionPath: string): void {
    const abs = path.isAbsolute(actionPath) ? actionPath : path.join(this.cwd, actionPath);
    void this.emitReadAsync(item, abs);
  }

  private async emitReadAsync(item: any, abs: string): Promise<void> {
    // Prefer the command's own output: it is exactly the bytes the agent saw,
    // and it cannot drift if the file changes before this handler runs. When
    // Codex did not carry the output, read the file back from disk.
    let content = String(item.aggregatedOutput ?? "");
    if (content.length === 0) {
      content = (await readFileSafe(abs)) ?? "";
    }
    // `cat`/`Get-Content` end each line with a newline; the trailing one is not
    // a line, so drop it to keep the line count honest.
    if (content.endsWith("\n")) content = content.slice(0, -1);

    const lineCount = content.length === 0 ? 0 : content.split("\n").length;
    this.emitAbsence("file_read", {
      path: this.display(abs),
      startLine: 1,
      endLine: Math.max(1, lineCount),
      content,
      language: languageFromPath(abs),
    });
  }

  /** A Codex `listFiles` action → a `search` event scoped to the directory. */
  private emitListing(item: any, actionPath: string | undefined): void {
    const scope = actionPath !== undefined ? this.display(actionPath) : this.display(this.cwd);
    const output = String(item.aggregatedOutput ?? "");
    const matches = output.split("\n").filter((line) => line.trim().length > 0).length;
    this.emitAbsence("search", {
      tool: "ls",
      query: scope,
      scope,
      matches,
      output: output.slice(0, 4000),
    });
  }

  /** A Codex `search` action → a `search` event with its query and scope. */
  private emitSearch(item: any, query: string | undefined, actionPath: string | undefined): void {
    const output = String(item.aggregatedOutput ?? "");
    const matches = output.split("\n").filter((line) => line.trim().length > 0).length;
    this.emitAbsence("search", {
      tool: "grep",
      query: query ?? "",
      scope: actionPath !== undefined ? this.display(actionPath) : this.display(this.cwd),
      matches,
      output: output.slice(0, 4000),
    });
  }

  private display(p: string): string {
    const absolute = path.isAbsolute(p) ? p : path.join(this.cwd, p);
    const rel = path.relative(this.cwd, absolute);
    return rel && !rel.startsWith("..") ? toPosix(rel) : p;
  }
}

/** The snapshot key for one file of one patch item. */
function beforeKey(itemId: unknown, changePath: string): string {
  return `${String(itemId)}\u0000${changePath}`;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Pi's MCP tool naming, so every runtime reports the same tool name. */
function mcpToolName(server: unknown, tool: unknown): string {
  const namespace = String(server ?? "").replace(/[^A-Za-z0-9_-]/g, "_").replace(/-/g, "_");
  return `mcp__${namespace}__${String(tool ?? "")}`;
}

/** Codex's `McpToolCallResult` → the text a person wants to read. */
function mcpResultText(result: any): string {
  if (!result) return "";
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content.map((block: any) =>
    block && typeof block === "object" && typeof block.text === "string" ? block.text : safeJson(block),
  );
  if (parts.length > 0) return parts.join(String.fromCharCode(10));
  if (result.structuredContent !== undefined) return safeJson(result.structuredContent);
  return safeJson(result);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** True when the configured policy refuses the action. */
export function isDeclineDecision(configured: string): boolean {
  return configured !== "accept" && configured !== "accept-for-session";
}

/**
 * Pick the decision to send back for an approval prompt. `available` is
 * Codex's own `availableDecisions` list (camelCase strings such as `"accept"`,
 * `"acceptForSession"`, `"decline"`); entries that are objects (decisions
 * that carry data, e.g. an execpolicy amendment) are ignored. When the list is
 * absent, Codex accepts a bare `"accept"` / `"acceptForSession"`.
 */
export function chooseApprovalDecision(configured: string, available: unknown): string {
  const list = Array.isArray(available)
    ? available.filter((d): d is string => typeof d === "string")
    : [];
  if (isDeclineDecision(configured)) {
    return list.includes("decline") ? "decline" : "cancel";
  }
  if (list.length === 0) {
    return configured === "accept-for-session" ? "acceptForSession" : "accept";
  }
  if (configured === "accept-for-session" && list.includes("acceptForSession")) {
    return "acceptForSession";
  }
  if (list.includes("accept")) return "accept";
  if (list.includes("acceptForSession")) return "acceptForSession";
  return list[0] ?? "decline";
}

/**
 * The Absence tool name for a Codex command, from Codex's own `commandActions`.
 * A read is `read` (so the status becomes "reading" and AgentFolder captures
 * the file); a listing is `ls` and a search is `grep` (both "searching");
 * anything else is `bash`. When the app-server omitted `commandActions`, a
 * read is recovered from the command text as a fallback.
 */
function toolNameForCommand(item: any): string {
  const actions = commandActionsFromItem(item);
  if (actions !== undefined) {
    if (actions.reads.length > 0) return "read";
    if (actions.searches.length > 0) return "grep";
    if (actions.lists.length > 0) return "ls";
    return "bash";
  }
  return parseReadCommand(unwrapShell(String(item?.command ?? ""))) ? "read" : "bash";
}

/** The sandbox levels Codex accepts (`SandboxMode`, kebab-case on the wire). */
export const PERMISSION_LEVELS = ["read-only", "workspace-write", "danger-full-access"] as const;

/**
 * The choices an approval card offers, from Codex's own `availableDecisions`
 * when it sent them (camelCase strings), otherwise the usual pair. Object
 * decisions (those that carry data, e.g. an execpolicy amendment) are dropped —
 * Absence cannot let the user edit them yet.
 */
export function approvalOptions(available: unknown): ApprovalOption[] {
  const raw = Array.isArray(available) ? available : [];
  const list = raw.filter((d): d is string => typeof d === "string");
  // Only treat "no list" as "offer everything" when nothing was sent at all;
  // an array of objects-only is a real restriction (the data-carrying decisions
  // cannot be represented as buttons), so fall through to the neutral pair.
  const open = raw.length === 0;
  const has = (value: string) => open || list.includes(value);
  const options: ApprovalOption[] = [];
  if (has("accept")) options.push({ value: "accept", label: "Allow once", tone: "accept" });
  if (has("acceptForSession")) {
    options.push({ value: "acceptForSession", label: "Allow for session", tone: "accept-session" });
  }
  if (has("decline")) options.push({ value: "decline", label: "Deny", tone: "decline" });
  if (has("cancel")) options.push({ value: "cancel", label: "Stop the turn", tone: "cancel" });
  if (options.length === 0) {
    // Codex advertised only data-carrying decisions; fall back to the basics.
    return [
      { value: "accept", label: "Allow once", tone: "accept" },
      { value: "decline", label: "Deny", tone: "decline" },
    ];
  }
  return options;
}

/** Render an approval request's detail — the text shown verbatim on the Stage. */
function formatPermissionDetail(params: any): string {
  const lines: string[] = [];
  if (params?.command) lines.push(String(params.command));
  if (params?.changes) {
    for (const change of params.changes as Array<{ path?: string; kind?: string }>) {
      lines.push(`${change.kind ?? "change"}: ${change.path ?? "?"}`);
    }
  }
  if (params?.permissions) {
    lines.push(JSON.stringify(params.permissions, null, 2));
  }
  return lines.length > 0 ? lines.join("\n") : JSON.stringify(params ?? {}, null, 2);
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Codex runs shell commands by spawning a shell itself, so the reported
 * command line is the whole invocation — `powershell.exe -Command 'cat x'` —
 * not the command the model wrote. The wrapper is stripped for display and
 * for the intent parser, both of which work on the model's command.
 *
 * Delegates to the shared parser (see process/CodexShell), which also removes
 * the UTF-8 preamble Codex prepends to PowerShell scripts and understands the
 * multi-flag forms (`pwsh -NoProfile -Command …`).
 */
export function unwrapShell(commandLine: string): string {
  return unwrapCommandText(commandLine);
}
