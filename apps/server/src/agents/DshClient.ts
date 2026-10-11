import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A newline-delimited JSON-RPC client for the DeepSeek Harness (dsh) ACP
 * server — `dsh --profile acp`.
 *
 * This is the transport behind DshAdapter. DSH ships an "automation-only Agent
 * Client Protocol server for driving DeepSeek Harness agents over JSON-RPC
 * stdio" (its own package description): stdout belongs entirely to ACP, so a
 * client gets a clean, pairable event stream without a TUI in the way. It is
 * the same observer shape as Codex's `codex app-server`.
 *
 * Protocol: Agent Client Protocol (https://agentclientprotocol.com), NDJSON —
 * one JSON object per line. Client→agent methods used here:
 *
 *   initialize                 — capabilities handshake
 *   session/new                — create a session (cwd, mcpServers)
 *   session/prompt             — run one turn; resolves with a stopReason
 *   session/cancel             — notification: interrupt the active turn
 *   session/close              — tear the session down
 *   session/set_config_option  — switch the model for subsequent turns
 *
 * Agent→client notifications (`session/update`) carry the stream:
 *   agent_message_chunk        — assistant text delta
 *   agent_thought_chunk        — reasoning delta
 *   tool_call / tool_call_update — tool lifecycle
 *   usage_update / config_option_update
 *
 * The agent also issues `session/request_permission` requests; the client must
 * answer them or the turn stays blocked (see DshAdapter.onRequest).
 */

export interface DshClientOptions {
  /** The `dsh` entrypoint to run. Defaults to probing the install. */
  dshBin?: string;
  /** The profile to boot (the shipped automation profile is `acp`). */
  profile: string;
  /** DSH_HOME for the spawned process. */
  dshHome?: string;
  cwd: string;
  env?: Record<string, string>;
  /** Invoked for every `session/update` notification the agent pushes. */
  onNotification: (method: string, params: any) => void;
  /**
   * Invoked for every agent-to-client request (the agent asks us something and
   * waits). Return the result to send back, or throw to answer with a JSON-RPC
   * error. DSH uses this for `session/request_permission`.
   */
  onRequest?: (method: string, params: any) => unknown | Promise<unknown>;
  /** Invoked when the server process dies. */
  onExit?: (code: number | null) => void;
  /** Invoked on stderr output (diagnostics only). */
  onErrorOutput?: (chunk: string) => void;
}

/** One selectable config option (DSH reports the model list this way). */
export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: Array<{ value: string; name?: string; description?: string } | { group: string; name?: string; options?: Array<{ value: string; name?: string; description?: string }> }>;
}

export interface NewSessionResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
}

export class DshClient {
  private child?: ReturnType<typeof spawn>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;
  private ready = false;
  private queue: Array<() => void> = [];

  constructor(private readonly options: DshClientOptions) {}

