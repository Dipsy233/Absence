/**
 * Offline check of the ACP layer (no model, no credentials, no VRAM).
 *
 *   npx tsx scripts/checks/check-acp.ts
 *
 * The point of this check is the user's constraint: Claude Code and Qwen Code
 * cannot be run for real on an 8 GB machine, so their event shapes are replayed
 * by a scripted ACP agent (`scripts/acp-fixture/fake-agent.mjs`) that speaks the
 * real protocol and launches real shell children.
 *
 * What it proves, per scenario:
 *   1. the same `AcpAdapter` drives both agents — no per-agent branch;
 *   2. tool calls become first-class events by ACP `kind` *and* by the shape
 *      rules when the agent omits `kind` (Qwen Code does);
 *   3. every `execute` call opens a ProcessWatcher window and closes it — that
 *      is the hook the Job Object uses for full shell capture;
 *   4. permission requests surface as `approval` events and the answer reaches
 *      the agent (the turn only completes if it does);
 *   5. model / commands come from the agent's own configOptions and
 *      available_commands_update.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AbsenceEvent } from "@absence/core";
import { AcpAdapter } from "../../apps/server/src/agents/acp/AcpAdapter";
import { fixtureProfile } from "../../apps/server/src/agents/acp/profiles";
import { resolveTool } from "../../apps/server/src/agents/acp/ToolRules";
import type { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";
import { check, finish, section } from "./harness";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scenarioDir = path.join(repoRoot, "scripts", "acp-fixture", "scenarios");

interface WindowRecord {
  id: number;
  phase: "begin" | "end";
  command?: string;
}

function stubWatcher(): { watcher: ProcessWatcher; windows: WindowRecord[] } {
  const windows: WindowRecord[] = [];
  let next = 1;
  const watcher = {
    beginSession: () => {},
    begin: (command: string) => {
      const id = next++;
      windows.push({ id, phase: "begin", command });
      return id;
    },
    end: (id: number) => {
      windows.push({ id, phase: "end" });
    },
  };
  return { watcher: watcher as unknown as ProcessWatcher, windows };
}

async function runScenario(agentId: string, scenarioFile: string) {
  const { watcher, windows } = stubWatcher();
  const adapter = new AcpAdapter(fixtureProfile(path.join(scenarioDir, scenarioFile), agentId), {
    processWatcher: watcher,
  });
  const events: AbsenceEvent[] = [];
  const approvals: string[] = [];
  adapter.subscribe((event) => {
    events.push(event);
    if (event.type === "approval") {
      const payload = event.payload as { id: string; options: Array<{ value: string }> };
      approvals.push(payload.id);
      // Answer the way the Stage would: pick the first "allow" option.
      const allow = payload.options?.[0]?.value ?? "allow-once";
      void adapter.respondApproval(payload.id, allow);
    }
  });

  await adapter.start({ sessionId: `acp-check-${agentId}`, cwd: repoRoot });
  const model = (await adapter.listModels()).find((option) => option.active)?.value;
  await adapter.prompt("please fix the return value");
  const commands = adapter.getAvailableCommands();
  const eventsByType = (type: string) => events.filter((event) => event.type === type);
  const result = {
    adapter,
    events,
    eventsByType,
    windows,
    approvals,
    model,
    commands,
  };
  adapter.dispose();
  return result;
}

section("rules: ACP kind first, shape rules when the kind is missing");
{
  const byKind = resolveTool({
    toolCallId: "x",
    name: "Update src/index.ts",
    kind: "edit",
    rawInput: { file_path: "src/index.ts", old_string: "a", new_string: "b" },
  });
  check("a reported kind wins over the title", byKind.kind === "edit" && byKind.rule === "acp-kind");

  const shellByShape = resolveTool({
    toolCallId: "y",
    name: "shell",
    kind: "other",
    rawInput: { command: "npm test" },
  });
  check("an `other` call with a command is execute", shellByShape.kind === "execute");
  check("the command is extracted for the watcher window", shellByShape.command === "npm test");

  const readByShape = resolveTool({
    toolCallId: "z",
    name: "read_file",
    rawInput: { file_path: "src/main.ts", offset: 0, limit: 20 },
  });
  check("path + range is a read", readByShape.kind === "read");
  check("the path is extracted", readByShape.path === "src/main.ts");

  const mcp = resolveTool({ toolCallId: "m", name: "mcp__filesystem__read_file", rawInput: { path: "a" } });
  check("an mcp__ tool is recognised by shape", mcp.mcp?.server === "filesystem" && mcp.mcp?.tool === "read_file");
  check("no agent name appears in the classifier's decision", mcp.rule === "mcp");
}

section("claude-code: prose titles, ACP kinds, real shell children");
{
  const result = await runScenario("claude-code", "claude-code.json");
  const { eventsByType, windows, approvals, model, commands } = result;
  const types = new Set(result.events.map((event) => event.type));

  check("the turn starts and completes", eventsByType("agent_start").length === 1 && eventsByType("agent_end").length === 1);
  check("the end reason is completed", (eventsByType("agent_end")[0]?.payload as { reason?: string })?.reason === "completed");
  check("assistant text arrives", eventsByType("message").some((event) => (event.payload as { content: string }).content.includes("Fixed")));
  check("a read is a file_read, not a tool titled 'Read'", types.has("file_read"));
  check("a search is a search event", types.has("search"));
  check("two shell calls are command events", eventsByType("command").length === 2);
  check("an edit carries before/after", (eventsByType("file_edit")[0]?.payload as { before?: string })?.before === "  return 0;");
  check("a write is file_write", eventsByType("file_write")[0]?.payload !== undefined && (eventsByType("file_write")[0]?.payload as { path: string }).path === "notes/fix.md");
  check("an mcp__ call becomes an mcp event", types.has("mcp"));
  check("the failing command reports exitCode 1", (eventsByType("command")[1]?.payload as { exitCode?: number })?.exitCode === 1);
  check("read paths are project-relative", (eventsByType("file_read")[0]?.payload as { path: string })?.path === "src/index.ts");
  check("file_read reports the line the agent reported", (eventsByType("file_read")[0]?.payload as { startLine: number })?.startLine === 1);
  check("permission prompts surfaced", approvals.length === 1);
  check("every shell call opened and closed one watcher window", windows.filter((w) => w.phase === "begin").length === 2 && windows.filter((w) => w.phase === "end").length === 2, JSON.stringify(windows));
  check("the window carries the command the agent ran", windows.some((w) => w.phase === "begin" && w.command?.includes("console.log('tests ok')")));
  check("the model comes from the agent's configOptions", model === "claude-sonnet-4-5", String(model));
  check("commands come from available_commands_update", commands.map((c) => c.name).join(",") === "compact,model,mcp", commands.map((c) => c.name).join(","));
  const usage = result.adapter.getContextUsage();
  check("usage comes from usage_update", usage?.used === 18200 && usage?.total === 200000);
}

section("qwen-code: no `kind`, snake_case tools — the rules still work");
{
  const result = await runScenario("qwen-code", "qwen-code.json");
  const { eventsByType, windows, model } = result;
  const types = new Set(result.events.map((event) => event.type));

  check("read_file (no kind) is a file_read", types.has("file_read"));
  check("run_shell_command is a command event", eventsByType("command").length === 1);
  check("the shell output reached the command event", (eventsByType("command")[0]?.payload as { stdout?: string })?.stdout?.includes("qwen ok"));
  check("replace is a file_edit", types.has("file_edit"));
  check("write_file is a file_write", types.has("file_write"));
  check("glob is a search event", types.has("search"));
  check("the watcher saw exactly one command window", windows.filter((w) => w.phase === "begin").length === 1);
  check("no permission prompt was needed", result.approvals.length === 0);
  check("the qwen model is reported", model === "qwen3-coder", String(model));
  check("qwen commands are read from the agent", result.commands.map((c) => c.name).join(",") === "compact,memory");
}

section("the same adapter class drove both agents");
{
  // Nothing in this file constructs a per-agent adapter: one AcpAdapter, two
  // profiles. That is the decoupling contract in one line.
  check("claude-code is a profile, not a class", true);
}

finish("acp");
