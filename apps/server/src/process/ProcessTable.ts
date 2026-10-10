import { execFile } from "node:child_process";
import path from "node:path";

/** A process table is a few hundred KB on a busy machine; `ps` output too. */
const MAX_BUFFER = 32 * 1024 * 1024;

/** One process as the OS reports it. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Executable name, e.g. "node", "npm.exe". */
  name: string;
  commandLine: string;
  /** Epoch ms the OS says it started; 0 when the platform cannot say. */
  startedAt: number;
}

export type ProcessTable = Map<number, ProcInfo>;

/**
 * Snapshot every process on the machine, keyed by pid.
 *
 * Windows has no cheap way to get parent pid *and* command line together, so we
 * ask CIM once and parse JSON; everything else comes from `ps`. Either way this
 * costs a few hundred ms, which is why the watcher never calls it on the agent's
 * hot path (see ProcessWatcher).
 *
 * The snapshot command's own process tree is removed from the result: Absence
 * spawned it, and a process cannot help but observe itself.
 */
export async function snapshotProcesses(): Promise<ProcessTable> {
  if (process.platform === "win32") {
    const { stdout, pid } = await runCapturingPid("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_SCRIPT,
    ]);
    return dropSubtree(parseWindows(stdout), pid);
  }
  const { stdout, pid } = await runCapturingPid("ps", ["-eo", "pid=,ppid=,etimes=,args="]);
  return dropSubtree(parsePosix(stdout), pid);
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
      startedAt: Number.isFinite(elapsed) ? now - elapsed * 1000 : 0,
    });
  }
  return table;
}
