/**
 * "Observed for" is the process's own lifetime, not how long Absence watched.
 *
 * The card used to fall back to the session start when no egg was selected, and
 * for an egg it counted up until *now*. The question it answers is "how long did
 * that process run?", so it must start when the process started and freeze the
 * moment it exits — a python script the agent launched counts up while it runs
 * and stops when it ends.
 *
 * This drives a real server through a short-lived process and asserts the egg's
 * lifetime is its own (bounded by start → exit), then that it is frozen.
 *
 *   npx tsx scripts/checks/check-observed-lifetime.ts
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

interface ProcessPayload {
  pid: number;
  name: string;
  status: "running" | "exited";
  startedAt: number;
  exitedAt?: number;
  kind: string;
}

async function api<T>(port: number, method: string, pathname: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const work = path.join(os.tmpdir(), `absence-lifetime-${Date.now()}`);
  const stateDir = path.join(work, "state");
  const projectDir = path.join(work, "project");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });

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

  const readEggs = async (sessionId: string): Promise<Map<number, ProcessPayload>> => {
    const snapshot = await api<{ processEvents: Array<{ payload: ProcessPayload }> }>(
      port,
      "GET",
      `/api/sessions/${sessionId}`,
    );
    const eggs = new Map<number, ProcessPayload>();
    for (const event of snapshot.processEvents) eggs.set(event.payload.pid, event.payload);
    return eggs;
  };

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
    await sleep(2_500);

    const created = await api<{ session: { id: string } }>(port, "POST", "/api/sessions", {
      projectPath: projectDir.replace(/\\/g, "/"),
      agent: "mock",
    });
    const sessionId = created.session.id;
    check("session opened", Boolean(sessionId));

    // A process that lives a few seconds and then ends.
    const runSeconds = 8;
    const startedAtWall = Date.now();
    await api(port, "POST", `/api/sessions/${sessionId}/prompt`, {
      prompt: `$ node -e "setTimeout(()=>{}, ${runSeconds * 1000})"`,
    });

    // Watch the egg while it runs.
    let running: ProcessPayload | undefined;
    for (let attempt = 0; attempt < 30 && !running; attempt++) {
      await sleep(1_000);
      for (const egg of (await readEggs(sessionId)).values()) {
        if (egg.name.toLowerCase().includes("node") && egg.status === "running") running = egg;
      }
    }
    check("the long-running process became an egg", Boolean(running), running ? running.name : "none");
    if (!running) throw new Error("the process was never seen");

    check(
      "its lifetime starts when the process started, not when the session did",
      running.startedAt >= startedAtWall - 5_000,
      `egg started ${running.startedAt - startedAtWall}ms after the prompt`,
    );
    check(
      "an egg that has not exited has no exit time yet",
      running.exitedAt === undefined,
      `exitedAt=${String(running.exitedAt)}`,
    );

    // Let it end.
    let exited: ProcessPayload | undefined;
    for (let attempt = 0; attempt < 45 && !exited; attempt++) {
      await sleep(1_000);
      const egg = (await readEggs(sessionId)).get(running.pid);
      if (egg?.status === "exited" && egg.exitedAt !== undefined) exited = egg;
    }
    check("the process eventually reports exited", Boolean(exited));
    if (!exited) throw new Error("the process never exited");

    const lifetime = exited.exitedAt! - exited.startedAt;
    check(
      "the lifetime is the process's own run, roughly what was asked for",
      lifetime >= (runSeconds - 2) * 1000 && lifetime <= (runSeconds + 8) * 1000,
      `${lifetime}ms for a ${runSeconds}s process`,
    );

    // And it is frozen: "observed for" reads startedAt → exitedAt, both fixed, so
    // the number the UI shows keeps growing with the clock is impossible.
    await sleep(4_000);
    const later = (await readEggs(sessionId)).get(running.pid);
    check(
      "the recorded lifetime does not keep growing after the exit",
      later !== undefined &&
        later.status === "exited" &&
        later.exitedAt === exited.exitedAt &&
        later.startedAt === exited.startedAt,
      `startedAt=${String(later?.startedAt)} exitedAt=${String(later?.exitedAt)}`,
    );
  } finally {
    server.kill();
    await sleep(500);
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }

  finish();
}

void main();
