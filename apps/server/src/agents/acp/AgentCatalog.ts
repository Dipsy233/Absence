import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProfile } from "./profiles";
import { builtinProfiles } from "./profiles";

/**
 * The agent catalog — every ACP agent Absence can start, as data.
 *
 * Three sources, in priority order:
 *   1. profiles registered in memory (tests, embedding hosts)
 *   2. ~/.absence/agents.json  — the user's own entries
 *   3. shipped profiles        — dsh, claude-code, qwen-code, codex-acp, pi-acp
 *
 * The official ACP registry can be synced into the cache file below; it is
 * optional and degrades to nothing, so Absence starts fine offline.
 */
export interface CatalogEntry extends AgentProfile {
  /** Where the launch spec came from, for diagnostics. */
  path?: string;
}

const CATALOG_DIR = path.join(os.homedir(), ".absence");
const CUSTOM_FILE = path.join(CATALOG_DIR, "agents.json");
const REGISTRY_CACHE = path.join(CATALOG_DIR, "registry.json");
/** Launch-line overrides saved from the picker, keyed by profile id. */
const RUNTIME_FILE = path.join(CATALOG_DIR, "runtimes.json");

/** The ACP registry (see https://agentclientprotocol.com/get-started/registry). */
export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const registered = new Map<string, CatalogEntry>();

/** Register a profile in memory (tests, fixtures, embedding hosts). */
export function registerProfile(profile: AgentProfile): void {
  registered.set(profile.id, { ...profile });
}

/** Drop an in-memory profile (tests). */
export function unregisterProfile(id: string): void {
  registered.delete(id);
}

/**
 * Every profile Absence can start right now.
 *
 * Precedence: shipped data < ~/.absence/agents.json < ACP registry cache <
 * in-memory registrations. A saved launch-line override applies on top of
 * whichever entry wins. That is the whole "switch agent without a code branch"
 * rule: selection is data lookup, not a product-name test.
 */
export function listProfiles(): CatalogEntry[] {
  const out = new Map<string, CatalogEntry>();
  const overrides = launchOverrides();
  for (const profile of builtinProfiles()) out.set(profile.id, applyOverride(profile, overrides));
  for (const profile of customProfiles()) out.set(profile.id, applyOverride(profile, overrides));
  // Registry entries are additive only: an id (or alias) the catalog already
  // knows must not duplicate a shipped Pi / Codex row in the picker.
  const known = new Set<string>();
  for (const [id, profile] of out) {
    known.add(id);
    for (const alias of profile.aliases ?? []) known.add(alias);
  }
  for (const profile of registryProfiles()) {
    if (known.has(profile.id)) continue;
    out.set(profile.id, applyOverride(profile, overrides));
  }
  // In-memory registrations win (a test fixture must shadow a builtin id only
  // when it deliberately reuses it).
  for (const [id, profile] of registered) out.set(id, profile);
  return [...out.values()];
}

/**
 * One profile by id, or by an alias (`pi-acp` → the `pi` runtime's profile).
 *
 * Exact ids win, so a user entry that deliberately reuses a registry name is
 * still reachable.
 */
export function getProfile(id: string): CatalogEntry | undefined {
  const profiles = listProfiles();
  return profiles.find((profile) => profile.id === id) ??
    profiles.find((profile) => (profile.aliases ?? []).includes(id));
}

/** The launch-line overrides saved from the picker, keyed by profile id. */
export function launchOverrides(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf8")) as {
      launch?: unknown;
      /** @deprecated P5 removes the native DSH adapter and this legacy key. */
      dshBin?: unknown;
    };
    const launch: Record<string, string> = {};
    if (parsed && typeof parsed.launch === "object" && parsed.launch !== null) {
      for (const [id, value] of Object.entries(parsed.launch as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) launch[id] = value.trim();
      }
    }
    // One-release migration: the old file stored only dsh's binary path. It is
    // an ACP profile now, so the path can become its launch line unchanged.
    if (typeof parsed?.dshBin === "string" && parsed.dshBin.trim() && !launch.dsh) {
      launch.dsh = parsed.dshBin.trim();
    }
    return launch;
  } catch {
    return {};
  }
}

/** Replace the saved launch-line overrides (empty values are dropped). */
export function writeLaunchOverrides(overrides: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [id, value] of Object.entries(overrides)) {
    if (typeof value === "string" && value.trim()) clean[id] = value.trim();
  }
  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, `${JSON.stringify({ launch: clean }, null, 2)}\n`, "utf8");
  return clean;
}

