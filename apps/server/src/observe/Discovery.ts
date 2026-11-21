import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AbsenceEvent } from "@absence/core";
import type { AbsenceSession, SessionStore } from "../sessions/SessionStore";
import { PiTranscriptParser } from "./parsers/pi";
import { TRANSCRIPT_SOURCES, sourceRoots, type TranscriptSourceProfile } from "./transcriptSources";
import type { ObserveMeta } from "./types";

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
 *                   offset past the last newline. Attach happens automatically
 *                   while pi touched the file recently (AUTO_ATTACH_WINDOW_MS),
 *                   or explicitly via `attach()` — the board's click-to-monitor.
 *   - *missing*   — the file was deleted; the tail keeps its row, reads nothing.
 */

/** Backfill cap. A transcript larger than this is tailed from its end. */
const MAX_BACKFILL_BYTES = 200 * 1024 * 1024;

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
}

interface FileTail {
  source: TranscriptSourceProfile;
  file: string;
  /** Next byte to read — always just past a newline once parsing started. */
  offset: number;
  parser: PiTranscriptParser;
  session?: AbsenceSession;
  lastActivityAt: number;
  eventCount: number;
  /** The watcher reported the file gone; the tail keeps its row, reads nothing. */
  missing?: boolean;
  feeding: boolean;
}

export class DiscoveryService {
  private watcher: FSWatcher | undefined;
  private readonly tails = new Map<string, FileTail>();
  private readonly sessionsByExternal = new Map<string, AbsenceSession>();
  private started = false;

  constructor(private readonly store: SessionStore) {}

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
   * Explicit attach from the observation board: identify, then backfill the
   * transcript's whole history into a session — regardless of recency.
   * Returns the row, or undefined when no tail follows the file.
   */
  async attach(file: string): Promise<ObserveDiscoveryRow | undefined> {
    const tail = this.tails.get(file);
    if (!tail) return undefined;
    tail.missing = false;
    if (!tail.session) {
      await this.feedForIdentity(tail);
      await this.ensureSession(tail, true);
      if (!tail.session) return this.rowFor(tail); // identity never arrived; nothing to attach
      await this.backfillTail(tail);
    } else {
      await this.feedAttached(tail);
    }
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
    };
  }

  private async onFileFound(file: string): Promise<void> {
    if (!this.isWatched(file)) return;
    const profile = this.profileFor(file);
    if (!profile || this.tails.has(file)) return;
    const tail: FileTail = {
      source: profile,
      file,
      offset: 0,
      parser: new PiTranscriptParser(),
      lastActivityAt: Date.now(),
      eventCount: 0,
      feeding: false,
    };
    this.tails.set(file, tail);
    await this.feedForIdentity(tail);
    // A file the agent wrote moments ago is live: attach and backfill at once.
    if (!tail.session && (await this.isRecentlyModified(tail.file))) {
      await this.ensureSession(tail, true);
      if (tail.session) await this.backfillTail(tail);
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
    if (tail.session) {
      // Attached: incremental — the parser's state continues from its offset.
      await this.feedAttached(tail);
      return;
    }
    await this.feedForIdentity(tail);
    // The write itself is the recency evidence: attach and backfill now.
    if (!tail.session) {
      await this.ensureSession(tail, true);
      if (tail.session) await this.backfillTail(tail);
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
    if (tail.feeding || tail.missing) return;
    if (tail.parser.externalId !== undefined && tail.parser.cwd !== undefined) return;
    tail.feeding = true;
    try {
      const text = await this.readNewLines(tail);
      if (text === undefined) return;
      for (const line of text.split("\n")) {
        await tail.parser.feed(line);
        if (tail.parser.externalId !== undefined && tail.parser.cwd !== undefined) break;
      }
      tail.lastActivityAt = Date.now();
    } finally {
      tail.feeding = false;
    }
  }

  /** Attached mode: feed new lines to the session's parser and deliver. */
  private async feedAttached(tail: FileTail): Promise<void> {
    if (tail.feeding || tail.missing) return;
    if (!tail.session) return;
    tail.feeding = true;
    try {
      const text = await this.readNewLines(tail);
      if (text === undefined) return;
      for (const line of text.split("\n")) {
        await tail.parser.feed(line);
      }
      tail.lastActivityAt = Date.now();
      const events = tail.parser.drain();
      if (events.length > 0) this.deliver(tail, events);
    } finally {
      tail.feeding = false;
    }
  }

  /**
   * The attach transition: a fresh parser reads the file from byte 0 — the
   * backfill is the transcript's whole history — and delivers everything to
   * the session.
   */
  private async backfillTail(tail: FileTail): Promise<void> {
    if (!tail.session) return;
    tail.feeding = true;
    try {
      tail.parser = new PiTranscriptParser();
      tail.offset = 0;
      const text = await this.readNewLines(tail);
      if (text === undefined) return;
      for (const line of text.split("\n")) {
        await tail.parser.feed(line);
      }
      tail.lastActivityAt = Date.now();
      const events = tail.parser.drain();
      if (events.length > 0) this.deliver(tail, events);
    } finally {
      tail.feeding = false;
    }
  }

  /**
   * Read complete new lines past the tail's offset. Returns the text up to and
   * including the last newline, or undefined when there is nothing complete to
   * read — a partial trailing line is the writer's mid-flight flush and is
   * replayed next time.
   */
  private async readNewLines(tail: FileTail): Promise<string | undefined> {
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(tail.file);
    } catch {
      return undefined; // A racing delete: the next change event retries.
    }
    if (stat.size <= tail.offset) return undefined;
    if (tail.offset === 0 && stat.size > MAX_BACKFILL_BYTES) {
      // Too large to backfill: observe from the end, honestly.
      tail.offset = stat.size;
      return undefined;
    }
    try {
      const handle = await fsp.open(tail.file, "r");
      try {
        const length = stat.size - tail.offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, tail.offset);
        const lastNewline = buffer.lastIndexOf(0x0a);
        if (lastNewline === -1) return undefined;
        tail.offset += lastNewline + 1;
        return buffer.subarray(0, lastNewline + 1).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }

  /** Create the session on first identity. Idempotent per (channel, externalId). */
  private async ensureSession(tail: FileTail, force: boolean): Promise<void> {
    if (tail.session) return;
    const parser = tail.parser;
    if (parser.externalId === undefined || parser.cwd === undefined) return;
    const key = `${tail.source.id}:${parser.externalId}`;
    const existing = this.sessionsByExternal.get(key);
    if (existing) {
      tail.session = existing;
      return;
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
 * True when the path is a project-sized scope worth watching: not the user's
 * home directory itself and not a drive root. Everything else gets transcript
 * facts only (see `ObserveMeta.watchProject`).
 */
function isNarrowScope(projectPath: string): boolean {
  const resolved = path.resolve(projectPath);
  const parsed = path.parse(resolved);
  if (parsed.root === resolved) return false;
  if (resolved === path.resolve(os.homedir())) return false;
  return true;
}
