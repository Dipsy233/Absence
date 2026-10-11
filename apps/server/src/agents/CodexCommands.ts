/**
 * Codex's own view of a command, read from the app-server protocol.
 *
 * Codex already parses every shell command it runs — it needs the parse for
 * approvals and the TUI — and it hands the result to observers on the command
 * item itself:
 *
 *   item.commandActions: [
 *     { type: "read",      command, name, path },   // path is cwd-resolved
 *     { type: "listFiles", command, path },
 *     { type: "search",    command, query, path },
 *     { type: "unknown",   command },
 *   ]
 *
 * (`CommandAction` in codex-rs/app-server-protocol/src/protocol/v2/item.rs,
 * produced by `ParsedCommand` in codex-rs/protocol/src/parse_command.rs.)
 *
 * That declaration is the truth: it is the same parse the TUI shows the user,
 * it resolves the path against the command's cwd, and it is stricter than a
 * text guess (Codex deliberately declines to classify `Get-Content -Encoding
 * UTF8 …`, globs, multi-file reads, `;` sequences and `$(…)` expressions).
 * So this module reads `commandActions` first.
 *
 * `parseReadCommand` below is only the fallback for an older app-server that
 * omits the field: it recognises the handful of read shapes a coding agent
 * emits (`Get-Content -Path … -Raw`, `cat`, `type`) without pretending to be a
 * shell grammar.
 */

import { tokenize } from "../process/CommandIntent";

/** What a read command names. */
export interface ReadCommand {
  /** The file path as written (may be relative to cwd). */
  path: string;
  /** First line the command asked for (1-based), when it asked for a range. */
  startLine?: number;
  /** Last line the command asked for (1-based), when it asked for a range. */
  endLine?: number;
  /**
   * True when the command asked for the whole file (`-Raw`, `cat` with no
   * range): the caller can treat the result as a complete version.
   */
  whole: boolean;
}

/** A `read` action exactly as Codex declares it. */
export interface CodexReadAction {
  command: string;
  /** File name as Codex resolved it. */
  name: string;
  /** cwd-resolved path (Codex joins it against the command's cwd for us). */
  path: string;
}

/** A `listFiles` action as Codex declares it. */
export interface CodexListAction {
  command: string;
  path?: string;
}

/** A `search` action as Codex declares it. */
export interface CodexSearchAction {
  command: string;
  query?: string;
  path?: string;
}

