import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { resolveCodexBin } from "./CodexBin";
import { config } from "../config";

/**
 * A newline-delimited JSON-RPC client for `codex app-server`.
 *
 * This is the transport behind CodexAdapter. `codex exec --json` (the SDK's
 * transport) regenerates item ids and drops call ids and timestamps, which is
 * why command attribution drifted; the app-server protocol is the channel
 * Codex itself defines for observers: every command item carries the pairable
 * id and the real started/completed timestamps.
 *
 * Wire format (verified against codex-rs/app-server-transport/src/transport/
 * stdio.rs): one JSON object per line, requests carry `jsonrpc`, `id`,
 * `method`, `params`; the server answers with `{id, result}` / `{id, error}`
 * and pushes notifications with `method`/`params`.
 */

export interface AppServerOptions {
  /** The `codex` entrypoint to run. Defaults to the npm-distributed CLI. */
  codexEntry?: string;
  cwd: string;
  env?: Record<string, string>;
  /** Invoked for every notification the server pushes. */
  onNotification: (method: string, params: any) => void;
  /**
   * Invoked for every server-to-client request (the server asks us something
   * and waits for our reply). Return the result to send back, or throw to
   * answer with a JSON-RPC error. Codex uses this channel for approval
   * prompts — `item/commandExecution/requestApproval` and
   * `item/fileChange/requestApproval` — so a client that never answers leaves
   * the agent waiting for permission that never comes.
   */
  onRequest?: (method: string, params: any) => unknown | Promise<unknown>;
  /** Invoked when the server process dies. */
  onExit?: (code: number | null) => void;
  /** Invoked on stderr output (diagnostics only). */
  onErrorOutput?: (chunk: string) => void;
}

export interface ThreadInfo {
  threadId: string;
  model: string;
  modelProvider: string;
  /** Codex's own rollout file for this thread, when the server reports one. */
  path?: string;
}

/** One entry of the `model/list` response (codex-rs Protocol `Model`). */
export interface AppServerModel {
  /** The slug Codex expects back in settings (e.g. "hy3"). */
  model: string;
  id?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>;
}

export interface StartThreadParams {
  cwd: string;
  /** Config overrides passed verbatim to `thread/start`'s `config` map. */
  config?: Record<string, unknown>;
  /** Resume an existing thread instead of starting one. */
  resumeThreadId?: string;
  model?: string;
  /**
   * The environment ids the thread runs in, in priority order. The first is the
   * turn's environment. Used to pin a thread to Absence's own exec-server (see
   * CodexExecServer) so Codex hands every command to Absence to spawn.
   */
  environments?: Array<{ environmentId: string; cwd: string }>;
  /**
   * Sandbox for the thread: `read-only`, `workspace-write` or
   * `danger-full-access`. Omitted means Codex's own default, which is
   * `read-only` — the reason an agent started without this cannot write a file.
   */
  sandbox?: string;
  /**
   * When to ask for approval: `untrusted`, `on-request`, `on-failure` or
   * `never`. Approvals arrive as server-to-client requests (see AppServerOptions.onRequest).
   */
  approvalPolicy?: string;
}

export class AppServerClient {
  private child?: ReturnType<typeof spawn>;
  private nextId = 1;
  /** Pending requests keyed by id. */
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;
  /** Set once `initialize` succeeds. */
  private ready = false;
  /** Queued while `initialize` is in flight. */
  private queue: Array<() => void> = [];

  constructor(private readonly options: AppServerOptions) {}

