/**
 * Cross-session aggregate statistics — the wire contract for `GET /api/stats`.
 *
 * This module lives in core so the server that computes the numbers and the
 * web client that renders them compile against one definition (same reason
 * `ws.ts` exists). The reporting philosophy follows the same rule the rest of
 * Absence keeps: absence of data is never rendered as a confident zero. Counts
 * may honestly be 0; derived values (error rate, percentiles, tokens, cost)
 * are `null` when the window has no samples to derive them from.
 */

export interface StatsQuery {
  /** Window start (epoch ms). Defaults to 7 days ago on the server. */
  from?: number;
  /** Window end (epoch ms). Defaults to now on the server. */
  to?: number;
  /** Filter by exact project path. */
  project?: string;
  /** Filter by agent runtime id. */
  runtime?: string;
}

export interface StatsTotals {
  sessions: number;
  runs: number;
  events: number;
  /** Runs that ended with status `error`. */
  errorRuns: number;
  /** `error` events in the window (a run may carry several). */
  errorEvents: number;
  /**
   * Share of runs that ended in error, 0..1. `null` when the window holds no
   * ended run — "no data", not "0% errors".
   */
  errorRate: number | null;
  /** Summed wall-clock time of ended runs, ms. */
  runWallMs: number | null;
  /**
   * Estimated token sums over `usage` events. `null` when the window has no
   * usage data at all (older archives, runtimes that report nothing).
   */
  tokens: { input: number | null; output: number | null };
  /**
   * Cost derived at query time from the pricing table. `null` when no price
   * matched or there is no token data — never a made-up 0.
   */
  cost: number | null;
}

/** One time bucket of the trend series. Bucket counts are honest zeros. */
export interface StatsBucket {
  /** Bucket start, epoch ms. */
  ts: number;
  runs: number;
  errorRuns: number;
  events: number;
  /** Estimated output tokens of the runs closing in this bucket; null = no usage data. */
  outputTokens: number | null;
}

export interface ToolStats {
  toolName: string;
  /** Calls started (`tool_start`) — failures are calls too, so they are not lost. */
  calls: number;
  /** Calls whose `tool_end` reported `isError`. */
  errors: number;
  /** Paired start→end latency; `null` below 1 paired sample. */
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface ErrorTopEntry {
  /** The error message, truncated; the grouping key. */
  message: string;
  count: number;
  /** Last occurrence, epoch ms. */
  lastTs: number;
}

export interface ModelTokenStats {
  model: string;
  runs: number;
  input: number;
  output: number;
  /** Derived cost for this model, `null` when no pricing rule matched. */
  cost: number | null;
}

export interface ProjectStats {
  projectName: string;
  projectPath: string;
  sessions: number;
  runs: number;
  errorRuns: number;
  events: number;
}

export interface StatsReport {
  from: number;
  to: number;
  /** The trend series' bucket width, ms. */
  stepMs: number;
  totals: StatsTotals;
  series: StatsBucket[];
  tools: ToolStats[];
  topErrors: ErrorTopEntry[];
  models: ModelTokenStats[];
  projects: ProjectStats[];
}

/**
 * One row of the price table (`~/.absence/pricing.json`): USD per million
 * tokens for a model glob. Cost is computed at query time only — tokens are
 * the telemetry fact, cost is a derived figure and is never stored.
 */
export interface PricingRule {
  /** Glob matched against the model name, case-insensitive (`claude-*`). */
  model: string;
  inputPer1M: number;
  outputPer1M: number;
}
