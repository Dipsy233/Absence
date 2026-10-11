/**
 * A shell write becomes a diff.
 *   npx tsx scripts/checks/check-fsdiff.ts
 *
 * Codex has no Write action: `Set-Content`, `echo > file` and `sed -i` are all
 * plain commands, so a file they change reaches Absence only as a filesystem
 * event. SessionStore closes that gap by reading the file back and emitting the
 * `file_write`/`file_edit` a first-class write tool would have sent. This check
 * drives that path against a real temp project and the mock runtime.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AbsenceEvent } from "@absence/core";
import { AbsenceSession } from "../../apps/server/src/sessions/SessionStore";
import { eventToStageItem } from "../../apps/web/src/lib/events";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`);
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "absence-fsdiff-"));
// Nest the project one level down so the FileWatcher's "outside" pass does not
// sweep the whole OS temp directory (which is busy and throws EPERM on realpath).
const dir = path.join(root, "project");
await fs.mkdir(dir, { recursive: true });

// Seed a file so the first change is a modification, not a creation.
await fs.writeFile(path.join(dir, "notes.txt"), "hello\n", "utf-8");

const session = new AbsenceSession(dir, "mock");
const events: AbsenceEvent[] = [];
session.bus.subscribe((event) => events.push(event));
await session.start();

const edits = () => events.filter((e) => e.type === "file_edit" || e.type === "file_write");

// 1. A first write to a file Absence has never seen is the whole content — it
//    cannot fabricate a "before" it does not have.
await fs.writeFile(path.join(dir, "notes.txt"), "hello\nworld\n", "utf-8");
check("a shell write reaches the stage", await waitFor(() => edits().length > 0), JSON.stringify(events.map((e) => e.type)));
const first = edits()[0] as Extract<AbsenceEvent, { type: "file_write" }> | undefined;
check("an unknown file is a file_write with the whole content", first?.type === "file_write" && first.payload.path === "notes.txt" && first.payload.content === "hello\nworld\n", JSON.stringify(first?.payload));

// 2. A second write to a file Absence now knows becomes a real diff.
const beforeCount = edits().length;
await fs.writeFile(path.join(dir, "notes.txt"), "hello\nworld\nagain\n", "utf-8");
check("a known file change reaches the stage", await waitFor(() => edits().length > beforeCount), JSON.stringify(edits().map((e) => e.type)));

const edit = edits().find((e) => e.type === "file_edit") as Extract<AbsenceEvent, { type: "file_edit" }> | undefined;
check("it is a file_edit with a path", edit?.payload.path === "notes.txt", JSON.stringify(edit?.payload?.path));
check("with the previous content as before", edit?.payload.before === "hello\nworld\n", JSON.stringify(edit?.payload?.before));
check("and the new content as after", edit?.payload.after === "hello\nworld\nagain\n", JSON.stringify(edit?.payload?.after));
check("with a unified diff", (edit?.payload.diff ?? "").includes("+again"), JSON.stringify(edit?.payload?.diff));

// The diff must render on the Stage, not just exist in the stream.
const item = edit ? eventToStageItem(edit) : undefined;
check("it becomes a DIFF stage item", item?.type === "diff" && item.payload.kind === "diff", JSON.stringify(item?.type));

// 3. A brand new file becomes a file_write (the whole content).
await fs.writeFile(path.join(dir, "1.txt"), "hi\n", "utf-8");
check(
  "a new file becomes a file_write",
  await waitFor(() => edits().some((e) => e.type === "file_write" && e.payload.path === "1.txt")),
  JSON.stringify(edits().map((e) => `${e.type}:${(e.payload as { path?: string }).path}`)),
);

// 4. No change, no event: rewriting identical content is not a diff.
const settled = edits().length;
await fs.writeFile(path.join(dir, "notes.txt"), "hello\nworld\nagain\n", "utf-8");
await new Promise((r) => setTimeout(r, 400));
check("an identical rewrite emits no diff", edits().length === settled, `${settled} → ${edits().length}`);

await session.dispose?.();
await fs.rm(root, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures === 0 ? 0 : 1);
