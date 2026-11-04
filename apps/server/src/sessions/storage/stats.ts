/**
 * Cross-session aggregate statistics (read-only).
 *
 * Everything here is a reduction over the same tables the archive already
 * keeps — sessions, events, runs — plus the per-run `usage` events the
 * adapters emit. No schema of its own, no write path: a stats query is just a
 * moment's read over the archive.
 *
 * The reporting contract follows one rule borrowed from telemetry practice:
 * absence of data is never rendered as a confident zero. Counts may honestly
 * be 0; anything derived (error rate, latency percentiles, token sums, cost)
 * comes back `null` when the window has no samples to derive it from, and the
 * UI says "no data" instead of showing a fake number.
 *
 * Latency pairing and payload extraction happen in JS: the payloads live in a
 * JSON column, and the volumes a monitoring window holds (thousands, not
 * millions) make a streaming JS reduction simpler and just as fast as JSON1
 * expression gymnastics in SQL.
 */

import type {
  ErrorTopEntry,
  ModelTokenStats,
  PricingRule,
  ProjectStats,
  StatsBucket,
  StatsReport,
  StatsTotals,
  ToolStats,
} from "@absence/core";
import { drainArchive, openDatabase } from "./db";
import { readPricingConfig } from "./pricing";
import { toPosix } from "../../util/paths";
import path from "node:path";

/** How many tool events one stats query will read before giving up on pairing. */
const TOOL_EVENT_LIMIT = 200_000;
/** How many error payloads one stats query will read before grouping. */
const ERROR_EVENT_LIMIT = 20_000;
/** Top-N size for the error and tool lists. */
const TOP_N = 8;

interface SqlRow {
  [column: string]: string | number | bigint | Uint8Array | null;
}

/** The stats query with its defaults applied. */
export interface StatsWindow {
  from: number;
  to: number;
  project?: string;
  runtime?: string;
}

