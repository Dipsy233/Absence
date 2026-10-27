/**
 * Session duration is dwell time, not wall time.
 *
 * Opening a session, staying 30s, leaving, and coming back later must continue
 * the clock: the hours in between are not time spent in the session, and the
 * 30s already accrued must not be thrown away. This check drives a real server
 * through open → wait → close → wait → reopen and asserts the dwell clock
 * continued.
 *
 *   npx tsx scripts/checks/check-session-dwell.ts
 */
import { check, finish } from "./harness";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

interface Snapshot {
  session: {
    id: string;
    startedAt: number;
    dwellMs?: number;
    openedAt?: number;
  };
}

async function api<T>(port: number, method: string, pathname: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await response.json()) as T;
}

/** Dwell the server says has accrued, in ms. */
function dwellOf(snapshot: Snapshot, now = Date.now()): number {
  const { dwellMs = 0, openedAt } = snapshot.session;
  return dwellMs + (openedAt ? now - openedAt : 0);
}

async function main(): Promise<void> {
  const work = path.join(os.tmpdir(), `absence-dwell-${Date.now()}`);
  const stateDir = path.join(work, "state");
  const projectDir = path.join(work, "project");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });

  const port = await freePort();
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const boot = async (listenPort: number) => {
    const child = spawn(process.execPath, [tsxCli, "apps/server/src/index.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(listenPort), ABSENCE_STATE_DIR: stateDir, HOST: "127.0.0.1" },
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
    for (let attempt = 0; attempt < 90 && !up; attempt++) {
      await sleep(500);
      up = await fetch(`http://127.0.0.1:${listenPort}/api/runtimes`)
        .then((r) => r.ok)
        .catch(() => false);
    }
    return { child, up };
  };

  let first: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    first = await boot(port);
    check("server booted", first.up);
    if (!first.up) throw new Error("server did not boot");
    await sleep(2_500);

    const created = await api<Snapshot>(port, "POST", "/api/sessions", {
      projectPath: projectDir.replace(/\\/g, "/"),
      agent: "mock",
    });
    const sessionId = created.session.id;
    const createdAt = created.session.startedAt;
    check("a fresh session starts its dwell clock", dwellOf(created) < 5_000, `${dwellOf(created)}ms`);
    check("and reports when this visit opened", typeof created.session.openedAt === "number");

    // The user watches for a while.
    await sleep(6_000);
    const watched = await api<Snapshot>(port, "GET", `/api/sessions/${sessionId}`);
    const watchedDwell = dwellOf(watched);
    check("dwell grows while the session is open", watchedDwell >= 5_500, `${watchedDwell}ms`);

    // Leave, then restart the whole server: the dwell clock must come back from
    // the archive, not from a process that happens to still be alive.
    await api(port, "POST", `/api/sessions/${sessionId}/close`);
    first.child.kill();
    await sleep(1_500);
    const port2 = await freePort();
    const second = await boot(port2);
    check("server restarted", second.up);
    if (!second.up) throw new Error("server did not restart");
    await sleep(1_500);

    const reopened = await api<Snapshot>(port2, "POST", "/api/sessions", {
      projectPath: projectDir.replace(/\\/g, "/"),
      agent: "mock",
      resume: { absenceSessionId: sessionId },
    });
    const reopenDwell = dwellOf(reopened);
    check(
      "reopening continues the dwell clock instead of restarting it",
      reopenDwell >= watchedDwell,
      `before=${watchedDwell}ms after=${reopenDwell}ms`,
    );
    check(
      "and does not count the time the session was closed",
      reopenDwell < watchedDwell + 4_000,
      `before=${watchedDwell}ms after=${reopenDwell}ms (the closed gap must not be counted)`,
    );
    check(
      "the session keeps its original creation time",
      reopened.session.startedAt === createdAt,
      `${reopened.session.startedAt} vs ${createdAt}`,
    );

    // And it keeps counting from there while open.
    await sleep(3_000);
    const stillOpen = await api<Snapshot>(port2, "GET", `/api/sessions/${sessionId}`);
    check(
      "the reopened visit keeps accruing dwell",
      dwellOf(stillOpen) >= reopenDwell + 2_000,
      `${reopenDwell}ms → ${dwellOf(stillOpen)}ms`,
    );

    second.child.kill();
    await sleep(500);
  } finally {
    first?.child.kill();
    await sleep(500);
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }

  finish();
}

void main();
