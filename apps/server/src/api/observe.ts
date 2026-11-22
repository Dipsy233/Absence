import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ObserveDiscoveryResponse, ObserveSessionRow } from "@absence/core";
import type { DiscoveryService } from "../observe/Discovery";
import { TRANSCRIPT_SOURCES, sourceRoots } from "../observe/transcriptSources";
import { launchTerminal } from "../observe/launcher";
import { sessionStore } from "../sessions/SessionStore";
import { readMeta } from "../sessions/archive";
import { toPosix } from "../util/paths";

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The observation board's endpoints.
 *
 * These are read-only on purpose: discovery lists what the tails found, and
 * attaching is automatic. The one exception is the auxiliary launcher — it
 * opens the user's own terminal running the agent and walks away; Absence
 * still never prompts, aborts or answers anything.
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

  /**
   * The auxiliary launcher (refactor plan §2.8): open the user's own terminal
   * running the agent — a fresh session in `cwd`, or continuing a transcript
   * with the profile's resume args. Absence spawns the terminal application
   * and nothing else; observation rides the transcript channel. When the
   * launch resumes a known conversation, the matching observed session is
   * re-attached and its id returned so the board can watch it immediately.
   */
  app.post("/api/observe/launch", async (request, reply) => {
    const body = request.body as
      | { cwd?: unknown; file?: unknown; absenceSessionId?: unknown }
      | undefined;
    const cwdInput = typeof body?.cwd === "string" ? body.cwd.trim() : undefined;
    const fileInput = typeof body?.file === "string" ? body.file.trim() : undefined;
    const absenceId = typeof body?.absenceSessionId === "string" ? body.absenceSessionId.trim() : undefined;
    if (cwdInput === undefined && fileInput === undefined && absenceId === undefined) {
      reply.code(400).send({ error: "cwd, file or absenceSessionId is required" });
      return undefined;
    }

    // Resolve which transcript the launch continues, if any. Strongest first:
    // an explicit file, a live observed session, the archive's resume handle,
    // and finally the tail list keyed by the archive's external id.
    let file = fileInput;
    let projectPath: string | undefined;
    let externalId: string | undefined;
    if (absenceId !== undefined) {
      const live = sessionStore.get(absenceId);
      file ??= live?.observe?.transcriptFile;
      externalId = live?.observe?.externalId;
      const meta = await readMeta("", absenceId);
      file ??= meta?.piSessionFile;
      projectPath = meta?.projectPath;
      externalId ??= meta?.externalId;
      if (file === undefined && externalId !== undefined) {
        file = options.discovery.list().find((row) => row.externalId === externalId)?.file;
      }
    }

    const profile = TRANSCRIPT_SOURCES.find((entry) => entry.launch !== undefined);
    if (profile === undefined) {
      reply.code(501).send({ error: "no launchable transcript source on this host" });
      return undefined;
    }

    const cwd = cwdInput !== undefined ? cwdInput : file !== undefined ? path.dirname(file) : undefined;
    if (cwd === undefined) {
      reply.code(400).send({ error: "a directory is required (cwd, or a file to resume)" });
      return undefined;
    }
    const resolvedCwd = toPosix(path.resolve(cwd));
    if (!(await isDirectory(resolvedCwd))) {
      reply.code(400).send({ error: `not a directory: ${resolvedCwd}` });
      return undefined;
    }
    if (file !== undefined && projectPath === undefined) projectPath = path.dirname(file);

    try {
      await launchTerminal(profile, resolvedCwd, file);
    } catch (error) {
      reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }

    // Re-attach the resumed conversation so the board can watch it at once.
    // createObserved dedupes live sessions and reuses the archive row by
    // (channel, externalId); archives without an identity simply get none.
    let sessionId: string | undefined;
    if (absenceId !== undefined && externalId !== undefined && file !== undefined) {
      try {
        const watch = await sessionStore.createObserved(
          projectPath ?? resolvedCwd,
          profile.agentKind,
          { channel: "transcript", externalId, transcriptFile: file },
        );
        sessionId = watch.id;
      } catch {
        // The launch itself succeeded; watching can attach later.
      }
    }
    return { ok: true, cwd: resolvedCwd, ...(file !== undefined ? { file } : {}), ...(sessionId !== undefined ? { sessionId } : {}) };
  });
}
