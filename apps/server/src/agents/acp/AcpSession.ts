import type {
  AgentCapabilitiesSnapshot,
  ConfigOptionValue,
  MonitorEvent,
  PromptBlock,
  PromptCapabilities,
  StopReason,
} from "@absence/core";
import { AcpConnection, type AcpCapabilities } from "./AcpConnection";
import { AcpToolMapper } from "./AcpToolMapper";
import { isAuthRequiredError, type AcpAuth } from "./AcpAuth";
import type { AcpConfigOptions } from "./AcpConfigOptions";
import type { AcpPermissionBridge } from "./AcpPermissionBridge";
import type { AgentProfile } from "./profiles";
import { AcpMonitorProjector } from "../../monitor/projector";
import type { ProcessWatcher } from "../../process/ProcessWatcher";

/**
 * One live ACP session: the transport plus the turn lifecycle on top of it.
 *
 * Everything here is capability-gated by the transport's normalised view:
 * `session/resume|load` is called only when the agent declared it, and
 * `session/close` is sent only when `session/close` was declared (and awaited
 * before the pipe is torn down). A prompt is trimmed to what the agent's
 * `promptCapabilities` accepts; unrecognised blocks are not sent at all.
 *
 * This class owns no permission policy: a pending `session/request_permission`
 * is answered by the bridge, which the adapter drains *before* asking this
 * session to send `session/cancel`.
 */
export interface AcpSessionOptions {
  profile: AgentProfile;
  /** The Absence session id, used for event identity and process attribution. */
  sessionId: string;
  cwd: string;
  processWatcher?: ProcessWatcher;
  config: AcpConfigOptions;
  auth: AcpAuth;
  permissions: AcpPermissionBridge;
  /** Session state updates (`usage_update`, `config_option_update`, …). */
  onStateUpdate(update: any): void;
  /** Projected monitor facts, in protocol order. */
  onProjected(events: MonitorEvent[]): void;
  /** A projection failure must be reported, never swallowed. */
  onError(message: string): void;
}

export class AcpSession {
  private connection?: AcpConnection;
  private acpSessionId?: string;
  private capabilities?: AcpCapabilities;
  private agentCapabilities: Record<string, unknown> = {};
  private projector?: AcpMonitorProjector;
  private resumeHandle?: string;
  private projection: Promise<void> = Promise.resolve();
  private busy = false;
  /**
   * False until this process's first `session/prompt`. A resumed/loaded
   * session's replay of its history arrives before that prompt and is not
   * projected (see handleNotification).
   */
  private hasPrompted = false;
  private aborted = false;
  private closed = false;
  private forceAbort?: () => void;
  private abortTimer?: NodeJS.Timeout;
  /** The spawned agent process, so a close can reap its command subtree. */
  private agentPid?: number;

  constructor(private readonly options: AcpSessionOptions) {}

  /** Open the transport, handshake, then create or reopen a session. */
  async start(resumeHandle: string | undefined): Promise<{ degraded: boolean }> {
    this.projector = new AcpMonitorProjector({
      sessionId: this.options.sessionId,
      cwd: this.options.cwd,
      mapper: new AcpToolMapper(this.options.cwd),
      commandWindow: this.options.processWatcher,
    });

    const connection = new AcpConnection({
      launch: this.options.profile.launch,
      cwd: this.options.cwd,
      env: {
        ABSENCE_SESSION_ID: this.options.sessionId,
        ...(this.options.profile.launch.env ?? {}),
      },
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleAgentRequest(method, params),
      onSpawn: (pid) => {
        this.agentPid = pid;
      },
      onErrorOutput: () => {
        /* stderr is diagnostics; the ACP stream is the truth */
      },
    });
    this.connection = connection;

    // Nothing is sent before `initialize` has settled: `connection.start()`
    // performs the handshake and queues any request made before it resolves.
    const init = await connection.start();
    this.agentCapabilities = init.agentCapabilities ?? {};
    this.options.auth.applyInitialize(init);
    this.capabilities = connection.capabilities;

    const degraded = await this.open(resumeHandle, true);
    return { degraded };
  }

  get sessionId(): string | undefined {
    return this.acpSessionId;
  }

