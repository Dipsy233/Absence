import { useEffect, useRef, useState } from "react";
import { reasonLevel } from "../lib/report";
import { useAttentionOptions } from "./useAttentionOptions";
import type { ActivityRow } from "../types/stage";
import type {
  Attention,
  AttentionLevel,
  AttentionReason,
  ReportAttentionOptions,
  RunFacts,
} from "../types/report";

/**
 * Attention notices — the run asking for a human, one card per *new* reason.
 *
 * The engine re-states its verdict twice a second, so "a notice" cannot be
 * "the current attention": that would re-open the same card forever and make
 * dismissing it meaningless. A notice is a reason the run had not raised yet,
 * per run: the first verdict of a run is seeded silently (a run you just opened
 * is not news), every reason after that becomes a notice exactly once.
 *
 * The notice carries the newest event of the run as its body, because "a
 * command failed" without the command is a headline with no story — and the
 * event id is where a click lands.
 */
export interface AttentionNotice {
  id: string;
  reason: AttentionReason;
  /** `low` / `medium` / `high` — the card's colour. A silenced reason is no notice. */
  level: Exclude<AttentionLevel, "none">;
  /** Absolute time the notice points at (the newest event's timestamp). */
  at: number;
  /** The event a click opens; absent when the run has no rows yet. */
  eventId?: string;
  /** The event's own line, in the feed's words. */
  detail?: string;
}

export interface AttentionNotices {
  /** Newest first. */
  notices: AttentionNotice[];
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

/** A stack, not an inbox: the older cards stop being useful long before ten. */
const MAX_NOTICES = 6;

export function useAttentionNotices(
  runId: string | undefined,
  attention: Attention,
  rows: ActivityRow[],
): AttentionNotices {
  const options = useAttentionOptions();
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const [notices, setNotices] = useState<AttentionNotice[]>([]);
  const seen = useRef<{
    runId?: string;
    reasons: Set<AttentionReason>;
    seq: number;
    booted: boolean;
  }>({ runId, reasons: new Set(), seq: 0, booted: false });

  const reasonsKey = attention.reasons.join(",");

  useEffect(() => {
    const state = seen.current;
    if (!state.booted || state.runId !== runId) {
      // First verdict, or a different run: seed silently. Whatever this run
      // already carries was true before the reader looked at it.
      state.booted = true;
      state.runId = runId;
      state.reasons = new Set(attention.reasons);
      setNotices([]);
      return;
    }

    const fresh = attention.reasons.filter((reason) => !state.reasons.has(reason));
    for (const reason of attention.reasons) state.reasons.add(reason);
    if (fresh.length === 0) return;

    const row = rowsRef.current[rowsRef.current.length - 1];
    const made: AttentionNotice[] = [];
    for (const reason of fresh) {
      const level = reasonLevel(reason, options);
      // A reason the reader tuned to "none" still counts as seen, but must
      // never raise a card — that is what the setting means.
      if (level === "none") continue;
      made.push({
        id: `notice-${++state.seq}`,
        reason,
        level,
        at: row?.event.timestamp ?? Date.now(),
        eventId: row?.id,
        detail: row?.primary,
      });
    }
    if (made.length === 0) return;
    setNotices((prev) => [...made.reverse(), ...prev].slice(0, MAX_NOTICES));
  }, [runId, reasonsKey, options]);

  return {
    notices,
    dismiss: (id) => setNotices((prev) => prev.filter((notice) => notice.id !== id)),
    dismissAll: () => setNotices([]),
  };
}

/**
 * The events behind one reason, from the persisted run facts. The engine keeps
 * one evidence list for the whole verdict, so a per-reason anchor has to come
 * from the facts themselves — otherwise every row in Monitor's Attention tab
 * would point at the newest event of the run.
 */
function reasonEvidence(reason: AttentionReason, facts: RunFacts): string[] {
  switch (reason) {
    case "command_failed":
      return facts.commandFacts
        .filter((fact) => fact.status === "failed")
        .flatMap((fact) => (fact.evidence.length > 0 ? fact.evidence : [fact.eventId]));
    case "command_failure_streak":
      return facts.failureStreak.evidence;
    case "command_retry_loop":
      return facts.loops.filter((loop) => loop.kind === "command_retry_loop").flatMap((loop) => loop.evidence);
    case "file_version_loop":
      return facts.loops.filter((loop) => loop.kind === "file_version_loop").flatMap((loop) => loop.evidence);
    case "process_left_running":
      return Object.values(facts.processes.byPid)
        .filter((fact) => fact.running)
        .flatMap((fact) => fact.evidence);
    case "outside_change":
      return facts.outsideChanges.flatMap((fact) => fact.evidence);
    case "external_change":
      return Object.values(facts.files.byPath)
        .filter((fact) => fact.externalChange)
        .flatMap((fact) => fact.evidence);
    default:
      // `activity_stalled` / `agent_waiting` / `no_progress`
      // have no event of their own: they are about the run as a whole.
      return [];
  }
}

/**
 * The run's attention, read the way Activity is read: out of the persisted
 * run, not out of whatever arrived while this page was open. Switch to a
 * historical run and its Attention panel still lists what it needed a human
 * for, each row anchored on the event that raised it.
 *
 * The live verdict is also persisted in the same sense — it is derived from
 * the run's own events — so a running run fills this list as it goes, while
 * the *popup* cards stay reserved for reasons that are actually new
 * (`useAttentionNotices`).
 */
export function attentionRecords(
  attention: Attention,
  facts: RunFacts | undefined,
  rows: ActivityRow[],
  options: ReportAttentionOptions,
): AttentionNotice[] {
  const byId = new Map<string, ActivityRow>();
  for (const row of rows) byId.set(row.id, row);

  const records: AttentionNotice[] = [];
  for (const reason of attention.reasons) {
    const level = reasonLevel(reason, options);
    if (level === "none") continue;

    const evidence = facts ? reasonEvidence(reason, facts) : [];
    let row: ActivityRow | undefined;
    for (let i = evidence.length - 1; i >= 0 && !row; i--) row = byId.get(evidence[i]!);
    for (let i = attention.evidence.length - 1; i >= 0 && !row; i--) row = byId.get(attention.evidence[i]!);
    if (!row) row = rows[rows.length - 1];

    records.push({
      id: `record-${reason}`,
      reason,
      level,
      at: row?.event.timestamp ?? facts?.lastActivityAt ?? Date.now(),
      eventId: row?.id,
      detail: row?.primary,
    });
  }

  // Newest first, like the popup stack: the newest thing that needs a human is
  // the first thing a reader should see.
  return records.sort((a, b) => b.at - a.at);
}
