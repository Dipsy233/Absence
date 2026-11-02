/**
 * Normalise the `initialize` payload into the two capability groups Absence
 * actually queries.
 *
 * ACP is explicit about *not* invoking a session method the agent did not
 * declare, so the raw booleans/objects are flattened here once and every call
 * site asks this view instead of poking at `agentCapabilities` itself.
 */

import type { AcpInitializeResult } from "./types";

export interface AcpSessionCapabilities {
  /** `session/new` is part of the base protocol, always available. */
  readonly newSession: boolean;
  readonly load: boolean;
  readonly resume: boolean;
  readonly close: boolean;
  readonly list: boolean;
}

export interface AcpCapabilities {
  readonly protocolVersion: number;
  /** The agent's raw capability object, kept for future, agent-specific probes. */
  readonly agent: Readonly<Record<string, unknown>>;
  readonly session: AcpSessionCapabilities;
  readonly authMethods: readonly unknown[];
}

/**
 * ACP marks most capabilities with an empty object (`resume: {}`) rather than
 * a boolean; `true` is accepted too, `false`/absent means "not offered".
 */
function offered(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  return true;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeCapabilities(
  result: AcpInitializeResult,
  protocolVersion: number,
): AcpCapabilities {
  const agent = record(result.agentCapabilities);
  // Some adapters put session capabilities at the top level; merge both, with
  // the spec-compliant nested copy winning on conflicts.
  const session = { ...record(result.sessionCapabilities), ...record(agent.sessionCapabilities) };

  return {
    protocolVersion,
    agent,
    session: {
      newSession: true,
      load: offered(session.load) || offered(session.loadSession) || offered(agent.loadSession),
      resume: offered(session.resume) || offered(agent.resumeSession),
      close: offered(session.close),
      list: offered(session.list),
    },
    authMethods: Array.isArray(result.authMethods) ? result.authMethods : [],
  };
}

export type AcpSessionMethod = "session/load" | "session/resume" | "session/close";

/** Map a session method to the capability that gates it. */
export function sessionCapabilityFor(
  method: AcpSessionMethod,
): keyof AcpSessionCapabilities {
  switch (method) {
    case "session/load":
      return "load";
    case "session/resume":
      return "resume";
    case "session/close":
      return "close";
  }
}

export function canCallSessionMethod(
  capabilities: AcpCapabilities | undefined,
  method: AcpSessionMethod,
): boolean {
  if (!capabilities) return false;
  return capabilities.session[sessionCapabilityFor(method)];
}
