/**
 * Transparent ACP proxy check.
 *
 *   npx tsx scripts/checks/check-acp-proxy.ts
 *
 * Two real subprocesses are used — a fake ACP client on the upstream side and a
 * fake agent on the downstream side — so the check exercises the actual pipes
 * and the actual spawn path, not a stubbed pair of objects.
 *
 * It pins the behaviours the proxy mode promises:
 *
 *   1. every line is forwarded byte-for-byte in both directions, in order,
 *      including `session/request_permission` and non-JSON diagnostics lines;
 *   2. the tap never changes the conversation: with it attached, the client's
 *      outgoing lines and the agent's incoming lines are identical;
 *   3. a permission request is answered only by the fake client; when the
 *      client stays silent the tap records it as unanswered instead of
 *      inventing an answer;
 *   4. the tap's `MonitorEvent`s carry `source: "acp-proxy"`;
 *   5. an abrupt agent exit resolves the proxy promptly and keeps exit code 7;
 *      `close()` is idempotent and does not hang or throw.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MonitorEvent } from "@absence/core";
import { AcpProxy } from "../../apps/server/src/agents/acp/proxy/proxy";
import { AcpProxyTap, type ProxyDiagnostic } from "../../apps/server/src/agents/acp/proxy/tap";
import { createAgentTransport, createStreamTransport } from "../../apps/server/src/agents/acp/proxy/transport";
import { createMonitorBus } from "../../apps/server/src/monitor/MonitorBus";
import { check, finish, section } from "./harness";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_CLIENT = String.raw`
import { createInterface } from "node:readline";
import fs from "node:fs";

const logPath = process.env.ACP_CHECK_CLIENT_LOG;
const scenario = process.env.ACP_CHECK_CLIENT_SCENARIO || "normal";
const log = (entry) => {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
};
const write = (line) => {
  process.stdout.write(line + "\n");
  log({ kind: "out", line });
};
const send = (payload) => write(JSON.stringify(payload));

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  log({ kind: "in", line });
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    if (message.id === 1) {
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: process.cwd(), mcpServers: [] },
      });
    } else if (message.id === 2) {
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: "sess-1", prompt: [{ type: "text", text: "hello" }] },
      });
    } else if (message.id === 3) {
      // An unknown method: the agent answers with a JSON-RPC error, which must
      // reach this client unchanged like any other message.
      send({
        jsonrpc: "2.0",
        id: 4,
        method: "diag/unknown",
        params: { sessionId: "sess-1" },
      });
    }
    return;
  }

  if (message.method === "session/request_permission" && message.id !== undefined) {
    if (scenario === "ignore-permission") {
      log({ kind: "permission-ignored", id: message.id });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
    log({ kind: "permission-answered", id: message.id });
    return;
  }
});

// A non-JSON line must reach the agent unchanged.
write("fake-client banner: this is not JSON");
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientInfo: { name: "fake-client", version: "1.0" } },
});
`;

const FAKE_AGENT = String.raw`
import { createInterface } from "node:readline";
import fs from "node:fs";

const logPath = process.env.ACP_CHECK_AGENT_LOG;
const scenario = process.env.ACP_CHECK_AGENT_SCENARIO || "normal";
const log = (entry) => {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
};
const write = (line) => {
  process.stdout.write(line + "\n");
  log({ kind: "out", line });
};
const send = (payload) => write(JSON.stringify(payload));

let nextId = 7001;
const pending = new Map();
const requestClient = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  log({ kind: "in", line });
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    log({ kind: "malformed-in", line });
    return;
  }

  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      log({ kind: "client-response", id: message.id, result: message.result, error: message.error });
      resolve(message.result);
    }
    return;
  }

  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
      break;

    case "session/new":
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "sess-1" } });
      break;

    case "session/prompt":
      if (scenario === "exit") {
        process.exit(7);
      }
      // A non-JSON line must reach the client unchanged.
      write("fake-agent banner: this is not JSON");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from the agent" },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "read notes.txt",
            kind: "read",
            status: "pending",
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            title: "read notes.txt",
            kind: "read",
            status: "completed",
          },
        },
      });
      if (scenario === "ignore-permission") {
        await requestClient("session/request_permission", {
          sessionId: "sess-1",
          toolCall: { toolCallId: "call-1", title: "read notes.txt" },
          options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        });
        break;
      }
      await requestClient("session/request_permission", {
        sessionId: "sess-1",
        toolCall: { toolCallId: "call-1", title: "read notes.txt" },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      break;

    default:
      if (message.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "unknown method: " + String(message.method) },
        });
      }
  }
});
`;

interface LogEntry {
  kind: string;
  line?: string;
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
}

async function readLog(logPath: string): Promise<LogEntry[]> {
  const text = await fs.readFile(logPath, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as LogEntry;
      } catch {
        return { kind: "unparsable", line };
      }
    });
}

async function waitForLog(
  logPath: string,
  predicate: (entries: LogEntry[]) => boolean,
  timeoutMs = 5000,
): Promise<LogEntry[]> {
  const deadline = Date.now() + timeoutMs;
  let entries = await readLog(logPath);
  while (Date.now() < deadline) {
    if (predicate(entries)) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
    entries = await readLog(logPath);
  }
  return entries;
}

function linesOf(entries: LogEntry[], kind: "in" | "out"): string[] {
  return entries.filter((entry) => entry.kind === kind && typeof entry.line === "string").map(
    (entry) => entry.line as string,
  );
}

function sameLines(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((line, i) => line === right[i]);
}

function describeMismatch(expected: string[], actual: string[]): string {
  const at = expected.findIndex((line, i) => line !== actual[i]);
  return `first mismatch at ${at} (${expected.length} vs ${actual.length}): expected=${JSON.stringify(expected[at])} actual=${JSON.stringify(actual[at])}`;
}

interface RunResult {
  events: MonitorEvent[];
  diagnostics: ProxyDiagnostic[];
  tap: AcpProxyTap;
  proxy: AcpProxy;
  clientLog: string;
  agentLog: string;
  clientProcess: ReturnType<typeof spawn>;
  dir: string;
}

interface Scenario {
  agent: string;
  client?: string;
}

async function startScenario(scenario: Scenario): Promise<RunResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "absence-acp-proxy-"));
  const clientPath = path.join(dir, "fake-client.mjs");
  const agentPath = path.join(dir, "fake-agent.mjs");
  await fs.writeFile(clientPath, FAKE_CLIENT, "utf8");
  await fs.writeFile(agentPath, FAKE_AGENT, "utf8");

  const clientLog = path.join(dir, "client.ndjson");
  const agentLog = path.join(dir, "agent.ndjson");

  const clientProcess = spawn(process.execPath, [clientPath], {
    cwd: dir,
    env: {
      ...process.env,
      ACP_CHECK_CLIENT_LOG: clientLog,
      ACP_CHECK_CLIENT_SCENARIO: scenario.client ?? "normal",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  clientProcess.stderr?.resume();

  if (!clientProcess.stdout || !clientProcess.stdin) {
    throw new Error("fake client has no pipes");
  }

  const client = createStreamTransport({
    input: clientProcess.stdout,
    output: clientProcess.stdin,
    label: "fake client",
    pid: clientProcess.pid,
    exitOnInputClose: false,
    exitSource: (emit) => clientProcess.on("close", (code) => emit(code)),
  });

  const agent = createAgentTransport(
    {
      command: process.execPath,
      args: [agentPath],
      env: { ACP_CHECK_AGENT_LOG: agentLog, ACP_CHECK_AGENT_SCENARIO: scenario.agent },
    },
    dir,
    {},
  );

  const events: MonitorEvent[] = [];
  const diagnostics: ProxyDiagnostic[] = [];
  const bus = createMonitorBus();
  bus.subscribe((event) => events.push(event));

  const tap = new AcpProxyTap({
    cwd: dir,
    fallbackSessionId: "proxy-check",
    bus,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  const proxy = new AcpProxy({ client, agent, tap, onDiagnostic: () => {} });
  return { events, diagnostics, tap, proxy, clientLog, agentLog, clientProcess, dir };
}

async function cleanup(run: RunResult): Promise<void> {
  run.proxy.close("check cleanup");
  await Promise.race([
    run.proxy.waitForExit(),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  try {
    run.clientProcess.kill();
  } catch {
    // already gone
  }
  await fs.rm(run.dir, { recursive: true, force: true }).catch(() => {});
}

function tapStatsOf(run: RunResult): ReturnType<AcpProxyTap["stats"]> {
  return run.tap.stats();
}

async function main(): Promise<void> {
  section("bidirectional byte-for-byte forwarding with a live tap");
  {
    const run = await startScenario({ agent: "normal" });
    try {
      const clientDone = await waitForLog(run.clientLog, (entries) =>
        entries.some((entry) => {
          if (entry.kind !== "in" || typeof entry.line !== "string") return false;
          try {
            const message = JSON.parse(entry.line);
            return message.id === 3 && message.result?.stopReason === "end_turn";
          } catch {
            return false;
          }
        }),
      );
      check(
        "the turn completed through the proxy",
        clientDone.length > 0,
        `${clientDone.length} client log entries`,
      );

      const errorSeen = await waitForLog(run.clientLog, (entries) =>
        entries.some((entry) => {
          if (entry.kind !== "in" || typeof entry.line !== "string") return false;
          try {
            const message = JSON.parse(entry.line);
            return message.id === 4 && message.error?.code === -32601;
          } catch {
            return false;
          }
        }),
      );
      const errorLine = linesOf(errorSeen, "in").find((line) => {
        try {
          const message = JSON.parse(line);
          return message.id === 4 && message.error?.code === -32601;
        } catch {
          return false;
        }
      });
      check(
        "a JSON-RPC error crossed the proxy unchanged",
        errorLine !== undefined,
        `${errorSeen.length} client log entries`,
      );
      check(
        "the error line is byte-identical to the agent's output",
        errorLine !== undefined && linesOf(await readLog(run.agentLog), "out").includes(errorLine),
        String(errorLine),
      );

      // Let the last lines drain before comparing the two wires.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const clientEntries = await readLog(run.clientLog);
      const agentEntries = await readLog(run.agentLog);

      const clientOut = linesOf(clientEntries, "out");
      const agentIn = linesOf(agentEntries, "in");
      check(
        "client → agent lines are identical, in order",
        sameLines(clientOut, agentIn),
        describeMismatch(clientOut, agentIn),
      );

      const agentOut = linesOf(agentEntries, "out");
      const clientIn = linesOf(clientEntries, "in");
      check(
        "agent → client lines are identical, in order",
        sameLines(agentOut, clientIn),
        describeMismatch(agentOut, clientIn),
      );

      const permissionOut = agentOut.find((line) => line.includes('"session/request_permission"'));
      const permissionIn = clientIn.find((line) => line.includes('"session/request_permission"'));
      check(
        "a permission request crossed unchanged",
        permissionOut !== undefined && permissionIn === permissionOut,
        String(permissionOut),
      );

      const answer = clientOut.find((line) => {
        if (!line.includes('"id":7001')) return false;
        return line.includes('"allow-once"');
      });
      const answerReceived = agentIn.find((line) => line.includes('"id":7001') && line === answer);
      check(
        "only the upstream client's answer reached the agent, byte-identical",
        answer !== undefined && answerReceived === answer,
        String(answerReceived ?? answer),
      );

      check(
        "a non-JSON client line reached the agent",
        agentIn.some((line) => line.includes("fake-client banner")),
        agentIn.join("\n"),
      );
      check(
        "a non-JSON agent line reached the client",
        clientIn.some((line) => line.includes("fake-agent banner")),
        clientIn.join("\n"),
      );

      await run.tap.drain();
      const stats = tapStatsOf(run);
      check(
        "the tap counted two malformed lines without dropping them",
        stats.malformedLines === 2,
        JSON.stringify(stats),
      );
      check(
        "the tap saw one permission request and one answer",
        stats.permissionRequests === 1 && stats.permissionAnswers === 1,
        JSON.stringify(stats),
      );

      check("the tap produced MonitorEvents", run.events.length > 0, `${run.events.length}`);
      check(
        "every tap event is tagged source acp-proxy",
        run.events.every((event) => event.source === "acp-proxy"),
        run.events.map((event) => event.source).join(","),
      );
      check(
        "the tap covers message and tool lifecycle",
        run.events.some((event) => event.event.type === "message") &&
          run.events.some((event) => event.event.type === "tool_start") &&
          run.events.some((event) => event.event.type === "tool_end"),
        run.events.map((event) => event.event.type).join(","),
      );
      check(
        "tap events carry the ACP session id",
        run.events.every((event) => event.sessionId === "sess-1"),
        run.events.map((event) => event.sessionId).join(","),
      );

      run.proxy.close("check done");
      run.proxy.close("second close");
      const exit = await run.proxy.waitForExit();
      check("close is idempotent and resolves", exit.reason === "check done", exit.reason);
      check("the proxy is not alive after close", !run.proxy.isAlive());
    } finally {
      await cleanup(run);
    }
  }

  section("a permission the client never answers is recorded, never decided");
  {
    const run = await startScenario({ agent: "ignore-permission", client: "ignore-permission" });
    try {
      const entries = await waitForLog(run.agentLog, (log) =>
        log.some(
          (entry) =>
            entry.kind === "out" &&
            typeof entry.line === "string" &&
            entry.line.includes('"session/request_permission"'),
        ),
      );
      check(
        "the agent asked for permission",
        entries.some(
          (entry) =>
            entry.kind === "out" &&
            typeof entry.line === "string" &&
            entry.line.includes('"session/request_permission"'),
        ),
        `${entries.length} agent log entries`,
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      const agentEntries = await readLog(run.agentLog);
      const answered = agentEntries.some(
        (entry) =>
          entry.kind === "client-response" ||
          (entry.kind === "in" && typeof entry.line === "string" && entry.line.includes('"id":7001')),
      );
      check("the proxy did not answer the permission itself", !answered, "id 7001 response found");
      check(
        "the tap recorded the unanswered request",
        tapStatsOf(run).unansweredPermissions === 1,
        JSON.stringify(tapStatsOf(run)),
      );

      run.proxy.close("check unanswered");
      await run.proxy.waitForExit();
      const afterClose = run.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "unanswered-permission",
      );
      check(
        "closing reports the unanswered permission as a diagnostic",
        afterClose.length === 1 && afterClose[0]?.id === 7001,
        JSON.stringify(afterClose),
      );
    } finally {
      await cleanup(run);
    }
  }

  section("an abrupt agent exit propagates its code and never hangs");
  {
    const run = await startScenario({ agent: "exit" });
    try {
      const startedAt = Date.now();
      const exit = await Promise.race([
        run.proxy.waitForExit(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
      ]);
      const elapsed = Date.now() - startedAt;
      check("the proxy noticed the agent exit", exit !== undefined, `${elapsed}ms`);
      check(
        "the agent's exit code is preserved",
        exit?.side === "agent" && exit.code === 7,
        JSON.stringify(exit),
      );
      check("teardown finished promptly", elapsed < 5000, `${elapsed}ms`);
      check("the proxy is no longer alive", !run.proxy.isAlive());
      run.proxy.close("after exit");
      const second = await run.proxy.waitForExit();
      check("close after exit is a no-op", second.code === 7, JSON.stringify(second));
    } finally {
      await cleanup(run);
    }
  }

  section("the real `absence proxy` CLI exits after both ends close");
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "absence-acp-proxy-cli-"));
    const agentPath = path.join(dir, "fake-agent.mjs");
    await fs.writeFile(agentPath, FAKE_AGENT, "utf8");
    const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const entry = path.join(repoRoot, "apps", "server", "src", "index.ts");
    const child = spawn(
      process.execPath,
      [tsxCli, entry, "proxy", "--", process.execPath, agentPath],
      {
        cwd: dir,
        env: {
          ...process.env,
          PORT: "0",
          HOST: "127.0.0.1",
          ABSENCE_STATE_DIR: path.join(dir, "state"),
          ABSENCE_PROJECTS_ROOT: dir,
          ABSENCE_DOCKER: "0",
          ABSENCE_MCP: "0",
          ABSENCE_LOG_LEVEL: "warn",
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk) => {
      stderr.push(String(chunk));
      process.stderr.write(`[proxy-cli] ${chunk}`);
    });

    const startedAt = Date.now();
    try {
      if (!child.stdin || !child.stdout) throw new Error("proxy CLI has no pipes");
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: 1, clientInfo: { name: "check", version: "1" } },
        }) + "\n",
      );

      // Wait for the initialize answer, then close the client side (EOF).
      const answered = await new Promise<boolean>((resolve) => {
        let buffer = "";
        const timer = setTimeout(() => resolve(false), 6000);
        child.stdout!.on("data", (chunk) => {
          buffer += String(chunk);
          if (buffer.includes('"id":1') && buffer.includes('"result"')) {
            clearTimeout(timer);
            resolve(true);
          }
        });
      });
      check("the proxy CLI answered initialize", answered, stderr.join("").slice(-300));

      child.stdin.end();

      const exit = await new Promise<{ code: number | null; at: number } | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 8000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, at: Date.now() });
        });
      });
      check(
        "the proxy process exits after the client EOF and agent close",
        exit !== undefined,
        `still alive after ${Date.now() - startedAt}ms`,
      );
      check(
        "it exits promptly instead of lingering",
        exit !== undefined && exit.at - startedAt < 8000,
        exit ? `${exit.at - startedAt}ms` : "no exit",
      );
      check(
        "the client-side close keeps a zero exit code",
        exit?.code === 0,
        JSON.stringify(exit?.code),
      );
    } finally {
      try {
        child.kill();
      } catch {
        // already gone
      }
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  finish("acp-proxy");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
