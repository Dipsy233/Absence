import path from "node:path";
import type {
  AbsenceEventPayloadMap,
  AbsenceEventType,
  FileChangePayload,
  MonitorFidelity,
  MonitorSource,
} from "@absence/core";
import { readFileSafe } from "../../filesystem/FileTree";
import { unifiedDiff } from "../../util/diff";
import { languageFromPath } from "../../util/language";
import { toPosix } from "../../util/paths";
import {
  diffOfContent,
  inputContent,
  inputOldContent,
  mcpParts,
  resolveTool,
  textOfToolContent,
  type AcpToolFacts,
  type ResolvedTool,
} from "./ToolRules";

/** One event the ACP layer decided to emit for a finished tool call. */
export type MappedEvent = {
  [K in AbsenceEventType]: { type: K; payload: AbsenceEventPayloadMap[K] };
}[AbsenceEventType];

/**
 * A mapped event plus its provenance, so the monitor layer can say whether the
 * fact came from the agent's report or from a disk snapshot Absence took.
 */
export interface MappedEventRecord {
  event: MappedEvent;
  source: MonitorSource;
  fidelity: MonitorFidelity;
}

/**
 * ACP tool calls → AbsenceEvent.
 *
 * The mapping is by ACP `kind` (plus the shape rules when the protocol gave no
 * kind), never by tool title or a product's private tool vocabulary. A read is
 * a read whether the agent calls it `Read`, `read_file` or `cat`; a shell call
 * is a shell call whether it is `Bash`, `run_shell_command` or `shell`. That is
 * the whole decoupling: adding an agent means adding a launch profile, not
 * teaching Absence a new vocabulary.
 *
 * Data sources, in order:
 *   1. what the agent reported (content / rawOutput / locations)
 *   2. what the call itself carried (rawInput)
 *   3. a disk snapshot taken at the moment the call finished, when neither is
 *      usable — every payload then says what was actually on disk, not a guess
 */
export class AcpToolMapper {
  constructor(private readonly cwd: string) {}

  /** Classify a call (also used at tool_call time to open a command window). */
  resolve(facts: AcpToolFacts): ResolvedTool {
    return resolveTool(facts);
  }

  /** Map a finished tool call to the first-class events it deserves. */
  async mapCompleted(facts: AcpToolFacts): Promise<MappedEvent[]> {
    return (await this.mapCompletedDetailed(facts)).map((record) => record.event);
  }

  /** The same mapping, with `source` / `fidelity` kept alongside each event. */
  async mapCompletedDetailed(facts: AcpToolFacts): Promise<MappedEventRecord[]> {
    const resolved = this.resolve(facts);
    // `content` is the model-facing result; some agents put the same text in
    // `rawOutput` instead, so the two are tried in that order.
    const content = textOfToolContent(facts.content) || textOfToolContent(facts.rawOutput);
    const failed = facts.status === "failed";

    if (resolved.mcp) {
      return [
        reported({
          type: "mcp",
          payload: {
            server: resolved.mcp.server,
            tool: resolved.mcp.tool,
            toolName: facts.name,
            toolCallId: facts.toolCallId,
            args: JSON.stringify(facts.rawInput ?? {}, null, 2),
            result: content.slice(0, 20_000),
            isError: failed,
          },
        }),
      ];
    }

    switch (resolved.kind) {
      case "read":
        return await this.fileRead(facts, resolved, content);
      case "edit":
        return await this.fileEdit(facts, resolved, content);
      case "delete":
      case "move":
        return this.fileChange(resolved, resolved.kind === "delete" ? "deleted" : "modified");
      case "execute": {
        // The authoritative denial comes from the client's permission answer
        // (AcpAdapter passes `permissionDenied`). A message-only fallback covers
        // adapters that encode it in the failed tool text instead. A denial is
        // never silent: the event says the command did not run.
        const denied =
          facts.permissionDenied === true ||
          (failed && facts.rawOutput === undefined && permissionDeniedText(content));
        const reportedCode = denied ? undefined : reportedExitCode(facts.rawOutput);
        const exitCode = denied ? 1 : reportedCode ?? (failed ? 1 : 0);
        const event: MappedEvent = {
          type: "command",
          payload: {
            command: resolved.command ?? "",
            // A failed call's text is usually the error the command wrote; a
            // successful one's is its output. Keeping them apart is what lets
            // the Report say "this failed" from the event alone.
            stdout: failed ? "" : content,
            stderr: failed ? content : "",
            exitCode,
            // ACP only carries completed/failed; the real code has to come
            // from `rawOutput`. When it is absent the numeric fallback is a
            // status inference, and the event says so instead of pretending.
            ...(denied || reportedCode === undefined ? { exitCodeKnown: false as const } : {}),
            ...(denied ? { permissionDenied: true as const } : {}),
          },
        };
        // A denial is reported by the client; an unknown exit code is inferred
        // from the call status, so the fidelity follows the weakest fact.
        return [denied || reportedCode !== undefined ? reported(event) : inferred(event)];
      }
      case "search":
        return [
          reported({
            type: "search",
            payload: {
              tool: (resolved.query ? "grep" : "find") as string,
              query: resolved.query ?? resolved.path ?? "",
              scope: resolved.path ? this.display(resolved.path) : undefined,
              matches: content.split("\n").filter((line) => line.trim().length > 0).length,
              output: content.slice(0, 4000),
            },
          }),
        ];
      default:
        // `fetch` / `think` / `other`: the tool_start/tool_end pair already
        // shows the action; inventing a payload would be guessing.
        return [];
    }
  }

