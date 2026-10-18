/**
 * `absence watch` argument parsing — deliberately its own module.
 *
 * It is imported by the CLI *and* by the offline checks, and it must not drag
 * the server (and therefore the adapters) in: the whole point of the observer
 * mode is that it works with `apps/server/src/agents/` deleted, and a parser
 * that imports the agent stack would quietly break that.
 */
import path from "node:path";

export interface WatchArgs {
  pid?: number;
  projectPath: string;
  label?: string;
  /** The command to run and watch, when Absence starts the agent itself. */
  command?: string[];
}

/** Parse `absence watch` arguments. Deliberately small: no dependencies. */
export function parseWatchArgs(argv: string[], cwd = process.cwd()): WatchArgs {
  const args: WatchArgs = { projectPath: cwd };
  const separator = argv.indexOf("--");
  const own = separator >= 0 ? argv.slice(0, separator) : argv;
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    if (arg === "--pid") {
      const value = Number(own[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error("--pid needs a positive integer");
      args.pid = value;
    } else if (arg.startsWith("--pid=")) {
      const value = Number(arg.slice("--pid=".length));
      if (!Number.isInteger(value) || value <= 0) throw new Error("--pid needs a positive integer");
      args.pid = value;
    } else if (arg === "--project") {
      const value = own[++i];
      if (!value) throw new Error("--project needs a directory");
      args.projectPath = path.resolve(value);
    } else if (arg.startsWith("--project=")) {
      args.projectPath = path.resolve(arg.slice("--project=".length));
    } else if (arg === "--label") {
      const value = own[++i];
      if (!value) throw new Error("--label needs a name");
      args.label = value;
    } else if (arg.startsWith("--label=")) {
      args.label = arg.slice("--label=".length);
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("help");
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (separator >= 0) {
    const command = argv.slice(separator + 1);
    if (command.length > 0) args.command = command;
  }
  return args;
}
