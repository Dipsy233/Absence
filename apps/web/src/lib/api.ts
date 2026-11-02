import type {
  AbsenceEvent,
  AvatarSkinMeta,
  AvatarSkinState,
  EggFilterProfileMeta,
  EggFilterSaveResponse,
  EggFilterState,
  FileContent,
  FileVersionInfo,
  MetricsResponse,
  Project,
  ResumeTarget,
  RunSummary,
  RuntimeKind,
  RuntimeStatus,
  SessionHistoryEntry,
  SessionSnapshot,
  SoundSetMeta,
  SoundSetState,
} from "@absence/core";

/* The wire shapes are the shared contracts (packages/core/api) — the same
   declarations the server's routes are annotated against, not hand-kept
   copies. Re-exported here because the settings panes import them from this
   module. */
export type {
  AvatarSkinMeta,
  AvatarSkinState,
  EggFilterProfileMeta,
  EggFilterSaveResponse,
  EggFilterState,
  FileContent,
  ResumeTarget,
  RuntimeKind,
  RuntimeStatus,
  SoundSetMeta,
  SoundSetState,
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

export async function createSession(
  projectPath: string,
  agent?: RuntimeKind,
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

/** The persisted history (ABSENCE archives + Pi sessions), newest first. */
export async function fetchSessionHistory(path?: string): Promise<SessionHistoryEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return json<SessionHistoryEntry[]>(await fetch(`/api/sessions/history${query}`));
}

/** Persisted metric series for a range. Live recent frames come from the socket. */
export async function fetchMetrics(
  sessionId: string,
  options: { from: number; to: number; step: number; eggPid?: number },
): Promise<MetricsResponse> {
  const query = new URLSearchParams({
    from: String(options.from),
    to: String(options.to),
    step: String(options.step),
  });
  if (options.eggPid !== undefined) query.set("egg", String(options.eggPid));
  return json<MetricsResponse>(
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/metrics?${query.toString()}`),
  );
}

/** Every recorded file version for a session, independent of the event window. */
export async function fetchFileVersions(sessionId: string): Promise<FileVersionInfo[]> {
  return json<FileVersionInfo[]>(await fetch(`/api/sessions/${sessionId}/file-versions`));
}

/** Run summaries for History (no event payloads). */
export async function fetchRuns(sessionId: string): Promise<RunSummary[]> {
  return json<RunSummary[]>(await fetch(`/api/sessions/${sessionId}/runs`));
}

/** The events belonging to one run, fetched only when it is selected. */
export async function fetchRunEvents(
  sessionId: string,
  index: number,
): Promise<{ run: RunSummary; events: AbsenceEvent[] }> {
  return json<{ run: RunSummary; events: AbsenceEvent[] }>(
    await fetch(`/api/sessions/${sessionId}/runs/${index}/events`),
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

/**
 * Leave a session: stop its watchers and metrics sampling, keep its archive.
 * Best effort — the UI leaves either way, but a failure is worth a console line
 * because it means the server will keep sampling in the background.
 */
export async function closeSession(id: string): Promise<void> {
  await fetch(`/api/sessions/${encodeURIComponent(id)}/close`, { method: "POST" });
}

/** Read a project file from disk (the user's view of the project). */
export async function readFile(sessionId: string, path: string): Promise<FileContent> {
  return json<FileContent>(
    await fetch(`/api/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`),
  );
}

/** Forward a chat command; its output arrives over the socket as run events. */
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
