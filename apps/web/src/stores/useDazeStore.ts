import { create } from "zustand";
import type {
  AgentStatus,
  ChatMessage,
  ContextState,
  DazeEvent,
  FileState,
  FileTreeNode,
  Plan,
  Session,
  SessionRuntimeState,
  SessionSnapshot,
} from "@daze/core";
import * as api from "../lib/api";

const MAX_ACTIVITY = 600;

/** Events that own the Stage and are paced for human eyes. */
const STAGE_TYPES = new Set<DazeEvent["type"]>([
  "file_read",
  "file_write",
  "file_edit",
  "command",
  "agent_start",
  "agent_end",
]);

/** Events worth showing in the Activity timeline. */
const ACTIVITY_TYPES = new Set<DazeEvent["type"]>([
  "agent_start",
  "agent_end",
  "file_read",
  "file_write",
  "file_edit",
  "file_change",
  "command",
  "error",
]);

/** Visual dwell time per event type — slow the agent down for humans. */
const DWELL: Partial<Record<DazeEvent["type"], number>> = {
  agent_start: 400,
  agent_end: 650,
  file_read: 850,
  file_write: 750,
  file_edit: 1000,
  command: 950,
};
const DWELL_MIN = 300;
const DWELL_MAX = 1000;

function dwellFor(event: DazeEvent): number {
  const base = DWELL[event.type] ?? 600;
  return Math.min(DWELL_MAX, Math.max(DWELL_MIN, base));
}

interface DazeStore {
  session: Session | null;
  agent: { status: AgentStatus; model?: string };
  currentAction?: DazeEvent;
  files: FileState[];
  activity: DazeEvent[];
  plan?: Plan;
  chat: ChatMessage[];
  context?: ContextState;
  tree?: FileTreeNode;
  connected: boolean;
  error?: string;

  startSession: (projectPath: string, agent?: "pi" | "mock") => Promise<void>;
  sendPrompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  reset: () => void;
  ingestSnapshot: (snapshot: SessionSnapshot) => void;
  ingestEvent: (event: DazeEvent) => void;
  ingestRuntimeState: (state: SessionRuntimeState) => void;
  setConnected: (connected: boolean) => void;
}

// Pacing queue lives outside the store so it survives re-renders.
let stageQueue: DazeEvent[] = [];
let stageTimer: ReturnType<typeof setTimeout> | null = null;

export const useDazeStore = create<DazeStore>((set, get) => {
  function pump(): void {
    if (stageTimer !== null) return;
    const step = () => {
      const event = stageQueue.shift();
      if (!event) {
        stageTimer = null;
        return;
      }
      if (event.type === "agent_end") {
        set({ currentAction: event });
        stageTimer = setTimeout(() => {
          set({ currentAction: undefined });
          step();
        }, dwellFor(event));
        return;
      }
      set({ currentAction: event });
      stageTimer = setTimeout(step, dwellFor(event));
    };
    step();
  }

  return {
    session: null,
    agent: { status: "idle" },
    currentAction: undefined,
    files: [],
    activity: [],
    plan: undefined,
    chat: [],
    context: undefined,
    tree: undefined,
    connected: false,
    error: undefined,

    startSession: async (projectPath, agent) => {
      set({ error: undefined });
      const snapshot = await api.createSession(projectPath, agent);
      get().ingestSnapshot(snapshot);
    },

    sendPrompt: async (text) => {
      const id = get().session?.id;
      if (!id || !text.trim()) return;
      await api.sendPrompt(id, text);
    },

    abort: async () => {
      const id = get().session?.id;
      if (!id) return;
      await api.abortSession(id);
    },

    reset: () => {
      stageQueue = [];
      if (stageTimer !== null) {
        clearTimeout(stageTimer);
        stageTimer = null;
      }
      set({
        session: null,
        agent: { status: "idle" },
        currentAction: undefined,
        files: [],
        activity: [],
        plan: undefined,
        chat: [],
        context: undefined,
        tree: undefined,
        connected: false,
        error: undefined,
      });
    },

    ingestSnapshot: (snapshot) => {
      stageQueue = [];
      set({
        session: snapshot.session,
        agent: snapshot.agent,
        context: snapshot.context,
        plan: snapshot.plan,
        tree: snapshot.tree,
        files: snapshot.files,
        chat: snapshot.chat,
        activity: snapshot.events.filter((e) => ACTIVITY_TYPES.has(e.type)),
        currentAction: snapshot.currentAction,
      });
    },

    ingestRuntimeState: (state) => {
      set({
        session: state.session,
        agent: state.agent,
        context: state.context,
        plan: state.plan,
        tree: state.tree,
      });
    },

    ingestEvent: (event) => {
      const state = get();

      const patch: Partial<DazeStore> = {};

      if (ACTIVITY_TYPES.has(event.type)) {
        const activity = [...state.activity, event];
        if (activity.length > MAX_ACTIVITY) activity.splice(0, activity.length - MAX_ACTIVITY);
        patch.activity = activity;
      }

      const files = applyFileEvent(state.files, event);
      if (files) patch.files = files;

      const chat = applyChatEvent(state.chat, event);
      if (chat) patch.chat = chat;

      if (Object.keys(patch).length > 0) set(patch);

      if (STAGE_TYPES.has(event.type)) {
        stageQueue.push(event);
        pump();
      }
    },

    setConnected: (connected) => set({ connected }),
  };
});

