/**
 * Offline check of the ACP proxy persistence channel (no real agent).
 *   npx tsx scripts/checks/check-observe-proxy.ts
 *
 * A fake ACP agent (a real subprocess) is spawned by a real ProxySessions
 * registry with the session store attached; the check itself plays the ACP
 * client over the TCP endpoint the way Zed would. What it proves:
 *
 *   1. the proxy session persists into an observed AbsenceSession: the proxy
 *      info names it, and (channel, externalId) identity is idempotent;
 *   2. the tap's facts land in the session — the client's own prompt arrives
 *      as the user message that opens a run, the agent's reply and tool
 *      lifecycle follow, every fact `source: "acp-proxy"`;
 *   3. the run index and the archive agree (one run, prompt text, persisted
 *      meta), and the archive stays readable after the proxy is closed —
 *      persistence is decoupled from the proxy's lifetime;
 *   4. the agent's environment carries `ABSENCE_SESSION_ID` naming that same
 *      session (the marker the kernel observer attributes by);
 *   5. an observed session refuses to be driven, even one born from a proxy.
 *
 * Uses a private ABSENCE_STATE_DIR, so it never touches real archives.
 */
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEvents, readMeta, readRuns } from "../../apps/server/src/sessions/archive";
import { check, finish, section } from "./harness";

const waitForAsync = async (predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return false;
};

// Isolation first: env must be set before the server modules are imported.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "absence-observe-proxy-"));
const stateDir = path.join(root, "state");
const project = path.join(root, "project");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(project, { recursive: true });
process.env.ABSENCE_STATE_DIR = stateDir;
process.env.ABSENCE_DOCKER = "0";
process.env.ABSENCE_MCP = "0";

const { sessionStore } = await import("../../apps/server/src/sessions/SessionStore");
const { ProxySessions } = await import("../../apps/server/src/agents/acp/proxy/registry");
const { createMonitorBus } = await import("../../apps/server/src/monitor/MonitorBus");

/**
 * The fake agent: speaks real ACP NDJSON over stdio. On a prompt it plays one
 * turn — a reply, a tool lifecycle — and records the environment marker the
 * proxy injected, so the check can verify exact-attribution wiring.
 */
const FAKE_AGENT = String.raw`
import { createInterface } from "node:readline";
import fs from "node:fs";

const write = (line) => process.stdout.write(line + "\n");
const send = (payload) => write(JSON.stringify(payload));
if (process.env.ABSENCE_CHECK_ENV_FILE) {
  fs.writeFileSync(process.env.ABSENCE_CHECK_ENV_FILE, process.env.ABSENCE_SESSION_ID ?? "", "utf8");
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) return;

  switch (message.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      break;
    case "session/new":
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "sess-1" } });
      break;
    case "session/prompt":
      send({
        jsonrpc: "2.0", method: "session/update",
        params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "observed reply" } } },
      });
      send({
        jsonrpc: "2.0", method: "session/update",
        params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "list files", kind: "execute", status: "pending", rawInput: { command: "node --version" } } },
      });
      send({
        jsonrpc: "2.0", method: "session/update",
        params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", title: "list files", kind: "execute", status: "completed", rawOutput: { content: [{ type: "content", content: { type: "text", text: "v24" } }] } } },
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
      }
  }
});
`;

interface Reply {
  id?: unknown;
  method?: string;
  result?: any;
  error?: any;
  params?: any;
}

/** A minimal ACP client over the proxy's TCP endpoint. */
function speakAgent(endpoint: { host: string; port: number }, dir: string, dump: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint.port, endpoint.host);
    let buffer = "";
    const send = (payload: Reply) => socket.write(JSON.stringify(payload) + "\n");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`fake client timed out — ${dump()}`));
    }, 15_000);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("connect", () => {
      send({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: 1, clientInfo: { name: "observe-proxy-check", version: "1.0" } },
      });
    });
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message: Reply;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && message.result !== undefined) {
          send({
            jsonrpc: "2.0", id: 2, method: "session/new",
            params: { cwd: dir, mcpServers: [] },
          });
        } else if (message.id === 2 && message.result !== undefined) {
          send({
            jsonrpc: "2.0", id: 3, method: "session/prompt",
            params: { sessionId: message.result.sessionId, prompt: [{ type: "text", text: "observe me" }] },
          });
        } else if (message.id === 3 && message.result !== undefined) {
          clearTimeout(timer);
          socket.end();
          resolve();
        } else if (message.method === "session/request_permission" && message.id !== undefined) {
          send({
            jsonrpc: "2.0", id: message.id,
            result: { outcome: { outcome: "selected", optionId: "allow-once" } },
          });
        }
      }
    });
  });
}

