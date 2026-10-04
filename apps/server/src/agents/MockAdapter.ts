import path from "node:path";
import {
  type ContextState,
  type DazeEvent,
  type DazeEventPayloadMap,
  type DazeEventType,
} from "@daze/core";
import { BaseAdapter, type AgentStartContext, type AgentStartResult } from "./AgentAdapter";
import { readFileSafe, scanCodeFiles } from "../filesystem/FileTree";
import { unifiedDiff } from "../util/diff";
import { languageFromPath } from "../util/language";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PREFERRED = /(app|index|main|auth|api|server|client|utils|user|login|config)\./i;

/**
 * A scripted runtime used for development and demos (read.md Phase 0/1).
 * It reads real files from the project so the Stage shows real content,
 * and paces events the way a real agent would.
 */
export class MockAdapter extends BaseAdapter {
  readonly runtime = "mock";
  private model = "mock/agent";
  private aborted = false;
  private tokensUsed = 0;

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

  async prompt(_text: string): Promise<void> {
    this.aborted = false;
    const emit = <K extends DazeEventType>(type: K, payload: DazeEventPayloadMap[K]) =>
      this.emitDaze(type, payload);

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

    // A shell command.
    const listing = allFiles.slice(0, 12).map((f) => `  ${f}`).join("\n");
    const bashId = "mock_bash_1";
    emit("tool_start", { toolCallId: bashId, toolName: "bash", args: { command: "ls -la" } });
    await sleep(200);
    emit("command", {
      command: "ls -la",
      stdout: `total ${allFiles.length}\n${listing}\n`,
      stderr: "",
      exitCode: 0,
    });
    await sleep(700);
    emit("tool_end", { toolCallId: bashId, toolName: "bash", isError: false });
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
    this.emitDaze("agent_end", { reason });
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  dispose(): void {
    this.aborted = true;
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
      ? `<!-- reviewed by daze · pass ${round} -->`
      : `// reviewed by daze · pass ${round}`;
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
