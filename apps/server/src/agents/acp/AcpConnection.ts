import {
  AcpRpcError as RpcError,
  AcpRequestCancelledError,
  AcpUnsupportedCapabilityError,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_METHOD_NOT_FOUND,
} from "./protocol/errors";
import {
  canCallSessionMethod,
  normalizeCapabilities,
  type AcpCapabilities,
  type AcpSessionMethod,
} from "./protocol/capabilities";
import { classifyClientRequest } from "./protocol/clientRequests";
import { isJsonRpcId, type JsonRpcId, type JsonRpcMessage } from "./protocol/jsonrpc";
import { PendingRequests } from "./protocol/pending";
import {
  createStdioTransport,
  type AcpTransport,
  type AcpTransportLaunch,
} from "./protocol/transport";
import type {
  AcpClientCapabilities,
  AcpClientInfo,
  AcpConfigOption,
  AcpConfigValue,
  AcpInitializeResult,
  AcpSessionResult,
  AcpSetConfigOptionParams,
} from "./protocol/types";
import { ACP_PROTOCOL_VERSION, negotiateProtocolVersion } from "./protocol/version";

export { AcpRpcError, AcpRequestCancelledError, AcpUnsupportedCapabilityError } from "./protocol/errors";
export {
  ACP_PROTOCOL_VERSION,
  AcpProtocolVersionError,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./protocol/version";
export type {
  AcpCapabilities,
  AcpSessionCapabilities,
  AcpSessionMethod,
} from "./protocol/capabilities";
export type {
  AcpClientCapabilities,
  AcpClientInfo,
  AcpConfigOption,
  AcpConfigValue,
  AcpInitializeResult,
  AcpSessionResult,
  AcpSetConfigOptionParams,
} from "./protocol/types";
export type { AcpTransport } from "./protocol/transport";

/**
 * A generic Agent Client Protocol transport (https://agentclientprotocol.com).
 *
 * This is the *only* place Absence talks to an agent process. It knows nothing
 * about Pi, Codex, Claude Code, Qwen Code or DSH: a caller hands it a launch
 * spec (command + args + env) and gets an NDJSON JSON-RPC channel back.
 *
 * The transport layer itself is protocol-pure:
 *   - `initialize` carries `clientInfo` and negotiates `protocolVersion`;
 *   - requests made before the handshake completes are queued, then sent in
 *     order;
 *   - `session/resume|load|close` is never sent unless the agent declared it;
 *   - agent→client requests are routed explicitly (unknown methods get
 *     `-32601`, not silence);
 *   - stdout non-JSON lines and stderr are diagnostics, never protocol;
 *   - `close()` is idempotent and rejects every pending request with `-32800`.
 *
 * The shape is deliberately the same one DshClient established:
 *
 *   initialize                 — capabilities handshake
 *   session/new                — create a session (cwd, mcpServers)
 *   session/prompt             — run one turn; resolves with a stopReason
 *   session/cancel             — notification: interrupt the active turn
 *   session/close              — tear the session down (capacity-gated)
 *   session/set_config_option  — switch a configurable option (model, mode, …)
 *
 * Process ownership: the caller spawns this from the Absence server, which
 * already runs inside a Job Object (process/JobSidecar.ts). Every agent process
 * and every shell it lays is therefore already in the kernel's event stream —
 * this transport does not need to (and must not) wrap the agent in another job.
 */

export type AcpLaunch = AcpTransportLaunch;

export interface AcpConnectionOptions {
  /** Launch spec; required unless `transport` is supplied. */
  launch?: AcpLaunch;
  /** Agent working directory; required unless `transport` is supplied. */
  cwd?: string;
  /** Extra environment for the agent process. */
  env?: Record<string, string>;
  /** A pre-built transport (a proxy/tee can reuse the same dispatcher). */
  transport?: AcpTransport;
  /** Identify this client in `initialize`; defaults to Absence. */
  clientInfo?: AcpClientInfo;
  /** Invoked for every notification the agent pushes. */
  onNotification: (method: string, params: any) => void;
  /**
   * Invoked for every agent-to-client request the agent protocol supports.
   * Return the result to send back, or throw to answer with a JSON-RPC error.
   */
  onRequest?: (method: string, params: any) => unknown | Promise<unknown>;
  /** Invoked when the agent process dies. */
  onExit?: (code: number | null) => void;
  /** Invoked on stderr (and malformed stdout) diagnostics only. */
  onErrorOutput?: (chunk: string) => void;
  /** Invoked once the agent process exists, so the caller can record its pid. */
  onSpawn?: (pid: number | undefined) => void;
  /**
   * What this client can do for the agent. Both fields default to "nothing":
   * Absence observes, it does not serve files or run the agent's commands. That
   * is what keeps the agent's execution path identical to running it in a
   * terminal (see docs/decoupling.md).
   */
  clientCapabilities?: AcpClientCapabilities;
}

interface QueuedAction {
  run: () => void;
  /** Present for requests so a failed handshake can settle them. */
  reject?: (error: Error) => void;
}

const DEFAULT_CLIENT_INFO: AcpClientInfo = {
  name: "absence",
  version: process.env.ABSENCE_VERSION ?? "0.5.0",
};

export class AcpConnection {
  private transport?: AcpTransport;
  private readonly pending = new PendingRequests();
  private readonly queue: QueuedAction[] = [];
  /** Sessions already closed, so repeated `closeSession` is idempotent. */
  private readonly closedSessions = new Set<string>();
  private closed = false;
  private ready = false;
  private started = false;
  private exitNotified = false;
  private initResult?: AcpInitializeResult;
  private caps?: AcpCapabilities;

  constructor(private readonly options: AcpConnectionOptions) {}

  /**
   * Spawn the agent (or attach the supplied transport) and perform the
   * `initialize` handshake. Resolves once the agent is accepting requests.
   */
  async start(): Promise<AcpInitializeResult> {
    if (this.ready && this.initResult) return this.initResult;
    if (this.closed) throw new AcpRequestCancelledError("initialize", "connection is closed");
    if (this.started) throw new Error("acp connection is already starting");
    this.started = true;

    const transport = this.options.transport ?? this.spawnTransport();
    this.transport = transport;
    this.bindTransport(transport);
    this.options.onSpawn?.(transport.pid);

    const params = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      clientCapabilities: normalizeClientCapabilities(this.options.clientCapabilities),
    };

    let result: unknown;
    try {
      result = await this.sendRequest("initialize", params);
    } catch (error) {
      this.closeInternal(`initialize failed: ${messageOf(error)}`);
      throw error;
    }

    let version: number;
    try {
      const record =
        result !== null && typeof result === "object" ? (result as Record<string, unknown>) : {};
      version = negotiateProtocolVersion(record.protocolVersion);
      this.initResult = record as AcpInitializeResult;
      this.caps = normalizeCapabilities(this.initResult, version);
    } catch (error) {
      this.closeInternal(messageOf(error));
      throw error;
    }

    this.ready = true;
    this.flushQueue();
    return this.initResult;
  }

  /** The capabilities the agent reported during `initialize`. */
  get initializeResult(): AcpInitializeResult | undefined {
    return this.initResult;
  }

  /** The normalised capability view; `undefined` before the handshake. */
  get capabilities(): AcpCapabilities | undefined {
    return this.caps;
  }

  /** True only when the agent declared the capability gating this method. */
  supportsSessionMethod(method: AcpSessionMethod): boolean {
    return canCallSessionMethod(this.caps, method);
  }

  /** Create a session rooted at a working directory. */
  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<AcpSessionResult> {
    const result = await this.request("session/new", { cwd, mcpServers });
    return this.sessionResult(result, undefined);
  }

  /**
   * Reopen an existing session by id (`session/resume`, or `session/load`).
   *
   * ACP MUST NOT call either method when the agent did not declare it, so an
   * undeclared capability is reported instead. The adapter's existing
   * `resume → newSession` fallback then creates a fresh session.
   */
  async resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers: unknown[] = [],
  ): Promise<AcpSessionResult> {
    if (canCallSessionMethod(this.caps, "session/resume")) {
      const result = await this.request("session/resume", { sessionId, cwd, mcpServers });
      return this.sessionResult(result, sessionId);
    }
    if (canCallSessionMethod(this.caps, "session/load")) {
      const result = await this.request("session/load", { sessionId, cwd, mcpServers });
      return this.sessionResult(result, sessionId);
    }
    throw new AcpUnsupportedCapabilityError(
      "session/resume",
      "ACP agent declared neither session/resume nor session/load; Absence must not call them. " +
        "The caller should create a new session instead.",
    );
  }

  /**
   * Run one turn. Resolves when the prompt settles (`session/prompt` replies
   * with `{ stopReason }`); progress arrives as `session/update` meanwhile.
   */
  async prompt(
    sessionId: string,
    blocks: Array<{ type: string; text?: string }>,
  ): Promise<{ stopReason?: string }> {
    const result = (await this.request("session/prompt", { sessionId, prompt: blocks })) as
      | { stopReason?: string }
      | undefined;
    return { stopReason: result?.stopReason };
  }

  /** Interrupt the active turn (a notification, not a request). */
  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  /**
   * Close a session and let the agent release its resources. Never sends
   * `session/close` unless declared; repeated calls are no-ops.
   */
  async closeSession(sessionId: string): Promise<void> {
    if (this.closedSessions.has(sessionId)) return;
    this.closedSessions.add(sessionId);
    if (this.closed || !canCallSessionMethod(this.caps, "session/close")) return;
    try {
      await this.request("session/close", { sessionId });
    } catch {
      // Already gone; closing is best-effort.
    }
  }

  /** Switch a config option (model, mode, thought level, boolean toggle…). */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: AcpConfigValue,
  ): Promise<unknown> {
    const params: AcpSetConfigOptionParams = { sessionId, configId, value };
    const result = (await this.request("session/set_config_option", params)) as
      | { configOptions?: unknown }
      | undefined;
    return result?.configOptions ?? result;
  }

  /** Authenticate with one method advertised in `initialize.authMethods`. */
  async authenticate(methodId: string): Promise<void> {
    await this.request("authenticate", { methodId });
  }

  isAlive(): boolean {
    return !this.closed && this.transport !== undefined && this.transport.isAlive();
  }

  /**
   * Idempotent teardown. The first call rejects every pending request with a
   * cancellation-class error and stops the agent; later calls do nothing.
   */
  close(reason = "acp connection closed"): void {
    this.closeInternal(reason);
  }

  dispose(): void {
    this.close("connection disposed");
  }

  // --------------------------------------------------------------------------

  private spawnTransport(): AcpTransport {
    const launch = this.options.launch;
    if (!launch) throw new Error("acp connection has neither a transport nor a launch spec");
    const env = {
      ...process.env,
      NO_COLOR: "1",
      ...this.options.env,
      ...(launch.env ?? {}),
    };
    // A custom entry may pin its own working directory; the profile carries it
    // as data, so the protocol layer still knows no product.
    const launchCwd = (launch as { cwd?: string }).cwd;
    return createStdioTransport(launch, launchCwd || this.options.cwd || process.cwd(), env);
  }

  private bindTransport(transport: AcpTransport): void {
    transport.onMessage((message) => this.handleMessage(message));
    // stdout lines that are not JSON-RPC are diagnostics; they must not be
    // dispatched as requests or notifications.
    transport.onMalformedLine((line) => this.options.onErrorOutput?.(line));
    transport.onStderr((chunk) => this.options.onErrorOutput?.(chunk));
    transport.onError((error) => {
      if (this.closed) return;
      this.closeInternal(`agent process error: ${messageOf(error)}`);
      this.notifyExit(null);
    });
    transport.onExit((code) => {
      if (!this.closed) this.closeInternal(`agent process exited (code ${code})`);
      this.notifyExit(code);
    });
  }

  private notifyExit(code: number | null): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    this.options.onExit?.(code);
  }

  /** Stop the pipe and settle everything still outstanding. Idempotent. */
  private closeInternal(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    const cancellation = new AcpRequestCancelledError("", reason);
    this.pending.rejectAll(cancellation);
    const queued = this.queue.splice(0);
    for (const action of queued) action.reject?.(cancellation);
    try {
      this.transport?.close();
    } catch {
      // already gone
    }
  }

  private flushQueue(): void {
    const queued = this.queue.splice(0);
    for (const action of queued) {
      if (this.closed) {
        action.reject?.(new AcpRequestCancelledError("", "connection is closed"));
        continue;
      }
      action.run();
    }
  }

  /**
   * Send a request. Before the handshake completes, everything except
   * `initialize` waits in a single FIFO queue and is flushed in order.
   */
  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new AcpRequestCancelledError(method, "connection is closed"));
    }
    if (!this.ready && method !== "initialize") {
      return new Promise((resolve, reject) => {
        this.queue.push({
          run: () => void this.sendRequest(method, params).then(resolve, reject),
          reject,
        });
      });
    }
    return this.sendRequest(method, params);
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new AcpRequestCancelledError(method, "connection is closed"));
    }
    const transport = this.transport;
    if (!transport) {
      return Promise.reject(new AcpRequestCancelledError(method, "transport is not started"));
    }
    const pending = this.pending.create(method);
    try {
      transport.send({ jsonrpc: "2.0", id: pending.id, method, params });
    } catch (error) {
      this.pending.discard(pending.id);
      const reason = `failed to write ${method}: ${messageOf(error)}`;
      this.closeInternal(reason);
      return Promise.reject(new AcpRequestCancelledError(method, reason));
    }
    return pending.promise;
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return;
    const run = (): void => {
      if (this.closed) return;
      try {
        this.transport?.send({ jsonrpc: "2.0", method, params });
      } catch (error) {
        this.closeInternal(`failed to write ${method}: ${messageOf(error)}`);
      }
    };
    if (!this.ready) {
      this.queue.push({ run });
      return;
    }
    run();
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (this.closed) return;

    if ("method" in message) {
      const method = message.method;
      if ("id" in message && isJsonRpcId(message.id)) {
        void this.handleAgentRequest(message.id, method, message.params);
      } else {
        this.options.onNotification(method, message.params ?? {});
      }
      return;
    }

    // A response to one of our requests.
    const pending = this.pending.take(message.id);
    if (!pending) return;
    if ("error" in message) {
      pending.reject(
        new RpcError(
          pending.method,
          String(message.error.message ?? "ACP error"),
          numberOrUndefined(message.error.code),
          message.error.data,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  /**
   * Route an agent→client request. Permission is forwarded to the caller; fs
   * and terminal callbacks are refused unless the matching capability was
   * declared, and unknown methods are refused explicitly.
   */
  private async handleAgentRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const route = classifyClientRequest(method, this.options.clientCapabilities);
    if (!route.supported) {
      this.sendError(id, JSON_RPC_METHOD_NOT_FOUND, route.reason ?? `unsupported request: ${method}`);
      return;
    }
    const handler = this.options.onRequest;
    if (!handler) {
      this.sendError(id, JSON_RPC_METHOD_NOT_FOUND, `No client handler for "${method}".`);
      return;
    }
    try {
      const result = await handler(method, params ?? {});
      // `undefined` cannot be serialised as a JSON-RPC result; treat it as
      // unhandled rather than sending an invalid frame.
      if (result === undefined) {
        this.sendError(id, JSON_RPC_METHOD_NOT_FOUND, `Unhandled request: ${method}`);
        return;
      }
      this.sendMessage({ jsonrpc: "2.0", id, result });
    } catch (error) {
      this.sendError(id, JSON_RPC_INTERNAL_ERROR, messageOf(error));
    }
  }

  private sendError(id: JsonRpcId, code: number, message: string): void {
    this.sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private sendMessage(message: JsonRpcMessage): void {
    if (this.closed) return;
    try {
      this.transport?.send(message);
    } catch (error) {
      this.closeInternal(`failed to write response: ${messageOf(error)}`);
    }
  }

  private sessionResult(result: any, fallbackId: string | undefined): AcpSessionResult {
    const sessionId = result?.sessionId ?? fallbackId;
    if (!sessionId) throw new Error("acp agent returned no session id");
    return {
      sessionId: String(sessionId),
      configOptions: Array.isArray(result?.configOptions)
        ? (result.configOptions as AcpConfigOption[])
        : undefined,
    };
  }
}

function normalizeClientCapabilities(
  capabilities: AcpClientCapabilities | undefined,
): Required<AcpClientCapabilities> {
  return {
    fs: {
      readTextFile: capabilities?.fs?.readTextFile === true,
      writeTextFile: capabilities?.fs?.writeTextFile === true,
    },
    terminal: capabilities?.terminal === true,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
