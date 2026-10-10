import type { AbsenceEvent } from "@absence/core";
import { useReplayStore } from "../stores/replayStore";

export interface ReplayClock {
  start: number;
  end: number;
  duration: number;
  currentTime: number;
  progress: number;
}

/** Derived replay timing for the timeline and controls. */
export function useReplayClock(): ReplayClock {
  const events = useReplayStore((s) => s.events);
  const currentTime = useReplayStore((s) => s.currentTime);
  return computeClock(events, currentTime);
}

export function computeClock(events: AbsenceEvent[], currentTime: number): ReplayClock {
  const start = events[0]?.timestamp ?? 0;
  const end = events[events.length - 1]?.timestamp ?? 0;
  const duration = Math.max(1, end - start);
  const progress = Math.min(1, Math.max(0, (currentTime - start) / duration));
  return { start, end, duration, currentTime, progress };
}
