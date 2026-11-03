import {
  applyRunCount,
  emptyRunCounts,
  type AbsenceEvent,
  type RunCounts,
} from "@absence/core";
import type { ActivityRow, StageItem } from "../types/stage";
import { appendActivityRow, eventToActivityRow } from "./events";
import type { HistoryRun } from "../types/history";
import type { PhaseType } from "../types/report";

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

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "message" && event.payload.role === "user") {
      if (start) flush(i - 1, undefined, "interrupted");
      start = {
        from: i,
        prompt: event.payload.content,
        startedAt: event.timestamp,
        counts: emptyRunCounts(),
        touched: new Set(),
      };
    } else if (event.type === "agent_end" && start) {
      const reason = String(event.payload.reason);
      flush(i, event.timestamp, reason === "aborted" ? "interrupted" : reason === "error" ? "error" : "completed");
    } else if (start) {
      applyRunCount(start.counts, event, start.touched);
    }
  }

  if (start) flush(events.length - 1, undefined, "running");
  return runs;
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
  if (event.type === "message" && event.payload.role === "user") {
    closeOpen(entry, undefined, "interrupted", absoluteIndex - 1);
    entry.open = {
      prompt: event.payload.content,
      startedAt: event.timestamp,
      fromIndex: absoluteIndex,
      counts: emptyRunCounts(),
      touched: new Set(),
    };
    return;
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
  applyRunCount(entry.open.counts, event, entry.open.touched);
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

/**
 * Bumped whenever `memoRunRows` changes the rows — a new row appended, or a
 * streamed thought folded into the row it continues.
 *
 * The rows array keeps one identity for the whole run — that is what makes the
 * conversion incremental — so a consumer that memoises on the array sees no
 * change when a token arrives, and its derivation freezes. Array length was the
 * old version, but it misses the fold: the length does not move while the
 * row's text does. This counter covers both, and any derivation over the rows
 * must depend on it. It is deliberately never reset: monotonicity is the only
 * property a dependency needs.
 */
let rowMutations = 0;

/** The current row-mutation version; see `rowMutations`. */
export function activityRowsVersion(): number {
  return rowMutations;
}

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
    if (row && (displayInActivity || row.tone !== "process")) {
      appendActivityRow(entry.rows, row);
      rowMutations += 1;
    }
  }
  entry.scanned = base + to + 1;
  return entry.rows;
}

/**
 * Drop the incremental history/row caches.
 *
 * Needed when the event window is not a continuation of the previous one:
 * a different session (same length/base can otherwise reuse stale runs), or an
 * older page prepended to the head (the caches fold a tail, not a head).
 */
export function resetEventCaches(): void {
  cache = undefined;
  rowCache = undefined;
}

/**
 * The row the replay cursor is on: the last row at or before `timestamp`.
 *
 * The replay highlight's rule, and the reason the feed's highlight walks
 * down the run while a replay plays. Rows are chronological, so a binary
 * search keeps it cheap on the 80ms replay tick — both faces (Monitor's feed
 * and Rounds' story) used to implement this scan themselves.
 *
 * Callers deriving this per render must also depend on `activityRowsVersion()`:
 * the rows array keeps one identity, so the version is what says "re-derive".
 */
export function replayRowAt(rows: ActivityRow[], timestamp: number): ActivityRow | undefined {
  let low = 0;
  let high = rows.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (rows[mid]!.event.timestamp <= timestamp) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found >= 0 ? rows[found] : undefined;
}

/* ── The activity pulse ────────────────────────────────────────────────────
   Events are discrete arrivals, but the reader reads them as an intensity —
   "how hard is it working right now". The pulse is that intensity: each event
   kicks the line and the kick decays, so a burst reads as a spike that settles
   back to the running rate instead of a step that only moves when a bucket
   boundary crosses. Pure math over timestamps; the face only samples it. */

/** A kick loses ~63% of its height every TAU ms (exp(-1)). */
const PULSE_TAU = 6_000;

/** The pulse's shape: one sample every SAMPLE ms over the last WINDOW ms. */
const PULSE_SAMPLE = 2_000;
const PULSE_WINDOW = 120_000;

/**
 * Events per minute, read through the decay.
 *
 * For each sample time `t`, every event within the window contributes
 * `exp(-(t - t_i) / TAU)`; the sum is scaled by `60_000 / TAU`, which makes a
 * *steady* stream read as its true rate (one event every TAU reads as
 * `e/(e-1)` ≈ its own per-minute rate). A historical run therefore shows the
 * shape it actually had, and a live run's newest event is a spike that decays
 * into the rate — the "the feed just got hit" feel, from real events only.
 *
 * `timestamps` must be ascending (ActivityRows are). The last sample is at
 * `now`, so a live caller re-derives as the clock moves; a finished run's
 * samples past its last event just decay towards zero.
 */
