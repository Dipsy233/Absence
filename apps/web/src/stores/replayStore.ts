import { create } from "zustand";
import type { DazeEvent } from "@daze/core";
import type { ReplaySpeed, ReplaySnapshot, ReplayStatus, ReplayView } from "../types/replay";
import {
  buildSnapshots,
  nextEventTimestamp,
  prevEventTimestamp,
  seek,
  timelineEnd,
  timelineStart,
} from "../lib/replay";

const TICK_MS = 80;

let timer: ReturnType<typeof setInterval> | null = null;

function clearTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

interface ReplayStore {
  /** The events of the run currently being replayed. */
  events: DazeEvent[];
  label?: string;
  snapshots: ReplaySnapshot[];
  status: ReplayStatus;
  speed: ReplaySpeed;
  currentTime: number;
  view?: ReplayView;

  /** Load a run to replay. `startAtEnd` keeps the view at live instead. */
  load: (events: DazeEvent[], options?: { startAtEnd?: boolean; label?: string }) => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  setSpeed: (speed: ReplaySpeed) => void;
  seekTimestamp: (timestamp: number) => void;
  seekRatio: (ratio: number) => void;
  stepForward: () => void;
  stepBackward: () => void;
  clear: () => void;
}

export const useReplayStore = create<ReplayStore>((set, get) => {
  const empty = {
    events: [] as DazeEvent[],
    label: undefined,
    snapshots: [] as ReplaySnapshot[],
    status: "idle" as ReplayStatus,
    speed: 1 as ReplaySpeed,
    currentTime: 0,
    view: undefined,
  };

  return {
    ...empty,

    load: (events, options) => {
      clearTimer();
      const snapshots = buildSnapshots(events);
      const at = options?.startAtEnd ? timelineEnd(events) : timelineStart(events);
      set({
        events,
        label: options?.label,
        snapshots,
        status: options?.startAtEnd ? "idle" : "paused",
        currentTime: at,
        view: seek(events, snapshots, at),
      });
    },

    play: () => {
      const state = get();
      if (state.events.length === 0) return;
      const start = timelineStart(state.events);
      const end = timelineEnd(state.events);
      const from = state.currentTime >= end ? start : state.currentTime;

      set({ status: "playing", currentTime: from, view: seek(state.events, state.snapshots, from) });
      clearTimer();
      timer = setInterval(() => {
        const s = get();
        if (s.status !== "playing") return;
        const limit = timelineEnd(s.events);
        const next = s.currentTime + TICK_MS * s.speed;
        if (next >= limit) {
          clearTimer();
          set({ currentTime: limit, status: "paused", view: seek(s.events, s.snapshots, limit) });
          return;
        }
        set({ currentTime: next, view: seek(s.events, s.snapshots, next) });
      }, TICK_MS);
    },

    pause: () => {
      clearTimer();
      if (get().status === "playing") set({ status: "paused" });
    },

    stop: () => {
      clearTimer();
      const { events, snapshots } = get();
      const end = timelineEnd(events);
      set({ status: "paused", currentTime: end, view: seek(events, snapshots, end) });
    },

    setSpeed: (speed) => set({ speed }),

    seekTimestamp: (timestamp) => {
      const { events, snapshots } = get();
      if (events.length === 0) return;
      const clamped = Math.min(Math.max(timestamp, timelineStart(events)), timelineEnd(events));
      set({ currentTime: clamped, view: seek(events, snapshots, clamped) });
    },

    seekRatio: (ratio) => {
      const { events } = get();
      if (events.length === 0) return;
      const start = timelineStart(events);
      const end = timelineEnd(events);
      get().seekTimestamp(start + Math.min(Math.max(ratio, 0), 1) * (end - start));
    },

    stepForward: () => {
      const { events, currentTime } = get();
      get().seekTimestamp(nextEventTimestamp(events, currentTime) ?? timelineEnd(events));
    },

    stepBackward: () => {
      const { events, currentTime } = get();
      get().seekTimestamp(prevEventTimestamp(events, currentTime) ?? timelineStart(events));
    },

    clear: () => {
      clearTimer();
      set({ ...empty });
    },
  };
});
