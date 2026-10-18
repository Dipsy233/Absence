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

finish("observer decoupling checks");
