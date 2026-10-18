/**
 * Reading an agent's own session transcript back into events.
 *
 * Why this replaces the MCP proxy
 * -------------------------------
 * An MCP call creates no process and writes no project file: it is a JSON-RPC
 * message written into a pipe that already exists. Measured on a real agent, a
 * whole calculator session produced **zero** process events. The earlier answer
 * was a proxy on the protocol's door (`{command, args}`), but that door only
 * exists for stdio servers, and it has to be bolted into the agent's own config
 * — observing must not rewrite the thing it observes.
 *
 * Both agents already write down every tool call they make, in a file meant to
 * be read back (that is what resume/export/report are built on):
 *
 *   Pi     ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl
 *   Codex  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * One line per record, append-only, no formatting surprises. So the transcript
 * is a *better* observation surface than a proxy: it covers stdio, HTTP and
 * in-process MCP alike (all of them end up as a tool call), it needs no config
 * change, no certificate, and no process to be in the middle.
 *
 * The trade is coupling to a file format rather than to a protocol. That is
 * acceptable because it degrades safely: an unreadable or unfamiliar line is
 * skipped, never fatal. The Stage stays usable with zero semantic events — the
 * invariant `docs/decoupling.md` sets.
 *
 * Two shapes, one output
 * ----------------------
 * Pi writes chat-shaped records (`{role:"toolResult", toolCallId, toolName}`),
 * Codex writes event-shaped ones (`{type:"response_item", payload:{type:"function_call"}}`).
 * Both carry the same three facts — which tool, what arguments, what came back —
 * so both parsers produce the same `SessionToolCall`.
 */

/** Provider whose transcript a file belongs to. */
export type TranscriptAgent = "pi" | "codex";

/** One completed tool call, whichever agent made it. */
export interface SessionToolCall {
  /** The agent's own id for the call, used to pair request and result. */
  id: string;
  /** The tool as the model named it: `mcp__<server>__<tool>` or `bash`. */
  toolName: string;
  /** The MCP server, when the name encodes one. Empty for a built-in tool. */
  server: string;
  /** The bare tool name (`observe`), or the built-in name (`bash`). */
  tool: string;
  /** The arguments as JSON text, when the transcript kept them. */
  args: string;
  /** What came back, as text. */
  result: string;
  /** True when the call failed as the agent saw it. */
  isError: boolean;
  /** Milliseconds between the call and its result, when both are present. */
  durationMs?: number;
}

/** A skill the agent declared it could load, read from its own transcript. */
export interface SessionSkill {
  name: string;
  description: string;
  /** Absolute path to the skill's SKILL.md, when the transcript names one. */
  filePath: string;
}

/** Everything one transcript line can contribute. */
export interface ParsedLine {
  calls?: SessionToolCall[];
  skills?: SessionSkill[];
}

/**
 * Split `mcp__<server>__<tool>` into its parts.
 *
 * A built-in tool (`bash`, `read`) is kept whole with `server` empty: the name
 * is not ours to invent a namespace for.
 */
export function splitToolName(name: string): { server: string; tool: string } {
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const cut = rest.indexOf("__");
    if (cut > 0) return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
    return { server: rest, tool: rest };
  }
  return { server: "", tool: name };
}

/** Flatten the content of a transcript message to plain text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  return "";
}

/** JSON text for an argument blob a transcript already stored as JSON. */
function argsText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Detect which agent wrote a line.
 *
 * Cheap and structural: Codex's records carry a top-level `type` of
 * `response_item` / `event_msg` with a `payload`; Pi's carry a `message`
 * envelope (or, in older builds, the chat record itself at the top level).
 * A line that matches neither is not ours to parse.
 */
export function detectAgent(line: unknown): TranscriptAgent | undefined {
  if (!line || typeof line !== "object") return undefined;
  const record = line as Record<string, unknown>;
  if (record.type === "response_item" || record.type === "event_msg" || record.type === "turn_context") {
    return "codex";
  }
  if (record.message && typeof record.message === "object") return "pi";
  if (typeof record.role === "string") return "pi";
  return undefined;
}

/** Epoch milliseconds from either an ISO timestamp or a numeric one. */
function timeOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/**
 * The Pi transcript, read incrementally.
 *
 * Pi writes a tool call and its result as two separate records sharing
 * `toolCallId`, so a call is held open until the result line arrives — the same
 * pairing the MCP proxy had to do with JSON-RPC ids, for the same reason: one
 * event needs both the arguments and what came back.
 */
