import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { SessionHistoryEntry } from "@absence/core";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { AgentKind } from "../config";
import { config } from "../config";
import { listArchives, readEventsPage, readMeta } from "../sessions/archive";
import { sessionStore, RuntimeUnavailableError } from "../sessions/SessionStore";
import { toPosix } from "../util/paths";
import { takeTerminalMirror } from "../sessions/terminalRegistry";

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function resolveAgent(value: string | undefined): AgentKind {
  if (value === "mock" || value === "pi" || value === "codex" || value === "dsh") return value;
  return config.defaultAgent;
}

/** A query-string positive integer, or undefined when absent/invalid. */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Session lifecycle API (read.md §31–32). */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The persisted history: ABSENCE archives merged with Pi's session files, newest
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
          resume?: { absenceSessionId?: string; piSessionFile?: string; piSessionId?: string };
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
      raw && (raw.absenceSessionId || raw.piSessionFile)
        ? {
            absenceSessionId: raw.absenceSessionId,
            piSessionFile: raw.piSessionFile,
            piSessionId: raw.piSessionId,
          }
        : undefined;
    const session = await (async () => {
      try {
        return await sessionStore.create(resolved, resolveAgent(body?.agent), resume);
      } catch (error) {
        // The runtime would not start (not installed / bad path / no
        // credentials). Surface it to the picker instead of a bare 500.
        if (error instanceof RuntimeUnavailableError) {
          return reply.code(503).send({ error: error.message, runtime: error.runtime });
        }
        throw error;
      }
    })();
    if (!session) return reply;
    return session.snapshot();
  });

  /**
   * Watch an agent that is already running, instead of starting one.
   *
   * This is the entry point that makes Absence an observer rather than a
   * client: any process — any agent, any version — can be watched by its pid,
   * with no adapter and no knowledge of its internals. `absence watch` uses it.
   */
  app.post("/api/sessions/observe", async (request, reply) => {
    const body = request.body as
      | { projectPath?: string; pid?: number; label?: string; transcript?: string }
      | undefined;
    const pid = Number(body?.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return reply.code(400).send({ error: "pid is required" });
    }
    const projectPath = body?.projectPath?.trim();
    if (!projectPath) {
      return reply.code(400).send({ error: "projectPath is required" });
    }
    const resolved = toPosix(path.resolve(projectPath));
    if (!(await isDirectory(resolved))) {
      return reply.code(400).send({ error: `not a directory: ${resolved}` });
    }
    try {
      // A mirror registered by the same process (the CLI's `watch -- cmd`) is
      // handed over here: the pid is the only shared key, and the HTTP body
      // cannot carry an object. An agent somebody else started has none.
      const terminal = takeTerminalMirror(pid);
      const session = await sessionStore.createObserved(
        resolved,
        pid,
        body?.label,
        terminal,
        body?.transcript,
      );
      return session.snapshot();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return session.snapshot();
  });

  /**
   * Persisted events, newest page first when `before` is omitted.
   *
   *   ?limit=500          page size (1..2000)
   *   ?before=<seq>       exclusive cursor from the previous page's nextBefore
   *
   * Returns `{ events, nextBefore, hasMore }`, with events chronological inside
   * the page. A live session and an archived one are served the same way; the
   * database is the source of history either way.
   */
  app.get("/api/sessions/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as { before?: string; limit?: string };
    const before = parsePositiveInt(query.before);
    if (query.before !== undefined && before === undefined) {
      return reply.code(400).send({ error: "before must be a positive integer" });
    }
    const limit = parsePositiveInt(query.limit);
    if (query.limit !== undefined && limit === undefined) {
      return reply.code(400).send({ error: "limit must be a positive integer" });
    }
    // A live session is in the store; a historical one only needs its archive
    // row. `readMeta` takes a cwd for compatibility, but the id is global.
    if (!sessionStore.get(id) && !(await readMeta("", id))) {
      return reply.code(404).send({ error: "session not found" });
    }
    return readEventsPage(id, { before, limit });
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

  /**
   * Answer an approval prompt the agent raised (the `approval` event). `value`
   * is one of that event's option values; it unblocks the runtime request.
   */
  app.post("/api/sessions/:id/approval", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const body = request.body as { id?: string; value?: string } | undefined;
    const approvalId = body?.id?.trim();
    const value = body?.value?.trim();
    if (!approvalId || !value) {
      return reply.code(400).send({ error: "id and value are required" });
    }
    await session.respondApproval(approvalId, value);
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
 * Merge ABSENCE's archives with Pi's own session files into one history list.
 * ABSENCE's archive wins on identity (it names the Pi session file); a Pi session
 * with no ABSENCE archive still appears, it just cannot restore the Stage.
 */
async function sessionHistory(projectPath?: string): Promise<SessionHistoryEntry[]> {
  const entries = new Map<string, SessionHistoryEntry>();
  const seenPiFiles = new Set<string>();

  for (const meta of await listArchives(projectPath)) {
    if (meta.piSessionFile) seenPiFiles.add(meta.piSessionFile);
    const key = meta.piSessionFile ? `pi:${meta.piSessionFile}` : `absence:${meta.absenceSessionId}`;
    entries.set(key, {
      id: meta.absenceSessionId,
      absenceSessionId: meta.absenceSessionId,
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
