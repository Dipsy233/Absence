import { check, finish } from "./harness";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Metric storage round-trip: chunks, session summary, and the exited-status
 * rule (a dead egg's average must stop growing the moment it exits).
 *
 * The state directory is redirected before the SQLite module is loaded, so the
 * check never touches the user's real archive.
 */
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "absence-metrics-"));
process.env.ABSENCE_STATE_DIR = stateDir;

const { appendMetricsFrame, flushMetrics, readMetricSeries, deleteSessionMetrics } = await import(
  "../../apps/server/src/sessions/storage/metrics"
);
const { closeArchive } = await import("../../apps/server/src/sessions/archive");

const sessionId = "sess_metrics_check";
const eggPid = 4242;
const base = 1_700_000_000_000;

function frame(ts: number, status: "running" | "exited", cpuSeconds: number, rssBytes: number) {
  return {
    ts,
    intervalMs: 2_000,
    processes: [],
    eggs: [
      {
        eggPid,
        name: "checker",
        kind: "primary" as const,
        status,
        cpuSeconds,
        rssBytes,
        processCount: status === "running" ? 1 : 0,
        avgCpuCoresSession: 0,
        avgRssBytesSession: 0,
      },
    ],
    host: {
      ts,
      cpuSeconds: ts / 1000,
      cpuIdleSeconds: ts / 2000,
      cpuCount: 8,
      memTotalBytes: 16 * 1024 ** 3,
      memAvailableBytes: 8 * 1024 ** 3,
      load1: 0,
    },
    precision: "sampled" as const,
  };
}

// Three live samples: 2s apart, CPU counter advances by 0.5s each tick.
appendMetricsFrame(sessionId, frame(base, "running", 10, 100 * 1024 * 1024));
appendMetricsFrame(sessionId, frame(base + 2_000, "running", 10.5, 102 * 1024 * 1024));
appendMetricsFrame(sessionId, frame(base + 4_000, "running", 11, 101 * 1024 * 1024));
flushMetrics();

const before = readMetricSeries(sessionId, { from: base - 1, to: base + 10_000, step: 1_000 });
check("one series comes back", before.length === 1, `${before.length}`);
check("the egg is still running", before[0]!.status === "running");
check(
  "every live sample became a point",
  before[0]!.points.length >= 3,
  `expected >=3 points, got ${before[0]!.points.length}`,
);
const avgBefore = before[0]!.avgRssBytesSession;

// The egg exits. The frame's ts is "when we noticed", not the exit time: the
// summary must not extend its lifetime or keep integrating RSS.
appendMetricsFrame(sessionId, frame(base + 60_000, "exited", 11, 101 * 1024 * 1024));
flushMetrics();

const after = readMetricSeries(sessionId, { from: base - 1, to: base + 120_000, step: 1_000 });
check("the series survives the exit", after.length === 1, `${after.length}`);
check("the egg reads as exited", after[0]!.status === "exited");
check(
  "an exit does not add a data point",
  after[0]!.points.length === before[0]!.points.length,
  `${before[0]!.points.length} -> ${after[0]!.points.length}`,
);
check(
  "an exit does not change the session average",
  Math.round(after[0]!.avgRssBytesSession) === Math.round(avgBefore),
  `${avgBefore} -> ${after[0]!.avgRssBytesSession}`,
);

// The chunk is readable across a step change (the dashboard asks for 5s).
const resampled = readMetricSeries(sessionId, { from: base - 1, to: base + 10_000, step: 5_000 });
check("a coarser step still returns the series", resampled.length === 1, `${resampled.length}`);
check("resampling keeps at least one point", resampled[0]!.points.length >= 1);

deleteSessionMetrics(sessionId);
closeArchive();
fs.rmSync(stateDir, { recursive: true, force: true });
finish("metrics storage checks");
