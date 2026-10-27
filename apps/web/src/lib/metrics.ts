import type {
  EggMetricSample,
  HostMetricSeriesPoint,
  MetricSeries,
  MetricsFrame,
} from "@absence/core";

/** The newest frame in the ring, if any. */
export function latestFrame(frames: MetricsFrame[]): MetricsFrame | undefined {
  return frames.length > 0 ? frames[frames.length - 1] : undefined;
}

/**
 * An egg's latest sample, searching backwards because an exited egg is absent
 * from the newest frame but still worth showing.
 */
export function findEgg(frames: MetricsFrame[], eggPid: number): EggMetricSample | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i]!;
    for (let j = frame.eggs.length - 1; j >= 0; j--) {
      const egg = frame.eggs[j]!;
      if (egg.eggPid === eggPid) return egg;
    }
  }
  return undefined;
}

/** All eggs in the newest frame, plus recently exited ones still in the ring. */
export function eggList(frames: MetricsFrame[]): EggMetricSample[] {
  const seen = new Map<number, EggMetricSample>();
  for (let i = frames.length - 1; i >= 0; i--) {
    for (const egg of frames[i]!.eggs) {
      if (!seen.has(egg.eggPid)) seen.set(egg.eggPid, egg);
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === "running" ? -1 : 1;
    return b.cpuSeconds - a.cpuSeconds;
  });
}

/** Raw points for one egg, oldest → newest. */
export function eggPoints(frames: MetricsFrame[], eggPid: number): Array<{
  ts: number;
  cpuSeconds: number;
  rssBytes: number;
}> {
  const points: Array<{ ts: number; cpuSeconds: number; rssBytes: number }> = [];
  for (const frame of frames) {
    for (const egg of frame.eggs) {
      if (egg.eggPid !== eggPid) continue;
      points.push({ ts: frame.ts, cpuSeconds: egg.cpuSeconds, rssBytes: egg.rssBytes });
      break;
    }
  }
  return points;
}

/** Aggregate the primary eggs into the agent's process tree. */
export function agentPoints(frames: MetricsFrame[]): Array<{
  ts: number;
  cpuSeconds: number;
  rssBytes: number;
}> {
  const explicit = frames.some((frame) => frame.agent !== undefined);
  if (explicit) {
    return frames.map((frame) => ({
      ts: frame.ts,
      cpuSeconds: frame.agent?.cpuSeconds ?? 0,
      rssBytes: frame.agent?.rssBytes ?? 0,
    }));
  }
  const state = new Map<number, { cpuSeconds: number; rssBytes: number }>();
  return frames.map((frame) => {
    const seen = new Set<number>();
    for (const egg of frame.eggs) {
      if (egg.kind !== "primary") continue;
      const previous = state.get(egg.eggPid);
      state.set(egg.eggPid, {
        // CPU is a cumulative counter. Keep the last value after exit so
        // another egg joining or leaving cannot make the agent counter fall.
        cpuSeconds: Math.max(previous?.cpuSeconds ?? 0, egg.cpuSeconds),
        // An exited egg's last RSS is not current agent memory.
        rssBytes: egg.status === "running" ? egg.rssBytes : 0,
      });
      seen.add(egg.eggPid);
    }
    for (const [eggPid, previous] of state) {
      if (!seen.has(eggPid)) previous.rssBytes = 0;
    }
    let cpuSeconds = 0;
    let rssBytes = 0;
    for (const value of state.values()) {
      cpuSeconds += value.cpuSeconds;
      rssBytes += value.rssBytes;
    }
    return { ts: frame.ts, cpuSeconds, rssBytes };
  });
}

export function agentCpuCores(frames: MetricsFrame[]): number {
  const points = agentPoints(frames);
  return points.length < 2 ? 0 : rateCores(points, points.length - 2);
}

export function agentAverageCores(frames: MetricsFrame[], windowMs: number): number {
  const points = agentPoints(frames);
  if (points.length < 2) return 0;
  const cutoff = points[points.length - 1]!.ts - windowMs;
  const index = points.findIndex((point) => point.ts >= cutoff);
  return rateCores(points, index < 0 ? 0 : index);
}

