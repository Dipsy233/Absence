import * as api from "./api";
import { createStageItem } from "./events";
import { languageFromPath } from "./language";
import { useFileStore } from "../stores/fileStore";
import { useSessionStore } from "../stores/sessionStore";
import { useStageStore } from "../stores/stageStore";

function fileItem(
  path: string,
  content: string,
  language: string,
  extra: { startLine?: number; endLine?: number; caption?: string; badge?: string; badgeTone?: "normal" | "warn" },
) {
  return createStageItem("file", path, { kind: "file", path, content, language, ...extra }, { path });
}

/** Agent view: show the content the agent has in context. */
export function openKnownFile(path: string): void {
  const file = useFileStore.getState().files[path];
  if (!file) return;
  useStageStore.getState().openStage(
    fileItem(path, file.content, file.language, {
      startLine: file.lastRead?.startLine,
      endLine: file.lastRead?.endLine,
      caption: "Agent-known content",
    }),
  );
}

/**
 * User view: show the whole file. Files the agent has touched come from the
 * event stream; anything else is read from disk on demand.
 */
export async function openUserFile(path: string): Promise<void> {
  const known = useFileStore.getState().files[path];
  if (known) {
    useStageStore.getState().openStage(
      fileItem(path, known.content, known.language, {
        startLine: known.lastRead?.startLine,
        endLine: known.lastRead?.endLine,
        caption: "Agent-known content",
      }),
    );
    return;
  }

  const sessionId = useSessionStore.getState().session?.id;
  if (!sessionId) return;

  try {
    const file = await api.readFile(sessionId, path);
    useStageStore.getState().openStage(
      fileItem(path, file.content, languageFromPath(path), { caption: "Read from disk · user view" }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useStageStore.getState().openStage(
      fileItem(path, `// ${message}`, "plaintext", {
        badge: "unavailable",
        badgeTone: "warn",
        caption: "Could not read this file from disk",
      }),
    );
  }
}
