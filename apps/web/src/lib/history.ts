import type { AbsenceEvent } from "@absence/core";
import type { ActivityRow } from "../types/stage";
import { appendActivityRow, eventToActivityRow } from "./events";
import type { HistoryRun, RunCounts } from "../types/history";

/** One event's contribution to a run's counts. */
function applyCount(counts: RunCounts, event: AbsenceEvent, touched: Set<string>) {
  switch (event.type) {
    case "file_read":
      counts.read += 1;
      touched.add(event.payload.path);
      break;
    case "file_edit":
      counts.edit += 1;
      touched.add(event.payload.path);
      break;
    case "file_write": {
      counts.edit += 1;
      const path = event.payload.path;
      // A write to a path nobody had seen before is a new file.
      if (!touched.has(path)) counts.created += 1;
      touched.add(path);
      break;
    }
    case "file_change":
      if (event.payload.kind === "created") counts.created += 1;
      touched.add(event.payload.path);
      break;
    case "search":
      counts.search += 1;
      break;
    case "command":
      counts.run += 1;
      break;
    default:
      break;
  }
}

/**
 * Group the event stream into runs (read02-style sessions split by user input).
 * A run starts at a user message and ends at `agent_end`; if a new user message
 * arrives first, the previous run was interrupted.
 *
 * `fromIndex`/`toIndex` are indices into the `events` array passed in. Callers
 * that need them to survive the live window sliding should go through
 * `memoBuildHistory`, which shifts them as the head is trimmed.
 */
export function buildHistory(events: AbsenceEvent[]): HistoryRun[] {
  const runs: HistoryRun[] = [];
  /** Paths touched by earlier runs, so "created" means created *here*. */
  const touched = new Set<string>();
  let start:
    | { from: number; prompt: string; startedAt: number; counts: RunCounts; touched: Set<string> }
    | null = null;

  const flush = (toIndex: number, endedAt: number | undefined, status: HistoryRun["status"]) => {
    if (!start) return;
    runs.push({
      id: `run_${runs.length + 1}`,
      index: runs.length + 1,
      prompt: start.prompt,
      startedAt: start.startedAt,
      endedAt,
      status,
      fromIndex: start.from,
      toIndex,
      counts: { ...start.counts },
    });
    for (const path of start.touched) touched.add(path);
    start = null;
  };

  /**
   * An observed agent never gets a `message` from us to send it, so the run
   * boundary has to come from something it does: the OLDEST event after the
   * last run is its opening. That keeps "runs" — the unit History, Replay and
   * the Report are built on — working for a session Absence only watches, with
   * no runtime to ask for a prompt.
   */
  const observed = isObservedStream(events);
  const opening = (index: number, timestamp: number) => ({
    from: index,
    prompt: observed ? "observed activity" : "",
    startedAt: timestamp,
    counts: { read: 0, search: 0, edit: 0, run: 0, created: 0 },
    touched: new Set<string>(),
  });

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (observed && !start && OPENING_EVENT_TYPES.has(event.type)) {
      start = opening(i, event.timestamp);
      applyCount(start.counts, event, start.touched);
      continue;
    }
    if (event.type === "message" && event.payload.role === "user") {
      if (start) flush(i - 1, undefined, "interrupted");
      start = {
        from: i,
        prompt: event.payload.content,
        startedAt: event.timestamp,
        counts: { read: 0, search: 0, edit: 0, run: 0, created: 0 },
        touched: new Set(),
      };
    } else if (event.type === "agent_end" && start) {
      const reason = String(event.payload.reason);
      flush(i, event.timestamp, reason === "aborted" ? "interrupted" : reason === "error" ? "error" : "completed");
    } else if (start) {
      applyCount(start.counts, event, start.touched);
    }
  }

  if (start) flush(events.length - 1, undefined, "running");
  return runs;
}

/**
 * Events that open a run in a session Absence only observes.
 *
 * Everything the OS reports about the agent's work qualifies; `message` and
 * `agent_start` are a driven runtime's, and cannot appear here. Kept small on
 * purpose: it answers "when did this start", not "what counts as activity".
 */
const OPENING_EVENT_TYPES = new Set<AbsenceEvent["type"]>([
  "process",
  "file_change",
  "file_write",
  "file_edit",
  "file_read",
  "command",
  "search",
  "mcp",
  "tool_start",
  "thinking",
]);

/**
 * Whether this window is an observed session's.
 *
 * Deliberately inferred from the events rather than passed in: `buildHistory`
 * is called from the incremental memo, the Report and Replay, and threading a
 * session flag through all of them would put the same knowledge in four places.
 * The signal is unambiguous — a driven runtime always opens with
 * `agent_start`, and an observed session cannot produce one.
 */
