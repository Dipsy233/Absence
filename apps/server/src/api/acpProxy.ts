import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { proxySessions } from "../agents/acp/proxy";

/**
 * Proxy session API.
 *
 * The proxy forwards, it does not manage agents: a session is started with the
 * exact command the user would otherwise have put behind the ACP client.
 *
 *   POST   /api/acp-proxy/sessions       start a session
 *   GET    /api/acp-proxy/sessions       list running and finished sessions
 *   DELETE /api/acp-proxy/sessions/:id   close one (idempotent on status)
 *
 * `absence proxy -- <command>` uses the same registry over its own stdio. Over
 * HTTP the upstream client attaches to the returned localhost endpoint (NDJSON
 * over TCP), because an HTTP request cannot carry a live JSON-RPC channel.
 */

interface StartBody {
  command?: unknown;
  cwd?: string;
  projectPath?: string;
  label?: string;
  env?: Record<string, string>;
  upstream?: { kind?: string; host?: string; port?: number };
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function asCommand(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value.trim()] : undefined;
  }
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (value.some((part) => typeof part !== "string" || part.length === 0)) return undefined;
  return value as string[];
}

export async function acpProxyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/acp-proxy/sessions", async () => {
    return { sessions: proxySessions.list() };
  });

  app.post("/api/acp-proxy/sessions", async (request, reply) => {
    const body = request.body as StartBody | undefined;
    const command = asCommand(body?.command);
    if (!command) {
      return reply.code(400).send({ error: "command is required (string or non-empty string[])" });
    }

    const upstream = body?.upstream;
    if (upstream && upstream.kind !== undefined && upstream.kind !== "tcp") {
      return reply
        .code(400)
        .send({ error: `unsupported upstream kind: ${upstream.kind} (only "tcp" is available over HTTP)` });
    }
    const port = upstream?.port === undefined ? 0 : Number(upstream.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return reply.code(400).send({ error: "upstream.port must be an integer in 0..65535" });
    }

    const cwd = path.resolve(body?.cwd?.trim() || body?.projectPath?.trim() || process.cwd());
    if (!(await isDirectory(cwd))) {
      return reply.code(400).send({ error: `not a directory: ${cwd}` });
    }
    if (body?.env !== undefined) {
      const env = body.env;
      if (
        typeof env !== "object" ||
        env === null ||
        Array.isArray(env) ||
        Object.values(env).some((value) => typeof value !== "string")
      ) {
        return reply.code(400).send({ error: "env must be an object of string values" });
      }
    }

    try {
      const session = await proxySessions.startTcp(
        {
          command,
          cwd,
          label: body?.label?.trim() || undefined,
          env: body?.env,
        },
        { host: upstream?.host?.trim() || "127.0.0.1", port },
      );
      return reply.code(201).send({ session: session.info() });
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/acp-proxy/sessions/:id", async (request, reply) => {
    const id = (request.params as { id?: string } | undefined)?.id;
    if (!id || !proxySessions.close(id)) {
      return reply.code(404).send({ error: "proxy session not found" });
    }
    return { ok: true, session: proxySessions.get(id) };
  });
}
