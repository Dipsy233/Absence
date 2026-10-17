import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

export type AgentKind = "pi" | "codex" | "dsh" | "mock";

export interface AbsenceConfig {
  port: number;
  host: string;
  /** Directory whose subfolders are offered as projects. */
  projectsRoot: string;
  /** Default agent runtime to use when creating sessions. */
  defaultAgent: AgentKind;
  /**
   * Pi's tool allowlist, from `ABSENCE_PI_TOOLS` — or **undefined** when the
   * variable is unset, which is the normal case.
   *
   * Undefined matters: passing a list makes Pi treat it as an allowlist, and a
   * list that does not mention `mcp__*` marks MCP tools "kept but only for
   * codemode/tool_search" (see Pi's `_isActivatable`). A server configured with
   * `exposure: "direct"` then connects, registers its tools, and is silently
   * never declared to the model. Leaving `tools` unset lets Pi use its own
   * `defaultTools` setting, where a `direct` server works as documented.
   */
  piTools?: string[];
  /** Model for the Pi session, if pinned. */
  piModel?: string;
  /**
   * Load MCP servers and skills (see capabilities/discover.ts). On by default;
   * `ABSENCE_MCP=0` turns MCP off for a session, which is what a broken server
   * launcher on a locked-down machine needs. Skills are always discovered.
   */
  mcpEnabled: boolean;
  /**
   * The `@earendil-works/pi-coding-agent` package to embed (its directory, or
   * the dist/index.js entry). Unset means Absence resolves it: a global npm
   * install the user has > the package resolved from Absence's own tree. Set
   * from the Project Picker (persisted to ~/.absence/runtimes.json) or via
   * ABSENCE_PI_BIN. See agents/PiBin.ts.
   */
  piBin?: string;
  /**
   * Codex sandbox for a thread: `read-only`, `workspace-write` or
   * `danger-full-access`. Defaults to `workspace-write` so the agent can edit
   * its project the way the Codex TUI does; without it the app-server's own
   * default is `read-only` and every write stalls on an approval nobody answers.
   */
  codexSandbox: string;
  /**
   * Codex approval policy: `untrusted`, `on-request`, `on-failure` or `never`.
   * Defaults to `on-request`; Absence surfaces the prompts on the Stage (see
   * CodexAdapter's onRequest) instead of silently deciding for the user.
   */
  codexApproval: string;
  /**
   * How Absence handles a Codex approval prompt:
   *   `ask`                 — surface it on the Stage and wait for the user (default)
   *   `accept`/`accept-for-session`/`decline` — answer automatically, no card
   * The default is `ask`: the agent is paused on the decision, so the user who
   * is watching gets to make it.
   */
  codexApprovalDecision: string;
  /**
   * Take over Codex's shell through its exec-server protocol. When on
   * (default), Absence registers a loopback exec-server with `environment/add`
   * and pins the thread to it, so Codex hands every command to Absence to
   * spawn. Absence then owns the process boundary — the same position
   * AbsenceShell holds for Pi — which is what lets it see every process the
   * agent lays, including detached ones (`Start-Process`, background daemons)
   * that would otherwise escape the Job Object.
   */
  codexExecServer: boolean;
  /**
   * Codex's home directory (`$CODEX_HOME`), where `config.toml` (its
   * `[mcp_servers.*]` tables) and `skills/` live. Unset means ~/.codex.
   */
  codexHome?: string;
  /**
   * The Codex CLI entry to run (the JS shim `@openai/codex/bin/codex.js`, or a
   * real executable). Unset means Absence resolves it from the installed
   * package. Editable from the Project Picker (persisted to
   * ~/.absence/runtimes.json); ABSENCE_CODEX_BIN seeds it from the environment.
   */
  codexBin?: string;
  /**
   * The `dsh` (DeepSeek Harness) ACP entry to run. Absence drives DSH through
   * its automation-only Agent Client Protocol server (`dsh --profile acp`),
   * a JSON-RPC/NDJSON channel on stdio — the same observer shape as Codex's
   * app-server. Override with ABSENCE_DSH_BIN; when unset, Absence probes the
   * common install locations (see agents/DshClient.ts) and finally falls back
   * to a bare `dsh` on PATH.
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
  /** Serve the built web app from this directory when present. */
  webDist: string;
}

/** `read,bash` → ["read","bash"]; unset / blank → undefined (Pi's own defaults). */
function parseToolList(value: string | undefined): string[] | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const list = trimmed
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function envAgent(): AgentKind {
  const value = (process.env.ABSENCE_AGENT ?? "pi").toLowerCase();
  return value === "mock" || value === "codex" || value === "dsh" ? value : "pi";
}

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/** Only Codex's own slugs are valid; anything else falls back to the safe default. */
function normalizeCodexSandbox(value: string | undefined): string {
  const v = (value ?? "").toLowerCase();
  if (v === "read-only" || v === "workspace-write" || v === "danger-full-access") return v;
  return "workspace-write";
}

function normalizeCodexApproval(value: string | undefined): string {
  const v = (value ?? "").toLowerCase();
  if (v === "untrusted" || v === "on-request" || v === "on-failure" || v === "never") return v;
  return "on-request";
}

/** `ask` (surface and wait), or an automatic decision. Anything else → `ask`. */
function normalizeApprovalDecision(value: string | undefined): string {
  const v = (value ?? "").toLowerCase();
  if (v === "accept" || v === "accept-for-session" || v === "decline") return v;
  return "ask";
}

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
  // Unset stays unset: an empty array would be an allowlist that filters every
  // MCP tool too (Pi reads length 0 as "no tools at all").
  piTools: parseToolList(process.env.ABSENCE_PI_TOOLS),
  piModel: process.env.ABSENCE_PI_MODEL,
  mcpEnabled: envFlag(process.env.ABSENCE_MCP, true),
  piBin: process.env.ABSENCE_PI_BIN,
  codexSandbox: normalizeCodexSandbox(process.env.ABSENCE_CODEX_SANDBOX),
  codexApproval: normalizeCodexApproval(process.env.ABSENCE_CODEX_APPROVAL),
  codexApprovalDecision: normalizeApprovalDecision(process.env.ABSENCE_CODEX_APPROVAL_DECISION),
  codexExecServer: envFlag(process.env.ABSENCE_CODEX_EXEC_SERVER, true),
  codexHome: process.env.CODEX_HOME,
  codexBin: process.env.ABSENCE_CODEX_BIN,
  dshBin: process.env.ABSENCE_DSH_BIN,
  dshProfile: process.env.ABSENCE_DSH_PROFILE ?? "acp",
  dshHome: process.env.ABSENCE_DSH_HOME,
  dshProvider: process.env.ABSENCE_DSH_PROVIDER,
  dshModel: process.env.ABSENCE_DSH_MODEL,
  maxEggs: Number.isFinite(Number(process.env.ABSENCE_MAX_EGGS))
    ? Math.max(0, Math.floor(Number(process.env.ABSENCE_MAX_EGGS)))
    : 200,
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
