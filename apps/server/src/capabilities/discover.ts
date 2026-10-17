import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* ══════════════════════════════════════════════════════════════════════════
   Capabilities — MCP servers and skills, discovered the same way for every
   runtime Absence observes.

   The three runtimes Absence drives have converged on two file formats, and
   they are the *same* formats:

     MCP     `mcp.json` with the `mcpServers` object, shared by Pi, Codex,
             Claude Code, Cursor and most other clients. Pi reads
             `~/.pi/agent/mcp.json` + `<project>/.pi/mcp.json`; Codex reads
             `~/.codex/config.toml` (TOML, converted below). The stdio/HTTP
             entry shape is identical, so one config feeds either runtime.
     Skills  a directory containing `SKILL.md` with `name` + `description`
             frontmatter (the Agent Skills spec, agentskills.io). Pi looks in
             `~/.agents/skills`, `~/.pi/agent/skills`, `<project>/.agents/skills`
             (ancestors up to the repo root) and `<project>/.pi/skills`; Codex
             looks in `~/.agents/skills` and `~/.codex/skills`.

   So Absence owns *discovery* here — one scan, one list — and hands the result
   to the runtime that can consume it. The adapters stay thin:

     Pi     resources are real: skills are injected into the resource loader
            (so they reach the system prompt), and MCP servers are fed to
            Pi's own `createMcpExtension` (or registered with
            `pi.registerMcpServer`), which connects them per session.
     Codex  reads the same two files itself over its own config: skills via
            the app-server's `skills/list`, MCP via `mcpServerStatus/list`.
            Discovery here is the fallback and the shared view.
     DSH    discovers `<DSH_HOME>/skills`; its tool calls already arrive as
            events, so an MCP or skill invocation shows up on the Stage
            without extra wiring.

   Nothing here executes anything: this module only reads files. The adapters
   decide what to do with the list.
   ══════════════════════════════════════════════════════════════════════════ */

/** One MCP server, in the cross-client `mcpServers` shape. */
export interface McpServerSpec {
  name: string;
  /** `stdio` when `command` is set, `http` when `url` is set. */
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** `codemode` (Pi default) | `deferred` | `direct` | `hidden`. */
  exposure?: string;
  description?: string;
  enabled?: boolean;
  timeout?: number;
  /** Where this entry came from, for the picker's provenance label. */
  source?: "user" | "project" | "codex" | "dsh";
  /** The file that defined it. */
  configPath?: string;
  /**
   * The name a runtime gives the server's tools (`mcp__<namespace>__<tool>`).
   * Pi replaces every character other than letters, digits and `_`, so a
   * server called `github-search` namespaces as `mcp__github_search`.
   */
  namespace?: string;
}

/** One skill: a directory with a SKILL.md. */
export interface SkillSpec {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md. */
  filePath: string;
  /** The directory relative paths in the skill resolve against. */
  baseDir: string;
  /** `user` (`~/.agents/skills`, `~/.pi/agent/skills`) or `project` (`<cwd>/.agents/skills`, …). */
  scope: "user" | "project" | string;
  /** A stable key: the skill's name plus where it was found. */
  id: string;
}

export interface CapabilityDiagnostic {
  type: "warning" | "error";
  message: string;
  path?: string;
}

export interface DiscoveredCapabilities {
  skills: SkillSpec[];
  mcpServers: McpServerSpec[];
  diagnostics: CapabilityDiagnostic[];
  /** Where each kind was looked for, so the UI can say why a list is empty. */
  searched: {
    skills: string[];
    mcp: string[];
  };
}

export interface DiscoverOptions {
  /** The project (session) working directory. */
  cwd: string;
  /** Pi's agent dir (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR`). */
  agentDir?: string;
  /** Codex's home (`~/.codex`, or `$CODEX_HOME`). */
  codexHome?: string;
  /** DSH's home (`~/.dsh`, or `$DSH_HOME`). */
  dshHome?: string;
}

/* ── skills ──────────────────────────────────────────────────────────────── */

const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

interface Frontmatter {
  [key: string]: string | undefined;
}

/** Parse the leading `---` YAML block. Flat `key: value` pairs only — that is
 *  all the Agent Skills spec uses for name/description. */
