/**
 * The monitor event contract.
 *
 * A session's facts can arrive from three independent observers: the agent's
 * protocol stream, the OS (process/file events) and a terminal mirror. They
 * all publish through one bus so the Stage, Activity and Report never need to
 * know which observer was responsible. The `source` / `fidelity` pair is what
 * lets the UI say how trustworthy a fact is instead of guessing.
 */
import type { AbsenceEvent, EventFidelity, EventSource } from "./events";

/** Which observer produced the fact. */
export type MonitorSource = EventSource;

/**
 * How the fact was obtained:
 *
 * - `exact`    — a kernel event or a protocol value that is exactly known
 * - `reported` — the agent reported it over the protocol
 * - `inferred` — Absence derived it from a window or a shape rule
 * - `unknown`  — the protocol did not carry it; Absence does not invent it
 */
export type MonitorFidelity = EventFidelity;

/** One fact, tagged with where it came from and how sure Absence is. */
export interface MonitorEvent {
  sessionId: string;
  /** Epoch ms; mirrors `event.timestamp` but is the bus's own ordering value. */
  at: number;
  source: MonitorSource;
  fidelity: MonitorFidelity;
  event: AbsenceEvent;
}

/** The only junction between observers and the session/UI layers. */
export interface MonitorBus {
  publish(event: MonitorEvent): void;
  subscribe(listener: (event: MonitorEvent) => void): () => void;
}
