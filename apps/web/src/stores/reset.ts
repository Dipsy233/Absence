import { useChatStore } from "./chatStore";
import { useFileStore } from "./fileStore";
import { useReplayStore } from "./replayStore";
import { useRunsStore } from "./runsStore";
import { useSessionStore } from "./sessionStore";
import { useStageStore } from "./stageStore";
import { useUiStore } from "./uiStore";
import { useMetricsStore } from "./metricsStore";
import * as api from "../lib/api";

/**
 * Drop every store's state — used when closing or switching sessions.
 *
 * The metrics store is part of this: its ring belongs to the session that is
 * ending. Leaving it behind would make the next session's dashboard open with
 * the previous agent's curve until the first new frame arrived.
 */
export function resetAllStores(): void {
  useSessionStore.getState().reset();
  useFileStore.getState().reset();
  useChatStore.getState().reset();
  useReplayStore.getState().clear();
  useRunsStore.getState().clear();
  useStageStore.getState().reset();
  useUiStore.getState().reset();
  useMetricsStore.getState().reset();
}

/**
 * Leave the current session and go back to the picker.
 *
 * "Change project" is a leave, not a hide: the server owns the metrics sampler
 * and the process watcher, so the session has to be closed there too or it
 * keeps sampling a tree nobody is watching. The close is awaited before the
 * stores reset so the last frames are flushed, but a failure never blocks the
 * user from leaving — the UI is the authority on what they are watching.
 */
export async function leaveSession(): Promise<void> {
  const id = useSessionStore.getState().session?.id;
  if (id) {
    try {
      await api.closeSession(id);
    } catch (error) {
      console.error("[absence] close session failed:", error);
    }
  }
  resetAllStores();
}
