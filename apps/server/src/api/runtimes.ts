import type { FastifyInstance } from "fastify";
import { getProfile } from "../agents/acp/AgentCatalog";
import { runtimeStatuses, setRuntimePaths } from "../runtimes/config";

/**
 * Runtime configuration API — the Project Picker reads which ACP profiles the
 * catalog knows and where their launch lines point, and can point a missing
 * one at the right executable. Values persist to ~/.absence/runtimes.json.
 *
 * The request shape is generic (`launch: { [profileId]: "command args…" }`).
 * There are deliberately no `piBin` / `codexBin` / `dshBin` fields: a new
 * agent is a catalog entry, and the API must not need a code change to expose
 * it.
 */
export async function runtimeRoutes(app: FastifyInstance): Promise<void> {
  /** Every runtime and whether it is startable, plus its launch line. */
  app.get("/api/runtimes", async () => {
    return { runtimes: runtimeStatuses() };
  });

  /**
   * Save launch lines. An empty string clears an override for that profile.
   * Unknown profile ids are refused with a readable message rather than
   * stored silently (a typo would otherwise be invisible forever).
   */
  app.post("/api/runtimes", async (request, reply) => {
    const body = request.body as { launch?: Record<string, unknown> } | undefined;
    const launch: Record<string, string> = {};
    for (const [id, value] of Object.entries(body?.launch ?? {})) {
      if (typeof value !== "string") {
        return reply.code(400).send({ error: `Launch line for "${id}" must be a string.` });
      }
      // Aliases are accepted so old clients/runtimes keep working, but the
      // override is stored under the canonical profile id the catalog reads.
      const profile = getProfile(id);
      if (value.trim() && !profile) {
        return reply.code(400).send({ error: `No ACP profile named "${id}".` });
      }
      launch[profile?.id ?? id] = value;
    }
    try {
      setRuntimePaths({ launch });
      return { ok: true, runtimes: runtimeStatuses() };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
