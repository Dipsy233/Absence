import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { SessionHistoryEntry } from "@daze/core";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { AgentKind } from "../config";
import { config } from "../config";
import { listArchives } from "../sessions/archive";
import { sessionStore } from "../sessions/SessionStore";
import { toPosix } from "../util/paths";

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function resolveAgent(value: string | undefined): AgentKind {
  if (value === "mock" || value === "pi") return value;
  return config.defaultAgent;
}

/** Session lifecycle API (read.md §31–32). */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The persisted history: DAZE archives merged with Pi's session files, newest
   * first. `?path=` narrows it to one project. This is what survives a restart.
   */
  app.get("/api/sessions/history", async (request) => {
    const filter = (request.query as { path?: string } | undefined)?.path?.trim();
    return sessionHistory(filter || undefined);
  });

  app.post("/api/sessions", async (request, reply) => {
    const body = request.body as
      | {
          projectPath?: string;
          agent?: string;
          resume?: { dazeSessionId?: string; piSessionFile?: string; piSessionId?: string };
        }
      | undefined;
    const projectPath = body?.projectPath?.trim();
    if (!projectPath) {
      return reply.code(400).send({ error: "projectPath is required" });
    }
    const resolved = toPosix(path.resolve(projectPath));
    if (!(await isDirectory(resolved))) {
      return reply.code(400).send({ error: `not a directory: ${resolved}` });
    }
    const raw = body?.resume;
    const resume =
      raw && (raw.dazeSessionId || raw.piSessionFile)
        ? {
            dazeSessionId: raw.dazeSessionId,
            piSessionFile: raw.piSessionFile,
            piSessionId: raw.piSessionId,
          }
        : undefined;
    const session = await sessionStore.create(resolved, resolveAgent(body?.agent), resume);
    return session.snapshot();
  });

  app.get("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return session.snapshot();
  });

  app.get("/api/sessions/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return session.history();
  });

  /**
   * Read a file from the project on demand. This backs the *user* view of the
   * project (the agent view only ever knows what it has touched).
   */
  app.get("/api/sessions/:id/file", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });

    const relative = (request.query as { path?: string } | undefined)?.path;
    if (!relative) return reply.code(400).send({ error: "path is required" });

    const root = path.resolve(session.session.projectPath);
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      return reply.code(400).send({ error: "path escapes the project" });
    }

    const MAX_BYTES = 512 * 1024;
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) return reply.code(400).send({ error: "not a file" });
      if (stat.size > MAX_BYTES) {
        return reply.code(413).send({ error: `file is too large (${stat.size} bytes)` });
      }
      const buffer = await fs.readFile(absolute);
      if (buffer.includes(0)) return reply.code(415).send({ error: "binary file" });
      return { path: relative, content: buffer.toString("utf-8"), size: stat.size };
    } catch {
      return reply.code(404).send({ error: "file not found" });
    }
  });

  app.post("/api/sessions/:id/prompt", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const body = request.body as { prompt?: string } | undefined;
    const prompt = body?.prompt;
    if (!prompt || !prompt.trim()) {
      return reply.code(400).send({ error: "prompt is required" });
    }
    session.prompt(prompt);
    return { ok: true };
  });

  app.post("/api/sessions/:id/abort", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    await session.abort();
    return { ok: true };
  });

  /** Choice lists for the commands that need one (the terminal box's submenu). */
  app.get("/api/sessions/:id/commands/:name/options", async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return { options: await session.commandOptions(name) };
  });

  /**
   * Run a chat command (`/model`, `/compact`, …). The result streams back over
   * the WebSocket as a system message; this call only reports that it ran.
   */
  app.post("/api/sessions/:id/command", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const body = request.body as { name?: string; args?: string } | undefined;
    const name = body?.name?.trim();
    if (!name) return reply.code(400).send({ error: "name is required" });
    await session.runCommand(name, body?.args ?? "");
    return { ok: true };
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionStore.get(id)) return reply.code(404).send({ error: "session not found" });
    await sessionStore.remove(id);
    return { ok: true };
  });
}

/**
 * Merge DAZE's archives with Pi's own session files into one history list.
 * DAZE's archive wins on identity (it names the Pi session file); a Pi session
 * with no DAZE archive still appears, it just cannot restore the Stage.
 */
async function sessionHistory(projectPath?: string): Promise<SessionHistoryEntry[]> {
  const entries = new Map<string, SessionHistoryEntry>();
  const seenPiFiles = new Set<string>();

  for (const meta of await listArchives(projectPath)) {
    if (meta.piSessionFile) seenPiFiles.add(meta.piSessionFile);
    const key = meta.piSessionFile ? `pi:${meta.piSessionFile}` : `daze:${meta.dazeSessionId}`;
    entries.set(key, {
      id: meta.dazeSessionId,
      dazeSessionId: meta.dazeSessionId,
      piSessionFile: meta.piSessionFile,
      piSessionId: meta.piSessionId,
      projectPath: meta.projectPath,
      projectName: meta.projectName,
      createdAt: meta.startedAt,
      updatedAt: meta.updatedAt,
      messageCount: meta.messageCount,
      firstPrompt: meta.firstPrompt,
      runtime: meta.runtime,
      archived: true,
    });
  }

  for (const info of await listPiSessions(projectPath)) {
    if (seenPiFiles.has(info.path)) continue;
    const cwd = info.cwd || projectPath || "";
    entries.set(`pi:${info.path}`, {
      id: info.id,
      piSessionFile: info.path,
      piSessionId: info.id,
      projectPath: cwd,
      projectName: cwd ? path.basename(cwd) : "—",
      name: info.name,
      createdAt: info.created.getTime(),
      updatedAt: info.modified.getTime(),
      messageCount: info.messageCount,
      firstPrompt: info.firstMessage,
      runtime: "pi",
      archived: false,
    });
  }

  return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Pi's persisted sessions, when the SDK is importable. Never throws. */
async function listPiSessions(cwd?: string): Promise<SessionInfo[]> {
  try {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const infos = await SessionManager.listAll();
    return cwd ? infos.filter((info) => samePath(info.cwd, cwd)) : infos;
  } catch {
    return [];
  }
}

function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
