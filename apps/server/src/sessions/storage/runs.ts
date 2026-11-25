import type { DatabaseSync } from "node:sqlite";
import {
  applyRunCount,
  emptyRunCounts,
  previewText,
  RUN_BURST_IDLE_MS,
  type AbsenceEvent,
  type RunCounts,
  type RunStatus,
  type RunSummary,
  type RunBoundarySource,
} from "@absence/core";

/**
 * The stored prompt is an outline field: History shows one line per run, so a
 * 10 KB paste is kept at 200 characters in the table. The full text remains in
 * the run's first `message` event.
 */
const PROMPT_PREVIEW_LIMIT = 200;

/**
 * The run index.
 *
 * History should not have to load a session's events to draw its rows. This
 * keeps one summary per run in SQLite, updated as events are written, so the
 * History panel is a small indexed query and Activity is fetched only for the
 * run the user selects.
 *
 * Boundaries match the web's buildHistory:
 *   - a runtime opens a run at a user message and closes it at agent_end
 *   - a new user message before agent_end closes the previous run as interrupted
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
  /** When the newest event in this run happened (burst segmentation). */
  lastAt?: number;
  /** What opened this run: a user message, an activity burst, or an attach. */
  boundarySource: RunBoundarySource;
  /** True when facts before this run are simply not in the record. */
  truncatedBefore?: boolean;
}

interface SessionRuns {
  sessionId: string;
  closed: RunSummary[];
  open?: OpenRun;
  lastSeq: number;
}

type SqlRow = Record<string, unknown>;

export class RunIndex {
  private states = new Map<string, SessionRuns>();
  /**
   * Sessions whose runs are activity bursts rather than user turns.
   *
   * An OS-only watch (channel "os") records processes, files and metrics but
   * no messages, so "a user message opens a run" has nothing to hang on.
   * There, a run is one burst of activity: it opens at the first fact after
   * silence and closes when the session goes quiet again (see
   * `closeOpen`), which is the honest shape of what Absence actually saw.
   */
  private readonly burstSessions = new Set<string>();
  /**
   * Sessions allowed to open a run without a user message.
   *
   * Only a transcript observation can legitimately attach mid-run (the file
   * already holds an assistant turn). A proxy session's projector always
   * delivers the prompt first, so it must not fabricate a headless run.
   */
  private readonly attachSessions = new Set<string>();
  private readonly selectRuns;
  private readonly insertRun;
  private readonly deleteRuns;

  constructor(private readonly db: DatabaseSync) {
    this.selectRuns = db.prepare(
      "SELECT * FROM runs WHERE session_id = ? ORDER BY run_index ASC",
    );
    this.insertRun = db.prepare(`
      INSERT INTO runs
        (session_id, run_index, from_seq, to_seq, prompt, started_at, ended_at, status, counts_json,
         boundary_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, run_index) DO UPDATE SET
        from_seq   = excluded.from_seq,
        to_seq     = excluded.to_seq,
        prompt     = excluded.prompt,
        started_at = excluded.started_at,
        ended_at   = excluded.ended_at,
        status     = excluded.status,
        counts_json = excluded.counts_json,
        boundary_source = excluded.boundary_source
    `);
    this.deleteRuns = db.prepare("DELETE FROM runs WHERE session_id = ?");
  }

