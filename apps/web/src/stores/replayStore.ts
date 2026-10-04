import { create } from "zustand";
import type { DazeEvent, SessionSnapshot } from "@daze/core";
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
  events: DazeEvent[];
  snapshots: ReplaySnapshot[];
  snapshotsDirty: boolean;
  status: ReplayStatus;
  speed: ReplaySpeed;
  currentTime: number;
  view?: ReplayView;

  hydrate: (events: DazeEvent[]) => void;
  ingest: (event: DazeEvent) => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  setSpeed: (speed: ReplaySpeed) => void;
  seekTimestamp: (timestamp: number) => void;
  seekRatio: (ratio: number) => void;
  stepForward: () => void;
  stepBackward: () => void;
  reset: () => void;
}

export const useReplayStore = create<ReplayStore>((set, get) => {
  function ensureSnapshots(): ReplaySnapshot[] {
    const state = get();
    if (state.snapshotsDirty) {
      const snapshots = buildSnapshots(state.events);
      set({ snapshots, snapshotsDirty: false });
      return snapshots;
    }
    return state.snapshots;
  }

  function compute(timestamp: number, snapshots: ReplaySnapshot[]): ReplayView {
    return seek(get().events, snapshots, timestamp);
  }

  return {
    events: [],
    snapshots: [],
    snapshotsDirty: true,
    status: "idle",
    speed: 1,
    currentTime: 0,
    view: undefined,

    hydrate: (events) => {
      clearTimer();
      const snapshots = buildSnapshots(events);
      const end = timelineEnd(events);
      set({
        events,
        snapshots,
        snapshotsDirty: false,
        status: "idle",
        currentTime: end,
        view: seek(events, snapshots, end),
      });
    },

    ingest: (event) => {
      const events = [...get().events, event];
      set({ events, snapshotsDirty: true });
      // While sitting at the live head, keep following; otherwise leave the
      // user's scrub position alone.
      if (get().status === "idle") {
        const snapshots = get().snapshots; // may be stale; the seek below tolerates it
        set({ currentTime: event.timestamp, view: seek(events, snapshots, event.timestamp) });
      }
    },

    play: () => {
      const state = get();
      if (state.events.length === 0) return;
      const snapshots = ensureSnapshots();
      const start = timelineStart(state.events);
      const end = timelineEnd(state.events);
      const from = state.currentTime >= end ? start : state.currentTime;

      set({ status: "playing", currentTime: from, view: compute(from, snapshots) });
      clearTimer();
      timer = setInterval(() => {
        const s = get();
        if (s.status !== "playing") return;
        const events = s.events;
        const snaps = s.snapshotsDirty ? ensureSnapshots() : s.snapshots;
        const limit = timelineEnd(events);
        const next = s.currentTime + TICK_MS * s.speed;
        if (next >= limit) {
          clearTimer();
          set({ currentTime: limit, status: "paused", view: compute(limit, snaps) });
          return;
        }
        set({ currentTime: next, view: compute(next, snaps) });
      }, TICK_MS);
    },

    pause: () => {
      clearTimer();
      if (get().status === "playing") set({ status: "paused" });
    },

    stop: () => {
      clearTimer();
      const { events } = get();
      const end = timelineEnd(events);
      const snapshots = ensureSnapshots();
      set({ status: "idle", currentTime: end, view: compute(end, snapshots) });
    },

    setSpeed: (speed) => set({ speed }),

    seekTimestamp: (timestamp) => {
      const { events } = get();
      if (events.length === 0) return;
      const start = timelineStart(events);
      const end = timelineEnd(events);
      const clamped = Math.min(Math.max(timestamp, start), end);
      const snapshots = ensureSnapshots();
      set({ currentTime: clamped, view: compute(clamped, snapshots) });
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
      const next = nextEventTimestamp(events, currentTime);
      get().seekTimestamp(next ?? timelineEnd(events));
    },

    stepBackward: () => {
      const { events, currentTime } = get();
      const prev = prevEventTimestamp(events, currentTime);
      get().seekTimestamp(prev ?? timelineStart(events));
    },

    reset: () => {
      clearTimer();
      set({
        events: [],
        snapshots: [],
        snapshotsDirty: true,
        status: "idle",
        speed: 1,
        currentTime: 0,
        view: undefined,
      });
    },
  };
});
