import * as api from "./api";
import { createStageItem } from "./events";
import { languageFromPath } from "./language";
import { useFileStore } from "../stores/fileStore";
import { useSessionStore } from "../stores/sessionStore";
import { useStageStore } from "../stores/stageStore";
import type { FileVersion, FileView } from "../types/file";
import type { StageItem } from "../types/stage";

type FilePayload = Extract<StageItem["payload"], { kind: "file" }>;

function payloadFor(file: FileView, entry: FileVersion, latestVersion: number): FilePayload {
  const parts = [`v${entry.version}`, entry.source];
  if (!entry.complete && entry.caption) parts.push(entry.caption);
  if (entry.version !== latestVersion) parts.push("earlier version");
  return {
    kind: "file",
    path: file.path,
    content: entry.content,
    language: file.language,
    startLine: entry.startLine,
    endLine: entry.endLine,
    lineOffset: entry.lineOffset,
    version: entry.version,
    caption: parts.join(" · "),
  };
}

/**
 * Agent view: a recorded version of the file — only what the agent had in
 * context. Defaults to the newest version.
 *
 * The item is built here and *returned*, not opened: a face that shows files
 * in its own windows (Rounds) reads the same construction without touching
 * the Stage. `openKnownFile` is the Stage-facing wrapper.
 */
export function knownFileItem(path: string, version?: number): StageItem | undefined {
  const file = useFileStore.getState().files[path];
  if (!file || file.history.length === 0) return undefined;

  const latestVersion = file.history[file.history.length - 1]!.version;
  const entry = version !== undefined ? file.history.find((v) => v.version === version) : file.history.at(-1);
  if (!entry) return undefined;

  return createStageItem("file", path, payloadFor(file, entry, latestVersion), { path });
}

export function openKnownFile(path: string, version?: number): void {
  const item = knownFileItem(path, version);
  if (item) useStageStore.getState().openAgentFile(item);
}

/**
 * User view: the whole file, always read from disk. The recorded versions only
 * hold what the agent saw, so using them here would show a slice as the file.
 */
export async function userFileItem(path: string): Promise<StageItem> {
  const sessionId = useSessionStore.getState().session?.id;
  let failure = "no session";

  if (sessionId) {
    try {
      const file = await api.readFile(sessionId, path);
      return createStageItem(
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
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  // The disk refused (binary, too large, …). Show the newest recorded version
  // instead, clearly marked as partial so it is not mistaken for the file.
  const known = useFileStore.getState().files[path];
  const entry = known?.history.at(-1);
  if (known && entry) {
    return createStageItem(
      "file",
      path,
      {
        ...payloadFor(known, entry, entry.version),
        badge: entry.complete ? undefined : "partial",
        badgeTone: entry.complete ? undefined : "warn",
        caption: `Whole file unavailable (${failure}) — showing the agent-known content (v${entry.version})`,
      },
      { path },
    );
  }

  return createStageItem(
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
  );
}

export async function openUserFile(path: string): Promise<void> {
  useStageStore.getState().openUserFile(await userFileItem(path));
}
