/**
 * Recognising — and undoing — the shell wrapper around a command.
 *
 * Agent tools never run a command string directly: they build a shell
 * invocation. On Windows that is `pwsh -NoProfile -Command "<script>"` (often
 * with a UTF-8 preamble) or `cmd /c`, elsewhere `/bin/bash -lc "<script>"`.
 * Both are plumbing. What the user and the egg panel should see is the command
 * that was actually written, not the wrapper around it.
 *
 * This module works on the single command-line string the process observer
 * reports (`pwsh.exe -Command "…"`), where argv boundaries are already gone.
 * It parses the common shapes and leaves anything else untouched.
 */

/** A PowerShell UTF-8 preamble some CLIs prepend to their command. */
export const UTF8_OUTPUT_PREFIX =
  "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

function isPowerShell(base: string): boolean {
  return base === "pwsh" || base === "pwsh.exe" || base === "powershell" || base === "powershell.exe";
}

function isCmd(base: string): boolean {
  return base === "cmd" || base === "cmd.exe";
}

/**
 * A POSIX-ish shell, where the script is passed with `-lc` / `-c`.
 *
 * The `.exe` suffix matters: on Windows the shell is `bash.exe` (Git Bash,
 * Cygwin, MSYS2), and `bash.exe !== "bash"` silently turned every one of those
 * command lines into "no wrapper" — the wrapper stayed in the text.
 */
function isPosixShell(base: string): boolean {
  const name = base.endsWith(".exe") ? base.slice(0, -4) : base;
  return name === "bash" || name === "sh" || name === "zsh" || name === "dash" || name === "fish";
}

function basename(token: string): string {
  const trimmed = token.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return (index >= 0 ? trimmed.slice(index + 1) : trimmed).toLowerCase();
}

/**
 * Strip the trailer a PowerShell preamble leaves behind. The preamble ends
 * with a newline, so the script is usually `"<preamble>\n<command>"`; the
 * command is everything after it.
 */
function stripPreamble(script: string): string {
  const trimmedStart = script.trimStart();
  if (trimmedStart.startsWith(UTF8_OUTPUT_PREFIX.trimStart())) {
    const at = script.indexOf("\n");
    return at >= 0 ? script.slice(at + 1) : "";
  }
  return script.replace(UTF8_OUTPUT_PREFIX, "");
}

/**
 * Undo the wrapper on a single command-line string.
 *
 * Less precise than working on argv, because the original boundaries are gone,
 * so it parses the common shapes and leaves anything else untouched.
 */
export function unwrapCommandText(commandLine: string): string {
  const trimmed = commandLine.trim();
  const match = trimmed.match(
    /^(?:"([^"]+)"|(\S+))((?:\s+(?:-{1,2}[a-z]+|\/[a-z]+))*)\s+\/?(?:-{1,2})?([a-z]*c[a-z]*|command)\s+([\s\S]+)$/i,
  );
  if (!match) return commandLine;
  const exe = (match[1] ?? match[2] ?? "").toLowerCase();
  const base = basename(exe);
  const flag = (match[4] ?? "").toLowerCase();
  const rest = match[5] ?? "";
  // The captured flag is `command`, `c`, `lc`, `ec`, … — anything containing a
  // `c`. PowerShell and POSIX shells both take the script after it.
  const isCommandFlag = flag === "command" || flag.includes("c");
  if (isPowerShell(base) && isCommandFlag) {
    return stripPreamble(stripOuterQuotes(rest)).trim();
  }
  if (isCmd(base) && isCommandFlag) {
    return stripOuterQuotes(rest).trim();
  }
  if (isPosixShell(base) && isCommandFlag) {
    return stripOuterQuotes(rest).trim();
  }
  return commandLine;
}

/** Remove one enclosing quote pair (`"…"` or `'…'`), if present. */
function stripOuterQuotes(text: string): string {
  const trimmed = text.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Whether a process is a *command the agent ran*, and what that command was.
 *
 * The OS knows a process was created and with what command line, but not which
 * of those lines are the agent's actual work. A shell wrapper is the signal:
 * an agent's tool call always goes through one, because that is the only way to
 * run a command string. Everything else is a program starting (a daemon the
 * command laid, the agent itself), which the eggs view already covers.
 *
 * `wrapped: false` means "not a command", not "we could not tell" — the caller
 * shows a process card instead of a command card.
 */
export function detectCommand(
  name: string,
  commandLine: string,
): { wrapped: boolean; command: string } {
  const base = basename(name);
  const shell = isPosixShell(base) || isCmd(base) || isPowerShell(base);
  if (!shell) return { wrapped: false, command: commandLine };

  // Peel repeatedly: Windows nests the wrappers (`cmd /d /s /c "cmd /c "X""`).
  let current = commandLine;
  let peeled = 0;
  for (;;) {
    const next = unwrapCommandText(current);
    if (next === current.trim()) break;
    if (peeled > 8) break;
    current = next;
    peeled += 1;
  }
  if (peeled === 0) return { wrapped: false, command: commandLine };
  return { wrapped: true, command: current };
}
