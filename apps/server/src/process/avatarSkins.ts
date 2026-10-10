import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/* ══════════════════════════════════════════════════════════════════════════
   Avatar skins — user-uploaded character animations, managed entirely from
   the Settings dialog. No URLs to write: the user picks a status, uploads a
   file, and the file becomes that status's animation.

   Directory layout (one folder per skin, named by the skin):

       avatar-skins/
       ├── active.json                 { "active": "WhaleBun" }
       └── MyDragon/
           ├── default.png             ← fallback for unlisted statuses
           ├── thinking.mp4
           ├── error.gif
           └── skin.json               { "name": "MyDragon", "loop": ... }

   Statuses: listening / thinking / speaking / reading / searching / editing /
   running / waiting / error, plus "default". A status without a file falls
   back to default.png/mp4/...; no default file means the built-in WhaleBun
   HTML character for that status.

   The active skin's files are served at /avatar/<status> so the web app never
   needs to know where they live.
   ══════════════════════════════════════════════════════════════════════════ */

const DIR = path.join(
  path.dirname(fileURLToPath(new URL(import.meta.url))),
  "avatar-skins",
);

const ACTIVE_FILE = path.join(DIR, "active.json");
const BUILTIN = "WhaleBun";

const STATUSES = [
  "default", "listening", "thinking", "speaking", "reading",
  "searching", "editing", "running", "waiting", "error",
] as const;

export type AvatarStatus = (typeof STATUSES)[number];

export const avatarStatuses: readonly string[] = STATUSES;

/** Media extensions we accept, mapped to their content type. */
const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

export function isMediaFile(name: string): boolean {
  return path.extname(name).toLowerCase() in MEDIA_TYPES;
}

export function contentTypeFor(name: string): string {
  return MEDIA_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** A safe single path segment for a skin folder name. */
function safeName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 64 || /[\\/:*?"<>|]/.test(trimmed)) return null;
  return trimmed;
}

function skinDir(name: string): string | null {
  const safe = safeName(name);
  return safe ? path.join(DIR, safe) : null;
}

function ensureDir(): void {
  fs.mkdirSync(DIR, { recursive: true });
}

export interface SkinMeta {
  name: string;
  /** Status → uploaded file name (as stored on disk). */
  files: Partial<Record<string, string>>;
  /** True when every status has a file, so no WhaleBun fallback shows. */
  complete: boolean;
}

function readSkin(name: string): SkinMeta | undefined {
  const dir = skinDir(name);
  if (!dir || !fs.existsSync(dir)) return undefined;
  const files: Partial<Record<string, string>> = {};
  for (const f of fs.readdirSync(dir)) {
    // Skip the normalizeVideo temp file (thinking.mp4.norm.mp4), which would
    // otherwise be read as a stale entry mid-transcode.
    if (f.endsWith(".norm.mp4")) continue;
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f, ext).toLowerCase();
    if (isMediaFile(f) && (STATUSES as readonly string[]).includes(base)) {
      files[base] = f;
    }
  }
  return {
    name,
    files,
    complete: (STATUSES as readonly string[]).every((s) => files[s]),
  };
}

