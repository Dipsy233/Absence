import { useEffect, useMemo } from "react";
import type { StageItem, StageMode } from "../types/stage";
import { useSessionStore } from "../stores/sessionStore";
import { useStageStore } from "../stores/stageStore";
import { useReplayStore } from "../stores/replayStore";
import { eventToStageItem } from "../lib/events";

/** The Stage item for the agent's current action (read02 §14). */
export function useLiveItem(): StageItem | undefined {
  const currentAction = useSessionStore((s) => s.currentAction);
  return useMemo(() => (currentAction ? eventToStageItem(currentAction) : undefined), [currentAction]);
}

/** The Stage item for the replay position. Memoised on the action, not per render. */
export function useReplayItem(): StageItem | undefined {
  const currentAction = useReplayStore((s) => s.view?.currentAction);
  return useMemo(() => (currentAction ? eventToStageItem(currentAction) : undefined), [currentAction]);
}

export interface StageView {
  mode: StageMode;
  following: boolean;
  item?: StageItem;
  liveItem?: StageItem;
}

/** Resolves what the Stage should render right now. */
export function useStageView(): StageView {
  const mode = useStageStore((s) => s.mode);
  const following = useStageStore((s) => s.following);
  const activeItem = useStageStore((s) => s.activeItem);
  const noteItem = useStageStore((s) => s.noteItem);
  const liveItem = useLiveItem();

  // Keep the mode buttons aware of what the agent has actually produced.
  useEffect(() => {
    if (liveItem) noteItem(liveItem);
  }, [liveItem, noteItem]);

  return { mode, following, item: following ? liveItem : activeItem, liveItem };
}