  /**
   * A read. The exact line range comes from ACP `locations` when the agent
   * reported one; when it did not, the range is the content that came back.
   * Absence never claims a range the agent did not report.
   */
  private async fileRead(
    facts: AcpToolFacts,
    resolved: ResolvedTool,
    content: string,
  ): Promise<MappedEventRecord[]> {
    if (!resolved.path) return [];
    const abs = this.abs(resolved.path);
    const reportedContent = content.length > 0;
    const raw = reportedContent ? content : ((await readFileSafe(abs)) ?? "");
    // Some agents decorate a read result with a header and `N: line` prefixes.
    // That is a *format*, not a product, so it is unwrapped generically here
    // rather than in an agent-specific adapter.
    const text = stripDecoratedRead(raw);
    if (text.length === 0) return [];
    const location = facts.locations?.find((l) => typeof l.line === "number");
    const startLine = location?.line ?? 1;
    const lines = text.split("\n").length;
    const event: MappedEvent = {
      type: "file_read",
      payload: {
        path: this.display(resolved.path),
        startLine,
        endLine: startLine + Math.max(0, lines - 1),
        content: text,
        language: languageFromPath(abs),
        // No `locations.line`: 1..contentLines is a display fallback, not a
        // range the agent reported. The UI must say "range unknown" — and the
        // returned text may be only the snippet that was read, never the whole
        // file.
        ...(location === undefined ? { rangeKnown: false as const } : {}),
      },
    };
    // When the protocol returned no text and Absence read the file itself, the
    // content is an OS observation rather than the agent's report.
    return [reportedContent ? reported(event) : { ...exact(event), source: "os" }];
  }

  /**
   * A write or an edit. Prefer the diff the agent sent; otherwise reconstruct
   * from the call's own input (old/new strings) or from disk.
   */
  private async fileEdit(
    facts: AcpToolFacts,
    resolved: ResolvedTool,
    content: string,
  ): Promise<MappedEventRecord[]> {
    if (!resolved.path) return [];
    const abs = this.abs(resolved.path);
    const diff = diffOfContent(facts.content);
    const written = inputContent(facts.rawInput);
    const replaced = inputOldContent(facts.rawInput);

    if (resolved.write) {
      return [
        reported({
          type: "file_write",
          payload: {
            path: this.display(resolved.path),
            content: written ?? ((await readFileSafe(abs)) ?? ""),
          },
        }),
      ];
    }

    const oldText = diff?.before ?? replaced;
    const newText = diff?.after ?? written;
    const disk = await readFileSafe(abs);

    // ACP adapters may send the whole file or only the replaced snippet in
    // `content: [{type:"diff"}]`. Reconstruct the whole before/after from disk
    // when the pair is a snippet, so SessionStore never stores the snippet as
    // the file's complete content (and the FileWatcher does not echo a second,
    // bogus edit).
    let before = oldText ?? "";
    let after = newText ?? content;
    let fullContent = false;
    if (disk !== null && oldText && newText) {
      if (disk.includes(oldText)) {
        before = disk;
        after = replaceOnce(disk, oldText, newText);
        fullContent = true;
      } else if (disk.includes(newText)) {
        after = disk;
        before = replaceOnce(disk, newText, oldText);
        fullContent = true;
      }
    }
    if (!after) return [];
    return [
      reported({
        type: "file_edit",
        payload: {
          path: this.display(resolved.path),
          before,
          after,
          diff: unifiedDiff(before, after, resolved.path, resolved.path),
          // Still an edit the agent reported, but only a snippet: consumers
          // must not present it as the file's complete content.
          ...(fullContent ? {} : { fullContent: false as const }),
        },
      }),
    ];
  }

