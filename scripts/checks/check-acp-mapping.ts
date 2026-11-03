/**
 * Offline check for the ACP → monitor projection layer.
 *
 *   npx tsx scripts/checks/check-acp-mapping.ts
 *
 * Pins the honesty rules:
 *   - an ACP `kind` always wins; only a missing/`other` kind runs the shape table;
 *   - the shape table never branches on a tool title or an agent's private name;
 *   - a read without a reported line is `rangeKnown=false` and its content is
 *     the returned snippet, not the whole file — unless the returned text
 *     matches the file on disk exactly and uniquely, which verifies the range;
 *     an ambiguous or stale match stays unknown;
 *   - a command without `rawOutput.exitCode` is `exitCodeKnown=false`;
 *   - a denied permission is `permissionDenied`, never silently dropped;
 *   - an execute call emits one tool_start, one tool_end and one command event,
 *     and opens/closes one process window — even if terminal updates repeat;
 *   - plan / current_mode_update become MonitorEvents with source + fidelity;
 *   - no path is invented when the protocol did not name one.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MonitorEvent } from "@absence/core";
import { AcpToolMapper } from "../../apps/server/src/agents/acp/AcpToolMapper";
import { resolveTool } from "../../apps/server/src/agents/acp/ToolRules";
import { createMonitorBus } from "../../apps/server/src/monitor/MonitorBus";
import {
  AcpMonitorProjector,
  type ProjectorCommandWindow,
} from "../../apps/server/src/monitor/projector";
import { check, finish, section } from "./harness";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "absence-acp-mapping-"));
}

function count(events: MonitorEvent[], type: string): number {
  return events.filter((event) => event.event.type === type).length;
}

function firstOf(events: MonitorEvent[], type: string): MonitorEvent | undefined {
  return events.find((event) => event.event.type === type);
}

function recordingWindow(): { port: ProjectorCommandWindow; log: Array<{ phase: string; id?: number; command?: string }> } {
  const log: Array<{ phase: string; id?: number; command?: string }> = [];
  let next = 1;
  return {
    log,
    port: {
      begin: (command) => {
        const id = next++;
        log.push({ phase: "begin", id, command });
        return id;
      },
      end: (id) => {
        log.push({ phase: "end", id });
      },
    },
  };
}

async function main(): Promise<void> {
  section("rules: ACP kind first, shape table only when the kind is absent");
  {
    const kindWins = resolveTool({
      toolCallId: "k1",
      name: "Bash",
      kind: "read",
      rawInput: { command: "rm -rf build", path: "src/index.ts" },
    });
    check("a real kind wins over a shell title and a command field", kindWins.kind === "read" && kindWins.rule === "acp-kind", JSON.stringify(kindWins));

    const editKind = resolveTool({
      toolCallId: "k2",
      name: "shell",
      kind: "edit",
      rawInput: { command: "echo x", path: "a.ts", old_string: "a", new_string: "b" },
    });
    check("a real edit kind is not overridden by a command title", editKind.kind === "edit" && editKind.rule === "acp-kind");

    const shellByShape = resolveTool({
      toolCallId: "k3",
      name: "shell",
      rawInput: { command: "npm test" },
    });
    check("no kind + a command field is execute", shellByShape.kind === "execute" && shellByShape.rule === "shell-command", JSON.stringify(shellByShape));
    check("the command is extracted for the window", shellByShape.command === "npm test");

    const otherWithCommand = resolveTool({
      toolCallId: "k4",
      name: "Run",
      kind: "other",
      rawInput: { command: "npm test" },
    });
    check("ACP `other` means unclassified, so the shape table may answer", otherWithCommand.kind === "execute" && otherWithCommand.rule === "shell-command");

    const editByShape = resolveTool({
      toolCallId: "k5",
      name: "apply_patch",
      rawInput: { path: "a.ts", old_string: "one", new_string: "two" },
    });
    check("no kind + old/new strings is edit", editByShape.kind === "edit" && editByShape.rule === "edit-with-replacement");

    const writeByShape = resolveTool({
      toolCallId: "k6",
      name: "write_file",
      rawInput: { path: "a.ts", content: "export const x = 1;" },
    });
    check("no kind + path/content is an edit-as-write", writeByShape.kind === "edit" && writeByShape.write === true && writeByShape.rule === "write-with-content");

    const searchByShape = resolveTool({
      toolCallId: "k7",
      name: "search",
      rawInput: { query: "needle" },
    });
    check("no kind + a query is search", searchByShape.kind === "search" && searchByShape.rule === "search-with-query");

    const fetchByShape = resolveTool({
      toolCallId: "k8",
      name: "fetch",
      rawInput: { url: "https://example.invalid" },
    });
    check("no kind + a url is fetch", fetchByShape.kind === "fetch" && fetchByShape.rule === "fetch-with-url");

    const readByShape = resolveTool({
      toolCallId: "k9",
      name: "read_file",
      rawInput: { path: "a.ts", offset: 0, limit: 20 },
    });
    check("no kind + path/range is read", readByShape.kind === "read" && readByShape.rule === "read-with-range");
    check("the path is extracted without inventing one", readByShape.path === "a.ts");

    const readByPath = resolveTool({
      toolCallId: "k10",
      name: "cat",
      rawInput: { path: "a.ts" },
    });
    check("no kind + a path is read", readByPath.kind === "read" && readByPath.rule === "read-with-path");

    const argv = resolveTool({
      toolCallId: "k-argv",
      name: "echo hi",
      kind: "execute",
      rawInput: {
        call_id: "call_0_0",
        command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "echo hi"],
        cwd: "E:\\work",
      },
    });
    check(
      "an argv command array is recovered as a display command",
      argv.kind === "execute" &&
        argv.command !== undefined &&
        argv.command.includes("echo hi") &&
        argv.command.indexOf("pwsh.exe") < argv.command.indexOf("-Command"),
      JSON.stringify(argv),
    );
    check(
      "the argv's argument order is preserved",
      argv.command === '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "echo hi"',
      argv.command,
    );

    const nullInput = resolveTool({
      toolCallId: "k-null",
      name: "Run",
      kind: "execute",
      rawInput: null,
    });
    check(
      "rawInput null is handled without inventing a command",
      nullInput.kind === "execute" && nullInput.command === undefined,
      JSON.stringify(nullInput),
    );

    const emptyArgv = resolveTool({
      toolCallId: "k-empty-argv",
      name: "Run",
      kind: "execute",
      rawInput: { command: [] },
    });
    check(
      "an empty argv is an empty value, not a fabricated command",
      emptyArgv.kind === "execute" && emptyArgv.command === undefined,
      JSON.stringify(emptyArgv),
    );

    const mcp = resolveTool({
      toolCallId: "k11",
      name: "mcp__filesystem__read_file",
      rawInput: {},
    });
    check("the shared mcp__ convention is recognised", mcp.mcp?.server === "filesystem" && mcp.mcp?.tool === "read_file" && mcp.rule === "mcp");

    const diffByShape = resolveTool({
      toolCallId: "k12",
      name: "Edit",
      rawInput: {},
      content: [{ type: "diff", path: "src/index.ts", oldText: "a", newText: "b" }],
    });
    check(
      "no kind + a diff content block is edit",
      diffByShape.kind === "edit" && diffByShape.rule === "diff-content",
      JSON.stringify(diffByShape),
    );
    check("the diff block supplies the file path", diffByShape.path === "src/index.ts");

    for (const title of ["read_file", "bash", "apply_patch", "todowrite"]) {
      const byTitle = resolveTool({ toolCallId: `t-${title}`, name: title, rawInput: {} });
      check(`the title "${title}" alone classifies nothing`, byTitle.kind === "other", JSON.stringify(byTitle));
    }
  }

  section("AcpToolMapper: ranges, exit codes, denials and snippets");
  {
    const dir = await tempDir();
    const mapper = new AcpToolMapper(dir);
    const disk = "alpha\nbeta\ngamma\n";
    await fs.writeFile(path.join(dir, "src.txt"), disk);
    await fs.writeFile(path.join(dir, "main.ts"), "export function main() {\n  return 0;\n}\n");
    await fs.mkdir(path.join(dir, "src"), { recursive: true });

    const unknownRange = await mapper.mapCompletedDetailed({
      toolCallId: "r1",
      name: "Read",
      kind: "read",
      rawInput: { path: "src.txt" },
      content: [{ type: "content", content: { type: "text", text: "alpha" } }],
    });
    const read = firstOf(unknownRange, "file_read");
    check(
      "a read without coordinates is located on disk when the match is exact and unique",
      read?.event.type === "file_read" &&
        read.event.payload.rangeKnown === undefined &&
        read.event.payload.startLine === 1 &&
        read.event.payload.endLine === 1,
      read ? JSON.stringify(read.event.payload) : "no file_read",
    );
    check(
      "the read content is the snippet the agent returned, not the whole file",
      read?.event.type === "file_read" && read.event.payload.content === "alpha" && read.event.payload.content !== disk,
    );
    check("a protocol read has source acp and reported fidelity", read?.source === "acp" && read?.fidelity === "reported");

    await fs.writeFile(path.join(dir, "dup.txt"), "same\nsame\nsame\n");
    const ambiguous = await mapper.mapCompletedDetailed({
      toolCallId: "r-dup",
      name: "Read",
      kind: "read",
      rawInput: { path: "dup.txt" },
      content: [{ type: "content", content: { type: "text", text: "same" } }],
    });
    const ambiguousRead = firstOf(ambiguous, "file_read");
    check(
      "a snippet that matches more than once stays rangeKnown=false",
      ambiguousRead?.event.type === "file_read" && ambiguousRead.event.payload.rangeKnown === false,
      ambiguousRead ? JSON.stringify(ambiguousRead.event.payload) : "no file_read",
    );

    const stale = await mapper.mapCompletedDetailed({
      toolCallId: "r-stale",
      name: "Read",
      kind: "read",
      rawInput: { path: "main.ts" },
      content: [{ type: "content", content: { type: "text", text: "export function stale() {}" } }],
    });
    const staleRead = firstOf(stale, "file_read");
    check(
      "returned text the disk no longer holds stays rangeKnown=false",
      staleRead?.event.type === "file_read" && staleRead.event.payload.rangeKnown === false,
      staleRead ? JSON.stringify(staleRead.event.payload) : "no file_read",
    );

    const fullFile = await mapper.mapCompletedDetailed({
      toolCallId: "r-full",
      name: "Read",
      kind: "read",
      rawInput: { path: "src.txt" },
      content: [{ type: "content", content: { type: "text", text: "alpha\nbeta\ngamma" } }],
    });
    const fullRead = firstOf(fullFile, "file_read");
    check(
      "a read whose text is the whole file is located at 1..N",
      fullRead?.event.type === "file_read" &&
        fullRead.event.payload.startLine === 1 &&
        fullRead.event.payload.endLine === 3 &&
        fullRead.event.payload.rangeKnown === undefined,
      fullRead ? JSON.stringify(fullRead.event.payload) : "no file_read",
    );

    await fs.writeFile(path.join(dir, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
    const crlfDisk = await mapper.mapCompletedDetailed({
      toolCallId: "r-crlf",
      name: "Read",
      kind: "read",
      rawInput: { path: "crlf.txt" },
      content: [{ type: "content", content: { type: "text", text: "two\nthree" } }],
    });
    const crlfRead = firstOf(crlfDisk, "file_read");
    check(
      "a CRLF file still yields line coordinates for an LF read",
      crlfRead?.event.type === "file_read" &&
        crlfRead.event.payload.startLine === 2 &&
        crlfRead.event.payload.endLine === 3 &&
        crlfRead.event.payload.rangeKnown === undefined,
      crlfRead ? JSON.stringify(crlfRead.event.payload) : "no file_read",
    );

    const knownRange = await mapper.mapCompletedDetailed({
      toolCallId: "r2",
      name: "Read",
      kind: "read",
      rawInput: { path: "src.txt" },
      locations: [{ path: "src.txt", line: 2 }],
      content: [{ type: "content", content: { type: "text", text: "beta" } }],
    });
    const known = firstOf(knownRange, "file_read");
    check(
      "a reported line keeps the range precise",
      known?.event.type === "file_read" &&
        known.event.payload.rangeKnown === undefined &&
        known.event.payload.startLine === 2 &&
        known.event.payload.endLine === 2,
    );

    // The four shapes from the regression: 3-line, empty, one line without
    // newline, and CRLF + trailing newline. None may invent an end line or a
    // ghost line from the text's terminator.
    const threeLines = await mapper.mapCompletedDetailed({
      toolCallId: "r-3lines",
      name: "read",
      kind: "read",
      rawInput: { path: "notes.txt" },
      content: [
        {
          type: "content",
          content: { type: "text", text: "alpha line1\nbeta line2\ngamma line3\r\n" },
        },
      ],
    });
    const threeLineRead = firstOf(threeLines, "file_read");
    check(
      "a 3-line CRLF read reports no endLine and no trailing \\r",
      threeLineRead?.event.type === "file_read" &&
        threeLineRead.event.payload.endLine === undefined &&
        threeLineRead.event.payload.content === "alpha line1\nbeta line2\ngamma line3" &&
        threeLineRead.event.payload.rangeKnown === false,
      threeLineRead?.event.type === "file_read"
        ? JSON.stringify(threeLineRead.event.payload)
        : "no file_read",
    );
    check(
      "the CRLF read is still reported at the protocol fidelity",
      threeLineRead?.fidelity === "reported",
      threeLineRead?.fidelity,
    );

    const emptyRead = await mapper.mapCompletedDetailed({
      toolCallId: "r-empty",
      name: "read",
      kind: "read",
      rawInput: { path: "empty.txt" },
      content: [{ type: "content", content: { type: "text", text: "" } }],
    });
    const emptyFileRead = firstOf(emptyRead, "file_read");
    check(
      "an empty file is one empty read, not a ghost line",
      emptyFileRead?.event.type === "file_read" &&
        emptyFileRead.event.payload.content === "" &&
        emptyFileRead.event.payload.endLine === undefined &&
        emptyFileRead.event.payload.rangeKnown === false,
      emptyFileRead?.event.type === "file_read"
        ? JSON.stringify(emptyFileRead.event.payload)
        : "no file_read",
    );

    const singleLine = await mapper.mapCompletedDetailed({
      toolCallId: "r-single",
      name: "read",
      kind: "read",
      rawInput: { path: "one.txt" },
      content: [{ type: "content", content: { type: "text", text: "only line" } }],
    });
    const singleLineRead = firstOf(singleLine, "file_read");
    check(
      "a single line without a newline has no ghost second line",
      singleLineRead?.event.type === "file_read" &&
        singleLineRead.event.payload.content === "only line" &&
        singleLineRead.event.payload.endLine === undefined,
      singleLineRead?.event.type === "file_read"
        ? JSON.stringify(singleLineRead.event.payload)
        : "no file_read",
    );

    const declared = await mapper.mapCompletedDetailed({
      toolCallId: "r-offset",
      name: "read",
      kind: "read",
      rawInput: { path: "src.txt", offset: 2, limit: 2 },
      content: [{ type: "content", content: { type: "text", text: "beta\ngamma" } }],
    });
    const declaredRead = firstOf(declared, "file_read");
    check(
      "offset/limit declares the range and marks rangeKnown=true",
      declaredRead?.event.type === "file_read" &&
        declaredRead.event.payload.startLine === 2 &&
        declaredRead.event.payload.endLine === 3 &&
        declaredRead.event.payload.rangeKnown === true,
      declaredRead?.event.type === "file_read"
        ? JSON.stringify(declaredRead.event.payload)
        : "no file_read",
    );
    check(
      "the declared range is reported, not disk-verified",
      declaredRead?.fidelity === "reported",
      declaredRead?.fidelity,
    );

    const pathOnlyLocation = await mapper.mapCompletedDetailed({
      toolCallId: "r-path-location",
      name: "read",
      kind: "read",
      locations: [{ path: "src/main.ts" }],
      rawInput: {},
      content: [{ type: "content", content: { type: "text", text: "export const main = 0;" } }],
    });
    const pathOnlyRead = firstOf(pathOnlyLocation, "file_read");
    check(
      "a path-only location still supplies the file path",
      pathOnlyRead?.event.type === "file_read" && pathOnlyRead.event.payload.path === "src/main.ts",
      pathOnlyRead?.event.type === "file_read"
        ? pathOnlyRead.event.payload.path
        : "no file_read",
    );

    const noPath = await mapper.mapCompletedDetailed({
      toolCallId: "r3",
      name: "Read",
      kind: "read",
      content: [{ type: "content", content: { type: "text", text: "body without a path" } }],
    });
    check("a read without a reported path emits nothing", firstOf(noPath, "file_read") === undefined);

    const reconstruct = await mapper.mapCompletedDetailed({
      toolCallId: "e1",
      name: "Update main.ts",
      kind: "edit",
      rawInput: { path: "main.ts", old_string: "return 0;", new_string: "return 1;" },
      content: [{ type: "diff", path: "main.ts", oldText: "return 0;", newText: "return 1;" }],
    });
    const edit = firstOf(reconstruct, "file_edit");
    check(
      "a snippet diff is reconstructed against the whole file on disk",
      edit?.event.type === "file_edit" &&
        edit.event.payload.before.includes("export function main()") &&
        edit.event.payload.after.includes("return 1;") &&
        edit.event.payload.fullContent === undefined,
      edit?.event.type === "file_edit" ? JSON.stringify(edit.event.payload.before) : "no file_edit",
    );
    check("the edit path comes from the reported diff, not invented", edit?.event.type === "file_edit" && edit.event.payload.path === "main.ts");

    await fs.writeFile(path.join(dir, "other.ts"), "unrelated contents\n");
    const snippetOnly = await mapper.mapCompletedDetailed({
      toolCallId: "e2",
      name: "Patch other.ts",
      kind: "edit",
      rawInput: { path: "other.ts", old_string: "old snippet", new_string: "new snippet" },
      content: [{ type: "diff", path: "other.ts", oldText: "old snippet", newText: "new snippet" }],
    });
    const snippet = firstOf(snippetOnly, "file_edit");
    check(
      "when the whole file cannot be reconstructed the event says fullContent=false",
      snippet?.event.type === "file_edit" && snippet.event.payload.fullContent === false,
      snippet?.event.type === "file_edit" ? JSON.stringify(snippet.event.payload) : "no file_edit",
    );
    check(
      "the snippet is not presented as the file's complete content",
      snippet?.event.type === "file_edit" &&
        snippet.event.payload.before === "old snippet" &&
        snippet.event.payload.after === "new snippet" &&
        snippet.event.payload.after !== "unrelated contents\n",
    );

    const wholeOld = "export const value = 1;\nexport const other = 2;\n";
    const wholeNew = "export const value = 3;\nexport const other = 2;\n";
    await fs.writeFile(path.join(dir, "src", "deep.ts"), wholeOld);
    const wholeDiff = await mapper.mapCompletedDetailed({
      toolCallId: "e3",
      name: "Edit",
      kind: "edit",
      content: [{ type: "diff", path: "src/deep.ts", oldText: wholeOld, newText: wholeNew }],
    });
    const whole = firstOf(wholeDiff, "file_edit");
    check(
      "a whole-file diff maps to file_edit with fullContent=true",
      whole?.event.type === "file_edit" && whole.event.payload.fullContent === true,
      whole?.event.type === "file_edit" ? JSON.stringify(whole.event.payload) : "no file_edit",
    );
    check(
      "the whole old/new text is kept verbatim",
      whole?.event.type === "file_edit" &&
        whole.event.payload.before === wholeOld &&
        whole.event.payload.after === wholeNew,
    );
    check(
      "a relative diff path is preserved, not turned absolute",
      whole?.event.type === "file_edit" &&
        whole.event.payload.path === "src/deep.ts" &&
        whole.event.payload.pathRelative === true,
      whole?.event.type === "file_edit" ? whole.event.payload.path : "no file_edit",
    );

    const absPath = path.join(dir, "src", "deep.ts");
    const absDiff = await mapper.mapCompletedDetailed({
      toolCallId: "e4",
      name: "Edit",
      kind: "edit",
      content: [{ type: "diff", path: absPath, oldText: wholeOld, newText: wholeNew }],
    });
    const absEdit = firstOf(absDiff, "file_edit");
    check(
      "an absolute path is not marked pathRelative",
      absEdit?.event.type === "file_edit" && absEdit.event.payload.pathRelative === undefined,
    );
    check(
      "an absolute path inside the project is shown project-relative",
      absEdit?.event.type === "file_edit" && absEdit.event.payload.path === "src/deep.ts",
      absEdit?.event.type === "file_edit" ? absEdit.event.payload.path : "no file_edit",
    );

    const write = await mapper.mapCompletedDetailed({
      toolCallId: "w1",
      name: "write_file",
      kind: "edit",
      rawInput: { path: "notes.md", content: "hello\n" },
    });
    const writeEvent = firstOf(write, "file_write");
    check(
      "an edit with whole content and no old text is file_write",
      writeEvent?.event.type === "file_write" && writeEvent.event.payload.content === "hello\n",
    );

    // A failed call changed nothing on disk. Its output text is a message
    // about the file, never the file itself — recording it would put a version
    // that never existed into the file index.
    const failedEdit = await mapper.mapCompletedDetailed({
      toolCallId: "e-failed",
      name: "edit",
      kind: "edit",
      status: "failed",
      rawInput: { path: "main.ts", edits: [{ oldText: "missing text", newText: "replacement" }] },
      content: [
        {
          type: "content",
          content: { type: "text", text: "Could not find edits[0] in main.ts. The oldText must match exactly." },
        },
      ],
    });
    check("a failed edit records no file version", firstOf(failedEdit, "file_edit") === undefined);

    const failedWrite = await mapper.mapCompletedDetailed({
      toolCallId: "w-failed",
      name: "write_file",
      kind: "edit",
      status: "failed",
      rawInput: { path: "notes.md", content: "hello\n" },
      content: [{ type: "content", content: { type: "text", text: "permission denied" } }],
    });
    check("a failed write records no file version", firstOf(failedWrite, "file_write") === undefined);

    const failedRead = await mapper.mapCompletedDetailed({
      toolCallId: "r-failed",
      name: "read",
      kind: "read",
      status: "failed",
      rawInput: { path: "src.txt" },
      content: [{ type: "content", content: { type: "text", text: "EISDIR: illegal operation on a directory" } }],
    });
    check("a failed read records no file version", firstOf(failedRead, "file_read") === undefined);

    const failedDelete = await mapper.mapCompletedDetailed({
      toolCallId: "d-failed",
      name: "delete",
      kind: "delete",
      status: "failed",
      rawInput: { path: "src.txt" },
    });
    check("a failed delete records no file_change", firstOf(failedDelete, "file_change") === undefined);

    const unknownExit = await mapper.mapCompletedDetailed({
      toolCallId: "c1",
      name: "Run",
      kind: "execute",
      status: "failed",
      rawInput: { command: "fails without a code" },
    });
    const unknownCommand = firstOf(unknownExit, "command");
    check(
      "no rawOutput → fallback exitCode but exitCodeKnown=false",
      unknownCommand?.event.type === "command" &&
        unknownCommand.event.payload.exitCode === 1 &&
        unknownCommand.event.payload.exitCodeKnown === false,
    );
    check(
      "the unknown exit code lowers the fidelity to inferred",
      unknownCommand?.fidelity === "inferred",
      unknownCommand?.fidelity,
    );

    const reportedExit = await mapper.mapCompletedDetailed({
      toolCallId: "c2",
      name: "Run",
      kind: "execute",
      status: "failed",
      rawInput: { command: "node -e process.exit(3)" },
      rawOutput: { exitCode: 3 },
    });
    const reportedCommand = firstOf(reportedExit, "command");
    check(
      "rawOutput.exitCode is reported exactly and not flagged unknown",
      reportedCommand?.event.type === "command" &&
        reportedCommand.event.payload.exitCode === 3 &&
        reportedCommand.event.payload.exitCodeKnown === undefined &&
        reportedCommand.fidelity === "reported",
    );

    const snakeExit = await mapper.mapCompletedDetailed({
      toolCallId: "c2b",
      name: "Run",
      kind: "execute",
      status: "completed",
      rawInput: { command: "echo snake" },
      rawOutput: { exit_code: 4 },
    });
    const snakeCommand = firstOf(snakeExit, "command");
    check(
      "rawOutput.exit_code is honoured when exitCode is absent",
      snakeCommand?.event.type === "command" &&
        snakeCommand.event.payload.exitCode === 4 &&
        snakeCommand.event.payload.exitCodeKnown === undefined,
    );

    const shortExit = await mapper.mapCompletedDetailed({
      toolCallId: "c2c",
      name: "Run",
      kind: "execute",
      status: "completed",
      rawInput: { command: "echo short" },
      rawOutput: { code: 5 },
    });
    const shortCommand = firstOf(shortExit, "command");
    check(
      "rawOutput.code is honoured when the other keys are absent",
      shortCommand?.event.type === "command" &&
        shortCommand.event.payload.exitCode === 5 &&
        shortCommand.event.payload.exitCodeKnown === undefined,
    );

    const priorityExit = await mapper.mapCompletedDetailed({
      toolCallId: "c2d",
      name: "Run",
      kind: "execute",
      status: "completed",
      rawInput: { command: "echo priority" },
      rawOutput: { exitCode: 6, exit_code: 7, code: 8 },
    });
    const priorityCommand = firstOf(priorityExit, "command");
    check(
      "rawOutput.exitCode outranks exit_code and code",
      priorityCommand?.event.type === "command" &&
        priorityCommand.event.payload.exitCode === 6 &&
        priorityCommand.event.payload.exitCodeKnown === undefined,
    );

    const metaExit = await mapper.mapCompletedDetailed({
      toolCallId: "c2e",
      name: "Run",
      kind: "execute",
      status: "completed",
      rawInput: { command: "echo meta" },
      meta: { terminal_exit: { exit_code: 0 } },
    });
    const metaCommand = firstOf(metaExit, "command");
    check(
      "_meta.terminal_exit.exit_code supplies the exit code without rawOutput",
      metaCommand?.event.type === "command" &&
        metaCommand.event.payload.exitCode === 0 &&
        metaCommand.event.payload.exitCodeKnown === undefined,
      metaCommand?.event.type === "command" ? JSON.stringify(metaCommand.event.payload) : "no command",
    );
    check(
      "a _meta exit code is reported, never exact",
      metaCommand?.fidelity === "reported",
      metaCommand?.fidelity,
    );

    const blockMetaExit = await mapper.mapCompletedDetailed({
      toolCallId: "c2f",
      name: "Run",
      kind: "execute",
      status: "completed",
      rawInput: { command: "echo terminal" },
      content: [
        { type: "terminal", terminalId: "term-1", _meta: { terminal_exit: { exit_code: 2 } } },
      ],
    });
    const blockCommand = firstOf(blockMetaExit, "command");
    check(
      "a content block's _meta exit code is read too",
      blockCommand?.event.type === "command" &&
        blockCommand.event.payload.exitCode === 2 &&
        blockCommand.event.payload.exitCodeKnown === undefined,
    );
    check(
      "the terminal block becomes a terminalId reference, not a guessed process",
      blockCommand?.event.type === "command" &&
        blockCommand.event.payload.terminalId === "term-1",
    );
    const terminalOnly = await mapper.mapCompletedDetailed({
      toolCallId: "c2g",
      name: "Run",
      kind: "execute",
      status: "completed",
      rawInput: { command: "echo terminal only" },
      content: [{ type: "terminal", terminalId: "term-2" }],
    });
    const terminalOnlyCommand = firstOf(terminalOnly, "command");
    check(
      "terminalId alone does not invent an exit code",
      terminalOnlyCommand?.event.type === "command" &&
        terminalOnlyCommand.event.payload.exitCodeKnown === false &&
        terminalOnlyCommand.fidelity === "inferred",
      terminalOnlyCommand?.event.type === "command" ? JSON.stringify(terminalOnlyCommand.event.payload) : "no command",
    );

    const aggregated = await mapper.mapCompletedDetailed({
      toolCallId: "c-agg",
      name: "Run",
      kind: "execute",
      status: "completed",
      rawInput: { command: ["pwsh.exe", "-Command", "echo hi"] },
      content: [{ type: "content", content: { type: "text", text: "last-chunk" } }],
      accumulatedOutput: "first-chunklast-chunk",
      rawOutput: { aggregatedOutput: "FULL-OUTPUT", exitCode: 0 },
    });
    const aggregatedCommand = firstOf(aggregated, "command");
    check(
      "rawOutput.aggregatedOutput wins over the last streamed chunk",
      aggregatedCommand?.event.type === "command" &&
        aggregatedCommand.event.payload.stdout === "FULL-OUTPUT" &&
        aggregatedCommand.event.payload.stdout !== "last-chunk",
      aggregatedCommand?.event.type === "command"
        ? JSON.stringify(aggregatedCommand.event.payload.stdout)
        : "no command",
    );
    check(
      "the argv command array reaches the command payload",
      aggregatedCommand?.event.type === "command" &&
        aggregatedCommand.event.payload.command.includes("echo hi"),
      aggregatedCommand?.event.type === "command"
        ? aggregatedCommand.event.payload.command
        : "no command",
    );

    const channels = await mapper.mapCompletedDetailed({
      toolCallId: "c-channels",
      name: "Run",
      kind: "execute",
      status: "completed",
      rawInput: { command: "emit both" },
      rawOutput: { stdout: "out\n", stderr: "err\n", exitCode: 0 },
    });
    const channelsCommand = firstOf(channels, "command");
    check(
      "rawOutput.stdout and rawOutput.stderr stay on their own channels",
      channelsCommand?.event.type === "command" &&
        channelsCommand.event.payload.stdout === "out\n" &&
        channelsCommand.event.payload.stderr === "err\n",
      channelsCommand?.event.type === "command"
        ? JSON.stringify(channelsCommand.event.payload)
        : "no command",
    );

    const accumulated = await mapper.mapCompletedDetailed({
      toolCallId: "c-acc",
      name: "Run",
      kind: "execute",
      status: "completed",
      rawInput: { command: "stream only" },
      content: [{ type: "content", content: { type: "text", text: "last-chunk" } }],
      accumulatedOutput: "first-chunklast-chunk",
    });
    const accumulatedCommand = firstOf(accumulated, "command");
    check(
      "without a final aggregate the accumulated chunks are the output",
      accumulatedCommand?.event.type === "command" &&
        accumulatedCommand.event.payload.stdout === "first-chunklast-chunk",
      accumulatedCommand?.event.type === "command"
        ? JSON.stringify(accumulatedCommand.event.payload.stdout)
        : "no command",
    );

    const truncated = await mapper.mapCompletedDetailed({
      toolCallId: "c-trunc",
      name: "Run",
      kind: "execute",
      status: "completed",
      rawInput: { command: "too much output" },
      accumulatedOutput: "x".repeat(10),
      outputTruncated: true,
    });
    const truncatedCommand = firstOf(truncated, "command");
    check(
      "a capped stream marks the command as truncated",
      truncatedCommand?.event.type === "command" &&
        truncatedCommand.event.payload.truncated === true,
      truncatedCommand?.event.type === "command"
        ? JSON.stringify(truncatedCommand.event.payload)
        : "no command",
    );

    const denied = await mapper.mapCompletedDetailed({
      toolCallId: "c3",
      name: "Run",
      kind: "execute",
      status: "failed",
      rawInput: { command: "rm -rf build" },
      content: [{ type: "content", content: { type: "text", text: "Permission denied by user" } }],
      permissionDenied: true,
    });
    const deniedCommand = firstOf(denied, "command");
    check(
      "a denied permission is expressed as permissionDenied",
      deniedCommand?.event.type === "command" && deniedCommand.event.payload.permissionDenied === true,
      deniedCommand?.event.type === "command" ? JSON.stringify(deniedCommand.event.payload) : "no command",
    );
    check(
      "the denied attempt has no invented exit status",
      deniedCommand?.event.type === "command" &&
        deniedCommand.event.payload.exitCodeKnown === false &&
        deniedCommand.event.payload.exitCode === 1,
    );
    check(
      "the denial text is retained as stderr",
      deniedCommand?.event.type === "command" && deniedCommand.event.payload.stderr.includes("Permission denied"),
    );

    const deniedCompleted = await mapper.mapCompletedDetailed({
      toolCallId: "c4",
      name: "Run",
      kind: "execute",
      status: "completed",
      rawInput: { command: "echo hi" },
      permissionDenied: true,
    });
    const deniedCompletedCommand = firstOf(deniedCompleted, "command");
    check(
      "a denial is not dropped just because the status says completed",
      deniedCompletedCommand?.event.type === "command" &&
        deniedCompletedCommand.event.payload.permissionDenied === true,
    );

    await fs.rm(dir, { recursive: true, force: true });
  }

  section("AcpMonitorProjector: one start, one end, one result");
  {
    const dir = await tempDir();
    const bus = createMonitorBus();
    const received: MonitorEvent[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));
    const window = recordingWindow();
    const projector = new AcpMonitorProjector({
      sessionId: "s1",
      cwd: dir,
      bus,
      commandWindow: window.port,
    });

    const events: MonitorEvent[] = [];
    events.push(
      ...(await projector.project("session/update", {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "Run tests",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "npm test" },
        },
      })),
    );
    events.push(
      ...(await projector.project("session/update", {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "all pass" } }],
          rawOutput: { exitCode: 0 },
        },
      })),
    );
    events.push(
      ...(await projector.project("session/update", {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "duplicate" } }],
        },
      })),
    );

    check("exactly one tool_start", count(events, "tool_start") === 1, String(count(events, "tool_start")));
    check("exactly one tool_end", count(events, "tool_end") === 1, String(count(events, "tool_end")));
    check("exactly one command result", count(events, "command") === 1, String(count(events, "command")));
    check("one window begin", window.log.filter((entry) => entry.phase === "begin").length === 1, JSON.stringify(window.log));
    check("one window end", window.log.filter((entry) => entry.phase === "end").length === 1, JSON.stringify(window.log));
    check("the window carries the reported command", window.log.some((entry) => entry.phase === "begin" && entry.command === "npm test"));
    check("the bus received every returned event", received.length === events.length, `${received.length} vs ${events.length}`);
    check("every projected event says source acp", events.every((event) => event.source === "acp"));
    check(
      "tool_start args come from the protocol rawInput",
      firstOf(events, "tool_start")?.event.type === "tool_start" &&
        JSON.stringify(firstOf(events, "tool_start")?.event.payload.args) === JSON.stringify({ command: "npm test" }),
    );

    const command = firstOf(events, "command");
    check(
      "a reported exit code is kept",
      command?.event.type === "command" &&
        command.event.payload.exitCode === 0 &&
        command.event.payload.exitCodeKnown === undefined &&
        command.fidelity === "reported",
    );
    check("the command output is the reported text", command?.event.type === "command" && command.event.payload.stdout === "all pass");
    check("the duplicate terminal update changed nothing", firstOf(events, "command") === command);

    unsubscribe();
    check("unsubscribe stops delivery", bus.subscribe(() => {}) !== undefined);
    projector.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }

  section("AcpMonitorProjector: terminal tool_call, update-only call, and cancel cleanup");
  {
    const dir = await tempDir();
    const window = recordingWindow();
    const projector = new AcpMonitorProjector({
      sessionId: "s2",
      cwd: dir,
      commandWindow: window.port,
    });

    const direct = await projector.project("session/update", {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "d1",
        title: "Run once",
        kind: "execute",
        status: "failed",
        rawInput: { command: "false" },
      },
    });
    check(
      "a terminal tool_call emits start + end + command once",
      count(direct, "tool_start") === 1 && count(direct, "tool_end") === 1 && count(direct, "command") === 1,
    );
    check(
      "the terminal call's window opened and closed once",
      window.log.filter((entry) => entry.phase === "begin").length === 1 &&
        window.log.filter((entry) => entry.phase === "end").length === 1,
    );
    const failed = firstOf(direct, "command");
    check(
      "an unknown exit code is flagged on the projected command",
      failed?.event.type === "command" && failed.event.payload.exitCodeKnown === false && failed.fidelity === "inferred",
    );

    const updateOnly = await projector.project("session/update", {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "u1",
        title: "Late call",
        kind: "read",
        status: "completed",
        rawInput: { path: "a.ts" },
        content: [{ type: "content", content: { type: "text", text: "a" } }],
      },
    });
    const lateStart = firstOf(updateOnly, "tool_start");
    check(
      "an update-only call is paired, not left as an orphan tool_end",
      count(updateOnly, "tool_start") === 1 && count(updateOnly, "tool_end") === 1,
    );
    check("its start is marked reported, not exact", lateStart?.fidelity === "reported", lateStart?.fidelity);

    const open = await projector.project("session/update", {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "o1",
        title: "Long run",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "sleep 10" },
      },
    });
    check("an in-progress execute opened one window", windowsOf(window.log, "begin") === 2);
    projector.endTurn();
    check("cancelling a turn closes every open window", windowsOf(window.log, "end") === 2, JSON.stringify(window.log));
    check("cancelling invents no tool_end for an unfinished call", count(open, "tool_end") === 0);

    projector.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }

  section("AcpMonitorProjector: agent-reported exit code and terminal reference");
  {
    const dir = await tempDir();
    const projector = new AcpMonitorProjector({ sessionId: "s4", cwd: dir });

    await projector.project("session/update", {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "m1",
        title: "Run node",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "node x.js" },
      },
    });
    const done = await projector.project("session/update", {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "m1",
        status: "completed",
        content: [{ type: "terminal", terminalId: "term-1" }],
        _meta: { terminal_exit: { exit_code: 0 } },
      },
    });
    const command = done.find((event) => event.event.type === "command");
    check(
      "an update-level _meta exit code reaches the command event",
      command?.event.type === "command" &&
        command.event.payload.exitCode === 0 &&
        command.event.payload.exitCodeKnown === undefined,
      command?.event.type === "command" ? JSON.stringify(command.event.payload) : "no command",
    );
    check(
      "the _meta exit code is reported, not exact",
      command?.fidelity === "reported",
      command?.fidelity,
    );
    check(
      "the terminal block is carried as terminalId",
      command?.event.type === "command" && command.event.payload.terminalId === "term-1",
    );
    check(
      "no process or egg is invented from a terminal reference",
      done.every((event) => event.event.type !== "process"),
    );

    projector.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }

  section("AcpMonitorProjector: streamed output accumulates across updates");
  {
    const dir = await tempDir();
    const projector = new AcpMonitorProjector({
      sessionId: "s5",
      cwd: dir,
      now: () => 1,
    });

    await projector.project("session/update", {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "stream",
        title: "Print a long report",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "node big-report.js" },
      },
    });
    const chunks: string[] = [];
    for (let i = 0; i < 60; i++) {
      const chunk = `chunk-${String(i).padStart(2, "0")}-` + "x".repeat(8000);
      chunks.push(chunk);
      await projector.project("session/update", {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "stream",
          status: "in_progress",
          content: [{ type: "content", content: { type: "text", text: chunk } }],
        },
      });
    }
    const full = chunks.join("");

    const done = await projector.project("session/update", {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "stream",
        status: "completed",
        rawOutput: { aggregatedOutput: full, exitCode: 0 },
      },
    });
    const command = firstOf(done, "command");
    check(
      "the final event carries the whole stream, not just the last chunk",
      command?.event.type === "command" && command.event.payload.stdout === full,
      command?.event.type === "command"
        ? `${command.event.payload.stdout.length} chars`
        : "no command",
    );
    check(
      "the last-chunk regression is gone (> 8 KB)",
      command?.event.type === "command" && command.event.payload.stdout.length > 8_000,
      command?.event.type === "command" ? `${command.event.payload.stdout.length}` : "no command",
    );

    const cumulativeProjector = new AcpMonitorProjector({
      sessionId: "s6",
      cwd: dir,
      now: () => 1,
    });
    await cumulativeProjector.project("session/update", {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "cum",
        title: "Cumulative",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "echo abc" },
      },
    });
    for (const text of ["a", "ab", "abc"]) {
      await cumulativeProjector.project("session/update", {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "cum",
          status: "in_progress",
          content: [{ type: "content", content: { type: "text", text } }],
        },
      });
    }
    const cumulativeDone = await cumulativeProjector.project("session/update", {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "cum",
        status: "completed",
        rawOutput: { exitCode: 0 },
      },
    });
    const cumulativeCommand = firstOf(cumulativeDone, "command");
    check(
      "a cumulative chunk replaces the prefix instead of repeating it",
      cumulativeCommand?.event.type === "command" &&
        cumulativeCommand.event.payload.stdout === "abc",
      cumulativeCommand?.event.type === "command"
        ? JSON.stringify(cumulativeCommand.event.payload.stdout)
        : "no command",
    );

    projector.dispose();
    cumulativeProjector.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }

  section("AcpMonitorProjector: plan, mode and text chunks");
  {
    const projector = new AcpMonitorProjector({ sessionId: "s3", cwd: repoRoot });

    const plan = await projector.project("session/update", {
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "do X", status: "pending", priority: "high" }],
      },
    });
    check("a plan becomes one MonitorEvent", plan.length === 1);
    check("the plan is source acp / reported fidelity", plan[0]?.source === "acp" && plan[0]?.fidelity === "reported");
    check(
      "the plan carries the agent's entries verbatim",
      plan[0]?.event.type === "message" &&
        plan[0].event.payload.role === "system" &&
        plan[0].event.payload.content.includes("do X"),
    );

    const mode = await projector.project("session/update", {
      update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
    });
    check("a mode update becomes one exact MonitorEvent", mode.length === 1 && mode[0]?.fidelity === "exact");
    check(
      "the mode id is not paraphrased",
      mode[0]?.event.type === "message" &&
        mode[0].event.payload.role === "system" &&
        mode[0].event.payload.content === "plan",
    );

    const emptyMode = await projector.project("session/update", {
      update: { sessionUpdate: "current_mode_update" },
    });
    check("a mode update without an id is marked unknown", emptyMode[0]?.fidelity === "unknown");

    const message = await projector.project("session/update", {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    });
    check(
      "an agent message chunk is an assistant message",
      message[0]?.event.type === "message" &&
        message[0].event.payload.role === "assistant" &&
        message[0].event.payload.content === "hello" &&
        message[0].fidelity === "exact",
    );

    const thought = await projector.project("session/update", {
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      },
    });
    check("an agent thought chunk is a thinking event", thought[0]?.event.type === "thinking" && thought[0].fidelity === "exact");

    projector.dispose();
  }

  section("static: the mapping never names an agent or imports its SDK");
  {
    const acpDir = path.join(repoRoot, "apps", "server", "src", "agents", "acp");
    const mappingFiles = ["AcpToolMapper.ts", "ToolRules.ts", "toolRules.json"];
    const agentName = /\b(pi|codex|dsh|claude|qwen)\b/i;

    for (const name of mappingFiles) {
      const text = await fs.readFile(path.join(acpDir, name), "utf8");
      check(`${name} has no agent-name branch`, !agentName.test(text), text.match(agentName)?.[0]);
      check(`${name} does not import the Pi SDK`, !text.includes("@earendil-works/pi-coding-agent"));
    }

    const json = JSON.parse(await fs.readFile(path.join(acpDir, "toolRules.json"), "utf8")) as {
      rules: Array<{ id: string; when: Record<string, unknown> }>;
    };
    check(
      "every shipped rule matches on field shape or a protocol content type",
      json.rules.every((rule) => {
        const keys = Object.keys(rule.when);
        return (
          keys.length > 0 &&
          keys.every((key) => key === "anyField" || key === "allFields" || key === "contentType")
        );
      }),
      JSON.stringify(json.rules.map((rule) => rule.when)),
    );
    check(
      "no rule matches on a title or a name pattern",
      json.rules.every((rule) => !("namePattern" in rule.when)),
    );

    const files = await fs.readdir(acpDir);
    const sdkImports: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      const text = await fs.readFile(path.join(acpDir, file), "utf8");
      if (/from\s+["']@earendil-works\/pi-coding-agent/.test(text)) sdkImports.push(file);
    }
    check("no ACP file imports the Pi SDK", sdkImports.length === 0, sdkImports.join(","));

    const adapter = await fs.readFile(path.join(acpDir, "AcpAdapter.ts"), "utf8");
    check(
      "the bridged event carries flat at/source/fidelity, not a nested event copy",
      adapter.includes("at: event.at") &&
        adapter.includes("source: event.source") &&
        adapter.includes("fidelity: event.fidelity") &&
        !/event:\s*event\.event/.test(adapter),
      "nested event copy found",
    );
  }

  finish("acp-mapping");
}

function windowsOf(log: Array<{ phase: string }>, phase: string): number {
  return log.filter((entry) => entry.phase === phase).length;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
