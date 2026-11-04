#!/usr/bin/env node
/**
 * A deliberately tiny ACP agent for the lifecycle checks. It is *not* part of
 * the parallel mock-agent suite; it exists to pin three production behaviours:
 *
 *   ABSENCE_ACP_TEST_MODE=auth      initialize advertises a method, session/new
 *                                   returns auth_required until authenticate.
 *   ABSENCE_ACP_TEST_MODE=hang      session/prompt never answers and cancel is
 *                                   ignored, so the abort watchdog must settle.
 *   ABSENCE_ACP_TEST_MODE=commands  prompt advertises agent-owned `/` commands.
 *   ABSENCE_ACP_TEST_MODE=silent-overflow
 *                                   over-window usage then a bare end_turn with
 *                                   no text (the provider-failure shape).
 *   ABSENCE_ACP_TEST_MODE=startup-chunk
 *                                   sends an agent_message_chunk right after
 *                                   session/new, like pi-acp's startup info.
 *   ABSENCE_ACP_TEST_MODE=resume-replay
 *                                   answers session/load, then replays the
 *                                   session's history as tool_call updates
 *                                   before any prompt (pi-acp's resume shape).
 */
import { createInterface } from "node:readline";

const mode = process.env.ABSENCE_ACP_TEST_MODE ?? "commands";
let authed = mode !== "auth";
let nextId = 900;
const pending = new Map();

const write = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const respondError = (id, message, data) =>
  write({ jsonrpc: "2.0", id, error: { code: -32000, message, ...(data ? { data } : {}) } });
const update = (sessionId, body) =>
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    write({ jsonrpc: "2.0", id, method, params });
  });

const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    }
    return;
  }

  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods:
          mode === "auth"
            ? [{ id: "test-login", name: "Test login", description: "Sign in for the check" }]
            : [],
      });
      break;

    case "session/new":
    case "session/resume":
    case "session/load":
      if (!authed) {
        respondError(message.id, "Authentication required", {
          authMethods: [{ id: "test-login", name: "Test login" }],
        });
        break;
      }
      {
        const sessionId = message.params?.sessionId ?? "test-session";
        respond(message.id, {
          sessionId,
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "test-model",
              options: [{ value: "test-model", name: "Test Model" }],
            },
          ],
        });
        if (mode === "startup-chunk" && message.method === "session/new") {
          // The pi-acp startup shape: a bare agent_message_chunk right after
          // session/new, before any prompt exists.
          update(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "## Skills\n- /skills/playwright-cli/SKILL.md\n" },
          });
          update(sessionId, { sessionUpdate: "usage_update", used: 0, size: 8192 });
          update(sessionId, {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "skill:playwright-cli", description: "Automate browsers" },
            ],
          });
        }
        if (mode === "resume-replay" && message.method !== "session/new") {
          // The pi-acp resume shape: the session's history replays as
          // tool_call updates right after session/load, before any prompt.
          update(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "replay-1",
            title: "Edit 2.txt",
            kind: "edit",
            status: "completed",
            rawInput: { path: "2.txt", content: "done" },
          });
          update(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "replay-2",
            title: "Read 2.txt",
            kind: "read",
            status: "completed",
            rawInput: { path: "2.txt" },
          });
        }
      }
      break;

    case "authenticate":
      if (message.params?.methodId !== "test-login") {
        respondError(message.id, `unknown authentication method: ${message.params?.methodId}`);
        break;
      }
      authed = true;
      respond(message.id, {});
      break;

    case "session/prompt":
      if (mode === "hang") break; // deliberately never settle, ignore cancel
      if (mode === "silent-overflow") {
        // The shape a provider failure takes: over-window usage, then a bare
        // end_turn with no assistant text at all.
        update(message.params?.sessionId, {
          sessionUpdate: "usage_update",
          used: 9000,
          size: 8192,
        });
        respond(message.id, { stopReason: "end_turn" });
        break;
      }
      if (mode === "deny") {
        const sessionId = message.params?.sessionId;
        const toolCallId = "denied_cmd";
        update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Run a denied command",
          kind: "execute",
          status: "pending",
          rawInput: { command: "echo SHOULD-NOT-RUN" },
        });
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
        await request("session/request_permission", {
          sessionId,
          toolCall: { toolCallId, title: "Run a denied command", rawInput: { command: "echo SHOULD-NOT-RUN" } },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          content: [
            { type: "content", content: { type: "text", text: "Permission denied by the user" } },
          ],
        });
        respond(message.id, { stopReason: "end_turn" });
        break;
      }
      if (mode === "commands") {
        update(message.params?.sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "compact", description: "agent compact" },
            { name: "custom-fix", description: "agent custom command" },
            { name: "mcp", description: "agent mcp" },
          ],
        });
      }
      update(message.params?.sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_1",
        content: { type: "text", text: "test agent replied" },
      });
      update(message.params?.sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_1",
        content: { type: "text", text: " to the prompt" },
      });
      respond(message.id, { stopReason: "end_turn" });
      break;

    case "session/cancel":
      // hang mode intentionally ignores this; others have nothing to cancel.
      break;

    case "session/set_config_option":
      respond(message.id, {
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: message.params?.value ?? "test-model",
            options: [{ value: "test-model", name: "Test Model" }],
          },
        ],
      });
      break;

    case "session/close":
      respond(message.id, {});
      break;

    default:
      if (message.id !== undefined) respondError(message.id, `unsupported: ${message.method}`);
  }
});

// Keep the pending map referenced so a future verifier extends it without
// reworking the protocol shell.
void nextId;
void pending;
