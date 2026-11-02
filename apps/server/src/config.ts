import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

/**
 * A runtime kind. The four built-ins are spelled out for autocomplete, but the
 * type is open on purpose: an ACP agent is a data profile (see
 * agents/acp/AgentCatalog.ts), so `claude-code` / `qwen-code` / any future id
 * must be storable without touching this file.
 */
export type AgentKind = "pi" | "codex" | "dsh" | "mock" | (string & {});

export interface AbsenceConfig {
  port: number;
  host: string;
  /** Directory whose subfolders are offered as projects. */
  projectsRoot: string;
  /** Default agent runtime to use when creating sessions. */
  defaultAgent: AgentKind;
  /**
   * The `dsh` entry the shipped ACP profile launches. Unset means the profile's
   * own `dsh` command is used; override with ABSENCE_DSH_BIN.
   */
  dshBin?: string;
  /**
   * The dsh profile the ACP server boots. The shipped automation profile is
   * `acp` (`dsh --profile acp`); override with ABSENCE_DSH_PROFILE.
   */
  dshProfile: string;
  /**
   * DSH_HOME — where dsh keeps its profiles and settings. Defaults to
   * ~/.dsh (dsh's own default); override with ABSENCE_DSH_HOME.
   */
  dshHome?: string;
  /**
   * Provider/model the ACP session starts on, written into the spawned
   * process's environment as DSH_PROVIDER / DSH_MODEL when set. Left unset,
   * the profile's own defaults apply (deepseek-official / deepseek-v4-flash).
   */
  dshProvider?: string;
  dshModel?: string;
  /**
   * How many finished eggs the watcher keeps. Eggs that are still running are
   * always kept; beyond this many finished ones the oldest exit and are
   * reported as `retired`, so a computer-use session that lays a process per
   * step cannot grow the Agent Eggs panel (or the watcher's memory) without
   * bound. Override with ABSENCE_MAX_EGGS; 0 means keep every finished egg.
   */
  maxEggs: number;
  /**
   * How many days of process metrics to keep. Chunks older than this are
   * deleted once a day. Override with ABSENCE_METRICS_RETENTION_DAYS; 0 keeps
   * everything (bounded only by disk).
   */
  metricsRetentionDays: number;
  /**
   * Watch Docker containers through the daemon's own event stream (see
   * process/DockerMonitor.ts). A container's processes live inside the
   * daemon's VM, where neither the Job Object nor eBPF can reach, so its
   * lifecycle and resource usage ride `docker events` and `docker stats`
   * instead. On by default; ABSENCE_DOCKER=0 turns it off, and a machine with
   * no docker at all degrades to exactly today's behavior.
   */
  dockerEnabled: boolean;
  /**
   * The docker CLI to drive, when the default resolution is not enough
   * (ABSENCE_DOCKER_BIN). Absence tries `docker` on PATH first, then — on
   * Windows only — `wsl docker` for a daemon that lives in a WSL distro. The
   * variable may be a bare binary or a prefix such as `wsl docker`.
   */
  dockerBin?: string;
  /** Serve the built web app from this directory when present. */
  webDist: string;
}

/** The runtime id from `ABSENCE_AGENT`, or the shipped default. Any id is valid. */
function envAgent(): AgentKind {
  return process.env.ABSENCE_AGENT?.trim() || "pi";
}

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/** On unless explicitly disabled (`0`/`false`/`off`). */
function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return fallback;
}

export const config: AbsenceConfig = {
  port: Number(process.env.PORT ?? 8848),
  host: process.env.HOST ?? "127.0.0.1",
  projectsRoot: process.env.ABSENCE_PROJECTS_ROOT ?? path.join(os.homedir(), "projects"),
  defaultAgent: envAgent(),
  dshBin: process.env.ABSENCE_DSH_BIN,
  dshProfile: process.env.ABSENCE_DSH_PROFILE ?? "acp",
  dshHome: process.env.ABSENCE_DSH_HOME,
  dshProvider: process.env.ABSENCE_DSH_PROVIDER,
  dshModel: process.env.ABSENCE_DSH_MODEL,
  maxEggs: Number.isFinite(Number(process.env.ABSENCE_MAX_EGGS))
    ? Math.max(0, Math.floor(Number(process.env.ABSENCE_MAX_EGGS)))
    : 200,
  metricsRetentionDays: Number.isFinite(Number(process.env.ABSENCE_METRICS_RETENTION_DAYS))
    ? Math.max(0, Math.floor(Number(process.env.ABSENCE_METRICS_RETENTION_DAYS)))
    : 30,
  dockerEnabled: envFlag(process.env.ABSENCE_DOCKER, true),
  dockerBin: process.env.ABSENCE_DOCKER_BIN,
  // Built UI lives at the repo root under dist/web (see apps/web/vite.config.ts
  // and the desktop staging script). Override with ABSENCE_WEB_DIST if hosting
  // elsewhere.
  webDist: process.env.ABSENCE_WEB_DIST ?? path.join(repoRoot, "dist/web"),
};

/**
 * Host override hook. The CLI entry point mutates nothing; an embedding host
 * (the Electron desktop shell) calls this once before `startServer()` so it can
 * choose the port — or pass `port: 0` to let the OS pick a free one — without
 * the server knowing who is hosting it. Everything else reads the same
 * singleton, so no call site changes.
 */
export function configure(patch: Partial<AbsenceConfig>): AbsenceConfig {
  Object.assign(config, patch);
  return config;
}
