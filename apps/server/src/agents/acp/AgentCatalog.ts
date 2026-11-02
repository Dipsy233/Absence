import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentAuthStatus,
  AgentLaunch,
  AgentModels,
  AgentProfile,
} from "./profiles";
import { builtinProfiles } from "./profiles";

/**
 * The agent catalog — every ACP agent Absence can start on *this* machine.
 *
 * Absence is a client. Discovery therefore answers "what did the user install",
 * in this order:
 *
 *   1. an explicit launch line: ~/.absence/agents.json (custom entry or
 *      override), the legacy ~/.absence/runtimes.json, or an env command such
 *      as ABSENCE_PI_ACP_BIN;
 *   2. an installed ACP entry: an executable on PATH (`pi-acp`, `codex-acp`,
 *      `claude-code-acp`, or an agent CLI that speaks ACP with its own flag),
 *      or an adapter package in a local `node_modules` (`dist/index.js`);
 *   3. the agent CLI alone: the row is `needs-adapter` and Absence does *not*
 *      reach for npx;
 *   4. `npx` only when the user explicitly allowed it (`ABSENCE_ALLOW_NPX=1`
 *      or `"allowNpx": true` in agents.json), marked as a temporary download.
 *
 * An agent's own settings (~/.pi, ~/.codex, ~/.claude, …) are read
 * best-effort for display: never written, never repaired, never migrated.
 * Anything unreadable is `unknown`, not a guess.
 */
export type AgentReadiness = "ready" | "needs-adapter" | "needs-auth" | "unavailable";
export type LaunchOrigin = "auto" | "manual" | "override";

export type { AgentAuthStatus, AgentModels } from "./profiles";

export interface CatalogEntry extends AgentProfile {
  /** Where the launch spec came from, for diagnostics. */
  path?: string;
  /** Whether this runtime can start right now, and why. */
  state: AgentReadiness;
  /** One sentence explaining `state`. */
  stateReason: string;
  /** Auto-discovered, manually configured, or a user override. */
  origin: LaunchOrigin;
  /** The executable or node_modules entry discovery landed on. */
  discoveredFrom?: string;
  /** True when the launch would download a package (npx opt-in only). */
  willDownload?: boolean;
  /** What to install to make a `needs-adapter` row startable. */
  installHint?: string;
  /** Auth conclusion from the agent's own config, or `unknown`. */
  authStatus: AgentAuthStatus;
  authReason: string;
  /** The agent's declared models (never the credentials behind them). */
  models: AgentModels;
}

