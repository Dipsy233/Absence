/**
 * One state of a file as the agent knew it (read02 §8–9).
 *
 * Versions are *recorded*, not derived: v0 accumulates whatever the agent read,
 * and every write/edit appends a new version. `content` is the literal text
 * captured at that moment, so later changes on disk can never rewrite what the
 * agent actually had in context.
 */
export interface FileVersion {
  version: number;
  timestamp: number;
  source: "read" | "write" | "edit";
  /** Display-ready content captured at this version. */
  content: string;
  /** True when this version holds the whole file. */
  complete: boolean;
  /** Original line number of the first displayed line (1 = whole file). */
  lineOffset: number;
  /** Highlight range, in original file coordinates. */
  startLine?: number;
  endLine?: number;
  caption?: string;
}

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
  lastRead?: { startLine: number; endLine: number };
  lastModifiedAt?: number;

  /** Convenience mirrors of the newest version. */
  content: string;
  version: number;
  complete: boolean;
}