  /**
   * Spawn the ACP server and perform the `initialize` handshake. Resolves once
   * the server is accepting requests.
   */
  async start(): Promise<void> {
    const entry = resolveDshBin(this.options.dshBin);
    // Windows cannot spawn a .js shim directly (EFTYPE): go through node,
    // unless the resolved entry is a real executable.
    const isScript = entry.endsWith(".js") || entry.endsWith(".cjs") || entry.endsWith(".mjs");
    const command = isScript ? process.execPath : entry;
    const args = isScript
      ? [entry, "--profile", this.options.profile]
      : ["--profile", this.options.profile];

    this.child = spawn(command, args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        ...(this.options.dshHome ? { DSH_HOME: this.options.dshHome } : {}),
        ...this.options.env,
      },
    });

    const child = this.child;
    // A failed spawn (command not found — e.g. dsh is not installed) emits an
    // 'error' event asynchronously. An EventEmitter with no 'error' listener
    // throws, which would take the whole server process down; catching it here
    // turns the failure into a rejected handshake instead, so the caller can
    // report "not installed" and fall back.
    child.on("error", (error) => {
      this.closed = true;
      const wrapped = new Error(`failed to start dsh (${entry}): ${error instanceof Error ? error.message : String(error)}`);
      for (const [, p] of this.pending) p.reject(wrapped);
      this.pending.clear();
      // Unblock anything waiting on the handshake that never arrived.
      for (const flush of this.queue) flush();
      this.queue = [];
      this.options.onExit?.(null);
    });
    child.on("exit", (code) => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error(`dsh acp server exited (code ${code})`));
      this.pending.clear();
      this.options.onExit?.(code);
    });
    child.stderr?.on("data", (chunk) => this.options.onErrorOutput?.(String(chunk)));

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => this.handleLine(line));

    // ACP handshake: advertise the client capabilities we actually implement.
    // We do file I/O ourselves (the adapter reads files back from disk), so we
    // do not claim `fs` here; declaring it would make the agent delegate reads
    // to us and we would never answer.
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    });
    this.ready = true;
    for (const flush of this.queue) flush();
    this.queue = [];
  }

  /** Create a session rooted at a working directory. */
  async newSession(cwd: string): Promise<NewSessionResult> {
    const result = await this.request("session/new", { cwd, mcpServers: [] });
    if (!result?.sessionId) throw new Error("dsh acp returned no session id");
    return {
      sessionId: String(result.sessionId),
      configOptions: Array.isArray(result.configOptions) ? (result.configOptions as AcpConfigOption[]) : undefined,
    };
  }

  /** Resume an existing dsh session by id over the ACP resume method. */
  async resumeSession(sessionId: string, cwd: string): Promise<NewSessionResult> {
    const result = await this.request("session/resume", { sessionId, cwd, mcpServers: [] });
    return {
      sessionId: String(result?.sessionId ?? sessionId),
      configOptions: Array.isArray(result?.configOptions) ? (result.configOptions as AcpConfigOption[]) : undefined,
    };
  }

  /**
   * Run one turn. The promise resolves when the prompt settles (ACP's
   * `session/prompt` replies with `{ stopReason }`); progress arrives as
   * `session/update` notifications meanwhile.
   */
  async prompt(sessionId: string, text: string): Promise<{ stopReason?: string }> {
    const result = await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    return { stopReason: result?.stopReason };
  }

  /** Interrupt the active turn (a notification, not a request). */
  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  /** Close a session and let dsh release its resources. */
  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.request("session/close", { sessionId });
    } catch {
      // The session may already be gone; closing is best-effort.
    }
  }

  /** Switch a config option (used to change the model). */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    const result = await this.request("session/set_config_option", {
      sessionId,
      configId,
      value,
    });
    return result?.configOptions ?? result;
  }

  isAlive(): boolean {
    return !this.closed && this.child !== undefined && this.child.exitCode === null;
  }

  dispose(): void {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error("dsh acp client disposed"));
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
    if (this.closed) return Promise.reject(new Error("dsh acp client is closed"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    const send = (): Promise<any> =>
      new Promise((resolve, reject) => {
        if (this.closed || !this.child) {
          reject(new Error("dsh acp client is closed"));
          return;
        }
        const stdin = this.child.stdin;
        if (!stdin) {
          reject(new Error("dsh acp stdin is unavailable"));
          return;
        }
        this.pending.set(id, { resolve, reject });
        stdin.write(payload + "\n", (error) => {
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

  private notify(method: string, params: unknown): void {
    if (this.closed || !this.child) return;
    try {
      this.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      // The pipe is gone; the exit handler settles any pending state.
    }
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // diagnostics or partial output, not JSON-RPC
    }
    // A response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? "dsh acp error"));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    // An agent-to-client request carries BOTH an id and a method; the agent is
    // waiting for our reply (this is how permission prompts arrive).
    if (msg.id !== undefined && typeof msg.method === "string") {
      void this.handleAgentRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      this.options.onNotification(msg.method, msg.params ?? {});
    }
  }

  /** Reply to an agent-to-client request, or error it if we cannot. */
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
      // The pipe is gone; the exit handler will settle any pending state.
    }
  }
}

/**
 * Locate the dsh CLI entry. Order (mirrors how Absence locates Codex):
 *   1. explicit override (config / ABSENCE_DSH_BIN)
 *   2. the DSH Desktop install's bundled runtime, by platform
 *   3. a bare `dsh` on PATH (let the shell resolve it)
 */
export function resolveDshBin(override?: string): string {
  if (override && override.trim().length > 0) return override.trim();
  for (const candidate of dshCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // unreadable path; try the next candidate
    }
  }
  return "dsh";
}

/** Known bundled-runtime locations, newest install first. */
function dshCandidates(): string[] {
  const home = os.homedir();
  const rel = path.join("node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const roots: string[] = [];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    roots.push(path.join(local, "Programs", "DSH Desktop", "resources", "app"));
    roots.push(path.join(local, "dsh-desktop", "resources", "app"));
  } else if (process.platform === "darwin") {
    roots.push("/Applications/DSH Desktop.app/Contents/Resources/app");
    roots.push(path.join(home, "Applications", "DSH Desktop.app", "Contents", "Resources", "app"));
  } else {
    roots.push("/opt/DSH Desktop/resources/app");
    roots.push("/usr/lib/dsh-desktop/resources/app");
  }
  // A repo-adjacent install is handy during development.
  try {
    const here = path.dirname(fileURLToPath(new URL(import.meta.url)));
    roots.push(path.resolve(here, "../../../../../dsh-desktop-main"));
  } catch {
    // import.meta unavailable; skip
  }
  return roots.map((root) => path.join(root, rel));
}