export class PiTranscriptReader {
  private readonly pending = new Map<string, { toolName: string; args: string; at: number }>();
  private skillsEmitted = false;

  /** Feed one parsed line; returns whatever it completed. */
  push(line: unknown): ParsedLine {
    if (!line || typeof line !== "object") return {};
    const envelope = line as Record<string, unknown>;
    // Pi wraps each chat record in an envelope (`{type, id, timestamp, message}`),
    // so the role and content live one level down. Older builds wrote the chat
    // record at the top level; accept both rather than pinning a build.
    const record =
      envelope.message && typeof envelope.message === "object"
        ? (envelope.message as Record<string, unknown>)
        : envelope;
    const at = timeOf(envelope.timestamp) ?? timeOf(record.timestamp);

    const out: ParsedLine = {};

    // The skill catalogue is written into the system prompt once per session.
    // Reading it here is how "which skills does this session have" is answered
    // without touching the agent: it is the agent's own statement. Newer builds
    // keep the prompt in `message.sections` (one entry per section) and leave
    // `content` empty, so both are consulted.
    if (!this.skillsEmitted && record.role === "system") {
      const sections = record.sections;
      const sectionSkills =
        sections && typeof sections === "object" ? (sections as Record<string, unknown>).skills : undefined;
      const skills = parseSkillCatalogue(textOf(sectionSkills) || textOf(record.content));
      if (skills.length > 0) {
        out.skills = skills;
        this.skillsEmitted = true;
      }
    }

    if (record.role === "assistant" && Array.isArray(record.content)) {
      for (const part of record.content) {
        if (!part || typeof part !== "object") continue;
        const block = part as Record<string, unknown>;
        if (block.type !== "toolCall" && block.type !== "tool_call" && block.type !== "toolUse") continue;
        const id = String(block.id ?? block.toolCallId ?? "");
        const toolName = String(block.name ?? block.toolName ?? "");
        if (!id || !toolName) continue;
        this.pending.set(id, {
          toolName,
          args: argsText(block.arguments ?? block.args ?? block.input),
          at: at ?? Date.now(),
        });
      }
    }

    if (record.role === "toolResult" || record.role === "tool") {
      const id = String(record.toolCallId ?? record.tool_call_id ?? "");
      const toolName = String(record.toolName ?? record.name ?? "");
      const held = id ? this.pending.get(id) : undefined;
      const name = held?.toolName ?? toolName;
      if (!name) return out;
      if (id) this.pending.delete(id);
      out.calls = [
        this.finish(
          id || name,
          name,
          held?.args ?? "",
          textOf(record.content),
          // The transcript states failure itself; nothing is inferred from text.
          record.isError === true || record.is_error === true,
          held?.at,
          at,
        ),
      ];
    }
    return out;
  }

  private finish(
    id: string,
    toolName: string,
    args: string,
    result: string,
    isError: boolean,
    start: number | undefined,
    end: number | undefined,
  ): SessionToolCall {
    const { server, tool } = splitToolName(toolName);
    return {
      id,
      toolName,
      server,
      tool,
      args,
      result,
      isError,
      durationMs: start !== undefined && end !== undefined && end >= start ? end - start : undefined,
    };
  }
}

/**
 * One `McpToolCall` item, which Codex records with the server and tool named
 * directly — no name to split, and a structured result instead of text.
 */
function mcpToolCallRecord(item: Record<string, unknown>): ParsedLine {
  const server = String(item.server ?? "");
  const tool = String(item.tool ?? "");
  if (!server || !tool) return {};
  const status = String(item.status ?? "");
  const result = item.result;
  // `result.content[].text` is the model-facing text; a structured payload is
  // kept as JSON so the Stage can show what the server actually returned.
  let text = "";
  if (result && typeof result === "object") {
    const content = (result as Record<string, unknown>).content;
    text = content === undefined ? JSON.stringify(result) : textOf(content) || JSON.stringify(result);
  } else if (result !== undefined && result !== null) {
    text = String(result);
  }
  return {
    calls: [
      {
        id: String(item.id ?? `${server}:${tool}`),
        toolName: `mcp__${server}__${tool}`,
        server,
        tool,
        args: argsText(item.arguments),
        result: text,
        isError: status === "failed" || status === "error",
      },
    ],
  };
}

