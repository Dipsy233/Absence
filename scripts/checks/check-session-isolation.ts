/**
 * Session isolation: one session's view must not receive a sibling agent's
 * processes or file changes.
 *
 *   npx tsx scripts/checks/check-session-isolation.ts
 *
 * Two independent regressions are pinned here:
 *
 *   1. The kernel observer is process-wide (`JobMonitor`), so every session's
 *      `ProcessWatcher` sees every session's processes. This section feeds two
 *      real watchers from one fake kernel stream (the production shape) and
 *      asserts that a foreign pid never becomes an egg and never enters the
 *      metrics target.
 *   2. Two Absence sessions on the same `projectPath` both watch the whole
 *      directory. This section boots a real server with the scripted runtime
 *      (no credentials, no model), has session B write a file through a shell
 *      command, and asserts that only B's archive records it.
 *
 * The process section is platform-neutral: the fake stream exercises the same
 * job-mode path both the Windows Job Object and Linux eBPF feed. The file
 * section runs on the host (Windows here, Linux in CI's offline group).
 */
import { check, finish, section } from "./harness";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AbsenceEvent, ProcessPayload } from "@absence/core";
import { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";
import type { WatchExit, WatchStart } from "../../apps/server/src/process/observer";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function api<T>(
  port: number,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: T | undefined }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as T) : undefined };
}

