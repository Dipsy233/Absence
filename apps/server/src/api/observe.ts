import type { FastifyInstance } from "fastify";
import type {
  ObserveDiscoveryResponse,
  ObserveLiveResponse,
  ObserveLiveRow,
  ObserveSessionRow,
  ObserveTargetsResponse,
  ObserveTargetRow,
  ObserveWatchResponse,
} from "@absence/core";
import type { DiscoveryService } from "../observe/Discovery";
import { TRANSCRIPT_SOURCES, sourceRoots } from "../observe/transcriptSources";
import { proxyTargets, transcriptTargets } from "../observe/Targets";
import { listLeases } from "../observe/leases";
import { unwatchSession, watchTarget } from "../observe/watch";
import { proxySessions } from "../agents/acp/proxy";
import { sessionStore } from "../sessions/SessionStore";

/**
 * The observation board's endpoints.
 *
 * Read-only on purpose, with exactly two write-shaped actions that are still
 * not *driving* anything:
 *
 *   POST /api/observe/watch    choose a discovered target to monitor (a lease)
 *   POST /api/observe/unwatch  stop monitoring it (the archive stays)
 *
 * Neither starts an agent, sends a prompt or answers an approval: the agent
 * keeps running in its own terminal, forever unaware of the board.
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
   * What the board may offer: transcripts the tails know, processes the
   * scanner matched, proxies the registry holds. Building this list creates
   * nothing — choosing a row does (`POST /watch`).
   */
  app.get("/api/observe/targets", async (): Promise<ObserveTargetsResponse> => {
    const liveByExternal = new Map<string, string>();
    for (const session of sessionStore.list()) {
      if (session.observe?.channel === "transcript" && session.observe.externalId) {
        liveByExternal.set(session.observe.externalId, session.id);
      }
    }
    const targets: ObserveTargetRow[] = [
      ...transcriptTargets(options.discovery.list(), liveByExternal),
      ...proxyTargets(proxySessions.list()),
    ];
    const priority: Record<ObserveTargetRow["liveness"], number> = {
      running: 0,
      idle: 1,
      exited: 2,
      missing: 3,
    };
    targets.sort(
      (a, b) =>
        priority[a.liveness] - priority[b.liveness] ||
        b.lastActivityAt - a.lastActivityAt ||
        a.key.localeCompare(b.key),
    );
    return { targets };
  });

  /**
   * What Absence is watching right now — the board's “正在监控”.
   *
   * A session appears here exactly while it is live in the store: a lease, an
   * auto-attached transcript, or a proxy spawned it. History is a different
   * list (the archive); a session that went quiet is archived and leaves this
   * one, and re-attaching brings it back.
   */
  app.get("/api/observe/live", async (): Promise<ObserveLiveResponse> => {
    const leased = new Set(listLeases().map((lease) => lease.sessionId));
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
        leased: session.hasMonitorLease() || leased.has(session.id),
      });
    }
    rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return { sessions: rows };
  });

  /** Attach one transcript by file path (kept for the CLI and older clients). */
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

  /**
   * Choose a target to monitor. Idempotent: watching the same target twice
   * lands on the same session and refreshes the same lease.
   */
  app.post("/api/observe/watch", async (request, reply): Promise<ObserveWatchResponse | undefined> => {
    const body = request.body as { key?: unknown } | undefined;
    const key = typeof body?.key === "string" ? body.key.trim() : undefined;
    if (key === undefined || key.length === 0) {
      reply.code(400).send({ error: "key is required" });
      return undefined;
    }
    const result = await watchTarget(key, { discovery: options.discovery });
    if (result === undefined) {
      reply.code(404).send({ error: `nothing to monitor for ${key}` });
      return undefined;
    }
    return { sessionId: result.sessionId, url: result.url, state: result.state };
  });

  /**
   * Stop monitoring. The archive and its History row stay; only the lease (the
   * “keep watching it” promise) is dropped, so the idle sweep may retire the
   * live view later.
   */
  app.post("/api/observe/unwatch", async (request, reply) => {
    const body = request.body as { sessionId?: unknown; key?: unknown } | undefined;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : undefined;
    const key = typeof body?.key === "string" ? body.key.trim() : undefined;
    if (sessionId === undefined && key === undefined) {
      reply.code(400).send({ error: "sessionId or key is required" });
      return undefined;
    }
    const removed = sessionId !== undefined ? unwatchSession(sessionId) : false;
    return { ok: true, removed };
  });
}