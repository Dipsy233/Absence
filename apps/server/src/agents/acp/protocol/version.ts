/**
 * ACP protocol-version negotiation.
 *
 * Absence sends its version in `initialize`. The agent answers with the version
 * it will actually speak; if that is not in the supported set the transport
 * MUST close the connection rather than guess, because every later frame is
 * interpreted against the agreed version.
 */

/** The version Absence implements. ACP currently defines version 1. */
export const ACP_PROTOCOL_VERSION = 1;

/** Versions this client can speak. Add entries only with matching handlers. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [ACP_PROTOCOL_VERSION];

export class AcpProtocolVersionError extends Error {
  constructor(
    readonly agentVersion: number | undefined,
    readonly supported: readonly number[],
  ) {
    const rendered = agentVersion === undefined ? "missing" : String(agentVersion);
    super(
      `ACP protocol version negotiation failed: the agent returned ${rendered}, ` +
        `but Absence supports ${supported.join(", ")}. The connection was closed.`,
    );
    this.name = "AcpProtocolVersionError";
  }
}

/**
 * Accept the version the agent returned. A missing or non-integer version is
 * just as fatal as an unsupported one: the handshake is not complete without it.
 */
export function negotiateProtocolVersion(agentVersion: unknown): number {
  const version =
    typeof agentVersion === "number" && Number.isInteger(agentVersion) ? agentVersion : undefined;
  if (version === undefined || !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    throw new AcpProtocolVersionError(version, SUPPORTED_PROTOCOL_VERSIONS);
  }
  return version;
}
