/**
 * Integration check for the Job Object observer (read.md §6, Windows only).
 *   npx tsx scripts/check-agentwatch.ts
 *
 * The point of the sidecar is that a process which lives a few tens of
 * milliseconds is seen like any other. The polling watcher could not do that:
 * a snapshot every ~1.1 s rarely lands inside a 20 ms lifetime. This script
 * starts the real helper against this process, drives the real ProcessWatcher,
 * and asserts that short-lived children are reported.
 *
 * On non-Windows platforms the script explains itself and exits 0: the fallback
 * path is what runs there, and it is the same code the server uses.
 */
import { spawn } from "node:child_process";
import type { ProcessPayload } from "@absence/core";
import { JobMonitor } from "../../apps/server/src/process/JobMonitor";
import { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.log("agentwatch is Windows-only; nothing to check on this platform.");
    return;
  }

  const monitor = JobMonitor.get();
  try {
    await monitor.start();
  } catch (error) {
    console.error(`agentwatch did not start: ${error instanceof Error ? error.message : String(error)}`);
    console.error("(build it with: cd native/agentwatch && g++ -O2 -municode -o agentwatch.exe agentwatch.c -lntdll)");
    process.exit(1);
  }
  check("agentwatch is watching", monitor.available);

  const events: ProcessPayload[] = [];
  const watcher = new ProcessWatcher({ onProcess: (payload) => events.push(payload) });
  watcher.warm();

  // One "command": short-lived children are the hard case the sidecar exists for.
  const commandId = watcher.begin("test: short-lived children");
  const spawnCount = 8;
  for (let i = 0; i < spawnCount; i++) {
    spawn("cmd.exe", ["/c", "exit", "0"], { stdio: "ignore", windowsHide: true });
  }
  await sleep(1500);
  watcher.end(commandId);

  const running = events.filter((event) => event.status === "running");
  const cmdEggs = running.filter((event) => event.name.toLowerCase() === "cmd.exe");
  check(
    `caught all ${spawnCount} short-lived cmd.exe`,
    cmdEggs.length >= spawnCount,
    `got ${cmdEggs.length} of ${spawnCount}: ${cmdEggs.map((e) => e.pid).join(",")}`,
  );
  check(
    "the eggs carry a command line (shell wrapper stripped)",
    cmdEggs.every((event) => event.commandLine.length > 0) &&
      cmdEggs.every((event) => !event.commandLine.toLowerCase().includes("cmd.exe")),
    cmdEggs.map((event) => event.commandLine).join(" | "),
  );
  check(
    "every egg is attributed to the command that laid it",
    cmdEggs.every((event) => event.command === "test: short-lived children"),
    cmdEggs.map((event) => `${event.pid}=${event.command}`).join(" | "),
  );
  check(
    "console hosts are filtered out",
    !events.some((event) => event.name.toLowerCase() === "conhost.exe"),
  );
  check(
    "exits are reported",
    events.some((event) => event.status === "exited"),
  );

  // Absence's own shell carries a marker and must never be reported as an egg; its
  // children (the real work) must be. This is the shape `AbsenceShell` produces:
  // the marker is a `# comment` at the head of the command.
  watcher.noteMarker("absence-test-marker");
  const markedId = watcher.begin("test: marked shell");
  const marked = spawn("cmd.exe", ["/c", "echo absence-test-marker & exit 0"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const markedPid = marked.pid;
  await sleep(1500);
  watcher.end(markedId);
  check(
    "the shell carrying Absence's marker is not reported as an egg",
    !events.some((event) => event.pid === markedPid),
    `saw pid ${markedPid}`,
  );

  // Codex mode: Absence cannot wrap the runtime's shell, so the runtime injects
  // `ABSENCE_SESSION_ID` into the command's environment instead (shell_environment_policy.set)
  // and the kernel reports it as `sess`. Only marked processes belong to the
  // session; an unmarked child is the server's own plumbing and must not be
  // credited to the command, however wide the window is.
  const codexSession = "codex-check-session";
  watcher.beginSession(codexSession);
  const codexId = watcher.begin("test: codex command");
  const markedChild = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 1500)"], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ABSENCE_SESSION_ID: codexSession },
  });
  const unmarkedChild = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 1500)"], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ABSENCE_SESSION_ID: "some-other-session" },
  });
  const markedChildPid = markedChild.pid;
  const unmarkedChildPid = unmarkedChild.pid;
  await sleep(1800);
  watcher.end(codexId);

  check(
    "a process marked with the session id is reported as an egg",
    events.some((event) => event.pid === markedChildPid && event.command === "test: codex command"),
    `marked child ${markedChildPid}: ${events.filter((e) => e.pid === markedChildPid).map((e) => e.command).join(",")}`,
  );
  check(
    "a process carrying a different session id is not reported",
    !events.some((event) => event.pid === unmarkedChildPid),
    `foreign child ${unmarkedChildPid} leaked`,
  );

  // A running egg must never be stuck at "running" once its process is gone.
  // The exits come from the thread-pool wait on each process handle, so a tree
  // killed in one burst cannot lose a child's exit.
  const daemonSession = "codex-check-daemon";
  watcher.beginSession(daemonSession);
  const daemonCmd = watcher.begin("test: long daemon");
  const daemon = spawn(process.execPath, ["-e", "setInterval(()=>{}, 500)"], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ABSENCE_SESSION_ID: daemonSession },
  });
  const daemonPid = daemon.pid;
  await sleep(1800);
  watcher.end(daemonCmd);
  const daemonRunning = events.find((event) => event.pid === daemonPid && event.status === "running");
  check("a long-lived daemon is reported running", daemonRunning !== undefined, `pid ${daemonPid}`);

  // Kill it, then give the kernel event + the alive tick time to land.
  spawn("taskkill", ["/PID", String(daemonPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await sleep(7000);
  check(
    "a killed daemon is reported exited",
    events.some((event) => event.pid === daemonPid && event.status === "exited"),
    `daemon ${daemonPid} still running`,
  );

  watcher.stop();
  monitor.dispose();

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