  private fileChange(resolved: ResolvedTool, kind: FileChangePayload["kind"]): MappedEventRecord[] {
    if (!resolved.path) return [];
    return [
      reported({
        type: "file_change",
        payload: { path: this.display(resolved.path), kind },
      }),
    ];
  }

  private abs(p: string): string {
    const value = p.replace(/^@/, "");
    return path.isAbsolute(value) ? value : path.join(this.cwd, value);
  }

  /** Project-relative when inside the project, otherwise as reported. */
  private display(p: string): string {
    const absolute = this.abs(p);
    const rel = path.relative(this.cwd, absolute);
    return rel && !rel.startsWith("..") ? toPosix(rel) : p;
  }
}

export { mcpParts };

function reported(event: MappedEvent): MappedEventRecord {
  return { event, source: "acp", fidelity: "reported" };
}

function inferred(event: MappedEvent): MappedEventRecord {
  return { event, source: "acp", fidelity: "inferred" };
}

function exact(event: MappedEvent): MappedEventRecord {
  return { event, source: "acp", fidelity: "exact" };
}

/**
 * The real exit code an ACP `rawOutput` carried. Agents put it at the top level
 * (`{ exitCode: 3 }`), as a numeric string, or under a nested result/meta
 * object. Anything else is not a code and must not be invented.
 */
function reportedExitCode(raw: unknown): number | undefined {
  const direct = exitCodeValue(raw);
  if (direct !== undefined) return direct;
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  for (const key of ["result", "data", "meta", "output", "process"]) {
    const nested = exitCodeValue(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function exitCodeValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["exitCode", "exit_code", "code"]) {
    if (typeof record[key] === "number" && Number.isFinite(record[key])) return record[key] as number;
    if (typeof record[key] === "string") {
      const n = Number((record[key] as string).trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/**
 * Text an agent uses when the *user* denied the permission request. Deliberately
 * narrower than "permission denied": an OS `EACCES` from a command that really
 * ran is a failed execution, not an unexecuted attempt.
 */
function permissionDeniedText(content: string): boolean {
  return /permission denied by (the )?user|denied by (the )?user|user (denied|rejected)|rejected by (the )?user|approval (was )?(denied|rejected)|permission request (denied|rejected)/i.test(
    content,
  );
}

/** Replace the first occurrence, like the tool's own `replace` semantics. */
function replaceOnce(text: string, find: string, replacement: string): string {
  const at = text.indexOf(find);
  if (at < 0) return text;
  return text.slice(0, at) + replacement + text.slice(at + find.length);
}

/**
 * Unwrap a decorated read result:
 *
 *   <path>/abs/path</path>
 *   <type>file</type>
 *   <content>
 *   1: first line
 *   </content>
 *
 * If a result carries no such decoration it is returned unchanged. This is a
 * tolerant format unwrap, not an agent-specific rule.
 */
function stripDecoratedRead(text: string): string {
  if (!/^\s*<path>[\s\S]*<\/path>/.test(text) && !text.includes("<content>")) return text;
  let body = text;
  const contentAt = body.indexOf("<content>");
  if (contentAt >= 0) body = body.slice(contentAt + "<content>".length);
  else body = body.replace(/^\s*<path>[\s\S]*?<\/path>\s*/, "").replace(/^\s*<type>[^<]*<\/type>\s*/, "");
  body = body.replace(/\s*<\/content>\s*$/, "");
  body = body.replace(/^\n/, "").replace(/\n$/, "");
  return body
    .split("\n")
    .map((line) => line.replace(/^\s*\d+[:\t]\s?/, ""))
    .join("\n");
}
