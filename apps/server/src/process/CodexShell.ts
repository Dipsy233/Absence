/**
 * Recognising — and undoing — the shell wrapper Codex puts around a command.
 *
 * Codex never runs the model's command directly. It builds a shell invocation:
 * on Windows `pwsh -NoProfile -Command "<script>"`, elsewhere `/bin/bash -lc
 * "<script>"`. It also prepends a UTF-8 preamble to PowerShell scripts so the
 * console emits UTF-8:
 *
 *   try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}
 *
 * Both are plumbing. What the user (and the egg panel) should see is the command
 * the model actually wrote, not `pwsh.exe -Command "try { … } catch {}\nnode
 * ticker.mjs"`.
 *
 * There are two ways to strip the wrapper, and they are not equal:
 *
 *   - `unwrapArgv` works on the argv array Codex hands the exec-server, where
 *     the script is already one element. This is exact: no quoting to guess.
 *   - `unwrapCommandText` works on a single command-line string (the shape the
 *     observer reports for a process), which needs a small parser.
 *
 * The preamble constant and the flag list are copied from Codex
 * (codex-rs/shell-command/src/powershell.rs) so the strip is by identity, not by
 * a lookalike regex.
 */

/** Codex's PowerShell UTF-8 preamble, verbatim (codex-rs/shell-command/src/powershell.rs). */
export const UTF8_OUTPUT_PREFIX =
  "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/** Flags that mean "the next argument is the script". */
const COMMAND_FLAGS = new Set(["-command", "-c", "-cmd"]);

/** PowerShell executables (name only, lower-cased). */
function isPowerShell(base: string): boolean {
  return base === "pwsh" || base === "pwsh.exe" || base === "powershell" || base === "powershell.exe";
}

/** cmd.exe / the shell Codex uses on Windows for a cmd invocation. */
function isCmd(base: string): boolean {
  return base === "cmd" || base === "cmd.exe";
}

/** A POSIX shell (bash/sh/zsh), where the script is passed with `-lc`/`-c`. */
/**
 * A POSIX-ish shell, where the script is passed with `-lc` / `-c`.
 *
 * The `.exe` suffix matters: on Windows the shell is `bash.exe` (Git Bash,
 * Cygwin, MSYS2), and `bash.exe !== "bash"` silently turned every one of those
 * command lines into "no wrapper" — the wrapper stayed in the text, so the
 * Stage showed `bash.exe -lc "npm test"` where the command was `npm test`.
 * That is the shape Pi's bash tool produces on Windows, so it was every Pi
 * command rather than an edge case.
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
 * Strip the trailer Codex's PowerShell preamble leaves behind. The preamble ends
 * with a newline, so the script is usually `"<preamble>\n<command>"`; the command
 * is everything after it. Once removed, a single remaining line is returned as
 * is, and multiple lines are kept (the model may write a real multi-line script).
 */
function stripPreamble(script: string): string {
  const trimmedStart = script.trimStart();
  if (trimmedStart.startsWith(UTF8_OUTPUT_PREFIX.trimStart())) {
    // Remove everything up to and including the preamble's trailing newline.
    const at = script.indexOf("\n");
    return at >= 0 ? script.slice(at + 1) : "";
  }
  // Tolerate a preamble without its trailing newline (glued to the command).
  const withoutPrefix = script.replace(UTF8_OUTPUT_PREFIX, "");
  return withoutPrefix;
}

/**
 * Undo the wrapper on an argv array, the way the exec-server receives it from
 * Codex. Returns the model's own command, or the argv joined when it is not a
 * recognised shell invocation.
 *
 * Examples:
 *   ["pwsh.exe","-Command","<preamble>node ticker.mjs"] → "node ticker.mjs"
 *   ["pwsh.exe","-NoProfile","-Command","echo hi"]      → "echo hi"
 *   ["cmd.exe","/c","node ticker.mjs"]                  → "node ticker.mjs"
 *   ["bash","-lc","echo hi"]                            → "echo hi"
 *   ["node","-v"]                                       → "node -v"
 */
