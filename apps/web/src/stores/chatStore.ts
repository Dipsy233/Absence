import { create } from "zustand";
import type { ChatMessage, DazeEvent, SessionSnapshot } from "@daze/core";
import type { ChatContext } from "../types/chat";

function lastStreamingIndex(chat: ChatMessage[]): number {
  for (let i = chat.length - 1; i >= 0; i--) {
    const message = chat[i]!;
    if (message.role === "assistant" && message.streaming) return i;
  }
  return -1;
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
        const next = [...chat];
        next[streamingIndex] = { ...next[streamingIndex]!, content: payload.content, streaming: true };
        return next;
      }
      return [
        ...chat,
        { id: event.id, role: "assistant", content: payload.content, timestamp: event.timestamp, streaming: true },
      ];
    }
    if (streamingIndex >= 0) {
      const next = [...chat];
      next[streamingIndex] = { ...next[streamingIndex]!, content: payload.content, streaming: false };
      return next;
    }
    return [...chat, { id: event.id, role: "assistant", content: payload.content, timestamp: event.timestamp }];
  }

  return null;
}

interface ChatStore {
  messages: ChatMessage[];
  /** Explicit context the user attached (read02 §30). */
  pending: ChatContext[];

  addContext: (context: ChatContext) => void;
  removeContext: (index: number) => void;
  clearContext: () => void;
  ingest: (event: DazeEvent) => void;
  hydrate: (snapshot: SessionSnapshot) => void;
  reset: () => void;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  pending: [],

  addContext: (context) => set({ pending: [...get().pending, context] }),
  removeContext: (index) => set({ pending: get().pending.filter((_, i) => i !== index) }),
  clearContext: () => set({ pending: [] }),

  ingest: (event) => {
    const next = applyChatEvent(get().messages, event);
    if (next) set({ messages: next });
  },

  hydrate: (snapshot) => set({ messages: snapshot.chat, pending: [] }),
  reset: () => set({ messages: [], pending: [] }),
}));
