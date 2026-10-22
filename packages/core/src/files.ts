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
  caption?: string;
  /** For a read version, the lines accumulated so far, keyed by file line. */
  knownLines?: Record<number, string>;
}
