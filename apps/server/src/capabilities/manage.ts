import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* ══════════════════════════════════════════════════════════════════════════
   Capability management — the writable half of capabilities/discover.ts.

   Discovery answers "what does this session have"; this module answers "make
   it have something else". Both work on the same cross-runtime files, so an
   action taken here is visible to Pi, Codex and DSH alike:

     skills  a directory with a SKILL.md. Absence can create one from a name +
               description, or import an existing skill folder (or a bare
               SKILL.md) the user drops in. Deletion only ever removes a folder
               Absence can see in its own skill roots — never ~/.pi or the
               project's .agents unless it really is the skill folder.
     MCP     an `mcpServers` entry. New servers are written to Pi's user-level
               `~/.pi/agent/mcp.json` (the file every Pi session reads), with
               the `enabled` flag Pi and Codex both honour. Codex-only servers
               live in `config.toml` and are flagged read-only here: rewriting
               a user's TOML is not something a valid-json editor should do.

   Where files go (and therefore what is editable) is resolved once, so the UI
   can say exactly which directory an action wrote to.
   ══════════════════════════════════════════════════════════════════════════ */

export interface CapabilityPaths {
  /** Pi's agent dir (`~/.pi/agent`, honouring PI_CODING_AGENT_DIR). */
  agentDir: string;
  /** `~/.agents/skills` — where new user skills are written. */
  userSkillsDir: string;
  /** Pi's user MCP config. */
  mcpConfig: string;
  /** The project's `.pi/mcp.json`, when a session is open. */
  projectMcpConfig?: string;
  /** Codex's `config.toml` (read-only for Absence). */
  codexConfig: string;
  /** The project's skill roots, for provenance. */
  projectSkillDirs: string[];
}

export interface EditableMcpEntry {
  name: string;
  /** `stdio` | `http` */
  type: string;
  command?: string;
  args?: string[];
  url?: string;
  /** `codemode` | `deferred` | `direct` | `hidden` */
  exposure?: string;
  description?: string;
  enabled: boolean;
  /** `user` (`~/.pi/agent/mcp.json`) or `project` (`.pi/mcp.json`). */
  scope: "user" | "project" | "codex";
  /** True when Absence may edit the entry (everything except Codex TOML). */
  editable: boolean;
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function capabilityPaths(cwd?: string): CapabilityPaths {
  const home = os.homedir();
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
    ? process.env.PI_CODING_AGENT_DIR.trim().replace(/^~(?=$|[\\/])/, home)
    : path.join(home, ".pi", "agent");
  return {
    agentDir,
    userSkillsDir: path.join(home, ".agents", "skills"),
    mcpConfig: path.join(agentDir, "mcp.json"),
    projectMcpConfig: cwd ? path.join(cwd, ".pi", "mcp.json") : undefined,
    codexConfig: path.join(process.env.CODEX_HOME?.trim() || path.join(home, ".codex"), "config.toml"),
    projectSkillDirs: cwd
      ? [path.join(cwd, ".agents", "skills"), path.join(cwd, ".pi", "skills")]
      : [],
  };
}

/* ── mcp.json ────────────────────────────────────────────────────────────── */

interface McpFile {
  path: string;
  scope: "user" | "project";
  data: Record<string, unknown> & { mcpServers?: Record<string, unknown> };
}

function readMcpFile(filePath: string, scope: "user" | "project"): McpFile | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const data = parsed as McpFile["data"];
    if (data.mcpServers !== undefined && (typeof data.mcpServers !== "object" || data.mcpServers === null)) {
      return undefined;
    }
    return { path: filePath, scope, data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: filePath, scope, data: {} };
    }
    return undefined;
  }
}

function writeMcpFile(file: McpFile): void {
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, `${JSON.stringify(file.data, null, 2)}\n`, "utf8");
}

/** The editable list for the settings pane: user, then project entries. */
export function listMcpEntries(cwd?: string): { dir: string; entries: EditableMcpEntry[] } {
  const paths = capabilityPaths(cwd);
  const entries: EditableMcpEntry[] = [];
  const files = [
    readMcpFile(paths.mcpConfig, "user"),
    paths.projectMcpConfig ? readMcpFile(paths.projectMcpConfig, "project") : undefined,
  ].filter((file): file is McpFile => file !== undefined);

  const seen = new Set<string>();
  for (const file of files) {
    for (const [name, raw] of Object.entries(file.data.mcpServers ?? {})) {
      if (seen.has(name)) continue; // the project entry shadows the user entry
      seen.add(name);
      const entry = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      entries.push({
        name,
        type: typeof entry.url === "string" ? "http" : "stdio",
        command: typeof entry.command === "string" ? entry.command : undefined,
        args: Array.isArray(entry.args) ? entry.args.map(String) : undefined,
        url: typeof entry.url === "string" ? entry.url : undefined,
        exposure: typeof entry.exposure === "string" ? entry.exposure : undefined,
        description: typeof entry.description === "string" ? entry.description : undefined,
        enabled: entry.enabled !== false,
        scope: file.scope,
        editable: true,
      });
    }
  }
  return { dir: paths.mcpConfig, entries };
}

