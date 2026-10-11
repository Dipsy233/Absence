import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, configure } from "../config";
import { resolveDshBin } from "../agents/DshClient";
import { resolveCodexBinDetailed } from "../agents/CodexBin";

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
  /** Codex CLI entry (the JS shim or a real executable). */
  codexBin?: string;
  /** dsh (DeepSeek Harness) CLI entry. */
  dshBin?: string;
}

/** One runtime's status row, as the picker shows it. */
export interface RuntimeStatus {
  kind: "pi" | "codex" | "dsh" | "mock";
  label: string;
  /** True when the runtime looks startable right now. */
  available: boolean;
  /** True when this runtime takes a configurable binary path. */
  configurable: boolean;
  /** The path currently in use (resolved), when the runtime has one. */
  path?: string;
  /** A short human note: why it is unavailable, or how it is provided. */
  note: string;
}

function read(): RuntimePaths {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw) as RuntimePaths;
    return {
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
  if (saved.codexBin !== undefined) configure({ codexBin: saved.codexBin });
  if (saved.dshBin !== undefined) configure({ dshBin: saved.dshBin });
}

/** Save new binary paths and apply them to the live config at once. */
export function setRuntimePaths(patch: RuntimePaths): RuntimePaths {
  const next = { ...read(), ...patch };
  // Empty string clears the override (falls back to probing / PATH).
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
      available: true,
      configurable: false,
      note: "in-process SDK — provided by the installed @earendil-works/pi-coding-agent package",
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
  ];
}
