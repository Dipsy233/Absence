/**
 * Pure determinism checks for the Absence Report engine (no server required).
 *   npx tsx scripts/check-report.ts
 *
 * Pins the rules that are easy to get silently wrong: a failed tool emits no
 * `command` event, agent writes must not be double-counted as observed changes,
 * `created` is relative to earlier runs, and recovery must consume failures.
 */
import { check, finish } from "./harness";
import { createEvent, type AbsenceEvent } from "@absence/core";
import { buildRunFacts, renderLive, renderRun } from "../../apps/web/src/lib/report";
import type { HistoryRun } from "../../apps/web/src/types/history";



const SID = "sess_check";
const ev = <K extends AbsenceEvent["type"]>(type: K, payload: Extract<AbsenceEvent, { type: K }>["payload"]): AbsenceEvent =>
  createEvent(SID, type, payload);

let clock = 0;
function stamp<T extends AbsenceEvent>(event: T): T {
  clock += 10;
  (event as { timestamp: number }).timestamp = clock;
  return event;
}

const bashStart = (id: string, command: string) =>
  stamp(ev("tool_start", { toolCallId: id, toolName: "bash", args: { command } }));
const bashEnd = (id: string, isError = false) =>
  stamp(ev("tool_end", { toolCallId: id, toolName: "bash", isError }));
const cmd = (id: string, command: string, exitCode: number) =>
  stamp(ev("command", { command, stdout: "", stderr: "", exitCode }));

function runOf(events: AbsenceEvent[], fromIndex: number, status: HistoryRun["status"] = "completed"): HistoryRun {
  return {
    id: "run_x",
    index: 1,
    prompt: "do it",
    startedAt: events[fromIndex]!.timestamp,
    endedAt: status === "running" ? undefined : events[events.length - 1]!.timestamp,
    status,
    fromIndex,
    toIndex: events.length - 1,
    counts: { read: 0, search: 0, edit: 0, run: 0, created: 0 },
  };
}

// A. a failed bash tool emits NO `command` event — it must still count as failed.
{
  const events = [bashStart("b1", "npm test"), bashEnd("b1", true)];
  const facts = buildRunFacts(events, runOf(events, 0));
  check("failed tool without a command event counts as a failed command", facts.commands.failed === 1);
  check("failed tool has no `command` but is still detected", facts.commandFacts.length === 1);
  check("unresolved failure → outcome failed", facts.outcome === "failed");
  check("unresolved failure → attention high", facts.attention.level === "high");
  // Silencing `command_failed` never silences an unresolved failure at rest:
  // that one stays high and reports itself as `unresolved_error`.
  const silenced = buildRunFacts(events, runOf(events, 0), {
    commandFailThreshold: 1,
    commandFailLevel: "none",
  });
  check("unresolved failure stays high when command_failed is silenced", silenced.attention.level === "high");
  check(
    "and reports unresolved_error, not command_failed",
    silenced.attention.reasons.includes("unresolved_error") &&
      !silenced.attention.reasons.includes("command_failed"),
    silenced.attention.reasons.join(","),
  );
  check("report says exactly one command failed", renderRun(facts).execution.failed === 1);
}

