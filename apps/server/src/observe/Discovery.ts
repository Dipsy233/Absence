import { createHash, type Hash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AbsenceEvent } from "@absence/core";
import type { AbsenceSession, SessionStore } from "../sessions/SessionStore";
import { queueTranscriptCheckpoint, readTranscriptCheckpoint } from "../sessions/archive";
import { PiTranscriptParser } from "./parsers/pi";
import { TRANSCRIPT_SOURCES, sourceRoots, type TranscriptSourceProfile } from "./transcriptSources";
import { isNarrowScope, type ObserveMeta } from "./types";

/**
 * DiscoveryService — the observer's front door.
 *
 * It watches pi's session directory, tails the transcript files it finds, and
 * attaches each one to an AbsenceSession created on demand. The agent software
 * knows nothing about this: it writes its transcript exactly as it always did,
 * and the tail follows.
 *
 * Three states per file:
 *   - *unknown*   — the watcher saw the file; the header (session id + cwd) is
 *                   parsed, then parsing stops. A machine with months of
 *                   history must not become hundreds of live sessions, watchers
 *                   and trees at server start, so parsing goes no further.
 *   - *attached*  — a session exists: a fresh parser reads the file from byte 0
 *                   (the backfill is the transcript's whole history), and every
 *                   later write feeds the same parser incrementally, byte
 *                   offset past the last newline. Attach is explicit by default;
 *                   ABSENCE_AUTO_ATTACH=1 opts in to recent transcript capture.
 *   - *missing*   — the file was deleted; the tail keeps its row, reads nothing.
 */

/** Backfill cap. A transcript larger than this is tailed from its end. */
const MAX_BACKFILL_BYTES = 200 * 1024 * 1024;

/** How much of a transcript the backfill reads per turn of the event loop. */
const BACKFILL_CHUNK_BYTES = 1024 * 1024;

/**
 * Only transcripts modified this recently attach automatically — a session pi
 * is using right now, or one that just ended. The window is generous because
 * it is checked on scan and on every write: an old transcript that suddenly
 * moves (the user resumed it) attaches at once.
 */
const AUTO_ATTACH_WINDOW_MS = 10 * 60_000;

export interface ObserveDiscoveryRow {
  /** The agent software's own session id. */
  externalId: string;
  /** Source profile id (`pi`). */
  source: string;
  /** Agent kind recorded on the session. */
  agentKind: string;
  /** The project the transcript belongs to, when a record named one. */
  projectPath?: string;
  /** The transcript file being tailed. */
  file: string;
  /** Absence session id, once attached. */
  sessionId?: string;
  lastActivityAt: number;
  /** Delivered events (diagnostics; 0 until attached). */
  events: number;
  /** Lines that were not JSON. */
  malformed: number;
  /** The watcher reported the file gone; the row stays, nothing is read. */
  missing?: boolean;
  /** True while a whole-file backfill is still streaming in. */
  backfilling?: boolean;
  /** 0..1 progress of that backfill. */
  backfillProgress?: number;
}

interface FileTail {
  source: TranscriptSourceProfile;
  file: string;
  /** Next byte to read — always just past a newline once parsing started. */
  offset: number;
  prefixHash?: Hash;
  resumeBlocked?: boolean;
  parser: PiTranscriptParser;
  session?: AbsenceSession;
  lastActivityAt: number;
  eventCount: number;
  /** The watcher reported the file gone; the tail keeps its row, reads nothing. */
  missing?: boolean;
  feeding: boolean;
  identifying?: Promise<void>;
  attaching?: Promise<void>;
  changedWhileFeeding?: boolean;
  /** True while a whole-file backfill is still streaming in (chunked). */
  backfilling?: boolean;
  /** 0..1 progress of the backfill, for the board's row. */
  backfillProgress?: number;
}

export class DiscoveryService {
  private watcher: FSWatcher | undefined;
  private readonly tails = new Map<string, FileTail>();
  private readonly sessionsByExternal = new Map<string, AbsenceSession>();
  private started = false;