  /** The agent child Absence spawned (undefined before `start` / after close). */
  get pid(): number | undefined {
    return this.agentPid;
  }

  isBusy(): boolean {
    return this.busy;
  }

  capabilitiesSnapshot(): AgentCapabilitiesSnapshot {
    const view = this.capabilities;
    const agent = record(this.agentCapabilities);
    const auth = record(agent.auth);
    const mcp = record(agent.mcp);
    return {
      protocolVersion: view?.protocolVersion ?? 0,
      loadSession: view?.session.load === true,
      resumeSession: view?.session.resume === true,
      closeSession: view?.session.close === true,
      prompt: this.promptCapabilities(),
      auth: { logout: auth.logout === true },
      mcp: { http: mcp.http === true, sse: mcp.sse === true },
      source: "acp-client",
    };
  }

  /** The prompt block kinds the agent declared it accepts. */
  promptCapabilities(): PromptCapabilities {
    const prompt = record(record(this.agentCapabilities).promptCapabilities);
    return {
      image: prompt.image === true,
      audio: prompt.audio === true,
      embeddedContext: prompt.embeddedContext === true,
    };
  }

  /**
   * Throw the one actionable message before a turn starts. The adapter uses
   * this before emitting `agent_start`, so a blocked prompt does not look like
   * a run that failed halfway.
   */
  ensurePromptable(): void {
    if (this.options.auth.isRequired) {
      const methods =
        this.options.auth
          .getMethods()
          .map((method) => method.id)
          .join(", ") || "(none advertised)";
      throw new Error(
        `${this.options.profile.id} requires authentication — run /auth <methodId>. Available: ${methods}.`,
      );
    }
    if (!this.connection || !this.acpSessionId) {
      throw new Error(`${this.options.profile.id} session not started`);
    }
    if (!this.connection.isAlive()) {
      throw new Error(`${this.options.profile.id} agent has exited`);
    }
  }

  /** Run one turn. Returns the agent's own stop reason. */
  async prompt(blocks: PromptBlock[]): Promise<StopReason> {
    this.ensurePromptable();
    const connection = this.connection as AcpConnection;
    const sessionId = this.acpSessionId as string;

    const accepted = trimPromptBlocks(blocks, this.promptCapabilities());
    if (accepted.length === 0) {
      throw new Error(
        `${this.options.profile.id} does not accept any of the provided prompt blocks.`,
      );
    }

    this.aborted = false;
    this.busy = true;
    // From here on, session/update traffic is live turn output. Everything
    // before it was the resume/load replay (see handleNotification).
    this.hasPrompted = true;

    let forced = false;
    const promptPromise = connection.prompt(sessionId, toAcpBlocks(accepted));
    const guarded = new Promise<{ stopReason?: string }>((resolve, reject) => {
      this.forceAbort = () => {
        forced = true;
        reject(new AcpTurnAbortedError());
      };
      promptPromise.then(resolve, reject);
    });

    try {
      const { stopReason } = await guarded;
      return normalizeStopReason(stopReason, this.aborted);
    } catch (error) {
      if (forced || error instanceof AcpTurnAbortedError) return "cancelled";
      throw error;
    } finally {
      this.clearAbortWatch();
      this.forceAbort = undefined;
      this.aborted = false;
      this.busy = false;
      // Let every queued `session/update` project before the turn is declared
      // over, then close any command window the turn left open.
      await this.flushProjection();
      this.projector?.endTurn();
      this.options.permissions.resetDenials();
    }
  }

  /**
   * Send `session/cancel` (the notification, not a request) and bound the wait
   * for an agent that never answers. Repeated calls are safe: a settled prompt
   * simply has nothing to wait for.
   */
  async cancelTurn(): Promise<void> {
    this.aborted = true;
    const connection = this.connection;
    const sessionId = this.acpSessionId;
    if (!connection || !sessionId) return;
    connection.cancel(sessionId);
    if (!this.busy || !this.forceAbort) return;
    this.clearAbortWatch();
    this.abortTimer = setTimeout(() => {
      this.abortTimer = undefined;
      this.forceAbortNow();
    }, ABORT_TIMEOUT_MS);
  }

