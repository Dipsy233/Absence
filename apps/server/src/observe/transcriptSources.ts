import os from "node:os";
import path from "node:path";

/**
 * The transcript source: pi's own session files.
 *
 * One source, one parser — this is the single deliberate coupling to an agent
 * software's private format (pi is open source, so the format is auditable).
 * Any future listener is a new module implementing the same seam
 * (`feed`/`drain` → AbsenceEvent) registered here; nothing else in the server
 * knows or cares where facts came from.
 */
export interface TranscriptLaunch {
  /** The command the user's terminal runs, resolved via PATH like always. */
  command: string;
  /** Extra args for a fresh session. */
  args?: string[];
  /** Args that point the agent at an existing transcript (resume). */
  resume?(transcriptFile: string): string[];
}

export interface TranscriptSourceProfile {
  id: string;
  label: string;
  /** The agent kind recorded on observed sessions created from this source. */
  agentKind: string;
  /** Directory roots to watch, recursively. `~` expands to the user's home. */
  roots: string[];
  /** The agent's config-root env; sessions live under `<dir>/sessions`. */
  dirEnv?: string;
  /** Subdirectory appended to `dirEnv`'s value when it is set. */
  dirEnvSuffix?: string;
  /** The env naming the sessions directory directly; wins over `dirEnv`. */
  sessionDirEnv?: string;
  /**
   * How Absence opens the user's own terminal on this agent (the auxiliary
   * launcher). Absence spawns the terminal application and nothing else: it
   * never speaks to the agent, and observation still rides the transcript.
   * Absent for sources Absence cannot launch.
   */
  launch?: TranscriptLaunch;
}

export const TRANSCRIPT_SOURCES: readonly TranscriptSourceProfile[] = [
  {
    id: "pi",
    label: "Pi",
    agentKind: "pi",
    roots: ["~/.pi/agent/sessions"],
    dirEnv: "PI_CODING_AGENT_DIR",
    dirEnvSuffix: "sessions",
    // pi moves its session store with `--session-dir`, the `sessionDir`
    // setting, or this env (docs.pi.dev/latest/sessions.md).
    sessionDirEnv: "PI_CODING_AGENT_SESSION_DIR",
    // `--session <file>` continues that transcript (real-machine verified:
    // this exact shape is what ProcessScanner binds attribution by).
    launch: {
      command: "pi",
      resume: (file) => ["--session", file],
    },
  },
];

/** `~` → home; keeps absolute roots untouched. */
export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/**
 * The directories this source watches on this host. An explicit
 * `ABSENCE_OBSERVE_PI_ROOT` (comma-separated) wins — the check suite uses it
 * to point discovery at a fixture tree instead of real agent data.
 */
export function sourceRoots(profile: TranscriptSourceProfile): string[] {
  const override = process.env[`ABSENCE_OBSERVE_${profile.id.toUpperCase().replace(/-/g, "_")}_ROOT`];
  if (override !== undefined && override.trim().length > 0) {
    return override
      .split(",")
      .map((value) => expandHome(value.trim()))
      .filter((value) => value.length > 0);
  }
  const sessionDir = profile.sessionDirEnv !== undefined ? process.env[profile.sessionDirEnv]?.trim() : undefined;
  if (sessionDir !== undefined && sessionDir.length > 0) {
    return [expandHome(sessionDir)];
  }
  const dirValue = profile.dirEnv !== undefined ? process.env[profile.dirEnv]?.trim() : undefined;
  if (dirValue !== undefined && dirValue.length > 0) {
    const base = expandHome(dirValue);
    const root = profile.dirEnvSuffix !== undefined ? path.join(base, profile.dirEnvSuffix) : base;
    return [root];
  }
  return profile.roots.map(expandHome);
}
