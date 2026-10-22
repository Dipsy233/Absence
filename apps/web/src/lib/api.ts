import type {
  CommandOption,
  Project,
  SessionEventPage,
  SessionHistoryEntry,
  SessionSnapshot,
} from "@absence/core";

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // The server returns { error } on failure; show that message verbatim
    // (e.g. a runtime that is not installed) instead of a raw status line.
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (parsed && typeof parsed.error === "string" && parsed.error.trim()) message = parsed.error;
      else if (text.trim()) message = `${message} ${text}`.trim();
    } catch {
      if (text.trim()) message = `${message} ${text}`.trim();
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export type RuntimeKind = "pi" | "codex" | "dsh" | "mock";

/** One agent runtime and whether it can start right now (GET /api/runtimes). */
export interface RuntimeStatus {
  kind: RuntimeKind;
  label: string;
  available: boolean;
  configurable: boolean;
  path?: string;
  note: string;
}

export async function fetchRuntimes(): Promise<RuntimeStatus[]> {
  const { runtimes } = await json<{ runtimes: RuntimeStatus[] }>(await fetch("/api/runtimes"));
  return runtimes;
}

/** Save codex / dsh binary paths; an empty string clears the override. */
export async function saveRuntimePaths(patch: {
  piBin?: string;
  codexBin?: string;
  dshBin?: string;
}): Promise<RuntimeStatus[]> {
  const { runtimes } = await json<{ runtimes: RuntimeStatus[] }>(
    await fetch("/api/runtimes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
  return runtimes;
}

export async function fetchProjects(root?: string): Promise<Project[]> {
  const query = root ? `?root=${encodeURIComponent(root)}` : "";
  return json<Project[]>(await fetch(`/api/projects${query}`));
}

/** What to reopen when resuming a persisted session. */
export interface ResumeTarget {
  absenceSessionId?: string;
  piSessionFile?: string;
  piSessionId?: string;
}

export async function createSession(
  projectPath: string,
  agent?: "pi" | "codex" | "dsh" | "mock",
  resume?: ResumeTarget,
): Promise<SessionSnapshot> {
  return json<SessionSnapshot>(
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath, agent, resume }),
    }),
  );
}

export async function getSession(id: string): Promise<SessionSnapshot> {
  return json<SessionSnapshot>(await fetch(`/api/sessions/${id}`));
}

/** The persisted history (ABSENCE archives + Pi sessions), newest first. */
export async function fetchSessionHistory(path?: string): Promise<SessionHistoryEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return json<SessionHistoryEntry[]>(await fetch(`/api/sessions/history${query}`));
}

/**
 * One page of persisted events, oldest → newest. Omit `before` for the newest
 * page; pass the previous page's `nextBefore` to walk backwards.
 */
export async function fetchSessionEventPage(
  sessionId: string,
  options: { before?: number; limit?: number } = {},
): Promise<SessionEventPage> {
  const params = new URLSearchParams();
  if (options.before !== undefined) params.set("before", String(options.before));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  return json<SessionEventPage>(
    await fetch(`/api/sessions/${sessionId}/events${query ? `?${query}` : ""}`),
  );
}

export async function sendPrompt(id: string, prompt: string): Promise<void> {
  await json(
    await fetch(`/api/sessions/${id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }),
  );
}

export async function abortSession(id: string): Promise<void> {
  await json(await fetch(`/api/sessions/${id}/abort`, { method: "POST" }));
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
}

/** Read a project file from disk (the user's view of the project). */
export async function readFile(sessionId: string, path: string): Promise<FileContent> {
  return json<FileContent>(
    await fetch(`/api/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`),
  );
}

/** Options for a chat command that needs a choice (e.g. the models for /model). */
export async function fetchCommandOptions(sessionId: string, name: string): Promise<CommandOption[]> {
  const data = await json<{ options: CommandOption[] }>(
    await fetch(`/api/sessions/${sessionId}/commands/${encodeURIComponent(name)}/options`),
  );
  return data.options;
}

/** Run a chat command; its output arrives over the socket as a system message. */
export async function runCommand(sessionId: string, name: string, args: string): Promise<void> {
  await json(
    await fetch(`/api/sessions/${sessionId}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    }),
  );
}

