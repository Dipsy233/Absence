import type { FastifyInstance } from "fastify";
import type {
  ObserveDiscoveryResponse,
  ObserveLiveResponse,
  ObserveLiveRow,
  ObserveSessionRow,
} from "@absence/core";
import type { DiscoveryService } from "../observe/Discovery";
import { TRANSCRIPT_SOURCES, sourceRoots } from "../observe/transcriptSources";
import { sessionStore } from "../sessions/SessionStore";

/**
 * The observation board's endpoints.
 *
 * These are read-only on purpose: discovery lists what the tails found, the
 * live list is what Absence is already watching, and attaching is the one
 * action that creates a session. Absence starts no agent here — the board
 * offers what is on this machine, and the user chooses.
 */
export async function observeRoutes(
  app: FastifyInstance,
  options: { discovery: DiscoveryService },
): Promise<void> {
  /** The discovery list: every transcript a tail knows, attached or not. */
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

  /**
   * What Absence is watching right now — the board's “正在监控”.
   *
   * A session appears here exactly while it is live in the store: the discovery
   * feed created it, a proxy spawned it, or the user attached a transcript.
   * History is a different list (the archive); a session that went quiet is
   * archived and leaves this one, and re-attaching brings it back.
   */
  app.get("/api/observe/live", async (): Promise<ObserveLiveResponse> => {
    const rows: ObserveLiveRow[] = [];
    for (const session of sessionStore.list()) {
      const observe = session.observe;
      if (!observe) continue;
      rows.push({
        sessionId: session.id,
        channel: observe.channel,
        externalId: observe.externalId,
        agentKind: session.session.agentRuntime,
        projectPath: session.session.projectPath,
        ...(observe.transcriptFile !== undefined ? { transcriptFile: observe.transcriptFile } : {}),
        ...(observe.pid !== undefined ? { pid: observe.pid } : {}),
        startedAt: session.session.startedAt,
        watchStartedAt: session.watchStartedAt,
        lastActivityAt: session.lastActiveAtMs(),
        events: session.eventCount(),
        viewers: session.viewerCount(),
      });
    }
    rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return { sessions: rows };
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
