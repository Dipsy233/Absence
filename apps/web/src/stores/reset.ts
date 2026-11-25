import { useChatStore } from "./chatStore";
import { useFileStore } from "./fileStore";
import { useReplayStore } from "./replayStore";
import { useRunsStore } from "./runsStore";
import { useSessionStore } from "./sessionStore";
import { useStageStore } from "./stageStore";
import { useUiStore } from "./uiStore";
import { useMetricsStore } from "./metricsStore";
import { clearSessionRoute } from "../lib/route";

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
 * Leave the current session and go back to the board.
 *
 * This is a *detach*, not a teardown: Absence observes, so the monitoring keeps
 * running on the server — the session lives until its monitor lease ends or
 * the silence sweep archives it, and the archive stays readable. Closing the
 * live session here (the old `POST /close`) would stop the watchers and the
 * sampling cadence just because nobody has a tab open, which is exactly what a
 * monitor is not.
 *
 * The observation's lifetime is the server's decision (see
 * `SessionStore.archiveIdle` and the monitor leases); the UI is only the
 * window onto it.
 */
export async function leaveSession(): Promise<void> {
  resetAllStores();
  clearSessionRoute();
}
