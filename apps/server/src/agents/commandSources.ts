import type { AgentCommandInfo } from "@absence/core";

/**
 * One adapter-owned source of `/` commands.
 *
 * ACP agents publish their list through `available_commands_update`; that is
 * the primary source and needs no source object. This interface exists for an
 * adapter whose own runtime can also expose commands (a native RPC, a side
 * channel, a plugin), so the extra list stays inside the adapter instead of
 * leaking a product name into the session or UI layer.
 *
 * `commands()` is a synchronous snapshot: do the async work in the adapter,
 * cache the result, then call the source's listeners when it changes.
 */
export interface AgentCommandSource {
  /** Stable diagnostic id; it never reaches the UI. */
  readonly id: string;
  commands(): readonly AgentCommandInfo[];
  /** Optional change notification, so the session can push a new state. */
  subscribe?(listener: () => void): () => void;
}

/**
 * Merge command sources in priority order. The first source that declares a
 * name owns that row; later sources may add names but never replace one.
 * Empty names are skipped, and matching is case-insensitive like the palette.
 */
export function mergeCommandSources(sources: readonly AgentCommandSource[]): AgentCommandInfo[] {
  const merged = new Map<string, AgentCommandInfo>();
  for (const source of sources) {
    for (const command of source.commands()) {
      const name = command.name.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (merged.has(key)) continue;
      merged.set(key, {
        name,
        ...(command.description !== undefined ? { description: command.description } : {}),
      });
    }
  }
  return [...merged.values()];
}
