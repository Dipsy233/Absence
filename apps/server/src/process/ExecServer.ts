/**
 * Absence's own Codex exec-server.
 *
 * Codex runs shell commands through a small JSON-RPC boundary it calls the
 * "exec-server" (see codex-rs/exec-server). Normally the executor is Codex's own
 * local one; but a client can register an alternative with `environment/add`
 * and pin a thread to it with `thread/start.environments`, at which point Codex
 * hands every command to that server as a `process/start` request.
 *
 * Absence uses that hook to take over Codex's shell the same way AbsenceShell
 * takes over Pi's: Absence spawns the process itself. That matters for two
 * reasons the Job Object alone could never fix:
 *
 *   - The process is Absence's own child, so it is always inside the Job Object
 *     the observer watches. A command Codex would have launched detached —
 *     `Start-Process`, a background daemon — can no longer escape and go
 *     invisible (see the README's "How" for why `Start-Process` breaks job
 *     inheritance).
 *   - Absence sees the exit first-hand, so an egg can never be stuck at
 *     `running` because a kernel message went missing.
 *
 * The watcher is still driven through `begin`/`end`, so an egg is attributed to
 * the command exactly as it is for Pi; the observer remains the second opinion
 * that catches anything the runtime spawns on its own.
 *
 * Transport is a loopback WebSocket. The protocol wants `file:` URIs for paths
 * and base64 chunks; both conversions live here so the rest of the server never
 * sees them.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { ProcessWatcher } from "./ProcessWatcher";
import { createCommandEnv, type ExecEnvPolicy } from "./ShellEnvironment";
import { unwrapArgv } from "./CodexShell";

/** Minimal shape of the ws socket we use — avoids depending on ws types. */
interface ServerSocket {
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  readyState: number;
}

/** Minimal shape of the ws server, as constructed through a lazy import. */
interface WebSocketServerLike {
  address(): { port: number } | string | null;
  on(event: string, listener: (...args: unknown[]) => void): void;
  close(callback?: () => void): void;
}

const OPEN = 1;

export interface ExecServerOptions {
  /**
   * The watcher that records the processes this server spawns. When absent the
   * server still runs the commands, it just cannot attribute the eggs.
   */
  processWatcher?: ProcessWatcher;
  /** Declared shell, reported back to Codex as the environment's shell. */
  shell?: { name: string; path: string };
  /** Extra environment variables every command inherits (the session marker). */
  env?: Record<string, string>;
}

/** A live process this server manages, keyed by the caller's `processId`. */
interface Managed {
  /**
   * How the process was started, which decides how it is written to and
   * stopped. Codex makes the same distinction: `tty: true` allocates a PTY
   * (ConPTY on Windows) and merges stdout/stderr into one stream; anything else
   * is plain pipes.
   */
  mode: "pipe" | "pty";
  child?: ChildProcessWithoutNullStreams;
  pty?: PtyLike;
  /** The watcher window this process belongs to. */
  windowId?: number;
  /** Output sequence number, monotonic per process. */
  seq: number;
  exited: boolean;
  exitCode: number | null;
}

/** The slice of node-pty's `IPty` this server uses (typed locally, lazily). */
interface PtyLike {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

/**
 * The loopback exec-server. Construct one per Codex session, `listen()` once,
 * hand the URL to `environment/add`, and `close()` when the session goes away.
 */
export class CodexExecServer {
  private server?: WebSocketServerLike;
  private sockets = new Set<ServerSocket>();
  private readonly procs = new Map<string, Managed>();
  private closed = false;

  constructor(private readonly options: ExecServerOptions = {}) {}