// B. recovery consumes a failure when a later command succeeds after activity.
{
  const events = [
    bashStart("b1", "npm test"),
    bashEnd("b1"),
    cmd("b1", "npm test", 0),
    stamp(ev("file_edit", { path: "a.ts", before: "x", after: "y", diff: "+y\n-x" })),
    bashStart("b2", "npm test"),
    bashEnd("b2"),
    cmd("b2", "npm test", 1),
    bashStart("b3", "npm test"),
    bashEnd("b3"),
    cmd("b3", "npm test", 0),
  ];
  const facts = buildRunFacts(events, runOf(events, 0));
  check("three commands, one failed", facts.commands.total === 3 && facts.commands.failed === 1);
  check("the failure is recovered", facts.recoveries.length === 1);
  check("no unresolved failure", facts.errors.unresolved === 0);
  check("recovered run → completed_with_warnings", facts.outcome === "completed_with_warnings");
  // Default threshold is 5: a single recovered failure no longer raises the level.
  check("recovered run → attention none at default threshold", facts.attention.level === "none");
  check(
    "recovered run → attention low with threshold 1",
    buildRunFacts(events, runOf(events, 0), { commandFailThreshold: 1 }).attention.level === "low",
  );
  // "none" is the user's mute switch: it must silence the reason, not just its
  // level. The recovered-failure branch used to list `command_failed` anyway.
  const muted = buildRunFacts(events, runOf(events, 0), {
    commandFailThreshold: 1,
    commandFailLevel: "none",
  });
  check("recovered failure with level none → no command_failed reason", !muted.attention.reasons.includes("command_failed"));
  check("recovered failure with level none → attention none", muted.attention.level === "none");
  // A live unresolved failure at a chosen level reports that level, and the
  // reason agrees with it (it used to be "medium" while claiming a level).
  const live = renderLive(
    buildRunFacts(events, runOf(events, 0, "running"), { commandFailThreshold: 1, commandFailLevel: "medium" }),
    { busy: true },
    { commandFailThreshold: 1, commandFailLevel: "medium" },
  );
  check(
    "live unresolved failure speaks at the chosen level",
    live.attention.level === "medium" && live.attention.reasons.includes("command_failed"),
    `${live.attention.level} · ${live.attention.reasons.join(",")}`,
  );
  check("executions list the commands that ran", renderRun(facts).executions.length === 3);
}

// B3. activity stall: a run with no recent events stalls (live only, via nowMs).
{
  const events = [cmd("w1", "sleep", 0)];
  const run = runOf(events, 0, "running");
  const facts = buildRunFacts(events, run, { activityStallThreshold: 60 });
  // 120s after the last event: over a 60s threshold, live view.
  const live = renderLive(
    facts,
    { busy: true, nowMs: facts.lastActivityAt + 120_000 },
    { activityStallThreshold: 60 },
  );
  check("stall: fires past the threshold", live.attention.reasons.includes("activity_stalled"));
  check("stall: level medium by default", live.attention.level === "medium");
  check(
    "stall: details mention the gap",
    live.details.some((line) => line.includes("no activity for 2m")),
  );
  // 10s after the last event: under the threshold, silent.
  const fresh = renderLive(
    facts,
    { busy: true, nowMs: facts.lastActivityAt + 10_000 },
    { activityStallThreshold: 60 },
  );
  check("stall: fresh activity stays silent", !fresh.attention.reasons.includes("activity_stalled"));
  // Silent level keeps the reason off even past the threshold.
  const muted = renderLive(
    facts,
    { busy: true, nowMs: facts.lastActivityAt + 120_000 },
    { activityStallThreshold: 60, activityStallLevel: "none" },
  );
  check("stall: silent level keeps the reason off", !muted.attention.reasons.includes("activity_stalled"));
  // Settled runs (renderRun) never stall: no nowMs is passed.
  check("stall: settled run never stalls", !renderRun(facts).attention.reasons.includes("activity_stalled"));
}

// B2. failure streak: back-to-back failures fire the streak warning.
{
  const events = [
    bashStart("s1", "npm test"),
    bashEnd("s1"),
    cmd("s1", "npm test", 1),
    bashStart("s2", "npm test"),
    bashEnd("s2"),
    cmd("s2", "npm test", 1),
    bashStart("s3", "npm test"),
    bashEnd("s3"),
    cmd("s3", "npm test", 1),
    bashStart("s4", "npm test"),
    bashEnd("s4"),
    cmd("s4", "npm test", 0),
  ];
  // Three consecutive failures: under the default total threshold (5) but at
  // the default streak threshold (3).
  const facts = buildRunFacts(events, runOf(events, 0));
  check("streak: three failures in a row, one success", facts.commands.failed === 3);
  check("streak: count is 3", facts.failureStreak?.count === 3);
  check("streak: fires at default threshold", facts.attention.reasons.includes("command_failure_streak"));
  // The run also ends with unresolved failures (no edit between them, so no
  // recovery), which keeps the level high — the streak reason rides along.
  check(
    "streak: silent level drops the streak's own contribution",
    buildRunFacts(events, runOf(events, 0), {
      commandStreakLevel: "none",
      commandStreakThreshold: 99, // silence everything the streak would add
      commandFailLevel: "none",
      commandFailThreshold: 99,
    }).attention.level === "high" &&
      !buildRunFacts(events, runOf(events, 0), { commandStreakLevel: "none" }).attention.reasons.includes(
        "command_failure_streak",
      ),
  );
  // Two failures stay under the streak threshold: no streak reason at all.
  const two = buildRunFacts(events.slice(0, 6), runOf(events.slice(0, 6), 0));
  check("streak: two failures stay silent", !two.attention.reasons.includes("command_failure_streak"));
  // A success between failures breaks the streak.
  const broken = [
    bashStart("k1", "a"),
    bashEnd("k1"),
    cmd("k1", "a", 1),
    bashStart("k2", "b"),
    bashEnd("k2"),
    cmd("k2", "b", 0),
    bashStart("k3", "a"),
    bashEnd("k3"),
    cmd("k3", "a", 1),
    bashStart("k4", "c"),
    bashEnd("k4"),
    cmd("k4", "c", 1),
  ];
  const brokenFacts = buildRunFacts(broken, runOf(broken, 0));
  check("streak: a success breaks the streak", brokenFacts.failureStreak.count === 2);
  check(
    "streak: broken streak fires with threshold 2",
    buildRunFacts(broken, runOf(broken, 0), { commandStreakThreshold: 2 }).attention.reasons.includes(
      "command_failure_streak",
    ),
  );
  // The streak can be silenced entirely.

}

