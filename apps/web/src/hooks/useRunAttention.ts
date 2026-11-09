import { useMemo, useRef } from "react";
import { isAgentBusy, type AbsenceEvent, type AgentStatus } from "@absence/core";
import { useNow } from "./useNow";
import { useAttentionOptions } from "./useAttentionOptions";
import { buildRunFacts, renderLive } from "../lib/report";
import type { Attention, RunFacts } from "../types/report";
import type { HistoryRun } from "../types/history";

/**
 * The run's facts and its human-attention verdict, for every face that reads
 * them: Monitor's centre and the attention notices.
 *
 * `buildRunFacts` walks the whole run, so it is clamped to twice a second —
 * the same budget the chime uses. Latest events arrive through a ref: the
 * session store hands out a fresh `events` array per socket batch, and making
 * that a dependency recomputed the whole run twenty times a second.
 */
export interface RunAttention {
  facts?: RunFacts;
  attention: Attention;
  /** The live "what is it doing" sentence, only while the run is in flight. */
  headline?: string;
}

const NO_ATTENTION: Attention = { level: "none", reasons: [], evidence: [] };

const FACTS_INTERVAL_MS = 500;

export function useRunAttention(
  run: HistoryRun | undefined,
  events: AbsenceEvent[],
  status: AgentStatus,
): RunAttention {
  const options = useAttentionOptions();
  const tick = useNow(FACTS_INTERVAL_MS);

  const eventsRef = useRef(events);
  eventsRef.current = events;

  // Only redo the whole-run reduction when the run's event slice actually
  // changed. The 500 ms tick exists to *notice* appended events (they arrive
  // through a ref, not a dependency), but while the agent is thinking nothing
  // is appended — the old code rebuilt the entire run twice a second for no
  // change. This cache keys on the run identity plus the slice's tail, so a
  // streamed chunk (a new last id) still triggers a rebuild.
  const cacheRef = useRef<{ sig: string; options: unknown; facts?: RunFacts }>({
    sig: "",
    options: undefined,
    facts: undefined,
  });

  const facts = useMemo(() => {
    void tick;
    if (!run) return undefined;
    const current = eventsRef.current;
    const last = current[current.length - 1];
    const sig = `${run.id}|${run.status}|${current.length}|${last?.id ?? ""}`;
    const cache = cacheRef.current;
    if (cache.sig === sig && cache.options === options) return cache.facts;
    let next: RunFacts | undefined;
    try {
      next = buildRunFacts(current, run, options);
    } catch {
      // A partially-built run (a snapshot that arrived mid-stream) must not
      // take the face down; the feed still works without the facts.
      next = undefined;
    }
    cacheRef.current = { sig, options, facts: next };
    return next;
  }, [run?.id, run?.status, tick, options]);

  const running = run?.status === "running";
  const busy = isAgentBusy(status);
  const live = useMemo(
    () => (facts && running ? renderLive(facts, { busy, status }, options) : undefined),
    [facts, running, busy, status, options],
  );

  return {
    facts,
    attention: live?.attention ?? facts?.attention ?? NO_ATTENTION,
    headline: live?.headline,
  };
}
