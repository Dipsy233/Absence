import path from "node:path";
import type { FastifyInstance } from "fastify";
import { discoverCapabilities } from "../capabilities/discover";
import {
  capabilityPaths,
  createSkill,
  deleteMcpEntry,
  deleteSkill,
  importSkill,
  listMcpEntries,
  saveMcpEntry,
  setMcpEnabled,
  skillLocations,
  type McpInput,
  type SkillUploadFile,
  type SkillInput,
} from "../capabilities/manage";

/**
 * Capability management for the Settings dialog: skills and MCP servers.
 *
 * Reads go through the same discovery a session uses (`capabilities/discover`)
 * plus the editable view (`capabilities/manage`); writes edit the shared
 * cross-runtime files, so the next session — whichever runtime — sees them.
 * `?cwd=` names the project a project-level write targets; without it every
 * write lands in the user-level location.
 */
export async function capabilityRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the pane renders in one call. */
  app.get("/api/capabilities", async (request) => {
    const cwd = (request.query as { cwd?: string } | undefined)?.cwd?.trim() || undefined;
    const discovered = discoverCapabilities({ cwd: cwd ?? process.cwd() });
    const mcp = listMcpEntries(cwd);
    const paths = capabilityPaths(cwd);
    return {
      dirs: {
        skills: skillLocations(cwd),
        userSkills: paths.userSkillsDir,
        mcp: mcp.dir,
        projectMcp: paths.projectMcpConfig,
        codexConfig: paths.codexConfig,
      },
      skills: discovered.skills,
      mcp: mcp.entries,
      diagnostics: discovered.diagnostics,
    };
  });

  /** Create a skill (name + description; the SKILL.md is templated). */
  app.post("/api/capabilities/skills", async (request, reply) => {
    const body = (request.body ?? {}) as Partial<SkillInput> & { cwd?: string };
    try {
      const result = createSkill(
        { name: String(body.name ?? ""), description: String(body.description ?? ""), body: body.body, scope: body.scope },
        body.cwd,
      );
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * Import a skill folder the user picked: a JSON list of `{ path, content }`
   * (relative paths, text files). The binary-friendly alternative is the raw
   * endpoint below, used by the native picker for a single SKILL.md.
   */
  app.post("/api/capabilities/skills/import", async (request, reply) => {
    const body = (request.body ?? {}) as {
      files?: Array<{ path?: string; content?: string }>;
      scope?: "user" | "project";
      cwd?: string;
      overwrite?: boolean;
    };
    const files: SkillUploadFile[] = (body.files ?? [])
      .filter((file) => typeof file.path === "string")
      .map((file) => ({ path: file.path!, data: Buffer.from(String(file.content ?? ""), "utf8") }));
    try {
      return { ok: true, ...importSkill(files, { scope: body.scope, cwd: body.cwd, overwrite: body.overwrite }) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Import one raw file (application/octet-stream): a bare SKILL.md. */
  app.put("/api/capabilities/skills/import", async (request, reply) => {
    const query = request.query as { scope?: string; cwd?: string; overwrite?: string } | undefined;
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: "request body must be the SKILL.md bytes" });
    }
    try {
      const result = importSkill([{ path: "SKILL.md", data: body }], {
        scope: query?.scope === "project" ? "project" : "user",
        cwd: query?.cwd,
        overwrite: query?.overwrite === "1",
      });
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Delete a discovered skill folder. */
  app.delete("/api/capabilities/skills", async (request, reply) => {
    const query = request.query as { path?: string; cwd?: string } | undefined;
    const filePath = query?.path?.trim() ?? "";
    if (!filePath) return reply.code(400).send({ error: "?path=<SKILL.md> is required" });
    try {
      return { ok: true, ...deleteSkill(path.resolve(filePath), query?.cwd) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Add or replace a user-level MCP server. */
  app.post("/api/capabilities/mcp", async (request, reply) => {
    const body = (request.body ?? {}) as Partial<McpInput>;
    try {
      const input: McpInput = {
        name: String(body.name ?? ""),
        type: body.type === "http" ? "http" : "stdio",
        command: body.command,
        args: Array.isArray(body.args) ? body.args.map(String) : undefined,
        env: body.env && typeof body.env === "object" ? (body.env as Record<string, string>) : undefined,
        url: body.url,
        headers: body.headers && typeof body.headers === "object" ? (body.headers as Record<string, string>) : undefined,
        exposure: body.exposure,
        description: body.description,
        enabled: body.enabled,
      };
      return { ok: true, ...saveMcpEntry(input) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Enable / disable a server (`mcp.json` entries only). */
  app.put("/api/capabilities/mcp/:name/enabled", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    const body = (request.body ?? {}) as { enabled?: boolean; cwd?: string };
    try {
      return { ok: true, ...setMcpEnabled(name, body.enabled !== false, body.cwd) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Remove a server (`mcp.json` entries only). */
  app.delete("/api/capabilities/mcp/:name", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    const query = request.query as { cwd?: string } | undefined;
    try {
      return { ok: true, ...deleteMcpEntry(name, query?.cwd) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
