import type { AdapterOptions, AgentAdapter } from "./AgentAdapter";
import type { AgentKind } from "../config";
import { MockAdapter } from "./MockAdapter";
import { PiAdapter } from "./PiAdapter";
import { CodexAdapter } from "./CodexAdapter";
import { DshAdapter } from "./DshAdapter";
import { AcpAdapter } from "./acp/AcpAdapter";
import { getProfile } from "./acp/AgentCatalog";
import { buildAdapter, registerAdapter } from "./registry";

/**
 * The shipped runtimes.
 *
 * Pi and Codex still have their own adapters (they predate the ACP refactor and
 * implement a protocol Absence reads directly). Every ACP agent — DSH, Claude
 * Code, Qwen Code, codex-acp, pi-acp, or an entry in ~/.absence/agents.json —
 * is driven by the *same* `AcpAdapter`, with only a launch profile differing.
 * That is the whole decoupling: `registerAdapter` is the only door for a
 * protocol-specific adapter, and a new ACP agent adds a data entry, not a class.
 * See docs/decoupling.md.
 */
registerAdapter("pi", (options: AdapterOptions) => new PiAdapter(options));
registerAdapter("codex", (options: AdapterOptions) => new CodexAdapter(options));
registerAdapter("mock", (options: AdapterOptions) => new MockAdapter(options));

// Legacy escape hatch: the DSH-specific adapter is still available for one
// release, in case a real DSH install regresses against the generic path.
if (process.env.ABSENCE_LEGACY_DSH === "1") {
  registerAdapter("dsh", (options: AdapterOptions) => new DshAdapter(options));
}

/**
 * Build the adapter for a runtime kind.
 *
 * ACP profiles are resolved *here*, at session start, rather than registered
 * once at import time. That matters: `~/.absence/agents.json` and a runtime
 * path saved from the picker are read per session, so adding a profile or
 * fixing a binary does not require a restart. It also keeps `pi` / `codex`
 * from being shadowed by a profile that happens to reuse their id.
 *
 * Throws only when neither an adapter nor a profile exists — the caller
 * (AbsenceSession) turns that into a clear "cannot drive this runtime" error
 * rather than a crash.
 */
export function createAdapter(kind: AgentKind, options: AdapterOptions): AgentAdapter {
  const adapter = buildAdapter(kind, options);
  if (adapter) return adapter;

  const profile = getProfile(kind);
  if (profile) return new AcpAdapter(profile, options);

  throw new Error(
    `No adapter is registered for runtime "${kind}". It can still be observed — see docs/decoupling.md.`,
  );
}
