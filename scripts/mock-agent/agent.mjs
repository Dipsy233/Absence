#!/usr/bin/env node
/**
 * agent.mjs — a scenario-driven ACP agent, for supervising Absence itself.
 *
 * It speaks real Agent Client Protocol over stdio (NDJSON JSON-RPC) and plays a
 * JSON scenario: thoughts, streamed messages, tool calls, real file writes, real
 * child processes, approvals, usage, cancellation. It needs no model, no
 * credentials and no VRAM, which is the point: on an 8 GB machine the event
 * shapes of Claude Code / Qwen Code / Codex cannot be produced by running them.
 *
 * Two things are deliberately separate:
 *
 *   • the *input* side is this file — it only emits protocol frames;
 *   • the *observation* side is scripts/mock-agent/run.ts — it watches what
 *     Absence normalised those frames into, and asserts against it.
 *
 * The protocol trace (`ABSENCE_MOCK_TRACE`) records what this side sent and
 * received, without the large payloads; the runner writes the Absence events
 * beside it. A scenario can therefore be debugged from both ends.
 *
 * Usage:
 *   ABSENCE_MOCK_SCENARIO=<scenario.json> node agent.mjs
 *
 * Nothing here knows about a product. A new agent shape is a new scenario.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const agentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(agentDir, "..", "..");
const scenarioArg = process.env.ABSENCE_MOCK_SCENARIO ?? process.argv[2];
if (!scenarioArg) {
  process.stderr.write("ABSENCE_MOCK_SCENARIO is required\n");
  process.exit(2);
}

const scenarioPath = path.resolve(scenarioArg);
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const cwd = process.cwd();
const tracePath = process.env.ABSENCE_MOCK_TRACE;
const traceFull = process.env.ABSENCE_MOCK_TRACE_FULL === "1";

let nextRequestId = 900;
const pending = new Map();
let cancelRequested = false;
let turnActive = false;
let toolSequence = 0;
const activeChildren = new Set();
const backgroundChildren = new Set();

const session = {
  id: `${scenario.sessionId ?? `mock-${scenario.id ?? "agent"}`}-${Math.random().toString(36).slice(2, 7)}`,
  configOptions: clone(scenario.init?.configOptions ?? []),
  commandsSent: false,
};

const DEFAULT_PERMISSION_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Deny", kind: "reject_once" },
];

class Cancelled extends Error {}

// ---------------------------------------------------------------------------
// transport

const writeLine = (value) => {
  try {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } catch {
    // The client went away; the exit handler settles whatever was pending.
  }
};

function summarizeUpdate(update) {
  if (!update || typeof update !== "object") return { update: "?" };
  const summary = { update: update.sessionUpdate };
  if (update.toolCallId) summary.toolCallId = String(update.toolCallId);
  if (update.title) summary.title = String(update.title).slice(0, 120);
  if (update.kind) summary.toolKind = String(update.kind);
  if (update.status) summary.status = String(update.status);
  if (update.messageId) summary.messageId = String(update.messageId);
  if (update.sessionUpdate === "usage_update") {
    summary.used = update.used;
    summary.size = update.size;
  }
  const chars = contentChars(update.content);
  if (chars > 0) summary.contentChars = chars;
  if (Array.isArray(update.content) && update.content.some((block) => block?.type === "diff")) {
    summary.hasDiff = true;
  }
  if (update.rawInput !== undefined) {
    summary.rawInputChars = safeLength(update.rawInput);
  }
  if (update.rawOutput !== undefined) {
    summary.rawOutputChars = safeLength(update.rawOutput);
  }
  if (Array.isArray(update.availableCommands)) summary.commands = update.availableCommands.length;
  if (Array.isArray(update.configOptions)) summary.configOptions = update.configOptions.length;
  return summary;
}

function trace(entry) {
  if (!tracePath) return;
  try {
    fs.appendFileSync(tracePath, `${JSON.stringify({ t: Date.now(), ...entry })}\n`, "utf8");
  } catch {
    // A trace must never be why the agent fails.
  }
}

function traceOut(payload) {
  if (!tracePath) return;
  if (payload.method === "session/update") {
    trace({ dir: "out", kind: "update", ...summarizeUpdate(payload.params?.update) });
    return;
  }
  if (payload.method) {
    trace({ dir: "out", kind: "request", method: payload.method, id: payload.id });
    return;
  }
  trace({
    dir: "out",
    kind: payload.error ? "error" : "response",
    id: payload.id,
    stopReason: payload.result?.stopReason,
    error: payload.error?.message,
    resultChars: traceFull ? safeLength(payload.result) : undefined,
  });
}

const send = (payload) => {
  traceOut(payload);
  writeLine(payload);
};

const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const respondError = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const notifyUpdate = (update, sessionId = session.id) =>
  notify("session/update", { sessionId, update });

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

// ---------------------------------------------------------------------------
// main loop

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  // A response to one of our own requests (the permission answer).
  if (message.id !== undefined && message.method === undefined) {
    const entry = pending.get(message.id);
    trace({
      dir: "in",
      kind: message.error ? "error" : "response",
      id: message.id,
      error: message.error?.message,
    });
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? "agent request failed"));
    else entry.resolve(message.result);
    return;
  }

  trace({ dir: "in", kind: "request", method: message.method, id: message.id });

  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: scenario.init?.protocolVersion ?? 1,
        agentCapabilities: scenario.init?.agentCapabilities ?? {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        authMethods: scenario.init?.authMethods ?? [],
      });
      trace({
        dir: "meta",
        event: "initialize",
        scenario: scenario.id,
        cwd,
        systemPromptChars: scenario.init?.systemPromptChars ?? 0,
        systemPromptTokens: scenario.init?.systemPromptTokens ?? 0,
        contextWindow: scenario.init?.contextWindow ?? 0,
      });
      break;

    case "session/new":
      void createSession(message.id, message.params).catch((error) =>
        respondError(message.id, String(error?.message ?? error)),
      );
      break;

    case "session/resume":
    case "session/load":
      void createSession(message.id, message.params, message.params?.sessionId).catch((error) =>
        respondError(message.id, String(error?.message ?? error)),
      );
      break;

    case "session/prompt":
      if (turnActive) {
        respondError(message.id, "mock agent is busy with another turn");
        break;
      }
      void runTurn(message.id, message.params).catch((error) =>
        respondError(message.id, String(error?.message ?? error)),
      );
      break;

    case "session/cancel":
      requestCancel();
      break;

    case "session/set_config_option": {
      const target = session.configOptions.find((option) => option.id === message.params?.configId);
      if (target) target.currentValue = message.params?.value;
      notifyUpdate(
        { sessionUpdate: "config_option_update", configOptions: clone(session.configOptions) },
        message.params?.sessionId,
      );
      respond(message.id, { configOptions: clone(session.configOptions) });
      break;
    }

    case "session/close":
      requestCancel();
      respond(message.id, {});
      break;

    default:
      if (message.id !== undefined) respondError(message.id, `unsupported method: ${message.method}`);
  }
});

input.on("close", () => {
  requestCancel();
  // The client is gone; nothing this agent spawned should outlive it.
  for (const child of activeChildren) killTree(child);
  process.exit(0);
});

async function createSession(id, params, resumeId) {
  const init = scenario.init ?? {};
  if (typeof init.sessionDelayMs === "number" && init.sessionDelayMs > 0) {
    await sleep(init.sessionDelayMs);
  }
  if (resumeId) session.id = String(resumeId);
  respond(id, {
    sessionId: session.id,
    configOptions: clone(session.configOptions),
  });

  // These arrive just after the response, the way an adapter that pre-fills its
  // context or advertises commands does during session setup.
  const sessionId = params?.sessionId ?? session.id;
  if (init.usageOnCreate) {
    setTimeout(() => notifyUpdate({ sessionUpdate: "usage_update", ...init.usageOnCreate }, sessionId), 10);
  }
  if (Array.isArray(scenario.commands)) {
    setTimeout(
      () => notifyUpdate({ sessionUpdate: "available_commands_update", availableCommands: scenario.commands }, sessionId),
      10,
    );
  }
  if (init.plan) {
    setTimeout(() => notifyUpdate({ sessionUpdate: "plan", plan: init.plan }, sessionId), 10);
  }
}

async function runTurn(id, params) {
  turnActive = true;
  cancelRequested = false;
  const promptText = promptToText(params?.prompt);
  const turn = pickTurn(promptText);
  const update = (payload) => notifyUpdate(payload, params?.sessionId);

  trace({
    dir: "in",
    kind: "prompt",
    promptChars: promptText.length,
    promptPreview: promptText.slice(0, 80),
    turn: turn.name ?? turn.match ?? "(default)",
  });

  try {
    if (scenario.init?.usageOnPrompt) {
      update({ sessionUpdate: "usage_update", ...scenario.init.usageOnPrompt });
    }
    if (!session.commandsSent && Array.isArray(scenario.commands)) {
      session.commandsSent = true;
      update({ sessionUpdate: "available_commands_update", availableCommands: scenario.commands });
    }

    for (const step of turn.steps ?? []) {
      throwIfCancelled();
      await runStep(step, update);
    }
    throwIfCancelled();
    respond(id, { stopReason: turn.stopReason ?? "end_turn" });
  } catch (error) {
    if (error instanceof Cancelled || cancelRequested) {
      respond(id, { stopReason: "cancelled" });
      return;
    }
    throw error;
  } finally {
    turnActive = false;
    cancelRequested = false;
  }
}

// ---------------------------------------------------------------------------
// steps

async function runStep(step, update) {
  const type = step.type ?? inferType(step);
  switch (type) {
    case "thought":
    case "message": {
      const role = type;
      const text = expandText(step);
      const chunkSize = Math.max(1, Number(step.chunk ?? (role === "thought" ? 24 : 18)));
      const delay = Math.max(0, Number(step.delay ?? (role === "thought" ? 15 : 12)));
      const messageId = step.messageId ?? `msg_${Math.random().toString(36).slice(2, 8)}`;
      for (let offset = 0; offset < text.length; offset += chunkSize) {
        throwIfCancelled();
        const chunk = text.slice(offset, offset + chunkSize);
        update(
          role === "thought"
            ? { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: chunk } }
            : {
                sessionUpdate: "agent_message_chunk",
                messageId,
                content: { type: "text", text: chunk },
              },
        );
        if (delay > 0) await sleep(delay);
      }
      break;
    }

    case "tool":
      await runToolStep(step, update);
      break;

    case "parallel": {
      const results = await Promise.allSettled((step.steps ?? []).map((inner) => runStep(inner, update)));
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      break;
    }

    case "permission": {
      await requestPermission(
        step.toolCallId ?? `perm_${++toolSequence}`,
        step,
        step.title ?? "Run a tool",
        step.rawInput ?? {},
      );
      break;
    }

    case "usage":
      update({
        sessionUpdate: "usage_update",
        used: Number(step.used ?? 0),
        size: Number(step.size ?? 0),
      });
      break;

    case "commands":
      update({
        sessionUpdate: "available_commands_update",
        availableCommands: step.commands ?? scenario.commands ?? [],
      });
      break;

    case "config":
      update({
        sessionUpdate: "config_option_update",
        configOptions: step.configOptions ?? session.configOptions,
      });
      break;

    case "sessionInfo":
      update({
        sessionUpdate: "session_info_update",
        title: step.title,
        updatedAt: step.updatedAt ?? new Date().toISOString(),
      });
      break;

    case "plan":
      update({ sessionUpdate: "plan", plan: step.plan ?? { entries: [] } });
      break;

    case "raw":
      update(step.update ?? {});
      break;

    case "delay":
      await sleepCancellable(Number(step.ms ?? 50));
      break;

    default:
      // An unknown step is a scenario bug, not an agent failure. Say so in the
      // trace and keep going, so one typo does not hide every later assertion.
      trace({ dir: "meta", event: "unknown-step", type: String(type) });
      break;
  }
}

async function runToolStep(step, update) {
  const callId = String(step.toolCallId ?? `tool_${++toolSequence}`);
  const relPath =
    step.path ??
    step.filePath ??
    step.readFile?.path ??
    step.writeFile?.path ??
    step.editFile?.path ??
    step.rawInput?.file_path ??
    step.rawInput?.path;
  const title = step.title ?? step.kind ?? "tool";
  const rawInput = step.rawInput ?? deriveRawInput(step, relPath);
  const locations = step.locations ?? (relPath ? [{ path: String(relPath), line: Number(step.startLine ?? 1) }] : undefined);

  update({
    sessionUpdate: "tool_call",
    toolCallId: callId,
    title,
    status: step.startStatus ?? "pending",
    rawInput,
    ...(step.kind ? { kind: step.kind } : {}),
    ...(locations ? { locations } : {}),
  });

  await sleepCancellable(Number(step.startDelay ?? 20));
  update({ sessionUpdate: "tool_call_update", toolCallId: callId, status: "in_progress" });

  if (step.permission) {
    const decision = await requestPermission(callId, step, title, rawInput);
    if (permissionRejected(decision)) {
      // A denied call is not executed. Report it as failed so the client can
      // close the tool row, but carry no rawOutput: there is no exit code to
      // invent, and Absence must mark the command's exitCodeKnown=false.
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: callId,
        status: "failed",
        content: contentBlocks(
          step.permission?.denyText ?? "Permission denied by the user",
        ),
        ...(locations ? { locations } : {}),
      });
      return;
    }
  }

  let content = normalizeContent(step.content);
  let status = step.status ?? "completed";
  let rawOutput = step.rawOutput;
  let diskWrite;
  let diskWritten = false;

  try {
    if (step.readFile) {
      const file = step.readFile;
      const relative = String(file.path ?? relPath ?? "");
      const absolute = insideWorkspace(relative);
      const text = fs.readFileSync(absolute, "utf8");
      const lines = text.split("\n");
      const start = Math.max(1, Number(file.startLine ?? 1));
      const count = Number(file.lines ?? 0);
      const slice = count > 0 ? lines.slice(start - 1, start - 1 + count) : lines;
      content = contentBlocks(slice.join("\n"));
      const line = step.locations?.[0]?.line ?? start;
      updateLocations(locations, relative, line);
    } else if (step.runCommand) {
      const spec = commandSpec(step.runCommand);
      const ran = await runCommandSpec(spec);
      content = contentBlocks(ran.stdout.length > 0 ? ran.stdout : ran.note ?? "");
      status = ran.exitCode === 0 ? "completed" : "failed";
      rawOutput = {
        exitCode: ran.exitCode,
        pid: ran.pid,
        truncated: ran.truncated === true,
        ...(ran.note ? { note: ran.note } : {}),
      };
    } else if (step.writeFile) {
      const spec = step.writeFile;
      const relative = String(spec.path ?? relPath ?? "");
      const text = expandText(spec);
      diskWrite = { path: relative, content: text };
      content = normalizeContent(spec.reportContent);
      updateLocations(locations, relative, 1);
    } else if (step.editFile) {
      const spec = step.editFile;
      const relative = String(spec.path ?? relPath ?? "");
      const absolute = insideWorkspace(relative);
      const before = fs.readFileSync(absolute, "utf8");
      const oldString = String(spec.oldString ?? "");
      const newString = String(spec.newString ?? "");
      if (!before.includes(oldString)) {
        status = "failed";
        content = contentBlocks(`mock edit: old string not found in ${relative}`);
      } else {
        const after = spec.replaceAll === true
          ? before.split(oldString).join(newString)
          : before.replace(oldString, newString);
        diskWrite = { path: relative, content: after };
        // ACP adapters differ: some send the whole old/new file, others only the
        // replaced snippet. Both are legal `content: [{type:"diff"}]` shapes and
        // both must normalise to the same Absence event.
        const full = spec.diffStyle === "full" || step.diffStyle === "full";
        content = [
          {
            type: "diff",
            path: relative,
            oldText: full ? before : oldString,
            newText: full ? after : newString,
          },
        ];
      }
      updateLocations(locations, relative, 1);
    }
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    status = "failed";
    content = contentBlocks(`mock agent step failed: ${error?.message ?? error}`);
    rawOutput = { error: String(error?.message ?? error) };
  }

  // A real agent writes first and reports afterwards; a scenario that wants the
  // event-driven path to be the authoritative one can say `beforeUpdate`, and
  // the default reports first so the FileWatcher's echo has something to dedupe
  // against. Both orderings are worth exercising.
  if (diskWrite && step.applyToDisk === "beforeUpdate") {
    writeWorkspaceFile(diskWrite.path, diskWrite.content);
    diskWritten = true;
  }

  try {
    await sleepCancellable(Number(step.duration ?? 120));
  } catch (error) {
    if (error instanceof Cancelled) {
      // A cancelled tool call must still settle: leaving it `in_progress`
      // forever is the one state the client cannot clear on its own.
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: callId,
        status: "failed",
        content: contentBlocks("cancelled by client"),
        ...(locations ? { locations } : {}),
      });
    }
    throw error;
  }
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: callId,
    status,
    ...(content !== undefined ? { content } : {}),
    ...(locations ? { locations } : {}),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
  });

  if (diskWrite && !diskWritten && step.applyToDisk !== false) {
    await sleepCancellable(Number(step.diskWriteDelayMs ?? 150));
    writeWorkspaceFile(diskWrite.path, diskWrite.content);
  }
}

function requestPermission(callId, step, title, rawInput) {
  const options = step.permission?.options ?? step.options ?? DEFAULT_PERMISSION_OPTIONS;
  return request("session/request_permission", {
    sessionId: session.id,
    toolCall: {
      toolCallId: callId,
      title,
      kind: step.kind,
      rawInput,
      ...(step.locations ? { locations: step.locations } : {}),
    },
    options,
  });
}

/**
 * ACP answers a permission request with `selected` (an option id) or
 * `cancelled`. The agent decides what "reject" means from the option id; the
 * option's `kind` is display metadata, not the decision.
 */
