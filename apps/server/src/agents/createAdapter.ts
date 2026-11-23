import type { AdapterOptions, AgentAdapter } from "./AgentAdapter";
import type { AgentKind } from "../config";
import { MockAdapter } from "./MockAdapter";
import { buildAdapter, registerAdapter } from "./registry";

/**
 * The shipped runtimes.
 *
 * Absence drives no agent. The only registered *driving* runtime is the
 * scripted fixture used by development and the offline checks — it is not a
 * product runtime, and no product UI reaches it. Every real agent is observed
 * instead: a transcript tail (observe/) or an ACP proxy spawn (acp/proxy/),
 * both feeding the same read-only event pipeline.
 */
registerAdapter("mock", (options: AdapterOptions) => new MockAdapter(options));

/**
 * Build the adapter for a runtime kind.
 *
 * Only the fixture registry can answer. Any other kind is not drivable — that
 * is the whole point: there is no spawn path, no prompt client and no
 * permission answer for a real agent. Callers that want an agent's facts use
 * the observation channels, not this factory.
 */
export function createAdapter(kind: AgentKind, options: AdapterOptions): AgentAdapter {
  const adapter = buildAdapter(kind, options);
  if (adapter) return adapter;
  throw new Error(
    `Runtime "${kind}" cannot be driven — Absence only observes agents ` +
      `(transcript tails and the ACP proxy; see docs/observation.md). ` +
      `The "mock" fixture is the sole driving runtime, for development and checks.`,
  );
}
