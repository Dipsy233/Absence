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
        const reportedCode = denied ? undefined : reportedExitCode(facts);
        const exitCode = denied ? 1 : reportedCode ?? (failed ? 1 : 0);
        const terminalId = terminalIdOf(facts.content);
        // The final output, in protocol priority order: the agent's aggregated
        // copy, then its explicit stdout/stderr, then every chunk this call
        // streamed. A failed call's text usually is the error the command
        // wrote, so it stays on stderr.
        const output = commandOutput(facts, failed);
        const event: MappedEvent = {
          type: "command",
          payload: {
            command: resolved.command ?? "",
            stdout: output.stdout,
            stderr: output.stderr,
            exitCode,
            ...(output.truncated ? { truncated: true as const } : {}),
            // ACP only carries completed/failed; the real code has to come
            // from `rawOutput` or the agent's `_meta.terminal_exit`. When it is
            // absent the numeric fallback is a status inference, and the event
            // says so instead of pretending.
            ...(denied || reportedCode === undefined ? { exitCodeKnown: false as const } : {}),
            ...(denied ? { permissionDenied: true as const } : {}),
            // Carry the terminal reference verbatim; do not guess a process.
            ...(terminalId !== undefined ? { terminalId } : {}),
          },
        };
        // A denial is reported by the client; an unknown exit code is inferred
        // from the call status, so the fidelity follows the weakest fact. An
        // exit code read from `_meta` is agent-reported, never `exact`.
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
    const text = normalizeReadText(stripDecoratedRead(raw));
    const location = facts.locations?.find((l) => typeof l.line === "number");
    const lineCount = text.split("\n").length;
    const range = declaredReadRange(facts.rawInput, location?.line, lineCount);
    const event: MappedEvent = {
      type: "file_read",
      payload: {
        path: this.display(resolved.path),
        content: text,
        language: languageFromPath(abs),
        ...(range.startLine !== undefined ? { startLine: range.startLine } : {}),
        ...(range.endLine !== undefined ? { endLine: range.endLine } : {}),
        // No `locations.line` and no `offset`/`limit`: there is no range to
        // assert. The number of lines the agent happened to return is not
        // evidence of where it read; a trailing newline even adds a ghost line.
        ...(range.rangeKnown !== undefined ? { rangeKnown: range.rangeKnown } : {}),
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
    // Some agents' edit sends the whole old/new file in the `diff` block. When
    // the reported text *is* the file on disk, say so explicitly; otherwise
    // this was a snippet and `fullContent` stays false.
    const wholeFile = diff !== undefined && disk !== null && (diff.before === disk || diff.after === disk);
    const pathRelative = !path.isAbsolute(resolved.path.replace(/^@/, ""));
    return [
      reported({
        type: "file_edit",
        payload: {
          // Keep the agent's relative path verbatim — Absence does not turn it
          // into an absolute path just because it knows the session cwd.
          path: this.display(resolved.path),
          ...(pathRelative ? { pathRelative: true } : {}),
          before,
          after,
          diff: unifiedDiff(before, after, resolved.path, resolved.path),
          // A reconstructed edit has full content; a diff that was already the
          // whole file is marked `true`; an unreconstructable snippet is false.
          ...(fullContent ? { ...(wholeFile ? { fullContent: true } : {}) } : { fullContent: false }),
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

  /**
   * The path as reported. A relative path is kept verbatim (and marked
   * `pathRelative` on the event); only an absolute path inside the project is
   * shown project-relative, and an absolute path outside is left as reported.
   */
  private display(p: string): string {
    const value = p.replace(/^@/, "");
    if (!path.isAbsolute(value)) return p;
    const rel = path.relative(this.cwd, value);
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
 * The command's final output, in the order ACP can supply it:
 *
 *   1. `rawOutput.aggregatedOutput` — the agent's own complete copy
 *   2. `rawOutput.stdout` + `rawOutput.stderr` — explicit channels
 *   3. every chunk streamed through `tool_call_update.content`
 *
 * A failed call's text belongs on stderr, as before; an explicit channel pair
 * is kept exactly where the agent put it.
 */
function commandOutput(
  facts: AcpToolFacts,
  failed: boolean,
): { stdout: string; stderr: string; truncated: boolean } {
  const raw = facts.rawOutput;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (typeof record["aggregatedOutput"] === "string") {
      const text = record["aggregatedOutput"];
      return failed
        ? { stdout: "", stderr: text, truncated: facts.outputTruncated === true }
        : { stdout: text, stderr: "", truncated: facts.outputTruncated === true };
    }
    const stdout = typeof record["stdout"] === "string" ? record["stdout"] : undefined;
    const stderr = typeof record["stderr"] === "string" ? record["stderr"] : undefined;
    if (stdout !== undefined || stderr !== undefined) {
      return {
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        truncated: facts.outputTruncated === true,
      };
    }
  }
  const text =
    facts.accumulatedOutput && facts.accumulatedOutput.length > 0
      ? facts.accumulatedOutput
      : textOfToolContent(facts.content) || textOfToolContent(facts.rawOutput);
  return failed
    ? { stdout: "", stderr: text, truncated: facts.outputTruncated === true }
    : { stdout: text, stderr: "", truncated: facts.outputTruncated === true };
}

/**
 * The real exit code an ACP call carried, in protocol priority order:
 *
 *   1. `rawOutput.exitCode`
 *   2. `rawOutput.exit_code`
 *   3. `rawOutput.code`
 *   4. `_meta.terminal_exit.exit_code` (update-level or a content block)
 *
 * Nested `result` / `data` / `meta` / `output` / `process` objects are still
 * accepted between 3 and 4 for adapters that wrap the code. Anything else is
 * not a code and must not be invented.
 */
function reportedExitCode(facts: AcpToolFacts): number | undefined {
  const raw = facts.rawOutput;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const key of ["exitCode", "exit_code", "code"]) {
      const code = exitCodeValue(record[key]);
      if (code !== undefined) return code;
    }
    for (const key of ["result", "data", "meta", "output", "process"]) {
      const nested = exitCodeValue(record[key]);
      if (nested !== undefined) return nested;
    }
  } else {
    const direct = exitCodeValue(raw);
    if (direct !== undefined) return direct;
  }
  return terminalExitCode(facts);
}

/** `_meta.terminal_exit.exit_code` on the update or on any content block. */
function terminalExitCode(facts: AcpToolFacts): number | undefined {
  const update = terminalExitFromMeta(facts.meta);
  if (update !== undefined) return update;
  for (const block of contentBlocks(facts.content)) {
    const fromBlock = terminalExitFromMeta(block);
    if (fromBlock !== undefined) return fromBlock;
    if (block !== null && typeof block === "object") {
      const direct = exitCodeValue((block as Record<string, unknown>)["terminal_exit"]);
      if (direct !== undefined) return direct;
    }
  }
  return terminalExitFromMeta(facts.rawOutput);
}

function terminalExitFromMeta(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  // The update-level `_meta` is passed as its contents already; a content
  // block still carries the `_meta` wrapper.
  const direct = exitCodeValue(record["terminal_exit"]);
  if (direct !== undefined) return direct;
  const meta = record["_meta"] ?? record["meta"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  return exitCodeValue((meta as Record<string, unknown>)["terminal_exit"]);
}

/** `{type:"terminal", terminalId}` — a reference, never resolved into a pid. */
function terminalIdOf(content: unknown): string | undefined {
  for (const block of contentBlocks(content)) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "terminal" && typeof record["terminalId"] === "string" && record["terminalId"].length > 0) {
      return record["terminalId"];
    }
  }
  return undefined;
}

/** Content blocks, unwrapping the `{type:"content", content:{…}}` envelope. */
function contentBlocks(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  return content.map((item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item) && "content" in item) {
      const inner = (item as { content?: unknown }).content;
      if (inner !== undefined) return inner;
    }
    return item;
  });
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
 * Normalise a read result's line endings and drop one trailing terminator.
 *
 * A CRLF file's last line otherwise keeps a `\r`, and a trailing newline makes
 * `split("\n")` report one more line than the file has — both turn into a
 * ghost line when written to the file index. Interior blank lines are kept.
 */
function normalizeReadText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

/**
 * The line range a read proves.
 *
 *   1. `locations.line` — the agent reported a line; the returned text tells
 *      how many lines it spans.
 *   2. `rawInput.offset` / `limit` — the agent *declared* the range it asked
 *      for. This is reported, not disk-verified, hence `rangeKnown: true`.
 *   3. Neither — no range. Absence never derives one from `content` line count.
 */
function declaredReadRange(
  rawInput: unknown,
  locationLine: number | undefined,
  lineCount: number,
): { startLine?: number; endLine?: number; rangeKnown?: boolean } {
  if (locationLine !== undefined) {
    return {
      startLine: locationLine,
      endLine: locationLine + Math.max(0, lineCount - 1),
    };
  }
  const record =
    rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : undefined;
  const offset = numericField(record, "offset");
  const limit = numericField(record, "limit");
  if ((offset !== undefined && offset > 0) || (limit !== undefined && limit > 0)) {
    const startLine = offset !== undefined && offset > 0 ? offset : 1;
    return {
      startLine,
      endLine: startLine + Math.max(0, lineCount - 1),
      rangeKnown: true,
    };
  }
  // No reported line and no declared offset: there is no end line to assert.
  // A start of 1 is the display origin only (the sim/UI already show
  // "range unknown" from `rangeKnown=false`), never a measured range.
  return { startLine: 1, rangeKnown: false };
}

function numericField(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
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
