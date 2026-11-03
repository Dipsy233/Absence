import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  isStreamingEvent,
  previewText,
  type AbsenceEvent,
  type FileVersionInfo,
  type FileVersionSummary,
  type RunSummary,
  type SessionEventForwardPage,
  type SessionEventPage,
  type SessionHistoryEntry,
  type SessionHistoryPage,
  type SessionHistoryQuery,
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
  /**
   * Historical column names, kept for archive compatibility: since v0.5.0 they
   * store the generic ACP resume handle and the runtime's session id for *any*
   * agent, not just Pi. Do not rename — old archives must keep loading.
   */
  piSessionFile?: string;
  piSessionId?: string;
  messageCount: number;
  firstPrompt?: string;
  /**
   * Dwell time this session had accrued when it was last closed, in ms.
   *
   * A session's "duration" is how long the user actually spent in it, not how
   * much wall time has passed since it was created: leaving the project and
   * coming back later continues the clock instead of restarting it or counting
   * the hours in between. Absent on archives written before this was tracked.
   */
  dwellMs?: number;
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
const SCHEMA_VERSION = 4;
const FLUSH_MS = 50;

let database: DatabaseSyncType | undefined;
let runIndex: RunIndex | undefined;
let fileIndex: FileIndex | undefined;
let pending = new Map<
  string,
  { cwd: string; events: AbsenceEvent[] }
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
      -- Provenance, stored so GET /events returns the same shape as the live
      -- WS stream. Rows written before this default to 'unknown'.
      source     TEXT NOT NULL DEFAULT 'unknown',
      fidelity   TEXT NOT NULL DEFAULT 'unknown',
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
      range_known      INTEGER NOT NULL DEFAULT 1,
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

    -- The machine's own counters, so an expanded dashboard can draw the host as
    -- a dashed reference line over a session that is no longer live. Same
    -- packed-chunk shape as metric_chunks, keyed by session and start time only
    -- (the host has no pid).
    CREATE TABLE IF NOT EXISTS host_metric_chunks (
      session_id    TEXT NOT NULL,
      start_ts      INTEGER NOT NULL,
      step_ms       INTEGER NOT NULL,
      n             INTEGER NOT NULL,
      cpu_base      REAL NOT NULL,
      cpu_idle_base REAL NOT NULL,
      cpu           BLOB NOT NULL,
      cpu_idle      BLOB NOT NULL,
      mem_used_kib  BLOB NOT NULL,
      mem_total_kib BLOB NOT NULL,
      cpu_count     INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (session_id, start_ts)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_host_metric_chunks_ts
      ON host_metric_chunks(session_id, start_ts);

    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
  try {
    // `CREATE TABLE IF NOT EXISTS` does not add a column to an existing DB.
    // This is the one column added after v0.4 shipped; older rows default to
    // known, which is exactly what their 1..N display represented.
    ensureColumn(db, "file_versions", "range_known", "INTEGER NOT NULL DEFAULT 1");
    // v0.4.1: event provenance. `CREATE TABLE IF NOT EXISTS` does not add
    // columns to an existing DB, and old rows have no provenance to recover —
    // `unknown` is exactly what Absence can honestly say about them.
    ensureColumn(db, "events", "source", "TEXT NOT NULL DEFAULT 'unknown'");
    ensureColumn(db, "events", "fidelity", "TEXT NOT NULL DEFAULT 'unknown'");
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

/** Add a column when a database created by an older build lacks it. */
function ensureColumn(
  db: DatabaseSyncType,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
  if (columns.some((entry) => String(entry.name) === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    INSERT OR IGNORE INTO events (session_id, seq, id, ts, type, payload, source, fidelity)
    VALUES (?, ?, ?, ?, ?, ?, 'unknown', 'unknown')
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
    dwellMs: readDwell(row),
  };
}

/**
 * The accrued dwell time, from the meta blob the row round-trips.
 *
 * It lives in `meta_json` rather than its own column on purpose: it is a value
 * the session writes as a whole, not something the archive queries, and adding a
 * column would mean a migration for one number. The dedicated columns exist for
 * the fields history sorts and filters on.
 */
function readDwell(row: SqlRow): number | undefined {
  if (typeof row.meta_json !== "string") return undefined;
  try {
    const meta = JSON.parse(row.meta_json) as { dwellMs?: unknown };
    const dwell = Number(meta.dwellMs);
    return Number.isFinite(dwell) && dwell > 0 ? dwell : undefined;
  } catch {
    return undefined;
  }
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
): void {
  const durable = events.filter((event) => !isStreamingEvent(event));
  if (durable.length === 0) return;
  const projectPath = toPosix(path.resolve(cwd));
  const entry = pending.get(id);
  if (entry) {
    entry.cwd = projectPath;
    entry.events.push(...durable);
  } else {
    pending.set(id, { cwd: projectPath, events: durable });
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
      INSERT OR IGNORE INTO events (session_id, seq, id, ts, type, payload, source, fidelity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
          storedPayload(event),
          event.source ?? "unknown",
          event.fidelity ?? "unknown",
        );
        runEvents.push({ seq, event });
        seq += 1;
      }
      runIndex?.ingest(id, runEvents);
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

/**
 * The payload as it is stored: large text fields reduced to a preview.
 *
 * The event stream carries whole files (a `file_write`'s content, an edit's
 * `before`/`after`/`diff`, a command's stdout) and the same values are already
 * materialised into `file_versions` by the FileIndex — full fidelity, exactly
 * one copy. Storing them again inside every event row doubles the database for
 * nothing a reader needs: Activity, the Stage and the replay timeline show the
 * head of a value, and the full text is fetched from the file-version endpoint
 * when someone actually opens it.
 *
 * The truncation happens at the storage boundary only: the run index, the file
 * index and the live window all receive the full event. Rows written before
 * this existed keep their full payloads, and every reader must therefore treat
 * `previewTruncated` as "may be a preview", never its absence as "complete".
 */
const TRUNCATED_TEXT_FIELDS: Partial<Record<AbsenceEvent["type"], string[]>> = {
  file_read: ["content"],
  file_write: ["content"],
  file_edit: ["before", "after", "diff"],
  command: ["stdout", "stderr"],
  search: ["output"],
  mcp: ["args", "result", "structured"],
};

function storedPayload(event: AbsenceEvent): string {
  const fields = TRUNCATED_TEXT_FIELDS[event.type];
  if (!fields) return JSON.stringify(event.payload);
  const payload = event.payload as unknown as Record<string, unknown>;
  let truncated = false;
  const stored = { ...payload };
  for (const field of fields) {
    const value = stored[field];
    if (typeof value !== "string") continue;
    const preview = previewText(value);
    if (preview !== value) {
      stored[field] = preview;
      truncated = true;
    }
  }
  if (!truncated) return JSON.stringify(event.payload);
  return JSON.stringify({ ...stored, previewTruncated: true });
}

/** Rebuild the full AbsenceEvent from the columns + payload JSON. */
function eventFromRow(sessionId: string, row: SqlRow): AbsenceEvent {
  const timestamp = Number(row.ts);
  const source = typeof row.source === "string" && row.source.length > 0 ? row.source : "unknown";
  const fidelity =
    typeof row.fidelity === "string" && row.fidelity.length > 0 ? row.fidelity : "unknown";
  return {
    id: String(row.id),
    sessionId,
    timestamp,
    type: String(row.type),
    payload: JSON.parse(String(row.payload)),
    // Same flat provenance the live WS frame carries. Rows written before the
    // columns existed read back as `unknown`.
    at: timestamp,
    source,
    fidelity,
    // The persisted position, when the query asked for it (the paging paths
    // do; the whole-session resume read does not need it).
    ...(row.seq !== undefined ? { seq: Number(row.seq) } : {}),
  } as AbsenceEvent;
}

export async function readEvents(cwd: string, id: string): Promise<AbsenceEvent[]> {
  flushPending();
  let rows: SqlRow[];
  try {
    rows = open()
      .prepare("SELECT id, ts, type, payload, source, fidelity FROM events WHERE session_id = ? ORDER BY seq ASC")
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
      .prepare("SELECT id, ts, type, payload, source, fidelity FROM events WHERE session_id = ? AND type = 'process' ORDER BY seq ASC")
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
              "SELECT seq, id, ts, type, payload, source, fidelity FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
            )
            .all(id, limit + 1)
        : db
            .prepare(
              "SELECT seq, id, ts, type, payload, source, fidelity FROM events WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
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

/**
 * One forward page of stored events, oldest → newest, for catch-up reads.
 *
 * `after` is exclusive (events with `seq > after`), so a client that holds its
 * last seen seq asks for exactly what it missed instead of re-downloading a
 * full snapshot on every reconnect. The mirror of `readEventsPage`, which
 * pages backwards from the newest event.
 */
export async function readEventsPageForward(
  id: string,
  options: { after?: number; limit?: number } = {},
): Promise<SessionEventForwardPage> {
  flushPending();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 500), 1), 2000);
  const after = options.after;
  let rows: SqlRow[];
  try {
    const db = open();
    rows = (
      after === undefined
        ? db
            .prepare(
              "SELECT seq, id, ts, type, payload, source, fidelity FROM events WHERE session_id = ? ORDER BY seq ASC LIMIT ?",
            )
            .all(id, limit + 1)
        : db
            .prepare(
              "SELECT seq, id, ts, type, payload, source, fidelity FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
            )
            .all(id, after, limit + 1)
    ) as SqlRow[];
  } catch (error) {
    console.error("[absence] sqlite event forward read failed:", error);
    return { events: [], hasMore: false };
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const events: AbsenceEvent[] = [];
  for (const row of page) {
    try {
      events.push(eventFromRow(id, row));
    } catch {
      // Skip a row written by an older/broken version.
    }
  }
  const nextAfter = hasMore && events.length > 0 ? Number(page[page.length - 1]!.seq) : undefined;
  return { events, nextAfter, hasMore };
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

/** Encode a history pagination cursor: sort key + id tie-break, plainly. */
function historyCursor(updatedAt: number, id: string): string {
  return `${updatedAt}~${id}`;
}

function parseHistoryCursor(cursor: string | undefined): { updatedAt: number; id: string } | undefined {
  if (!cursor) return undefined;
  const sep = cursor.lastIndexOf("~");
  if (sep <= 0) return undefined;
  const updatedAt = Number(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  return Number.isSafeInteger(updatedAt) && updatedAt >= 0 && id ? { updatedAt, id } : undefined;
}

/**
 * Filtered, paginated history query — the search/filter front end of
 * `listArchives`. Everything is pushed into SQL so a thousand archived
 * sessions cost one indexed scan, not one process-side pass over every row.
 *
 * The cursor is the `(updated_at, id)` pair of the last row of the previous
 * page: `updated_at` is the sort key, `id` breaks the (common) ties between
 * sessions touched in the same second. Order is `updated_at DESC, id DESC`,
 * matching `listArchives`.
 */
export async function queryArchives(
  query: SessionHistoryQuery,
): Promise<SessionHistoryPage> {
  flushPending();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.path?.trim()) {
    // Stored paths are POSIX absolute; normalise a Windows caller's backslashes.
    conditions.push("project_path = ? COLLATE NOCASE");
    params.push(toPosix(path.resolve(query.path.trim())));
  }
  if (query.search?.trim()) {
    // A substring match, not a prefix match: people search "absence", not
    // "E:/work/absence". LIKE wildcards in the term are literal, so escape them.
    const term = query.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    const pattern = `%${term}%`;
    conditions.push(
      "(project_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR project_path LIKE ? ESCAPE '\\' COLLATE NOCASE OR first_prompt LIKE ? ESCAPE '\\')",
    );
    params.push(pattern, pattern, pattern);
  }
  if (query.runtime?.trim()) {
    conditions.push("runtime = ?");
    params.push(query.runtime.trim());
  }
  if (query.since !== undefined) {
    conditions.push("updated_at >= ?");
    params.push(query.since);
  }
  if (query.until !== undefined) {
    conditions.push("updated_at <= ?");
    params.push(query.until);
  }
  const cursor = parseHistoryCursor(query.cursor);
  if (cursor) {
    conditions.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }

  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  let rows: SqlRow[];
  try {
    rows = open()
      .prepare(
        `SELECT * FROM sessions ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as SqlRow[];
  } catch (error) {
    console.error("[absence] sqlite history query failed:", error);
    return { entries: [], hasMore: false };
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const metas = page
    .map(rowToMeta)
    .filter((meta): meta is ArchiveMeta => meta !== undefined);
  const last = metas[metas.length - 1];
  return {
    entries: metas.map(metaToHistoryEntry),
    hasMore,
    ...(hasMore && last ? { nextCursor: historyCursor(last.updatedAt, last.absenceSessionId) } : {}),
  };
}

/** The archive row shaped as the wire history entry (same as the list route). */
function metaToHistoryEntry(meta: ArchiveMeta): SessionHistoryEntry {
  return {
    id: meta.absenceSessionId,
    absenceSessionId: meta.absenceSessionId,
    projectPath: meta.projectPath,
    projectName: meta.projectName,
    createdAt: meta.startedAt,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
    firstPrompt: meta.firstPrompt,
    runtime: meta.runtime,
    archived: true,
  };
}

/**
 * Delete one archived session's persisted state: its events, runs, file
 * versions, metrics and the header row. The live session is untouched — the
 * route refuses to call this while the session is still open, because the
 * next flush would silently recreate the rows.
 *
 * The metric tables are deleted here rather than through `metrics.ts` because
 * that module imports this one (for `openDatabase`); the schema for all of
 * them lives in this file's `open()`, so the delete statements belong to the
 * same place.
 */
export async function deleteArchive(id: string): Promise<boolean> {
  flushPending();
  const db = open();
  const row = db.prepare("SELECT id FROM sessions WHERE id = ?").get(id) as SqlRow | undefined;
  if (!row) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of [
      "events",
      "runs",
      "file_versions",
      "metric_chunks",
      "egg_metric_summary",
      "host_metric_chunks",
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
    }
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original error is the useful one.
    }
    throw error;
  }
  // The writers cache per-session state; drop it so a same-id session created
  // later does not inherit sequences or run/file state from deleted rows.
  nextSeq.delete(id);
  runIndex?.reset();
  fileIndex?.reset();
  return true;
}

/**
 * Archive retention, opt-in via config (`sessionRetentionDays` /
 * `maxArchivedSessions`; both default off). Called once at startup and then
 * daily, next to the metric expiry. Deleting user data is never a default:
 * until the operator asks for it, the archive grows unbounded.
 */
export async function expireArchives(options: {
  retentionDays?: number;
  maxSessions?: number;
}): Promise<number> {
  const { retentionDays = 0, maxSessions = 0 } = options;
  if (retentionDays <= 0 && maxSessions <= 0) return 0;
  let targets: string[] = [];
  try {
    const db = open();
    if (retentionDays > 0) {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
      const rows = db
        .prepare("SELECT id FROM sessions WHERE updated_at < ? ORDER BY updated_at DESC")
        .all(cutoff) as SqlRow[];
      targets.push(...rows.map((row) => String(row.id)));
    }
    if (maxSessions > 0) {
      const rows = db
        .prepare("SELECT id FROM sessions ORDER BY updated_at DESC LIMIT -1 OFFSET ?")
        .all(maxSessions) as SqlRow[];
      targets.push(...rows.map((row) => String(row.id)));
    }
  } catch (error) {
    console.error("[absence] sqlite retention query failed:", error);
    return 0;
  }
  let deleted = 0;
  for (const id of new Set(targets)) {
    try {
      if (await deleteArchive(id)) deleted += 1;
    } catch (error) {
      console.error(`[absence] retention delete failed for ${id}:`, error);
    }
  }
  if (deleted > 0) {
    console.log(`[absence] retention removed ${deleted} archived session(s)`);
  }
  return deleted;
}

/**
 * Close a run the archive still marks open, because the process that owned it
 * died before `agent_end` could arrive.
 *
 * See `RunIndex.closeStaleOpen`: without this a resumed session reports its last
 * run as still running, and the Stage keeps following work that already stopped.
 */
export async function closeStaleOpenRun(id: string, endedAt?: number): Promise<void> {
  flushPending();
  try {
    runIndex?.closeStaleOpen(id, endedAt);
  } catch (error) {
    console.error("[absence] sqlite run close failed:", error);
  }
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
        "SELECT seq, id, ts, type, payload, source, fidelity FROM events WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC",
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

/**
 * One forward page of a run's events, oldest → newest.
 *
 * A long run can span tens of thousands of events, so it is fetched in
 * chunks: the client asks for the page after its last seq until `hasMore`
 * is false, rendering each page as it arrives, instead of one unbounded
 * response it must parse whole.
 */
export async function readRunEventsPage(
  id: string,
  fromSeq: number,
  toSeq: number,
  options: { after?: number; limit?: number } = {},
): Promise<SessionEventForwardPage> {
  flushPending();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 500), 1), 2000);
  // `after` is exclusive; before the first page it sits just under the run.
  const after = Math.max(Math.trunc(options.after ?? fromSeq - 1), fromSeq - 1);
  let rows: SqlRow[];
  try {
    rows = open()
      .prepare(
        "SELECT seq, id, ts, type, payload, source, fidelity FROM events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?",
      )
      .all(id, after, toSeq, limit + 1) as SqlRow[];
  } catch (error) {
    console.error("[absence] sqlite run event page read failed:", error);
    return { events: [], hasMore: false };
  }
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const events: AbsenceEvent[] = [];
  for (const row of page) {
    try {
      events.push(eventFromRow(id, row));
    } catch {
      // Skip a row written by an older/broken version.
    }
  }
  const nextAfter = hasMore && page.length > 0 ? Number(page[page.length - 1]!.seq) : undefined;
  return { events, nextAfter, hasMore };
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

/**
 * The file-version listing without full contents: sizes and a short preview,
 * so an outline can be sent for a session with thousands of versions and the
 * text fetched per version on demand. Same order as `readFileVersions`.
 */
export async function readFileVersionSummaries(id: string): Promise<FileVersionSummary[]> {
  flushPending();
  try {
    return fileIndex?.listSummaries(id) ?? [];
  } catch (error) {
    console.error("[absence] sqlite file version summary read failed:", error);
    return [];
  }
}

/**
 * One file version's full content, by its exact key. This is the read side of
 * payload previews: an event row stores the head of a value, and this returns
 * the whole thing that the FileIndex materialised from the same event.
 */
export async function readFileVersionContent(
  id: string,
  filePath: string,
  version: number,
): Promise<FileVersionInfo | undefined> {
  flushPending();
  try {
    return fileIndex?.content(id, filePath, version);
  } catch (error) {
    console.error("[absence] sqlite file version content read failed:", error);
    return undefined;
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
