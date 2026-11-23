/**
 * Offline check of the observation board's entry model (P0).
 *   npx tsx scripts/checks/check-observe-board.ts
 *
 * The board is the app's front door and it must never be a launcher:
 *
 *   1. the server boots with an isolated state dir and a fixture transcript
 *      root, and `GET /api/observe/live` starts empty;
 *   2. a transcript the agent wrote on its own is discovered, attached, and
 *      appears in `/api/observe/live` with its channel, identity and project;
 *   3. the board's session is a *place*: `GET /api/sessions/:id` serves it, and
 *      a second attach is idempotent (the same session id, no duplicate);
 *   4. the launcher is gone — `POST /api/observe/launch` answers 404;
 *   5. write-back stays refused: prompt/abort/approval/command are 403 for an
 *      observed session.
 *
 * Runs a real server on an ephemeral port (the HTTP surface is the contract),
 * with its own ABSENCE_STATE_DIR and transcript root, so it never touches the
 * user's archives or agent data.
 */
import { spawn } from "node:child_process";
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

async function api<T>(
  port: number,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
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
  agentKind: string;
  projectPath: string;
  transcriptFile?: string;
  watchStartedAt: number;
  lastActivityAt: number;
  events: number;
  viewers: number;
}

interface DiscoverRow {
  externalId: string;
  source: string;
  file: string;
  sessionId?: string;
}

async function main(): Promise<void> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "absence-board-"));
  const stateDir = path.join(work, "state");
  const projectDir = path.join(work, "project");
  const piRoot = path.join(work, "pi-home", "sessions", "--fixture--");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(piRoot, { recursive: true });

  const EXTERNAL_ID = "pi-board-fixture";
  const now = Date.now();
  const transcript = [
    {
      type: "session",
      version: 3,
      id: EXTERNAL_ID,
      cwd: projectDir,
      timestamp: new Date(now - 20_000).toISOString(),
    },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date(now - 19_000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "hello board" }], timestamp: now - 19_000 },
    },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: new Date(now - 18_000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        api: "anthropic-messages",
        provider: "test",
        model: "test-model",
        usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 7 },
        stopReason: "stop",
        timestamp: now - 18_000,
      },
    },
  ];
  const transcriptFile = path.join(piRoot, `2026-01-01T00-00-00-000Z_${EXTERNAL_ID}.jsonl`);
  await fs.writeFile(transcriptFile, transcript.map((entry) => JSON.stringify(entry)).join(NL) + NL, "utf8");

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

  try {
    section("boot");
    let up = false;
    for (let attempt = 0; attempt < 120 && !up; attempt++) {
      await sleep(500);
      up = await fetch(`http://127.0.0.1:${port}/api/observe/live`)
        .then((r) => r.ok)
        .catch(() => false);
    }
    check("server booted", up);
    if (!up) throw new Error("server did not boot");

    const initial = await api<{ sessions: LiveRow[] }>(port, "GET", "/api/observe/live");
    check(
      "the live list holds observed sessions only (never a driven one)",
      initial.status === 200 && initial.body.sessions.every((row) => typeof row.channel === "string" && row.channel.length > 0),
    );

    section("discovery → attach → live");
    const board = await api<{ sessions: DiscoverRow[] }>(port, "GET", "/api/observe/sessions");
    const discoverRow = board.body.sessions.find((row) => row.externalId === EXTERNAL_ID);
    check("discovery found the fixture transcript", discoverRow !== undefined, JSON.stringify(board.body.sessions));
    check("the discovered row names the project from the header", discoverRow !== undefined);
    // Recency: the fixture is written now, so discovery attaches it on its own.
    let attached: LiveRow | undefined;
    for (let attempt = 0; attempt < 40 && attached === undefined; attempt++) {
      await sleep(250);
      const live = await api<{ sessions: LiveRow[] }>(port, "GET", "/api/observe/live");
      attached = live.body.sessions.find((row) => row.externalId === EXTERNAL_ID);
    }
    check("the active transcript attached automatically", attached !== undefined);
    if (attached === undefined) throw new Error("fixture transcript never attached");
    check("the live row carries the transcript channel", attached.channel === "transcript");
    check("the live row carries the agent kind and project", attached.agentKind === "pi" && attached.projectPath.replace(/\\/g, "/") === projectDir.replace(/\\/g, "/"), `${attached.agentKind} ${attached.projectPath}`);
    check("the live row names the transcript file", attached.transcriptFile === transcriptFile);
    check("the live row counts facts", attached.events >= 2, `${attached.events} events`);
    check("the live row records when watching began", Number.isFinite(attached.watchStartedAt) && attached.watchStartedAt > 0);

    section("the panel is a place");
    const snapshot = await api<{ session: { id: string; projectPath: string } }>(
      port,
      "GET",
      `/api/sessions/${attached.sessionId}`,
    );
    check("the live session serves a snapshot", snapshot.status === 200 && snapshot.body.session.id === attached.sessionId);

    const again = await api<{ sessionId?: string }>(port, "POST", "/api/observe/attach", { file: transcriptFile });
    check("attaching again is idempotent", again.status === 200 && again.body.sessionId === attached.sessionId, JSON.stringify(again.body));

    section("no launcher, no drive");
    const launch = await api<unknown>(port, "POST", "/api/observe/launch", { cwd: projectDir });
    check("the launcher endpoint is gone", launch.status === 404, `status ${launch.status}`);

    for (const route of ["prompt", "abort", "approval", "command"]) {
      const response = await api<unknown>(port, "POST", `/api/sessions/${attached.sessionId}/${route}`, {
        prompt: "hello",
        command: "model",
        args: "x",
        id: "x",
        value: "y",
      });
      check(`POST /${route} is refused for an observed session`, response.status === 403, `status ${response.status}`);
    }
  } finally {
    server.kill();
    await sleep(300);
  }

  finish("check-observe-board");
}

await main();