// C. observed is reconciled: agent writes are never also counted as observed.
{
  const events = [
    stamp(ev("file_write", { path: "a.ts", content: "hello\nworld" })),
    stamp(ev("file_change", { path: "a.ts", kind: "modified" })),
    stamp(ev("file_change", { path: "package-lock.json", kind: "modified" })),
  ];
  const facts = buildRunFacts(events, runOf(events, 0));
  check("agent write → created", facts.files.created.includes("a.ts"));
  check("agent's own change is not observed", !facts.files.observed.includes("a.ts"));
  check("external watcher change → observed", facts.files.observed.includes("package-lock.json"));
  check("created file adds its lines", facts.changes.additions === 2);
}

// D. `created` is relative to earlier runs (seed from events before the run).
{
  const events = [
    stamp(ev("file_read", { path: "a.ts", startLine: 1, endLine: 1, content: "x" })),
    stamp(ev("file_write", { path: "a.ts", content: "y" })),
  ];
  const facts = buildRunFacts(events, runOf(events, 1));
  check("a file read by an earlier run is modified, not created", facts.files.modified.includes("a.ts"));
  check("and is not in created", !facts.files.created.includes("a.ts"));
}

// E. phases track the compressed story (… → recovering → verifying).
{
  const events = [
    stamp(ev("file_read", { path: "a.ts", startLine: 1, endLine: 1, content: "x" })),
    stamp(ev("file_edit", { path: "a.ts", before: "x", after: "y", diff: "+y\n-x" })),
    bashStart("b1", "npm test"),
    bashEnd("b1"),
    cmd("b1", "npm test", 0),
    bashStart("b2", "npm test"),
    bashEnd("b2"),
    cmd("b2", "npm test", 1),
    stamp(ev("file_edit", { path: "a.ts", before: "y", after: "z", diff: "+z\n-y" })),
    bashStart("b3", "npm test"),
    bashEnd("b3"),
    cmd("b3", "npm test", 0),
  ];
  const facts = buildRunFacts(events, runOf(events, 0));
  check("current phase is verifying", facts.currentPhase === "verifying");
  const live = renderLive(facts, { busy: true });
  check("live headline reflects the phase", live.headline.length > 0 && live.phase === "verifying");
}

// F. `knows` captures what the agent learned: reads (merged) and searches.
{
  const events = [
    stamp(ev("file_read", { path: "a.ts", startLine: 1, endLine: 20, content: "x" })),
    stamp(ev("file_read", { path: "a.ts", startLine: 30, endLine: 40, content: "y" })),
    stamp(ev("search", { tool: "grep", query: "token", scope: "src", matches: 5, output: "" })),
  ];
  const report = renderRun(buildRunFacts(events, runOf(events, 0)));
  check("knows merges reads of the same file", report.knows.reads.length === 1);
  check(
    "knows merges to the union range",
    report.knows.reads[0]?.startLine === 1 && report.knows.reads[0]?.endLine === 40,
  );
  check("knows lists searches", report.knows.searches.length === 1 && report.knows.searches[0]?.query === "token");
}

