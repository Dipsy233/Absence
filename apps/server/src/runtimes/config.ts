import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, configure } from "../config";
import { resolveDshBin } from "../agents/DshClient";
import { resolveCodexBinDetailed } from "../agents/CodexBin";
import { resolvePiDetailed } from "../agents/PiBin";
import { listProfiles } from "../agents/acp/AgentCatalog";
import type { RuntimeStatus } from "@absence/core";

export type { RuntimeStatus };

/* ══════════════════════════════════════════════════════════════════════════
   Runtime configuration — the binary paths the agent runtimes need, editable
   from the Project Picker so a missing/incorrectly-pathed runtime can be fixed
   without editing environment variables or restarting.

   Persisted to ~/.absence/runtimes.json. Env vars still win at first load
   (ABSENCE_CODEX_BIN / ABSENCE_DSH_BIN); a value saved here overrides them and
   survives a restart, so the picker is the single place to configure paths.

   Pi runs in-process (its SDK is a module import), so it has no path — it is
   reported by whether its package resolves, nothing more.
   ══════════════════════════════════════════════════════════════════════════ */

const DIR = path.join(os.homedir(), ".absence");
const FILE = path.join(DIR, "runtimes.json");

export interface RuntimePaths {
  /** Pi coding-agent package directory (or its dist/index.js entry). */
  piBin?: string;
  /** Codex CLI entry (the JS shim or a real executable). */
  codexBin?: string;
  /** dsh (DeepSeek Harness) CLI entry. */
  dshBin?: string;
}

function read(): RuntimePaths {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw) as RuntimePaths;
    return {
      piBin: typeof parsed.piBin === "string" ? parsed.piBin : undefined,
      codexBin: typeof parsed.codexBin === "string" ? parsed.codexBin : undefined,
      dshBin: typeof parsed.dshBin === "string" ? parsed.dshBin : undefined,
    };
  } catch {
    return {};
  }
}

function write(paths: RuntimePaths): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, `${JSON.stringify(paths, null, 2)}\n`, "utf8");
  } catch {
    // Best effort; a failed write just means the override is not remembered.
  }
}

/** The saved overrides, merged with env defaults (env wins only when unset here). */
export function runtimePaths(): RuntimePaths {
  return read();
}

/**
 * Apply saved overrides onto the live config. Called once at startup, after
 * config is built from env, so a path saved from the picker takes effect on the
 * next launch (and immediately when the setter runs).
 */
export function applyRuntimePaths(): void {
  const saved = read();
  if (saved.piBin !== undefined) configure({ piBin: saved.piBin });
  if (saved.codexBin !== undefined) configure({ codexBin: saved.codexBin });
  if (saved.dshBin !== undefined) {
    configure({ dshBin: saved.dshBin });
  } else if (!config.dshBin) {
    // The generic ACP profile launches `config.dshBin ?? "dsh"`. DSH Desktop's
    // bundled bin.js is not on PATH, so resolve it once here — the same
    // discovery the pre-ACP DshClient used — or the default path would regress.
    const resolved = resolveDshBin();
    if (resolved !== "dsh") configure({ dshBin: resolved });
  }
}

/** Save new binary paths and apply them to the live config at once. */
export function setRuntimePaths(patch: RuntimePaths): RuntimePaths {
  const next = { ...read(), ...patch };
  // Empty string clears the override (falls back to probing / PATH).
  if (patch.piBin !== undefined) {
    next.piBin = patch.piBin.trim() || undefined;
    configure({ piBin: next.piBin });
  }
  if (patch.codexBin !== undefined) {
    next.codexBin = patch.codexBin.trim() || undefined;
    configure({ codexBin: next.codexBin });
  }
  if (patch.dshBin !== undefined) {
    next.dshBin = patch.dshBin.trim() || undefined;
    configure({ dshBin: next.dshBin });
  }
  write(next);
  return next;
}

/** Every runtime, with an availability verdict for the picker. */
export function runtimeStatuses(): RuntimeStatus[] {
  const saved = read();
  const pi = resolvePiDetailed(config.piBin ?? saved.piBin);
  const piAvailable = pi.source !== "none";
  const codex = resolveCodexBinDetailed(config.codexBin ?? saved.codexBin);
  const codexAvailable = codex.source !== "none";
  const dshResolved = resolveDshBin(config.dshBin ?? saved.dshBin);
  // resolveDshBin returns a real path when it finds the DSH Desktop install, or
  // the bare name "dsh" to mean "let PATH resolve it". Either way dsh is
  // startable; an unresolvable `dsh` will fail at spawn and be reported then.
  const dshAvailable = dshResolved !== undefined;

  return [
    {
      kind: "pi",
      label: "Pi",
      available: piAvailable,
      configurable: true,
      path: pi.dir,
      note: piAvailable
        ? `package path${pi.version ? ` (v${pi.version})` : ""} (${pi.source})`
        : "not found — install @earendil-works/pi-coding-agent or set its path below",
    },
    {
      kind: "codex",
      label: "Codex",
      available: codexAvailable,
      configurable: true,
      path: codex.source === "none" ? undefined : codex.entry,
      note: codexAvailable
        ? `path to codex.js or the codex executable (${codex.source})`
        : "not found — install codex or set its path below",
    },
    {
      kind: "dsh",
      label: "DSH (DeepSeek Harness)",
      available: dshAvailable,
      configurable: true,
      path: dshResolved,
      note: dshAvailable
        ? "path to the dsh bin.js (or a dsh executable on PATH)"
        : "not found — install DSH Desktop or set its path below",
    },
    {
      kind: "mock",
      label: "Mock",
      available: true,
      configurable: false,
      note: "no credentials needed — lays real processes for the watcher",
    },
    ...acpRuntimeStatuses(["dsh"]),
  ];
}

/**
 * Every ACP profile the catalog knows, as a picker entry.
 *
 * These are data, not code: the list comes from agents/acp/profiles.ts plus
 * ~/.absence/agents.json plus the optional registry cache. `dsh` is skipped
 * because it already has its own entry above.
 */
function acpRuntimeStatuses(skip: string[]): RuntimeStatus[] {
  return listProfiles()
    .filter((profile) => profile.source !== "fixture" && !skip.includes(profile.id))
    .map((profile) => ({
      kind: profile.id,
      label: profile.label,
      available: commandOnPath(profile.launch.command),
      configurable: false,
      path: profile.launch.command,
      note:
        [profile.note, `launch: ${[profile.launch.command, ...(profile.launch.args ?? [])].join(" ")}`]
          .filter(Boolean)
          .join(" · ") || "ACP profile",
    }));
}

/**
 * True when a launch command is present: an existing absolute path, or on PATH.
 *
 * Deliberately a PATH scan rather than `where`/`which`: the picker asks this for
 * every ACP profile, and spawning a process per profile made the first
 * `/api/runtimes` request slower than the UI's 1 s probe timeout.
 */
function commandOnPath(command: string): boolean {
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
