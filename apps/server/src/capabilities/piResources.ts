import fs from "node:fs";
import type {
  ExtensionFactory,
  McpServerConfig,
  Skill,
} from "@earendil-works/pi-coding-agent";
import type { McpServerSpec, SkillSpec } from "./discover";

/* ══════════════════════════════════════════════════════════════════════════
   Pi capability wiring.

   Pi's SDK does not run the CLI's bootstrap: `createAgentSession` builds a
   plain `DefaultResourceLoader` with no built-in extensions, so a naive
   embedding silently loses exactly the things a Pi user takes for granted:

     • `codemode`, `tool_search` and `mcp` — the CLI loads them in `main.ts`
       via `builtInExtensions`; `createAgentSession` does not. Without them an
       `mcp.json` is never read and no `mcp__<server>__<tool>` exists.
     • `~/.agents/skills` and `<project>/.agents/skills` — discovered by Pi's
       package manager, which is also only wired through the CLI path.
     • The first `session_start` — the MCP extension connects its servers
       only on `session_start`, which is emitted by `bindExtensions()`.

   This module supplies all three. It is deliberately runtime-version
   tolerant: every Pi capability it uses is probed, so an older or newer SDK
   degrades instead of failing the session (see PiAdapter's comments on
   `Markdown` — the same principle: probe, then use).

   What it does NOT do: execute anything, or change the shell takeover. Tool
   calls — MCP, codemode, skill reads — flow through Pi's normal pipeline,
   so they arrive as `tool_execution_*` events and render on the Stage like
   `read` or `bash` does.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The slice of the loaded Pi SDK this module needs.
 *
 * Typed as `Partial` of the *real* SDK rather than as home-grown shapes: the
 * user may have a different Pi version installed than the one Absence is
 * compiled against (see agents/PiBin.ts), so every member is optional, but the
 * ones that do exist must type-check against Pi's own signatures. A factory
 * that is missing (old version) is simply not used.
 */
export type PiCapabilitySdk = Partial<typeof import("@earendil-works/pi-coding-agent")>;

export type PiExtensionFactory = ExtensionFactory;

/** The resource loader instance Pi's `createAgentSession` accepts. */
type PiResourceLoader = NonNullable<
  NonNullable<Parameters<typeof import("@earendil-works/pi-coding-agent").createAgentSession>[0]>["resourceLoader"]
>;

export interface PiCapabilityPlan {
  /** Extension factories to give `DefaultResourceLoader.extensionFactories`. */
  extensionFactories: PiExtensionFactory[];
  /** Options passed to `new DefaultResourceLoader({...})` alongside cwd/agentDir. */
  loaderOptions: Record<string, unknown>;
  /**
   * Build the loader for a session. Undefined when the installed Pi has no
   * `DefaultResourceLoader` — then the session starts with Pi's own defaults
   * and only the built-in tool set, exactly as before this module existed.
   */
  createLoader?: (options: { cwd: string; agentDir?: string }) => PiResourceLoader & {
    reload: (options?: unknown) => Promise<void>;
  };
  /** MCP servers Pi's own extension will read from `mcp.json`, for logging. */
  mcpServers: string[];
  /** Skills injected directly (the ones Pi's discovery may not reach). */
  injectedSkills: number;
}

/**
 * Build the resource-loader inputs for a Pi session.
 *
 * `discovered` comes from `capabilities/discover.ts`. Pi re-reads `mcp.json`
 * itself (through the MCP extension), so the servers listed there are not
 * re-registered here — that would double-connect. Only servers that Pi would
 * not see (a Codex `config.toml` entry, an extension-registered server) are
 * registered explicitly, with `pi.registerMcpServer`.
 */
