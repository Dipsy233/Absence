/* ══════════════════════════════════════════════════════════════════════════
   REST payload contracts — the response bodies (and a couple of request
   bodies) the server answers with and the browser's api layer parses.

   The session/event types already live in `types`/`events`/`runs`/`metrics`;
   these are the smaller payloads the settings surfaces use (runtimes, egg
   filter profiles, avatar skins, sound sets) plus the file-read and resume
   shapes. They used to be declared twice — once beside the server route, once
   beside the client fetch — and stayed equal only by hand.
   ══════════════════════════════════════════════════════════════════════════ */

import type { ObserveChannel } from "./types";

/** The agent runtimes Absence can drive. ACP agents are data profiles, so the type is open. */
export type RuntimeKind = "pi" | "codex" | "dsh" | "mock" | (string & {});

/** One agent runtime and whether it can start right now (GET /api/runtimes). */
export interface RuntimeStatus {
  kind: RuntimeKind;
  label: string;
  /** True when the runtime looks startable right now. */
  available: boolean;
  /** True when this runtime takes a configurable binary path. */
  configurable: boolean;
  /** The path currently in use (resolved), when the runtime has one. */
  path?: string;
  /** A short human note: why it is unavailable, or how it is provided. */
  note: string;
}

/** What to reopen when resuming a persisted session (POST /api/sessions). */
export interface ResumeTarget {
  absenceSessionId?: string;
  /** Historical names kept for compatibility: the generic ACP resume handle. */
  piSessionFile?: string;
  piSessionId?: string;
}

/** A project file read from disk (GET /api/sessions/:id/file). */
export interface FileContent {
  path: string;
  content: string;
  size: number;
}

/* ── Agent Eggs filter profiles (server-side named files) ────────────────── */

/** One saved profile, as the editor's list shows it. */
export interface EggFilterProfileMeta {
  name: string;
  /** Epoch ms of the file's last modification. */
  savedAt: number;
  /** Number of names in the profile. */
  count: number;
}

/** Everything the egg-filter editor needs on open (GET /api/egg-filter). */
export interface EggFilterState {
  dir: string;
  active: string;
  /** True when the active profile overrides even "named by the command". */
  force: boolean;
  profiles: EggFilterProfileMeta[];
  current: string[];
}

/** The answer to saving a profile (PUT /api/egg-filter/:name). */
export interface EggFilterSaveResponse {
  ok: boolean;
  active: string;
  profile: EggFilterProfileMeta & { names: string[] };
}

/* ── Avatar skins (user-uploaded animation files) ────────────────────────── */

export interface AvatarSkinMeta {
  name: string;
  /** Status → stored file name. */
  files: Partial<Record<string, string>>;
  /** True when every status has a file, so no builtin fallback shows. */
  complete: boolean;
}

export interface AvatarSkinState {
  dir: string;
  active: string;
  builtin: string;
  skins: AvatarSkinMeta[];
  activeFiles: Partial<Record<string, string>>;
}

/* ── Sound sets (user-uploaded chimes) ───────────────────────────────────── */

export interface SoundSetMeta {
  name: string;
  /** Event → stored file name. */
  files: Partial<Record<string, string>>;
  /** True when every event has a file, so no synthesised fallback rings. */
  complete: boolean;
}

export interface SoundSetState {
  dir: string;
  active: string;
  builtin: string;
  sets: SoundSetMeta[];
  activeFiles: Partial<Record<string, string>>;
}

/* ── Observation board (transcript discovery) ────────────────────────────── */

/** One transcript a tail is following (GET /api/observe/sessions). */
export interface ObserveSessionRow {
  /** The agent software's own session id. */
  externalId: string;
  /** Transcript source profile id (`claude-code`). */
  source: string;
  /** Agent kind recorded on the observed session. */
  agentKind: string;
  /** The project the transcript belongs to, when a record named one. */
  projectPath?: string;
  /** The transcript file being tailed. */
  file: string;
  /** Absence session id, once attached — the id every session endpoint takes. */
  sessionId?: string;
  /** Last write the tail saw on the transcript. */
  lastActivityAt: number;
  /** Parsed events so far. */
  events: number;
  /** Lines that were not JSON. */
  malformed: number;
}

