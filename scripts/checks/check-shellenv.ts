/**
 * Determinism checks for Codex's shell-environment policy, reimplemented in
 *   npx tsx scripts/checks/check-shellenv.ts
 *
 * When Codex delegates a command to an exec-server it sends an `env_policy` (and
 * a sparse `env`). The executor is expected to build the command's environment
 * by running that policy over its own — Codex's own executor calls
 * `shell_environment::create_env`. These checks pin the same rules, because the
 * environment a command runs under must not depend on which executor ran it:
 * the PATH-missing bug that made `pwsh -Command "node …"` fail was exactly this
 * step diverging.
 */
import { check, finish } from "./harness";
import { createCommandEnv } from "../../apps/server/src/process/ShellEnvironment";



const isWindows = process.platform === "win32";

// A stand-in for the executor's own environment.
const BASE: NodeJS.ProcessEnv = {
  PATH: isWindows ? "C:\\Windows;C:\\bin" : "/usr/bin:/bin",
  HOME: "/home/agent",
  USER: "agent",
  SystemRoot: "C:\\Windows",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  OPENAI_API_KEY: "sk-secret",
  GITHUB_TOKEN: "ghp_secret",
  MY_SECRET_THING: "x",
  ABSENCE_SESSION_ID: "sess-old",
};

// A. inherit=all keeps the full environment (this is what Codex sends for a
// normal command), minus the default excludes it explicitly disables.
{
  const env = createCommandEnv({ inherit: "all", ignoreDefaultExcludes: true }, {}, BASE);
  check("inherit=all keeps PATH", typeof env.PATH === "string" && env.PATH.length > 0, JSON.stringify(env.PATH));
  check("inherit=all keeps HOME/USER", env.HOME === "/home/agent" && env.USER === "agent");
}

// B. the default excludes drop *KEY*, *SECRET*, *TOKEN* unless disabled.
{
  const excluded = createCommandEnv({ inherit: "all", ignoreDefaultExcludes: false }, {}, BASE);
  check("default excludes drop *KEY*", excluded.OPENAI_API_KEY === undefined);
  check("default excludes drop *TOKEN*", excluded.GITHUB_TOKEN === undefined);
  check("default excludes drop *SECRET*", excluded.MY_SECRET_THING === undefined);
  check("default excludes keep PATH", excluded.PATH !== undefined);

  const kept = createCommandEnv({ inherit: "all", ignoreDefaultExcludes: true }, {}, BASE);
  check("ignoreDefaultExcludes keeps *KEY*", kept.OPENAI_API_KEY === "sk-secret");
}

// C. inherit=core keeps only the platform core set.
{
  const env = createCommandEnv({ inherit: "core", ignoreDefaultExcludes: true }, {}, BASE);
  check("inherit=core keeps PATH", env.PATH !== undefined);
  check("inherit=core drops HOME on Windows, keeps on POSIX", isWindows ? env.HOME === undefined : env.HOME === "/home/agent");
}

// D. inherit=none starts empty.
{
  const env = createCommandEnv({ inherit: "none", ignoreDefaultExcludes: true }, {}, BASE);
  check("inherit=none starts empty", Object.keys(env).length === 0, JSON.stringify(env));
}

// E. the policy's `set` overrides the base (case-insensitively on Windows).
{
  const env = createCommandEnv(
    { inherit: "all", ignoreDefaultExcludes: true, set: { ABSENCE_SESSION_ID: "sess-new" } },
    {},
    BASE,
  );
  check("set overrides the base value", env.ABSENCE_SESSION_ID === "sess-new", JSON.stringify(env.ABSENCE_SESSION_ID));
  const lower = createCommandEnv({ inherit: "all", ignoreDefaultExcludes: true, set: { PATH: "OVERRIDE" } }, {}, BASE);
  check("set replaces the name case-insensitively", lower.PATH === "OVERRIDE" && Object.keys(lower).filter((k) => k.toLowerCase() === "path").length === 1, JSON.stringify(lower.PATH));
}

// F. the request's sparse `env` wins over the policy.
{
  const env = createCommandEnv(
    { inherit: "all", ignoreDefaultExcludes: true, set: { ABSENCE_SESSION_ID: "sess-policy" } },
    { ABSENCE_SESSION_ID: "sess-request", EXTRA: "1" },
    BASE,
  );
  check("the request's env wins over the policy set", env.ABSENCE_SESSION_ID === "sess-request", JSON.stringify(env.ABSENCE_SESSION_ID));
  check("the request's env adds new variables", env.EXTRA === "1");
}

// G. include_only filters everything else out.
{
  const env = createCommandEnv({ inherit: "all", ignoreDefaultExcludes: true, includeOnly: ["PATH"] }, {}, BASE);
  check("include_only keeps only the match", env.PATH !== undefined && Object.keys(env).length === 1, JSON.stringify(Object.keys(env)));
  const glob = createCommandEnv({ inherit: "all", ignoreDefaultExcludes: true, includeOnly: ["*PATH*", "P?TH"] }, {}, BASE);
  check("include_only supports globs", glob.PATH !== undefined);
}

// H. the whole point: a sparse request still yields a full environment.
{
  const env = createCommandEnv(
    { inherit: "all", ignoreDefaultExcludes: true, exclude: ["CODEX_VERSION"], set: { ABSENCE_SESSION_ID: "s" } },
    { SPARSE_ONLY: "1" },
    BASE,
  );
  check("a sparse request still gets PATH (the original bug)", env.PATH === BASE.PATH, JSON.stringify(env.PATH));
  check("a sparse request still gets PATHEXT/SystemRoot", env.PATHEXT !== undefined && env.SystemRoot !== undefined);
  check("custom excludes are honoured", env.CODEX_VERSION === undefined);
}

finish();