/** A custom entry as it is stored in ~/.absence/agents.json. */
export interface CustomAgent {
  id: string;
  label: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface AgentsFile {
  allowNpx: boolean;
  launch: Record<string, string>;
  agents: CustomAgent[];
}

/** The ACP registry (see https://agentclientprotocol.com/get-started/registry). */
export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const registered = new Map<string, AgentProfile>();

/** Register a profile in memory (tests, fixtures, embedding hosts). */
export function registerProfile(profile: AgentProfile): void {
  registered.set(profile.id, { ...profile });
}

/** Drop an in-memory profile (tests). */
export function unregisterProfile(id: string): void {
  registered.delete(id);
}

/** The directory holding Absence's own state (overridable for checks). */
export function catalogDir(): string {
  return process.env.ABSENCE_CATALOG_DIR?.trim() || path.join(os.homedir(), ".absence");
}

export function catalogFile(): string {
  return path.join(catalogDir(), "agents.json");
}

/** The pre-v0.5 location for launch overrides. Read-only for compatibility. */
export function legacyRuntimeFile(): string {
  return path.join(catalogDir(), "runtimes.json");
}

export function registryCacheFile(): string {
  return path.join(catalogDir(), "registry.json");
}

/**
 * Every profile Absence can start right now.
 *
 * Precedence: shipped data < ~/.absence/agents.json < ACP registry cache <
 * in-memory registrations. A saved launch-line override applies on top of
 * whichever entry wins. Selection is data lookup, not a product-name test.
 */
export function listProfiles(): CatalogEntry[] {
  const overrides = launchOverrides();
  const out = new Map<string, CatalogEntry>();
  for (const profile of builtinProfiles()) out.set(profile.id, finalize(profile, overrides));
  const reserved = reservedIds();
  for (const profile of customProfiles()) {
    // A hand-edited agents.json must not shadow a shipped row; the API refuses
    // such an id, and a manual edit is skipped rather than duplicated.
    if (reserved.has(profile.id)) continue;
    out.set(profile.id, finalize(profile, overrides));
  }
  // Registry entries are additive only: an id (or alias) the catalog already
  // knows must not duplicate a shipped row in the picker.
  const known = new Set([...out.keys()].flatMap((id) => [id, ...(out.get(id)?.aliases ?? [])]));
  for (const profile of registryProfiles()) {
    if (known.has(profile.id)) continue;
    out.set(profile.id, finalize(profile, overrides));
    known.add(profile.id);
    for (const alias of profile.aliases ?? []) known.add(alias);
  }
  for (const profile of registered.values()) out.set(profile.id, finalize(profile, overrides));
  return [...out.values()];
}

/**
 * One profile by id, or by an alias (`pi-acp` → the `pi` runtime's profile).
 * Exact ids win, so a user entry that deliberately reuses a registry name is
 * still reachable.
 */
export function getProfile(id: string): CatalogEntry | undefined {
  const profiles = listProfiles();
  return (
    profiles.find((profile) => profile.id === id) ??
    profiles.find((profile) => (profile.aliases ?? []).includes(id))
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Absence's own state file: ~/.absence/agents.json
   ══════════════════════════════════════════════════════════════════════════ */

/** Read ~/.absence/agents.json tolerantly; a broken file behaves like empty. */
export function readAgentsFile(file = catalogFile()): AgentsFile {
  const empty: AgentsFile = { allowNpx: false, launch: {}, agents: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      return { ...empty, agents: parseCustomEntries(parsed) };
    }
    const record = (parsed ?? {}) as Record<string, unknown>;
    const rawAgents = Array.isArray(record.agents) ? record.agents : [];
    const launch: Record<string, string> = {};
    if (record.launch && typeof record.launch === "object") {
      for (const [id, value] of Object.entries(record.launch as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) launch[id] = value.trim();
      }
    }
    return {
      allowNpx: record.allowNpx === true,
      launch,
      agents: parseCustomEntries(rawAgents),
    };
  } catch {
    return empty;
  }
}

/** Write only Absence's own state file. Agent directories are never touched. */
export function writeAgentsFile(data: AgentsFile, file = catalogFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    allowNpx: data.allowNpx,
    ...(Object.keys(data.launch).length > 0 ? { launch: data.launch } : {}),
    agents: data.agents,
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/** The launch-line overrides saved from the picker, keyed by profile id. */
export function launchOverrides(): Record<string, string> {
  const merged: Record<string, string> = {};
  // Legacy file first; agents.json wins on conflict. The legacy file is never
  // rewritten — new saves land in agents.json.
  Object.assign(merged, readLegacyOverrides());
  Object.assign(merged, readAgentsFile().launch);
  return merged;
}

function readLegacyOverrides(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyRuntimeFile(), "utf8")) as { launch?: unknown };
    const launch: Record<string, string> = {};
    if (parsed && typeof parsed.launch === "object" && parsed.launch !== null) {
      for (const [id, value] of Object.entries(parsed.launch as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) launch[id] = value.trim();
      }
    }
    return launch;
  } catch {
    return {};
  }
}

/** Replace the saved launch-line overrides (empty values are dropped). */
export function writeLaunchOverrides(
  overrides: Record<string, string>,
  file = catalogFile(),
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [id, value] of Object.entries(overrides)) {
    if (typeof value === "string" && value.trim()) clean[id] = value.trim();
  }
  const current = readAgentsFile(file);
  writeAgentsFile({ ...current, launch: clean }, file);
  return clean;
}

/** True when the user explicitly allowed the npx fallback. */
export function npxAllowed(file = catalogFile()): boolean {
  const env = process.env.ABSENCE_ALLOW_NPX?.trim().toLowerCase();
  if (env && ["1", "true", "on", "yes"].includes(env)) return true;
  return readAgentsFile(file).allowNpx;
}

/** Persist the npx opt-in in Absence's own state file. */
export function setNpxAllowed(allowed: boolean, file = catalogFile()): AgentsFile {
  const current = readAgentsFile(file);
  const next = { ...current, allowNpx: allowed };
  writeAgentsFile(next, file);
  return next;
}

/** The full launch line the picker shows and saves (`command args…`). */
export function launchLine(profile: { launch: AgentLaunch }): string {
  return [profile.launch.command, ...(profile.launch.args ?? [])].map(quoteArg).join(" ");
}

/**
 * Split a saved launch line into argv. Double or single quotes group an
 * argument; backslashes are literal (Windows paths must survive unchanged).
 */
export function parseLaunchLine(line: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) argv.push(current);
  return argv;
}

