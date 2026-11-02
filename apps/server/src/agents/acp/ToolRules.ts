import fs from "node:fs";

/**
 * Tool-call classification for the ACP layer.
 *
 * ACP already carries a `kind` (`read | edit | delete | move | search | execute |
 * fetch | think | other`), but the spec says agents SHOULD fill it, not MUST —
 * an agent that omits it lands every call in `other`. Rather than special-casing
 * that agent, this module applies a table of shape rules from `toolRules.json`:
 * a call with a `command` field is a shell command, one with `path` + `old_string`
 * is an edit, and so on. The table is data, and it is written against generic
 * field names, so a new agent needs a profile, not code.
 */

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "fetch"
  | "think"
  | "other";

interface RuleSet {
  fields: Record<string, string[]>;
  rules: Array<{
    id: string;
    kind: string;
    as?: "write";
    when: { anyField?: string; allFields?: string[] };
  }>;
}

/** Fallback used when toolRules.json cannot be read (a packaged build without it). */
const FALLBACK: RuleSet = {
  fields: {
    command: ["command", "cmd", "script", "shell_command", "commandLine"],
    path: ["path", "file_path", "filePath", "file", "filename", "target_file", "abs_path"],
    content: ["content", "contents", "text", "new_string", "newText", "new_str"],
    oldContent: ["old_string", "oldText", "old_str"],
    query: ["pattern", "query", "glob", "regex", "search"],
    url: ["url", "uri", "endpoint"],
    range: ["offset", "limit", "start_line", "end_line", "startLine", "endLine"],
  },
  rules: [
    { id: "shell-command", kind: "execute", when: { anyField: "command" } },
    { id: "edit-with-replacement", kind: "edit", when: { anyField: "oldContent" } },
    { id: "write-with-content", kind: "edit", as: "write", when: { allFields: ["path", "content"] } },
    { id: "search-with-query", kind: "search", when: { anyField: "query" } },
    { id: "fetch-with-url", kind: "fetch", when: { anyField: "url" } },
    { id: "read-with-range", kind: "read", when: { allFields: ["path", "range"] } },
    { id: "read-with-path", kind: "read", when: { allFields: ["path"] } },
  ],
};

let cached: RuleSet | undefined;

function load(): RuleSet {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(new URL("./toolRules.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as RuleSet;
    cached = parsed?.rules && parsed?.fields ? parsed : FALLBACK;
  } catch {
    cached = FALLBACK;
  }
  return cached;
}

/** One tool call, in the shape ACP actually sends it. */
export interface AcpToolFacts {
  toolCallId: string;
  /** What the agent shows the user (`title` / `name`). Display only — never the classification. */
  name: string;
  /** ACP's own kind, when the agent filled it. */
  kind?: string;
  rawInput?: unknown;
  status?: string;
  locations?: Array<{ path?: string; line?: number }>;
  /** ACP's `content` (text blocks, or `{type:"diff", oldText, newText}`). */
  content?: unknown;
  rawOutput?: unknown;
  /** The client answered the permission request with a reject option. */
  permissionDenied?: boolean;
}

export interface ResolvedTool {
  kind: ToolKind;
  /** Set when the rules identified a write (`as: "write"`). */
  write?: boolean;
  mcp?: { server: string; tool: string };
  command?: string;
  path?: string;
  query?: string;
  url?: string;
  /** Which rule decided the kind; surfaced in diagnostics. */
  rule: string;
}

const ACP_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "fetch",
  "think",
  "other",
]);

/**
 * Decide what a tool call is.
 *
 * A usable ACP `kind` wins. Only when the protocol omitted it (or said `other`,
 * which ACP defines as "not classified") do the shape rules answer. The rules
 * look at generic fields, never at a tool title or an agent's private tool
 * name; a title is display text and cannot prove what a call does.
 */