export async function readStats(window: StatsWindow): Promise<StatsReport> {
  // The archive batches writes in a 50ms buffer; drain it so "just finished a
  // run and opened the tab" is not missing the run it was about.
  await drainArchive();
  const db = openDatabase();
  const { from, to } = window;
  const stepMs = bucketStep(to - from);

  // Session scoping: every event/run/table is keyed by session_id, so the
  // project/runtime filters compile once into a session-id subquery and every
  // count reuses it.
  const sessionFilters: string[] = [];
  const sessionParams: (string | number)[] = [];
  if (window.project?.trim()) {
    // Stored paths are POSIX absolute (see SessionStore.create); normalise a
    // Windows caller's backslashes the same way `queryArchives` does.
    sessionFilters.push("project_path = ? COLLATE NOCASE");
    sessionParams.push(toPosix(path.resolve(window.project.trim())));
  }
  if (window.runtime?.trim()) {
    sessionFilters.push("runtime = ?");
    sessionParams.push(window.runtime.trim());
  }
  const sessionWhere =
    sessionFilters.length > 0 ? ` WHERE ${sessionFilters.join(" AND ")}` : "";
  const scopedSessionIds =
    `SELECT id FROM sessions${sessionWhere}` as string;

  const eventsInScope = `session_id IN (${scopedSessionIds})`;
  const runsInScope = `session_id IN (${scopedSessionIds})`;

  // --- sessions -------------------------------------------------------------
  // A session belongs to the window when it was active in it (same column the
  // history list sorts by); otherwise "2 sessions" would be true for every
  // window ever queried.
  let sessions = 0;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions
         WHERE updated_at >= ? AND updated_at <= ?${sessionWhere ? ` AND ${sessionFilters.join(" AND ")}` : ""}`,
      )
      .get(from, to, ...sessionParams) as SqlRow | undefined;
    sessions = Number(row?.n ?? 0);
  } catch (error) {
    console.error("[absence] stats session count failed:", error);
  }

  // --- runs -----------------------------------------------------------------
  let runs = 0;
  let errorRuns = 0;
  let runWallMs: number | null = null;
  const runBuckets = new Map<number, { runs: number; errorRuns: number }>();
  try {
    const rows = db
      .prepare(
        `SELECT started_at, ended_at, status FROM runs
         WHERE ${runsInScope} AND started_at >= ? AND started_at <= ?`,
      )
      .all(...sessionParams, from, to) as SqlRow[];
    let wall = 0;
    let ended = 0;
    for (const row of rows) {
      runs += 1;
      const isError = String(row.status) === "error";
      if (isError) errorRuns += 1;
      const startedAt = Number(row.started_at);
      const bucket = Math.floor(startedAt / stepMs) * stepMs;
      const entry = runBuckets.get(bucket) ?? { runs: 0, errorRuns: 0 };
      entry.runs += 1;
      if (isError) entry.errorRuns += 1;
      runBuckets.set(bucket, entry);
      if (row.ended_at !== null) {
        wall += Math.max(0, Number(row.ended_at) - startedAt);
        ended += 1;
      }
    }
    if (ended > 0) runWallMs = wall;
  } catch (error) {
    console.error("[absence] stats run query failed:", error);
  }

  // --- events + trend series -------------------------------------------------
  let events = 0;
  let errorEvents = 0;
  const eventBuckets = new Map<number, number>();
  try {
    const rows = db
      .prepare(
        `SELECT ts, type FROM events
         WHERE ${eventsInScope} AND ts >= ? AND ts <= ?`,
      )
      .all(...sessionParams, from, to) as SqlRow[];
    for (const row of rows) {
      events += 1;
      if (String(row.type) === "error") errorEvents += 1;
      const bucket = Math.floor(Number(row.ts) / stepMs) * stepMs;
      eventBuckets.set(bucket, (eventBuckets.get(bucket) ?? 0) + 1);
    }
  } catch (error) {
    console.error("[absence] stats event query failed:", error);
  }

  // --- usage events (token estimates) ----------------------------------------
  let inputTotal: number | null = null;
  let outputTotal: number | null = null;
  const usageBuckets = new Map<number, number>();
  const modelTokens = new Map<
    string,
    { runs: number; input: number; output: number; sawInput: boolean }
  >();
  try {
    const rows = db
      .prepare(
        `SELECT ts, payload FROM events
         WHERE ${eventsInScope} AND type = 'usage' AND ts >= ? AND ts <= ?`,
      )
      .all(...sessionParams, from, to) as SqlRow[];
    for (const row of rows) {
      const ts = Number(row.ts);
      const bucket = Math.floor(ts / stepMs) * stepMs;
      let payload: {
        model?: string;
        outputEst?: number;
        inputEst?: number | null;
      };
      try {
        payload = JSON.parse(String(row.payload)) as typeof payload;
      } catch {
        continue;
      }
      const output = Number.isFinite(payload.outputEst) ? Number(payload.outputEst) : 0;
      const input = payload.inputEst;
      outputTotal = (outputTotal ?? 0) + output;
      usageBuckets.set(bucket, (usageBuckets.get(bucket) ?? 0) + output);
      if (typeof input === "number" && Number.isFinite(input)) {
        inputTotal = (inputTotal ?? 0) + input;
      }
      const model = payload.model?.trim() || "unknown";
      const entry = modelTokens.get(model) ?? { runs: 0, input: 0, output: 0, sawInput: false };
      entry.runs += 1;
      entry.output += output;
      if (typeof input === "number" && Number.isFinite(input)) {
        entry.input += input;
        entry.sawInput = true;
      }
      modelTokens.set(model, entry);
    }
  } catch (error) {
    console.error("[absence] stats usage query failed:", error);
  }

  // --- tool latency + calls ---------------------------------------------------
  const toolStats = await toolLatencyStats(window);

  // --- error top-N ------------------------------------------------------------
  const topErrors: ErrorTopEntry[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT ts, payload FROM events
         WHERE ${eventsInScope} AND type = 'error' AND ts >= ? AND ts <= ?
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(...sessionParams, from, to, ERROR_EVENT_LIMIT) as SqlRow[];
    const grouped = new Map<string, ErrorTopEntry>();
    for (const row of rows) {
      let message = "";
      try {
        message = String((JSON.parse(String(row.payload)) as { message?: unknown }).message ?? "");
      } catch {
        continue;
      }
      if (!message.trim()) continue;
      const key = message.length > 160 ? message.slice(0, 160) : message;
      const entry = grouped.get(key);
      if (entry) {
        entry.count += 1;
        entry.lastTs = Math.max(entry.lastTs, Number(row.ts));
      } else {
        grouped.set(key, { message: key, count: 1, lastTs: Number(row.ts) });
      }
    }
    topErrors.push(...[...grouped.values()].sort((a, b) => b.count - a.count).slice(0, TOP_N));
  } catch (error) {
    console.error("[absence] stats error-top query failed:", error);
  }

  // --- per-project breakdown ---------------------------------------------------
  const projects: ProjectStats[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT s.project_name AS project_name, s.project_path AS project_path,
                COUNT(r.run_index) AS runs,
                SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) AS error_runs
         FROM runs r JOIN sessions s ON s.id = r.session_id
         WHERE r.started_at >= ? AND r.started_at <= ?${sessionWhere ? ` AND ${sessionFilters.map((f) => `s.${f}`).join(" AND ")}` : ""}
         GROUP BY s.project_path, s.project_name
         ORDER BY runs DESC`,
      )
      .all(...sessionParams, from, to) as SqlRow[];
    const byPath = new Map<string, ProjectStats>();
    for (const row of rows) {
      const stat: ProjectStats = {
        projectName: String(row.project_name),
        projectPath: String(row.project_path),
        sessions: 0,
        runs: Number(row.runs),
        errorRuns: Number(row.error_runs ?? 0),
        events: 0,
      };
      byPath.set(stat.projectPath, stat);
      projects.push(stat);
    }
    for (const row of db
      .prepare(
        `SELECT project_path, project_name, COUNT(*) AS n FROM sessions
         WHERE updated_at >= ? AND updated_at <= ?${sessionWhere ? ` AND ${sessionFilters.join(" AND ")}` : ""}
         GROUP BY project_path, project_name`,
      )
      .all(from, to, ...sessionParams) as SqlRow[]) {
      const projectPath = String(row.project_path);
      const stat =
        byPath.get(projectPath) ??
        (() => {
          const created: ProjectStats = {
            projectName: String(row.project_name),
            projectPath,
            sessions: 0,
            runs: 0,
            errorRuns: 0,
            events: 0,
          };
          byPath.set(projectPath, created);
          projects.push(created);
          return created;
        })();
      stat.sessions = Number(row.n);
    }
    projects.sort((a, b) => b.runs - a.runs || b.sessions - a.sessions);
  } catch (error) {
    console.error("[absence] stats project query failed:", error);
  }

  // --- derived values (no-data contract: null, never a fake 0) ----------------
  const errorRate = runs > 0 ? errorRuns / runs : null;
  const models: ModelTokenStats[] = [...modelTokens.entries()]
    .map(([model, entry]) => ({
      model,
      runs: entry.runs,
      input: entry.input,
      output: entry.output,
      cost: modelCost(model, entry, pricingRules()),
    }))
    .sort((a, b) => b.output + b.input - (a.output + a.input));

  const totals: StatsTotals = {
    sessions,
    runs,
    events,
    errorRuns,
    errorEvents,
    errorRate,
    runWallMs,
    tokens: { input: inputTotal, output: outputTotal },
    cost: totalsCost(models),
  };

  const series: StatsBucket[] = [];
  for (let ts = Math.floor(from / stepMs) * stepMs; ts <= to; ts += stepMs) {
    const runEntry = runBuckets.get(ts);
    const eventCount = eventBuckets.get(ts);
    const outputTokens = usageBuckets.get(ts);
    if (!runEntry && eventCount === undefined && outputTokens === undefined) continue;
    series.push({
      ts,
      runs: runEntry?.runs ?? 0,
      errorRuns: runEntry?.errorRuns ?? 0,
      events: eventCount ?? 0,
      outputTokens: outputTokens === undefined ? null : outputTokens,
    });
  }

  return {
    from,
    to,
    stepMs,
    totals,
    series,
    tools: toolStats.slice(0, TOP_N),
    topErrors,
    models,
    projects: projects.slice(0, TOP_N),
  };
}

