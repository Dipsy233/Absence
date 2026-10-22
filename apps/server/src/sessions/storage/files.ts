import type { DatabaseSync } from "node:sqlite";
import {
  renderKnownState,
  type AbsenceEvent,
  type FileVersionInfo,
  type FileVersionSource,
} from "@absence/core";

/**
 * The file-version index.
 *
 * Files are not a view of History: Agent Folder lists every version the agent
 * held, File History diffs two of them, and both must work without loading a
 * run's events. This keeps those versions in their own table, materialised from
 * the same file events the UI already understands.
 *
 * Read versions follow the UI's v0 rule: consecutive reads accumulate into one
 * partial version. A write/edit appends a complete version and ends the
 * accumulation, so later reads do not rewrite what the agent wrote.
 */

interface FileState {
  knownLines: Record<number, string>;
  latestVersion: number;
  complete: boolean;
}

interface SessionFiles {
  files: Map<string, FileState>;
}

interface FileVersionRow {
  path: string;
  version: number;
  timestamp: number;
  source: FileVersionSource;
  complete: boolean;
  content: string;
  lineOffset: number;
  startLine?: number;
  endLine?: number;
  caption?: string;
  knownLinesJson?: string;
}

type SqlRow = Record<string, unknown>;

export class FileIndex {
  private states = new Map<string, SessionFiles>();
  private readonly selectFiles;
  private readonly insertVersion;
  private readonly deleteFile;
  private readonly deleteSession;

  constructor(private readonly db: DatabaseSync) {
    this.selectFiles = db.prepare(
      "SELECT path, version, complete, known_lines_json FROM file_versions WHERE session_id = ? ORDER BY path ASC, version ASC",
    );
    this.insertVersion = db.prepare(`
      INSERT INTO file_versions
        (session_id, path, version, ts, source, complete, content, line_offset,
         start_line, end_line, caption, known_lines_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, path, version) DO UPDATE SET
        ts               = excluded.ts,
        source           = excluded.source,
        complete         = excluded.complete,
        content          = excluded.content,
        line_offset      = excluded.line_offset,
        start_line       = excluded.start_line,
        end_line         = excluded.end_line,
        caption          = excluded.caption,
        known_lines_json = excluded.known_lines_json
    `);
    this.deleteFile = db.prepare(
      "DELETE FROM file_versions WHERE session_id = ? AND path = ?",
    );
    this.deleteSession = db.prepare("DELETE FROM file_versions WHERE session_id = ?");
  }

  /** Feed newly written file events, in order, into the index. */
  ingest(sessionId: string, events: AbsenceEvent[]): void {
    const state = this.state(sessionId);
    const writes: FileVersionRow[] = [];
    const deletes = new Set<string>();
    for (const event of events) this.apply(state, writes, deletes, event);
    for (const path of deletes) this.deleteFile.run(sessionId, path);
    for (const row of writes) {
      if (deletes.has(row.path)) continue;
      this.write(sessionId, row);
    }
  }

  /** Every recorded version for a session, oldest first per path. */
  list(sessionId: string): FileVersionInfo[] {
    const rows = this.db
      .prepare(
        "SELECT path, version, ts, source, complete, content, line_offset, start_line, end_line, caption, known_lines_json FROM file_versions WHERE session_id = ? ORDER BY path ASC, version ASC",
      )
      .all(sessionId) as SqlRow[];
    return rows.map(rowToVersion).filter((version): version is FileVersionInfo => version !== undefined);
  }

  /** Rebuild one session from its stored events (migration). */
  rebuild(sessionId: string): void {
    this.deleteSession.run(sessionId);
    this.states.delete(sessionId);
    const rows = this.db
      .prepare(
        "SELECT seq, id, ts, type, payload FROM events WHERE session_id = ? ORDER BY seq ASC",
      )
      .all(sessionId) as SqlRow[];
    const state = this.state(sessionId);
    const writes: FileVersionRow[] = [];
    const deletes = new Set<string>();
    for (const row of rows) {
      try {
        const event = {
          id: String(row.id),
          sessionId,
          timestamp: Number(row.ts),
          type: String(row.type),
          payload: JSON.parse(String(row.payload)),
        } as AbsenceEvent;
        this.apply(state, writes, deletes, event);
      } catch {
        // Skip a row written by an older/broken version.
      }
    }
    for (const path of deletes) this.deleteFile.run(sessionId, path);
    for (const row of writes) {
      if (deletes.has(row.path)) continue;
      this.write(sessionId, row);
    }
  }

  reset(): void {
    this.states.clear();
  }

