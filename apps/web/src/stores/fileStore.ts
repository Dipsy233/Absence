import { create } from "zustand";
import type { DazeEvent, FileTreeNode, SessionSnapshot } from "@daze/core";
import type { FileView } from "../types/file";
import { languageFromPath } from "../lib/language";
import { renderKnownLines } from "../lib/knownLines";

function makeView(path: string, content = "", version = 0): FileView {
  return {
    path,
    content,
    language: languageFromPath(path),
    version,
    status: "idle",
    history: [],
    complete: version > 0,
    knownLines: {},
  };
}

/** Mutates `views` in place, always assigning fresh FileView objects. */
function applyEvent(views: Record<string, FileView>, event: DazeEvent): void {
  switch (event.type) {
    case "file_read": {
      const { path, content, startLine, endLine } = event.payload;
      const existing = views[path] ?? makeView(path);

      if (existing.complete) {
        // A write/edit already gave us the whole file; the read adds nothing.
        views[path] = { ...existing, path, lastRead: { startLine, endLine }, status: "reading" };
        break;
      }

      // Reads accumulate: the agent's context is the union of every range it
      // has read, not just the most recent one.
      const knownLines = { ...existing.knownLines };
      content.split("\n").forEach((line, index) => {
        knownLines[startLine + index] = line;
      });

      views[path] = {
        ...existing,
        path,
        knownLines,
        content: renderKnownLines(knownLines).text,
        lastRead: { startLine, endLine },
        status: "reading",
      };
      break;
    }
    case "file_write":
    case "file_edit": {
      const { path } = event.payload;
      const content = event.type === "file_edit" ? event.payload.after : event.payload.content;
      const existing = views[path];
      const version = (existing?.version ?? 0) + 1;
      views[path] = {
        ...(existing ?? makeView(path)),
        path,
        content,
        version,
        status: "modified",
        lastModifiedAt: event.timestamp,
        complete: true,
        knownLines: {},
        history: [
          ...(existing?.history ?? []),
          { version, timestamp: event.timestamp, content, source: event.type === "file_edit" ? "edit" : "write" },
        ],
      };
      break;
    }
    case "file_change":
      if (event.payload.kind === "deleted") delete views[event.payload.path];
      break;
    default:
      break;
  }
}

interface FileStore {
  tree?: FileTreeNode;
  files: Record<string, FileView>;

  setTree: (tree?: FileTreeNode) => void;
  ingest: (event: DazeEvent) => void;
  hydrate: (snapshot: SessionSnapshot) => void;
  reset: () => void;
}

export const useFileStore = create<FileStore>((set, get) => ({
  tree: undefined,
  files: {},

  setTree: (tree) => set({ tree }),

  ingest: (event) => {
    const files = { ...get().files };
    applyEvent(files, event);
    set({ files });
  },

  hydrate: (snapshot) => {
    // Rebuild from the event timeline so knowledge survives a reconnect.
    const files: Record<string, FileView> = {};
    for (const event of snapshot.events) applyEvent(files, event);
    for (const f of snapshot.files) {
      if (!files[f.path]) {
        files[f.path] = {
          ...makeView(f.path, f.content, f.version),
          lastRead: f.lastRead,
          lastModifiedAt: f.lastModified,
        };
      }
    }
    set({ tree: snapshot.tree, files });
  },

  reset: () => set({ tree: undefined, files: {} }),
}));
