/**
 * `absence` — the command-line way into Absence.
 *
 * The important subcommand is `watch`: open a session that only observes an
 * agent somebody else is running. That is Absence as an observer, and it needs
 * no adapter, no runtime version and no configuration format of the agent's —
 * just a pid and a project directory. See docs/decoupling.md.
 *
 * The other subcommands are the server's existing surfaces, given names:
 *
 *   absence                      start the server (same as before)
 *   absence serve                start it explicitly
 *   absence watch [--pid N]      observe a running agent
 *   absence watch -- <cmd> …     start an agent, then observe it (pass-through
 *                                stdin/stdout: the agent keeps the terminal)
 */
import { spawn } from "node:child_process";
import { parseWatchArgs, type WatchArgs } from "./cliArgs";

export { parseWatchArgs, type WatchArgs };
import { startServer } from "./index";

const NL = String.fromCharCode(10);

const USAGE = [
  "usage:",
  "  absence                       start the server",
  "  absence serve                 start the server",
  "  absence watch --pid <pid>     observe a running agent",
  "  absence watch [--project DIR] [--label NAME] -- <command> …",
  "                                start an agent and observe it in place",
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
 */
async function watchCommand(command: string[], projectPath: string, label: string | undefined): Promise<void> {
  const child = spawn(command[0]!, command.slice(1), {
    stdio: "inherit",
    cwd: projectPath,
    // Its own group on POSIX, so a Ctrl-C reaches the agent (the terminal's job)
    // rather than the watcher, and Absence keeps observing until it exits.
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
  });
  if (child.pid === undefined) throw new Error(`could not start ${command.join(" ")}`);
  await watchPid(child.pid, projectPath, label ?? command[0]!, () => {
    child.kill();
  });
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

/** Open an observe session for `pid` and keep the server up until Ctrl-C. */
async function watchPid(
  pid: number,
  projectPath: string,
  label: string,
  onInterrupt?: () => void,
): Promise<void> {
  const server = await startServer();
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
