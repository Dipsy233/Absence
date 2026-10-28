/**
 * `absence` — the command-line way into Absence.
 *
 * The important subcommand is `watch`: open a session that only observes an
 * agent. That is Absence as an observer, and it needs no adapter, no runtime
 * version and no configuration format of the agent's. See docs/decoupling.md.
 *
 *   absence                      start the server
 *   absence serve                start it explicitly
 *   absence watch --pid N        observe a process somebody else started
 *   absence watch -- <cmd> …     start an agent, then observe it
 */
import { spawn } from "node:child_process";
import { existsSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { parseWatchArgs, type WatchArgs } from "./cliArgs";
import { startServer, type RunningServer } from "./index";
import { TerminalMirror } from "./sessions/TerminalMirror";
import { registerTerminalMirror } from "./sessions/terminalRegistry";

export { parseWatchArgs, type WatchArgs };

const NL = String.fromCharCode(10);

const USAGE = [
  "usage:",
  "  absence                       start the server",
  "  absence serve                 start the server",
  "  absence watch --pid <pid>     observe a running agent",
  "  absence watch [--project DIR] [--label NAME] -- <command> …",
  "                                start an agent and observe it",
  "",
  "  --project DIR   the directory the agent works in (default: cwd)",
  "  --pid PID       the process to watch (its whole subtree is the agent's work)",
  "  --label NAME    what to call the observed agent",
  "  --transcript FILE  read an agent's own session log (default: discovered)",
].join(NL);

/**
 * Watch an agent Absence starts itself.
 *
 * The agent runs under a **PTY**, and this process is a transparent bridge
 * between that PTY and the real terminal:
 *
 *   your terminal ──stdin──► this bridge ──PTY──► agent
 *   your terminal ◄─stdout── this bridge ◄─PTY─── agent
 *
 * Two reasons, both about not being intrusive:
 *
 *  · **The agent must see a TTY.** With piped stdio it detects "not a terminal",
 *    drops its TUI and colour and switches to plain line output. A PTY is what
 *    makes `absence watch -- pi` look and behave exactly like running `pi`.
 *  · **The mirror needs the same bytes.** Everything the agent writes is copied
 *    to a TerminalMirror on its way through, so the Stage can show it without
 *    parsing, rewriting or re-rendering anything (docs/decoupling.md, Layer 1).
 *
 * Keys go through untouched, and a window resize is forwarded, so the agent's
 * own layout stays correct. Absence never interprets the stream; it is a wire.
 *
 * **The server must be up before the agent is spawned.** On Windows the process
 * observer is a Job Object placed on the server: everything the server creates
 * *afterwards* joins that job, and the kernel then reports the whole tree with
 * no sampling at all. A process that already existed when the job was assigned
 * is not retroactively adopted, so spawning the agent first would silently fall
 * back to sampling the process table — correct, but the slow path. Bringing the
 * server up first is what makes `absence watch -- pi` exact.
 */
async function watchCommand(
  command: string[],
  projectPath: string,
  label: string | undefined,
  transcript: string | undefined,
): Promise<void> {
  // 1. Server first: it takes the job, so the agent below is born into it.
  const server = await startServer();

  // 2. The agent, under a PTY, with this process as the bridge.
  const nodePty = (await import("node-pty")) as unknown as {
    spawn: (
      file: string,
      args: string[],
      options: { cwd: string; env: Record<string, string>; cols: number; rows: number; name: string },
    ) => {
      readonly pid: number;
      onData(listener: (data: string) => void): void;
      onExit(listener: (event: { exitCode: number }) => void): void;
      write(data: string): void;
      resize(cols: number, rows: number): void;
      kill(signal?: string): void;
    };
  };

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  // node-pty does not search PATH: `node` has to be an absolute path. A bare
  // name is resolved here the way a shell would, so `absence watch -- pi`
  // works with whatever the user would type at a prompt.
  const file = resolveExecutable(command[0]!, env);
  const pty = nodePty.spawn(file, command.slice(1), {
    cwd: projectPath,
    env,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    name: "xterm-256color",
  });

  const mirror = new TerminalMirror();
  registerTerminalMirror(pty.pid, mirror);

  // Everything the agent writes: to the real terminal, and to the mirror.
  pty.onData((data) => {
    process.stdout.write(data);
    mirror.push(data);
  });

  // Everything the user types: straight through. Raw mode so keys arrive one at
  // a time (arrow keys, Ctrl-C) rather than after a newline.
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const onInput = (data: Buffer) => pty.write(data.toString("utf8"));
  stdin.on("data", onInput);

  // A resize must reach the agent, or its layout drifts from the window's.
  const onResize = () => pty.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  process.stdout.on("resize", onResize);

  const restore = () => {
    stdin.off("data", onInput);
    process.stdout.off("resize", onResize);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdin.pause();
  };

  try {
    await observeAndHold(server, pty.pid, projectPath, label ?? command[0]!, transcript, () => pty.kill());
    await new Promise<void>((resolve) => pty.onExit(() => resolve()));
  } finally {
    restore();
    mirror.end();
  }
}

/** Open an observe session for `pid`, on a server we start, until Ctrl-C. */
async function watchPid(
  pid: number,
  projectPath: string,
  label: string,
  transcript?: string,
  onInterrupt?: () => void,
): Promise<void> {
  const server = await startServer();
  await observeAndHold(server, pid, projectPath, label, transcript, onInterrupt);
}

/**
 * POST the observe session and hold until Ctrl-C.
 *
 * Takes a running server rather than starting one: `watchCommand` needs the
 * server (and its job) in place *before* it spawns the agent, so the two
 * callers cannot share a "start the server" step in the wrong order.
 */
async function observeAndHold(
  server: RunningServer,
  pid: number,
  projectPath: string,
  label: string,
  transcript: string | undefined,
  onInterrupt?: () => void,
): Promise<void> {
  const response = await fetch(`${server.url}/api/sessions/observe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath, pid, label, ...(transcript ? { transcript } : {}) }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    await server.close();
    throw new Error(body.error ?? `observe failed (${response.status})`);
  }
  const snapshot = (await response.json()) as { session: { id: string } };
  process.stdout.write(
    [
      `observing ${label} (pid ${pid}) in ${projectPath}`,
      `session ${snapshot.session.id}`,
      `open ${server.url} to watch — Ctrl-C to stop observing`,
      "",
    ].join(NL),
  );

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  // The agent is not ours: an interrupt stops the watching, never the agent.
  if (onInterrupt) onInterrupt();
  await server.close();
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
  if (first !== "watch") {
    process.stderr.write(`unknown command: ${first}${NL}${USAGE}${NL}`);
    process.exitCode = 2;
    return;
  }
  let args: WatchArgs;
  try {
    args = parseWatchArgs(rest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message === "help" ? "" : `${message}${NL}`}${USAGE}${NL}`);
    process.exitCode = message === "help" ? 0 : 2;
    return;
  }
  if (args.command) {
    await watchCommand(args.command, args.projectPath, args.label, args.transcript);
    return;
  }
  if (args.pid === undefined) {
    process.stderr.write(`watch needs --pid or a command after --${NL}${USAGE}${NL}`);
    process.exitCode = 2;
    return;
  }
  await watchPid(args.pid, args.projectPath, args.label ?? `pid ${args.pid}`, args.transcript);
}

/**
 * Resolve a command name to an absolute path, the way a shell would.
 *
 * node-pty takes a file path, not a name: `spawn("node", …)` fails with "File
 * not found" where `spawn` (child_process) would have searched PATH. Doing that
 * search here keeps `absence watch -- pi` as natural to type as `pi`.
 * An already-absolute path, or one with a separator, is taken as given.
 */
function resolveExecutable(name: string, env: Record<string, string>): string {
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const hasSeparator = name.includes("/") || name.includes("\\");
  const isAbsolute = /^[a-zA-Z]:[\/]/.test(name) || name.startsWith("/") || name.startsWith("\\");
  const candidates = (base: string) =>
    extnameOf(base) ? [base] : exts.map((ext) => base + ext);

  if (isAbsolute || hasSeparator) {
    for (const candidate of candidates(name)) {
      if (existsSync(candidate)) return candidate;
    }
    return name;
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const candidate of candidates(join(dir, name))) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}

/** True when a path already carries an extension (so PATHEXT is not appended). */
function extnameOf(file: string): boolean {
  const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  return base.includes(".");
}
