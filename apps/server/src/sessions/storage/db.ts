import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  isStreamingEvent,
  type AbsenceEvent,
  type FileVersionInfo,
  type RunSummary,
  type SessionEventPage,
} from "@absence/core";
import { toPosix } from "../../util/paths";
import { eventsFile, sessionsRoot, stateRoot } from "./legacyPaths";
import { ensureFileVersionsMigrated, FileIndex } from "./files";
import { ensureRunsMigrated, RunIndex, type RunEvent } from "./runs";

/**
 * ABSENCE's session store.
 *
 * The live session is still in memory (`SessionStore`); this module only
 * replaces the on-disk archive behind `archive.ts`. Keeping the same five
 * functions — readMeta / writeMeta / appendEvents / readEvents / listArchives —
 * means the event bus, the WebSocket protocol, the Stage and every UI store are
 * untouched. The database is a persistence adapter, not a second source of
 * live state.
 *
 * Why SQLite: the JSONL archive had to be scanned file-by-file to list history
 * and read whole files to resume a session. SQLite gives indexed history,
 * idempotent writes, and a place for the metric rollups we want next. The cost
 * is one schema and one importer, both confined to this directory.
 *
 * Writes are buffered for FLUSH_MS and committed in one transaction. A burst of
 * process/file events therefore costs one commit, not one per event. The data
 * is durable up to that window; `drainArchive()` flushes it on dispose.
 */

export interface ArchiveMeta {
  version: 1;
  absenceSessionId: string;
  projectPath: string;
  projectName: string;
  startedAt: number;
  updatedAt: number;
  model?: string;
  runtime: string;
  /** Pi's session file, when the session ran on the Pi runtime. */
  piSessionFile?: string;
  piSessionId?: string;
  messageCount: number;
  firstPrompt?: string;
}

type SqlRow = Record<string, unknown>;

/**
 * `node:sqlite` is experimental in the Node versions we ship (22/24) and prints
 * an ExperimentalWarning the first time it loads. The API we use is wrapped
 * here and the runtime is pinned (Electron exact; Node LTS in .nvmrc/CI), so the
 * warning is noise in the server log. Filter only that one warning.
 *
 * The patch has to run before the module is loaded, so `node:sqlite` is pulled
 * in with `createRequire` instead of a static import (which the module loader
 * would evaluate before this file's body). This is cosmetic: the module is
 * still experimental upstream. Swapping to better-sqlite3 means deleting this
 * block and the require below; the rest of Absence does not care.
 */
const originalEmitWarning = process.emitWarning as (...args: unknown[]) => void;
process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
  const message =
    typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  const type =
    typeof args[0] === "string"
      ? args[0]
      : warning instanceof Error
        ? warning.name
        : "";
  if (type === "ExperimentalWarning" && /SQLite/i.test(message)) return;
  originalEmitWarning.call(process, warning, ...args);
}) as typeof process.emitWarning;

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const DB_FILE = "absence.db";
const SCHEMA_VERSION = 2;
const FLUSH_MS = 50;

let database: DatabaseSyncType | undefined;
let runIndex: RunIndex | undefined;
let fileIndex: FileIndex | undefined;
let pending = new Map<
  string,
  { cwd: string; events: AbsenceEvent[]; observed: boolean }
>();
let flushTimer: NodeJS.Timeout | undefined;
/** Next `seq` per session, cached so a batch does not re-query MAX(seq). */
const nextSeq = new Map<string, number>();

function dbFile(): string {
  return path.join(stateRoot(), DB_FILE);
}

/**
 * The shared SQLite handle. The archive and the metric store both live in this
 * database; keeping one opener means one schema, one WAL and one lifecycle.
 */
export function openDatabase(): DatabaseSyncType {
  return open();
}

