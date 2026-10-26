/**
 * Container egg check — the Docker observer (DockerMonitor + DockerEggs).
 *
 * The kernel observers cannot see past a VM boundary, so a container's egg is
 * laid from the daemon's own event stream and attributed by what the command
 * *predicts*: `docker run -d --name web nginx` names its container, and the
 * daemon's start event must match that prediction (name, image, or compose
 * project) to be credited. This check drives real docker commands through
 * command windows and asserts the whole story end to end:
 *
 *   command window → container start event → attributed primary egg
 *                  → per-container CPU/RSS from `docker stats`
 *                  → die event → exited egg with the real exit code
 *
 *   npx tsx scripts/checks/check-docker-eggs.ts
 *
 * Needs a reachable docker (PATH, or a WSL distro's on Windows); explains
 * itself and exits non-zero when there is none.
 */
import { check, finish } from "./harness";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessPayload } from "@absence/core";
import { JobMonitor } from "../../apps/server/src/process/JobMonitor";
import { DockerMonitor } from "../../apps/server/src/process/DockerMonitor";
import { DockerEggs } from "../../apps/server/src/process/DockerEggs";
import { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";

const CONTAINER = "absence-docker-egg-nginx";
const IMAGE = "nginx:alpine";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSync(command: string): number {
  return spawnSync("cmd.exe", ["/d", "/s", "/c", command], { stdio: "ignore", windowsHide: true }).status ?? -1;
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.log("this check drives docker (via WSL on Windows); nothing to do elsewhere.");
    return;
  }

  // Pre-flight: start the WSL daemon if it is down (a cold VM starts dockerd
  // asynchronously, so poll until it answers).
  runSync(`wsl -d Ubuntu-24.04 -u root service docker start`);
  let daemonUp = false;
  for (let attempt = 0; attempt < 20 && !daemonUp; attempt++) {
    daemonUp = runSync(`wsl -d Ubuntu-24.04 docker info > NUL 2>&1`) === 0;
    if (!daemonUp) await sleep(1000);
  }
  if (!daemonUp) {
    console.error("no reachable docker; start one before running this check.");
    process.exit(1);
  }
  // Leave no earlier attempt behind, and have the foreign container's image
  // ready so its start lands inside the window under test, not in a pull.
  runSync(`wsl docker rm -f ${CONTAINER} absence-foreign-nginx absence-pred-nginx absence-pred-foreign > NUL 2>&1`);
  runSync(`wsl docker pull redis:alpine > NUL 2>&1`);

  const monitor = JobMonitor.get();
  await monitor.start().catch(() => undefined);
  const docker = DockerMonitor.get();
  try {
    await docker.start();
  } catch (error) {
    console.error(`docker observer did not start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  check("docker observer is watching", docker.available);

  const payloads: ProcessPayload[] = [];
  const watcher = new ProcessWatcher({ onProcess: (payload) => payloads.push(payload) });
  watcher.warm();
  const eggs = new DockerEggs(watcher, (payload) => payloads.push(payload));
  // The wiring a SessionStore does: daemon events feed the session's eggs.
  const unsubDocker = docker.onContainer((event) => eggs.onContainerEvent(event));
  // The full container id of the check's own container, as the stats stream keys it.
  let startedContainerId: string | undefined;
  const unsubTap = docker.onContainer((event) => {
    if (event.name === CONTAINER && event.kind === "start") startedContainerId = event.containerId;
  });

  // Adopt whatever is running first; our container is not among it yet.
  await eggs.adopt();
  const adoptedBefore = payloads.length;

  // One command window, exactly the shape AbsenceShell produces.
  const commandText = `wsl docker run -d --name ${CONTAINER} ${IMAGE}`;
  const marker = `absence-${Math.random().toString(16).slice(2, 10)}`;
  const commandId = watcher.begin(commandText);
  watcher.noteMarker(marker);
  spawn("cmd.exe", ["/d", "/s", "/c", `echo ${marker} > NUL & ${commandText} & exit 0`], {
    stdio: "ignore",
    windowsHide: true,
  });

  // The container egg: laid from the daemon event, attributed by window alone.
  let startEgg: ProcessPayload | undefined;
  for (let attempt = 0; attempt < 40 && !startEgg; attempt++) {
    await sleep(250);
    startEggs: for (const payload of payloads.slice(adoptedBefore)) {
      if (payload.name === CONTAINER && payload.status === "running") {
        startEgg = payload;
        break startEggs;
      }
    }
  }
  watcher.end(commandId);

  check("the container is laid as an egg", startEgg !== undefined);
  if (startEgg) {
    check(
      "the container egg is a primary named by the container",
      startEgg.kind === "primary" && startEgg.kindReason === "docker container",
      `${startEgg.kind}/${startEgg.kindReason}`,
    );
    check(
      "the container egg is attributed to the command that laid it",
      startEgg.command === commandText,
      `command=${startEgg.command ?? "(none)"}`,
    );
    check(
      "the container egg's identity carries the image",
      (startEgg.commandLine ?? "").includes(IMAGE),
      startEgg.commandLine,
    );
    check("the container egg's pid is synthetic (far above any real pid)", startEgg.pid >= 1_000_000_000, String(startEgg.pid));
  }

  // Per-container counters arrive on the stats stream; give it two ticks.
  await sleep(8_000);
  const samples = eggs.extraSamples();
  const sample = startEgg ? samples.get(startEgg.pid) : undefined;
  check(
    "the container's resource counters arrive from the stats stream",
    sample !== undefined && sample.rssBytes > 0 && Number.isFinite(sample.cpuSeconds),
    sample ? `rss=${sample.rssBytes} cpu=${sample.cpuSeconds}` : "(no sample)",
  );
  const targets = eggs.metricsTargets();
  check(
    "the container is a metrics target",
    targets.some((target) => target.rootPid === startEgg?.pid && target.kind === "primary" && target.status === "running"),
  );

  // --- the stats stream is supervised: a killed child respawns, and the
  // readings resume fresh instead of freezing at the last value. An idle
  // container integrates ~0 CPU, so the assertion watches the freshness of
  // the underlying reading, not its magnitude. ---
  const cache = (docker as unknown as { resources: Map<string, { at: number }> }).resources;
  const preKillAt = cache.get(startedContainerId)?.at;
  (docker as unknown as { statsChild?: { kill(): void } }).statsChild?.kill();
  await sleep(6_000);
  const postKillAt = cache.get(startedContainerId)?.at;
  const fresh = postKillAt !== undefined && Date.now() - postKillAt < 6_000;
  check(
    "a killed stats stream respawns and resumes fresh readings",
    fresh && (preKillAt === undefined || postKillAt! > preKillAt),
    preKillAt && postKillAt
      ? `last line ${((Date.now() - postKillAt) / 1000).toFixed(1)}s ago (was ${(Date.now() - preKillAt).toFixed(0) >= 5_000 ? "stale" : "fresh"})`
      : "(no readings)",
  );

  // Stop the container; the die event carries the real exit code.
  runSync(`wsl docker rm -f ${CONTAINER} > NUL 2>&1`);
  let exitEgg: ProcessPayload | undefined;
  for (let attempt = 0; attempt < 40 && !exitEgg; attempt++) {
    await sleep(250);
    exitEgg = payloads.find(
      (payload) => payload.name === CONTAINER && payload.status === "exited" && payload.exitCode !== undefined,
    );
  }
  check("the container's exit is reported", exitEgg !== undefined);
  if (exitEgg) {
    check(
      "the container's exit code comes from the daemon",
      typeof exitEgg.exitCode === "number",
      `exit=${exitEgg.exitCode}`,
    );
  }

  // --- a container the *user* started — no command window anywhere — must not
  // become an egg. The daemon reports every container on the machine; the
  // window is the only thing that makes one the agent's work. ---
  spawn("cmd.exe", ["/d", "/s", "/c", `wsl docker run -d --name absence-foreign-nginx ${IMAGE}`], {
    stdio: "ignore",
    windowsHide: true,
  });
  await sleep(4_000);
  const foreignCount = payloads.filter((payload) => payload.name === "absence-foreign-nginx").length;
  check("a container laid outside any command window gets no egg", foreignCount === 0, `${foreignCount} events`);

  // --- prediction: the command's words say which containers it lays. A
  // foreign container started *inside* the window — same moment, both docker —
  // is not credited, because `--name` names the agent's one and nothing else. ---
  spawn("cmd.exe", ["/d", "/s", "/c", `wsl docker run -d --name absence-pred-nginx ${IMAGE}`], {
    stdio: "ignore",
    windowsHide: true,
  });
  const predId = watcher.begin(`wsl docker run -d --name absence-pred-nginx ${IMAGE}`);
  watcher.noteMarker(marker);
  await sleep(300);
  spawn("cmd.exe", ["/d", "/s", "/c", `wsl docker run -d --name absence-pred-foreign redis:alpine`], {
    stdio: "ignore",
    windowsHide: true,
  });
  await sleep(4_000);
  watcher.end(predId);
  const predEgg = payloads.find(
    (payload) => payload.name === "absence-pred-nginx" && payload.command?.includes("absence-pred-nginx"),
  );
  check("the named container is credited by its command's prediction", predEgg !== undefined);
  const predForeign = payloads.filter((payload) => payload.name === "absence-pred-foreign").length;
  check(
    "a foreign container inside the window is not credited — it matches nothing the command predicted",
    predForeign === 0,
    `${predForeign} events`,
  );

  // --- a run without --name: the image is the prediction. ---
  const noNameText = `wsl docker run -d --rm ${IMAGE}`;
  const noNameWindow = watcher.begin(noNameText);
  watcher.noteMarker(marker);
  spawn("cmd.exe", ["/d", "/s", "/c", `echo ${marker} > NUL & ${noNameText} & exit 0`], {
    stdio: "ignore",
    windowsHide: true,
  });
  await sleep(4_000);
  watcher.end(noNameWindow);
  const noNameEgg = payloads.find(
    (payload) => (payload.commandLine ?? "").includes(IMAGE) && payload.command === noNameText && payload.pid >= 1_000_000_000,
  );
  check(
    "an unnamed container is credited through its image",
    noNameEgg !== undefined && noNameEgg.command === noNameText,
    noNameEgg ? `command=${noNameEgg.command}` : "(no egg)",
  );

  // --- compose: the daemon's project label matches the command's project. ---
  const composeDir = path.join(os.tmpdir(), `absence-pred-compose-${Date.now()}`);
  await fs.mkdir(composeDir, { recursive: true });
  await fs.writeFile(path.join(composeDir, "dc.yml"), "services:\n  web:\n    image: nginx:alpine\n", "utf8");
  const composePosix = composeDir.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/mnt/$1").toLowerCase();
  const composeText = `wsl docker compose -f ${composePosix}/dc.yml -p absence-pred-c up -d`;
  const composeWindow = watcher.begin(composeText);
  watcher.noteMarker(marker);
  spawn("cmd.exe", ["/d", "/s", "/c", `echo ${marker} > NUL & ${composeText} & exit 0`], {
    stdio: "ignore",
    windowsHide: true,
  });
  await sleep(5_000);
  watcher.end(composeWindow);
  runSync(`wsl docker compose -p absence-pred-c -f ${composePosix}/dc.yml down > NUL 2>&1`);
  const composeEggs = payloads.filter(
    (payload) => payload.name.startsWith("absence-pred-c-") && payload.command === composeText,
  );
  check(
    "a compose container is credited through the project label",
    composeEggs.length > 0,
    composeEggs.map((payload) => payload.name).join(", ") || "(no egg)",
  );
  await fs.rm(composeDir, { recursive: true, force: true }).catch(() => undefined);

  // --- nor one that lands in the post-command slack of a command that cannot
  // drive a container: the command text is the second gate. ---
  const quietId = watcher.begin("wsl echo quiet-plain-command");
  watcher.noteMarker(marker);
  spawn("cmd.exe", ["/d", "/s", "/c", `echo ${marker} > NUL & wsl echo quiet-plain-command & exit 0`], {
    stdio: "ignore",
    windowsHide: true,
  });
  await sleep(400);
  watcher.end(quietId);
  spawn("cmd.exe", ["/d", "/s", "/c", `wsl docker run -d --name absence-stray-nginx ${IMAGE}`], {
    stdio: "ignore",
    windowsHide: true,
  });
  await sleep(4_000);
  const strayCount = payloads.filter((payload) => payload.name === "absence-stray-nginx").length;
  check(
    "a container right after a non-docker command is not credited to it",
    strayCount === 0,
    `${strayCount} events`,
  );

  // --- adoption: a session opening while containers run still sees them,
  // unattributed — visible and honest, but never credited to a command. ---
  const adopted: ProcessPayload[] = [];
  const adopter = new DockerEggs(watcher, (payload) => adopted.push(payload));
  await adopter.adopt();
  const adoptedForeign = adopted.find((payload) => payload.name === "absence-foreign-nginx");
  check(
    "a session opening later adopts the running container unattributed",
    adoptedForeign !== undefined && adoptedForeign.command === undefined,
    adoptedForeign ? `command=${adoptedForeign.command ?? "(none)"}` : "(no egg)",
  );
  adopter.dispose();

  runSync(`wsl docker rm -f absence-foreign-nginx absence-stray-nginx absence-pred-nginx absence-pred-foreign > NUL 2>&1`);

  eggs.dispose();
  unsubDocker();
  unsubTap();
  watcher.stop();
  monitor.dispose();
  docker.dispose();
  finish();
}

void main();
