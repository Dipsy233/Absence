import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

export type AgentKind = "pi" | "mock";

export interface DazeConfig {
  port: number;
  host: string;
  /** Directory whose subfolders are offered as projects. */
  projectsRoot: string;
  /** Default agent runtime to use when creating sessions. */
  defaultAgent: AgentKind;
  /** Built-in Pi tools to enable (comma separated in env). */
  piTools: string[];
  /** Model for the Pi session, if pinned. */
  piModel?: string;
  /** Serve the built web app from this directory when present. */
  webDist: string;
}

function envAgent(): AgentKind {
  const value = (process.env.DAZE_AGENT ?? "pi").toLowerCase();
  return value === "mock" ? "mock" : "pi";
}

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export const config: DazeConfig = {
  port: Number(process.env.PORT ?? 8848),
  host: process.env.HOST ?? "127.0.0.1",
  projectsRoot: process.env.DAZE_PROJECTS_ROOT ?? path.join(os.homedir(), "projects"),
  defaultAgent: envAgent(),
  piTools: (process.env.DAZE_PI_TOOLS ?? "read,bash,edit,write,grep,find,ls")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),
  piModel: process.env.DAZE_PI_MODEL,
  webDist: process.env.DAZE_WEB_DIST ?? path.join(repoRoot, "apps/web/dist"),
};

/**
 * Host override hook. The CLI entry point mutates nothing; an embedding host
 * (the Electron desktop shell) calls this once before `startServer()` so it can
 * choose the port — or pass `port: 0` to let the OS pick a free one — without
 * the server knowing who is hosting it. Everything else reads the same
 * singleton, so no call site changes.
 */
export function configure(patch: Partial<DazeConfig>): DazeConfig {
  Object.assign(config, patch);
  return config;
}