export function unwrapArgv(argv: string[]): string {
  if (argv.length === 0) return "";
  const base = basename(argv[0] ?? "");

  // cmd.exe /c <cmd>: the /c may be written /C; everything after it is the command.
  if (isCmd(base)) {
    for (let i = 1; i < argv.length - 1; i++) {
      if (/^\/c$/i.test(argv[i] ?? "")) return joinScript(argv.slice(i + 1));
    }
  }

  // PowerShell / POSIX shell: find the flag that names the script, take the rest.
  if (isPowerShell(base) || isPosixShell(base)) {
    for (let i = 1; i < argv.length; i++) {
      const flag = (argv[i] ?? "").toLowerCase();
      if (COMMAND_FLAGS.has(flag)) {
        const script = argv[i + 1] ?? "";
        const body = isPowerShell(base) ? stripPreamble(script) : script;
        return body.trim();
      }
      // bash's combined form `-lc`, `-c`, `-ec`, …
      if (isPosixShell(base) && /^-[a-z]*c[a-z]*$/i.test(argv[i] ?? "")) {
        return (argv[i + 1] ?? "").trim();
      }
    }
  }

  return argv.join(" ");
}

/** Join the remaining argv as a command line, keeping a single wrapping quote pair off. */
function joinScript(rest: string[]): string {
  const joined = rest.join(" ");
  const trimmed = joined.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Undo the wrapper on a single command-line string, the shape the process
 * observer reports (`pwsh.exe -Command "…"`). Less precise than `unwrapArgv`
 * because the original argv boundaries are gone, so it parses the common shapes
 * and leaves anything else untouched.
 */
export function unwrapCommandText(commandLine: string): string {
  const trimmed = commandLine.trim();
  // `<exe> <flags> -Command <script>` — the script is everything after the flag,
  // with a single pair of surrounding quotes removed. The flag group accepts
  // `-command`, `-c`, `-lc`, `/c` and similar.
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
 * Layer 0 of docs/decoupling.md is the OS: it knows a process was created and
 * with what command line, but not which of those command lines are the agent's
 * actual work. This answers that, from the shape of the line alone — no agent
 * name, no version, no configuration:
 *
 *   `bash.exe -lc "npm test"`                       → `npm test`
 *   `pwsh -Command "<preamble>\nnode x.mjs"`        → `node x.mjs`
 *   `cmd.exe /c "dir /b"`                           → `dir /b`
 *   `/bin/bash -c "ls -la"`                         → `ls -la`
 *   `C:\nodejs\node.exe app.js`                     → `app.js` is the program, not a command
 *
 * A shell wrapper is the signal: an agent's tool call always goes through one,
 * because that is the only way to run a command string. Everything else is a
 * program starting (a daemon the command laid, the agent itself), which the
 * eggs view already covers.
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

  // Peel repeatedly. Windows nests the wrappers: `cmd /d /s /c "cmd /c "X""`
  // is what `execSync('cmd /c "X"')` actually spawns (the outer `cmd.exe` is
  // the shell it was typed into, the inner one is the command). One pass left
  // the inner wrapper in place, so the Stage showed a command whose text was
  // itself a shell invocation.
  let current = commandLine;
  let peeled = 0;
  for (;;) {
    const next = unwrapCommandText(current);
    // No match, or an unchanged result: this is as deep as the wrappers go.
    if (next === current.trim()) break;
    // A shell nested in a shell is unusual; a few levels is the whole story
    // (`cmd` inside `cmd`, `bash -lc "bash -c …"`). Bounded so a pathological
    // line cannot spin.
    if (peeled > 8) break;
    current = next;
    peeled += 1;
  }
  // Nothing was peeled: a shell with no `-c`-style flag (a bare `bash`, an
  // interactive shell) is not a command.
  if (peeled === 0) return { wrapped: false, command: commandLine };
  return { wrapped: true, command: current };
}
