/**
 * Offline check of the headless entry (P3): one server, driven from a shell.
 *   npx tsx scripts/checks/check-cli-observe.ts
 *
 * A server with no desktop must be fully usable with a single command. This
 * runs the real CLI (`tsx apps/server/src/index.ts <cmd>`) against a real
 * server and proves:
 *
 *   1. the server refuses a non-loopback bind without ABSENCE_TOKEN, and boots
 *      with one;
 *   2. once a token is set, the observation API answers 401 without it and 200
 *      with `?token=` (and with the x-absence-token header);
 *   3. `absence ls --json` lists the transcript target;
 *   4. `absence observe --session <file>` prints a panel URL with /s/<id> and
 *      the token, and the session it names is real;
 *   5. `absence open <id>` prints the same kind of URL;
 *   6. `absence unwatch <id>` stops the lease (the archive stays).
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
const TOKEN = "check-secret-token";

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

const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const entry = "apps/server/src/index.ts";

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ABSENCE_DOCKER: "0", ABSENCE_KEEP_ALIVE: "1", ...extra };
}

/** Run a CLI command to completion; resolves { code, stdout, stderr }. */
function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, entry, ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

interface TargetRow {
  key: string;
  transcriptFile?: string;
  sessionId?: string;
}

async function main(): Promise<void> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "absence-cli-"));
  const stateDir = path.join(work, "state");
  const projectDir = path.join(work, "project");
  const piRoot = path.join(work, "pi-home", "sessions", "--fixture--");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(piRoot, { recursive: true });

  const now = Date.now();
  const transcriptFile = path.join(piRoot, "cli.jsonl");
  await fs.writeFile(
    transcriptFile,
    [
      { type: "session", version: 3, id: "pi-cli", cwd: projectDir, timestamp: new Date(now - 800).toISOString() },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: new Date(now - 700).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "hello cli" }], timestamp: now - 700 },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: new Date(now - 600).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          api: "x",
          provider: "t",
          model: "m",
          usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3 },
          stopReason: "stop",
          timestamp: now - 600,
        },
      },
    ]
      .map((entryRow) => JSON.stringify(entryRow))
      .join(NL) + NL,
    "utf8",
  );

  section("host bind guard");
  const noToken = await runCli(["serve", "--port", String(await freePort()), "--host", "0.0.0.0"], baseEnv({
    ABSENCE_STATE_DIR: stateDir,
    ABSENCE_OBSERVE_PI_ROOT: piRoot,
  }));
  check(
    "serve refuses a non-loopback host without a token",
    noToken.code !== 0 && /ABSENCE_TOKEN/.test(noToken.stderr),
    `code ${noToken.code} stderr ${noToken.stderr.slice(0, 200)}`,
  );

  section("serve with a token");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [tsxCli, entry, "serve", "--port", String(port), "--host", "127.0.0.1"], {
    cwd: REPO_ROOT,
    env: baseEnv({
      ABSENCE_STATE_DIR: stateDir,
      ABSENCE_OBSERVE_PI_ROOT: piRoot,
      ABSENCE_TOKEN: TOKEN,
      ABSENCE_ARCHIVE_SILENCE_MS: "600000",
    }),
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (!text.includes("incoming request") && !text.includes("request completed")) {
      process.stderr.write(`[server] ${text}`);
    }
  });

  const cliEnv = baseEnv({ ABSENCE_URL: url, ABSENCE_TOKEN: TOKEN });

  try {
    let up = false;
    for (let attempt = 0; attempt < 120 && !up; attempt++) {
      await sleep(500);
      up = await fetch(`${url}/api/observe/live?token=${encodeURIComponent(TOKEN)}`)
        .then((r) => r.ok)
        .catch(() => false);
    }
    check("the token-protected server booted", up);
    if (!up) throw new Error("server did not boot");

    section("token enforcement");
    const bare = await fetch(`${url}/api/observe/live`);
    check("the API answers 401 without a token", bare.status === 401, `status ${bare.status}`);
    const withQuery = await fetch(`${url}/api/observe/live?token=${encodeURIComponent(TOKEN)}`);
    check("the API answers 200 with the query token", withQuery.status === 200);
    const withHeader = await fetch(`${url}/api/observe/live`, { headers: { "x-absence-token": TOKEN } });
    check("the API answers 200 with the header token", withHeader.status === 200);
    const wrong = await fetch(`${url}/api/observe/live?token=nope`);
    check("a wrong token is refused", wrong.status === 401);

    section("absence ls");
    let ls: { code: number | null; stdout: string; stderr: string } = { code: 1, stdout: "", stderr: "" };
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(250);
      ls = await runCli(["ls", "--json"], cliEnv);
      if (ls.code === 0 && ls.stdout.trim().startsWith("[")) break;
    }
    check("absence ls --json succeeds", ls.code === 0, ls.stderr.slice(0, 200));
    let targets: TargetRow[] = [];
    try {
      targets = JSON.parse(ls.stdout) as TargetRow[];
    } catch {
      targets = [];
    }
    check("absence ls --json lists the transcript target", targets.some((row) => row.transcriptFile === transcriptFile), ls.stdout.slice(0, 300));

    section("absence observe");
    let observed = { code: 1 as number | null, stdout: "", stderr: "" };
    for (let attempt = 0; attempt < 20; attempt++) {
      observed = await runCli(["observe", "--session", transcriptFile], cliEnv);
      if (observed.code === 0 && observed.stdout.trim().length > 0) break;
      await sleep(250);
    }
    check("absence observe --session succeeds", observed.code === 0, observed.stderr.slice(0, 300));
    const panelUrl = observed.stdout.trim();
    check("it prints a panel URL", /\/s\/[^?\s]+/.test(panelUrl), panelUrl);
    check("it carries the token", panelUrl.includes(`token=${TOKEN}`), panelUrl);
    const sessionId = panelUrl.match(/\/s\/([^?\s]+)/)?.[1] ?? "";
    check("the session it names exists", (await fetch(`${url}/api/sessions/${sessionId}?token=${encodeURIComponent(TOKEN)}`)).ok, sessionId);

    section("absence open");
    const opened = await runCli(["open", sessionId], cliEnv);
    check("absence open prints the same panel", opened.code === 0 && opened.stdout.trim().includes(`/s/${sessionId}`), opened.stdout.trim());

    section("absence unwatch");
    const unwatched = await runCli(["unwatch", sessionId], cliEnv);
    check("absence unwatch succeeds", unwatched.code === 0, unwatched.stderr.slice(0, 200));
    const live = await (
      await fetch(`${url}/api/observe/live?token=${encodeURIComponent(TOKEN)}`)
    ).json() as { sessions: Array<{ sessionId: string; leased?: boolean }> };
    check(
      "the session is no longer leased but still live",
      live.sessions.some((row) => row.sessionId === sessionId && row.leased !== true),
      JSON.stringify(live.sessions),
    );
  } finally {
    server.kill();
    await sleep(400);
  }

  finish("check-cli-observe");
}

await main();