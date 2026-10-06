import type { DazeEvent } from "@daze/core";
import type { HistoryRun } from "../types/history";
import type {
  Attention,
  AttentionLevel,
  AttentionReason,
  CommandFact,
  FileFact,
  LiveReport,
  Phase,
  PhaseType,
  ProcessFact,
  ReadKnowledge,
  Recovery,
  RenderLiveOptions,
  RunFacts,
  RunOutcome,
  RunReport,
  SearchKnowledge,
  TimelineKind,
  TimelineNode,
} from "../types/report";
import { countDiff, eventPath, firstLine } from "./events";

/**
 * The Daze Report engine (E:\0down\daze-demo\read.md).
 *
 * Pure, deterministic reduction of a run's DazeEvents into facts, then into
 * prose. No LLM, no command parsing — it only reports what the observer saw.
 */

const SHELL_TOOLS = new Set(["bash", "powershell"]);

type PhaseSignalKind = "read" | "search" | "write" | "cmd-success" | "cmd-fail";

interface BuiltCommand extends CommandFact {
  /** Position in the run's event slice, used to require activity between a failure and its recovery. */
  sliceIndex: number;
}

interface PendingTool {
  toolName: string;
  command: string;
  at: number;
  eventId: string;
  sliceIndex: number;
}

interface WatcherChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  eventId: string;
  at: number;
}

/** An ordered, de-duplicated string set that also supports removal (deletes). */
function orderedSet() {
  const map = new Map<string, true>();
  return {
    add(path: string) {
      map.set(path, true);
    },
    delete(path: string) {
      map.delete(path);
    },
    has(path: string) {
      return map.has(path);
    },
    keys(): string[] {
      return [...map.keys()];
    },
  };
}