// G. `response` is the agent's final reply for the run.
{
  const events = [
    stamp(ev("message", { role: "user", content: "do it", streaming: false })),
    stamp(ev("message", { role: "assistant", content: "partial…", streaming: true })),
    stamp(ev("message", { role: "assistant", content: "Done — I changed a.ts.", streaming: false })),
    stamp(ev("agent_end", { reason: "completed" })),
  ];
  const facts = buildRunFacts(events, runOf(events, 0));
  check("response is the final assistant message", facts.response === "Done — I changed a.ts.");
  check("report exposes the response", renderRun(facts).response === "Done — I changed a.ts.");
}

// H. the world line: one node per activity, in order, each with what it caused.
{
  const events = [
    stamp(ev("agent_start", { model: "mock/agent" })),
    stamp(ev("thinking", { content: "Looking around", streaming: true })),
    stamp(ev("thinking", { content: "Looking around the project", streaming: true })),
    stamp(ev("file_read", { path: "a.ts", startLine: 1, endLine: 20, content: "x" })),
    stamp(ev("search", { tool: "grep", query: "token", scope: "src", matches: 5, output: "" })),
    stamp(ev("file_edit", { path: "a.ts", before: "x", after: "y", diff: "+y\n-x" })),
    stamp(ev("file_write", { path: "b.ts", content: "one\ntwo" })),
    bashStart("b9", "npm test"),
    bashEnd("b9", true),
    stamp(ev("agent_end", { reason: "completed" })),
  ];
  const facts = buildRunFacts(events, runOf(events, 0));
  const timeline = facts.timeline;
  check("a streamed thought is one timeline node", timeline.filter((n) => n.kind === "think").length === 1);
  check(
    "the thought node keeps the reasoning so far",
    timeline.find((n) => n.kind === "think")?.subject === "Looking around the project",
  );
  check(
    "the timeline is in event order",
    timeline.every((n, i) => i === 0 || n.at >= timeline[i - 1]!.at),
    timeline.map((n) => n.action).join(" → "),
  );
  check(
    "a read says what entered the context",
    timeline.find((n) => n.kind === "read")?.effects[0] === "lines 1–20 into context",
  );
  check("an edit says its delta", timeline.find((n) => n.kind === "edit")?.effects[0] === "changed +1 −1 lines");
  check("a new file is a creation node", timeline.find((n) => n.kind === "write")?.action === "CREATE");
  check(
    "a failed tool is still a run node, with its failure",
    timeline.some((n) => n.kind === "run" && n.effects[0]?.startsWith("failed")),
  );
  check("every node names the event it came from", timeline.every((n) => n.eventId.length > 0));
  check("the report exposes the timeline", renderRun(facts).timeline.length === timeline.length);
}

// I. a shell tool that started and never ended is a process still running.
{
  const events = [bashStart("b1", "npm run dev")];
  const facts = buildRunFacts(events, runOf(events, 0, "running"));
  check(
    "an unfinished shell tool reads as a running process",
    facts.timeline.some((n) => n.kind === "run" && n.effects[0] === "process still running"),
  );
}

// J. eggs land on the world line, and one still running at the end gets attention.
{
  const events = [
    stamp(ev("agent_start", { model: "mock/agent" })),
    bashStart("b1", "npm run dev"),
    bashEnd("b1"),
    cmd("b1", "npm run dev", 0),
    stamp(
      ev("process", {
        pid: 4242,
        ppid: 1000,
        name: "node",
        commandLine: "node server.js",
        status: "running",
        startedAt: 1_000,
        children: 2,
        command: "npm run dev",
      }),
    ),
    stamp(ev("agent_end", { reason: "completed" })),
  ];
  const facts = buildRunFacts(events, runOf(events, 0));
  const report = renderRun(facts);
  check("a laid process is a fact", facts.processes.laid === 1 && facts.processes.runningAtEnd === 1);
  check("the report exposes it", report.processes.length === 1 && report.processesRunning === 1);

  const node = facts.timeline.find((n) => n.kind === "process");
  check("it is on the timeline as LAID", node?.action === "LAID", `got ${node?.action}`);
  check("and says what laid it", node?.effects[1] === "npm run dev", `got ${node?.effects[1]}`);
  check("with its rolled-up children", node?.effects[0] === "pid 4242 +2", `got ${node?.effects[0]}`);

  check(
    "a process left running asks for attention",
    facts.attention.reasons.includes("process_left_running"),
  );
  // An egg still alive after the conversation has ended is the loudest
  // everyday signal, so it now speaks at high, not low.
  check("and at high level", facts.attention.level === "high", `got ${facts.attention.level}`);
}

