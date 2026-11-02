/**
 * The JSON-RPC 2.0 wire shapes ACP is built on.
 *
 * Kept separate from the transport and from `AcpConnection` so a future proxy
 * can reuse the same message model on either side of the pipe: the transport
 * only moves messages, it never interprets ACP semantics.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorBody {
  code: unknown;
  message?: unknown;
  data?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse one stdout line. Anything that is not a JSON object with JSON-RPC
 * shape returns `undefined`: agent diagnostics, startup banners and structured
 * log lines must never be mistaken for protocol traffic.
 *
 * `jsonrpc: "2.0"` is accepted but not required, because a few adapters omit it.
 * The shape (method vs. id+result/error) is what decides the message kind.
 */
export function parseJsonRpcMessage(line: string): JsonRpcMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if ("jsonrpc" in value && value.jsonrpc !== "2.0") return undefined;

  if (typeof value.method === "string") {
    if (isJsonRpcId(value.id)) {
      return {
        jsonrpc: "2.0",
        id: value.id,
        method: value.method,
        ...("params" in value ? { params: value.params } : {}),
      };
    }
    return {
      jsonrpc: "2.0",
      method: value.method,
      ...("params" in value ? { params: value.params } : {}),
    };
  }

  if (isJsonRpcId(value.id) && ("result" in value || isRecord(value.error))) {
    if (isRecord(value.error)) {
      return { jsonrpc: "2.0", id: value.id, error: value.error as unknown as JsonRpcErrorBody };
    }
    return { jsonrpc: "2.0", id: value.id, result: value.result };
  }

  return undefined;
}