export function buildRunFacts(events: DazeEvent[], run: HistoryRun): RunFacts {
  const slice = events.slice(run.fromIndex, run.toIndex + 1);

  // `created` means "new here": seed with every path seen before this run so a
  // second run that writes a file an earlier run read is a modification.
  const known = new Set<string>();
  for (let i = 0; i < run.fromIndex && i < events.length; i++) {
    const path = eventPath(events[i]);
    if (path) known.add(path);
  }

  const read = orderedSet();
  const created = orderedSet();
  const modified = orderedSet();
  const deleted = orderedSet();
  const observed = orderedSet();
  const byPath = new Map<string, FileFact>();
  const file = (path: string, at: number): FileFact => {
    let fact = byPath.get(path);
    if (!fact) {
      fact = {
        path,
        firstSeenAt: at,
        lastSeenAt: at,
        read: false,
        agentWrite: false,
        agentEdit: false,
        externalChange: false,
        additions: 0,
        deletions: 0,
        evidence: [],
      };
      byPath.set(path, fact);
    }
    fact.lastSeenAt = at;
    return fact;
  };

  const watcher: WatcherChange[] = [];
  const agentChanged = new Set<string>();
  /** Whether the write at this event id created the path (vs rewrote it). */
  const writeCreated = new Map<string, boolean>();
  const evidence: string[] = [];
  const signals: { kind: PhaseSignalKind; eventId: string; at: number }[] = [];

  // What the agent learned: reads merged per path, plus every search.
  const readRanges = new Map<string, { start: number; end: number; evidence: string[] }>();
  const searches: SearchKnowledge[] = [];

  const commands: BuiltCommand[] = [];
  const openTools = new Map<string, PendingTool>();
  const unclaimedEnds: BuiltCommand[] = [];
  const errorEvidence: string[] = [];
  /** Eggs, folded per pid like the file facts: laid once, then updated. */
  const processByPid = new Map<number, ProcessFact>();

  let reads = 0;
  let edits = 0;
  let writes = 0;
  let additions = 0;
  let deletions = 0;
  /** The last non-empty assistant message — the agent's reply for the run. */
  let response: string | undefined;

  for (let i = 0; i < slice.length; i++) {
    const event = slice[i]!;
    evidence.push(event.id);

    switch (event.type) {
      case "file_read": {
        const { path, startLine, endLine } = event.payload;
        reads++;
        read.add(path);
        deleted.delete(path);
        const fact = file(path, event.timestamp);
        fact.read = true;
        fact.evidence.push(event.id);
        known.add(path);
        const range = readRanges.get(path);
        if (range) {
          range.start = Math.min(range.start, startLine);
          range.end = Math.max(range.end, endLine);
          range.evidence.push(event.id);
        } else {
          readRanges.set(path, { start: startLine, end: endLine, evidence: [event.id] });
        }
        signals.push({ kind: "read", eventId: event.id, at: event.timestamp });
        break;
      }
      case "file_write": {
        const { path, content } = event.payload;
        writes++;
        deleted.delete(path);
        agentChanged.add(path);
        const isNew = !known.has(path);
        writeCreated.set(event.id, isNew);
        if (isNew) {
          created.add(path);
          additions += lineCount(content);
        } else {
          modified.add(path);
        }
        known.add(path);
        const fact = file(path, event.timestamp);
        fact.agentWrite = true;
        fact.evidence.push(event.id);
        signals.push({ kind: "write", eventId: event.id, at: event.timestamp });
        break;
      }
      case "file_edit": {
        const { path, diff } = event.payload;
        edits++;
        deleted.delete(path);
        agentChanged.add(path);
        modified.add(path);
        known.add(path);
        const counts = countDiff(diff);
        additions += counts.added;
        deletions += counts.removed;
        const fact = file(path, event.timestamp);
        fact.agentEdit = true;
        fact.additions += counts.added;
        fact.deletions += counts.removed;
        fact.evidence.push(event.id);
        signals.push({ kind: "write", eventId: event.id, at: event.timestamp });
        break;
      }
      case "file_change":
        watcher.push({
          path: event.payload.path,
          kind: event.payload.kind,
          eventId: event.id,
          at: event.timestamp,
        });
        break;
      case "search":
        searches.push({
          tool: event.payload.tool,
          query: event.payload.query,
          scope: event.payload.scope,
          matches: event.payload.matches,
          evidence: [event.id],
        });
        signals.push({ kind: "search", eventId: event.id, at: event.timestamp });
        break;
      case "message":
        // Only the final non-empty assistant message counts as the reply; the
        // streaming updates before it are partial. System notices are not the agent.
        if (event.payload.role === "assistant" && event.payload.content.trim().length > 0) {
          response = event.payload.content;
        }
        break;
      case "error":
        errorEvidence.push(event.id);
        break;
      case "tool_start": {
        if (SHELL_TOOLS.has(event.payload.toolName)) {
          const args = (event.payload.args ?? {}) as { command?: unknown };
          openTools.set(event.payload.toolCallId, {
            toolName: event.payload.toolName,
            command: String(args.command ?? ""),
            at: event.timestamp,
            eventId: event.id,
            sliceIndex: i,
          });
        }
        break;
      }
      case "tool_end": {
        const id = event.payload.toolCallId;
        const start = openTools.get(id);
        if (!start || !SHELL_TOOLS.has(event.payload.toolName)) break;
        openTools.delete(id);
        if (event.payload.isError) {
          // A tool-level failure emits NO `command` event (PiAdapter returns
          // early), so this is the only place a failed shell command is visible.
          commands.push({
            eventId: event.id,
            toolCallId: id,
            toolName: start.toolName,
            command: start.command,
            startedAt: start.at,
            endedAt: event.timestamp,
            durationMs: event.timestamp - start.at,
            status: "failed",
            evidence: [start.eventId, event.id],
            sliceIndex: i,
          });
          signals.push({ kind: "cmd-fail", eventId: event.id, at: event.timestamp });
        } else {
          unclaimedEnds.push({
            eventId: event.id,
            toolCallId: id,
            toolName: start.toolName,
            command: start.command,
            startedAt: start.at,
            endedAt: event.timestamp,
            durationMs: event.timestamp - start.at,
            status: "unknown",
            evidence: [start.eventId, event.id],
            sliceIndex: i,
          });
        }
        break;
      }
      case "command": {
        const exitCode = event.payload.exitCode;
        const status = exitCode === 0 ? "success" : "failed";
        const end = unclaimedEnds.pop();
        commands.push(
          end
            ? {
                ...end,
                eventId: event.id,
                command: event.payload.command,
                exitCode,
                status,
                evidence: [...end.evidence, event.id],
                sliceIndex: i,
              }
            : {
                eventId: event.id,
                toolName: "shell",
                command: event.payload.command,
                exitCode,
                status,
                evidence: [event.id],
                sliceIndex: i,
              },
        );
        signals.push({ kind: status === "success" ? "cmd-success" : "cmd-fail", eventId: event.id, at: event.timestamp });
        break;
      }
      case "process": {
        const { pid, name, commandLine, command, startedAt, exitedAt, children, status, kind, kindReason } =
          event.payload;
        const fact: ProcessFact = processByPid.get(pid) ?? {
          pid,
          name,
          commandLine,
          startedAt,
          children,
          running: false,
          kind: kind ?? "primary",
          kindReason,
          evidence: [],
        };
        fact.name = name;
        fact.commandLine = commandLine;
        if (kind !== undefined) fact.kind = kind;
        if (kindReason !== undefined) fact.kindReason = kindReason;
        if (command !== undefined) fact.command = command;
        if (exitedAt !== undefined) fact.exitedAt = exitedAt;
        fact.children = children;
        fact.running = status === "running";
        fact.evidence.push(event.id);
        processByPid.set(pid, fact);
        break;
      }
      default:
        break;
    }
  }

  // A shell tool that started but never ended is still running.
  for (const [toolCallId, start] of openTools) {
    commands.push({
      eventId: start.eventId,
      toolCallId,
      toolName: start.toolName,
      command: start.command,
      startedAt: start.at,
      status: "running",
      evidence: [start.eventId],
      sliceIndex: start.sliceIndex,
    });
  }
  // A tool that ended cleanly but produced no `command` event: unknown outcome.
  for (const end of unclaimedEnds) commands.push(end);

  // Second pass: watcher changes are "observed" only when the agent did not
  // write/edit that path itself (the watcher also fires for the agent's writes).
  for (const change of watcher) {
    const fact = file(change.path, change.at);
    fact.evidence.push(change.eventId);
    if (change.kind === "deleted") {
      read.delete(change.path);
      created.delete(change.path);
      modified.delete(change.path);
      observed.delete(change.path);
      deleted.add(change.path);
      continue;
    }
    if (!agentChanged.has(change.path)) {
      observed.add(change.path);
      deleted.delete(change.path);
      fact.externalChange = true;
    }
  }

  const commandFacts: CommandFact[] = commands.map(({ sliceIndex: _sliceIndex, ...fact }) => fact);
  const counts = { total: 0, running: 0, succeeded: 0, failed: 0, unknown: 0 };
  for (const command of commands) {
    counts.total++;
    if (command.status === "running") counts.running++;
    else if (command.status === "success") counts.succeeded++;
    else if (command.status === "failed") counts.failed++;
    else counts.unknown++;
  }

  const recoveries = findRecoveries(commands, slice);
  const failedIds = commands.filter((command) => command.status === "failed").map((command) => command.eventId);
  const recoveredSet = new Set(recoveries.map((recovery) => recovery.failedCommandId));
  const unresolvedIds = failedIds.filter((id) => !recoveredSet.has(id));

  const phases = buildPhases(signals);
  const processFacts = [...processByPid.values()];
  const primaries = processFacts.filter((fact) => fact.kind === "primary");
  const runningAtEnd = primaries.filter((fact) => fact.running);
  const lastActivityAt = slice.length > 0 ? slice[slice.length - 1]!.timestamp : run.startedAt;
  const noChanges =
    created.keys().length + modified.keys().length + deleted.keys().length + observed.keys().length === 0;

  const outcome = outcomeFor(run, unresolvedIds.length, counts.failed, noChanges);
  const attention = computeAttention({
    unresolved: unresolvedIds.length,
    failed: counts.failed,
    errorCount: errorEvidence.length,
    ended: run.status !== "running",
    runError: run.status === "error",
    busy: undefined,
    unresolvedIds,
    failedIds,
    errorIds: errorEvidence,
    runningProcessIds: runningAtEnd.map((fact) => fact.evidence[0] ?? ""),
  });

  return {
    runId: run.id,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.endedAt !== undefined ? run.endedAt - run.startedAt : undefined,
    files: {
      read: read.keys(),
      created: created.keys(),
      modified: modified.keys(),
      deleted: deleted.keys(),
      observed: observed.keys(),
      byPath: Object.fromEntries(byPath),
    },
    commands: counts,
    commandFacts,
    processes: {
      laid: primaries.length,
      runningAtEnd: runningAtEnd.length,
      tools: processFacts.length - primaries.length,
      byPid: Object.fromEntries(primaries.map((fact) => [fact.pid, fact])),
    },
    errors: { total: errorEvidence.length, unresolved: unresolvedIds.length, evidence: errorEvidence },
    changes: { additions, deletions },
    counts: { reads, searches: searches.length, edits, writes },
    knowledge: {
      reads: [...readRanges.entries()].map(
        ([path, range]): ReadKnowledge => ({
          path,
          startLine: range.start,
          endLine: range.end,
          evidence: range.evidence,
        }),
      ),
      searches,
    },
    phases,
    currentPhase: phases.length > 0 ? phases[phases.length - 1]!.type : "investigating",
    recoveries,
    timeline: buildTimeline(slice, run, commandFacts, agentChanged, writeCreated),
    attention,
    outcome,
    response,
    lastActivityAt,
    evidence,
  };
}

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split("\n").length;
}

