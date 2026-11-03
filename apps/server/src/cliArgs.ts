/**
 * `absence proxy` argument parsing — deliberately its own module.
 *
 * It is imported by the CLI *and* by the offline checks, and it must not drag
 * the server (and therefore the adapters) in.
 */
import path from "node:path";

/** `absence proxy` arguments: only a directory, a label and the agent command. */
export interface ProxyArgs {
  projectPath: string;
  label?: string;
  command?: string[];
}

/**
 * Parse `absence proxy` arguments. No pid/transcript here: the proxy always
 * owns both endpoints, so the only inputs are where the agent runs and what it
 * is called.
 */
export function parseProxyArgs(argv: string[], cwd = process.cwd()): ProxyArgs {
  const args: ProxyArgs = { projectPath: cwd };
  const separator = argv.indexOf("--");
  const own = separator >= 0 ? argv.slice(0, separator) : argv;
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    if (arg === "--project") {
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
