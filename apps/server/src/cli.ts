/**
 * `absence` — the command-line way into Absence.
 *
 *   absence                       start the server
 *   absence serve                 start it explicitly
 *   absence proxy -- <cmd> …      sit between an ACP client and an agent
 */
import { fstatSync } from "node:fs";
import { parseProxyArgs, type ProxyArgs } from "./cliArgs";
import { startServer, type RunningServer } from "./index";
import { proxySessions, createProcessTransport } from "./agents/acp/proxy";
import { JobMonitor } from "./process/JobMonitor";

export { parseProxyArgs, type ProxyArgs };

const NL = String.fromCharCode(10);

const USAGE = [
  "usage:",
  "  absence                       start the server",
  "  absence serve                 start the server",
  "  absence proxy [--project DIR] [--label NAME] -- <command> …",
  "                                forward an ACP client to an agent (tap only)",
  "",
  "  --project DIR   the directory the agent works in (default: cwd)",
  "  --label NAME    what to call the proxied agent",
].join(NL);

/**
 * `absence proxy -- <agent command>`: transparent ACP proxy.
 *
 * The client launched this process and speaks NDJSON on our stdin/stdout, so
 * stdout belongs to the protocol from the first byte. Everything Absence itself
 * has to say goes to stderr; even `console.log` is redirected, because one
 * stray line on stdout would corrupt the client's JSON-RPC stream.
 *
 * The monitoring server is best-effort: if it cannot start, the proxy still
 * forwards. The tap keeps publishing into its own bus either way.
 */
async function proxyCommand(
  command: string[],
  projectPath: string,
  label: string | undefined,
): Promise<void> {
  const restoreStdout = keepStdoutForProtocol();

  let server: RunningServer | undefined;
  try {
    server = await startServer({ quiet: true });
    process.stderr.write(`ABSENCE proxy: monitoring server at ${server.url}${NL}`);
  } catch (error) {
    process.stderr.write(
      `ABSENCE proxy: monitoring server unavailable (${messageOf(error)}) — forwarding only${NL}`,
    );
  }

  const client = createProcessTransport();
  const session = proxySessions.startStdio({ command, cwd: projectPath, label }, client);
  process.stderr.write(
    `ABSENCE proxy: session ${session.id} — ${command.join(" ")} in ${projectPath}${NL}`,
  );

  const stop = () => session.close("interrupted");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const exit = await session.waitForExit();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);

  try {
    await server?.close();
  } catch {
    // The proxy already finished; a slow server shutdown must not change the code.
  }
  // The server close releases Fastify and the archive, but the process-wide
  // kernel observer is deliberately kept for a serving process. A proxy is
  // finished here: its helper child holds the event loop open, and leaving it
  // behind is exactly the "still alive 8s after both ends closed" failure.
  JobMonitor.get().dispose();
  restoreStdout();
  // The agent's own exit code is the client's answer. A client-side close (the
  // parent went away) is a normal end and keeps its code when there is one.
  const code = exit.side === "agent" ? (exit.code ?? 1) : (exit.code ?? 0);
  process.exitCode = code;
  // Both ends are gone and every handle they owned is released. Exit explicitly
  // so a platform-specific stream that outlives close cannot keep a finished
  // proxy resident.
  process.exit(code);
}

/**
 * Reserve stdout for JSON-RPC. `console.log` is the one writer Absence's own
 * dependencies use; sending it to stderr keeps the protocol stream byte-clean.
 */
function keepStdoutForProtocol(): () => void {
  const original = console.log;
  console.log = (...args: unknown[]) => {
    try {
      process.stderr.write(args.map((value) => String(value)).join(" ") + NL);
    } catch {
      // No console left; a lost log line is preferable to a corrupted stream.
    }
  };
  return () => {
    console.log = original;
  };
}

/**
 * Serve until something says stop: the user (signal), the parent going away
 * (orphan detection), or a fatal error. Everything here is CLI-only — the
 * desktop shell runs the server in-process and owns this lifecycle itself.
 */