  async setConfigOption(id: string, value: ConfigOptionValue): Promise<void> {
    const connection = this.connection;
    const sessionId = this.acpSessionId;
    if (!connection || !sessionId) {
      throw new Error(`${this.options.profile.id} session not started`);
    }
    await this.options.config.set(connection, sessionId, id, value);
  }

  /**
   * Authenticate with one advertised method, then reopen the deferred session.
   * A failure is wrapped with the method and the agent's message so the chat
   * shows something actionable instead of a blocked session.
   */
  async authenticate(methodId: string): Promise<void> {
    const connection = this.connection;
    if (!connection) throw new Error(`${this.options.profile.id} is not connected`);
    const method = this.options.auth.find(methodId);
    if (!method) {
      const available =
        this.options.auth
          .getMethods()
          .map((entry) => entry.id)
          .join(", ") || "(none)";
      throw new Error(
        `Unknown authentication method "${methodId}". Available: ${available}.`,
      );
    }
    try {
      await connection.authenticate(methodId);
    } catch (error) {
      throw new Error(
        `Authentication with "${methodId}" failed: ${messageOf(error)}`,
      );
    }

    const pending = this.options.auth.takePending();
    this.options.auth.clearRequired();
    if (!pending) return;

    await this.open(pending.resumeHandle, false);
    if (!this.acpSessionId) {
      throw new Error(
        `${this.options.profile.id} still requires authentication after "${methodId}".`,
      );
    }
  }

  /**
   * Release the session. `session/close` is awaited when the agent declared
   * it; the transport is disposed afterwards either way. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.aborted = true;
    this.clearAbortWatch();
    this.forceAbort?.();

    const connection = this.connection;
    const sessionId = this.acpSessionId;
    try {
      if (
        connection &&
        sessionId &&
        connection.supportsSessionMethod("session/close")
      ) {
        await connection.closeSession(sessionId);
      }
    } finally {
      connection?.dispose();
      this.connection = undefined;
      this.acpSessionId = undefined;
      this.projector?.dispose();
      this.projector = undefined;
    }
  }

  // --------------------------------------------------------------------------

  /**
   * Create a session, or reopen one when the capability (and a handle) exist.
   * Both resume and load are capability-gated here; with neither declared,
   * Absence creates a fresh session rather than sending an undeclared method.
   */
  private async open(
    resumeHandle: string | undefined,
    deferAuth: boolean,
  ): Promise<boolean> {
    const connection = this.connection;
    if (!connection) throw new Error(`${this.options.profile.id} is not connected`);
    this.resumeHandle = resumeHandle ?? this.resumeHandle;
    const canResume =
      typeof this.resumeHandle === "string" &&
      (connection.supportsSessionMethod("session/resume") ||
        connection.supportsSessionMethod("session/load"));

    try {
      let result;
      if (canResume) {
        try {
          result = await connection.resumeSession(this.resumeHandle as string, this.options.cwd);
        } catch (error) {
          if (isAuthRequiredError(error)) throw error;
          result = await connection.newSession(this.options.cwd);
        }
      } else {
        result = await connection.newSession(this.options.cwd);
      }
      this.acpSessionId = result.sessionId;
      this.options.config.fromSession(result.configOptions);
      return Boolean(this.resumeHandle) && !canResume;
    } catch (error) {
      if (!isAuthRequiredError(error)) throw error;
      if (this.options.auth.getMethods().length === 0) {
        throw new Error(
          `${this.options.profile.id} requires authentication but advertised no auth methods.`,
        );
      }
      if (!deferAuth) throw error;
      // Keep the connection alive so `/auth <methodId>` can finish the handshake.
      this.options.auth.markBlocked({
        cwd: this.options.cwd,
        ...(this.resumeHandle !== undefined ? { resumeHandle: this.resumeHandle } : {}),
      });
      return false;
    }
  }

