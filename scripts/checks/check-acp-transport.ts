/**
 * Protocol-conformance check for the ACP transport layer.
 *
 *   npx tsx scripts/checks/check-acp-transport.ts
 *
 * Everything runs against a fake agent subprocess written into a temp directory
 * at run time, so the check exercises the real spawn/stdio path (not an in-memory
 * stub). It pins the seven behaviours the refactor is responsible for:
 *
 *   1. `initialize` carries `clientInfo` and negotiates `protocolVersion`;
 *   2. agent `sessionCapabilities` are normalised, and undeclared
 *      `session/resume|load|close` are never sent;
 *   3. requests made before the handshake are queued and sent in order;
 *   4. agent→client requests are routed (permission answers, fs/unknown refused);
 *   5. non-JSON stdout and stderr never pollute the protocol stream;
 *   6. `close` is idempotent and rejects every pending request with `-32800`;
 *   7. a version mismatch closes the connection with a readable error.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AcpConnection,
  AcpRequestCancelledError,
  AcpUnsupportedCapabilityError,
  type AcpConnectionOptions,
} from "../../apps/server/src/agents/acp/AcpConnection";
import { AcpProtocolVersionError } from "../../apps/server/src/agents/acp/protocol/version";
import { pickExecutable, resolveExecutable } from "../../apps/server/src/agents/acp/protocol/transport";
import { check, finish, section } from "./harness";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const FAKE_AGENT = String.raw`
import { createInterface } from "node:readline";
import fs from "node:fs";

const scenario = process.env.ACP_CHECK_SCENARIO || "normal";
const logPath = process.env.ACP_CHECK_LOG;
const capturePath = process.env.ACP_CHECK_CAPTURE;

const log = (entry) => {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
};
const write = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
const writeRaw = (line) => process.stdout.write(line + "\n");
const stderr = (line) => process.stderr.write(line + "\n");

let nextId = 900;
const pending = new Map();

const requestClient = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { method, resolve, reject });
    write({ jsonrpc: "2.0", id, method, params });
  });

const capabilitiesFor = () => {
  if (scenario === "version-mismatch") return { protocolVersion: 99, agentCapabilities: {} };
  if (scenario === "minimal-caps") return { protocolVersion: 1, agentCapabilities: {} };
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {}, close: true },
    },
  };
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    if (!entry) return;
    pending.delete(message.id);
    log({
      kind: "client-response",
      id: message.id,
      method: entry.method,
      result: message.result,
      error: message.error,
    });
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
    return;
  }

  log({ kind: "incoming", id: message.id, method: message.method, params: message.params });

  switch (message.method) {
    case "initialize":
      if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(message.params || null));
      if (scenario === "noise") {
        writeRaw("this is a plain stdout banner, not JSON");
        writeRaw('{"level":"info","message":"structured log, not JSON-RPC"}');
        stderr("stderr: starting up");
      }
      await delay(scenario === "slow-init" ? 150 : 0);
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: { ...capabilitiesFor(), authMethods: [] },
      });
      break;

    case "session/new":
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1", configOptions: [] } });
      if (scenario === "permission") {
        const permission = await requestClient("session/request_permission", {
          sessionId: "session-1",
          toolCall: { toolCallId: "call-1", title: "Run a tool" },
          options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        });
        log({ kind: "permission-answer", result: permission });
        try {
          await requestClient("fs/read_text_file", { sessionId: "session-1", path: "notes.txt" });
        } catch (error) {
          log({ kind: "fs-refused", message: String(error && error.message) });
        }
        try {
          await requestClient("diag/unknown", { sessionId: "session-1" });
        } catch (error) {
          log({ kind: "unknown-refused", message: String(error && error.message) });
        }
      }
      break;

    case "session/resume":
    case "session/load":
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: message.params?.sessionId ?? "session-1", configOptions: [] },
      });
      break;

    case "session/prompt":
      if (scenario === "hang") break; // never answers; the client must cancel it
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      break;

    case "session/cancel":
      // hang mode intentionally ignores this.
      break;

    case "session/close":
      write({ jsonrpc: "2.0", id: message.id, result: {} });
      break;

    case "session/set_config_option":
      write({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
      break;

    default:
      if (message.id !== undefined) {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "unsupported: " + String(message.method) },
        });
      }
  }
});
`;

interface AgentRun {
  readonly dir: string;
  readonly logPath: string;
  readonly capturePath: string;
  readonly connection: AcpConnection;
  readonly diagnostics: string[];
  readonly notifications: Array<{ method: string; params: any }>;
  readonly requests: Array<{ method: string; params: any }>;
}

async function createAgent(scenario: string): Promise<AgentRun> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "absence-acp-transport-"));
  const agentPath = path.join(dir, "fake-agent.mjs");
  await fs.writeFile(agentPath, FAKE_AGENT, "utf8");
  const logPath = path.join(dir, "log.ndjson");
  const capturePath = path.join(dir, "initialize.json");

  const diagnostics: string[] = [];
  const notifications: Array<{ method: string; params: any }> = [];
  const requests: Array<{ method: string; params: any }> = [];

  const options: AcpConnectionOptions = {
    launch: {
      command: process.execPath,
      args: [agentPath],
      env: {
        ACP_CHECK_SCENARIO: scenario,
        ACP_CHECK_LOG: logPath,
        ACP_CHECK_CAPTURE: capturePath,
      },
    },
    cwd: repoRoot,
    onNotification: (method, params) => notifications.push({ method, params }),
    onRequest: async (method, params) => {
      requests.push({ method, params });
      if (method === "session/request_permission") {
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      }
      throw new Error("unexpected client request: " + method);
    },
    onErrorOutput: (chunk) => diagnostics.push(chunk),
  };

  return { dir, logPath, capturePath, connection: new AcpConnection(options), diagnostics, notifications, requests };
}

async function destroy(run: AgentRun): Promise<void> {
  run.connection.close("check cleanup");
  await fs.rm(run.dir, { recursive: true, force: true });
}

async function readLog(logPath: string): Promise<any[]> {
  const text = await fs.readFile(logPath, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { kind: "unparsable", line };
      }
    });
}

/** Poll the fake agent's NDJSON log until the predicate sees enough. */
async function waitForLog(
  logPath: string,
  predicate: (entries: any[]) => boolean,
  timeoutMs = 3000,
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  let entries = await readLog(logPath);
  while (Date.now() < deadline) {
    if (predicate(entries)) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
    entries = await readLog(logPath);
  }
  return entries;
}

