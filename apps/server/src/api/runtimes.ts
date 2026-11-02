import type { FastifyInstance } from "fastify";
import { getProfile, listProfiles, pickerRows, setNpxAllowed } from "../agents/acp/AgentCatalog";
import { setRuntimePaths } from "../runtimes/config";
import { sessionStore } from "../sessions/SessionStore";
import { agentRoutes } from "./agents";

/**
 * Runtime configuration API — the Project Picker reads which ACP entries the
 * catalog discovered on this machine and can override a launch line. Values
 * persist to Absence's own state file (~/.absence/agents.json).
 *
 * The request shape is generic (`launch: { [profileId]: "command args…" }`).
 * There are deliberately no `piBin` / `codexBin` / `dshBin` fields: a new
 * agent is a catalog entry, and the API must not need a code change to expose
 * it.
 */
export async function runtimeRoutes(app: FastifyInstance): Promise<void> {
  // Custom ACP CRUD lives in its own module; registering it here keeps the
  // server entry point untouched.
  await app.register(agentRoutes);

  /**
   * Every agent discovered on this machine, in the picker's row shape.
   * `unavailable` entries are deliberately absent: the probe view never lists
   * something that is not installed. A fresh request re-runs discovery, so the
   * UI's "重新探测" button needs no restart.
   */
  app.get("/api/runtimes", async () => {
    return { runtimes: pickerRows(listProfiles(), liveSessionModels()) };
  });

  /**
   * Save launch lines. An empty string clears an override for that profile.
   * Unknown profile ids are refused with a readable message rather than
   * stored silently (a typo would otherwise be invisible forever).
   *
   * `allowNpx: true` is the explicit opt-in for the npx fallback; it is stored
   * in Absence's own file, never in an agent's.
   */
  app.post("/api/runtimes", async (request, reply) => {
    const body = request.body as
      | { launch?: Record<string, unknown>; allowNpx?: unknown }
      | undefined;
    if (body?.allowNpx !== undefined) {
      if (typeof body.allowNpx !== "boolean") {
        return reply.code(400).send({ error: "allowNpx must be a boolean." });
      }
      setNpxAllowed(body.allowNpx);
    }
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
      if (Object.keys(launch).length > 0) setRuntimePaths({ launch });
      return { ok: true, runtimes: pickerRows(listProfiles(), liveSessionModels()) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/**
 * Models a live ACP session reported for its runtime. `session/new`'s
 * `configOptions` are already collapsed into `session.model` by the adapter,
 * so this is the agent's own answer — never a config-file guess.
 */
function liveSessionModels(): Record<string, string> {
  const models: Record<string, string> = {};
  for (const session of sessionStore.list()) {
    const model = session.session.model;
    if (typeof model === "string" && model) models[session.session.agentRuntime] = model;
  }
  return models;
}
