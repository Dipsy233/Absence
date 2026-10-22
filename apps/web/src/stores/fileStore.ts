import { create } from "zustand";
import type { AbsenceEvent, FileTreeNode, SessionSnapshot } from "@absence/core";
import type { FileVersion, FileView } from "../types/file";
import { languageFromPath } from "../lib/language";
import { renderKnownState } from "../lib/knownLines";

function emptyView(path: string): FileView {
  return {
    path,
    language: languageFromPath(path),
    status: "idle",
    history: [],
    knownLines: {},
    content: "",
    version: -1,
    complete: false,
  };
}

/** Add or replace a version and mirror it as the current state. */
function putVersion(view: FileView, entry: FileVersion): FileView {
  const history = [...view.history.filter((v) => v.version !== entry.version), entry].sort(
    (a, b) => a.version - b.version,
  );
  return { ...view, history, content: entry.content, version: entry.version, complete: entry.complete };
}

function latest(view: FileView): FileVersion | undefined {
  return view.history[view.history.length - 1];
}

/** Mutates `views` in place, always assigning fresh FileView objects. */
function applyEvent(views: Record<string, FileView>, event: AbsenceEvent): void {
  switch (event.type) {
    case "file_read": {
      const { path, content, startLine, endLine } = event.payload;
      const view = views[path] ?? emptyView(path);

      if (view.complete) {
        // We already hold the whole file; the read adds nothing.
        views[path] = { ...view, path, lastRead: { startLine, endLine }, status: "reading" };
        break;
      }

      // Reads accumulate into v0: the agent's context is the union of every
      // range it has read, not just the most recent one.
      const knownLines = { ...view.knownLines };
      content.split("\n").forEach((line, index) => {
        knownLines[startLine + index] = line;
      });
      const state = renderKnownState(knownLines);

      views[path] = {
        ...putVersion(view, {
          version: 0,
          timestamp: event.timestamp,
          source: "read",
          content: state.content,
          complete: false,
          lineOffset: state.lineOffset,
          startLine: state.startLine,
          endLine: state.endLine,
          caption: state.caption,
        }),
        path,
        knownLines,
        lastRead: { startLine, endLine },
        status: "reading",
      };
      break;
    }
    case "file_write":
    case "file_edit": {
      const { path } = event.payload;
      const content = event.type === "file_edit" ? event.payload.after : event.payload.content;
      const view = views[path] ?? emptyView(path);
      const nextNumber = (latest(view)?.version ?? -1) + 1;

      views[path] = {
        ...putVersion(view, {
          version: nextNumber,
          timestamp: event.timestamp,
          source: event.type === "file_edit" ? "edit" : "write",
          content,
          complete: true,
          lineOffset: 0,
        }),
        path,
        status: "modified",
        lastModifiedAt: event.timestamp,
        knownLines: {},
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
  ingest: (event: AbsenceEvent) => void;
  ingestEvents: (events: AbsenceEvent[]) => void;
  hydrate: (snapshot: SessionSnapshot) => void;
  reset: () => void;
}

export const useFileStore = create<FileStore>((set, get) => ({
  tree: undefined,
  files: {},

  setTree: (tree) => set({ tree }),

  ingestEvents: (events) => {
    // Only file events change this store; a batch of process/thinking events
    // must not copy the file map or re-render the Files panel.
    const relevant = events.filter(
      (event) =>
        event.type === "file_read" ||
        event.type === "file_write" ||
        event.type === "file_edit" ||
        event.type === "file_change",
    );
    if (relevant.length === 0) return;
    const files = { ...get().files };
    for (const event of relevant) applyEvent(files, event);
    set({ files });
  },

  ingest: (event) => get().ingestEvents([event]),

  hydrate: (snapshot) => {
    // Rebuild from the event timeline so recorded versions survive a reconnect.
    const files: Record<string, FileView> = {};
    for (const event of snapshot.events) applyEvent(files, event);

    for (const f of snapshot.files) {
      if (files[f.path]) continue;
      const view = emptyView(f.path);
      files[f.path] = {
        ...putVersion(view, {
          version: Math.max(0, f.version),
          timestamp: f.lastModified ?? 0,
          source: "write",
          content: f.content,
          complete: f.version > 0,
          lineOffset: 0,
        }),
        lastRead: f.lastRead,
        lastModifiedAt: f.lastModified,
      };
    }
    set({ tree: snapshot.tree, files });
  },

  reset: () => set({ tree: undefined, files: {} }),
}));