async function serveUntilStopped(): Promise<void> {
  exitWhenOrphaned();
  logProcessErrors();
  const server = await startServer();

  // Ctrl+C closes cleanly: WebSocket clients see the socket close instead of a
  // dead TCP connection, and the port is free the moment the process exits.
  const shutdown = (signal: string) => {
    process.stderr.write(`ABSENCE server: ${signal} — closing${NL}`);
    void server
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
    // If close() itself wedges (a handler that never returns), do not just sit
    // there wedged — the whole point of the signal was to leave.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGHUP", () => shutdown("SIGHUP"));

  // Returning from serveUntilStopped would let the process live on the open
  // listening socket alone; nothing else ever needs to happen in serve mode.
  return new Promise<void>(() => {});
}

/**
 * A leftover server wedged at 0% CPU with a listening port is the worst failure
 * mode this process has: nothing responds, nothing crashes, and the next start
 * cannot bind the port. Both halves of the guard below came out of one such
 * zombie (orphaned when its parent npm died; unresponsive to every request).
 *
 *  · stdin EOF — the first casualty of a killed parent. When stdin is a pipe
 *    (npm, concurrently, a start script), its close means the tree above us is
 *    gone, and a headless server nobody can reach is only ever a hazard.
 *  · parent liveness — when the parent kept the console (stdin a TTY), stdin
 *    never closes, so check every 30s that the parent pid still exists.
 *
 * Set ABSENCE_KEEP_ALIVE=1 to run the server detached on purpose.
 */
function exitWhenOrphaned(): void {
  if (process.env.ABSENCE_KEEP_ALIVE === "1") return;

  const bail = (why: string) => {
    process.stderr.write(`ABSENCE server: ${why} — exiting${NL}`);
    process.exit(0);
  };

  const stdin = process.stdin;
  if (stdin.readable && !stdin.isTTY) {
    // A NUL-mounted stdin (spawned with stdio "ignore") would report EOF at
    // once and must not read as an orphan. It is a character device; a piped
    // stdin from a live parent is not. TTY was already excluded above.
    let nulled = false;
    try {
      nulled = fstatSync(0).isCharacterDevice();
    } catch {
      // Unfstatable stdin: keep the guard anyway — a rare false orphan exit is
      // recoverable, a silent zombie is not.
    }
    if (!nulled) {
      stdin.once("end", () => bail("stdin closed (parent gone)"));
      stdin.once("close", () => bail("stdin closed (parent gone)"));
      stdin.once("error", () => bail("stdin error"));
      stdin.resume();
    }
  }

  const ppid = process.ppid;
  if (ppid > 0) {
    // The interval is env-tunable so the lifecycle check can watch the guard
    // fire in seconds instead of half a minute.
    const tick = Number(process.env.ABSENCE_ORPHAN_TICK_MS) || 30_000;
    const timer = setInterval(() => {
      // Reparenting is the signal that works everywhere. On POSIX a dead parent
      // makes the kernel re-parent us to init (or to the nearest subreaper), so
      // `process.ppid` stops being the pid we recorded — that alone is proof,
      // and it does not depend on what pid 1 is. Asking "does the old pid still
      // exist" is not enough there: pid 1 always exists, so `kill(1, 0)`
      // succeeds and a Linux server orphaned by a dead parent would sit on the
      // port forever — the exact wedge this guard was written for. Windows does
      // not re-parent, so the recorded pid stays and the liveness probe below
      // is what fires there; both are checked, whichever notices first.
      if (process.ppid !== ppid) {
        process.stderr.write(`ABSENCE server: parent ${ppid} is gone (now ${process.ppid}) — exiting${NL}`);
        process.exit(0);
      }
      try {
        // Signal 0 asks "does this process exist"; EPERM would also mean alive.
        process.kill(ppid, 0);
      } catch {
        process.stderr.write(`ABSENCE server: parent process ${ppid} is gone — exiting${NL}`);
        process.exit(0);
      }
    }, tick);
    timer.unref();
  }
}

/**
 * Silence is how the wedge went unnoticed: the process sat there, listening,
 * answering nothing, writing nothing. Whatever we can say about a broken state,
 * say it — even if the console is the broken part, the write is best-effort.
 */
function logProcessErrors(): void {
  const report = (what: string) => (detail: unknown) => {
    try {
      process.stderr.write(`ABSENCE server: ${what}: ${String(detail)}${NL}`);
    } catch {
      // The console itself is gone; nothing else to do about it here.
    }
  };
  process.on("unhandledRejection", report("unhandled rejection"));
  process.on("uncaughtException", (error) => {
    report("uncaughtException")(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}

export async function runCli(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;
  if (first === "serve" || first === undefined) {
    await serveUntilStopped();
    return;
  }
  if (first === "proxy") {
    let args: ProxyArgs;
    try {
      args = parseProxyArgs(rest);
    } catch (error) {
      const message = messageOf(error);
      process.stderr.write(`${message === "help" ? "" : `${message}${NL}`}${USAGE}${NL}`);
      process.exitCode = message === "help" ? 0 : 2;
      return;
    }
    if (!args.command) {
      process.stderr.write(`proxy needs a command after --${NL}${USAGE}${NL}`);
      process.exitCode = 2;
      return;
    }
    await proxyCommand(args.command, args.projectPath, args.label);
    return;
  }
  if (first !== "proxy") {
    process.stderr.write(`unknown command: ${first}${NL}${USAGE}${NL}`);
    process.exitCode = 2;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
