import { config } from "../../config";

/**
 * What it takes to start an agent — data, not code.
 *
 * Absence is a *client*: it starts an agent that already speaks ACP, or it
 * starts a separate ACP adapter that the user installed. It never installs a
 * package on its own (the `npx` fallback is an explicit opt-in), and it never
 * writes anything into an agent's own directories.
 *
 * A shipped profile therefore does not say "run this package". It says:
 *
 *   1. which executables on PATH count as the agent's own CLI (`cli`);
 *   2. which executables / local node_modules entries count as an ACP entry;
 *   3. what a `npx` fallback would look like, if the user allows one.
 *
 * The actual choice is made by `AgentCatalog.ts` from what is installed on this
 * machine. That is why a new agent is a new entry here, not a new adapter class.
 */
export interface AgentLaunch {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for the agent process, when it must differ from the project. */
  cwd?: string;
}

/** How sign-in shows up: the UI hints, the agent decides. */
export type AgentAuthMode = "none" | "optional" | "required";

/**
 * What Absence could conclude about credentials from the agent's own config.
 * Values are never read out; this is a presence check, and `unknown` is a
 * legitimate answer.
 */
export type AgentAuthStatus = "configured" | "missing" | "unknown" | "not-required";

/**
 * The agent's declared models.
 *
 *   declared — read from the agent's own settings before it is connected
 *   session  — reported by ACP (`session/new` / `config_option_update`), which wins
 *   empty    — the settings were readable but declared no models
 *   unknown  — no readable settings; not the same as "no models"
 */
export interface AgentModels {
  state: "session" | "declared" | "empty" | "unknown";
  items: string[];
  /** The file the items were read from, when declared. */
  path?: string;
}

/** A machine-readable recipe for finding an installed ACP entry. */
export interface AgentDiscovery {
  /** The agent's own CLI. Found on PATH means "the agent is installed". */
  cli?: string[];
  /** Dedicated ACP adapter executables to look for on PATH (`pi-acp`, …). */
  acpBins?: string[];
  /** ACP adapter package names whose local `node_modules` entry counts. */
  acpPackages?: string[];
  /** Entry file inside an adapter package (default `dist/index.js`). */
  acpEntry?: string;
  /**
   * Arguments that put the agent's own CLI into ACP mode (`gemini --acp`,
   * `qwen --experimental-acp`). Presence means the CLI itself is the entry.
   */
  acpArgs?: string[];
  /** Package name for the explicit `npx` fallback. */
  npxPackage?: string;
  /** Version baked into the fallback; a `versionEnv` can override it. */
  npxVersion?: string;
  npxVersionEnv?: string;
}

/**
 * Where an agent keeps its own provider/model settings. Absence reads these
 * best-effort, for display only: no writes, no migrations, no repairs. A file
 * that is missing, unreadable or changed shape yields `unknown`.
 */
export interface AgentInspect {
  /** Env var naming the agent's config directory (e.g. PI_CODING_AGENT_DIR). */
  dirEnv?: string;
  /** Fallback directories, `~` expanded to the user's home. */
  dirs: string[];
  /** Parser family; named by format, never by product. */
  format: "providers-json" | "model-toml" | "settings-json";
  /** Files that may carry the declared model list. */
  modelFiles: string[];
  /** Files whose presence means credentials exist (values are never read out). */
  authFiles?: string[];
  /** Settings keys whose non-empty value means credentials exist. */
  credentialEnvKeys?: string[];
}

