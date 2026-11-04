/**
 * Offline check for the cross-session aggregate stats.
 *   npx tsx scripts/checks/check-stats.ts
 *
 * Pins the reporting contract the Stats tab relies on:
 *   - totals over seeded sessions/runs/events (runs indexed from events)
 *   - tool start→end pairing on toolCallId, with p50/p95 percentiles
 *   - error Top-N grouping by truncated message
 *   - usage events aggregate into per-model token sums and a derived cost
 *   - the no-data contract: an empty window yields nulls, never fake zeros
 *   - estimateTokens: CJK ≈ 1 token/char, other ≈ 1 token/4 chars
 *
 * Uses a private ABSENCE_STATE_DIR, so it never touches the user's archive.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AbsenceEvent } from "@absence/core";
import { estimateTokens } from "../../packages/core/src/tokens";
import { appendEvents, drainArchive, writeMeta } from "../../apps/server/src/sessions/archive";
import { readStats } from "../../apps/server/src/sessions/storage/stats";
import { writePricingConfig } from "../../apps/server/src/sessions/storage/pricing";
import { check, finish, section } from "./harness";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "absence-stats-"));
const stateDir = path.join(root, "state");
process.env.ABSENCE_STATE_DIR = stateDir;

const projectA = path.join(root, "project-a");
const projectB = path.join(root, "project-b");
fs.mkdirSync(projectA, { recursive: true });
fs.mkdirSync(projectB, { recursive: true });

const base = 1_700_000_000_000;
const window = { from: base - 60_000, to: base + 600_000 };

let seq = 0;
const event = (sessionId: string, type: string, payload: unknown, offsetMs: number): AbsenceEvent =>
  ({
    id: `evt_${++seq}`,
    sessionId,
    timestamp: base + offsetMs,
    type,
    payload,
  }) as AbsenceEvent;

/** One run: a user prompt opens it, an agent_end closes it. */
function run(sessionId: string, offsetMs: number, body: AbsenceEvent[], reason: string): AbsenceEvent[] {
  return [
    event(sessionId, "message", { role: "user", content: `prompt ${offsetMs}`, streaming: false }, offsetMs),
    ...body,
    event(sessionId, "agent_end", { reason }, offsetMs + 9),
  ];
}

// ── session A: two runs, tools, an error, usage ─────────────────────────────
const s1 = "sess_stats_a";
const eventsA: AbsenceEvent[] = [
  ...run(s1, 1000, [
    event(s1, "tool_start", { toolCallId: "c1", toolName: "bash", args: {} }, 1100),
    event(s1, "tool_end", { toolCallId: "c1", toolName: "bash", isError: false }, 1200),
    event(s1, "tool_start", { toolCallId: "c2", toolName: "bash", args: {} }, 1300),
    event(s1, "tool_end", { toolCallId: "c2", toolName: "bash", isError: true }, 1600),
    event(s1, "error", { message: "network timeout while calling bash" }, 1650),
    event(s1, "message", { role: "assistant", content: "partly done", streaming: false }, 1700),
    event(s1, "usage", { model: "mock-1", outputEst: 500, inputEst: 1000, estimated: true }, 1800),
  ], "error"),
  ...run(s1, 10_000, [
    event(s1, "tool_start", { toolCallId: "c3", toolName: "read", args: {} }, 10_100),
    event(s1, "tool_end", { toolCallId: "c3", toolName: "read", isError: false }, 10_300),
    // No context reported for this run: its input estimate is unknown.
    event(s1, "usage", { model: "mock-1", outputEst: 200, inputEst: null, estimated: true }, 10_400),
  ], "completed"),
];

// ── session B: one clean run, no usage (an older runtime) ───────────────────
const s2 = "sess_stats_b";
const eventsB: AbsenceEvent[] = run(s2, 20_000, [], "completed");

