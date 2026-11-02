#!/usr/bin/env node
/**
 * fake-agent.mjs — a scripted ACP agent.
 *
 * It speaks real Agent Client Protocol over stdio (NDJSON JSON-RPC) and replays
 * a scenario file, so the capture pipeline can be exercised against Claude Code
 * / Qwen Code event shapes without a model, credentials, or VRAM. Shell steps
 * launch *real* child processes, which is what lets the Job Object watcher see
 * them exactly as it would in a live session.
 *
 * Usage:
 *   ABSENCE_FIXTURE_SCENARIO=<path/to/scenario.json> node fake-agent.mjs
 *
 * Nothing here is product-specific: a scenario is data. Adding an agent shape
 * means adding a scenario, not changing Absence.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const scenarioPath = process.env.ABSENCE_FIXTURE_SCENARIO ?? process.argv[2];
if (!scenarioPath) {
  process.stderr.write("ABSENCE_FIXTURE_SCENARIO is required\n");
  process.exit(2);
}

const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const cwd = process.cwd();
let nextId = 900; // requests we send to the client
let cancelRequested = false;

const write = (payload) => {
  process.stdout.write(JSON.stringify(payload) + "\n");
};
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });
const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const respondError = (id, message) => write({ jsonrpc: "2.0", id, error: { code: -32000, message } });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send an agent→client request and wait for its response. */
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    write({ jsonrpc: "2.0", id, method, params });
  });

const pending = new Map();

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // A response to one of our requests (the permission answer).
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const entry = pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
    }
    return;
  }

  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        authMethods: [],
      });
      break;

    case "session/new":
      respond(msg.id, {
        sessionId: `fixture-${scenario.agent ?? "agent"}`,
        configOptions: scenario.configOptions ?? [],
      });
      break;

    case "session/resume":
    case "session/load":
      respond(msg.id, {
        sessionId: msg.params?.sessionId ?? `fixture-${scenario.agent ?? "agent"}`,
        configOptions: scenario.configOptions ?? [],
      });
      break;

    case "session/prompt":
      runTurn(msg.id, msg.params).catch((error) => respondError(msg.id, String(error?.message ?? error)));
      break;

    case "session/cancel":
      cancelRequested = true;
      break;

    case "session/set_config_option": {
      const options = scenario.configOptions ?? [];
      const target = options.find((option) => option.id === msg.params?.configId);
      if (target) target.currentValue = msg.params?.value;
      notify("session/update", {
        sessionId: msg.params?.sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: options },
      });
      respond(msg.id, { configOptions: options });
      break;
    }

    case "session/close":
      respond(msg.id, {});
      break;

    default:
      if (msg.id !== undefined) respondError(msg.id, `unsupported method: ${msg.method}`);
  }
});

async function runTurn(id, params) {
  cancelRequested = false;
  const turn = pickTurn(params?.prompt);
  const update = (payload) =>
    notify("session/update", { sessionId: params?.sessionId, update: payload });

  // The agent's own `/` command surface, as ACP advertises it.
  if (Array.isArray(scenario.commands)) {
    update({ sessionUpdate: "available_commands_update", availableCommands: scenario.commands });
  }

  for (const step of turn.steps ?? []) {
    if (cancelRequested) break;
    await runStep(step, update, params);
  }

  const result = { stopReason: cancelRequested ? "cancelled" : "end_turn" };
  respond(id, result);
}

async function runStep(step, update, params) {
  switch (step.type ?? inferType(step)) {
    case "thought": {
      for (const chunk of chunks(step.text ?? "", step.chunk ?? 24)) {
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: chunk } });
        await sleep(step.delay ?? 15);
      }
      break;
    }

    case "message": {
      const messageId = step.messageId ?? `msg_${Math.random().toString(36).slice(2, 8)}`;
      for (const chunk of chunks(step.text ?? "", step.chunk ?? 18)) {
        update({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: chunk } });
        await sleep(step.delay ?? 12);
      }
      break;
    }

    case "tool": {
      const call = {
        sessionUpdate: "tool_call",
        toolCallId: step.toolCallId,
        title: step.title ?? step.kind ?? "tool",
        kind: step.kind,
        status: "pending",
        rawInput: step.rawInput ?? {},
        ...(step.locations ? { locations: step.locations } : {}),
      };
      update(call);
      await sleep(step.startDelay ?? 30);
      update({ sessionUpdate: "tool_call_update", toolCallId: step.toolCallId, status: "in_progress" });

      // A permission prompt arrives before the tool executes, as ACP specifies.
      if (step.permission) {
        await request("session/request_permission", {
          sessionId: params?.sessionId,
          toolCall: { toolCallId: step.toolCallId, title: step.title, rawInput: step.rawInput },
          options: step.permission.options ?? [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Deny", kind: "reject_once" },
          ],
        });
      }

      // A shell step really runs: the Job Object watcher must be able to see it.
      let content = step.content;
      let status = step.status ?? "completed";
      if (typeof step.runCommand === "string") {
        const ran = await runShell(step.runCommand);
        content = [{ type: "content", content: { type: "text", text: ran.stdout } }];
        status = ran.exitCode === 0 ? "completed" : "failed";
      }

      await sleep(step.duration ?? 120);
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: step.toolCallId,
        status,
        ...(content ? { content } : {}),
        ...(step.locations ? { locations: step.locations } : {}),
      });
      break;
    }

    case "permission": {
      await request("session/request_permission", {
        sessionId: params?.sessionId,
        toolCall: step.toolCall ?? { toolCallId: "perm_1", title: "Run a tool" },
        options: step.options ?? [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" },
        ],
      });
      break;
    }

    case "usage":
      update({ sessionUpdate: "usage_update", used: step.used ?? 0, size: step.size ?? 0 });
      break;

    case "delay":
      await sleep(step.ms ?? 50);
      break;

    default:
      // Unknown step: ignore rather than fail the turn.
      break;
  }
}

function pickTurn(prompt) {
  const text = promptToText(prompt);
  const turns = Array.isArray(scenario.turns) ? scenario.turns : [];
  for (const turn of turns) {
    if (typeof turn.match === "string" && text.includes(turn.match)) return turn;
  }
  const fallback = turns.find((turn) => !turn.match);
  return fallback ?? scenario.defaultTurn ?? { steps: [] };
}

function promptToText(prompt) {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => (block?.type === "text" ? String(block.text ?? "") : ""))
    .join("");
}

function inferType(step) {
  if (step.text && step.role === "assistant") return "message";
  if (step.toolCallId) return "tool";
  return "message";
}

function chunks(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length > 0 ? out : [""];
}

function runShell(command) {
  return new Promise((resolve) => {
    // Real child processes, so the watcher sees eggs exactly as it would from
    // a live agent. The parent is this fixture, which the server spawned.
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => resolve({ stdout: String(error.message), stderr: "", exitCode: 1 }));
    child.on("exit", (code) => resolve({ stdout: stdout + stderr, stderr, exitCode: code ?? 0 }));
  });
}
