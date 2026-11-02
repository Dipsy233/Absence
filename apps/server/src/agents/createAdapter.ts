import type { AdapterOptions, AgentAdapter } from "./AgentAdapter";
import type { AgentKind } from "../config";
import { MockAdapter } from "./MockAdapter";
import { PiAdapter } from "./PiAdapter";
import { CodexAdapter } from "./CodexAdapter";
import { DshAdapter } from "./DshAdapter";
import { AcpAdapter } from "./acp/AcpAdapter";
import { commandAvailable, getProfile, launchLine, missingProfileCommands } from "./acp/AgentCatalog";
import type { AgentProfile } from "./acp/profiles";
import { buildAdapter, registerAdapter } from "./registry";

/**
 * The shipped runtimes.
 *
 * Pi and Codex used to be privileged native adapters. They are ACP profiles
 * now (agents/acp/profiles.ts); their old adapters exist only behind
 * `ABSENCE_LEGACY_NATIVE_ADAPTERS=1` so the migration can be compared against
 * the native path on a real machine.
 *
 * @deprecated P5 deletes these three registrations and the adapter classes
 * behind them. They are reachable only through the explicit legacy switch
 * below; the default path is the generic `AcpAdapter` plus a data profile.
 */
registerAdapter("pi", (options: AdapterOptions) => new PiAdapter(options));
registerAdapter("codex", (options: AdapterOptions) => new CodexAdapter(options));
registerAdapter("mock", (options: AdapterOptions) => new MockAdapter(options));

/**
 * @deprecated P5 deletes the DSH-specific adapter and `ABSENCE_LEGACY_DSH`.
 * The shipped `dsh` profile drives the same binary through ACP.
 */
if (process.env.ABSENCE_LEGACY_DSH === "1") {
  registerAdapter("dsh", (options: AdapterOptions) => new DshAdapter(options));
}

/**
 * The explicit escape hatch for the migration.
 *
 * Default is ACP. Setting this to `1` makes the registry (the old native
 * adapters) win for any kind it knows, which is how P4's event quality can be
 * compared against P5's deletion candidates. It is one variable, not a code
 * branch, and it disappears in P5.
 *
 * @deprecated P5 removes this switch together with the native adapters.
 */
const LEGACY_NATIVE_ENV = "ABSENCE_LEGACY_NATIVE_ADAPTERS";

function legacyNativeEnabled(): boolean {
  return process.env[LEGACY_NATIVE_ENV] === "1";
}

/**
 * Build the adapter for a runtime kind.
 *
 * Resolution is a catalog lookup, not a product-name switch:
 *   1. explicit legacy switch → an adapter registered by `agents/registry`
 *   2. any ACP profile, by id or alias (`pi`, `pi-acp`, `codex`, …)
 *   3. a non-ACP adapter registered by a host/fixture (`mock`)
 *
 * A profile is resolved per session, so a launch-command fix saved in the
 * picker or an entry in ~/.absence/agents.json takes effect without a restart.
 *
 * Throws a readable error when neither exists, and when the ACP profile exists
 * but its launch command is not installed — never a silent fall back to mock.
 */
export function createAdapter(kind: AgentKind, options: AdapterOptions): AgentAdapter {
  if (legacyNativeEnabled()) {
    const legacy = buildAdapter(kind, options);
    if (legacy) return legacy;
  }

  const profile = getProfile(kind);
  if (profile) {
    if (commandAvailable(profile.launch.command)) return new AcpAdapter(profile, options);
    throw new Error(unavailableMessage(profile));
  }

  const adapter = buildAdapter(kind, options);
  if (adapter) return adapter;

  throw new Error(
    `No ACP profile or registered adapter for runtime "${kind}". ` +
      `Add an entry to ~/.absence/agents.json or install a shipped profile — ` +
      `see docs/decoupling.md.`,
  );
}

/** Say which profile, which command, and how to fix it — no silent fallback. */
function unavailableMessage(profile: AgentProfile): string {
  const missing = missingProfileCommands(profile);
  const hint = profile.commandEnv
    ? `set ${profile.commandEnv}, or edit the launch command in the picker`
    : "edit the launch command in the picker";
  return (
    `Runtime "${profile.id}" (${profile.label}) cannot start: ` +
    `${missing.length > 0 ? missing.join(", ") : profile.launch.command} ` +
    `not found on PATH. Launch line is "${launchLine(profile)}"; ${hint}.` +
    (profile.note ? ` ${profile.note}` : "")
  );
}