/** One fake kernel stream shared by two watchers, exactly like JobMonitor. */
function fakeKernel(): {
  subscribe: (listener: (event: WatchStart | WatchExit) => void) => () => void;
  emit: (event: WatchStart | WatchExit) => void;
} {
  const listeners = new Set<(event: WatchStart | WatchExit) => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function start(
  pid: number,
  ppid: number,
  extra: Partial<WatchStart> = {},
): WatchStart {
  return { pid, ppid, createdAt: NOW, commandLine: `node work-${pid}`, ...extra };
}

/**
 * 1. Two sessions share one kernel stream. A must only accept its own agent
 *    subtree; B must only accept its own.
 */
function processIsolation(): void {
  section("process events: two sessions on one kernel stream");

  const kernel = fakeKernel();
  const aEvents: ProcessPayload[] = [];
  const bEvents: ProcessPayload[] = [];
  const AGENT_A = 1100;
  const AGENT_B = 1200;

  const a = new ProcessWatcher({
    onProcess: (payload) => aEvents.push(payload),
    subscribeKernel: kernel.subscribe,
    now: () => NOW,
  });
  const b = new ProcessWatcher({
    onProcess: (payload) => bEvents.push(payload),
    subscribeKernel: kernel.subscribe,
    now: () => NOW,
  });
  a.beginSession("session-a", AGENT_A);
  b.beginSession("session-b", AGENT_B);
  a.begin("npm test", ".", undefined, NOW);
  b.begin("npm test", ".", undefined, NOW);

  // The strongest positive case: an unmarked process whose ppid is this
  // session's agent. Linux eBPF reports exactly this shape (no env marker).
  kernel.emit(start(2101, AGENT_A));
  kernel.emit(start(2102, 2101));

  // A marked process from the other session, and an unmarked one descending
  // from the other agent, must both be rejected.
  kernel.emit(start(2201, AGENT_B, { absenceSessionId: "session-b" }));
  kernel.emit(start(2202, AGENT_B));

  // A lost start has no ppid and no marker. It cannot prove ancestry and must
  // never be credited to whichever command happened to be open.
  kernel.emit(start(2203, 0, { lost: true }));

  const aPids = new Set(aEvents.map((event) => event.pid));
  const bPids = new Set(bEvents.map((event) => event.pid));

  check("A captures its own unmarked child", aPids.has(2101), `A=${[...aPids]}`);
  check(
    "A folds its own grandchild into the parent egg",
    aEvents.some((event) => event.pid === 2101 && event.children === 1),
    JSON.stringify(aEvents),
  );
  check("A rejects the marked foreign process", !aPids.has(2201), `A=${[...aPids]}`);
  check("A rejects the unmarked foreign descendant", !aPids.has(2202), `A=${[...aPids]}`);
  check("A ignores a lost start when a session is declared", !aPids.has(2203), `A=${[...aPids]}`);

  check("B captures its own marked process", bPids.has(2201), `B=${[...bPids]}`);
  check("B captures its own unmarked descendant", bPids.has(2202), `B=${[...bPids]}`);
  check("B rejects A's unmarked subtree", !bPids.has(2101) && !bPids.has(2102), `B=${[...bPids]}`);
  check("B ignores the lost start too", !bPids.has(2203), `B=${[...bPids]}`);

  const aMetrics = new Set(a.metricsAgentTarget().pids);
  const bMetrics = new Set(b.metricsAgentTarget().pids);
  check("A's metric target carries its agent", aMetrics.has(AGENT_A), `A=${[...aMetrics]}`);
  check("A's metric target carries its own subtree", aMetrics.has(2101) && aMetrics.has(2102));
  check(
    "A's metric target has no foreign pid",
    !aMetrics.has(2201) && !aMetrics.has(2202) && !aMetrics.has(2203),
    `A=${[...aMetrics]}`,
  );
  check(
    "B's metric target has no A pid",
    !bMetrics.has(AGENT_A) && !bMetrics.has(2101) && !bMetrics.has(2102),
    `B=${[...bMetrics]}`,
  );
  check(
    "the two metric targets are disjoint",
    [...aMetrics].every((pid) => !bMetrics.has(pid)),
    `A=${[...aMetrics]} B=${[...bMetrics]}`,
  );

  a.stop();
  b.stop();
}

interface EventsPage {
  events: AbsenceEvent[];
}

async function readEvents(port: number, id: string): Promise<AbsenceEvent[]> {
  const response = await api<EventsPage>(port, "GET", `/api/sessions/${id}/events?limit=2000`);
  return response.body?.events ?? [];
}

/**
 * 2. Two sessions on the same project directory. B writes through a shell
 *    command; A's watcher sees the same chokidar event and must not report it.
 */
async function fileIsolation(): Promise<void> {
  section("file events: two sessions on one project");

  const work = path.join(os.tmpdir(), `absence-session-isolation-${Date.now()}`);
  const stateDir = path.join(work, "state");
  const projectDir = path.join(work, "project");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "a.txt"), "seed\n", "utf-8");

  const port = await freePort();
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const server = spawn(process.execPath, [tsxCli, "apps/server/src/index.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), ABSENCE_STATE_DIR: stateDir, HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (!text.includes("incoming request") && !text.includes("request completed")) {
      process.stderr.write(`[server] ${text}`);
    }
  });

  try {
    let up = false;
    for (let attempt = 0; attempt < 90 && !up; attempt++) {
      await sleep(500);
      up = await fetch(`http://127.0.0.1:${port}/api/runtimes`)
        .then((r) => r.ok)
        .catch(() => false);
    }
    check("server booted", up);
    if (!up) throw new Error("server did not boot");

    const create = async (): Promise<string> => {
      const created = await api<{ session: { id: string } }>(port, "POST", "/api/sessions", {
        projectPath: projectDir.replace(/\\/g, "/"),
        agent: "mock",
      });
      return created.body!.session.id;
    };
    const sessionA = await create();
    const sessionB = await create();
    check("two sessions opened on one project", Boolean(sessionA && sessionB));

    const probe = "isolation-probe.txt";
    await api(port, "POST", `/api/sessions/${sessionB}/prompt`, {
      prompt: `$ node -e "require('fs').writeFileSync('${probe}','from B')"`,
    });

    // Wait until B's run reaches its end, then let the file watchers settle.
    let bDone = false;
    for (let attempt = 0; attempt < 60 && !bDone; attempt++) {
      await sleep(500);
      bDone = (await readEvents(port, sessionB)).some((event) => event.type === "agent_end");
    }
    check("B's run completed", bDone);
    await sleep(1_500);

    const aEvents = await readEvents(port, sessionA);
    const bEvents = await readEvents(port, sessionB);
    const paths = (events: AbsenceEvent[]): string[] =>
      events
        .map((event) => (event.payload as { path?: unknown }).path)
        .filter((value): value is string => typeof value === "string");
    const aFileEvents = aEvents.filter((event) => event.type.startsWith("file_"));

    check(
      "B records the file it wrote",
      bEvents.some((event) => event.type.startsWith("file_") && paths([event]).includes(probe)),
      `B file paths=${bEvents.flatMap((event) => paths([event])).join(",")}`,
    );
    check(
      "A records none of B's file events",
      aFileEvents.length === 0 && !aEvents.some((event) => paths([event]).includes(probe)),
      `A file events=${aFileEvents.length} paths=${aEvents.flatMap((event) => paths([event])).join(",")}`,
    );

    await api(port, "POST", `/api/sessions/${sessionA}/close`);
    await api(port, "POST", `/api/sessions/${sessionB}/close`);
  } finally {
    server.kill();
    await sleep(500);
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  processIsolation();
  await fileIsolation();
  finish("session isolation checks");
}

void main();