function applyFileEvent(files: FileState[], event: DazeEvent): FileState[] | null {
  switch (event.type) {
    case "file_read": {
      const index = files.findIndex((f) => f.path === event.payload.path);
      const next: FileState = {
        path: event.payload.path,
        content: event.payload.content,
        version: index >= 0 ? files[index]!.version : 1,
        lastRead: { startLine: event.payload.startLine, endLine: event.payload.endLine },
        lastModified: Date.now(),
      };
      return replaceAt(files, index, next);
    }
    case "file_write":
    case "file_edit": {
      const index = files.findIndex((f) => f.path === event.payload.path);
      const content = event.type === "file_edit" ? event.payload.after : event.payload.content;
      const next: FileState = {
        path: event.payload.path,
        content,
        version: (index >= 0 ? files[index]!.version : 0) + 1,
        lastRead: index >= 0 ? files[index]!.lastRead : undefined,
        lastModified: Date.now(),
      };
      return replaceAt(files, index, next);
    }
    default:
      return null;
  }
}

function replaceAt(files: FileState[], index: number, next: FileState): FileState[] {
  const arr = [...files];
  if (index >= 0) arr[index] = next;
  else arr.push(next);
  return arr;
}

function applyChatEvent(chat: ChatMessage[], event: DazeEvent): ChatMessage[] | null {
  if (event.type !== "message") return null;
  const payload = event.payload;

  if (payload.role === "user") {
    return [...chat, { id: event.id, role: "user", content: payload.content, timestamp: event.timestamp }];
  }

  if (payload.role === "assistant") {
    const streamingIndex = lastStreamingIndex(chat);
    if (payload.streaming) {
      if (streamingIndex >= 0) {
        const arr = [...chat];
        arr[streamingIndex] = { ...arr[streamingIndex]!, content: payload.content, streaming: true };
        return arr;
      }
      return [
        ...chat,
        { id: event.id, role: "assistant", content: payload.content, timestamp: event.timestamp, streaming: true },
      ];
    }
    if (streamingIndex >= 0) {
      const arr = [...chat];
      arr[streamingIndex] = { ...arr[streamingIndex]!, content: payload.content, streaming: false };
      return arr;
    }
    return [...chat, { id: event.id, role: "assistant", content: payload.content, timestamp: event.timestamp }];
  }

  return null;
}

function lastStreamingIndex(chat: ChatMessage[]): number {
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i]!.role === "assistant" && chat[i]!.streaming) return i;
  }
  return -1;
}
