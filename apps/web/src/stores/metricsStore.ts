import { create } from "zustand";
import type { MetricsFrame } from "@absence/core";

/** Keep the same window as the server's ring (2s × 300 ≈ 10 minutes). */
const MAX_FRAMES = 300;

interface MetricsStore {
  frames: MetricsFrame[];
  /** Bumped whenever `frames` changes; the array is mutated in place. */
  version: number;
  /** The egg the panel and dashboard follow. */
  selectedEggPid?: number;

  hydrate: (frames?: MetricsFrame[]) => void;
  ingest: (frame: MetricsFrame) => void;
  selectEgg: (eggPid?: number) => void;
  reset: () => void;
}

/**
 * The live metric ring. Frames are appended in place (like the egg map) so a
 * 2s tick does not copy a 300-frame array; components subscribe to `version`.
 */
export const useMetricsStore = create<MetricsStore>((set, get) => ({
  frames: [],
  version: 0,
  selectedEggPid: undefined,

  hydrate: (incoming) => {
    const frames = incoming ? [...incoming] : [];
    set({ frames, version: get().version + 1 });
  },

  ingest: (frame) => {
    const frames = get().frames;
    const last = frames[frames.length - 1];
    if (last && last.ts === frame.ts) {
      frames[frames.length - 1] = frame;
    } else if (last && frame.ts < last.ts) {
      // A reconnect replay: keep the ring chronological and drop duplicates.
      const index = frames.findIndex((entry) => entry.ts === frame.ts);
      if (index >= 0) frames[index] = frame;
      else frames.push(frame);
      frames.sort((a, b) => a.ts - b.ts);
    } else {
      frames.push(frame);
    }
    if (frames.length > MAX_FRAMES) frames.splice(0, frames.length - MAX_FRAMES);
    set({ version: get().version + 1 });
  },

  selectEgg: (selectedEggPid) => set({ selectedEggPid }),

  reset: () => set({ frames: [], version: get().version + 1, selectedEggPid: undefined }),
}));