function permissionRejected(result) {
  const outcome = result?.outcome;
  if (!outcome) return true;
  if (outcome.outcome === "cancelled") return true;
  if (outcome.outcome === "selected") {
    return /reject|deny|decline|disallow|cancel/i.test(String(outcome.optionId ?? ""));
  }
  return true;
}

function updateLocations(locations, relative, line) {
  if (!Array.isArray(locations)) return;
  locations.splice(0, locations.length, { path: relative, line });
}

function deriveRawInput(step, relPath) {
  if (step.runCommand) {
    const spec = commandSpec(step.runCommand);
    return {
      command: spec.display ?? [spec.command, ...spec.args].join(" "),
      ...(step.title ? { description: step.title } : {}),
    };
  }
  if (step.readFile) return { file_path: relPath };
  if (step.writeFile) {
    return { file_path: relPath, content: expandText(step.writeFile) };
  }
  if (step.editFile) {
    return {
      file_path: relPath,
      old_string: step.editFile.oldString,
      new_string: step.editFile.newString,
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// commands

function commandSpec(raw) {
  if (typeof raw === "string") {
    return {
      command: expandShell(raw),
      args: [],
      shell: true,
      background: false,
      detached: false,
      timeoutMs: 30_000,
      maxBytes: 2_000_000,
    };
  }
  const record = raw ?? {};
  return {
    command: expandRaw(String(record.command ?? "")),
    args: Array.isArray(record.args) ? record.args.map((arg) => expandRaw(String(arg))) : [],
    shell: record.shell === true,
    background: record.background === true,
    detached: record.detached === true,
    timeoutMs: Number(record.timeoutMs ?? 30_000),
    maxBytes: Number(record.maxBytes ?? 2_000_000),
    display: record.display ? expandShell(String(record.display)) : undefined,
  };
}

function runCommandSpec(spec) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timer;

    const child = spawn(spec.command, spec.args, {
      cwd,
      env: process.env,
      shell: spec.shell,
      detached: spec.detached,
      windowsHide: true,
      stdio: spec.background || spec.detached ? "ignore" : ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid) activeChildren.add(child);
    if (spec.background || spec.detached) backgroundChildren.add(child);

    const finish = (exitCode, note) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout: `${stdout}${stderr}`,
        stderr,
        exitCode,
        pid,
        note,
        truncated,
      });
    };

    child.on("error", (error) => finish(1, `spawn failed: ${error.message}`));
    child.stdout?.on("data", (chunk) => {
      if (stdout.length >= spec.maxBytes) {
        truncated = true;
        return;
      }
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length >= spec.maxBytes) {
        truncated = true;
        return;
      }
      stderr += String(chunk);
    });
    child.on("exit", (code) => {
      activeChildren.delete(child);
      backgroundChildren.delete(child);
      finish(code ?? -1);
    });

    // A backgrounded daemon returns immediately from the command's point of view,
    // exactly as `npm run dev &` does, while the process stays alive under the
    // Job Object.
    if (spec.background || spec.detached) {
      child.unref();
      setTimeout(() => finish(0, `background pid ${pid ?? "?"}`), 60);
      return;
    }

    timer = setTimeout(() => {
      killTree(child);
      finish(124, `timeout after ${spec.timeoutMs}ms`);
    }, spec.timeoutMs);
    timer.unref?.();
  });
}

