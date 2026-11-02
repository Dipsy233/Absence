/** Where a recorded file version came from. */
export type FileVersionSource = "read" | "write" | "edit";

/**
 * One recorded state of a file as the agent knew it.
 *
 * The file index is independent of the event stream: Agent Folder and File
 * History read these records directly, and diffs compare two of them. `content`
 * is the literal text captured at that moment; a later disk change never
 * rewrites what the agent saw.
 */
export interface FileVersionInfo {
  path: string;
  version: number;
  timestamp: number;
  source: FileVersionSource;
  /** True when this version holds the whole file (a write/edit). */
  complete: boolean;
  content: string;
  /** Original line number of the first displayed line (1 = whole file). */
  lineOffset: number;
  startLine?: number;
  endLine?: number;
  /** False when no range is known; true when the agent declared one. */
  rangeKnown?: boolean;
  caption?: string;
  /** For a read version, the lines accumulated so far, keyed by file line. */
  knownLines?: Record<number, string>;
}

/**
 * A file-version row without its full content, for listings that only need to
 * show what exists (the outline of Agent Folder / File History). The full text
 * is fetched per version from GET /api/sessions/:id/file-versions/content.
 */
export interface FileVersionSummary {
  path: string;
  version: number;
  timestamp: number;
  source: FileVersionSource;
  complete: boolean;
  lineOffset: number;
  startLine?: number;
  endLine?: number;
  rangeKnown?: boolean;
  caption?: string;
  /** Stored content size in UTF-8 bytes. */
  contentBytes: number;
  /** First ~240 characters, so a list can show what the version holds. */
  preview: string;
}
