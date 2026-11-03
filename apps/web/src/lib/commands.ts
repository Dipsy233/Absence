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
 * The command catalog is the agent's list, unchanged.
 *
 * Every distinct command the agent advertised becomes an entry; Absence adds
 * none of its own and drops none for being unknown. The line the user picks is
 * forwarded verbatim as a prompt.
 */
export function agentCommands(specs: AgentCommandInfo[] | undefined): CommandSpec[] {
  const commands: CommandSpec[] = [];
  const seen = new Set<string>();
  for (const spec of specs ?? []) {
    const name = spec.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push({
      name,
      description: spec.description ?? "provided by the agent",
      argHint: "[arguments]",
      kind: "text",
    });
  }
  return commands;
}

/**
 * The one `/` line Absence itself executes: ACP authentication. Signing in is
 * a port action (`authenticate`), not a prompt the agent can interpret.
 *
 * It is a palette entry, not part of the agent's command catalog: the agent
 * list above stays untouched.
 */
const AUTH_ACTION: CommandSpec = {
  name: "auth",
  description: "Authenticate the ACP agent",
  argHint: "<methodId>",
  kind: "choice",
};

/**
 * What the `/` palette draws: the agent's catalog plus Absence's auth action.
 * Agent commands take free-text arguments and are forwarded by the server as
 * prompts; the auth action is the only local one.
 */
export function mergeAgentCommands(specs: AgentCommandInfo[] | undefined): CommandSpec[] {
  return [AUTH_ACTION, ...agentCommands(specs).filter((command) => command.name.toLowerCase() !== "auth")];
}

/**
 * The palette's filter: every catalog entry whose name starts with the text
 * after `/`. It never drops a command for being unknown to Absence.
 */
export function matchCommands(commands: CommandSpec[], query: string): CommandSpec[] {
  const prefix = query.trim().toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(prefix));
}

export function findCommand(name: string, commands: CommandSpec[] = [AUTH_ACTION]): CommandSpec | undefined {
  return commands.find((command) => command.name.toLowerCase() === name.toLowerCase());
}