/**
 * The run as an ordered world line (read02 §12): one node per activity, in the
 * order it happened, each carrying what it caused.
 *
 * Consecutive reasoning deltas collapse into the single thought they are — Pi
 * streams a thought token by token, and a hundred nodes for one idea would not
 * be a world line. What a node "caused" is read off the stream only: a shell tool
 * that started and never ended is a process still running, but the command line
 * is never parsed to guess that it *meant* to start a service.
 */
function buildTimeline(
  slice: DazeEvent[],
  run: HistoryRun,
  commandFacts: CommandFact[],
  agentChanged: Set<string>,
  writeCreated: Map<string, boolean>,
): TimelineNode[] {
  const commandByEvent = new Map(commandFacts.map((command) => [command.eventId, command]));
  const nodes: TimelineNode[] = [];
  const push = (event: DazeEvent, kind: TimelineKind, action: string, subject: string, effects: string[]) =>
    nodes.push({
      eventId: event.id,
      kind,
      at: event.timestamp,
      offsetMs: Math.max(0, event.timestamp - run.startedAt),
      action,
      subject,
      effects,
    });

  for (const event of slice) {
    switch (event.type) {
      case "agent_start":
        push(event, "start", "START", event.payload.model, []);
        break;

      case "thinking": {
        const subject = firstLine(event.payload.content);
        const last = nodes[nodes.length - 1];
        if (last?.kind === "think") {
          // Same thought, still streaming: each delta carries the text so far.
          last.eventId = event.id;
          last.at = event.timestamp;
          last.offsetMs = Math.max(0, event.timestamp - run.startedAt);
          last.subject = subject;
        } else {
          push(event, "think", "THINK", subject, []);
        }
        break;
      }

      case "file_read": {
        const { path, startLine, endLine } = event.payload;
        push(event, "read", "READ", path, [`lines ${startLine}–${endLine} into context`]);
        break;
      }

      case "search": {
        const { tool, query, scope, matches } = event.payload;
        push(event, "search", "SEARCH", `${tool} ${query}`, [
          `${matches} hit${matches === 1 ? "" : "s"}${scope ? ` in ${scope}` : ""}`,
        ]);
        break;
      }

      case "file_edit": {
        const { added, removed } = countDiff(event.payload.diff);
        push(event, "edit", "EDIT", event.payload.path, [`changed +${added} −${removed} lines`]);
        break;
      }

      case "file_write": {
        const { path, content } = event.payload;
        const lines = lineCount(content);
        const isNew = writeCreated.get(event.id) === true;
        push(event, "write", isNew ? "CREATE" : "WRITE", path, [
          isNew ? `created ${lines} line${lines === 1 ? "" : "s"}` : `rewrote ${lines} lines`,
        ]);
        break;
      }

      case "file_change": {
        const { path, kind } = event.payload;
        push(event, "observe", kind === "deleted" ? "REMOVE" : "CHANGE", path, [
          kind === "deleted"
            ? "deleted on disk"
            : agentChanged.has(path)
              ? "the agent's write landed on disk"
              : "changed outside the agent",
        ]);
        break;
      }

      // A command is anchored on whichever event carries it: the `command` event
      // when the shell reported, the tool_start when it is still running, and the
      // tool_end when it failed (a failed tool emits no `command` event at all).
      case "tool_start":
      case "command":
      case "tool_end": {
        const command = commandByEvent.get(event.id);
        if (!command) break;
        push(event, "run", "RUN", command.command || "(shell)", [commandEffect(command)]);
        break;
      }

      // An egg on the world line: the shell command left something running, and
      // later it exited. Both moments are facts worth seeing. Helpers are not:
      // the `cat`, `grep` and `sleep` a command ran along the way would bury the
      // one daemon it started, so only primaries reach the world line.
      case "process": {
        const { kind } = event.payload;
        if (kind === "tool") break;
        const { pid, name, commandLine, command, status, children, startedAt, exitedAt } = event.payload;
        const livedSeconds = Math.max(0, Math.round(((exitedAt ?? startedAt) - startedAt) / 1000));
        push(
          event,
          "process",
          status === "running" ? "LAID" : "DIED",
          name,
          status === "running"
            ? [`pid ${pid}${children > 0 ? ` +${children}` : ""}`, command ?? commandLine]
            : [`pid ${pid}`, `exited after ${livedSeconds}s`],
        );
        break;
      }

      case "error":
        push(event, "error", "ERROR", event.payload.message, []);
        break;

      case "agent_end":
        push(event, "end", "END", event.payload.reason, []);
        break;

      default:
        break;
    }
  }

  return nodes;
}

