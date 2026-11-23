/**
 * Offline check of the transcript observation channel (no agent, no ACP).
 *   npx tsx scripts/checks/check-observe-transcript.ts
 *
 * A fixture pi session transcript is written into a fake discovery root, the
 * way pi itself would (one JSON entry per line, real entry shapes sampled from
 * `~/.pi/agent/sessions` and specified at docs.pi.dev/latest/session-format.md).
 * What it proves:
 *
 *   1. discovery finds the transcript and attaches it to an AbsenceSession
 *      created on demand — no agent was started, no prompt was sent;
 *   2. the backfill recovers a whole turn from the transcript: message,
 *      thinking, tool_start/tool_end, the write tool's file_write, the stated
 *      turn boundary (`stopReason: "stop"`) and the reported usage — every
 *      fact `source: "transcript"`;
 *   3. the run index and the archive agree with the transcript (one run per
 *      user turn, file versions persisted, history row runtime recorded);
 *   4. a mid-observation append (turn 2 with a failing bash command) is tailed
 *      incrementally and lands as a second run, its command honestly marked
 *      exit-code-unknown (the transcript does not carry one);
 *   5. an observed session refuses to be driven: prompt throws, command is
 *      answered with a notice, nothing is ever sent to an agent;
 *   6. attach is idempotent per (channel, externalId).
 *
 * Uses a private ABSENCE_STATE_DIR and a private discovery root, so it never
 * touches the user's own archives or agent data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMeta, readRuns, readFileVersions } from "../../apps/server/src/sessions/archive";
import { check, finish, section, waitFor } from "./harness";

/** waitFor for async predicates — the shared harness one takes sync predicates only. */
const waitForAsync = async (predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return false;
};

// Isolation first: env must be set before the server modules are imported.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "absence-observe-"));
const stateDir = path.join(root, "state");
const project = path.join(root, "project");
const piRoot = path.join(root, "pi-home", "sessions", "--fixture--");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(piRoot, { recursive: true });
process.env.ABSENCE_STATE_DIR = stateDir;
process.env.ABSENCE_DOCKER = "0";
process.env.ABSENCE_OBSERVE_PI_ROOT = piRoot;

const { sessionStore } = await import("../../apps/server/src/sessions/SessionStore");
const { DiscoveryService } = await import("../../apps/server/src/observe/Discovery");

const EXTERNAL_ID = "pi-fixture-session-1";

let clock = Date.now() - 60_000;
const entryStamp = (): string => new Date((clock += 1_000)).toISOString();
const messageStamp = (): number => clock += 1_000;

const entry = (record: Record<string, unknown>): string =>
  JSON.stringify({ id: `e_${Math.random().toString(36).slice(2, 8)}`, parentId: null, timestamp: entryStamp(), ...record });

const userMessage = (text: string): string =>
  entry({
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], timestamp: messageStamp() },
  });

const assistantMessage = (blocks: unknown[], stopReason: string, usage: Record<string, number>): string =>
  entry({
    type: "message",
    message: {
      role: "assistant",
      content: blocks,
      api: "anthropic-messages",
      provider: "test",
      model: "test-model",
      usage: { input: usage.input, output: usage.output, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: usage.input + usage.output },
      stopReason,
      timestamp: messageStamp(),
    },
  });

const toolResultMessage = (toolCallId: string, toolName: string, isError: boolean, text: string): string =>
  entry({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: text.length > 0 ? [{ type: "text", text }] : [],
      isError,
      durationMs: 12,
      timestamp: messageStamp(),
    },
  });

const header = entry({
  type: "session",
  version: 3,
  id: EXTERNAL_ID,
  cwd: project,
});

const turn1 = [
  header,
  userMessage("create the file"),
  assistantMessage(
    [
      { type: "thinking", thinking: "I should create the file." },
      { type: "text", text: "Creating it now." },
      { type: "toolCall", id: "tc_1", name: "write", arguments: { path: path.join(project, "a.txt"), content: "hello\nworld\n" } },
    ],
    "toolUse",
    { input: 10, output: 5 },
  ),
  toolResultMessage("tc_1", "write", false, "ok"),
  assistantMessage([{ type: "text", text: "Done — a.txt has two lines." }], "stop", { input: 40, output: 9 }),
];

