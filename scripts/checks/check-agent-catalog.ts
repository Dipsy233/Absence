/**
 * Offline check of P4: agents are resolved from catalog data, not product
 * branches.
 *
 *   npx tsx scripts/checks/check-agent-catalog.ts
 *
 * What it proves:
 *   1. the shipped launch data is the verified Pi / Codex ACP commands;
 *   2. `createAdapter("pi")` / `("codex")` default to the ACP adapter, and the
 *      registry-name aliases reach the same profile;
 *   3. the explicit legacy switch is the *only* way back to the native
 *      adapters, and it is one env var;
 *   4. a missing profile or a missing launch command throws a readable error;
 *   5. /api/runtimes' rows come from the catalog with generic fields, not
 *      piBin / codexBin / dshBin;
 *   6. `agents/**` has no product-name equality branches outside the profile
 *      data and the deprecated native adapters P5 deletes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAdapter } from "../../apps/server/src/agents/acp/AcpAdapter";
import {
  getProfile,
  parseLaunchLine,
  registerProfile,
  unregisterProfile,
} from "../../apps/server/src/agents/acp/AgentCatalog";
import { builtinProfileData, builtinProfiles } from "../../apps/server/src/agents/acp/profiles";
import { createAdapter } from "../../apps/server/src/agents/createAdapter";
import { CodexAdapter } from "../../apps/server/src/agents/CodexAdapter";
import { MockAdapter } from "../../apps/server/src/agents/MockAdapter";
import { PiAdapter } from "../../apps/server/src/agents/PiAdapter";
import { runtimeStatuses } from "../../apps/server/src/runtimes/config";
import { check, finish, section } from "./harness";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const agentsDir = path.join(repoRoot, "apps", "server", "src", "agents");

function throws(label: string, fn: () => unknown, expected: RegExp): void {
  try {
    fn();
    check(label, false, "did not throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, expected.test(message), message);
  }
}

section("profile data: the verified ACP launches are written down once");
{
  const pi = builtinProfiles().find((profile) => profile.id === "pi");
  check("Pi profile exists", pi !== undefined);
  check(
    "Pi launches pi-acp 0.0.34 through npx",
    pi?.launch.command === "npx" &&
      (pi?.launch.args ?? []).join(" ") === "-y pi-acp@0.0.34",
    pi ? `${pi.launch.command} ${(pi.launch.args ?? []).join(" ")}` : "",
  );
  check(
    "Pi enables embedded context",
    pi?.launch.env?.PI_ACP_ENABLE_EMBEDDED_CONTEXT === "true",
  );
  check("Pi declares the pi CLI prerequisite", (pi?.requires ?? []).includes("pi"));
  check("Pi advertises no permission prompt", pi?.auth === "none");
  const piData = builtinProfileData.find((profile) => profile.id === "pi");
  check(
    "Pi version is overridable without a code change",
    piData?.launch.versionEnv === "ABSENCE_PI_ACP_VERSION",
  );

  const codex = builtinProfiles().find((profile) => profile.id === "codex");
  check("Codex profile exists", codex !== undefined);
  check(
    "Codex launches the Zed codex-acp 0.16.0 through npx",
    codex?.launch.command === "npx" &&
      (codex?.launch.args ?? []).join(" ") === "-y @zed-industries/codex-acp@0.16.0",
    codex ? `${codex.launch.command} ${(codex.launch.args ?? []).join(" ")}` : "",
  );
  check("Codex declares sign-in as required", codex?.auth === "required");
  const codexData = builtinProfileData.find((profile) => profile.id === "codex");
  check(
    "Codex version is overridable without a code change",
    codexData?.launch.versionEnv === "ABSENCE_CODEX_ACP_VERSION",
  );
  check(
    "Codex has a plan / modes / commands capability hint",
    /plan/.test(codex?.capabilities ?? "") && /modes/.test(codex?.capabilities ?? ""),
  );

  const alternative = builtinProfiles().find((profile) => profile.id === "codex-acp-alt");
  check(
    "the alternative Codex build is a second data row, not a branch",
    (alternative?.launch.args ?? []).join(" ") === "-y codex-acp@1.11.0",
    alternative ? (alternative.launch.args ?? []).join(" ") : "",
  );

  const ids = builtinProfileData.map((profile) => profile.id);
  check("profile ids are unique", ids.length === new Set(ids).size, ids.join(", "));
  const aliases = builtinProfileData.flatMap((profile) => profile.aliases ?? []);
  check("profile aliases are unique", aliases.length === new Set(aliases).size, aliases.join(", "));
}

section("catalog: ids and registry-name aliases resolve to the same profile");
{
  const pi = getProfile("pi");
  check("pi resolves", pi?.id === "pi" && pi?.source === "builtin");
  check("pi-acp alias resolves to the Pi profile", getProfile("pi-acp")?.id === "pi");
  const codex = getProfile("codex");
  check("codex resolves", codex?.id === "codex" && codex?.source === "builtin");
  check("codex-acp alias resolves to the Codex profile", getProfile("codex-acp")?.id === "codex");
  check("an unknown id does not resolve", getProfile("no-such-agent-xyz") === undefined);
  check(
    "a saved launch line keeps quoted Windows paths intact",
    parseLaunchLine('"C:\\Program Files\\pi-acp.exe" --flag').join("|") ===
      "C:\\Program Files\\pi-acp.exe|--flag",
  );
}

section("createAdapter: ACP by default, native only behind the explicit switch");
{
  const pi = createAdapter("pi", {});
  check("createAdapter(pi) is the generic ACP adapter", pi instanceof AcpAdapter, pi.constructor.name);
  check("the ACP adapter keeps the runtime id", pi.runtime === "pi");
  pi.dispose();

  const codex = createAdapter("codex", {});
  check("createAdapter(codex) is the generic ACP adapter", codex instanceof AcpAdapter, codex.constructor.name);
  codex.dispose();

  const alias = createAdapter("codex-acp", {});
  check("createAdapter(codex-acp alias) is the same ACP path", alias instanceof AcpAdapter);
  check("the alias resolves to the runtime id", alias.runtime === "codex");
  alias.dispose();

  const mock = createAdapter("mock", {});
  check("a non-ACP registered adapter still works", mock instanceof MockAdapter);
  mock.dispose();

  process.env.ABSENCE_LEGACY_NATIVE_ADAPTERS = "1";
  try {
    const legacyPi = createAdapter("pi", {});
    check("the legacy switch restores the Pi native adapter", legacyPi instanceof PiAdapter);
    legacyPi.dispose();
    const legacyCodex = createAdapter("codex", {});
    check("the legacy switch restores the Codex native adapter", legacyCodex instanceof CodexAdapter);
    legacyCodex.dispose();
  } finally {
    delete process.env.ABSENCE_LEGACY_NATIVE_ADAPTERS;
  }

  const backToAcp = createAdapter("pi", {});
  check("after the switch is unset, pi is ACP again", backToAcp instanceof AcpAdapter);
  backToAcp.dispose();
}

section("createAdapter: missing data is a readable error, never a silent fallback");
{
  throws("an unknown runtime names what is missing", () => createAdapter("no-such-agent-xyz", {}), /No ACP profile or registered adapter/);

  registerProfile({
    id: "check-missing-command",
    label: "Missing command",
    source: "fixture",
    launch: { command: "absence-definitely-missing-binary-xyz" },
    commandEnv: "ABSENCE_MISSING_TEST_BIN",
  });
  try {
    throws(
      "a missing launch command names the profile and the fix",
      () => createAdapter("check-missing-command", {}),
      /cannot start.*absence-definitely-missing-binary-xyz.*ABSENCE_MISSING_TEST_BIN/s,
    );
  } finally {
    unregisterProfile("check-missing-command");
  }
}

section("api rows: /api/runtimes is catalog data, not per-product fields");
{
  const statuses = runtimeStatuses();
  const pi = statuses.find((status) => status.kind === "pi") as Record<string, unknown> | undefined;
  const codex = statuses.find((status) => status.kind === "codex") as Record<string, unknown> | undefined;
  check("the list contains the Pi profile row", pi !== undefined);
  check("the list contains the Codex profile row", codex !== undefined);
  check("rows carry a generic launch line", typeof pi?.commandLine === "string");
  check("rows carry the auth hint", codex?.auth === "required");
  check("rows carry a capability hint", typeof codex?.capabilities === "string");
  check("no piBin field on a row", pi !== undefined && !("piBin" in pi));
  check("no codexBin field on a row", codex !== undefined && !("codexBin" in codex));
  check("no dshBin field on a row", statuses.every((status) => !("dshBin" in status)));
  const mock = statuses.find((status) => status.kind === "mock");
  check("registered adapters without a profile still appear", mock !== undefined);
}

section("static: no product-name equality branches in the generic path");
{
  /**
   * The deprecated native adapters are the compatibility layer P5 deletes;
   * they are allowed to know their own product. `profiles.ts` is the data file.
   */
  const allowed = new Set([
    "profiles.ts",
    "PiAdapter.ts",
    "CodexAdapter.ts",
    "DshAdapter.ts",
    "DshClient.ts",
    "AppServerClient.ts",
    "CodexBin.ts",
    "PiBin.ts",
    "MockAdapter.ts",
    "CodexCommands.ts",
  ]);
  const pattern = /(===|!==)\s*["'](pi|codex|dsh)["']|case\s*["'](pi|codex|dsh)["']/;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith(".ts") || allowed.has(entry.name)) continue;
      const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (pattern.test(line)) {
          offenders.push(`${path.relative(repoRoot, absolute)}:${index + 1} ${line.trim()}`);
        }
      });
    }
  };
  walk(agentsDir);
  check("agents/** has no product-name equality branch", offenders.length === 0, offenders.join("\n"));
}

finish("agent catalog checks");