export function activityPulse(timestamps: number[], now: number): number[] {
  const samples = Math.floor(PULSE_WINDOW / PULSE_SAMPLE);
  const values: number[] = new Array(samples);
  // Events older than ~5 tau contribute under 0.7% each — skip the scan past
  // them by starting at the first event inside the effective window.
  const cutoff = now - PULSE_WINDOW - PULSE_TAU * 5;
  let start = 0;
  while (start < timestamps.length && timestamps[start]! < cutoff) start++;
  const scale = 60_000 / PULSE_TAU;
  for (let i = 0; i < samples; i++) {
    const t = now - (samples - 1 - i) * PULSE_SAMPLE;
    let sum = 0;
    for (let j = start; j < timestamps.length; j++) {
      const age = t - timestamps[j]!;
      if (age < 0) break;
      if (age > PULSE_WINDOW) continue;
      sum += Math.exp(-age / PULSE_TAU);
    }
    values[i] = sum * scale;
  }
  return values;
}

/**
 * LIVE or REPLAY — what a face is doing with the run, in Monitor's words: a
 * walking replay and a pinned moment are the same answer to the reader ("the
 * clock has stopped here"), so both read REPLAY.
 */
export function playingState(
  following: boolean,
  item: StageItem | undefined,
  inReplay: boolean,
): "live" | "replay" {
  return inReplay || (!following && item !== undefined) ? "replay" : "live";
}

/* ── The feed's reading view ──────────────────────────────────────────────
   Phase grouping, repeat folding and the anchored boundaries. This is a
   *derivation over the rows*, not rendering, so it lives here beside
   `memoRunRows` — the component that draws the feed only lays the groups out. */

/** Monitor's coarse phase: what kind of work a run is doing (see atoms). */
export type MonPhase = "investigating" | "executing" | "implementing";

const PHASE_FOLD: Record<PhaseType, MonPhase> = {
  investigating: "investigating",
  executing: "executing",
  implementing: "implementing",
  verifying: "executing",
  recovering: "executing",
};

export function monPhase(phase: PhaseType): MonPhase {
  return PHASE_FOLD[phase];
}

/**
 * The phase a *row* belongs to, read off the row's own kind.
 *
 * The report's phase signals are anchored on `command` events, which arrive
 * when a command finishes — so a RUN row (a `tool_start`) landed under the
 * phase the *previous* command had opened, and a shell row could appear under
 * "reading files". A feed knows what each row is, so the divider is derived
 * from the rows themselves and cannot disagree with them.
 *
 * Reasoning, lifecycle, approvals and errors do not change the kind of work, so
 * they inherit the current phase instead of opening one.
 */
export function phaseForRow(row: ActivityRow): MonPhase | undefined {
  switch (row.tone) {
    case "read":
    case "search":
      return "investigating";
    case "edit":
      return "implementing";
    case "run":
    case "process":
      return "executing";
    default:
      return undefined;
  }
}

/** One feed entry: the newest row that acted, and how many reports folded in. */
export interface FeedRow {
  row: ActivityRow;
  count: number;
}

/** A run of consecutive rows under one phase (or under no phase at all). */
export interface FeedGroup {
  id: string;
  phase?: MonPhase;
  rows: FeedRow[];
}

/**
 * The feed's groups: consecutive rows under a phase divider, with state
 * re-reports folded into the row they re-report.
 *
 * The kind comes from the row itself (`phaseForRow`), so a divider only
 * appears where the kind of work actually changes — and a shell row can never
 * be filed under "reading files".
 *
 * The fold only collapses *state re-reports of one thing*: the same action,
 * the same subject, the same stage card. Required because a `process` event is
 * an update (the child count moves), not a new act. The Stage item id is part
 * of the key so two different `npm test` runs are never merged, and RUN vs
 * EXIT stay separate — they are the same command's two ends, and collapsing
 * them would lose the fact that it finished.
 */
export function groupFeedRows(rows: ActivityRow[]): FeedGroup[] {
  const out: FeedGroup[] = [];
  for (const row of rows) {
    const phase = phaseForRow(row);
    let group = out[out.length - 1];
    if (phase && group?.phase !== phase) {
      group = { id: `p_${row.id}`, phase, rows: [] };
      out.push(group);
    } else if (!group) {
      group = { id: `h_${row.id}`, rows: [] };
      out.push(group);
    }
    const previous = group.rows[group.rows.length - 1];
    if (
      previous &&
      previous.row.action === row.action &&
      previous.row.primary === row.primary &&
      previous.row.stageItem?.id === row.stageItem?.id
    ) {
      previous.row = row;
      previous.count += 1;
      continue;
    }
    group.rows.push({ row, count: 1 });
  }
  return out;
}

/**
 * Lift the run's two boundaries out of the stream.
 *
 * START and END are the only rows that answer "where does this run start and
 * end", and scrolling a long feed used to lose both. They are pinned outside
 * the scroll container, so the body must not repeat them.
 */
export function feedAnchors(rows: ActivityRow[]): { start?: ActivityRow; end?: ActivityRow } {
  return {
    start: rows.find((row) => row.action === "START"),
    end: [...rows].reverse().find((row) => row.action === "END"),
  };
}

/** The groups a scrolling feed shows: every anchor row removed. */
export function stripFeedAnchors(groups: FeedGroup[]): FeedGroup[] {
  return groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter(({ row }) => row.action !== "START" && row.action !== "END"),
    }))
    .filter((group) => group.rows.length > 0);
}
