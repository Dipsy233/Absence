/**
 * What a shell command *intends*, read from the command text the agent submitted.
 *
 * This is the strongest signal Daze has for telling a real process from a
 * throwaway tool, and it costs nothing but a string parse: Daze owns the shell,
 * so every command is in hand before it runs. The point is not to implement a
 * shell grammar — it is to pull out the few facts that separate a daemon from a
 * `cat`:
 *
 *  - the **subjects**: programs or scripts the command runs directly, such as
 *    `./daemon.sh`, `python train.py`, `.\run.ps1`. An interpreter is not a
 *    subject; the script path after it is.
 *  - whether a subject was **backgrounded** (`&`, `start`, `Start-Process`).
 *  - whether output was **redirected to a file or to null** (`> x.log`,
 *    `> /dev/null`, `> NUL`), which is how a daemon detaches from the session.
 *
 * A process that matches a subject is a candidate primary; everything else is a
 * candidate tool. The subjects are computed per command, so no name list is
 * involved and an agent can use any tool it likes.
 */

import { hasScriptExtension, isToolPrior } from "./priors";

/** One program or script the command runs directly. */
export interface CommandSubject {
  /** Basename as written, lowercased: `daemon.sh`, `train.py`, `run.ps1`. */
  name: string;
  /** Full token as written, for path checks: `./daemon.sh`, `C:\x\run.ps1`. */
  path: string;
  /** True when this subject was launched in the background. */
  background: boolean;
  /** True when this subject's output goes to a file or to null. */
  redirected: boolean;
}

export interface CommandIntent {
  subjects: CommandSubject[];
  /** True when anything in the command was backgrounded. */
  hasBackground: boolean;
  /** True when anything in the command redirected its output away from the pipe. */
  hasRedirection: boolean;
}

/** Interpreters: when one runs a script path, the *script* is the subject. */
const INTERPRETERS = new Set([
  "python",
  "python3",
  "py",
  "node",
  "node.exe",
  "deno",
  "bun",
  "ruby",
  "perl",
  "php",
  "bash",
  "sh",
  "zsh",
  "dash",
  "pwsh",
  "pwsh.exe",
  "powershell",
  "powershell.exe",
  "cmd",
  "cmd.exe",
]);

/** Launchers that mean "run this in the background" on Windows. */
const BACKGROUND_WORDS = new Set(["start", "start-process", "start-job"]);

/** Fields whose inline-code argument makes an interpreter a tool, not a subject. */
const INLINE_FLAGS = new Set(["-c", "-e", "-command", "-encodedcommand", "/c", "/k"]);

/** Shell operators that never introduce a subject on their own. */
const NOISE = new Set([
  "&&",
  "||",
  "&",
  ";",
  "|",
  "(",
  ")",
  "{",
  "}",
  "<",
  ">",
  ">>",
  "2>",
  "2>>",
  "1>",
  "1>>",
  "|&",
]);

/**
 * Tokens that, when they appear as a command's first word, do not name a program
 * (they are shell builtins or control words). A command starting with one of
 * these has no subject of its own.
 */
const BUILTINS = new Set([
  "echo",
  "cd",
  "export",
  "set",
  "unset",
  "if",
  "then",
  "else",
  "fi",
  "for",
  "while",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "return",
  "read",
  "shift",
  "trap",
  "local",
  "let",
  "printf",
  "test",
  "true",
  "false",
  "kill",
  "wait",
  "exit",
  "source",
  ".",
  ":",
  "eval",
  "exec",
  "time",
  "nohup",
  "sudo",
  "env",
]);

/**
 * Split a command into shell-ish tokens. Not a parser: quotes and escapes are
 * resolved only far enough to keep paths intact, and operators are separated so
 * a subject can be recognised at the start of each segment.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      // A backslash escapes the next character (also the path separator on
      // Windows — keep it, the shell does too outside quotes).
      current += ch + command[i + 1];
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (current) tokens.push(current);
      current = "";
      tokens.push(";");
      continue;
    }
    if (ch === " ") {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    // Two-character operators first.
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === ">>" || two === "2>" || two === "1>") {
      if (current) tokens.push(current);
      current = "";
      if (two === "2>" && command.slice(i, i + 3) === "2>>") {
        tokens.push("2>>");
        i += 2;
      } else {
        tokens.push(two);
        i++;
      }
      continue;
    }
    if (ch === "|" || ch === "&" || ch === ";") {
      if (current) tokens.push(current);
      current = "";
      tokens.push(ch);
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** The basename of a path, without a trailing `\` or `/`. */
function basename(token: string): string {
  const trimmed = token.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return (index >= 0 ? trimmed.slice(index + 1) : trimmed).toLowerCase();
}

/** True when a token looks like a program or script to run, not an option/argument. */
function looksRunnable(token: string): boolean {
  if (!token) return false;
  if (NOISE.has(token)) return false;
  if (token.startsWith("-") || token.startsWith("/")) return false;
  // A redirection target is not a program.
  if (token.startsWith(">") || token.startsWith("<")) return false;
  return true;
}

