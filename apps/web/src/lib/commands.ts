import type { AgentCommandInfo, CommandOption } from "@absence/core";

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
 * The model selector Absence drives: ACP config options, not a prompt.
 *
 * It is a palette entry only when the agent advertised selectable models, so
 * the command never appears for an agent that cannot switch models.
 */
const MODEL_ACTION: CommandSpec = {
  name: "model",
  description: "Switch the agent's model",
  argHint: "<model>",
  kind: "choice",
};

/**
 * What the `/` palette draws: the agent's catalog plus the actions Absence owns.
 * Agent commands take free-text arguments and are forwarded by the server as
 * prompts; `/auth` and (when the agent exposes a model selector) `/model` are
 * ACP port actions performed locally by the server.
 *
 * An owned name shadows the agent's own command of the same name; a `/model`
 * an agent advertises as a text command survives only when no selector exists
 * (then Absence has nothing better to offer and forwards it verbatim).
 */
export function mergeAgentCommands(
  specs: AgentCommandInfo[] | undefined,
  models?: CommandOption[],
): CommandSpec[] {
  const natives: CommandSpec[] = [];
  if (models && models.length > 0) natives.push(MODEL_ACTION);
  natives.push(AUTH_ACTION);
  const owned = new Set(natives.map((command) => command.name.toLowerCase()));
  return [...natives, ...agentCommands(specs).filter((command) => !owned.has(command.name.toLowerCase()))];
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
