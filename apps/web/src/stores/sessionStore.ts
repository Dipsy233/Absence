import { create } from "zustand";
import type {
  AgentStatus,
  ContextState,
  DazeEvent,
  Session,
  SessionHistoryEntry,
  SessionRuntimeState,
  SessionSnapshot,
} from "@daze/core";
import * as api from "../lib/api";
import { STAGE_EVENT_TYPES, clearsStage, lastStageAction } from "../lib/events";

const MAX_EVENTS = 2000;

interface SessionStore {
  session?: Session;
  agent: { status: AgentStatus; model?: string };
  events: DazeEvent[];
  /** The most recent event that owns the Stage (read02 §14). */
  currentAction?: DazeEvent;
  context?: ContextState;
  connected: boolean;
  error?: string;

  startSession: (projectPath: string, agent?: "pi" | "mock") => Promise<void>;
  /** Reopen a persisted session from the history list. */
  resumeSession: (entry: SessionHistoryEntry) => Promise<void>;
  sendPrompt: (text: string) => Promise<void>;
  /** Run a terminal-box command (its output streams back as a system message). */
  runCommand: (name: string, args: string) => Promise<void>;
  abort: () => Promise<void>;
  reset: () => void;
  hydrate: (snapshot: SessionSnapshot) => void;
  applyRuntimeState: (state: SessionRuntimeState) => void;
  ingestEvent: (event: DazeEvent) => void;
  setConnected: (connected: boolean) => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  session: undefined,
  agent: { status: "listening" },
  events: [],
  currentAction: undefined,
  context: undefined,
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
      entry.dazeSessionId || entry.piSessionFile
        ? {
            dazeSessionId: entry.dazeSessionId,
            piSessionFile: entry.piSessionFile,
            piSessionId: entry.piSessionId,
          }
        : undefined;
    const snapshot = await api.createSession(
      entry.projectPath,
      entry.runtime === "mock" ? "mock" : undefined,
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
      currentAction: undefined,
      context: undefined,
      connected: false,
      error: undefined,
    }),

  hydrate: (snapshot) =>
    set({
      session: snapshot.session,
      agent: snapshot.agent,
      context: snapshot.context,
      events: snapshot.events,
      currentAction: lastStageAction(snapshot.events),
    }),

  applyRuntimeState: (state) =>
    set({
      session: state.session,
      agent: state.agent,
      context: state.context,
    }),

  ingestEvent: (event) => {
    const events = [...get().events, event];
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    const patch: Partial<SessionStore> = { events };
    if (clearsStage(event)) {
      // A run ended, or a new one just started: back to the default Stage page.
      patch.currentAction = undefined;
    } else if (STAGE_EVENT_TYPES.has(event.type)) {
      patch.currentAction = event;
    }
    set(patch);
  },

  setConnected: (connected) => set({ connected }),
}));
