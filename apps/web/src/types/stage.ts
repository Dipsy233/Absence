import type { AbsenceEvent, ApprovalOption, FileTreeNode } from "@absence/core";

/** Stage modes. `live` follows the agent; the rest are pinned views. */
export type StageMode =
  | "live"
  | "metrics"
  | "file"
  | "diff"
  | "terminal"
  | "replay"
  | "thought"
  | "process"
  | "approval";

export type StageItemType = "file" | "diff" | "terminal" | "thought" | "process" | "approval";

export type StagePayload =
  | {
      kind: "file";
      path: string;
      content: string;
      language: string;
      /** Range to highlight, in original file coordinates. */
      startLine?: number;
      endLine?: number;
      /**
       * Original line number of the first displayed line (1 = the content is the
       * whole file from the top). A read of lines 10–20 sets this to 10 so the
       * slice is numbered as it appears in the file.
       */
      lineOffset?: number;
      /** Which recorded version of the file this is (see FileVersion). */
      version?: number;
      caption?: string;
      badge?: string;
      badgeTone?: "normal" | "warn";
    }
  | {
      kind: "diff";
      path: string;
      before: string;
      after: string;
      diff: string;
      language: string;
      emptied?: boolean;
    }
  | {
      kind: "terminal";
      command: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      /**
       * Present when this terminal is an MCP call rather than a shell command:
       * the terminal view is the right surface for "something ran, here is what
       * came back", and these fields say which server answered.
       */
      mcp?: {
        server: string;
        tool: string;
        namespace?: string;
        /** The server's structured result, as JSON text, when it sent one. */
        structured?: string;
        /** The call's arguments, for the terminal card's text/json toggle. */
        args?: string;
        /**
         * `call` while the call is in flight (a `tool_start` for an `mcp__`
         * tool), `result` once it ends.
         */
        phase?: "call" | "result";
        /** Pairing id, so the start event and the result event share one card. */
        toolCallId?: string;
        /**
         * True when this card was rebuilt from the tool start instead of a full
         * `mcp` event: the adapter never reported a result, so absence shows
         * what it has and says so rather than pretending the call produced
         * this.
         */
        pending?: boolean;
        /** Absence's honest note for a call it only saw start. */
        note?: string;
      };
    }
  /** The agent's own reasoning, streamed as it arrives. */
  | { kind: "thought"; text: string; streaming?: boolean }
  /** An OS process the agent laid (an "egg"). */
  | {
      kind: "process";
      pid: number;
      ppid: number;
      name: string;
      commandLine: string;
      status: "running" | "exited";
      children: number;
      command?: string;
      /** mtime of the state we are showing, used for the "alive for" line. */
      startedAt: number;
      exitedAt?: number;
    }
  /** The runtime asking the user for permission (Codex's approval prompts). */
  | {
      kind: "approval";
      approvalId: string;
      approvalKind: string;
      title: string;
      detail: string;
      reason?: string;
      cwd?: string;
      options: ApprovalOption[];
    };

/** One thing placed on the Stage (read02 §12). */
export interface StageItem {
  id: string;
  type: StageItemType;
  title: string;
  source?: { eventId?: string; path?: string };
  payload: StagePayload;
  createdAt: number;
  /** The originating event, kept for "+ Chat" and replay seeking. */
  event?: AbsenceEvent;
}

/** Desk data model (read02 §34). Visuals land in v0.3. */
export interface DeskState {
  items: DeskItem[];
  camera?: { x: number; y: number; zoom: number };
}

export interface DeskItem {
  id: string;
  type: "file" | "terminal" | "paper" | "cursor";
  position: { x: number; y: number };
  rotation?: number;
  sourceId?: string;
}

/** A renderable activity row (read02 §18). */
export interface ActivityRow {
  id: string;
  event: AbsenceEvent;
  time: string;
  action: string;
  primary: string;
  secondary?: string;
  tone:
    | "read"
    | "search"
    | "edit"
    | "run"
    | "lifecycle"
    | "think"
    | "process"
    | "approval"
    | "error"
    | "warn";
  /** The Stage item this row opens, if any (read02 §19). */
  stageItem?: StageItem;
}

export type { FileTreeNode };