/** The transcript source this host watches. */
export interface ObserveSourceRow {
  id: string;
  label: string;
  agentKind: string;
  /** The directories watched. */
  roots: string[];
  /** True when at least one tailed transcript belongs to this source. */
  watched: boolean;
}

export interface ObserveDiscoveryResponse {
  sessions: ObserveSessionRow[];
  sources: ObserveSourceRow[];
}

/**
 * One live observed session (GET /api/observe/live) — the board's “正在监控”.
 *
 * A session exists here exactly when Absence already holds it in memory and is
 * feeding it facts. The archive's History rows are separate: a row whose facts
 * went quiet is archived (removed from this list) but stays in History, and
 * re-attaching its identity brings it back.
 */
export interface ObserveLiveRow {
  sessionId: string;
  /** Which observation channel feeds it. */
  channel: ObserveChannel;
  /** The agent-side identity of the conversation (see `ObserveMeta.externalId`). */
  externalId: string;
  agentKind: string;
  projectPath: string;
  /** The transcript file being tailed, when the channel has one. */
  transcriptFile?: string;
  /** The agent process the session is bound to, when one is bound. */
  pid?: number;
  /** When the archive row was first opened. */
  startedAt: number;
  /**
   * When the observer began watching. Facts older than this came from a
   * backfill (the transcript's own history) or not at all (OS facts have no
   * history), so the UI can mark the session's honest beginning.
   */
  watchStartedAt: number;
  lastActivityAt: number;
  /** Facts recorded so far (the live window's length). */
  events: number;
  /** Open WebSocket viewers. */
  viewers: number;
  /** True while a user-chosen monitor lease holds this session. */
  leased?: boolean;
  /** True while the transcript backfill is still running. */
  backfilling?: boolean;
}

export interface ObserveLiveResponse {
  sessions: ObserveLiveRow[];
}

/** Why a session's monitoring is not running (see `ObserveWatchResponse`). */
export type ObserveWatchState = "watching" | "exited" | "missing";

/** The answer to POST /api/observe/watch (selecting a target to monitor). */
export interface ObserveWatchResponse {
  sessionId: string;
  /** Where the panel lives, so a CLI can print one line to paste. */
  url: string;
  state: ObserveWatchState;
}

/**
 * One thing the board may offer to monitor (GET /api/observe/targets).
 *
 * Targets are discovered, not created: a list of what is on this machine right
 * now, cheap to produce (a process-table signature match, a transcript header,
 * a proxy registration) and creating no session, watcher or sample. Choosing
 * one is what attaches it.
 */
export interface ObserveTargetRow {
  /** Stable key: `transcript:<file>`, `proc:<pid>@<startedAt>`, `proxy:<id>`. */
  key: string;
  kind: "transcript" | "process" | "proxy";
  agentKind: string;
  cwd?: string;
  pid?: number;
  transcriptFile?: string;
  externalId?: string;
  /** Which channels could observe it. */
  channels: ObserveChannel[];
  /**
   * `running` — a live process; `idle` — a transcript nothing is writing right
   * now; `exited` — the process is gone; `missing` — the file vanished.
   */
  liveness: "running" | "idle" | "exited" | "missing";
  lastActivityAt: number;
  /** The live session already watching it, when there is one. */
  sessionId?: string;
  /** True when choosing it can start monitoring now. */
  watchable: boolean;
  /** Why it cannot be monitored, when `watchable` is false. */
  reason?: string;
}

export interface ObserveTargetsResponse {
  targets: ObserveTargetRow[];
}

/** One ACP proxy session as the observation board lists it. */
export interface AcpProxySessionRow {
  id: string;
  label: string;
  cwd: string;
  /** The Absence session the proxy persists into, once the agent spawned. */
  sessionId?: string;
  status: "waiting" | "running" | "closed" | "failed";
  createdAt: number;
  closedAt?: number;
  pid?: number;
  error?: string;
  /** The localhost endpoint an ACP client attaches to (tcp transports). */
  endpoint?: { host: string; port: number };
}

export interface AcpProxySessionsResponse {
  sessions: AcpProxySessionRow[];
}
