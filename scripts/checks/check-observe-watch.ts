/**
 * Offline check of the monitor lease (P1): choosing a target, and the
 * lifetime that follows.
 *   npx tsx scripts/checks/check-observe-watch.ts
 *
 * What it proves:
 *
 *   1. `GET /api/observe/targets` lists a transcript as a target with a stable
 *      key, its channels and liveness — creating nothing;
 *   2. `POST /api/observe/watch` attaches it, records a lease, and the live row
 *      reports `leased: true`; watching again is idempotent;
 *   3. the idle sweep's two thresholds differ: with a 1ms auto-archive silence
 *      an auto-attached transcript is retired, while a leased one survives
 *      (ABSENCE_LEASE_SILENCE_MS=0 means “keep it”);
 *   4. a lease survives a server restart: the restarted server re-attaches the
 *      session on its own, without the transcript moving;
 *   5. `POST /api/observe/unwatch` drops the lease (the archive stays);
 *   6. a vanished transcript is a `missing` target, not a crash.
 *
 * Runs a real server twice on an ephemeral port with an isolated state dir and
 * transcript root.
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

interface LiveRow {
  sessionId: string;
  channel: string;
  externalId: string;
  leased?: boolean;
  events: number;
}

interface TargetRow {
  key: string;
  kind: string;
  transcriptFile?: string;
  channels: string[];
  liveness: string;
  sessionId?: string;
  watchable: boolean;
}

interface ServerHandle {
  port: number;
  child: ChildProcess;
}

async function boot(stateDir: string, piRoot: string, env: Record<string, string>): Promise<ServerHandle> {
  const port = await freePort();
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "apps/server/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      ABSENCE_STATE_DIR: stateDir,
      ABSENCE_OBSERVE_PI_ROOT: piRoot,
      ABSENCE_AUTO_ATTACH: "1",
      ABSENCE_DOCKER: "0",
      ABSENCE_KEEP_ALIVE: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (!text.includes("incoming request") && !text.includes("request completed")) {
      process.stderr.write(`[server] ${text}`);
    }
  });
  let up = false;
  for (let attempt = 0; attempt < 120 && !up; attempt++) {
    await sleep(500);
    up = await fetch(`http://127.0.0.1:${port}/api/observe/live`)
      .then((r) => r.ok)
      .catch(() => false);
  }
  if (!up) throw new Error("server did not boot");
  return { port, child };
}

async function stop(server: ServerHandle): Promise<void> {
  server.child.kill();
  await sleep(500);
}

/** Write a pi-shaped transcript (header + one completed turn). */
async function writeTranscript(file: string, externalId: string, cwd: string, prompt: string): Promise<void> {
  const now = Date.now();
  const entries = [
    { type: "session", version: 3, id: externalId, cwd, timestamp: new Date(now - 1_000).toISOString() },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date(now - 900).toISOString(),
      message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: now - 900 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: new Date(now - 800).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "anthropic-messages",
        provider: "test",
        model: "test-model",
        usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 4 },
        stopReason: "stop",
        timestamp: now - 800,
      },
    },
  ];
  await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join(NL) + NL, "utf8");
}

