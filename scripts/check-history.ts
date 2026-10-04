/**
 * Offline check of the History / Replay logic using real events from a live
 * mock session (needs the DAZE server running).
 *
 *   npx tsx scripts/check-history.ts
 *
 * Verifies: run grouping, per-run activity scoping, deterministic stage item
 * ids (a random id used to freeze the replay Stage), snapshot seek determinism,
 * and that seeking anywhere in a run still shows an action.
 */
import type { DazeEvent } from "@daze/core";
import { buildHistory, pickRun, runEvents } from "../apps/web/src/lib/history";
import { eventToStageItem, lastStageAction } from "../apps/web/src/lib/events";
import { buildSnapshots, seek, timelineEnd, timelineStart } from "../apps/web/src/lib/replay";

const base = "http://127.0.0.1:8787";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function collect(prompts: string[]): Promise<DazeEvent[]> {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(base + "/api/projects")).ok) break;
    } catch {}
    await wait(500);
  }

  const snap = await (
    await fetch(base + "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: "E:/0down/daze-demo", agent: "mock" }),
    })
  ).json();
  const id = snap.session.id;

  const ws = new WebSocket(`ws://127.0.0.1:8787/ws/sessions/${id}`);
  const events: DazeEvent[] = [];
  ws.addEventListener("message", (raw: MessageEvent) => {
    const m = JSON.parse(String(raw.data));
    if (m.type === "event") events.push(m.event);
  });
  await new Promise((r) => ws.addEventListener("open", r));

  for (const prompt of prompts) {
    const before = events.length;
    await fetch(base + `/api/sessions/${id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await wait(500);
      if (events.slice(before).some((e) => e.type === "agent_end")) break;
    }
    await wait(400);
  }
  ws.close();
  return events;
}

const assert = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const run = async () => {
  const events = await collect(["first task: tidy up", "second task: look around"]);
  console.log(`collected ${events.length} events\n`);

  // 1. history runs
  const runs = buildHistory(events);
  console.log("--- history runs ---");
  for (const r of runs) {
    console.log(
      `  #${r.index}  ${r.status.padEnd(11)} ${String(r.prompt).slice(0, 34).padEnd(34)}` +
        `  events[${r.fromIndex}..${r.toIndex}]  R${r.counts.read} S${r.counts.search} E${r.counts.edit} $${r.counts.run}`,
    );
  }
  assert("two prompts produce two runs", runs.length === 2, `got ${runs.length}`);
  assert("runs are completed", runs.every((r) => r.status === "completed"));
  assert(
    "runs do not overlap",
    runs.every((r, i) => i === 0 || r.fromIndex > runs[i - 1]!.toIndex),
  );

  // 2. activity filter is scoped to a run
  const first = runs[0]!;
  const second = runs[1]!;
  const firstEvents = runEvents(events, first);
  const secondEvents = runEvents(events, second);
  assert(
    "run events are disjoint",
    !firstEvents.some((e) => secondEvents.includes(e)),
    `run1=${firstEvents.length} run2=${secondEvents.length}`,
  );
  assert("pickRun falls back to newest", pickRun(runs, undefined)?.id === second.id);
  assert("pickRun honours selection", pickRun(runs, first.id)?.id === first.id);

  // 3. stable stage item ids (this is what froze the replay)
  const action = firstEvents.find((e) => e.type === "file_read")!;
  const a = eventToStageItem(action)!;
  const b = eventToStageItem(action)!;
  assert("event-derived item id is deterministic", a.id === b.id && a.id === action.id, `id=${a.id}`);

  // 4. seek is deterministic and actually moves through the run
  const snapshots = buildSnapshots(firstEvents);
  const start = timelineStart(firstEvents);
  const end = timelineEnd(firstEvents);
  const at = (f: number) => seek(firstEvents, snapshots, start + f * (end - start));
  const ids = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const view = at(f);
    return view.currentAction ? eventToStageItem(view.currentAction)!.id : "none";
  });
  console.log("\n--- seek through run #1 ---");
  console.log("  distinct action ids:", new Set(ids).size, ids.map((v) => v.slice(-6)).join(" -> "));
  assert("seek yields more than one action (playback moves)", new Set(ids).size > 1, `got ${new Set(ids).size}`);
  const twice = [at(0.5).currentAction?.id, at(0.5).currentAction?.id];
  assert("seek is deterministic", twice[0] === twice[1]);

  // 5. seeking past the last action still shows it (snapshots carry the action)
  const STAGE = ["file_read", "file_write", "file_edit", "command", "search"];
  const lastAction = [...firstEvents].reverse().find((e) => STAGE.includes(e.type));
  assert(
    "seek to the end of the run still shows the last action",
    at(1).currentAction?.id === lastAction?.id,
    `end=${at(1).currentAction?.type ?? "none"} expected=${lastAction?.type}`,
  );
  assert(
    "every seek position has an action once the run has started",
    [0.2, 0.4, 0.6, 0.8, 1].every((f) => at(f).currentAction !== undefined),
  );

  // 6. the Stage returns to its default page when a run ends
  assert(
    "a finished run leaves the Stage on the default page",
    lastStageAction(firstEvents) === undefined,
    `got ${lastStageAction(firstEvents)?.type ?? "undefined"}`,
  );
  assert(
    "an in-flight run still shows its last action",
    lastStageAction(firstEvents.slice(0, -1)) !== undefined,
    `got ${lastStageAction(firstEvents.slice(0, -1))?.type ?? "undefined"}`,
  );
  const justStarted = [events[0]!];
  assert("a brand new run shows the default page", lastStageAction(justStarted) === undefined);
  assert(
    "the whole session (last run finished) shows the default page",
    lastStageAction(events) === undefined,
  );

  // 5. file state is reconstructed
  const mid = at(1);
  assert("run reconstruction produced files", Object.keys(mid.files).length > 0, Object.keys(mid.files).join(", "));
  console.log(`\nsnapshots for run #1: ${snapshots.length}`);
  process.exit(process.exitCode ?? 0);
};

run().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
