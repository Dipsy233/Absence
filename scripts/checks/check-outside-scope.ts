/**
 * Outside-project file monitoring: attribution and scope.
 *
 *   npx tsx scripts/checks/check-outside-scope.ts
 *
 * Two things used to go wrong here:
 *
 *   1. **False positives.** A sibling agent's write on a shared path arrived
 *      inside the 120 s window and was reported as this session's agent. Path
 *      plus time was not enough; the tool write's content is now the second
 *      half of the proof.
 *   2. **Scope.** Only the project's parent directory was watched. A named path
 *      anywhere else was invisible. Named tool/command paths now get a bounded,
 *      non-recursive, on-demand watcher; nothing watches the whole disk.
 *
 * White-box on purpose: it builds a real `AbsenceSession` (mock runtime, no
 * credentials) and calls the same internal hook an adapter write goes through
 * (`noteAgentWrite`) for the tool-write scenarios. The OS watcher,
 * `OutsideAttribution`, session bus and archive are all real. `check-fsdiff`
 * covers the adapter/command path end to end.
 */
import { check, finish, section, waitFor } from "./harness";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AbsenceEvent } from "@absence/core";
import { FileWatcher } from "../../apps/server/src/filesystem/FileWatcher";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "absence-outside-scope-"));
const projA = path.join(root, "proj-a");
const projB = path.join(root, "proj-b");
const elsewhere = path.join(os.tmpdir(), `absence-elsewhere-${Date.now()}`);
await fs.mkdir(projA, { recursive: true });
await fs.mkdir(projB, { recursive: true });
await fs.mkdir(elsewhere, { recursive: true });

// Config is read at import time: isolate state and the archive.
process.env.ABSENCE_STATE_DIR = path.join(root, "state");
const { AbsenceSession } = await import("../../apps/server/src/sessions/SessionStore");

const session = new AbsenceSession(projA, "mock");
const events: AbsenceEvent[] = [];
session.bus.subscribe((event) => events.push(event));
await session.start();
const watcher = (session as unknown as { watcher: FileWatcher }).watcher;
const noteWrite = (absolute: string, content: string): void =>
  (session as unknown as { noteAgentWrite: (p: string, c: string) => void }).noteAgentWrite(
    absolute,
    content,
  );

const outsideEventsFor = (absolute: string): AbsenceEvent[] =>
  events.filter(
    (event) =>
      event.type === "file_change" &&
      event.payload.outside === true &&
      path.resolve(event.payload.path) === path.resolve(absolute),
  );

try {
  section("sibling project: fresh paths are silent");
  const fresh = path.join(projB, "b-new.txt");
  await fs.writeFile(fresh, "B\n", "utf-8");
  await sleep(1_000);
  check("B's fresh sibling write is not reported", outsideEventsFor(fresh).length === 0);

  const windowed = path.join(projB, "b-window.txt");
  const window = (session as unknown as {
    processWatcher: { begin: (c: string, cwd?: string) => number; end: (id: number) => void };
  }).processWatcher.begin('node -e "setTimeout(()=>{}, 30000)"', projA);
  await fs.writeFile(windowed, "B\n", "utf-8");
  await sleep(1_000);
  check("B's fresh write inside A's command window is not reported", outsideEventsFor(windowed).length === 0);
  (session as unknown as { processWatcher: { end: (id: number) => void } }).processWatcher.end(window);

  section("unrelated directory without a claim");
  const far = path.join(elsewhere, "far.txt");
  await fs.writeFile(far, "far\n", "utf-8");
  await sleep(1_000);
  check("an unclaimed write outside every watched root is invisible", outsideEventsFor(far).length === 0);

  section("on-demand: a tool-reported path beyond the parent");
  const farReported = path.join(elsewhere, "reported.txt");
  noteWrite(farReported, "A");
  await sleep(700); // let chokidar attach to the on-demand directory
  await fs.writeFile(farReported, "A", "utf-8");
  await sleep(1_000);
  check(
    "A's reported write beyond the parent is reported",
    outsideEventsFor(farReported).length > 0,
    JSON.stringify(events.filter((e) => e.type === "file_change")),
  );

  section("on-demand: a command naming an outside path");
  const cmdTarget = path.join(elsewhere, "cmd-report.txt");
  const posixTarget = cmdTarget.replace(/\\/g, "/");
  const from = events.length;
  await session.prompt(
    `$ node -e "setTimeout(()=>require('fs').writeFileSync('${posixTarget}','A'), 1200)"`,
  );
  await waitFor(
    () => events.slice(from).some((event) => event.type === "agent_end"),
    15_000,
  );
  await sleep(1_000);
  check(
    "a shell write to a command-named outside path is reported",
    outsideEventsFor(cmdTarget).length > 0,
    JSON.stringify(events.filter((e) => e.type === "file_change")),
  );

  section("control: A really writes a shared file outside");
  const shared = path.join(root, "shared.txt");
  noteWrite(shared, "A");
  await fs.writeFile(shared, "A", "utf-8");
  check(
    "A's own outside write is reported",
    await waitFor(() => outsideEventsFor(shared).length > 0, 3_000),
  );

  section("the sibling later writes the same shared file");
  await sleep(2_000);
  await fs.writeFile(shared, "B", "utf-8");
  await sleep(1_000);
  check(
    "B's differing write is silent",
    outsideEventsFor(shared).length === 1,
    `events=${outsideEventsFor(shared).length}`,
  );

  section("A reports a path but the watcher never saw A's write");
  const shared2 = path.join(projB, "b-shared.txt");
  noteWrite(shared2, "A");
  await sleep(300);
  await fs.writeFile(shared2, "B", "utf-8");
  await sleep(1_000);
  check(
    "B's differing write of A's reported path is silent",
    outsideEventsFor(shared2).length === 0,
    JSON.stringify(events.filter((e) => e.type === "file_change")),
  );

  section("on-demand registry is bounded and releases");
  const registry = new FileWatcher(projA, () => {}, () => {});
  const extra = [1, 2, 3, 4].map((n) => path.join(elsewhere, `leased-${n}.txt`));
  const releases = extra.map((file) => registry.watchExternalFile(file, () => {}, 1_000));
  const stats = registry.externalStats();
  check(
    "one directory, one target per named file",
    stats.dirs === 1 && stats.paths === extra.length,
    JSON.stringify(stats),
  );
  for (const release of releases) release();
  const released = registry.externalStats();
  check("releases empty the registry", released.dirs === 0 && released.paths === 0, JSON.stringify(released));
  const ttlRelease = registry.watchExternalFile(path.join(elsewhere, "leased-ttl.txt"), () => {}, 200);
  await sleep(500);
  const expired = registry.externalStats();
  check("TTL also empties the registry", expired.dirs === 0 && expired.paths === 0, JSON.stringify(expired));
  ttlRelease();
  await registry.close();
} finally {
  await session.dispose();
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(elsewhere, { recursive: true, force: true }).catch(() => undefined);
  finish("outside-scope checks");
}
