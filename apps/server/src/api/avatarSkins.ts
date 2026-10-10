import type { FastifyInstance } from "fastify";
import {
  activateSkin,
  avatarSkinsDir,
  contentTypeFor,
  createSkin,
  deleteSkin,
  deleteSkinFile,
  getActiveName,
  getSkin,
  listSkins,
  resolveSkinFile,
  saveSkinFile,
} from "../process/avatarSkins";
import fs from "node:fs";

/**
 * Avatar skins: user-uploaded animations managed from the Settings dialog.
 * The client picks a status and PUTs the raw file bytes; the file becomes that
 * status's animation inside the skin's folder. The active skin's files are
 * served at /avatar/<status> so the web app never touches the filesystem.
 */
export async function avatarSkinRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the editor needs: skins, the active one, and its files. */
  app.get("/api/avatar-skins", async () => {
    const active = getActiveName();
    return {
      dir: avatarSkinsDir,
      active,
      builtin: "WhaleBun",
      skins: listSkins(),
      activeFiles: active ? getSkin(active)?.files ?? {} : {},
    };
  });

  /** Create an empty skin folder (a new character). */
  app.post("/api/avatar-skins/:name", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    try {
      return { ok: true, skin: createSkin(name) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Upload one file: ?status=thinking with the raw bytes as the body. */
  app.put("/api/avatar-skins/:name/files", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    const query = request.query as { status?: string; filename?: string };
    const status = query.status ?? "";
    const originalName = query.filename || `${status}.bin`;
    const body = request.body as Buffer | undefined;
    if (!body || !Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: "request body must be the raw file bytes" });
    }
    try {
      const skin = saveSkinFile(name, status, originalName, body);
      return { ok: true, skin };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Remove one status's file from a skin. */
  app.delete("/api/avatar-skins/:name/files/:status", async (request, reply) => {
    const { name, status } = request.params as { name?: string; status?: string };
    try {
      const skin = deleteSkinFile(name ?? "", status ?? "");
      return { ok: true, skin };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Delete a whole skin folder. */
  app.delete("/api/avatar-skins/:name", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    if (!deleteSkin(name)) return reply.code(404).send({ error: `skin not found: ${name}` });
    return { ok: true };
  });

  /** Activate a skin; the name "WhaleBun" (or empty) restores the builtin. */
  app.post("/api/avatar-skins/:name/activate", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    try {
      activateSkin(name);
      return { ok: true, active: getActiveName() };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * Serve the active skin's media at /avatar/<status>. 404 (not a builtin
   * fallback) so the web app can tell "no upload" apart from "wrong bytes"
   * and fall back to the HTML character per status.
   *
   * Supports HTTP Range requests — browsers require them to play <video>:
   * without a 206 response Chrome/Edge refuse to start mp4 playback.
   */
  app.get("/avatar/:status", async (request, reply) => {
    const status = (request.params as { status?: string }).status ?? "";
    const file = resolveSkinFile(status);
    if (!file) return reply.code(404).send({ error: "no file for this status" });

    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return reply.code(404).send({ error: "no file for this status" });
    }
    reply.type(contentTypeFor(file));
    reply.header("Accept-Ranges", "bytes");
    reply.header("Cache-Control", "no-cache");

    const range = request.headers.range;
    const match = typeof range === "string" ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (Number.isNaN(start) || start > end || start >= size) {
        reply.code(416).header("Content-Range", `bytes */${size}`);
        return reply.send();
      }
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
      reply.header("Content-Length", end - start + 1);
      return reply.send(fs.createReadStream(file, { start, end }));
    }

    reply.header("Content-Length", size);
    return reply.send(fs.createReadStream(file));
  });
}