function requestCancel() {
  cancelRequested = true;
  // A pending permission request is part of the turn too: reject it so the
  // turn can settle instead of waiting for an answer that will never come.
  for (const [, entry] of pending) entry.reject(new Error("turn cancelled"));
  pending.clear();
  for (const child of activeChildren) killTree(child);
}

function throwIfCancelled() {
  if (cancelRequested) throw new Cancelled("turn cancelled");
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    // Node's child.kill() only ends the immediate process; taskkill /T is what
    // reaches the grandchildren a shell command laid.
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    } catch {
      // Fall through to the portable kill.
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
}

// ---------------------------------------------------------------------------
// helpers

function pickTurn(promptText) {
  const turns = Array.isArray(scenario.turns) ? scenario.turns : [];
  // A matching turn wins over a catch-all: the first prompt may be huge and
  // mention words a later prompt also uses, so an unanchored catch-all must
  // never swallow an explicit trigger.
  for (const turn of turns) {
    if (typeof turn.match === "string" && promptText.includes(turn.match)) return turn;
  }
  for (const turn of turns) {
    if (turn.match instanceof Object && typeof turn.match.pattern === "string") {
      try {
        if (new RegExp(turn.match.pattern, turn.match.flags ?? "i").test(promptText)) return turn;
      } catch {
        // A bad pattern falls through rather than failing the turn.
      }
    }
  }
  for (const turn of turns) {
    if (turn.match === undefined) return turn;
  }
  return scenario.defaultTurn ?? { steps: [] };
}

