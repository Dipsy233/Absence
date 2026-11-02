import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { SessionHistoryEntry } from "@absence/core";
import type { AgentKind } from "../config";
import { config } from "../config";
import {
  deleteArchive,
  listArchives,
  queryArchives,
  readEventsPage,
  readEventsPageForward,
  readFileVersionContent,
  readFileVersions,
  readFileVersionSummaries,
  readMeta,
  readRunEvents,
  readRunEventsPage,
  readRuns,
} from "../sessions/archive";
import { sessionStore, RuntimeUnavailableError } from "../sessions/SessionStore";
import { hasAdapter } from "../agents/registry";
import { getProfile } from "../agents/acp/AgentCatalog";
import { toPosix } from "../util/paths";
import { takeTerminalMirror } from "../sessions/terminalRegistry";

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function resolveAgent(value: string | undefined): AgentKind {
  const kind = value?.trim();
  // An ACP profile is a runtime kind too: accept any id the registry can
  // build, or any profile the catalog knows (including ~/.absence/agents.json),
  // instead of hard-coding the built-ins here (that was coupling).
  if (kind && (hasAdapter(kind) || getProfile(kind) !== undefined)) return kind;
  return config.defaultAgent;
}

/** A query-string positive integer, or undefined when absent/invalid. */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** A query-string non-negative integer, or undefined when absent/invalid. */
function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** Session lifecycle API (read.md §31–32). */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The persisted history: ABSENCE archives, newest first. This is what
   * survives a restart.
   *
   *   ?path=<dir>      exact project filter (kept from the original route)
   *   ?search=<text>   substring match over name, path and first prompt
   *   ?runtime=<id>    exact runtime filter
   *   ?since=<ms>      updatedAt >= since
   *   ?until=<ms>      updatedAt <= until
   *   ?limit=<n>       page size (1..200) — turns on page mode
   *   ?cursor=<key>    nextCursor from the previous page
   *
   * Without `limit`/`cursor` the response is the original entry array, so the
   * existing client keeps working. With them it is a page object:
   * `{ entries, nextCursor, hasMore }` — the cursor encodes the sort key and
   * id of the last row, so paging is stable while new sessions arrive.
   */
  app.get("/api/sessions/history", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const since = parsePositiveInt(q.since);
    if (q.since !== undefined && since === undefined) {
      return reply.code(400).send({ error: "since must be a positive integer" });
    }
    const until = parsePositiveInt(q.until);
    if (q.until !== undefined && until === undefined) {
      return reply.code(400).send({ error: "until must be a positive integer" });
    }
    const limit = parsePositiveInt(q.limit);
    if (q.limit !== undefined && limit === undefined) {
      return reply.code(400).send({ error: "limit must be a positive integer" });
    }
    const pathFilter = q.path?.trim();
    const query = {
      ...(pathFilter ? { path: pathFilter } : {}),
      ...(q.search?.trim() ? { search: q.search } : {}),
      ...(q.runtime?.trim() ? { runtime: q.runtime } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    };
    const filtered = Object.keys(query).length > 0;

    // Page mode: exactly what the query asked for, plus the next cursor.
    if (limit !== undefined || q.cursor !== undefined) {
      return queryArchives({ ...query, ...(limit !== undefined ? { limit } : {}), ...(q.cursor ? { cursor: q.cursor } : {}) });
    }
    // Filtered without pagination: still routed through the SQL query, capped
    // so a runaway filter cannot serialise the whole table. Page mode is the
    // complete answer when a client needs more.
    if (filtered) {
      return (await queryArchives({ ...query, limit: 200 })).entries;
    }
    // The original behaviour, byte for byte: every archive, newest first.
    return sessionHistory(pathFilter || undefined);
  });

  app.post("/api/sessions", async (request, reply) => {
    const body = request.body as
      | {
          projectPath?: string;
          agent?: string;
          resume?: { absenceSessionId?: string };
        }
      | undefined;
    const projectPath = body?.projectPath?.trim();
    if (!projectPath) {
      return reply.code(400).send({ error: "projectPath is required" });
    }
    const resolved = toPosix(path.resolve(projectPath));
    if (!(await isDirectory(resolved))) {
      return reply.code(400).send({ error: `not a directory: ${resolved}` });
    }
    const resumeId = body?.resume?.absenceSessionId?.trim();
    const resume = resumeId ? { absenceSessionId: resumeId } : undefined;
    const session = await (async () => {
      try {
        return await sessionStore.create(resolved, resolveAgent(body?.agent), resume);
      } catch (error) {
        // The runtime would not start (not installed / bad path / no
        // credentials). Surface it to the picker instead of a bare 500.
        if (error instanceof RuntimeUnavailableError) {
          return reply.code(503).send({ error: error.message, runtime: error.runtime });
        }
        throw error;
      }
    })();
    if (!session) return reply;
    return session.snapshot();
  });

  /**
   * Watch an agent that is already running, instead of starting one.
   *
   * This is the entry point that makes Absence an observer rather than a
   * client: any process — any agent, any version — can be watched by its pid,
   * with no adapter and no knowledge of its internals. `absence watch` uses it.
   */
  app.post("/api/sessions/observe", async (request, reply) => {
    const body = request.body as
      | { projectPath?: string; pid?: number; label?: string; transcript?: string }
      | undefined;
    const pid = Number(body?.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return reply.code(400).send({ error: "pid is required" });
    }
    const projectPath = body?.projectPath?.trim();
    if (!projectPath) {
      return reply.code(400).send({ error: "projectPath is required" });
    }
    const resolved = toPosix(path.resolve(projectPath));
    if (!(await isDirectory(resolved))) {
      return reply.code(400).send({ error: `not a directory: ${resolved}` });
    }
    try {
      // A mirror registered by the same process (the CLI's `watch -- cmd`) is
      // handed over here: the pid is the only shared key, and the HTTP body
      // cannot carry an object. An agent somebody else started has none.
      const terminal = takeTerminalMirror(pid);
      const session = await sessionStore.createObserved(
        resolved,
        pid,
        body?.label,
        terminal,
        body?.transcript,
      );
      return session.snapshot();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const query = (request.query ?? {}) as { eventLimit?: string };
    const eventLimit = parsePositiveInt(query.eventLimit);
    if (query.eventLimit !== undefined && eventLimit === undefined) {
      return reply.code(400).send({ error: "eventLimit must be a positive integer" });
    }
    return session.snapshot({ eventLimit });
  });

  /**
   * The file-version index: every version the agent held, independent of the
   * event window. Agent Folder and File History read this directly.
   */
  app.get("/api/sessions/:id/file-versions", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionStore.get(id) && !(await readMeta("", id))) {
      return reply.code(404).send({ error: "session not found" });
    }
    return readFileVersions(id);
  });

  /**
   * Run summaries for History. Small enough to send all at once for a normal
   * session (tens of runs); the events for one run are fetched separately.
   */
  app.get("/api/sessions/:id/runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionStore.get(id) && !(await readMeta("", id))) {
      return reply.code(404).send({ error: "session not found" });
    }
    return readRuns(id);
  });

  /**
   * One run's summary only — the outline row without any event body. A client
   * can size the run (`eventCount`) and decide how it wants to page its
   * events before downloading any.
   */
  app.get("/api/sessions/:id/runs/:index", async (request, reply) => {
    const { id, index } = request.params as { id: string; index: string };
    const runIndex = parsePositiveInt(index);
    if (runIndex === undefined) {
      return reply.code(400).send({ error: "run index must be a positive integer" });
    }
    if (!sessionStore.get(id) && !(await readMeta("", id))) {
      return reply.code(404).send({ error: "session not found" });
    }
    const run = (await readRuns(id)).find((candidate) => candidate.index === runIndex);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return { run };
  });

  /**
   * One run's summary and events, by the 1-based index History shows.
   *
   *   ?after=<seq>     forward cursor from the previous page's nextAfter
   *   ?limit=<n>       page size (1..2000)
   *
   * Without them the whole run arrives at once (the original shape, kept for
   * the current client). With them the response is
   * `{ run, events, nextAfter, hasMore }`: each page is rendered as it
   * arrives, so a run with tens of thousands of observed events never has to
   * be parsed whole.
   */
  app.get("/api/sessions/:id/runs/:index/events", async (request, reply) => {
    const { id, index } = request.params as { id: string; index: string };
    const runIndex = parsePositiveInt(index);
    if (runIndex === undefined) {
      return reply.code(400).send({ error: "run index must be a positive integer" });
    }
    if (!sessionStore.get(id) && !(await readMeta("", id))) {
      return reply.code(404).send({ error: "session not found" });
    }
    const run = (await readRuns(id)).find((candidate) => candidate.index === runIndex);
    if (!run) return reply.code(404).send({ error: "run not found" });

    const query = (request.query ?? {}) as { after?: string; limit?: string };
    const after = parsePositiveInt(query.after);
    if (query.after !== undefined && after === undefined) {
      return reply.code(400).send({ error: "after must be a positive integer" });
    }
    const limit = parsePositiveInt(query.limit);
    if (query.limit !== undefined && limit === undefined) {
      return reply.code(400).send({ error: "limit must be a positive integer" });
    }
    if (after !== undefined || limit !== undefined) {
      const page = await readRunEventsPage(id, run.fromSeq, run.toSeq, { after, limit });
      return { run, ...page };
    }
    return { run, events: await readRunEvents(id, run.fromSeq, run.toSeq) };
  });

  /**
   * Persisted events, newest page first when `before` is omitted.
   *
   *   ?limit=500          page size (1..2000)
   *   ?before=<seq>       exclusive cursor from the previous page's nextBefore
   *   ?after=<seq>        exclusive forward cursor (catch-up direction);
   *                       mutually exclusive with `before`
   *
   * Returns `{ events, nextBefore, hasMore }` paging backwards, or
   * `{ events, nextAfter, hasMore }` paging forwards, with events
   * chronological inside the page. A live session and an archived one are
   * served the same way; the database is the source of history either way.
   */
  app.get("/api/sessions/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as { before?: string; after?: string; limit?: string };
    const before = parsePositiveInt(query.before);
    if (query.before !== undefined && before === undefined) {
      return reply.code(400).send({ error: "before must be a positive integer" });
    }
    const after = parsePositiveInt(query.after);
    if (query.after !== undefined && after === undefined) {
      return reply.code(400).send({ error: "after must be a positive integer" });
    }
    if (before !== undefined && after !== undefined) {
      return reply.code(400).send({ error: "before and after are mutually exclusive" });
    }
    const limit = parsePositiveInt(query.limit);
    if (query.limit !== undefined && limit === undefined) {
      return reply.code(400).send({ error: "limit must be a positive integer" });
    }
    // A live session is in the store; a historical one only needs its archive
    // row. `readMeta` takes a cwd for compatibility, but the id is global.
    if (!sessionStore.get(id) && !(await readMeta("", id))) {
      return reply.code(404).send({ error: "session not found" });
    }
    if (after !== undefined) {
      return readEventsPageForward(id, { after, limit });
    }
    return readEventsPage(id, { before, limit });
  });

  /**
   * The file-version outline: every version, without full contents. Each row
   * carries its size and a short preview; the text itself is fetched per
   * version from /file-versions/content. This is what an outline or a large
   * listing should read — /file-versions stays for the current client, which
   * wants the text inline.
   */
  app.get("/api/sessions/:id/file-versions/index", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionStore.get(id) && !(await readMeta("", id))) {
      return reply.code(404).send({ error: "session not found" });
    }
    return readFileVersionSummaries(id);
  });

  /**
   * One file version's full content, by its exact (path, version) key. This is
   * the read side of payload previews: an event row stores the head of a
   * value; this returns the whole thing the FileIndex materialised from the
   * same event.
   */
  app.get("/api/sessions/:id/file-versions/content", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as { path?: string; version?: string };
    const filePath = query.path?.trim();
    // Version 0 is legitimate: it is the accumulated read-version before the
    // first write, so this key is non-negative, not positive.
    const version = parseNonNegativeInt(query.version);
    if (!filePath) return reply.code(400).send({ error: "path is required" });
    if (version === undefined) return reply.code(400).send({ error: "version is required" });
    if (!sessionStore.get(id) && !(await readMeta("", id))) {
      return reply.code(404).send({ error: "session not found" });
    }
    const info = await readFileVersionContent(id, filePath, version);
    if (!info) return reply.code(404).send({ error: "file version not found" });
    return info;
  });

  /**
   * Read a file from the project on demand. This backs the *user* view of the
   * project (the agent view only ever knows what it has touched).
   */
  app.get("/api/sessions/:id/file", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });

    const relative = (request.query as { path?: string } | undefined)?.path;
    if (!relative) return reply.code(400).send({ error: "path is required" });

    const root = path.resolve(session.session.projectPath);
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      return reply.code(400).send({ error: "path escapes the project" });
    }

    const MAX_BYTES = 512 * 1024;
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) return reply.code(400).send({ error: "not a file" });
      if (stat.size > MAX_BYTES) {
        return reply.code(413).send({ error: `file is too large (${stat.size} bytes)` });
      }
      const buffer = await fs.readFile(absolute);
      if (buffer.includes(0)) return reply.code(415).send({ error: "binary file" });
      return { path: relative, content: buffer.toString("utf-8"), size: stat.size };
    } catch {
      return reply.code(404).send({ error: "file not found" });
    }
  });

  // Fastify's default bodyLimit is 1 MiB. A pasted stack trace or a long
  // file excerpt is a legitimate prompt, so this one route accepts 8 MiB;
  // everything else keeps the default.
  app.post("/api/sessions/:id/prompt", { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const body = request.body as { prompt?: string } | undefined;
    const prompt = body?.prompt;
    if (!prompt || !prompt.trim()) {
      return reply.code(400).send({ error: "prompt is required" });
    }
    session.prompt(prompt);
    return { ok: true };
  });

  app.post("/api/sessions/:id/abort", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    await session.abort();
    return { ok: true };
  });

  /**
   * Answer an approval prompt the agent raised (the `approval` event). `value`
   * is one of that event's option values; it unblocks the runtime request.
   */
  app.post("/api/sessions/:id/approval", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const body = request.body as { id?: string; value?: string } | undefined;
    const approvalId = body?.id?.trim();
    const value = body?.value?.trim();
    if (!approvalId || !value) {
      return reply.code(400).send({ error: "id and value are required" });
    }
    await session.respondApproval(approvalId, value);
    return { ok: true };
  });

  /**
   * Forward a `/…` line (`/model`, `/skill:<name>`, `/mcp`, …). The agent owns
   * their meaning; Absence only forwards the text as a prompt. `/auth` is the
   * one ACP-native action Absence performs. The result streams back over the
   * WebSocket as normal run events; this call only reports that it ran.
   */
  app.post("/api/sessions/:id/command", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionStore.get(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const body = request.body as { text?: string; name?: string; args?: string } | undefined;
    const text = body?.text?.trim();
    if (text) {
      session.forwardCommand(text);
      return { ok: true };
    }
    const name = body?.name?.trim();
    if (!name) return reply.code(400).send({ error: "text or name is required" });
    await session.runCommand(name, body?.args ?? "");
    return { ok: true };
  });

  /**
   * Leave the session without deleting it.
   *
   * "Change project" means the user is done watching this agent. The live
   * session is what owns the metrics sampler, the process watcher and the
   * runtime; leaving it in the store would keep sampling a process tree nobody
   * is looking at and keep appending frames to the database forever. Disposing
   * it flushes what it has and stops the cadence, while the archive and the
   * metric chunks stay on disk so reopening the session later gets its whole
   * history back.
   */
  app.post("/api/sessions/:id/close", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionStore.get(id)) {
      // Already closed (or the server restarted): the desired state holds.
      return { ok: true };
    }
    await sessionStore.remove(id);
    return { ok: true };
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionStore.get(id)) return reply.code(404).send({ error: "session not found" });
    await sessionStore.remove(id);
    return { ok: true };
  });

  /**
   * Delete one archived session's persisted state — events, runs, file
   * versions, metrics and the header row. This is the only way history ever
   * shrinks; without it the archive grows unbounded on a machine that watches
   * agents every day.
   *
   * A live session must be closed first (`POST /close`): while it is open the
   * next event flush would silently recreate the rows, and the caller would
   * believe a deletion happened that did not stick.
   */
  app.delete("/api/sessions/:id/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (sessionStore.get(id)) {
      return reply.code(409).send({ error: "session is open; close it before deleting its archive" });
    }
    let deleted: boolean;
    try {
      deleted = await deleteArchive(id);
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
    if (!deleted) return reply.code(404).send({ error: "archive not found" });
    return { ok: true };
  });
}

/**
 * The persisted history: Absence's own archives, newest first. `?path=` narrows
 * it to one project. This is what survives a restart; no agent-private session
 * files are read or merged. Resuming by `absenceSessionId` reconnects the
 * agent's own conversation from the ACP handle stored in the archive.
 */
async function sessionHistory(projectPath?: string): Promise<SessionHistoryEntry[]> {
  const entries: SessionHistoryEntry[] = [];
  for (const meta of await listArchives(projectPath)) {
    entries.push({
      id: meta.absenceSessionId,
      absenceSessionId: meta.absenceSessionId,
      projectPath: meta.projectPath,
      projectName: meta.projectName,
      createdAt: meta.startedAt,
      updatedAt: meta.updatedAt,
      messageCount: meta.messageCount,
      firstPrompt: meta.firstPrompt,
      runtime: meta.runtime,
      archived: true,
    });
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}