async function main(): Promise<void> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "absence-watch-"));
  const stateDir = path.join(work, "state");
  const projectDir = path.join(work, "project");
  const piRoot = path.join(work, "pi-home", "sessions", "--fixture--");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(piRoot, { recursive: true });

  const leasedFile = path.join(piRoot, "leased.jsonl");
  const autoFile = path.join(piRoot, "auto.jsonl");

  // The sweep fires fast, and the auto threshold is 1ms; the leased threshold
  // is 0 = never, so the two rules are distinguishable in seconds.
  const sweepEnv = { ABSENCE_ARCHIVE_SILENCE_MS: "1500", ABSENCE_LEASE_SILENCE_MS: "0", ABSENCE_ARCHIVE_SWEEP_MS: "300" };
  let server = await boot(stateDir, piRoot, sweepEnv);

  try {
    // Written after boot, with "now" timestamps: the silence threshold is
    // measured from the transcript's own last fact, and a fixture written
    // before the server came up would already look minutes old.
    await writeTranscript(leasedFile, "pi-leased", projectDir, "keep watching me");
    await writeTranscript(autoFile, "pi-auto", projectDir, "forget me");

    section("targets");
    // The watcher picks the new files up asynchronously; wait for the row.
    let leasedTarget: TargetRow | undefined;
    for (let attempt = 0; attempt < 60 && leasedTarget === undefined; attempt++) {
      await sleep(200);
      const rows = (await api<{ targets: TargetRow[] }>(server.port, "GET", "/api/observe/targets")).body.targets;
      leasedTarget = rows.find((row) => row.transcriptFile === leasedFile);
    }
    check("a transcript is a target", leasedTarget !== undefined, String(leasedTarget?.key));
    check("the target key is the transcript file", leasedTarget?.key === `transcript:${leasedFile}`, leasedTarget?.key);
    check("the target names its channel", leasedTarget?.channels.includes("transcript") === true);
    check("the target is watchable", leasedTarget?.watchable === true);

    // Let the auto-attach happen, then watch the leased one explicitly.
    section("watch → lease");
    let watched = await api<{ sessionId: string; url: string; state: string }>(
      server.port,
      "POST",
      "/api/observe/watch",
      { key: `transcript:${leasedFile}` },
    );
    check("watch answers with a session", watched.status === 200 && typeof watched.body.sessionId === "string", JSON.stringify(watched.body));
    check("watch answers with the panel url", watched.body.url === `/s/${watched.body.sessionId}`);
    const sessionId = watched.body.sessionId;

    const again = await api<{ sessionId: string }>(server.port, "POST", "/api/observe/watch", {
      key: `transcript:${leasedFile}`,
    });
    check("watching again is idempotent", again.body.sessionId === sessionId);

    let live = (await api<{ sessions: LiveRow[] }>(server.port, "GET", "/api/observe/live")).body.sessions;
    const leasedRow = live.find((row) => row.sessionId === sessionId);
    check("the watched session is live and leased", leasedRow?.leased === true, "live=" + JSON.stringify(live));

    section("the idle sweep respects the lease");
    // The auto-attached transcript (no lease) must be retired by the 1ms rule…
    const autoArchived = await (async () => {
      for (let attempt = 0; attempt < 60; attempt++) {
        await sleep(250);
        const rows = (await api<{ sessions: LiveRow[] }>(server.port, "GET", "/api/observe/live")).body.sessions;
        if (!rows.some((row) => row.externalId === "pi-auto")) return true;
      }
      return false;
    })();
    check("an unleased auto-attached session is archived by the short threshold", autoArchived);
    // …while the leased one stays, with the same sweep running.
    live = (await api<{ sessions: LiveRow[] }>(server.port, "GET", "/api/observe/live")).body.sessions;
    check("a leased session survives the short threshold", live.some((row) => row.sessionId === sessionId));

    section("restart recovery");
    await stop(server);
    const offlineAt = Date.now();
    const offlineEntry = JSON.stringify({
      type: "message", id: "u2", parentId: "a1", timestamp: new Date(offlineAt).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "written while offline" }], timestamp: offlineAt },
    });
    await fs.appendFile(leasedFile, offlineEntry + NL);
    server = await boot(stateDir, piRoot, sweepEnv);
    const recovered = await (async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        await sleep(250);
        const rows = (await api<{ sessions: LiveRow[] }>(server.port, "GET", "/api/observe/live")).body.sessions;
        const row = rows.find((candidate) => candidate.externalId === "pi-leased");
        if (row !== undefined) return row;
      }
      return undefined;
    })();
    check("the lease re-attaches after a restart", recovered !== undefined, JSON.stringify(recovered));
    check("the recovered session is still leased", recovered?.leased === true);
    check("the recovered session reuses the same archive id", recovered?.sessionId === sessionId, `${recovered?.sessionId} vs ${sessionId}`);

    type EventPage = { events: Array<{ type: string; payload: { role?: string; content?: string } }> };
    const prompts = async () => (await api<EventPage>(server.port, "GET", `/api/sessions/${sessionId}/events`))
      .body.events.filter((event) => event.type === "message" && event.payload.role === "user")
      .map((event) => event.payload.content);
    const recoveredPrompts = await prompts();
    check("the pre-restart prompt was not duplicated", recoveredPrompts.filter((text) => text === "keep watching me").length === 1);
    check("the offline prompt was recovered exactly once", recoveredPrompts.filter((text) => text === "written while offline").length === 1);

    await stop(server);
    const original = await fs.readFile(leasedFile, "utf8");
    await fs.writeFile(leasedFile, original.replace("keep watching me", "rewritten prompt") + offlineEntry.replace("written while offline", "after rewrite") + NL);
    server = await boot(stateDir, piRoot, sweepEnv);
    const rewrittenPrompts = await prompts();
    check("a changed prefix is not resumed at the saved offset", !rewrittenPrompts.includes("after rewrite") && !rewrittenPrompts.includes("rewritten prompt"));
    const blocked = (await api<{ sessions: LiveRow[] }>(server.port, "GET", "/api/observe/live")).body.sessions
      .find((row) => row.sessionId === sessionId);
    check("the board is told the transcript diverged", blocked?.transcriptResumeBlocked === true, JSON.stringify(blocked));

    section("unwatch");
    const unwatched = await api<{ ok: boolean; removed: boolean }>(server.port, "POST", "/api/observe/unwatch", {
      sessionId,
    });
    check("unwatch removes the lease", unwatched.status === 200 && unwatched.body.removed === true, JSON.stringify(unwatched.body));
    live = (await api<{ sessions: LiveRow[] }>(server.port, "GET", "/api/observe/live")).body.sessions;
    check("the session is no longer leased", live.find((row) => row.sessionId === sessionId)?.leased !== true);

    section("a vanished transcript");
    await fs.rm(leasedFile, { force: true });
    const gone = await (async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        await sleep(250);
        const rows = (await api<{ targets: TargetRow[] }>(server.port, "GET", "/api/observe/targets")).body.targets;
        const row = rows.find((candidate) => candidate.transcriptFile === leasedFile);
        if (row?.liveness === "missing") return row;
      }
      return undefined;
    })();
    check("a deleted transcript becomes a missing target", gone !== undefined, JSON.stringify(gone));
    check("a missing target is not watchable", gone?.watchable === false);
  } finally {
    await stop(server);
  }

  finish("check-observe-watch");
}

await main();
