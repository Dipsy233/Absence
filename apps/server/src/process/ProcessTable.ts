import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { JobMonitor } from "./JobMonitor";
import type { WatchTableRow } from "./observer";

/** A process table is a few hundred KB on a busy machine; `ps` output too. */
const MAX_BUFFER = 32 * 1024 * 1024;

/** One process as the OS reports it. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Executable name, e.g. "node", "npm.exe". */
  name: string;
  commandLine: string;
  /**
   * The process's working directory, when the table can report it. It is the
   * evidence that scopes two same-shaped agents to different projects; the
   * PowerShell fallback and platforms without `/proc` leave it unknown.
   */
  cwd?: string;
  /** Epoch ms the OS says it started; 0 when the platform cannot say. */
  startedAt: number;
}

export type ProcessTable = Map<number, ProcInfo>;

/**
 * Snapshot every process on the machine, keyed by pid.
 *
 * On Windows the kernel observer's helper answers a `table` request over the
 * stdin channel it is already on — tens of milliseconds, no spawned process.
 * When no live helper exists (no agentwatch.exe, no rights, or one predating
 * the command) the old CIM path remains: ask PowerShell once and parse JSON.
 * Everything else comes from `ps`. Either way the read costs hundreds of
 * milliseconds at worst, which is why the watcher never calls it on the
 * agent's hot path (see ProcessWatcher).
 *
 * The snapshot command's own process tree is removed from the result: Absence
 * spawned it, and a process cannot help but observe itself. (The helper needs
 * no such trimming — it excludes its own pid and spawns nothing.)
 */
export async function snapshotProcesses(): Promise<ProcessTable> {
  if (process.platform === "win32") {
    const native = await JobMonitor.get().readTable();
    if (native && native.length > 0) return tableFromRows(native);
    const { stdout, pid } = await runCapturingPid("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_SCRIPT,
    ]);
    return dropSubtree(parseWindows(stdout), pid);
  }
  const { stdout, pid } = await runCapturingPid("ps", ["-eo", "pid=,ppid=,etimes=,args="]);
  const table = dropSubtree(parsePosix(stdout), pid);
  if (process.platform === "linux") attachLinuxCwd(table);
  return table;
}

/**
 * `/proc/<pid>/cwd` — the working directory `ps` does not print.
 *
 * Cheap (one readlink per row, same user) and the only scope evidence on Linux:
 * two default `pi` processes in different projects must not be paired with
 * each other's transcripts. A process we may not inspect keeps `cwd` unknown.
 */
function attachLinuxCwd(table: ProcessTable): void {
  for (const info of table.values()) {
    try {
      const cwd = fs.readlinkSync(`/proc/${info.pid}/cwd`);
      if (cwd.length > 0) info.cwd = trimDir(cwd);
    } catch {
      // Exited, or not ours to look at: missing evidence, not a failure.
    }
  }
}

/**
 * A working directory without its trailing separator.
 *
 * Windows reports `CurrentDirectory` as `E:\dir\`; the board, the project
 * scope and the tree all name the same place as `E:\dir`, and a row that
 * differs from every other row by one backslash looks like a different project.
 */
export function trimDir(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  // A drive root (`E:\`, `/`) keeps its separator: it is the path.
  return trimmed.length === 0 ? value : trimmed;
}

/** The helper's rows, in the shape the watcher's adoption logic reads. */
function tableFromRows(rows: WatchTableRow[]): ProcessTable {
  const table: ProcessTable = new Map();
  for (const row of rows) {
    if (!Number.isInteger(row.pid) || row.pid <= 0) continue;
    table.set(row.pid, {
      pid: row.pid,
      ppid: Number.isInteger(row.ppid) ? row.ppid : 0,
      name: row.name || "?",
      commandLine: row.commandLine ?? "",
      ...(row.cwd !== undefined ? { cwd: trimDir(row.cwd) } : {}),
      startedAt: row.startedAt ?? 0,
    });
  }
  return table;
}

/** `execFile` with the child's pid, so the caller can mute its own reflection. */
function runCapturingPid(
  file: string,
  args: string[],
): Promise<{ stdout: string; pid: number | undefined }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout, pid: child.pid });
    });
  });
}
/** Remove a pid and everything under it — our own tooling, never an egg. */
function dropSubtree(table: ProcessTable, pid: number | undefined): ProcessTable {
  if (pid === undefined) return table;
  const doomed = new Set<number>([pid]);
  // A table is a couple of hundred rows deep at most; walk until it settles.
  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const info of table.values()) {
      if (!doomed.has(info.pid) && doomed.has(info.ppid)) {
        doomed.add(info.pid);
        grew = true;
      }
    }
    if (!grew) break;
  }
  for (const pid of doomed) table.delete(pid);
  return table;
}

const WINDOWS_SCRIPT = [
  "Get-CimInstance Win32_Process",
  "| ForEach-Object { [pscustomobject]@{",
  "pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; cmd=$_.CommandLine;",
  // Ticks → epoch ms, so no date parsing or locale surprises on either side.
  "s=$(if ($_.CreationDate) { [long](([datetime]$_.CreationDate).ToUniversalTime().Ticks / 10000 - 62135596800000) } else { 0 })",
  "} }",
  "| ConvertTo-Json -Compress",
].join(" ");

interface RawRow {
  pid?: unknown;
  ppid?: unknown;
  name?: unknown;
  cmd?: unknown;
  s?: unknown;
}

function parseWindows(stdout: string): ProcessTable {
  const table: ProcessTable = new Map();
  const text = stdout.trim();
  if (text.length === 0) return table;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return table;
  }

  // ConvertTo-Json unwraps a single row into an object rather than an array.
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    const raw = row as RawRow;
    const pid = Number(raw.pid);
    const ppid = Number(raw.ppid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, {
      pid,
      ppid: Number.isInteger(ppid) ? ppid : 0,
      name: typeof raw.name === "string" ? raw.name : "?",
      commandLine: typeof raw.cmd === "string" ? raw.cmd : "",
      startedAt: Number.isFinite(Number(raw.s)) ? Number(raw.s) : 0,
    });
  }
  return table;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+|-)\s+(.*)$/;

function parsePosix(stdout: string): ProcessTable {
  const table: ProcessTable = new Map();
  const now = Date.now();
  for (const line of stdout.split("\n")) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const elapsed = Number(match[3]);
    const commandLine = match[4] ?? "";
    const executable = commandLine.split(/\s+/)[0] ?? "";
    table.set(pid, {
      pid,
      ppid: Number(match[2]),
      name: executable ? path.basename(executable) : "?",
      commandLine,
      // `etimes` is elapsed seconds — a clock, not a date, so no parsing.
      // The derived instant carries the sweep's own milliseconds, so a second
      // later it lands on a different value for the same process; round it to
      // the second, which is the resolution `etimes` actually has. Callers
      // still compare with PID_START_SLACK_MS, because a second boundary can
      // be straddled.
      startedAt: Number.isFinite(elapsed) ? Math.round((now - elapsed * 1000) / 1000) * 1000 : 0,
    });
  }
  return table;
}
