import type { FastifyInstance } from "fastify";
import {
  activateSet,
  contentTypeFor,
  createSet,
  deleteSet,
  deleteSetFile,
  getActiveName,
  getSet,
  listSets,
  resolveSetFile,
  saveSetFile,
  soundsDir,
} from "../process/sounds";
import fs from "node:fs";

/**
 * Sound sets: user-uploaded chimes managed from the Settings dialog, shaped
 * exactly like avatar skins. The client picks an event and PUTs the raw file
 * bytes; the file becomes that event's chime inside the set's folder. The
 * active set's files are served at /sound/<event> so the web app never touches
 * the filesystem.
 */
export async function soundRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the editor needs: sets, the active one, and its files. */
  app.get("/api/sounds", async () => {
    const active = getActiveName();
    return {
      dir: soundsDir,
      active,
      builtin: "Default",
      sets: listSets(),
      activeFiles: active ? getSet(active)?.files ?? {} : {},
    };
  });

  /** Create an empty set folder (a new set of chimes). */
  app.post("/api/sounds/:name", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    try {
      return { ok: true, set: createSet(name) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Upload one file: ?event=complete with the raw bytes as the body. */
  app.put("/api/sounds/:name/files", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    const query = request.query as { event?: string; filename?: string };
    const event = query.event ?? "";
    const originalName = query.filename || `${event}.bin`;
    const body = request.body as Buffer | undefined;
    if (!body || !Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: "request body must be the raw file bytes" });
    }
    try {
      const set = saveSetFile(name, event, originalName, body);
      return { ok: true, set };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Remove one event's file from a set. */
  app.delete("/api/sounds/:name/files/:event", async (request, reply) => {
    const { name, event } = request.params as { name?: string; event?: string };
    try {
      const set = deleteSetFile(name ?? "", event ?? "");
      return { ok: true, set };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Delete a whole sound-set folder. */
  app.delete("/api/sounds/:name", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    if (!deleteSet(name)) return reply.code(404).send({ error: `sound set not found: ${name}` });
    return { ok: true };
  });

  /** Activate a set; the name "Default" (or empty) restores the synth chimes. */
  app.post("/api/sounds/:name/activate", async (request, reply) => {
    const name = (request.params as { name?: string }).name ?? "";
    try {
      activateSet(name);
      return { ok: true, active: getActiveName() };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * Serve the active set's audio at /sound/<event>. 404 (not a builtin
   * fallback) so the web app can tell "no upload" apart from "bad bytes" and
   * fall back to the synthesised chime for that event. An optional ?set=<name>
   * auditions a specific set's file (the Settings preview button).
   *
   * Supports HTTP Range requests for the same reason as videos: browsers may
   * seek within an audio element, and a missing 206 can stall playback.
   */
  app.get("/sound/:event", async (request, reply) => {
    const event = (request.params as { event?: string }).event ?? "";
    const query = request.query as { set?: string };
    const file = resolveSetFile(event, query.set ?? undefined);
    if (!file) return reply.code(404).send({ error: "no file for this event" });

    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return reply.code(404).send({ error: "no file for this event" });
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
