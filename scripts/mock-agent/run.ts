/**
 * run.ts — the supervision runner for the ACP mock agent.
 *
 *   npm run mock:agent                 # every scenario, real server
 *   npm run mock:agent -- --scenario 03-file-ops
 *   npm run mock:agent -- --list
 *
 * It does three things, and keeps them separate on purpose:
 *
 *   1. builds a throwaway home/state/workspace for each scenario;
 *   2. boots the real Absence server with a custom ACP profile that launches
 *      scripts/mock-agent/agent.mjs (so the server spawns a real agent process,
 *      inside its Job Object, exactly as it would a Claude Code adapter);
 *   3. observes the normalised AbsenceEvents over the session WebSocket + SQLite
 *      and checks the scenario's `expect` block.
 *
 * The mock's protocol trace (`agent-trace.ndjson`) and the Absence event stream
 * (`absence-events.jsonl`) are written side by side under `--out`, so a failing
 * assertion can be read from both ends.
 *
 * Nothing here imports a production adapter module. The server does that itself;
 * a concurrent ACP refactor therefore cannot break this runner's typechecking.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const AGENT_PATH = path.join(HERE, "agent.mjs");
const SCENARIO_DIR = path.join(HERE, "scenarios");
const FIXTURE_PROJECT = path.join(HERE, "fixtures", "project");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

type Json = any;

interface Scenario {
  id: string;
  label?: string;
  agent?: string;
  note?: string;
  workspace?: "fixture" | "empty";
  init?: Json;
  commands?: Json[];
  initialPrompt?: string | { text?: string; fillChars?: number; fillText?: string; repeat?: number; join?: string };
  conversation?: Array<string | { prompt: string; cancelAfterMs?: number }>;
  cancelAfterMs?: number;
  postWaitMs?: number;
  turns?: Json[];
  defaultTurn?: Json;
  approvalAnswer?: string;
  expect?: Json;
  [key: string]: unknown;
}

interface Options {
  all: boolean;
  list: boolean;
  keep: boolean;
  requireExact: boolean;
  verbose: boolean;
  out?: string;
  timeoutMs: number;
  scenarioRefs: string[];
  printProfile?: string;
}

interface AssertionResult {
  label: string;
  ok: boolean;
  skip?: boolean;
  detail?: string;
}

interface CollectedApproval {
  id: string;
  value: string;
}

interface TraceSummary {
  promptCharsReceived: number;
  promptCharsMax: number;
  messageChunks: number;
  messageChars: number;
  thoughtChunks: number;
  thoughtChars: number;
  toolCalls: number;
  toolTerminals: number;
  maxActiveTools: number;
  stopReasons: string[];
  systemPromptChars: number;
  contextWindow: number;
  updates: Record<string, number>;
}

interface Observation {
  scenario: Scenario;
  sessionId: string;
  workspace: string;
  events: Json[];
  runs: Array<{ index: number; status: string }>;
  context?: { used: number | null; total: number | null };
  processPrecision: "exact" | "sampled" | "unknown";
  approvals: CollectedApproval[];
  trace: TraceSummary;
  snapshot: Json;
  postWaitMs: number;
}

interface ScenarioOutcome {
  id: string;
  label: string;
  assertions: AssertionResult[];
  error?: string;
  precision: string;
  tracePath?: string;
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv: string[]): Options {
  const options: Options = {
    all: false,
    list: false,
    keep: false,
    requireExact: false,
    verbose: false,
    timeoutMs: 60_000,
    scenarioRefs: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--all":
        options.all = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--require-exact":
        options.requireExact = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--out":
        options.out = argv[++index];
        break;
      case "--timeout":
        options.timeoutMs = Number(argv[++index] ?? options.timeoutMs);
        break;
      case "--scenario":
        options.scenarioRefs.push(argv[++index] ?? "");
        break;
      case "--print-profile":
        options.printProfile = argv[++index] ?? "";
        options.scenarioRefs.push(options.printProfile);
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`unknown option: ${arg}`);
        }
        options.scenarioRefs.push(arg);
    }
  }
  if (options.scenarioRefs.length === 0) options.all = true;
  return options;
}

function printHelp(): void {
  console.log(`Absence mock agent trigger

Usage:
  tsx scripts/mock-agent/run.ts                 run every scenario against a real server
  tsx scripts/mock-agent/run.ts --all           same, explicit
  tsx scripts/mock-agent/run.ts --scenario <id> run one scenario (id or json path)
  tsx scripts/mock-agent/run.ts --list          list scenarios
  tsx scripts/mock-agent/run.ts --scenario 03-file-ops --keep --verbose

Options:
  --all              every scenario (the default when none is named)
  --scenario <ref>   scenario id (without .json) or a path; repeatable
  --print-profile <ref>  print an ~/.absence/agents.json entry for <ref> and exit
  --list             print the scenario list and exit
  --out <dir>        artifact directory (default: a fresh temp directory)
  --keep             keep the temp home/state/workspaces after the run
  --require-exact    fail process assertions when the kernel observer is unavailable
  --timeout <ms>     per-prompt timeout (default 60000)
  --verbose          print server stderr and per-scenario artifact paths
`);
}

// ---------------------------------------------------------------------------
// scenarios

function loadScenarios(refs: string[]): Scenario[] {
  const files = fs
    .readdirSync(SCENARIO_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort();
  if (refs.length === 0) return files.map((file) => readScenario(path.join(SCENARIO_DIR, file)));
  return refs.map((ref) => {
    const direct = path.isAbsolute(ref) || ref.endsWith(".json") ? path.resolve(ref) : undefined;
    if (direct) {
      if (!fs.existsSync(direct)) throw new Error(`scenario not found: ${direct}`);
      return readScenario(direct);
    }
    const match = files.find((file) => path.basename(file, ".json") === ref || file === ref);
    if (!match) throw new Error(`scenario not found: ${ref} (try --list)`);
    return readScenario(path.join(SCENARIO_DIR, match));
  });
}

function readScenario(file: string): Scenario {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Scenario;
  if (!parsed.id) throw new Error(`scenario has no id: ${file}`);
  // Keep the real path so a scenario loaded from anywhere still reaches the
  // agent; the id alone is the profile id, not a filename assumption.
  Object.defineProperty(parsed, "__file", { value: file, enumerable: false });
  return parsed;
}

function expandInitialPrompt(spec: Scenario["initialPrompt"]): string {
  if (spec === undefined) return "run the scenario";
  if (typeof spec === "string") return spec;
  let text = String(spec.text ?? "");
  if (Number(spec.repeat ?? 0) > 1) {
    text = Array.from({ length: Number(spec.repeat) }, () => text).join(String(spec.join ?? "\n"));
  }
  const target = Number(spec.fillChars ?? 0);
  if (target > 0 && text.length < target) {
    const fill = String(spec.fillText ?? "context filler line for the mock agent.\n");
    const needed = target - text.length;
    text += fill.repeat(Math.ceil(needed / fill.length)).slice(0, needed);
  }
  return text;
}

interface PromptEntry {
  text: string;
  cancelAfterMs?: number;
}

function promptsFor(scenario: Scenario): PromptEntry[] {
  const prompts: PromptEntry[] = [
    { text: expandInitialPrompt(scenario.initialPrompt), cancelAfterMs: scenario.cancelAfterMs },
  ];
  for (const entry of scenario.conversation ?? []) {
    if (typeof entry === "string") prompts.push({ text: entry });
    else prompts.push({ text: entry.prompt, cancelAfterMs: entry.cancelAfterMs });
  }
  return prompts;
}

// ---------------------------------------------------------------------------
// temp layout, server boot

interface ServerContext {
  port: number;
  root: string;
  home: string;
  stateDir: string;
  outDir: string;
  server: ChildProcess;
  stderr: string[];
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

function timestamp(): string {
  return new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 15);
}

async function bootServer(scenarios: Scenario[], options: Options): Promise<ServerContext> {
  if (!fs.existsSync(TSX_CLI)) throw new Error(`tsx not found at ${TSX_CLI}; run npm install`);
  const root = options.out
    ? path.resolve(options.out)
    : path.join(os.tmpdir(), `absence-mock-agent-${timestamp()}`);
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const outDir = path.join(root, "out");
  for (const dir of [home, stateDir, outDir, path.join(home, ".absence"), path.join(home, "projects")]) {
    await fsp.mkdir(dir, { recursive: true });
  }

  // The only production surface this runner touches: a custom profile in
  // ~/.absence/agents.json. Absence reads that file in AgentCatalog and creates
  // the same AcpAdapter it would for Claude Code — no adapter code changes.
  const profiles = scenarios.map((scenario) => ({
    id: profileId(scenario),
    label: `Mock ACP · ${scenario.label ?? scenario.id}`,
    command: process.execPath,
    args: [AGENT_PATH],
    env: {
      ABSENCE_MOCK_SCENARIO: scenarioPath(scenario),
      ABSENCE_MOCK_TRACE: tracePath(outDir, scenario),
    },
  }));
  await fsp.writeFile(
    path.join(home, ".absence", "agents.json"),
    `${JSON.stringify({ agents: profiles }, null, 2)}\n`,
    "utf8",
  );

  const port = await freePort();
  const stderr: string[] = [];
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    PORT: String(port),
    HOST: "127.0.0.1",
    ABSENCE_STATE_DIR: stateDir,
    ABSENCE_PROJECTS_ROOT: path.join(home, "projects"),
    ABSENCE_DOCKER: "0",
    ABSENCE_MCP: "0",
    ABSENCE_LOG_LEVEL: "warn",
    NO_COLOR: "1",
  };
  const server = spawn(process.execPath, [TSX_CLI, "apps/server/src/index.ts"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    const text = String(chunk);
    stderr.push(...text.split(/\r?\n/).filter(Boolean));
    if (stderr.length > 200) stderr.splice(0, stderr.length - 200);
    if (options.verbose) process.stderr.write(`[server] ${text}`);
  });
  server.stdout?.on("data", (chunk: Buffer) => {
    if (options.verbose) process.stderr.write(`[server] ${String(chunk)}`);
  });

  let exited = false;
  server.on("exit", () => {
    exited = true;
  });

  let ready = false;
  for (let attempt = 0; attempt < 80 && !ready; attempt++) {
    if (exited) break;
    await sleep(250);
    ready = await fetch(`http://127.0.0.1:${port}/api/runtimes`)
      .then((response) => response.ok)
      .catch(() => false);
  }
  if (!ready) {
    const tail = stderr.slice(-20).join("\n");
    try {
      server.kill();
    } catch {
      // already gone
    }
    throw new Error(`Absence server did not boot (port ${port})${tail ? `\n${tail}` : ""}`);
  }

  const stop = async (): Promise<void> => {
    try {
      server.kill();
    } catch {
      // already gone
    }
    await waitFor(() => exited, 3000).catch(() => false);
    if (!options.keep && !options.out) {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  return { port, root, home, stateDir, outDir, server, stderr, stop };
}

let activeOutDir = "";
let activeRoot = "";
const scenarioPathCache = new Map<string, string>();

function scenarioPath(scenario: Scenario): string {
  const cached = scenarioPathCache.get(scenario.id);
  if (cached) return cached;
  const fromObject = (scenario as Json).__file;
  const file =
    typeof fromObject === "string" && fs.existsSync(fromObject)
      ? fromObject
      : path.join(SCENARIO_DIR, `${scenario.id}.json`);
  if (!fs.existsSync(file)) throw new Error(`scenario file for ${scenario.id} is missing`);
  scenarioPathCache.set(scenario.id, file);
  return file;
}

function profileId(scenario: Scenario): string {
  return `mock-${scenario.id}`;
}

function tracePath(outDir: string, scenario: Scenario): string {
  return path.join(outDir, scenario.id, "agent-trace.ndjson");
}

// ---------------------------------------------------------------------------
// HTTP + websocket observation

async function api(ctx: ServerContext, method: string, pathname: string, body?: unknown): Promise<Json> {
  const response = await fetch(`http://127.0.0.1:${ctx.port}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Json;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${method} ${pathname} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return parsed;
}

interface LiveCollector {
  events: Json[];
  seen: Set<string>;
  approvals: CollectedApproval[];
  close: () => void;
}

function connectSessionSocket(ctx: ServerContext, sessionId: string, scenario: Scenario): LiveCollector {
  const WS = (globalThis as Json).WebSocket;
  const collector: LiveCollector = {
    events: [],
    seen: new Set(),
    approvals: [],
    close: () => undefined,
  };
  if (typeof WS !== "function") {
    throw new Error("this Node has no global WebSocket; use Node >= 22");
  }

  const socket = new WS(`ws://127.0.0.1:${ctx.port}/ws/sessions/${sessionId}`);
  const add = (event: Json) => {
    if (!event || typeof event.id !== "string" || collector.seen.has(event.id)) return;
    collector.seen.add(event.id);
    collector.events.push(event);
    if (event.type === "approval") answerApproval(ctx, sessionId, scenario, collector, event);
  };

  socket.onmessage = (message: Json) => {
    let parsed: Json;
    try {
      parsed = JSON.parse(String(message.data));
    } catch {
      return;
    }
    if (parsed.type === "snapshot") {
      for (const event of parsed.state?.events ?? []) add(event);
      return;
    }
    if (parsed.type === "events") {
      for (const event of parsed.events ?? []) add(event);
    }
  };
  socket.onerror = () => {
    // The assertion that needs the stream will fail on its own; do not throw
    // from an event handler.
  };
  collector.close = () => {
    try {
      socket.close();
    } catch {
      // already closed
    }
  };
  return collector;
}

function answerApproval(
  ctx: ServerContext,
  sessionId: string,
  scenario: Scenario,
  collector: LiveCollector,
  event: Json,
): void {
  const payload = event.payload ?? {};
  const options = Array.isArray(payload.options) ? payload.options : [];
  const preferred =
    scenario.approvalAnswer ??
    options.find((option: Json) => option?.tone === "accept")?.value ??
    options[0]?.value;
  if (!preferred) return;
  collector.approvals.push({ id: String(payload.id ?? ""), value: String(preferred) });
  void api(ctx, "POST", `/api/sessions/${sessionId}/approval`, {
    id: String(payload.id ?? ""),
    value: String(preferred),
  }).catch(() => undefined);
}

async function fetchArchivedEvents(ctx: ServerContext, sessionId: string): Promise<Json[]> {
  const out: Json[] = [];
  let before: number | undefined;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ limit: "2000" });
    if (before !== undefined) query.set("before", String(before));
    const body = await api(ctx, "GET", `/api/sessions/${sessionId}/events?${query.toString()}`);
    for (const event of body.events ?? []) out.push(event);
    if (body.hasMore !== true || typeof body.nextBefore !== "number") break;
    before = body.nextBefore;
  }
  return out;
}

function mergeEvents(live: Json[], archived: Json[]): Json[] {
  const byId = new Map<string, Json>();
  for (const event of live) if (event?.id) byId.set(event.id, event);
  for (const event of archived) {
    if (!event?.id) continue;
    // The archive stores a preview of large text fields; the live frame is the
    // full value. Never let the preview overwrite a complete live event.
    const current = byId.get(event.id);
    const currentIsPreview = current?.previewTruncated === true || current?.payload?.previewTruncated === true;
    const archivedIsPreview =
      event.previewTruncated === true || event.payload?.previewTruncated === true;
    if (current && !currentIsPreview && archivedIsPreview) continue;
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

// ---------------------------------------------------------------------------
// one scenario

async function runScenario(scenario: Scenario, ctx: ServerContext, options: Options): Promise<ScenarioOutcome> {
  const wsRoot = path.join(ctx.root, "workspaces", scenario.id);
  const workspace = path.join(wsRoot, "project");
  await fsp.mkdir(wsRoot, { recursive: true });
  if (scenario.workspace === "empty") {
    await fsp.mkdir(workspace, { recursive: true });
  } else {
    await fsp.cp(FIXTURE_PROJECT, workspace, { recursive: true });
  }
  const outDir = path.join(ctx.outDir, scenario.id);
  await fsp.mkdir(outDir, { recursive: true });
  const traceFile = tracePath(ctx.outDir, scenario);
  await fsp.mkdir(path.dirname(traceFile), { recursive: true });

  let sessionId = "";
  let collector: LiveCollector | undefined;
  const assertions: AssertionResult[] = [];
  let error: string | undefined;
  let precision = "unknown";

  try {
    const created = await api(ctx, "POST", "/api/sessions", {
      projectPath: workspace.replace(/\\/g, "/"),
      agent: profileId(scenario),
    });
    sessionId = created.session?.id;
    if (!sessionId) throw new Error("POST /api/sessions returned no session id");
    const live = connectSessionSocket(ctx, sessionId, scenario);
    collector = live;
    await sleep(120);

    const prompts = promptsFor(scenario);
    for (const [index, prompt] of prompts.entries()) {
      const before = countEvents(live.events, "agent_end");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await api(ctx, "POST", `/api/sessions/${sessionId}/prompt`, { prompt: prompt.text });
        // Start the cancel clock after the prompt was accepted, so a large
        // request body does not eat the delay before the turn begins.
        if (prompt.cancelAfterMs) {
          timer = setTimeout(() => {
            void api(ctx, "POST", `/api/sessions/${sessionId}/abort`).catch(() => undefined);
          }, prompt.cancelAfterMs);
        }
        const finished = await waitFor(
          () => countEvents(live.events, "agent_end") > before,
          options.timeoutMs,
        );
        if (!finished) {
          await api(ctx, "POST", `/api/sessions/${sessionId}/abort`).catch(() => undefined);
          assertions.push({
            label: `prompt ${index + 1} settled`,
            ok: false,
            detail: `no agent_end within ${options.timeoutMs}ms`,
          });
          break;
        }
        assertions.push({ label: `prompt ${index + 1} settled`, ok: true });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // Let the archive drain, the FileWatcher settle, and late process exits land.
    await sleep(500 + Math.max(0, Number(scenario.postWaitMs ?? 0)));

    const snapshot = await api(ctx, "GET", `/api/sessions/${sessionId}`);
    const archived = await fetchArchivedEvents(ctx, sessionId).catch(() => []);
    const events = mergeEvents(collector.events, archived);
    const runs = [...(snapshot.runs ?? [])]
      .sort((a: Json, b: Json) => Number(a.index ?? 0) - Number(b.index ?? 0))
      .map((run: Json) => ({ index: Number(run.index ?? 0), status: String(run.status ?? "") }));
    const trace = parseTrace(traceFile);

    const observation: Observation = {
      scenario,
      sessionId,
      workspace,
      events,
      runs,
      context: snapshot.context,
      processPrecision:
        snapshot.session?.processPrecision === "exact"
          ? "exact"
          : snapshot.session?.processPrecision === "sampled"
            ? "sampled"
            : "unknown",
      approvals: collector.approvals,
      trace,
      snapshot,
      postWaitMs: Number(scenario.postWaitMs ?? 0),
    };

    assertions.push(...evaluate(scenario, observation, options));
    precision = observation.processPrecision;

    await fsp.writeFile(
      path.join(outDir, "absence-events.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}${events.length > 0 ? "\n" : ""}`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(outDir, "report.json"),
      `${JSON.stringify(
        {
          scenario: { id: scenario.id, label: scenario.label, note: scenario.note },
          sessionId,
          workspace,
          processPrecision: observation.processPrecision,
          runs,
          context: observation.context,
          eventCounts: countByType(events),
          assertions,
          trace,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch (exception) {
    error = exception instanceof Error ? exception.message : String(exception);
    assertions.push({ label: "scenario ran to completion", ok: false, detail: error });
  } finally {
    collector?.close();
    if (sessionId) {
      await api(ctx, "POST", `/api/sessions/${sessionId}/close`).catch(() => undefined);
      await sleep(150);
    }
  }

  return {
    id: scenario.id,
    label: scenario.label ?? scenario.id,
    assertions,
    error,
    precision,
    tracePath: fs.existsSync(traceFile) ? traceFile : undefined,
  };
}

// ---------------------------------------------------------------------------
// assertions

function evaluate(scenario: Scenario, observation: Observation, options: Options): AssertionResult[] {
  const expect = scenario.expect ?? {};
  const results: AssertionResult[] = [];
  const events = observation.events;
  const byType = (type: string) => events.filter((event) => event.type === type);

  if (Array.isArray(expect.runs)) {
    results.push(
      result(
        "run statuses",
        observation.runs.map((run) => run.status).join(", "),
        expect.runs.join(", "),
        observation.runs.map((run) => run.status).join(",") === expect.runs.join(","),
      ),
    );
  }

  for (const [type, spec] of Object.entries(expect.events ?? {})) {
    const actual = byType(type).length;
    const range = countRange(spec);
    results.push(
      result(
        `${type} count`,
        String(actual),
        describeRange(range),
        inRange(actual, range),
      ),
    );
  }

  for (const type of expect.requires ?? []) {
    const actual = byType(type).length;
    results.push(result(`requires ${type}`, String(actual), ">= 1", actual >= 1));
  }

  for (const type of expect.forbids ?? []) {
    const actual = byType(type).length;
    results.push(result(`no ${type} events`, String(actual), "0", actual === 0));
  }

  if (expect.userMessages !== undefined) {
    const actual = events.filter((event) => event.type === "message" && event.payload?.role === "user").length;
    results.push(result("user messages", String(actual), String(expect.userMessages), actual === expect.userMessages));
  }

  if (Array.isArray(expect.agentEndReasons)) {
    const actual = byType("agent_end").map((event) => String(event.payload?.reason ?? ""));
    results.push(
      result("agent_end reasons", actual.join(", "), expect.agentEndReasons.join(", "), actual.join(",") === expect.agentEndReasons.join(",")),
    );
  }

  if (Array.isArray(expect.stopReasons)) {
    const actual = observation.trace.stopReasons;
    results.push(
      result("ACP stop reasons", actual.join(", "), expect.stopReasons.join(", "), actual.join(",") === expect.stopReasons.join(",")),
    );
  }

  for (const predicate of expect.messages ?? []) {
    results.push(checkMessages(predicate, events));
  }

  for (const predicate of expect.commands ?? []) {
    results.push(checkCommands(predicate, byType("command")));
  }

  for (const predicate of expect.fileEdits ?? []) {
    results.push(checkFileEdits(predicate, byType("file_edit")));
  }

  if (Array.isArray(expect.commandExitCodes)) {
    const actual = byType("command").map((event) => Number(event.payload?.exitCode ?? -999));
    results.push(
      result("command exit codes", actual.join(", "), expect.commandExitCodes.join(", "), actual.join(",") === expect.commandExitCodes.join(",")),
    );
  }

  if (Array.isArray(expect.toolErrors)) {
    const actual = byType("tool_end").map((event) => event.payload?.isError === true);
    results.push(
      result("tool_end errors", actual.map(String).join(", "), expect.toolErrors.map(String).join(", "), actual.map(String).join(",") === expect.toolErrors.map(String).join(",")),
    );
  }

  if (expect.approvals) {
    const wanted = Number(expect.approvals.count ?? 0);
    const answered = String(expect.approvals.answered ?? "");
    const actual = observation.approvals;
    const countOk = actual.length === wanted;
    const answerOk = answered.length === 0 || actual.every((entry) => entry.value === answered);
    results.push(
      result("approvals surfaced", String(actual.length), String(wanted), countOk),
    );
    if (answered.length > 0) {
      results.push(
        result("approvals answered", actual.map((entry) => entry.value).join(", "), answered, answerOk),
      );
    }
  }

  for (const file of expect.files ?? []) {
    results.push(checkFile(file, observation.workspace));
  }

  if (expect.usage) {
    const used = Number(observation.context?.used ?? 0);
    const total = Number(observation.context?.total ?? 0);
    const minUsed = Number(expect.usage.minUsed ?? 0);
    const maxUsed = Number(expect.usage.maxUsed ?? Number.MAX_SAFE_INTEGER);
    const expectedTotal = expect.usage.total === undefined ? total : Number(expect.usage.total);
    const ok = used >= minUsed && used <= maxUsed && total === expectedTotal;
    results.push(result("context usage", `${used}/${total}`, `>= ${minUsed}, total ${expectedTotal}`, ok));
  }

  if (expect.promptCharsReceived) {
    const range = countRange(expect.promptCharsReceived);
    const actual = observation.trace.promptCharsReceived;
    results.push(
      result("initial prompt reached the agent", `${actual} chars`, describeRange(range), inRange(actual, range)),
    );
  }

  if (expect.streaming) {
    const s = expect.streaming;
    if (s.messageChunks !== undefined) {
      results.push(checkRange("streamed message chunks", observation.trace.messageChunks, s.messageChunks));
    }
    if (s.thoughtChunks !== undefined) {
      results.push(checkRange("streamed thought chunks", observation.trace.thoughtChunks, s.thoughtChunks));
    }
    if (s.messageChars !== undefined) {
      results.push(checkRange("streamed message chars", observation.trace.messageChars, s.messageChars));
    }
    if (s.thoughtChars !== undefined) {
      results.push(checkRange("streamed thought chars", observation.trace.thoughtChars, s.thoughtChars));
    }
  }

  if (expect.concurrency?.maxActiveTools !== undefined) {
    results.push(checkRange("max concurrent tool calls", observation.trace.maxActiveTools, expect.concurrency.maxActiveTools));
  }

  if (expect.init) {
    if (expect.init.systemPromptChars !== undefined) {
      results.push(checkRange("simulated system prompt chars", observation.trace.systemPromptChars, expect.init.systemPromptChars));
    }
    if (expect.init.contextWindow !== undefined) {
      const ok = observation.trace.contextWindow === Number(expect.init.contextWindow);
      results.push(
        result("context window", String(observation.trace.contextWindow), String(expect.init.contextWindow), ok),
      );
    }
  }

  if (expect.processes) {
    results.push(...checkProcesses(expect.processes, observation, options));
  }

  return results;
}

function checkMessages(predicate: Json, events: Json[]): AssertionResult {
  const messages = events.filter((event) => event.type === "message");
  const matching = messages.filter((event) => {
    const content = String(event.payload?.content ?? "");
    if (predicate.contains !== undefined && !content.includes(String(predicate.contains))) return false;
    if (predicate.minChars !== undefined && content.length < Number(predicate.minChars)) return false;
    if (predicate.maxChars !== undefined && content.length > Number(predicate.maxChars)) return false;
    return true;
  });
  const wanted = Number(predicate.min ?? 1);
  const label = predicate.contains !== undefined
    ? `message contains ${JSON.stringify(predicate.contains)}`
    : predicate.minChars !== undefined
      ? `message >= ${predicate.minChars} chars`
      : "message predicate";
  return result(label, String(matching.length), `>= ${wanted}`, matching.length >= wanted, predicate.detail);
}

function checkCommands(predicate: Json, commands: Json[]): AssertionResult {
  const matching = commands.filter((event) => {
    const payload = event.payload ?? {};
    if (predicate.stdoutContains !== undefined && !String(payload.stdout ?? "").includes(String(predicate.stdoutContains))) return false;
    if (predicate.stderrContains !== undefined && !String(payload.stderr ?? "").includes(String(predicate.stderrContains))) return false;
    if (predicate.commandContains !== undefined && !String(payload.command ?? "").includes(String(predicate.commandContains))) return false;
    if (predicate.exitCode !== undefined && Number(payload.exitCode) !== Number(predicate.exitCode)) return false;
    if (predicate.minStdoutChars !== undefined && String(payload.stdout ?? "").length < Number(predicate.minStdoutChars)) return false;
    if (predicate.exitCodeKnownAbsent === true && payload.exitCodeKnown !== undefined) return false;
    if (predicate.exitCodeKnown === false && payload.exitCodeKnown !== false) return false;
    if (predicate.exitCodeKnown === true && payload.exitCodeKnown === false) return false;
    return true;
  });
  const wanted = Number(predicate.min ?? 1);
  const label = predicate.stdoutContains !== undefined
    ? `command stdout contains ${JSON.stringify(predicate.stdoutContains)}`
    : predicate.stderrContains !== undefined
      ? `command stderr contains ${JSON.stringify(predicate.stderrContains)}`
      : predicate.commandContains !== undefined
        ? `command contains ${JSON.stringify(predicate.commandContains)}`
        : predicate.exitCode !== undefined
          ? `command exitCode ${predicate.exitCode}`
          : predicate.minStdoutChars !== undefined
            ? `command stdout >= ${predicate.minStdoutChars} chars`
            : predicate.exitCodeKnownAbsent === true
              ? "command exit code reported (exitCodeKnown absent)"
              : predicate.exitCodeKnown === false
                ? "command exit code unknown (exitCodeKnown false)"
                : "command predicate";
  return result(label, String(matching.length), `>= ${wanted}`, matching.length >= wanted, predicate.detail);
}

function checkFileEdits(predicate: Json, edits: Json[]): AssertionResult {
  const matching = edits.filter((event) => {
    const payload = event.payload ?? {};
    if (predicate.path !== undefined && String(payload.path ?? "") !== String(predicate.path)) return false;
    if (predicate.beforeContains !== undefined && !String(payload.before ?? "").includes(String(predicate.beforeContains))) return false;
    if (predicate.afterContains !== undefined && !String(payload.after ?? "").includes(String(predicate.afterContains))) return false;
    if (predicate.diffContains !== undefined && !String(payload.diff ?? "").includes(String(predicate.diffContains))) return false;
    return true;
  });
  const wanted = Number(predicate.min ?? 1);
  const label = predicate.beforeContains !== undefined
    ? `file_edit before contains ${JSON.stringify(predicate.beforeContains)}`
    : predicate.afterContains !== undefined
      ? `file_edit after contains ${JSON.stringify(predicate.afterContains)}`
      : predicate.diffContains !== undefined
        ? `file_edit diff contains ${JSON.stringify(predicate.diffContains)}`
        : "file_edit predicate";
  return result(label, String(matching.length), `>= ${wanted}`, matching.length >= wanted, predicate.detail);
}

function checkFile(spec: Json, workspace: string): AssertionResult {
  const absolute = path.resolve(workspace, String(spec.path ?? ""));
  const exists = fs.existsSync(absolute);
  if (spec.exists === false) {
    return result(`file absent: ${spec.path}`, exists ? "exists" : "absent", "absent", !exists);
  }
  if (!exists) {
    return result(`file exists: ${spec.path}`, "absent", "present", false);
  }
  if (spec.contains === undefined && spec.equals === undefined) {
    return result(`file exists: ${spec.path}`, "present", "present", true);
  }
  let content = "";
  try {
    content = fs.readFileSync(absolute, "utf8");
  } catch (exception) {
    return result(`file readable: ${spec.path}`, "unreadable", "readable", false, String(exception));
  }
  if (spec.equals !== undefined) {
    return result(`file content: ${spec.path}`, content.length > 120 ? `${content.slice(0, 120)}…` : content, "exact match", content === String(spec.equals));
  }
  const ok = content.includes(String(spec.contains));
  return result(`file contains: ${spec.path}`, ok ? "found" : "missing", JSON.stringify(String(spec.contains)), ok);
}

function checkProcesses(spec: Json, observation: Observation, options: Options): AssertionResult[] {
  const events = observation.events.filter((event) => event.type === "process");
  const latest = new Map<number, Json>();
  const anyRunning = new Set<number>();
  for (const event of events) {
    const payload = event.payload ?? {};
    const pid = Number(payload.pid ?? 0);
    if (!pid) continue;
    latest.set(pid, payload);
    if (payload.status === "running") anyRunning.add(pid);
  }
  const eggs = [...latest.values()];
  const results: AssertionResult[] = [];
  const precision = observation.processPrecision;
  const bucket = spec[precision === "exact" ? "exact" : "sampled"] ?? spec.exact ?? spec.sampled;

  results.push(
    result("process precision", precision, options.requireExact ? "exact" : "exact or sampled", options.requireExact ? precision === "exact" : precision !== "unknown"),
  );
  if (precision !== "exact" && spec.exact) {
    results.push({
      label: "exact kernel process capture",
      ok: !options.requireExact,
      skip: !options.requireExact,
      detail: `process precision is ${precision}; the Job Object / eBPF observer is unavailable`,
    });
  }

  if (bucket) {
    if (precision !== "exact" && spec.exact && !spec.sampled) {
      // The skip was reported above; exact-only assertions do not run on a
      // sampled observer, because they would be measuring the fallback.
    } else {
      if (bucket.minPids !== undefined) {
        results.push(checkMin("process roots captured", latest.size, Number(bucket.minPids)));
      }
      if (bucket.minChildren !== undefined) {
        const maxChildren = eggs.reduce((max, egg) => Math.max(max, Number(egg.children ?? 0)), 0);
        results.push(checkMin("descendants folded into eggs", maxChildren, Number(bucket.minChildren)));
      }
      if (bucket.minPrimary !== undefined) {
        const actual = eggs.filter((egg) => egg.kind === "primary").length;
        results.push(checkMin("primary eggs", actual, Number(bucket.minPrimary)));
      }
      if (bucket.minTool !== undefined) {
        const actual = eggs.filter((egg) => egg.kind === "tool").length;
        results.push(checkMin("tool eggs", actual, Number(bucket.minTool)));
      }
      for (const needle of bucket.commandLineIncludes ?? []) {
        const found = eggs.some((egg) => String(egg.commandLine ?? "").includes(String(needle)));
        results.push(
          result(
            `process command line contains ${JSON.stringify(needle)}`,
            found ? "found" : "missing",
            "found",
            found,
            eggs.map((egg) => `${egg.name}:${String(egg.commandLine ?? "").slice(0, 60)}`).join(" | "),
          ),
        );
      }
      for (const needle of bucket.commandsInclude ?? []) {
        const found = eggs.some((egg) => String(egg.command ?? "").includes(String(needle)));
        results.push(
          result(`egg attributed to command ${JSON.stringify(needle)}`, found ? "found" : "missing", "found", found),
        );
      }
      if (bucket.minRunningAtAnyPoint !== undefined) {
        results.push(checkMin("processes seen running", anyRunning.size, Number(bucket.minRunningAtAnyPoint)));
      }
    }
  }

  // A pair assertion is the attribution test: the process's own command line
  // and the command window it was credited to must name the same run. On two
  // overlapping executes, an order-based attribution would swap these.
  for (const pair of spec.pairs ?? []) {
    const lineNeedle = String(pair.commandLineContains ?? "");
    const commandNeedle = String(pair.commandContains ?? lineNeedle);
    const matched = eggs.filter(
      (egg) =>
        String(egg.commandLine ?? "").includes(lineNeedle) &&
        String(egg.command ?? "").includes(commandNeedle),
    );
    results.push(
      result(
        `process attribution: ${JSON.stringify(lineNeedle)}`,
        String(matched.length),
        ">= 1",
        matched.length >= 1,
        eggs
          .map(
            (egg) =>
              `${egg.name}: line=${String(egg.commandLine ?? "").slice(0, 40)} command=${String(egg.command ?? "").slice(0, 40)}`,
          )
          .join(" | "),
      ),
    );
  }

  if (spec.allExited === true) {
    if (precision !== "exact") {
      results.push({
        label: "every mock process exited",
        ok: !options.requireExact,
        skip: !options.requireExact,
        detail: `process precision is ${precision}; exit observation is sampled and may lag the collection window`,
      });
    } else {
      const stillRunning = eggs.filter((egg) => egg.status === "running");
      results.push(
        result(
          "every mock process exited",
          `${stillRunning.length} still running`,
          "0",
          stillRunning.length === 0,
          stillRunning.map((egg) => `${egg.name}:${egg.pid}`).join(", "),
        ),
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// trace, counting, small helpers

function parseTrace(file: string): TraceSummary {
  const summary: TraceSummary = {
    promptCharsReceived: 0,
    promptCharsMax: 0,
    messageChunks: 0,
    messageChars: 0,
    thoughtChunks: 0,
    thoughtChars: 0,
    toolCalls: 0,
    toolTerminals: 0,
    maxActiveTools: 0,
    stopReasons: [],
    systemPromptChars: 0,
    contextWindow: 0,
    updates: {},
  };
  if (!fs.existsSync(file)) return summary;

  const active = new Set<string>();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Json;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.event === "initialize") {
      summary.systemPromptChars = Number(entry.systemPromptChars ?? 0);
      summary.contextWindow = Number(entry.contextWindow ?? 0);
      continue;
    }
    if (entry.kind === "prompt") {
      const chars = Number(entry.promptChars ?? 0);
      summary.promptCharsReceived += chars;
      summary.promptCharsMax = Math.max(summary.promptCharsMax, chars);
      continue;
    }
    if (entry.kind === "response" && entry.stopReason) {
      summary.stopReasons.push(String(entry.stopReason));
      continue;
    }
    if (entry.kind !== "update") continue;

    const update = String(entry.update ?? "");
    summary.updates[update] = (summary.updates[update] ?? 0) + 1;
    if (update === "tool_call") {
      summary.toolCalls += 1;
      const id = String(entry.toolCallId ?? "");
      if (id) active.add(id);
      summary.maxActiveTools = Math.max(summary.maxActiveTools, active.size);
    } else if (update === "tool_call_update" && (entry.status === "completed" || entry.status === "failed")) {
      summary.toolTerminals += 1;
      active.delete(String(entry.toolCallId ?? ""));
    } else if (update === "agent_message_chunk") {
      summary.messageChunks += 1;
      summary.messageChars += Number(entry.contentChars ?? 0);
    } else if (update === "agent_thought_chunk") {
      summary.thoughtChunks += 1;
      summary.thoughtChars += Number(entry.contentChars ?? 0);
    }
  }
  return summary;
}

function countByType(events: Json[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function countEvents(events: Json[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

interface CountRange {
  min?: number;
  max?: number;
  eq?: number;
}

function countRange(spec: unknown): CountRange {
  if (typeof spec === "number") return { eq: spec };
  if (typeof spec === "string") {
    const match = /^(>=|<=|=|>|<)\s*(\d+)$/.exec(spec.trim());
    if (!match) return {};
    const value = Number(match[2]);
    switch (match[1]) {
      case ">=":
        return { min: value };
      case "<=":
        return { max: value };
      case ">":
        return { min: value + 1 };
      case "<":
        return { max: value - 1 };
      default:
        return { eq: value };
    }
  }
  if (spec && typeof spec === "object") {
    const record = spec as Json;
    return {
      ...(record.min !== undefined ? { min: Number(record.min) } : {}),
      ...(record.max !== undefined ? { max: Number(record.max) } : {}),
      ...(record.eq !== undefined ? { eq: Number(record.eq) } : {}),
    };
  }
  return {};
}

function inRange(actual: number, range: CountRange): boolean {
  if (range.eq !== undefined) return actual === range.eq;
  if (range.min !== undefined && actual < range.min) return false;
  if (range.max !== undefined && actual > range.max) return false;
  return true;
}

function describeRange(range: CountRange): string {
  if (range.eq !== undefined) return String(range.eq);
  const parts: string[] = [];
  if (range.min !== undefined) parts.push(`>= ${range.min}`);
  if (range.max !== undefined) parts.push(`<= ${range.max}`);
  return parts.length > 0 ? parts.join(" and ") : "any";
}

function checkRange(label: string, actual: number, spec: unknown): AssertionResult {
  const range = countRange(spec);
  return result(label, String(actual), describeRange(range), inRange(actual, range));
}

function checkMin(label: string, actual: number, minimum: number): AssertionResult {
  return result(label, String(actual), `>= ${minimum}`, actual >= minimum);
}

function result(label: string, actual: string, expected: string, ok: boolean, detail?: string): AssertionResult {
  const shown = detail ? `${detail}` : `got ${actual}, expected ${expected}`;
  return { label, ok, detail: ok ? undefined : shown };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(40);
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// output

function printOutcome(outcome: ScenarioOutcome): void {
  console.log(`\n[${outcome.id}] ${outcome.label}`);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const assertion of outcome.assertions) {
    if (assertion.skip) {
      skipped += 1;
      console.log(`  skip ${assertion.label}${assertion.detail ? `  — ${assertion.detail}` : ""}`);
    } else if (assertion.ok) {
      passed += 1;
      console.log(`  ok   ${assertion.label}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${assertion.label}${assertion.detail ? `  — ${assertion.detail}` : ""}`);
    }
  }
  console.log(
    `  ${passed}/${passed + failed} passed${skipped > 0 ? `, ${skipped} skipped` : ""}` +
      (outcome.error ? ` — ${outcome.error}` : ""),
  );
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (exception) {
    console.error(exception instanceof Error ? exception.message : String(exception));
    printHelp();
    process.exit(2);
  }

  const scenarios = loadScenarios(options.scenarioRefs);
  if (options.printProfile) {
    const scenario = scenarios[0];
    if (!scenario) {
      console.error("no scenario selected for --print-profile");
      process.exit(2);
    }
    console.log(
      JSON.stringify(
        {
          agents: [
            {
              id: profileId(scenario),
              label: `Mock ACP · ${scenario.label ?? scenario.id}`,
              command: process.execPath,
              args: [AGENT_PATH],
              env: { ABSENCE_MOCK_SCENARIO: scenarioPath(scenario) },
            },
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  if (options.list) {
    for (const scenario of scenarios) console.log(`${scenario.id}  ${scenario.label ?? ""}`);
    return;
  }
  if (scenarios.length === 0) {
    console.error("no scenarios selected");
    process.exit(2);
  }

  console.log(`Absence mock agent — ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}, real server`);
  let ctx: ServerContext | undefined;
  const outcomes: ScenarioOutcome[] = [];
  try {
    ctx = await bootServer(scenarios, options);
    activeOutDir = ctx.outDir;
    activeRoot = ctx.root;
    console.log(`server: http://127.0.0.1:${ctx.port}  home=${ctx.home}`);
    console.log(`artifacts: ${ctx.outDir}`);
    for (const scenario of scenarios) {
      outcomes.push(await runScenario(scenario, ctx, options));
      printOutcome(outcomes[outcomes.length - 1]!);
    }
  } finally {
    if (ctx) {
      console.log("\nserver: stopping");
      await ctx.stop();
    } else if (!options.keep && activeRoot) {
      await fsp.rm(activeRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const totalAssertions = outcomes.reduce((sum, outcome) => sum + outcome.assertions.length, 0);
  const failures = outcomes.reduce(
    (sum, outcome) => sum + outcome.assertions.filter((assertion) => !assertion.ok && !assertion.skip).length,
    0,
  );
  const skipped = outcomes.reduce(
    (sum, outcome) => sum + outcome.assertions.filter((assertion) => assertion.skip).length,
    0,
  );
  const failedScenarios = outcomes.filter(
    (outcome) =>
      outcome.error !== undefined || outcome.assertions.some((assertion) => !assertion.ok && !assertion.skip),
  );

  console.log("\nScenario summary");
  for (const outcome of outcomes) {
    const failed = outcome.error !== undefined || outcome.assertions.some((assertion) => !assertion.ok && !assertion.skip);
    console.log(
      `  ${failed ? "FAIL" : "PASS"} ${outcome.id}` +
        `${outcome.precision !== "unknown" ? `  (${outcome.precision})` : ""}`,
    );
  }
  console.log(
    `\nmock-agent: ${outcomes.length - failedScenarios.length}/${outcomes.length} scenarios, ` +
      `${totalAssertions - failures - skipped}/${totalAssertions - skipped} assertions passed` +
      `${skipped > 0 ? `, ${skipped} skipped` : ""}`,
  );
  if (activeOutDir && fs.existsSync(activeOutDir)) console.log(`artifacts: ${activeOutDir}`);
  process.exit(failures === 0 && failedScenarios.length === 0 ? 0 : 1);
}

void main().catch((exception) => {
  console.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
  process.exit(2);
});
