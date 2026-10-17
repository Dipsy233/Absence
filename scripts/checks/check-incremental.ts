/**
 * Offline check for the incremental state folding (no server needed).
 *
 *   npx tsx scripts/checks/check-incremental.ts
 *
 * Guards the two regressions that made the Activity / Agent Eggs counts lie at
 * scale, and the per-event cost that made them expensive:
 *
 * 1. **Eggs survive the window sliding.** `process` events are state updates;
 *    the live egg map is maintained incrementally, so a process whose *first*
 *    event was trimmed still counts. Folding the truncated stream instead used
 *    to make the count shrink.
 * 2. **History / Activity agree with a full rebuild.** The incremental memo must
 *    produce exactly what `buildHistory` / a fresh `map` would, including after
 *    a head trim rebases the run indices.
 * 3. **The cost is not O(window) per event.** Appending a token must not walk
 *    the whole window: measure the total time of a long append and assert it is
 *    in the same ballpark as the number of appended events, not their product
 *    with the window size.
 */
import { createEvent, MAX_SESSION_EVENTS, type AbsenceEvent, type AbsenceEventType } from "@absence/core";
import {
  buildHistory,
  eventsBase,
  markEventsBase,
  memoBuildHistory,
  memoRunRows,
  runEvents,
} from "../../apps/web/src/lib/history";
import { eventToActivityRow } from "../../apps/web/src/lib/events";
import { applyProcessEvent, sortEggs, type Egg } from "../../apps/web/src/lib/eggs";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sessionId = "check";
let clock = 1_700_000_000_000;

function ev<K extends AbsenceEventType>(
  type: K,
  payload: Parameters<typeof createEvent<K>>[2],
  at = (clock += 10),
): AbsenceEvent {
  const event = createEvent(sessionId, type, payload as never) as AbsenceEvent;
  (event as { timestamp: number }).timestamp = at;
  return event;
}