  constructor(
    private readonly store: SessionStore,
    private readonly autoAttach = process.env.ABSENCE_AUTO_ATTACH === "1",
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    const roots = [...new Set(TRANSCRIPT_SOURCES.flatMap(sourceRoots))];
    if (roots.length === 0) return;
    this.watcher = chokidar.watch(roots, {
      ignoreInitial: false,
      persistent: true,
      depth: 6,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.watcher
      .on("add", (file) => void this.onFileFound(file))
      .on("change", (file) => void this.onFileChanged(file))
      .on("unlink", (file) => void this.onFileGone(file))
      .on("error", () => {
        // A vanished root or a racing delete is not fatal: the next change
        // event reopens what matters.
      });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close().catch(() => {});
      this.watcher = undefined;
    }
    this.started = false;
    // Sessions live in the SessionStore; stopping discovery only stops watching.
  }

  list(): ObserveDiscoveryRow[] {
    return [...this.tails.values()]
      .map((tail) => this.rowFor(tail))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /**
   * The row for a file without attaching it (identity only).
   *
   * A board click needs the transcript's externalId and project to record a
   * lease before deciding *how* to attach it — a plain transcript session, or
   * an upgrade of an OS-only session already watching the same agent. This
   * parses the header (via `ensureTail`) and stops there.
   */
  async inspect(file: string): Promise<ObserveDiscoveryRow | undefined> {
    const tail = await this.ensureTail(file);
    if (!tail) return undefined;
    await this.feedForIdentity(tail);
    return this.rowFor(tail);
  }

  /**
   * Deliver a transcript's facts into an *existing* session (the OS-only upgrade).
   *
   * The session already has facts (processes, files); this adds the transcript's
   * history and then its live tail, without becoming a second session. A
   * session that already holds this transcript's history (an archive replay)
   * is warmed instead, so nothing is delivered twice. Returns false when the
   * file is not a watchable transcript on this host.
   */
  async attachInto(file: string, session: AbsenceSession): Promise<boolean> {
    const tail = await this.ensureTail(file);
    if (!tail) return false;
    if (tail.attaching) await tail.attaching;
    if (tail.session === session) return true;
    // Re-key by the transcript's own identity so a later attach() reuses this
    // session rather than opening a competing one.
    if (tail.parser.externalId !== undefined) {
      this.sessionsByExternal.set(`${tail.source.id}:${tail.parser.externalId}`, session);
    }
    tail.session = session;
    tail.missing = false;
    if (session.replayedFromArchive) await this.warmTail(tail);
    else await this.backfillTail(tail);
    await this.feedAttached(tail);
    return true;
  }

  /**
   * Explicit attach from the observation board: identify, then put the
   * transcript's history into a session — regardless of recency. Returns the
   * row, or undefined when no tail follows the file.
   */
  async attach(file: string): Promise<ObserveDiscoveryRow | undefined> {
    const tail = await this.ensureTail(file);
    if (!tail) return undefined;
    tail.missing = false;
    if (tail.session?.isDisposed()) tail.session = undefined;
    if (!tail.session || tail.attaching) await this.attachTransition(tail);
    if (tail.session) await this.feedAttached(tail);
    return this.rowFor(tail);
  }

  // --------------------------------------------------------------------------

  private isWatched(file: string): boolean {
    if (path.extname(file) !== ".jsonl") return false;
    return this.profileFor(file) !== undefined;
  }

  private profileFor(file: string): TranscriptSourceProfile | undefined {
    return TRANSCRIPT_SOURCES.find((profile) => sourceRoots(profile).some((root) => isWithin(root, file)));
  }

  /**
   * The tail for a file, created on demand.
   *
   * The watcher's add event is not the only way in: a board click or a CLI
   * `absence observe` can name a transcript the watcher has not reached yet
   * (a fresh boot, a large session directory), and a racing request must not
   * 404 because of scan order. The file must still live inside a source root
   * and exist on disk — that is what makes it this host's transcript.
   */
  private async ensureTail(file: string): Promise<FileTail | undefined> {
    const existing = this.tails.get(file);
    if (existing) return existing;
    if (!this.isWatched(file)) return undefined;
    const profile = this.profileFor(file);
    if (!profile) return undefined;
    const stat = await fsp.stat(file).catch(() => undefined);
    if (stat === undefined || !stat.isFile()) return undefined;
    const raced = this.tails.get(file);
    if (raced) return raced;
    const tail: FileTail = {
      source: profile,
      file,
      offset: 0,
      parser: new PiTranscriptParser(),
      lastActivityAt: stat.mtimeMs > 0 ? stat.mtimeMs : Date.now(),
      eventCount: 0,
      feeding: false,
    };
    this.tails.set(file, tail);
    return tail;
  }

  private rowFor(tail: FileTail): ObserveDiscoveryRow {
    return {
      externalId: tail.parser.externalId ?? path.basename(tail.file, path.extname(tail.file)),
      source: tail.source.id,
      agentKind: tail.source.agentKind,
      ...(tail.parser.cwd !== undefined ? { projectPath: tail.parser.cwd } : {}),
      file: tail.file,
      ...(tail.session !== undefined ? { sessionId: tail.session.id } : {}),
      lastActivityAt: tail.lastActivityAt,
      events: tail.eventCount,
      malformed: tail.parser.malformed,
      ...(tail.missing === true ? { missing: true } : {}),
      ...(tail.backfilling === true ? { backfilling: true } : {}),
      ...(tail.backfilling === true && tail.backfillProgress !== undefined
        ? { backfillProgress: tail.backfillProgress }
        : {}),
    };
  }

  private async onFileFound(file: string): Promise<void> {
    const created = !this.tails.has(file);
    const tail = await this.ensureTail(file);
    if (!tail || !created) return;
    await this.feedForIdentity(tail);
    // A file the agent wrote moments ago is live: attach and backfill at once.
    if (this.autoAttach && !tail.session && (await this.isRecentlyModified(tail.file))) {
      await this.attachTransition(tail);
    }
  }

  private async onFileChanged(file: string): Promise<void> {
    if (!this.isWatched(file)) return;
    let tail = this.tails.get(file);
    if (!tail) {
      await this.onFileFound(file);
      tail = this.tails.get(file);
      if (!tail) return;
    }
    tail.missing = false;
    if (tail.feeding) {
      tail.changedWhileFeeding = true;
      return;
    }
    if (tail.session?.isDisposed()) tail.session = undefined;
    if (tail.session && !tail.attaching) {
      // Attached: incremental — the parser's state continues from its offset.
      await this.feedAttached(tail);
      return;
    }
    if (!this.autoAttach) {
      await this.feedForIdentity(tail); // A partial header may only now be complete.
      tail.lastActivityAt = Date.now();
      return;
    }
    // The write itself is the recency evidence: attach and backfill now.
    await this.attachTransition(tail);
    if (tail.session) await this.feedAttached(tail);
  }

  /**
   * The attach transition: identity, session, then the transcript's history.
   *
   * A session whose history already came from its archive (re-attach after a
   * restart, or a conversation the board resumed) gets the parser **warmed**
   * instead: read from byte 0 so its tool-call state is complete, but deliver
   * nothing — replaying facts the session already holds would duplicate the
   * conversation in the chat, the archive and the report. A fresh session is
   * backfilled for real: the backfill is its history.
   */
  private async attachTransition(tail: FileTail): Promise<void> {
    if (tail.attaching) return tail.attaching;
    const operation = (async () => {
      await this.feedForIdentity(tail);
      if (tail.session) return;
      const session = await this.ensureSession(tail);
      if (!session) return;
      if (session.replayedFromArchive) await this.warmTail(tail);
      else await this.backfillTail(tail);
      await this.feedAttached(tail);
    })();
    tail.attaching = operation;
    try {
      await operation;
    } finally {
      tail.attaching = undefined;
    }
  }

  private async onFileGone(file: string): Promise<void> {
    const tail = this.tails.get(file);
    if (tail) tail.missing = true;
  }

  private async isRecentlyModified(file: string): Promise<boolean> {
    const stat = await fsp.stat(file).catch(() => undefined);
    return stat !== undefined && Date.now() - stat.mtimeMs <= AUTO_ATTACH_WINDOW_MS;
  }

  /**
   * Parse new lines only until identity is known (session id + cwd from the
   * header). Everything past that stays unparsed until the transcript
   * attaches; identity alone is what the observation board's row needs.
   */
  private async feedForIdentity(tail: FileTail): Promise<void> {
    if (tail.identifying) return tail.identifying;
    if (tail.feeding || tail.missing) return;
    if (tail.parser.externalId !== undefined && tail.parser.cwd !== undefined) return;
    tail.identifying = this.readIdentity(tail);
    try {
      await tail.identifying;
    } finally {
      tail.identifying = undefined;
    }
  }

  private async readIdentity(tail: FileTail): Promise<void> {
    const text = await this.readNewLines(tail, 8192, true);
    if (text === undefined) return;
    for (const line of text.split("\n")) {
      await tail.parser.feed(line);
      if (tail.parser.externalId !== undefined && tail.parser.cwd !== undefined) break;
    }
    tail.lastActivityAt = Date.now();
  }

  /** Attached mode: feed new lines to the session's parser and deliver. */
  private async feedAttached(tail: FileTail): Promise<void> {
    if (tail.feeding || tail.missing || tail.resumeBlocked) return;
    if (!tail.session) return;
    tail.feeding = true;
    tail.changedWhileFeeding = false;
    try {
      const text = await this.readNewLines(tail);
      if (text === undefined) return;
      for (const line of text.split("\n")) {
        await tail.parser.feed(line);
      }
      tail.lastActivityAt = Date.now();
      const events = tail.parser.drain();
      if (events.length > 0) this.deliver(tail, events);
      this.checkpoint(tail);
    } finally {
      tail.feeding = false;
      if (tail.changedWhileFeeding) await this.feedAttached(tail);
    }
  }

  /**
   * The attach transition for a fresh session: a fresh parser reads the file
   * from byte 0 — the backfill is the transcript's whole history — and
   * delivers everything to the session.
   */
  private async backfillTail(tail: FileTail): Promise<void> {
    await this.rereadTail(tail, true);
  }

  /**
   * The attach transition for a session whose history is already in place
   * (archive replay): same fresh read from byte 0 — the parser's tool-call
   * state must be complete for the lines still to come — but the parsed
   * facts up to the verified checkpoint are discarded instead of delivered.
   * Archives from older versions have no checkpoint: warm silently once.
   */
  private async warmTail(tail: FileTail): Promise<void> {
    await this.rereadTail(tail, false);
  }

  /**
   * The whole-file backfill, read in bounded chunks.
   *
   * A transcript can be hundreds of megabytes; reading it in one Buffer would
   * stall the event loop (and every socket) for the whole parse. Each chunk is
   * read, parsed and then the loop yields, so the board stays responsive and the
   * row can show how far the backfill has come. A file past MAX_BACKFILL_BYTES
   * is still tailed from its end, honestly (see `readNewLines`).
   */
  private async rereadTail(tail: FileTail, deliver: boolean): Promise<void> {
    if (!tail.session) return;
    tail.feeding = true;
    tail.session.setBackfilling(true);
    tail.backfilling = true;
    tail.backfillProgress = 0;
    try {
      tail.parser = new PiTranscriptParser();
      tail.offset = 0;
      tail.resumeBlocked = false;
      const size = (await fsp.stat(tail.file).catch(() => undefined))?.size ?? 0;
      const total = size > MAX_BACKFILL_BYTES ? 0 : size;
      const saved = deliver ? undefined : readTranscriptCheckpoint(tail.session.id);
      if (saved && (saved.offset > size || total === 0)) {
        tail.resumeBlocked = true;
        return;
      }
      let verifyAt = saved?.offset;
      tail.prefixHash = total > 0 ? createHash("sha256") : undefined;
      for (;;) {
        const text = await this.readNewLines(tail, BACKFILL_CHUNK_BYTES, false, verifyAt);
        if (text === undefined) break;
        for (const line of text.split("\n")) {
          await tail.parser.feed(line);
        }
        const events = tail.parser.drain();
        if (deliver) {
          if (events.length > 0) this.deliver(tail, events);
          this.checkpoint(tail);
        }
        if (verifyAt !== undefined && tail.offset === verifyAt) {
          deliver = tail.prefixHash?.copy().digest("hex") === saved?.digest;
          verifyAt = undefined;
          if (!deliver) break;
        }
        tail.backfillProgress = total > 0 ? Math.min(1, tail.offset / total) : 0;
        // Yield to the event loop between chunks: the backfill must not block
        // live writes, sockets or the idle sweep.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (!saved || deliver) this.checkpoint(tail);
      else {
        // A rewritten/truncated prefix must not be merged into this archive.
        tail.resumeBlocked = true;
        tail.prefixHash = undefined;
      }
      tail.lastActivityAt = Date.now();
    } finally {
      tail.feeding = false;
      tail.session.setBackfilling(false);
      tail.session.setTranscriptResumeBlocked(tail.resumeBlocked === true);
      tail.backfilling = false;
      tail.backfillProgress = undefined;
    }
  }

  /**
   * Read complete new lines past the tail's offset. Returns the text up to and
   * including the last newline, or undefined when there is nothing complete to
   * read — a partial trailing line is the writer's mid-flight flush and is
   * replayed next time.
   */
  private async readNewLines(tail: FileTail, maxBytes?: number, identityOnly = false, endOffset = Infinity): Promise<string | undefined> {
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(tail.file);
    } catch {
      return undefined; // A racing delete: the next change event retries.
    }
    if (stat.size <= tail.offset) return undefined;
    if (!identityOnly && tail.offset === 0 && stat.size > MAX_BACKFILL_BYTES) {
      // Too large to backfill: observe from the end, honestly.
      tail.offset = stat.size;
      return undefined;
    }
    try {
      const handle = await fsp.open(tail.file, "r");
      try {
        const available = Math.min(stat.size, endOffset) - tail.offset;
        const chunks: Buffer[] = [];
        let read = 0;
        while (read < available) {
          const buffer = Buffer.allocUnsafe(Math.min(maxBytes ?? available, available - read));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, tail.offset + read);
          if (!bytesRead) break;
          const chunk = buffer.subarray(0, bytesRead);
          const newline = chunk.lastIndexOf(0x0a);
          if (newline >= 0) {
            chunks.push(chunk.subarray(0, newline + 1));
            tail.offset += read + newline + 1;
            const raw = Buffer.concat(chunks);
            tail.prefixHash?.update(raw);
            return raw.toString("utf8");
          }
          // A single JSON record (e.g. a tool result) can span several chunks.
          chunks.push(chunk);
          read += bytesRead;
        }
        return undefined;
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }

  /** Create the session on first identity. Idempotent per (channel, externalId). */
  private async ensureSession(tail: FileTail): Promise<AbsenceSession | undefined> {
    if (tail.session) return tail.session;
    const parser = tail.parser;
    if (parser.externalId === undefined || parser.cwd === undefined) return;
    const key = `${tail.source.id}:${parser.externalId}`;
    const existing = this.sessionsByExternal.get(key);
    if (existing !== undefined) {
      if (!existing.isDisposed()) {
        tail.session = existing;
        return existing;
      }
      // The session was closed from under us (the board's ✕, a teardown):
      // forget it, or this map would feed a dead session forever and the
      // transcript could never be watched again.
      this.sessionsByExternal.delete(key);
    }
    const observe: ObserveMeta = {
      channel: "transcript",
      externalId: parser.externalId,
      transcriptFile: tail.file,
      // A transcript whose cwd is the home directory (or a drive root) names
      // no watchable project: facts only, no tree, no file watcher.
      watchProject: isNarrowScope(parser.cwd),
    };
    const session = await this.store.createObserved(parser.cwd, tail.source.agentKind, observe);
    this.sessionsByExternal.set(key, session);
    tail.session = session;
    return session;
  }

  private checkpoint(tail: FileTail): void {
    const session = tail.session;
    if (!session || session.isDisposed() || !tail.prefixHash || tail.offset === 0) return;
    queueTranscriptCheckpoint(session.session.projectPath, session.id, {
      offset: tail.offset,
      digest: tail.prefixHash.copy().digest("hex"),
    });
  }

  /** Re-stamp events with the Absence session id and push them into the pipeline. */
  private deliver(tail: FileTail, events: AbsenceEvent[]): void {
    const session = tail.session;
    if (!session) return;
    for (const event of events) {
      const stamped = event.sessionId === session.id ? event : { ...event, sessionId: session.id };
      tail.eventCount += 1;
      session.ingestObservation(stamped);
    }
  }
}

function isWithin(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The first user prompt in a transcript, for a board row's subtitle.
 *
 * Reads only the head of the file (a running session's opening prompt is near
 * the top) and stops as soon as it is found. Cached on (mtime, size) so the
 * board's 4 s refresh does not re-read unchanged files; a growing transcript
 * re-reads only its small head. Purely cosmetic — failures yield `undefined`.
 */
const firstPromptCache = new Map<string, { mtimeMs: number; size: number; prompt?: string }>();

export async function readFirstUserPrompt(file: string, maxBytes = 128 * 1024): Promise<string | undefined> {
  const stat = await fsp.stat(file).catch(() => undefined);
  if (stat === undefined || !stat.isFile()) return undefined;
  const cached = firstPromptCache.get(file);
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.prompt;
  }
  let prompt: string | undefined;
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(file, "r");
    const parser = new PiTranscriptParser();
    let offset = 0;
    let carry = "";
    while (offset < maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(16 * 1024, maxBytes - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      const lines = (carry + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        await parser.feed(line);
        if (parser.firstUserPrompt !== undefined) break;
      }
      if (parser.firstUserPrompt !== undefined) break;
    }
    prompt = parser.firstUserPrompt;
  } catch {
    prompt = undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  firstPromptCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, prompt });
  return prompt;
}