export interface AgentProfile {
  /** The runtime kind Absence stores in a session (`claude-code`, `qwen-code`, …). */
  id: string;
  label: string;
  /** The launch spec; for a shipped profile it is filled by discovery. */
  launch: AgentLaunch;
  /** Where this profile came from, so the picker can say so honestly. */
  source: "builtin" | "custom" | "registry" | "fixture";
  /** A short note shown in the picker. */
  note?: string;
  /**
   * Alternate ids that resolve to this profile. The session history stores the
   * runtime kind (`pi`), while the ACP registry names the adapter (`pi-acp`);
   * both must reach the same launch data without a code branch.
   */
  aliases?: string[];
  /** The ACP registry/package name this profile targets, for diagnostics only. */
  acp?: string;
  /**
   * Executables the agent itself needs, shown with the row. Discovery uses
   * `discovery.cli`; this is only the display copy.
   */
  requires?: string[];
  /**
   * Whether the agent refuses `session/new` until `authenticate` succeeds. This
   * is a hint; the resolved auth fact comes from `inspect`, or is `unknown`.
   */
  auth?: AgentAuthMode;
  /** A short capability hint shown in the picker (modes, plan, commands…). */
  capabilities?: string;
  /** True when the picker may persist a launch-line override for this profile. */
  configurable?: boolean;
  /** The env var that overrides the launch command, named in errors/notes. */
  commandEnv?: string;
  /**
   * Ask Absence's shared, cross-runtime file scan for the skills/MCP panel.
   * ACP carries no catalog request, so this is explicit opt-in and defaults
   * off: a profile that does not set it gets no panel rather than a list of
   * another runtime's servers. It is a data policy, not a product branch.
   */
  discoverCapabilities?: boolean;
  /** How to find an installed entry; absent for custom/registry profiles. */
  discovery?: AgentDiscovery;
  /** Where the agent's own settings live, read-only; absent means unknown. */
  inspect?: AgentInspect;
}

/* ══════════════════════════════════════════════════════════════════════════
   The shipped profile data. Everything below is the one place an install
   recipe, a package name or a config location is written down.
   ══════════════════════════════════════════════════════════════════════════ */

type ConfigBackedField = "dshBin" | "dshHome" | "dshProvider" | "dshModel" | "dshProfile";

interface ProfileData extends Omit<AgentProfile, "source" | "launch"> {
  launch: {
    /** Values forwarded from the host process's own environment. */
    envFrom?: string[];
    /** Literal values written into the child's environment. */
    env?: Record<string, string>;
    /** Env values taken from config (never invented). */
    envConfig?: Record<string, ConfigBackedField>;
  };
  /** Use this config field instead of `commandEnv` when it is set (dsh only). */
  commandConfig?: ConfigBackedField;
}

/**
 * Filled from the real-hardware verification (pi-acp 0.0.34,
 * @zed-industries/codex-acp 0.16.0). Versions are overridable without a code
 * change through the matching `versionEnv`.
 *
 * None of these launch `npx` by default. `npxPackage` only describes the
 * fallback that `ABSENCE_ALLOW_NPX=1` (or `allowNpx` in
 * ~/.absence/agents.json) turns on.
 */