  /**
   * Spawn the server and perform the `initialize` handshake. Resolves once
   * the server is accepting requests.
   */
  async start(): Promise<void> {
    // Windows cannot spawn a .js shim directly (EFTYPE): go through node. A
    // .cmd/.bat wrapper (the global `codex.cmd` npm installs) cannot be spawned
    // directly either (EINVAL): run it through the shell, which every platform
    // handles.
    const entry = this.options.codexEntry ?? codexEntryPath();
    const isScript = entry.endsWith(".js") || entry.endsWith(".cjs") || entry.endsWith(".mjs");
    const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(entry);

    let child: ReturnType<typeof spawn>;
    if (isBatch) {
      // A `.cmd`/`.bat` wrapper (the global npm-installed codex) cannot be
      // spawned directly on Windows (EINVAL); run it through the shell with the
      // executable quoted so a path containing spaces still works.
      child = spawn(`"${entry}" app-server`, {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: this.options.env,
        shell: true,
        windowsVerbatimArguments: true,
      });
    } else {
      // A .js shim goes through node (Windows cannot spawn it directly: EFTYPE).
      const command = isScript ? process.execPath : entry;
      const args = isScript ? [entry, "app-server"] : ["app-server"];
      child = spawn(command, args, {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: this.options.env,
      });
    }
    this.child = child;

    // A failed spawn (command not found — e.g. codex is not installed) emits an
    // 'error' event asynchronously. An EventEmitter with no 'error' listener
    // throws, which would take the whole server process down; catching it here
    // turns the failure into a rejected handshake instead.
    child.on("error", (error) => {
      this.closed = true;
      const wrapped = new Error(
        `failed to start codex (${entry}): ${error instanceof Error ? error.message : String(error)}`,
      );
      for (const [, p] of this.pending) p.reject(wrapped);
      this.pending.clear();
      for (const flush of this.queue) flush();
      this.queue = [];
      this.options.onExit?.(null);
    });
    child.on("exit", (code) => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error(`codex app-server exited (code ${code})`));
      this.pending.clear();
      this.options.onExit?.(code);
    });
    child.stderr?.on("data", (chunk) => this.options.onErrorOutput?.(String(chunk)));

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => this.handleLine(line));

    // The handshake must complete before anything else goes on the wire.
    // `experimentalApi` opts into methods still behind the experimental gate —
    // notably thread/settings/update, which is how /model and /thinking apply
    // their changes. Without it the server rejects those calls outright.
    await this.request("initialize", {
      clientInfo: { name: "absence", title: "Absence", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.ready = true;
    for (const flush of this.queue) flush();
    this.queue = [];
  }

  /**
   * Register an executable environment (a remote exec-server) for this
   * connection. Codex routes a thread's commands to the environment named in
   * `thread/start.environments`; Absence registers its own loopback exec-server
   * here so it can spawn every command itself (see CodexExecServer).
   */
  async addEnvironment(environmentId: string, execServerUrl: string): Promise<void> {
    await this.request("environment/add", { environmentId, execServerUrl });
  }

  /** Start a new thread (or resume one) and return its identity. */
  async startThread(params: StartThreadParams): Promise<ThreadInfo> {
    const request = params.resumeThreadId
      ? {
          method: "thread/resume",
          params: {
            threadId: params.resumeThreadId,
            ...(params.sandbox ? { sandbox: params.sandbox } : {}),
            ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
          },
        }
      : {
          method: "thread/start",
          params: {
            cwd: params.cwd,
            ...(params.config ? { config: params.config } : {}),
            ...(params.model ? { model: params.model } : {}),
            ...(params.environments && params.environments.length > 0
              ? { environments: params.environments }
              : {}),
            ...(params.sandbox ? { sandbox: params.sandbox } : {}),
            ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
          },
        };
    const result = await this.request(request.method, request.params);
    const thread = result?.thread;
    if (!thread?.id) throw new Error("codex app-server returned no thread id");
    return {
      threadId: thread.id,
      model: result.model ?? thread.model ?? "codex",
      modelProvider: result.modelProvider ?? thread.modelProvider ?? "codex",
      path: thread.path,
    };
  }

  /**
   * Run one turn. The promise resolves when the server *accepts* the turn
   * (`turn/start` replies); progress arrives as notifications, completion as
   * a `turn/completed` / `turn/failed` notification.
   */
  async runTurn(
    threadId: string,
    text: string,
    environments?: Array<{ environmentId: string; cwd: string }>,
  ): Promise<string | undefined> {
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      // Also carried here, not only on thread/start: a resumed thread cannot be
      // given environments at resume time, and turn/start's setting sticks for
      // subsequent turns.
      ...(environments && environments.length > 0 ? { environments } : {}),
    });
    return result?.turn?.id;
  }

  /** Interrupt the running turn, if any. */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  /**
   * List the models Codex itself offers. When `model_catalog_json` is set in
   * config.toml (which is how an external switcher injects its catalog), Codex
   * builds a StaticModelsManager from that file, so the list here is exactly
   * the final Codex configuration — not the upstream OpenAI catalog.
   */
  async listModels(): Promise<AppServerModel[]> {
    const result = await this.request("model/list", { includeHidden: false });
    return Array.isArray(result?.data) ? (result.data as AppServerModel[]) : [];
  }

  /**
   * Override settings for subsequent turns on a thread. `model` is Codex's own
   * slug (e.g. "hy3") — the same string that appears in config.toml — never a
   * `provider/id` pair. Running turns are unaffected.
   */
  async updateThreadSettings(
    threadId: string,
    settings: { model?: string; effort?: string; sandboxMode?: string },
  ): Promise<void> {
    await this.request("thread/settings/update", {
      threadId,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(settings.sandboxMode ? { sandboxPolicy: sandboxPolicyFor(settings.sandboxMode) } : {}),
    });
  }

  /**
   * A general request, for observers that need a catalog the typed helpers do
   * not cover: `skills/list`, `mcpServerStatus/list`, `model/list` with
   * different params. A method an older app-server does not implement rejects
   * with the server's own error — callers treat that as "not supported".
   */
  requestMethod(method: string, params: unknown): Promise<any> {
    return this.request(method, params);
  }

  isAlive(): boolean {
    return !this.closed && this.child !== undefined && this.child.exitCode === null;
  }

  dispose(): void {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error("codex app-server disposed"));
    this.pending.clear();
    try {
      this.child?.kill();
    } catch {
      // already gone
    }
    this.child = undefined;
  }

  // --------------------------------------------------------------------------

  private request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error("codex app-server is closed"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    const send = (): Promise<any> =>
      new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.child!.stdin!.write(payload + "\n", (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        });
      });

    // The server rejects everything until `initialize` round-trips; hold
    // non-initialize requests back so they cannot race it.
    if (!this.ready && method !== "initialize") {
      return new Promise((resolve, reject) => {
        this.queue.push(() => send().then(resolve, reject));
      });
    }
    return send();
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // diagnostics or partial output, not JSON-RPC
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? "codex app-server error"));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    // A server-to-client request carries BOTH an id and a method; the server is
    // waiting for our reply. Answer it, or the agent blocks (this is how
    // approval prompts arrive).
    if (msg.id !== undefined && typeof msg.method === "string") {
      void this.handleServerRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      this.options.onNotification(msg.method, msg.params ?? {});
    }
  }

  /** Reply to a server-to-client request, or error it if we cannot. */
  private async handleServerRequest(id: unknown, method: string, params: any): Promise<void> {
    try {
      const result = await this.options.onRequest?.(method, params);
      if (result === undefined) {
        // No handler: answer with an error so the server does not wait forever.
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
      // The pipe is gone; the exit handler will settle any pending state.
    }
  }
}

/**
 * Map a `SandboxMode` slug (`read-only`, `workspace-write`, `danger-full-access`)
 * to the `SandboxPolicy` object `thread/settings/update` expects.
 */
export function sandboxPolicyFor(mode: string): Record<string, unknown> {
  switch (mode) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "workspace-write":
    default:
      return { type: "workspaceWrite" };
  }
}

/**
 * Locate the codex CLI entry. Absence drives the user's own codex, so a
 * global install on PATH wins over any package that happens to sit next to
 * Absence (see agents/CodexBin.ts).
 */
function codexEntryPath(): string {
  return resolveCodexBin(config.codexBin);
}

/** A fresh request id for logs (unused on the wire; the client numbers its own). */
export function traceId(): string {
  return randomUUID().slice(0, 8);
}