/* ══════════════════════════════════════════════════════════════════════════
   Executable lookup
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Resolve a command to an existing file, or undefined. A PATH scan rather than
 * `where`/`which`: the picker asks this for every profile, and spawning a
 * process per profile made the first `/api/runtimes` request slower than the
 * UI's 1 s probe timeout.
 */
export function resolveCommand(command: string): string | undefined {
  const trimmed = command.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return undefined;
  if (path.isAbsolute(trimmed)) return isFile(trimmed) ? trimmed : undefined;
  if (/[\\/]/.test(trimmed)) {
    const absolute = path.resolve(process.cwd(), trimmed);
    return isFile(absolute) ? absolute : undefined;
  }
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of pathDirs()) {
    for (const extension of extensions) {
      const candidate = path.join(dir, trimmed + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** True when a launch command can be found on disk. */
export function commandAvailable(command: string): boolean {
  return resolveCommand(command) !== undefined;
}

function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Find an ACP adapter entry inside a local `node_modules`, walking up from the
 * working directory. This is the "installed but not global" case: the user ran
 * `npm i -D pi-acp` in the project Absence is started from.
 */
export function findLocalAdapter(
  packageName: string,
  entry = "dist/index.js",
  start = process.cwd(),
): string | undefined {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(dir, "node_modules", ...packageName.split("/"), ...entry.split("/"));
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** What a failed lookup checked, so the API can report the resolved paths. */
export function commandLookupPaths(command: string): string[] {
  const trimmed = command.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return [];
  if (path.isAbsolute(trimmed) || /[\\/]/.test(trimmed)) {
    return [path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed)];
  }
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const checked: string[] = [];
  for (const dir of pathDirs()) {
    for (const extension of extensions) checked.push(path.join(dir, trimmed + extension));
  }
  return checked;
}

/** The ids the picker can offer. */
export function profileIds(): string[] {
  return listProfiles().map((profile) => profile.id);
}

/** True when a profile's launch command is a bare name that must be on PATH. */
export function usesPathLookup(profile: AgentProfile): boolean {
  return !path.isAbsolute(profile.launch.command);
}

function quoteArg(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/* ══════════════════════════════════════════════════════════════════════════
   Custom entries: read, validate, add, update, delete
   ══════════════════════════════════════════════════════════════════════════ */

export interface CustomAgentInput {
  id?: string;
  label?: string;
  command: string;
  args?: unknown;
  env?: unknown;
  cwd?: string;
}

export function parseCustomEntries(entries: unknown[]): CustomAgent[] {
  const out: CustomAgent[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const command = typeof record.command === "string" ? record.command.trim() : "";
    if (!id || !command || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: typeof record.label === "string" && record.label.trim() ? record.label : id,
      command,
      args: Array.isArray(record.args) ? record.args.map(String) : [],
      ...(isStringMap(record.env) ? { env: record.env } : {}),
      ...(typeof record.cwd === "string" && record.cwd.trim() ? { cwd: record.cwd.trim() } : {}),
    });
  }
  return out;
}

/** The user's entries: `{ "agents": [{ "id", "label", "command", "args", "env", "cwd" }] }`. */
export function customProfiles(): AgentProfile[] {
  return readAgentsFile().agents.map((entry) => ({
    id: entry.id,
    label: entry.label,
    source: "custom" as const,
    launch: {
      command: entry.command,
      ...(entry.args && entry.args.length > 0 ? { args: entry.args } : {}),
      ...(entry.env && Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
    },
    path: catalogFile(),
    note: "custom ACP entry from ~/.absence/agents.json",
    configurable: true,
  }));
}

export function customAgents(file = catalogFile()): CustomAgent[] {
  return readAgentsFile(file).agents;
}

/**
 * Normalise and validate a custom entry. Errors are written for the form and
 * name the path that was checked — never a silent failure.
 */
export function validateCustomAgent(
  input: CustomAgentInput,
  options: { file?: string; existingId?: string } = {},
): CustomAgent {
  const rawLabel = typeof input.label === "string" ? input.label.trim() : "";
  const requestedId = typeof input.id === "string" ? input.id.trim() : "";
  const id = requestedId || slug(rawLabel);
  if (!id) throw new Error("A custom ACP entry needs an id or a display name.");
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`Agent id "${id}" may only contain letters, digits, dot, dash and underscore.`);
  }
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("A custom ACP entry needs a command.");
  if (!resolveCommand(command)) {
    const checked = commandLookupPaths(command);
    throw new Error(
      `ACP command "${command}" was not found. Checked: ${checked.slice(0, 6).join(", ")}` +
        (checked.length > 6 ? ` … (${checked.length} paths)` : ""),
    );
  }
  const label = rawLabel || id;
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const env = isStringMap(input.env) ? input.env : {};
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (cwd) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(cwd);
    } catch {
      stat = undefined;
    }
    if (!stat?.isDirectory()) {
      throw new Error(`Working directory "${cwd}" does not exist or is not a directory.`);
    }
  }

  if (reservedIds().has(id) && id !== options.existingId) {
    throw new Error(`Agent id "${id}" is already used by a shipped or existing entry.`);
  }

  return {
    id,
    label,
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

/** Add a custom entry; returns the stored row. */
export function addCustomAgent(input: CustomAgentInput, file = catalogFile()): CustomAgent {
  const current = readAgentsFile(file);
  const agent = validateCustomAgent(input, { file });
  if (current.agents.some((entry) => entry.id === agent.id)) {
    throw new Error(`Agent id "${agent.id}" already exists.`);
  }
  writeAgentsFile({ ...current, agents: [...current.agents, agent] }, file);
  return agent;
}

/** Update a custom entry by id. */
export function updateCustomAgent(
  id: string,
  input: CustomAgentInput,
  file = catalogFile(),
): CustomAgent {
  const current = readAgentsFile(file);
  if (!current.agents.some((entry) => entry.id === id)) {
    throw new Error(`No custom ACP entry named "${id}".`);
  }
  const agent = validateCustomAgent({ ...input, id }, { file, existingId: id });
  if (agent.id !== id && current.agents.some((entry) => entry.id === agent.id)) {
    throw new Error(`Agent id "${agent.id}" already exists.`);
  }
  writeAgentsFile(
    {
      ...current,
      agents: current.agents.map((entry) => (entry.id === id ? agent : entry)),
    },
    file,
  );
  return agent;
}

/** Delete a custom entry by id. */
export function removeCustomAgent(id: string, file = catalogFile()): boolean {
  const current = readAgentsFile(file);
  const next = current.agents.filter((entry) => entry.id !== id);
  if (next.length === current.agents.length) return false;
  writeAgentsFile({ ...current, agents: next }, file);
  return true;
}

function reservedIds(): Set<string> {
  const ids = new Set<string>();
  for (const profile of builtinProfiles()) {
    ids.add(profile.id);
    for (const alias of profile.aliases ?? []) ids.add(alias);
  }
  for (const profile of registered.values()) ids.add(profile.id);
  return ids;
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* ══════════════════════════════════════════════════════════════════════════
   Discovery: resolve what this machine actually has
   ══════════════════════════════════════════════════════════════════════════ */

interface Resolution {
  launch: AgentLaunch;
  origin: LaunchOrigin;
  discoveredFrom?: string;
  willDownload?: boolean;
  state: AgentReadiness;
  stateReason: string;
  installHint?: string;
}

function finalize(profile: AgentProfile, overrides: Record<string, string>): CatalogEntry {
  const resolution = resolveProfile(profile, overrides);
  const config = inspectAgentConfig(profile);
  let state = resolution.state;
  let stateReason = resolution.stateReason;
  if (state === "ready" && profile.auth === "required" && config.auth === "missing") {
    state = "needs-auth";
    stateReason = `credentials missing: ${config.authReason}`;
  } else if (state === "ready" && profile.auth === "required" && config.auth === "unknown") {
    stateReason = `${stateReason} · sign-in requirement unknown until the agent answers`;
  }
  return {
    ...profile,
    launch: resolution.launch,
    state,
    stateReason,
    origin: resolution.origin,
    ...(resolution.discoveredFrom ? { discoveredFrom: resolution.discoveredFrom } : {}),
    ...(resolution.willDownload ? { willDownload: true } : {}),
    ...(resolution.installHint ? { installHint: resolution.installHint } : {}),
    authStatus: config.auth,
    authReason: config.authReason,
    models: config.models,
  };
}

function resolveProfile(profile: AgentProfile, overrides: Record<string, string>): Resolution {
  const explicit = explicitLaunch(profile, overrides);
  if (explicit) {
    const resolved = resolveCommand(explicit.command);
    if (resolved) {
      return {
        launch: { ...explicit, command: resolved },
        origin: profile.source === "custom" ? "manual" : "override",
        discoveredFrom: resolved,
        ...(isNpx(resolved) ? { willDownload: true } : {}),
        state: "ready",
        stateReason:
          profile.source === "custom"
            ? `custom ACP entry from ${catalogFile()}`
            : `explicit launch from ${catalogFile()}`,
      };
    }
    return {
      launch: explicit,
      origin: profile.source === "custom" ? "manual" : "override",
      state: "unavailable",
      stateReason: notFoundReason(explicit.command, "the configured launch line"),
    };
  }

  const discovery = profile.discovery;
  if (!discovery) return resolvePlainProfile(profile);

  for (const bin of discovery.acpBins ?? []) {
    const found = resolveCommand(bin);
    if (found) {
      return readyPath({ ...profile.launch, command: found }, found, `${bin} found on PATH`);
    }
  }

  for (const packageName of discovery.acpPackages ?? []) {
    const entry = findLocalAdapter(packageName, discovery.acpEntry ?? "dist/index.js");
    if (entry) {
      return {
        launch: { ...profile.launch, command: process.execPath, args: [entry] },
        origin: "auto",
        discoveredFrom: entry,
        state: "ready",
        stateReason: `ACP adapter found in local node_modules (${entry})`,
      };
    }
  }

  const cli = firstResolved(discovery.cli ?? []);
  if (cli && discovery.acpArgs && discovery.acpArgs.length > 0) {
    return readyPath(
      { ...profile.launch, command: cli.resolved, args: discovery.acpArgs },
      cli.resolved,
      `${cli.name} speaks ACP with its own flag`,
    );
  }

  if (npxAllowed() && discovery.npxPackage) {
    const version =
      (discovery.npxVersionEnv && process.env[discovery.npxVersionEnv]) ||
      discovery.npxVersion ||
      "";
    const spec = version ? `${discovery.npxPackage}@${version}` : discovery.npxPackage;
    return {
      launch: { ...profile.launch, command: "npx", args: ["-y", spec] },
      origin: "auto",
      willDownload: true,
      state: "ready",
      stateReason: `npx fallback enabled; ${spec} will be downloaded temporarily on launch`,
    };
  }

  if (cli) {
    const target = discovery.acpBins?.[0] ?? discovery.npxPackage ?? profile.acp ?? cli.name;
    return {
      launch: { ...profile.launch, command: target },
      origin: "auto",
      state: "needs-adapter",
      stateReason: `${cli.name} is installed, but no ACP adapter (${target}) was found on PATH or local node_modules`,
      installHint: installHint(profile, discovery),
    };
  }

  const target = discovery.acpBins?.[0] ?? discovery.npxPackage ?? profile.acp ?? discovery.cli?.[0] ?? "";
  return {
    launch: { ...profile.launch, command: target },
    origin: "auto",
    state: "unavailable",
    stateReason: target
      ? `neither the agent CLI (${(discovery.cli ?? []).join("/") || "unknown"}) nor an ACP entry (${target}) was found on PATH or local node_modules`
      : "no ACP entry or agent CLI was found",
    installHint: installHint(profile, discovery),
  };
}

function resolvePlainProfile(profile: AgentProfile): Resolution {
  const command = profile.launch.command;
  if (command && isNpx(command) && !npxAllowed()) {
    return {
      launch: profile.launch,
      origin: "auto",
      state: "unavailable",
      stateReason:
        "this entry is distributed through npx; enable ABSENCE_ALLOW_NPX=1 (or allowNpx in " +
        "~/.absence/agents.json) to allow a temporary download, or install it locally",
    };
  }
  if (command && commandAvailable(command)) {
    const resolved = resolveCommand(command);
    return {
      launch: resolved ? { ...profile.launch, command: resolved } : profile.launch,
      origin: profile.source === "custom" ? "manual" : "auto",
      discoveredFrom: resolved,
      ...(isNpx(command) ? { willDownload: true } : {}),
      state: "ready",
      stateReason: resolved ? `executable found at ${resolved}` : `${command} found on PATH`,
    };
  }
  return {
    launch: profile.launch,
    origin: profile.source === "custom" ? "manual" : "auto",
    state: "unavailable",
    stateReason: notFoundReason(command, "the launch command"),
  };
}

function readyPath(launch: AgentLaunch, discoveredFrom: string, reason: string): Resolution {
  return {
    launch,
    origin: "auto",
    discoveredFrom,
    state: "ready",
    stateReason: `ACP entry found at ${reason}`,
  };
}

/** An explicit launch line wins over discovery. */
function explicitLaunch(
  profile: AgentProfile,
  overrides: Record<string, string>,
): AgentLaunch | undefined {
  const line = overrides[profile.id];
  if (line) {
    const argv = parseLaunchLine(line);
    const command = argv[0];
    if (command) {
      return {
        command,
        args: argv.slice(1),
        ...(profile.launch.env ? { env: profile.launch.env } : {}),
      };
    }
  }
  const envCommand = profile.commandEnv ? process.env[profile.commandEnv]?.trim() : "";
  if (envCommand) {
    return {
      command: envCommand,
      ...(profile.discovery?.acpArgs ? { args: profile.discovery.acpArgs } : {}),
      ...(profile.launch.env ? { env: profile.launch.env } : {}),
    };
  }
  if (profile.source === "custom" || profile.source === "fixture") return profile.launch;
  // A config-backed command (dshBin) materialised by builtinProfiles().
  // Registry profiles keep their own launch through `resolvePlainProfile`, so
  // their npx distribution is not mistaken for an explicit user choice.
  if (profile.source === "builtin" && profile.launch.command) {
    return {
      command: profile.launch.command,
      ...(profile.discovery?.acpArgs ? { args: profile.discovery.acpArgs } : {}),
      ...(profile.launch.env ? { env: profile.launch.env } : {}),
    };
  }
  return undefined;
}

function firstResolved(names: string[]): { name: string; resolved: string } | undefined {
  for (const name of names) {
    const resolved = resolveCommand(name);
    if (resolved) return { name, resolved };
  }
  return undefined;
}

function isNpx(command: string): boolean {
  return path.basename(command).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase() === "npx";
}

function notFoundReason(command: string, what: string): string {
  if (!command) return `${what} is empty`;
  const checked = commandLookupPaths(command);
  return (
    `${what} points at "${command}", which was not found` +
    (checked.length > 0 ? ` (checked ${checked.slice(0, 4).join(", ")})` : "")
  );
}

function installHint(profile: AgentProfile, discovery: NonNullable<AgentProfile["discovery"]>): string {
  const packages = discovery.acpPackages ?? (discovery.npxPackage ? [discovery.npxPackage] : []);
  const bins = discovery.acpBins ?? [];
  const target = packages[0] ?? bins[0] ?? profile.acp ?? "";
  const how = packages[0]
    ? `npm install -g ${packages[0]} (or install it in the project's node_modules)`
    : `install ${bins[0] ?? target} and put it on PATH`;
  return (
    `Install the ACP adapter for ${profile.label}: ${how}. ` +
    "Absence never downloads packages unless ABSENCE_ALLOW_NPX=1 is set."
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Read-only inspection of the agent's own settings
   ══════════════════════════════════════════════════════════════════════════ */

interface AgentConfigSnapshot {
  models: AgentModels;
  auth: AgentAuthStatus;
  authReason: string;
}

const UNKNOWN_MODELS: AgentModels = { state: "unknown", items: [] };

/**
 * Read the agent's own settings for display. Strictly read-only: no file is
 * created, changed, backed up, migrated or deleted, and credential values are
 * never returned — only whether they exist.
 */
export function inspectAgentConfig(
  profile: AgentProfile,
  home = os.homedir(),
): AgentConfigSnapshot {
  const hint = profile.auth;
  if (!profile.inspect) {
    return {
      models: { ...UNKNOWN_MODELS },
      auth: hint === "none" ? "not-required" : "unknown",
      authReason:
        hint === "none"
          ? "this agent does not require sign-in"
          : "no readable agent config; sign-in status unknown",
    };
  }
  const spec = profile.inspect;
  const dir = resolveInspectDir(spec, home);
  try {
    if (spec.format === "providers-json") return inspectProviders(dir, spec);
    if (spec.format === "model-toml") return inspectToml(dir, spec);
    return inspectSettings(dir, spec, hint);
  } catch {
    return {
      models: { ...UNKNOWN_MODELS },
      auth: hint === "none" ? "not-required" : "unknown",
      authReason: "agent config could not be read; status unknown",
    };
  }
}

function resolveInspectDir(spec: NonNullable<AgentProfile["inspect"]>, home: string): string {
  const fromEnv = spec.dirEnv ? process.env[spec.dirEnv]?.trim() : "";
  if (fromEnv) return path.resolve(expandHome(fromEnv, home));
  for (const candidate of spec.dirs) {
    const dir = path.resolve(expandHome(candidate, home));
    if (isDirectory(dir)) return dir;
  }
  return path.resolve(expandHome(spec.dirs[0] ?? "~", home));
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
  return value;
}

function inspectProviders(dir: string, spec: NonNullable<AgentProfile["inspect"]>): AgentConfigSnapshot {
  let parsed: Record<string, any> | undefined;
  let source: string | undefined;
  for (const name of spec.modelFiles) {
    const file = path.join(dir, name);
    const body = readJson(file);
    if (body === undefined) continue;
    parsed = body;
    source = file;
    break;
  }
  const authName = spec.authFiles?.[0];
  const authFile = authName ? path.join(dir, authName) : undefined;
  const authBody = authFile ? readJson(authFile) : undefined;
  const authConfigured =
    isNonEmptyObject(authBody) || Boolean(parsed && hasProviderCredential(parsed));

  let models: AgentModels = { ...UNKNOWN_MODELS };
  if (parsed) {
    const items = providerModels(parsed);
    models = {
      state: items.length > 0 ? "declared" : "empty",
      items,
      ...(source ? { path: source } : {}),
    };
  }

  let auth: AgentAuthStatus;
  let authReason: string;
  if (authConfigured) {
    auth = "configured";
    authReason = `credentials present in ${authFile ?? source ?? dir} (values not read)`;
  } else if (authFile && fs.existsSync(authFile)) {
    auth = "missing";
    authReason = `${authFile} exists but contains no credentials`;
  } else if (parsed) {
    auth = "missing";
    authReason = `no credentials found under ${dir}`;
  } else {
    auth = "unknown";
    authReason = `no readable settings under ${dir}`;
  }
  return { models, auth, authReason };
}

function providerModels(body: Record<string, any>): string[] {
  const providers = body.providers;
  if (!providers || typeof providers !== "object") return [];
  const items: string[] = [];
  for (const [provider, config] of Object.entries(providers as Record<string, any>)) {
    const models = Array.isArray(config?.models) ? config.models : [];
    for (const model of models) {
      if (model && typeof model.id === "string" && model.id) {
        items.push(`${provider}/${model.id}`);
      }
    }
  }
  return dedupe(items);
}

function hasProviderCredential(body: Record<string, any>): boolean {
  const providers = body.providers;
  if (!providers || typeof providers !== "object") return false;
  return Object.values(providers as Record<string, any>).some(
    (config) => typeof config?.apiKey === "string" && config.apiKey.length > 0,
  );
}

function inspectToml(dir: string, spec: NonNullable<AgentProfile["inspect"]>): AgentConfigSnapshot {
  let toml: Toml | undefined;
  let source: string | undefined;
  for (const name of spec.modelFiles) {
    const file = path.join(dir, name);
    try {
      toml = parseToml(fs.readFileSync(file, "utf8"));
      source = file;
      break;
    } catch {
      // missing or unreadable; try the next candidate
    }
  }
  const authName = spec.authFiles?.[0];
  const authFile = authName ? path.join(dir, authName) : undefined;
  const authBody = authFile ? readJson(authFile) : undefined;
  const authConfigured = isNonEmptyObject(authBody);
  const provider = toml?.top.model_provider;
  const providerNeedsAuth =
    typeof provider === "string"
      ? toml?.sections[`model_providers.${provider}`]?.requires_openai_auth
      : undefined;
  const noAuthProvider = providerNeedsAuth === false;

  let models: AgentModels = { ...UNKNOWN_MODELS };
  if (toml) {
    const model = typeof toml.top.model === "string" ? toml.top.model : "";
    const items = model ? [model] : [];
    models = {
      state: items.length > 0 ? "declared" : "empty",
      items,
      ...(source ? { path: source } : {}),
    };
  }

  let auth: AgentAuthStatus;
  let authReason: string;
  if (authConfigured || noAuthProvider) {
    auth = "configured";
    authReason = authConfigured
      ? `credentials present in ${authFile} (values not read)`
      : "the configured provider does not require OpenAI sign-in";
  } else if (toml) {
    auth = "missing";
    authReason = `no credentials found under ${dir}`;
  } else {
    auth = "unknown";
    authReason = `no readable config under ${dir}`;
  }
  return { models, auth, authReason };
}

function inspectSettings(
  dir: string,
  spec: NonNullable<AgentProfile["inspect"]>,
  hint: AgentProfile["auth"],
): AgentConfigSnapshot {
  let body: Record<string, any> | undefined;
  let source: string | undefined;
  for (const name of spec.modelFiles) {
    const file = path.join(dir, name);
    const parsed = readJson(file);
    if (parsed === undefined) continue;
    body = parsed;
    source = file;
    break;
  }
  const env = (body?.env ?? {}) as Record<string, unknown>;
  const items = dedupe(
    Object.entries(env)
      .filter(
        ([key, value]) =>
          /MODEL/.test(key) && !/NAME/.test(key) && typeof value === "string" && value.length > 0,
      )
      .map(([, value]) => String(value)),
  );

  let models: AgentModels = { ...UNKNOWN_MODELS };
  if (body) {
    models = {
      state: items.length > 0 ? "declared" : "empty",
      items,
      ...(source ? { path: source } : {}),
    };
  }

  const credentialKey = (spec.credentialEnvKeys ?? []).find(
    (key: string) => typeof env[key] === "string" && String(env[key]).length > 0,
  );
  let auth: AgentAuthStatus;
  let authReason: string;
  if (credentialKey) {
    auth = "configured";
    authReason = `credentials present in ${source} (values not read)`;
  } else if (body) {
    auth = hint === "optional" ? "missing" : "unknown";
    authReason = `no credential setting found in ${source}`;
  } else {
    auth = "unknown";
    authReason = `no readable settings under ${dir}`;
  }
  return { models, auth, authReason };
}

interface Toml {
  top: Record<string, string | boolean | number>;
  sections: Record<string, Record<string, string | boolean | number>>;
}

/** A deliberately small TOML reader: `key = value` and `[a.b]` sections. */
export function parseToml(text: string): Toml {
  const top: Record<string, string | boolean | number> = {};
  const sections: Record<string, Record<string, string | boolean | number>> = {};
  let current = top;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      const name = section[1]?.trim();
      if (!name) continue;
      current = sections[name] ?? (sections[name] = {});
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1];
    if (key) current[key] = tomlValue(pair[2] ?? "");
  }
  return { top, sections };
}

function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

function tomlValue(raw: string): string | boolean | number {
  const value = raw.trim();
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^[+-]?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const inner = value.slice(1, -1);
    return value.startsWith('"') ? inner.replaceAll('\\"', '"') : inner;
  }
  const array = /^\[\s*(.*?)\s*\]$/s.exec(value);
  if (array) {
    return (array[1] ?? "")
      .split(",")
      .map((item) => String(tomlValue(item.trim())))
      .join(", ");
  }
  return value;
}

function readJson(file: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isNonEmptyObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && Object.keys(value as object).length > 0);
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/* ══════════════════════════════════════════════════════════════════════════
   ACP registry cache (optional, additive)
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Profiles derived from the cached ACP registry.
 *
 * An entry is usable when it names an id and a startable distribution. A
 * registry `npx` distribution is treated like any other package: the row is
 * only startable when the executable exists, or when npx is explicitly allowed.
 */
export function registryProfiles(cachePath = registryCacheFile()): CatalogEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as unknown;
    return parseRegistryEntries(parsed, cachePath);
  } catch {
    return [];
  }
}

