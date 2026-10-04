import * as api from "./api";
import { createStageItem } from "./events";
import { languageFromPath } from "./language";
import { useFileStore } from "../stores/fileStore";
import { useSessionStore } from "../stores/sessionStore";
import { useStageStore } from "../stores/stageStore";
import type { StageItem } from "../types/stage";

/**
 * Agent view: only what the agent actually has in context. If it read lines
 * 10–20 of a file, that slice is all this shows — the slice is numbered as it
 * appears in the file, so the missing head is obvious.
 */
export function openKnownFile(path: string): void {
  const file = useFileStore.getState().files[path];
  if (!file) return;

  // A file with version 0 was never written, so its content is a read slice.
  const slice = file.version === 0 && file.lastRead ? file.lastRead : undefined;
  const item = createStageItem(
    "file",
    path,
    {
      kind: "file",
      path,
      content: file.content,
      language: file.language,
      startLine: slice?.startLine,
      endLine: slice?.endLine,
      lineOffset: slice ? Math.max(0, slice.startLine - 1) : 0,
      caption: slice
        ? `Agent read lines ${slice.startLine}–${slice.endLine} — the rest of the file is not in its context`
        : "Agent-known content",
    },
    { path },
  );

  useStageStore.getState().openAgentFile(item);
}

/**
 * User view: the whole file. Files the agent has touched come from the event
 * stream; anything else is read from disk on demand.
 */
export async function openUserFile(path: string): Promise<void> {
  const known = useFileStore.getState().files[path];
  if (known) {
    useStageStore.getState().openUserFile(fullItem(path, known.content, known.language, "Whole file · user view"));
    return;
  }

  const sessionId = useSessionStore.getState().session?.id;
  if (!sessionId) return;

  try {
    const file = await api.readFile(sessionId, path);
    useStageStore
      .getState()
      .openUserFile(fullItem(path, file.content, languageFromPath(path), "Whole file · read from disk"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useStageStore.getState().openUserFile(
      createStageItem(
        "file",
        path,
        {
          kind: "file",
          path,
          content: `// ${message}`,
          language: "plaintext",
          badge: "unavailable",
          badgeTone: "warn",
          caption: "Could not read this file from disk",
        },
        { path },
      ),
    );
  }
}

function fullItem(path: string, content: string, language: string, caption: string): StageItem {
  return createStageItem(
    "file",
    path,
    { kind: "file", path, content, language, lineOffset: 0, caption },
    { path },
  );
}