// K. an egg that exits is one egg with two moments, and no attention cry.
{
  const events = [
    stamp(
      ev("process", {
        pid: 4343,
        ppid: 1000,
        name: "esbuild",
        commandLine: "esbuild --watch",
        status: "running",
        startedAt: 1_000,
        children: 0,
      }),
    ),
    stamp(
      ev("process", {
        pid: 4343,
        ppid: 1000,
        name: "esbuild",
        commandLine: "esbuild --watch",
        status: "exited",
        startedAt: 1_000,
        exitedAt: 9_000,
        children: 0,
      }),
    ),
  ];
  const facts = buildRunFacts(events, runOf(events, 0));
  check("laid then dead is one egg", facts.processes.laid === 1 && facts.processes.runningAtEnd === 0);
  check(
    "the timeline shows both moments",
    facts.timeline.filter((n) => n.kind === "process").map((n) => n.action).join(",") === "LAID,DIED",
    facts.timeline.map((n) => n.action).join(","),
  );
  check(
    "a dead egg is not an attention reason",
    !facts.attention.reasons.includes("process_left_running"),
  );
}

// L. a file version loop: the agent writes v0's state back (v2 ≡ v0).
{
  const events = [
    stamp(ev("file_read", { path: "a.ts", startLine: 1, endLine: 2, content: "x\ny" })),
    stamp(ev("file_write", { path: "a.ts", content: "x\nCHANGED\ny" })),
    stamp(ev("file_write", { path: "a.ts", content: "x\ny" })),
  ];
  const facts = buildRunFacts(events, runOf(events, 0));
  check(
    "a write that restores the read state is a version loop",
    facts.loops.some((loop) => loop.kind === "file_version_loop" && loop.path === "a.ts"),
    JSON.stringify(facts.loops),
  );
  check("a version loop asks for attention", facts.attention.reasons.includes("file_version_loop"));
  check("at medium level", facts.attention.level === "medium", `got ${facts.attention.level}`);

  // A partial (gapped) v0 must never be compared against a full version.
  const gapped = [
    stamp(ev("file_read", { path: "b.ts", startLine: 1, endLine: 1, content: "x" })),
    stamp(ev("file_read", { path: "b.ts", startLine: 3, endLine: 3, content: "x" })),
    stamp(ev("file_write", { path: "b.ts", content: "x\nx" })),
  ];
  const gappedFacts = buildRunFacts(gapped, runOf(gapped, 0));
  check(
    "a gapped read state is never a loop baseline",
    !gappedFacts.loops.some((loop) => loop.kind === "file_version_loop"),
  );
}

// M. a command retry loop: the same command fails twice in one run.
{
  const events = [
    bashStart("b1", "npm test"),
    bashEnd("b1"),
    cmd("b1", "npm test", 1),
    stamp(ev("file_edit", { path: "a.ts", before: "x", after: "y", diff: "+y\n-x" })),
    bashStart("b2", "npm test"),
    bashEnd("b2"),
    cmd("b2", "npm test", 1),
  ];
  const facts = buildRunFacts(events, runOf(events, 0));
  const retry = facts.loops.find((loop) => loop.kind === "command_retry_loop");
  check("a twice-failed command is a retry loop", retry !== undefined && retry.count === 2);
  check("the retry loop names the command", retry?.command === "npm test");
  check("a retry loop asks for attention", facts.attention.reasons.includes("command_retry_loop"));

  // A single failure is not a loop.
  const once = [bashStart("b1", "npm test"), bashEnd("b1"), cmd("b1", "npm test", 1)];
  const onceFacts = buildRunFacts(once, runOf(once, 0));
  check("one failure is not a retry loop", !onceFacts.loops.some((loop) => loop.kind === "command_retry_loop"));
}

