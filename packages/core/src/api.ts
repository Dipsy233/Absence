/* ══════════════════════════════════════════════════════════════════════════
   REST payload contracts — the response bodies (and a couple of request
   bodies) the server answers with and the browser's api layer parses.

   The session/event types already live in `types`/`events`/`runs`/`metrics`;
   these are the smaller payloads the settings surfaces use (runtimes, egg
   filter profiles, avatar skins, sound sets) plus the file-read and resume
   shapes. They used to be declared twice — once beside the server route, once
   beside the client fetch — and stayed equal only by hand.
   ══════════════════════════════════════════════════════════════════════════ */

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
