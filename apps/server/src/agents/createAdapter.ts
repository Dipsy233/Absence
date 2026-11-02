import type { AdapterOptions, AgentAdapter } from "./AgentAdapter";
import type { AgentKind } from "../config";
import { MockAdapter } from "./MockAdapter";
import { AcpAdapter } from "./acp/AcpAdapter";
import { getProfile } from "./acp/AgentCatalog";
import { buildAdapter, registerAdapter } from "./registry";

/**
 * The shipped runtimes.
 *
 * There is one driving path: an ACP entry Absence found on this machine (or one
 * the user configured) plus the generic `AcpAdapter` (protocol). The only non-
 * ACP registration is the scripted fixture used by development and the offline
 * checks; it is not a product runtime.
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
 * A row that is not `ready` throws the catalog's own reason — `needs-adapter`,
 * `needs-auth` or `unavailable` — never a silent npx download or a mock fallback.
 */
export function createAdapter(kind: AgentKind, options: AdapterOptions): AgentAdapter {
  const profile = getProfile(kind);
  if (profile) {
    if (profile.state === "ready") return new AcpAdapter(profile, options);
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

/** Say which profile, which state, and how to fix it — no silent fallback. */
function unavailableMessage(profile: {
  id: string;
  label: string;
  state: string;
  stateReason: string;
  installHint?: string;
}): string {
  return (
    `Runtime "${profile.id}" (${profile.label}) is not startable (${profile.state}): ` +
    profile.stateReason +
    (profile.installHint ? ` ${profile.installHint}` : "")
  );
}
