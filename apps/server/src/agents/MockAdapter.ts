import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
  type CommandOption,
  type ContextState,
  type AbsenceEvent,
  type AbsenceEventPayloadMap,
  type AbsenceEventType,
  type SessionStatsInfo,
} from "@absence/core";
import { BaseAdapter, type AdapterOptions, type AgentStartContext, type AgentStartResult } from "./AgentAdapter";
import { loadPiSdk } from "./PiBin";
import { config } from "../config";
import { createAbsenceShell } from "../process/AbsenceShell";
import { readFileSafe, scanCodeFiles } from "../filesystem/FileTree";
import { unifiedDiff } from "../util/diff";
import { languageFromPath } from "../util/language";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PREFERRED = /(app|index|main|auth|api|server|client|utils|user|login|config)\./i;

/**
 * A scripted runtime used for development and demos (read.md Phase 0/1).
 * It reads real files from the project so the Stage shows real content,
 * and paces events the way a real agent would.
 *
 * Its shell command is real too: it goes through the same Absence shell the Pi
 * runtime uses, so the process watcher reports eggs with no credentials needed.
 */
export class MockAdapter extends BaseAdapter {
  readonly runtime = "mock";
  private model = "mock/agent";
  private aborted = false;
  private busy = false;
  private thinkingLevel = "medium";
  private name?: string;
  private tokensUsed = 0;
  private shell?: BashOperations;

  constructor(private readonly options: AdapterOptions = { tools: [] }) {
    super();
  }

  async start(ctx: AgentStartContext): Promise<AgentStartResult> {
    this.sessionId = ctx.sessionId;
    this.cwd = ctx.cwd;
    this.model = ctx.model ?? "mock/agent";
    return { model: this.model };
  }

  getContextUsage(): ContextState | undefined {
    this.tokensUsed = Math.min(this.tokensUsed + 1400, 128_000);
    return { used: this.tokensUsed, total: 128_000 };
  }

  // --- command surface (stubs so the terminal box works without credentials) --

  async listModels(): Promise<CommandOption[]> {
    return [
      { value: "mock/agent", label: "Mock Agent", description: "scripted runtime", active: this.model === "mock/agent" },
      { value: "mock/fast", label: "Mock Fast", description: "scripted runtime", active: this.model === "mock/fast" },
    ];
  }

  async setModel(value: string): Promise<string> {
    this.model = value;
    return this.model;
  }

  getThinking(): { level: string; available: string[] } {
    return { level: this.thinkingLevel, available: ["off", "low", "medium", "high"] };
  }

  async setThinking(level: string): Promise<string> {
    this.thinkingLevel = level;
    return this.thinkingLevel;
  }

  getSessionName(): string | undefined {
    return this.name;
  }

  setSessionName(name: string): void {
    this.name = name;
  }

