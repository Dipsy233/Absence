/**
 * Deciding whether a process is something to watch or a throwaway tool.
 *
 * Names are not the criterion. `cat` that lives ten minutes is not a tool, and
 * `python train.py` is not one either just because `python` is common. What
 * separates them is *what the process is* — derived from the command the agent
 * submitted, where the executable came from, and how it sits in the process
 * tree — so an agent can use any tool, including one it just wrote, and the
 * classification still holds.
 *
 * The order below is the decision order. The first rule that fires wins; the
 * duration threshold is the tiebreaker, and the name list is only a prior that
 * nudges an otherwise ambiguous case.
 */

import type { CommandIntent } from "./CommandIntent";
import { hasScriptExtension, TOOL_PRIOR } from "./priors";

/** What Absence thinks a process is. */
export type ProcessKind =
  /** A process worth tracking on its own: a daemon, server, script, build root. */
  | "primary"
  /** A short-lived helper: cat, grep, sleep, git status, an inline interpreter. */
  | "tool";

export interface ClassifyInput {
  /** Basename of the executable, lowercased. */
  name: string;
  /** Full command line as the kernel reported it. */
  commandLine: string;
  /** Full image path, when the observer could resolve it. */
  exePath?: string;
  /** Working directory of the command that laid this process. */
  cwd: string;
  /** The intent of the command that laid it. */
  intent: CommandIntent;
  /** True when the process is still alive after its command returned. */
  survivedCommand: boolean;
  /** Milliseconds the process has lived so far (0 while still young). */
  ageMs: number;
  /** Number of direct/indirect children folded into it. */
  children: number;
  /** The pid of the process that started it. */
  ppid: number;
  /** The pid of the shell Absence drove for this command, when known. */
  shellPid?: number;
}

export interface ClassifyResult {
  kind: ProcessKind;
  /** Why, for the UI's tooltip and for tests. */
  reason: string;
}

/** Directories whose contents are tools by provenance, not by name. */
const TOOL_DIRS = [
  "\\windows\\system32\\",
  "\\windows\\syswow64\\",
  "\\git\\usr\\bin\\",
  "\\git\\mingw64\\bin\\",
  "\\git\\cmd\\",
  "\\nodejs\\",
  "\\nvm\\",
  "\\python",
  "\\program files\\git\\usr\\bin\\",
  // POSIX paths, in the same backslash-normalised form (see normalizePath).
  "\\usr\\bin\\",
  "\\usr\\sbin\\",
  "\\usr\\local\\bin\\",
  "\\usr\\local\\sbin\\",
  "\\bin\\",
  "\\sbin\\",
  "\\opt\\",
];

/** Toolchain entry points that are launchers even from a project directory. */
const TOOL_LAUNCHERS = new Set([
  "cmd.exe",
  "cmd",
  "conhost.exe",
  "where.exe",
  "which",
  "where",
  "type",
  "tasklist.exe",
]);

/** How long a quiet, childless, side-effect-free process may live and still be a tool. */
export const TOOL_AGE_MS = 2000;

/**
 * Below this lifetime a process is a helper by *shape* alone: nothing that is a
 * daemon or a build finishes this fast. Measured from the OS start and exit
 * times, so no directory or name list is involved.
 */
export const EPHEMERAL_MS = 300;

