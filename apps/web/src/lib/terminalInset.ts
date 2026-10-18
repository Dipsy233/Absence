import type { AbsenceEvent } from "@absence/core";
import type { StageItem } from "../types/stage";
import { clearsStage, eventToMcpInset, isMcpEvent, mcpInsetItem } from "./events";

/**
 * The Stage's docked terminal inset — where MCP calls are shown.
 *
 * An MCP call used to be a Stage *page*: it covered the whole body, opaque,
 * and stayed there until the next activity pushed it away. That is wrong for
 * what the call is. It runs *alongside* the work — the read, the diff, the
 * command — so it is docked above the chat as a small terminal pane that never
 * covers the Stage, and it retracts by itself a moment after the call ends.
 *
 * The rules, in order:
 *   1. A finished call appears and starts a `HOLD_MS` retract timer.
 *   2. A call in flight (a `tool_start` for an `mcp__` tool) is pinned open —
 *      no timer runs, so a slow server stays visible for as long as it is slow.
 *   3. Pinning a call by hand (from Activity) holds it until it is dismissed.
 *   4. Any other Stage activity retracts it at once: the call's moment passed.
 *   5. A new run (`agent_start`) or a switch to replay clears it.
 *
 * The reducer is pure and lives here, apart from the store, so the offline
 * checks can drive it without a browser.
 */

/** How long a finished call stays docked before folding itself away. */
export const HOLD_MS = 6000;
/** How long the card takes to fold away once the timer fires. */
export const EXIT_MS = 220;

/** Inset state as the store holds it. */
export interface InsetState {
  /** The docked item, or undefined when nothing is docked. */
  item?: StageItem;
  /** 0 = raised, 1 = folded away. Drives the height/opacity animation. */
  phase: "open" | "closing";
  /** The user pinned this call: no timer, only an explicit dismiss folds it. */
  pinned: boolean;
}

export const CLOSED_INSET: InsetState = { item: undefined, phase: "open", pinned: false };

/** `call` / `result` for a docked MCP card, undefined for anything else. */
function dockedPhase(item: StageItem | undefined): "call" | "result" | undefined {
  return item?.payload.kind === "terminal" ? item.payload.mcp?.phase : undefined;
}

/** The newest MCP-ish event in the run, if there is one. */
export function latestMcpItem(events: AbsenceEvent[]): StageItem | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "agent_start") return undefined;
    if (!isMcpEvent(event)) continue;
    const item = eventToMcpInset(event);
    if (item) return item;
  }
  return undefined;
}

export interface IngestInsetOptions {
  /** True when the event came from a freshly hydrated snapshot. */
  hydrating?: boolean;
}

/**
 * Fold one event into the inset state. Returns the next state, or the same
 * object when nothing about the dock changes (so the store can keep it and
 * skip a re-render).
 */
export function reduceInset(state: InsetState, event: AbsenceEvent, options: IngestInsetOptions = {}): InsetState {
  // A new run starts with an empty dock; hydrating a snapshot does too, since
  // ingest is about to fold every event of that snapshot in order.
  if (event.type === "agent_start" || options.hydrating) {
    return state.item === undefined && state.phase === "open" && !state.pinned ? state : CLOSED_INSET;
  }

  if (event.type === "mcp") {
    const item = mcpInsetItem(event);
    if (!item) return state;
    // Same call as the one docked (typically the result of the start we showed):
    // update in place and start its retract timer — being pinned while it was in
    // flight was the dock holding a call that had not answered yet, not the user
    // asking to keep the result. A hand pin (a click in Activity) survives.
    const wasInFlight = dockedPhase(state.item) === "call";
    return { item, phase: "open", pinned: wasInFlight ? false : state.pinned };
  }

  if (event.type === "tool_start") {
    const item = eventToMcpInset(event);
    if (!item) {
      // Any other tool means the MCP call's moment has passed.
      return state.item ? { ...state, phase: "closing" } : state;
    }
    // In flight: docked and pinned — nothing retracts it until it ends.
    return { item, phase: "open", pinned: true };
  }

  if (event.type === "tool_end") {
    const item = eventToMcpInset(event);
    if (item) return { item, phase: "open", pinned: state.pinned };
    return state.item ? { ...state, phase: "closing" } : state;
  }

  // Any other activity retracts the call: it has been overtaken — unless the
  // user pinned it by hand (rule 3): a held card is a kept card, whatever else
  // the agent does, until it is dismissed or a new run starts. `message` here
  // is the agent speaking — a system message is an Absence notice, not an action.
  if (!state.pinned && state.item && (event.type === "agent_end" || clearsStage(event))) {
    return { ...state, phase: "closing" };
  }

  return state;
}

/**
 * Whether a finished call should retract itself now.
 *
 * Kept out of the reducer because it depends on wall-clock time: the store arms
 * one timer per docked card instead of re-reducing the stream on a tick.
 */
export function shouldAutoRetract(state: InsetState): boolean {
  if (!state.item || state.pinned) return false;
  return state.item.payload.kind === "terminal" && state.item.payload.mcp?.phase === "result";
}


/**
 * The call docked for a replay position.
 *
 * Replay folds a run's events up to its cursor, so the same DONE/CALL decision
 * applies: the newest MCP event at or before the cursor, unless a run started
 * after it (the run being shown is over) or the call was already cleared by the
 * agent speaking. A finished call in a rewound recording does not tick down —
 * the bar is paused, so folding it away would make the recording unreadable.
 */
export function insetItemAtCursor(events: AbsenceEvent[], cursor: number): StageItem | undefined {
  let newest = -1;
  let newerStart = false;
  let cleared = -1;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.timestamp <= cursor) {
      if (event.type === "agent_start") {
        newest = -1;
        cleared = -1;
      }
      continue;
    }
    if (event.type === "agent_start") newerStart = true;
  }
  if (newerStart) return undefined;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.timestamp > cursor) break;
    if (isMcpEvent(event) && eventToMcpInset(event)) newest = i;
    else if (clearsStage(event)) cleared = i;
  }
  if (newest < 0 || cleared > newest) return undefined;
  return eventToMcpInset(events[newest]!);
}
