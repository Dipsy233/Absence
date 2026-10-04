import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AgentKind } from "../config";
import { config } from "../config";
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
  app.post("/api/sessions", async (request, reply) => {
    const body = request.body as { projectPath?: string; agent?: string } | undefined;
    const projectPath = body?.projectPath?.trim();
    if (!projectPath) {
      return reply.code(400).send({ error: "projectPath is required" });
    }
    const resolved = toPosix(path.resolve(projectPath));
    if (!(await isDirectory(resolved))) {
      return reply.code(400).send({ error: `not a directory: ${resolved}` });
    }
    const session = await sessionStore.create(resolved, resolveAgent(body?.agent));
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

  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionStore.get(id)) return reply.code(404).send({ error: "session not found" });
    await sessionStore.remove(id);
    return { ok: true };
  });
}
