import type { DazeEvent, FileTreeNode, Plan } from "@daze/core";

/** Stage modes. `live` follows the agent; the rest are pinned views. */
export type StageMode = "live" | "desk" | "file" | "diff" | "terminal" | "replay";

export type StageItemType = "file" | "diff" | "terminal";

export type StagePayload =
  | {
      kind: "file";
      path: string;
      content: string;
      language: string;
      startLine?: number;
      endLine?: number;
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
  | { kind: "terminal"; command: string; stdout: string; stderr: string; exitCode: number };

/** One thing placed on the Stage (read02 §12). */
export interface StageItem {
  id: string;
  type: StageItemType;
  title: string;
  source?: { eventId?: string; path?: string };
  payload: StagePayload;
  createdAt: number;
  /** The originating event, kept for "+ Chat" and replay seeking. */
  event?: DazeEvent;
}

/** Desk data model (read02 §34). Visuals land in v0.3. */
export interface DeskState {
  items: DeskItem[];
  camera?: { x: number; y: number; zoom: number };
}

export interface DeskItem {
  id: string;
  type: "file" | "terminal" | "paper" | "plan" | "cursor";
  position: { x: number; y: number };
  rotation?: number;
  sourceId?: string;
}

/** A renderable activity row (read02 §18). */
export interface ActivityRow {
  id: string;
  event: DazeEvent;
  time: string;
  action: string;
  primary: string;
  secondary?: string;
  tone: "read" | "search" | "edit" | "run" | "lifecycle" | "error" | "warn";
  /** The Stage item this row opens, if any (read02 §19). */
  stageItem?: StageItem;
}

export type { FileTreeNode, Plan };
