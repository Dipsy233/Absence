import type { EggMetricSample, MetricsFrame, ProcessMetricSample } from "@absence/core";
import { sampleHost, sampleProcesses } from "./metricSample";

/** One egg root and the pids that roll into it. */
export interface MetricsTarget {
  rootPid: number;
  name: string;
  kind: "primary" | "tool";
  status: "running" | "exited";
  startedAt: number;
  pids: number[];
}

/** How many frames the live snapshot keeps (2s × 300 ≈ 10 minutes). */
export const METRICS_RING_FRAMES = 300;

/** The interval ladder. The sampler picks the first one that fits the budget. */
const INTERVAL_LADDER_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

/**
 * ~128 MB/day of persisted samples (8 bytes per sample). At the ladder's
 * coarsest step this still leaves room for a few thousand concurrent eggs;
 * beyond that the persistence layer keeps the top-N and folds the rest.
 */
const DAILY_BUDGET_BYTES = 128 * 1024 * 1024;
const BYTES_PER_SAMPLE = 8;

interface EggSummary {
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

export interface ProcessMetricsSamplerOptions {
  targets: () => MetricsTarget[];
  onFrame: (frame: MetricsFrame) => void;
  now?: () => number;
}

/**
 * Samples the eggs' process trees and emits a `MetricsFrame` on a cadence.
 *
 * The cadence is adaptive: the more primary eggs are running, the coarser the
 * interval, so a session that lays a thousand processes does not write a
 * gigabyte a day. A selected egg can pin the cadence back to 2s (the client
 * sends `metrics_subscribe` when the dashboard opens).
 */
export class ProcessMetricsSampler {
  private readonly targets: () => MetricsTarget[];
  private readonly onFrame: (frame: MetricsFrame) => void;
  private readonly now: () => number;
  private readonly ring: MetricsFrame[] = [];
  private readonly summaries = new Map<number, EggSummary>();
  private readonly lastEggs = new Map<number, EggMetricSample>();
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private hotEggPid?: number;
  private intervalMs = 2_000;
  private ticking = false;

  constructor(options: ProcessMetricsSamplerOptions) {
    this.targets = options.targets;
    this.onFrame = options.onFrame;
    this.now = options.now ?? Date.now;
  }

  /** The live frames, oldest → newest. */
  snapshot(): MetricsFrame[] {
    return [...this.ring];
  }

  get interval(): number {
    return this.intervalMs;
  }

  /** Pin a selected egg's cadence to 2s (or release it with `undefined`). */
  setHotEgg(eggPid?: number): void {
    this.hotEggPid = eggPid;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.schedule(0);
  }

  start(): void {
    if (this.timer !== undefined || this.disposed) return;
    this.schedule(500);
  }

  stop(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(afterMs: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, afterMs);
    // Do not keep the process alive for metrics alone.
    this.timer.unref?.();
  }

