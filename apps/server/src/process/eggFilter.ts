import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ══════════════════════════════════════════════════════════════════════════
   Egg filter profiles — named files of command names the classifier treats
   as helpers. Each profile is one JSON file in the profiles directory:

       profiles/my-helpers.json
       { "names": ["sleep", "tail", ...], "force": true }

   Saving with the same name overwrites that file; a new name creates a new
   file. One profile is active at a time; the classifier reads its names.

   Profiles are read from disk on boot and on every load, so files edited
   out-of-band also work. The active name is stored in active.json next to
   the profiles.
   ══════════════════════════════════════════════════════════════════════════ */

const DIR = path.join(path.dirname(fileURLToPath(new URL(import.meta.url))), "egg-filters");

const DEFAULT_NAME = "default";
const DEFAULT_NAMES = [
  "conhost", "cmd.exe", "where", "which", "tasklist",
  "cat", "grep", "sleep", "echo", "pwd", "whoami", "uname", "ps",
];

export interface ProfileMeta {
  name: string;
  /** Epoch ms of the file's last modification. */
  savedAt: number;
  /** Number of names in the profile. */
  count: number;
}

export interface Profile extends ProfileMeta {
  names: string[];
  /** True when the list overrides even "named by the command". */
  force: boolean;
}

/** A safe single path segment: letters, digits, space, dash, underscore, dot. */
function safeFileName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 64 || /[\\/:*?"<>|]/.test(trimmed)) return null;
  return trimmed;
}

function profilePath(name: string): string | null {
  const file = safeFileName(name);
  return file ? path.join(DIR, `${file}.json`) : null;
}

function normalizeNames(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const out = new Set<string>();
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    out.add(name);
    if (!name.endsWith(".exe")) out.add(`${name}.exe`);
  }
  return [...out];
}

function ensureDir(): void {
  fs.mkdirSync(DIR, { recursive: true });
}

function readProfileFile(name: string): Profile | undefined {
  const file = profilePath(name);
  if (!file) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      names?: unknown;
      force?: unknown;
    };
    const stat = fs.statSync(file);
    return {
      name,
      names: normalizeNames(parsed.names),
      force: parsed.force === true,
      savedAt: stat.mtimeMs,
      count: normalizeNames(parsed.names).length,
    };
  } catch {
    return undefined;
  }
}

/** Every saved profile, newest first. */
export function listProfiles(): ProfileMeta[] {
  try {
    return fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".json") && f !== "active.json")
      .map((f) => readProfileFile(f.slice(0, -5)))
      .filter((p): p is Profile => p !== undefined)
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export function getProfile(name: string): Profile | undefined {
  return readProfileFile(name);
}

/** Create (new name) or overwrite (same name) a profile. */
export function saveProfile(name: string, names: string[], force: boolean): Profile {
  ensureDir();
  const file = profilePath(name);
  if (!file) throw new Error(`invalid profile name: ${name}`);
  const cleaned = normalizeNames(names);
  fs.writeFileSync(file, `${JSON.stringify({ names: cleaned, force }, null, 2)}\n`, "utf8");
  return { name: name.trim(), names: cleaned, force, savedAt: Date.now(), count: cleaned.length };
}

export function deleteProfile(name: string): boolean {
  const file = profilePath(name);
  if (!file) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The profile currently in use (its name). */
export function getActiveName(): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DIR, "active.json"), "utf8")) as {
      active?: string;
    };
    return typeof parsed.active === "string" ? parsed.active : DEFAULT_NAME;
  } catch {
    return DEFAULT_NAME;
  }
}

export function setActiveName(name: string): void {
  ensureDir();
  fs.writeFileSync(path.join(DIR, "active.json"), `${JSON.stringify({ active: name }, null, 2)}\n`, "utf8");
}

/** The live name list: the active profile's names, falling back to defaults. */
let current: string[] = [];
let currentForce = false;

function reload(): void {
  const active = getProfile(getActiveName());
  if (active && active.count > 0) {
    current = active.names;
    currentForce = active.force;
    return;
  }
  // No usable active profile: seed the default and use it.
  const seeded = saveProfile(DEFAULT_NAME, DEFAULT_NAMES, false);
  setActiveName(DEFAULT_NAME);
  current = seeded.names;
  currentForce = false;
}

reload();

export function eggFilterNames(): string[] {
  return [...current];
}

export function eggFilterForce(): boolean {
  return currentForce;
}

export function activeProfileName(): string {
  return getActiveName();
}

/** Activate a saved profile (or save-and-activate in one step). */
export function activateProfile(name: string, names?: string[], force?: boolean): Profile {
  const profile = names
    ? saveProfile(name, names, force ?? getProfile(name)?.force ?? false)
    : getProfile(name);
  if (!profile) throw new Error(`profile not found: ${name}`);
  setActiveName(profile.name);
  current = profile.names;
  currentForce = profile.force;
  return profile;
}

/** True when the process name is on the active profile's list (exact basename). */
export function isEggFiltered(name: string): boolean {
  return current.includes(name.toLowerCase());
}

/**
 * Demote to a helper when the name is on the active profile's list. This is a
 * USER OVERRIDE, stronger than every classifier rule except the two structural
 * ones no name can fake:
 *   - a process that survived its command ("outlived its command")
 *   - a subject the command explicitly backgrounded ("named by the command")
 * Everything else — including the built-in name priors — yields to the list.
 * Called by ProcessWatcher after classifyProcess.
 */
export function applyEggFilter(
  name: string,
  verdict: { kind: "primary" | "tool"; reason: string },
): { kind: "primary" | "tool"; reason: string } {
  if (verdict.kind !== "primary" || !isEggFiltered(name)) return verdict;
  // Structural rules that no name can fake: keep them unless the profile opts
  // out of even that protection with "force": true.
  if (!currentForce) {
    if (verdict.reason === "outlived its command" || verdict.reason === "named by the command") {
      return verdict;
    }
  } else if (verdict.reason === "outlived its command") {
    // Even forced, a process that outlived its command is a daemon by shape.
    return verdict;
  }
  return { kind: "tool", reason: "on the filter list" };
}

export const eggFiltersDir = DIR;
