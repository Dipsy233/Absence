import type { Project, SessionSnapshot } from "@daze/core";

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

export async function createSession(projectPath: string, agent?: "pi" | "mock"): Promise<SessionSnapshot> {
  return json<SessionSnapshot>(
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath, agent }),
    }),
  );
}

export async function getSession(id: string): Promise<SessionSnapshot> {
  return json<SessionSnapshot>(await fetch(`/api/sessions/${id}`));
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
