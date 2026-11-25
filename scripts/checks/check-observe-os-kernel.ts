import assert from "node:assert/strict";
import { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";
import { TargetedObserver } from "../../apps/server/src/process/TargetedObserver";
import type { ProcessTable, ProcInfo } from "../../apps/server/src/process/ProcessTable";
import type { WatchExit, WatchStart } from "../../apps/server/src/process/observer";
import type { ProcessPayload } from "@absence/core";

/**
 * Offline check of the pure third-party monitoring path (no proxy, no launch).
 *
 * The user keeps running pi in their own terminal; Absence attaches a kernel
 * observer to that already-running pid and reports its subtree without
 * polling. Two backends are exercised with injected event streams so the
 * check is deterministic and needs no real helper:
 *
 *   - job    — the Windows Job Object backend (events already scoped to the
 *              adopted pid): a seed pass plus the kernel's own stream;
 *   - filter — the Linux machine-wide backend: unrelated pids are dropped by
 *              the ancestry filter, only the chosen subtree survives.
 *
 * It also pins the ProcessWatcher integration: an OS-only watch with an
 * external pid ends up driven by kernel events, not the table sweep, and
 * reports `exact` precision through `onPrecision`.
 */

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const now = Date.now();
const proc = (pid: number, ppid: number, name: string, startedAt = now): ProcInfo => ({
  pid,
  ppid,
  name,
  commandLine: `${name} --x`,
  startedAt,
});

// ---------------------------------------------------------------------------
console.log("[targeted observer — job backend]");
{
  const ROOT = 5000;
  const table: ProcessTable = new Map([
    [ROOT, proc(ROOT, 1, "pi", now)],
    [5001, proc(5001, ROOT, "node")],
    [5002, proc(5002, 5001, "worker")],
    [5999, proc(5999, 1, "unrelated")],
  ]);
  let kernelPush: (e: WatchStart | WatchExit) => void = () => {};
  const observer = new TargetedObserver({
    pid: ROOT,
    startedAt: now,
    backend: "job",
    snapshot: async () => table,
    subscribeKernel: (listener) => {
      kernelPush = listener;
      return () => {
        kernelPush = () => {};
      };
    },
  });
  const starts: number[] = [];
  const exits: number[] = [];
  let status = "";
  observer.on("start", (e) => starts.push(e.pid));
  observer.on("exit", (e) => exits.push(e.pid));
  observer.on("status", (s) => {
    status = s;
  });
  await observer.start();
  check("ready", status === "watching");
  check("seed emits existing descendants only", starts.includes(5001) && starts.includes(5002) && !starts.includes(ROOT) && !starts.includes(5999), JSON.stringify(starts));
  // The job's own stream is already scoped: a new child is reported as-is.
  kernelPush({ pid: 5003, ppid: 5001, createdAt: now, commandLine: "node late.js", comm: "node" } satisfies WatchStart);
  check("a new child is reported", starts.includes(5003));
  kernelPush({ pid: 5003, exitedAt: now, exitCode: 0 } satisfies WatchExit);
  check("an exit is reported", exits.includes(5003));
  observer.dispose();
}

// ---------------------------------------------------------------------------
console.log("[targeted observer — filter backend]");
{
  const ROOT = 6000;
  const table: ProcessTable = new Map([
    [ROOT, proc(ROOT, 1, "pi", now)],
    [6001, proc(6001, ROOT, "node")],
    [6002, proc(6002, 6001, "worker")],
    [6999, proc(6999, 1, "foreign")],
  ]);
  let kernelPush: (e: WatchStart | WatchExit) => void = () => {};
  const observer = new TargetedObserver({
    pid: ROOT,
    startedAt: now,
    backend: "filter",
    snapshot: async () => table,
    subscribeKernel: (listener) => {
      kernelPush = listener;
      return () => {
        kernelPush = () => {};
      };
    },
  });
  const starts: number[] = [];
  const exits: number[] = [];
  observer.on("start", (e) => starts.push(e.pid));
  observer.on("exit", (e) => exits.push(e.pid));
  await observer.start();
  check("seed emits the existing subtree", starts.includes(6001) && starts.includes(6002) && !starts.includes(ROOT), JSON.stringify(starts));
  // A machine-wide stream reports everything; the filter keeps the subtree.
  kernelPush({ pid: 6003, ppid: ROOT, createdAt: now, commandLine: "node in-tree.js", comm: "node" } satisfies WatchStart);
  check("an in-tree start survives the filter", starts.includes(6003));
  kernelPush({ pid: 7001, ppid: 1, createdAt: now, commandLine: "sleep 1", comm: "sleep" } satisfies WatchStart);
  check("an unrelated start is dropped", !starts.includes(7001));
  kernelPush({ pid: 6001, exitedAt: now, exitCode: 0 } satisfies WatchExit);
  check("an in-tree exit is reported", exits.includes(6001));
  kernelPush({ pid: 6999, exitedAt: now } satisfies WatchExit);
  check("an unrelated exit is dropped", !exits.includes(6999));
  observer.dispose();
}

// ---------------------------------------------------------------------------
console.log("[ProcessWatcher — OS channel driven by kernel events]");
{
  const ROOT = 8000;
  const table: ProcessTable = new Map([
    [ROOT, proc(ROOT, 1, "pi", now)],
    [8001, proc(8001, ROOT, "node")],
    [8999, proc(8999, 1, "foreign")],
  ]);
  let kernelPush: (e: WatchStart | WatchExit) => void = () => {};
  const events: ProcessPayload[] = [];
  const precisions: boolean[] = [];
  const watcher = new ProcessWatcher({
    externalPid: ROOT,
    externalPidStartedAt: now,
    targetedBackend: "filter", // deterministic on every platform
    snapshot: async () => table,
    subscribeKernel: (listener) => {
      kernelPush = listener;
      return () => {
        kernelPush = () => {};
      };
    },
    onProcess: (event) => events.push(event),
    onPrecision: (exact) => precisions.push(exact),
  });
  watcher.beginSession("os-kernel-test");
  watcher.warm();
  await new Promise((resolve) => setTimeout(resolve, 60));
  try {
    check("precision reported exact", precisions.includes(true));
    check("watcher uses kernel events", watcher.usesKernelEvents());
    check("the seeded descendant is an egg", events.some((e) => e.pid === 8001 && e.status === "running"));
    check("the unrelated pid is never an egg", !events.some((e) => e.pid === 8999));
    // A kernel exit (not a table sweep) marks the egg exited.
    kernelPush({ pid: 8001, exitedAt: Date.now(), exitCode: 0 } satisfies WatchExit);
    await new Promise((resolve) => setTimeout(resolve, 20));
    check("a kernel exit marks the egg exited", events.some((e) => e.pid === 8001 && e.status === "exited"));
  } finally {
    watcher.stop();
  }
}

if (failed > 0) {
  console.error(`\n${failed} targeted-observer check(s) failed`);
  process.exit(1);
}
console.log("\ntargeted observer checks passed");
