import * as api from "./api";
import { createStageItem } from "./events";
import { languageFromPath } from "./language";
import { contiguousRanges, describeRanges } from "./knownLines";
import { useFileStore } from "../stores/fileStore";
import { useSessionStore } from "../stores/sessionStore";
import { useStageStore } from "../stores/stageStore";
import type { FileView } from "../types/file";
import type { StageItem } from "../types/stage";

/**
 * Payload for the agent's view of a file: exactly what is in its context.
 * Reads accumulate, so two reads of 1–2 and 3–5 yield lines 1–5; lines it never
 * read are shown as explicit markers so the numbering stays true to the file.
 */
function knownPayload(file: FileView): Extract<StageItem["payload"], { kind: "file" }> {
  const base = { kind: "file" as const, path: file.path, content: file.content, language: file.language };

  if (file.complete) {
    return { ...base, lineOffset: 0, caption: "Agent-known content · whole file" };
  }

  const ranges = contiguousRanges(Object.keys(file.knownLines).map(Number));
  if (ranges.length === 0) {
    return { ...base, lineOffset: 0, caption: "Agent-known content" };
  }

  const first = ranges[0]!.start;
  const last = ranges[ranges.length - 1]!.end;
  const contiguous = ranges.length === 1;
  return {
    ...base,
    startLine: contiguous ? first : undefined,
    endLine: contiguous ? last : undefined,
    lineOffset: first - 1,
    caption: contiguous
      ? `Agent has lines ${first}–${last} of this file`
      : `Agent has lines ${describeRanges(ranges)} — the gaps are not in its context`,
  };
}

/** Agent view: only what the agent actually has in context. */
export function openKnownFile(path: string): void {
  const file = useFileStore.getState().files[path];
  if (!file) return;
  useStageStore
    .getState()
    .openAgentFile(createStageItem("file", path, knownPayload(file), { path }));
}

/**
 * User view: the whole file, always read from disk. The event stream only ever
 * holds what the agent read, so using it here would show a slice as the file.
 */
export async function openUserFile(path: string): Promise<void> {
  const sessionId = useSessionStore.getState().session?.id;
  let failure = "no session";

  if (sessionId) {
    try {
      const file = await api.readFile(sessionId, path);
      useStageStore.getState().openUserFile(
        createStageItem(
          "file",
          path,
          {
            kind: "file",
            path,
            content: file.content,
            language: languageFromPath(path),
            lineOffset: 0,
            caption: "Whole file · read from disk",
          },
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
          ...knownPayload(known),
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
