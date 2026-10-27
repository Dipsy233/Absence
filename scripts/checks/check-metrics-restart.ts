/**
 * Live check: a metrics curve survives a server restart.
 *
 * Boots a real server on an ephemeral port with an isolated state dir, opens a
 * mock session, runs a command that burns a little CPU for a few seconds, waits
 * for samples to reach SQLite, then **restarts** the server and reads the same
 * session's metrics endpoint again. The dashboard's whole bug was that the
 * second read came back empty.
 *
 *   npx tsx scripts/checks/check-metrics-restart.ts
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

async function api<T>(port: number, method: string, pathname: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${pathname} → ${response.status}`);
  return (await response.json()) as T;
}

interface MetricsBody {
  series: Array<{ eggPid: number; kind: string; points: Array<{ ts: number }> }>;
  host: Array<{ ts: number; cpuCount: number; memTotalBytes: number }>;
}

async function main(): Promise<void> {
  const work = path.join(os.tmpdir(), `absence-metrics-restart-${Date.now()}`);
  const stateDir = path.join(work, "state");
  const projectDir = path.join(work, "project");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });

  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const boot = async (port: number) => {
    const child = spawn(process.execPath, [tsxCli, "apps/server/src/index.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(port), ABSENCE_STATE_DIR: stateDir, HOST: "127.0.0.1" },
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
      up = await fetch(`http://127.0.0.1:${port}/api/runtimes`)
        .then((r) => r.ok)
        .catch(() => false);
    }
    return { child, up };
  };

  let sessionId = "";
  let firstMetrics: MetricsBody | undefined;
  try {
    const port = await freePort();
    const first = await boot(port);
    check("server booted", first.up);
    if (!first.up) throw new Error("server did not boot");
    await sleep(2_500);

    const created = await api<{ session: { id: string } }>(port, "POST", "/api/sessions", {
      projectPath: projectDir.replace(/\\/g, "/"),
      agent: "mock",
    });
    sessionId = created.session.id;
    check("mock session opened", Boolean(sessionId));

    // A workload that lives long enough to be sampled a few times.
    await api(port, "POST", `/api/sessions/${sessionId}/prompt`, {
      prompt: '$ node -e "const t=Date.now(); while(Date.now()-t<9000){Math.sqrt(Math.random())}"',
    });
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(1_000);
      const body = await api<MetricsBody>(port, "GET", `/api/sessions/${sessionId}/metrics?step=5000`);
      if (body.host.length >= 3 && body.series.length > 0) {
        firstMetrics = body;
        break;
      }
    }
    check(
      "live session produced samples on disk",
      Boolean(firstMetrics && firstMetrics.host.length >= 3),
      firstMetrics ? `host=${firstMetrics.host.length} series=${firstMetrics.series.length}` : "none",
    );

    first.child.kill();
    await sleep(1_500);

    // The actual bug: a fresh server, the same session, and the curve is gone.
    const port2 = await freePort();
    const second = await boot(port2);
    check("server restarted", second.up);
    if (!second.up) throw new Error("server did not restart");
    await sleep(1_500);

    const reopened = await api<{ snapshot: unknown } | { session: { id: string } }>(
      port2,
      "POST",
      "/api/sessions",
      {
        projectPath: projectDir.replace(/\\/g, "/"),
        agent: "mock",
        resume: { absenceSessionId: sessionId },
      },
    );
    void reopened;

    const after = await api<MetricsBody>(port2, "GET", `/api/sessions/${sessionId}/metrics?step=5000`);
    check(
      "the egg series survived the restart",
      after.series.length > 0 && after.series.some((entry) => entry.points.length > 0),
      `series=${after.series.length} points=${after.series.reduce((sum, entry) => sum + entry.points.length, 0)}`,
    );
    check(
      "the host series survived the restart (the dashed machine line)",
      after.host.length > 0,
      `host=${after.host.length}`,
    );
    check(
      "the host keeps the machine's memory size",
      after.host.every((point) => point.memTotalBytes > 0),
    );

    second.child.kill();
    await sleep(500);
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }

  finish();
}

void main();
