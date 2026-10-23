import type { FastifyInstance } from "fastify";
import { readMeta } from "../sessions/archive";
import { readMetricSeries } from "../sessions/storage/metrics";
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

/**
 * GET /api/sessions/:id/metrics?from=&to=&step=&egg=
 *
 * The history path for the metrics dashboard. Live recent frames arrive over
 * the WebSocket snapshot; this endpoint reads the persisted chunks, which is
 * also what replay and archived sessions use.
 */
export async function metricRoutes(app: FastifyInstance): Promise<void> {
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
    };
    const now = Date.now();
    const to = parsePositive(query.to) ?? now;
    const from = parsePositive(query.from) ?? to - 60 * 60_000;
    if (from >= to) return reply.code(400).send({ error: "from must be before to" });
    const step =
      parsePositive(query.step) ??
      defaultStep(to - from);
    const eggPid = parsePositive(query.egg);
    return {
      from,
      to,
      step,
      series: readMetricSeries(id, { from, to, step, eggPid }),
    };
  });
}
