import type { DatabaseSync } from "node:sqlite";
import {
  applyRunCount,
  emptyRunCounts,
  isObservedStream,
  OBSERVED_OPENING_EVENT_TYPES,
  type AbsenceEvent,
  type RunCounts,
  type RunStatus,
  type RunSummary,
} from "@absence/core";

/**
 * The run index.
 *
 * History should not have to load a session's events to draw its rows. This
 * keeps one summary per run in SQLite, updated as events are written, so the
 * History panel is a small indexed query and Activity is fetched only for the
 * run the user selects.
 *
 * Boundaries match the web's buildHistory:
 *   - a driven runtime opens a run at a user message and closes it at agent_end
 *   - a new user message before agent_end closes the previous run as interrupted
 *   - an observed session opens at its first activity and stays open
 *
 * The in-memory state is per session and only used by the writer. `list()` reads
 * the table, so a fresh process (or another client) sees the same rows.
 */

export interface RunEvent {
  seq: number;
  event: AbsenceEvent;
}

interface OpenRun {
  index: number;
  prompt: string;
  startedAt: number;
  fromSeq: number;
  toSeq: number;
  counts: RunCounts;
  touched: Set<string>;
}

interface SessionRuns {
  observed: boolean;
  closed: RunSummary[];
  open?: OpenRun;
  lastSeq: number;
}

type SqlRow = Record<string, unknown>;

export class RunIndex {
  private states = new Map<string, SessionRuns>();
  private readonly selectRuns;
  private readonly insertRun;
  private readonly deleteRuns;

  constructor(private readonly db: DatabaseSync) {
    this.selectRuns = db.prepare(
      "SELECT * FROM runs WHERE session_id = ? ORDER BY run_index ASC",
    );
    this.insertRun = db.prepare(`
      INSERT INTO runs
        (session_id, run_index, from_seq, to_seq, prompt, started_at, ended_at, status, counts_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, run_index) DO UPDATE SET
        from_seq   = excluded.from_seq,
        to_seq     = excluded.to_seq,
        prompt     = excluded.prompt,
        started_at = excluded.started_at,
        ended_at   = excluded.ended_at,
        status     = excluded.status,
        counts_json = excluded.counts_json
    `);
    this.deleteRuns = db.prepare("DELETE FROM runs WHERE session_id = ?");
  }

  /** Feed newly written events, in seq order, into the run index. */
  ingest(sessionId: string, observed: boolean, events: RunEvent[]): void {
    if (events.length === 0) return;
    const state = this.state(sessionId, observed);
    const closedNow: RunSummary[] = [];
    for (const { seq, event } of events) this.apply(state, closedNow, seq, event);
    for (const run of closedNow) this.write(sessionId, run);
    if (state.open) this.write(sessionId, this.summary(state.open, "running"));
  }

  /** All runs for a session, oldest first. Reads the table, not the cache. */
  list(sessionId: string): RunSummary[] {
    const rows = this.selectRuns.all(sessionId) as SqlRow[];
    return rows.map(rowToSummary).filter((run): run is RunSummary => run !== undefined);
  }

  /** Rebuild one session from its stored events (migration). */
  rebuild(sessionId: string, observed?: boolean): void {
    this.deleteRuns.run(sessionId);
    this.states.delete(sessionId);
    const rows = this.db
      .prepare(
        "SELECT seq, id, ts, type, payload FROM events WHERE session_id = ? ORDER BY seq ASC",
      )
      .all(sessionId) as SqlRow[];
    const events: RunEvent[] = [];
    for (const row of rows) {
      try {
        events.push({
          seq: Number(row.seq),
          event: {
            id: String(row.id),
            sessionId,
            timestamp: Number(row.ts),
            type: String(row.type),
            payload: JSON.parse(String(row.payload)),
          } as AbsenceEvent,
        });
      } catch {
        // A row written by an older/broken version is skipped, as elsewhere.
      }
    }
    // The runtime label is not enough: old test archives ran as "mock" but only
    // contained observed file events. Use the same signal as the web builder.
    const isObserved = observed ?? isObservedStream(events.map((entry) => entry.event));
    const state = this.state(sessionId, isObserved);
    const closedNow: RunSummary[] = [];
    for (const { seq, event } of events) this.apply(state, closedNow, seq, event);
    for (const run of closedNow) this.write(sessionId, run);
    if (state.open) this.write(sessionId, this.summary(state.open, "running"));
  }

  /** Drop cached writer state; the next ingest reloads from the table. */
  reset(): void {
    this.states.clear();
  }

