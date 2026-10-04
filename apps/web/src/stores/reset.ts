import { useChatStore } from "./chatStore";
import { useFileStore } from "./fileStore";
import { useReplayStore } from "./replayStore";
import { useSessionStore } from "./sessionStore";
import { useStageStore } from "./stageStore";
import { useUiStore } from "./uiStore";

/** Drop every store's state — used when closing or switching sessions. */
export function resetAllStores(): void {
  useSessionStore.getState().reset();
  useFileStore.getState().reset();
  useChatStore.getState().reset();
  useReplayStore.getState().clear();
  useStageStore.getState().reset();
  useUiStore.getState().reset();
}