const transcriptFile = path.join(piRoot, `2026-01-01T00-00-00-000Z_${EXTERNAL_ID}.jsonl`);
fs.writeFileSync(transcriptFile, turn1.join("\n") + "\n", "utf8");

section("discovery");

let discovery = new DiscoveryService(sessionStore, true);
discovery.start();

const found = await waitFor(() => discovery.list().some((row) => row.externalId === EXTERNAL_ID && row.sessionId !== undefined), 8_000);
check("discovery finds the fixture transcript and attaches it", found);
const rows = discovery.list();
const row = rows.find((entry_) => entry_.externalId === EXTERNAL_ID);
check("the discovery row names the project from the session header", row?.projectPath === project, JSON.stringify(row));
check("the discovery row records the source profile", row?.source === "pi" && row?.agentKind === "pi");

const sessionId = row?.sessionId;
check("an AbsenceSession exists for the observation", sessionId !== undefined && sessionStore.get(sessionId!) !== undefined);
if (sessionId === undefined) finish("check-observe-transcript");
const session = sessionStore.get(sessionId!)!;

check("the session carries the observation metadata", session.observe?.channel === "transcript" && session.observe?.externalId === EXTERNAL_ID);
check("the observed session started no runtime", session.session.status === "listening");

section("backfill (turn 1)");

const hasEvent = (type: string, match: (payload: any) => boolean): boolean =>
  session.history().some((event) => event.type === type && match(event.payload));
const inOrder = (types: string[]): boolean => {
  const actual = session.history().map((event) => event.type);
  let index = 0;
  for (const event of actual) {
    if (event === types[index]) index += 1;
    if (index === types.length) return true;
  }
  return false;
};

check("the user message came from the transcript", hasEvent("message", (payload) => payload.role === "user" && payload.content === "create the file"));
check("the thinking block is a fact", hasEvent("thinking", (payload) => payload.content === "I should create the file."));
check("the assistant reply arrived before the tool call", inOrder(["message", "tool_start"]) && hasEvent("message", (payload) => payload.role === "assistant" && payload.content === "Creating it now."));
check("the write tool opened", hasEvent("tool_start", (payload) => payload.toolName === "write" && payload.toolCallId === "tc_1"));
check("the write tool closed", hasEvent("tool_end", (payload) => payload.toolName === "write" && payload.isError === false));
check("the write tool became a file_write with the content", hasEvent("file_write", (payload) => payload.path === path.join(project, "a.txt") && payload.content === "hello\nworld\n"));
check("the stated turn boundary closed with agent_end", hasEvent("agent_end", (payload) => payload.reason === "completed"));
check("the model arrived as a fact", session.session.model === "test-model");
check("usage carries the reported token counts", hasEvent("usage", (payload) => payload.estimated === true && payload.outputEst === 14 && payload.contextUsed === 40));
check("every transcript fact is tagged source=transcript", session.history().length > 0 && session.history().every((event) => event.source === "transcript"));
check("tool lifecycle is ordered: start → end → write", inOrder(["tool_start", "tool_end", "file_write"]));

section("persistence");

const runs = (await waitForAsync(async () => (await readRuns(sessionId!)).length >= 1, 6_000)) ? await readRuns(sessionId!) : [];
check("the run index holds one run for the turn", runs.length === 1, `runs=${runs.length}`);
check("the run kept the prompt as its identity", runs[0]?.prompt === "create the file", JSON.stringify(runs[0]));

const versions = await readFileVersions(sessionId!);
const written = versions.find((version) => version.path === path.join(project, "a.txt"));
check("the file version was persisted with the full content", written !== undefined && (written as any).content === "hello\nworld\n", JSON.stringify(versions.map((v) => v.path)));

