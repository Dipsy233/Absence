/**
 * Full-pipeline end-to-end check — no model, no credentials.
 *
 * Boots a real Absence server on an ephemeral port with an isolated state
 * directory, opens a **mock** session, and drives it with a scripted prompt
 * (`$ `-prefixed lines — MockAdapter runs each through the same AbsenceShell a
 * real agent uses). Assertions then cover everything a real run would produce:
 *
 *   command events → process eggs (Job Object) → container eggs (docker
 *   events, when docker is reachable) → metrics frames → SQLite persistence
 *
 *   npx tsx scripts/checks/check-e2e.ts
 *
 * This is the fast path for "did the whole pipeline survive my change": one
 * command, ~30 s, no runtime setup. The model-driven path is what the UI is
 * for; this check pins the plumbing.
 */
import { check, finish } from "./harness";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTAINER = "absence-e2e-check";
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
  return (await response.json()) as T;
}

/** Whether a docker CLI answers — the container-egg half of the check needs it. */
function dockerAvailable(): boolean {
  const probe =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", `wsl -d Ubuntu-24.04 -u root service docker start > NUL 2>&1 & wsl docker info > NUL 2>&1`], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 120_000,
        })
      : spawnSync("docker", ["info"], { stdio: "ignore", timeout: 30_000 });
  return probe.status === 0;
}

