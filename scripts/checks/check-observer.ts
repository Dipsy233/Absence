/**
 * Offline check of the decoupling contract (no server, no agent needed).
 *
 *   npx tsx scripts/checks/check-observer.ts
 *
 * docs/decoupling.md states one standard for whether Absence is an observer or
 * a client:
 *
 *   > Delete apps/server/src/agents/ entirely — does `absence watch` still work?
 *
 * This check answers the testable part of that question without deleting files:
 *
 * 1. **Observation needs no adapter.** A session model that declares itself
 *    `observe` reports `canDriveSession() === false`; a runtime reports true; an
 *    older server that omits `source` is treated as driven (never a regression in
 *    the field).
 * 2. **The registry is the only door.** Nothing is registered until the shipped
 *    adapters are imported — the registry does not import them. That is what
 *    makes "delete the directory" work: the application boots without it.
 * 3. **The CLI's watch parser is standalone.** `--pid`, `--project`, `--label`
 *    and the pass-through `-- command` form parse without starting anything.
 * 4. **The web treats an observed session differently from a driven one.** The
 *    one predicate the UI uses is `useIsObserved`; its rule is checked here at
 *    the value level (a UI hook needs React, its contract does not).
 */
import { canDriveSession, createEvent, type SessionSource } from "@absence/core";
import { buildAdapter, hasAdapter, registeredRuntimes } from "../../apps/server/src/agents/registry";
import { parseWatchArgs } from "../../apps/server/src/cliArgs";
import { check, finish, section } from "./harness";

section("source: observing and driving are different sessions");
{
  const driven: SessionSource = { kind: "runtime", runtime: "pi" };
  const observed: SessionSource = { kind: "observe", targetPid: 4242, label: "pi" };
  check("a driven session can be driven", canDriveSession(driven));
  check("an observed session cannot", !canDriveSession(observed));
  check("an older server (no source) is driven", canDriveSession(undefined));
  check(
    "the observed source carries the pid the watcher roots at",
    observed.kind === "observe" && observed.targetPid === 4242,
  );
  check(
    "the observed source names what is watched, not which runtime it embeds",
    observed.kind === "observe" && observed.label === "pi" && !("runtime" in observed),
  );
}

section("registry: importing the application does not import the adapters");
{
  // Nothing has imported agents/createAdapter in this process: the four shipped
  // runtimes must therefore be absent. If this ever fails, some module in the
  // observe path has pulled the adapters back in — which is exactly the coupling
  // that makes deleting apps/server/src/agents impossible.
  check("no adapter is registered on a bare import", registeredRuntimes().length === 0, registeredRuntimes().join(","));
  check("pi is not registered here", !hasAdapter("pi"));
  check("an unknown runtime yields no adapter instead of throwing", buildAdapter("pi", { tools: [] }) === undefined);
}

section("cli: `absence watch` parses on its own");
{
  const byPid = parseWatchArgs(["--pid", "1234", "--project", ".", "--label", "pi"]);
  check("a pid is accepted", byPid.pid === 1234, String(byPid.pid));
  check("the label is accepted", byPid.label === "pi", byPid.label);
  check("the project is resolved", byPid.projectPath.length > 0);

  const byCommand = parseWatchArgs(["--project", ".", "--", "pi", "do", "the thing"]);
  check("a command after -- is captured", byCommand.command?.join(" ") === "pi do the thing", byCommand.command?.join(" "));
  check("no pid when a command is given", byCommand.pid === undefined);

  let rejected = false;
  try {
    parseWatchArgs(["--pid", "not-a-number"]);
  } catch {
    rejected = true;
  }
  check("a bad pid is rejected", rejected);

  let unknownRejected = false;
  try {
    parseWatchArgs(["--nope"]);
  } catch {
    unknownRejected = true;
  }
  check("an unknown option is rejected", unknownRejected);
}

section("events: an observed session's rows come from the OS, not a runtime");
{
  // The only event kinds an observe session can produce are process and file
  // changes; both already have Activity rows, and a process row is what tells a
  // person what the agent is running.
  const processEvent = createEvent("sess_obs", "process", {
    pid: 100,
    ppid: 90,
    name: "esbuild",
    commandLine: "esbuild --watch",
    status: "running",
    startedAt: Date.now(),
    children: 2,
    kind: "primary",
  } as never);
  check("a process event is a first-class event", processEvent.type === "process");

  const fileChange = createEvent("sess_obs", "file_change", { path: "src/app.ts", kind: "modified" } as never);
  check("a file change is a first-class event", fileChange.type === "file_change");
}


