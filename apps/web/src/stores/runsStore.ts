import { create } from "zustand";
import type { AbsenceEvent, RunSummary } from "@absence/core";
import * as api from "../lib/api";

/**
 * History is a list of run summaries; Activity is the events of the runs the
 * user opened. Keeping them apart means the History panel never has to load an
 * event to draw a row, and selecting a run costs one range query instead of
 * growing the live window.
 *
 * Opened runs are cached by id, capped: opening two runs side by side is a
 * normal thing to do, holding every run of a session is not.
 */
const CACHED_RUNS = 4;

interface RunsStore {
  runs: RunSummary[];
  loading: boolean;
  /** Events of the runs that have been opened, by run id. */
  eventsByRun: Record<string, AbsenceEvent[]>;
  /** Run ids in the order they were opened — the cap drops the oldest. */
  eventsOrder: string[];
  /** The runs whose events are being fetched right now. */
  pending: Record<string, true>;
  error?: string;

  hydrate: (runs: RunSummary[]) => void;
  loadRuns: (sessionId: string) => Promise<void>;
  loadRunEvents: (sessionId: string, run: RunSummary) => Promise<void>;
  clear: () => void;
}

let runsRequest = 0;
let generation = 0;

export const useRunsStore = create<RunsStore>((set, get) => ({
  runs: [],
  loading: false,
  eventsByRun: {},
  eventsOrder: [],
  pending: {},
  error: undefined,

  hydrate: (runs) => {
    // A snapshot supersedes a fetch that was in flight for the same session.
    runsRequest += 1;
    set({ runs, loading: false });
  },

  loadRuns: async (sessionId) => {
    const request = ++runsRequest;
    set({ loading: true });
    try {
      const runs = await api.fetchRuns(sessionId);
      if (request !== runsRequest) return;
      set({ runs, loading: false });
    } catch (error) {
      if (request !== runsRequest) return;
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  loadRunEvents: async (sessionId, run) => {
    if (get().eventsByRun[run.id] || get().pending[run.id]) return;
    const at = generation;
    set({ pending: { ...get().pending, [run.id]: true }, error: undefined });
    try {
      const data = await api.fetchRunEvents(sessionId, run.index);
      if (at !== generation) return;
      const { eventsByRun, eventsOrder, pending } = get();
      const order = eventsOrder.filter((id) => id !== run.id);
      order.push(run.id);
      const next: Record<string, AbsenceEvent[]> = { ...eventsByRun, [run.id]: data.events };
      while (order.length > CACHED_RUNS) {
        const drop = order.shift();
        if (drop) delete next[drop];
      }
      const rest = { ...pending };
      delete rest[run.id];
      set({ eventsByRun: next, eventsOrder: order, pending: rest });
    } catch (error) {
      if (at !== generation) return;
      const rest = { ...get().pending };
      delete rest[run.id];
      set({
        pending: rest,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  clear: () => {
    generation += 1;
    runsRequest += 1;
    set({
      runs: [],
      loading: false,
      eventsByRun: {},
      eventsOrder: [],
      pending: {},
      error: undefined,
    });
  },
}));
