/**
 * Codex's shell environment policy, reimplemented for Absence's exec-server.
 *
 * When Codex delegates a command to an exec-server it sends two things: a sparse
 * `env` map (the variables the command is meant to see) and an `env_policy`
 * describing how the executor should build the rest of the environment from its
 * own. Codex's own executor runs `shell_environment::create_env` over that
 * policy (see codex-rs/protocol/src/shell_environment.rs); Absence must do the
 * same, or the command runs under a different environment than it would on the
 * native executor — which is exactly how `pwsh -Command "node …"` ended up with
 * no PATH and "术语 'node' 不会被识别".
 *
 * This mirrors `populate_env` step for step:
 *
 *   1. start from `inherit` (All / Core / None);
 *   2. drop the default excludes (`*KEY*`, `*SECRET*`, `*TOKEN*`) unless told not to;
 *   3. drop the policy's own excludes;
 *   4. apply the policy's `set` overrides;
 *   5. if `include_only` is present, keep only matching names;
 *   6. drop Codex's non-inheritable variables.
 *
 * Patterns are case-insensitive globs (`*`, `?`), matching Codex's
 * `EnvironmentVariablePattern` (a wildmatch). Windows names are compared
 * case-insensitively throughout, as they are on the platform.
 */

/** The subset of Codex's `ExecEnvPolicy` Absence consumes. */
export interface ExecEnvPolicy {
  inherit?: "all" | "core" | "none" | string;
  ignoreDefaultExcludes?: boolean;
  exclude?: string[];
  set?: Record<string, string>;
  includeOnly?: string[];
}

/** Core variables, per platform (codex-rs/protocol/src/shell_environment.rs). */
const UNIX_CORE = [
  "PATH",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "USER",
];

const WINDOWS_CORE = [
  "PATH",
  "PATHEXT",
  "SHELL",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "USERNAME",
  "USERDOMAIN",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROGRAMDATA",
  "LOCALAPPDATA",
  "APPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "POWERSHELL",
  "PWSH",
];

/** Variables model-reachable children must never inherit (Codex's list). */
const NON_INHERITABLE = [
  "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN",
  "NODE_REPL_AUTH_TOKEN",
  "CODEX_GUARDIAN_DECISIONS_API_KEY",
  "OPENAI_FEDERATION_RULE_ID",
  "OPENAI_IDENTITY_TOKEN_FILE",
  "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
];

/** The default excludes `create_env` applies unless the policy opts out. */
const DEFAULT_EXCLUDES = ["*KEY*", "*SECRET*", "*TOKEN*"];

function isWindows(): boolean {
  return process.platform === "win32";
}

/** True for variables that must not leak to a command, on either side. */
function isNonInheritable(name: string): boolean {
  return NON_INHERITABLE.some((restricted) => equalName(restricted, name));
}

function equalName(a: string, b: string): boolean {
  return isWindows() ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * A case-insensitive glob match (`*` matches any run, `?` a single character).
 * Equivalent to Codex's `WildMatchPattern<'*','?'>` on the names it sees.
 */
function globMatch(pattern: string, name: string): boolean {
  const p = isWindows() ? pattern.toLowerCase() : pattern;
  const s = isWindows() ? name.toLowerCase() : name;
  // Classic iterative wildcard matcher: no recursion, no catastrophic backtracking.
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
      pi += 1;
      si += 1;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi;
      mark = si;
      pi += 1;
    } else if (star >= 0) {
      pi = star + 1;
      mark += 1;
      si = mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi += 1;
  return pi === p.length;
}

function matchesAny(patterns: string[], name: string): boolean {
  return patterns.some((pattern) => globMatch(pattern, name));
}

/**
 * Build a command's environment from the executor's own, Codex-style. `base` is
 * normally `process.env` (the executor's environment); `overrides` is the
 * request's sparse `env`, applied last so it wins.
 */
export function createCommandEnv(
  policy: ExecEnvPolicy | undefined,
  overrides: Record<string, string> | undefined,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const inherit = (policy?.inherit ?? "all").toLowerCase();
  const core = isWindows() ? WINDOWS_CORE : UNIX_CORE;

  // Step 1 — the starting set.
  let env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (inherit === "none") continue;
    if (inherit === "core" && !core.some((allowed) => equalName(allowed, name))) continue;
    env[name] = value;
  }

  // Step 2 — the default excludes.
  if (!policy?.ignoreDefaultExcludes) {
    env = retainUnless(env, (name) => matchesAny(DEFAULT_EXCLUDES, name));
  }

  // Step 3 — the policy's own excludes.
  if (policy?.exclude && policy.exclude.length > 0) {
    env = retainUnless(env, (name) => matchesAny(policy.exclude!, name));
  }

  // Step 4 — the policy's `set` overrides (case-insensitive replace on Windows).
  for (const [name, value] of Object.entries(policy?.set ?? {})) {
    env = removeName(env, name);
    env[name] = value;
  }

  // Step 5 — `include_only`, when present.
  if (policy?.includeOnly && policy.includeOnly.length > 0) {
    env = retainUnless(env, (name) => !matchesAny(policy.includeOnly!, name));
  }

  // The request's own `env` wins over everything the policy produced.
  for (const [name, value] of Object.entries(overrides ?? {})) {
    env = removeName(env, name);
    env[name] = value;
  }

  // Step 6 — never leak a non-inheritable variable, whatever the policy said.
  env = retainUnless(env, (name) => isNonInheritable(name));

  return env;
}

/** Drop every entry whose name matches the predicate. Returns a new object. */
function retainUnless(
  env: Record<string, string>,
  drop: (name: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!drop(name)) out[name] = value;
  }
  return out;
}

/** Remove any existing key equal to `name` under the platform's case rules. */
function removeName(env: Record<string, string>, name: string): Record<string, string> {
  if (!isWindows()) {
    delete env[name];
    return env;
  }
  const lower = name.toLowerCase();
  for (const existing of Object.keys(env)) {
    if (existing.toLowerCase() === lower) delete env[existing];
  }
  return env;
}
