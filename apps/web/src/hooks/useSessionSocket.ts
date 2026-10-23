import { useEffect } from "react";
import type { AbsenceEvent, SessionRuntimeState, SessionSnapshot } from "@absence/core";
import { useSessionStore } from "../stores/sessionStore";
import { useFileStore } from "../stores/fileStore";
import { useChatStore } from "../stores/chatStore";
import { useStageStore } from "../stores/stageStore";
import { useRunsStore } from "../stores/runsStore";
import { useUiStore } from "../stores/uiStore";
import { useMetricsStore } from "../stores/metricsStore";
import type { MetricsFrame } from "@absence/core";

type ServerMessage =
  | { type: "snapshot"; state: SessionSnapshot }
  | { type: "event"; event: AbsenceEvent }
  | { type: "events"; events: AbsenceEvent[] }
  | { type: "metrics"; frame: MetricsFrame }
  | { type: "session_state"; state: SessionRuntimeState }
  | { type: "error"; message: string };

/** A user message opens a run; agent_end closes it. Both change History. */
function isRunBoundary(events: AbsenceEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === "agent_end" ||
      (event.type === "message" && event.payload.role === "user"),
  );
}

/**
 * Opens the session websocket and fans each message out to the stores
 * (read02 §42). Reconnects with backoff.
 */
export function useSessionSocket(sessionId: string | undefined): void {
  useEffect(() => {
    if (!sessionId) return;

    useStageStore.getState().reset();
    useUiStore.getState().reset();
    useMetricsStore.getState().reset();

    let socket: WebSocket | undefined;
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    // The dashboard's selected egg gets the sampler's fast cadence back while
    // the dashboard is open. Closing it releases the cadence again, so a
    // session with hundreds of eggs does not keep paying for 2s sampling.
    const sendHotEgg = () => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const open = useUiStore.getState().metricsOpen;
      socket.send(
        JSON.stringify({
          type: "metrics_subscribe",
          eggPid: open ? useMetricsStore.getState().selectedEggPid : undefined,
        }),
      );
    };
    const unsubscribeHotEgg = useMetricsStore.subscribe((state, previous) => {
      if (state.selectedEggPid !== previous.selectedEggPid) sendHotEgg();
    });
    const unsubscribeMetricsOpen = useUiStore.subscribe((state, previous) => {
      if (state.metricsOpen !== previous.metricsOpen) sendHotEgg();
    });

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws/sessions/${sessionId}`);

      socket.onopen = () => {
        if (disposed) return;
        attempt = 0;
        useSessionStore.getState().setConnected(true);
        sendHotEgg();
      };

      socket.onmessage = (raw) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(raw.data as string) as ServerMessage;
        } catch {
          return;
        }
        switch (message.type) {
          case "snapshot":
            useSessionStore.getState().hydrate(message.state);
            useFileStore.getState().hydrate(message.state);
            useChatStore.getState().hydrate(message.state);
            useMetricsStore.getState().hydrate(message.state.metrics);
            break;
          case "event":
            useSessionStore.getState().ingestEvent(message.event);
            useFileStore.getState().ingest(message.event);
            useChatStore.getState().ingest(message.event);
            if (isRunBoundary([message.event])) void useRunsStore.getState().loadRuns(sessionId);
            break;
          case "events":
            // One store update per socket batch: the server already coalesced
            // a burst into this frame (see websocket/ws.ts).
            useSessionStore.getState().ingestEvents(message.events);
            useFileStore.getState().ingestEvents(message.events);
            useChatStore.getState().ingestEvents(message.events);
            if (isRunBoundary(message.events)) {
              void useRunsStore.getState().loadRuns(sessionId);
            }
            break;
          case "metrics":
            useMetricsStore.getState().ingest(message.frame);
            break;
          case "session_state":
            useSessionStore.getState().applyRuntimeState(message.state);
            // `tree` is only present when it actually changed; an absent tree
            // must leave the current one alone, not clear the Files panel.
            if (message.state.tree !== undefined) {
              useFileStore.getState().setTree(message.state.tree);
            }
            break;
          case "error":
            break;
        }
      };

      socket.onclose = () => {
        if (disposed) return;
        useSessionStore.getState().setConnected(false);
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };

      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      disposed = true;
      unsubscribeHotEgg();
      unsubscribeMetricsOpen();
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      useSessionStore.getState().setConnected(false);
    };
  }, [sessionId]);
}
