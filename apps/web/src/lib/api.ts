import type { CommandOption, Project, SessionHistoryEntry, SessionSnapshot } from "@absence/core";

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText} ${text}`.trim());
  }
  return (await response.json()) as T;
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
  agent?: "pi" | "mock",
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
