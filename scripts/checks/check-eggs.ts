/**
 * Pure determinism checks for process detection (no server, no spawning).
 *   npx tsx scripts/check-eggs.ts
 *
 * The risky part of "Agent Eggs" is not the snapshot but the *attribution*: which
 * of the processes that appeared during a shell command are the agent's, and
 * which are just the rest of the machine. That logic is a pure function, so it is
 * pinned here — the command window, the ancestor chain, the marker Absence puts on
 * its own shells, and the orphan it refuses to guess about.
 */
import { check, finish } from "./harness";
import { createEvent, type AbsenceEvent } from "@absence/core";
import { attributeProcesses, candidatePids, retiredPids } from "../../apps/server/src/process/ProcessWatcher";
import type { ProcessTable } from "../../apps/server/src/process/ProcessTable";
import { applyProcessEvent, buildEggs, countEggs, filterEggs } from "../../apps/web/src/lib/eggs";



const SERVER = 1000;
const MARK = new Set(["absence-test"]);
/** A command line carrying Absence's marker, as Pi's own shell does. */
const MARKED = (cmd: string) => `bash -c "# absence-test\n${cmd}"`;

/** `[pid, ppid, name, commandLine?]` rows → a process table. */
function table(rows: [number, number, string, string?][], startedAt = 0): ProcessTable {
  const map: ProcessTable = new Map();
  for (const [pid, ppid, name, commandLine] of rows) {
    map.set(pid, { pid, ppid, name, commandLine: commandLine ?? name, startedAt });
  }
  return map;
}

// A. the delta and the window: only what this command could have started.
{
  const previous = table([
    [1000, 4, "node"],
    [1001, 1000, "chrome"], // the user's app: alive before, ignored forever
  ]);
  const settled = table([
    [1000, 4, "node"],
    [1001, 1000, "chrome"],
    [1002, 1000, "node"], // laid by the command we just watched
  ]);
  const candidates = candidatePids(previous, settled, new Set());
  check("a process that appeared since the last look is a candidate", candidates.includes(1002));
  check("something already running is not", !candidates.includes(1001));
  check("something already claimed is not", !candidatePids(previous, settled, new Set([1002])).includes(1002));
  check("with no previous snapshot everything alive is a candidate", candidatePids(undefined, settled, new Set()).length === 3);

  // The window: a `sleep` from the user's own shell must never look like an egg,
  // and neither must the next command's child.
  check(
    "a process that started before the window is not a candidate",
    candidatePids(undefined, table([[1003, 4, "sleep"]], 1_000), new Set(), { from: 10_000, to: 12_000 }).length === 0,
  );
  check(
    "a process that started inside it is",
    candidatePids(undefined, table([[1004, 4, "node"]], 10_500), new Set(), { from: 10_000, to: 12_000 }).length === 1,
  );
  check(
    "the next command's child belongs to the next command",
    candidatePids(undefined, table([[1005, 4, "node"]], 12_500), new Set(), { from: 10_000, to: 12_000 }).length === 0,
  );
  check(
    "an unknown start time falls back to the delta",
    candidatePids(undefined, table([[1006, 4, "mystery"]]), new Set(), { from: 10_000, to: 12_000 }).length === 1,
  );
}

// B. ours means the chain reaches the server.
{
  const snapshot = table([
    [1000, 4, "node"],
    [1001, 1000, "bash", MARKED("npm test")],
    [1002, 1001, "node"],
    [1003, 5000, "chrome"],
    [5000, 4002, "explorer"],
    [4002, 0, "system"],
  ]);
  const { roots, claimed } = attributeProcesses(snapshot, [1001, 1002, 1003], new Set(), SERVER, MARK);
  check("a descendant of the server is ours", claimed.includes(1002));
  check("an unrelated process is not", !claimed.includes(1003));
  check("the shell Absence drove is not an egg", !claimed.includes(1001));
  check("what it ran becomes the egg", roots.length === 1 && roots[0]?.pid === 1002);
  // A freshly started server is young enough to fall inside the first command's
  // window; claiming it swallowed everything the command spawned.
  check(
    "the observer is never an egg, even inside the window",
    attributeProcesses(table([[1000, 4, "node"]]), [1000], new Set(), SERVER).claimed.length === 0,
  );
}

// C. a subtree that is not a shell collapses to its root.
{
  const snapshot = table([
    [1000, 4, "node"],
    [1001, 1000, "bash", MARKED("npm run dev")],
    [1002, 1001, "npm"],
    [1003, 1002, "node"],
    [1004, 1003, "esbuild"],
  ]);
  const { roots, children } = attributeProcesses(snapshot, [1001, 1002, 1003, 1004], new Set(), SERVER, MARK);
  check("one command is one egg", roots.length === 1 && roots[0]?.pid === 1002, `roots=${roots.map((r) => r.pid)}`);
  check("with its descendants rolled up", children.get(1002) === 2, `got ${children.get(1002)}`);
}

// D. the agent's own shell script is an egg — Absence's marker is what tells them apart.
{
  const snapshot = table([
    [1000, 4, "node"],
    [1001, 1000, "bash", MARKED("timeout 20 bash daemon.sh")],
    [1002, 1001, "timeout"],
    [1003, 1002, "bash", '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" daemon.sh'],
    [1004, 1003, "sleep"],
  ]);
  const { roots, children, claimed } = attributeProcesses(
    snapshot,
    [1001, 1002, 1003, 1004],
    new Set(),
    SERVER,
    MARK,
  );
  check("an unmarked shell the agent started is ours", claimed.includes(1003));
  check("the marked launcher is not", !claimed.includes(1001));
  check("the daemon is reported through its launcher", roots.length === 1 && roots[0]?.pid === 1002);
  check("with the script and its sleep rolled in", children.get(1002) === 2, `got ${children.get(1002)}`);
  check(
    "a console host is never an egg",
    attributeProcesses(table([[1000, 4, "node"], [1001, 1000, "conhost.exe"]]), [1001], new Set(), SERVER).claimed
      .length === 0,
  );
}

