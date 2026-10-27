import type {
  EggMetricSample,
  HostMetricSeriesPoint,
  MetricSeries,
  MetricSeriesPoint,
  MetricsFrame,
} from "@absence/core";
import type { StatementSync } from "node:sqlite";
import { openDatabase } from "./db";

/** A chunk covers this much wall time before a new row is started. */
const CHUNK_MS = 30 * 60_000;
/** Partial chunks are rewritten this often, so a crash loses little. */
const FLUSH_MS = 15_000;
/** At the fastest cadence a chunk holds 30 minutes × 2s. */
const MAX_SAMPLES = (CHUNK_MS / 1_000) | 0;

interface OpenChunk {
  sessionId: string;
  eggPid: number;
  /** Timestamp of the first sample; the chunk spans n × stepMs from here. */
  startTs: number;
  /** The 30-minute bucket this chunk belongs to, for rollover only. */
  bucketStart: number;
  stepMs: number;
  /** Cumulative CPU at the first sample of this chunk. */
  cpuBase: number;
  lastCpu: number;
  /** Per-sample deltas from the previous sample; the first is 0. */
  cpuDeltas: number[];
  /** RSS in KiB, so a Uint32 covers 4 TiB. */
  rssKiB: number[];
}

/**
 * The machine's own counters, chunked exactly like an egg's.
 *
 * Host samples have no pid, so they get their own table rather than a sentinel
 * egg row. CPU and idle are cumulative counters (stored as deltas from a base,
 * for the same precision reasons as the eggs); memory is a gauge.
 */
interface OpenHostChunk {
  sessionId: string;
  startTs: number;
  bucketStart: number;
  stepMs: number;
  cpuBase: number;
  idleBase: number;
  lastCpu: number;
  lastIdle: number;
  cpuDeltas: number[];
  idleDeltas: number[];
  memUsedKiB: number[];
  memTotalKiB: number[];
  /** The core count the machine reported; written once per chunk. */
  cpuCount: number;
}

interface SummaryRow {
  sessionId: string;
  eggPid: number;
  name: string;
  kind: "agent" | "primary" | "tool";
  status: "running" | "exited";
  firstTs: number;
  lastTs: number;
  prevTs: number;
  cpuStart: number;
  prevCpu: number;
  cpuEnd: number;
  rssIntegral: number;
  prevRss: number;
  samples: number;
}

const openChunks = new Map<string, OpenChunk>();
const openHostChunks = new Map<string, OpenHostChunk>();
const summaries = new Map<string, SummaryRow>();
let flushTimer: NodeJS.Timeout | undefined;
let failed = false;

function keyOf(sessionId: string, eggPid: number): string {
  return `${sessionId}:${eggPid}`;
}

/** Sessions whose summaries have been read back from SQLite. */
const summariesLoaded = new Set<string>();

/**
 * Bring a reopened session's running totals back before its first new frame.
 *
 * The summaries hold the session-to-date averages and are memory-only by design
 * (see `flushMetrics`). A session closed and reopened later would otherwise
 * start a fresh summary at the reopen and the session average in the UI would
 * reset to the second half of the story. Reading the persisted row first keeps
 * it continuous and keeps the `firstTs` baseline, so the CPU counter does not
 * appear to jump.
 */
function ensureSummariesLoaded(sessionId: string): void {
  if (summariesLoaded.has(sessionId)) return;
  summariesLoaded.add(sessionId);
  try {
    const rows = openDatabase()
      .prepare("SELECT * FROM egg_metric_summary WHERE session_id = ?")
      .all(sessionId) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const eggPid = Number(row.egg_pid ?? 0);
      const cpuEnd = Number(row.cpu_seconds_end ?? 0);
      const lastTs = Number(row.last_ts ?? 0);
      summaries.set(keyOf(sessionId, eggPid), {
        sessionId,
        eggPid,
        name: String(row.name ?? ""),
        kind: row.kind === "agent" ? "agent" : row.kind === "tool" ? "tool" : "primary",
        status: row.status === "exited" ? "exited" : "running",
        firstTs: Number(row.first_ts ?? 0),
        lastTs,
        prevTs: lastTs,
        cpuStart: Number(row.cpu_seconds_start ?? 0),
        prevCpu: cpuEnd,
        cpuEnd,
        rssIntegral: Number(row.rss_integral ?? 0),
        prevRss: 0,
        samples: Number(row.samples ?? 0),
      });
    }
  } catch {
    // No store (or an older schema): a fresh summary is the honest fallback.
  }
}

