import { create } from "zustand";
import type {
  AgentStatus,
  ContextState,
  AbsenceEvent,
  Session,
  SessionHistoryEntry,
  SessionRuntimeState,
  SessionSnapshot,
  SessionSource,
} from "@absence/core";
import type { StageItem } from "../types/stage";
import { MAX_SESSION_EVENTS } from "@absence/core";
import * as api from "../lib/api";
import { isStageEvent, clearsStage, lastStageAction } from "../lib/events";
import { applyProcessEvent, sortEggs, type Egg } from "../lib/eggs";
import { eventsBase, markEventsBase, resetEventCaches } from "../lib/history";
import { useRunsStore } from "./runsStore";

/**
 * Eggs folded incrementally from `process` events.
 *
 * Deliberately *not* derived from `events` at render time. `process` events are
 * state updates (a pid is overwritten as it changes), so the live set has to
 * outlive the event window: folding the truncated stream again would drop any
 * process whose first event had been cut, and the panel's count would shrink.
 * One `Map.set` per event instead of a full rebuild per render.
 */

/**
 * Mutable egg map plus a version counter.
 *
 * Copying the map per `process` event would make a busy session O(eggs) per
 * update again — the same shape of cost we just removed. So the store mutates
 * one map in place and bumps `eggVersion`; the panel selects the version to
 * re-render and reads the map through it. React never sees the map itself, so
 * its identity does not matter.
 */
export interface EggStateHandle {
  eggs: Map<number, Egg>;
  /** Incremented whenever `eggs` changes. */
  version: number;
  /**
   * How many finished eggs the watcher has retired so far (see
   * `ProcessWatcher.retireOverflow`). Shown in the panel so a number that stops
   * at the cap reads as "200 shown, more folded" rather than "data went
   * missing".
   */
  retired: number;
}

interface SessionStore {
  session?: Session;
  agent: { status: AgentStatus; model?: string };
  events: AbsenceEvent[];
  /**
   * Bumped every time `events` changes.
   *
   * `events` is appended to in place so the incremental caches (history, rows)
   * can key on its identity. A selector like `(s) => s.events` compares with
   * `Object.is` and would therefore never see the change — components must
   * subscribe to this counter as well (see `useEvents`).
   */
  eventsVersion: number;
  /** Live egg state, maintained incrementally (see `EggStateHandle`). */
  eggState: EggStateHandle;
  /** The most recent event that owns the Stage (read02 §14). */
  currentAction?: AbsenceEvent;
  /** The agent's own context-window report, for the FaceBar meter. */
  context?: ContextState;
  /**
   * Where the events come from: `acp`, `acp-proxy`, `transcript` — which
   * channel observes this conversation.
   */
  source?: SessionSource;
  connected: boolean;
  error?: string;

  /**
   * Reopen a persisted session from the history list (the archive's own
   * resume semantics live server-side; the client only names the archive).
   */
  resumeSession: (entry: SessionHistoryEntry) => Promise<void>;
  /**
   * Enter a session that already exists on the server — an observed session
   * the discovery found, or one a proxy spawned. Nothing is created here.
   */
  openSession: (sessionId: string) => Promise<void>;
  reset: () => void;
  hydrate: (snapshot: SessionSnapshot) => void;
  applyRuntimeState: (state: SessionRuntimeState) => void;
  ingestEvent: (event: AbsenceEvent) => void;
  /** Fold a whole socket batch in one store update (see useSessionSocket). */
  ingestEvents: (events: AbsenceEvent[]) => void;
  setConnected: (connected: boolean) => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  session: undefined,
  agent: { status: "listening" },
  events: [],
  eventsVersion: 0,
  eggState: { eggs: new Map(), version: 0, retired: 0 },
  currentAction: undefined,
  context: undefined,
  source: undefined,
  connected: false,
  error: undefined,

  resumeSession: async (entry) => {
    set({ error: undefined });
    // The archive id is enough: the server reads the agent's ACP resume handle
    // from its own archive, so the client never names an agent-private file.
    const resume = entry.absenceSessionId
      ? { absenceSessionId: entry.absenceSessionId }
      : undefined;
    const snapshot = await api.createSession(entry.projectPath, entry.runtime, resume);
    get().hydrate(snapshot);
  },

  openSession: async (sessionId) => {
    set({ error: undefined });
    const snapshot = await api.fetchSession(sessionId);
    get().hydrate(snapshot);
  },

