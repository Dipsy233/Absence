import { create } from "zustand";
import type {
  AgentStatus,
  CapabilityState,
  ContextState,
  AbsenceEvent,
  Session,
  SessionHistoryEntry,
  SessionRuntimeState,
  SessionSnapshot,
} from "@absence/core";
import { MAX_SESSION_EVENTS } from "@absence/core";
import * as api from "../lib/api";
import { STAGE_EVENT_TYPES, clearsStage, isInstantSearch, lastStageAction } from "../lib/events";
import { applyProcessEvent, sortEggs, type Egg } from "../lib/eggs";
import { eventsBase, markEventsBase } from "../lib/history";

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
  /**
   * What the runtime can do beyond its built-in tools — MCP servers and skills.
   * Pushed with every `session_state` (see SessionRuntimeState), so it grows
   * during a run as servers connect; undefined for a runtime that reports none.
   */
  capabilities?: CapabilityState;
  connected: boolean;
  error?: string;

  startSession: (projectPath: string, agent?: "pi" | "codex" | "dsh" | "mock") => Promise<void>;
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
  capabilities: undefined,
  connected: false,
  error: undefined,

  startSession: async (projectPath, agent) => {
    set({ error: undefined });
    const snapshot = await api.createSession(projectPath, agent);
    get().hydrate(snapshot);
  },

  resumeSession: async (entry) => {
    set({ error: undefined });
    const resume =
      entry.absenceSessionId || entry.piSessionFile
        ? {
            absenceSessionId: entry.absenceSessionId,
            piSessionFile: entry.piSessionFile,
            piSessionId: entry.piSessionId,
          }
        : undefined;
    const snapshot = await api.createSession(
      entry.projectPath,
      entry.runtime === "mock" || entry.runtime === "codex" || entry.runtime === "dsh" ? entry.runtime : "pi",
      resume,
    );
    get().hydrate(snapshot);
  },

  sendPrompt: async (text) => {
    const id = get().session?.id;
    if (!id || !text.trim()) return;
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
    await api.abortSession(id);
  },

  reset: () =>
    set({
      session: undefined,
      agent: { status: "listening" },
      events: [],
      eventsVersion: 0,
      eggState: { eggs: new Map(), version: 0, retired: 0 },
      currentAction: undefined,
      context: undefined,
      capabilities: undefined,
      connected: false,
      error: undefined,
    }),

  hydrate: (snapshot) => {
    const eggs = new Map<number, Egg>();
    for (const event of snapshot.events) applyProcessEvent(eggs, event);
    // A hydrated snapshot is a fresh window: no events have been trimmed from
    // it, so absolute indices start at 0 and the history cache rebuilds.
    markEventsBase(snapshot.events, 0);
    set({
      session: snapshot.session,
      agent: snapshot.agent,
      context: snapshot.context,
      capabilities: snapshot.capabilities,
      events: snapshot.events,
      eventsVersion: get().eventsVersion + 1,
      eggState: { eggs, version: get().eggState.version + 1, retired: 0 },
      currentAction: lastStageAction(snapshot.events),
    });
  },

  applyRuntimeState: (state) =>
    set({
      session: state.session,
      agent: state.agent,
      context: state.context,
      capabilities: state.capabilities,
    }),

  ingestEvent: (event) => {
    const previous = get().events;
    // A fresh array per change is what makes React's selector see the update
    // (`Object.is` on the same reference would skip the render). A shallow copy
    // of the window is a few microseconds; the incremental history / row caches
    // no longer key on identity, so they still fold only the new tail.
    const full = previous.length >= MAX_SESSION_EVENTS;
    const events = full ? [...previous.slice(1), event] : [...previous, event];
    // One event leaves the window when it was already full.
    markEventsBase(events, eventsBase(previous) + (full ? 1 : 0));

    const patch: Partial<SessionStore> = { events, eventsVersion: get().eventsVersion + 1 };
    // Eggs update in place, O(1), and do not depend on the event window above.
    if (event.type === "process") {
      const current = get().eggState;
      applyProcessEvent(current.eggs, event);
      patch.eggState = {
        eggs: current.eggs,
        version: current.version + 1,
        retired: current.retired + (event.payload.retired ? 1 : 0),
      };
    }
    if (clearsStage(event)) {
      // A run ended, or a new one just started: back to the default Stage page.
      patch.currentAction = undefined;
    } else if (STAGE_EVENT_TYPES.has(event.type) && !isInstantSearch(event)) {
      patch.currentAction = event;
    }
    set(patch);
  },

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
