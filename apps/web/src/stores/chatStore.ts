import { create } from "zustand";
import type { ChatMessage, AbsenceEvent, SessionSnapshot } from "@absence/core";
import type { ChatContext } from "../types/chat";

function lastStreamingIndex(chat: ChatMessage[]): number {
  for (let i = chat.length - 1; i >= 0; i--) {
    const message = chat[i]!;
    if (message.role === "assistant" && message.streaming) return i;
  }
  return -1;
}

function applyChatEvent(chat: ChatMessage[], event: AbsenceEvent): ChatMessage[] | null {
  if (event.type !== "message") return null;
  const payload = event.payload;

  if (payload.role === "user") {
    return [...chat, { id: event.id, role: "user", content: payload.content, timestamp: event.timestamp }];
  }

  // A system notice (a command result, "model switched to …") is appended as-is
  // and never touches the streaming assistant bubble.
  if (payload.role === "system") {
    return [...chat, { id: event.id, role: "system", content: payload.content, timestamp: event.timestamp }];
  }

  if (payload.role === "assistant") {
    const content = payload.content ?? "";
    const streamingIndex = lastStreamingIndex(chat);

    // A tool-only turn carries no text; never render an empty bubble for it.
    if (content.length === 0) {
      if (streamingIndex < 0) return null;
      const next = [...chat];
      next[streamingIndex] = { ...next[streamingIndex]!, streaming: false };
      return next;
    }

    if (payload.streaming) {
      if (streamingIndex >= 0) {
        const next = [...chat];
        next[streamingIndex] = { ...next[streamingIndex]!, content, streaming: true };
        return next;
      }
      return [...chat, { id: event.id, role: "assistant", content, timestamp: event.timestamp, streaming: true }];
    }

    if (streamingIndex >= 0) {
      const next = [...chat];
      next[streamingIndex] = { ...next[streamingIndex]!, content, streaming: false };
      return next;
    }
    return [...chat, { id: event.id, role: "assistant", content, timestamp: event.timestamp }];
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
  ingest: (event: AbsenceEvent) => void;
  ingestEvents: (events: AbsenceEvent[]) => void;
  hydrate: (snapshot: SessionSnapshot) => void;
  reset: () => void;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  pending: [],

  addContext: (context) => set({ pending: [...get().pending, context] }),
  removeContext: (index) => set({ pending: get().pending.filter((_, i) => i !== index) }),
  clearContext: () => set({ pending: [] }),

  ingestEvents: (events) => {
    let messages = get().messages;
    let changed = false;
    for (const event of events) {
      const next = applyChatEvent(messages, event);
      if (next) {
        messages = next;
        changed = true;
      }
    }
    if (changed) set({ messages });
  },

  ingest: (event) => get().ingestEvents([event]),

  hydrate: (snapshot) => set({ messages: snapshot.chat, pending: [] }),
  reset: () => set({ messages: [], pending: [] }),
}));
