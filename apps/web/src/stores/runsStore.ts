import { create } from "zustand";
import type { AbsenceEvent, RunSummary } from "@absence/core";
import * as api from "../lib/api";

/**
 * History is a list of run summaries; Activity is the events of the one run the
 * user selected. Keeping them in separate stores means the History panel never
 * has to load an event to draw a row, and selecting a historical run costs one
 * range query instead of growing the live window.
 *
 * Only one run's events are held at a time. That is deliberate: the whole point
 * of the split is bounded memory.
 */
interface RunsStore {
  runs: RunSummary[];
  loading: boolean;
  /** Events of the selected historical run, keyed by run id. */
  selectedEvents?: { runId: string; events: AbsenceEvent[] };
  /** The run whose events are currently being fetched, if any. */
  pendingRunId?: string;
  eventsLoading: boolean;
  error?: string;

  hydrate: (runs: RunSummary[]) => void;
  loadRuns: (sessionId: string) => Promise<void>;
  loadRunEvents: (sessionId: string, run: RunSummary) => Promise<void>;
  clear: () => void;
}

let runsRequest = 0;
let eventsRequest = 0;

export const useRunsStore = create<RunsStore>((set, get) => ({
  runs: [],
  loading: false,
  selectedEvents: undefined,
  pendingRunId: undefined,
  eventsLoading: false,
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
    if (get().selectedEvents?.runId === run.id) return;
    // Activity and Report both ask for the selected run; only one fetch.
    if (get().pendingRunId === run.id) return;
    // A newer selection supersedes an in-flight one; the request token below
    // makes the older response a no-op.
    const request = ++eventsRequest;
    set({ pendingRunId: run.id, eventsLoading: true, error: undefined });
    try {
      const data = await api.fetchRunEvents(sessionId, run.index);
      if (request !== eventsRequest) return;
      set({
        selectedEvents: { runId: run.id, events: data.events },
        pendingRunId: undefined,
        eventsLoading: false,
      });
    } catch (error) {
      if (request !== eventsRequest) return;
      set({
        pendingRunId: undefined,
        eventsLoading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  clear: () => {
    runsRequest += 1;
    eventsRequest += 1;
    set({
      runs: [],
      loading: false,
      selectedEvents: undefined,
      pendingRunId: undefined,
      eventsLoading: false,
      error: undefined,
    });
  },
}));