async function main(): Promise<void> {
  const port = await freePort();
  const work = path.join(os.tmpdir(), `absence-e2e-check-${Date.now()}`);
  const stateDir = path.join(work, "state");
  const projectDir = path.join(work, "project");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });

  const hasDocker = dockerAvailable();
  const docker = hasDocker ? (process.platform === "win32" ? "wsl docker" : "docker") : "";
  console.log(`docker: ${hasDocker ? "available (container-egg assertions on)" : "absent (process-only)"}`);

  // Boot the server in-process of a child node: tsx runs the server itself, so
  // killing the child kills the server. As our child it also lands in this
  // process's Job Object, which is what makes the server's kernel watching exact.
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const server = spawn(process.execPath, [tsxCli, "apps/server/src/index.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), ABSENCE_STATE_DIR: stateDir, HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    // Surface everything but fastify's per-request noise: crashes, agentwatch
    // diagnostics and (with ABSENCE_DEBUG_WATCHER) every kernel event.
    const text = chunk.toString();
    if (!text.includes("incoming request") && !text.includes("request completed")) {
      process.stderr.write(`[server] ${text}`);
    }
  });

  const cleanup = async (): Promise<void> => {
    server.kill();
    await sleep(500);
    if (hasDocker) {
      spawnSync("cmd.exe", ["/d", "/s", "/c", `${docker} rm -f ${CONTAINER} > NUL 2>&1`], { stdio: "ignore", windowsHide: true });
    }
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    // Wait for the server to answer.
    let up = false;
    for (let attempt = 0; attempt < 60 && !up; attempt++) {
      await sleep(500);
      up = await fetch(`http://127.0.0.1:${port}/api/runtimes`)
        .then((r) => r.ok)
        .catch(() => false);
    }
    check("server booted and answered", up);
    if (!up) throw new Error("server did not boot");
    // The kernel observer's helper settles asynchronously after boot; a session
    // opened in the same instant can race it and lose the earliest process
    // events. Real usage never opens a session this fast — wait it out.
    await sleep(2_500);

    // The scripted prompt: each `$` line is one real shell command.
    const commands = hasDocker
      ? [
          `${docker} rm -f ${CONTAINER} 2>/dev/null || true`,
          `${docker} run -d --name ${CONTAINER} nginx:alpine`,
          `${docker} ps`,
          "sleep 7",
          `${docker} rm -f ${CONTAINER}`,
        ]
      : [`node -e "setTimeout(()=>{}, 1500)"`];
    const prompt = commands.map((command) => `$ ${command}`).join("\n");

    const created = await api<{ session: { id: string } }>(port, "POST", "/api/sessions", {
      projectPath: projectDir.replace(/\\/g, "/"),
      agent: "mock",
    });
    const sessionId = created.session.id;
    check("mock session opened", Boolean(sessionId));

    await api(port, "POST", `/api/sessions/${sessionId}/prompt`, { prompt });

    // Wait for the run to complete.
    let runStatus = "";
    for (let attempt = 0; attempt < 60 && runStatus !== "completed"; attempt++) {
      await sleep(1_000);
      const snapshot = await api<{ runs: Array<{ index: number; status: string }> }>(
        port,
        "GET",
        `/api/sessions/${sessionId}`,
      );
      runStatus = snapshot.runs[0]?.status ?? "";
    }
    check("the scripted run completed", runStatus === "completed", `status=${runStatus}`);

    // What the pipeline recorded.
    const events = await api<{ events: Array<{ type: string; payload: Record<string, unknown> }> }>(
      port,
      "GET",
      `/api/sessions/${sessionId}/runs/1/events`,
    );
    const commandEvents = events.events.filter((event) => event.type === "command");
    const processEvents = events.events.filter((event) => event.type === "process");

    check(
      "every scripted command ran through the shell and was reported",
      commandEvents.length === commands.length &&
        commandEvents.every((event) => event.payload.exitCode === 0),
      `commands=${commandEvents.length}/${commands.length}`,
    );

    const eggs = new Map<number, Record<string, unknown>>();
    for (const event of processEvents) eggs.set(event.payload.pid as number, event.payload);
    const names = [...eggs.values()].map((payload) => String(payload.name));

    if (hasDocker) {
      const runCommand = commands[1];
      const container = [...eggs.values()].find((payload) => payload.name === CONTAINER);
      check("the container became an egg", container !== undefined, names.join(", "));
      if (container) {
        check(
          "the container egg is attributed to the scripted docker run",
          container.command === runCommand,
          `command=${String(container.command ?? "(none)")}`,
        );
        check(
          "the container egg is a primary under a synthetic pid",
          container.kind === "primary" && (container.pid as number) >= 1_000_000_000,
        );
      }
      // The client the Job Object / eBPF observer sees: `wsl.exe` wraps docker
      // on Windows; on Linux the CLI itself is the process.
      const clientPrefix = process.platform === "win32" ? "wsl" : "docker";
      const clientEggs = [...eggs.values()].filter(
        (payload) =>
          String(payload.name).toLowerCase().startsWith(clientPrefix) &&
          String(payload.command ?? "").includes("docker run"),
      );
      check(
        "the docker client process was also caught by the Job Object",
        clientEggs.length > 0,
        [...eggs.values()].map((payload) => `${payload.name}:${String(payload.command ?? "").slice(0, 40)}`).join(" | ") || "(no eggs)",
      );
      if (clientEggs.length === 0 && process.env.ABSENCE_DEBUG_WATCHER) {
        // Diagnose while the server is still alive: is the helper dead (restart
        // broken) or alive (delivery broken)?
        const probe = spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process agentwatch -ErrorAction SilentlyContinue | ForEach-Object { \"helper pid=$($_.Id)\" }"], {
          encoding: "utf8",
          windowsHide: true,
        });
        console.log(`[diagnose] helper processes while server alive: ${probe.stdout?.trim() || "(none)"}`);
      }

      // The stats stream feeds the frames; wait one sampling tick at most.
      let sampled = false;
      for (let attempt = 0; attempt < 10 && !sampled; attempt++) {
        await sleep(1_000);
        const snapshot = await api<{ metrics: Array<{ eggs: Array<{ name: string; rssBytes: number }> }> }>(
          port,
          "GET",
          `/api/sessions/${sessionId}`,
        );
        sampled = snapshot.metrics.some((frame) =>
          frame.eggs.some((egg) => egg.name === CONTAINER && egg.rssBytes > 0),
        );
      }
      check("the container's resource usage reached the metrics frames", sampled);

      // And the archive: a fresh processEvents read comes from SQLite.
      const persisted = await api<{ processEvents: Array<{ payload: { name: string } }> }>(
        port,
        "GET",
        `/api/sessions/${sessionId}`,
      );
      check(
        "container eggs persisted to the archive",
        persisted.processEvents.some((event) => event.payload.name === CONTAINER),
      );
    } else {
      check("the scripted workload became a process egg", names.some((name) => name.includes("node")), names.join(", "));
    }
  } finally {
    await cleanup();
  }

  finish();
}

void main();
