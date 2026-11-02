/**
 * Byte-level transport for ACP.
 *
 * The interface is intentionally narrower than ACP: it moves JSON-RPC messages
 * over a pipe and reports diagnostics/exit. A future proxy can implement the
 * same interface for a socket or a tee without touching request dispatch in
 * `AcpConnection`.
 *
 * Two invariants live here rather than in the dispatcher:
 *   - stdout is parsed line by line; anything that is not a JSON-RPC message
 *     goes to `onMalformedLine` and never reaches protocol handling;
 *   - stderr is a diagnostics channel only and is never parsed as protocol.
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parseJsonRpcMessage, type JsonRpcMessage } from "./jsonrpc";

export interface AcpTransportLaunch {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type Unsubscribe = () => void;

export interface AcpTransport {
  readonly pid: number | undefined;
  onMessage(listener: (message: JsonRpcMessage) => void): Unsubscribe;
  /** A stdout line that was not JSON-RPC; diagnostics only. */
  onMalformedLine(listener: (line: string) => void): Unsubscribe;
  /** Raw stderr chunks; diagnostics only. */
  onStderr(listener: (chunk: string) => void): Unsubscribe;
  onError(listener: (error: Error) => void): Unsubscribe;
  onExit(listener: (code: number | null) => void): Unsubscribe;
  send(message: JsonRpcMessage): void;
  close(): void;
  isAlive(): boolean;
}

function emitter<Args extends unknown[]>(): {
  add: (listener: (...args: Args) => void) => Unsubscribe;
  emit: (...args: Args) => void;
} {
  const listeners = new Set<(...args: Args) => void>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

/**
 * Spawn an ACP agent over stdio and expose the message stream.
 *
 * Process ownership stays with the caller: this transport spawns, kills and
 * observes the one child, but never wraps it in another job (the Absence server
 * already runs inside one; see process/JobSidecar.ts).
 */
export function createStdioTransport(
  launch: AcpTransportLaunch,
  cwd: string,
  env: NodeJS.ProcessEnv,
): AcpTransport {
  // Resolve a bare Windows command through PATH/PATHEXT first: `npx` is
  // `npx.cmd` there, and CreateProcess cannot execute it (ENOENT).
  const entry = resolveExecutable(launch.command);
  const args = launch.args ?? [];

  // Mirrors the resolution DshClient already needed on Windows:
  //   .js      → run through node (a .js shim is not executable: EFTYPE)
  //   .cmd/.bat → go through the shell, quoted (spawn cannot exec it: EINVAL)
  const isScript = /\.(js|cjs|mjs)$/i.test(entry);
  const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(entry);

  let child: ReturnType<typeof spawn>;
  if (isBatch) {
    const line = [quote(entry), ...args.map(quote)].join(" ");
    child = spawn(line, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: true,
      windowsVerbatimArguments: true,
    });
  } else {
    child = spawn(isScript ? process.execPath : entry, isScript ? [entry, ...args] : args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
  }

  const messageListeners = emitter<[JsonRpcMessage]>();
  const malformedListeners = emitter<[string]>();
  const stderrListeners = emitter<[string]>();
  const errorListeners = emitter<[Error]>();
  const exitListeners = emitter<[number | null]>();

  let closed = false;
  let exited = false;
  let readline: Interface | undefined;

  const emitExit = (code: number | null): void => {
    if (exited) return;
    exited = true;
    closed = true;
    exitListeners.emit(code);
  };

  const emitError = (error: Error): void => {
    if (closed) return;
    errorListeners.emit(error);
  };

  child.on("error", (error) => {
    emitError(
      new Error(
        `failed to start agent (${entry}): ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  });
  child.on("exit", (code) => emitExit(code));

  child.stderr?.on("data", (chunk) => {
    if (closed) return;
    stderrListeners.emit(String(chunk));
  });

  if (child.stdout) {
    readline = createInterface({ input: child.stdout });
    readline.on("line", (line) => {
      if (closed) return;
      const message = parseJsonRpcMessage(line);
      if (message) messageListeners.emit(message);
      else malformedListeners.emit(line);
    });
  }

  return {
    pid: child.pid,
    onMessage: messageListeners.add,
    onMalformedLine: malformedListeners.add,
    onStderr: stderrListeners.add,
    onError: errorListeners.add,
    onExit: exitListeners.add,

    send(message) {
      if (closed) throw new Error("acp transport is closed");
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed) throw new Error("acp stdin is unavailable");
      const payload = JSON.stringify(message) + "\n";
      stdin.write(payload, (error) => {
        if (error) emitError(new Error(`failed to write to acp stdin: ${error.message}`));
      });
    },

    close() {
      if (closed) return;
      closed = true;
      try {
        readline?.close();
      } catch {
        // already gone
      }
      try {
        child.kill();
      } catch {
        // already gone
      }
    },

    isAlive() {
      return !closed && !exited && child.exitCode === null;
    },
  };
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

/** Quote an argument for a Windows command line. */
function quote(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
