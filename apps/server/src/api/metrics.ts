import type { FastifyInstance } from "fastify";
import type { MetricSeries, MetricsResponse } from "@absence/core";
import { config } from "../config";
import { readMeta } from "../sessions/archive";
import { readMetrics } from "../sessions/storage/metrics";
import { sessionStore } from "../sessions/SessionStore";

/** A query-string positive integer, or undefined when absent/invalid. */
function parsePositive(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Pick a step that keeps a long range readable but a short one detailed. */
function defaultStep(rangeMs: number): number {
  if (rangeMs <= 5 * 60_000) return 2_000;
  if (rangeMs <= 15 * 60_000) return 5_000;
  if (rangeMs <= 60 * 60_000) return 10_000;
  if (rangeMs <= 6 * 60 * 60_000) return 60_000;
  return 5 * 60_000;
}

/** Escape a label value for the text exposition format. */
function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * GET /api/sessions/:id/metrics?from=&to=&step=&egg=
 *
 * The history path for the metrics dashboard. Live recent frames arrive over
 * the WebSocket snapshot; this endpoint reads the persisted chunks, which is
 * also what replay and archived sessions use.
 *
 * `?format=prometheus` renders the Prometheus text exposition format instead of
 * JSON, so a real Prometheus server can scrape one session's eggs directly.
 */
export async function metricRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What the metrics store is configured to do, for the Settings dialog. The
   * retention is a server value (ABSENCE_METRICS_RETENTION_DAYS), not client
   * state: the UI shows it and how to change it rather than pretending a
   * browser toggle can rewrite the database policy.
   */
  app.get("/api/metrics/info", async () => ({
    retentionDays: config.metricsRetentionDays,
    scrapePath: "/api/sessions/{id}/metrics?format=prometheus",
  }));

  app.get("/api/sessions/:id/metrics", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionStore.get(id) && !(await readMeta("", id))) {
      return reply.code(404).send({ error: "session not found" });
    }
    const query = (request.query ?? {}) as {
      from?: string;
      to?: string;
      step?: string;
      egg?: string;
      format?: string;
    };
    const now = Date.now();
    const to = parsePositive(query.to) ?? now;
    const from = parsePositive(query.from) ?? to - 60 * 60_000;
    if (from >= to) return reply.code(400).send({ error: "from must be before to" });
    const step = parsePositive(query.step) ?? defaultStep(to - from);
    const eggPid = parsePositive(query.egg);
    const { series, host } = readMetrics(id, { from, to, step, eggPid });

    if (query.format === "prometheus" || query.format === "text") {
      reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
      return renderPrometheusText(id, series);
    }
    const response: MetricsResponse = { from, to, step, series, host };
    return response;
  });
}

/**
 * The Prometheus text exposition format (version 0.0.4).
 *
 * Counters are exported as the cumulative totals the samples already are
 * (`cpu_seconds_total`), and memory as the instantaneous gauge it is. A client
 * derives rates with `rate(...)`, exactly as it would for any other exporter —
 * Absence does not pretend to know the scrape interval.
 */
function renderPrometheusText(
  sessionId: string,
  series: MetricSeries[],
): string {
  const lines: string[] = [];
  const header = (name: string, type: "counter" | "gauge", help: string) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
  };

  lines.push(`# session ${sessionId}`);

  header(
    "absence_egg_cpu_seconds_total",
    "counter",
    "Cumulative CPU time of the egg's whole process subtree.",
  );
  for (const entry of series) {
    const last = entry.points[entry.points.length - 1];
    if (!last) continue;
    lines.push(
      `absence_egg_cpu_seconds_total{session="${label(sessionId)}",egg="${label(String(entry.eggPid))}",name="${label(entry.name)}",kind="${label(entry.kind)}"} ${last.cpuSeconds}`,
    );
  }

  header(
    "absence_egg_resident_memory_bytes",
    "gauge",
    "Resident memory of the egg's whole process subtree, in bytes.",
  );
  for (const entry of series) {
    const last = entry.points[entry.points.length - 1];
    if (!last) continue;
    lines.push(
      `absence_egg_resident_memory_bytes{session="${label(sessionId)}",egg="${label(String(entry.eggPid))}",name="${label(entry.name)}",kind="${label(entry.kind)}"} ${last.rssBytes}`,
    );
  }

  header(
    "absence_egg_resident_memory_bytes_max",
    "gauge",
    "Peak resident memory over the requested range, in bytes.",
  );
  for (const entry of series) {
    const last = entry.points[entry.points.length - 1];
    if (!last) continue;
    lines.push(
      `absence_egg_resident_memory_bytes_max{session="${label(sessionId)}",egg="${label(String(entry.eggPid))}",name="${label(entry.name)}"} ${last.rssMaxBytes}`,
    );
  }

  header(
    "absence_eggs",
    "gauge",
    "Eggs that produced at least one sample in the requested range.",
  );
  const running = series.filter((entry) => entry.status === "running").length;
  lines.push(`absence_eggs{session="${label(sessionId)}",status="running"} ${running}`);
  lines.push(
    `absence_eggs{session="${label(sessionId)}",status="exited"} ${series.length - running}`,
  );

  header(
    "absence_egg_session_avg_cpu_cores",
    "gauge",
    "Average CPU cores used by the egg since the session began.",
  );
  for (const entry of series) {
    lines.push(
      `absence_egg_session_avg_cpu_cores{session="${label(sessionId)}",egg="${label(String(entry.eggPid))}",name="${label(entry.name)}"} ${entry.avgCpuCoresSession}`,
    );
  }

  header(
    "absence_egg_session_avg_resident_memory_bytes",
    "gauge",
    "Time-weighted average resident memory of the egg since the session began.",
  );
  for (const entry of series) {
    lines.push(
      `absence_egg_session_avg_resident_memory_bytes{session="${label(sessionId)}",egg="${label(String(entry.eggPid))}",name="${label(entry.name)}"} ${entry.avgRssBytesSession}`,
    );
  }

  return `${lines.join("\n")}\n`;
}