  private state(sessionId: string): SessionFiles {
    const cached = this.states.get(sessionId);
    if (cached) return cached;

    const rows = this.selectFiles.all(sessionId) as SqlRow[];
    const files = new Map<string, FileState>();
    for (const row of rows) {
      const path = String(row.path ?? "");
      if (!path) continue;
      const version = Number(row.version ?? 0);
      const complete = Number(row.complete ?? 0) === 1;
      const knownLines = parseKnownLines(row.known_lines_json);
      const current = files.get(path);
      if (!current || version >= current.latestVersion) {
        files.set(path, {
          knownLines: complete ? {} : knownLines,
          latestVersion: version,
          complete,
        });
      }
    }
    const state: SessionFiles = { files };
    this.states.set(sessionId, state);
    return state;
  }

  private apply(
    state: SessionFiles,
    writes: FileVersionRow[],
    deletes: Set<string>,
    event: AbsenceEvent,
  ): void {
    if (event.type === "file_read") {
      const path = event.payload.path;
      let file = state.files.get(path);
      if (!file) {
        file = { knownLines: {}, latestVersion: -1, complete: false };
        state.files.set(path, file);
      }
      if (file.complete) return;

      const knownLines = { ...file.knownLines };
      const lines = event.payload.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        knownLines[event.payload.startLine + i] = lines[i]!;
      }
      const rendered = renderKnownState(knownLines);
      const version = Math.max(0, file.latestVersion);
      writes.push({
        path,
        version,
        timestamp: event.timestamp,
        source: "read",
        complete: false,
        content: rendered.content,
        lineOffset: rendered.lineOffset,
        startLine: rendered.startLine,
        endLine: rendered.endLine,
        caption: rendered.caption,
        knownLinesJson: JSON.stringify(knownLines),
      });
      file.knownLines = knownLines;
      file.latestVersion = version;
      file.complete = false;
      return;
    }

    if (event.type === "file_write" || event.type === "file_edit") {
      const path = event.payload.path;
      let file = state.files.get(path);
      if (!file) {
        file = { knownLines: {}, latestVersion: -1, complete: false };
        state.files.set(path, file);
      }
      const version = file.latestVersion + 1;
      const content = event.type === "file_edit" ? event.payload.after : event.payload.content;
      writes.push({
        path,
        version,
        timestamp: event.timestamp,
        source: event.type === "file_edit" ? "edit" : "write",
        complete: true,
        content,
        lineOffset: 0,
      });
      file.latestVersion = version;
      file.complete = true;
      file.knownLines = {};
      return;
    }

    if (event.type === "file_change" && event.payload.kind === "deleted") {
      const path = event.payload.path;
      deletes.add(path);
      state.files.delete(path);
    }
  }

  private write(sessionId: string, row: FileVersionRow): void {
    this.insertVersion.run(
      sessionId,
      row.path,
      row.version,
      row.timestamp,
      row.source,
      row.complete ? 1 : 0,
      row.content,
      row.lineOffset,
      row.startLine ?? null,
      row.endLine ?? null,
      row.caption ?? null,
      row.knownLinesJson ?? null,
    );
  }
}

function parseKnownLines(json: unknown): Record<number, string> {
  if (typeof json !== "string" || json.length === 0) return {};
  try {
    return JSON.parse(json) as Record<number, string>;
  } catch {
    return {};
  }
}

function rowToVersion(row: SqlRow): FileVersionInfo | undefined {
  const path = String(row.path ?? "");
  if (!path) return undefined;
  const source = String(row.source ?? "write") as FileVersionSource;
  return {
    path,
    version: Number(row.version ?? 0),
    timestamp: Number(row.ts ?? 0),
    source,
    complete: Number(row.complete ?? 0) === 1,
    content: String(row.content ?? ""),
    lineOffset: Number(row.line_offset ?? 0),
    startLine:
      row.start_line === null || row.start_line === undefined
        ? undefined
        : Number(row.start_line),
    endLine:
      row.end_line === null || row.end_line === undefined ? undefined : Number(row.end_line),
    caption: typeof row.caption === "string" ? row.caption : undefined,
    knownLines: source === "read" ? parseKnownLines(row.known_lines_json) : undefined,
  };
}

/**
 * One-time rebuild of the file-version index for databases created before it
 * existed. The marker is written only after the whole rebuild commits.
 */
export function ensureFileVersionsMigrated(db: DatabaseSync, index: FileIndex): void {
  const marker = db
    .prepare("SELECT value FROM store_meta WHERE key = ?")
    .get("file_versions_v1") as SqlRow | undefined;
  if (marker) return;

  const sessions = db.prepare("SELECT id FROM sessions").all() as SqlRow[];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM file_versions").run();
    for (const session of sessions) {
      const id = String(session.id ?? "");
      if (id) index.rebuild(id);
    }
    db.prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)").run(
      "file_versions_v1",
      "1",
    );
    db.exec("COMMIT");
    index.reset();
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original error is the useful one.
    }
    throw error;
  }
}