export function isObservedStream(events: AbsenceEvent[]): boolean {
  for (const event of events) {
    if (event.type === "agent_start") return false;
    if (event.type === "message" && event.payload.role === "user") return false;
  }
  return events.length > 0;
}

/** The events belonging to a run, clamped to the live window. */
export function runEvents(events: AbsenceEvent[], run: HistoryRun): AbsenceEvent[] {
  // `fromIndex`/`toIndex` are relative to the *current* window, and a run the
  // head has passed is clamped to the base, so `from` is already a valid index;
  // only the end needs clamping to what is loaded. An empty run has
  // `to < from`: nothing to show.
  const from = Math.max(0, run.fromIndex);
  const to = Math.min(events.length - 1, run.toIndex);
  if (to < from || events.length === 0) return [];
  return events.slice(from, to + 1);
}

/** The selected run, falling back to the newest one. */
export function pickRun(runs: HistoryRun[], selectedId: string | undefined): HistoryRun | undefined {
  if (selectedId) {
    const found = runs.find((run) => run.id === selectedId);
    if (found) return found;
  }
  return runs[runs.length - 1];
}

// ---------------------------------------------------------------------------
// Incremental memo
// ---------------------------------------------------------------------------

/**
 * A run whose index range has to be rebased when the window slides. Runs hold
 * indices into the live array, so when the store trims the head, every kept
 * index shifts left by the same amount.
 */
interface OpenRun {
  prompt: string;
  startedAt: number;
  /** Absolute index of the user message that opened the run. */
  fromIndex: number;
  counts: RunCounts;
  /** Paths this run touched, for `created` being run-relative. */
  touched: Set<string>;
}

interface HistoryCache {
  /**
   * The array this cache last folded. The store hands out a fresh array on
   * every change (so React re-renders), so identity cannot be the key; this is
   * used only to tell "same window, new wrapper" from "different session".
   */
  source: AbsenceEvent[] | undefined;
  /** Absolute index of `events[0]` in the session: how many were dropped. */
  base: number;
  /** Events already folded into `runs`/`open`. */
  consumed: number;
  /**
   * Closed runs, in **absolute** indices. Relative indices are derived on
   * publish, so a trim never has to rewrite what is already folded — and a run
   * that has slid entirely out of the window can simply be dropped.
   */
  runs: HistoryRun[];
  /** Paths touched by all *closed* runs. */
  touched: Set<string>;
  open?: OpenRun;
  /**
   * True once a driven runtime's marker (`agent_start` / a user message) has
   * been seen. Until then the cache also opens runs at an observed stream's
   * first event; see applyEvent.
   */
  observed: boolean;
  /** The runs array handed out, reused as long as it is not mutated in place. */
  view: HistoryRun[];
}

/**
 * One cache per module is enough: there is exactly one live session store, and
 * `hydrate`/`reset` are detected through the base/length check rather than the
 * array identity (which changes on every append now).
 */
let cache: HistoryCache | undefined;

/**
 * `buildHistory` memoised on the event array, incrementally.
 *
 * The store appends to one array and trims its head in place, so on each event
 * only the new tail is folded — the previous O(N) re-group is gone. Two facts
 * make that safe:
 *
 * - **Base offset.** The store records how many events it has dropped
 *   (`eventsBase`). `fromIndex`/`toIndex` stay indices into the *current*
 *   array: a run's absolute start minus the base. A run entirely behind the
 *   base no longer has events to show; it is kept as a `partial` row with an
 *   empty range (see `rebase`) rather than dropped.
 * - **Stable identity.** Hydrate and reset replace the array, which starts a
 *   fresh cache; appends and trims keep the identity.
 *
 * `base` is read from the array itself (`eventsBase`) so the cache never needs
 * the store. Declared as a non-enumerable symbol-keyed field by the store.
 */
const BASE = Symbol.for("absence.eventsBase");