export interface McpInput {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  exposure?: string;
  description?: string;
  enabled?: boolean;
}

/** Add or replace a user-level server in `~/.pi/agent/mcp.json`. */
export function saveMcpEntry(input: McpInput): { path: string; entry: EditableMcpEntry } {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) throw new Error("name may use letters, digits, _ and -");
  const paths = capabilityPaths();
  const file = readMcpFile(paths.mcpConfig, "user") ?? { path: paths.mcpConfig, scope: "user" as const, data: {} };

  let entry: Record<string, unknown>;
  if (input.type === "http") {
    const url = input.url?.trim() ?? "";
    if (!/^https?:\/\//i.test(url)) throw new Error("an http server needs a url (https://…)");
    entry = { url };
    if (input.headers && Object.keys(input.headers).length > 0) entry.headers = input.headers;
  } else {
    const command = input.command?.trim() ?? "";
    if (!command) throw new Error("a stdio server needs a command");
    entry = { command };
    if (input.args && input.args.length > 0) entry.args = input.args;
    if (input.env && Object.keys(input.env).length > 0) entry.env = input.env;
  }
  if (input.exposure) entry.exposure = input.exposure;
  if (input.description?.trim()) entry.description = input.description.trim();
  entry.enabled = input.enabled !== false;

  file.data.mcpServers = { ...(file.data.mcpServers ?? {}), [name]: entry };
  writeMcpFile(file);
  return {
    path: paths.mcpConfig,
    entry: {
      name,
      type: input.type,
      command: input.command,
      args: input.args,
      url: input.url,
      exposure: input.exposure,
      description: input.description,
      enabled: entry.enabled !== false,
      scope: "user",
      editable: true,
    },
  };
}

/** Flip `enabled` on a user or project entry. Codex TOML servers are refused. */
export function setMcpEnabled(name: string, enabled: boolean, cwd?: string): { path: string } {
  const paths = capabilityPaths(cwd);
  for (const file of [readMcpFile(paths.mcpConfig, "user"), paths.projectMcpConfig ? readMcpFile(paths.projectMcpConfig, "project") : undefined]) {
    if (!file) continue;
    const servers = file.data.mcpServers;
    if (!servers || !(name in servers)) continue;
    const raw = servers[name];
    const entry = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
    entry.enabled = enabled;
    servers[name] = entry;
    writeMcpFile(file);
    return { path: file.path };
  }
  throw new Error(`server "${name}" is not defined in mcp.json (Codex's config.toml is read-only here)`);
}

/** Remove a user or project entry. */
export function deleteMcpEntry(name: string, cwd?: string): { path: string } {
  const paths = capabilityPaths(cwd);
  for (const file of [readMcpFile(paths.mcpConfig, "user"), paths.projectMcpConfig ? readMcpFile(paths.projectMcpConfig, "project") : undefined]) {
    if (!file) continue;
    const servers = file.data.mcpServers;
    if (!servers || !(name in servers)) continue;
    delete servers[name];
    writeMcpFile(file);
    return { path: file.path };
  }
  throw new Error(`server "${name}" is not defined in mcp.json (Codex's config.toml is read-only here)`);
}

/* ── skills ──────────────────────────────────────────────────────────────── */

export interface SkillInput {
  name: string;
  description: string;
  /** Optional body below the frontmatter; a short template when omitted. */
  body?: string;
  /** `user` (`~/.agents/skills`) or `project` (`<cwd>/.agents/skills`). */
  scope?: "user" | "project";
}

function userSkillDir(name: string): string {
  return path.join(capabilityPaths().userSkillsDir, name);
}

function projectSkillDir(name: string, cwd: string): string {
  return path.join(cwd, ".agents", "skills", name);
}