function methodsOf(entries: any[]): string[] {
  return entries.filter((entry) => entry.kind === "incoming").map((entry) => String(entry.method));
}

async function main(): Promise<void> {
  section("initialize: clientInfo, version negotiation, capability normalisation");
  {
    const run = await createAgent("normal");
    try {
      const init = await run.connection.start();
      check("the agent's protocolVersion is accepted", init.protocolVersion === 1, JSON.stringify(init));

      const captured = JSON.parse(await fs.readFile(run.capturePath, "utf8"));
      check(
        "initialize carries clientInfo",
        captured.clientInfo?.name === "absence" && typeof captured.clientInfo?.version === "string",
        JSON.stringify(captured.clientInfo),
      );
      check(
        "clientCapabilities default to nothing",
        captured.clientCapabilities?.fs?.readTextFile === false &&
          captured.clientCapabilities?.fs?.writeTextFile === false &&
          captured.clientCapabilities?.terminal === false,
        JSON.stringify(captured.clientCapabilities),
      );

      const caps = run.connection.capabilities;
      check(
        "loadSession and session/resume|close are normalised",
        caps?.session.load === true && caps?.session.resume === true && caps?.session.close === true,
        JSON.stringify(caps?.session),
      );

      const session = await run.connection.newSession(repoRoot);
      check("session/new returns a session id", session.sessionId === "session-1");

      const resumed = await run.connection.resumeSession("session-1", repoRoot);
      check("a declared session/resume is called", resumed.sessionId === "session-1");

      const log = await readLog(run.logPath);
      check(
        "the resume actually reached the agent",
        methodsOf(log).includes("session/resume"),
        methodsOf(log).join(","),
      );

      await run.connection.setConfigOption("session-1", "model", "claude-sonnet");
      await run.connection.setConfigOption("session-1", "auto_approve", false);
      const configLog = await readLog(run.logPath);
      const configFrames = configLog.filter((entry) => entry.method === "session/set_config_option");
      check(
        "string config values pass through unchanged",
        configFrames[0]?.params?.value === "claude-sonnet",
        JSON.stringify(configFrames[0]),
      );
      check(
        "boolean config values pass through unchanged",
        configFrames[1]?.params?.value === false,
        JSON.stringify(configFrames[1]),
      );

      await run.connection.closeSession("session-1");
      await run.connection.closeSession("session-1");
      const afterClose = await readLog(run.logPath);
      check(
        "closeSession is idempotent: one session/close frame",
        afterClose.filter((entry) => entry.method === "session/close").length === 1,
        String(afterClose.filter((entry) => entry.method === "session/close").length),
      );
    } finally {
      await destroy(run);
    }
  }

  section("undeclared session capabilities are never called");
  {
    const run = await createAgent("minimal-caps");
    try {
      await run.connection.start();
      const caps = run.connection.capabilities;
      check(
        "missing capabilities normalise to false",
        caps?.session.resume === false && caps?.session.load === false && caps?.session.close === false,
        JSON.stringify(caps?.session),
      );

      let resumeError: unknown;
      try {
        await run.connection.resumeSession("session-1", repoRoot);
      } catch (error) {
        resumeError = error;
      }
      check(
        "resumeSession refuses instead of calling",
        resumeError instanceof AcpUnsupportedCapabilityError,
        String(resumeError),
      );

      await run.connection.closeSession("session-1");
      const log = await readLog(run.logPath);
      check(
        "MUST NOT: session/resume and session/load never sent",
        !methodsOf(log).includes("session/resume") && !methodsOf(log).includes("session/load"),
        methodsOf(log).join(","),
      );
      check(
        "MUST NOT: session/close never sent without the capability",
        !methodsOf(log).includes("session/close"),
        methodsOf(log).join(","),
      );
    } finally {
      await destroy(run);
    }
  }

  section("protocol version mismatch closes the connection");
  {
    const run = await createAgent("version-mismatch");
    const queued = run.connection.newSession(repoRoot).catch((error) => error);
    try {
      let startError: unknown;
      try {
        await run.connection.start();
      } catch (error) {
        startError = error;
      }
      check(
        "start rejects with a protocol-version error",
        startError instanceof AcpProtocolVersionError,
        String(startError),
      );
      check(
        "the error names the returned and supported versions",
        /99/.test(String(startError)) && /supports 1/.test(String(startError)),
        String(startError),
      );

      const queuedError = await queued;
      check(
        "a queued request is rejected with a cancellation-class error",
        queuedError instanceof AcpRequestCancelledError &&
          (queuedError as AcpRequestCancelledError).code === -32800,
        String(queuedError),
      );
      check("the connection is no longer alive", !run.connection.isAlive());
    } finally {
      await destroy(run);
    }
  }

  section("pre-initialize requests queue and flush in order");
  {
    const run = await createAgent("slow-init");
    const queued = run.connection.newSession(repoRoot);
    try {
      await run.connection.start();
      const session = await queued;
      check("the queued session/new resolves after the handshake", session.sessionId === "session-1");

      const log = await readLog(run.logPath);
      const methods = methodsOf(log);
      check(
        "initialize is sent before the queued request",
        methods[0] === "initialize" && methods[1] === "session/new",
        methods.join(","),
      );
    } finally {
      await destroy(run);
    }
  }

  section("agent→client requests are routed");
  {
    const run = await createAgent("permission");
    try {
      await run.connection.start();
      await run.connection.newSession(repoRoot);

      const log = await waitForLog(
        run.logPath,
        (entries) =>
          entries.some((entry) => entry.method === "fs/read_text_file") &&
          entries.some((entry) => entry.method === "diag/unknown"),
      );

      check(
        "session/request_permission reached onRequest",
        run.requests.some((request) => request.method === "session/request_permission"),
        run.requests.map((request) => request.method).join(","),
      );

      const permissionResponse = log.find(
        (entry) => entry.kind === "client-response" && entry.method === "session/request_permission",
      );
      check(
        "the permission answer was sent back",
        permissionResponse?.result?.outcome?.outcome === "selected" &&
          permissionResponse?.result?.outcome?.optionId === "allow-once",
        JSON.stringify(permissionResponse),
      );

      const fsResponse = log.find(
        (entry) => entry.kind === "client-response" && entry.method === "fs/read_text_file",
      );
      check(
        "an undeclared fs request is refused with -32601",
        fsResponse?.error?.code === -32601,
        JSON.stringify(fsResponse),
      );
      check(
        "the fs request never reached onRequest",
        !run.requests.some((request) => request.method === "fs/read_text_file"),
        run.requests.map((request) => request.method).join(","),
      );

      const unknownResponse = log.find(
        (entry) => entry.kind === "client-response" && entry.method === "diag/unknown",
      );
      check(
        "an unknown agent request is refused with -32601",
        unknownResponse?.error?.code === -32601,
        JSON.stringify(unknownResponse),
      );
    } finally {
      await destroy(run);
    }
  }

  section("non-JSON stdout and stderr stay out of the protocol stream");
  {
    const run = await createAgent("noise");
    try {
      await run.connection.start();
      const session = await run.connection.newSession(repoRoot);
      const turn = await run.connection.prompt("session-1", [{ type: "text", text: "hello" }]);

      check("protocol requests still work", session.sessionId === "session-1");
      check("the turn still completes", turn.stopReason === "end_turn", String(turn.stopReason));
      check(
        "stderr is delivered on the diagnostics channel",
        run.diagnostics.join("").includes("stderr: starting up"),
        run.diagnostics.join(" "),
      );
      check(
        "a non-JSON stdout banner became diagnostics, not protocol",
        run.diagnostics.some((chunk) => chunk.includes("plain stdout banner")),
        run.diagnostics.join(" "),
      );
      check(
        "a structured non-JSON-RPC log line never became a notification",
        run.notifications.length === 0,
        JSON.stringify(run.notifications),
      );
    } finally {
      await destroy(run);
    }
  }

  section("close is idempotent and cancels pending requests");
  {
    const run = await createAgent("hang");
    try {
      await run.connection.start();
      await run.connection.newSession(repoRoot);

      const pendingPrompt = run.connection
        .prompt("session-1", [{ type: "text", text: "hang" }])
        .catch((error) => error);

      const log = await waitForLog(run.logPath, (entries) =>
        entries.some((entry) => entry.kind === "incoming" && entry.method === "session/prompt"),
      );
      check("the hanging prompt reached the agent", methodsOf(log).includes("session/prompt"));

      run.connection.close("check close");
      run.connection.close("second close");

      const error = await pendingPrompt;
      check(
        "the pending request rejects with the cancellation code",
        error instanceof AcpRequestCancelledError &&
          (error as AcpRequestCancelledError).code === -32800,
        String(error),
      );
      check("the connection is not alive after close", !run.connection.isAlive());

      let afterClose: unknown;
      try {
        await run.connection.newSession(repoRoot);
      } catch (afterError) {
        afterClose = afterError;
      }
      check(
        "requests issued after close reject immediately",
        afterClose instanceof AcpRequestCancelledError,
        String(afterClose),
      );
    } finally {
      await destroy(run);
    }
  }

  section("Windows: PATHEXT resolution and a batch shim in a path with spaces");
  {
    check(
      "the .cmd wins over the extensionless shim `where` printed first",
      pickExecutable(
        ["D:\\nodejs\\npx", "D:\\nodejs\\npx.cmd"],
        "npx",
        ".COM;.EXE;.BAT;.CMD",
      ) === "D:\\nodejs\\npx.cmd",
      pickExecutable(["D:\\nodejs\\npx", "D:\\nodejs\\npx.cmd"], "npx", ".COM;.EXE;.BAT;.CMD"),
    );
    check(
      "PATHEXT order outranks `where` order (.exe before .cmd)",
      pickExecutable(["C:\\tools\\x.cmd", "C:\\tools\\x.exe"], "x", ".COM;.EXE;.BAT;.CMD") ===
        "C:\\tools\\x.exe",
    );
    check(
      "a lookup with no executable extension falls back to the first hit",
      pickExecutable(["C:\\tools\\x.shim"], "x", ".COM;.EXE;.BAT;.CMD") === "C:\\tools\\x.shim",
    );
    check(
      "a bare name is left to `where` only on Windows",
      process.platform === "win32" ? resolveExecutable("npx") !== "npx" : resolveExecutable("npx") === "npx",
      resolveExecutable("npx"),
    );

    if (process.platform === "win32") {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "absence acp batch "));
      const agentPath = path.join(dir, "fake agent.mjs");
      const shimPath = path.join(dir, "run agent.cmd");
      const argsPath = path.join(dir, "args.txt");
      await fs.writeFile(agentPath, FAKE_AGENT, "utf8");
      await fs.writeFile(
        shimPath,
        [
          "@echo off",
          `echo %~1>"${argsPath}"`,
          `"${process.execPath}" "${agentPath}" %*`,
          "",
        ].join("\r\n"),
        "utf8",
      );

      const connection = new AcpConnection({
        launch: { command: shimPath, args: ["a b"] },
        cwd: repoRoot,
        onNotification: () => {},
        onRequest: () => {
          throw new Error("unexpected request");
        },
      });
      try {
        const init = await connection.start();
        check(
          "a .cmd shim in a path containing spaces starts the agent",
          init.protocolVersion === 1,
          JSON.stringify(init),
        );
        const session = await connection.newSession(repoRoot);
        check("the batch-launched agent still serves session/new", session.sessionId === "session-1");
        const args = (await fs.readFile(argsPath, "utf8")).trim();
        check("an argument containing a space reaches the agent unsplit", args === "a b", args);
      } finally {
        connection.close("batch check cleanup");
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  }

  finish("acp-transport");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