/** What the observer can say about a command's effect, without reading it. */
function commandEffect(command: CommandFact): string {
  if (command.status === "running") return "process still running";
  if (command.status === "failed") {
    return command.exitCode !== undefined ? `failed · exit ${command.exitCode}` : "failed, no output captured";
  }
  if (command.status === "success") return `exit ${command.exitCode}`;
  return "outcome unknown";
}

function buildPhases(signals: { kind: PhaseSignalKind; eventId: string; at: number }[]): Phase[] {
  const phases: Phase[] = [];
  let current: PhaseType | undefined;
  let hadFailure = false;
  for (const signal of signals) {
    let next: PhaseType;
    switch (signal.kind) {
      case "read":
      case "search":
        next = "investigating";
        break;
      case "write":
        next = "implementing";
        break;
      case "cmd-fail":
        next = "recovering";
        hadFailure = true;
        break;
      case "cmd-success":
        next = hadFailure ? "verifying" : "executing";
        break;
      default:
        continue;
    }
    if (next !== current) {
      current = next;
      phases.push({ type: next, at: signal.at, eventId: signal.eventId });
    }
  }
  return phases;
}

/**
 * A failure is "recovered" when a later successful command follows at least one
 * intervening event (doc §22). Each success consumes at most one failure.
 */
