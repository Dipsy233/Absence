/**
 * Line transports for the transparent ACP proxy.
 *
 * `AcpTransport` is the frozen interface the dispatcher already speaks. A
 * proxy needs one thing that interface deliberately does not carry: the raw
 * stdout/stdin line. Forwarding a parsed `JsonRpcMessage` would round-trip it
 * through JSON.stringify and silently re-order keys, drop unknown fields and
 * rewrite nothing that looked like an id. The proxy therefore implements
 * `AcpTransport` *plus* a raw line channel, and forwards the original bytes of
 * every line. The tap listens to the parsed view; the wire never sees it.
 *
 * Two endpoints are built from the same primitive:
 *   - the client side, over process stdio or a socket;
 *   - the agent side, over a spawned child process.
 */

import { createInterface, type Interface } from "node:readline";
import { parseJsonRpcMessage, type JsonRpcMessage } from "../protocol/jsonrpc";
import {
  resolveExecutable,
  spawnResolved,
  type AcpTransport,
  type AcpTransportLaunch,
  type Unsubscribe,
} from "../protocol/transport";

export interface AcpProxyTransport extends AcpTransport {
  /** The raw line, exactly as it arrived (newline excluded). */
  onLine(listener: (line: string) => void): Unsubscribe;
  /** Write one raw line; the proxy never reserialises a message. */
  sendRaw(line: string): void;
}

export interface StreamTransportOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  label?: string;
  pid?: number;
  /** Tear down the endpoint in close() (kill a child, destroy a socket). */
  dispose?: () => void;
  /** An authoritative exit signal. Without it, input close means exit. */
  exitSource?: (emit: (code: number | null) => void) => void;
  /** An authoritative error signal (a spawn failure, for instance). */
  errorSource?: (emit: (error: Error) => void) => void;
  /** When false, closing the input alone does not count as an exit. */
  exitOnInputClose?: boolean;
  stderr?: NodeJS.ReadableStream;
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
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

/** A transport over any line-delimited JSON-RPC stream. */
export function createStreamTransport(options: StreamTransportOptions): AcpProxyTransport {
  const label = options.label ?? "acp proxy stream";
  const lineListeners = emitter<[string]>();
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
    exitListeners.emit(code);
  };

  const emitError = (error: Error): void => {
    if (closed) return;
    errorListeners.emit(error);
  };

  const input = options.input;
  const output = options.output;

  input.on("error", (error: Error) => emitError(error));
  output.on("error", (error: Error) => emitError(error));

  if (options.stderr) {
    options.stderr.on("data", (chunk) => {
      if (closed) return;
      stderrListeners.emit(String(chunk));
    });
  }

  readline = createInterface({ input, terminal: false });
  readline.on("line", (line) => {
    if (closed) return;
    // Raw first: forwarding must never depend on the parse succeeding.
    lineListeners.emit(line);
    const message = parseJsonRpcMessage(line);
    if (message) messageListeners.emit(message);
    else malformedListeners.emit(line);
  });
  readline.on("close", () => {
    if (closed) return;
    if (options.exitOnInputClose === false) return;
    emitExit(null);
  });

  options.exitSource?.(emitExit);
  options.errorSource?.(emitError);

  return {
    pid: options.pid,
    onLine: lineListeners.add,
    onMessage: messageListeners.add,
    onMalformedLine: malformedListeners.add,
    onStderr: stderrListeners.add,
    onError: errorListeners.add,
    onExit: exitListeners.add,

    send(message) {
      this.sendRaw(JSON.stringify(message));
    },

    sendRaw(line) {
      if (closed) throw new Error(`${label} is closed`);
      if (!output || output.writable === false) {
        throw new Error(`${label} output is unavailable`);
      }
      try {
        output.write(line + "\n", (error?: Error | null) => {
          if (error) emitError(new Error(`${label} write failed: ${error.message}`));
        });
      } catch (error) {
        throw new Error(
          `${label} write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
        options.dispose?.();
      } catch {
        // already gone
      }
    },

    isAlive() {
      return !closed && !exited;
    },
  };
}

/** The client side of `absence proxy`: this process's own stdin/stdout. */
export function createProcessTransport(): AcpProxyTransport {
  return createStreamTransport({
    input: process.stdin,
    output: process.stdout,
    label: "acp client stdio",
    pid: process.pid,
    dispose: () => {
      try {
        process.stdin.pause();
      } catch {
        // stdin may already be gone
      }
    },
  });
}

/** The agent side: spawn the real ACP agent and speak NDJSON over its pipes. */
export function createAgentTransport(
  launch: AcpTransportLaunch,
  cwd: string,
  env: Record<string, string> = {},
): AcpProxyTransport {
  const mergedEnv = { ...process.env, NO_COLOR: "1", ...launch.env, ...env };
  const entry = resolveExecutable(launch.command, mergedEnv);
  const args = launch.args ?? [];
  const child = spawnResolved(entry, args, cwd, mergedEnv);

  if (!child.stdout || !child.stdin) {
    throw new Error(`failed to open pipes for agent (${entry})`);
  }

  return createStreamTransport({
    input: child.stdout,
    output: child.stdin,
    label: "acp agent stdio",
    pid: child.pid,
    stderr: child.stderr ?? undefined,
    exitOnInputClose: false,
    exitSource: (emit) => {
      child.on("close", (code) => emit(code));
    },
    errorSource: (emit) => {
      child.on("error", (error) => {
        emit(
          new Error(
            `failed to start agent (${entry}): ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
    },
    dispose: () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    },
  });
}