function warn(error: unknown): void {
  if (failed) return;
  failed = true;
  console.error("[absence] metric store write failed:", error);
}

/**
 * Queue one frame. Called from the sampler's tick, so it must stay cheap: the
 * actual SQLite work happens on the 15s flush.
 */
export function appendMetricsFrame(sessionId: string, frame: MetricsFrame): void {
  try {
    ensureSummariesLoaded(sessionId);
    if (frame.agent) {
      appendEgg(sessionId, { ...frame.agent, eggPid: 0, kind: "agent", name: "Agent" }, frame);
    }
    for (const egg of frame.eggs) {
      if (egg.kind === "primary") appendEgg(sessionId, egg, frame);
    }
    const tools = frame.eggs.filter((egg) => egg.kind === "tool" && egg.status === "running");
    if (tools.length > 0) appendEgg(sessionId, aggregateTools(tools), frame);
    appendHost(sessionId, frame);
    scheduleFlush();
  } catch (error) {
    warn(error);
  }
}

/**
 * Queue the frame's host counters. No summary is kept: the machine's session
 * average is not something the UI shows, and the ring/chart derives whatever
 * it needs from the points themselves.
 */
function appendHost(sessionId: string, frame: MetricsFrame): void {
  const host = frame.host;
  const bucketStart = Math.floor(frame.ts / CHUNK_MS) * CHUNK_MS;
  let chunk = openHostChunks.get(sessionId);
  const reset =
    chunk === undefined ||
    chunk.stepMs !== frame.intervalMs ||
    chunk.bucketStart !== bucketStart ||
    chunk.cpuDeltas.length >= MAX_SAMPLES ||
    host.cpuSeconds < chunk.lastCpu - 1e-6 ||
    host.cpuIdleSeconds < chunk.lastIdle - 1e-6;
  const memUsed = Math.max(0, host.memTotalBytes - host.memAvailableBytes);

  if (reset) {
    if (chunk) flushHostChunk(sessionId, chunk);
    openHostChunks.set(sessionId, {
      sessionId,
      startTs: frame.ts,
      bucketStart,
      stepMs: frame.intervalMs,
      cpuBase: host.cpuSeconds,
      idleBase: host.cpuIdleSeconds,
      lastCpu: host.cpuSeconds,
      lastIdle: host.cpuIdleSeconds,
      cpuDeltas: [0],
      idleDeltas: [0],
      memUsedKiB: [toKiB(memUsed)],
      memTotalKiB: [toKiB(host.memTotalBytes)],
      cpuCount: Math.max(1, host.cpuCount),
    });
    return;
  }

  chunk.cpuDeltas.push(Math.max(0, host.cpuSeconds - chunk.lastCpu));
  chunk.idleDeltas.push(Math.max(0, host.cpuIdleSeconds - chunk.lastIdle));
  chunk.lastCpu = host.cpuSeconds;
  chunk.lastIdle = host.cpuIdleSeconds;
  chunk.memUsedKiB.push(toKiB(memUsed));
  chunk.memTotalKiB.push(toKiB(host.memTotalBytes));
}

