import assert from "node:assert/strict";
import path from "node:path";
import { attributedTree, findPiSession, piSessionFile } from "../../apps/server/src/process/ProcessScanner";
import { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";
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