/** Create a skill folder with a SKILL.md (refuses to overwrite). */
export function createSkill(input: SkillInput, cwd?: string): { dir: string; filePath: string } {
  const name = input.name.trim().toLowerCase();
  if (!SKILL_NAME_RE.test(name) || name.length > 64) {
    throw new Error("skill names use lowercase letters, digits and hyphens (max 64)");
  }
  const description = input.description.trim();
  if (!description) throw new Error("a skill needs a description (it is how the agent finds it)");
  if (description.length > 1024) throw new Error("description is limited to 1024 characters");

  const dir = input.scope === "project" && cwd ? projectSkillDir(name, cwd) : userSkillDir(name);
  const filePath = path.join(dir, "SKILL.md");
  if (fs.existsSync(filePath)) throw new Error(`skill "${name}" already exists at ${filePath}`);

  const body =
    input.body?.trim() ||
    [
      `# ${name}`,
      "",
      "Describe what the agent should do when this skill applies. Relative paths",
      "in this file resolve against this directory.",
    ].join("\n");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
  return { dir, filePath };
}

/** A files-only import of one skill folder (e.g. from a native file picker). */
export interface SkillUploadFile {
  /** Path relative to the skill folder, e.g. `SKILL.md` or `scripts/run.sh`. */
  path: string;
  data: Buffer;
}

/**
 * Import a skill folder. Every path is confined to the destination folder:
 * a dropped file may not escape it (`../`), and the folder may not already
 * hold a different skill. `SKILL.md` is required and must declare a
 * description, so a broken drop is rejected before anything is written.
 */
export function importSkill(
  files: SkillUploadFile[],
  options: { scope?: "user" | "project"; cwd?: string; overwrite?: boolean } = {},
): { dir: string; filePath: string } {
  if (files.length === 0) throw new Error("no files to import");
  const skillFile = files.find((file) => path.basename(file.path) === "SKILL.md" && !file.path.includes(".."));
  if (!skillFile) throw new Error("the folder must contain a SKILL.md");

  // Read the name from the frontmatter so the destination matches the skill.
  const text = skillFile.data.toString("utf8");
  const meta = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const declared = /^name:\s*(.+)$/m.exec(meta)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const description = /^description:\s*(.+)$/m.exec(meta)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!description) throw new Error("SKILL.md must declare a description");
  const name = (declared ?? path.basename(path.dirname(skillFile.path))).trim();
  if (!SKILL_NAME_RE.test(name) || name.length > 64) {
    throw new Error(`invalid skill name "${name}" (lowercase letters, digits, hyphens)`);
  }

  const dir =
    options.scope === "project" && options.cwd ? projectSkillDir(name, options.cwd) : userSkillDir(name);
  const root = path.resolve(dir);
  for (const file of files) {
    const target = path.resolve(root, file.path);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`refusing to write outside the skill folder: ${file.path}`);
    }
  }
  if (fs.existsSync(dir) && !options.overwrite) {
    throw new Error(`skill "${name}" already exists at ${dir}`);
  }
  if (options.overwrite && fs.existsSync(dir)) {
    // Only replace a folder that is really a skill, never a stray directory.
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) throw new Error(`${dir} exists and is not a skill folder`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const target = path.resolve(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data);
  }
  return { dir, filePath: path.join(dir, "SKILL.md") };
}

/**
 * Delete a skill folder. Only a directory Absence discovered as a skill may be
 * removed — a path that is not exactly one of the known skill roots' children
 * is refused, so a bad id cannot remove `~/.agents/skills` itself.
 */
export function deleteSkill(filePath: string, cwd?: string): { dir: string } {
  const target = path.resolve(filePath);
  if (path.basename(target) !== "SKILL.md") throw new Error("expected a SKILL.md path");
  const dir = path.dirname(target);
  const paths = capabilityPaths(cwd);
  const home = os.homedir();
  const roots = [
    paths.userSkillsDir,
    paths.agentDir ? path.join(paths.agentDir, "skills") : "",
    ...paths.projectSkillDirs,
    process.env.DSH_HOME?.trim() ? path.join(process.env.DSH_HOME.trim(), "skills") : path.join(home, ".dsh", "skills"),
    path.join(process.env.CODEX_HOME?.trim() || path.join(home, ".codex"), "skills"),
  ].filter(Boolean);
  const allowed = roots.some((root) => {
    const resolved = path.resolve(root);
    return dir.startsWith(resolved + path.sep);
  });
  if (!allowed) throw new Error(`refusing to delete ${dir}: not inside a known skills directory`);
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) throw new Error(`${dir} is not a skill folder`);
  fs.rmSync(dir, { recursive: true, force: true });
  return { dir };
}

/** The directories the pane should show, so an empty list is explainable. */
export function skillLocations(cwd?: string): string[] {
  const paths = capabilityPaths(cwd);
  const home = os.homedir();
  return [
    paths.userSkillsDir,
    path.join(paths.agentDir, "skills"),
    path.join(process.env.CODEX_HOME?.trim() || path.join(home, ".codex"), "skills"),
    path.join(process.env.DSH_HOME?.trim() || path.join(home, ".dsh"), "skills"),
    ...paths.projectSkillDirs,
  ];
}