function parseFrontmatter(text: string): Frontmatter {
  const out: Frontmatter = {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return out;
  for (const rawLine of match[1]!.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Walk one skills root, following Pi's own discovery rules: a directory that
 * contains `SKILL.md` is a skill and is not searched further; otherwise look
 * in subdirectories. `.gitignore`/`.fdignore` are honoured by Pi itself when
 * it loads the directory — this scan only has to *list* the same skills.
 */
function scanSkillDir(dir: string, scope: string, out: SkillSpec[], diagnostics: CapabilityDiagnostic[]): void {
  if (!isDirectory(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const skillFile = entries.find((entry) => entry.name === "SKILL.md" && (entry.isFile() || entry.isSymbolicLink()));
  if (skillFile) {
    const fullPath = path.join(dir, "SKILL.md");
    const spec = readSkill(fullPath, dir, scope, diagnostics);
    if (spec) out.push(spec);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const child = path.join(dir, entry.name);
    let childIsDir = entry.isDirectory();
    if (entry.isSymbolicLink()) childIsDir = isDirectory(child);
    if (childIsDir) scanSkillDir(child, scope, out, diagnostics);
  }
}

/** Read one SKILL.md's frontmatter. A skill without a declared name falls back
 *  to its directory name, which the spec allows (matching names are portable). */
function readSkill(
  filePath: string,
  baseDir: string,
  scope: string,
  diagnostics: CapabilityDiagnostic[],
): SkillSpec | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    diagnostics.push({ type: "warning", message: `Cannot read skill: ${String(error)}`, path: filePath });
    return undefined;
  }
  const meta = parseFrontmatter(text);
  const name = (meta.name ?? path.basename(baseDir)).trim();
  const description = (meta.description ?? "").trim();
  if (!name || name.length > MAX_NAME) {
    diagnostics.push({ type: "warning", message: `Skill name invalid or missing`, path: filePath });
    return undefined;
  }
  if (!description) {
    diagnostics.push({ type: "warning", message: `Skill "${name}" has no description`, path: filePath });
    return undefined;
  }
  return {
    name,
    description: description.length > MAX_DESCRIPTION ? description.slice(0, MAX_DESCRIPTION) : description,
    filePath,
    baseDir,
    scope,
    id: createHash("sha1").update(filePath).digest("hex").slice(0, 12),
  };
}

/** `.agents/skills` directories from `cwd` up to the repo root (or fs root) —
 *  Pi's rule, which keeps monorepo parents from leaking into a nested project. */
function ancestorAgentsSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  let repoRoot: string | undefined;
  let probe = dir;
  while (true) {
    if (fs.existsSync(path.join(probe, ".git"))) {
      repoRoot = probe;
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  while (true) {
    dirs.push(path.join(dir, ".agents", "skills"));
    if (repoRoot && dir === repoRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function discoverSkills(options: DiscoverOptions, diagnostics: CapabilityDiagnostic[], searched: string[]) {
  const home = os.homedir();
  const agentDir = options.agentDir ?? path.join(home, ".pi", "agent");
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(home, ".codex");
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? path.join(home, ".dsh");

  // First found wins, like Pi's own collision rule.
  const roots: Array<{ dir: string; scope: string }> = [
    // Project: .agents/skills through the ancestors, then .pi/skills.
    ...ancestorAgentsSkillDirs(options.cwd).map((dir) => ({ dir, scope: "project" })),
    { dir: path.join(options.cwd, ".pi", "skills"), scope: "project" },
    // User: the Agent Skills locations both Pi and Codex read, then Pi's own.
    { dir: path.join(home, ".agents", "skills"), scope: "user" },
    { dir: path.join(agentDir, "skills"), scope: "user" },
    { dir: path.join(codexHome, "skills"), scope: "user" },
    { dir: path.join(dshHome, "skills"), scope: "user" },
  ];

  const skills: SkillSpec[] = [];
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  const canonical = (filePath: string): string => {
    try {
      return fs.realpathSync(filePath);
    } catch {
      return filePath;
    }
  };
  for (const { dir, scope } of roots) {
    searched.push(dir);
    const found: SkillSpec[] = [];
    scanSkillDir(dir, scope, found, diagnostics);
    for (const skill of found) {
      const real = canonical(skill.filePath);
      if (seenPaths.has(real)) continue;
      seenPaths.add(real);
      if (seenNames.has(skill.name)) continue;
      seenNames.add(skill.name);
      skills.push(skill);
    }
  }
  return skills;
}

/* ── MCP ─────────────────────────────────────────────────────────────────── */

function readJsonFile(filePath: string, diagnostics: CapabilityDiagnostic[]): Record<string, unknown> | undefined {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    diagnostics.push({ type: "error", message: "Config is not a JSON object", path: filePath });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({ type: "error", message: `Cannot read MCP config: ${String(error)}`, path: filePath });
    }
  }
  return undefined;
}

/** One `mcpServers` entry → a spec. Returns a message when the entry is invalid. */
function normalizeServer(
  name: string,
  raw: unknown,
  source: McpServerSpec["source"],
  configPath: string,
): McpServerSpec | string {
  if (!raw || typeof raw !== "object") return `server "${name}": entry is not an object`;
  const entry = raw as Record<string, unknown>;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return `server "${name}": name may use letters, digits, _ and -`;
  const command = typeof entry.command === "string" ? entry.command : undefined;
  const url = typeof entry.url === "string" ? entry.url : undefined;
  if (!command && !url) {
    // An override entry (`enabled`/`exposure` only) is legal; it inherits the
    // rest from a user-level server of the same name.
    if (entry.enabled === undefined && entry.exposure === undefined && entry.toolExposure === undefined) {
      return `server "${name}": needs "command" (stdio) or "url" (http)`;
    }
  }
  const spec: McpServerSpec = {
    name,
    type: url ? "http" : "stdio",
    command,
    url,
    source,
    configPath,
    enabled: entry.enabled !== false,
    namespace: name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/-/g, "_"),
  };
  if (Array.isArray(entry.args)) spec.args = entry.args.map(String);
  if (entry.env && typeof entry.env === "object") spec.env = stringRecord(entry.env);
  if (entry.headers && typeof entry.headers === "object") spec.headers = stringRecord(entry.headers);
  if (typeof entry.cwd === "string") spec.cwd = entry.cwd;
  if (typeof entry.exposure === "string") spec.exposure = entry.exposure;
  else if (typeof entry.type === "string" && entry.type === "codemode") spec.exposure = "codemode";
  if (typeof entry.description === "string") spec.description = entry.description;
  if (typeof entry.timeout === "number") spec.timeout = entry.timeout;
  return spec;
}

function stringRecord(input: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * Minimal TOML reader for `[mcp_servers.<name>]` tables in Codex's
 * `config.toml`. Values we need are strings, arrays of strings and inline
 * tables (`env = { KEY = "v" }`); anything richer is skipped rather than
 * guessed at. Nested tables (`[mcp_servers.name.env]`) are read too.
 */
export function mcpServersFromCodexToml(text: string): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  let current: Record<string, unknown> | undefined;
  /** Set while the open table is `[mcp_servers.<name>.env]` or `.headers`. */
  let nestedKey: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      const parts = splitDotted(table[1]!.trim());
      nestedKey = undefined;
      if (parts[0] === "mcp_servers" && parts.length >= 2) {
        const name = stripQuotes(parts[1]!);
        servers[name] ??= {};
        current = servers[name]!;
        if (parts[2] === "env" || parts[2] === "headers") {
          current[parts[2]] ??= {};
          nestedKey = parts[2];
        }
      } else {
        current = undefined;
      }
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = stripQuotes(line.slice(0, eq).trim());
    const value = parseTomlValue(line.slice(eq + 1).trim());
    if (value === undefined) continue;
    if (nestedKey) {
      // `[mcp_servers.<name>.env]` — a flat string map under the entry.
      (current[nestedKey] as Record<string, unknown>)[key] = value;
    } else {
      current[key] = value;
    }
  }
  return servers;
}

function splitDotted(input: string): string[] {
  const parts: string[] = [];
  let buffer = "";
  let quote: string | undefined;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined;
      buffer += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
    } else if (char === ".") {
      parts.push(buffer.trim());
      buffer = "";
    } else {
      buffer += char;
    }
  }
  parts.push(buffer.trim());
  return parts;
}

function stripQuotes(value: string): string {
  if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseTomlValue(value: string): unknown {
  if (value.startsWith('"') || value.startsWith("'")) {
    return stripQuotes(value.replace(/\s+#.*$/, ""));
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((part) => parseTomlValue(part.trim()))
      .filter((part): part is string => typeof part === "string");
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const out: Record<string, string> = {};
    for (const pair of value.slice(1, -1).split(",")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const parsed = parseTomlValue(pair.slice(eq + 1).trim());
      if (typeof parsed === "string") out[stripQuotes(pair.slice(0, eq).trim())] = parsed;
    }
    return out;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function discoverMcp(options: DiscoverOptions, diagnostics: CapabilityDiagnostic[], searched: string[]) {
  const home = os.homedir();
  const agentDir = options.agentDir ?? path.join(home, ".pi", "agent");
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(home, ".codex");

  const byName = new Map<string, McpServerSpec>();
  /** Project entries override user entries of the same name, field by field. */
  const merge = (spec: McpServerSpec): void => {
    const existing = byName.get(spec.name);
    if (!existing) {
      byName.set(spec.name, spec);
      return;
    }
    byName.set(spec.name, {
      ...existing,
      ...Object.fromEntries(Object.entries(spec).filter(([, value]) => value !== undefined)),
    });
  };

  // User level: Pi's mcp.json, then Codex's TOML (looser precedence; a name
  // already defined by Pi wins, matching how a project entry wins over user).
  const userJson = path.join(agentDir, "mcp.json");
  searched.push(userJson);
  const userConfig = readJsonFile(userJson, diagnostics);
  const userServers = userConfig?.mcpServers;
  if (userServers && typeof userServers === "object") {
    for (const [name, raw] of Object.entries(userServers as Record<string, unknown>)) {
      const spec = normalizeServer(name, raw, "user", userJson);
      if (typeof spec === "string") diagnostics.push({ type: "warning", message: spec, path: userJson });
      else merge(spec);
    }
  }

  const codexToml = path.join(codexHome, "config.toml");
  searched.push(codexToml);
  if (isFile(codexToml)) {
    try {
      const servers = mcpServersFromCodexToml(fs.readFileSync(codexToml, "utf8"));
      for (const [name, entry] of Object.entries(servers)) {
        if (byName.has(name)) continue;
        const spec = normalizeServer(name, entry, "codex", codexToml);
        if (typeof spec === "string") diagnostics.push({ type: "warning", message: spec, path: codexToml });
        else merge(spec);
      }
    } catch (error) {
      diagnostics.push({ type: "error", message: `Cannot read ${codexToml}: ${String(error)}`, path: codexToml });
    }
  }

  // Project level: `<cwd>/.pi/mcp.json` (Pi) and `<cwd>/.codex/config.toml`
  // (Codex). Project trust is the runtimes' business; Absence lists what the
  // project declares and lets the runtime decide whether to honour it.
  const projectJson = path.join(options.cwd, ".pi", "mcp.json");
  searched.push(projectJson);
  const projectConfig = readJsonFile(projectJson, diagnostics);
  const projectServers = projectConfig?.mcpServers;
  if (projectServers && typeof projectServers === "object") {
    for (const [name, raw] of Object.entries(projectServers as Record<string, unknown>)) {
      const spec = normalizeServer(name, raw, "project", projectJson);
      if (typeof spec === "string") diagnostics.push({ type: "warning", message: spec, path: projectJson });
      else merge(spec);
    }
  }

  return [...byName.values()];
}

/* ── the one entry point ─────────────────────────────────────────────────── */

/**
 * Scan for skills and MCP servers once, for a session's working directory.
 * Pure file reading: safe to call on every session start, and safe to call
 * for a runtime that will not use the result.
 */
export function discoverCapabilities(options: DiscoverOptions): DiscoveredCapabilities {
  const diagnostics: CapabilityDiagnostic[] = [];
  const searched = { skills: [] as string[], mcp: [] as string[] };
  let skills: SkillSpec[] = [];
  let mcpServers: McpServerSpec[] = [];
  try {
    skills = discoverSkills(options, diagnostics, searched.skills);
  } catch (error) {
    diagnostics.push({ type: "error", message: `Skill discovery failed: ${String(error)}` });
  }
  try {
    mcpServers = discoverMcp(options, diagnostics, searched.mcp);
  } catch (error) {
    diagnostics.push({ type: "error", message: `MCP discovery failed: ${String(error)}` });
  }
  return { skills, mcpServers, diagnostics, searched };
}
