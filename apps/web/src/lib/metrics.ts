import type { EggMetricSample, MetricSeries, MetricsFrame } from "@absence/core";

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
  cpuCores: number[];
  rssMiB: number[];
}

export function chartFromRing(frames: MetricsFrame[], eggPid: number): ChartSeries {
  const points = eggPoints(frames, eggPid);
  return chartFromPoints(points);
}

export function chartFromAgentRing(frames: MetricsFrame[]): ChartSeries {
  return chartFromPoints(agentPoints(frames));
}

function chartFromPoints(
  points: Array<{ ts: number; cpuSeconds: number; rssBytes: number }>,
): ChartSeries {
  const ts: number[] = [];
  const cpuCores: number[] = [];
  const rssMiB: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const point = points[i]!;
    const seconds = (point.ts - previous.ts) / 1000;
    if (seconds <= 0) continue;
    ts.push(Math.round(point.ts / 1000));
    cpuCores.push(Math.max(0, (point.cpuSeconds - previous.cpuSeconds) / seconds));
    rssMiB.push(point.rssBytes / (1024 * 1024));
  }
  return { ts, cpuCores, rssMiB };
}

/** Resample API points into uniform chart arrays. */
export function chartFromSeries(series: MetricSeries, step: number): ChartSeries {
  const ts: number[] = [];
  const cpuCores: number[] = [];
  const rssMiB: number[] = [];
  const points = series.points;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const point = points[i]!;
    const seconds = (point.ts - previous.ts) / 1000;
    if (seconds <= 0) continue;
    ts.push(Math.round(point.ts / 1000));
    cpuCores.push(Math.max(0, (point.cpuSeconds - previous.cpuSeconds) / seconds));
    rssMiB.push(point.rssBytes / (1024 * 1024));
  }
  // A single point is not a rate; show memory at least.
  if (points.length === 1) {
    ts.push(Math.round(points[0]!.ts / 1000));
    cpuCores.push(0);
    rssMiB.push(points[0]!.rssBytes / (1024 * 1024));
  }
  void step;
  return { ts, cpuCores, rssMiB };
}