function open(): DatabaseSyncType {
  if (database) return database;
  fs.mkdirSync(stateRoot(), { recursive: true });
  const db = new DatabaseSync(dbFile());
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS store_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      project_path    TEXT NOT NULL,
      project_name    TEXT NOT NULL,
      started_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      runtime         TEXT NOT NULL DEFAULT 'unknown',
      model           TEXT,
      pi_session_file TEXT,
      pi_session_id   TEXT,
      message_count   INTEGER NOT NULL DEFAULT 0,
      first_prompt    TEXT,
      meta_json       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path, updated_at DESC);

    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      id         TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      type       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      PRIMARY KEY (session_id, seq),
      UNIQUE (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type, ts);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(session_id, ts);

    CREATE TABLE IF NOT EXISTS runs (
      session_id  TEXT NOT NULL,
      run_index   INTEGER NOT NULL,
      from_seq    INTEGER NOT NULL,
      to_seq      INTEGER NOT NULL,
      prompt      TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      status      TEXT NOT NULL,
      counts_json TEXT NOT NULL,
      PRIMARY KEY (session_id, run_index)
    );
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, run_index);

    CREATE TABLE IF NOT EXISTS file_versions (
      session_id       TEXT NOT NULL,
      path             TEXT NOT NULL,
      version          INTEGER NOT NULL,
      ts               INTEGER NOT NULL,
      source           TEXT NOT NULL,
      complete         INTEGER NOT NULL,
      content          TEXT NOT NULL,
      line_offset      INTEGER NOT NULL DEFAULT 0,
      start_line       INTEGER,
      end_line         INTEGER,
      caption          TEXT,
      known_lines_json TEXT,
      PRIMARY KEY (session_id, path, version)
    );
    CREATE INDEX IF NOT EXISTS idx_file_versions_path ON file_versions(session_id, path, version);

    -- v0.4: process resource metrics. One row per egg per ~30 minute chunk;
    -- the arrays are packed binary (Float32 CPU deltas + Uint32 RSS KiB), so
    -- a thousand eggs do not turn into a million relational rows a day.
    CREATE TABLE IF NOT EXISTS metric_chunks (
      session_id TEXT NOT NULL,
      egg_pid    INTEGER NOT NULL,
      start_ts   INTEGER NOT NULL,
      step_ms    INTEGER NOT NULL,
      n          INTEGER NOT NULL,
      cpu_base   REAL NOT NULL,
      cpu        BLOB NOT NULL,
      rss_kib    BLOB NOT NULL,
      PRIMARY KEY (session_id, egg_pid, start_ts)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_metric_chunks_ts
      ON metric_chunks(session_id, start_ts);

    CREATE TABLE IF NOT EXISTS egg_metric_summary (
      session_id        TEXT NOT NULL,
      egg_pid           INTEGER NOT NULL,
      name              TEXT NOT NULL,
      kind              TEXT NOT NULL,
      status            TEXT NOT NULL,
      first_ts          INTEGER NOT NULL,
      last_ts           INTEGER NOT NULL,
      cpu_seconds_start REAL NOT NULL,
      cpu_seconds_end   REAL NOT NULL,
      rss_integral      REAL NOT NULL,
      samples           INTEGER NOT NULL,
      PRIMARY KEY (session_id, egg_pid)
    );

    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
  try {
    importLegacyArchives(db);
    const runs = new RunIndex(db);
    ensureRunsMigrated(db, runs);
    const files = new FileIndex(db);
    ensureFileVersionsMigrated(db, files);
    runIndex = runs;
    fileIndex = files;
  } catch (error) {
    // Leave no half-open database behind: the next call must retry the import.
    db.close();
    throw error;
  }
  database = db;
  return db;
}

/**
 * One-time import of the JSONL archives that existed before the database.
 *
 * The marker is written only after the whole import commits, so a crash leaves
 * the next start to retry. `INSERT OR IGNORE` makes a retry idempotent. Streaming
 * message/thinking events are dropped: the final non-streaming event carries the
 * same value and the archive never needed every prefix (see `isStreamingEvent`).
 *
 * Legacy files are left in place. They are no longer written, but they are a
 * useful export/backup and deleting user data is not this migration's job.
 */
