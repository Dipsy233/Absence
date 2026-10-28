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
import { check, finish } from "./harness";
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
check(
  "the agent and the egg both come back",
  read.series.length >= 2,
  `expected agent + egg series, got ${read.series.length}`,
);
const egg = read.series.find((entry) => entry.eggPid === 7);
check("the egg's series is persisted", egg !== undefined);
check("the egg has persisted points", (egg?.points.length ?? 0) > 0, `${egg?.points.length ?? 0}`);
check(
  "every written sample survived the round trip",
  (egg?.points.length ?? 0) >= COUNT - 2,
  `expected roughly ${COUNT} points, got ${egg?.points.length ?? 0}`,
);

// The agent summary is what a reopened session's average is based on.
const agent = read.series.find((entry) => entry.kind === "agent");
check("the agent's series is persisted", agent !== undefined);
check("the agent reads as running", agent?.status === "running");

// The host is persisted, so an expanded dashboard can draw the dashed machine
// line for a session that is no longer live.
check(
  "the host series is persisted",
  read.host.length > 0,
  "empty — the dashed line would be missing",
);
check("the host's cpu count is persisted", read.host[0]?.cpuCount === 16);
check("host total memory is persisted", (read.host[0]?.memTotalBytes ?? 0) > 0);
check(
  "host CPU is a monotonic counter",
  read.host[read.host.length - 1]!.cpuSeconds > read.host[0]!.cpuSeconds,
);
check(
  "host used memory advances with the samples",
  read.host[read.host.length - 1]!.memUsedBytes > read.host[0]!.memUsedBytes,
);

// A gap is a gap: querying a window with no samples returns no points, so the
// chart draws a hole instead of a line across the silence.
const quiet = readMetrics(sessionId, {
  from: to + 60 * 60_000,
  to: to + 61 * 60_000,
  step: STEP,
});
check(
  "a window with no samples invents no points",
  quiet.series.every((entry) => entry.points.length === 0),
  quiet.series.map((e) => e.points.length).join(","),
);
check("the host invents no points either", quiet.host.length === 0, `${quiet.host.length}`);

deleteSessionMetrics(sessionId);
closeArchive();
fs.rmSync(stateDir, { recursive: true, force: true });
finish("metrics persistence checks");