/** True when this segment's redirect target is a file or null, not a pipe. */
function isDetachedRedirect(token: string): boolean {
  const lower = token.toLowerCase();
  if (lower === "/dev/null" || lower === "nul" || lower === "$null") return true;
  // Anything else written to is a file, which detaches the process.
  return !lower.startsWith("&");
}

/**
 * Read a command's intent: its subjects, and whether any part of it was
 * backgrounded or redirected.
 *
 * Handles the shapes an agent actually emits: `./daemon.sh &`,
 * `python train.py > train.log`, `powershell -File run.ps1`,
 * `npm run dev -- --port 3000 &`, and pipelines such as `cat x | grep y`.
 */
export function parseCommandIntent(command: string): CommandIntent {
  const tokens = tokenize(command);
  const subjects: CommandSubject[] = [];
  let hasBackground = false;
  let hasRedirection = false;

  /** State for the segment currently being read. */
  let expectProgram = true;
  let segmentBackground = false;
  let segmentRedirect = false;
  let pendingSubjectIndex = -1;
  let lastProgram: string | undefined;

  const flushSubject = (): void => {
    if (pendingSubjectIndex < 0) return;
    const subject = subjects[pendingSubjectIndex];
    if (subject) {
      subject.background = segmentBackground;
      subject.redirected = segmentRedirect;
    }
    pendingSubjectIndex = -1;
  };

  const endSegment = (): void => {
    flushSubject();
    expectProgram = true;
    if (segmentBackground) hasBackground = true;
    if (segmentRedirect) hasRedirection = true;
    segmentBackground = false;
    segmentRedirect = false;
    lastProgram = undefined;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    const lower = token.toLowerCase();

    // A background operator applies to the segment just finished.
    if (lower === "&") {
      segmentBackground = true;
      endSegment();
      continue;
    }
    if (lower === "&&" || lower === "||" || lower === ";" || lower === "|" || lower === "|&") {
      endSegment();
      continue;
    }

    // Redirection: the next token is the target.
    if (lower === ">" || lower === ">>" || lower === "1>" || lower === "1>>" || lower === "2>" || lower === "2>>") {
      const target = tokens[i + 1];
      if (target !== undefined) {
        if (isDetachedRedirect(target)) segmentRedirect = true;
        i++;
      }
      continue;
    }
    if (lower.startsWith(">")) {
      // Attached form: `>out.log`.
      if (isDetachedRedirect(token.slice(1))) segmentRedirect = true;
      continue;
    }

    if (expectProgram) {
      if (BUILTINS.has(lower)) {
        // A builtin produces no process of its own; the rest of the segment may
        // still contain a subject (for example `nohup ./x &` is handled above,
        // `time ./x` is not a program launch worth subject-ing).
        expectProgram = false;
        continue;
      }
      if (BACKGROUND_WORDS.has(lower)) {
        // `start`, `Start-Process`, `start-job`: whatever follows runs detached.
        segmentBackground = true;
        // Keep expecting a program: the next runnable token is the subject.
        continue;
      }
      if (!looksRunnable(token)) continue;
      const name = basename(token);
      if (INTERPRETERS.has(name)) {
        // The interpreter is not the subject; the script it runs may be.
        lastProgram = name;
        expectProgram = false;
        continue;
      }
      // A tool the prior knows (cat, grep, ls) is never a subject on its own:
      // it is one of the helpers this very classification is meant to fold away.
      // A path or a script extension still earns a subject entry, so a project
      // script that happens to share a tool's name is not lost.
      if (isToolPrior(name) && !token.includes("\\") && !token.includes("/") && !hasScriptExtension(name)) {
        expectProgram = false;
        continue;
      }
      subjects.push({ name, path: token, background: false, redirected: false });
      pendingSubjectIndex = subjects.length - 1;
      expectProgram = false;
      continue;
    }

    // Not the first word: an interpreter's script argument is the subject.
    if (lastProgram && pendingSubjectIndex < 0) {
      if (lower.startsWith("-")) {
        // An interpreter flag. `-c`/`-Command`/`-EncodedCommand` mean the code
        // is inline, so the interpreter is a tool and nothing here is a subject.
        if (INLINE_FLAGS.has(lower)) lastProgram = undefined;
        continue;
      }
      const name = basename(token);
      // A script path after the interpreter: `python train.py`, `-File run.ps1`,
      // `bash daemon.sh`. A bare word (`python -m mod`, `python foo`) is not.
      if (hasScriptExtension(name) || token.includes("\\") || token.includes("/")) {
        subjects.push({ name, path: token, background: false, redirected: false });
        pendingSubjectIndex = subjects.length - 1;
      }
      lastProgram = undefined;
    }
  }
  endSegment();

  return { subjects, hasBackground, hasRedirection };
}