function aggregateTools(tools: EggMetricSample[]): EggMetricSample {
  let cpuSeconds = 0;
  let rssBytes = 0;
  let processCount = 0;
  for (const tool of tools) {
    cpuSeconds += tool.cpuSeconds;
    rssBytes += tool.rssBytes;
    processCount += tool.processCount;
  }
  return {
    eggPid: 0,
    name: "tools",
    kind: "tool",
    status: "running",
    cpuSeconds,
    rssBytes,
    processCount,
    avgCpuCoresSession: 0,
    avgRssBytesSession: 0,
  };
}

function appendEgg(sessionId: string, egg: EggMetricSample, frame: MetricsFrame): void {
  if (egg.status === "exited") {
    // Mark the summary exited without extending its lifetime: the frame's ts
    // is when we noticed, not when the process died. Chunks stop at the last
    // live sample, so the session average does not keep integrating a dead RSS.
    const previous = summaries.get(keyOf(sessionId, egg.eggPid));
    if (previous) {
      previous.status = "exited";
      previous.name = egg.name;
    }
    return;
  }
  updateSummary(sessionId, egg, frame.ts);

  const key = keyOf(sessionId, egg.eggPid);
  let chunk = openChunks.get(key);
  const bucketStart = Math.floor(frame.ts / CHUNK_MS) * CHUNK_MS;
  const reset =
    chunk === undefined ||
    chunk.stepMs !== frame.intervalMs ||
    chunk.bucketStart !== bucketStart ||
    chunk.cpuDeltas.length >= MAX_SAMPLES ||
    egg.cpuSeconds < chunk.lastCpu - 1e-6;

  if (reset) {
    if (chunk) flushChunk(key, chunk);
    chunk = {
      sessionId,
      eggPid: egg.eggPid,
      startTs: frame.ts,
      bucketStart,
      stepMs: frame.intervalMs,
      cpuBase: egg.cpuSeconds,
      lastCpu: egg.cpuSeconds,
      cpuDeltas: [0],
      rssKiB: [toKiB(egg.rssBytes)],
    };
    openChunks.set(key, chunk);
    return;
  }

  if (!chunk) return;
  chunk.cpuDeltas.push(Math.max(0, egg.cpuSeconds - chunk.lastCpu));
  chunk.rssKiB.push(toKiB(egg.rssBytes));
  chunk.lastCpu = egg.cpuSeconds;
}

function updateSummary(sessionId: string, egg: EggMetricSample, ts: number): void {
  const key = keyOf(sessionId, egg.eggPid);
  const previous = summaries.get(key);
  if (!previous) {
    summaries.set(key, {
      sessionId,
      eggPid: egg.eggPid,
      name: egg.name,
      kind: egg.kind,
      status: egg.status,
      firstTs: ts,
      lastTs: ts,
      prevTs: ts,
      cpuStart: egg.cpuSeconds,
      prevCpu: egg.cpuSeconds,
      cpuEnd: egg.cpuSeconds,
      rssIntegral: 0,
      prevRss: egg.rssBytes,
      samples: 1,
    });
    return;
  }
  const dt = Math.min(120, Math.max(0, (ts - previous.prevTs) / 1000));
  if (egg.cpuSeconds < previous.prevCpu) {
    // pid reuse / restart: start a new baseline rather than integrating a
    // negative delta.
    previous.cpuStart = egg.cpuSeconds;
    previous.cpuEnd = egg.cpuSeconds;
    previous.prevCpu = egg.cpuSeconds;
    previous.prevRss = egg.rssBytes;
    previous.prevTs = ts;
    previous.lastTs = ts;
    previous.samples += 1;
    previous.status = egg.status;
    return;
  }
  previous.rssIntegral += previous.prevRss * dt;
  previous.prevRss = egg.rssBytes;
  previous.prevCpu = egg.cpuSeconds;
  previous.cpuEnd = egg.cpuSeconds;
  previous.prevTs = ts;
  previous.lastTs = ts;
  previous.samples += 1;
  previous.status = egg.status;
  previous.name = egg.name;
}