// N. a watcher change outside the project is a low attention fact.
{
  const events = [
    stamp(ev("file_edit", { path: "a.ts", before: "x", after: "y", diff: "+y\n-x" })),
    stamp(ev("file_change", { path: "E:/elsewhere/notes.md", kind: "modified", outside: true })),
  ];
  const facts = buildRunFacts(events, runOf(events, 0));
  const report = renderRun(facts);
  check(
    "an outside change is a fact of the run",
    facts.outsideChanges.length === 1 && facts.outsideChanges[0]?.path === "E:/elsewhere/notes.md",
  );
  check("the report exposes it", report.outsideChanges.length === 1);
  check("outside change is an attention reason", facts.attention.reasons.includes("outside_change"));
  check("but only at low level", facts.attention.level === "low", `got ${facts.attention.level}`);
  check(
    "the timeline marks it OUTSIDE",
    facts.timeline.some((n) => n.kind === "observe" && n.action === "OUTSIDE"),
    facts.timeline.map((n) => n.action).join(","),
  );
}

// O. a still-running egg outranks everything: high attention.
{
  const events = [
    bashStart("b1", "npm run dev"),
    bashEnd("b1"),
    cmd("b1", "npm run dev", 0),
    stamp(
      ev("process", {
        pid: 5001,
        ppid: 1000,
        name: "node",
        commandLine: "node server.js",
        status: "running",
        startedAt: 1_000,
        children: 0,
        command: "npm run dev",
      }),
    ),
    stamp(ev("agent_end", { reason: "completed" })),
    stamp(ev("file_change", { path: "E:/elsewhere/x.log", kind: "modified", outside: true })),
  ];
  const facts = buildRunFacts(events, runOf(events, 0));
  check(
    "high (egg) beats low (outside change)",
    facts.attention.level === "high" &&
      facts.attention.reasons.includes("process_left_running") &&
      facts.attention.reasons.includes("outside_change"),
    `got ${facts.attention.level} ${facts.attention.reasons.join(",")}`,
  );
}

{
  // MCP calls are facts about what the agent reached outside the project, so
  // the Report must count them per server — a report that only listed reads
  // and commands would call an MCP-heavy run "idle".
  const events = [
    stamp(ev("agent_start", { model: "p/m" })),
    stamp(ev("tool_start", { toolCallId: "c1", toolName: "mcp__filesystem__list_directory", args: { path: "E:/x" } })),
    stamp(
      ev("mcp", {
        server: "filesystem",
        tool: "list_directory",
        toolName: "mcp__filesystem__list_directory",
        toolCallId: "c1",
        args: '{"path":"E:/x"}',
        result: "[DIR] y",
        isError: false,
      }),
    ),
    stamp(ev("tool_end", { toolCallId: "c1", toolName: "mcp__filesystem__list_directory", isError: false })),
    stamp(
      ev("mcp", {
        server: "filesystem",
        tool: "read_text_file",
        toolName: "mcp__filesystem__read_text_file",
        toolCallId: "c2",
        args: "{}",
        result: "denied",
        isError: true,
      }),
    ),
    stamp(
      ev("mcp", {
        server: "postgres",
        tool: "query",
        toolName: "mcp__postgres__query",
        toolCallId: "c3",
        args: "{}",
        result: "1 row",
        isError: false,
      }),
    ),
    stamp(ev("agent_end", { reason: "completed" })),
  ];
  const facts = buildRunFacts(events, runOf(events, 0));
  check("mcp call count", facts.mcp.calls === 3, String(facts.mcp.calls));
  check("mcp failure count", facts.mcp.failed === 1, String(facts.mcp.failed));
  check("mcp servers are folded", Object.keys(facts.mcp.servers).length === 2);
  check(
    "tools are deduped per server",
    facts.mcp.servers.filesystem?.tools.join(",") === "list_directory,read_text_file",
    facts.mcp.servers.filesystem?.tools.join(","),
  );
  check(
    "evidence ids point at the calls",
    facts.mcp.servers.postgres?.evidence.length === 1,
  );
}

