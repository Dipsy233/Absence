import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * A generic Agent Client Protocol transport (https://agentclientprotocol.com).
 *
 * This is the *only* place Absence talks to an agent process. It knows nothing
 * about Pi, Codex, Claude Code, Qwen Code or DSH: a caller hands it a launch
 * spec (command + args + env) and gets an NDJSON JSON-RPC channel back.
 *
 * The shape is deliberately the same one DshClient established, because that
 * was already the observer model rather than a product-specific one:
 *
 *   initialize                 — capabilities handshake
 *   session/new                — create a session (cwd, mcpServers)
 *   session/prompt             — run one turn; resolves with a stopReason
 *   session/cancel             — notification: interrupt the active turn
 *   session/close              — tear the session down
 *   session/set_config_option  — switch a configurable option (model, mode, …)
 *
 * Agent→client notifications (`session/update`) carry the stream:
 *   agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update /
 *   usage_update / config_option_update / available_commands_update
 *
 * The agent also issues requests of its own (`session/request_permission`);
 * the client must answer them or the turn stays blocked.
 *
 * Process ownership: the caller spawns this from the Absence server, which
 * already runs inside a Job Object (process/JobSidecar.ts). Every agent process
 * and every shell it lays is therefore already in the kernel's event stream —
 * this transport does not need to (and must not) wrap the agent in another job.
 */

/** A JSON-RPC error returned by the agent, with the method that caused it. */
export class AcpRpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

export interface AcpLaunch {
  /** Executable, npm shim, or a .js entry run through node. */
  command: string;
  args?: string[];
  /** Extra environment for the agent process. */
  env?: Record<string, string>;
}

export interface AcpConnectionOptions {
  launch: AcpLaunch;
  cwd: string;
  /** Environment merged over process.env (ABSENCE_SESSION_ID is added by the adapter). */
  env?: Record<string, string>;
  /** Invoked for every `session/update` notification the agent pushes. */
  onNotification: (method: string, params: any) => void;
  /**
   * Invoked for every agent-to-client request. Return the result to send back,
   * or throw to answer with a JSON-RPC error.
   */
  onRequest?: (method: string, params: any) => unknown | Promise<unknown>;
  /** Invoked when the agent process dies. */
  onExit?: (code: number | null) => void;
  /** Invoked on stderr output (diagnostics only). */
  onErrorOutput?: (chunk: string) => void;
  /** Invoked once the agent process exists, so the caller can record its pid. */
  onSpawn?: (pid: number | undefined) => void;
  /**
   * What this client can do for the agent. Both fields default to "nothing":
   * Absence observes, it does not serve files or run the agent's commands. That
   * is what keeps the agent's execution path identical to running it in a
   * terminal (see docs/decoupling.md).
   */
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
}

/** One selectable config option, as ACP reports it (model, mode, thought level…). */
export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: Array<
    | { value: string; name?: string; description?: string }
    | { group: string; name?: string; options?: Array<{ value: string; name?: string; description?: string }> }
  >;
}

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: unknown[];
}

export interface AcpSessionResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
}

export class AcpConnection {
  private child?: ReturnType<typeof spawn>;
  private nextId = 1;
  private pending = new Map<
    number,
    { method: string; resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private closed = false;
  private ready = false;
  private queue: Array<() => void> = [];
  private initResult?: AcpInitializeResult;

  constructor(private readonly options: AcpConnectionOptions) {}

  /**
   * Spawn the agent and perform the `initialize` handshake. Resolves once the
   * agent is accepting requests.
   */
  async start(): Promise<AcpInitializeResult> {
    const { launch } = this.options;
    // Resolve a bare Windows command through PATH/PATHEXT first: `npx` is
    // `npx.cmd` there, and CreateProcess cannot execute it (ENOENT).
    const entry = resolveExecutable(launch.command);
    const args = launch.args ?? [];
    const env = {
      ...process.env,
      NO_COLOR: "1",
      ...this.options.env,
      ...(launch.env ?? {}),
    };

    // Mirrors the resolution DshClient already needed on Windows:
    //   .js      → run through node (a .js shim is not executable: EFTYPE)
    //   .cmd/.bat → go through the shell, quoted (spawn cannot exec it: EINVAL)
    const isScript = /\.(js|cjs|mjs)$/i.test(entry);
    const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(entry);

    let child: ReturnType<typeof spawn>;
    if (isBatch) {
      const line = [quote(entry), ...args.map(quote)].join(" ");
      child = spawn(line, {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
        shell: true,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(isScript ? process.execPath : entry, isScript ? [entry, ...args] : args, {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    }
    this.child = child;
    this.options.onSpawn?.(child.pid);

    // A failed spawn emits 'error' asynchronously; without this listener the
    // whole server would go down. Turn it into a rejected handshake instead.
    child.on("error", (error) => {
      this.closed = true;
      const wrapped = new Error(
        `failed to start agent (${entry}): ${error instanceof Error ? error.message : String(error)}`,
      );
      this.rejectAll(wrapped);
      this.options.onExit?.(null);
    });
    child.on("exit", (code) => {
      this.closed = true;
      this.rejectAll(new Error(`acp agent exited (code ${code})`));
      this.options.onExit?.(code);
    });
    child.stderr?.on("data", (chunk) => this.options.onErrorOutput?.(String(chunk)));

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => this.handleLine(line));

    const capabilities = this.options.clientCapabilities ?? {};
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: capabilities.fs?.readTextFile === true,
          writeTextFile: capabilities.fs?.writeTextFile === true,
        },
        terminal: capabilities.terminal === true,
      },
    });
    this.initResult = (result ?? {}) as AcpInitializeResult;
    this.ready = true;
    for (const flush of this.queue) flush();
    this.queue = [];
    return this.initResult;
  }