function inferType(step) {
  if (step.runCommand || step.readFile || step.writeFile || step.editFile) return "tool";
  if (Array.isArray(step.steps)) return "parallel";
  if (step.text && step.role === "thought") return "thought";
  if (step.text) return "message";
  if (step.toolCallId || step.kind) return "tool";
  return "message";
}

function promptToText(prompt) {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => (block?.type === "text" ? String(block.text ?? "") : ""))
    .join("");
}

function contentBlocks(text) {
  return [{ type: "content", content: { type: "text", text: String(text) } }];
}

function normalizeContent(content) {
  if (content === undefined || content === null) return undefined;
  if (Array.isArray(content)) return content;
  return contentBlocks(content);
}

function contentChars(content) {
  if (typeof content === "string") return content.length;
  if (!content || typeof content !== "object") return 0;
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      if (typeof block?.text === "string") total += block.text.length;
      else if (typeof block?.content?.text === "string") total += block.content.text.length;
      else if (typeof block?.oldText === "string" || typeof block?.newText === "string") {
        total += String(block.oldText ?? "").length + String(block.newText ?? "").length;
      }
    }
    return total;
  }
  return typeof content.text === "string" ? content.text.length : 0;
}

function expandText(step) {
  let text = String(step.text ?? "");
  const repeat = Number(step.repeat ?? 0);
  if (repeat > 1) text = Array.from({ length: repeat }, () => text).join(String(step.join ?? "\n"));
  const target = Number(step.fillChars ?? 0);
  if (target > 0) {
    const fill = String(step.fillText ?? "context filler line for a long session.\n");
    if (text.length < target) {
      const needed = target - text.length;
      text += fill.repeat(Math.ceil(needed / fill.length)).slice(0, needed);
    }
  }
  return text;
}

