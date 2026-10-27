/**
 * "Change project" must actually leave the session.
 *
 * The button used to reset the client stores only, which left the server
 * sampling a process tree nobody was watching: the metrics sampler kept ticking
 * and kept appending frames to SQLite. This check closes a live session through
 * the API and asserts the sampler stops producing new samples, while the
 * samples it already took stay readable.
 *
 *   npx tsx scripts/checks/check-session-close.ts
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

interface MetricsBody {
  series: Array<{ points: Array<{ ts: number }> }>;
  host: Array<{ ts: number }>;
}

function lastTs(body: MetricsBody): number {
  let last = 0;
  for (const entry of body.series) for (const point of entry.points) last = Math.max(last, point.ts);
  for (const point of body.host) last = Math.max(last, point.ts);
  return last;
}

/** How many samples the response carries. The metric that must stop growing. */
function pointCount(body: MetricsBody): number {
  let count = 0;
  for (const entry of body.series) count += entry.points.length;
  return count + body.host.length;
}

async function main(): Promise<void> {
  const work = path.join(os.tmpdir(), `absence-session-close-${Date.now()}`);
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
    const sessionId = created.body!.session.id;
    check("mock session opened", Boolean(sessionId));

    await api(port, "POST", `/api/sessions/${sessionId}/prompt`, {
      prompt: '$ node -e "setTimeout(()=>{}, 30000)"',
    });

    // Wait until the session has a couple of samples on disk.
    let before: MetricsBody | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(1_000);
      const response = await api<MetricsBody>(port, "GET", `/api/sessions/${sessionId}/metrics?from=1&to=${Date.now() + 60 * 60_000}&step=5000`);
      if (response.body && lastTs(response.body) > 0 && response.body.host.length >= 2) {
        before = response.body;
        break;
      }
    }
    check("a live session samples", Boolean(before), before ? `host=${before.host.length}` : "none");
    if (!before) throw new Error("the session never sampled");

    // "Change project".
    const closed = await api<{ ok: boolean }>(port, "POST", `/api/sessions/${sessionId}/close`);
    check("close answered ok", closed.status === 200 && closed.body?.ok === true, `status=${closed.status}`);

    // Give the sampler several cadences' worth of time. If close did not stop it,
    // the sample count would keep climbing.
    const query = (offset: number) =>
      `/api/sessions/${sessionId}/metrics?from=1&to=${Date.now() + offset}&step=5000`;
    const atClose = await api<MetricsBody>(port, "GET", query(60 * 60_000));
    const countAtClose = atClose.body ? pointCount(atClose.body) : 0;
    check("the close flushed the samples it had", countAtClose > 0, `points=${countAtClose}`);
    await sleep(14_000);
    const after = await api<MetricsBody>(port, "GET", query(60 * 60_000));
    check(
      "the sampler stopped — no samples after the close",
      after.body !== undefined && pointCount(after.body) === countAtClose,
      `at close=${countAtClose} after=${after.body ? pointCount(after.body) : "none"}`,
    );

    // Leaving a session is not deleting it: the history it already recorded stays.
    check(
      "the recorded samples survive the close",
      after.body !== undefined && after.body.host.length >= before.host.length,
      after.body ? `host=${after.body.host.length}` : "none",
    );

    // Closing again is a no-op, not an error: the UI may retry.
    const again = await api<{ ok: boolean }>(port, "POST", `/api/sessions/${sessionId}/close`);
    check("closing an already closed session is harmless", again.status === 200);

    // And the session can be reopened with its history intact.
    const reopened = await api<{ session: { id: string } }>(port, "POST", "/api/sessions", {
      projectPath: projectDir.replace(/\\/g, "/"),
      agent: "mock",
      resume: { absenceSessionId: sessionId },
    });
    check("the session can be reopened", reopened.status === 200 && reopened.body?.session.id === sessionId);
    const restored = await api<MetricsBody>(port, "GET", `/api/sessions/${sessionId}/metrics?from=1&to=${Date.now() + 60 * 60_000}&step=5000`);
    check(
      "the reopened session still shows its metric history",
      restored.body !== undefined && restored.body.host.length > 0,
      restored.body ? `host=${restored.body.host.length}` : "none",
    );
  } finally {
    server.kill();
    await sleep(500);
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }

  finish();
}

void main();
