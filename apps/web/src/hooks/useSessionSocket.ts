import { useEffect } from "react";
import type { AbsenceEvent, SessionClientMessage, SessionServerMessage } from "@absence/core";
import { useSessionStore } from "../stores/sessionStore";
import { useFileStore } from "../stores/fileStore";
import { useChatStore } from "../stores/chatStore";
import { useStageStore } from "../stores/stageStore";
import { useRunsStore } from "../stores/runsStore";
import { useUiStore } from "../stores/uiStore";
import { useMetricsStore } from "../stores/metricsStore";

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
      const frame: SessionClientMessage = {
        type: "metrics_subscribe",
        eggPid: open ? useMetricsStore.getState().selectedEggPid : undefined,
      };
      socket.send(JSON.stringify(frame));
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
        // A frame can still be dispatched after cleanup called close(). The
        // effect may already be bound to another session, so a stale frame must
        // not touch the stores.
        if (disposed) return;
        let message: SessionServerMessage;
        try {
          message = JSON.parse(raw.data as string) as SessionServerMessage;
        } catch {
          return;
        }
        // Defence in depth for the session boundary. The server already sends
        // only this session's frames, but a frame that names another session
        // must never hydrate or append here.
        if (
          (message.type === "snapshot" || message.type === "session_state") &&
          message.state.session.id !== sessionId
        ) {
          return;
        }
        switch (message.type) {
          case "snapshot":
            useSessionStore.getState().hydrate(message.state);
            useFileStore.getState().hydrate(message.state);
            useChatStore.getState().hydrate(message.state);
            useMetricsStore.getState().hydrate(message.state.metrics);
            break;
          case "events": {
            // One store update per socket batch: the server already coalesced
            // a burst into this frame (see websocket/ws.ts). Filter by the
            // event's own sessionId as well — the payload carries it, and the
            // store is global.
            const events = message.events.filter((event) => event.sessionId === sessionId);
            if (events.length === 0) break;
            useSessionStore.getState().ingestEvents(events);
            useFileStore.getState().ingestEvents(events);
            useChatStore.getState().ingestEvents(events);
            if (isRunBoundary(events)) {
              void useRunsStore.getState().loadRuns(sessionId);
            }
            break;
          }
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
