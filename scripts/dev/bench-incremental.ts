/**
 * Timing report for the incremental event fold — not a check.
 *   npm run bench:incremental
 *
 * This asserts nothing and can never fail, so it does not belong with the
 * acceptance checks: a red/green signal is what makes a check worth having.
 * It measures the old full re-fold against the incremental path over a sliding
 * window and prints ms/event plus the speedup, so a performance regression in
 * `memoBuildHistory` / `memoRunRows` is visible when somebody looks. Its
 * correctness counterpart is `scripts/checks/check-incremental.ts`, which does
 * assert that the incremental path agrees with a full rebuild.
 */
import { createEvent, MAX_SESSION_EVENTS, type AbsenceEvent, type AbsenceEventType } from "@absence/core";
import { buildHistory, markEventsBase, memoBuildHistory, eventsBase, memoRunRows } from "../../apps/web/src/lib/history";
import { eventToActivityRow, eventToStageItem } from "../../apps/web/src/lib/events";
import { applyProcessEvent, sortEggs, type Egg } from "../../apps/web/src/lib/eggs";

let clock = 1_700_000_000_000;
function ev<K extends AbsenceEventType>(type: K, payload: unknown): AbsenceEvent {
  clock += 3;
  const e = createEvent("s", type, payload as never) as AbsenceEvent;
  (e as any).timestamp = clock;
  return e;
}
function seed() {
  const out: AbsenceEvent[] = [];
  out.push(ev("message", { role: "user", content: "go", streaming: false }));
  for (let i = 0; i < 100; i++) out.push(ev("process", { pid: i + 1, ppid: 1, name: "node", commandLine: "node", status: "running", startedAt: clock, children: 0, kind: "primary" }));
  while (out.length < MAX_SESSION_EVENTS) {
    const k = out.length % 5;
    if (k === 0) out.push(ev("file_read", { path: "a.ts", content: "x", startLine: 1, endLine: 1, language: "ts" }));
    else if (k === 1) out.push(ev("command", { command: "ls", status: "success", toolCallId: `t${out.length}` }));
    else out.push(ev("thinking", { content: "x", streaming: true }));
  }
  markEventsBase(out, 0);
  return out;
}

// OLD: rebuild everything from the truncated stream on every event.
function oldWay(events: AbsenceEvent[], display: boolean) {
  const runs = buildHistory(events);
  const run = runs[runs.length - 1];
  const shown = run ? events.slice(run.fromIndex, run.toIndex + 1) : events;
  const rows = shown.map(eventToActivityRow).filter((r) => r && (display || r.tone !== "process"));
  const byPid = new Map<number, Egg>();
  for (const e of events) applyProcessEvent(byPid, e);
  sortEggs(byPid);
  return rows;
}
// NEW: incremental.
function newWay(events: AbsenceEvent[], display: boolean) {
  const runs = memoBuildHistory(events);
  const run = runs[runs.length - 1];
  if (run) memoRunRows(events, run, display);
  return runs;
}

const events = seed();
const eggs = new Map<number, Egg>();
for (const e of events) applyProcessEvent(eggs, e);

const N = 300;
let t = performance.now();
for (let i = 0; i < N; i++) oldWay(events, false);
const oldMs = performance.now() - t;

t = performance.now();
for (let i = 0; i < N; i++) {
  const e = ev("thinking", { content: "t", streaming: true });
  events.push(e);
  if (events.length > MAX_SESSION_EVENTS) {
    const d = events.length - MAX_SESSION_EVENTS;
    events.splice(0, d);
    markEventsBase(events, eventsBase(events) + d);
  }
  newWay(events, false);
}
const newMs = performance.now() - t;

console.log(`window=${events.length} events, ${N} updates`);
console.log(`  old (full re-fold per event): ${oldMs.toFixed(1)} ms  (${(oldMs / N).toFixed(2)} ms/event)`);
console.log(`  new (incremental)           : ${newMs.toFixed(1)} ms  (${(newMs / N).toFixed(2)} ms/event)`);
console.log(`  speedup: ${(oldMs / newMs).toFixed(1)}x`);
