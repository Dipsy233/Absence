/** A content version of a file, derived from write/edit events (read02 §8–9). */
export interface FileVersion {
  version: number;
  timestamp: number;
  content: string;
  source: "write" | "edit";
}

export type FileStatus = "idle" | "reading" | "editing" | "modified";

/** The web app's view of a file the agent has touched (read02 §8). */
export interface FileView {
  path: string;
  content: string;
  language: string;
  version: number;
  status: FileStatus;
  lastRead?: { startLine: number; endLine: number };
  lastModifiedAt?: number;
  history: FileVersion[];
}