/** The command actions Codex attached to a command item, narrowed by type. */
export interface CodexCommandActions {
  reads: CodexReadAction[];
  lists: CodexListAction[];
  searches: CodexSearchAction[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Read `commandActions` off a `commandExecution` item. Returns undefined when
 * the app-server did not send the field (an older Codex), so the caller can
 * fall back to parsing the command text.
 */
export function commandActionsFromItem(item: any): CodexCommandActions | undefined {
  const raw = item?.commandActions;
  if (!Array.isArray(raw)) return undefined;
  const reads: CodexReadAction[] = [];
  const lists: CodexListAction[] = [];
  const searches: CodexSearchAction[] = [];
  for (const action of raw) {
    if (!action || typeof action !== "object") continue;
    const type = asString(action.type)?.toLowerCase();
    const command = asString(action.command) ?? "";
    switch (type) {
      case "read": {
        const path = asString(action.path);
        if (path !== undefined) {
          reads.push({ command, name: asString(action.name) ?? "", path });
        }
        break;
      }
      case "listfiles":
      case "list_files":
        lists.push({ command, path: asString(action.path) });
        break;
      case "search":
        searches.push({ command, query: asString(action.query), path: asString(action.path) });
        break;
      default:
        break; // unknown / future actions: not our concern
    }
  }
  return { reads, lists, searches };
}

// ---------------------------------------------------------------------------
// Fallback: parse the command text when `commandActions` is absent.
// ---------------------------------------------------------------------------

/**
 * Programs that read a file to stdout. PowerShell aliases (`gc` for
 * Get-Content, `type`/`cat` for Get-Content) and cmd's `type` are all here;
 * they are only treated as reads when the arguments look like a file path.
 */
const READ_PROGRAMS = new Set([
  "get-content",
  "gc",
  "cat",
  "type",
  "more",
  "head",
  "tail",
  "less",
  "bat",
  "nl",
]);

/** Flags that take the next token as a value. */
const VALUE_FLAGS = new Set([
  "-path",
  "-literalpath",
  "-pspath",
  "-encoding",
  "-totalcount",
  "-head",
  "-tail",
  "-first",
  "-last",
  "-skip",
  "-count",
  "-n",
  "-lines",
]);

/** Flags that mean "read the whole file, verbatim". */
const RAW_FLAGS = new Set(["-raw"]);

/** Flags whose following token is a line count. */
const COUNT_FLAGS = new Set(["-totalcount", "-head", "-tail", "-first", "-last", "-count", "-n", "-lines"]);

/** Flags whose following token is a line offset to skip. */
const SKIP_FLAGS = new Set(["-skip"]);

function basename(token: string): string {
  const trimmed = token.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return (index >= 0 ? trimmed.slice(index + 1) : trimmed).toLowerCase();
}

/**
 * Strip the quoting a shell may leave on a path. The tokenizer keeps Windows
 * backslashes and escapes, so an escaped-quote path ("\"E:\x y.txt\"") can
 * arrive with literal `\"` at both ends.
 */
function cleanPath(token: string): string {
  let value = token;
  value = value.replace(/^\\+"/, "").replace(/\\+"$/, "");
  value = value.replace(/^"([\s\S]*)"$/, "$1").replace(/^'([\s\S]*)'$/, "$1");
  return value;
}

/** True when a token is a cmd-style switch such as `/p` or `/a`. */
function isCmdSwitch(token: string): boolean {
  return /^\/[a-zA-Z]{1,2}$/.test(token);
}

/** True when a token is plausibly a file path rather than an option or a word. */
function looksLikePath(token: string): boolean {
  if (!token) return false;
  if (token.startsWith("-")) return false;
  if (isCmdSwitch(token)) return false;
  // A path has a separator, a drive, or a file extension. A bare word is too
  // ambiguous to call a read (`type foo` prints a cmd type check), so it is not
  // captured — better to miss than to invent a file the agent never opened.
  if (token.includes("\\") || token.includes("/")) return true;
  if (/^[a-zA-Z]:/.test(token)) return true;
  return /\.[a-zA-Z0-9]{1,8}$/.test(token);
}

function toInt(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const n = Number.parseInt(token, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse one command segment (no pipes) as a read. Returns undefined when the
 * segment is not a plain read of a single file.
 */
function parseSegment(tokens: string[]): ReadCommand | undefined {
  const program = tokens[0];
  if (program === undefined) return undefined;
  if (!READ_PROGRAMS.has(basename(program))) return undefined;

  let path: string | undefined;
  let whole = false;
  let count: number | undefined;
  let skip: number | undefined;
  let head = false;
  let tail = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    const lower = token.toLowerCase();

    if (lower.startsWith("-") || isCmdSwitch(token)) {
      const normalized = lower.startsWith("/") ? `-${lower.slice(1)}` : lower;
      if (RAW_FLAGS.has(normalized)) {
        whole = true;
        continue;
      }
      if (COUNT_FLAGS.has(normalized)) {
        const next = tokens[i + 1];
        count = toInt(next);
        i++;
        if (normalized === "-head" || normalized === "-first") head = true;
        if (normalized === "-tail" || normalized === "-last") tail = true;
        continue;
      }
      if (SKIP_FLAGS.has(normalized)) {
        skip = toInt(tokens[i + 1]);
        i++;
        continue;
      }
      if (VALUE_FLAGS.has(normalized)) {
        // A value flag whose value is a path (Get-Content -Path x) or an
        // encoding/interpreter setting we ignore.
        const next = tokens[i + 1];
        if (normalized === "-path" || normalized === "-literalpath" || normalized === "-pspath") {
          if (next !== undefined && !next.startsWith("-")) {
            path ??= cleanPath(next);
          }
        }
        i++;
        continue;
      }
      // Any other flag (`-NoProfile`, `-Encoding`, `-Wait`, …) takes no path.
      continue;
    }

    // A non-flag token: the first one is the path. Anything after it is a
    // second file (Get-Content a b) — do not guess; take the first.
    if (path === undefined && looksLikePath(cleanPath(token))) {
      path ??= cleanPath(token);
    }
  }

  if (path === undefined) return undefined;

  if (whole) return { path, whole: true, startLine: 1 };

  if (skip !== undefined || count !== undefined) {
    const startLine = skip !== undefined ? skip + 1 : 1;
    const endLine = count !== undefined ? startLine + count - 1 : undefined;
    // `tail -n N` counts from the end, which we cannot resolve without the
    // length; leave the range open-ended from line 1 so nothing is lost.
    if (tail) return { path, whole: false };
    if (head && startLine === 1 && endLine !== undefined) return { path, whole: false, startLine, endLine };
    if (endLine !== undefined) return { path, whole: false, startLine, endLine };
    return { path, whole: false, startLine };
  }

  // A bare `cat x` / `Get-Content x` reads the whole file.
  return { path, whole: true, startLine: 1 };
}

/**
 * A read piped into a pure line limiter (`Select-Object -Skip N -First M`,
 * `head -n N`) is still a read; a read piped into anything else (grep, sort, a
 * filter that transforms the text) is not, because what the agent received is
 * no longer the file.
 */
function isLineLimiter(tokens: string[]): { skip?: number; count?: number } | undefined {
  const program = tokens[0] ? basename(tokens[0]) : "";
  if (program === "select-object" || program === "select") {
    const result: { skip?: number; count?: number } = {};
    for (let i = 1; i < tokens.length; i++) {
      const lower = (tokens[i] ?? "").toLowerCase();
      if (lower === "-first" || lower === "-last") result.count = toInt(tokens[i + 1]);
      if (lower === "-skip") result.skip = toInt(tokens[i + 1]);
    }
    return result.count !== undefined || result.skip !== undefined ? result : undefined;
  }
  if (program === "head") {
    const tokens2 = tokens.slice(1);
    for (let i = 0; i < tokens2.length; i++) {
      const lower = (tokens2[i] ?? "").toLowerCase();
      if (lower === "-n" || lower === "-c") return { count: toInt(tokens2[i + 1]) };
    }
    // `head -5` legacy form.
    const n = toInt(tokens2[0]?.startsWith("-") ? tokens2[0].slice(1) : undefined);
    return n !== undefined ? { count: n } : undefined;
  }
  return undefined;
}

/**
 * Parse a command line (already stripped of its shell wrapper by
 * `unwrapShell`) as a file read. Returns undefined when it is not one.
 *
 * This is the fallback for an app-server that does not send `commandActions`;
 * prefer `commandActionsFromItem`.
 */
export function parseReadCommand(command: string): ReadCommand | undefined {
  // Codex sometimes carries an inner command with escaped quotes (`\"x y\"`).
  // The shared tokenizer keeps backslashes (Windows paths), so turn the
  // escaped quote delimiters into real ones first; this is what makes a quoted
  // path with spaces one token instead of three.
  const normalizedCommand = command.replace(/\\"/g, '"');
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokenize(normalizedCommand)) {
    if (token === "|") {
      segments.push(current);
      current = [];
      continue;
    }
    // A read is a single simple command. Redirections, sequencing and
    // backgrounding mean the command is doing more than reading.
    if (token === ";" || token === "&&" || token === "||" || token === "&" || token === ">" || token === ">>" || token === "2>" || token === "2>>" || token === "1>" || token === "1>>") {
      return undefined;
    }
    current.push(token);
  }
  segments.push(current);

  const read = parseSegment(segments[0] ?? []);
  if (!read) return undefined;

  // Everything after the first pipe must only limit lines, never transform them.
  for (let i = 1; i < segments.length; i++) {
    const limit = isLineLimiter(segments[i] ?? []);
    if (limit === undefined) return undefined;
    if (limit.skip !== undefined) {
      read.whole = false;
      read.startLine = (read.startLine ?? 1) + limit.skip;
      read.endLine = undefined;
    }
    // A limiter truncates the tail (head, -First) — so it sets an end line when
    // the range is still open. `tail`/`-Last` needs the file length, so leave
    // the range open and capture the whole thing.
    if (limit.count !== undefined && read.endLine === undefined) {
      read.whole = false;
      read.startLine ??= 1;
      read.endLine = read.startLine + limit.count - 1;
    }
  }

  return read;
}