// ---------------------------------------------------------------------------
// 5. Observe-mode process attribution, driven through a fake process table.
//    This is the part that makes an observed agent's work visible at all, and
//    the part that is easy to get wrong: the first version reported every
//    process on the machine.
// ---------------------------------------------------------------------------
section("observe mode: only the observed tree is reported");
{
  const { ProcessWatcher } = await import("../../apps/server/src/process/ProcessWatcher");
  type ProcInfo = { pid: number; ppid: number; name: string; commandLine: string; startedAt: number };
  const table = new Map<number, ProcInfo>();
  const put = (pid: number, ppid: number, name: string) =>
    table.set(pid, { pid, ppid, name, commandLine: name, startedAt: Date.now() });

  // The agent (100) already exists with a child (101) when Absence attaches.
  put(1, 0, "services.exe");
  put(2, 1, "unrelated-app.exe");
  put(50, 1, "terminal.exe");
  put(100, 50, "pi");
  put(101, 100, "old-child");
  // And a sibling underneath the terminal that has nothing to do with the agent.
  put(102, 50, "other-shell");

  const seen: { pid: number; name: string; status: string }[] = [];
  const watcher = new ProcessWatcher({
    rootPid: 100,
    snapshot: async () => new Map(table),
    onProcess: (payload) => seen.push({ pid: payload.pid, name: payload.name, status: payload.status }),
    maxFinishedEggs: 10,
  });
  watcher.warm();
  await new Promise((resolve) => setTimeout(resolve, 50));
  check("nothing pre-existing is reported", seen.length === 0, String(seen.length));

  // The agent now starts a server (103), which starts its own child (104).
  put(103, 100, "npm");
  put(104, 103, "node");
  await new Promise((resolve) => setTimeout(resolve, 1600));
  check("a new child of the agent is reported", seen.some((egg) => egg.pid === 103), JSON.stringify(seen));
  check("its own child is folded in, not reported twice", !seen.some((egg) => egg.pid === 104));

  // An unrelated app starts a process: never ours.
  put(105, 2, "unrelated-child.exe");
  await new Promise((resolve) => setTimeout(resolve, 1600));
  check("a sibling app's child is ignored", !seen.some((egg) => egg.pid === 105));

  watcher.stop();
}


// ---------------------------------------------------------------------------
// 6. Runs: an observed stream has no prompts, but History / Replay / the Report
//    are all built out of runs. The run boundary has to come from the agent's
//    own activity, and a driven runtime must keep its exact old behaviour.
// ---------------------------------------------------------------------------
section("runs: an observed stream still forms runs");
{
  const { buildHistory, isObservedStream } = await import("../../apps/web/src/lib/history");
  const proc = (offset: number, pid: number) =>
    createEvent("sess_obs", "process", {
      pid,
      ppid: 1,
      name: "node",
      commandLine: "node",
      status: "running",
      startedAt: Date.now() + offset,
      children: 0,
      kind: "primary",
    } as never);

  const observedEvents = [proc(0, 10), proc(10, 11), proc(20, 12)];
  check("an observed stream is recognised", isObservedStream(observedEvents));
  const observedRuns = buildHistory(observedEvents);
  check("an observed stream forms one run", observedRuns.length === 1, String(observedRuns.length));
  check("the run opens at its first event", observedRuns[0]?.fromIndex === 0, String(observedRuns[0]?.fromIndex));
  check("it reads as running", observedRuns[0]?.status === "running", observedRuns[0]?.status);

  // A driven runtime is unchanged: no prompt, no run.
  const start = createEvent("sess_drv", "agent_start", { model: "pi" } as never);
  const driven = [start, proc(10, 20)];
  check("a driven stream is not mistaken for observed", !isObservedStream(driven));
  check("a driven run still needs a prompt", buildHistory(driven).length === 0);
}


