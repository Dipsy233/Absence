import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ══════════════════════════════════════════════════════════════════════════
   Sound sets — user-uploaded chimes, managed entirely from the Settings
   dialog, in the same shape as avatar skins. No URLs to write: the user picks
   an event, uploads a file, and that file replaces the synthesised chime.

   Directory layout (one folder per sound set, named by the set):

       sound-sets/
       ├── active.json                 { "active": "MyChimes" }
       └── MyChimes/
           ├── attention.mp3           ← Human-attention level changed
           ├── complete.wav            ← the run finished
           └── approval.ogg            ← the runtime is waiting on a decision

   Events: attention / complete / approval. A missing file falls back to the
   synthesised WebAudio chime for that event, so a half-finished set still
   works. The active set's files are served at /sound/<event> so the web app
   never needs to know where they live.
   ══════════════════════════════════════════════════════════════════════════ */

const DIR = path.join(
  path.dirname(fileURLToPath(new URL(import.meta.url))),
  "sound-sets",
);

const ACTIVE_FILE = path.join(DIR, "active.json");
const BUILTIN = "Default";

/** The events that ring a chime (see apps/web/src/lib/sounds.ts).
 *
 *  `attention` comes in two levels: a set can carry `attention-medium` and
 *  `attention-high` files. The bare `attention` name stays legal so sets
 *  uploaded before the split keep working — it plays for both levels.
 */
const EVENTS = ["attention", "attention-medium", "attention-high", "complete", "approval"] as const;

export type SoundEvent = (typeof EVENTS)[number];

export const soundEvents: readonly string[] = EVENTS;

/** Audio extensions we accept, mapped to their content type. */
const AUDIO_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  ".mp4": "audio/mp4",
};

export function isAudioFile(name: string): boolean {
  return path.extname(name).toLowerCase() in AUDIO_TYPES;
}

export function contentTypeFor(name: string): string {
  return AUDIO_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** A safe single path segment for a sound-set folder name. */
function safeName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 64 || /[\\/:*?"<>|]/.test(trimmed)) return null;
  return trimmed;
}

function setDir(name: string): string | null {
  const safe = safeName(name);
  return safe ? path.join(DIR, safe) : null;
}

function ensureDir(): void {
  fs.mkdirSync(DIR, { recursive: true });
}

export interface SoundSetMeta {
  name: string;
  /** Event → uploaded file name (as stored on disk). */
  files: Partial<Record<string, string>>;
  /** True when every event has a file, so no synthesised fallback rings. */
  complete: boolean;
}

function readSet(name: string): SoundSetMeta | undefined {
  const dir = setDir(name);
  if (!dir || !fs.existsSync(dir)) return undefined;
  const files: Partial<Record<string, string>> = {};
  for (const f of fs.readdirSync(dir)) {
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f, ext).toLowerCase();
    if (isAudioFile(f) && (EVENTS as readonly string[]).includes(base)) {
      files[base] = f;
    }
  }
  return {
    name,
    files,
    complete: (EVENTS as readonly string[]).every((e) => files[e]),
  };
}

/** Every sound-set folder, alphabetically. */
export function listSets(): SoundSetMeta[] {
  try {
    return fs
      .readdirSync(DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => readSet(e.name))
      .filter((s): s is SoundSetMeta => s !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function getSet(name: string): SoundSetMeta | undefined {
  return readSet(name);
}

/** The set in use; the empty/unknown value means the synthesised default. */
export function getActiveName(): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACTIVE_FILE, "utf8")) as { active?: string };
    return typeof parsed.active === "string" ? parsed.active : "";
  } catch {
    return "";
  }
}

export function setActiveName(name: string): void {
  ensureDir();
  fs.writeFileSync(ACTIVE_FILE, `${JSON.stringify({ active: name }, null, 2)}\n`, "utf8");
}

/** Activate a set; an empty name (or the builtin) restores the synth chimes. */
export function activateSet(name: string): SoundSetMeta | undefined {
  if (!name || name === BUILTIN) {
    setActiveName("");
    return undefined;
  }
  const set = getSet(name);
  if (!set) throw new Error(`sound set not found: ${name}`);
  setActiveName(name);
  return set;
}

/** Store an uploaded file as an event's chime inside a sound-set folder. */
export function saveSetFile(setName: string, event: string, originalName: string, data: Buffer): SoundSetMeta {
  const dir = setDir(setName);
  if (!dir) throw new Error(`invalid sound set name: ${setName}`);
  if (!(EVENTS as readonly string[]).includes(event)) {
    throw new Error(`unknown sound event: ${event}`);
  }
  const ext = path.extname(originalName).toLowerCase();
  if (!(ext in AUDIO_TYPES)) {
    throw new Error(`unsupported file type: ${ext || "(none)"}`);
  }
  ensureDir();
  fs.mkdirSync(dir, { recursive: true });
  // Remove other files for this event first, so re-uploading replaces.
  for (const f of fs.readdirSync(dir)) {
    if (path.basename(f, path.extname(f)).toLowerCase() === event) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
  fs.writeFileSync(path.join(dir, `${event}${ext}`), data);
  const set = readSet(setName);
  if (!set) throw new Error("sound set save failed");
  return set;
}

export function deleteSetFile(setName: string, event: string): SoundSetMeta {
  const dir = setDir(setName);
  if (!dir) throw new Error(`invalid sound set name: ${setName}`);
  for (const f of fs.readdirSync(dir)) {
    if (path.basename(f, path.extname(f)).toLowerCase() === event) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
  const set = readSet(setName);
  if (!set) throw new Error(`sound set not found: ${setName}`);
  return set;
}

export function deleteSet(setName: string): boolean {
  const dir = setDir(setName);
  if (!dir || !fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  if (getActiveName() === setName) setActiveName("");
  return true;
}

/** Create an empty sound-set folder so the user can upload into it. */
export function createSet(name: string): SoundSetMeta {
  const dir = setDir(name);
  if (!dir) throw new Error(`invalid sound set name: ${name}`);
  ensureDir();
  fs.mkdirSync(dir, { recursive: true });
  const set = readSet(name);
  if (!set) throw new Error("sound set create failed");
  return set;
}

/** Absolute path of a served file, for the static handler. */
export function resolveSetFile(event: string, setName?: string): string | undefined {
  const active = setName ?? getActiveName();
  if (!active) return undefined;
  const dir = setDir(active);
  if (!dir) return undefined;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (path.basename(f, path.extname(f)).toLowerCase() === event) {
        return path.join(dir, f);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export const soundsDir = DIR;