// P. every reason that used to be hard-coded now honours a configured level.
{
  // agent_stopped: a run that ended in error.
  const died = [stamp(ev("agent_start", { model: "p/m" })), stamp(ev("agent_end", { reason: "error" }))];
  const stopped = buildRunFacts(died, { ...runOf(died, 0, "error") });
  check("agent_stopped fires by default at high", stopped.attention.level === "high");
  check(
    "agent_stopped can be raised to a chosen level",
    buildRunFacts(died, { ...runOf(died, 0, "error") }, { agentStoppedLevel: "low" }).attention.level === "low",
  );
  check(
    "agent_stopped can be silenced",
    !buildRunFacts(died, { ...runOf(died, 0, "error") }, { agentStoppedLevel: "none" }).attention.reasons.includes(
      "agent_stopped",
    ),
  );

  // unresolved_error at rest: high by default, the user's level when chosen.
  const failed = [bashStart("b1", "npm test"), bashEnd("b1", true)];
  const unresolved = (options?: Parameters<typeof buildRunFacts>[2]) =>
    buildRunFacts(failed, runOf(failed, 0), { commandFailThreshold: 1, ...options });
  check("unresolved error is high by default", unresolved().attention.level === "high");
  check(
    "unresolved error takes a chosen level",
    unresolved({ unresolvedErrorLevel: "low" }).attention.level === "low",
    unresolved({ unresolvedErrorLevel: "low" }).attention.level,
  );
  check(
    "unresolved error can be silenced",
    !unresolved({ unresolvedErrorLevel: "none" }).attention.reasons.includes("unresolved_error"),
  );
}

// Q. a leftover egg: level, minimum lifetime, and the ignore list.
{
  const events = [
    bashStart("b1", "npm run dev"),
    bashEnd("b1"),
    cmd("b1", "npm run dev", 0),
    stamp(
      ev("process", {
        pid: 5001,
        ppid: 1000,
        name: "node",
        commandLine: "node server.js",
        status: "running",
        startedAt: 1_000,
        children: 0,
        command: "npm run dev",
      }),
    ),
    stamp(ev("agent_end", { reason: "completed" })),
  ];
  const run = runOf(events, 0);
  const egg = (options?: Parameters<typeof buildRunFacts>[2]) => buildRunFacts(events, run, options);

  check("leftover egg is high by default", egg().attention.level === "high");
  check(
    "leftover egg takes a chosen level",
    egg({ processLeftRunningLevel: "low" }).attention.level === "low",
  );
  check(
    "leftover egg can be silenced",
    !egg({ processLeftRunningLevel: "none" }).attention.reasons.includes("process_left_running"),
  );
  // Silencing the attention must not hide the egg itself: the fact stays.
  check(
    "a silenced leftover egg is still a fact",
    egg({ processLeftRunningLevel: "none" }).processes.runningAtEnd === 1,
  );
  // Ignore list: name, command line, and command all match, case-insensitively.
  for (const ignore of [["node"], ["SERVER.JS"], ["npm run dev"]]) {
    check(
      `ignoring ${ignore.join(",")} drops the reason`,
      !egg({ processLeftRunningIgnore: ignore }).attention.reasons.includes("process_left_running"),
    );
  }
  check(
    "an unrelated ignore entry keeps it",
    egg({ processLeftRunningIgnore: ["redis"] }).attention.reasons.includes("process_left_running"),
  );
  // Minimum lifetime: the run is 10s of stamped clock, so 60s filters it out.
  check(
    "a short-lived egg can be filtered by lifetime",
    !egg({ processLeftRunningMinSeconds: 600 }).attention.reasons.includes("process_left_running"),
  );
  check(
    "a lifetime of 0 keeps everything",
    egg({ processLeftRunningMinSeconds: 0 }).attention.reasons.includes("process_left_running"),
  );
}

