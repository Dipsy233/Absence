import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  attributedTree,
  defaultPiCandidates,
  findPiSession,
  pairDefaultSessions,
  piSessionFile,
} from "../../apps/server/src/process/ProcessScanner";
import { ExternalScanner } from "../../apps/server/src/process/ExternalScanner";
import { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";
import { DockerEggs } from "../../apps/server/src/process/DockerEggs";
import type { ProcessTable, ProcInfo } from "../../apps/server/src/process/ProcessTable";
import type { ProcessPayload } from "@absence/core";

if (process.platform === "win32") {
  process.env.ABSENCE_DOCKER = "1";
  const { config } = await import("../../apps/server/src/config");
  assert.equal(config.dockerEnabled, false, "Windows cannot enable container capture");
  const { DockerMonitor } = await import("../../apps/server/src/process/DockerMonitor");
  await assert.rejects(DockerMonitor.get().start(), /disabled/);
  DockerMonitor.get().dispose();
}

const file = path.resolve("external-session.jsonl");
const row = (pid: number, ppid: number, commandLine: string): ProcInfo => ({
  pid, ppid, commandLine, name: "node", startedAt: Date.now(),
});
const agent = row(101, 1, `node /opt/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --session "${file}"`);
assert.equal(piSessionFile(agent), file);
assert.equal(piSessionFile(row(102, 1, `bash -c 'pi --session "${file}"'`)), undefined);
assert.equal(piSessionFile(row(102, 1, "node unrelated.js --session /tmp/foo")), undefined);
assert.equal(piSessionFile(row(102, 1, "pi --session relative.jsonl")), undefined);
let table: ProcessTable = new Map([[101, agent], [201, row(201, 101, "node server.js")], [301, row(301, 201, "node worker.js")], [401, row(401, 1, "node foreign.js")]]);
assert.equal(findPiSession(table, file)?.pid, 101);
assert.deepEqual(attributedTree(table, 101).map((info) => info.pid), [201, 301]);
const ambiguous = new Map(table);
ambiguous.set(102, { ...agent, pid: 102 });
assert.equal(findPiSession(ambiguous, file), undefined);
const events: ProcessPayload[] = [];
const watcher = new ProcessWatcher({ externalTranscript: file, snapshot: async () => table, onProcess: (event) => events.push(event) });
watcher.beginSession("external-test");
assert.deepEqual(watcher.metricsAgentTarget().pids, []);
const command = watcher.begin("node server.js", process.cwd());
watcher.warm();
try {
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(new Set(watcher.metricsAgentTarget().pids), new Set([101, 201, 301]));
  assert.ok(events.some((event) => event.pid === 201));
  assert.ok(!events.some((event) => event.pid === 401 || event.pid === process.pid));
  watcher.end(command);
  table = new Map();
  await new Promise((resolve) => setTimeout(resolve, 4200));
  assert.equal(watcher.metricsAgentTarget().status, "exited");
  assert.ok(events.some((event) => event.pid === 201 && event.status === "exited"));
  console.log("external process attribution checks passed");
} finally {
  watcher.stop();
}

// Default pi (no --session): candidates are pi entries only, pairing binds
// only a unique 1:1 new-process/new-transcript pair.
const now = Date.now();
const defaultPi = row(501, 1, "pi");
const secondPi = row(502, 1, "pi");
const candidateTable: ProcessTable = new Map([[501, defaultPi], [502, secondPi]]);
assert.deepEqual(defaultPiCandidates(candidateTable).map((info) => info.pid), [501, 502]);
// One new process, one new transcript born right after it: a pair.
const freshFile = { file: "fresh.jsonl", createdAt: now - 30_000 };
const started = (pid: number): ProcInfo => ({ ...defaultPi, pid, startedAt: now - 45_000 });
assert.deepEqual(pairDefaultSessions([freshFile], [started(501)]).get("fresh.jsonl"), 501);
// Two pi processes at once: ambiguous, nothing binds.
assert.equal(pairDefaultSessions([freshFile], [started(501), started(502)]).size, 0);
// Two new transcripts: ambiguous the other way round, nothing binds.
assert.equal(
  pairDefaultSessions(
    [freshFile, { file: "fresh2.jsonl", createdAt: now - 30_000 }],
    [started(501)],
  ).size,
  0,
);
// An old transcript (born long before the process) is not this process's.
assert.equal(
  pairDefaultSessions([{ file: "old.jsonl", createdAt: now - 600_000 }], [started(501)]).size,
  0,
);

// A long-lived default pi may resume an older session mid-run. The file it
// wrote last is its current one; the file born beside the process is history —
// this was the stale pairing that put the wrong conversation on the board.
const bornFile = { file: "born.jsonl", createdAt: now - 30_000, lastActivityAt: now - 600_000 };
const resumedFile = { file: "resumed.jsonl", createdAt: now - 3_600_000, lastActivityAt: now - 5_000 };
const resumedPair = pairDefaultSessions([bornFile, resumedFile], [started(501)]);
assert.equal(resumedPair.get("resumed.jsonl"), 501);
assert.equal(resumedPair.has("born.jsonl"), false);

// Project scope: two agents running at once are told apart by cwd, never by
// pairing one project's transcript with the other project's process.
const projectA = path.join(process.cwd(), "project-a");
const projectB = path.join(process.cwd(), "project-b");
const scoped = { ...defaultPi, pid: 503, startedAt: now - 45_000, cwd: projectB + path.sep };
assert.equal(pairDefaultSessions([{ ...freshFile, cwd: projectA }], [scoped]).size, 0);
assert.equal(pairDefaultSessions([{ ...freshFile, cwd: projectB }], [scoped]).get("fresh.jsonl"), 503);
console.log("default-pi pairing checks passed");

// The shared scanner: one snapshot per tick, dispatched to both transcripts.
let scans = 0;
const sharedTable: ProcessTable = new Map([
  [101, agent],
  [201, row(201, 101, "node server.js")],
  [601, { ...defaultPi, pid: 601, startedAt: now - 2_000 }],
]);
const scanner = new ExternalScanner({ snapshot: async () => { scans += 1; return sharedTable; } });
const watcherA = new ProcessWatcher({
  externalTranscript: file, externalScanner: scanner,
  snapshot: async () => sharedTable, onProcess: () => {},
});
const watcherB = new ProcessWatcher({
  externalTranscript: "fresh.jsonl", externalScanner: scanner,
  snapshot: async () => sharedTable, onProcess: () => {},
});
watcherA.beginSession("shared-a");
watcherB.beginSession("shared-b");
try {
  await new Promise((resolve) => setTimeout(resolve, 600));
  // Both registrations were served by one sweep: the first tick fired once.
  assert.equal(scans, 1, "one sweep dispatched to every registered transcript");
  // A got the explicit --session root; B was paired with the default pi born
  // moments before its transcript registered (birth falls back to register
  // time here, inside the pairing window of that process's start).
  const targetA = watcherA.metricsAgentTarget().pids;
  assert.ok(targetA.includes(101) && targetA.includes(201));
  assert.ok(watcherB.metricsAgentTarget().pids.includes(601));
} finally {
  watcherA.stop();
  watcherB.stop();
  scanner.dispose();
}
console.log("shared scanner checks passed");

// A default pi that resumed another session mid-run: the shared scanner must
// follow the file written last, not the one the process was born beside. This
// is the case that made the board watch a DrawForth conversation the agent had
// already left.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "absence-resume-"));
  const startupFile = path.join(dir, "startup.jsonl");
  const resumedPath = path.join(dir, "resumed.jsonl");
  fs.writeFileSync(startupFile, JSON.stringify({ type: "session", id: "startup" }) + String.fromCharCode(10));
  fs.writeFileSync(resumedPath, JSON.stringify({ type: "session", id: "resumed" }) + String.fromCharCode(10));
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(startupFile, old, old);
  const resumedTable: ProcessTable = new Map([
    [701, { ...defaultPi, pid: 701, startedAt: Date.now() - 30_000, cwd: dir }],
  ]);
  const resumeScanner = new ExternalScanner({ snapshot: async () => resumedTable });
  const seen = new Map<string, boolean>();
  for (const name of [startupFile, resumedPath]) {
    resumeScanner.register(name, (root) => seen.set(name, root?.pid === 701), dir);
  }
  try {
    await (resumeScanner as unknown as { scan(): Promise<void> }).scan();
    assert.equal(resumeScanner.bindingFor(701), resumedPath, "the last-written file wins");
    assert.equal(seen.get(startupFile), false, "the abandoned file gets no tree");

    // The agent resumes the other way round: bindings are recomputed, not
    // frozen from the first sweep.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(startupFile, future, future);
    await (resumeScanner as unknown as { scan(): Promise<void> }).scan();
    assert.equal(resumeScanner.bindingFor(701), startupFile, "the binding follows the new file");
    assert.equal(seen.get(resumedPath), false, "the previous file loses the tree");
    console.log("resume rebinding checks passed");
  } finally {
    resumeScanner.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Docker attribution from transcript command windows: an observed session
// opens the window on a transcript tool_start, and the container the command
// predicts becomes that session's egg — no docker daemon needed to pin it.
const dockerEvents: ProcessPayload[] = [];
const dockerWatcher = new ProcessWatcher({
  externalTranscript: file,
  snapshot: async () => new Map(),
  onProcess: (payload) => dockerEvents.push(payload),
});
dockerWatcher.beginSession("docker-test");
const eggs = new DockerEggs(dockerWatcher, (payload) => dockerEvents.push(payload));
const containerId = "a".repeat(64);
try {
  const window = dockerWatcher.begin("docker run -d --name web nginx:alpine", process.cwd());
  eggs.onContainerEvent({
    kind: "start", containerId, name: "web", image: "nginx:alpine", at: Date.now(),
  });
  const egg = dockerEvents.find((event) => event.containerId === containerId);
  assert.ok(egg, "a container the command predicted becomes an egg");
  assert.equal(egg?.kind, "primary");
  assert.ok(egg?.command?.includes("--name web"), "the egg carries the command that laid it");
  dockerWatcher.end(window);
  // The daemon reports every container on the machine: even inside the window
  // slack, a container the command did not predict stays out of the panel.
  eggs.onContainerEvent({
    kind: "start", containerId: "b".repeat(64), name: "foreign", image: "redis:7", at: Date.now(),
  });
  assert.ok(!dockerEvents.some((event) => event.name === "foreign"));
  console.log("observed-session docker attribution checks passed");
} finally {
  dockerWatcher.stop();
  eggs.dispose();
}
