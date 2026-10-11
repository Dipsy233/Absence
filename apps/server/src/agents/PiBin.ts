import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/* ══════════════════════════════════════════════════════════════════════════
   Locate the Pi coding-agent package.

   Absence is a client, not a vendor: it should embed whichever
   `@earendil-works/pi-coding-agent` the user has installed, not ship (and
   prefer) its own copy. Pi is a *library* — an in-process SDK, not a CLI
   Absence spawns — so "locating" it means finding its package directory and
   importing its `dist/index.js` from there.

   Resolution order, most specific first:
     1. an explicit override (the picker's saved path, or ABSENCE_PI_BIN)
     2. the package the user installed globally (npm -g)
     3. the package resolved from Absence's own tree (bundled fallback)

   The exported loaders import the *SDK entry* (`dist/index.js`), the same
   module a bundled install would resolve, so every capability Absence relies
   on — createAgentSession, the replaceable shell operations behind Agent Eggs,
   model/thinking/compact APIs — is identical regardless of where it loads from.
   ══════════════════════════════════════════════════════════════════════════ */

const PKG = "@earendil-works/pi-coding-agent";
const SDK_ENTRY = path.join("dist", "index.js");

/** Where a resolved pi package came from, for the picker's provenance label. */
export type PiSource = "configured" | "env" | "global" | "bundled" | "none";

export interface ResolvedPi {
  /** Absolute path to the package root, when resolved. */
  dir?: string;
  /** Absolute path to the SDK entry (dist/index.js), when resolved. */
  entry?: string;
  /** The package version, when readable. */
  version?: string;
  source: PiSource;
}

function isPiPackage(dir: string): boolean {
  try {
    const pkgPath = path.join(dir, "package.json");
    if (!fs.existsSync(path.join(dir, SDK_ENTRY))) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
    return pkg.name === PKG;
  } catch {
    return false;
  }
}

/** Candidate root directories an override might name, in order. */
function candidateDirs(input: string): string[] {
  const trimmed = input.trim().replace(/^file:\/\//, "");
  // The user may point at the package dir, its dist/index.js, or package.json.
  return [trimmed, path.join(trimmed, "dist"), path.dirname(trimmed)];
}

/** The global npm root, computed without shelling out. */
function globalRoots(): string[] {
  const roots: string[] = [];
  const prefix =
    process.env.npm_config_prefix ??
    process.env.PREFIX ??
    (process.platform === "win32"
      ? path.join(process.env.APPDATA ?? "", "npm")
      : "/usr/local");
  if (prefix) roots.push(path.join(prefix, "node_modules"));
  // Common alternates (nvm, Homebrew, pnpm).
  for (const extra of [
    process.env.NVM_BIN ? path.join(process.env.NVM_BIN, "..", "lib", "node_modules") : "",
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    path.join(process.env.HOME ?? "", ".local", "share", "pnpm", "global", "5", "node_modules"),
  ]) {
    if (extra) roots.push(extra);
  }
  return roots;
}

/** Resolve the pi package directory. */
export function resolvePiDetailed(override?: string): ResolvedPi {
  const configured = override?.trim();
  if (configured) {
    for (const dir of candidateDirs(configured)) {
      if (isPiPackage(dir)) return finish(dir, "configured");
    }
    // The override names an explicit entry file — trust it as-is.
    const entry = path.isAbsolute(configured) ? configured : path.resolve(configured);
    return { dir: path.dirname(entry), entry, source: "configured" };
  }

  const fromEnv = process.env.ABSENCE_PI_BIN?.trim();
  if (fromEnv) {
    for (const dir of candidateDirs(fromEnv)) {
      if (isPiPackage(dir)) return finish(dir, "env");
    }
  }

  for (const root of globalRoots()) {
    const dir = path.join(root, PKG);
    if (isPiPackage(dir)) return finish(dir, "global");
  }

  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve(`${PKG}/package.json`);
    const dir = path.dirname(pkgJson);
    if (isPiPackage(dir)) return finish(dir, "bundled");
  } catch {
    // not installed alongside Absence either
  }

  return { source: "none" };
}

function finish(dir: string, source: PiSource): ResolvedPi {
  let version: string | undefined;
  try {
    version = (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string })
      .version;
  } catch {
    // version is cosmetic
  }
  return { dir, entry: path.join(dir, SDK_ENTRY), version, source };
}

/**
 * Import the Pi SDK from the resolved package. Falls back to the bare specifier
 * (Absence's own dependency) when nothing else resolves, so a normal install
 * still works even if the global probe misses.
 */
export async function loadPiSdk(override?: string): Promise<{
  sdk: typeof import("@earendil-works/pi-coding-agent");
  resolved: ResolvedPi;
}> {
  const resolved = resolvePiDetailed(override);
  if (resolved.entry) {
    const sdk = (await import(pathToFileURL(resolved.entry).href)) as typeof import(
      "@earendil-works/pi-coding-agent"
    );
    return { sdk, resolved };
  }
  const sdk = (await import(PKG)) as typeof import("@earendil-works/pi-coding-agent");
  return { sdk, resolved };
}
