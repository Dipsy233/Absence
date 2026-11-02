import { config } from "../../config";

/**
 * What it takes to start an agent — data, not code.
 *
 * Every ACP agent is the same shape from Absence's side: a command, its
 * arguments, and some environment. A new agent is therefore a new entry here
 * (or an entry in ~/.absence/agents.json), never a new adapter class. Compare
 * PiAdapter / CodexAdapter / DshAdapter, each of which had to be written by
 * reading that product's private implementation.
 */
export interface AgentLaunch {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

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
   * Ask Absence's shared, cross-runtime discovery for the skills/MCP panel.
   * ACP itself carries no catalog request, so this is opt-in: a profile that
   * does not set it gets no panel rather than a list of another runtime's
   * servers. It is a data policy, not a product branch.
   */
  discoverCapabilities?: boolean;
}

/**
 * Shipped profiles.
 *
 * Codex and Pi are the two entries the ACP registry lists (`codex-acp`,
 * `pi-acp`); Claude Code and Qwen Code expose ACP through their own adapters.
 * The launch commands below are the defaults — every one of them can be
 * overridden with an environment variable or an entry in
 * ~/.absence/agents.json, which is the point: Absence does not need a code
 * change when a vendor renames a package.
 */
export function builtinProfiles(): AgentProfile[] {
  return [
    {
      id: "dsh",
      label: "DSH (DeepSeek Harness)",
      source: "builtin",
      launch: {
        // `config.dshBin` is also filled from a saved path / the DSH Desktop
        // install at startup (see runtimes/config.ts applyRuntimePaths).
        command: config.dshBin ?? "dsh",
        args: ["--profile", config.dshProfile],
        env: {
          ...(config.dshHome ? { DSH_HOME: config.dshHome } : {}),
          ...(config.dshProvider ? { DSH_PROVIDER: config.dshProvider } : {}),
          ...(config.dshModel ? { DSH_MODEL: config.dshModel } : {}),
        },
      },
      // DSH has no ACP catalog request; its skills and MCP servers are read by
      // the shared discovery scan, exactly as the pre-ACP adapter did.
      discoverCapabilities: true,
    },
    {
      id: "claude-code",
      label: "Claude Code",
      source: "builtin",
      launch: {
        command: process.env.ABSENCE_CLAUDE_ACP_BIN ?? "npx",
        args: ["-y", "@zed-industries/claude-code-acp"],
        env: pickEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]),
      },
      note: "ACP adapter: @zed-industries/claude-code-acp (override with ABSENCE_CLAUDE_ACP_BIN)",
    },
    {
      id: "qwen-code",
      label: "Qwen Code",
      source: "builtin",
      launch: {
        command: process.env.ABSENCE_QWEN_ACP_BIN ?? "qwen",
        args: ["--experimental-acp"],
        env: pickEnv(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]),
      },
      note: "ACP mode: qwen --experimental-acp (override with ABSENCE_QWEN_ACP_BIN)",
    },
    {
      id: "codex-acp",
      label: "Codex (ACP)",
      source: "builtin",
      launch: {
        command: process.env.ABSENCE_CODEX_ACP_BIN ?? "npx",
        args: ["-y", "@agentclientprotocol/codex-acp"],
        env: pickEnv(["OPENAI_API_KEY", "OPENAI_BASE_URL"]),
      },
      note: "ACP adapter: @agentclientprotocol/codex-acp (override with ABSENCE_CODEX_ACP_BIN)",
    },
    {
      id: "pi-acp",
      label: "Pi (ACP)",
      source: "builtin",
      launch: {
        command: process.env.ABSENCE_PI_ACP_BIN ?? "npx",
        args: ["-y", "pi-acp"],
      },
      note: "ACP adapter: pi-acp (override with ABSENCE_PI_ACP_BIN)",
    },
  ];
}

/** Only forward credentials the user already exported; never invent them. */
function pickEnv(names: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