  /** Bind to an ephemeral loopback port and return the `ws://` URL. */
  async listen(): Promise<string> {
    // Lazy import: `ws` is only needed when a Codex session actually starts.
    // `ws` ships no types of its own and the server does not depend on
    // @types/ws; the shape we use is declared above.
    const wsModule = (await import("ws")) as unknown as {
      WebSocketServer: new (opts: { host: string; port: number }) => WebSocketServerLike;
    };
    const server = new wsModule.WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.on("listening", () => resolve());
      server.on("error", (error: unknown) => reject(error));
    });
    server.on("connection", (socket: unknown) => this.onConnection(socket as ServerSocket));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (!port) throw new Error("exec-server: no port assigned");
    return `ws://127.0.0.1:${port}`;
  }

  /** Stop the server and terminate anything still running under it. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const managed of this.procs.values()) {
      killTree(managed);
      if (managed.windowId !== undefined) this.options.processWatcher?.end(managed.windowId);
    }
    this.procs.clear();
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    this.server?.close();
    this.server = undefined;
  }

  // --------------------------------------------------------------------------

  private onConnection(socket: ServerSocket): void {
    this.sockets.add(socket);
    socket.on("message", (data: unknown) => {
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      let message: any;
      try {
        message = JSON.parse(text);
      } catch {
        return; // not JSON-RPC; ignore
      }
      this.onMessage(socket, message);
    });
    socket.on("close", () => this.sockets.delete(socket));
  }

  private onMessage(socket: ServerSocket, message: any): void {
    const { id, method, params } = message ?? {};
    try {
      switch (method) {
        case "initialize":
          this.reply(socket, id, {
            sessionId: "00000000-0000-4000-8000-a6556e636500",
            environmentInfo: {
              shell: this.options.shell ?? { name: "powershell", path: "powershell" },
              executorVersion: "0.0.0",
              cwd: pathToFileURL(process.cwd()).href,
            },
          });
          return;
        case "initialized":
          return; // notification; nothing to do
        case "process/start":
          void this.startProcess(socket, id, params ?? {});
          return;
        case "process/read":
          this.reply(socket, id, this.readProcess(params ?? {}));
          return;
        case "process/write":
          this.writeProcess(socket, id, params ?? {});
          return;
        case "process/terminate":
          this.terminateProcess(socket, id, params ?? {});
          return;
        case "process/signal":
          this.signalProcess(socket, id, params ?? {});
          return;
        default:
          this.error(socket, id, -32601, `unhandled method: ${method}`);
      }
    } catch (error) {
      this.error(socket, id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Start one command. The argv comes from Codex already split; Absence spawns
   * it directly, so the process is a child of the server and lives in the Job
   * Object the observer watches.
   */
  private async startProcess(socket: ServerSocket, id: unknown, params: any): Promise<void> {
    const processId = String(params.processId ?? "");
    if (!processId) {
      this.error(socket, id, -32602, "processId is required");
      return;
    }
    if (this.procs.has(processId)) {
      this.error(socket, id, -32602, `duplicate processId: ${processId}`);
      return;
    }
    const argv: string[] = Array.isArray(params.argv) ? params.argv.map((a: unknown) => String(a)) : [];
    if (argv.length === 0) {
      this.error(socket, id, -32602, "argv must be non-empty");
      return;
    }
    const cwd = fileUrlToPath(params.cwd) ?? process.cwd();
    // Build the environment the way Codex's own executor does: run the request's
    // `env_policy` over the executor's environment, then let the request's
    // sparse `env` win, then add the session marker (see ShellEnvironment.ts).
    // Using Codex's algorithm rather than an ad-hoc merge is what keeps the
    // command's environment identical to the native executor's.
    const env = createCommandEnv(
      params.envPolicy as ExecEnvPolicy | undefined,
      params.env as Record<string, string> | undefined,
      process.env,
    );
    for (const [name, value] of Object.entries(this.options.env ?? {})) env[name] = value;

    // The watcher window opens at spawn so the processes this command lays are
    // attributed to it, exactly as AbsenceShell does for Pi. The egg shows the
    // model's own command, not Codex's wrapper: `unwrapArgv` lands the argv
    // back on the script the model wrote, preamble and all shell flags gone.
    const windowId = this.options.processWatcher?.begin(unwrapArgv(argv), cwd);

    const managed: Managed = {
      mode: params.tty === true ? "pty" : "pipe",
      windowId,
      seq: 0,
      exited: false,
      exitCode: null,
    };

    const emit = (stream: "stdout" | "stderr" | "pty", chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      if (buf.length === 0) return;
      managed.seq += 1;
      this.notify(socket, "process/output", {
        processId,
        seq: managed.seq,
        stream,
        chunk: buf.toString("base64"),
      });
    };

    if (managed.mode === "pty") {
      // `tty: true` — a real PTY, exactly as Codex allocates one. A PTY merges
      // stdout and stderr into a single stream (reported as `pty`), and Ctrl+C
      // written to it is delivered by the terminal driver.
      try {
        const pty = await this.spawnPty(argv, cwd, env);
        managed.pty = pty;
        this.procs.set(processId, managed);
        this.reply(socket, id, { processId });
        pty.onData((data) => emit("pty", data));
        pty.onExit((event) => this.finish(socket, processId, managed, event.exitCode ?? 0));
      } catch (error) {
        this.procs.delete(processId);
        if (managed.windowId !== undefined) this.options.processWatcher?.end(managed.windowId);
        this.error(socket, id, -32603, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    // Plain pipes (the default, and what Codex itself uses unless `tty: true`
    // is asked for).
    const child = spawn(argv[0] ?? "", argv.slice(1), {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    managed.child = child;

    this.procs.set(processId, managed);
    this.reply(socket, id, { processId });

    child.stdout.on("data", (chunk: Buffer) => emit("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => emit("stderr", chunk));

    child.on("error", (error: Error) => {
      // A spawn failure is an exit with a negative code, so the runtime sees the
      // command end rather than hanging.
      this.finish(socket, processId, managed, -1);
    });
    child.on("close", (code: number | null) => this.finish(socket, processId, managed, code ?? 0));
  }

  /**
   * Allocate a PTY and run `argv` under it through node-pty (ConPTY on
   * Windows), the drop-in equivalent of the `portable-pty` Codex uses. The
   * default size matches Codex's TerminalSize (24 rows x 80 cols).
   */
  private async spawnPty(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<PtyLike> {
    const nodePty = (await import("node-pty")) as unknown as {
      spawn: (
        file: string,
        args: string[],
        options: { cwd: string; env: Record<string, string>; cols: number; rows: number; name: string },
      ) => PtyLike;
    };
    const file = argv[0] ?? "";
    const envStrings: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined) envStrings[name] = value;
    }
    return nodePty.spawn(file, argv.slice(1), {
      cwd,
      env: envStrings,
      cols: 80,
      rows: 24,
      name: "xterm-color",
    });
  }

  private finish(
    socket: ServerSocket,
    processId: string,
    managed: Managed,
    code: number,
    _detail?: string,
  ): void {
    if (managed.exited) return;
    managed.exited = true;
    managed.exitCode = code;
    // Close the watcher window: whatever is still alive survived the command.
    if (managed.windowId !== undefined) {
      this.options.processWatcher?.end(managed.windowId);
      managed.windowId = undefined;
    }
    managed.seq += 1;
    this.notify(socket, "process/exited", {
      processId,
      seq: managed.seq,
      exitCode: code,
      sandboxDenied: false,
    });
    managed.seq += 1;
    this.notify(socket, "process/closed", { processId, seq: managed.seq });
    this.procs.delete(processId);
  }

  private readProcess(params: any): unknown {
    const managed = this.procs.get(String(params.processId ?? ""));
    return {
      chunks: [],
      nextSeq: managed?.seq ?? 0,
      exited: managed?.exited ?? true,
      exitCode: managed?.exitCode ?? null,
      closed: managed === undefined,
      failure: null,
    };
  }

  private writeProcess(socket: ServerSocket, id: unknown, params: any): void {
    const managed = this.procs.get(String(params.processId ?? ""));
    if (!managed || managed.exited) {
      this.error(socket, id, -32602, "unknown process");
      return;
    }
    const chunk = typeof params.chunk === "string" ? Buffer.from(params.chunk, "base64") : Buffer.alloc(0);
    if (managed.mode === "pty") {
      // node-pty wants a string; decode the base64 bytes as UTF-8. A Ctrl+C
      // (`\u0003`) written here is delivered by the terminal driver.
      managed.pty?.write(chunk.toString("utf8"));
    } else {
      managed.child?.stdin.write(chunk);
    }
    this.reply(socket, id, { status: "accepted" });
  }

  /**
   * Codex's interrupt path. Codex never writes Ctrl+C to a non-PTY stdin — it
   * calls `process.interrupt()`, which arrives here as
   * `process/signal { signal: "interrupt" }` (see
   * codex-rs/core/src/unified_exec/process_manager.rs). How the interrupt is
   * delivered is the executor's call: a real console Ctrl+C stops the command
   * and everything it started, so both modes take the tree down. (In a PTY,
   * Codex may instead write the ETX byte through `process/write`, which the
   * terminal driver turns into the same signal.)
   *
   * Without this handler the request falls through to the unknown-method error,
   * Codex reports the interrupt as failed, and the process keeps running — the
   * "Ctrl+C does nothing" bug this method exists to fix.
   */
  private signalProcess(socket: ServerSocket, id: unknown, params: any): void {
    const signal = String(params.signal ?? "").toLowerCase();
    if (signal !== "interrupt") {
      this.error(socket, id, -32602, `unsupported signal: ${signal}`);
      return;
    }
    const managed = this.procs.get(String(params.processId ?? ""));
    if (!managed || managed.exited) {
      // Already gone: the caller sees a successful interrupt, there is nothing
      // left to stop.
      this.reply(socket, id, {});
      return;
    }
    killTree(managed);
    this.reply(socket, id, {});
  }

  private terminateProcess(socket: ServerSocket, id: unknown, params: any): void {
    const managed = this.procs.get(String(params.processId ?? ""));
    if (!managed || managed.exited) {
      this.reply(socket, id, { running: false });
      return;
    }
    killTree(managed);
    this.reply(socket, id, { running: true });
  }

  private reply(socket: ServerSocket, id: unknown, result: unknown): void {
    this.send(socket, { jsonrpc: "2.0", id, result });
  }

  private error(socket: ServerSocket, id: unknown, code: number, message: string): void {
    this.send(socket, { jsonrpc: "2.0", id, error: { code, message } });
  }

  private notify(socket: ServerSocket, method: string, params: unknown): void {
    this.send(socket, { jsonrpc: "2.0", method, params });
  }

  private send(socket: ServerSocket, message: unknown): void {
    if (socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // socket went away between the check and the send
    }
  }
}

/**
 * Stop a command and everything it started.
 *
 * A shell command's real work is usually a grandchild (`pwsh -Command "node
 * ticker.mjs"`), so on Windows the tree is taken down with `taskkill /T`
 * against the process id; elsewhere the child is signalled directly (Node
 * sends SIGTERM, and the shell forwards it). node-pty exposes the process id
 * too, so both modes take the same path. Best-effort either way: the process may
 * already be gone, and the exit listener is what actually reports the exit.
 */
function killTree(managed: Managed): void {
  const pid = managed.mode === "pty" ? managed.pty?.pid : managed.child?.pid;
  const directKill = () => {
    try {
      if (managed.mode === "pty") managed.pty?.kill();
      else managed.child?.kill();
    } catch {
      // already gone
    }
  };
  if (process.platform === "win32" && pid !== undefined) {
    try {
      // /T = the process and its descendants, /F = forceful. Detached so the
      // server never waits on taskkill.
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", directKill);
      killer.unref();
      return;
    } catch {
      // fall through to the direct kill
    }
  }
  directKill();
}

/** `file:///E:/x` → `E:\x` (or `/x` on POSIX); undefined when not a file URL. */
function fileUrlToPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (!value.startsWith("file:")) return value; // tolerate a bare path
  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}
