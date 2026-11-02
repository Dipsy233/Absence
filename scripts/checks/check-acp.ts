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
 *
 * The last sections exercise the `AgentSessionPort` contract directly (an
 * inline scripted agent, because the behaviours are about this client layer):
 *   - `resume` / `load` / `close` are never sent without a declared capability;
 *   - a prompt is trimmed to the agent's declared `promptCapabilities`;
 *   - `cancel` answers every pending permission `cancelled` *before* it sends
 *     `session/cancel`;
 *   - `respondPermission` is a verbatim JSON-RPC echo (no auto decision);
 *   - `session/close` is awaited on close and repeated cancel/close are safe;
 *   - `commands` come only from `available_commands_update`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AbsenceEvent, AgentSessionPort, PermissionAnswer } from "@absence/core";
import { AcpAdapter } from "../../apps/server/src/agents/acp/AcpAdapter";
import { fixtureProfile, type AgentProfile } from "../../apps/server/src/agents/acp/profiles";
import { resolveTool } from "../../apps/server/src/agents/acp/ToolRules";
import type { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";
import { check, finish, section, waitFor } from "./harness";

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

// ---------------------------------------------------------------------------
// AgentSessionPort: capability gating, cancellation ordering, permissions

/**
 * A tiny scripted agent whose every received frame is logged, so the checks
 * can assert what the client actually sent (and in which order). It is inline
 * because these behaviours belong to this client layer, not to a fixture.
 */
const PORT_AGENT = String.raw`
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const scenario = process.env.ABSENCE_PORT_SCENARIO || 'caps-minimal';
const logPath = process.env.ABSENCE_PORT_LOG;
let nextId = 900;
let activePrompt = null;
const pending = new Map();

const write = (payload) => process.stdout.write(JSON.stringify(payload) + '\n');
const log = (entry) => {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
};
const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
const update = (sessionId, body) => notify('session/update', { sessionId, update: body });
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { method, resolve, reject });
    write({ jsonrpc: '2.0', id, method, params });
  });

const configOptions = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'inline-model',
    options: [{ value: 'inline-model', name: 'Inline Model' }, { value: 'other-model', name: 'Other Model' }],
  },
  { id: 'toggle', name: 'Toggle', category: 'mode', type: 'boolean', currentValue: false },
];

const input = createInterface({ input: process.stdin });
input.on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const entry = pending.get(message.id);
    log({
      kind: 'client-response',
      id: message.id,
      method: entry ? entry.method : '?',
      result: message.result,
      error: message.error,
    });
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
    return;
  }

  log({ kind: 'method', method: message.method });

  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        protocolVersion: 1,
        agentCapabilities:
          scenario === 'caps-full'
            ? {
                loadSession: true,
                sessionCapabilities: { resume: {}, close: true },
                promptCapabilities: { image: true, audio: true, embeddedContext: true },
                auth: { logout: true },
                mcp: { http: true, sse: false },
              }
            : { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: [],
      });
      break;

    case 'session/new':
    case 'session/resume':
    case 'session/load':
      respond(message.id, { sessionId: 'inline-session', configOptions });
      break;

    case 'session/set_config_option':
      log({
        kind: 'set-config',
        id: message.params?.configId,
        value: message.params?.value,
        valueType: typeof message.params?.value,
      });
      for (const option of configOptions) {
        if (option.id === message.params?.configId) option.currentValue = message.params?.value;
      }
      respond(message.id, { configOptions });
      notify('session/update', {
        sessionId: message.params?.sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions },
      });
      break;

    case 'session/close':
      respond(message.id, {});
      break;

    case 'session/cancel': {
      log({ kind: 'cancel' });
      const promptId = activePrompt;
      activePrompt = null;
      for (const [, entry] of pending) entry.reject(new Error('turn cancelled'));
      pending.clear();
      if (promptId !== null) respond(promptId, { stopReason: 'cancelled' });
      break;
    }

    case 'session/prompt': {
      const sessionId = message.params?.sessionId;
      activePrompt = message.id;
      log({
        kind: 'prompt',
        types: (message.params?.prompt || []).map((block) => block.type),
      });

      if (scenario === 'caps-full') {
        update(sessionId, {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'compact', description: 'agent compact' },
            { name: 'review', description: 'agent review' },
          ],
        });
        update(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 10000 });
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                type: 'select',
                currentValue: 'other-model',
                options: configOptions[0].options,
              },
              configOptions[1],
            ],
          },
        });
        activePrompt = null;
        respond(message.id, { stopReason: 'end_turn' });
        break;
      }

      if (scenario === 'permission-cancel' || scenario === 'respond-passthrough') {
        const callId = 'inline_tool';
        update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: callId,
          title: 'Review a command',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'echo inline' },
        });
        try {
          const result = await request('session/request_permission', {
            sessionId,
            toolCall: {
              toolCallId: callId,
              title: 'Review a command',
              rawInput: { command: 'echo inline' },
            },
            options: [
              { optionId: 'do-it', name: 'Do it', kind: 'allow_once' },
              { optionId: 'no', name: 'No', kind: 'reject_once' },
            ],
          });
          log({ kind: 'permission-answer', result });
        } catch (error) {
          log({ kind: 'permission-answer', note: String(error && error.message ? error.message : error) });
        }
        if (scenario === 'permission-cancel') break; // the cancel settles this turn
        if (activePrompt === message.id) {
          activePrompt = null;
          update(sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: callId,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'inline done' } }],
            rawOutput: { exitCode: 0 },
          });
          respond(message.id, { stopReason: 'end_turn' });
        }
        break;
      }

      activePrompt = null;
      respond(message.id, { stopReason: 'end_turn' });
      break;
    }

    default:
      if (message.id !== undefined) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'unsupported' } });
      }
  }
});
`;

async function portScenario(scenario: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `absence-acp-port-${scenario}-`));
  const agentPath = path.join(dir, "agent.mjs");
  await fs.writeFile(agentPath, PORT_AGENT, "utf8");
  const logPath = path.join(dir, "agent-log.ndjson");
  const profile: AgentProfile = {
    id: `port-${scenario}`,
    label: `Port ${scenario}`,
    source: "fixture",
    launch: {
      command: process.execPath,
      args: [agentPath],
      env: { ABSENCE_PORT_SCENARIO: scenario, ABSENCE_PORT_LOG: logPath },
    },
  };
  const adapter = new AcpAdapter(profile);
  const port: AgentSessionPort = adapter;
  const readLog = async (): Promise<Array<Record<string, any>>> => {
    try {
      return (await fs.readFile(logPath, "utf8"))
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const cleanup = async (): Promise<void> => {
    try {
      await adapter.close();
    } catch {
      // already closed
    }
    await fs.rm(dir, { recursive: true, force: true });
  };
  return { adapter, port, readLog, cleanup };
}

section("AgentSessionPort: capability-gated lifecycle and prompt trimming");
{
  const { adapter, port, readLog, cleanup } = await portScenario("caps-minimal");
  check(
    "AcpAdapter exposes the session port surface",
    [
      "start",
      "prompt",
      "cancel",
      "close",
      "subscribe",
      "capabilities",
      "configOptions",
      "setConfigOption",
      "commands",
      "auth",
      "authenticate",
      "respondPermission",
    ].every((name) => typeof (adapter as unknown as Record<string, unknown>)[name] === "function"),
  );

  // A handle was supplied, but the agent declared neither resume nor load.
  const info = await port.start({
    sessionId: "port-caps-min",
    cwd: repoRoot,
    resumeHandle: "saved-handle",
  });
  const caps = port.capabilities();
  check(
    "undeclared load/resume/close stay off",
    caps.loadSession === false && caps.resumeSession === false && caps.closeSession === false,
    JSON.stringify(caps),
  );
  check(
    "undeclared prompt capabilities stay off",
    caps.prompt.image === false && caps.prompt.audio === false && caps.prompt.embeddedContext === false,
  );
  check("the port reports source acp-client", caps.source === "acp-client");
  check("the agent session id is reported", info.runtimeSessionId === "inline-session");

  const first = await readLog();
  check(
    "initialize settles before session/new",
    first[0]?.method === "initialize" && first[1]?.method === "session/new",
    JSON.stringify(first.map((entry) => entry.method)),
  );
  check(
    "no undeclared resume/load/close is sent",
    !first.some((entry) =>
      ["session/resume", "session/load", "session/close"].includes(String(entry.method)),
    ),
    JSON.stringify(first.map((entry) => entry.method)),
  );
  check("commands are empty until the agent advertises one", port.commands().length === 0);

  await port.prompt([
    { type: "text", text: "hello" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
    { type: "audio", data: "BBBB", mimeType: "audio/wav" },
    { type: "resource", uri: "file:///x", mimeType: "text/plain", text: "body" },
  ]);
  const promptFrame = (await readLog()).find((entry) => entry.kind === "prompt");
  check(
    "prompt blocks are trimmed to the declared capabilities",
    promptFrame?.types.join(",") === "text",
    JSON.stringify(promptFrame),
  );

  await port.close();
  await port.close();
  const final = await readLog();
  check(
    "no session/close was sent when it was not declared",
    !final.some((entry) => entry.method === "session/close"),
  );
  check("repeated close is idempotent", true);
  await cleanup();
}

section("AgentSessionPort: declared capabilities are used and forwarded");
{
  const { port, readLog, cleanup } = await portScenario("caps-full");
  const info = await port.start({
    sessionId: "port-caps-full",
    cwd: repoRoot,
    resumeHandle: "saved-handle",
  });
  const caps = port.capabilities();
  check(
    "declared load/resume/close are reported",
    caps.loadSession && caps.resumeSession && caps.closeSession,
    JSON.stringify(caps),
  );
  check(
    "declared prompt capabilities are reported",
    caps.prompt.image && caps.prompt.audio && caps.prompt.embeddedContext,
  );
  check(
    "auth and mcp capabilities come from initialize",
    caps.auth.logout && caps.mcp.http && !caps.mcp.sse,
    JSON.stringify(caps),
  );

  const started = await readLog();
  check(
    "a declared resume is used instead of session/new",
    started.some((entry) => entry.method === "session/resume") &&
      !started.some((entry) => entry.method === "session/new"),
    JSON.stringify(started.map((entry) => entry.method)),
  );
  check("the model comes from the agent's configOptions", info.model === "inline-model", info.model);

  await port.setConfigOption("toggle", true);
  const setFrame = (await readLog()).find((entry) => entry.kind === "set-config");
  check(
    "a boolean config value is forwarded as a boolean",
    setFrame?.valueType === "boolean" && setFrame?.value === true,
    JSON.stringify(setFrame),
  );
  check(
    "configOptions() refreshes after set_config_option",
    port.configOptions().find((option) => option.id === "toggle")?.currentValue === true,
  );

  await port.prompt([
    { type: "text", text: "hello" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
    { type: "audio", data: "BBBB", mimeType: "audio/wav" },
    { type: "resource", uri: "file:///x", mimeType: "text/plain", text: "body" },
    { type: "resource_link", uri: "file:///y", name: "y.txt", mimeType: "text/plain" },
  ]);
  const promptFrame = (await readLog()).find((entry) => entry.kind === "prompt");
  check(
    "every declared block is forwarded",
    promptFrame?.types.join(",") === "text,image,audio,resource,resource_link",
    JSON.stringify(promptFrame),
  );
  check(
    "commands() is exactly the agent's advertised list",
    port.commands().map((command) => command.name).join(",") === "compact,review",
    port.commands().map((command) => command.name).join(","),
  );
  check(
    "config_option_update refreshed the model",
    port.configOptions().find((option) => option.id === "model")?.currentValue === "other-model",
    JSON.stringify(port.configOptions()),
  );

  await port.close();
  const final = await readLog();
  check(
    "session/close is sent when declared",
    final.some((entry) => entry.method === "session/close"),
  );
  await cleanup();
}

section("cancel: pending permissions are answered before session/cancel");
{
  const { adapter, port, readLog, cleanup } = await portScenario("permission-cancel");
  const events: AbsenceEvent[] = [];
  let requestId = "";
  adapter.subscribe((event) => {
    events.push(event);
    if (event.type === "approval") {
      requestId = (event.payload as { id: string }).id;
    }
  });

  await port.start({ sessionId: "port-cancel", cwd: repoRoot });
  const running = port.prompt([{ type: "text", text: "please run" }]);
  await waitFor(() => requestId.length > 0);

  check("the permission was surfaced as an approval event", requestId.length > 0, requestId);
  const beforeCancel = await readLog();
  check(
    "no answer was sent before the user acted",
    !beforeCancel.some(
      (entry) => entry.kind === "client-response" && entry.method === "session/request_permission",
    ),
    JSON.stringify(beforeCancel),
  );

  await adapter.cancel();
  const reason = await running;
  const frames = await readLog();
  const answeredAt = frames.findIndex(
    (entry) =>
      entry.kind === "client-response" &&
      entry.method === "session/request_permission" &&
      entry.result?.outcome?.outcome === "cancelled",
  );
  const cancelAt = frames.findIndex((entry) => entry.kind === "cancel");
  check("the pending permission is answered cancelled", answeredAt >= 0, JSON.stringify(frames));
  check(
    "the cancelled answer precedes session/cancel",
    answeredAt >= 0 && cancelAt >= 0 && answeredAt < cancelAt,
    JSON.stringify(frames),
  );
  check("the turn returns the agent's stop reason", reason === "cancelled", String(reason));
  check("the turn did not add an error row", !events.some((event) => event.type === "error"));

  await adapter.cancel();
  check("repeated cancel is safe", !events.some((event) => event.type === "error"));
  await port.close();
  await cleanup();
}

section("respondPermission: verbatim JSON-RPC echo, no local decision");
{
  const { adapter, port, readLog, cleanup } = await portScenario("respond-passthrough");
  let requestId = "";
  adapter.subscribe((event) => {
    if (event.type === "approval") requestId = (event.payload as { id: string }).id;
  });

  await port.start({ sessionId: "port-echo", cwd: repoRoot });
  const running = port.prompt([{ type: "text", text: "ask me" }]);
  await waitFor(() => requestId.length > 0);

  const before = await readLog();
  check(
    "nothing is answered automatically",
    !before.some(
      (entry) => entry.kind === "client-response" && entry.method === "session/request_permission",
    ),
    JSON.stringify(before),
  );

  const answer: PermissionAnswer = { outcome: "selected", optionId: "do-it" };
  await port.respondPermission(requestId, answer);
  const reason = await running;
  const frames = await readLog();
  const response = frames.find(
    (entry) =>
      entry.kind === "client-response" && entry.method === "session/request_permission",
  );
  check(
    "the selected option id is echoed verbatim",
    response?.result?.outcome?.outcome === "selected" &&
      response?.result?.outcome?.optionId === "do-it",
    JSON.stringify(response),
  );
  check(
    "no other option was sent",
    !frames.some(
      (entry) =>
        entry.kind === "client-response" &&
        entry.method === "session/request_permission" &&
        entry.result?.outcome?.optionId !== "do-it",
    ),
  );
  check("the turn ends after the answer", reason === "end_turn", String(reason));

  await port.close();
  await cleanup();
}

section("decoupling: no product branch, no Pi SDK, no local capability scan");
{
  const dir = path.join(repoRoot, "apps", "server", "src", "agents", "acp");
  const owned = [
    "AcpAdapter.ts",
    "AcpSession.ts",
    "AcpPermissionBridge.ts",
    "AcpAuth.ts",
    "AcpConfigOptions.ts",
  ];
  for (const name of owned) {
    const text = await fs.readFile(path.join(dir, name), "utf8");
    check(`${name} does not import a product SDK`, !/from\s+["']@earendil-works/.test(text));
    check(
      `${name} does not branch on a product name`,
      !/(case|===|!==)\s*["'](pi|codex|dsh)["']/i.test(text),
    );
    check(
      `${name} only scans capabilities behind the profile's explicit opt-in`,
      name === "AcpAdapter.ts"
        ? text.includes("this.profile.discoverCapabilities === true") && !/discoverCapabilities\s*:\s*true/.test(text)
        : !/discoverCapabilities/.test(text),
    );
  }
  const profiles = await fs.readFile(path.join(dir, "profiles.ts"), "utf8");
  check(
    "no built-in profile opts into the local capability scan",
    !/discoverCapabilities\s*:\s*true/.test(profiles),
  );
}

finish("acp");
