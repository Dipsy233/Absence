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
import fs from "node:fs/promises";
import type { DazeEvent } from "@daze/core";
import { buildHistory, pickRun, runEvents } from "../apps/web/src/lib/history";
import { createStageItem, eventToStageItem, lastStageAction } from "../apps/web/src/lib/events";
import { openKnownFile, openUserFile } from "../apps/web/src/lib/openFile";
import { useStageStore } from "../apps/web/src/stores/stageStore";
import { useSessionStore } from "../apps/web/src/stores/sessionStore";
import { useFileStore } from "../apps/web/src/stores/fileStore";
import { buildSnapshots, seek, timelineEnd, timelineStart } from "../apps/web/src/lib/replay";

const base = "http://127.0.0.1:8787";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The web app's api module uses relative URLs, which only resolve in a browser.
// Point them at the server so the real code paths can run here.
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" && input.startsWith("/") ? base + input : input;
  return nativeFetch(url as string, init);
}) as typeof fetch;

async function collect(prompts: string[]): Promise<{ events: DazeEvent[]; snapshot: any }> {
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
  return { events, snapshot: snap };
}

const assert = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const run = async () => {
  const { events, snapshot } = await collect(["first task: tidy up", "second task: look around"]);
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
  // 7. mode buttons follow what the agent has produced (not only manual opens)
  const command = events.find((e) => e.type === "command");
  const search = events.find((e) => e.type === "search");
  assert("a command maps to a terminal item", eventToStageItem(command!)?.type === "terminal");
  assert("search renders through the terminal view", eventToStageItem(search!)?.type === "terminal");

  const stage = useStageStore.getState();
  stage.reset();
  assert("no mode is available before anything happens", stage.lastByType.terminal === undefined);
  const terminalItem = eventToStageItem(command!)!;
  useStageStore.getState().noteItem(terminalItem);
  assert(
    "a live action makes its mode available",
    useStageStore.getState().lastByType.terminal?.id === terminalItem.id,
  );
  useStageStore.getState().showType("terminal");
  assert(
    "showType pins that item",
    useStageStore.getState().activeItem?.id === terminalItem.id && !useStageStore.getState().following,
  );
  useStageStore.getState().setMode("live");
  assert("LIVE resumes following", useStageStore.getState().following === true);
  useStageStore.getState().goDesk();
  assert(
    "TABLE shows the default page and stops following",
    useStageStore.getState().mode === "desk" && !useStageStore.getState().following,
    `mode=${useStageStore.getState().mode} following=${useStageStore.getState().following}`,
  );
  useStageStore.getState().setMode("live");
  assert("LIVE takes over again after TABLE", useStageStore.getState().following === true);
  useStageStore.getState().reset();

  // 8. the two FILE slots are independent, and a partial read stays partial
  const partialRead: DazeEvent = {
    id: "evt_partial_read",
    sessionId: "s",
    timestamp: Date.now(),
    type: "file_read",
    payload: {
      path: "src/auth.ts",
      startLine: 10,
      endLine: 20,
      content: "line10\nline11\nline12",
      language: "typescript",
    },
  };
  const agentItem = eventToStageItem(partialRead)!;
  assert(
    "a slice item is numbered from its start line",
    agentItem.payload.kind === "file" && agentItem.payload.lineOffset === 9,
    `lineOffset=${agentItem.payload.kind === "file" ? agentItem.payload.lineOffset : "n/a"}`,
  );
  assert(
    "a slice item highlights only what was read",
    agentItem.payload.kind === "file" && agentItem.payload.startLine === 10 && agentItem.payload.endLine === 20,
  );

  useStageStore.getState().noteItem(agentItem);
  assert("a live read fills the agent FILE slot", useStageStore.getState().agentFile?.id === agentItem.id);
  assert("a live read leaves the user FILE slot empty", useStageStore.getState().userFile === undefined);

  const userItem = createStageItem(
    "file",
    "src/auth.ts",
    { kind: "file", path: "src/auth.ts", content: "WHOLE FILE", language: "typescript", lineOffset: 0 },
    { path: "src/auth.ts" },
  );
  useStageStore.getState().openUserFile(userItem);
  assert("opening from the tree fills the user FILE slot", useStageStore.getState().userFile?.id === userItem.id);
  assert("opening from the tree keeps the agent FILE slot", useStageStore.getState().agentFile?.id === agentItem.id);
  assert(
    "the two slots hold different content",
    userItem.payload.kind === "file" &&
      agentItem.payload.kind === "file" &&
      userItem.payload.content !== agentItem.payload.content,
  );

  useStageStore.getState().showAgentFile();
  assert("right FILE shows the agent content", useStageStore.getState().activeItem?.id === agentItem.id);
  useStageStore.getState().showUserFile();
  assert("left FILE shows the whole file", useStageStore.getState().activeItem?.id === userItem.id);
  useStageStore.getState().reset();

  // 9. the user view reads the whole file from disk, never the agent's slice
  useSessionStore.setState({ session: snapshot.session });
  useStageStore.getState().noteItem(agentItem); // agent read only lines 10–20
  await openUserFile("src/auth.ts");
  const userView = useStageStore.getState().userFile;
  const truth = await fs.readFile("E:/0down/daze-demo/src/auth.ts", "utf8");
  assert(
    "left tree opens the whole file, not the read slice",
    userView?.payload.kind === "file" && userView.payload.content === truth,
    userView?.payload.kind === "file"
      ? `${userView.payload.content.length} chars shown vs ${truth.length} in the file`
      : "no file item",
  );
  assert("the user view leaves the agent slot alone", useStageStore.getState().agentFile?.id === agentItem.id);
  useStageStore.getState().reset();

  // 10. reads accumulate: the agent's context is the union of every read range
  useFileStore.getState().reset();
  const readEvent = (startLine: number, endLine: number, content: string): DazeEvent => ({
    id: `evt_read_${startLine}_${endLine}`,
    sessionId: "s",
    timestamp: Date.now(),
    type: "file_read",
    payload: { path: "src/ten.ts", startLine, endLine, content },
  });

  useFileStore.getState().ingest(readEvent(1, 2, "one\ntwo"));
  useFileStore.getState().ingest(readEvent(3, 5, "three\nfour\nfive"));
  const accumulated = useFileStore.getState().files["src/ten.ts"]!;
  assert(
    "two adjacent reads accumulate",
    accumulated.content === "one\ntwo\nthree\nfour\nfive",
    JSON.stringify(accumulated.content),
  );

  openKnownFile("src/ten.ts");
  const accumulatedView = useStageStore.getState().agentFile!;
  assert(
    "the agent view spans every read (1–5)",
    accumulatedView.payload.kind === "file" &&
      accumulatedView.payload.lineOffset === 0 &&
      accumulatedView.payload.startLine === 1 &&
      accumulatedView.payload.endLine === 5,
    accumulatedView.payload.kind === "file"
      ? `offset=${accumulatedView.payload.lineOffset} range=${accumulatedView.payload.startLine}–${accumulatedView.payload.endLine}`
      : "wrong payload",
  );

  useFileStore.getState().ingest(readEvent(8, 8, "eight"));
  openKnownFile("src/ten.ts");
  const gapView = useStageStore.getState().agentFile!;
  assert(
    "an unread line in between is marked, not silently bridged",
    gapView.payload.kind === "file" && gapView.payload.content.includes("not in the agent's context"),
    gapView.payload.kind === "file" ? JSON.stringify(gapView.payload.content) : "wrong payload",
  );
  assert(
    "a gap drops the single-range highlight",
    gapView.payload.kind === "file" && gapView.payload.startLine === undefined,
  );
  assert(
    "the gap view still reports where the knowledge starts",
    gapView.payload.kind === "file" && gapView.payload.lineOffset === 0,
  );
  useStageStore.getState().reset();
  useFileStore.getState().reset();

  // 11. every version of a file is recorded separately
  useFileStore.getState().reset();
  useFileStore.getState().ingest(readEvent(1, 2, "one\ntwo"));
  useFileStore.getState().ingest(readEvent(3, 5, "three\nfour\nfive"));
  const stamp = (n: number) => Date.now() + n;
  useFileStore.getState().ingest({
    id: "evt_w1",
    sessionId: "s",
    timestamp: stamp(1),
    type: "file_write",
    payload: { path: "src/ten.ts", content: "ONE\nTWO\nTHREE\nFOUR\nFIVE" },
  });
  useFileStore.getState().ingest({
    id: "evt_e1",
    sessionId: "s",
    timestamp: stamp(2),
    type: "file_edit",
    payload: { path: "src/ten.ts", before: "x", after: "ONE\nTWO\nTHREE\nFOUR\nFIVE\nSIX", diff: "" },
  });

  const record = useFileStore.getState().files["src/ten.ts"]!;
  assert(
    "a file records one version per state",
    record.history.map((v) => v.version).join(",") === "0,1,2",
    record.history.map((v) => `v${v.version}:${v.source}`).join(" "),
  );
  assert("v0 keeps exactly what was read", record.history[0]!.content === "one\ntwo\nthree\nfour\nfive");
  assert("v0 is marked partial", record.history[0]!.complete === false);
  assert(
    "v1 is the written file",
    record.history[1]!.source === "write" && record.history[1]!.content === "ONE\nTWO\nTHREE\nFOUR\nFIVE",
  );
  assert(
    "v2 is the edited file",
    record.history[2]!.source === "edit" && record.history[2]!.content.endsWith("SIX"),
  );
  assert(
    "the newest version mirrors the file",
    record.version === 2 && record.content === record.history[2]!.content,
  );

  openKnownFile("src/ten.ts", 0);
  const v0Item = useStageStore.getState().agentFile!;
  assert(
    "an older version can be opened",
    v0Item.payload.kind === "file" &&
      v0Item.payload.version === 0 &&
      v0Item.payload.content === "one\ntwo\nthree\nfour\nfive",
    v0Item.payload.kind === "file" ? `v${v0Item.payload.version}` : "wrong payload",
  );
  assert(
    "an older version says so",
    v0Item.payload.kind === "file" && (v0Item.payload.caption ?? "").includes("earlier version"),
    v0Item.payload.kind === "file" ? v0Item.payload.caption : "",
  );
  openKnownFile("src/ten.ts");
  const newestItem = useStageStore.getState().agentFile!;
  assert(
    "the default is the newest version",
    newestItem.payload.kind === "file" && newestItem.payload.version === 2,
  );

  useFileStore.getState().ingest(readEvent(1, 1, "ONE"));
  assert(
    "a read after a write does not roll the file back",
    useFileStore.getState().files["src/ten.ts"]!.content.endsWith("SIX"),
  );

  // 12. C counts the files created during a run
  const userMessage = (n: number, content: string): DazeEvent => ({
    id: `evt_u${n}`,
    sessionId: "s",
    timestamp: stamp(10 + n),
    type: "message",
    payload: { role: "user", content },
  });
  const agentEnd = (n: number): DazeEvent => ({
    id: `evt_end${n}`,
    sessionId: "s",
    timestamp: stamp(20 + n),
    type: "agent_end",
    payload: { reason: "completed" },
  });
  const write = (n: number, path: string): DazeEvent => ({
    id: `evt_wr${n}`,
    sessionId: "s",
    timestamp: stamp(30 + n),
    type: "file_write",
    payload: { path, content: "x" },
  });
  const readOf = (n: number, path: string): DazeEvent => ({
    id: `evt_rd${n}`,
    sessionId: "s",
    timestamp: stamp(40 + n),
    type: "file_read",
    payload: { path, startLine: 1, endLine: 1, content: "x" },
  });

  const synthetic = buildHistory([
    userMessage(1, "first"),
    readOf(1, "existing.ts"),
    write(1, "existing.ts"), // read first → not a creation
    write(2, "brand-new.ts"), // never seen → created
    agentEnd(1),
    userMessage(2, "second"),
    write(3, "another-new.ts"),
    agentEnd(2),
  ]);
  assert(
    "C counts files created in the run",
    synthetic[0]!.counts.created === 1 && synthetic[1]!.counts.created === 1,
    `run1=${synthetic[0]!.counts.created} run2=${synthetic[1]!.counts.created}`,
  );
  assert(
    "writing a file it had only read is not a creation",
    synthetic[0]!.counts.created === 1,
  );

  useStageStore.getState().reset();
  useFileStore.getState().reset();

  console.log(`\nsnapshots for run #1: ${snapshots.length}`);
  process.exit(process.exitCode ?? 0);
};

run().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
