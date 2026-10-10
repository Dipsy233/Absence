import type { FastifyInstance } from "fastify";
import {
  activeProfileName,
  activateProfile,
  deleteProfile,
  eggFiltersDir,
  getProfile,
  listProfiles,
} from "../process/eggFilter";

/**
 * Agent Eggs filter profiles: named JSON files (one command name per array
 * entry) the classifier reads. Same name overwrites, a new name creates a file;
 * one profile is active at a time.
 */
export async function eggFilterRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the editor needs on open: profiles, the active one, its content. */
  app.get("/api/egg-filter", async () => {
    const profiles = listProfiles();
    const active = activeProfileName();
    const currentProfile = getProfile(active);
    return {
      dir: eggFiltersDir,
      active,
      force: currentProfile?.force ?? false,
      profiles,
      current: currentProfile?.names ?? [],
    };
  });

  /** Save a profile: same name overwrites, a new name creates. */
  app.put("/api/egg-filter/:name", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    const body = request.body as { names?: unknown; force?: boolean } | undefined;
    if (!body || !Array.isArray(body.names)) {
      return reply.code(400).send({ error: "names must be a string array" });
    }
    try {
      const profile = activateProfile(name, body.names as string[], body.force === true);
      return { ok: true, profile, active: activeProfileName() };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Activate a saved profile without re-saving content. */
  app.post("/api/egg-filter/:name/activate", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    try {
      activateProfile(name);
      return { ok: true, active: activeProfileName(), current: getProfile(name)?.names ?? [] };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/egg-filter/:name", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    if (!deleteProfile(name)) return reply.code(404).send({ error: `profile not found: ${name}` });
    return { ok: true };
  });
}