  getSessionStats(): SessionStatsInfo {
    const used = Math.round(this.tokensUsed);
    return {
      sessionId: this.sessionId,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: used },
      cost: 0,
      contextUsed: used,
      contextTotal: 128_000,
    };
  }

  async compact(instructions?: string): Promise<{ tokensBefore?: number; estimatedTokensAfter?: number }> {
    const before = Math.round(this.tokensUsed);
    void instructions;
    return { tokensBefore: before, estimatedTokensAfter: Math.round(before * 0.3) };
  }

  async exportSession(format: "html" | "jsonl"): Promise<string> {
    const dir = path.join(os.homedir(), ".absence", "exports");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${this.sessionId || "mock"}.${format}`);
    await fs.writeFile(file, `ABSENCE mock export (${format}) for session ${this.sessionId}\n`, "utf-8");
    return file;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Absence's shell when a watcher is present, else Pi's plain local shell. */
  private async shellOperations(): Promise<BashOperations> {
    if (this.shell) return this.shell;
    const { sdk } = await loadPiSdk(config.piBin);
    if (this.options.processWatcher) {
      this.shell = (
        await createAbsenceShell(this.options.processWatcher, {
          createLocalBashOperations: sdk.createLocalBashOperations,
          createLocalPowerShellOperations: sdk.createLocalPowerShellOperations,
        })
      ).bash;
    } else {
      this.shell = sdk.createLocalBashOperations();
    }
    return this.shell;
  }

  /** Run a command for real and collect its output, the way Pi's tool does. */
  private async runCommand(command: string): Promise<{ stdout: string; exitCode: number }> {
    const chunks: Buffer[] = [];
    try {
      const shell = await this.shellOperations();
      const { exitCode } = await shell.exec(command, this.cwd, {
        onData: (data) => chunks.push(data),
        timeout: 20_000,
      });
      return { stdout: Buffer.concat(chunks).toString("utf8"), exitCode: exitCode ?? -1 };
    } catch (error) {
      const partial = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: `${partial}${message}`, exitCode: -1 };
    }
  }

  async prompt(_text: string): Promise<void> {
    this.aborted = false;
    this.busy = true;
    const emit = <K extends AbsenceEventType>(type: K, payload: AbsenceEventPayloadMap[K]) =>
      this.emitAbsence(type, payload);

    const bail = () => this.aborted;

    emit("agent_start", { model: this.model });
    await sleep(300);
    if (bail()) return this.finish("aborted");

    emit("thinking", { content: "Getting oriented in the project…", streaming: true });
    await sleep(450);

    const allFiles = await scanCodeFiles(this.cwd, 40);
    const picks = selectFiles(allFiles, 3);

    for (const rel of picks) {
      if (bail()) return this.finish("aborted");
      const abs = path.join(this.cwd, rel);
      const content = (await readFileSafe(abs)) ?? "";
      const lines = content.split("\n");
      const endLine = Math.min(lines.length, 140);
      const shown = lines.slice(0, endLine).join("\n");
      const toolCallId = `mock_read_${rel}`;

      emit("tool_start", { toolCallId, toolName: "read", args: { path: rel } });
      await sleep(180);
      emit("file_read", {
        path: rel,
        startLine: 1,
        endLine,
        content: shown,
        language: languageFromPath(rel),
      });
      this.tokensUsed += Math.min(shown.length / 4, 3000);
      await sleep(620);
      emit("tool_end", { toolCallId, toolName: "read", isError: false });
      // A real agent spends a moment reading the result before the next tool.
      await sleep(400);
    }

    if (bail()) return this.finish("aborted");

    // A search.
    const grepId = "mock_grep_1";
    emit("tool_start", { toolCallId: grepId, toolName: "grep", args: { pattern: "function", path: "." } });
    await sleep(200);
    const grepHits = allFiles.slice(0, 6);
    emit("search", {
      tool: "grep",
      query: "function",
      scope: ".",
      matches: grepHits.length,
      output: grepHits.map((f) => `${f}:1: export function …`).join("\n") || "(no matches)",
    });
    this.tokensUsed += 400;
    await sleep(600);
    emit("tool_end", { toolCallId: grepId, toolName: "grep", isError: false });
    await sleep(400);

    if (bail()) return this.finish("aborted");

    // A shell command. Really run, through the same shell Pi's bash tool uses,
    // so the process watcher sees the evidence it would see from Pi.
    const listing = allFiles.slice(0, 12).map((f) => `  ${f}`).join("\n");
    const shortCommand = "ls -la";
    const bashId = "mock_bash_1";
    emit("tool_start", { toolCallId: bashId, toolName: "bash", args: { command: shortCommand } });
    const ran = await this.runCommand(shortCommand);
    // A project with no shell (or a machine without bash) still gets a demo.
    const usable = ran.stdout.trim().length > 0;
    emit("command", {
      command: shortCommand,
      stdout: usable ? ran.stdout : `total ${allFiles.length}\n${listing}\n`,
      stderr: "",
      exitCode: usable ? ran.exitCode : 0,
    });
    await sleep(700);
    emit("tool_end", { toolCallId: bashId, toolName: "bash", isError: false });
    await sleep(400);

    if (bail()) return this.finish("aborted");

    // Processes, so the Agent Eggs panel has something real to show without Pi
    // credentials — and both kinds of egg:
    //   • one left running (it exits on its own after a minute),
    //   • one that lives and dies *inside* the command, which is only visible
    //     because Absence samples while the command is still running.
    // Absence reports what the agent started; it never kills anything.
    const serverCommand = `(node -e "setTimeout(()=>{},60000)" &); node -e "setTimeout(()=>{},6000)"`;
    const serverId = "mock_bash_server";
    emit("tool_start", { toolCallId: serverId, toolName: "bash", args: { command: serverCommand } });
    const laid = await this.runCommand(serverCommand);
    emit("command", {
      command: serverCommand,
      stdout: laid.stdout.trim().length > 0 ? laid.stdout : "(one process left running, one that exits after 6s)\n",
      stderr: "",
      exitCode: laid.exitCode,
    });
    await sleep(600);
    emit("tool_end", { toolCallId: serverId, toolName: "bash", isError: false });
    await sleep(400);

    if (bail()) return this.finish("aborted");

    // Two edits on the same file, so File History and Replay have versions.
    const target = picks.find((p) => /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php)$/.test(p)) ?? picks[0];
    if (target) {
      const abs = path.join(this.cwd, target);
      const original = (await readFileSafe(abs)) ?? "";
      if (original.length > 0 && original.length < 60_000) {
        let current = original;
        for (let round = 1; round <= 2; round++) {
          if (bail()) return this.finish("aborted");
          const next = injectEdit(current, target, round);
          const editId = `mock_edit_${round}`;
          emit("tool_start", { toolCallId: editId, toolName: "edit", args: { path: target } });
          await sleep(220);
          emit("file_edit", {
            path: target,
            before: current,
            after: next,
            diff: unifiedDiff(current, next, target, target),
          });
          await sleep(800);
          emit("tool_end", { toolCallId: editId, toolName: "edit", isError: false });
          await sleep(400);
          current = next;
        }
      }
    }

    if (bail()) return this.finish("aborted");

    // 5) create a brand new file, so History shows a created-file count.
    const newPath = "notes/agent-summary.md";
    const newContent = [
      "# Agent summary",
      "",
      `Read: ${picks.join(", ") || "nothing"}`,
      "",
      "Written by the mock runtime.",
    ].join("\n");
    const writeId = "mock_write_new";
    emit("tool_start", { toolCallId: writeId, toolName: "write", args: { path: newPath } });
    await sleep(220);
    emit("file_write", { path: newPath, content: newContent });
    this.tokensUsed += Math.min(newContent.length / 4, 800);
    await sleep(600);
    emit("tool_end", { toolCallId: writeId, toolName: "write", isError: false });
    await sleep(400);

    // Final assistant message, streamed.
    emit("thinking", { content: "Writing up what I found…", streaming: true });
    await sleep(300);
    const answer =
      `I looked through the project and read ${picks.length} file${picks.length === 1 ? "" : "s"} ` +
      `(${picks.join(", ")}). Nothing looks obviously broken — I made one small edit as a demonstration. ` +
      `Ask me to dig into anything specific.`;
    let acc = "";
    for (const chunk of chunkText(answer, 18)) {
      if (bail()) return this.finish("aborted");
      acc += chunk;
      emit("message", { role: "assistant", content: acc, delta: chunk, streaming: true });
      await sleep(60);
    }
    emit("message", { role: "assistant", content: answer, streaming: false });
    this.finish("completed");
  }

  private finish(reason: string): void {
    this.busy = false;
    this.emitAbsence("agent_end", { reason });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.busy = false;
  }

  dispose(): void {
    this.aborted = true;
    this.busy = false;
  }
}

function selectFiles(files: string[], count: number): string[] {
  const preferred = files.filter((f) => PREFERRED.test(path.basename(f)));
  const rest = files.filter((f) => !preferred.includes(f));
  return [...preferred, ...rest].slice(0, count);
}

function injectEdit(content: string, filePath: string, round = 1): string {
  const comment =
    languageFromPath(filePath) === "markdown"
      ? `<!-- reviewed by absence · pass ${round} -->`
      : `// reviewed by absence · pass ${round}`;
  const lines = content.split("\n");
  const head = lines[0]?.startsWith("#!") ? 1 : 0;
  lines.splice(head, 0, comment);
  return lines.join("\n");
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}