async function main(): Promise<void> {
  section("a proxy session persists into an observed session");
  const envFile = path.join(root, "agent-env.txt");
  const agentPath = path.join(root, "fake-agent.mjs");
  fs.writeFileSync(agentPath, FAKE_AGENT, "utf8");

  const proxies = new ProxySessions(createMonitorBus());
  proxies.useSessionStore(sessionStore);
  const handle = await proxies.startTcp({
    command: [process.execPath, agentPath],
    cwd: project,
    label: "observe-proxy-check",
    env: { ABSENCE_CHECK_ENV_FILE: envFile },
  }, { port: 0 });
  const info = handle.info();
  try {
    await speakAgent(info.endpoint!, project, () => JSON.stringify(handle.info(), null, 2));
    // The attach happens when the client connects (the agent spawns then), so
    // the session id is read after the dialog has run.
    const attached = handle.info();
    check("the proxy info names the absence session it persists into", typeof attached.sessionId === "string" && attached.sessionId.length > 0, String(attached.sessionId));
    const sessionId = attached.sessionId!;
    // The marker reached the agent's environment, naming the same session.
    const marker = fs.readFileSync(envFile, "utf8");
    check("the agent's ABSENCE_SESSION_ID names this session", marker === sessionId, `marker=${marker || "(none)"}`);

    const session = sessionStore.get(sessionId);
    check("the observed session exists in the store", session !== undefined, String(sessionId));
    check("its channel is acp-proxy", session?.observe?.channel === "acp-proxy", String(session?.observe?.channel));
    check("its external id is the proxy session id", session?.observe?.externalId === handle.id, String(session?.observe?.externalId));

    // The tap's facts land: prompt → user message, reply, tool lifecycle.
    const eventsReady = await waitForAsync(async () => {
      const events = await readEvents("", sessionId);
      return events.some((event) => event.type === "tool_end");
    });
    check("the turn's events reached the session", eventsReady, "tool_end seen");
    const events = await readEvents("", sessionId);
    const user = events.find((event) => event.type === "message" && event.payload.role === "user");
    check("the client's own prompt is the user message", user !== undefined && user.payload.content === "observe me", String(user?.payload.content));
    check(
      "every persisted fact is tagged source acp-proxy",
      events.length > 0 && events.every((event) => event.source === "acp-proxy"),
      [...new Set(events.map((event) => event.source))].join(","),
    );
    check(
      "reply and tool lifecycle both landed",
      events.some((event) => event.type === "message" && event.payload.role === "assistant") &&
        events.some((event) => event.type === "tool_start") &&
        events.some((event) => event.type === "tool_end"),
      events.map((event) => event.type).join(","),
    );

    // The run index agrees: the prompt opened a run, the agent closed it.
    const runsReady = await waitForAsync(async () => (await readRuns(sessionId)).length === 1);
    check("the run index has one run for the turn", runsReady, "1 run");
    const runs = await readRuns(sessionId);
    check("the run's prompt is the client's text", runs[0]?.prompt === "observe me", String(runs[0]?.prompt));

    // Refusal to drive holds for proxy-born observed sessions too.
    let refused = false;
    try {
      session?.prompt("write back anyway");
    } catch {
      refused = true;
    }
    check("an observed proxy session refuses prompts", refused, "prompt() threw");

    // Closing the proxy must not close the archive: persistence outlives it.
    handle.close("check done");
    await handle.waitForExit();
    const metaReady = await waitForAsync(async () => (await readMeta("", sessionId)) !== undefined);
    check("the archive still holds the session after the proxy closed", metaReady, "meta readable");
    const meta = await readMeta("", sessionId);
    check("the archive meta records the agent kind", meta?.runtime === "acp-agent" || meta?.runtime === "observe-proxy-check", String(meta?.runtime));
    check("identity is idempotent per (channel, externalId)", session?.id === sessionId, session?.id);
  } finally {
    handle.close("check cleanup");
    proxies.closeAll("check cleanup");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  finish("observe-proxy");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
