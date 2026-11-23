/**
 * Offline check of mid-way monitoring (P4): attaching to an agent that was
 * already running, and being honest about what the observer could not see.
 *   npx tsx scripts/checks/check-observe-midway.ts
 *
 * A transcript is written whose head is *not* a user message — the shape of a
 * conversation the observer attached to in the middle. What it proves:
 *
 *   1. the backfill recovers every fact already in the file (content is whole);
 *   2. the first run is marked `boundarySource: "attach"` and
 *      `truncatedBefore: true` — history, not a fabricated complete turn;
 *   3. a later user message opens a normal `user-message` run (the live
 *      boundary is the transcript's own, not the attach point);
 *   4. a fact appended while attached flows in incrementally (the tail is live);
 *   5. a backfill of a large file streams in chunks without losing a line, and
 *      reports `backfilling` while it runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish, section } from "./harness";

const NL = String.fromCharCode(10);

// Isolation first: env before the server modules load.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "absence-midway-"));
const stateDir = path.join(root, "state");
const project = path.join(root, "project");
const piRoot = path.join(root, "pi-home", "sessions", "--fixture--");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(piRoot, { recursive: true });
process.env.ABSENCE_STATE_DIR = stateDir;
process.env.ABSENCE_DOCKER = "0";
process.env.ABSENCE_OBSERVE_PI_ROOT = piRoot;
process.env.ABSENCE_ARCHIVE_SILENCE_MS = "0";

const { sessionStore } = await import("../../apps/server/src/sessions/SessionStore");
const { DiscoveryService } = await import("../../apps/server/src/observe/Discovery");
const { readRuns } = await import("../../apps/server/src/sessions/archive");

const waitForAsync = async (predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return false;
};

const EXTERNAL_ID = "pi-midway";
let clock = Date.now() - 60_000;
const stamp = (): number => (clock += 1_000);

const entry = (record: Record<string, unknown>): string =>
  JSON.stringify({ id: `e_${Math.random().toString(36).slice(2, 8)}`, parentId: null, timestamp: new Date(stamp()).toISOString(), ...record });

const header = entry({ type: "session", version: 3, id: EXTERNAL_ID, cwd: project });

// The head is an assistant turn already in flight: no user message before it.
const midTurn = [
  header,
  entry({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "working on it" },
        { type: "toolCall", id: "tc_1", name: "write", arguments: { path: path.join(project, "a.txt"), content: "one\n" } },
      ],
      api: "x",
      provider: "t",
      model: "m",
      usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 14 },
      stopReason: "toolUse",
      timestamp: stamp(),
    },
  }),
  entry({
    type: "message",
    message: { role: "toolResult", toolCallId: "tc_1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false, durationMs: 9, timestamp: stamp() },
  }),
  entry({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "file written" }],
      api: "x",
      provider: "t",
      model: "m",
      usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 25 },
      stopReason: "stop",
      timestamp: stamp(),
    },
  }),
];

const transcriptFile = path.join(piRoot, `${EXTERNAL_ID}.jsonl`);
fs.writeFileSync(transcriptFile, midTurn.join(NL) + NL, "utf8");

const discovery = new DiscoveryService(sessionStore, true);
discovery.start();

section("mid-way backfill");
const found = await waitForAsync(async () => discovery.list().some((row) => row.externalId === EXTERNAL_ID && row.sessionId !== undefined && !row.backfilling));
check("the mid-run transcript attaches", found);
const row = discovery.list().find((entryRow) => entryRow.externalId === EXTERNAL_ID);
const sessionId = row?.sessionId;
check("a session exists", sessionId !== undefined);
if (sessionId === undefined) finish("check-observe-midway");
const session = sessionStore.get(sessionId!)!;

const has = (type: string, match: (payload: any) => boolean): boolean =>
  session.history().some((event) => event.type === type && match(event.payload));
check("the backfilled assistant text is present", has("message", (p) => p.role === "assistant" && p.content === "working on it"));
check("the backfilled tool call is present", has("tool_start", (p) => p.toolCallId === "tc_1"));
check("the backfilled write became a file_write", has("file_write", (p) => p.path === path.join(project, "a.txt")));
check("the backfilled turn end is present", has("agent_end", () => true));

section("the run boundary is honest");
const runs = (await waitForAsync(async () => (await readRuns(sessionId!)).length >= 1, 6_000)) ? await readRuns(sessionId!) : [];
check("a run exists for the mid-way facts", runs.length >= 1, JSON.stringify(runs));
check("it is marked as an attach boundary", runs[0]?.boundarySource === "attach", JSON.stringify(runs[0]));
check("its head is flagged as truncated", runs[0]?.truncatedBefore === true, JSON.stringify(runs[0]));
check("it has no fabricated prompt", (runs[0]?.prompt ?? "x") === "", JSON.stringify(runs[0]?.prompt));

section("a later user turn opens a normal run");
fs.appendFileSync(
  transcriptFile,
  [
    entry({ type: "message", message: { role: "user", content: [{ type: "text", text: "now do more" }], timestamp: stamp() } }),
    entry({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done more" }],
        api: "x",
        provider: "t",
        model: "m",
        usage: { input: 30, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 36 },
        stopReason: "stop",
        timestamp: stamp(),
      },
    }),
  ].join(NL) + NL,
  "utf8",
);
const twoRuns = await waitForAsync(async () => (await readRuns(sessionId!)).length >= 2, 8_000);
check("the appended turn is tailed live", twoRuns);
const allRuns = await readRuns(sessionId!);
const userRun = allRuns.find((run) => run.boundarySource === "user-message");
check("the appended turn is a normal user-message run", userRun !== undefined, JSON.stringify(allRuns.map((r) => r.boundarySource)));
check("its prompt is the real prompt", userRun?.prompt === "now do more", JSON.stringify(userRun?.prompt));

section("a chunked backfill of a large file loses nothing");
// A big transcript (several MB, past the 1MB chunk size) attaches and every
// line must still land: the chunk loop reads to EOF in bounded pieces.
const bigId = "pi-midway-big";
const bigFile = path.join(piRoot, `${bigId}.jsonl`);
const bigLines = [JSON.stringify({ type: "session", version: 3, id: bigId, cwd: project, timestamp: new Date(stamp()).toISOString() })];
bigLines.push(
  JSON.stringify({
    type: "message",
    id: "bu",
    parentId: null,
    timestamp: new Date(stamp()).toISOString(),
    message: { role: "user", content: [{ type: "text", text: "big" }], timestamp: stamp() },
  }),
);
const filler = "x".repeat(2_000);
for (let i = 0; i < 900; i++) {
  bigLines.push(
    JSON.stringify({
      type: "message",
      id: `ba${i}`,
      parentId: "bu",
      timestamp: new Date(stamp()).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `chunk ${i} ${i === 450 ? "界".repeat(400_000) : filler}` }],
        api: "x",
        provider: "t",
        model: "m",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2 },
        stopReason: i === 899 ? "stop" : "toolUse",
        timestamp: stamp(),
      },
    }),
  );
}
fs.writeFileSync(bigFile, bigLines.join(NL) + NL, "utf8");
const firstAttach = discovery.attach(bigFile);
const concurrentAttach = discovery.attach(bigFile);
let sawBackfill = false;
const sampleBackfill = setInterval(() => {
  const row = discovery.list().find((candidate) => candidate.file === bigFile);
  if (!row?.backfilling || !row.sessionId) return;
  sawBackfill = sessionStore.get(row.sessionId)?.isBackfilling() === true;
  clearInterval(sampleBackfill);
  fs.appendFileSync(bigFile, entry({ type: "message", message: {
    role: "user", content: [{ type: "text", text: "appended during backfill" }], timestamp: stamp(),
  } }) + NL);
}, 1);
const [first, concurrent] = await Promise.all([firstAttach, concurrentAttach]);
clearInterval(sampleBackfill);
check("concurrent attaches reuse the same session", first?.sessionId !== undefined && first.sessionId === concurrent?.sessionId);
check("discovery and the live session report backfilling together", sawBackfill);
const bigAttached = await waitForAsync(async () => {
  const matches = discovery.list().filter((entryRow) => entryRow.externalId === bigId && entryRow.sessionId !== undefined);
  return matches.length > 0 && matches[0]?.backfilling !== true;
}, 20_000);
check("the large transcript attaches and finishes backfilling", bigAttached);
const bigRow = discovery.list().find((entryRow) => entryRow.externalId === bigId);
const bigSession = bigRow?.sessionId !== undefined ? sessionStore.get(bigRow.sessionId) : undefined;
const bigUserMessages = bigSession?.history().filter((event) => event.type === "message" && (event.payload as any).role === "user").length ?? 0;
check("the original and concurrent append each appear once", bigUserMessages === 2, `${bigUserMessages} user turns`);
check("the appended user turn reached the session", bigSession?.history().some((event) =>
  event.type === "message" && event.payload.role === "user" && event.payload.content === "appended during backfill",
) === true);
const bigAssistant = bigSession?.history().filter((event) => event.type === "message" && (event.payload as any).role === "assistant").length ?? 0;
check("the large backfill kept all 900 assistant turns", bigAssistant === 900, `${bigAssistant} assistant turns`);

await discovery.stop();
await sessionStore.remove(sessionId!).catch(() => undefined);
if (bigRow?.sessionId) await sessionStore.remove(bigRow.sessionId).catch(() => undefined);

finish("check-observe-midway");