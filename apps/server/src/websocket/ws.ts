import type { FastifyInstance } from "fastify";
import { sessionStore } from "../sessions/SessionStore";

/** Minimal shape of the ws socket we use — avoids depending on ws types. */
interface ClientSocket {
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  readyState: number;
}

const OPEN = 1;

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
  app.get("/ws/sessions/:id", { websocket: true }, (socket, request) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) {
      send(socket as unknown as ClientSocket, { type: "error", message: "session not found" });
      (socket as unknown as ClientSocket).close();
      return;
    }

    const client = socket as unknown as ClientSocket;
    send(client, { type: "snapshot", state: session.snapshot() });

    const unsubscribeEvents = session.bus.subscribe((event) => {
      send(client, { type: "event", event });
    });
    const unsubscribeState = session.stateBus.subscribe((state) => {
      send(client, { type: "session_state", state });
    });

    client.on("close", () => {
      unsubscribeEvents();
      unsubscribeState();
    });
  });
}
