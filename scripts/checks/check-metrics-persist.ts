/**
 * Persistence check for the metrics dashboard.
 *
 * The bug this pins: close the app and reopen it, and the dashboard was empty.
 * The frames lived in a ring and only ever reached SQLite through a flush that
 * nothing forced on dispose, so the reopened session had nothing to draw.
 *
 * This check appends frames, flushes, then reads the series back the way the
 * dashboard does — eggs **and** the host — and asserts that the host line is
 * persisted too, since it is drawn as the dashed reference curve.
 *
 *   npx tsx scripts/checks/check-metrics-persist.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "absence-metrics-persist-"));
process.env.ABSENCE_STATE_DIR = stateDir;

const { appendMetricsFrame, flushMetrics, readMetrics, deleteSessionMetrics } = await import(
  "../../apps/server/src/sessions/storage/metrics"
);
const { closeArchive } = await import("../../apps/server/src/sessions/archive");

const sessionId = "sess_metrics_persist";
const base = 1_700_000_000_000;
const STEP = 5_000;

function frame(index: number) {
  const ts = base + index * STEP;
  const cpu = 10 + index * 0.5;
  const hostCpu = 1000 + index * 8;
  const hostIdle = 900 + index * 6;
  return {
    ts,
    intervalMs: STEP,
    processes: [],
    eggs: [
      {
        eggPid: 7,
        name: "dev server",
        kind: "primary" as const,
        status: "running" as const,
        cpuSeconds: cpu,
        rssBytes: (200 + index) * 1024 * 1024,
        processCount: 2,
        avgCpuCoresSession: 0,
        avgRssBytesSession: 0,
      },
    ],
    agent: {
      eggPid: 0,
      name: "Agent",
      kind: "agent" as const,
      status: "running" as const,
      cpuSeconds: cpu + 1,
      rssBytes: (400 + index) * 1024 * 1024,
      processCount: 5,
      avgCpuCoresSession: 0,
      avgRssBytesSession: 0,
    },
    host: {
      ts,
      cpuSeconds: hostCpu,
      cpuIdleSeconds: hostIdle,
      cpuCount: 16,
      memTotalBytes: 32 * 1024 ** 3,
      memAvailableBytes: (16 - index) * 1024 ** 3,
      load1: 0.5,
    },
    precision: "sampled" as const,
  };
}

// Two minutes of samples, 5s apart.
const COUNT = 25;
for (let i = 0; i < COUNT; i++) appendMetricsFrame(sessionId, frame(i));
flushMetrics();

const from = base - STEP;
const to = base + COUNT * STEP;
const read = readMetrics(sessionId, { from, to, step: STEP });

// The eggs survived the round trip.
assert.ok(read.series.length >= 2, `expected agent + egg series, got ${read.series.length}`);
const egg = read.series.find((entry) => entry.eggPid === 7);
assert.ok(egg, "the egg's series is missing");
assert.ok(egg.points.length > 0, "the egg has no persisted points");
assert.ok(
  egg.points.length >= COUNT - 2,
  `expected roughly ${COUNT} points, got ${egg.points.length}`,
);

// The agent summary is what a reopened session's average is based on.
const agent = read.series.find((entry) => entry.kind === "agent");
assert.ok(agent, "the agent's series is missing");
assert.equal(agent.status, "running");

// The host is persisted, so an expanded dashboard can draw the dashed machine
// line for a session that is no longer live.
assert.ok(read.host.length > 0, "the host series is empty — the dashed line would be missing");
assert.equal(read.host[0]!.cpuCount, 16);
assert.ok(read.host[0]!.memTotalBytes > 0, "host total memory must be persisted");
assert.ok(
  read.host[read.host.length - 1]!.cpuSeconds > read.host[0]!.cpuSeconds,
  "host CPU is a monotonic counter",
);
assert.ok(
  read.host[read.host.length - 1]!.memUsedBytes > read.host[0]!.memUsedBytes,
  "host used memory advances with the samples",
);

// A gap is a gap: querying a window with no samples returns no points, so the
// chart draws a hole instead of a line across the silence.
const quiet = readMetrics(sessionId, {
  from: to + 60 * 60_000,
  to: to + 61 * 60_000,
  step: STEP,
});
for (const entry of quiet.series) {
  assert.equal(entry.points.length, 0, "a window with no samples must not invent points");
}
assert.equal(quiet.host.length, 0, "the host must not invent points either");

deleteSessionMetrics(sessionId);
closeArchive();
fs.rmSync(stateDir, { recursive: true, force: true });
console.log("metrics persistence: ok");
