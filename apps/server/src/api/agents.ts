import type { FastifyInstance } from "fastify";
import {
  addCustomAgent,
  catalogFile,
  commandLookupPaths,
  customAgents,
  launchLine,
  npxAllowed,
  removeCustomAgent,
  resolveCommand,
  updateCustomAgent,
  type CustomAgent,
} from "../agents/acp/AgentCatalog";

/**
 * Custom ACP entries — the user's own endpoints.
 *
 * An entry is `{ id, label, command, args, env, cwd }` and is stored in
 * ~/.absence/agents.json. The picker lists it like any other runtime; nothing
 * outside this module has to recognise the name. The command is validated
 * against the filesystem when it is saved, so a typo fails loudly here instead
 * of silently at session start.
 */
export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/agents", async () => {
    const file = catalogFile();
    return {
      file,
      allowNpx: npxAllowed(file),
      agents: customAgents(file).map(describe),
    };
  });

  app.post("/api/agents", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body) return reply.code(400).send({ error: "A custom ACP entry is required." });
    try {
      const agent = addCustomAgent({
        id: stringOrUndefined(body.id),
        label: stringOrUndefined(body.label),
        command: stringOrUndefined(body.command) ?? "",
        args: body.args,
        env: body.env,
        cwd: stringOrUndefined(body.cwd),
      });
      return reply.code(201).send({ agent: describe(agent) });
    } catch (error) {
      return reply.code(400).send(errorBody(error));
    }
  });

  app.put("/api/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown> | undefined;
    if (!body) return reply.code(400).send({ error: "A custom ACP entry is required." });
    try {
      const agent = updateCustomAgent(id, {
        id: stringOrUndefined(body.id) ?? id,
        label: stringOrUndefined(body.label),
        command: stringOrUndefined(body.command) ?? "",
        args: body.args,
        env: body.env,
        cwd: stringOrUndefined(body.cwd),
      });
      return { agent: describe(agent) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith(`No custom ACP entry`) ? 404 : 400;
      return reply.code(status).send(errorBody(error));
    }
  });

  app.delete("/api/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!removeCustomAgent(id)) {
      return reply.code(404).send({ error: `No custom ACP entry named "${id}".` });
    }
    return { ok: true };
  });
}

/** A row for the form: raw fields plus what the catalog resolved. */
function describe(agent: CustomAgent): CustomAgent & {
  commandLine: string;
  resolved?: string;
  available: boolean;
} {
  const resolved = resolveCommand(agent.command);
  return {
    ...agent,
    commandLine: launchLine({ launch: { command: agent.command, args: agent.args } }),
    ...(resolved ? { resolved } : {}),
    available: resolved !== undefined,
  };
}

function errorBody(error: unknown): { error: string; checked?: string[] } {
  const message = error instanceof Error ? error.message : String(error);
  const checked = /command "(.+)" was not found/.exec(message);
  if (!checked) return { error: message };
  const command = checked[1] ?? "";
  const paths = commandLookupPaths(command);
  return { error: message, ...(paths.length > 0 ? { checked: paths } : {}) };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