/**
 * Tool call volume, errors and start→end latency, paired on
 * `session_id + toolCallId`. Calls started (`tool_start`) drive the count so
 * failures are never lost; a start whose end fell outside the window pairs
 * with nothing and contributes no latency sample.
 */
async function toolLatencyStats(window: StatsWindow): Promise<ToolStats[]> {
  await drainArchive();
  const db = openDatabase();
  const sessions = scopedSessions(window);
  if (sessions !== null && sessions.length === 0) return [];
  const inScope = sessions === null ? "" : ` AND session_id IN (${sessions.map(() => "?").join(",")})`;
  const params: (string | number)[] = sessions === null ? [] : sessions;

  interface OpenCall {
    toolName: string;
    startTs: number;
  }
  const open = new Map<string, OpenCall>();
  const perTool = new Map<
    string,
    { calls: number; errors: number; durations: number[] }
  >();
  let rows: SqlRow[];
  try {
    rows = db
      .prepare(
        `SELECT session_id, ts, type, payload FROM events
         WHERE type IN ('tool_start', 'tool_end') AND ts >= ? AND ts <= ?${inScope}
         ORDER BY ts ASC LIMIT ?`,
      )
      .all(window.from, window.to, ...params, TOOL_EVENT_LIMIT) as SqlRow[];
  } catch (error) {
    console.error("[absence] stats tool query failed:", error);
    return [];
  }
  for (const row of rows) {
    let payload: {
      toolCallId?: unknown;
      toolName?: unknown;
      isError?: unknown;
    };
    try {
      payload = JSON.parse(String(row.payload)) as typeof payload;
    } catch {
      continue;
    }
    const toolCallId = String(payload.toolCallId ?? "");
    const toolName = String(payload.toolName ?? "").trim();
    if (!toolCallId || !toolName) continue;
    const key = `${row.session_id}:${toolCallId}`;
    const entry = perTool.get(toolName) ?? { calls: 0, errors: 0, durations: [] };
    if (String(row.type) === "tool_start") {
      entry.calls += 1;
      open.set(key, { toolName, startTs: Number(row.ts) });
    } else {
      if (payload.isError === true) entry.errors += 1;
      const started = open.get(key);
      if (started) {
        const duration = Number(row.ts) - started.startTs;
        if (duration >= 0 && Number.isFinite(duration)) entry.durations.push(duration);
        open.delete(key);
      }
    }
    perTool.set(toolName, entry);
  }
  return [...perTool.entries()]
    .map(([name, entry]) => ({
      toolName: name,
      calls: entry.calls,
      errors: entry.errors,
      p50Ms: percentile(entry.durations, 0.5),
      p95Ms: percentile(entry.durations, 0.95),
    }))
    .sort((a, b) => b.calls - a.calls);
}