function toKiB(bytes: number): number {
  return Math.max(0, Math.min(0xffff_ffff, Math.round(bytes / 1024)));
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushMetrics();
  }, FLUSH_MS);
  flushTimer.unref?.();
}

/** Write the partial chunks and summaries now. Safe to call on dispose. */
export function flushMetrics(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (openChunks.size === 0 && openHostChunks.size === 0 && summaries.size === 0) return;
  const chunks = [...openChunks.entries()];
  const hostChunks = [...openHostChunks.values()];
  const rows = [...summaries.values()];
  openChunks.clear();
  openHostChunks.clear();
  // Summaries stay in memory: they hold the whole session's running totals, so
  // a later exit can flip the status without losing the average, and each flush
  // writes absolute values rather than increments.
  try {
    const db = openDatabase();
    const insertChunk = db.prepare(`
      INSERT OR REPLACE INTO metric_chunks
        (session_id, egg_pid, start_ts, step_ms, n, cpu_base, cpu, rss_kib)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertHostChunk = db.prepare(`
      INSERT OR REPLACE INTO host_metric_chunks
        (session_id, start_ts, step_ms, n, cpu_base, cpu_idle_base,
         cpu, cpu_idle, mem_used_kib, mem_total_kib, cpu_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSummary = db.prepare(`
      INSERT INTO egg_metric_summary
        (session_id, egg_pid, name, kind, status, first_ts, last_ts,
         cpu_seconds_start, cpu_seconds_end, rss_integral, samples)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, egg_pid) DO UPDATE SET
        name              = excluded.name,
        kind              = excluded.kind,
        status            = excluded.status,
        first_ts          = excluded.first_ts,
        last_ts           = excluded.last_ts,
        cpu_seconds_start = excluded.cpu_seconds_start,
        cpu_seconds_end   = excluded.cpu_seconds_end,
        rss_integral      = excluded.rss_integral,
        samples           = excluded.samples
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [, chunk] of chunks) writeChunk(insertChunk, chunk);
      for (const chunk of hostChunks) writeHostChunk(insertHostChunk, chunk);
      for (const row of rows) {
        insertSummary.run(
          row.sessionId,
          row.eggPid,
          row.name,
          row.kind,
          row.status,
          row.firstTs,
          row.lastTs,
          row.cpuStart,
          row.cpuEnd,
          row.rssIntegral,
          row.samples,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error is the useful one.
      }
      throw error;
    }
  } catch (error) {
    warn(error);
  }
}

function writeChunk(statement: StatementSync, chunk: OpenChunk): void {
  statement.run(
    chunk.sessionId,
    chunk.eggPid,
    chunk.startTs,
    chunk.stepMs,
    chunk.cpuDeltas.length,
    chunk.cpuBase,
    f32(chunk.cpuDeltas),
    u32(chunk.rssKiB),
  );
}

function writeHostChunk(statement: StatementSync, chunk: OpenHostChunk): void {
  statement.run(
    chunk.sessionId,
    chunk.startTs,
    chunk.stepMs,
    chunk.cpuDeltas.length,
    chunk.cpuBase,
    chunk.idleBase,
    f32(chunk.cpuDeltas),
    f32(chunk.idleDeltas),
    u32(chunk.memUsedKiB),
    u32(chunk.memTotalKiB),
    chunk.cpuCount,
  );
}

function flushChunk(key: string, chunk: OpenChunk): void {
  openChunks.delete(key);
  try {
    const db = openDatabase();
    writeChunk(
      db.prepare(`
        INSERT OR REPLACE INTO metric_chunks
          (session_id, egg_pid, start_ts, step_ms, n, cpu_base, cpu, rss_kib)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      chunk,
    );
  } catch (error) {
    warn(error);
  }
}

function flushHostChunk(sessionId: string, chunk: OpenHostChunk): void {
  openHostChunks.delete(sessionId);
  try {
    const db = openDatabase();
    writeHostChunk(
      db.prepare(`
        INSERT OR REPLACE INTO host_metric_chunks
          (session_id, start_ts, step_ms, n, cpu_base, cpu_idle_base,
           cpu, cpu_idle, mem_used_kib, mem_total_kib, cpu_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      chunk,
    );
  } catch (error) {
    warn(error);
  }
}

/** Wait for pending writes (dispose / tests). */
export async function drainMetrics(): Promise<void> {
  flushMetrics();
}

function f32(values: number[]): Buffer {
  const array = new Float32Array(values);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function u32(values: number[]): Buffer {
  const array = new Uint32Array(values);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function decodeF32(buffer: Uint8Array, n: number): Float32Array {
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(copy, 0, n);
}

function decodeU32(buffer: Uint8Array, n: number): Uint32Array {
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Uint32Array(copy, 0, n);
}

/* ── read ───────────────────────────────────────────────────────────────── */

interface ChunkRow {
  session_id?: unknown;
  egg_pid?: unknown;
  start_ts?: unknown;
  step_ms?: unknown;
  n?: unknown;
  cpu_base?: unknown;
  cpu?: unknown;
  rss_kib?: unknown;
}

interface SummarySqlRow {
  egg_pid?: unknown;
  name?: unknown;
  kind?: unknown;
  status?: unknown;
  first_ts?: unknown;
  last_ts?: unknown;
  cpu_seconds_start?: unknown;
  cpu_seconds_end?: unknown;
  rss_integral?: unknown;
  samples?: unknown;
}

interface HostChunkRow {
  session_id?: unknown;
  start_ts?: unknown;
  step_ms?: unknown;
  n?: unknown;
  cpu_base?: unknown;
  cpu_idle_base?: unknown;
  cpu?: unknown;
  cpu_idle?: unknown;
  mem_used_kib?: unknown;
  mem_total_kib?: unknown;
  cpu_count?: unknown;
}

/**
 * Read a session's persisted series, bucketed to `step` for a uniform x axis.
 * Live recent frames are served from the in-memory ring by the snapshot; this
 * is the history path (and the replay path).
 */
export function readMetricSeries(
  sessionId: string,
  options: { from: number; to: number; step: number; eggPid?: number },
): MetricSeries[] {
  return readMetrics(sessionId, options).series;
}

/** The persisted eggs **and** the host's own counters over the same buckets. */
export function readMetrics(
  sessionId: string,
  options: { from: number; to: number; step: number; eggPid?: number },
): { series: MetricSeries[]; host: HostMetricSeriesPoint[] } {
  flushMetrics();
  const from = Math.max(0, Math.min(options.from, options.to));
  const to = Math.max(from + 1, Math.max(options.from, options.to));
  const step = Math.max(1_000, Math.min(3_600_000, options.step));
  const eggPid = options.eggPid;
  let db;
  try {
    db = openDatabase();
  } catch (error) {
    warn(error);
    return { series: [], host: [] };
  }

  let summaries: SummarySqlRow[];
  let chunks: ChunkRow[];
  let hostChunks: HostChunkRow[];
  try {
    summaries = (
      eggPid === undefined
        ? db
            .prepare("SELECT * FROM egg_metric_summary WHERE session_id = ? ORDER BY egg_pid ASC")
            .all(sessionId)
        : db
            .prepare(
              "SELECT * FROM egg_metric_summary WHERE session_id = ? AND egg_pid = ? ORDER BY egg_pid ASC",
            )
            .all(sessionId, eggPid)
    ) as SummarySqlRow[];
    chunks = (
      eggPid === undefined
        ? db
            .prepare(
              "SELECT * FROM metric_chunks WHERE session_id = ? AND start_ts < ? AND start_ts + (n * step_ms) > ? ORDER BY egg_pid ASC, start_ts ASC",
            )
            .all(sessionId, to, from)
        : db
            .prepare(
              "SELECT * FROM metric_chunks WHERE session_id = ? AND egg_pid = ? AND start_ts < ? AND start_ts + (n * step_ms) > ? ORDER BY start_ts ASC",
            )
            .all(sessionId, eggPid, to, from)
    ) as ChunkRow[];
    hostChunks = db
      .prepare(
        "SELECT * FROM host_metric_chunks WHERE session_id = ? AND start_ts < ? AND start_ts + (n * step_ms) > ? ORDER BY start_ts ASC",
      )
      .all(sessionId, to, from) as HostChunkRow[];
  } catch (error) {
    warn(error);
    return { series: [], host: [] };
  }

  // Decode every chunk into raw points, grouped by egg.
  const raw = new Map<number, Array<{ ts: number; cpuSeconds: number; rssBytes: number }>>();
  for (const row of chunks) {
    const id = Number(row.egg_pid ?? 0);
    const n = Number(row.n ?? 0);
    const stepMs = Number(row.step_ms ?? 0);
    const startTs = Number(row.start_ts ?? 0);
    const cpuBase = Number(row.cpu_base ?? 0);
    if (n <= 0 || stepMs <= 0 || !(row.cpu instanceof Uint8Array) || !(row.rss_kib instanceof Uint8Array)) {
      continue;
    }
    const deltas = decodeF32(row.cpu, n);
    const rss = decodeU32(row.rss_kib, n);
    let cumulative = cpuBase;
    let points = raw.get(id);
    if (!points) {
      points = [];
      raw.set(id, points);
    }
    for (let i = 0; i < n; i++) {
      cumulative += deltas[i] ?? 0;
      points.push({
        ts: startTs + i * stepMs,
        cpuSeconds: cumulative,
        rssBytes: (rss[i] ?? 0) * 1024,
      });
    }
  }

  const series: MetricSeries[] = [];
  for (const summary of summaries) {
    const id = Number(summary.egg_pid ?? 0);
    const points = raw.get(id) ?? [];
    const bucketed = bucket(points, from, to, step);
    const firstTs = Number(summary.first_ts ?? 0);
    const lastTs = Number(summary.last_ts ?? 0);
    const elapsed = Math.max(0.001, (lastTs - firstTs) / 1000);
    const cpuStart = Number(summary.cpu_seconds_start ?? 0);
    const cpuEnd = Number(summary.cpu_seconds_end ?? 0);
    const rssIntegral = Number(summary.rss_integral ?? 0);
    series.push({
      eggPid: id,
      name: String(summary.name ?? ""),
      kind: summary.kind === "agent" ? "agent" : summary.kind === "tool" ? "tool" : "primary",
      status: summary.status === "exited" ? "exited" : "running",
      points: bucketed,
      avgCpuCoresSession: Math.max(0, (cpuEnd - cpuStart) / elapsed),
      avgRssBytesSession: Math.max(0, rssIntegral / elapsed),
      firstTs,
      lastTs,
    });
  }
  return { series, host: readHostPoints(hostChunks, from, to, step) };
}

/**
 * Decode the host chunks into bucketed points.
 *
 * The last sample of each bucket wins for the counters (the same rule as the
 * eggs' `bucket`), so a rate computed between two buckets is the rate between
 * the two samples the eggs' own rates used. Missing buckets are simply absent:
 * the chart draws a gap rather than inventing a value.
 */
function readHostPoints(
  chunks: HostChunkRow[],
  from: number,
  to: number,
  step: number,
): HostMetricSeriesPoint[] {
  const buckets = new Map<
    number,
    { cpu: number; idle: number; memUsed: number; memTotal: number; cpuCount: number }
  >();
  for (const row of chunks) {
    const n = Number(row.n ?? 0);
    const stepMs = Number(row.step_ms ?? 0);
    const startTs = Number(row.start_ts ?? 0);
    let cpu = Number(row.cpu_base ?? 0);
    let idle = Number(row.cpu_idle_base ?? 0);
    if (
      n <= 0 ||
      stepMs <= 0 ||
      !(row.cpu instanceof Uint8Array) ||
      !(row.cpu_idle instanceof Uint8Array) ||
      !(row.mem_used_kib instanceof Uint8Array) ||
      !(row.mem_total_kib instanceof Uint8Array)
    ) {
      continue;
    }
    const cpuDeltas = decodeF32(row.cpu, n);
    const idleDeltas = decodeF32(row.cpu_idle, n);
    const memUsed = decodeU32(row.mem_used_kib, n);
    const memTotal = decodeU32(row.mem_total_kib, n);
    for (let i = 0; i < n; i++) {
      cpu += cpuDeltas[i] ?? 0;
      idle += idleDeltas[i] ?? 0;
      const ts = startTs + i * stepMs;
      if (ts < from || ts > to) continue;
      buckets.set(Math.floor((ts - from) / step), {
        cpu,
        idle,
        memUsed: (memUsed[i] ?? 0) * 1024,
        memTotal: (memTotal[i] ?? 0) * 1024,
        cpuCount: Math.max(1, Number(row.cpu_count ?? 1)),
      });
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, value]) => ({
      ts: from + index * step,
      cpuSeconds: value.cpu,
      cpuIdleSeconds: value.idle,
      memUsedBytes: value.memUsed,
      memTotalBytes: value.memTotal,
      cpuCount: value.cpuCount,
    }));
}

function bucket(
  points: Array<{ ts: number; cpuSeconds: number; rssBytes: number }>,
  from: number,
  to: number,
  step: number,
): MetricSeriesPoint[] {
  const buckets = new Map<number, { cpu: number; rssSum: number; rssMax: number; count: number }>();
  for (const point of points) {
    if (point.ts < from || point.ts > to) continue;
    const index = Math.floor((point.ts - from) / step);
    const bucket = buckets.get(index);
    if (bucket) {
      bucket.cpu = point.cpuSeconds;
      bucket.rssSum += point.rssBytes;
      bucket.rssMax = Math.max(bucket.rssMax, point.rssBytes);
      bucket.count += 1;
    } else {
      buckets.set(index, {
        cpu: point.cpuSeconds,
        rssSum: point.rssBytes,
        rssMax: point.rssBytes,
        count: 1,
      });
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, value]) => ({
      ts: from + index * step,
      cpuSeconds: value.cpu,
      rssBytes: Math.round(value.rssSum / value.count),
      rssMaxBytes: value.rssMax,
    }));
}

/* ── retention ──────────────────────────────────────────────────────────── */

/** Drop everything older than the retention cutoff (default: 30 days). */
export function expireMetrics(beforeTs: number): void {
  try {
    const db = openDatabase();
    db.prepare("DELETE FROM metric_chunks WHERE start_ts < ?").run(beforeTs);
    db.prepare("DELETE FROM host_metric_chunks WHERE start_ts < ?").run(beforeTs);
    db.prepare("DELETE FROM egg_metric_summary WHERE last_ts < ?").run(beforeTs);
  } catch (error) {
    warn(error);
  }
}

/** Remove a session's metrics (session deletion). */
export function deleteSessionMetrics(sessionId: string): void {
  for (const key of [...summaries.keys()]) {
    if (key.startsWith(`${sessionId}:`)) summaries.delete(key);
  }
  for (const key of [...openChunks.keys()]) {
    if (key.startsWith(`${sessionId}:`)) openChunks.delete(key);
  }
  openHostChunks.delete(sessionId);
  summariesLoaded.delete(sessionId);
  try {
    const db = openDatabase();
    db.prepare("DELETE FROM metric_chunks WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM host_metric_chunks WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM egg_metric_summary WHERE session_id = ?").run(sessionId);
  } catch (error) {
    warn(error);
  }
}
