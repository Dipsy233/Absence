import type { FastifyInstance } from "fastify";
import type { PricingRule } from "@absence/core";
import { readStats } from "../sessions/storage/stats";
import { readPricingConfig, writePricingConfig } from "../sessions/storage/pricing";

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60_000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60_000;

/**
 * Cross-session aggregate statistics and the token price table.
 *
 * `GET /api/stats` is a moment's read over the archive (sessions/events/runs
 * plus per-run `usage` events); the price table is the one local config that
 * turns estimated tokens into an estimated cost, computed per query and never
 * stored.
 */
export async function statsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Aggregated agent behavior over a time window.
   *
   *   ?from=<ms>      window start (default: to - 7d)
   *   ?to=<ms>        window end (default: now)
   *   ?project=<dir>  exact project path filter
   *   ?runtime=<id>   exact agent runtime filter
   *
   * Derived values are `null` when the window has no data — the report never
   * dresses emptiness up as a confident zero.
   */
  app.get("/api/stats", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const now = Date.now();
    const to = parseMs(q.to) ?? now;
    const from = parseMs(q.from) ?? to - DEFAULT_WINDOW_MS;
    if (from > to) {
      return reply.code(400).send({ error: "from must be <= to" });
    }
    // `from=0` is the "all" reading — everything the archive holds. The cap
    // guards accidental giant windows, not a deliberate full-table read.
    if (from !== 0 && to - from > MAX_WINDOW_MS) {
      return reply.code(400).send({ error: "window exceeds 366 days" });
    }
    return readStats({
      from,
      to,
      ...(q.project !== undefined ? { project: q.project } : {}),
      ...(q.runtime !== undefined ? { runtime: q.runtime } : {}),
    });
  });

  /** The whole price table: rules are matched top-down, first hit wins. */
  app.get("/api/pricing", async () => {
    return { rules: readPricingConfig() };
  });

  /** Replace the whole table. The next stats query picks it up, no restart. */
  app.put("/api/pricing", async (request, reply) => {
    const body = request.body as { rules?: unknown } | undefined;
    if (!body || !Array.isArray(body.rules)) {
      return reply.code(400).send({ error: "rules must be an array" });
    }
    try {
      writePricingConfig(body.rules as PricingRule[]);
      return { ok: true, rules: readPricingConfig() };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/** A query-string epoch-ms number (0 = epoch, a valid "all" bound), or undefined when absent/invalid. */
function parseMs(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
