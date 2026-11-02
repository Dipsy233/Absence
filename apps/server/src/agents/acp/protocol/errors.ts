/**
 * Error taxonomy for the ACP transport.
 *
 * The JSON-RPC numeric codes are part of the contract: an agent (and a future
 * proxy) can distinguish "method not supported" from "the request was
 * cancelled" without parsing English text.
 */

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INTERNAL_ERROR = -32603;
export const JSON_RPC_REQUEST_CANCELLED = -32800;

/** A JSON-RPC error returned by the agent, with the method that caused it. */
export class AcpRpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

/**
 * Every in-flight request is settled with this when the connection is closed,
 * the agent exits, or the handshake fails. `code === -32800` is the cancellation
 * class, so callers can recognise a teardown rather than a real agent failure.
 */
export class AcpRequestCancelledError extends AcpRpcError {
  constructor(method = "", reason = "acp connection closed") {
    super(method, `ACP request cancelled: ${reason}`, JSON_RPC_REQUEST_CANCELLED);
    this.name = "AcpRequestCancelledError";
  }
}

/** A session method was blocked because the agent never declared the capability. */
export class AcpUnsupportedCapabilityError extends Error {
  constructor(
    readonly capability: string,
    message: string,
  ) {
    super(message);
    this.name = "AcpUnsupportedCapabilityError";
  }
}

export function isRequestCancelled(error: unknown): error is AcpRequestCancelledError {
  return error instanceof AcpRequestCancelledError;
}

/**
 * Describe a JSON-RPC error without throwing away what the provider said.
 *
 * ACP agents commonly send `{ code: -32603, message: "Internal error",
 * data: { message: "maximum context length 8192 …" } }`. Keeping only the
 * top-level message turns every provider failure into the same useless word.
 * `error.data.message` / `error.data.error` / a string detail are appended
 * verbatim, and the code is kept so callers can still distinguish classes.
 */
export function describeAcpError(error: unknown): string {
  if (!(error instanceof AcpRpcError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const parts = [error.message];
  const detail = rpcDetail(error.data);
  if (detail && detail !== error.message) parts.push(detail);
  const code = error.code !== undefined ? ` (code ${error.code})` : "";
  return `${parts.join(": ")}${code}`;
}

function rpcDetail(data: unknown): string | undefined {
  if (typeof data === "string") return data.trim() || undefined;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ["message", "detail", "error", "reason"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
    if (value !== null && typeof value === "object") {
      const nested = rpcDetail(value);
      if (nested) return nested;
    }
  }
  try {
    return JSON.stringify(data);
  } catch {
    return undefined;
  }
}