// ---------------------------------------------------------------------------
// 7. Watch-with-a-command: the server must be up before the agent is spawned.
//
// On Windows the observer is a Job Object on the server, so only processes the
// server creates *after* the job is assigned are in it. Spawning the agent first
// would silently fall back to sampling — correct output, the slow path — and
// nothing in the output would say so. This pins the ordering, and the two other
// facts that make kernel events usable for an observed root.
// ---------------------------------------------------------------------------
section("observe mode rides on kernel events when Absence started the agent");
{
  const { ProcessWatcher } = await import("../../apps/server/src/process/ProcessWatcher");
  type ProcInfo = { pid: number; ppid: number; name: string; commandLine: string; startedAt: number };
  const self = process.pid;

  const makeTable = (rows: [number, number, string][]) => {
    const table = new Map<number, ProcInfo>();
    for (const [pid, ppid, name] of rows) {
      table.set(pid, { pid, ppid, name, commandLine: name, startedAt: Date.now() });
    }
    return table;
  };

  // A descendant of ours: ours → agent → its future children.
  {
    const table = makeTable([
      [self, 1, "node"],
      [9001, self, "pi"],
    ]);
    const seen: number[] = [];
    const watcher = new ProcessWatcher({
      rootPid: 9001,
      snapshot: async () => new Map(table),
      onProcess: (payload) => seen.push(payload.pid),
    });
    watcher.warm();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const inJob = (watcher as unknown as { observedInJob: boolean }).observedInJob;
    check("an agent Absence started is recognised as ours", inJob === true);
    // Nothing is sampled: the kernel will report the tree.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    check("and nothing is reported by sampling", seen.length === 0, String(seen.length));
    watcher.stop();
  }

  // Somebody else's process: not ours, so sampling takes over.
  {
    const table = makeTable([
      [self, 1, "node"],
      [9100, 1, "explorer.exe"],
      [9101, 9100, "pi"],
    ]);
    const watcher = new ProcessWatcher({
      rootPid: 9101,
      snapshot: async () => new Map(table),
      onProcess: () => undefined,
    });
    watcher.warm();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const inJob = (watcher as unknown as { observedInJob: boolean }).observedInJob;
    check("an agent started elsewhere is not ours", inJob === false);
    check("so it falls back to sampling", (watcher as unknown as { jobMode: boolean }).jobMode === false);
    watcher.stop();
  }
}


// ---------------------------------------------------------------------------
// 8. The terminal mirror: a copy of the agent's output that cannot hurt it.
//
// Layer 1 of docs/decoupling.md. Three promises, each of which is easy to break
// and impossible to notice until something else fails:
//   · a burst becomes few messages, not one per write
//   · the buffer is bounded, so a long session cannot grow it without limit
//   · a late subscriber is handed the tail instead of a blank screen
// ---------------------------------------------------------------------------
section("terminal mirror: bounded, coalesced, replayable");
{
  const { TerminalMirror } = await import("../../apps/server/src/sessions/TerminalMirror");
  const mirror = new TerminalMirror();
  const frames: string[] = [];
  mirror.subscribe((chunk) => frames.push(chunk));

  // A redraw: many small writes in one tick must arrive as one message.
  for (let i = 0; i < 50; i++) mirror.push(`\rframe ${i}`);
  check("a burst is coalesced, not one message per write", frames.length === 0, `${frames.length} early`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  check("and then flushed as a single frame", frames.length === 1, `${frames.length} frames`);

  const tail = mirror.tail();
  const late: string[] = [];
  mirror.subscribe((chunk) => late.push(chunk));
  check("a late subscriber is handed the tail", late.join("") === tail, `${late.length} chunks`);

  // Flood: the ring must stay bounded and report what it dropped.
  for (let i = 0; i < 20_000; i++) mirror.push("x".repeat(100) + "\n");
  check("the buffer stays bounded", mirror.tail().length <= 256 * 1024, String(mirror.tail().length));
  check("and counts what it dropped", mirror.droppedBytes > 0, String(mirror.droppedBytes));

  mirror.end();
  check("end() marks it finished", mirror.finished === true);
  mirror.dispose();
}


// ---------------------------------------------------------------------------
// 9. Commands come from the OS, not from a shell shim.
//
// docs/decoupling.md Layer 0: a process is created carrying its full command
// line, so "what did the agent run" needs no configuration and no knowledge of
// which agent it was. This is what replaces a per-agent shell shim for almost
// every case, so the shapes that occur in practice are pinned here.
// ---------------------------------------------------------------------------
section("commands are read off the command line");
{
  const { detectCommand } = await import("../../apps/server/src/process/CodexShell");
  const BS = String.fromCharCode(92);
  const Q = String.fromCharCode(34);
  const cmd = (line: string) => `C:${BS}WINDOWS${BS}system32${BS}cmd.exe ${line}`;

  check(
    "bash -lc wraps the command",
    detectCommand("bash.exe", `bash -lc ${Q}npm test${Q}`).command === "npm test",
  );
  check(
    "bash.exe is a POSIX shell too (Git Bash on Windows)",
    detectCommand("bash.exe", `bash.exe -lc ${Q}npm run build${Q}`).wrapped === true,
  );
  check(
    "cmd /c wraps the command",
    detectCommand("cmd.exe", cmd(`/s /c ${Q}npm run dev${Q}`)).command === "npm run dev",
  );
  // Codex's PowerShell wrapper carries a UTF-8 preamble before the command;
  // stripping it is what makes the reported text the model's own command.
  const preamble = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}";
  check(
    "PowerShell -Command wraps it, preamble stripped",
    detectCommand(
      "pwsh.exe",
      `pwsh.exe -NoProfile -Command ${Q}${preamble}${String.fromCharCode(10)}node x.mjs${Q}`,
    ).command === "node x.mjs",
  );
  // Windows nests wrappers: `execSync('cmd /c \"X\"')` spawns an outer cmd.exe
  // whose line is `cmd.exe /d /s /c \"cmd /c \"X\"\"`.
  check(
    "nested wrappers are peeled to the command",
    detectCommand("cmd.exe", cmd(`/d /s /c ${Q}cmd /c ${Q}echo hi${Q}${Q}`)).command === "echo hi",
  );

  // Not every shell is a command.
  check("a bare shell is not a command", detectCommand("bash.exe", "bash").wrapped === false);
  check("a program is not a command", detectCommand("node.exe", "node app.js").wrapped === false);
}