// R. an outside change: level and ignore globs.
{
  const events = [
    stamp(ev("file_edit", { path: "a.ts", before: "x", after: "y", diff: "+y\n-x" })),
    stamp(ev("file_change", { path: "E:/elsewhere/notes.md", kind: "modified", outside: true })),
    stamp(ev("file_change", { path: "E:/elsewhere/debug.log", kind: "modified", outside: true })),
  ];
  const run = runOf(events, 0);
  const outside = (options?: Parameters<typeof buildRunFacts>[2]) => buildRunFacts(events, run, options);

  check("outside changes are low by default", outside().attention.level === "low");
  check(
    "outside changes take a chosen level",
    outside({ outsideChangeLevel: "medium" }).attention.level === "medium",
  );
  check(
    "outside changes can be silenced",
    !outside({ outsideChangeLevel: "none" }).attention.reasons.includes("outside_change"),
  );
  // A glob filters the reason and the fact layer's attention payload together.
  check(
    "a *.log glob drops only the log",
    outside({ outsideChangeIgnore: ["*.log"] }).outsideChanges.every((c) => !c.path.endsWith(".log")),
    outside({ outsideChangeIgnore: ["*.log"] }).outsideChanges.map((c) => c.path).join(","),
  );
  check(
    "an ignored log is still not an attention reason when it is the only change left",
    (() => {
      const onlyLog = [
        stamp(ev("file_edit", { path: "a.ts", before: "x", after: "y", diff: "+y\n-x" })),
        stamp(ev("file_change", { path: "E:/elsewhere/debug.log", kind: "modified", outside: true })),
      ];
      const facts = buildRunFacts(onlyLog, runOf(onlyLog, 0), { outsideChangeIgnore: ["*.log"] });
      return facts.outsideChanges.length === 0 && !facts.attention.reasons.includes("outside_change");
    })(),
  );
  // `**` spans folders, `*` does not.
  check(
    "a ** glob spans folders",
    outside({ outsideChangeIgnore: ["**/elsewhere/notes.md"] }).outsideChanges.every(
      (c) => !c.path.endsWith("notes.md"),
    ),
  );
  check(
    "a single * matches the file name, not the folders",
    outside({ outsideChangeIgnore: ["*notes.md"] }).outsideChanges.every((c) => !c.path.endsWith("notes.md")),
  );
}

// S. loops: the two repeat counts and their levels.
{
  const reverted = [
    stamp(ev("file_read", { path: "a.ts", startLine: 1, endLine: 1, content: "x" })),
    stamp(ev("file_write", { path: "a.ts", content: "x" })),
  ];
  const versionLoop = (options?: Parameters<typeof buildRunFacts>[2]) =>
    buildRunFacts(reverted, runOf(reverted, 0), options);
  check("a single revert loops by default", versionLoop().loops.length === 1);
  check(
    "a higher version-loop threshold defers it",
    versionLoop({ fileVersionLoopThreshold: 2 }).loops.length === 0,
  );
  check(
    "a version loop takes a chosen level",
    versionLoop({ fileVersionLoopLevel: "high" }).attention.level === "high",
  );
  check(
    "a version loop can be silenced",
    !versionLoop({ fileVersionLoopLevel: "none" }).attention.reasons.includes("file_version_loop"),
  );

  const retried = [
    bashStart("b1", "npm test"),
    bashEnd("b1"),
    cmd("b1", "npm test", 1),
    stamp(ev("file_edit", { path: "a.ts", before: "x", after: "y", diff: "+y\n-x" })),
    bashStart("b2", "npm test"),
    bashEnd("b2"),
    cmd("b2", "npm test", 1),
  ];
  const retryLoop = (options?: Parameters<typeof buildRunFacts>[2]) =>
    buildRunFacts(retried, runOf(retried, 0), options);
  check("two identical failures loop by default", retryLoop().loops.some((l) => l.kind === "command_retry_loop"));
  check(
    "a higher retry threshold defers it",
    !retryLoop({ commandRetryLoopThreshold: 3 }).loops.some((l) => l.kind === "command_retry_loop"),
  );
  // The two failures are also back-to-back (streak medium), so the retry loop
  // can only *beat* medium by going higher; its own floor is what "low" would
  // have set, which the streak already outranks.
  check(
    "a retry loop can be raised above the streak",
    retryLoop({ commandRetryLoopLevel: "high", commandStreakLevel: "none" }).attention.level === "high",
    retryLoop({ commandRetryLoopLevel: "high", commandStreakLevel: "none" }).attention.level,
  );
  check(
    "a retry loop can be silenced independently of the version loop",
    (() => {
      const facts = retryLoop({ commandRetryLoopLevel: "none" });
      return !facts.attention.reasons.includes("command_retry_loop");
    })(),
  );
}

finish();
