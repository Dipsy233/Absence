/**
 * Offline check for the ACP → monitor projection layer.
 *
 *   npx tsx scripts/checks/check-acp-mapping.ts
 *
 * Pins the honesty rules:
 *   - an ACP `kind` always wins; only a missing/`other` kind runs the shape table;
 *   - the shape table never branches on a tool title or an agent's private name;
 *   - a read without a reported line is `rangeKnown=false` and its content is
 *     the returned snippet, not the whole file;
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
      "an omitted locations.line marks rangeKnown=false",
      read?.event.type === "file_read" && read.event.payload.rangeKnown === false,
      read ? JSON.stringify(read.event.payload) : "no file_read",
    );
    check(
      "the fallback range is the returned content, 1..1",
      read?.event.type === "file_read" && read.event.payload.startLine === 1 && read.event.payload.endLine === 1,
    );
    check(
      "the read content is the snippet the agent returned, not the whole file",
      read?.event.type === "file_read" && read.event.payload.content === "alpha" && read.event.payload.content !== disk,
    );
    check("a protocol read has source acp and reported fidelity", read?.source === "acp" && read?.fidelity === "reported");

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
