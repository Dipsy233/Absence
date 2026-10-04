import { create } from "zustand";
import type { DazeEvent, FileTreeNode, SessionSnapshot } from "@daze/core";
import type { FileView } from "../types/file";
import { languageFromPath } from "../lib/language";

function makeView(path: string, content = "", version = 0): FileView {
  return {
    path,
    content,
    language: languageFromPath(path),
    version,
    status: "idle",
    history: [],
  };
}

/** Mutates `views` in place, always assigning fresh FileView objects. */
function applyEvent(views: Record<string, FileView>, event: DazeEvent): void {
  switch (event.type) {
    case "file_read": {
      const { path, content, startLine, endLine } = event.payload;
      const existing = views[path];
      views[path] = {
        ...(existing ?? makeView(path)),
        path,
        // A read returns a slice; keep a full write/edit body if we already have one.
        content: existing && existing.version > 0 ? existing.content : content,
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
    // Rebuild from the event timeline so history survives a reconnect.
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
