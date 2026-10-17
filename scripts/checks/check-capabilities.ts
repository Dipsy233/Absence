/**
 * Offline check of capability discovery — skills and MCP servers.
 *
 *   npx tsx scripts/checks/check-capabilities.ts
 *
 * These are the two formats every runtime Absence observes has converged on:
 * a directory with a SKILL.md (the Agent Skills spec), and an `mcpServers`
 * object (Pi's mcp.json, Codex's config.toml). The check builds a throwaway
 * HOME with both, then reads them back through the real discovery code and
 * through Pi's own loader, so a regression in either shows up here:
 *
 *   • every skills location is searched, ancestors stop at the repo root
 *   • a skill without a description is reported, not silently dropped
 *   • mcp.json project entries override user entries by name
 *   • Codex's [mcp_servers.*] TOML is read into the same shape
 *   • Pi's DefaultResourceLoader receives the discovered skills, and the MCP
 *     extension is in the factory list (an SDK session would otherwise never
 *     read mcp.json — see apps/server/src/capabilities/piResources.ts)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish, section } from "./harness";
import {
  discoverCapabilities,
  mcpServersFromCodexToml,
} from "../../apps/server/src/capabilities/discover";
import { planPiCapabilities } from "../../apps/server/src/capabilities/piResources";
import {
  createSkill,
  deleteMcpEntry,
  deleteSkill,
  importSkill,
  listMcpEntries,
  saveMcpEntry,
  setMcpEnabled,
} from "../../apps/server/src/capabilities/manage";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "absence-capabilities-")));
const home = path.join(root, "home");
// Discovery reads the *user* skill roots from the real HOME (that is the point
// of the check), so redirect it for the duration of the run.
const previousHome = process.env.HOME;
process.env.HOME = home;
process.env.USERPROFILE = home;
const project = path.join(root, "repo", "project");
const agentDir = path.join(home, ".pi", "agent");
const codexHome = path.join(home, ".codex");
const dshHome = path.join(home, ".dsh");

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function skill(dir: string, name: string, description: string): void {
  write(
    path.join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing.\n`,
  );
}

function cleanup(): void {
  fs.rmSync(root, { recursive: true, force: true });
}

try {
  // ── a project inside a git repo, with the repo root two levels up ────────
  write(path.join(root, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(project, { recursive: true });

  section("skills: every location, first found wins");
  skill(path.join(project, ".agents", "skills"), "project-skill", "A project skill");
  skill(path.join(project, ".pi", "skills"), "pi-project-skill", "A .pi project skill");
  skill(path.join(root, "repo", ".agents", "skills"), "repo-skill", "Inherited from the repo root");
  skill(path.join(root, ".agents", "skills"), "outside-repo", "Must NOT leak past the repo root");
  skill(path.join(home, ".agents", "skills"), "user-agents-skill", "A user Agent Skills skill");
  check("homedir is redirected for the check", os.homedir() === home, os.homedir());
  skill(path.join(agentDir, "skills"), "pi-user-skill", "A Pi user skill");
  skill(path.join(codexHome, "skills"), "codex-user-skill", "A Codex user skill");
  skill(path.join(dshHome, "skills"), "dsh-user-skill", "A DSH user skill");
  // A nested skill under a skill directory must not be found (SKILL.md stops the walk).
  skill(path.join(project, ".pi", "skills", "pi-project-skill", "nested"), "nested", "Should not appear");
  // A skill with no description is invalid per the spec.
  write(
    path.join(project, ".pi", "skills", "broken", "SKILL.md"),
    `---\nname: broken\n---\n\n# broken\n`,
  );

  const first = discoverCapabilities({ cwd: project, agentDir, codexHome, dshHome });
  const names = first.skills.map((s) => s.name);
  check("project .agents skill found", names.includes("project-skill"));
  check("project .pi skill found", names.includes("pi-project-skill"));
  check("repo-root .agents skill inherited", names.includes("repo-skill"));
  check("no leak past the repo root", !names.includes("outside-repo"));
  check("user ~/.agents skill found", names.includes("user-agents-skill"));
  check("user Pi skill found", names.includes("pi-user-skill"));
  check("user Codex skill found", names.includes("codex-user-skill"));
  check("user DSH skill found", names.includes("dsh-user-skill"));
  check("nested SKILL.md not descended into", !names.includes("nested"));
  check(
    "invalid skill reported",
    first.diagnostics.some((d) => d.path?.endsWith(path.join("broken", "SKILL.md"))),
  );
  check(
    "skill carries a baseDir",
    first.skills.find((s) => s.name === "project-skill")?.baseDir === path.join(project, ".agents", "skills", "project-skill"),
  );

  section("mcp: shared mcpServers shape, project overrides user");
  write(
    path.join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
        docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
        off: { command: "uvx", args: ["off"], enabled: false },
        // An override-only entry: legal, inherits the rest.
        overridden: { command: "old", args: ["old"] },
      },
    }),
  );
  write(
    path.join(project, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { overridden: { exposure: "direct" } } }),
  );
  write(
    path.join(codexHome, "config.toml"),
    [
      "[mcp_servers.codex-only]",
      'command = "node"',
      'args = ["server.mjs", "--flag"]',
      "",
      "[mcp_servers.codex-only.env]",
      'TOKEN = "abc"',
      "",
      "[mcp_servers.filesystem]",
      'command = "codex-shadowed"',
      "",
      "[other]",
      'x = "y"',
      "",
    ].join("\n"),
  );

  section("codex: TOML [mcp_servers.*] parsed into the mcpServers shape");
  const toml = mcpServersFromCodexToml(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"));
  check("stdio command read", toml["codex-only"]?.command === "node");
  check("args read", JSON.stringify(toml["codex-only"]?.args) === JSON.stringify(["server.mjs", "--flag"]));
  check("nested env read", (toml["codex-only"]?.env as Record<string, string>)?.TOKEN === "abc");
  check("unrelated table ignored", toml["other"] === undefined);

  const second = discoverCapabilities({ cwd: project, agentDir, codexHome, dshHome });
  const servers = new Map(second.mcpServers.map((server) => [server.name, server]));
  check("mcp.json stdio server", servers.get("filesystem")?.type === "stdio");
  check("mcp.json http server", servers.get("docs")?.type === "http");
  check("http headers kept", servers.get("docs")?.headers?.Authorization === "Bearer ${DOCS_TOKEN}");
  check("disabled entry kept, flagged", servers.get("off")?.enabled === false);
  check("project override merges field", servers.get("overridden")?.exposure === "direct");
  check("project override keeps the command", servers.get("overridden")?.command === "old");
  check("codex TOML server discovered", servers.get("codex-only")?.source === "codex");
  check("pi mcp.json wins over codex for the same name", servers.get("filesystem")?.command === "npx");
  check(
    "namespace matches Pi's tool prefix",
    servers.get("codex-only")?.namespace === "codex_only",
  );

  section("pi: the resource loader gets skills, the MCP extension is loaded");
  const sdk = await import("@earendil-works/pi-coding-agent");
  const plan = planPiCapabilities(sdk, {
    cwd: project,
    agentDir,
    mcp: true,
    skills: second.skills,
    mcpServers: second.mcpServers,
  });
  check("a loader factory is produced", typeof plan.createLoader === "function");
  check("MCP extension is in the factory list", plan.extensionFactories.length >= 1);
  check("mcp servers reported to the caller", plan.mcpServers.includes("filesystem"));

  if (plan.createLoader) {
    const loader = plan.createLoader({ cwd: project, agentDir });
    await loader.reload();
    const loaded = loader.getSkills().skills.map((s) => s.name);
    check("Pi's loader sees the project .agents skill", loaded.includes("project-skill"));
    check("Pi's loader sees the user ~/.agents skill", loaded.includes("user-agents-skill"));
    check(
      "injected skills are not duplicated",
      loaded.filter((name) => name === "project-skill").length === 1,
    );
    const extensionPaths = loader.getExtensions().extensions.map((extension) => extension.path);
    check(
      "MCP extension factory was loaded",
      extensionPaths.some((p) => p.includes("inline") || p.includes("mcp")),
      extensionPaths.join(", "),
    );
  }

  section("pi: the tool list must not silently disable direct MCP tools");
  // Pi's `_isActivatable`: when the session has an allowlist and an MCP tool is
  // not named in it, the tool is only activatable for non-`direct` exposure.
  // A config that always passed ["read","bash",…] therefore connected `direct`
  // servers, registered their tools, and never declared them to the model.
  // `ABSENCE_PI_TOOLS` unset must stay undefined so Pi uses its own
  // `defaultTools` (see AbsenceConfig.piTools).
  const parsed = (await import("../../apps/server/src/config")).config.piTools;
  check(
    "ABSENCE_PI_TOOLS unset → no allowlist is passed",
    process.env.ABSENCE_PI_TOOLS !== undefined || parsed === undefined,
    JSON.stringify(parsed),
  );

  section("pi: MCP can be switched off");
  const disabled = planPiCapabilities(sdk, {
    cwd: project,
    agentDir,
    mcp: false,
    skills: [],
    mcpServers: second.mcpServers,
  });
  check("no factories when MCP is off", disabled.extensionFactories.length === 0);
  check("no loaders skipped when MCP is off", typeof disabled.createLoader === "function");
section("manage: writes land in the shared files, and refuse to escape");
{
  const cwd = project;
  // A created skill is templated, discoverable, and reported where it landed.
  const created = createSkill({ name: "new-skill", description: "Created by the settings pane" }, cwd);
  check("skill folder is the user-level one", created.dir === path.join(home, ".agents", "skills", "new-skill"));
  const createdText = fs.readFileSync(created.filePath, "utf8");
  check(
    "frontmatter carries name + description",
    createdText.includes("name: new-skill") && createdText.includes("description: Created by the settings pane"),
  );
  check(
    "created skill is discovered",
    discoverCapabilities({ cwd, agentDir, codexHome, dshHome }).skills.some((s) => s.name === "new-skill"),
  );
  let rejected = false;
  try {
    createSkill({ name: "new-skill", description: "again" }, cwd);
  } catch {
    rejected = true;
  }
  check("an existing skill is not overwritten", rejected);
  let badName = false;
  try {
    createSkill({ name: "Not Valid", description: "x" }, cwd);
  } catch {
    badName = true;
  }
  check("invalid skill names are refused", badName);

  // Import: a folder with scripts/ keeps its relative paths.
  const imported = importSkill(
    [
      {
        path: "SKILL.md",
        data: Buffer.from(["---", "name: imported", "description: Imported folder", "---", "body", ""].join("\n")),
      },
      { path: "scripts/run.sh", data: Buffer.from("echo hi" + String.fromCharCode(10)) },
    ],
    { cwd },
  );
  check("imported folder keeps scripts/", fs.existsSync(path.join(imported.dir, "scripts", "run.sh")));
  let escaped = false;
  try {
    importSkill(
      [
        { path: "SKILL.md", data: Buffer.from(["---", "name: evil", "description: nope", "---", ""].join("\n")) },
        { path: "../../escape.txt", data: Buffer.from("x") },
      ],
      { cwd },
    );
  } catch {
    escaped = true;
  }
  check("import refuses paths outside the folder", escaped);
  let noDescription = false;
  try {
    importSkill([{ path: "SKILL.md", data: Buffer.from(["---", "name: nodesc", "---", ""].join("\n")) }], { cwd });
  } catch {
    noDescription = true;
  }
  check("import requires a description", noDescription);

  // Deletion is confined to known skill roots.
  let outside = false;
  try {
    deleteSkill(path.join(root, "repo", "SKILL.md"), cwd);
  } catch {
    outside = true;
  }
  check("delete refuses a path outside the skill roots", outside);
  deleteSkill(created.filePath, cwd);
  check("delete removes the skill folder", !fs.existsSync(created.dir));

  // MCP: a saved server replaces the same-name entry and is discoverable.
  const saved = saveMcpEntry({ name: "added", type: "stdio", command: "node", args: ["s.mjs"], description: "Added here" });
  check("server written to ~/.pi/agent/mcp.json", saved.path === path.join(agentDir, "mcp.json"));
  const listed = listMcpEntries(cwd);
  check("listed with its scope", listed.entries.find((e) => e.name === "added")?.scope === "user");
  check("listed as enabled", listed.entries.find((e) => e.name === "added")?.enabled === true);
  setMcpEnabled("added", false, cwd);
  check(
    "toggle writes enabled:false",
    listMcpEntries(cwd).entries.find((e) => e.name === "added")?.enabled === false,
  );
  check(
    "the disabled server is still discovered (flagged)",
    discoverCapabilities({ cwd, agentDir, codexHome, dshHome }).mcpServers.find((s) => s.name === "added")?.enabled ===
      false,
  );
  deleteMcpEntry("added", cwd);
  check("delete removes it", !listMcpEntries(cwd).entries.some((e) => e.name === "added"));
  let codexReadOnly = false;
  try {
    setMcpEnabled("codex-only", false, cwd);
  } catch {
    codexReadOnly = true;
  }
  check("codex TOML servers are read-only", codexReadOnly);
  check(
    "unrelated mcp.json entries survive the edits",
    listMcpEntries(cwd).entries.some((e) => e.name === "filesystem"),
  );
}
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  cleanup();
}

finish("capability checks");
