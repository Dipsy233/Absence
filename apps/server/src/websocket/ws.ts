import type { FastifyInstance } from "fastify";
import type {
  AbsenceEvent,
  SessionClientMessage,
  SessionServerMessage,
} from "@absence/core";
import { sessionStore } from "../sessions/SessionStore";
import { readEventsPageForward } from "../sessions/archive";

/** Minimal shape of the ws socket we use — avoids depending on ws types. */
interface ClientSocket {
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  readyState: number;
}

const OPEN = 1;

/** A query-string positive integer, or undefined when absent/invalid. */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Event batching window. A run can emit many events per second (process
 * creation, file changes, streamed text); sending each as its own JSON frame
 * makes the client run a React update per event. One frame per window lets the
 * client fold the batch into a single store update.
 */
const EVENT_FLUSH_MS = 50;
const EVENT_BATCH_MAX = 200;

function send(socket: ClientSocket, message: SessionServerMessage): void {
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
 *
 * `?since=<seq>` turns the snapshot into a catch-up: the client sends the seq
 * of the last event it persisted (`event.seq` on every archive-read event) and
 * receives the state plus only the events after it, instead of re-downloading
 * up to 2000 events on every reconnect. If more than one catch-up page exists,
 * `state.events` stops at the page boundary and the rest is fetched from
 * GET /api/sessions/:id/events?after=<seq> before going back to live frames.
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
    const since = parsePositiveInt(
      (request.query as { since?: string } | undefined)?.since,
    );
    if (since !== undefined) {
      // Reads flush the pending buffer first, so the page is current at the
      // moment the socket switches to live frames — nothing is lost between
      // the catch-up page and the subscription below.
      const state = await session.snapshot();
      const page = await readEventsPageForward(id, { after: since, limit: 2000 });
      state.events = page.events;
      send(client, { type: "snapshot", state });
    } else {
      send(client, { type: "snapshot", state: await session.snapshot() });
    }

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
        const message = JSON.parse(String(raw)) as SessionClientMessage;
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
}
