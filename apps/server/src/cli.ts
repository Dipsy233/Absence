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
import { existsSync } from "node:fs";
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
async function watchCommand(command: string[], projectPath: string, label: string | undefined): Promise<void> {
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
    await observeAndHold(server, pty.pid, projectPath, label ?? command[0]!, () => pty.kill());
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
  onInterrupt?: () => void,
): Promise<void> {
  const server = await startServer();
  await observeAndHold(server, pid, projectPath, label, onInterrupt);
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
  onInterrupt?: () => void,
): Promise<void> {
  const response = await fetch(`${server.url}/api/sessions/observe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath, pid, label }),
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

/** CLI entry, called from index.ts when the module is run directly. */
export async function runCli(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;
  if (first === "serve" || first === undefined) {
    await startServer();
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
    await watchCommand(args.command, args.projectPath, args.label);
    return;
  }
  if (args.pid === undefined) {
    process.stderr.write(`watch needs --pid or a command after --${NL}${USAGE}${NL}`);
    process.exitCode = 2;
    return;
  }
  await watchPid(args.pid, args.projectPath, args.label ?? `pid ${args.pid}`);
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