/** CPU cores in use between two samples. */
export function rateCores(points: Array<{ ts: number; cpuSeconds: number }>, fromIndex = 0): number {
  if (points.length < 2) return 0;
  const first = points[Math.max(0, Math.min(fromIndex, points.length - 2))]!;
  const last = points[points.length - 1]!;
  const seconds = (last.ts - first.ts) / 1000;
  if (seconds <= 0) return 0;
  return Math.max(0, (last.cpuSeconds - first.cpuSeconds) / seconds);
}

/** Instantaneous CPU for an egg: the last two frames that contain it. */
export function eggCpuCores(frames: MetricsFrame[], eggPid: number): number {
  const points = eggPoints(frames, eggPid);
  if (points.length < 2) return 0;
  return rateCores(points, points.length - 2);
}

/** Average CPU over a window of frames. */
export function eggAverageCores(frames: MetricsFrame[], eggPid: number, windowMs: number): number {
  const points = eggPoints(frames, eggPid);
  if (points.length < 2) return 0;
  const cutoff = points[points.length - 1]!.ts - windowMs;
  const index = points.findIndex((point) => point.ts >= cutoff);
  return rateCores(points, index < 0 ? 0 : index);
}

/** Host CPU percent from the ring. */
export function hostCpuPercent(frames: MetricsFrame[]): number {
  if (frames.length < 2) return 0;
  const last = frames[frames.length - 1]!;
  const first = frames[Math.max(0, frames.length - 2)]!;
  const seconds = (last.ts - first.ts) / 1000;
  if (seconds <= 0) return 0;
  const total = Math.max(0, last.host.cpuSeconds - first.host.cpuSeconds);
  const idle = Math.max(0, last.host.cpuIdleSeconds - first.host.cpuIdleSeconds);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
}

/** Host memory used, as a fraction. */
export function hostMemoryPercent(frames: MetricsFrame[]): number {
  const frame = latestFrame(frames);
  if (!frame || frame.host.memTotalBytes <= 0) return 0;
  const used = frame.host.memTotalBytes - frame.host.memAvailableBytes;
  return (used / frame.host.memTotalBytes) * 100;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatCores(cores: number): string {
  if (!Number.isFinite(cores) || cores <= 0) return "0.00";
  return cores.toFixed(cores >= 10 ? 1 : 2);
}

export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return "0%";
  return `${percent.toFixed(percent >= 10 ? 1 : 2)}%`;
}

/** A series for the full dashboard: points from the ring or from the API. */
export interface ChartSeries {
  ts: number[];
  /** Cores in use, or null where nothing was sampled (a gap, not a zero). */
  cpuCores: Array<number | null>;
  /** RSS in MiB, or null where nothing was sampled. */
  rssMiB: Array<number | null>;
  /** The machine's CPU usage, 0–100, or null where nothing was sampled. */
  hostCpuPercent?: Array<number | null>;
  /** The machine's used memory, in MiB, or null where nothing was sampled. */
  hostMemMiB?: Array<number | null>;
}

/** A raw point shared by the ring and the API paths. */
export interface SeriesPoint {
  ts: number;
  cpuSeconds: number;
  rssBytes: number;
}

/**
 * A chart from raw egg points.
 *
 * `times` is the x axis. When it is given, a slot with no sample becomes a
 * `null` rather than a straight line across a silence — which is the whole
 * reason the samples are persisted: a session closed and reopened later must
 * show the time in between as empty, not as "the agent was busy".
 */
export function chartFromPoints(points: SeriesPoint[], times?: number[], step?: number): ChartSeries {
  const axis = times ?? points.map((point) => point.ts);
  void step;
  const cpuCores: Array<number | null> = [];
  const rssMiB: Array<number | null> = [];
  let previous: SeriesPoint | undefined;
  let index = 0;
  for (const time of axis) {
    // Consume every sample at or before this slot; the newest one wins.
    let current: SeriesPoint | undefined;
    while (index < points.length && points[index]!.ts <= time) {
      current = points[index]!;
      index += 1;
    }
    if (!current) {
      // Nothing sampled yet at this x: leave a hole, both series.
      cpuCores.push(null);
      rssMiB.push(null);
      continue;
    }
    if (!previous) {
      // The first sample is a baseline, not a rate.
      cpuCores.push(0);
    } else {
      const seconds = (current.ts - previous.ts) / 1000;
      cpuCores.push(seconds > 0 ? Math.max(0, (current.cpuSeconds - previous.cpuSeconds) / seconds) : 0);
    }
    rssMiB.push(current.rssBytes / (1024 * 1024));
    previous = current;
  }
  return { ts: axis.map((ts) => Math.round(ts / 1000)), cpuCores, rssMiB };
}

