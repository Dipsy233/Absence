/**
 * One state of a file as the agent knew it (read02 §8–9).
 *
 * Versions are *recorded*, not derived: v0 accumulates whatever the agent read,
 * and every write/edit appends a new version. `content` is the literal text
 * captured at that moment, so later changes on disk can never rewrite what the
 * agent actually had in context.
 */
import type { FileVersionInfo } from "@absence/core";

/**
 * The web's view of one recorded version.
 *
 * The fields are the shared `FileVersionInfo` contract (packages/core) minus
 * the two only the persisted file index carries (`path` — the web view keeps it
 * on the FileView, and `knownLines` — an archive-read concern). Deriving from
 * the contract keeps the live view from drifting from what Agent Folder reads
 * off disk.
 */
export type FileVersion = Omit<FileVersionInfo, "path" | "knownLines">;

export type FileStatus = "idle" | "reading" | "editing" | "modified";

/** The web app's view of a file the agent has touched (read02 §8). */
export interface FileView {
  path: string;
  language: string;
  status: FileStatus;
  /** Every version the agent has seen, oldest first (v0 … vN). */
  history: FileVersion[];
  /** Accumulator for the current read-only version. */
  knownLines: Record<number, string>;
  lastRead?: { startLine: number; endLine: number; rangeKnown?: false };
  /** Sticky for the read accumulation: any unreported range makes it unknown. */
  rangeKnown?: false;
  lastModifiedAt?: number;

  /** Convenience mirrors of the newest version. */
  content: string;
  version: number;
  complete: boolean;
}
