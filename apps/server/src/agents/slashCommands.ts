import type { AgentCommandInfo } from "@absence/core";

/**
 * `/` commands Absence owns for every runtime. They are never forwarded, even
 * when an agent happens to advertise the same name: `/model`, `/thinking` and
 * `/permission` map onto ACP `configOptions`, and the rest are Absence features.
 */
export const ABSENCE_LOCAL_COMMANDS = new Set([
  "model",
  "thinking",
  "permission",
  "session",
  "name",
  "export",
  "auth",
]);

/** Find an agent-advertised command by name (case-insensitive). */
export function findAgentCommand(
  commands: AgentCommandInfo[] | undefined,
  name: string,
): AgentCommandInfo | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  return (commands ?? []).find((command) => command.name.toLowerCase() === wanted);
}

/**
 * True when a `/name` line belongs to the agent, not Absence. The advertised
 * list is the authority; an unadvertised `/foo` stays "unknown command" rather
 * than being sent blindly.
 */
export function shouldForwardAgentCommand(
  name: string,
  commands: AgentCommandInfo[] | undefined,
): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower || ABSENCE_LOCAL_COMMANDS.has(lower)) return false;
  return findAgentCommand(commands, lower) !== undefined;
}

/** Rebuild the line the user typed, preserving the agent's own spelling. */
export function formatAgentCommand(name: string, args: string): string {
  const command = name.trim();
  const tail = args.trim();
  return tail.length > 0 ? `/${command} ${tail}` : `/${command}`;
}
