import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

/* ══════════════════════════════════════════════════════════════════════════
   Locate the Codex CLI.

   Absence is a client, not a vendor: it drives whichever codex the user has,
   it does not ship one of its own. Resolution order, most specific first:

     1. an explicit override (the picker's saved path, or ABSENCE_CODEX_BIN)
     2. a `codex` executable on PATH        — the user's own install
     3. the package-resolved bin shim       — only when a codex package happens
                                              to be installed alongside Absence

   Step 3 exists purely as a fallback so a development checkout that installs
   a codex package still works; a normal install relies on 1 or 2. When nothing
   resolves, the bare name "codex" is returned and the spawn fails with ENOENT,
   which the adapter reports as "not installed".
   ══════════════════════════════════════════════════════════════════════════ */

/** What a resolved codex entry points at, for the picker's provenance label. */
export type CodexBinSource = "configured" | "env" | "path" | "bundled" | "none";

export interface ResolvedCodexBin {
  /** The command or script path to run. */
  entry: string;
  source: CodexBinSource;
}

/** Look up an executable on PATH (with Windows extensions). */
function whichOnPath(name: string): string | undefined {
  const pathVar = process.env.PATH ?? process.env.Path ?? "";
  const parts = pathVar.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of parts) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // unreadable path; keep looking
      }
    }
  }
  return undefined;
}

/**
 * Resolve the codex entry.
 *
 * @param override - the picker's saved path (highest priority).
 */
export function resolveCodexBinDetailed(override?: string): ResolvedCodexBin {
  const configured = override?.trim();
  if (configured) return { entry: configured, source: "configured" };

  const fromEnv = process.env.ABSENCE_CODEX_BIN?.trim();
  if (fromEnv) return { entry: fromEnv, source: "env" };

  const onPath = whichOnPath("codex");
  if (onPath) return { entry: onPath, source: "path" };

  try {
    const req = createRequire(import.meta.url);
    const bundled = req.resolve("@openai/codex/bin/codex.js");
    return { entry: bundled, source: "bundled" };
  } catch {
    // Nothing found: let the spawn fail and be reported as "not installed".
    return { entry: "codex", source: "none" };
  }
}

/** The codex entry to run, preferring the user's own install. */
export function resolveCodexBin(override?: string): string {
  return resolveCodexBinDetailed(override).entry;
}
