import type { AbsenceEvent } from "./events";
import type { MetricsFrame } from "./metrics";
import type { SessionRuntimeState, SessionSnapshot } from "./types";

/* ══════════════════════════════════════════════════════════════════════════
   The websocket protocol frames — the contract both ends compile against.

   Server → client on WS /ws/sessions/:id: one snapshot on connect, then event
   batches, metrics frames and session-state updates. Client → server: only
   the metrics subscription (read02 §42). The terminal mirror has its own
   socket and its own, much dumber frames.

   These unions live in core, not beside the socket code, so a frame added on
   the server without a client case (or vice versa) is a type error on both
   ends — the old hand-written copies drifted, and one client branch even
   listened for a frame the server never sends.
   ══════════════════════════════════════════════════════════════════════════ */

/** Server → client, WS /ws/sessions/:id. */
export type SessionServerMessage =
  | { type: "snapshot"; state: SessionSnapshot }
  | { type: "events"; events: AbsenceEvent[] }
  | { type: "metrics"; frame: MetricsFrame }
  | { type: "session_state"; state: SessionRuntimeState }
  | { type: "error"; message: string };

/** Client → server, WS /ws/sessions/:id. */
export type SessionClientMessage =
  /** Ask for the selected egg to be sampled at the fast cadence while its
      dashboard page is open; `undefined` releases the cadence. */
  | { type: "metrics_subscribe"; eggPid?: number };

/** Server → client, WS /ws/sessions/:id/terminal. */
export type TerminalServerMessage =
  | { type: "output"; chunk: string }
  | { type: "ended" }
  | { type: "unavailable"; reason: string }
  | { type: "error"; message: string };