/** Answer an approval prompt the agent raised; unblocks the runtime request. */
export async function respondApproval(sessionId: string, id: string, value: string): Promise<void> {
  await json(
    await fetch(`/api/sessions/${sessionId}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, value }),
    }),
  );
}

/* ── Agent Eggs filter profiles (server-side named files) ───────────────── */

export interface EggFilterProfileMeta {
  name: string;
  savedAt: number;
  count: number;
}

export interface EggFilterState {
  dir: string;
  active: string;
  /** True when the active profile overrides even "named by the command". */
  force: boolean;
  profiles: EggFilterProfileMeta[];
  current: string[];
}

export interface EggFilterSaveResponse {
  ok: boolean;
  active: string;
  profile: EggFilterProfileMeta & { names: string[] };
}

export async function fetchEggFilter(): Promise<EggFilterState> {
  return json<EggFilterState>(await fetch("/api/egg-filter"));
}

/** Save a profile: same name overwrites, a new name creates. Activates it. */
export async function saveEggFilter(
  name: string,
  names: string[],
  force: boolean,
): Promise<EggFilterSaveResponse> {
  return json<EggFilterSaveResponse>(
    await fetch(`/api/egg-filter/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names, force }),
    }),
  );
}

export async function activateEggFilter(name: string): Promise<{ active: string; current: string[] }> {
  return json(
    await fetch(`/api/egg-filter/${encodeURIComponent(name)}/activate`, { method: "POST" }),
  );
}

export async function deleteEggFilter(name: string): Promise<void> {
  await json(await fetch(`/api/egg-filter/${encodeURIComponent(name)}`, { method: "DELETE" }));
}

/* ── Avatar skins (user-uploaded animation files) ─────────────────────────── */

export interface AvatarSkinMeta {
  name: string;
  /** Status → stored file name. */
  files: Partial<Record<string, string>>;
  complete: boolean;
}

export interface AvatarSkinState {
  dir: string;
  active: string;
  builtin: string;
  skins: AvatarSkinMeta[];
  activeFiles: Partial<Record<string, string>>;
}

export async function fetchAvatarSkins(): Promise<AvatarSkinState> {
  return json<AvatarSkinState>(await fetch("/api/avatar-skins"));
}

export async function createAvatarSkin(name: string): Promise<void> {
  await json(await fetch(`/api/avatar-skins/${encodeURIComponent(name)}`, { method: "POST" }));
}

export async function uploadAvatarSkinFile(
  name: string,
  status: string,
  file: File,
): Promise<void> {
  const query = `status=${encodeURIComponent(status)}&filename=${encodeURIComponent(file.name)}`;
  await json(
    await fetch(`/api/avatar-skins/${encodeURIComponent(name)}/files?${query}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    }),
  );
}

export async function deleteAvatarSkinFile(name: string, status: string): Promise<void> {
  await json(
    await fetch(`/api/avatar-skins/${encodeURIComponent(name)}/files/${encodeURIComponent(status)}`, {
      method: "DELETE",
    }),
  );
}

export async function deleteAvatarSkin(name: string): Promise<void> {
  await json(await fetch(`/api/avatar-skins/${encodeURIComponent(name)}`, { method: "DELETE" }));
}

export async function activateAvatarSkin(name: string): Promise<{ active: string }> {
  return json(
    await fetch(`/api/avatar-skins/${encodeURIComponent(name)}/activate`, { method: "POST" }),
  );
}

/* ── Sound sets (user-uploaded chimes) ────────────────────────────────────── */

export interface SoundSetMeta {
  name: string;
  /** Event → stored file name. */
  files: Partial<Record<string, string>>;
  complete: boolean;
}

export interface SoundSetState {
  dir: string;
  active: string;
  builtin: string;
  sets: SoundSetMeta[];
  activeFiles: Partial<Record<string, string>>;
}

export async function fetchSounds(): Promise<SoundSetState> {
  return json<SoundSetState>(await fetch("/api/sounds"));
}

export async function createSoundSet(name: string): Promise<void> {
  await json(await fetch(`/api/sounds/${encodeURIComponent(name)}`, { method: "POST" }));
}

export async function uploadSoundFile(name: string, event: string, file: File): Promise<void> {
  const query = `event=${encodeURIComponent(event)}&filename=${encodeURIComponent(file.name)}`;
  await json(
    await fetch(`/api/sounds/${encodeURIComponent(name)}/files?${query}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    }),
  );
}

export async function deleteSoundFile(name: string, event: string): Promise<void> {
  await json(
    await fetch(`/api/sounds/${encodeURIComponent(name)}/files/${encodeURIComponent(event)}`, {
      method: "DELETE",
    }),
  );
}

export async function deleteSoundSet(name: string): Promise<void> {
  await json(await fetch(`/api/sounds/${encodeURIComponent(name)}`, { method: "DELETE" }));
}

export async function activateSoundSet(name: string): Promise<{ active: string }> {
  return json(await fetch(`/api/sounds/${encodeURIComponent(name)}/activate`, { method: "POST" }));
}