// E. a child of an egg we already reported is part of that egg.
{
  const snapshot = table([
    [1000, 4, "node"],
    [2000, 1000, "npm"], // claimed by an earlier look
    [2001, 2000, "node"], // appears a second later — npm's child, not a new egg
  ]);
  const { roots, claimed } = attributeProcesses(snapshot, [2001], new Set([2000]), SERVER);
  check("a child of an egg we already reported is not a new egg", claimed.length === 0 && roots.length === 0);
}

// F. an orphan of unknown parentage is not attributed to the agent.
{
  const stranger = table([[1000, 4, "node"], [4000, 8888, "sleep"]]);
  check("an orphan is somebody else's process", attributeProcesses(stranger, [4000], new Set(), SERVER, MARK).claimed.length === 0);
  const stranger2 = table([[1000, 4, "node"], [4000, 4001, "explorer"], [4001, 4002, "userinit"], [4002, 0, "system"]]);
  check("a stranger's process is left alone", attributeProcesses(stranger2, [4000], new Set(), SERVER).claimed.length === 0);
}

// G. eggs fold by pid: laid once, then updated in place.
{
  const SID = "sess_eggs";
  const laid = createEvent(SID, "process", {
    pid: 4242,
    ppid: 1000,
    name: "node",
    commandLine: "node server.js",
    status: "running",
    startedAt: 1_000,
    children: 2,
    command: "npm run dev",
  });
  const died = createEvent(SID, "process", {
    pid: 4242,
    ppid: 1000,
    name: "node",
    commandLine: "node server.js",
    status: "exited",
    startedAt: 1_000,
    exitedAt: 61_000,
    children: 2,
    command: "npm run dev",
  });
  const other = createEvent(SID, "process", {
    pid: 4343,
    ppid: 1000,
    name: "esbuild",
    commandLine: "esbuild --watch",
    status: "running",
    startedAt: 2_000,
    children: 0,
  });
  const events: AbsenceEvent[] = [laid, other, died];

  const eggs = buildEggs(events);
  check("two pids fold into two eggs", eggs.length === 2, `got ${eggs.length}`);
  check("the later state wins", eggs.find((egg) => egg.pid === 4242)?.status === "exited");
  check("newest first", eggs[0]?.pid === 4343);
  check("the egg keeps what laid it", eggs.find((egg) => egg.pid === 4242)?.command === "npm run dev");

  const counts = countEggs(eggs);
  check("counts split running from dead", counts.running === 1 && counts.dead === 1 && counts.all === 2);
  check("the running tab shows only live eggs", filterEggs(eggs, "running").length === 1);
  check("the dead tab shows only exited eggs", filterEggs(eggs, "dead")[0]?.pid === 4242);
  check("the all tab shows everything", filterEggs(eggs, "all").length === 2);

  const nonProcess: AbsenceEvent[] = [createEvent(SID, "message", { role: "assistant", content: "hi" })];
  check("non-process events are ignored", buildEggs(nonProcess).length === 0);
}

// E. retirement: the finished set is bounded, running eggs never are.
{
  const mk = (pid: number, status: "running" | "exited", startedAt: number, exitedAt?: number) => ({
    pid,
    status,
    startedAt,
    exitedAt,
  });

  const eggs = [
    mk(1, "exited", 100, 110),
    mk(2, "exited", 200, 210),
    mk(3, "exited", 300, 310),
    mk(4, "running", 400),
    mk(5, "exited", 500, 510),
  ];

  check("under the limit nothing is retired", retiredPids(eggs, 5).length === 0);
  check("limit 0 keeps everything", retiredPids(eggs, 0).length === 0);
  check(
    "over the limit the oldest exits go first",
    JSON.stringify(retiredPids(eggs, 2)) === JSON.stringify([1, 2]),
    JSON.stringify(retiredPids(eggs, 2)),
  );
  check("a running egg is never retired", !retiredPids(eggs, 1).includes(4));
  check(
    "only as many as overflow are retired",
    retiredPids(eggs, 3).length === 1 && retiredPids(eggs, 3)[0] === 1,
  );

  // Two exits at the same instant: order must still be deterministic.
  const tied = [mk(7, "exited", 100, 500), mk(8, "exited", 200, 500), mk(9, "exited", 300, 500)];
  const retired = retiredPids(tied, 1);
  check("ties fall back to start time", retired.length === 2 && retired[0] === 7);

  // A retired egg is dropped from the live fold, not turned into a new one.
  const live = new Map<number, ReturnType<typeof buildEggs>[number]>();
  const SID2 = "retire";
  const running = createEvent(SID2, "process", {
    pid: 900,
    ppid: 1,
    name: "node",
    commandLine: "node server.js",
    status: "exited",
    startedAt: 1000,
    exitedAt: 1100,
    children: 0,
    kind: "primary",
  });
  const retireEvent = createEvent(SID2, "process", {
    pid: 900,
    ppid: 1,
    name: "node",
    commandLine: "node server.js",
    status: "exited",
    startedAt: 1000,
    exitedAt: 1100,
    children: 0,
    kind: "primary",
    retired: true,
  });
  applyProcessEvent(live, running);
  check("an egg is present before it is retired", live.has(900));
  applyProcessEvent(live, retireEvent);
  check("a retired egg is dropped from the live view", !live.has(900));
}

finish();
