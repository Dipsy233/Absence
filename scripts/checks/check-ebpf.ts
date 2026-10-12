/**
 * Integration check for the eBPF process observer (Linux only).
 *   npx tsx scripts/check-ebpf.ts
 *
 * The point of the observer is that a process which lives a few milliseconds is
 * seen like any other. This starts the real helper, drives the real
 * ProcessWatcher, and asserts that short-lived children are reported with their
 * command line and attributed to the command that laid them.
 *
 * Build the helper first:  native/agentwatch-linux/build.sh
 */
import { check, finish } from "./harness";
import { spawn } from "node:child_process";
import type { ProcessPayload } from "@absence/core";
import { JobMonitor } from "../../apps/server/src/process/JobMonitor";
import { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";



function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (process.platform !== "linux") {
    console.log("the eBPF observer is Linux-only; nothing to check on this platform.");
    return;
  }

  const monitor = JobMonitor.get();
  try {
    await monitor.start();
  } catch (error) {
    console.error(`agentwatch-linux did not start: ${error instanceof Error ? error.message : String(error)}`);
    console.error("(build it with: native/agentwatch-linux/build.sh)");
    process.exit(1);
  }
  check("agentwatch-linux is watching", monitor.available);

  const events: ProcessPayload[] = [];
  const watcher = new ProcessWatcher({ onProcess: (payload) => events.push(payload) });
  watcher.warm();

  const commandId = watcher.begin("test: short-lived children", process.cwd());
  const spawnCount = 8;
  for (let i = 0; i < spawnCount; i++) {
    spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
  }
  await sleep(1500);
  watcher.end(commandId);

  const running = events.filter((event) => event.status === "running");
  const shEggs = running.filter((event) => event.name === "sh" || event.name === "dash");
  check(
    `caught all ${spawnCount} short-lived children`,
    shEggs.length >= spawnCount,
    `got ${shEggs.length} of ${spawnCount}: ${shEggs.map((e) => e.pid).join(",")}`,
  );
  check(
    "the eggs carry a command line",
    shEggs.every((event) => event.commandLine.includes("exit 0")),
    shEggs.map((event) => event.commandLine).join(" | "),
  );
  check(
    "every egg is attributed to the command that laid it",
    shEggs.every((event) => event.command === "test: short-lived children"),
    shEggs.map((event) => `${event.pid}=${event.command}`).join(" | "),
  );
  check(
    "exits are reported",
    events.some((event) => event.status === "exited"),
  );

  // Regression: Codex mode calls `beginSession`, but the eBPF observer reports
  // no `ABSENCE_SESSION_ID` marker (there is no env read on Linux, and the shell
  // wrapper is a command-line comment, not an env var). A session id must only
  // *exclude* other sessions' processes, never discard the unmarked ones — or
  // Linux would capture nothing at all under Codex.
  const codexEvents: ProcessPayload[] = [];
  const codexWatcher = new ProcessWatcher({ onProcess: (payload) => codexEvents.push(payload) });
  codexWatcher.warm();
  codexWatcher.beginSession("codex-session-check");
  const codexId = codexWatcher.begin("node -v", process.cwd());
  spawn("/bin/sh", ["-c", "exec /bin/echo CODEX_MARK"], { stdio: "ignore" });
  await sleep(1500);
  codexWatcher.end(codexId);
  check(
    "an unmarked process is still captured while a session id is set",
    codexEvents.some((event) => event.commandLine.includes("CODEX_MARK")),
    JSON.stringify(codexEvents.map((e) => e.commandLine)),
  );
  codexWatcher.stop();

  watcher.stop();
  monitor.dispose();

  finish();
}

void main();
