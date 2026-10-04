import * as api from "./api";
import { createStageItem } from "./events";
import { languageFromPath } from "./language";
import { useFileStore } from "../stores/fileStore";
import { useSessionStore } from "../stores/sessionStore";
import { useStageStore } from "../stores/stageStore";
import type { StageItem } from "../types/stage";

/**
 * Agent view: only what the agent actually has in context. If it read lines
 * 10–20 of a file, that slice is all this shows — numbered as it appears in the
 * file, so the missing head is obvious.
 */
export function openKnownFile(path: string): void {
  const file = useFileStore.getState().files[path];
  if (!file) return;

  const item = createStageItem("file", path, { kind: "file", path, ...knownContent(file) }, { path });
  useStageStore.getState().openAgentFile(item);
}

/**
 * User view: the whole file, always read from disk. The event stream only ever
 * holds what the agent read, so using it here would show a read slice as if it
 * were the file.
 */
export async function openUserFile(path: string): Promise<void> {
  const sessionId = useSessionStore.getState().session?.id;
  let failure = "no session";

  if (sessionId) {
    try {
      const file = await api.readFile(sessionId, path);
      useStageStore
        .getState()
        .openUserFile(
          createStageItem(
            "file",
            path,
            { kind: "file", path, content: file.content, language: languageFromPath(path), lineOffset: 0, caption: "Whole file · read from disk" },
            { path },
          ),
        );
      return;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  // The disk refused (binary, too large, …). Show what the agent knows instead,
  // clearly marked as partial so it is not mistaken for the whole file.
  const known = useFileStore.getState().files[path];
  if (known) {
    useStageStore.getState().openUserFile(
      createStageItem(
        "file",
        path,
        {
          kind: "file",
          path,
          ...knownContent(known),
          badge: "partial",
          badgeTone: "warn",
          caption: `Whole file unavailable (${failure}) — showing the agent-known content`,
        },
        { path },
      ),
    );
    return;
  }

  useStageStore.getState().openUserFile(
    createStageItem(
      "file",
      path,
      {
        kind: "file",
        path,
        content: `// ${failure}`,
        language: "plaintext",
        lineOffset: 0,
        badge: "unavailable",
        badgeTone: "warn",
        caption: "Could not read this file from disk",
      },
      { path },
    ),
  );
}

function knownContent(file: { content: string; language: string; version: number; lastRead?: { startLine: number; endLine: number } }) {
  // A file with version 0 was never written, so its content is a read slice.
  const slice = file.version === 0 && file.lastRead ? file.lastRead : undefined;
  return {
    content: file.content,
    language: file.language,
    startLine: slice?.startLine,
    endLine: slice?.endLine,
    lineOffset: slice ? Math.max(0, slice.startLine - 1) : 0,
    caption: slice
      ? `Agent read lines ${slice.startLine}–${slice.endLine} — the rest of the file is not in its context`
      : "Agent-known content",
  } satisfies Partial<Extract<StageItem["payload"], { kind: "file" }>>;
}
