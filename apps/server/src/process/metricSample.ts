import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { JobMonitor } from "./JobMonitor";
import type { WatchHostMetric } from "./observer";

const run = promisify(execFile);

/** A process table is a few hundred KB; CIM JSON can be larger. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** One process as the OS reports it. */
export interface RawProcessSample {
  pid: number;
  ppid: number;
  name: string;
  /** Cumulative CPU time in seconds. */
  cpuSeconds: number;
  rssBytes: number;
  vszBytes?: number;
  threads?: number;
  handles?: number;
  ioReadBytes?: number;
  ioWriteBytes?: number;
}

/** Host counters in the shape the frame carries. */
export interface RawHostSample {
  ts: number;
  cpuSeconds: number;
  cpuIdleSeconds: number;
  cpuCount: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  load1?: number;
}

/** One sampling pass: the processes plus the host context they ran in. */
export interface RawSample {
  processes: Map<number, RawProcessSample>;
  host: RawHostSample;
  /**
   * `exact` when a kernel helper answered from handles it already holds,
   * `sampled` when the numbers came from reading the process table.
   */
  precision: "exact" | "sampled";
}

/**
 * Read the requested pids, preferring the native path.
 *
 * On Windows the process observer already holds a handle per process, so one
 * "sample" round-trip to `agentwatch` yields CPU, RSS, threads, handles and IO
 * for every pid at once — no CIM query, no process-table enumeration. When that
 * is unavailable (Linux, a helper predating sampling, a restart in progress)
 * we read `/proc`, or ask CIM once and filter, or run `ps`. Every path returns
 * the same shape, so the sampler never branches on the platform.
 */
export async function sampleSnapshot(pids: number[]): Promise<RawSample> {
  const wanted = new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0));
  const native =
    wanted.size > 0 ? await JobMonitor.get().sampleMetrics([...wanted]) : undefined;
  if (native) {
    const processes = new Map<number, RawProcessSample>();
    for (const [pid, metric] of native.processes) {
      if (!wanted.has(pid)) continue;
      processes.set(pid, {
        pid,
        ppid: 0,
        name: "",
        cpuSeconds: metric.cpuMs / 1000,
        rssBytes: metric.rssBytes,
        vszBytes: metric.vszBytes,
        threads: metric.threads,
        handles: metric.handles,
        ioReadBytes: metric.ioReadBytes,
        ioWriteBytes: metric.ioWriteBytes,
      });
    }
    // The helper only samples processes it opened a handle for. A pid it never
    // saw (a tree that predates the observer, an observed agent that is not in
    // our job) falls back to the table — but only when the native pass covered
    // little enough of the set that reading the table is worth half a second.
    const missing = [...wanted].filter((pid) => !processes.has(pid));
    let usedFallback = false;
    if (processes.size === 0 || processes.size * 2 < wanted.size) {
      usedFallback = missing.length > 0;
      const fallback = await platformSample(new Set(missing));
      for (const [pid, sample] of fallback) processes.set(pid, sample);
    }
    return {
      processes,
      host: native.host ? hostFromNative(native.host) : sampleHost(Date.now()),
      // "exact" only when the values really came from the helper's handles; a
      // native pass that missed the tree (an observed agent before the borrow
      // round-trip lands) is a table read.
      precision: usedFallback ? "sampled" : "exact",
    };
  }
  const processes = wanted.size === 0 ? new Map<number, RawProcessSample>() : await platformSample(wanted);
  return { processes, host: sampleHost(Date.now()), precision: "sampled" };
}

/** The platform's own table read, used when no native pass answered. */
function platformSample(wanted: Set<number>): Promise<Map<number, RawProcessSample>> {
  if (wanted.size === 0) return Promise.resolve(new Map());
  if (process.platform === "linux") return sampleLinux(wanted);
  if (process.platform === "win32") return sampleWindows(wanted);
  return samplePosix(wanted);
}

function hostFromNative(host: WatchHostMetric): RawHostSample {
  return {
    ts: Date.now(),
    // Windows' kernel time includes idle; the same convention as /proc-free
    // os.cpus() summation above.
    cpuSeconds: host.cpuMs / 1000,
    cpuIdleSeconds: host.idleMs / 1000,
    cpuCount: Math.max(1, host.cores),
    memTotalBytes: host.memTotalBytes,
    memAvailableBytes: host.memAvailableBytes,
  };
}

/* ── Linux: /proc ───────────────────────────────────────────────────────── */

/** Linux USER_HZ. 100 on every mainstream architecture Absence ships on. */
const CLK_TCK = 100;
const PAGE_SIZE = 4096;