export function resolveTool(facts: AcpToolFacts): ResolvedTool {
  const record = isRecord(facts.rawInput) ? facts.rawInput : undefined;
  const rules = load();
  const fields = rules.fields;

  const first = (bucket: string): string | undefined => {
    const keys = fields[bucket] ?? [];
    if (!record) return undefined;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
      // Range fields (`offset` / `limit`) are usually numbers; a present
      // number still proves the shape a rule is looking for.
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return undefined;
  };

  const hasField = (bucket: string): boolean => first(bucket) !== undefined;

  // `other` is not a classification: it is the absence of one. A real ACP kind
  // is authoritative and is never overridden by the shape table.
  const declared = normalizeKind(facts.kind);
  const usable = declared !== "other" ? declared : undefined;

  const resolved: ResolvedTool = {
    kind: usable ?? "other",
    rule: usable ? "acp-kind" : "",
    command: first("command"),
    path: first("path") ?? facts.locations?.find((l) => l.path)?.path ?? contentPath(facts.content),
    query: first("query"),
    url: first("url"),
  };

  // `mcp__<server>__<tool>` is a shared MCP naming convention, not an agent's
  // private tool name; it is the only recognised identifier convention.
  const mcp = mcpParts(facts.name);

  // An `edit` that carries whole new content and no old text is a write: same
  // kind in ACP, different first-class event in Absence.
  if ((usable ?? resolved.kind) === "edit" && hasField("content") && !hasField("oldContent")) {
    resolved.write = true;
  }

  if (mcp) {
    resolved.mcp = mcp;
    if (!usable) {
      resolved.kind = "fetch";
      resolved.rule = "mcp";
      return resolved;
    }
  }

  if (usable) return resolved;

  for (const rule of rules.rules) {
    if (!matches(rule, hasField)) continue;
    resolved.kind = normalizeKind(rule.kind);
    resolved.rule = rule.id;
    if (rule.as === "write") resolved.write = true;
    if (resolved.kind !== "other") return resolved;
  }
  return resolved;
}

function matches(rule: RuleSet["rules"][number], hasField: (bucket: string) => boolean): boolean {
  const { when } = rule;
  if (when.anyField && !hasField(when.anyField)) return false;
  if (when.allFields && !when.allFields.every((bucket) => hasField(bucket))) return false;
  return true;
}

function normalizeKind(kind: string | undefined): ToolKind {
  const value = String(kind ?? "other").toLowerCase();
  return (ACP_KINDS.has(value) ? value : "other") as ToolKind;
}

/** `mcp__filesystem__read_file` → the server and tool. */
export function mcpParts(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator === -1) return { server: rest, tool: "" };
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Extract text from an ACP content block. */
export function textOfContentBlock(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  const block = content as { type?: string; text?: unknown };
  if (block.type === "text") return String(block.text ?? "");
  return "";
}

/** Extract text from a tool_call_update `content` array. */
export function textOfToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const inner = (item as { content?: unknown })?.content ?? item;
    const text = textOfContentBlock(inner);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n");
}

/**
 * The path a `diff` content block names. ACP requires `path` on a diff even
 * when the agent's `rawInput`/`locations` omit it, so an edit can still be
 * placed on the right file.
 */
function contentPath(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    const block = item as { type?: string; path?: unknown; diff?: { path?: unknown } };
    if (block.type === "diff" && typeof block.path === "string") return block.path;
    if (block.diff && typeof block.diff.path === "string") return block.diff.path;
  }
  return undefined;
}

/** A diff ACP attached to an edit, when it has one. */
export function diffOfContent(content: unknown): { before: string; after: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    const block = item as { type?: string; diff?: { oldText?: string; newText?: string }; oldText?: string; newText?: string };
    const diff = block.diff ?? (block.type === "diff" ? block : undefined);
    if (diff && typeof diff.newText === "string") {
      return { before: diff.oldText ?? "", after: diff.newText };
    }
  }
  return undefined;
}

/** The bytes a write/edit call carried in its own input. */
export function inputContent(rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) return undefined;
  for (const key of ["content", "contents", "text", "new_string", "newText", "new_str"]) {
    if (typeof rawInput[key] === "string") return rawInput[key] as string;
  }
  return undefined;
}

/** The old text an edit replaced, when the agent sent it. */
export function inputOldContent(rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) return undefined;
  for (const key of ["old_string", "oldText", "old_str"]) {
    if (typeof rawInput[key] === "string") return rawInput[key] as string;
  }
  return undefined;
}