const meta = await readMeta("", sessionId!);
check("the history row records the observed runtime", meta?.runtime === "pi", JSON.stringify(meta?.runtime));

section("mid-observation append (turn 2)");

const turn2 = [
  userMessage("run the failing command"),
  assistantMessage(
    [{ type: "toolCall", id: "tc_2", name: "bash", arguments: { command: "exit 7" } }],
    "toolUse",
    { input: 60, output: 4 },
  ),
  toolResultMessage("tc_2", "bash", true, ""),
  assistantMessage([{ type: "text", text: "It failed as expected." }], "stop", { input: 80, output: 6 }),
];
fs.appendFileSync(transcriptFile, turn2.join("\n") + "\n", "utf8");

const twoRuns = await waitForAsync(async () => (await readRuns(sessionId!)).length >= 2, 10_000);
check("the appended turn is tailed incrementally", twoRuns);
const commandEvent = session.history().find((event) => event.type === "command");
check("the bash call became a command fact", commandEvent !== undefined && (commandEvent.payload as any).command === "exit 7", JSON.stringify(commandEvent?.payload));
check("the exit code is honestly unknown (the transcript carries none)", commandEvent !== undefined && (commandEvent.payload as any).exitCodeKnown === false && (commandEvent.payload as any).exitCode === 1, JSON.stringify(commandEvent?.payload));
check("the second run closed", (await readRuns(sessionId!)).every((run) => run.status !== "running"), JSON.stringify((await readRuns(sessionId!)).map((run) => run.status)));

section("the observer refuses to drive");

let promptRefused = false;
try {
  session.prompt("hello agent");
} catch {
  promptRefused = true;
}
check("prompt() throws on an observed session", promptRefused);
check("prompting recorded no user message", !hasEvent("message", (payload) => payload.role === "user" && payload.content === "hello agent"));

await session.runCommand("model", "other-model");
const notices = session.history().filter((event) => event.type === "message" && (event.payload as any).role === "system");
check("a command is answered with a notice, not forwarded", notices.some((event) => (event.payload as any).content.includes("Observed sessions accept no commands")));

const again = await sessionStore.createObserved(project, "pi", { channel: "transcript", externalId: EXTERNAL_ID });
check("attach is idempotent per (channel, externalId)", again.id === sessionId);

// Re-attach across a restart: the archive keyed (channel, externalId) is
// found, the same absence session id is reused, and the replayed history is
// the session's opening facts — no duplicate archive row per server lifetime.
// A real restart means a brand-new discovery service: the old one's session
// map and tail offsets do not survive it.
discovery.stop();
discovery = new DiscoveryService(sessionStore, true);
discovery.start();
await sessionStore.remove(sessionId!);
const reattached = await sessionStore.createObserved(project, "pi", { channel: "transcript", externalId: EXTERNAL_ID });
check("a restart re-attaches by identity, not a new archive row", reattached.id === sessionId, reattached.id);
const replayed = reattached.history().length;
check("the reopened archive replays its history", replayed > 0, `${replayed} events`);

// Re-attach then attach again: the session already holds the transcript's
// history from the archive replay, so attaching warms the parser silently —
// the conversation must NOT appear twice in the chat.
await discovery.attach(transcriptFile);
const afterWarm = reattached.history().length;
check("a re-attach does not backfill its history twice", afterWarm === replayed, `${replayed} → ${afterWarm}`);

// …and an append still flows incrementally into the warmed session.
fs.appendFileSync(
  transcriptFile,
  `${JSON.stringify({
    type: "message",
    id: "ff000010",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "turn three" }], timestamp: Date.now() },
  })}\n`,
);
const changeReady = await waitForAsync(() => reattached.history().some((event) => event.type === "message" && (event.payload as any).content === "turn three"));
check("an append after a warm re-attach still reaches the session", changeReady, "turn three seen");

await discovery.stop();
await sessionStore.remove(sessionId!);

finish("check-observe-transcript");
