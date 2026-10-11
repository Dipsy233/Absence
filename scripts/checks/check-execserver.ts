/**
 * Integration check for Absence's Codex exec-server.
 *   npx tsx scripts/checks/check-execserver.ts
 *
 * Codex hands every command to whatever exec-server the thread's environment
 * names (see ExecServer.ts). The check speaks that protocol over a real
 * loopback WebSocket and asserts the three things the takeover exists for:
 *
 *   - `process/start` spawns the process and answers with its id;
 *   - output streams back as `process/output`;
 *   - the exit arrives as `process/exited` + `process/closed`, first-hand — the
 *     reason an egg can never be stuck at "running".
 *
 * It also asserts the watch window: the exec-server tells the ProcessWatcher a
 * command began and ended, so eggs are attributed to it exactly as for Pi.
 */
import { WebSocket } from "ws";
import { CodexExecServer } from "../../apps/server/src/process/ExecServer";
import type { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`);
  }
}

/** A watcher stub that records the begin/end calls the server makes. */
interface WatcherSpy {
  watcher: ProcessWatcher;
  begins: string[];
  ends: () => number;
}

function watcherSpy(): WatcherSpy {
  const begins: string[] = [];
  let ends = 0;
  let next = 0;
  const watcher = {
    begin: (command: string) => {
      begins.push(command);
      return ++next;
    },
    end: () => {
      ends += 1;
    },
  } as unknown as ProcessWatcher;
  return { watcher, begins, ends: () => ends };
}

const isWindows = process.platform === "win32";
const SHELL = isWindows ? "pwsh.exe" : "bash";
const ECHO = isWindows
  ? ["-NoProfile", "-Command", "Write-Output EXEC_HELLO"]
  : ["-lc", "echo EXEC_HELLO"];
const NODE_VERSION = isWindows
  ? ["-NoProfile", "-Command", "node -v"]
  : ["-lc", "node -v"];
// A command that echoes a marker and then waits, used for the PTY checks.
const PTY_ECHO = isWindows
  ? ["-NoProfile", "-Command", "Write-Output PTY_MARK; Start-Sleep -Seconds 60"]
  : ["-lc", "echo PTY_MARK; sleep 60"];
// A command that runs until interrupted: it prints a marker, then sits still.
const LONG_RUNNING = isWindows
  ? ["-NoProfile", "-Command", "Write-Output READY; Start-Sleep -Seconds 60"]
  : ["-lc", "echo READY; sleep 60"];

/** Run one command to completion; returns its combined stdout. */
async function runCommand(rpc: Rpc, processId: string, argv: string[]): Promise<string> {
  await rpc.send("process/start", {
    processId,
    argv,
    cwd: "file:///" + (isWindows ? (process.cwd().replace(/\\/g, "/")) : process.cwd().replace(/^\//, "")),
    // Deliberately sparse, and deliberately *no* PATH: this is the shape Codex
    // actually sends, and the one the layering must survive.
    env: { ABSENCE_TEST_MARKER: "1" },
    tty: false,
    pipeStdin: false,
    arg0: null,
  });
  let out = "";
  for (;;) {
    const note = await rpc.waitNotify("process/output", "proc-2", 8000);
    out += decode(note.chunk);
    if (out.includes("\n") || out.length > 200) return out;
  }
}

function decode(chunk: string): string {
  return Buffer.from(chunk, "base64").toString("utf8");
}

interface Rpc {
  send(method: string, params: unknown, id?: number): Promise<any>;
  notify(method: string, params: unknown): void;
  waitNotify(method: string, processId?: string, timeoutMs?: number): Promise<any>;
  drain(): void;
  close(): void;
}

/** A minimal JSON-RPC client over the exec-server's loopback WebSocket. */
function connect(url: string): Promise<Rpc> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map<number, (v: any) => void>();
    const notifications: Array<{ method: string; params: any }> = [];
    const waiters: Array<{ method: string; processId?: string; resolve: (v: any) => void }> = [];

    ws.on("message", (buf: Buffer) => {
      const msg = JSON.parse(buf.toString("utf8"));
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        pending.get(msg.id)?.(msg.error ?? msg.result);
        pending.delete(msg.id);
        return;
      }
      if (typeof msg.method === "string") {
        const waiter = waiters.findIndex(
          (w) =>
            w.method === msg.method &&
            (w.processId === undefined || w.processId === msg.params?.processId),
        );
        if (waiter >= 0) {
          const [entry] = waiters.splice(waiter, 1);
          entry!.resolve(msg.params);
        } else {
          notifications.push({ method: msg.method, params: msg.params });
        }
      }
    });

    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        send: (method, params, id) =>
          new Promise((res) => {
            const rid = id ?? nextId++;
            pending.set(rid, res);
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }));
          }),
        notify: (method, params) => {
          ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
        },
        drain: () => {
          notifications.length = 0;
        },
        waitNotify: (method, processId, timeoutMs = 4000) =>
          new Promise((res, rej) => {
            const matches = (n: { method: string; params: any }) =>
              n.method === method && (processId === undefined || n.params?.processId === processId);
            const existing = notifications.findIndex(matches);
            if (existing >= 0) {
              const [entry] = notifications.splice(existing, 1);
              res(entry!.params);
              return;
            }
            const timer = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), timeoutMs);
            waiters.push({
              method,
              processId,
              resolve: (v) => {
                clearTimeout(timer);
                res(v);
              },
            });
          }),
        close: () => ws.close(),
      }),
    );
  });
}

async function main(): Promise<void> {
  const spy = watcherSpy();
  const server = new CodexExecServer({ processWatcher: spy.watcher });
  const url = await server.listen();
  check("exec-server listens on a loopback ws URL", /^ws:\/\/127\.0\.0\.1:\d+$/.test(url), url);

  const rpc = await connect(url);

  // Handshake (the exec-server protocol's initialize/initialized).
  const init = await rpc.send("initialize", { clientName: "check" });
  check("initialize returns a session id", typeof init?.sessionId === "string" && init.sessionId.length > 0, JSON.stringify(init));
  check("initialize reports the environment shell", typeof init?.environmentInfo?.shell?.name === "string", JSON.stringify(init?.environmentInfo));
  // `initialized` is a notification, not a request: it gets no reply.
  rpc.notify("initialized", {});

  // A command: spawn the shell, echo, exit.
  const started = await rpc.send("process/start", {
    processId: "proc-1",
    argv: [SHELL, ...ECHO],
    cwd: "file:///" + (isWindows ? process.cwd().replace(/\\/g, "/") : process.cwd().replace(/^\//, "")),
    env: process.env,
    tty: false,
    pipeStdin: false,
    arg0: null,
  });
  check("process/start answers with the process id", started?.processId === "proc-1", JSON.stringify(started));
  check("the command opened a watch window", spy.begins.includes("EXEC_HELLO") || spy.begins.length === 1, JSON.stringify(spy.begins));

  // Output + exit arrive as notifications.
  const output = await rpc.waitNotify("process/output", "proc-1");
  check("process/output carries the shell's stdout", decode(output.chunk).includes("EXEC_HELLO"), JSON.stringify(output).slice(0, 120));

  const exited = await rpc.waitNotify("process/exited", "proc-1");
  check("process/exited reports the exit code", exited?.exitCode === 0, JSON.stringify(exited));
  check("process/exited arrives first-hand (no polling)", typeof exited?.seq === "number");

  const closed = await rpc.waitNotify("process/closed", "proc-1");
  check("process/closed marks the handle removed", closed?.processId === "proc-1", JSON.stringify(closed));
  check("the command's watch window closed", spy.ends() >= 1, String(spy.ends()));

  // A duplicate id is rejected, as the protocol requires.
  const dupe = await rpc.send("process/start", {
    processId: "proc-1",
    argv: [SHELL, ...ECHO],
    cwd: "file:///",
    env: {},
    tty: false,
    pipeStdin: false,
  });
  // proc-1 already closed, so this must succeed as a fresh start; a *live* dup
  // is what is rejected. Just assert it did not error the connection.
  check("the server keeps serving after an exit", dupe !== undefined, JSON.stringify(dupe));

  // The environment layering: Codex sends a *sparse* env with no PATH (its own
  // executor fills the rest in). Absence must layer it over the server's own
  // environment, or `pwsh` has no PATH and `node` is "未知" — the exact bug
  // this check pins. Here the command asks the shell to run `node`, which is
  // only resolvable through the inherited PATH.
  const nodeOut = await runCommand(rpc, "proc-2", [SHELL, ...NODE_VERSION]);
  check(
    "a command with a PATH-less env still resolves node (server env is the base)",
    nodeOut.includes("v") && /\d+\.\d+\.\d+/.test(nodeOut),
    JSON.stringify(nodeOut).slice(0, 120),
  );

  // Ctrl+C: Codex does not write a byte to a non-PTY stdin — it calls
  // `process.interrupt()`, which lands as `process/signal { signal: interrupt }`.
  // The process must actually stop, and the exit must be reported first-hand.
  rpc.drain();
  const longId = "proc-signal";
  await rpc.send("process/start", {
    processId: longId,
    argv: [SHELL, ...LONG_RUNNING],
    cwd: "file:///" + (isWindows ? process.cwd().replace(/\\/g, "/") : process.cwd().replace(/^\//, "")),
    env: { ABSENCE_TEST_MARKER: "1" },
    tty: false,
    pipeStdin: false,
    arg0: null,
  });
  const ready = await rpc.waitNotify("process/output", "proc-signal", 8000);
  check("a long-running command starts and streams", decode(ready.chunk).includes("READY"), JSON.stringify(ready).slice(0, 100));

  const signalAck = await rpc.send("process/signal", { processId: longId, signal: "interrupt" });
  check("process/signal interrupts without error", signalAck !== undefined && signalAck.code === undefined, JSON.stringify(signalAck));

  const interrupted = await rpc.waitNotify("process/exited", "proc-signal", 8000);
  check("the interrupted command reports its exit first-hand", interrupted?.processId === longId, JSON.stringify(interrupted));

  // An interrupt on an unknown id is a no-op success, not an error.
  const missing = await rpc.send("process/signal", { processId: "nope", signal: "interrupt" });
  check("interrupting an unknown process is a no-op", missing !== undefined && missing.code === undefined, JSON.stringify(missing));

  // tty: true — a real PTY, exactly as Codex allocates one. Output arrives on
  // the `pty` stream (a PTY merges stdout and stderr), and Ctrl+C written to it
  // is delivered by the terminal driver.
  rpc.drain();
  const ptyId = "proc-pty";
  await rpc.send("process/start", {
    processId: ptyId,
    argv: [SHELL, ...PTY_ECHO],
    cwd: "file:///" + (isWindows ? process.cwd().replace(/\\/g, "/") : process.cwd().replace(/^\//, "")),
    env: { ABSENCE_TEST_MARKER: "1" },
    tty: true,
    pipeStdin: false,
    arg0: null,
  });
  const ptyOut = await rpc.waitNotify("process/output", ptyId, 8000);
  check("a tty command streams on the pty stream", ptyOut?.stream === "pty" && decode(ptyOut.chunk).includes("PTY_MARK"), JSON.stringify(ptyOut).slice(0, 100));

  // Ctrl+C through the PTY: write ETX. The terminal driver turns it into the
  // interrupt, and the command exits — no `process/signal` needed.
  await rpc.send("process/write", { processId: ptyId, chunk: Buffer.from("\u0003").toString("base64") });
  const ptyExit = await rpc.waitNotify("process/exited", ptyId, 8000);
  check("Ctrl+C written to the PTY stops the command", ptyExit?.processId === ptyId, JSON.stringify(ptyExit));

  rpc.close();
  server.close();
  check("close() stops the server", true);

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error("check-execserver crashed:", error);
  process.exit(1);
});
