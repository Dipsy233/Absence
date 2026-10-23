import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

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
  ioReadBytes?: number;
  ioWriteBytes?: number;
}

/**
 * Read the requested pids.
 *
 * Linux reads `/proc/<pid>` directly (cheap, only the pids we care about).
 * Windows asks CIM once for the whole table and filters; the fallback is a
 * `ps` snapshot. All three return the same shape, so the sampler above never
 * branches on the platform.
 */
export async function sampleProcesses(pids: number[]): Promise<Map<number, RawProcessSample>> {
  const wanted = new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0));
  if (wanted.size === 0) return new Map();
  if (process.platform === "linux") return sampleLinux(wanted);
  if (process.platform === "win32") return sampleWindows(wanted);
  return samplePosix(wanted);
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