/** Attach the absolute index of `events[0]` (the trim count) to the array. */
export function markEventsBase(events: AbsenceEvent[], base: number): void {
  Object.defineProperty(events, BASE, {
    value: base,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export function eventsBase(events: AbsenceEvent[]): number {
  const value = (events as unknown as Record<symbol, unknown>)[BASE];
  return typeof value === "number" ? value : 0;
}
export function memoBuildHistory(events: AbsenceEvent[]): HistoryRun[] {
  const base = eventsBase(events);
  const stored = cache;

  // A *different* window (a rewind, a shorter array after a hydrate) is not a
  // continuation: rebuild from scratch. Note the absent `stored.base > base`
  // test — that case is a jump forward (a trimmed window delivered in one go),
  // which `rebase` handles without losing the runs it has already folded.
  if (!stored || base < stored.base || stored.consumed > base + events.length) {
    const fresh = fold(events, base);
    cache = fresh;
    return fresh.view;
  }

  if (base > stored.consumed) {
    // The head moved past events that were never folded (nothing rendered
    // between the two calls). The runs in those events cannot be recovered
    // from the stream, so a fresh fold is the honest answer.
    const fresh = fold(events, base);
    cache = fresh;
    return fresh.view;
  }

  if (stored.source === events) {
    // Same wrapper: the view is already correct.
    return stored.view;
  }

  if (stored.base < base) {
    // The window slid: drop runs whose start fell out of it.
    rebase(stored, base);
  }

  const from = stored.consumed - base;
  if (from >= 0 && from < events.length) {
    for (let i = from; i < events.length; i++) applyEvent(stored, events[i]!, base + i);
    stored.consumed = base + events.length;
  }

  stored.source = events;
  // Publish the open run (or clear it) without rebuilding the closed ones.
  publishOpen(stored, base + events.length - 1);
  return stored.view;
}

function fold(events: AbsenceEvent[], base: number): HistoryCache {
  const entry: HistoryCache = {
    source: events,
    base,
    consumed: base,
    runs: [],
    touched: new Set(),
    observed: false,
    view: [],
  };
  for (let i = 0; i < events.length; i++) applyEvent(entry, events[i]!, base + i);
  entry.consumed = base + events.length;
  publishOpen(entry, base + events.length - 1);
  return entry;
}

/**
 * Rebase a cache onto a newer base after a head trim.
 *
 * Runs are stored with absolute indices, so nothing has to be rewritten: a run
 * whose start fell behind the base is dropped (see the filter below for why),
 * and the rest keep their absolute indices until publish converts them.
 */
function rebase(entry: HistoryCache, base: number): void {
  entry.base = base;
  // Nothing is dropped for being old, not even a run the window has slid
  // completely past: History is the record of what happened in this session,
  // and losing a row whenever the oldest one was trimmed is why the panel came
  // to show only the newest run. Such a run keeps its number and its prompt,
  // with an empty range and `partial` set — its counts and Stage content are
  // gone with its events, and saying so is better than a vanished row.
  //
  // A run the head has only partly passed starts at the base, also marked
  // partial: its counts cover the part still loaded. A fresh fold over the same
  // window cannot see either run — which is the reason this cache exists.
  entry.runs = entry.runs.map((run) => {
    const fromIndex = Math.max(run.fromIndex, base);
    // An empty range is `toIndex === fromIndex - 1` whichever end ran out
    // first — one shape for "no events left", so `runEvents` needs no special
    // case beyond `to < from`.
    const empty = run.toIndex < base || run.fromIndex > run.toIndex;
    const toIndex = empty ? fromIndex - 1 : run.toIndex;
    const partial = run.partial || run.fromIndex < base;
    return partial === Boolean(run.partial) && fromIndex === run.fromIndex && toIndex === run.toIndex
      ? run
      : { ...run, fromIndex, toIndex, ...(partial ? { partial: true } : {}) };
  });
  // The view is rebuilt on publish with the current base.
  entry.view = [];
}

function applyEvent(entry: HistoryCache, event: AbsenceEvent, absoluteIndex: number) {
  if (!entry.observed && OPENING_EVENT_TYPES.has(event.type) && !entry.open) {
    // Observe mode: the first event after the last run opens it. See
    // buildHistory for why a watched agent cannot open a run with a prompt.
    // A driven runtime's marker below flips `observed` and reopens the run with
    // its own prompt instead, so this opening is replaced, not kept.
    entry.open = {
      prompt: "observed activity",
      startedAt: event.timestamp,
      fromIndex: absoluteIndex,
      counts: { read: 0, search: 0, edit: 0, run: 0, created: 0 },
      touched: new Set(),
    };
    applyCount(entry.open.counts, event, entry.open.touched);
    return;
  }
  if (event.type === "message" && event.payload.role === "user") {
    entry.observed = false;
    closeOpen(entry, undefined, "interrupted", absoluteIndex - 1);
    entry.open = {
      prompt: event.payload.content,
      startedAt: event.timestamp,
      fromIndex: absoluteIndex,
      counts: { read: 0, search: 0, edit: 0, run: 0, created: 0 },
      touched: new Set(),
    };
    return;
  }
  if (event.type === "agent_start" && entry.open && entry.open.prompt === "observed activity") {
    // The runtime announced itself: this is a driven session, and the run starts
    // where it said, not at the observed events that preceded it.
    entry.observed = false;
    entry.open = undefined;
  }
  if (!entry.open) return;
  if (event.type === "agent_end") {
    const reason = String(event.payload.reason);
    closeOpen(
      entry,
      event.timestamp,
      reason === "aborted" ? "interrupted" : reason === "error" ? "error" : "completed",
      absoluteIndex,
    );
    return;
  }
  applyCount(entry.open.counts, event, entry.open.touched);
}

function closeOpen(
  entry: HistoryCache,
  endedAt: number | undefined,
  status: HistoryRun["status"],
  absoluteTo: number,
): void {
  const open = entry.open;
  if (!open) return;
  for (const path of open.touched) entry.touched.add(path);
  entry.runs.push({
    id: `run_${entry.runs.length + 1}`,
    index: entry.runs.length + 1,
    prompt: open.prompt,
    startedAt: open.startedAt,
    endedAt,
    status,
    // Absolute; `publish` converts to indices into the current window.
    fromIndex: open.fromIndex,
    toIndex: absoluteTo,
    counts: { ...open.counts },
  });
  entry.open = undefined;
  entry.view = [];
}

/**
 * Publish the closed runs plus, if one is open, a running run for it. The open
 * run is rebuilt fresh each time rather than mutated, because consumers hold the
 * array they were handed.
 */
function publishOpen(entry: HistoryCache, absoluteLast: number): void {
  const base = entry.base;
  // Deliberately not clamped at 0: an empty run's end is `fromIndex - 1`, and
  // clamping would turn "no events" into a range containing the first one.
  // Callers treat `to < from` as empty (see `runEvents`).
  const rel = (absolute: number) => absolute - base;
  const closed = entry.runs.map((run) => ({
    ...run,
    fromIndex: rel(run.fromIndex),
    toIndex: rel(run.toIndex),
    ...(run.partial ? { partial: true } : {}),
  }));
  if (!entry.open) {
    entry.view = closed;
    return;
  }
  const open = entry.open;
  const running: HistoryRun = {
    id: `run_${entry.runs.length + 1}`,
    index: entry.runs.length + 1,
    prompt: open.prompt,
    startedAt: open.startedAt,
    status: "running",
    fromIndex: rel(open.fromIndex),
    toIndex: rel(absoluteLast),
    counts: { ...open.counts },
  };
  entry.view = [...closed, running];
}

// ---------------------------------------------------------------------------
// Activity rows
// ---------------------------------------------------------------------------

/**
 * Activity rows for one run, built incrementally.
 *
 * The panel used to `map` + `filter` the whole run on every event, which is
 * O(run length) per token and allocates a new array each time. Here the rows
 * are kept per (events array, run, visibility) and only the tail is converted:
 * `eventToActivityRow` is pure, so a row never changes once created — a
 * streamed thought being the exception, which `appendActivityRow` folds into
 * the row it continues instead of appending a new one per token.
 *
 * The run only grows at its tail, so a running absolute index into the event
 * stream is enough to resume the scan. A different run, or a toggled setting,
 * starts a fresh cache; so does the window sliding past the run's start.
 */
interface RowCache {
  runId: string;
  displayInActivity: boolean;
  /** Absolute index of the first source event not yet scanned. */
  scanned: number;
  rows: ActivityRow[];
}

/**
 * One row cache per module, for the same reason as the history cache: the store
 * hands out a new array wrapper on every change, so identity says nothing. The
 * scan position and the run/setting it was built for are the real key.
 */
let rowCache: RowCache | undefined;

/** The rows currently shown for `run`, converting only the events not seen yet. */
export function memoRunRows(
  events: AbsenceEvent[],
  run: HistoryRun,
  displayInActivity: boolean,
): ActivityRow[] {
  const base = eventsBase(events);
  const from = Math.max(0, run.fromIndex);
  const to = Math.min(events.length - 1, run.toIndex);
  if (to < from) return [];

  let entry = rowCache;
  if (
    !entry ||
    entry.runId !== run.id ||
    entry.displayInActivity !== displayInActivity ||
    entry.scanned > base + to + 1 ||
    entry.scanned < base + from
  ) {
    entry = { runId: run.id, displayInActivity, scanned: base + from, rows: [] };
    rowCache = entry;
  }

  for (let absolute = entry.scanned; absolute <= base + to; absolute++) {
    const event = events[absolute - base];
    if (!event) break;
    const row = eventToActivityRow(event);
    // The Setting can hide the LAID/DIED process rows (Agent Eggs) so the panel
    // reads as actions only; the eggs stay in the Agent Eggs panel. Consecutive
    // THINK rows fold into one (see appendActivityRow).
    if (row && (displayInActivity || row.tone !== "process")) appendActivityRow(entry.rows, row);
  }
  entry.scanned = base + to + 1;
  return entry.rows;
}