void (async () => {
  await writeMeta(projectA, {
    version: 1,
    absenceSessionId: s1,
    projectPath: projectA,
    projectName: "project-a",
    startedAt: base,
    updatedAt: base + 11_000,
    runtime: "mock",
    model: "mock-1",
    messageCount: 2,
  });
  await writeMeta(projectB, {
    version: 1,
    absenceSessionId: s2,
    projectPath: projectB,
    projectName: "project-b",
    startedAt: base + 20_000,
    updatedAt: base + 21_000,
    runtime: "pi",
    messageCount: 1,
  });
  appendEvents(projectA, s1, eventsA);
  appendEvents(projectB, s2, eventsB);
  await drainArchive();

  section("estimateTokens");
  {
    check("ASCII is ~1 token per 4 chars", estimateTokens("abcdefgh") === 2, String(estimateTokens("abcdefgh")));
    check("CJK is ~1 token per char", estimateTokens("四个中文字") === 5, String(estimateTokens("四个中文字")));
    check("empty text is 0 tokens", estimateTokens("") === 0);
  }

  section("totals and no-data contract");
  {
    const empty = await readStats({ from: base - 500_000, to: base - 400_000 });
    check("an empty window has zero sessions", empty.totals.sessions === 0);
    check("an empty window has an errorRate of null, not 0", empty.totals.errorRate === null);
    check(
      "an empty window has null tokens, not 0",
      empty.totals.tokens.input === null && empty.totals.tokens.output === null,
    );
    check("an empty window has null cost", empty.totals.cost === null);
    check("an empty window has an empty series", empty.series.length === 0);
    check("an empty window has no tool rows", empty.tools.length === 0);
  }

  section("totals over the seeded window");
  {
    const report = await readStats({ ...window });
    check("sessions counted", report.totals.sessions === 2, String(report.totals.sessions));
    check("runs counted (runs indexed from events)", report.totals.runs === 3, String(report.totals.runs));
    check("events counted (usage events included)", report.totals.events === eventsA.length + eventsB.length, String(report.totals.events));
    check("error runs counted", report.totals.errorRuns === 1, String(report.totals.errorRuns));
    check("error events counted", report.totals.errorEvents === 1, String(report.totals.errorEvents));
    check("error rate derived", Math.abs((report.totals.errorRate ?? -1) - 1 / 3) < 1e-9);
    check("wall time summed", report.totals.runWallMs !== null && report.totals.runWallMs > 0);
    check(
      "token sums skip the unknown input",
      report.totals.tokens.input === 1000 && report.totals.tokens.output === 700,
      JSON.stringify(report.totals.tokens),
    );
  }

  section("tools");
  {
    const report = await readStats({ ...window });
    const bash = report.tools.find((tool) => tool.toolName === "bash");
    check("bash call count includes its failure", bash?.calls === 2, JSON.stringify(bash));
    check("bash errors counted", bash?.errors === 1);
    check("bash latency paired from both calls", bash?.p50Ms === 100 && bash?.p95Ms === 300, JSON.stringify(bash));
    const read = report.tools.find((tool) => tool.toolName === "read");
    check("read has one clean call", read?.calls === 1 && read?.errors === 0);
  }

  section("errors and models");
  {
    const report = await readStats({ ...window });
    check("the error tops the list", report.topErrors[0]?.message.includes("network timeout") && report.topErrors[0]?.count === 1, JSON.stringify(report.topErrors));
    check("no cost before a price exists", report.totals.cost === null);
    const model = report.models.find((entry) => entry.model === "mock-1");
    check("per-model sums exist", model?.output === 700 && model?.runs === 2, JSON.stringify(model));
  }

  section("pricing");
  {
    writePricingConfig([{ model: "mock-*", inputPer1M: 3, outputPer1M: 15 }]);
    const report = await readStats({ ...window });
    // 1000/1e6 × 3 + 700/1e6 × 15 = 0.003 + 0.0105
    check("cost derived from the table", Math.abs((report.totals.cost ?? -1) - 0.0135) < 1e-9, String(report.totals.cost));
    const model = report.models.find((entry) => entry.model === "mock-1");
    check("per-model cost derived", Math.abs((model?.cost ?? -1) - 0.0135) < 1e-9);
    check("the unpriced runtime stays null", report.models.every((entry) => entry.model !== "unknown"));
    try {
      writePricingConfig([{ model: "", inputPer1M: 1, outputPer1M: 1 }]);
      check("a bad rule is rejected", false);
    } catch {
      check("a bad rule is rejected", true);
    }
  }

  section("filters");
  {
    const onlyA = await readStats({ ...window, project: projectA });
    check("project filter scopes sessions", onlyA.totals.sessions === 1, String(onlyA.totals.sessions));
    check("project filter scopes runs", onlyA.totals.runs === 2, String(onlyA.totals.runs));
    const onlyPi = await readStats({ ...window, runtime: "pi" });
    check("runtime filter scopes runs", onlyPi.totals.runs === 1, String(onlyPi.totals.runs));
    check(
      "a runtime without usage has null tokens",
      onlyPi.totals.tokens.input === null && onlyPi.totals.tokens.output === null,
      JSON.stringify(onlyPi.totals.tokens),
    );
    check("the series carries the error bucket", onlyA.series.some((bucket) => bucket.errorRuns === 1), JSON.stringify(onlyA.series));
  }

  finish("check-stats");
})();