  /** Feed newly written events, in seq order, into the run index. */
  ingest(sessionId: string, events: RunEvent[]): void {
    if (events.length === 0) return;
    const state = this.state(sessionId);
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
  rebuild(sessionId: string): void {
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
    const state = this.state(sessionId);
    const closedNow: RunSummary[] = [];
    for (const { seq, event } of events) this.apply(state, closedNow, seq, event);
    for (const run of closedNow) this.write(sessionId, run);
    if (state.open) this.write(sessionId, this.summary(state.open, "running"));
  }

  /** Drop cached writer state; the next ingest reloads from the table. */
  reset(): void {
    this.states.clear();
  }

  /**
   * Close a run the table still marks open, because nothing is going to close
   * it now.
   *
   * A run is opened at a user message and closed at `agent_end`. When the
   * server dies mid-run (or the agent process is killed) the `agent_end` never
   * arrives, so the row stays `running` forever — and every reader of the run
   * list believes the run is still in flight. The UI is the visible symptom:
   * `MonitorStage` sees `status === "running"`, keeps following, and the centre
   * panel sits on the last activity of a run that ended long ago.
   *
   * Called when a session is resumed (`SessionStore.start`): a reopened session
   * is by definition not mid-run, so a row still marked running was
   * interrupted. `endedAt` is unknown for those — there was no event to take it
   * from — so the run reports no end time, which is the honest answer.
   *
   * Reads the table rather than the cached writer state: on a fresh process
   * (the resume case that matters) that cache has not been loaded yet, and
   * loading it here would freeze an `observed` flag this call cannot know.
   */
  closeStaleOpen(sessionId: string, endedAt?: number): void {
    const rows = this.selectRuns.all(sessionId) as SqlRow[];
    const all = rows.map(rowToSummary).filter((run): run is RunSummary => run !== undefined);
    const last = all[all.length - 1];
    if (last?.status !== "running") return;
    this.write(sessionId, { ...last, endedAt, status: "interrupted" });
    // The writer's cached view still holds this run as open; drop it so the
    // next ingest starts from the corrected table.
    this.states.delete(sessionId);
  }

  private state(sessionId: string): SessionRuns {
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
            boundarySource: last.boundarySource ?? "user-message",
            ...(last.truncatedBefore === true ? { truncatedBefore: true } : {}),
          }
        : undefined;
    const closed = open ? all.slice(0, -1) : all;
    const state: SessionRuns = {
      sessionId,
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

    if (this.burstSessions.has(state.sessionId) && !(event.type === "message" && event.payload.role === "user")) {
      this.applyBurst(state, closedNow, seq, event);
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
        boundarySource: "user-message",
      };
      return;
    }

    if (!state.open) {
      // No user turn opened this run. For a transcript observation that means
      // the observer attached mid-run (the file's head is an assistant turn);
      // the facts before the attach are simply not in the record, so the run
      // is honestly marked `attach` and flagged as truncated. Any other
      // channel (a proxy, a fixture) must not invent a headless run.
      if (!this.attachSessions.has(state.sessionId) || state.closed.length > 0 || event.source !== "transcript") return;
      if (event.type === "agent_end" || event.type === "usage") return;
      state.open = {
        index: state.closed.length + 1,
        prompt: "",
        startedAt: event.timestamp,
        fromSeq: seq,
        toSeq: seq,
        counts: emptyRunCounts(),
        touched: new Set<string>(),
        boundarySource: "attach",
        truncatedBefore: true,
      };
      applyRunCount(state.open.counts, event, state.open.touched);
      return;
    }

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

  /** Turns activity-burst mode on for a session (see `burstSessions`). */
  setBurstMode(sessionId: string): void {
    this.burstSessions.add(sessionId);
  }

  /** Allows a session to open a run without a user turn (see `attachSessions`). */
  setAttachMode(sessionId: string): void {
    this.attachSessions.add(sessionId);
  }

  /**
   * Switch an OS-only session to transcript run boundaries.
   *
   * The watch began as a bare process, where silence was the only possible
   * boundary; once its transcript is folded in, user turns and `agent_end`
   * are back and they are the truthful shape. The caller rebuilds the rows
   * (see `markTranscriptSession`), because the burst rows already written
   * labelled runs by their first event — "usage", "tool_end" — and would
   * otherwise keep masquerading as turns.
   */
  setTranscriptMode(sessionId: string): void {
    this.burstSessions.delete(sessionId);
    this.attachSessions.add(sessionId);
  }

  /**
   * Close a session's open run because nothing more is coming.
   *
   * A burst cannot close itself: the silence *after* the last fact is what
   * ends it, and no event will arrive to say so. The session calls this on
   * its own idle timer.
   */
  closeOpen(sessionId: string, endedAt?: number): void {
    const state = this.states.get(sessionId);
    if (!state?.open) return;
    const closed = this.close(state.open, state.open.toSeq, "completed", endedAt ?? state.open.lastAt);
    state.closed.push(closed);
    state.open = undefined;
    this.write(sessionId, closed);
  }

  /**
   * One fact in an activity-burst session: open at the first, cut on silence.
   *
   * The label is the first thing a reader would name the burst after — a
   * command's text, a path, a process — because there is no prompt to use.
   */
  private applyBurst(
    state: SessionRuns,
    closedNow: RunSummary[],
    seq: number,
    event: AbsenceEvent,
  ): void {
    if (event.type === "agent_end") {
      // An OS-only watch should never see one; if it does, honour it.
      if (state.open) {
        const closed = this.close(state.open, seq, "completed", event.timestamp);
        state.closed.push(closed);
        closedNow.push(closed);
        state.open = undefined;
      }
      return;
    }

    const open = state.open;
    if (open && event.timestamp - (open.lastAt ?? open.startedAt) > RUN_BURST_IDLE_MS) {
      const closed = this.close(open, Math.max(open.fromSeq, open.toSeq), "completed", open.lastAt);
      state.closed.push(closed);
      closedNow.push(closed);
      state.open = undefined;
    }

    if (!state.open) {
      state.open = {
        index: state.closed.length + 1,
        prompt: burstLabel(event),
        startedAt: event.timestamp,
        fromSeq: seq,
        toSeq: seq,
        counts: emptyRunCounts(),
        touched: new Set<string>(),
        lastAt: event.timestamp,
        boundarySource: "activity-burst",
      };
      applyRunCount(state.open.counts, event, state.open.touched);
      return;
    }

    applyRunCount(state.open.counts, event, state.open.touched);
    state.open.toSeq = seq;
    state.open.lastAt = Math.max(state.open.lastAt ?? event.timestamp, event.timestamp);
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
      boundarySource: open.boundarySource,
      ...(open.truncatedBefore === true ? { truncatedBefore: true } : {}),
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
      boundarySource: open.boundarySource,
      ...(open.truncatedBefore === true ? { truncatedBefore: true } : {}),
    };
  }