export const builtinProfileData: readonly ProfileData[] = [
  {
    id: "pi",
    label: "Pi",
    acp: "pi-acp",
    aliases: ["pi-acp"],
    discovery: {
      cli: ["pi"],
      acpBins: ["pi-acp"],
      acpPackages: ["pi-acp"],
      acpEntry: "dist/index.js",
      npxPackage: "pi-acp",
      npxVersion: "0.0.34",
      npxVersionEnv: "ABSENCE_PI_ACP_VERSION",
    },
    inspect: {
      dirEnv: "PI_CODING_AGENT_DIR",
      dirs: ["~/.pi/agent", "~/.pi"],
      format: "providers-json",
      modelFiles: ["models.json"],
      authFiles: ["auth.json"],
    },
    launch: { env: { PI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" } },
    requires: ["pi"],
    commandEnv: "ABSENCE_PI_ACP_BIN",
    auth: "none",
    capabilities: "loadSession · embedded context · no permission prompts",
    note:
      "Pi itself is not an ACP server — `pi-acp` is the adapter. Absence starts an " +
      "installed `pi-acp` (PATH or local node_modules) and never downloads one.",
    configurable: true,
  },
  {
    id: "codex",
    label: "Codex",
    acp: "codex-acp",
    aliases: ["codex-acp"],
    discovery: {
      cli: ["codex"],
      acpBins: ["codex-acp"],
      acpPackages: ["@zed-industries/codex-acp"],
      acpEntry: "dist/index.js",
      npxPackage: "@zed-industries/codex-acp",
      npxVersion: "0.16.0",
      npxVersionEnv: "ABSENCE_CODEX_ACP_VERSION",
    },
    inspect: {
      dirEnv: "CODEX_HOME",
      dirs: ["~/.codex"],
      format: "model-toml",
      modelFiles: ["config.toml"],
      authFiles: ["auth.json"],
    },
    launch: {},
    requires: ["codex"],
    commandEnv: "ABSENCE_CODEX_ACP_BIN",
    auth: "required",
    capabilities:
      "plan · modes read-only/auto/full-access · slash commands · loadSession · embedded context",
    note:
      "@zed-industries/codex-acp · session/new answers “Authentication required” " +
      "until the agent's own authenticate method succeeds",
    configurable: true,
  },
  {
    id: "codex-acp-alt",
    label: "Codex (ACP, alternative)",
    acp: "codex-acp",
    // No PATH/node_modules discovery: this row exists for the alternative
    // package. It only becomes startable through an explicit path, an override,
    // or the opt-in npx fallback.
    discovery: {
      cli: ["codex"],
      acpBins: [],
      acpPackages: ["codex-acp"],
      acpEntry: "dist/index.js",
      npxPackage: "codex-acp",
      npxVersion: "1.11.0",
      npxVersionEnv: "ABSENCE_CODEX_ACP_ALT_VERSION",
    },
    launch: {},
    requires: ["codex"],
    commandEnv: "ABSENCE_CODEX_ACP_ALT_BIN",
    auth: "required",
    capabilities:
      "resume/close · prompt token detail · no plan, no command list, no loadSession",
    note:
      "baldaworks codex-acp · pick only when the Zed build is unavailable; " +
      "it declares different session capabilities",
    configurable: true,
  },
  {
    id: "dsh",
    label: "DSH (DeepSeek Harness)",
    discovery: {
      cli: ["dsh"],
      acpArgs: ["--profile", "{dshProfile}"],
    },
    launch: {
      envConfig: {
        DSH_HOME: "dshHome",
        DSH_PROVIDER: "dshProvider",
        DSH_MODEL: "dshModel",
      },
    },
    commandConfig: "dshBin",
    commandEnv: "ABSENCE_DSH_BIN",
    auth: "none",
    capabilities: "ACP automation profile · permission requests",
    note: "dsh --profile acp · also filled from a saved path / the DSH Desktop install",
    configurable: true,
    requires: ["dsh"],
  },
  {
    id: "claude-code",
    label: "Claude Code",
    acp: "claude-code-acp",
    discovery: {
      cli: ["claude"],
      acpBins: ["claude-code-acp"],
      acpPackages: ["@zed-industries/claude-code-acp"],
      acpEntry: "dist/index.js",
      npxPackage: "@zed-industries/claude-code-acp",
    },
    inspect: {
      dirEnv: "CLAUDE_CONFIG_DIR",
      dirs: ["~/.claude"],
      format: "settings-json",
      modelFiles: ["settings.json"],
      authFiles: ["settings.json"],
      credentialEnvKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    },
    launch: { envFrom: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] },
    requires: ["claude"],
    commandEnv: "ABSENCE_CLAUDE_ACP_BIN",
    auth: "optional",
    capabilities: "ACP adapter · permission requests",
    note: "ACP adapter: @zed-industries/claude-code-acp",
    configurable: true,
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    discovery: {
      cli: ["qwen"],
      acpArgs: ["--experimental-acp"],
    },
    launch: { envFrom: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"] },
    requires: ["qwen"],
    commandEnv: "ABSENCE_QWEN_ACP_BIN",
    auth: "optional",
    capabilities: "ACP mode · permission requests",
    note: "ACP mode: qwen --experimental-acp",
    configurable: true,
  },
  {
    id: "gemini",
    label: "Gemini",
    aliases: ["gemini-cli"],
    discovery: {
      cli: ["gemini"],
      acpArgs: ["--acp"],
    },
    requires: ["gemini"],
    commandEnv: "ABSENCE_GEMINI_ACP_BIN",
    auth: "optional",
    capabilities: "ACP mode · permission requests",
    note: "ACP mode: gemini --acp (older builds use --experimental-acp)",
    configurable: true,
  },
];

/**
 * Materialise the shipped data into profiles: env forwarding and the dsh
 * profile interpolation happen here, never at a call site. The command itself
 * is intentionally left empty — `AgentCatalog.ts` fills it from what is
 * installed on this machine.
 */
export function builtinProfiles(): AgentProfile[] {
  return builtinProfileData.map((data) => {
    const env: Record<string, string> = { ...(data.launch.env ?? {}) };
    for (const [name, field] of Object.entries(data.launch.envConfig ?? {})) {
      const value = config[field];
      if (typeof value === "string" && value.length > 0) env[name] = value;
    }
    for (const name of data.launch.envFrom ?? []) {
      const value = process.env[name];
      if (typeof value === "string" && value.length > 0) env[name] = value;
    }
    const discovery = data.discovery
      ? {
          ...data.discovery,
          ...(data.discovery.acpArgs
            ? {
                acpArgs: data.discovery.acpArgs.map((arg) =>
                  arg.replaceAll("{dshProfile}", config.dshProfile),
                ),
              }
            : {}),
        }
      : undefined;
    const configuredCommand = data.commandConfig ? config[data.commandConfig] : undefined;
    const profile: AgentProfile = {
      id: data.id,
      label: data.label,
      source: "builtin",
      launch: {
        command: typeof configuredCommand === "string" ? configuredCommand : "",
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
      ...(data.note !== undefined ? { note: data.note } : {}),
      ...(data.aliases !== undefined ? { aliases: data.aliases } : {}),
      ...(data.acp !== undefined ? { acp: data.acp } : {}),
      ...(data.requires ?? discovery?.cli
        ? { requires: data.requires ?? discovery?.cli }
        : {}),
      ...(data.auth !== undefined ? { auth: data.auth } : {}),
      ...(data.capabilities !== undefined ? { capabilities: data.capabilities } : {}),
      ...(data.configurable !== undefined ? { configurable: data.configurable } : {}),
      ...(data.commandEnv !== undefined ? { commandEnv: data.commandEnv } : {}),
      ...(data.discoverCapabilities !== undefined
        ? { discoverCapabilities: data.discoverCapabilities }
        : {}),
      ...(discovery !== undefined ? { discovery } : {}),
      ...(data.inspect !== undefined ? { inspect: data.inspect } : {}),
    };
    return profile;
  });
}

/**
 * The scripted ACP agent used by `npm run check:acp`. It speaks the real
 * protocol, launches real shell children, and needs no model — which is what
 * makes it possible to exercise Claude Code / Qwen Code event shapes on a
 * machine that cannot run those models.
 */
export function fixtureProfile(scenarioPath: string, id = "acp-fixture"): AgentProfile {
  return {
    id,
    label: `ACP fixture (${id})`,
    source: "fixture",
    launch: {
      command: process.execPath,
      args: [fixtureScriptPath()],
      env: { ABSENCE_FIXTURE_SCENARIO: scenarioPath },
    },
    note: "scripted ACP agent — protocol-accurate, no model",
  };
}

/** `scripts/acp-fixture/fake-agent.mjs`, resolved from this file. */
export function fixtureScriptPath(): string {
  return new URL("../../../../../scripts/acp-fixture/fake-agent.mjs", import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );
}
