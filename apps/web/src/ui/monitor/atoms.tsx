import type { ReactNode } from "react";
import type { Attention, AttentionReason, PhaseType } from "../../types/report";
import type { ActivityRow } from "../../types/stage";
import { useT } from "../../lib/i18n";

/* ══════════════════════════════════════════════════════════════════════════
   The Monitor's shared vocabulary: a tone per kind, the phase words, the
   attention verdict, and the two or three atoms every column reuses.

   Tones are class suffixes (`mon-chip--read`), not raw colours, so the palette
   stays in monitor.css and a theme change has one place to land.
   ══════════════════════════════════════════════════════════════════════════ */

export type MonTone = "think" | "read" | "search" | "edit" | "run" | "egg" | "err" | "mute";

/** Activity row tone → Monitor tone. */
export const TONE_FOR_ROW: Record<ActivityRow["tone"], MonTone> = {
  think: "think",
  read: "read",
  search: "search",
  edit: "edit",
  run: "run",
  lifecycle: "mute",
  process: "egg",
  approval: "run",
  error: "err",
  warn: "err",
};

/** …and the same mapping for the report's timeline kinds and phases. */
export const TONE_FOR_KIND: Record<string, MonTone> = {
  start: "mute",
  think: "think",
  read: "read",
  search: "search",
  edit: "edit",
  write: "edit",
  run: "run",
  process: "egg",
  observe: "mute",
  error: "err",
  end: "mute",
};

/**
 * Monitor's phases: three, not the report's five.
 *
 * A phase answers "what is the agent doing to the project", and there are only
 * three answers worth a divider in a feed:
 *
 *   investigating — reading files
 *   executing     — running commands
 *   implementing  — changing files
 *
 * The report engine also emits `verifying` (a command succeeded after a
 * failure) and `recovering` (a command failed). Both are *command* activity, so
 * they read as `executing` here: a feed that relabelled the same act three
 * times would put three dividers between two shell commands, and a red
 * RECOVERING band made a normal retry look like an incident. The report keeps
 * the finer phases; the feed keeps the honest coarse one.
 */
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

/** Status dot colour: what the avatar is doing, in one hue. */
export function toneForStatus(status: string): MonTone {
  switch (status) {
    case "error":
      return "err";
    case "thinking":
      return "think";
    case "reading":
    case "searching":
      return "read";
    case "editing":
      return "edit";
    case "running":
      return "run";
    case "waiting":
      return "egg";
    default:
      return "mute";
  }
}

export function Chip({
  tone = "mute",
  className,
  title,
  children,
}: {
  tone?: MonTone;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`mon-chip mon-chip--${tone}${className ? ` ${className}` : ""}`} title={title}>
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: MonTone }) {
  return <span className={`mon-dot mon-chip--${tone}`} style={{ background: "currentColor" }} aria-hidden />;
}

/** A tiny SVG sparkline — no dependency, no axes. */
export function Spark({
  values,
  height = 22,
  tone = "read",
}: {
  values: number[];
  height?: number;
  tone?: MonTone;
}) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length < 2) return <div style={{ height }} aria-hidden />;
  let min = Math.min(...clean);
  let max = Math.max(...clean);
  if (max - min < 1e-9) {
    max += 1;
    min = Math.max(0, min - 1);
  }
  const width = 120;
  const stepX = width / Math.max(1, clean.length - 1);
  const points = clean
    .map((value, index) => `${(index * stepX).toFixed(1)},${(height - 2 - ((value - min) / (max - min)) * (height - 4)).toFixed(1)}`)
    .join(" L");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block", width: "100%", height }}
      aria-hidden
    >
      <path d={`M${points}`} fill="none" stroke="currentColor" strokeWidth={1.5} className={`mon-chip--${tone}`} />
    </svg>
  );
}

/* ── Words ──────────────────────────────────────────────────────────────── */

const PHASE_WORD: Record<MonPhase, string> = {
  investigating: "Investigating",
  executing: "Executing",
  implementing: "Implementing",
};

/**
 * What the phase means, in the feed's own words: the divider has to say what
 * kind of work opened it, not leave the reader to infer it from the rows below.
 */
const PHASE_INTENT: Record<MonPhase, string> = {
  investigating: "reading files",
  executing: "running commands",
  implementing: "editing files",
};

export function phaseWord(phase: MonPhase | undefined): string {
  return phase ? PHASE_WORD[phase] : "Idle";
}

export function phaseIntent(phase: MonPhase): string {
  return PHASE_INTENT[phase];
}

const REASON_TEXT: Record<AttentionReason, string> = {
  command_failed: "A command failed",
  command_failure_streak: "Commands failed back-to-back — the agent may be flailing",
  activity_stalled: "No activity for a long time — something may be stuck",
  unresolved_error: "Unresolved error — no successful recovery detected",
  agent_waiting: "Agent is waiting",
  agent_stopped: "Agent stopped",
  no_progress: "No progress detected",
  external_change: "External file change observed",
  process_left_running: "A process the agent started is still running",
  outside_change: "A file outside the project was changed",
  file_version_loop: "File versions oscillated — the agent may have undone its own edit",
  command_retry_loop: "The same command failed repeatedly",
};

/** The human sentence for one attention reason (translated via the i18n table). */
export function useReasonText(): (reason: AttentionReason) => string {
  const t = useT();
  return (reason) => t(REASON_TEXT[reason]);
}

export function attentionTone(level: Attention["level"]): MonTone {
  return level === "high" ? "err" : level === "medium" ? "run" : level === "low" ? "read" : "mute";
}