  private state(sessionId: string, observed: boolean): SessionRuns {
    const cached = this.states.get(sessionId);
    if (cached) return cached;

    const rows = this.selectRuns.all(sessionId) as SqlRow[];
    const all = rows.map(rowToSummary).filter((run): run is RunSummary => run !== undefined);
    const last = all[all.length - 1];
    const open =
      last?.status === "running"
        ? {
            index: last.index,
            prompt: last.prompt,
            startedAt: last.startedAt,
            fromSeq: last.fromSeq,
            toSeq: last.toSeq,
            counts: { ...last.counts },
            touched: new Set<string>(),
          }
        : undefined;
    const closed = open ? all.slice(0, -1) : all;
    const state: SessionRuns = {
      observed,
      closed,
      open,
      lastSeq: all.reduce((max, run) => Math.max(max, run.toSeq), 0),
    };
    this.states.set(sessionId, state);
    return state;
  }

  private apply(
    state: SessionRuns,
    closedNow: RunSummary[],
    seq: number,
    event: AbsenceEvent,
  ): void {
    const previousSeq = state.lastSeq;
    state.lastSeq = seq;

    if (state.observed && !state.open && OBSERVED_OPENING_EVENT_TYPES.has(event.type)) {
      state.open = {
        index: state.closed.length + 1,
        prompt: "observed activity",
        startedAt: event.timestamp,
        fromSeq: seq,
        toSeq: seq,
        counts: emptyRunCounts(),
        touched: new Set<string>(),
      };
      applyRunCount(state.open.counts, event, state.open.touched);
      return;
    }

    if (event.type === "message" && event.payload.role === "user") {
      if (state.open) {
        const closed = this.close(state.open, Math.max(state.open.fromSeq, previousSeq), "interrupted");
        state.closed.push(closed);
        closedNow.push(closed);
      }
      state.open = {
        index: state.closed.length + 1,
        prompt: event.payload.content,
        startedAt: event.timestamp,
        fromSeq: seq,
        toSeq: seq,
        counts: emptyRunCounts(),
        touched: new Set<string>(),
      };
      return;
    }

    if (!state.open) return;

    if (event.type === "agent_end") {
      const reason = String(event.payload.reason);
      const status: RunStatus =
        reason === "aborted" ? "interrupted" : reason === "error" ? "error" : "completed";
      const closed = this.close(state.open, seq, status, event.timestamp);
      state.closed.push(closed);
      closedNow.push(closed);
      state.open = undefined;
      return;
    }

    applyRunCount(state.open.counts, event, state.open.touched);
    state.open.toSeq = seq;
  }

  private close(
    open: OpenRun,
    toSeq: number,
    status: RunStatus,
    endedAt?: number,
  ): RunSummary {
    return {
      id: `run_${open.index}`,
      index: open.index,
      prompt: open.prompt,
      startedAt: open.startedAt,
      endedAt: status === "running" ? undefined : endedAt,
      status,
      fromSeq: open.fromSeq,
      toSeq: Math.max(open.fromSeq, toSeq),
      counts: { ...open.counts },
    };
  }

  private summary(open: OpenRun, status: RunStatus): RunSummary {
    return {
      id: `run_${open.index}`,
      index: open.index,
      prompt: open.prompt,
      startedAt: open.startedAt,
      status,
      fromSeq: open.fromSeq,
      toSeq: open.toSeq,
      counts: { ...open.counts },
    };
  }

  private write(sessionId: string, run: RunSummary): void {
    this.insertRun.run(
      sessionId,
      run.index,
      run.fromSeq,
      run.toSeq,
      run.prompt,
      run.startedAt,
      run.endedAt ?? null,
      run.status,
      JSON.stringify(run.counts),
    );
  }
}

function rowToSummary(row: SqlRow): RunSummary | undefined {
  const index = Number(row.run_index);
  if (!Number.isInteger(index) || index < 1) return undefined;
  let counts: RunCounts;
  try {
    counts = JSON.parse(String(row.counts_json)) as RunCounts;
  } catch {
    counts = emptyRunCounts();
  }
  return {
    id: `run_${index}`,
    index,
    prompt: String(row.prompt ?? ""),
    startedAt: Number(row.started_at ?? 0),
    endedAt: row.ended_at === null || row.ended_at === undefined ? undefined : Number(row.ended_at),
    status: String(row.status ?? "completed") as RunStatus,
    fromSeq: Number(row.from_seq ?? 0),
    toSeq: Number(row.to_seq ?? 0),
    counts,
  };
}

/**
 * One-time rebuild of the runs table for databases created before it existed.
 * The marker is only written after the whole rebuild commits.
 */
export function ensureRunsMigrated(db: DatabaseSync, index: RunIndex): void {
  const marker = db
    .prepare("SELECT value FROM store_meta WHERE key = ?")
    .get("runs_v1") as SqlRow | undefined;
  if (marker) return;

  const sessions = db.prepare("SELECT id, runtime FROM sessions").all() as SqlRow[];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM runs").run();
    for (const session of sessions) {
      const id = String(session.id ?? "");
      if (!id) continue;
      index.rebuild(id);
    }
    db.prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)").run(
      "runs_v1",
      "1",
    );
    db.exec("COMMIT");
    // Rebuild only needs the writer cache during the migration; keeping one
    // entry per historical session would defeat the point of a lazy index.
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