export function planPiCapabilities(
  sdk: PiCapabilitySdk,
  options: {
    cwd: string;
    agentDir: string;
    /** When false, do not load `mcp.json` through the extension (tests, mock). */
    mcp?: boolean;
    /** Skills discovered by Absence; injected so `.agents/skills` is honoured. */
    skills: SkillSpec[];
    /** MCP servers discovered by Absence, with their source file. */
    mcpServers: McpServerSpec[];
  },
): PiCapabilityPlan {
  const extensionFactories: PiExtensionFactory[] = [];
  const loaderOptions: Record<string, unknown> = {};

  // 1. Skills. The loader's own discovery covers `~/.pi/agent/skills` and
  //    `<cwd>/.pi/skills`; it composes with `~/.agents/skills` and
  //    `<project>/.agents/skills` only through the CLI bootstrap. Injecting
  //    the discovered set makes both work identically here. Duplicates are
  //    dropped by name (Pi keeps the first), so an injected skill that the
  //    loader also found is harmless.
  if (options.skills.length > 0) {
    const injected = toPiSkills(sdk, options.skills);
    loaderOptions.skillsOverride = (current: { skills: Skill[]; diagnostics: unknown[] } | undefined) => {
      const existing = current?.skills ?? [];
      const known = new Set(existing.map((skill) => skill.name));
      return {
        skills: [...existing, ...injected.filter((skill) => !known.has(skill.name))],
        diagnostics: current?.diagnostics ?? [],
      };
    };
  }

  // 2. MCP. Pi's built-in MCP extension is what actually connects servers.
  //    `createAgentSession` does not load it, so it is added here. Servers
  //    from a Codex `config.toml` are registered explicitly on top.
  const mcpCapable = options.mcp !== false && typeof sdk.createMcpExtension === "function";
  if (mcpCapable) {
    const factories: PiExtensionFactory[] = [];
    // codemode/tool_search are registered inactive; the MCP extension
    // activates them for `codemode`/`deferred` servers. Supplying them is what
    // makes the default (`exposure: "codemode"`) reachable at all.
    if (typeof sdk.createCodemodeExtension === "function") {
      factories.push(sdk.createCodemodeExtension({ mode: "on" }));
    }
    if (typeof sdk.createToolSearchExtension === "function") {
      factories.push(sdk.createToolSearchExtension());
    }
    factories.push(sdk.createMcpExtension!({ startupWaitMs: 10_000 }));
    extensionFactories.push(...factories);

    // Servers Pi cannot see on its own (Codex TOML). Registered as extension
    // servers; `mcp.json` entries keep precedence inside Pi too.
    const extra = options.mcpServers.filter((server) => server.source === "codex" && server.enabled !== false);
    if (extra.length > 0) {
      const register: ExtensionFactory = (pi) => {
        const api = pi as unknown as {
          registerMcpServer?: (name: string, config: McpServerConfig) => void;
        };
        if (typeof api.registerMcpServer !== "function") return;
        for (const server of extra) {
          try {
            api.registerMcpServer(server.name, toPiMcpConfig(server));
          } catch {
            // A malformed entry must not take the session down.
          }
        }
      };
      extensionFactories.push(register);
    }
  }

  const Loader = sdk.DefaultResourceLoader;
  const createLoader =
    typeof Loader === "function"
      ? (loaderOptionsInput: { cwd: string; agentDir?: string }) =>
          new Loader({
            ...loaderOptions,
            cwd: loaderOptionsInput.cwd,
            agentDir: loaderOptionsInput.agentDir ?? options.agentDir,
            ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
          }) as PiResourceLoader & { reload: (options?: unknown) => Promise<void> }
      : undefined;

  return {
    extensionFactories,
    loaderOptions,
    createLoader,
    mcpServers: mcpCapable ? options.mcpServers.filter((s) => s.enabled !== false).map((s) => s.name) : [],
    injectedSkills: (loaderOptions.skillsOverride ? options.skills.length : 0),
  };
}

/** Absence's `SkillSpec` → Pi's `Skill`. */
function toPiSkills(sdk: PiCapabilitySdk, skills: SkillSpec[]): Skill[] {
  const createSyntheticSourceInfo = sdk.createSyntheticSourceInfo;
  const source = createSyntheticSourceInfo
    ? (filePath: string, baseDir: string) =>
        createSyntheticSourceInfo(filePath, {
          source: "absence",
          scope: "temporary",
          baseDir,
        })
    : (filePath: string, baseDir: string) =>
        ({
          path: filePath,
          source: "absence",
          scope: "temporary",
          origin: "top-level",
          baseDir,
        }) as unknown;
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    sourceInfo: source(skill.filePath, skill.baseDir) as Skill["sourceInfo"],
    disableModelInvocation: false,
  }));
}

/** Absence's `McpServerSpec` → Pi's `McpServerConfig` (`mcpServers` shape). */
export function toPiMcpConfig(server: McpServerSpec): McpServerConfig {
  const base: Record<string, unknown> = {
    enabled: server.enabled !== false,
  };
  if (server.exposure) base.exposure = server.exposure;
  if (server.description) base.description = server.description;
  if (server.timeout !== undefined) base.timeout = server.timeout;
  if (server.type === "http" && server.url) {
    return { ...base, url: server.url, ...(server.headers ? { headers: server.headers } : {}) } as McpServerConfig;
  }
  return {
    ...base,
    command: server.command ?? "",
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
  } as McpServerConfig;
}

/**
 * Read the SDK's default agent dir without importing Pi's config module at
 * load time (the adapter may be importing a *user-installed* Pi).
 */
export function piAgentDirFromSdk(sdk: {
  getAgentDir?: () => string;
}): string | undefined {
  try {
    return sdk.getAgentDir?.();
  } catch {
    return undefined;
  }
}

/** True when a path is a real file — used to keep `mcp.json` diagnostics honest. */
export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
