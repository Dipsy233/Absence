import { create } from "zustand";
import type { StatsQuery, StatsReport } from "@absence/core";
import * as api from "../lib/api";

/**
 * Cross-session aggregate statistics for the Chart face's "cumulative" tab.
 *
 * Unlike every other face's data, this is not one session's slice: the store
 * holds the server's aggregate over a time window, refetched on a slow poll
 * while the tab is visible. The store keeps the request-token guard the other
 * stores use so a slow response for an abandoned range can never overwrite a
 * newer one.
 */
interface StatsStore {
  report?: StatsReport;
  /** The window the current report was fetched for. */
  query?: StatsQuery;
  loading: boolean;
  error?: string;

  load: (query: StatsQuery) => Promise<void>;
  clear: () => void;
}

let statsRequest = 0;

export const useStatsStore = create<StatsStore>((set) => ({
  report: undefined,
  query: undefined,
  loading: false,
  error: undefined,

  load: async (query) => {
    const request = ++statsRequest;
    set({ loading: true, error: undefined });
    try {
      const report = await api.fetchStats(query);
      if (request !== statsRequest) return;
      set({ report, query, loading: false });
    } catch (error) {
      if (request !== statsRequest) return;
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  clear: () => {
    statsRequest += 1;
    set({ report: undefined, query: undefined, loading: false, error: undefined });
  },
}));
