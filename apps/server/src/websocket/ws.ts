import type { FastifyInstance } from "fastify";
import type { AbsenceEvent } from "@absence/core";
import { sessionStore } from "../sessions/SessionStore";

/** Minimal shape of the ws socket we use — avoids depending on ws types. */
interface ClientSocket {
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  readyState: number;
}

const OPEN = 1;

/**
 * Event batching window. A run can emit many events per second (process
 * creation, file changes, streamed text); sending each as its own JSON frame
 * makes the client run a React update per event. One frame per window lets the
 * client fold the batch into a single store update.
 */
const EVENT_FLUSH_MS = 50;
const EVENT_BATCH_MAX = 200;

function send(socket: ClientSocket, message: unknown): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // socket went away between the check and the send
  }
}

/**
 * WS /ws/sessions/:id (read.md §11, §33).
 *
 * On connect we replay the current snapshot, then stream AbsenceEvents and
 * session-state updates.
 */
export async function wsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws/sessions/:id", { websocket: true }, async (socket, request) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) {
      send(socket as unknown as ClientSocket, { type: "error", message: "session not found" });
      (socket as unknown as ClientSocket).close();
      return;
    }

    const client = socket as unknown as ClientSocket;
    send(client, { type: "snapshot", state: await session.snapshot() });

    // Buffer events for this client only: a slow reader loses its own frames,
    // never another client's. The batch is flushed on a timer, on size, and on
    // close so a burst is never left in memory.
    let pending: AbsenceEvent[] = [];
    let flushTimer: NodeJS.Timeout | undefined;
    const flushEvents = () => {
      if (pending.length === 0) return;
      const events = pending;
      pending = [];
      send(client, { type: "events", events });
    };
    const queueEvent = (event: AbsenceEvent) => {
      pending.push(event);
      if (pending.length >= EVENT_BATCH_MAX) {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = undefined;
        flushEvents();
        return;
      }
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        flushEvents();
      }, EVENT_FLUSH_MS);
    };

    const unsubscribeEvents = session.bus.subscribe(queueEvent);
    const unsubscribeState = session.stateBus.subscribe((state) => {
      send(client, { type: "session_state", state });
    });
    const unsubscribeMetrics = session.onMetrics((frame) => {
      send(client, { type: "metrics", frame });
    });

    // The dashboard asks for the selected egg to be sampled at 2s while it is
    // open. Nothing else on this socket is client-to-server.
    client.on("message", (raw: unknown) => {
      try {
        const message = JSON.parse(String(raw)) as { type?: string; eggPid?: number };
        if (message.type === "metrics_subscribe") {
          session.setMetricsHotEgg(
            typeof message.eggPid === "number" && message.eggPid > 0 ? message.eggPid : undefined,
          );
        }
      } catch {
        // Ignore malformed client frames; this socket is otherwise one-way.
      }
    });

    client.on("close", () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      flushEvents();
      unsubscribeEvents();
      unsubscribeState();
      unsubscribeMetrics();
    });
  });

  /**
   * WS /ws/sessions/:id/terminal — the agent's terminal, mirrored.
   *
   * A separate socket from the event stream on purpose. Terminal output is a
   * byte firehose (a redrawing spinner's hundreds of writes a second); sharing
   * the event socket would make the event stream back up behind it, and every
   * client would need to demultiplex two very different traffic shapes. Here a
   * slow reader only loses its own frames.
   *
   * There is no input direction: this is a mirror of a terminal somebody else
   * owns. Typing into the agent happens in the agent's own terminal.
   */
  app.get("/ws/sessions/:id/terminal", { websocket: true }, (socket, request) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    const client = socket as unknown as ClientSocket;
    if (!session) {
      send(client, { type: "error", message: "session not found" });
      client.close();
      return;
    }
    if (!session.terminal) {
      // An agent somebody else started: its terminal is not ours to read. Say
      // so once and close, rather than leaving a socket that never speaks.
      send(client, { type: "unavailable", reason: "this agent's terminal is not visible to Absence" });
      client.close();
      return;
    }
    const mirror = session.terminal;
    const unsubscribe = mirror.subscribe((chunk) => send(client, { type: "output", chunk }));
    if (mirror.finished) send(client, { type: "ended" });
    client.on("close", unsubscribe);
  });
}