export function chartFromRing(frames: MetricsFrame[], eggPid: number, times?: number[]): ChartSeries {
  return withHostSeries(chartFromPoints(eggPoints(frames, eggPid), times), frames);
}

export function chartFromAgentRing(frames: MetricsFrame[], times?: number[]): ChartSeries {
  return withHostSeries(chartFromPoints(agentPoints(frames), times), frames);
}

/** The machine's own line for a ring, aligned to an existing x axis. */
export function hostSeriesFromFrames(
  times: number[],
  frames: MetricsFrame[],
): { hostCpuPercent: Array<number | null>; hostMemMiB: Array<number | null> } {
  const chart = withHostSeries({ ts: times.map((ts) => Math.round(ts / 1000)), cpuCores: [], rssMiB: [] }, frames);
  return { hostCpuPercent: chart.hostCpuPercent ?? [], hostMemMiB: chart.hostMemMiB ?? [] };
}

/** The machine's own line, aligned to an existing chart's x axis. */
function withHostSeries(chart: ChartSeries, frames: MetricsFrame[]): ChartSeries {
  const hostCpuPercent: Array<number | null> = [];
  const hostMemMiB: Array<number | null> = [];
  for (const second of chart.ts) {
    const ts = second * 1000;
    let index = -1;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i]!.ts <= ts) index = i;
      else break;
    }
    const frame = frames[index];
    if (!frame) {
      hostCpuPercent.push(null);
      hostMemMiB.push(null);
      continue;
    }
    const previous = frames[Math.max(0, index - 1)];
    hostMemMiB.push(Math.max(0, frame.host.memTotalBytes - frame.host.memAvailableBytes) / (1024 * 1024));
    if (!previous || frame.ts === previous.ts) {
      hostCpuPercent.push(0);
      continue;
    }
    const total = Math.max(0, frame.host.cpuSeconds - previous.host.cpuSeconds);
    const idle = Math.max(0, frame.host.cpuIdleSeconds - previous.host.cpuIdleSeconds);
    hostCpuPercent.push(total > 0 ? Math.max(0, Math.min(100, ((total - idle) / total) * 100)) : 0);
  }
  return { ...chart, hostCpuPercent, hostMemMiB };
}

/**
 * The host's own line for a persisted range, aligned to the egg chart's axis.
 *
 * Host points carry cumulative counters, so the rate is derived here exactly the
 * way it is for an egg. A whole machine's percentage needs no core count: it is
 * already the machine's own share.
 */
export function chartHostFromSeries(host: HostMetricSeriesPoint[], times: number[]): {
  hostCpuPercent: Array<number | null>;
  hostMemMiB: Array<number | null>;
} {
  const hostCpuPercent: Array<number | null> = [];
  const hostMemMiB: Array<number | null> = [];
  let index = 0;
  let previous: HostMetricSeriesPoint | undefined;
  for (const time of times) {
    let current: HostMetricSeriesPoint | undefined;
    while (index < host.length && host[index]!.ts <= time) {
      current = host[index]!;
      index += 1;
    }
    if (!current) {
      hostCpuPercent.push(null);
      hostMemMiB.push(null);
      continue;
    }
    if (!previous) {
      hostCpuPercent.push(0);
    } else {
      const seconds = (current.ts - previous.ts) / 1000;
      const total = current.cpuSeconds - previous.cpuSeconds;
      const idle = current.cpuIdleSeconds - previous.cpuIdleSeconds;
      hostCpuPercent.push(
        seconds > 0 && total > 0 ? Math.max(0, Math.min(100, ((total - idle) / total) * 100)) : 0,
      );
    }
    hostMemMiB.push(Math.max(0, current.memUsedBytes) / (1024 * 1024));
    previous = current;
  }
  return { hostCpuPercent, hostMemMiB };
}

/**
 * Resample API points onto the dashboard's shared x axis.
 *
 * `times` is the union of the egg points and the host chunks, so the two lines
 * line up and the empty stretches stay empty.
 */
export function chartFromSeries(
  series: MetricSeries,
  times: number[],
  host: HostMetricSeriesPoint[] = [],
): ChartSeries {
  return { ...chartFromPoints(series.points, times), ...chartHostFromSeries(host, times) };
}