function importLegacyArchives(db: DatabaseSyncType): void {
  const marker = db
    .prepare("SELECT value FROM store_meta WHERE key = ?")
    .get("jsonl_import_v1") as SqlRow | undefined;
  if (marker) return;

  const root = sessionsRoot();
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    // No legacy archive: mark it so we do not stat the directory every start.
  }

  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO sessions
      (id, project_path, project_name, started_at, updated_at, runtime, model,
       pi_session_file, pi_session_id, message_count, first_prompt, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (session_id, seq, id, ts, type, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let sessions = 0;
  let events = 0;
  let skipped = 0;

  if (dirs.length > 0) {
    console.log(`[absence] importing legacy JSONL archives from ${root} ...`);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const dir of dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".meta.json")) continue;
        let meta: ArchiveMeta;
        try {
          meta = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as ArchiveMeta;
        } catch {
          continue;
        }
        if (!meta?.absenceSessionId) continue;
        insertSession.run(...sessionParams(meta));
        sessions += 1;

        let text: string;
        try {
          text = fs.readFileSync(eventsFile(meta.projectPath, meta.absenceSessionId), "utf8");
        } catch {
          continue;
        }
        let lineNo = 0;
        for (const line of text.split("\n")) {
          lineNo += 1;
          if (!line.trim()) continue;
          let event: AbsenceEvent;
          try {
            event = JSON.parse(line) as AbsenceEvent;
          } catch {
            skipped += 1;
            continue;
          }
          if (!event || typeof event.type !== "string") {
            skipped += 1;
            continue;
          }
          if (isStreamingEvent(event)) continue;
          const id =
            typeof event.id === "string" && event.id
              ? event.id
              : `${meta.absenceSessionId}:${lineNo}`;
          const ts = Number.isFinite(event.timestamp) ? event.timestamp : meta.startedAt;
          try {
            insertEvent.run(
              meta.absenceSessionId,
              lineNo,
              id,
              ts,
              event.type,
              JSON.stringify(event.payload),
            );
            events += 1;
          } catch {
            skipped += 1;
          }
        }
      }
    }
    db.prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)").run(
      "jsonl_import_v1",
      "1",
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already be gone; the original error is the useful one.
    }
    throw error;
  }

  if (sessions > 0 || events > 0 || skipped > 0) {
    console.log(
      `[absence] imported ${sessions} session(s) / ${events} event(s) from JSONL archives` +
        (skipped > 0 ? ` (${skipped} unreadable line(s) skipped)` : ""),
    );
  }
}

function sessionParams(meta: ArchiveMeta): [
  string,
  string,
  string,
  number,
  number,
  string,
  string | null,
  string | null,
  string | null,
  number,
  string | null,
  string,
] {
  const projectPath = toPosix(path.resolve(meta.projectPath));
  return [
    meta.absenceSessionId,
    projectPath,
    meta.projectName || path.basename(projectPath) || projectPath,
    meta.startedAt,
    meta.updatedAt,
    meta.runtime || "unknown",
    meta.model ?? null,
    meta.piSessionFile ?? null,
    meta.piSessionId ?? null,
    meta.messageCount ?? 0,
    meta.firstPrompt ?? null,
    JSON.stringify(meta),
  ];
}

function rowToMeta(row: SqlRow): ArchiveMeta | undefined {
  const id = typeof row.id === "string" ? row.id : undefined;
  if (!id) return undefined;
  return {
    version: 1,
    absenceSessionId: id,
    projectPath: String(row.project_path ?? ""),
    projectName: String(row.project_name ?? ""),
    startedAt: Number(row.started_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    model: typeof row.model === "string" ? row.model : undefined,
    runtime: String(row.runtime ?? "unknown"),
    piSessionFile: typeof row.pi_session_file === "string" ? row.pi_session_file : undefined,
    piSessionId: typeof row.pi_session_id === "string" ? row.pi_session_id : undefined,
    messageCount: Number(row.message_count ?? 0),
    firstPrompt: typeof row.first_prompt === "string" ? row.first_prompt : undefined,
  };
}

export async function readMeta(cwd: string, id: string): Promise<ArchiveMeta | undefined> {
  flushPending();
  const row = open()
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(id) as SqlRow | undefined;
  return row ? rowToMeta(row) : undefined;
}

export async function writeMeta(cwd: string, meta: ArchiveMeta): Promise<void> {
  try {
    open()
      .prepare(
        `
        INSERT INTO sessions
          (id, project_path, project_name, started_at, updated_at, runtime, model,
           pi_session_file, pi_session_id, message_count, first_prompt, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_path    = excluded.project_path,
          project_name    = excluded.project_name,
          started_at      = excluded.started_at,
          updated_at      = excluded.updated_at,
          runtime         = excluded.runtime,
          model           = excluded.model,
          pi_session_file = excluded.pi_session_file,
          pi_session_id   = excluded.pi_session_id,
          message_count   = excluded.message_count,
          first_prompt    = excluded.first_prompt,
          meta_json       = excluded.meta_json
      `,
      )
      .run(...sessionParams(meta));
  } catch (error) {
    // Archiving is best-effort; a failed write must never break a session.
    console.error("[absence] sqlite meta write failed:", error);
  }
}

export function appendEvents(
  cwd: string,
  id: string,
  events: AbsenceEvent[],
  options: { observed?: boolean } = {},
): void {
  const durable = events.filter((event) => !isStreamingEvent(event));
  if (durable.length === 0) return;
  const projectPath = toPosix(path.resolve(cwd));
  const observed = options.observed === true;
  const entry = pending.get(id);
  if (entry) {
    entry.cwd = projectPath;
    entry.observed = observed;
    entry.events.push(...durable);
  } else {
    pending.set(id, { cwd: projectPath, events: durable, observed });
  }
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushPending();
  }, FLUSH_MS);
}

