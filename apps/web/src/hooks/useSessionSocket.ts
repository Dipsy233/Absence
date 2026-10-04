import { useEffect } from "react";
import type { DazeEvent, SessionRuntimeState, SessionSnapshot } from "@daze/core";
import { useDazeStore } from "../stores/useDazeStore";

type ServerMessage =
  | { type: "snapshot"; state: SessionSnapshot }
  | { type: "event"; event: DazeEvent }
  | { type: "session_state"; state: SessionRuntimeState }
  | { type: "error"; message: string };

/**
 * Opens the websocket for a session and pipes messages into the store.
 * Reconnects with backoff if the connection drops.
 */
export function useSessionSocket(sessionId: string | undefined): void {
  const ingestSnapshot = useDazeStore((s) => s.ingestSnapshot);
  const ingestEvent = useDazeStore((s) => s.ingestEvent);
  const ingestRuntimeState = useDazeStore((s) => s.ingestRuntimeState);
  const setConnected = useDazeStore((s) => s.setConnected);

  useEffect(() => {
    if (!sessionId) return;
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
        setConnected(true);
      };

      socket.onmessage = (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data as string) as ServerMessage;
        } catch {
          return;
        }
        switch (message.type) {
          case "snapshot":
            ingestSnapshot(message.state);
            break;
          case "event":
            ingestEvent(message.event);
            break;
          case "session_state":
            ingestRuntimeState(message.state);
            break;
          case "error":
            break;
        }
      };

      socket.onclose = () => {
        if (disposed) return;
        setConnected(false);
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      setConnected(false);
    };
  }, [sessionId, ingestSnapshot, ingestEvent, ingestRuntimeState, setConnected]);
}
