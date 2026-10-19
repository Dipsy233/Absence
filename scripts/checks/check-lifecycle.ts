/**
 * Lifecycle check for the standalone server (`absence serve`).
 *   npx tsx scripts/checks/check-lifecycle.ts
 *
 * The failure this pins down was a real incident: a dev server orphaned when
 * its parent npm died kept running wedged — listening, 0% CPU, answering no
 * request — and held port 8848 until it was killed by hand. The server must
 * instead notice that nobody is above it and leave. The check asserts:
 *
 *   - stdin EOF exits the server: a piped parent dying closes the child's
 *     stdin, and that is the cheapest "parent is gone" signal there is;
 *   - a dead parent pid is noticed by the liveness watchdog (the TTY case,
 *     where stdin never closes), here sped up through ABSENCE_ORPHAN_TICK_MS;
 *   - a second server on an occupied port fails with instructions instead of
 *     a bare EADDRINUSE stack.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, finish, section, waitFor } from "./harness";

const PORT = 8899;
const SERVER_DIR = fileURLToPath(new URL("../../apps/server", import.meta.url));
// `npx` is not spawnable without a shell on Windows; run tsx's entry through
// node directly — the same thing `tsx src/index.ts` does.
const SERVER = [process.execPath, "../../node_modules/tsx/dist/cli.mjs", "src/index.ts", "serve"] as const;
const SPAWN_OPTS = {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), ABSENCE_ORPHAN_TICK_MS: "1000" },
  stdio: ["pipe", "pipe", "pipe"],
} as const;

/** Wait until the server answers on its port; also drains its stdout. */
async function waitListening(child: ChildProcess, timeoutMs = 20000): Promise<boolean> {
  child.stdout?.resume();
  child.stderr?.resume();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/runtimes`, {
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

async function exited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return waitFor(() => child.exitCode !== null || child.signalCode !== null, timeoutMs);
}

section("stdin EOF exits the server");
{
  const child = spawn(SERVER[0], SERVER.slice(1), SPAWN_OPTS);
  const up = await waitListening(child);
  check("server came up", up);
  if (up) {
    // The parent (npm, concurrently) dying closes our pipe: stdin EOF must
    // mean exit, not a headless server squatting on the port.
    child.stdin?.end();
    const gone = await exited(child, 10000);
    check("stdin close exits the server", gone, `exitCode=${child.exitCode} signal=${child.signalCode}`);
  } else {
    child.kill();
  }
}

section("dead parent pid is noticed by the watchdog");
{
  // The server's parent must be a process we can kill, so a placeholder node
  // spawns the server (inheriting the pipe-kept-open) and outlives it — then
  // dies. The server's stdin stays open (held by the placeholder), so only the
  // ppid watchdog can notice the death.
  const placeholder = [
    "const { spawn } = require('node:child_process');",
    "setInterval(() => {}, 1e9);",
    // Under `node -e` argv holds no script-name slot: everything after the
    // placeholder itself is the server command to re-spawn through node.
    "spawn(process.execPath, process.argv.slice(1), { cwd: process.cwd(), stdio: 'ignore', env: process.env });",
  ].join(";");
  const parent = spawn(
    process.execPath,
    ["-e", placeholder, ...SERVER.slice(1)],
    { cwd: SERVER_DIR, env: SPAWN_OPTS.env, stdio: ["ignore", "inherit", "inherit"] },
  );
  const up = await waitListening(parent);
  check("server came up under a live parent", up);
  if (up) {
    // Kill the parent: hard-kill on Windows, SIGTERM on POSIX — either way it
    // dies without closing anything the server depends on except its own
    // liveness. stdin is 'ignore' for the server, so the EOF guard is out of
    // the picture and only the ppid watchdog can end it.
    parent.kill();
    let freed = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const probe = await fetch(`http://127.0.0.1:${PORT}/api/runtimes`, { signal: AbortSignal.timeout(1000) });
        await probe.body?.cancel();
      } catch {
        freed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    check("dead parent exits the server (port freed)", freed);
  } else {
    parent.kill();
  }
}

section("occupied port fails with instructions");
{
  const holder = spawn(SERVER[0], SERVER.slice(1), SPAWN_OPTS);
  const up = await waitListening(holder);
  check("holder server came up", up);
  if (up) {
    const second = spawn(SERVER[0], SERVER.slice(1), SPAWN_OPTS);
    const stderr = await new Promise<string>((resolve) => {
      let text = "";
      second.stderr?.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      second.on("exit", () => resolve(text));
    });
    check(
      "second server names the port and the fix",
      /already taken/.test(stderr) && new RegExp(String(PORT)).test(stderr),
      stderr.slice(0, 200),
    );
    // holder.exitCode is set only after stdin is closed (orphan guard) — force
    // the same exit the previous section proved.
    holder.stdin?.end();
    await exited(holder, 10000);
  } else {
    holder.kill();
  }
}

finish("lifecycle checks");
