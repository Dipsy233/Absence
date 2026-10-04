/** Explicit Chat context the user attaches (read02 §30). Chat never guesses. */
export interface ChatContext {
  type: "file" | "selection" | "event" | "diff";
  path?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  eventId?: string;
  /** Human-readable label for the chip. */
  label: string;
}
