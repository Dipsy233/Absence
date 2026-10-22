import { create } from "zustand";
import type { AbsenceEvent, FileState, FileTreeNode, SessionSnapshot } from "@absence/core";
import type { FileVersion, FileView } from "../types/file";
import { languageFromPath } from "../lib/language";
import { renderKnownState, type FileVersionInfo } from "@absence/core";
import * as api from "../lib/api";

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

/** Rebuild file views from a timeline, then fill files no event mentioned. */
function buildFileViews(
  events: AbsenceEvent[],
  seedFiles: FileState[],
): Record<string, FileView> {
  const files: Record<string, FileView> = {};
  for (const event of events) applyEvent(files, event);

  for (const f of seedFiles) {
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
  return files;
}

/** Convert a stored version into the view model the file panels use. */
function versionFromInfo(info: FileVersionInfo): FileVersion {
  return {
    version: info.version,
    timestamp: info.timestamp,
    source: info.source,
    content: info.content,
    complete: info.complete,
    lineOffset: info.lineOffset,
    startLine: info.startLine,
    endLine: info.endLine,
    caption: info.caption,
  };
}

interface FileStore {
  tree?: FileTreeNode;
  files: Record<string, FileView>;

  setTree: (tree?: FileTreeNode) => void;
  ingest: (event: AbsenceEvent) => void;
  ingestEvents: (events: AbsenceEvent[]) => void;
  hydrate: (snapshot: SessionSnapshot) => void;
  /** Load the independent file-version index (Agent Folder / File History). */
  loadVersions: (sessionId: string) => Promise<void>;
  reset: () => void;
}

let versionsRequest = 0;

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
    set({
      tree: snapshot.tree,
      files: buildFileViews(snapshot.events, snapshot.files),
    });
    void get().loadVersions(snapshot.session.id);
  },

  loadVersions: async (sessionId) => {
    const request = ++versionsRequest;
    try {
      const infos = await api.fetchFileVersions(sessionId);
      if (request !== versionsRequest) return;
      const byPath = new Map<string, FileVersionInfo[]>();
      for (const info of infos) {
        const list = byPath.get(info.path);
        if (list) list.push(info);
        else byPath.set(info.path, [info]);
      }
      const files = { ...get().files };
      for (const [path, list] of byPath) {
        const current = files[path];
        const view = current ?? emptyView(path);
        const latest = list[list.length - 1];
        const history = list.map(versionFromInfo);
        // The snapshot's current state can be newer than the index only if a
        // write has not reached the store yet; keep it in that case.
        const currentWins = current !== undefined && current.version > (latest?.version ?? -1);
        files[path] = {
          ...view,
          path,
          history,
          knownLines:
            !currentWins && latest?.source === "read"
              ? latest.knownLines ?? {}
              : view.knownLines,
          content: currentWins ? current.content : latest?.content ?? view.content,
          version: currentWins ? current.version : latest?.version ?? view.version,
          complete: currentWins ? current.complete : latest?.complete ?? view.complete,
          lastModifiedAt: latest?.timestamp ?? view.lastModifiedAt,
        };
      }
      set({ files });
    } catch {
      // The current snapshot state remains usable; File History simply stays
      // at whatever the events provided.
    }
  },

  reset: () => {
    versionsRequest += 1;
    set({ tree: undefined, files: {} });
  },
}));