function findRecoveries(commands: BuiltCommand[], slice: DazeEvent[]): Recovery[] {
  const recoveries: Recovery[] = [];
  const pending: number[] = [];
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index]!;
    if (command.status === "failed") {
      pending.push(index);
      continue;
    }
    if (command.status !== "success") continue;
    for (let q = pending.length - 1; q >= 0; q--) {
      const failureIndex = pending[q]!;
      const failure = commands[failureIndex]!;
      if (command.sliceIndex - failure.sliceIndex < 2) continue; // no activity between
      const between = slice.slice(failure.sliceIndex + 1, command.sliceIndex);
      recoveries.push({
        failedCommandId: failure.eventId,
        successfulCommandId: command.eventId,
        recoveryEvents: between.map((event) => event.id),
        hadEdit: between.some((event) => event.type === "file_write" || event.type === "file_edit"),
      });
      pending.splice(q, 1);
      break;
    }
  }
  return recoveries;
}

function outcomeFor(run: HistoryRun, unresolved: number, failed: number, noChanges: boolean): RunOutcome {
  if (run.status === "interrupted") return "stopped";
  if (run.status === "error") return "failed";
  if (unresolved > 0) return "failed";
  if (failed > 0) return "completed_with_warnings";
  if (noChanges) return "no_change";
  return "completed";
}

function computeAttention(input: {
  unresolved: number;
  failed: number;
  errorCount: number;
  ended: boolean;
  runError: boolean;
  busy?: boolean;
  unresolvedIds: string[];
  failedIds: string[];
  errorIds: string[];
  /**
   * Evidence for eggs the agent left running. Only a settled run reports these:
   * while the agent is working, running things is the whole point.
   */
  runningProcessIds?: string[];
}): Attention {
  const reasons: AttentionReason[] = [];
  let level: AttentionLevel = "none";
  let evidence: string[] = [];

  if (input.ended && input.runError) {
    level = "high";
    reasons.push("agent_stopped");
  }
  if (input.unresolved > 0) {
    const needsYou = input.ended || input.busy === false;
    level = needsYou ? "high" : level === "high" ? "high" : "medium";
    reasons.push(needsYou ? "unresolved_error" : "command_failed");
    // "waiting" only makes sense live — the event stream cannot say it ended there.
    if (!input.ended && input.busy === false) reasons.push("agent_waiting");
    evidence = input.unresolvedIds;
  } else if (input.failed > 0) {
    if (level === "none") level = "low";
    reasons.push("command_failed");
    evidence = input.failedIds;
  } else if (input.errorCount > 0) {
    if (level === "none") level = "medium";
    reasons.push("unresolved_error");
    evidence = input.errorIds;
  }

  const leftRunning = input.runningProcessIds ?? [];
  if (input.ended && leftRunning.length > 0) {
    if (level === "none") level = "low";
    reasons.push("process_left_running");
    evidence = [...evidence, ...leftRunning];
  }

  return { level, reasons: [...new Set(reasons)], evidence };
}

