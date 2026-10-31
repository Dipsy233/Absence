import type { ReactNode } from "react";
import type { RunSummary } from "@absence/core";
import type { Attention, AttentionReason } from "../../types/report";
import type { ActivityRow } from "../../types/stage";
import { useT } from "../../lib/i18n";
import { ATTENTION_REASON_TEXT } from "../../lib/attention";

/* ══════════════════════════════════════════════════════════════════════════
   The faces' shared vocabulary: a tone per kind, the phase words, the
   attention verdict, and the two or three atoms every face reuses.

   Tones are class suffixes (`mon-chip--read`), not raw colours, so the palette
   stays in shared.css and a theme change has one place to land. This module
   sits above the individual faces (monitor, rounds, chart, drip) — it must
   never import from one, or the faces couple through their own primitives.
   ══════════════════════════════════════════════════════════════════════════ */

export type MonTone = "think" | "read" | "search" | "edit" | "run" | "egg" | "err" | "mute";

/** Activity row tone → Monitor tone. */
export const TONE_FOR_ROW: Record<ActivityRow["tone"], MonTone> = {
  think: "think",
  say: "think",
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
 * The feed's coarse phase and its per-row derivation are data logic — they
 * live in lib/history beside the row builders; the words below are what a
 * face prints for them.
 */
export type { MonPhase } from "../../lib/history";
export { monPhase, phaseForRow } from "../../lib/history";
import type { MonPhase } from "../../lib/history";

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

/** The human sentence for one attention reason (translated via the i18n table). */
export function useReasonText(): (reason: AttentionReason) => string {
  const t = useT();
  return (reason) => t(ATTENTION_REASON_TEXT[reason]);
}

export function attentionTone(level: Attention["level"]): MonTone {
  return level === "high" ? "err" : level === "medium" ? "run" : level === "low" ? "read" : "mute";
}

/* ── Run status ─────────────────────────────────────────────────────────── */

/** A run's dot, in the shared tones. */
export const RUN_TONE: Record<RunSummary["status"], MonTone> = {
  running: "run",
  completed: "edit",
  interrupted: "mute",
  error: "err",
};

/** How a run's status is spoken, matching Monitor's run list. */
export const RUN_WORD: Record<RunSummary["status"], string> = {
  running: "running",
  completed: "done",
  interrupted: "stopped",
  error: "error",
};