/** A live window with the same shape the store keeps: one array, head-trimmed. */
function makeWindow() {
  const events: AbsenceEvent[] = [];
  markEventsBase(events, 0);
  return {
    events,
    push(event: AbsenceEvent) {
      events.push(event);
      if (events.length > MAX_SESSION_EVENTS) {
        const drop = events.length - MAX_SESSION_EVENTS;
        events.splice(0, drop);
        markEventsBase(events, eventsBase(events) + drop);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Eggs are not lost when the window slides
// ---------------------------------------------------------------------------
console.log("eggs across a sliding window");
{
  const eggs = new Map<number, Egg>();
  // 120 processes laid early — more than the 100 the user reports.
  for (let pid = 1; pid <= 120; pid++) {
    applyProcessEvent(eggs, ev("process", {
      pid,
      ppid: 1,
      name: "node",
      commandLine: `node server-${pid}.js`,
      status: "running",
      startedAt: clock,
      children: 0,
      kind: "primary",
    }));
  }
  const firstCount = sortEggs(eggs).length;

  // Then a long tail of chatter that would push every egg event out of the
  // window if the eggs were re-folded from the stream.
  for (let i = 0; i < MAX_SESSION_EVENTS + 500; i++) {
    applyProcessEvent(eggs, ev("process", {
      pid: 1_000 + i,
      ppid: 1,
      name: "cat",
      commandLine: "cat x",
      status: "exited",
      startedAt: clock,
      children: 0,
      kind: "tool",
    }));
  }
  const primary = sortEggs(eggs).filter((egg) => egg.kind === "primary");
  check("all 120 primaries still present", primary.length === 120, `got ${primary.length}`);
  check("count never dropped", primary.length >= firstCount, `${firstCount} -> ${primary.length}`);

  // The old behaviour, for contrast: folding only the window would lose them.
  const window = makeWindow();
  for (let pid = 1; pid <= 120; pid++) {
    window.push(ev("process", {
      pid,
      ppid: 1,
      name: "node",
      commandLine: "node",
      status: "running",
      startedAt: clock,
      children: 0,
      kind: "primary",
    }));
  }
  for (let i = 0; i < MAX_SESSION_EVENTS + 500; i++) {
    window.push(ev("process", {
      pid: 1_000 + i,
      ppid: 1,
      name: "cat",
      commandLine: "cat",
      status: "exited",
      startedAt: clock,
      children: 0,
      kind: "tool",
    }));
  }
  const refold = new Map<number, Egg>();
  for (const event of window.events) applyProcessEvent(refold, event);
  const refoldPrimary = sortEggs(refold).filter((egg) => egg.kind === "primary").length;
  console.log(`         (re-folding the window would show ${refoldPrimary}/120 — the reported bug)`);
  check("re-fold is indeed lossy, so the incremental map is the fix", refoldPrimary < 120);
}

// ---------------------------------------------------------------------------
// 2. Incremental history / activity match a full rebuild
// ---------------------------------------------------------------------------
console.log("history + activity vs a full rebuild");
{
  const window = makeWindow();
  const prompts = 6;
  const perRun = 400;
  for (let run = 0; run < prompts; run++) {
    window.push(ev("message", { role: "user", content: `prompt ${run}`, streaming: false }));
    for (let i = 0; i < perRun; i++) {
      const kind = i % 5;
      if (kind === 0) {
        window.push(ev("file_read", { path: `src/f${i}.ts`, content: "x", startLine: 1, endLine: 1, language: "ts" }));
      } else if (kind === 1) {
        window.push(ev("command", { command: "npm test", status: "success", toolCallId: `t${run}_${i}` }));
      } else if (kind === 2) {
        window.push(ev("thinking", { content: "hmm", streaming: true }));
      } else if (kind === 3) {
        window.push(ev("message", { role: "assistant", content: "ok", streaming: false }));
      } else {
        window.push(ev("process", {
          pid: 5_000 + run * 100 + i,
          ppid: 1,
          name: "esbuild",
          commandLine: "esbuild",
          status: "running",
          startedAt: clock,
          children: 0,
          kind: "primary",
        }));
      }
    }
    window.push(ev("agent_end", { reason: "completed" }));
  }

  const incremental = memoBuildHistory(window.events);
  const full = buildHistory(window.events);
  check(
    "same number of runs",
    incremental.length === full.length,
    `${incremental.length} vs ${full.length}`,
  );
  const sameRuns = incremental.every((run, i) => {
    const other = full[i]!;
    return (
      run.id === other.id &&
      run.status === other.status &&
      run.fromIndex === other.fromIndex &&
      run.toIndex === other.toIndex &&
      JSON.stringify(run.counts) === JSON.stringify(other.counts)
    );
  });
  check("same run ranges and counts", sameRuns);

  const display = true;
  for (const run of incremental) {
    const current = memoRunRows(window.events, run, display);
    const expected = runEvents(window.events, run)
      .map(eventToActivityRow)
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    if (
      current.length !== expected.length ||
      current.some((row, i) => row.id !== expected[i]!.id || row.tone !== expected[i]!.tone)
    ) {
      check(`rows for ${run.id} match`, false, `${current.length} vs ${expected.length}`);
      break;
    }
  }
  check("activity rows match a full map", true);

  // A run entirely behind the window is gone, not mis-indexed.
  const base = eventsBase(window.events);
  check("window actually slid", base > 0, `base ${base}`);
  check(
    "all kept runs start inside the window",
    incremental.every((run) => run.fromIndex >= 0 && run.fromIndex < window.events.length),
  );
}

// ---------------------------------------------------------------------------
// 2b. Step-by-step: incremental == full at every event, through several trims
// ---------------------------------------------------------------------------
console.log("incremental vs full, event by event");
{
  const events: AbsenceEvent[] = [];
  markEventsBase(events, 0);
  const push = (event: AbsenceEvent) => {
    events.push(event);
    if (events.length > MAX_SESSION_EVENTS) {
      const drop = events.length - MAX_SESSION_EVENTS;
      events.splice(0, drop);
      markEventsBase(events, eventsBase(events) + drop);
    }
  };
  const snapshot = () => {
    const inc = memoBuildHistory(events);
    const full = buildHistory(events);
    return {
      runs: JSON.stringify(inc.map((r) => [r.id, r.index, r.status, r.fromIndex, r.toIndex, r.counts])),
      full: JSON.stringify(full.map((r) => [r.id, r.index, r.status, r.fromIndex, r.toIndex, r.counts])),
      rows: inc.map((run) => memoRunRows(events, run, true).length).join(","),
      fullRows: full.map((run) => runEvents(events, run).map(eventToActivityRow).filter(Boolean).length).join(","),
    };
  };

  let tracked = 0;
  let mismatched = 0;
  for (let run = 0; run < 8; run++) {
    push(ev("message", { role: "user", content: `p${run}`, streaming: false }));
    for (let i = 0; i < 300; i++) {
      if (i % 6 === 0) push(ev("file_write", { path: `f${run}_${i}.ts`, content: "x" }));
      else if (i % 6 === 1) push(ev("command", { command: "ls", status: "failed", toolCallId: `t${run}_${i}` }));
      else if (i % 6 === 2) push(ev("file_change", { path: `f${run}.ts`, kind: "created" }));
      else push(ev("thinking", { content: "x", streaming: true }));
      if (i % 40 === 0) {
        tracked += 1;
        const { runs, full, rows, fullRows } = snapshot();
        if (runs !== full || rows !== fullRows) mismatched += 1;
      }
    }
    push(ev("agent_end", { reason: "completed" }));
    const { runs, full } = snapshot();
    tracked += 1;
    if (runs !== full) mismatched += 1;
  }
  console.log(`         ${tracked} snapshots, window slid to base ${eventsBase(events)}`);
  check("incremental matches a full rebuild at every step", mismatched === 0, `${mismatched} mismatches`);
}

// ---------------------------------------------------------------------------
// 3. Appending is not O(window) per event
// ---------------------------------------------------------------------------
console.log("per-event cost");
{
  const window = makeWindow();
  // Fill the window with activity.
  for (let i = 0; i < MAX_SESSION_EVENTS; i++) {
    window.push(ev("thinking", { content: "x", streaming: true }));
  }
  window.push(ev("message", { role: "user", content: "go", streaming: false }));

  const appended = 500;
  const started = performance.now();
  for (let i = 0; i < appended; i++) {
    window.push(ev("thinking", { content: "token", streaming: true }));
    memoBuildHistory(window.events);
    const runs = memoBuildHistory(window.events);
    const run = runs[runs.length - 1]!;
    memoRunRows(window.events, run, false);
  }
  const ms = performance.now() - started;
  const perEvent = ms / appended;
  console.log(`         ${appended} events: ${ms.toFixed(1)} ms (${perEvent.toFixed(3)} ms/event)`);
  // O(N) per event at N=1000 would be tens of ms/event; incremental folding
  // keeps it well under a millisecond in this harness.
  check("under 1 ms per event", perEvent < 1, `${perEvent.toFixed(3)} ms`);
}

console.log("");
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