/** Every skin folder, alphabetically. */
export function listSkins(): SkinMeta[] {
  try {
    return fs
      .readdirSync(DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => readSkin(e.name))
      .filter((s): s is SkinMeta => s !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function getSkin(name: string): SkinMeta | undefined {
  return readSkin(name);
}

/** The skin in use; the empty/unknown value means the built-in WhaleBun. */
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

/** Activate a skin; an empty name (or the builtin) restores WhaleBun. */
export function activateSkin(name: string): SkinMeta | undefined {
  if (!name || name === BUILTIN) {
    setActiveName("");
    return undefined;
  }
  const skin = getSkin(name);
  if (!skin) throw new Error(`skin not found: ${name}`);
  setActiveName(name);
  return skin;
}

/** Store an uploaded file as a status's animation inside a skin folder. */
export function saveSkinFile(skinName: string, status: string, originalName: string, data: Buffer): SkinMeta {
  const dir = skinDir(skinName);
  if (!dir) throw new Error(`invalid skin name: ${skinName}`);
  if (!(STATUSES as readonly string[]).includes(status)) {
    throw new Error(`unknown status: ${status}`);
  }
  const ext = path.extname(originalName).toLowerCase();
  if (!(ext in MEDIA_TYPES)) {
    throw new Error(`unsupported file type: ${ext || "(none)"}`);
  }
  ensureDir();
  fs.mkdirSync(dir, { recursive: true });
  // Remove other files for this status first, so re-uploading replaces.
  for (const f of fs.readdirSync(dir)) {
    if (path.basename(f, path.extname(f)).toLowerCase() === status) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
  fs.writeFileSync(path.join(dir, `${status}${ext}`), data);
  const skin = readSkin(skinName);
  if (!skin) throw new Error("skin save failed");
  // Fire-and-forget: if ffmpeg exists, re-encode videos into a browser-safe
  // container. Files with a data track (e.g. a timecode stream) or without
  // faststart are rejected by <video> with a broken-image icon.
  if (ext === ".mp4" || ext === ".mov" || ext === ".m4v") {
    void normalizeVideo(path.join(dir, `${status}${ext}`));
  }
  return skin;
}

/**
 * Re-encode a video in place with ffmpeg (when available): H.264 main /
 * yuv420p, video stream only, metadata dropped, moov moved to the front.
 * This removes data tracks (e.g. a tmcd timecode), which Chrome refuses
 * to play — the classic broken-image icon in a <video> tag.
 */
async function normalizeVideo(file: string): Promise<void> {
  const tmp = `${file}.norm.mp4`;
  const args = [
    "-y", "-loglevel", "error", "-i", file,
    // Map the video only and drop all metadata: a tmcd (timecode) data track
    // survives -an, and Chrome refuses to play a file that has one.
    "-map", "0:v:0", "-map_metadata", "-1",
    "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    tmp,
  ];
  await new Promise<void>((resolve) => {
    execFile("ffmpeg", args, { timeout: 120_000, windowsHide: true }, () => resolve());
  });
  // Swap only if the normalized output is a usable non-empty file.
  try {
    if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
      fs.renameSync(tmp, file);
    } else {
      fs.rmSync(tmp, { force: true });
    }
  } catch {
    // keep the original file; playback may still work
  }
}

export function deleteSkinFile(skinName: string, status: string): SkinMeta {
  const dir = skinDir(skinName);
  if (!dir) throw new Error(`invalid skin name: ${skinName}`);
  for (const f of fs.readdirSync(dir)) {
    if (path.basename(f, path.extname(f)).toLowerCase() === status) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
  const skin = readSkin(skinName);
  if (!skin) throw new Error(`skin not found: ${skinName}`);
  return skin;
}

export function deleteSkin(skinName: string): boolean {
  const dir = skinDir(skinName);
  if (!dir || !fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  if (getActiveName() === skinName) setActiveName("");
  return true;
}

/** Create an empty skin folder so the user can upload into it. */
export function createSkin(name: string): SkinMeta {
  const dir = skinDir(name);
  if (!dir) throw new Error(`invalid skin name: ${name}`);
  ensureDir();
  fs.mkdirSync(dir, { recursive: true });
  const skin = readSkin(name);
  if (!skin) throw new Error("skin create failed");
  return skin;
}

/** Absolute path of a served file, for the static handler. */
export function resolveSkinFile(status: string): string | undefined {
  const active = getActiveName();
  if (!active) return undefined;
  const dir = skinDir(active);
  if (!dir) return undefined;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (path.basename(f, path.extname(f)).toLowerCase() === status) {
        return path.join(dir, f);
      }
    }
  } catch {
    return undefined;
  }
  // Fall back to the skin's default file for unlisted statuses.
  if (status !== "default") return resolveSkinFile("default");
  return undefined;
}

export const avatarSkinsDir = DIR;
