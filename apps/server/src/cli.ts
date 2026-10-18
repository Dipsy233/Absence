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
import { parseWatchArgs, type WatchArgs } from "./cliArgs";
import { startServer, type RunningServer } from "./index";

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
 * stdin/stdout are inherited, so the agent keeps the terminal — its TUI, its
 * prompts, its keys. Absence only learns the pid and observes it, which is the
 * whole point: it never has to understand the agent to show what it does.
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

  // 2. Now the agent. The terminal stays its own: stdio is inherited.
  //
  // No `shell: true`. It would wrap the command in `cmd.exe`, and `child.pid`
  // would then be the wrapper's pid, not the agent's — every observation is
  // rooted at that pid, so watching the wrapper means watching the wrong tree.
  const child = spawn(command[0]!, command.slice(1), {
    stdio: "inherit",
    cwd: projectPath,
    // Its own group on POSIX, so a Ctrl-C reaches the agent (the terminal's job)
    // rather than Absence, which keeps observing until the agent exits.
    detached: process.platform !== "win32",
  });
  if (child.pid === undefined) {
    await server.close();
    throw new Error(`could not start ${command.join(" ")}`);
  }

  await observeAndHold(server, child.pid, projectPath, label ?? command[0]!, () => child.kill());
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
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
