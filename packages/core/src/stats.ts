/**
 * The run-scope totals row — the shape behind the Chart report's four
 * cumulative cards (run count, events, errors, tokens), computed web-side from
 * the selected run's window or the session-wide merged slice.
 *
 * The reporting philosophy follows the same rule the rest of Absence keeps:
 * absence of data is never rendered as a confident zero. Counts may honestly
 * be 0; derived values (error rate, wall time, tokens) are `null` when the
 * scope has no samples to derive them from.
 */

export interface StatsTotals {
  /** Sessions the scope spans (1 for the Chart report's run scopes). */
  sessions: number;
  runs: number;
  events: number;
  /** Runs that ended with status `error`. */
  errorRuns: number;
  /** `error` events in the scope (a run may carry several). */
  errorEvents: number;
  /**
   * Share of runs that ended in error, 0..1. `null` when the scope holds no
   * runs — "no data", not "0% errors".
   */
  errorRate: number | null;
  /** Summed wall-clock time of ended runs, ms. */
  runWallMs: number | null;
  /**
   * Estimated token sums over `usage` events. `null` when the scope has no
   * usage data at all (older archives, runtimes that report nothing).
   */
  tokens: { input: number | null; output: number | null };
}
