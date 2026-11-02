import type { AdapterOptions, AgentAdapter } from "./AgentAdapter";
import type { AgentKind } from "../config";
import { MockAdapter } from "./MockAdapter";
import { AcpAdapter } from "./acp/AcpAdapter";
import { commandAvailable, getProfile, launchLine, missingProfileCommands } from "./acp/AgentCatalog";
import type { AgentProfile } from "./acp/profiles";
import { buildAdapter, registerAdapter } from "./registry";

/**
 * The shipped runtimes.
 *
 * There is one driving path: an ACP profile (data) plus the generic
 * `AcpAdapter` (protocol). The only non-ACP registration is the scripted
 * fixture used by development and the offline checks; it is not a product
 * runtime.
 */
registerAdapter("mock", (options: AdapterOptions) => new MockAdapter(options));

/**
 * Build the adapter for a runtime kind.
 *
 * Resolution is a catalog lookup, not a product-name switch:
 *   1. any ACP profile, by id or alias (`pi-acp`, `codex-acp`, …)
 *   2. a non-ACP adapter registered by a host/fixture (`mock`)
 *
 * A profile is resolved per session, so a launch-command fix saved in the
 * picker or an entry in ~/.absence/agents.json takes effect without a restart.
 *
 * Throws a readable error when neither exists, and when the ACP profile exists
 * but its launch command is not installed — never a silent fall back to mock.
 */
export function createAdapter(kind: AgentKind, options: AdapterOptions): AgentAdapter {
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