  /** The capabilities the agent reported during `initialize`. */
  get initializeResult(): AcpInitializeResult | undefined {
    return this.initResult;
  }

  /** Create a session rooted at a working directory. */
  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<AcpSessionResult> {
    const result = await this.request("session/new", { cwd, mcpServers });
    if (!result?.sessionId) throw new Error("acp agent returned no session id");
    return {
      sessionId: String(result.sessionId),
      configOptions: Array.isArray(result.configOptions) ? (result.configOptions as AcpConfigOption[]) : undefined,
    };
  }

  /** Reopen an existing session by id (`session/resume`, or `session/load`). */
  async resumeSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<AcpSessionResult> {
    const result = await this.request("session/resume", { sessionId, cwd, mcpServers }).catch((error) => {
      // Older adapters only implement session/load. One retry, then give up.
      if (error instanceof Error) return this.request("session/load", { sessionId, cwd, mcpServers });
      throw error;
    });
    return {
      sessionId: String(result?.sessionId ?? sessionId),
      configOptions: Array.isArray(result?.configOptions) ? (result.configOptions as AcpConfigOption[]) : undefined,
    };
  }

  /**
   * Run one turn. Resolves when the prompt settles (`session/prompt` replies
   * with `{ stopReason }`); progress arrives as `session/update` meanwhile.
   */
  async prompt(sessionId: string, blocks: Array<{ type: string; text?: string }>): Promise<{ stopReason?: string }> {
    const result = await this.request("session/prompt", { sessionId, prompt: blocks });
    return { stopReason: result?.stopReason };
  }

  /** Interrupt the active turn (a notification, not a request). */
  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  /** Close a session and let the agent release its resources. */
  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.request("session/close", { sessionId });
    } catch {
      // Already gone; closing is best-effort.
    }
  }

  /** Switch a config option (model, mode, thought level…). */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    const result = await this.request("session/set_config_option", { sessionId, configId, value });
    return result?.configOptions ?? result;
  }

  /** Authenticate with one method advertised in `initialize.authMethods`. */
  async authenticate(methodId: string): Promise<void> {
    await this.request("authenticate", { methodId });
  }

  isAlive(): boolean {
    return !this.closed && this.child !== undefined && this.child.exitCode === null;
  }

  dispose(): void {
    this.closed = true;
    this.rejectAll(new Error("acp connection disposed"));
    try {
      this.child?.kill();
    } catch {
      // already gone
    }
    this.child = undefined;
  }

  // --------------------------------------------------------------------------

  private rejectAll(error: Error): void {
    for (const [, p] of this.pending) p.reject(error);
    this.pending.clear();
    for (const flush of this.queue) flush();
    this.queue = [];
  }

  private request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error("acp connection is closed"));
    const id = this.nextId++;
    const send = (): Promise<any> =>
      new Promise((resolve, reject) => {
        if (this.closed || !this.child) {
          reject(new Error("acp connection is closed"));
          return;
        }
        const stdin = this.child.stdin;
        if (!stdin) {
          reject(new Error("acp stdin is unavailable"));
          return;
        }
        this.pending.set(id, { method, resolve, reject });
        stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        });
      });

    // The agent rejects everything until `initialize` round-trips; hold other
    // requests back so they cannot race the handshake.
    if (!this.ready && method !== "initialize") {
      return new Promise((resolve, reject) => {
        this.queue.push(() => void send().then(resolve, reject));
      });
    }
    return send();
  }

  private notify(method: string, params: unknown): void {
    if (this.closed || !this.child) return;
    try {
      this.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      // Pipe gone; the exit handler settles pending state.
    }
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // diagnostics, not JSON-RPC
    }
    // A response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new AcpRpcError(
            pending.method,
            String(msg.error.message ?? "acp error"),
            numberOrUndefined(msg.error.code),
            msg.error.data,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    // An agent-to-client request carries both an id and a method.
    if (msg.id !== undefined && typeof msg.method === "string") {
      void this.handleAgentRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      this.options.onNotification(msg.method, msg.params ?? {});
    }
  }

  private async handleAgentRequest(id: unknown, method: string, params: any): Promise<void> {
    try {
      const result = await this.options.onRequest?.(method, params);
      if (result === undefined) {
        this.sendResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unhandled request: ${method}` } });
        return;
      }
      this.sendResponse({ jsonrpc: "2.0", id, result });
    } catch (error) {
      this.sendResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private sendResponse(payload: unknown): void {
    if (this.closed || !this.child) return;
    try {
      this.child.stdin?.write(JSON.stringify(payload) + "\n");
    } catch {
      // Pipe gone; the exit handler will settle it.
    }
  }
}

/**
 * Turn a launch command into something CreateProcess can start.
 *
 * On Windows a bare `npx` / `uvx` / `qwen` is a `.cmd` shim on PATH, and
 * `spawn("npx")` fails with ENOENT. `where` applies PATHEXT, so ask it once and
 * use the first hit. An absolute path or a name that already carries an
 * extension is left alone; a lookup failure falls through to spawn's own error,
 * which the adapter reports as "not installed".
 */
function resolveExecutable(entry: string): string {
  if (process.platform !== "win32" || path.isAbsolute(entry)) return entry;
  if (/\.(exe|com|cmd|bat|js|cjs|mjs)$/i.test(entry)) return entry;
  try {
    const result = spawnSync("where", [entry], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0 || !result.stdout) return entry;
    const first = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return first ?? entry;
  } catch {
    return entry;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Quote an argument for a Windows command line. */
function quote(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
