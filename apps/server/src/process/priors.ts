/**
 * The name prior shared by command parsing and classification.
 *
 * These are names that are *usually* tools — `cat`, `grep`, `sleep`, and the
 * like. This is a **prior, never a verdict**: it nudges an otherwise ambiguous
 * case, and the structural rules (survival, children, workspace provenance,
 * daemon intent) override it. Keeping it here rather than in `classify.ts` lets
 * `CommandIntent` consult it without importing the classifier back.
 */

/** Names that are usually tools rather than subjects or daemons. */
export const TOOL_PRIOR = new Set([
  "ls", "ls.exe", "dir", "cat", "cat.exe", "type.exe", "head", "head.exe",
  "tail", "tail.exe", "grep", "grep.exe", "find", "find.exe", "fd", "fd.exe",
  "findstr.exe", "sed", "sed.exe",
  "awk", "awk.exe", "sort", "sort.exe", "uniq", "uniq.exe", "wc", "wc.exe",
  "cut", "cut.exe", "tr", "tr.exe", "sleep", "sleep.exe", "date", "date.exe",
  "echo", "true", "false", "test", "test.exe", "pwd", "pwd.exe", "env",
  "env.exe", "which", "which.exe", "du", "du.exe", "df", "df.exe",
  "mkdir", "mkdir.exe", "rmdir", "rmdir.exe", "rm", "rm.exe", "cp", "cp.exe",
  "mv", "mv.exe", "touch", "touch.exe", "basename", "basename.exe",
  "dirname", "dirname.exe", "printenv", "whoami", "whoami.exe",
  "hostname", "hostname.exe", "uname", "uname.exe", "id", "id.exe",
  "ps", "ps.exe", "kill", "kill.exe", "pkill", "pkill.exe",
  "tasklist", "tasklist.exe", "pgrep", "pgrep.exe",
]);

/**
 * Launchers that are transparent: they change *how* a process runs (detached,
 * timed, niceness) but not *what* it is. The real process is the child, so Daze
 * reports that child rather than the launcher — otherwise `nohup node ticker.mjs`
 * shows up as `nohup.exe` and the daemon is hidden behind it.
 */
export const TRANSPARENT_LAUNCHERS = new Set([
  "nohup",
  "nohup.exe",
  "setsid",
  "setsid.exe",
  "time",
  "time.exe",
  "nice",
  "nice.exe",
  "ionice",
  "stdbuf",
  "stdbuf.exe",
  "env",
  "env.exe",
  "exec",
]);

/** True when a process only wraps the one it starts. */
export function isTransparentLauncher(name: string): boolean {
  return TRANSPARENT_LAUNCHERS.has(name.toLowerCase());
}

/** True when the name is in the tool prior — used by tests and UI hints. */
export function isToolPrior(name: string): boolean {
  return TOOL_PRIOR.has(name.toLowerCase());
}

/** File names that mark a token as a script an interpreter would run. */
export function hasScriptExtension(name: string): boolean {
  return (
    name.endsWith(".py") ||
    name.endsWith(".js") ||
    name.endsWith(".ts") ||
    name.endsWith(".mjs") ||
    name.endsWith(".sh") ||
    name.endsWith(".ps1") ||
    name.endsWith(".bat") ||
    name.endsWith(".cmd") ||
    name.endsWith(".rb") ||
    name.endsWith(".pl") ||
    name.endsWith(".php")
  );
}
