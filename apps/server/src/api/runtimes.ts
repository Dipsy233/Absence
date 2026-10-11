import type { FastifyInstance } from "fastify";
import { runtimeStatuses, setRuntimePaths } from "../runtimes/config";

/**
 * Runtime configuration API — the Project Picker reads which runtimes are
 * installed and where their binaries live, and can point a missing one at the
 * right path. Values persist to ~/.absence/runtimes.json.
 */
export async function runtimeRoutes(app: FastifyInstance): Promise<void> {
  /** Every runtime and whether it is startable, plus its resolved path. */
  app.get("/api/runtimes", async () => {
    return { runtimes: runtimeStatuses() };
  });

  /** Save binary paths (pi / codex / dsh). Empty string clears an override. */
  app.post("/api/runtimes", async (request, reply) => {
    const body = request.body as { piBin?: string; codexBin?: string; dshBin?: string } | undefined;
    try {
      setRuntimePaths({
        ...(typeof body?.piBin === "string" ? { piBin: body.piBin } : {}),
        ...(typeof body?.codexBin === "string" ? { codexBin: body.codexBin } : {}),
        ...(typeof body?.dshBin === "string" ? { dshBin: body.dshBin } : {}),
      });
      return { ok: true, runtimes: runtimeStatuses() };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
