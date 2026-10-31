import { useMemo } from "react";
import { countEggs, primaryEggs, sortEggs, summarizeTools, type Egg, type EggCounts, type ToolSummary } from "../lib/eggs";
import { useSessionStore } from "../stores/sessionStore";

/**
 * The session's eggs, derived once: the full map sorted, the primary eggs
 * (helpers folded), the tool summary, and the counts.
 *
 * The egg map lives in `sessionStore` under a version counter — the store
 * mutates the map in place and bumps the version, so the map is read via
 * `getState()` and `version` is the re-render trigger. Every face that showed
 * eggs re-derived this same pipeline (`sortEggs` → `primaryEggs` → counts), so
 * it lives here; the dock badge and the rail list now read one source and
 * cannot disagree.
 */
export interface EggsData {
  /** All eggs, newest activity first. */
  sorted: Egg[];
  /** The primary eggs — helpers folded into their parent command. */
  eggs: Egg[];
  tools: ToolSummary;
  counts: EggCounts;
  /** How many older finished processes were folded away entirely. */
  retired: number;
}

export function useEggs(): EggsData {
  const version = useSessionStore((s) => s.eggState.version);
  const retired = useSessionStore((s) => s.eggState.retired);
  const eggsMap = useSessionStore.getState().eggState.eggs;

  const sorted = useMemo(() => sortEggs(eggsMap), [eggsMap, version]);
  const eggs = useMemo(() => primaryEggs(sorted), [sorted]);
  const tools = useMemo(() => summarizeTools(sorted), [sorted]);

  return { sorted, eggs, tools, counts: countEggs(eggs), retired };
}
