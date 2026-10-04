import { useEffect } from "react";
import type { DazeEvent, SessionRuntimeState, SessionSnapshot } from "@daze/core";
import { useSessionStore } from "../stores/sessionStore";
import { useFileStore } from "../stores/fileStore";
import { useChatStore } from "../stores/chatStore";
import { useStageStore } from "../stores/stageStore";
import { useUiStore } from "../stores/uiStore";

type ServerMessage =
  | { type: "snapshot"; state: SessionSnapshot }
  | { type: "event"; event: DazeEvent }
  | { type: "session_state"; state: SessionRuntimeState }
  | { type: "error"; message: string };

/**
 * Opens the session websocket and fans each message out to the stores
 * (read02 §42). Reconnects with backoff.
 */
export function useSessionSocket(sessionId: string | undefined): void {
  useEffect(() => {
    if (!sessionId) return;

    useStageStore.getState().reset();
    useUiStore.getState().reset();

    let socket: WebSocket | undefined;
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws/sessions/${sessionId}`);

      socket.onopen = () => {
        if (disposed) return;
        attempt = 0;
        useSessionStore.getState().setConnected(true);
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
            break;
          case "event":
            useSessionStore.getState().ingestEvent(message.event);
            useFileStore.getState().ingest(message.event);
            useChatStore.getState().ingest(message.event);
            break;
          case "session_state":
            useSessionStore.getState().applyRuntimeState(message.state);
            useFileStore.getState().setTree(message.state.tree);
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
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      useSessionStore.getState().setConnected(false);
    };
  }, [sessionId]);
}
