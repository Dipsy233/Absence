import type { FastifyInstance } from "fastify";
import type { ObserveDiscoveryResponse, ObserveSessionRow } from "@absence/core";
import type { DiscoveryService } from "../observe/Discovery";
import { TRANSCRIPT_SOURCES, sourceRoots } from "../observe/transcriptSources";

/**
 * The observation board's endpoints.
 *
 * These are read-only on purpose: discovery lists what the tails found, and
 * attaching is automatic. An observe row is not a control surface — nothing
 * here spawns, prompts or answers anything.
 */
export async function observeRoutes(app: FastifyInstance, options: { discovery: DiscoveryService }): Promise<void> {
  app.get("/api/observe/sessions", async (): Promise<ObserveDiscoveryResponse> => {
    const sessions = options.discovery.list();
    const sources = TRANSCRIPT_SOURCES.map((profile) => ({
      id: profile.id,
      label: profile.label,
      agentKind: profile.agentKind,
      roots: sourceRoots(profile),
      watched: sessions.some((session) => session.source === profile.id),
    }));
    return { sessions, sources };
  });

  /** Attach one transcript by file path (the board's click-to-monitor). */
  app.post("/api/observe/attach", async (request, reply): Promise<ObserveSessionRow | undefined> => {
    const body = request.body as { file?: unknown } | undefined;
    const file = typeof body?.file === "string" ? body.file : undefined;
    if (file === undefined) {
      reply.code(400).send({ error: "file is required" });
      return undefined;
    }
    const row = await options.discovery.attach(file);
    if (row === undefined) {
      reply.code(404).send({ error: "no transcript tail follows this file" });
      return undefined;
    }
    return row;
  });
}
