/**
 * Docker monitoring check (Windows) — what the Job Object observer actually
 * sees when the agent drives Docker, and where the boundary sits.
 *
 * Docker on this machine runs inside WSL2 (no Docker Desktop on the host), so
 * the realistic agent command is `wsl docker …`. Every scenario is driven the
 * way `AbsenceShell` drives a real command: a command window (begin/end), a
 * marker in the shell's command line, the real process tree underneath.
 *
 *   npx tsx scripts/checks/check-docker.ts
 *
 * It needs the WSL daemon up; the script starts it when needed.
 */
import { check, finish } from "./harness";
import { spawn, spawnSync } from "node:child_process";
import type { ProcessPayload } from "@absence/core";
import { JobMonitor } from "../../apps/server/src/process/JobMonitor";
import { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";
import { classifyProcess } from "../../apps/server/src/process/classify";
import { parseCommandIntent } from "../../apps/server/src/process/CommandIntent";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a shell command the way the shell tool would, synchronously, no capture. */
function runSync(command: string, cwd?: string): number {
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", command], {
    stdio: "ignore",
    windowsHide: true,
    cwd,
  });
  return result.status ?? -1;
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.log("this check drives Windows Docker (via WSL); nothing to do elsewhere.");
    return;
  }

  // Pre-flight: the WSL daemon may be down after an idle VM shutdown. Starting
  // the service returns before dockerd listens, so poll until it answers.
  runSync(`wsl -d Ubuntu-24.04 -u root service docker start`);
  let daemonUp = false;
  for (let attempt = 0; attempt < 20 && !daemonUp; attempt++) {
    daemonUp = runSync(`wsl -d Ubuntu-24.04 docker info > NUL 2>&1`) === 0;
    if (!daemonUp) await sleep(1000);
  }
  check("wsl docker daemon is reachable", daemonUp);
  if (!daemonUp) {
    console.error("start the docker daemon inside WSL before running this check.");
    process.exit(1);
  }

  const monitor = JobMonitor.get();
  try {
    await monitor.start();
  } catch (error) {
    console.error(`agentwatch did not start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  check("agentwatch is watching", monitor.available);

  const events: ProcessPayload[] = [];
  const watcher = new ProcessWatcher({ onProcess: (payload) => events.push(payload) });
  watcher.warm();

  /**
   * Drive one command through the same window + marker path AbsenceShell uses.
   * Returns the eggs laid while the window was open (running or exited).
   */
  const scenarios: Array<{ id: string; command: string; cwd?: string; settleMs: number }> = [];
  const eggsOf = (commandText: string): ProcessPayload[] =>
    events.filter((event) => event.command === commandText && event.name.toLowerCase() !== "conhost.exe");

  async function drive(
    label: string,
    commandText: string,
    opts: { cwd?: string; settleMs?: number; whileRunning?: () => void } = {},
  ): Promise<{ eggs: ProcessPayload[]; stdout: string }> {
    const id = `check: ${label}`;
    scenarios.push({ id, command: commandText, cwd: opts.cwd, settleMs: opts.settleMs ?? 1500 });
    const marker = `absence-${Math.random().toString(16).slice(2, 10)}`;
    const commandId = watcher.begin(commandText, opts.cwd);
    watcher.noteMarker(marker);
    // `echo` puts the marker on the shell's command line and always runs; a
    // `rem` here would swallow the whole line (`&` included) as its comment.
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `echo ${marker} > NUL & ${commandText} & exit 0`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: opts.cwd,
    });
    const stdout: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    const childPid = child.pid;
    if (opts.whileRunning) {
      await sleep(1200);
      opts.whileRunning();
      console.log(
        `  live    : ` +
          (liveSnapshot.length
            ? liveSnapshot.map((e) => `${e.name}(${e.status})`).join(", ")
            : "(nothing running)"),
      );
    }
    await sleep(opts.settleMs ?? 1500);
    watcher.end(commandId);
    // The watcher re-emits an egg as its tree changes; keep one entry per pid.
    const eggs = [...new Map(eggsOf(commandText).map((e) => [e.pid, e])).values()];
    console.log(
      `\n— ${label}\n  command : ${commandText}\n  shell   : pid ${childPid} (excluded by marker)\n  eggs    : ` +
        (eggs.length
          ? eggs
              .map(
                (e) =>
                  `${e.name} pid=${e.pid} ${e.status} kind=${e.kind ?? "?"} (${e.kindReason ?? "?"}) children=${e.children} cmd="${e.commandLine.slice(0, 90)}"`,
              )
              .join("\n            ")
          : "(none)"),
    );
    return { eggs, stdout: Buffer.concat(stdout).toString("utf8") };
  }

  // --- S1: a docker query. The client folds into a helper count; nothing else. ---
  const s1 = (await drive("docker ps (query)", "wsl docker ps")).eggs;

  // --- S2: a detached container. The workload lives inside the WSL VM. ---
  const s2 = (
    await drive(
      "docker run -d nginx (detached container)",
      "wsl docker run -d --name absence-egg-nginx -p 18848:80 nginx:alpine",
      { settleMs: 2500 },
    )
  ).eggs;

  // --- S3: compose up, the README's flagship example (`docker compose up -d`
  // shows the containers, not the client). ---
  const s3 = (
    await drive(
      "docker compose up -d (two services)",
      `wsl docker compose -f /mnt/e/0down/daze/.tmp-docker-check/docker-compose.yml -p absence-egg up -d`,
      { settleMs: 3500 },
    )
  ).eggs;

  // --- S3b: verify the services came up, with a command of its own (an agent
  // would run `docker ps` next; driving it keeps it out of S3's post-window
  // slack, where a background process is still credited to S3). ---
  const s3b = await drive("docker ps (after compose up)", `wsl docker ps --format "{{.Names}}"`);
  const composeRunning = s3b.stdout.includes("absence-egg");
  check("the compose services are running inside WSL", composeRunning, s3b.stdout.trim().slice(0, 120));
  check(
    "no Windows process is credited with the containers",
    s3.every((e) => e.name.toLowerCase().startsWith("wsl")),
    `non-wsl eggs: ${s3.filter((e) => !e.name.toLowerCase().startsWith("wsl")).map((e) => e.name).join(",") || "(none)"}`,
  );

  // --- S4: a foreground container. While it runs, sample what Windows sees. ---
  let liveSnapshot: ProcessPayload[] = [];
  const s4 = (
    await drive("docker run (foreground container)", "wsl docker run --rm nginx:alpine sleep 4", {
      settleMs: 6000,
      whileRunning: () => {
        liveSnapshot = [...events.filter((e) => e.status === "running")];
      },
    })
  ).eggs;
  check(
    "a foreground container still exposes no Windows process",
    s4.every((e) => e.name.toLowerCase().startsWith("wsl")),
    s4.map((e) => e.name).join(","),
  );

  // --- what the classification would do with a Windows docker client ---
  // On a host with Docker Desktop the client *would* be a real Windows process.
  const clientInput = {
    name: "docker.exe",
    commandLine: `"C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe" compose up -d`,
    exePath: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    cwd: "E:\\0down\\daze",
    intent: parseCommandIntent("docker compose up -d"),
    survivedCommand: false,
    ageMs: 400,
    children: 0,
    ppid: 4242,
  };
  // The classifier folds a short-lived client into the helper count…
  const clientVerdict = classifyProcess(clientInput);
  check(
    "a visible docker client classifies as a tool",
    clientVerdict.kind === "tool",
    `${clientVerdict.kind} (${clientVerdict.reason})`,
  );
  // …and is promoted to primary if it outlives its command.
  const survivingVerdict = classifyProcess({ ...clientInput, survivedCommand: true });
  check(
    "a docker client that outlives its command is promoted to primary",
    survivingVerdict.kind === "primary",
    `${survivingVerdict.kind} (${survivingVerdict.reason})`,
  );

  // --- the boundary, stated as data: the only Windows-visible processes across
  // every docker scenario. The watcher's own sampler (a powershell that reads
  // the process table) is plumbing, and an ambient process may land in a
  // window's slack — neither is a docker workload. ---
  const allEggs = [...s1, ...s2, ...s3, ...s3b.eggs, ...s4].filter(
    (e) => !e.commandLine.includes("Get-CimInstance"),
  );
  const names = new Set(allEggs.map((e) => e.name.toLowerCase()));
  console.log(`\ndistinct Windows-visible processes across all docker scenarios: ${[...names].join(", ") || "(none)"}`);
  const containerEggs = allEggs.filter((e) => !e.name.toLowerCase().startsWith("wsl"));
  console.log(
    `container processes visible to the Job Object: ${containerEggs.length}` +
      (containerEggs.length ? ` (${containerEggs.map((e) => e.name).join(", ")})` : ""),
  );
  check(
    "the only Windows process a docker command lays is the wsl.exe client",
    [...names].every((name) => name.startsWith("wsl")),
    `saw: ${[...names].join(", ") || "(none)"}`,
  );
  void liveSnapshot;

  // Leave no test workload behind.
  runSync(`wsl docker rm -f absence-egg-nginx > NUL 2>&1`);
  runSync(`wsl docker compose -p absence-egg down > NUL 2>&1`);

  watcher.stop();
  monitor.dispose();
  finish();
}

void main();