  private handleNotification(method: string, params: any): void {
    if (method !== "session/update") return;
    const update = params?.update;
    if (!update || typeof update !== "object") return;

    this.options.onStateUpdate(update);

    // A resumed/loaded session replays its history as session/update traffic
    // before the first prompt. Absence already restored that history from its
    // own archive; projecting it again would pin the Stage and the agent
    // status on stale work (a replay ends without `agent_end`, so nothing
    // would reset them) and would write the same events into the archive a
    // second time. Session state (model, context usage, commands) still flows
    // above; only event projection is gated. The first prompt of this process
    // is what separates replay from live turn output.
    if (!this.hasPrompted) return;

    // A rejected permission is a fact about the *call*, not an ACP field; the
    // bridge remembers it (from the standard option kind) so the projector can
    // report "never executed" instead of inferring a failure.
    const annotated = this.options.permissions.consumeDenied(update.toolCallId)
      ? { ...update, permissionDenied: true }
      : update;

    this.projection = this.projection
      .then(async () => {
        const events = await this.projector?.projectUpdate(annotated);
        if (events && events.length > 0) this.options.onProjected(events);
      })
      .catch((error) => this.options.onError(messageOf(error)));
  }

  private handleAgentRequest(method: string, params: any): unknown | Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return this.options.permissions.request(params);
      default:
        throw new Error(`unsupported request: ${method}`);
    }
  }

  private async flushProjection(): Promise<void> {
    try {
      await this.projection;
    } catch {
      // The projection chain reports each failure through `onError`.
    }
    this.projection = Promise.resolve();
  }

  private clearAbortWatch(): void {
    if (this.abortTimer !== undefined) {
      clearTimeout(this.abortTimer);
      this.abortTimer = undefined;
    }
  }

  /** Settle the hung run and drop the connection the agent left open. */
  private forceAbortNow(): void {
    // A forced settlement is not a normal abort: the agent ignored
    // `session/cancel` for the whole watchdog window. Report that, so the user
    // sees why the run ended instead of a silent "aborted".
    const window = ABORT_TIMEOUT_MS >= 1000 ? `${Math.round(ABORT_TIMEOUT_MS / 1000)}s` : `${ABORT_TIMEOUT_MS}ms`;
    this.options.onError(`Agent did not respond to session/cancel within ${window}; forced settlement.`);
    this.forceAbort?.();
    this.connection?.dispose();
    this.connection = undefined;
    this.acpSessionId = undefined;
  }
}

/** How long the cancel watchdog waits before forcing the turn to settle. */
const ABORT_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.ABSENCE_ACP_ABORT_TIMEOUT_MS) || 10_000,
);

class AcpTurnAbortedError extends Error {
  constructor() {
    super("ACP turn aborted by watchdog");
    this.name = "AcpTurnAbortedError";
  }
}

function normalizeStopReason(value: string | undefined, aborted: boolean): StopReason {
  if (aborted) return "cancelled";
  switch (value) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
      return value;
    default:
      return "end_turn";
  }
}

/**
 * Keep only the blocks the agent declared it accepts. ACP agents that omit
 * `promptCapabilities` accept text; sending an image/audio/embedded resource
 * they never advertised would be a protocol violation.
 */
function trimPromptBlocks(
  blocks: PromptBlock[],
  capabilities: PromptCapabilities,
): PromptBlock[] {
  return blocks.filter((block) => {
    switch (block.type) {
      case "text":
        return true;
      case "image":
        return capabilities.image;
      case "audio":
        return capabilities.audio;
      case "resource":
      case "resource_link":
        return capabilities.embeddedContext;
    }
  });
}

/** PromptBlock is already the reduced ACP shape; `resource` nests its body. */
function toAcpBlocks(
  blocks: PromptBlock[],
): Array<{ type: string; text?: string }> {
  const out: Array<Record<string, unknown>> = blocks.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "image":
        return { type: "image", data: block.data, mimeType: block.mimeType };
      case "audio":
        return { type: "audio", data: block.data, mimeType: block.mimeType };
      case "resource_link":
        return {
          type: "resource_link",
          uri: block.uri,
          ...(block.name !== undefined ? { name: block.name } : {}),
          ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
        };
      case "resource":
        return {
          type: "resource",
          resource: {
            uri: block.uri,
            ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
            ...(block.text !== undefined ? { text: block.text } : {}),
          },
        };
    }
  });
  return out as Array<{ type: string; text?: string }>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
