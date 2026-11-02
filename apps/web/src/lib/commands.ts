import type { AgentCommandInfo } from "@absence/core";

/** How a command takes its argument. */
export type CommandKind =
  /** Pick one of a list of options (the ACP auth methods). */
  | "choice"
  /** Free text; the whole line is forwarded to the agent. */
  | "text"
  /** No argument — forwarded as-is on Enter. */
  | "none";

export interface CommandSpec {
  name: string;
  description: string;
  /** Shown in the palette as a hint for the argument. */
  argHint?: string;
  kind: CommandKind;
}

/**
 * The only `/` line Absence itself executes: ACP authentication. Signing in is
 * a port action (`authenticate`), not a prompt the agent can interpret.
 *
 * Everything else — `/model`, `/skill`, `/skill:<name>`, `/mcp`, or any command
 * the agent advertises — is forwarded verbatim as a prompt, and the agent
 * decides whether it knows it. Absence does not parse or implement them.
 */
export const LOCAL_COMMANDS: CommandSpec[] = [
  {
    name: "auth",
    description: "Authenticate the ACP agent",
    argHint: "<methodId>",
    kind: "choice",
  },
];

const LOCAL_NAMES = new Set(LOCAL_COMMANDS.map((command) => command.name));

/**
 * Merge Absence's one ACP action with the `/` commands an agent advertised.
 * Advertised commands take free-text arguments and are forwarded by the server
 * as prompts; they never replace `/auth`.
 */
export function mergeAgentCommands(specs: AgentCommandInfo[] | undefined): CommandSpec[] {
  const merged = new Map<string, CommandSpec>(LOCAL_COMMANDS.map((command) => [command.name, command]));
  for (const spec of specs ?? []) {
    const name = spec.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (LOCAL_NAMES.has(key)) continue;
    merged.set(key, {
      name,
      description: spec.description ?? "provided by the agent",
      argHint: "[arguments]",
      kind: "text",
    });
  }
  return [...merged.values()];
}

export function findCommand(
  name: string,
  commands: CommandSpec[] = LOCAL_COMMANDS,
): CommandSpec | undefined {
  return commands.find((command) => command.name.toLowerCase() === name.toLowerCase());
}