/** The full launch line the picker shows and saves (`command args…`). */
export function launchLine(profile: AgentProfile): string {
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

/**
 * True when a launch command can be found: an existing absolute path, or a
 * name on PATH. Deliberately a PATH scan rather than `where`/`which`; the
 * picker asks this for every profile, and spawning a process per profile made
 * the first `/api/runtimes` request slower than the UI's 1 s probe timeout.
 */
export function commandAvailable(command: string): boolean {
  if (!command) return false;
  if (path.isAbsolute(command)) {
    try {
      return fs.existsSync(command);
    } catch {
      return false;
    }
  }
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const extension of extensions) {
      try {
        if (fs.existsSync(path.join(dir, command + extension))) return true;
      } catch {
        // unreadable PATH entry; try the next one
      }
    }
  }
  return false;
}

/**
 * The executables a profile still needs, in the order it declares them.
 *
 * `launch.command` is the one Absence spawns; `requires` are prerequisites the
 * agent itself shells out to (Pi needs its own CLI, for example). Returned as
 * data so both the picker and the launch error can explain the same thing.
 */
export function missingProfileCommands(profile: AgentProfile): string[] {
  const wanted = [...new Set([profile.launch.command, ...(profile.requires ?? [])])].filter(Boolean);
  return wanted.filter((command) => !commandAvailable(command));
}

function applyOverride(profile: CatalogEntry, overrides: Record<string, string>): CatalogEntry {
  const line = overrides[profile.id];
  if (!line) return profile;
  const argv = parseLaunchLine(line);
  const command = argv[0];
  if (!command) return profile;
  return {
    ...profile,
    launch: { ...profile.launch, command, args: argv.slice(1) },
  };
}

function quoteArg(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/** The ids the picker can offer. */
export function profileIds(): string[] {
  return listProfiles().map((profile) => profile.id);
}

/** The user's entries: `{ "agents": [{ "id", "label", "command", "args", "env" }] }`. */
export function customProfiles(): CatalogEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(CUSTOM_FILE, "utf8")) as unknown;
    const entries = Array.isArray(parsed) ? parsed : (parsed as { agents?: unknown })?.agents;
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const command = typeof record.command === "string" ? record.command.trim() : "";
      if (!id || !command) return [];
      return [
        {
          id,
          label: typeof record.label === "string" ? record.label : id,
          source: "custom" as const,
          launch: {
            command,
            args: Array.isArray(record.args) ? record.args.map(String) : [],
            env: isStringMap(record.env) ? (record.env as Record<string, string>) : undefined,
          },
          path: CUSTOM_FILE,
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * Profiles derived from the cached ACP registry.
 *
 * The registry is JSON per agent; this reads it tolerantly: an entry is usable
 * when it names an id and a startable distribution (`npx` package, `uvx`
 * package, or a binary path). Anything it cannot read is skipped rather than
 * guessed.
 */
export function registryProfiles(cachePath = REGISTRY_CACHE): CatalogEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as unknown;
    return parseRegistryEntries(parsed, cachePath);
  } catch {
    return [];
  }
}

/**
 * The pure half of the registry reader: one agent entry is usable when it
 * names an id and a startable distribution. Exported so the sync check can
 * exercise it without touching the user's real cache.
 */
export function parseRegistryEntries(body: unknown, cachePath = REGISTRY_CACHE): CatalogEntry[] {
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
    return [
      {
        id,
        label: typeof record.name === "string" ? record.name : id,
        source: "registry" as const,
        launch: { command, args },
        path: cachePath,
      },
    ];
  });
}

/**
 * Download the ACP registry into the cache file. Returns the entry count.
 *
 * Options exist for the offline check (a temp directory + stub fetch); the
 * production entry point uses the defaults. A network/offline failure is
 * thrown with the URL, so the CLI can explain what happened.
 */
export async function syncRegistry(
  options: { url?: string; fetcher?: typeof fetch; dir?: string } = {},
): Promise<number> {
  const url = options.url ?? REGISTRY_URL;
  const dir = options.dir ?? CATALOG_DIR;
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

/** True when a profile's launch command is a bare name that must be on PATH. */
export function usesPathLookup(profile: AgentProfile): boolean {
  return !path.isAbsolute(profile.launch.command);
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}
