/**
 * Reading an MCP proxy's log back into events.
 *
 * The shim (bin/absence-mcp-shim.mjs) sits between an agent and an MCP server
 * and records every JSON-RPC message in both directions, as JSON lines. This
 * turns that stream into `mcp` events.
 *
 * Why the pair matters
 * --------------------
 * A `tools/call` is a request and a `tools/call` result is a *response* keyed by
 * `id` — they are separate lines, possibly far apart, and possibly interleaved
 * with other calls. One event needs both (the arguments and what came back), so
 * a call is held open until its response arrives.
 *
 * This is the reader, not the parser of any agent's format: MCP is a published
 * protocol, so `tools/call` / `id` / `result` are the spec's field names, not
 * one implementation's naming choice.
 */

/** One line the shim wrote. */
export interface ShimRecord {
  ts: number;
  dir: "client-to-server" | "server-to-client";
  session?: string;
  pid?: number;
  text: string;
}

/** A completed MCP call, ready to become an `mcp` event. */
export interface McpCall {
  id: string;
  /** The tool name the model used (`mcp__<server>__<tool>` or the bare tool). */
  toolName: string;
  /** The server, when the tool name encodes it. */
  server: string;
  tool: string;
  args: string;
  result: string;
  isError: boolean;
  durationMs?: number;
}

interface Pending {
  id: string;
  toolName: string;
  server: string;
  tool: string;
  args: string;
  startedAt: number;
}

/**
 * Split `mcp__<server>__<tool>` into its parts.
 *
 * A proxy sees the tool name the *client* used, which for a deferred/direct MCP
 * tool is `mcp__<server>__<tool>`. Anything else (a bare `observe`) is kept
 * whole as the tool name, with the server unknown.
 */
function splitToolName(name: string): { server: string; tool: string } {
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const cut = rest.indexOf("__");
    if (cut > 0) return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
  }
  return { server: "", tool: name };
}

/** Format what the server returned as text, the way the model saw it. */
function formatResult(result: unknown): { text: string; isError: boolean; structured?: string } {
  if (result === null || result === undefined) return { text: "", isError: false };
  const obj = result as {
    content?: { type?: string; text?: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  const isError = obj.isError === true;
  if (Array.isArray(obj.content)) {
    const text = obj.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join(String.fromCharCode(10));
    const structured =
      obj.structuredContent === undefined ? undefined : safeJson(obj.structuredContent);
    return { text, isError, structured };
  }
  // A server that answers with a bare value (not the MCP content shape): show
  // it rather than nothing.
  const structured = safeJson(result);
  return { text: structured ?? "", isError };
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, undefined, 2);
  } catch {
    return undefined;
  }
}

/**
 * Feed records in, get completed calls out.
 *
 * Stateful by design: requests and responses are matched across lines, and the
 * reader survives a truncated log (a shim killed mid-write leaves a partial
 * line) by ignoring what it cannot parse.
 */
export class McpLogReader {
  private readonly pending = new Map<string, Pending>();

  /**
   * One record. Returns the call it completed, or undefined.
   *
   * A request opens a call; the matching response closes it. Anything that is
   * neither (initialize, notifications, tools/list) is ignored — this reports
   * what the agent *did*, not the handshake that made it possible.
   */
  push(record: ShimRecord): McpCall | undefined {
    let message: {
      id?: string | number;
      method?: string;
      params?: { name?: string; arguments?: unknown };
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(record.text) as typeof message;
    } catch {
      return undefined;
    }
    if (message === null || typeof message !== "object") return undefined;

    if (record.dir === "client-to-server" && message.method === "tools/call") {
      const rawName = message.params?.name ?? "";
      const { server, tool } = splitToolName(rawName);
      const id = String(message.id ?? `${record.ts}`);
      this.pending.set(id, {
        id,
        toolName: rawName,
        server,
        tool,
        args: safeJson(message.params?.arguments ?? {}) ?? "{}",
        startedAt: record.ts,
      });
      return undefined;
    }

    if (record.dir !== "server-to-client") return undefined;
    const id = message.id === undefined ? undefined : String(message.id);
    if (id === undefined) return undefined;
    const open = this.pending.get(id);
    if (!open) return undefined;
    this.pending.delete(id);

    // A JSON-RPC error and an MCP `isError` result are both failures; a watcher
    // should not have to know which one it is looking at.
    if (message.error) {
      return {
        id: open.id,
        toolName: open.toolName,
        server: open.server,
        tool: open.tool,
        args: open.args,
        result: message.error.message ?? "error",
        isError: true,
        durationMs: record.ts - open.startedAt,
      };
    }
    const formatted = formatResult(message.result);
    return {
      id: open.id,
      toolName: open.toolName,
      server: open.server,
      tool: open.tool,
      args: open.args,
      result: formatted.text,
      isError: formatted.isError,
      durationMs: record.ts - open.startedAt,
    };
  }

  /** Calls still waiting for a response, e.g. when the shim went away. */
  get openCalls(): Pending[] {
    return [...this.pending.values()];
  }
}