function normalizePath(value: string): string {
  return value.toLowerCase().replace(/\//g, "\\");
}

/** True when the executable's directory marks it as an installed tool. */
function isFromToolDirectory(exePath: string | undefined): boolean {
  if (!exePath) return false;
  const normalized = normalizePath(exePath);
  return TOOL_DIRS.some((dir) => normalized.includes(dir));
}

/** True when a path lies inside the working directory. */
function isInWorkspace(path: string | undefined, cwd: string): boolean {
  if (!path) return false;
  const p = normalizePath(path);
  const c = normalizePath(cwd).replace(/\\+$/, "");
  return p.startsWith(`${c}\\`) || p === c;
}

/**
 * True when this process is one the command declared as a subject.
 *
 * Two shapes qualify:
 *  - the executable *is* the subject (`./daemon.sh` runs a process named
 *    `daemon.sh`, `npm run dev` runs `npm`);
 *  - the executable is an interpreter running the subject script
 *    (`node server.js` runs `node.exe`, whose command line names `server.js`).
 *
 * The second shape matches on a whole-token boundary, not a substring, so a
 * command that merely mentions a name elsewhere does not promote an unrelated
 * process.
 */
function matchesSubject(input: ClassifyInput): boolean {
  const name = input.name.toLowerCase();
  const tokens = new Set(
    input.commandLine
      .toLowerCase()
      .split(/[\s"']+/)
      .map((t) => t.replace(/^[./\\]+/, ""))
      .filter(Boolean),
  );
  for (const subject of input.intent.subjects) {
    if (subject.name === name) return true;
    const bare = subject.name.replace(/^[./\\]+/, "");
    const pathBare = subject.path.toLowerCase().replace(/^[./\\]+/, "");
    if (tokens.has(bare) || tokens.has(pathBare)) return true;
  }
  return false;
}

/**
 * Classify one process. See the module comment for the decision order.
 *
 * Callers run this twice: once when the process appears (young), and again when
 * it either exits or outlives its command (mature). A process that looked like a
 * tool when young may be promoted once it survives.
 */
export function classifyProcess(input: ClassifyInput): ClassifyResult {
  const name = input.name.toLowerCase();

  // 1. A structure that no tool has: it outlived the command that laid it, or it
  //    is running a loop of other processes. Either is a primary, whatever the
  //    name says.
  if (input.survivedCommand) {
    return { kind: "primary", reason: "outlived its command" };
  }
  if (input.children > 0) {
    return { kind: "primary", reason: "spawns its own processes" };
  }

  // 2. The command said so: this process *is* one of its subjects —
  //    `./daemon.sh`, `python train.py`, `.\run.ps1`. That is what the command
  //    is about, so it is tracked whatever its name.
  if (matchesSubject(input)) {
    return { kind: "primary", reason: "named by the command" };
  }

  // 3. Daemon intent, before provenance: a process the command itself
  //    backgrounded or detached is tracked even if its launcher happens to live
  //    in a tool directory — `bash daemon.sh &` runs bash from Git\usr\bin, and
  //    that bash *is* the daemon. Only a subject the command explicitly marked
  //    with `&` or a file redirect qualifies, so a plain `cat` alongside it is
  //    untouched.
  if (backgroundedSubject(input)) {
    if (!TOOL_LAUNCHERS.has(name)) {
      return { kind: "primary", reason: "backgrounded and redirected" };
    }
  }

  // 4. Provenance: an installed utility running from a tool directory is a tool.
  //    It has no children (rule 1) and the command did not background it
  //    (rule 3), so it can only be a helper the command ran along the way —
  //    `sleep 3`, `cat log`, `grep …`. Its *lifetime* is irrelevant here: a
  //    three-second `sleep` is still a sleep, and a ten-minute one would have
  //    been promoted by rule 1 the moment it outlived the command.
  if (isFromToolDirectory(input.exePath)) {
    return { kind: "tool", reason: "installed tool" };
  }

  // 5. Provenance the other way: code running from the workspace is the
  //    project's own, so it is tracked.
  if (isInWorkspace(input.exePath, input.cwd)) {
    return { kind: "primary", reason: "runs from the workspace" };
  }

  // 6. Ephemeral by structure: it was gone almost as soon as it appeared, it
  //    started nothing of its own, and it is not a subject the command named. A
  //    process with that shape is a helper whatever its name and wherever it
  //    lives — `fd.exe` in Pi's own bin directory, `getprocaddr64.exe` in Git's
  //    libexec — so no directory list has to be kept in step with every tool an
  //    agent might use. A named subject is excluded above (rule 2), and a
  //    daemon that outlived its command is caught by rule 1.
  if (input.ageMs > 0 && input.ageMs < EPHEMERAL_MS) {
    return { kind: "tool", reason: "ephemeral helper" };
  }

  // 7. Tool by shape: a name that is usually a tool, with no children and no
  //    daemon intent. `ageMs` of 0 means "just appeared", which counts as young.
  if (input.ageMs < TOOL_AGE_MS && TOOL_PRIOR.has(name)) {
    return { kind: "tool", reason: "short-lived helper" };
  }

  // 8. Nothing decisive. Default to primary so an unknown process is not hidden;
  //    the caller promotes on survival anyway.
  return { kind: "primary", reason: "unclassified" };
}

/**
 * True when this process is a subject the command explicitly backgrounded or
 * redirected. This is what separates the `daemon.sh` in
 * `./daemon.sh > log &` from the `cat` in `./daemon.sh > log & … ; cat log`:
 * only the daemon carries the intent.
 */
function backgroundedSubject(input: ClassifyInput): boolean {
  const commandLine = input.commandLine.toLowerCase();
  for (const subject of input.intent.subjects) {
    if (!subject.background && !subject.redirected) continue;
    const name = subject.name;
    if (input.name.toLowerCase() === name) return true;
    if (name.length > 0 && commandLine.includes(name)) return true;
    const path = subject.path.toLowerCase().replace(/^\.\//, "");
    if (path.length > 1 && commandLine.includes(path)) return true;
  }
  return false;
}

export { isToolPrior } from "./priors";