  private write(sessionId: string, run: RunSummary): void {
    this.insertRun.run(
      sessionId,
      run.index,
      run.fromSeq,
      run.toSeq,
      previewText(run.prompt, PROMPT_PREVIEW_LIMIT),
      run.startedAt,
      run.endedAt ?? null,
      run.status,
      JSON.stringify(run.counts),
      run.boundarySource ?? "user-message",
    );
  }
}

/** What to call a burst that had no prompt to name it. */
function burstLabel(event: AbsenceEvent): string {
  switch (event.type) {
    case "command": {
      const command = String(event.payload.command ?? "").trim().replace(/s+/g, " ");
      return command.length > 0 ? `$ ${command}` : "command";
    }
    case "file_write":
    case "file_edit":
    case "file_read":
    case "file_change":
      return String(event.payload.path ?? "file");
    case "process":
      return String(event.payload.name ?? "process");
    case "search":
      return `search ${String(event.payload.query ?? "")}`.trim();
    default:
      return event.type;
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
  const fromSeq = Number(row.from_seq ?? 0);
  const toSeq = Number(row.to_seq ?? 0);
  return {
    id: `run_${index}`,
    index,
    prompt: String(row.prompt ?? ""),
    startedAt: Number(row.started_at ?? 0),
    endedAt: row.ended_at === null || row.ended_at === undefined ? undefined : Number(row.ended_at),
    status: String(row.status ?? "completed") as RunStatus,
    fromSeq,
    toSeq,
    counts,
    // Seqs are contiguous per session, so the span is the count. A gap (an
    // ignored duplicate write) makes this an upper bound, which is the right
    // bias for something that sizes a run before it is loaded.
    eventCount: Math.max(0, toSeq - fromSeq + 1),
    ...(typeof row.boundary_source === "string" && row.boundary_source.length > 0
      ? {
          boundarySource: row.boundary_source as RunSummary["boundarySource"],
          ...(row.boundary_source === "attach" ? { truncatedBefore: true } : {}),
        }
      : {}),
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
