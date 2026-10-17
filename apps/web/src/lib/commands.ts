import type { CommandOption } from "@absence/core";

/** How a command takes its argument. */
export type CommandKind =
  /** Pick one of a list of options (from the server, or `staticOptions`). */
  | "choice"
  /** A free-text argument; an empty argument is allowed for some. */
  | "text"
  /** No argument — runs immediately on selection. */
  | "none";

export interface CommandSpec {
  name: string;
  description: string;
  /** Shown in the palette as a hint for the argument. */
  argHint?: string;
  kind: CommandKind;
  /** Options that don't need a server round-trip (e.g. /export's formats). */
  staticOptions?: CommandOption[];
}

/**
 * The chat commands the terminal box understands. The list lives on the client
 * so the palette can filter instantly; the server owns the execution and the
 * choice lists that depend on the runtime (models, thinking levels).
 */
export const COMMANDS: CommandSpec[] = [
  { name: "model", description: "Switch the model", argHint: "<provider/id>", kind: "choice" },
  { name: "thinking", description: "Set the thinking level", argHint: "<level>", kind: "choice" },
  { name: "permission", description: "Set the sandbox / permission level", argHint: "<level>", kind: "choice" },
  { name: "compact", description: "Compact the context", argHint: "[instructions]", kind: "text" },
  { name: "name", description: "Set the session name", argHint: "<name>", kind: "text" },
  { name: "session", description: "Show session info and stats", kind: "none" },
  {
    name: "skill",
    description: "List skills — load one with /skill:<name>",
    argHint: "[name]",
    kind: "text",
  },
  {
    name: "mcp",
    description: "MCP servers: list, reconnect (config edits belong to pi mcp / codex mcp)",
    argHint: "[list|reconnect] [server]",
    kind: "choice",
    staticOptions: [
      { value: "list", label: "list", description: "servers and whether they connected" },
      { value: "reconnect", label: "reconnect", description: "reconnect one in this session" },
    ],
  },
  {
    name: "export",
    description: "Export the session",
    argHint: "<html|jsonl>",
    kind: "choice",
    staticOptions: [
      { value: "html", label: "html", description: "single-file page" },
      { value: "jsonl", label: "jsonl", description: "raw session log" },
    ],
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name.toLowerCase() === name.toLowerCase());
}

/**
 * `/skill:<name> [request]` is a skill *invocation*, not a command: Pi expands
 * it into the skill's instructions before the prompt reaches the model. The
 * palette offers the names, so the exact spelling is discoverable.
 */
export function isSkillInvocation(text: string): boolean {
  return text.startsWith("/skill:");
}
