/**
 * `/` lines are the agent's, not Absence's.
 *
 * Absence does not parse or implement `/model`, `/skill`, `/mcp` or any other
 * product command: a line the user typed is forwarded as a prompt and the agent
 * decides what it means. This module only rebuilds the line for the legacy
 * `{name, args}` HTTP shape, preserving the agent's own spelling.
 */
export function formatAgentCommand(name: string, args: string): string {
  const command = name.trim();
  const tail = args.trim();
  return tail.length > 0 ? `/${command} ${tail}` : `/${command}`;
}
