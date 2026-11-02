/**
 * Offline check of client-side ACP discovery.
 *
 *   npx tsx scripts/checks/check-agent-catalog.ts
 *
 * What it proves:
 *   1. a shipped profile never launches `npx` on its own;
 *   2. only an agent CLI installed → `needs-adapter`, and nothing spawns npx;
 *   3. a PATH ACP entry or a local node_modules adapter → `ready`;
 *   4. an agent CLI that speaks ACP with its own flag (qwen / gemini) → `ready`;
 *   5. npx is only used when explicitly allowed, and is marked "will download";
 *   6. custom entries (add / update / delete) live in ~/.absence/agents.json,
 *      reject a missing command with the checked paths, and never duplicate a
 *      shipped row;
 *   7. read-only agent config parsing: models, auth presence, and `unknown`
 *      on corrupt/missing/permission-denied input — with no writes to the
 *      agent's directory;
 *   8. /api/runtimes rows come from the catalog with generic fields.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAdapter } from "../../apps/server/src/agents/acp/AcpAdapter";
import {
  addCustomAgent,
  commandLookupPaths,
  customAgents,
  getProfile,
  listProfiles,
  parseLaunchLine,
  pickerRow,
  pickerRows,
  readAgentsFile,
  removeCustomAgent,
  updateCustomAgent,
  writeLaunchOverrides,
  type CatalogEntry,
} from "../../apps/server/src/agents/acp/AgentCatalog";
import {
  adapterInstall,
  builtinProfileData,
  builtinProfiles,
} from "../../apps/server/src/agents/acp/profiles";
import { createAdapter } from "../../apps/server/src/agents/createAdapter";
import { runtimeStatuses } from "../../apps/server/src/runtimes/config";
import { check, finish, section } from "./harness";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const agentsDir = path.join(repoRoot, "apps", "server", "src", "agents");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "absence-catalog-"));
const catalog = path.join(temp, "absence");
const cliBin = path.join(temp, "cli-bin");
const adapterBin = path.join(temp, "adapter-bin");
fs.mkdirSync(cliBin, { recursive: true });
fs.mkdirSync(adapterBin, { recursive: true });
fs.mkdirSync(catalog, { recursive: true });

const savedEnv = {
  PATH: process.env.PATH,
  ABSENCE_CATALOG_DIR: process.env.ABSENCE_CATALOG_DIR,
  ABSENCE_ALLOW_NPX: process.env.ABSENCE_ALLOW_NPX,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  ABSENCE_PI_ACP_BIN: process.env.ABSENCE_PI_ACP_BIN,
  ABSENCE_CODEX_ACP_BIN: process.env.ABSENCE_CODEX_ACP_BIN,
  ABSENCE_CLAUDE_ACP_BIN: process.env.ABSENCE_CLAUDE_ACP_BIN,
  ABSENCE_QWEN_ACP_BIN: process.env.ABSENCE_QWEN_ACP_BIN,
  ABSENCE_GEMINI_ACP_BIN: process.env.ABSENCE_GEMINI_ACP_BIN,
};

process.env.ABSENCE_CATALOG_DIR = catalog;
delete process.env.ABSENCE_ALLOW_NPX;
for (const name of [
  "ABSENCE_PI_ACP_BIN",
  "ABSENCE_CODEX_ACP_BIN",
  "ABSENCE_CLAUDE_ACP_BIN",
  "ABSENCE_QWEN_ACP_BIN",
  "ABSENCE_GEMINI_ACP_BIN",
] as const) {
  delete process.env[name];
}

function makeBin(dir: string, name: string): string {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const file = path.join(dir, name + ext);
  fs.writeFileSync(
    file,
    process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    "utf8",
  );
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
  return file;
}

function onlyPath(dirs: string[]): void {
  process.env.PATH = dirs.join(path.delimiter);
}

function profile(id: string): CatalogEntry | undefined {
  return getProfile(id);
}

function throws(label: string, fn: () => unknown, expected: RegExp): void {
  try {
    fn();
    check(label, false, "did not throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, expected.test(message), message);
  }
}

function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (root: string): void => {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) {
        out.push(`d ${path.relative(root, absolute)}`);
        walk(absolute);
        continue;
      }
      const stat = fs.statSync(absolute);
      out.push(`f ${path.relative(root, absolute)} ${stat.size} ${stat.mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
}

try {
  section("shipped data: nothing launches npx on its own");
  {
    check(
      "no shipped profile carries a command",
      builtinProfileData.every((data) => !("command" in data.launch)),
      JSON.stringify(builtinProfileData.map((data) => data.launch)),
    );
    check(
      "materialised profiles start empty",
      builtinProfiles().every((entry) => entry.launch.command === ""),
      builtinProfiles().map((entry) => `${entry.id}:${entry.launch.command}`).join(","),
    );
    const pi = builtinProfileData.find((entry) => entry.id === "pi");
    check("Pi declares pi-acp as its ACP entry", pi?.discovery?.acpBins?.[0] === "pi-acp");
    check("Pi keeps pi-acp as an opt-in npx fallback", pi?.discovery?.npxPackage === "pi-acp");
    check("Pi's fallback version stays data", pi?.discovery?.npxVersionEnv === "ABSENCE_PI_ACP_VERSION");
    check("Pi's config is read from PI_CODING_AGENT_DIR", pi?.inspect?.dirEnv === "PI_CODING_AGENT_DIR");
    const ids = builtinProfileData.map((entry) => entry.id);
    check("profile ids are unique", ids.length === new Set(ids).size, ids.join(", "));
    const aliases = builtinProfileData.flatMap((entry) => entry.aliases ?? []);
    check("profile aliases are unique", aliases.length === new Set(aliases).size, aliases.join(", "));
  }

  section("discovery: only the pi CLI installed → needs-adapter, no npx");
  {
    makeBin(cliBin, "pi");
    onlyPath([cliBin]);
    const pi = profile("pi");
    check("pi resolves", pi?.id === "pi");
    check("pi is needs-adapter", pi?.state === "needs-adapter", pi?.stateReason);
    check(
      "the reason says the adapter is missing",
      /no ACP adapter/i.test(pi?.stateReason ?? ""),
      pi?.stateReason,
    );
    check(
      "the install hint names the adapter package",
      /pi-acp/i.test(pi?.installHint ?? ""),
      pi?.installHint,
    );
    check("pi does not launch npx", pi?.launch.command !== "npx", pi?.launch.command);
    check("pi is not marked as a download", pi?.willDownload !== true);
    throws(
      "createAdapter(pi) refuses with the catalog's own reason",
      () => createAdapter("pi", {}),
      /needs-adapter.*no ACP adapter.*pi-acp/s,
    );
    check("pi-acp alias reaches the same row", profile("pi-acp")?.id === "pi");

    const codex = profile("codex");
    check(
      "codex is unavailable when neither CLI nor adapter exists",
      codex?.state === "unavailable",
      codex?.stateReason,
    );
    check("codex never launches npx either", codex?.launch.command !== "npx", codex?.launch.command);

    // The probe view shows only what was found: pi is the single row here.
    const rows = pickerRows(listProfiles());
    check(
      "only the pi row is listed",
      rows.length === 1 && rows[0]?.kind === "pi",
      rows.map((row) => row.kind).join(","),
    );
    check("the row keeps needs-adapter", rows[0]?.state === "needs-adapter", rows[0]?.stateReason);
    check("the row carries the adapter package", rows[0]?.adapter?.packages[0] === "pi-acp", JSON.stringify(rows[0]?.adapter));
    check(
      "the install command is copyable data",
      rows[0]?.adapter?.command === "npm install -g pi-acp",
      rows[0]?.adapter?.command,
    );
    check(
      "the prefilled entry points at the adapter binary",
      rows[0]?.adapter?.suggestedEntry.command === "pi-acp",
      rows[0]?.adapter?.suggestedEntry.command,
    );
    check("needs-adapter is not advertised as a download", rows[0]?.willDownload !== true);
    check("an unavailable profile has no picker row", codex !== undefined && pickerRow(codex) === undefined);
    check("an empty probe yields the empty state", pickerRows([]).length === 0);

    // The install recipe comes from the profile data, not a UI branch.
    const piData = builtinProfileData.find((entry) => entry.id === "pi");
    const install = piData ? adapterInstall(piData) : undefined;
    check(
      "adapter install is derived from profiles.ts",
      install?.command === "npm install -g pi-acp" && install?.bins[0] === "pi-acp",
      JSON.stringify(install),
    );
  }

  section("discovery: a PATH ACP entry → ready");
  {
    const piAcp = makeBin(adapterBin, "pi-acp");
    onlyPath([cliBin, adapterBin]);
    const pi = profile("pi");
    check("pi is ready", pi?.state === "ready", pi?.stateReason);
    check("the source is auto-discovery", pi?.origin === "auto", pi?.origin);
    const discovered = pi?.discoveredFrom;
    check(
      "discoveredFrom is the executable",
      discovered !== undefined &&
        fs.realpathSync(discovered).toLowerCase() === fs.realpathSync(piAcp).toLowerCase(),
      discovered,
    );
    check(
      "the launch command is the resolved executable",
      pi?.launch.command === pi?.discoveredFrom,
      pi?.launch.command,
    );
    const adapter = createAdapter("pi", {});
    check("createAdapter(pi) is the generic ACP adapter", adapter instanceof AcpAdapter, adapter.constructor.name);
    adapter.dispose();
  }

  section("discovery: a local node_modules adapter → ready");
  {
    const project = path.join(temp, "project");
    const entry = path.join(project, "node_modules", "pi-acp", "dist", "index.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "// fixture adapter entry\n", "utf8");
    const cwd = process.cwd();
    onlyPath([cliBin]);
    process.chdir(project);
    try {
      const pi = profile("pi");
      check("pi is ready from node_modules", pi?.state === "ready", pi?.stateReason);
      check("discoveredFrom is the adapter entry", pi?.discoveredFrom === entry, pi?.discoveredFrom);
      check("the launch runs node + the entry", pi?.launch.command === process.execPath, pi?.launch.command);
      check("the entry is the first argument", (pi?.launch.args ?? [])[0] === entry, (pi?.launch.args ?? []).join(" "));
    } finally {
      process.chdir(cwd);
      onlyPath([cliBin, adapterBin]);
    }
  }

  section("discovery: an agent CLI that speaks ACP itself → ready");
  {
    makeBin(cliBin, "qwen");
    makeBin(cliBin, "gemini");
    onlyPath([cliBin, adapterBin]);
    const qwen = profile("qwen-code");
    check("qwen-code is ready", qwen?.state === "ready", qwen?.stateReason);
    check(
      "qwen launches its own ACP flag",
      (qwen?.launch.args ?? []).join(" ") === "--experimental-acp",
      (qwen?.launch.args ?? []).join(" "),
    );
    const gemini = profile("gemini");
    check("gemini is ready", gemini?.state === "ready", gemini?.stateReason);
    check(
      "gemini launches --acp",
      (gemini?.launch.args ?? []).join(" ") === "--acp",
      (gemini?.launch.args ?? []).join(" "),
    );

    const rows = pickerRows(listProfiles());
    const qwenRow = rows.find((row) => row.kind === "qwen-code");
    check(
      "unknown auth stays ready, never needs-auth",
      qwenRow?.state === "ready" && qwenRow?.auth === "unknown",
      qwenRow ? `${qwenRow.state}/${qwenRow.auth}` : "missing",
    );
  }

  section("npx is an explicit opt-in only");
  {
    const piAcp = path.join(adapterBin, process.platform === "win32" ? "pi-acp.cmd" : "pi-acp");
    fs.rmSync(piAcp, { force: true });
    onlyPath([cliBin]);
    process.env.ABSENCE_ALLOW_NPX = "1";
    try {
      const pi = profile("pi");
      check("pi becomes ready through npx", pi?.state === "ready", pi?.stateReason);
      check("the row is marked as a download", pi?.willDownload === true);
      check("the launch command is npx", pi?.launch.command === "npx", pi?.launch.command);
      check(
        "the reason says the package is temporary",
        /temporarily/i.test(pi?.stateReason ?? ""),
        pi?.stateReason,
      );
    } finally {
      delete process.env.ABSENCE_ALLOW_NPX;
    }
    const pi = profile("pi");
    check("without the opt-in pi is needs-adapter again", pi?.state === "needs-adapter", pi?.stateReason);
    makeBin(adapterBin, "pi-acp");
  }

  section("custom entries: CRUD, validation and persistence");
  {
    const file = path.join(temp, "custom.json");
    const created = addCustomAgent(
      { label: "My Adapter", command: process.execPath, args: ["--flag"], cwd: temp },
      file,
    );
    check("the id is a slug of the display name", created.id === "my-adapter", created.id);
    check(
      "the entry persisted to Absence's own file",
      customAgents(file).some((entry) => entry.id === "my-adapter"),
    );
    check("the file is a single JSON store", path.basename(file) === "custom.json");

    throws(
      "a duplicate id is refused",
      () => addCustomAgent({ label: "My Adapter", command: process.execPath }, file),
      /already exists/i,
    );
    const missing = "absence-definitely-missing-binary-xyz";
    throws(
      "a missing command names the command and the checked paths",
      () => addCustomAgent({ label: "Broken", command: missing }, file),
      /absence-definitely-missing-binary-xyz.*Checked:/s,
    );
    const checked = commandLookupPaths(missing);
    check("the lookup reports concrete paths", checked.length > 0, checked.join(", "));
    check(
      "the checked paths point at the command, not a bare name",
      checked.every((candidate) => path.isAbsolute(candidate)),
      checked.join(", "),
    );
    throws(
      "a nonexistent cwd is refused",
      () =>
        addCustomAgent(
          { label: "Bad cwd", command: process.execPath, cwd: path.join(temp, "nope") },
          file,
        ),
      /does not exist or is not a directory/i,
    );

    const updated = updateCustomAgent(
      "my-adapter",
      { label: "Renamed", command: process.execPath, args: ["--other"] },
      file,
    );
    check(
      "update persisted the new label",
      updated.label === "Renamed" && customAgents(file)[0]?.label === "Renamed",
    );
    check("delete removes the entry", removeCustomAgent("my-adapter", file) && customAgents(file).length === 0);

    throws(
      "a custom id may not shadow a shipped runtime",
      () => addCustomAgent({ id: "pi", label: "Pi again", command: process.execPath }, file),
      /already used/i,
    );

    // A hand-edited file that reuses "pi" must not duplicate the row.
    fs.writeFileSync(
      file,
      JSON.stringify({ agents: [{ id: "pi", label: "Hand edit", command: process.execPath }] }),
      "utf8",
    );
    const piRows = listProfiles().filter((entry) => entry.id === "pi");
    check("a hand-edited duplicate does not add a second pi row", piRows.length === 1, String(piRows.length));
    check("the shipped row wins", piRows[0]?.source === "builtin", piRows[0]?.source);

    // Persist in the real catalog location too, then resolve it as a runtime.
    const persisted = addCustomAgent({ label: "Persisted", command: process.execPath });
    check(
      "the default catalog file keeps the entry",
      readAgentsFile().agents.some((entry) => entry.id === persisted.id),
    );
    const row = profile(persisted.id);
    check("the custom entry appears as its own runtime", row?.id === persisted.id);
    check("it resolves ready", row?.state === "ready", row?.stateReason);
    check("its source is manual", row?.origin === "manual", row?.origin);
    check("it does not duplicate a shipped label", row?.label === "Persisted", row?.label);
    removeCustomAgent(persisted.id);
  }

  section("launch overrides win over discovery and survive a reload");
  {
    const line = `"${process.execPath}" --custom-flag`;
    writeLaunchOverrides({ pi: line });
    onlyPath([cliBin]);
    const pi = profile("pi");
    check("the override is used even without an adapter", pi?.state === "ready", pi?.stateReason);
    check("the source is override", pi?.origin === "override", pi?.origin);
    check("the quoted path survives", parseLaunchLine(line)[0] === process.execPath);
    check("the override args are applied", (pi?.launch.args ?? []).join(" ") === "--custom-flag");
    check(
      "the override persisted in Absence's own file",
      readAgentsFile().launch.pi === line,
      readAgentsFile().launch.pi,
    );
    writeLaunchOverrides({});
    onlyPath([cliBin, adapterBin]);
  }

  section("read-only agent config: models and auth facts, never values");
  {
    makeBin(adapterBin, "codex-acp");
    makeBin(adapterBin, "claude-code-acp");
    const piDir = path.join(temp, "pi-agent");
    const codexDir = path.join(temp, "codex");
    const claudeDir = path.join(temp, "claude");
    fs.mkdirSync(piDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });

    const secret = "sk-secret-value-must-not-leak";
    fs.writeFileSync(
      path.join(piDir, "models.json"),
      JSON.stringify({
        providers: {
          "qwen-local": {
            apiKey: secret,
            models: [{ id: "qwen3-4b" }, { id: "qwen3-0.6b" }],
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(piDir, "auth.json"), "{}", "utf8");
    process.env.PI_CODING_AGENT_DIR = piDir;
    onlyPath([cliBin, adapterBin]);

    const pi = profile("pi");
    check("pi's models come from its own config", pi?.models.state === "declared", pi?.models.state);
    check(
      "provider/model pairs are listed",
      (pi?.models.items ?? []).includes("qwen-local/qwen3-4b"),
      (pi?.models.items ?? []).join(", "),
    );
    check("the model file is named", pi?.models.path === path.join(piDir, "models.json"), pi?.models.path);
    check("auth is configured", pi?.authStatus === "configured", pi?.authStatus);
    const leaked = JSON.stringify(pi ?? {}) + (pi?.authReason ?? "");
    check("no credential value leaks into the row", !leaked.includes(secret));

    // Corrupt file → unknown, and the server still lists the row.
    fs.writeFileSync(path.join(piDir, "models.json"), "{ this is not json", "utf8");
    const corrupt = profile("pi");
    check("a corrupt config yields unknown models", corrupt?.models.state === "unknown", corrupt?.models.state);
    check("the row itself still resolves", corrupt?.state === "ready", corrupt?.stateReason);

    // Parsed but no model entries → "empty" (not "unknown").
    fs.writeFileSync(path.join(piDir, "models.json"), JSON.stringify({ providers: {} }), "utf8");
    const empty = profile("pi");
    check("an empty config is 'empty', not a guess", empty?.models.state === "empty", empty?.models.state);
    check("it carries no invented models", (empty?.models.items ?? []).length === 0);

    // Missing directory → unknown, and reading must not create it.
    const absentDir = path.join(temp, "absent-agent");
    process.env.PI_CODING_AGENT_DIR = absentDir;
    const missingConfig = profile("pi");
    check(
      "a missing config yields unknown models",
      missingConfig?.models.state === "unknown",
      missingConfig?.models.state,
    );
    check("reading did not create the directory", !fs.existsSync(absentDir));

    // Codex: a provider that requires no OpenAI sign-in.
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      [
        'model = "gpt-5"',
        'model_provider = "custom"',
        "",
        "[model_providers.custom]",
        "requires_openai_auth = false",
      ].join("\n"),
      "utf8",
    );
    process.env.CODEX_HOME = codexDir;
    const codex = profile("codex");
    check(
      "codex's model is read from config.toml",
      (codex?.models.items ?? []).includes("gpt-5"),
      (codex?.models.items ?? []).join(","),
    );
    check("codex reports its provider's no-auth mode", codex?.authStatus === "configured", codex?.authReason);
    check("codex is ready", codex?.state === "ready", codex?.stateReason);

    // Codex with no credentials → needs-auth (an honest, positive conclusion).
    fs.writeFileSync(path.join(codexDir, "config.toml"), 'model = "gpt-5"\n', "utf8");
    const needsAuth = profile("codex");
    check("codex without credentials is needs-auth", needsAuth?.state === "needs-auth", needsAuth?.stateReason);
    check(
      "the reason names the missing credentials",
      /credentials missing/i.test(needsAuth?.stateReason ?? ""),
      needsAuth?.stateReason,
    );

    // Claude: model ids and credential presence, no values.
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: secret, ANTHROPIC_MODEL: "qwen3-0.6b" } }),
      "utf8",
    );
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const claude = profile("claude-code");
    check(
      "claude's models are read from settings.json",
      (claude?.models.items ?? []).includes("qwen3-0.6b"),
      (claude?.models.items ?? []).join(","),
    );
    check("claude's credential presence is detected", claude?.authStatus === "configured", claude?.authReason);
    check(
      "claude's secret does not leak",
      !(JSON.stringify(claude ?? {}) + (claude?.authReason ?? "")).includes(secret),
    );
    check("claude is ready", claude?.state === "ready", claude?.stateReason);

    // Proof of no writes: the agent directories are byte-for-byte unchanged.
    const before = [snapshot(piDir), snapshot(codexDir), snapshot(claudeDir)].join("\n");
    for (let index = 0; index < 3; index += 1) {
      profile("pi");
      profile("codex");
      profile("claude-code");
      runtimeStatuses();
    }
    const after = [snapshot(piDir), snapshot(codexDir), snapshot(claudeDir)].join("\n");
    check("no agent file was created, changed or removed", before === after, `${before}\n---\n${after}`);

    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.CODEX_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  section("acp session models beat the static config (row shape only)");
  {
    const statuses = runtimeStatuses({ pi: "session-model-x" });
    const pi = statuses.find((status) => status.kind === "pi") as Record<string, unknown> | undefined;
    check("the row exists", pi !== undefined);
    check("state is reported", typeof pi?.state === "string");
    check("stateReason is reported", typeof pi?.stateReason === "string");
    check(
      "source is reported",
      pi?.source === "auto" || pi?.source === "override" || pi?.source === "manual",
    );
    check("auth is reported", typeof pi?.auth === "string");
    const models = pi?.models as { state?: string; items?: string[] } | undefined;
    check("session models take precedence", models?.state === "session", JSON.stringify(models));
    check("the session model is shown", (models?.items ?? []).includes("session-model-x"));
    check("no piBin field on a row", !("piBin" in (pi ?? {})));
    check("no codexBin field on a row", statuses.every((status) => !("codexBin" in status)));
  }

  section("static: no product-name branches outside the profile data");
  {
    const allowed = new Set(["profiles.ts"]);
    const pattern = /(===|!==)\s*["'](pi|codex|dsh|claude)["']|case\s*["'](pi|codex|dsh|claude)["']/;
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

    // The picker renders server rows; it must not decide anything per product.
    const pickerFile = path.join(
      repoRoot,
      "apps",
      "web",
      "src",
      "components",
      "ProjectPicker",
      "ProjectPicker.tsx",
    );
    const pickerSource = fs.readFileSync(pickerFile, "utf8");
    check(
      "the picker has no product-name branch",
      !/(===|!==|case)\s*["'](pi|codex|dsh|claude|qwen|gemini)["']/.test(pickerSource),
    );
  }
} finally {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true });
}

finish("agent catalog checks");
