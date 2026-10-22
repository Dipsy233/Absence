import os from "node:os";
import path from "node:path";

/**
 * Where the pre-SQLite archive lives:
 *
 *   ~/.absence/sessions/<encoded-cwd>/<id>.meta.json
 *   ~/.absence/sessions/<encoded-cwd>/<id>.events.jsonl
 *
 * Kept in its own module because both the SQLite store (for the one-time
 * import) and `archive.ts` (which still exposes these paths) need it, and
 * importing them from each other would make the storage layer circular.
 */
export function stateRoot(): string {
  return process.env.ABSENCE_STATE_DIR ?? path.join(os.homedir(), ".absence");
}

export function sessionsRoot(): string {
  return path.join(stateRoot(), "sessions");
}

export function encodeCwd(cwd: string): string {
  const slug = cwd.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "root";
}

export function archiveDir(cwd: string): string {
  return path.join(sessionsRoot(), encodeCwd(cwd));
}

export function metaFile(cwd: string, id: string): string {
  return path.join(archiveDir(cwd), `${id}.meta.json`);
}

export function eventsFile(cwd: string, id: string): string {
  return path.join(archiveDir(cwd), `${id}.events.jsonl`);
}
