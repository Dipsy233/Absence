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
      // pi ships its CLI in different places depending on package/build:
      //   dist/cli.js          (older / unbundled builds)
      //   dist/bundle/cli.js   (npm `bin: pi`, v1.6+)
      //   dist/bun/cli.js      (compiled build source)
      // Allow one optional sub-directory under `dist/` so a layout change in
      // the agent's own build does not silently blind process detection.
      /\/@(?:mariozechner|earendil-works)\/pi-coding-agent\/dist\/(?:[^/]+\/)?cli\.js$/i.test(entry));
}

/** The transcript file named by `--session`, when the entry carries one. */
function piSessionArg(args: string[]): string | undefined {
  const index = args.indexOf("--session");
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith("--session="))?.slice(10);
}

/**
 * What `--session` named, when the command line carries one.
 *
 *   - a *path*: the transcript to resume (`pi --session <file>`), so the
 *     process is bound to it outright;
 *   - an *id*: the session to resume by identifier (`pi --session <id>`), which
 *     names no file — the transcript it writes carries that id in its header,
 *     and the board resolves it from there.
 */
export interface PiSessionRef {
  /** The argument verbatim. */
  raw: string;
  /** The transcript file, when the argument was a path. */
  file?: string;
  /** The session id, when the argument was an identifier rather than a path. */
  id?: string;
}

export function piSessionRef(info: ProcInfo): PiSessionRef | undefined {
  const args = tokenize(info.commandLine);
  if (!isPiEntry(args)) return undefined;
  const raw = piSessionArg(args);
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  const file = stripDevicePrefix(value);
  // A path is absolute; anything else is a session identifier. A relative path
  // cannot be resolved without the process cwd, so it is not evidence either.
  return path.isAbsolute(file) ? { raw, file } : { raw, id: value };
}

/**
 * Windows lets a caller name a path with an extended-length prefix
 * (`\\?\C:\…`, `\\.\C:\…`, `\\?\UNC\server\share`). pi uses it when it
 * resumes a long session file, and `path.resolve` would treat the prefixed
 * string as relative and glue the cwd's drive onto it — so the process would
 * never match the file the watcher reports. The prefix is transport detail;
 * the path is what follows it.
 */
function stripDevicePrefix(value: string): string {
  if (process.platform !== "win32") return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\")) return value.slice(4);
  return value;
}

/** A pi process that names its transcript on the command line. */
export function piSessionFile(info: ProcInfo): string | undefined {
  return piSessionRef(info)?.file;
}

/**
 * A pi process that names no transcript: the default `pi` a user just typed.
 * It will write a brand-new session file, but nothing on the command line says
 * which one — the pairing is timing evidence only (see `pairDefaultSessions`).
 */
export function defaultPiCandidates(table: ProcessTable): ProcInfo[] {
  return [...table.values()].filter((info) => {
    const args = tokenize(info.commandLine);
    return isPiEntry(args) && piSessionArg(args) === undefined;
  });
}

/**
 * Every pi process whose transcript is not provable from its command line.
 *
 * That is a default `pi` (no `--session` at all) *and* a `pi` resumed by id
 * (`--session <id>`): both write a session file the command line does not name,
 * so both are listed on the board and both are eligible for binding — by the
 * id in the transcript header, or by project `cwd` and latest write. Using the
 * narrower "no `--session`" set hid an id-resumed agent from the board
 * entirely, which reads as "only one of my three pi processes was found".
 */
export function unboundPiCandidates(table: ProcessTable): ProcInfo[] {
  return [...table.values()].filter((info) => {
    const args = tokenize(info.commandLine);
    return isPiEntry(args) && piSessionRef(info)?.file === undefined;
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
  /**
   * When the transcript was last written (mtime). This is the live evidence:
   * a process that resumed another session writes *that* file, and its old
   * file goes quiet. Omitted when the caller has only the birth time.
   */
  lastActivityAt?: number;
  /** The project the transcript belongs to (its header's `cwd`). */
  cwd?: string;
}

/** Compare two absolute paths the way the platform does. */
function sameScope(a: string, b: string): boolean {
  const resolve = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return resolve(a) === resolve(b);
}

/**
 * Pair default-pi processes with transcripts.
 *
 * The first evidence is co-occurrence: the process started just before the
 * transcript was created. But a default `pi` is long-lived and can resume a
 * different session mid-run (`-c`, the in-app resume picker), after which it
 * appends to a file that predates it and the file born at startup goes quiet.
 * Treating the startup pairing as permanent put the wrong conversation on the
 * board: the running row showed the old file while the live one sat in
 * history. So when a file's last write is known, a process is also eligible
 * for any transcript written while it ran, and among its eligible files only
 * the most recently written one can be its current session.
 *
 * Both sides must still be unique: two pi processes running at once cannot be
 * told apart by timing, and guessing would put one agent's work on the
 * other's board, so ambiguity binds nothing at all. Returns file → pid.
 */
export function pairDefaultSessions(
  files: readonly PairingCandidateFile[],
  candidates: readonly ProcInfo[],
  options?: { clockSlackMs?: number; windowMs?: number },
): Map<string, number> {
  const clockSlack = options?.clockSlackMs ?? CLOCK_SLACK_MS;
  const window = options?.windowMs ?? DEFAULT_PAIR_WINDOW_MS;

  // (file, process) pairs with the strength of the evidence: the transcript's
  // last write when known, otherwise its birth. A stronger claim is a later
  // one, because a process writes its current session last.
  const candidatesByFile = new Map<string, { pid: number; strength: number }[]>();
  for (const { file, createdAt, lastActivityAt, cwd } of files) {
    const eligible = candidates.filter((info) => {
      if (info.startedAt <= 0) return false;
      // Two agents running at once cannot be told apart by timing, but their
      // projects can: a process only ever writes its own project's transcript.
      // When either side's directory is unknown, scope is not evidence.
      if (cwd !== undefined && info.cwd !== undefined && !sameScope(cwd, info.cwd)) return false;
      const bornWithProcess =
        info.startedAt >= createdAt - window && info.startedAt <= createdAt + clockSlack;
      // The process kept writing a file that existed before it started: the
      // session was resumed inside this process.
      const writtenByProcess = lastActivityAt !== undefined && lastActivityAt >= info.startedAt;
      return bornWithProcess || writtenByProcess;
    });
    if (eligible.length > 0) {
      const strength = lastActivityAt ?? createdAt;
      candidatesByFile.set(file, eligible.map((info) => ({ pid: info.pid, strength })));
    }
  }

  // One process writes one session at a time: keep only its latest file.
  // A tie between equally recent files is ambiguity, not a coin toss.
  const latestByPid = new Map<number, { file: string; strength: number }[]>();
  for (const [file, entries] of candidatesByFile) {
    for (const { pid, strength } of entries) {
      const list = latestByPid.get(pid) ?? [];
      list.push({ file, strength });
      latestByPid.set(pid, list);
    }
  }
  const current = new Map<string, number[]>();
  for (const [pid, entries] of latestByPid) {
    const latest = Math.max(...entries.map((entry) => entry.strength));
    const best = entries.filter((entry) => entry.strength === latest);
    const winner = best.length === 1 ? best[0] : undefined;
    if (winner === undefined) continue;
    const list = current.get(winner.file) ?? [];
    list.push(pid);
    current.set(winner.file, list);
  }

  const result = new Map<string, number>();
  for (const [file, pids] of current) {
    // One transcript, one process: a file claimed twice is a coin toss too.
    const [pid] = pids;
    if (pids.length === 1 && pid !== undefined) result.set(file, pid);
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