  private chooseInterval(count: number): number {
    const floor = process.platform === "win32" ? 5_000 : 2_000;
    const candidates = INTERVAL_LADDER_MS.filter((ms) => ms >= floor);
    for (const ms of candidates) {
      const samplesPerDay = 86_400_000 / ms;
      if (count * samplesPerDay * BYTES_PER_SAMPLE <= DAILY_BUDGET_BYTES) return ms;
    }
    return candidates[candidates.length - 1] ?? 60_000;
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    // A slow CIM query must not stack ticks on top of each other.
    if (this.ticking) {
      this.schedule(this.intervalMs);
      return;
    }
    this.ticking = true;
    const ts = this.now();
    try {
      const targets = this.targets();
      const running = targets.filter((target) => target.status === "running");
      const primaryCount = running.filter((target) => target.kind === "primary").length;
      const base = this.chooseInterval(primaryCount);
      this.intervalMs = this.hotEggPid !== undefined ? Math.min(base, 2_000) : base;

      const pids = new Set<number>();
      for (const target of running) for (const pid of target.pids) pids.add(pid);
      const raw = await sampleProcesses([...pids]);
      const host = sampleHost(ts);

      const processes: ProcessMetricSample[] = [];
      const eggs: EggMetricSample[] = [];
      const known = new Set(targets.map((target) => target.rootPid));
      // The watcher retires finished eggs to keep its set bounded; drop their
      // last sample too so a long session's frames do not carry every egg ever.
      for (const pid of this.lastEggs.keys()) {
        if (!known.has(pid)) this.lastEggs.delete(pid);
      }

      for (const target of targets) {
        if (target.status !== "running") {
          // An exited egg keeps its last sample so the panel can show it (and
          // the persistence layer can mark the summary exited). It is not
          // re-sampled: its pids are gone.
          const last = this.lastEggs.get(target.rootPid);
          if (last) eggs.push({ ...last, status: "exited", processCount: 0 });
          continue;
        }
        let cpuSeconds = 0;
        let rssBytes = 0;
        let processCount = 0;
        for (const pid of target.pids) {
          const sample = raw.get(pid);
          if (!sample) continue;
          processCount += 1;
          cpuSeconds += sample.cpuSeconds;
          rssBytes += sample.rssBytes;
          processes.push({
            ts,
            pid,
            ppid: sample.ppid,
            eggPid: target.rootPid,
            name: sample.name || target.name,
            cpuSeconds: sample.cpuSeconds,
            rssBytes: sample.rssBytes,
            vszBytes: sample.vszBytes,
            threads: sample.threads,
            ioReadBytes: sample.ioReadBytes,
            ioWriteBytes: sample.ioWriteBytes,
          });
        }
        if (processCount === 0) continue;
        const summary = this.updateSummary(target.rootPid, ts, cpuSeconds, rssBytes);
        const elapsed = Math.max(0.001, (summary.lastTs - summary.firstTs) / 1000);
        const egg: EggMetricSample = {
          eggPid: target.rootPid,
          name: target.name,
          kind: target.kind,
          status: target.status,
          cpuSeconds,
          rssBytes,
          processCount,
          avgCpuCoresSession: summary.samples > 1 ? (summary.cpuEnd - summary.cpuStart) / elapsed : 0,
          avgRssBytesSession: summary.samples > 1 ? summary.rssIntegral / elapsed : rssBytes,
        };
        this.lastEggs.set(target.rootPid, egg);
        eggs.push(egg);
      }

      // Exited eggs keep their last summary so the panel can still show them;
      // they are not in this frame, but the store searches backwards.
      const frame: MetricsFrame = {
        ts,
        intervalMs: this.intervalMs,
        processes,
        eggs,
        host,
        precision: "sampled",
      };
      this.ring.push(frame);
      if (this.ring.length > METRICS_RING_FRAMES) {
        this.ring.splice(0, this.ring.length - METRICS_RING_FRAMES);
      }
      this.onFrame(frame);
    } catch {
      // A failed tick is a missed sample, not a reason to stop watching.
    } finally {
      this.ticking = false;
      this.schedule(this.intervalMs);
    }
  }

  private updateSummary(eggPid: number, ts: number, cpuSeconds: number, rssBytes: number): EggSummary {
    const previous = this.summaries.get(eggPid);
    if (!previous) {
      const fresh: EggSummary = {
        firstTs: ts,
        lastTs: ts,
        prevTs: ts,
        cpuStart: cpuSeconds,
        prevCpu: cpuSeconds,
        cpuEnd: cpuSeconds,
        rssIntegral: 0,
        prevRss: rssBytes,
        samples: 1,
      };
      this.summaries.set(eggPid, fresh);
      return fresh;
    }
    const dt = Math.min(120, Math.max(0, (ts - previous.prevTs) / 1000));
    // A counter going backwards means pid reuse or a restart; treat it as a new
    // baseline rather than integrating a negative.
    if (cpuSeconds < previous.prevCpu) {
      previous.cpuStart = cpuSeconds;
      previous.cpuEnd = cpuSeconds;
      previous.prevCpu = cpuSeconds;
      previous.prevTs = ts;
      previous.lastTs = ts;
      previous.prevRss = rssBytes;
      previous.samples += 1;
      return previous;
    }
    previous.rssIntegral += previous.prevRss * dt;
    previous.prevRss = rssBytes;
    previous.prevCpu = cpuSeconds;
    previous.cpuEnd = cpuSeconds;
    previous.prevTs = ts;
    previous.lastTs = ts;
    previous.samples += 1;
    return previous;
  }
}