  reset: () => {
    resetEventCaches();
    useRunsStore.getState().clear();
    set({
      session: undefined,
      agent: { status: "listening" },
      events: [],
      eventsVersion: 0,
      eggState: { eggs: new Map(), version: 0, retired: 0 },
      currentAction: undefined,
      context: undefined,
      source: undefined,
      connected: false,
      error: undefined,
    });
  },

  hydrate: (snapshot) => {
    const eggs = new Map<number, Egg>();
    const processEvents = new Map<string, AbsenceEvent>();
    for (const event of snapshot.processEvents ?? []) processEvents.set(event.id, event);
    for (const event of snapshot.events) {
      if (event.type === "process") processEvents.set(event.id, event);
    }
    for (const event of processEvents.values()) applyProcessEvent(eggs, event);
    // A hydrated snapshot is a fresh window. Reset the module-level history /
    // row caches first: a different session can have the same length and base,
    // and the incremental cache would otherwise reuse the previous session's
    // runs. Absolute indices start at 0 for the loaded tail.
    resetEventCaches();
    markEventsBase(snapshot.events, 0);
    useRunsStore.getState().hydrate(snapshot.runs ?? []);
    set({
      session: snapshot.session,
      agent: snapshot.agent,
      context: snapshot.context,
      source: snapshot.source,
      events: snapshot.events,
      eventsVersion: get().eventsVersion + 1,
      eggState: { eggs, version: get().eggState.version + 1, retired: 0 },
      currentAction: lastStageAction(snapshot.events),
    });
  },

  applyRuntimeState: (state) => {
    set({
      session: state.session,
      agent: state.agent,
      context: state.context,
      source: state.source,
    });
  },

  ingestEvents: (raw) => {
    // The store is a module singleton; the events must be narrowed to the
    // session it is currently showing. A frame from a stale socket (or any
    // producer bug) must not append another session's work.
    const current = get().session?.id;
    if (!current) return;
    const incoming = raw.filter((event) => event.sessionId === current);
    if (incoming.length === 0) return;
    const previous = get().events;
    // The socket batches events, so copy the window once per batch instead of
    // once per event. `keepFrom` is how many of the oldest events no longer
    // fit; it may include some of this batch when a batch alone overflows.
    const total = previous.length + incoming.length;
    const keepFrom = Math.max(0, total - MAX_SESSION_EVENTS);
    const droppedPrevious = Math.min(previous.length, keepFrom);
    const droppedIncoming = keepFrom - droppedPrevious;
    const events = [...previous.slice(droppedPrevious), ...incoming.slice(droppedIncoming)];
    markEventsBase(events, eventsBase(previous) + keepFrom);

    let currentAction = get().currentAction;
    let stageChanged = false;
    let eggsChanged = false;
    let retired = get().eggState.retired;
    const eggs = get().eggState.eggs;

    for (const event of incoming) {
      // Eggs update in place, O(1), and do not depend on the event window.
      if (event.type === "process") {
        applyProcessEvent(eggs, event);
        eggsChanged = true;
        if (event.payload.retired) retired += 1;
      }
      if (clearsStage(event)) {
        // A run ended, or a new one just started: back to the default Stage page.
        currentAction = undefined;
        stageChanged = true;
      } else if (isStageEvent(event)) {
        currentAction = event;
        stageChanged = true;
      }
    }

    const patch: Partial<SessionStore> = {
      events,
      eventsVersion: get().eventsVersion + 1,
    };
    if (eggsChanged) {
      patch.eggState = { eggs, version: get().eggState.version + 1, retired };
    }
    if (stageChanged) patch.currentAction = currentAction;
    set(patch);
  },

  ingestEvent: (event) => get().ingestEvents([event]),

  setConnected: (connected) => set({ connected }),
}));

/**
 * The session's event window, re-read whenever it changes.
 *
 * Components must not use `useSessionStore((s) => s.events)` directly: the
 * store appends in place, so that selector's value keeps the same identity and
 * zustand's `Object.is` check skips the re-render. Reading the version first
 * gives this hook a dependency that does change, and the returned array is then
 * the current one.
 */
export function useEvents(): AbsenceEvent[] {
  return useSessionStore((s) => {
    // Depend on the counter so a fresh snapshot is delivered on every append.
    void s.eventsVersion;
    return s.events;
  });
}