function expandRaw(value) {
  return applyPlaceholders(String(value), false);
}

function expandShell(value) {
  return applyPlaceholders(String(value), true);
}

function applyPlaceholders(value, quote) {
  const replacements = {
    "{{NODE}}": process.execPath,
    "{{AGENT_DIR}}": agentDir,
    "{{REPO_ROOT}}": repoRoot,
    "{{CWD}}": cwd,
    "{{TMP}}": os.tmpdir(),
  };
  let out = value;
  for (const [token, replacement] of Object.entries(replacements)) {
    out = out.split(token).join(quote ? quoteShell(replacement) : replacement);
  }
  return out;
}

function quoteShell(value) {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function insideWorkspace(relative) {
  if (!relative) throw new Error("mock agent: a file path is required");
  const absolute = path.isAbsolute(relative) ? path.resolve(relative) : path.resolve(cwd, relative);
  const root = path.resolve(cwd);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`mock agent refuses to touch a path outside the workspace: ${relative}`);
  }
  return absolute;
}

function writeWorkspaceFile(relative, content) {
  const absolute = insideWorkspace(relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeLength(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function sleepCancellable(ms) {
  if (ms <= 0) {
    throwIfCancelled();
    return;
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    throwIfCancelled();
    await sleep(Math.min(50, deadline - Date.now()));
  }
  throwIfCancelled();
}
