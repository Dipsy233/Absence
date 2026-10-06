import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DazeEvent } from "@daze/core";

/**
 * DAZE's own session archive (read.md §26). Pi keeps the model's conversation;
 * this keeps what *DAZE observed* — the DazeEvent stream — so a resumed session
 * gets its Stage, Activity, files and chat back. Plain files, no database:
 *
 *   ~/.daze/sessions/<encoded-cwd>/<id>.meta.json     one header per session
 *   ~/.daze/sessions/<encoded-cwd>/<id>.events.jsonl  one DazeEvent per line
 *
 * Override the root with DAZE_STATE_DIR.
 */
function stateRoot(): string {
  return process.env.DAZE_STATE_DIR ?? path.join(os.homedir(), ".daze");
}

export function encodeCwd(cwd: string): string {
  const slug = cwd.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "root";
}

export function archiveDir(cwd: string): string {
  return path.join(stateRoot(), "sessions", encodeCwd(cwd));
}

export function metaFile(cwd: string, id: string): string {
  return path.join(archiveDir(cwd), `${id}.meta.json`);
}

export function eventsFile(cwd: string, id: string): string {
  return path.join(archiveDir(cwd), `${id}.events.jsonl`);
}

/** Header describing a DAZE session archive. */
export interface ArchiveMeta {
  version: 1;
  dazeSessionId: string;
  projectPath: string;
  projectName: string;
  startedAt: number;
  updatedAt: number;
  model?: string;
  runtime: string;
  /** Pi's session file, when the session ran on the Pi runtime. */
  piSessionFile?: string;
  piSessionId?: string;
  messageCount: number;
  firstPrompt?: string;
}

export async function readMeta(cwd: string, id: string): Promise<ArchiveMeta | undefined> {
  try {
    const meta = JSON.parse(await fs.readFile(metaFile(cwd, id), "utf8")) as ArchiveMeta;
    return meta?.dazeSessionId ? meta : undefined;
  } catch {
    return undefined;
  }
}

export async function writeMeta(cwd: string, meta: ArchiveMeta): Promise<void> {
  try {
    await fs.mkdir(archiveDir(cwd), { recursive: true });
    await fs.writeFile(metaFile(cwd, meta.dazeSessionId), JSON.stringify(meta), "utf8");
  } catch {
    // Archiving is best-effort; a failed write must never break a session.
  }
}

/** Serialized appender: one queue per archive file, so lines never interleave. */
const queues = new Map<string, Promise<void>>();

export function appendEvents(cwd: string, id: string, events: DazeEvent[]): void {
  if (events.length === 0) return;
  const file = eventsFile(cwd, id);
  const text = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous
    .then(() => fs.mkdir(path.dirname(file), { recursive: true }))
    .then(() => fs.appendFile(file, text, "utf8"))
    .catch(() => undefined)
    .then(() => undefined);
  queues.set(file, next);
}

/** Wait for pending appends (used on dispose and by tests). */
export async function drainArchive(): Promise<void> {
  await Promise.all([...queues.values()]);
}

export async function readEvents(cwd: string, id: string): Promise<DazeEvent[]> {
  let text: string;
  try {
    text = await fs.readFile(eventsFile(cwd, id), "utf8");
  } catch {
    return [];
  }
  const events: DazeEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as DazeEvent;
      if (event && typeof event.type === "string") events.push(event);
    } catch {
      // Skip a torn line (e.g. a crash mid-write).
    }
  }
  return events;
}

/** Every archive header for a project, or for all projects when cwd is omitted. */
export async function listArchives(cwd?: string): Promise<ArchiveMeta[]> {
  const root = path.join(stateRoot(), "sessions");
  const dirs = cwd ? [archiveDir(cwd)] : await listDirs(root);
  const metas: ArchiveMeta[] = [];
  for (const dir of dirs) {
    for (const name of await listFiles(dir)) {
      if (!name.endsWith(".meta.json")) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as ArchiveMeta;
        if (meta?.dazeSessionId) metas.push(meta);
      } catch {
        // Ignore unreadable archives.
      }
    }
  }
  return metas;
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
