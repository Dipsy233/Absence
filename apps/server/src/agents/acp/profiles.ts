import { config } from "../../config";

/**
 * What it takes to start an agent — data, not code.
 *
 * Every ACP agent is the same shape from Absence's side: a command, its
 * arguments, and some environment. A new agent is therefore a new entry here
 * (or an entry in ~/.absence/agents.json), never a new adapter class. Compare
 * PiAdapter / CodexAdapter / DshAdapter, each of which had to be written by
 * reading that product's private implementation.
 *
 * This file is the one place launch commands live. Versions are data too: each
 * package entry can be pinned with an env var (`versionEnv`) without touching
 * code in a second place.
 */
export interface AgentLaunch {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** How sign-in shows up: the UI hints, the agent decides. */
export type AgentAuthMode = "none" | "optional" | "required";

export interface AgentProfile {
  /** The runtime kind Absence stores in a session (`claude-code`, `qwen-code`, …). */
  id: string;
  label: string;
  launch: AgentLaunch;
  /** Where this profile came from, so the picker can say so honestly. */
  source: "builtin" | "custom" | "registry" | "fixture";
  /**
   * A short note shown in the picker. Used for "launch command not verified
   * against the vendor's current package name" rather than silently pretending.
   */
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
   * Executables that must resolve for this profile to work, in addition to
   * `launch.command`. Used by the picker to show an unavailable runtime before
   * it is opened, and by the launch error when the command itself is missing.
   */
  requires?: string[];
  /**
   * Whether the agent refuses `session/new` until `authenticate` succeeds. This
   * is a hint for the picker; Absence never reads or guesses credentials.
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
}

/* ══════════════════════════════════════════════════════════════════════════
   The shipped profile data. Everything below is the one place a launch
   command, package version or prerequisite is written down.
   ══════════════════════════════════════════════════════════════════════════ */

type ConfigBackedField = "dshBin" | "dshHome" | "dshProvider" | "dshModel" | "dshProfile";

interface ProfileLaunchData {
  command: string;
  commandEnv?: string;
  /** Use this config field instead of `command` when it is set. */
  commandConfig?: ConfigBackedField;
  args?: string[];
  /** Values forwarded from the host process's own environment. */
  envFrom?: string[];
  /** Literal values written into the child's environment. */
  env?: Record<string, string>;
  /** Env values taken from config (never invented). */
  envConfig?: Record<string, ConfigBackedField>;
  /** `{version}` in args resolves to this. */
  version?: string;
  versionEnv?: string;
}

interface ProfileData extends Omit<AgentProfile, "source" | "launch"> {
  launch: ProfileLaunchData;
}

/**
 * Filled from the real-hardware verification (pi-acp 0.0.34,
 * @zed-industries/codex-acp 0.16.0). Versions are overridable without a code
 * change through the matching `versionEnv`.
 */
export const builtinProfileData: readonly ProfileData[] = [
  {
    id: "pi",
    label: "Pi",
    acp: "pi-acp",
    aliases: ["pi-acp"],
    launch: {
      command: "npx",
      commandEnv: "ABSENCE_PI_ACP_BIN",
      args: ["-y", "pi-acp@{version}"],
      version: "0.0.34",
      versionEnv: "ABSENCE_PI_ACP_VERSION",
      env: { PI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" },
    },
    requires: ["node", "npx", "pi"],
    auth: "none",
    capabilities: "loadSession · embedded context · no permission prompts",
    note:
      "pi-acp via npx · needs Node ≥20 and the pi CLI (≥0.81) on PATH · " +
      "session/new requires an absolute cwd",
    configurable: true,
  },
  {
    id: "codex",
    label: "Codex",
    acp: "codex-acp",
    aliases: ["codex-acp"],
    launch: {
      command: "npx",
      commandEnv: "ABSENCE_CODEX_ACP_BIN",
      args: ["-y", "@zed-industries/codex-acp@{version}"],
      version: "0.16.0",
      versionEnv: "ABSENCE_CODEX_ACP_VERSION",
    },
    requires: ["node", "npx"],
    auth: "required",
    capabilities:
      "plan · modes read-only/auto/full-access · slash commands · loadSession · embedded context",
    note:
      "@zed-industries/codex-acp · session/new answers “Authentication required” " +
      "until the agent's own authenticate method succeeds · pin 0.15.0 with " +
      "ABSENCE_CODEX_ACP_VERSION if your registry mirror lacks 0.16.0",
    configurable: true,
  },
  {
    id: "codex-acp-alt",
    label: "Codex (ACP, alternative)",
    acp: "codex-acp",
    launch: {
      command: "npx",
      commandEnv: "ABSENCE_CODEX_ACP_ALT_BIN",
      args: ["-y", "codex-acp@{version}"],
      version: "1.11.0",
      versionEnv: "ABSENCE_CODEX_ACP_ALT_VERSION",
    },
    requires: ["node", "npx"],
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
    launch: {
      command: "dsh",
      commandConfig: "dshBin",
      commandEnv: "ABSENCE_DSH_BIN",
      args: ["--profile", "{dshProfile}"],
      envConfig: {
        DSH_HOME: "dshHome",
        DSH_PROVIDER: "dshProvider",
        DSH_MODEL: "dshModel",
      },
    },
    auth: "none",
    capabilities: "ACP automation profile · permission requests",
    note: "dsh --profile acp · also filled from a saved path / the DSH Desktop install",
    configurable: true,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    acp: "claude-code-acp",
    launch: {
      command: "npx",
      commandEnv: "ABSENCE_CLAUDE_ACP_BIN",
      args: ["-y", "@zed-industries/claude-code-acp"],
      envFrom: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
    },
    requires: ["node", "npx"],
    auth: "optional",
    capabilities: "ACP adapter · permission requests",
    note: "ACP adapter: @zed-industries/claude-code-acp",
    configurable: true,
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    launch: {
      command: "qwen",
      commandEnv: "ABSENCE_QWEN_ACP_BIN",
      args: ["--experimental-acp"],
      envFrom: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"],
    },
    auth: "optional",
    capabilities: "ACP mode · permission requests",
    note: "ACP mode: qwen --experimental-acp",
    configurable: true,
  },
];

/**
 * Materialise the shipped data into profiles: env forwarding and version
 * interpolation happen here, never at a call site.
 */
export function builtinProfiles(): AgentProfile[] {
  return builtinProfileData.map((data) => {
    const version = (data.launch.versionEnv && process.env[data.launch.versionEnv]) ?? data.launch.version;
    const command =
      (data.launch.commandEnv && process.env[data.launch.commandEnv]) ||
      (data.launch.commandConfig ? config[data.launch.commandConfig] : undefined) ||
      data.launch.command;
    const env: Record<string, string> = { ...(data.launch.env ?? {}) };
    for (const [name, field] of Object.entries(data.launch.envConfig ?? {})) {
      const value = config[field];
      if (typeof value === "string" && value.length > 0) env[name] = value;
    }
    for (const name of data.launch.envFrom ?? []) {
      const value = process.env[name];
      if (typeof value === "string" && value.length > 0) env[name] = value;
    }
    const args = (data.launch.args ?? [])
      .map((arg) =>
        arg
          .replaceAll("{version}", version ?? "")
          .replaceAll("{dshProfile}", config.dshProfile),
      )
      .filter((arg) => arg.length > 0);
    return {
      ...data,
      source: "builtin" as const,
      launch: {
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
      ...(data.note && version ? { note: data.note.replaceAll("{version}", version) } : {}),
    };
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