/**
 * The Codex rollout, read incrementally.
 *
 * Codex writes a `function_call` and later a `function_call_output` carrying the
 * same `call_id`, both inside `payload` of a `response_item` line. An MCP call
 * splits its name across two fields — `namespace: "mcp__<server>"` and
 * `name: "observe"` — so they have to be rejoined before the tool name is read.
 *
 * The rollout also carries an `event_msg` / `item_completed` record for an MCP
 * call that is richer than the function-call pair: it names the server and tool
 * directly and carries the structured result. That record is preferred when it
 * arrives, because it is the agent's own statement of what the call was; the
 * function-call pair remains the only source for built-in tools.
 */
export class CodexTranscriptReader {
  private readonly pending = new Map<string, { toolName: string; args: string; at: number }>();
  /**
   * Calls already reported, by call id.
   *
   * Codex writes one MCP call twice: a rich `event_msg`/`McpToolCall` item and
   * the `function_call` / `function_call_output` pair. They are the same call,
   * so the first one that completes wins and the other is dropped — otherwise
   * every MCP call would appear twice in the Stage.
   */
  private readonly reported = new Set<string>();

  push(line: unknown): ParsedLine {
    if (!line || typeof line !== "object") return {};
    const record = line as Record<string, unknown>;
    if (record.type === "event_msg") {
      // The richer MCP record: `{type:"item_completed", item:{type:"McpToolCall",...}}`.
      const payload = record.payload;
      const item = payload && typeof payload === "object" ? (payload as Record<string, unknown>).item : undefined;
      if (item && typeof item === "object" && (item as Record<string, unknown>).type === "McpToolCall") {
        const parsed = mcpToolCallRecord(item as Record<string, unknown>);
        for (const call of parsed.calls ?? []) {
          if (this.reported.has(call.id)) return {};
          this.reported.add(call.id);
          // The function-call half may still be waiting to pair up.
          this.pending.delete(call.id);
        }
        return parsed;
      }
      return {};
    }
    if (record.type !== "response_item") return {};
    const payload = record.payload;
    if (!payload || typeof payload !== "object") return {};
    const item = payload as Record<string, unknown>;
    const at = timeOf(record.timestamp);
    const now = at ?? Date.now();

    if (item.type === "function_call") {
      const id = String(item.call_id ?? item.id ?? "");
      const name = String(item.name ?? "");
      if (!id || !name) return {};
      // MCP tools arrive as `namespace` + `name`; a built-in tool has no namespace.
      const namespace = typeof item.namespace === "string" ? item.namespace : "";
      const toolName = namespace ? `${namespace}__${name}` : name;
      this.pending.set(id, { toolName, args: argsText(item.arguments), at: now });
      return {};
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const id = String(item.call_id ?? item.id ?? "");
      const held = id ? this.pending.get(id) : undefined;
      if (!held) return {};
      this.pending.delete(id);
      // An MCP call already reported through its `McpToolCall` item.
      if (this.reported.has(id)) return {};
      this.reported.add(id);
      const { server, tool } = splitToolName(held.toolName);
      const result = textOf(item.output);
      return {
        calls: [
          {
            id,
            toolName: held.toolName,
            server,
            tool,
            args: held.args,
            result,
            // Codex has no error flag on a tool output; it says so in the opening
            // of the text. A tool that answers normally with a refusal carries
            // its own structured status, which the McpToolCall item reports.
            isError: /^\s*(error|failed|denied)\b/i.test(result),
            durationMs: now >= held.at ? now - held.at : undefined,
          },
        ],
      };
    }
    return {};
  }
}

/**
 * Pull `<skill><name>..</name><description>..</description></skill>` entries out
 * of a skill catalogue block.
 *
 * Pi states its skills inside the system prompt as XML-ish text; there is no
 * side file to read. Deliberately tolerant: a malformed block yields fewer
 * skills, never an exception.
 */
export function parseSkillCatalogue(text: string): SessionSkill[] {
  const skills: SessionSkill[] = [];
  const block = /<skill>([\s\S]*?)<\/skill>/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(text)) !== null) {
    const body = match[1] ?? "";
    const name = /<name>([\s\S]*?)<\/name>/.exec(body)?.[1]?.trim();
    if (!name) continue;
    skills.push({
      name,
      description: (/<description>([\s\S]*?)<\/description>/.exec(body)?.[1] ?? "").trim(),
      filePath: (/<location>([\s\S]*?)<\/location>/.exec(body)?.[1] ?? "").trim(),
    });
  }
  return skills;
}