// ---------------------------------------------------------------------------
// 10. A `.cmd` wrapper puts the real agent below the observed root.
//
// `absence watch -- pi` on Windows spawns `pi.cmd`, whose pid is `cmd.exe` and
// whose child is the actual agent (`node.exe`). The agent's own tool processes
// are then *grandchildren* of the pid Absence was given, so attribution that
// only accepted direct children saw nothing at all — the session produced zero
// process events while the agent ran commands in plain sight.
//
// Verified against a real Pi run: `bash.exe -lc "ls"` under the agent is now
// reported with `command: "ls"`.
// ---------------------------------------------------------------------------
section("observe mode: a wrapper level below the root is still the agent's tree");
{
  const { ProcessWatcher } = await import("../../apps/server/src/process/ProcessWatcher");
  type ProcInfo = { pid: number; ppid: number; name: string; commandLine: string; startedAt: number };
  const self = process.pid;

  const table = new Map<number, ProcInfo>();
  const put = (pid: number, ppid: number, name: string, commandLine = name) =>
    table.set(pid, { pid, ppid, name, commandLine, startedAt: Date.now() });

  put(self, 1, "node");
  // The root Absence was handed is the wrapper; the agent is its child.
  put(7000, self, "cmd.exe");
  put(7001, 7000, "node.exe");

  const eggs: { pid: number; name: string; command: string }[] = [];
  const watcher = new ProcessWatcher({
    rootPid: 7000,
    snapshot: async () => new Map(table),
    onProcess: (payload) => eggs.push({ pid: payload.pid, name: payload.name, command: payload.command ?? "" }),
  });
  watcher.warm();
  await new Promise((resolve) => setTimeout(resolve, 80));

  // Now the agent runs a command: bash under the agent, two levels below the root.
  put(7002, 7001, "bash.exe", 'bash.exe -lc "ls"');
  // Drive the discovery the same way the kernel would: the job path checks
  // `jobSeen`, which `warm` seeded from the table.
  const internal = watcher as unknown as {
    onJobStart(event: unknown): void;
  };
  internal.onJobStart({
    pid: 7002,
    ppid: 7001,
    commandLine: 'bash.exe -lc "ls"',
    exePath: process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe" : "/bin/bash",
  });
  check("a grandchild of the observed root is reported", eggs.some((egg) => egg.pid === 7002), JSON.stringify(eggs));
  check(
    "and its command is the one that ran, not the wrapper",
    eggs.find((egg) => egg.pid === 7002)?.command === "ls",
    eggs.find((egg) => egg.pid === 7002)?.command,
  );
  watcher.stop();
}
