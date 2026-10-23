/**
 * Process resource metrics (v0.4).
 *
 * Prometheus-shaped on purpose: CPU is a cumulative counter in seconds, memory
 * is a gauge in bytes. The UI derives `rate()` / `avg_over_time()` from these
 * samples; the server never has to know what a chart wants.
 *
 * Metrics are *not* AbsenceEvents. They are sampled at a fixed cadence and
 * streamed on their own channel, because the event window (MAX_SESSION_EVENTS)
 * and the event archive are for facts the agent produced, not for a process
 * table sampled every two seconds.
 */

/** One process the sampler saw in a tick. */
export interface ProcessMetricSample {
  ts: number;
  pid: number;
  ppid: number;
  /** The egg root this process rolls into. */
  eggPid: number;
  name: string;
  /** Cumulative CPU time, in seconds (counter). */
  cpuSeconds: number;
  /** Resident set size, in bytes (gauge). */
  rssBytes: number;
  vszBytes?: number;
  threads?: number;
  /** Open handles: only the native (Windows) pass reports one. */
  handles?: number;
  ioReadBytes?: number;
  ioWriteBytes?: number;
}

/** One egg's subtree, aggregated for the chart. */
export interface EggMetricSample {
  eggPid: number;
  name: string;
  kind: "agent" | "primary" | "tool";
  status: "running" | "exited";
  /** Cumulative CPU time of the whole subtree, in seconds (counter). */
  cpuSeconds: number;
  /** Sum of the subtree's RSS, in bytes (gauge). */
  rssBytes: number;
  /** How many processes the subtree currently has. */
  processCount: number;
  /**
   * Session-to-date averages, maintained by the server so a client that joins
   * late still sees the true average even after the in-memory ring has dropped
   * the oldest frames.
   */
  avgCpuCoresSession: number;
  avgRssBytesSession: number;
}

/** Host context, so a process's share can be read against the machine. */
export interface HostMetricSample {
  ts: number;
  /** Cumulative host CPU time, in seconds (counter). */
  cpuSeconds: number;
  /** Cumulative host idle time, in seconds (counter), for the usage rate. */
  cpuIdleSeconds: number;
  cpuCount: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  load1?: number;
}

/** One sampling tick. */
export interface MetricsFrame {
  ts: number;
  /** The sampler's cadence when this frame was taken. */
  intervalMs: number;
  processes: ProcessMetricSample[];
  eggs: EggMetricSample[];
  /** The complete agent tree, including Absence/runtime plumbing and eggs. */
  agent?: EggMetricSample;
  host: HostMetricSample;
  /**
   * `exact` when a kernel helper reported the values, `sampled` when they came
   * from a process table read. The UI says which one it is.
   */
  precision: "exact" | "sampled";
}

/** A persisted point after server-side bucketing. */
export interface MetricSeriesPoint {
  ts: number;
  /** Cumulative CPU seconds at the end of the bucket. */
  cpuSeconds: number;
  /** Mean RSS over the bucket, in bytes. */
  rssBytes: number;
  /** Peak RSS over the bucket, in bytes. */
  rssMaxBytes: number;
}

/** One persisted series, as returned by GET /api/sessions/:id/metrics. */
export interface MetricSeries {
  eggPid: number;
  name: string;
  kind: "agent" | "primary" | "tool";
  status: "running" | "exited";
  points: MetricSeriesPoint[];
  /** Session-to-date averages from the summary table. */
  avgCpuCoresSession: number;
  avgRssBytesSession: number;
  firstTs: number;
  lastTs: number;
}

/** GET /api/sessions/:id/metrics response. */
export interface MetricsResponse {
  from: number;
  to: number;
  step: number;
  series: MetricSeries[];
}