/**
 * The pure half of the registry reader. Exported so the sync check can
 * exercise it without touching the user's real cache.
 */
export function parseRegistryEntries(body: unknown, cachePath = registryCacheFile()): CatalogEntry[] {
  const agents = Array.isArray(body) ? body : (body as { agents?: unknown })?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((agent) => {
    const record = agent as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return [];
    const distribution = (record.distribution ?? {}) as Record<string, any>;
    const npxPackage = distribution?.npx?.package ?? distribution?.npx?.packages?.[0];
    const uvxPackage = distribution?.uvx?.package;
    const binary = distribution?.binary;
    let command = "";
    let args: string[] = [];
    if (typeof npxPackage === "string") {
      command = "npx";
      args = ["-y", npxPackage];
    } else if (typeof uvxPackage === "string") {
      command = "uvx";
      args = [uvxPackage];
    } else if (typeof binary === "string") {
      command = binary;
    } else if (typeof distribution?.binary?.windows === "string" && process.platform === "win32") {
      command = distribution.binary.windows;
    } else {
      return [];
    }
    const entry: AgentProfile = {
      id,
      label: typeof record.name === "string" ? record.name : id,
      source: "registry" as const,
      launch: { command, args },
    };
    return [
      {
        ...entry,
        path: cachePath,
        state: "unavailable" as const,
        stateReason: "registry entry not resolved yet",
        origin: "auto" as const,
        authStatus: "unknown" as const,
        authReason: "registry entry; sign-in status unknown",
        models: { ...UNKNOWN_MODELS },
      },
    ];
  });
}

/**
 * Download the ACP registry into the cache file. Returns the entry count.
 *
 * Options exist for the offline check (a temp directory + stub fetch); the
 * production entry point uses the defaults.
 */
export async function syncRegistry(
  options: { url?: string; fetcher?: typeof fetch; dir?: string } = {},
): Promise<number> {
  const url = options.url ?? REGISTRY_URL;
  const dir = options.dir ?? catalogDir();
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (error) {
    throw new Error(
      `ACP registry is unreachable (${url}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) throw new Error(`ACP registry request failed (${url}): HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(
      `ACP registry returned invalid JSON (${url}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries = parseRegistryEntries(body, path.join(dir, "registry.json"));
  if (entries.length === 0) {
    throw new Error(`ACP registry contained no usable agents (${url}).`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const cachePath = path.join(dir, "registry.json");
  fs.writeFileSync(cachePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return entries.length;
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}
