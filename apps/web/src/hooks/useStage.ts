import { useEffect, useMemo } from "react";
import type { AgentStatus } from "@absence/core";
import type { StageItem, StageMode } from "../types/stage";
import type { WorldFocus } from "../components/stage/StageWorld";
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

/** Which object the world camera should frame, given what the Stage is showing. */
export function focusFor(mode: StageMode, status: AgentStatus, replayItem?: StageItem): WorldFocus {
  switch (mode) {
    case "file":
      return "reading";
    case "diff":
      return "editing";
    case "terminal":
      return "terminal";
    case "replay":
      switch (replayItem?.type) {
        case "file":
          return "reading";
        case "diff":
          return "editing";
        case "terminal":
          return "terminal";
        default:
          return "desk";
      }
    case "desk":
      return "desk";
    default:
      // live: follow the agent's current action.
      switch (status) {
        case "reading":
        case "searching":
          return "reading";
        case "editing":
          return "editing";
        case "running":
          return "terminal";
        case "thinking":
          return "thinking";
        default:
          return "desk";
      }
  }
}

/**
 * The world camera focus for the agent's *live* activity — the status alone.
 *
 * Used by the desk world while it sits in the top-right panel. Only what is on
 * the Stage participates in replay and pinned views, so the panel just follows
 * the agent as it works instead of mirroring the Stage.
 */
export function useLiveWorldFocus(): WorldFocus {
  const status = useSessionStore((s) => s.agent.status);
  return focusFor("live", status);
}
