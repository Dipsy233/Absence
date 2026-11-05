import { create } from "zustand";
import type {
  AgentCommandInfo,
  AgentStatus,
  AuthMethodInfo,
  ContextState,
  AbsenceEvent,
  Session,
  SessionHistoryEntry,
  SessionRuntimeState,
  SessionSnapshot,
  SessionSource,
  RuntimeKind,
} from "@absence/core";
import type { StageItem } from "../types/stage";
import { MAX_SESSION_EVENTS } from "@absence/core";
import * as api from "../lib/api";
import { isStageEvent, clearsStage, lastStageAction } from "../lib/events";
import { applyProcessEvent, sortEggs, type Egg } from "../lib/eggs";
import { eventsBase, markEventsBase, resetEventCaches } from "../lib/history";
import { useRunsStore } from "./runsStore";
import { useChatStore } from "./chatStore";

/**
 * How long the UI waits for the server to confirm a stop.
 *
 * The server's own watchdog settles a hung turn after ~10s and emits
 * `agent_end aborted`. This is the client-side backstop for a build/agent where
 * that never arrives: after it, the UI is unlocked and a system notice says the
 * stop was not confirmed.
 */
const STOP_CONFIRM_MS = 12_000;
let stopToken = 0;
let stopTimer: ReturnType<typeof setTimeout> | undefined;

/** Invalidate the pending stop confirmation and cancel its timer. */
function clearStopWatch(): void {
  stopToken += 1;
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = undefined;
}

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
  context?: ContextState;
  /** `/` commands the agent advertised; merged into the palette. */
  agentCommands?: AgentCommandInfo[];
  /** ACP authentication methods, when the agent advertised any. */
  authMethods?: AuthMethodInfo[];
  /** True when the agent is blocked until `/auth <methodId>` succeeds. */
  authRequired?: boolean;
  /**
   * Where the events come from: the runtime profile Absence drives. Undefined
   * from an older server.
   */
  source?: SessionSource;
  connected: boolean;
  /** A stop was requested and the server has not confirmed it yet. */
  stopping: boolean;
  error?: string;

  startSession: (projectPath: string, agent?: RuntimeKind) => Promise<void>;
  /** Reopen a persisted session from the history list. */
  resumeSession: (entry: SessionHistoryEntry) => Promise<void>;
  sendPrompt: (text: string) => Promise<void>;
  /** Run a terminal-box command (its output streams back as a system message). */
  runCommand: (name: string, args: string) => Promise<void>;
  /** Answer an approval prompt the agent raised (the `approval` event). */
  respondApproval: (id: string, value: string) => Promise<void>;
  abort: () => Promise<void>;
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
  eventWindowSize: MAX_SESSION_EVENTS,
  currentAction: undefined,
  context: undefined,
  agentCommands: undefined,
  authMethods: undefined,
  authRequired: undefined,
  source: undefined,
  connected: false,
  stopping: false,
  error: undefined,

  startSession: async (projectPath, agent) => {
    set({ error: undefined });
    const snapshot = await api.createSession(projectPath, agent);
    get().hydrate(snapshot);
  },

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

  sendPrompt: async (text) => {
    const id = get().session?.id;
    if (!id || !text.trim()) return;
    // A new prompt supersedes any pending stop confirmation.
    clearStopWatch();
    if (get().stopping) set({ stopping: false });
    await api.sendPrompt(id, text);
  },

  runCommand: async (name, args) => {
    const id = get().session?.id;
    if (!id) return;
    await api.runCommand(id, name, args);
  },

  respondApproval: async (approvalId, value) => {
    const id = get().session?.id;
    if (!id) return;
    await api.respondApproval(id, approvalId, value);
  },

  abort: async () => {
    const id = get().session?.id;
    if (!id) return;
    clearStopWatch();
    const token = stopToken;
    set({ stopping: true });
    stopTimer = setTimeout(() => {
      stopTimer = undefined;
      if (token !== stopToken || !get().stopping) return;
      // The server never confirmed the stop. Unlock the UI locally and say so;
      // the server-side watchdog is the normal path (see AcpSession).
      set({ stopping: false, agent: { ...get().agent, status: "listening" } });
      useChatStore
        .getState()
        .appendSystem(
          "Stop was not acknowledged by the agent within 12s; the run was unlocked locally.",
        );
    }, STOP_CONFIRM_MS);
    try {
      await api.abortSession(id);
    } catch (error) {
      clearStopWatch();
      set({ stopping: false });
      throw error;
    }
  },

  reset: () => {
    resetEventCaches();
    clearStopWatch();
    useRunsStore.getState().clear();
    set({
      session: undefined,
      agent: { status: "listening" },
      events: [],
      eventsVersion: 0,
      eggState: { eggs: new Map(), version: 0, retired: 0 },
      currentAction: undefined,
      context: undefined,
      agentCommands: undefined,
      authMethods: undefined,
      authRequired: undefined,
      source: undefined,
      connected: false,
      stopping: false,
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
      agentCommands: snapshot.agentCommands,
      authMethods: snapshot.authMethods,
      authRequired: snapshot.authRequired,
      source: snapshot.source,
      events: snapshot.events,
      eventsVersion: get().eventsVersion + 1,
      eggState: { eggs, version: get().eggState.version + 1, retired: 0 },
      currentAction: lastStageAction(snapshot.events),
    });
  },

  applyRuntimeState: (state) => {
    // The server saying "listening" is the confirmation a stop was waiting for.
    if (state.agent.status === "listening" && get().stopping) clearStopWatch();
    set({
      session: state.session,
      agent: state.agent,
      context: state.context,
      agentCommands: state.agentCommands,
      authMethods: state.authMethods,
      authRequired: state.authRequired,
      source: state.source,
      ...(state.agent.status === "listening" && get().stopping ? { stopping: false } : {}),
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

    if (incoming.some((event) => event.type === "agent_end") && get().stopping) {
      // The run closed: the stop request has been answered.
      clearStopWatch();
    }
    const patch: Partial<SessionStore> = {
      events,
      eventsVersion: get().eventsVersion + 1,
      ...(incoming.some((event) => event.type === "agent_end") && get().stopping
        ? { stopping: false }
        : {}),
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
