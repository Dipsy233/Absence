/**
 * Offline check of the OS-only channel (P2): monitoring a process with no
 * transcript, and upgrading it when a transcript appears.
 *   npx tsx scripts/checks/check-observe-os.ts
 *
 * No agent is installed. Two stand-in "pi" processes are spawned: the pi
 * signature is `node …/@earendil-works/pi-coding-agent/dist/cli.js`, which is
 * exactly what `ProcessScanner` matches, so the real process table sees them.
 *
 * What it proves:
 *
 *   1. `proc:<pid>@<startedAt>` targets list a pi process that has no
 *      transcript; a transcript target whose pid owns it gains the `os`
 *      channel (the pair is provable, so the board says so);
 *   2. `POST /api/observe/watch` on a `proc:` key opens a channel-`os` session
 *      with a pid identity that cannot be confused by pid reuse — and a stale
 *      start time is refused;
 *   3. that session's runs are activity bursts (`boundarySource:
 *      "activity-burst"`), not user turns;
 *   4. the upgrade: watching the transcript proven to belong to an already
 *      watched pid folds both into one session with both channels, instead of
 *      showing the same agent twice.
 *
 * Runs a real server on an ephemeral port with an isolated state dir.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, finish, section } from "./harness";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NL = String.fromCharCode(10);

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

async function api<T>(port: number, method: string, pathname: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed as T };
}

interface TargetRow {
  key: string;
  kind: string;
  agentKind: string;
  pid?: number;
  transcriptFile?: string;
  channels: string[];
  liveness: string;
  sessionId?: string;
  watchable: boolean;
  pidStartedAt?: number;
}

interface LiveRow {
  sessionId: string;
  channel: string;
  externalId: string;
  pid?: number;
  leased?: boolean;
  events: number;
}

interface RunRow {
  index: number;
  prompt: string;
  status: string;
  boundarySource?: string;
}

/** Write a pi-shaped transcript (header + one completed turn). */
async function writeTranscript(file: string, externalId: string, cwd: string): Promise<void> {
  const now = Date.now();
  const entries = [
    { type: "session", version: 3, id: externalId, cwd, timestamp: new Date(now - 900).toISOString() },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date(now - 800).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "hello from the transcript" }], timestamp: now - 800 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: new Date(now - 700).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "x",
        provider: "t",
        model: "m",
        usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 4 },
        stopReason: "stop",
        timestamp: now - 700,
      },
    },
  ];
  await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join(NL) + NL, "utf8");
}

