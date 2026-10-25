import type { EggMetricSample, MetricsFrame, ProcessMetricSample } from "@absence/core";
import { sampleSnapshot, type RawProcessSample } from "./metricSample";
import { SYNTHETIC_PID_BASE } from "./DockerEggs";

/** One egg root and the pids that roll into it. */
export interface MetricsTarget {
  rootPid: number;
  name: string;
  kind: "agent" | "primary" | "tool";
  status: "running" | "exited";
  startedAt: number;
  pids: number[];
}

/** How many frames the live snapshot keeps (5s × 300 ≈ 25 minutes). */
export const METRICS_RING_FRAMES = 300;

/** Metrics are sampled on wall-clock 5-second boundaries. */
const SAMPLE_INTERVAL_MS = 5_000;

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
  /**
   * Counters for eggs that have no OS process behind them — a Docker
   * container's CPU and memory come from the daemon's stats stream, keyed by
   * its synthetic pid. Merged into the raw table before the per-egg fold, so
   * such an egg samples exactly like a real one.
   */
  extraSamples?: () => Map<number, RawProcessSample>;
  now?: () => number;
}

/**
 * Samples the eggs' process trees and emits a `MetricsFrame` on a cadence.
 *
 * Samples are aligned to wall-clock boundaries so every frame is at :00, :05,
 * :10, and so on. This keeps the x-axis stable across sessions and clients.
 */
export class ProcessMetricsSampler {
  private readonly targets: () => MetricsTarget[];
  private readonly onFrame: (frame: MetricsFrame) => void;
  private readonly extraSamples?: () => Map<number, RawProcessSample>;
  private readonly now: () => number;
  private readonly ring: MetricsFrame[] = [];
  private readonly summaries = new Map<number, EggSummary>();
  private readonly lastEggs = new Map<number, EggMetricSample>();
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private intervalMs = SAMPLE_INTERVAL_MS;
  private ticking = false;

  constructor(options: ProcessMetricsSamplerOptions) {
    this.targets = options.targets;
    this.onFrame = options.onFrame;
    this.extraSamples = options.extraSamples;
    this.now = options.now ?? Date.now;
  }

  /** The live frames, oldest → newest. */
  snapshot(): MetricsFrame[] {
    return [...this.ring];
  }

  get interval(): number {
    return this.intervalMs;
  }

  /** Kept for the socket protocol; selection never changes the global cadence. */
  setHotEgg(eggPid?: number): void {
    void eggPid;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.schedule(this.delayToBoundary());
  }

  start(): void {
    if (this.timer !== undefined || this.disposed) return;
    this.schedule(this.delayToBoundary());
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

  private delayToBoundary(): number {
    const remainder = this.now() % SAMPLE_INTERVAL_MS;
    return remainder === 0 ? SAMPLE_INTERVAL_MS : SAMPLE_INTERVAL_MS - remainder;
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    // A slow CIM query must not stack ticks on top of each other.
    if (this.ticking) {
      this.schedule(this.delayToBoundary());
      return;
    }
    this.ticking = true;
    const ts = Math.floor(this.now() / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS;
    try {
      const targets = this.targets();
      const running = targets.filter((target) => target.status === "running");
      this.intervalMs = SAMPLE_INTERVAL_MS;

      const pids = new Set<number>();
      for (const target of running) for (const pid of target.pids) pids.add(pid);
      // Container pids are synthetic — no OS process exists to read, and their
      // counters arrive through extraSamples. Asking the platform for them
      // would spend a CIM query every tick on pids that can never answer.
      for (const pid of pids) {
        if (pid >= SYNTHETIC_PID_BASE) pids.delete(pid);
      }
      const snapshot = await sampleSnapshot([...pids]);
      const raw = snapshot.processes;
      // Eggs with no OS process (containers) contribute their daemon-reported
      // counters here; the per-egg fold below cannot tell the difference.
      if (this.extraSamples) {
        for (const [pid, sample] of this.extraSamples()) raw.set(pid, sample);
      }
      // The frame's ts is when the sampler asked; the host counters arrived
      // with it, so they share that timestamp on the chart's x axis.
      const host = { ...snapshot.host, ts };

      const processes: ProcessMetricSample[] = [];
      const eggs: EggMetricSample[] = [];
      let agent: EggMetricSample | undefined;
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
            handles: sample.handles,
            ioReadBytes: sample.ioReadBytes,
            ioWriteBytes: sample.ioWriteBytes,
          });
        }
        if (processCount === 0) continue;
        const summary = this.updateSummary(target.rootPid, ts, cpuSeconds, rssBytes);
        const elapsed = Math.max(0.001, (summary.lastTs - summary.firstTs) / 1000);
        const sample: EggMetricSample = {
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
        if (target.kind === "agent") {
          agent = sample;
        } else {
          this.lastEggs.set(target.rootPid, sample);
          eggs.push(sample);
        }
      }

      // Exited eggs keep their last summary so the panel can still show them;
      // they are not in this frame, but the store searches backwards.
      const frame: MetricsFrame = {
        ts,
        intervalMs: this.intervalMs,
        processes,
        eggs,
        agent,
        host,
        precision: snapshot.precision,
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
      this.schedule(this.delayToBoundary());
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
