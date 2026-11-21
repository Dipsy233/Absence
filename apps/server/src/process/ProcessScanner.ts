import path from "node:path";
import type { ProcInfo, ProcessTable } from "./ProcessTable";

/** Command-line evidence only: never inspect credentials or mutate an agent. */

/** Split a command line the way a shell would, quotes included. */
function tokenize(commandLine: string): string[] {
  return commandLine.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((arg) =>
    arg.replace(/^(["'])(.*)\1$/, "$2"),
  ) ?? [];
}

/** The executable/entrypoint signature of the pi coding agent itself. */
function isPiEntry(args: string[]): boolean {
  const executable = (args[0] ?? "").replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  const entry = (args[1] ?? "").replace(/\\/g, "/");
  return executable === "pi" || executable === "pi.exe" ||
    ((executable === "node" || executable === "node.exe") &&
      /\/@(?:mariozechner|earendil-works)\/pi-coding-agent\/dist\/cli\.js$/i.test(entry));
}

/** The transcript file named by `--session`, when the entry carries one. */
function piSessionArg(args: string[]): string | undefined {
  const index = args.indexOf("--session");
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith("--session="))?.slice(10);
}

/** A pi process that names its transcript on the command line. */
export function piSessionFile(info: ProcInfo): string | undefined {
  const args = tokenize(info.commandLine);
  if (!isPiEntry(args)) return undefined;
  const file = piSessionArg(args);
  // Relative paths need the process cwd, which the portable table cannot prove.
  return file && path.isAbsolute(file) ? file : undefined;
}

/**
 * A pi process that names no transcript: the default `pi` a user just typed.
 * It will write a brand-new session file, but nothing on the command line says
 * which one — the pairing is timing evidence only (see `pairDefaultSessions`)
 * and binds only when exactly one new process meets exactly one new transcript.
 */
export function defaultPiCandidates(table: ProcessTable): ProcInfo[] {
  return [...table.values()].filter((info) => {
    const args = tokenize(info.commandLine);
    return isPiEntry(args) && piSessionArg(args) === undefined;
  });
}

/** How far a process may start after the transcript appeared (clock jitter). */
const CLOCK_SLACK_MS = 2000;
/**
 * How long after a pi process started its new transcript may still appear. The
 * agent creates the session file at startup, but a prompt may lag a little;
 * beyond this window the process and the file are different stories.
 */
const DEFAULT_PAIR_WINDOW_MS = 5 * 60_000;

export interface PairingCandidateFile {
  file: string;
  /** When the transcript first appeared (birth time, or first sighting). */
  createdAt: number;
}

/**
 * Pair brand-new default-pi processes with brand-new transcripts.
 *
 * The only honest evidence for a default `pi` run is co-occurrence: the process
 * started just before the transcript was created. Both sides must be unique —
 * two pi processes running at once cannot be told apart by timing, and
 * guessing would put one agent's work on the other's board, so ambiguity binds
 * nothing at all. Returns file → pid for the pairs that qualify.
 */
export function pairDefaultSessions(
  files: readonly PairingCandidateFile[],
  candidates: readonly ProcInfo[],
  options?: { clockSlackMs?: number; windowMs?: number },
): Map<string, number> {
  const clockSlack = options?.clockSlackMs ?? CLOCK_SLACK_MS;
  const window = options?.windowMs ?? DEFAULT_PAIR_WINDOW_MS;
  const byFile = new Map<string, number[]>();
  for (const { file, createdAt } of files) {
    const pids = candidates
      .filter((info) =>
        info.startedAt > 0 &&
        info.startedAt >= createdAt - window &&
        info.startedAt <= createdAt + clockSlack)
      .map((info) => info.pid);
    if (pids.length > 0) byFile.set(file, pids);
  }
  const result = new Map<string, number>();
  for (const [file, pids] of byFile) {
    // One transcript, one process — and that process must not be a candidate
    // of any other transcript, or the pairing is a coin toss.
    const pid = pids.length === 1 ? pids[0] : undefined;
    if (pid === undefined) continue;
    const contested = [...byFile.entries()].some(
      ([other, otherPids]) => other !== file && otherPids.includes(pid),
    );
    if (contested) continue;
    result.set(file, pid);
  }
  return result;
}

/** Ambiguity is absence of attribution, never a first-match guess. */
export function findPiSession(table: ProcessTable, transcriptFile: string): ProcInfo | undefined {
  const normalize = (file: string) => {
    const resolved = path.resolve(file);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const matches = [...table.values()].filter((info) => {
    const file = piSessionFile(info);
    return file !== undefined && normalize(file) === normalize(transcriptFile);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Parent-first traversal, bounded even for malformed cyclic tables. */
export function attributedTree(table: ProcessTable, root: number): ProcInfo[] {
  const seen = new Set([root]);
  const result: ProcInfo[] = [];
  for (let index = 0, queue = [root]; index < queue.length; index++) {
    for (const info of table.values()) {
      if (info.ppid !== queue[index] || seen.has(info.pid)) continue;
      seen.add(info.pid);
      queue.push(info.pid);
      result.push(info);
    }
  }
  return result;
}