/** The live view while a run is in flight (doc §12). */
export function renderLive(facts: RunFacts, options: RenderLiveOptions = {}): LiveReport {
  const changed = facts.files.created.length + facts.files.modified.length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  let headline: string;
  let details: string[];

  switch (facts.currentPhase) {
    case "implementing":
      headline = "Agent is implementing changes.";
      details = [
        `${plural(changed, "file")} changed`,
        facts.commands.total > 0 ? `${plural(facts.commands.succeeded, "command")} completed` : "",
        facts.commands.failed > 0 ? `${facts.commands.failed} failed` : "",
      ];
      break;
    case "executing":
      headline = "Agent is running a command.";
      details = [`${plural(facts.commands.total, "command")} so far`];
      break;
    case "verifying":
      headline = "Agent is checking the result.";
      details = [`${plural(facts.commands.succeeded, "command")} succeeded`];
      break;
    case "recovering":
      headline = "A command failed.";
      details = ["Agent is continuing", facts.commands.failed > 0 ? `${facts.commands.failed} failed` : ""];
      break;
    default:
      headline = "Agent is investigating the project.";
      details = [
        `${plural(facts.counts.reads, "file")} read`,
        facts.counts.searches > 0 ? `${plural(facts.counts.searches, "search")}` : "",
        changed === 0 ? "No changes made yet" : `${plural(changed, "file")} changed`,
      ];
  }

  const failedIds = facts.commandFacts.filter((command) => command.status === "failed").map((command) => command.eventId);
  const recoveredSet = new Set(facts.recoveries.map((recovery) => recovery.failedCommandId));
  const unresolvedIds = failedIds.filter((id) => !recoveredSet.has(id));

  return {
    phase: facts.currentPhase,
    headline,
    details: details.filter(Boolean),
    progress: { filesRead: facts.counts.reads, filesChanged: changed, commands: facts.commands.total },
    attention: computeAttention({
      unresolved: unresolvedIds.length,
      failed: facts.commands.failed,
      errorCount: facts.errors.total,
      ended: false,
      runError: false,
      busy: options.busy,
      unresolvedIds,
      failedIds,
      errorIds: facts.errors.evidence,
    }),
  };
}

/** The completed view once a run has settled (doc §20). */
export function renderRun(facts: RunFacts): RunReport {
  const files = (paths: string[]) => paths.map((path) => ({ path, evidence: facts.files.byPath[path]?.evidence ?? [] }));
  const changes = {
    created: files(facts.files.created),
    modified: files(facts.files.modified),
    deleted: files(facts.files.deleted),
    observed: files(facts.files.observed),
    additions: facts.changes.additions,
    deletions: facts.changes.deletions,
  };
  const anyChange =
    changes.created.length + changes.modified.length + changes.deleted.length + changes.observed.length > 0;

  let headline: string;
  switch (facts.outcome) {
    case "failed":
      headline = "Agent stopped with unresolved errors.";
      break;
    case "stopped":
      headline = "Agent stopped before finishing.";
      break;
    case "no_change":
      headline = "No project changes were made.";
      break;
    case "completed_with_warnings":
      headline = "Agent completed, with warnings.";
      break;
    default:
      headline =
        facts.recoveries.length > 0
          ? "Agent completed after recovering from an error."
          : anyChange
            ? "Agent completed with project changes."
            : "Agent completed the run.";
  }

  return {
    runId: facts.runId,
    durationMs: facts.durationMs ?? 0,
    outcome: facts.outcome,
    headline,
    knows: facts.knowledge,
    changes,
    executions: facts.commandFacts,
    execution: {
      commands: facts.commands.total,
      succeeded: facts.commands.succeeded,
      failed: facts.commands.failed,
      unknown: facts.commands.unknown,
    },
    processes: Object.values(facts.processes.byPid).sort((a, b) => a.startedAt - b.startedAt),
    processesRunning: facts.processes.runningAtEnd,
    recoveries: facts.recoveries,
    attention: facts.attention,
    timeline: facts.timeline,
    response: facts.response,
    evidence: facts.evidence,
  };
}
