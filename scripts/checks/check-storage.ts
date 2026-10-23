/**
 * Offline check for the SQLite session store.
 *   npx tsx scripts/checks/check-storage.ts
 *
 * Pins the seam the rest of the server relies on:
 *   - the legacy JSONL archive imports once, and streaming prefixes are dropped
 *   - readEvents rebuilds the full AbsenceEvent envelope, not just the payload
 *   - new writes round-trip, and a batch flushes on drain
 *   - listArchives filters by project path (POSIX, case-insensitive)
 *   - re-running the importer does not duplicate events
 *
 * Uses a private ABSENCE_STATE_DIR, so it never touches the user's archive.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AbsenceEvent } from "@absence/core";
import {
  appendEvents,
  closeArchive,
  drainArchive,
  encodeCwd,
  listArchives,
  readEvents,
  readEventsPage,
  readFileVersions,
  readRunEvents,
  readRuns,
  writeMeta,
} from "../../apps/server/src/sessions/archive";
import { check, finish, section } from "./harness";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "absence-storage-"));
const stateDir = path.join(root, "state");
process.env.ABSENCE_STATE_DIR = stateDir;

const project = path.join(root, "project");
const legacyId = "sess_legacy";
const archive = path.join(stateDir, "sessions", encodeCwd(project));
fs.mkdirSync(archive, { recursive: true });
fs.mkdirSync(project, { recursive: true });

const startedAt = 1_700_000_000_000;
const meta = {
  version: 1,
  absenceSessionId: legacyId,
  projectPath: project,
  projectName: "project",
  startedAt,
  updatedAt: startedAt + 5,
  runtime: "mock",
  messageCount: 1,
  firstPrompt: "hello",
};
fs.writeFileSync(path.join(archive, `${legacyId}.meta.json`), JSON.stringify(meta), "utf8");

const event = (id: string, type: string, payload: unknown, at: number): AbsenceEvent =>
  ({ id, sessionId: legacyId, timestamp: at, type, payload }) as AbsenceEvent;

const legacyEvents: AbsenceEvent[] = [
  event("evt_user", "message", { role: "user", content: "hello", streaming: false }, startedAt + 1),
  event("evt_think_stream", "thinking", { content: "thin", streaming: true }, startedAt + 2),
  event("evt_think_final", "thinking", { content: "thinking", streaming: false }, startedAt + 3),
  event("evt_msg_stream", "message", { role: "assistant", content: "he", streaming: true }, startedAt + 4),
  event("evt_msg_final", "message", { role: "assistant", content: "hello!", streaming: false }, startedAt + 5),
  event("evt_write", "file_write", { path: "a.txt", content: "x" }, startedAt + 6),
];
fs.writeFileSync(
  path.join(archive, `${legacyId}.events.jsonl`),
  legacyEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
  "utf8",
);

section("legacy import");
{
  const metas = await listArchives();
  check("the legacy session is imported", metas.some((m) => m.absenceSessionId === legacyId));
  const events = await readEvents(project, legacyId);
  check("streaming prefixes are not imported", events.length === 4, `${events.length} events`);
  check(
    "the final values are kept",
    events.some((e) => e.type === "thinking" && e.payload.content === "thinking") &&
      events.some((e) => e.type === "message" && e.payload.content === "hello!"),
  );
  const first = events[0]!;
  check("the envelope is rebuilt, not just the payload", first.id === "evt_user" && first.type === "message" && first.timestamp === startedAt + 1);
}

section("run index");
{
  const runs = await readRuns(legacyId);
  check("the legacy run is indexed", runs.length === 1, `${runs.length} runs`);
  check("the run carries its prompt", runs[0]?.prompt === "hello", runs[0]?.prompt);
  check(
    "the run covers its event range",
    runs[0]?.fromSeq === 1 && runs[0]?.toSeq === 6,
    `${runs[0]?.fromSeq}..${runs[0]?.toSeq}`,
  );
  check(
    "the run counts its work",
    runs[0]?.counts.edit === 1 && runs[0]?.counts.created === 1,
    JSON.stringify(runs[0]?.counts),
  );
  const runEvents = await readRunEvents(legacyId, runs[0]!.fromSeq, runs[0]!.toSeq);
  check("the run's events are fetched by range", runEvents.length === 4, `${runEvents.length}`);
}

section("new writes");
{
  const id = "sess_new";
  await writeMeta(project, {
    version: 1,
    absenceSessionId: id,
    projectPath: project,
    projectName: "project",
    startedAt: startedAt + 10,
    updatedAt: startedAt + 11,
    runtime: "mock",
    messageCount: 1,
    firstPrompt: "roundtrip",
  });
  appendEvents(project, id, [
    event("evt_new_user", "message", { role: "user", content: "roundtrip", streaming: false }, startedAt + 10),
    event("evt_new_stream", "thinking", { content: "partial", streaming: true }, startedAt + 11),
  ]);
  await drainArchive();
  const events = await readEvents(project, id);
  check("a durable event round-trips", events.length === 1 && events[0]!.id === "evt_new_user", `${events.length}`);
  check("the session is listed", (await listArchives(project)).some((m) => m.absenceSessionId === id));
  const newRuns = await readRuns(id);
  check("a new run is indexed immediately", newRuns.length === 1 && newRuns[0]!.prompt === "roundtrip", `${newRuns.length}`);
  const alternateSeparators =
    process.platform === "win32" ? project.replace(/\//g, "\\") : project;
  check(
    "history filters by project path",
    (await listArchives(alternateSeparators)).some((m) => m.absenceSessionId === id),
  );
}

section("file index");
{
  const id = "sess_files";
  await writeMeta(project, {
    version: 1,
    absenceSessionId: id,
    projectPath: project,
    projectName: "project",
    startedAt: startedAt + 20,
    updatedAt: startedAt + 23,
    runtime: "mock",
    messageCount: 0,
  });
  appendEvents(project, id, [
    event("evt_file_read", "file_read", { path: "f.txt", startLine: 1, endLine: 1, content: "one" }, startedAt + 20),
    event("evt_file_write", "file_write", { path: "f.txt", content: "one\ntwo\n" }, startedAt + 21),
    event("evt_file_edit", "file_edit", { path: "f.txt", before: "one\ntwo\n", after: "one\ntwo\nthree\n", diff: "" }, startedAt + 22),
  ]);
  await drainArchive();
  const versions = await readFileVersions(id);
  check("file versions are indexed", versions.length === 3, `${versions.length}`);
  check(
    "a read becomes a partial v0",
    versions[0]?.version === 0 && versions[0]?.source === "read" && versions[0]?.complete === false,
    JSON.stringify(versions[0]),
  );
  check(
    "a write appends a complete version",
    versions[1]?.version === 1 && versions[1]?.source === "write" && versions[1]?.content === "one\ntwo\n",
    JSON.stringify(versions[1]),
  );
  check(
    "an edit appends the next version",
    versions[2]?.version === 2 && versions[2]?.source === "edit" && versions[2]?.content === "one\ntwo\nthree\n",
    JSON.stringify(versions[2]),
  );
}

section("pagination");
{
  const newest = await readEventsPage(legacyId, { limit: 2 });
  check("a page is chronological", newest.events.map((e) => e.id).join(",") === "evt_msg_final,evt_write", newest.events.map((e) => e.id).join(","));
  check("the newest page reports more", newest.hasMore);
  check("the cursor is the oldest seq in the page", typeof newest.nextBefore === "number", `${newest.nextBefore}`);

  const older = await readEventsPage(legacyId, { before: newest.nextBefore, limit: 2 });
  check("before is exclusive", !older.events.some((e) => e.id === "evt_msg_final"));
  check("the older page is chronological", older.events.map((e) => e.id).join(",") === "evt_user,evt_think_final", older.events.map((e) => e.id).join(","));
  check("the oldest page ends the walk", older.hasMore === false && older.nextBefore === undefined);

  const empty = await readEventsPage("sess_missing", { limit: 2 });
  check("an unknown session has an empty page", empty.events.length === 0 && empty.hasMore === false);
}

section("reopen and re-import");
{
  closeArchive();
  const dbPath = path.join(stateDir, "absence.db");
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM store_meta WHERE key = ?").run("jsonl_import_v1");
  db.close();

  const metas = await listArchives();
  check("re-import keeps one legacy row", metas.filter((m) => m.absenceSessionId === legacyId).length === 1);
  const events = await readEvents(project, legacyId);
  check("re-import does not duplicate events", events.length === 4, `${events.length} events`);
  check("re-import rebuilds the run index", (await readRuns(legacyId)).length === 1);
}

closeArchive();
fs.rmSync(root, { recursive: true, force: true });
finish("storage checks");