async function sampleLinux(wanted: Set<number>): Promise<Map<number, RawProcessSample>> {
  const out = new Map<number, RawProcessSample>();
  await Promise.all(
    [...wanted].map(async (pid) => {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        if (close < 0) return;
        const name = stat.slice(stat.indexOf("(") + 1, close);
        const fields = stat.slice(close + 2).split(" ");
        // fields[0] is field 3 (state); utime is field 14 → index 11.
        const ppid = numberAt(fields, 1);
        const utime = numberAt(fields, 11);
        const stime = numberAt(fields, 12);
        const threads = numberAt(fields, 17) || undefined;
        const vsz = numberAt(fields, 20) || undefined;
        const rssPages = numberAt(fields, 21);
        let ioReadBytes: number | undefined;
        let ioWriteBytes: number | undefined;
        try {
          const io = await fs.readFile(`/proc/${pid}/io`, "utf8");
          for (const line of io.split("\n")) {
            if (line.startsWith("read_bytes:")) ioReadBytes = Number(line.slice(11).trim());
            else if (line.startsWith("write_bytes:")) ioWriteBytes = Number(line.slice(12).trim());
          }
        } catch {
          // IO accounting is optional (kernel config, permissions).
        }
        out.set(pid, {
          pid,
          ppid,
          name,
          cpuSeconds: (utime + stime) / CLK_TCK,
          rssBytes: Math.max(0, rssPages) * PAGE_SIZE,
          vszBytes: vsz,
          threads,
          ioReadBytes,
          ioWriteBytes,
        });
      } catch {
        // The process exited between the watcher's report and this read.
      }
    }),
  );
  return out;
}

function numberAt(values: string[], index: number): number {
  const n = Number(values[index]);
  return Number.isFinite(n) ? n : 0;
}

/* ── Windows: one CIM query ─────────────────────────────────────────────── */

const WINDOWS_SCRIPT = [
  "Get-CimInstance Win32_Process",
  "| Select-Object ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime,WorkingSetSize,VirtualSize,ThreadCount",
  "| ConvertTo-Json -Compress",
].join(" ");

interface WindowsRow {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  Name?: unknown;
  KernelModeTime?: unknown;
  UserModeTime?: unknown;
  WorkingSetSize?: unknown;
  VirtualSize?: unknown;
  ThreadCount?: unknown;
}

async function sampleWindows(wanted: Set<number>): Promise<Map<number, RawProcessSample>> {
  const out = new Map<number, RawProcessSample>();
  let stdout: string;
  try {
    ({ stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], {
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    }));
  } catch {
    return out;
  }
  const text = stdout.trim();
  if (!text) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const value of rows) {
    const row = value as WindowsRow;
    const pid = Number(row.ProcessId);
    if (!wanted.has(pid)) continue;
    // Win32_Process reports 100ns units; the counter we expose is seconds.
    const cpuSeconds = (Number(row.KernelModeTime ?? 0) + Number(row.UserModeTime ?? 0)) / 10_000_000;
    out.set(pid, {
      pid,
      ppid: Number(row.ParentProcessId ?? 0),
      name: typeof row.Name === "string" ? row.Name : "?",
      cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : 0,
      rssBytes: Math.max(0, Number(row.WorkingSetSize ?? 0)),
      vszBytes: Number(row.VirtualSize ?? 0) || undefined,
      threads: Number(row.ThreadCount ?? 0) || undefined,
    });
  }
  return out;
}

/* ── POSIX fallback: ps ─────────────────────────────────────────────────── */

async function samplePosix(wanted: Set<number>): Promise<Map<number, RawProcessSample>> {
  const out = new Map<number, RawProcessSample>();
  let stdout: string;
  try {
    ({ stdout } = await run("ps", ["-eo", "pid=,ppid=,time=,rss=,vsz="], {
      maxBuffer: MAX_BUFFER,
    }));
  } catch {
    return out;
  }
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const pid = Number(parts[0]);
    if (!wanted.has(pid)) continue;
    out.set(pid, {
      pid,
      ppid: Number(parts[1] ?? 0),
      name: "",
      cpuSeconds: parsePsTime(parts[2] ?? "0"),
      rssBytes: Math.max(0, Number(parts[3] ?? 0)) * 1024,
      vszBytes: Math.max(0, Number(parts[4] ?? 0)) * 1024,
    });
  }
  return out;
}

/** `[[dd-]hh:]mm:ss` → seconds. */
function parsePsTime(value: string): number {
  let days = 0;
  let rest = value;
  const dash = rest.indexOf("-");
  if (dash >= 0) {
    days = Number(rest.slice(0, dash)) || 0;
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":").map((part) => Number(part) || 0);
  let seconds = days * 86_400;
  if (parts.length === 3) seconds += parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  else if (parts.length === 2) seconds += parts[0]! * 60 + parts[1]!;
  else seconds += parts[0] ?? 0;
  return seconds;
}

/* ── Host ───────────────────────────────────────────────────────────────── */

export function sampleHost(ts: number): {
  ts: number;
  cpuSeconds: number;
  cpuIdleSeconds: number;
  cpuCount: number;
  memTotalBytes: number;
  memAvailableBytes: number;
  load1?: number;
} {
  const cpus = os.cpus();
  let cpuMs = 0;
  let idleMs = 0;
  for (const cpu of cpus) {
    cpuMs += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    idleMs += cpu.times.idle;
  }
  return {
    ts,
    cpuSeconds: cpuMs / 1000,
    cpuIdleSeconds: idleMs / 1000,
    cpuCount: cpus.length || 1,
    memTotalBytes: os.totalmem(),
    memAvailableBytes: os.freemem(),
    load1: os.loadavg()[0],
  };
}