function ensureSessionRow(
  db: DatabaseSyncType,
  cwd: string,
  id: string,
  events: AbsenceEvent[],
): void {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  db.prepare(`
    INSERT OR IGNORE INTO sessions
      (id, project_path, project_name, started_at, updated_at, runtime, message_count)
    VALUES (?, ?, ?, ?, ?, 'unknown', 0)
  `).run(id, cwd, path.basename(cwd) || cwd, first.timestamp, last.timestamp);
}

function flushPending(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (pending.size === 0) return;
  const batch = pending;
  pending = new Map();

  let db: DatabaseSyncType;
  try {
    db = open();
  } catch (error) {
    console.error("[absence] sqlite open failed:", error);
    return;
  }

  try {
    db.exec("BEGIN IMMEDIATE");
    const insertEvent = db.prepare(`
      INSERT OR IGNORE INTO events (session_id, seq, id, ts, type, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const maxSeq = db.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?",
    );
    const touch = db.prepare("UPDATE sessions SET updated_at = MAX(updated_at, ?) WHERE id = ?");

    const committed = new Map<string, number>();
    for (const [id, entry] of batch) {
      ensureSessionRow(db, entry.cwd, id, entry.events);
      let seq = nextSeq.get(id);
      if (seq === undefined) {
        const row = maxSeq.get(id) as { next?: number } | undefined;
        seq = Number(row?.next ?? 1);
      }
      const runEvents: RunEvent[] = [];
      for (const event of entry.events) {
        insertEvent.run(
          id,
          seq,
          event.id,
          event.timestamp,
          event.type,
          JSON.stringify(event.payload),
        );
        runEvents.push({ seq, event });
        seq += 1;
      }
      runIndex?.ingest(id, entry.observed, runEvents);
      fileIndex?.ingest(id, entry.events);
      committed.set(id, seq);
      touch.run(entry.events[entry.events.length - 1]!.timestamp, id);
    }
    db.exec("COMMIT");
    for (const [id, seq] of committed) nextSeq.set(id, seq);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nothing useful to add; the write error below is the cause.
    }
    // The in-memory run accumulator may be ahead of the rolled-back rows.
    // Dropping it makes the next write reload from the table.
    runIndex?.reset();
    fileIndex?.reset();
    console.error("[absence] sqlite event write failed:", error);
  }
}

/** Wait for pending writes (used on dispose and by tests). */
export async function drainArchive(): Promise<void> {
  flushPending();
}

/** Rebuild the full AbsenceEvent from the columns + payload JSON. */
function eventFromRow(sessionId: string, row: SqlRow): AbsenceEvent {
  return {
    id: String(row.id),
    sessionId,
    timestamp: Number(row.ts),
    type: String(row.type),
    payload: JSON.parse(String(row.payload)),
  } as AbsenceEvent;
}

export async function readEvents(cwd: string, id: string): Promise<AbsenceEvent[]> {
  flushPending();
  let rows: SqlRow[];
  try {
    rows = open()
      .prepare("SELECT id, ts, type, payload FROM events WHERE session_id = ? ORDER BY seq ASC")
      .all(id) as SqlRow[];
  } catch (error) {
    console.error("[absence] sqlite event read failed:", error);
    return [];
  }

  const events: AbsenceEvent[] = [];
  for (const row of rows) {
    try {
      events.push(eventFromRow(id, row));
    } catch {
      // Skip a row written by an older/broken version.
    }
  }
  return events;
}

/** Read only process lifecycle events for restoring the Eggs panel. */
export async function readProcessEvents(cwd: string, id: string): Promise<AbsenceEvent[]> {
  flushPending();
  let rows: SqlRow[];
  try {
    rows = open()
      .prepare("SELECT id, ts, type, payload FROM events WHERE session_id = ? AND type = 'process' ORDER BY seq ASC")
      .all(id) as SqlRow[];
  } catch (error) {
    console.error("[absence] sqlite process event read failed:", error);
    return [];
  }
  const events: AbsenceEvent[] = [];
  for (const row of rows) {
    try {
      events.push(eventFromRow(id, row));
    } catch {
      // Skip a row written by an older/broken version.
    }
  }
  return events;
}

/**
 * One page of stored events, oldest → newest. `before` is exclusive (events
 * with `seq < before`); omitting it returns the newest page. The cursor in
 * `nextBefore` is the oldest `seq` in this page, so the next call can ask for
 * the events immediately older than it.
 */
export async function readEventsPage(
  id: string,
  options: { before?: number; limit?: number } = {},
): Promise<SessionEventPage> {
  flushPending();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 500), 1), 2000);
  const before = options.before;
  let rows: SqlRow[];
  try {
    const db = open();
    rows = (
      before === undefined
        ? db
            .prepare(
              "SELECT seq, id, ts, type, payload FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
            )
            .all(id, limit + 1)
        : db
            .prepare(
              "SELECT seq, id, ts, type, payload FROM events WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
            )
            .all(id, before, limit + 1)
    ) as SqlRow[];
  } catch (error) {
    console.error("[absence] sqlite event page read failed:", error);
    return { events: [], hasMore: false };
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  // The query walks backwards; the API and the UI both want chronological order.
  page.reverse();
  const events: AbsenceEvent[] = [];
  for (const row of page) {
    try {
      events.push(eventFromRow(id, row));
    } catch {
      // Skip a row written by an older/broken version.
    }
  }
  const nextBefore = hasMore && page.length > 0 ? Number(page[0]!.seq) : undefined;
  return { events, nextBefore, hasMore };
}

/** Every archive header for a project, or for all projects when cwd is omitted. */
export async function listArchives(cwd?: string): Promise<ArchiveMeta[]> {
  flushPending();
  // Stored paths are POSIX absolute paths (see SessionStore.create). Normalise
  // the filter the same way so a Windows caller's backslashes still match.
  const project = cwd ? toPosix(path.resolve(cwd)) : undefined;
  let rows: SqlRow[];
  try {
    rows = project
      ? (open()
          .prepare(
            "SELECT * FROM sessions WHERE project_path = ? COLLATE NOCASE ORDER BY updated_at DESC",
          )
          .all(project) as SqlRow[])
      : (open().prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as SqlRow[]);
  } catch (error) {
    console.error("[absence] sqlite history read failed:", error);
    return [];
  }
  return rows.map(rowToMeta).filter((meta): meta is ArchiveMeta => meta !== undefined);
}

/** Run summaries for History, oldest first. */
export async function readRuns(id: string): Promise<RunSummary[]> {
  flushPending();
  try {
    return runIndex?.list(id) ?? [];
  } catch (error) {
    console.error("[absence] sqlite run read failed:", error);
    return [];
  }
}

/** The events belonging to one run, by its inclusive seq range. */
export async function readRunEvents(
  id: string,
  fromSeq: number,
  toSeq: number,
): Promise<AbsenceEvent[]> {
  flushPending();
  let rows: SqlRow[];
  try {
    rows = open()
      .prepare(
        "SELECT id, ts, type, payload FROM events WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC",
      )
      .all(id, fromSeq, toSeq) as SqlRow[];
  } catch (error) {
    console.error("[absence] sqlite run event read failed:", error);
    return [];
  }
  const events: AbsenceEvent[] = [];
  for (const row of rows) {
    try {
      events.push(eventFromRow(id, row));
    } catch {
      // Skip a row written by an older/broken version.
    }
  }
  return events;
}

/** Every recorded file version for a session, independent of the event window. */
export async function readFileVersions(id: string): Promise<FileVersionInfo[]> {
  flushPending();
  try {
    return fileIndex?.list(id) ?? [];
  } catch (error) {
    console.error("[absence] sqlite file version read failed:", error);
    return [];
  }
}

/** Close the database (tests, and a clean process shutdown). */
export function closeArchive(): void {
  flushPending();
  database?.close();
  database = undefined;
  runIndex?.reset();
  runIndex = undefined;
  fileIndex?.reset();
  fileIndex = undefined;
  nextSeq.clear();
}