async function main(): Promise<void> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "absence-os-"));
  const stateDir = path.join(work, "state");
  const projectDir = path.join(work, "project");
  const piRoot = path.join(work, "pi-home", "sessions", "--fixture--");
  // The pi signature ProcessScanner matches: `node <…>/@earendil-works/
  // pi-coding-agent/dist/cli.js`. It sleeps, so the table keeps seeing it.
  const fakeCli = path.join(
    work,
    "fake-pi",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(piRoot, { recursive: true });
  await fs.mkdir(path.dirname(fakeCli), { recursive: true });
  await fs.writeFile(fakeCli, "setTimeout(() => {}, 600000);\n", "utf8");

  const transcriptFile = path.join(piRoot, "owned.jsonl");
  await writeTranscript(transcriptFile, "pi-owned", projectDir);

  const port = await freePort();
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const server = spawn(process.execPath, [tsxCli, "apps/server/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      ABSENCE_STATE_DIR: stateDir,
      ABSENCE_OBSERVE_PI_ROOT: piRoot,
      ABSENCE_DOCKER: "0",
      ABSENCE_KEEP_ALIVE: "1",
      // Nothing may be archived while the check runs.
      ABSENCE_ARCHIVE_SILENCE_MS: "600000",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (!text.includes("incoming request") && !text.includes("request completed")) {
      process.stderr.write(`[server] ${text}`);
    }
  });

  const children: ChildProcess[] = [];
  const fakePi = (args: string[]): ChildProcess => {
    const child = spawn(process.execPath, [fakeCli, ...args], { stdio: "ignore", windowsHide: true });
    children.push(child);
    return child;
  };

  try {
    let up = false;
    for (let attempt = 0; attempt < 120 && !up; attempt++) {
      await sleep(500);
      up = await fetch(`http://127.0.0.1:${port}/api/observe/live`)
        .then((r) => r.ok)
        .catch(() => false);
    }
    check("server booted", up);
    if (!up) throw new Error("server did not boot");

    section("targets from the process table");
    // Two stand-ins: one owns the transcript, one has no transcript of its own.
    const owner = fakePi(["--session", transcriptFile]);
    const bare = fakePi([]);
    await sleep(600);

    let ownerTarget: TargetRow | undefined;
    let bareTarget: TargetRow | undefined;
    let transcriptTarget: TargetRow | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(300);
      const rows = (await api<{ targets: TargetRow[] }>(port, "GET", "/api/observe/targets")).body.targets;
      transcriptTarget = rows.find((row) => row.transcriptFile === transcriptFile);
      ownerTarget = rows.find((row) => row.kind === "process" && row.pid === owner.pid);
      bareTarget = rows.find((row) => row.kind === "process" && row.pid === bare.pid);
      if (transcriptTarget?.channels.includes("os") && bareTarget !== undefined) break;
    }
    check("the transcript is a target", transcriptTarget !== undefined);
    check(
      "a transcript whose pid is proven gains the os channel",
      transcriptTarget?.channels.join(",") === "transcript,os",
      JSON.stringify(transcriptTarget?.channels),
    );
    check("the transcript target names its bound pid", transcriptTarget?.pid === owner.pid, `${transcriptTarget?.pid} vs ${owner.pid}`);
    check(
      "a pi process with no transcript is a process target",
      bareTarget !== undefined && bareTarget.channels.join(",") === "os",
      JSON.stringify(bareTarget),
    );
    if (bareTarget === undefined || transcriptTarget?.pid === undefined) {
      throw new Error("targets never resolved");
    }

    section("an OS-only watch");
    const osWatch = await api<{ sessionId: string; state: string }>(port, "POST", "/api/observe/watch", {
      key: bareTarget.key,
    });
    check("watching a process opens a session", osWatch.status === 200 && typeof osWatch.body.sessionId === "string", JSON.stringify(osWatch.body));
    const osSessionId = osWatch.body.sessionId;

    let live = (await api<{ sessions: LiveRow[] }>(port, "GET", "/api/observe/live")).body.sessions;
    const osRow = live.find((row) => row.sessionId === osSessionId);
    check("the OS session is live, channel os, and leased", osRow?.channel === "os" && osRow?.leased === true, JSON.stringify(osRow));
    check("the OS session records the pid", osRow?.pid === bare.pid, `${osRow?.pid} vs ${bare.pid}`);
    check("the pid identity carries the start time", /^pid:\d+@\d+$/.test(osRow?.externalId ?? ""), osRow?.externalId);

    section("pid reuse is not the same process");
    const stale = await api<unknown>(port, "POST", "/api/observe/watch", {
      key: `proc:${bare.pid}@1`,
    });
    check("a stale pid start time is refused", stale.status === 404, `status ${stale.status}`);

    section("activity bursts");
    let runs: RunRow[] = [];
    for (let attempt = 0; attempt < 30 && runs.length === 0; attempt++) {
      await sleep(500);
      runs = (await api<RunRow[]>(port, "GET", `/api/sessions/${osSessionId}/runs`)).body;
    }
    check("the OS session records activity as a run", runs.length > 0, JSON.stringify(runs));
    check("the run says an activity burst opened it", runs[0]?.boundarySource === "activity-burst", JSON.stringify(runs[0]));

    section("the upgrade keeps one session");
    // Watch the OS-only process that owns the transcript, then the transcript.
    const ownerWatch = await api<{ sessionId: string }>(port, "POST", "/api/observe/watch", {
      key: `proc:${owner.pid}@${transcriptTarget.pidStartedAt}`,
    });
    check("the owning process can be watched as OS-only", ownerWatch.status === 200, JSON.stringify(ownerWatch.body));
    const upgraded = await api<{ sessionId: string }>(port, "POST", "/api/observe/watch", {
      key: `transcript:${transcriptFile}`,
    });
    check(
      "watching its transcript folds into the same session",
      upgraded.body.sessionId === ownerWatch.body.sessionId,
      `${upgraded.body.sessionId} vs ${ownerWatch.body.sessionId}`,
    );

    live = (await api<{ sessions: LiveRow[] }>(port, "GET", "/api/observe/live")).body.sessions;
    const upgradedRow = live.find((row) => row.sessionId === upgraded.body.sessionId);
    check("the upgraded session keeps the os channel as its identity", upgradedRow?.channel === "os", JSON.stringify(upgradedRow));
    check("the upgraded session received the transcript's facts", (upgradedRow?.events ?? 0) > 1, `${upgradedRow?.events} events`);
    const upgradedEvents = await api<{ events: Array<{ type: string; payload: { role?: string } }> }>(
      port,
      "GET",
      `/api/sessions/${upgraded.body.sessionId}/events?limit=200`,
    );
    check(
      "the transcript's user message landed in the OS session",
      upgradedEvents.body.events.some(
        (event) => event.type === "message" && event.payload.role === "user",
      ),
      JSON.stringify(upgradedEvents.body.events.map((event) => event.type)),
    );

    section("runs switch from activity bursts to user turns");
    // A bare process is observed as bursts (silence is the only boundary).
    // Folding its transcript in must switch the run index to user turns and
    // rebuild the burst rows away: they were labelled by event type ("usage",
    // "tool_end") and are not what the agent actually did.
    let upgradedRuns: RunRow[] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(300);
      upgradedRuns = (await api<RunRow[]>(port, "GET", `/api/sessions/${upgraded.body.sessionId}/runs`)).body;
      if (upgradedRuns.length > 0 && upgradedRuns.every((run) => run.boundarySource !== "activity-burst")) break;
    }
    check(
      "the upgraded session's runs are user turns",
      upgradedRuns.length > 0 && upgradedRuns.every((run) => run.boundarySource !== "activity-burst"),
      JSON.stringify(upgradedRuns),
    );
    check(
      "the transcript's turn is settled",
      upgradedRuns[0]?.status === "completed",
      JSON.stringify(upgradedRuns[0]),
    );
    check(
      "the run is named by the prompt, not an event type",
      (upgradedRuns[0]?.prompt ?? "").includes("hello from the transcript"),
      JSON.stringify(upgradedRuns[0]?.prompt),
    );

    section("a live transcript is watched with kernel precision");
    // Choosing the transcript a running pi writes must bind that process and
    // use the OS channel — not replay history alone. This is the pure
    // third-party path: the user keeps pi in their own terminal, and picking
    // its conversation on the board watches the exact process.
    const directTranscript = path.join(piRoot, "direct.jsonl");
    await writeTranscript(directTranscript, "pi-direct", projectDir);
    const direct = fakePi(["--session", directTranscript]);
    await sleep(700);
    const directWatch = await api<{ sessionId: string }>(port, "POST", "/api/observe/watch", {
      key: `transcript:${directTranscript}`,
    });
    check("watching a live transcript opens a session", directWatch.status === 200, JSON.stringify(directWatch.body));
    live = (await api<{ sessions: LiveRow[] }>(port, "GET", "/api/observe/live")).body.sessions;
    const directRow = live.find((row) => row.sessionId === directWatch.body.sessionId);
    check("the live transcript is watched on the os channel", directRow?.channel === "os", JSON.stringify(directRow));
    check("it binds the running pi pid", directRow?.pid === direct.pid, `${directRow?.pid} vs ${direct.pid}`);
    check("its transcript facts are folded in", (directRow?.events ?? 0) > 1, `${directRow?.events} events`);
  } finally {
    for (const child of children) child.kill();
    server.kill();
    await sleep(300);
  }

  finish("check-observe-os");
}

await main();