/**
 * The session ids the project/runtime filters select, or `null` for "no
 * filter". The tool query inlines them as parameters; every other query keeps
 * the subquery form (see `readStats`).
 */
function scopedSessions(window: StatsWindow): string[] | null {
  const filters: string[] = [];
  const params: (string | number)[] = [];
  if (window.project?.trim()) {
    filters.push("project_path = ? COLLATE NOCASE");
    params.push(toPosix(path.resolve(window.project.trim())));
  }
  if (window.runtime?.trim()) {
    filters.push("runtime = ?");
    params.push(window.runtime.trim());
  }
  const db = openDatabase();
  const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
  try {
    const rows = db
      .prepare(`SELECT id FROM sessions${where}`)
      .all(...params) as SqlRow[];
    return rows.map((row) => String(row.id));
  } catch (error) {
    console.error("[absence] stats session scope failed:", error);
    return [];
  }
}

/** Percentile of a sample list; `null` below one sample (never a fake 0). */
function percentile(samples: number[], q: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

/** Bucket width for the trend series: ~60 buckets across any window. */
function bucketStep(rangeMs: number): number {
  const steps = [
    60_000,
    5 * 60_000,
    15 * 60_000,
    60 * 60_000,
    3 * 60 * 60_000,
    6 * 60 * 60_000,
    24 * 60 * 60_000,
    7 * 24 * 60 * 60_000,
  ];
  const target = Math.max(60_000, Math.floor(rangeMs / 60));
  return steps.find((step) => step >= target) ?? steps[steps.length - 1]!;
}

/** Cost for one model's token sums, `null` when no pricing rule matched. */
function modelCost(
  model: string,
  entry: { input: number; output: number; sawInput: boolean },
  rules: PricingRule[],
): number | null {
  const rule = rules.find((candidate) => globMatches(candidate.model, model));
  if (!rule) return null;
  const outputCost = (entry.output / 1_000_000) * rule.outputPer1M;
  const inputCost = entry.sawInput ? (entry.input / 1_000_000) * rule.inputPer1M : null;
  if (inputCost === null) return outputCost;
  return inputCost + outputCost;
}

function totalsCost(models: ModelTokenStats[]): number | null {
  const priced = models.filter((entry) => entry.cost !== null);
  if (priced.length === 0) return null;
  return priced.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
}

/** Case-insensitive glob (`*` wildcards) against a model name. */
function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .trim()
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (!escaped) return false;
  return new RegExp(`^${escaped}$`).test(value.trim().toLowerCase());
}

/**
 * The price table, read fresh per query: editing the file takes effect on the
 * next refresh, no restart. An unreadable or absent table prices nothing, and
 * the report answers with `cost: null` — the honest "not configured" — rather
 * than a made-up zero.
 */
function pricingRules(): PricingRule[] {
  return readPricingConfig();
}
