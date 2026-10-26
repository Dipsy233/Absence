/**
 * Absence's voice, such as it is: three chimes hooked onto the event stream.
 *
 * By default they are synthesised with the WebAudio API — no audio assets, and
 * no sound until the user has interacted with the page (the browser's autoplay
 * policy is also the mute switch: Absence never asks, it just stays silent until
 * the page has been touched).
 *
 * - `attention`: the Human-attention level crossed a threshold — two rising
 *   notes, urgent at high, a softer pair at medium.
 * - `complete`: the run finished and the agent has a reply — one resolved
 *   major third, descending, like a kettle clicking off.
 * - `approval`: the runtime is waiting on the user's decision — a three-note
 *   rising alert that is deliberately unlike the other two, because this is the
 *   one chime that asks for a response rather than reporting one.
 *
 * A custom sound set (Settings → SOUND SETS) can replace any of these with an
 * uploaded audio file, served at /sound/<event>. When the active set has a file
 * for an event, that file plays; otherwise the synthesised chime above rings,
 * so a half-finished set still works.
 *
 * Which events ring, and how loudly, is the user's call (Settings → REPORT WARN
 * for the levels that trigger `attention`, Settings → SOUND SETS for the chimes
 * themselves). Every entry point here is a no-op when its switch is off.
 */

import { useSettingsStore } from "../stores/settingsStore";

let ctx: AudioContext | undefined;

function audio(): AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return undefined;
  ctx ??= new Ctor();
  // A suspended context means the page has not been interacted with yet: stay
  // silent rather than queue a sound for later.
  if (ctx.state === "suspended") return undefined;
  return ctx;
}

function tone(at: AudioContext, start: number, frequency: number, duration: number, gain: number): void {
  const osc = at.createOscillator();
  const env = at.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  // The synth gains were tuned by ear at full scale; the user's volume scales
  // them, so a quiet desk can keep the chimes as a nudge rather than an alarm.
  const level = gain * volumeScale();
  if (level <= 0) return;
  env.gain.setValueAtTime(0, at.currentTime + start);
  env.gain.linearRampToValueAtTime(level, at.currentTime + start + 0.02);
  env.gain.exponentialRampToValueAtTime(0.0001, at.currentTime + start + duration);
  osc.connect(env).connect(at.destination);
  osc.start(at.currentTime + start);
  osc.stop(at.currentTime + start + duration + 0.05);
}

/** The master volume as a 0–1 multiplier (0 when chimes are switched off). */
function volumeScale(): number {
  const { soundEnabled, soundVolume } = useSettingsStore.getState();
  if (!soundEnabled) return 0;
  return Math.min(100, Math.max(0, soundVolume)) / 100;
}

/* ══════════════════════════════════════════════════════════════════════════
   Custom sound sets.

   The Settings dialog uploads files into the server's sound-sets directory and
   activates one. Here we poll which events the active set covers, then play the
   uploaded file instead of the synth chime. Mirrors useAvatarSkinCoverage.
   ══════════════════════════════════════════════════════════════════════════ */

export type SoundEvent = "attention" | "complete" | "approval";

/** What the active set holds: stored file names, not just the three events. */
type StoredFiles = Partial<Record<string, string>>;

/** The stored file names an attention level can map to, most specific first. */
const ATTENTION_FILES = ["attention-high", "attention-medium", "attention"] as const;

/**
 * The stored event name for an attention chime: the level's own file when the
 * active set has one, then the other level's, then the legacy bare
 * `attention` file (sets uploaded before the split) — undefined when none.
 */
function attentionFileFor(level: "medium" | "high"): string | undefined {
  const files: Partial<Record<string, string>> = coverage?.files ?? {};
  const order: readonly string[] =
    level === "high" ? ATTENTION_FILES : (["attention-medium", "attention"] as const);
  for (const name of order) {
    if (files[name]) return name;
  }
  return undefined;
}

interface SoundCoverage {
  active: string;
  /** Event → stored file name (presence means a custom file exists). */
  files: Partial<Record<SoundEvent, string>>;
}

const POLL_MS = 4000;
let coverage: SoundCoverage | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

/** Fetch (once) and poll the active sound set's coverage. Idempotent. */
export function startSoundCoveragePolling(): void {
  if (pollTimer !== undefined || typeof window === "undefined") return;
  const tick = async () => {
    try {
      const res = await fetch("/api/sounds", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as {
        active: string;
        activeFiles: Partial<Record<string, string>>;
      };
      coverage = {
        active: json.active,
        files: (json.activeFiles ?? {}) as Partial<Record<SoundEvent, string>>,
      };
    } catch {
      // Server unreachable: keep whatever we had.
    }
  };
  void tick();
  pollTimer = setInterval(tick, POLL_MS);
}

/** A custom file exists for this stored name in the active set. */
function customFileFor(event: string): boolean {
  const files: Partial<Record<string, string>> = coverage?.files ?? {};
  return Boolean(coverage?.active && files[event]);
}

/**
 * Play the active set's stored chime by its file name. Returns false when
 * there is none (the caller then falls back to the synthesised tone).
 */
function playStored(event: string): boolean {
  if (!customFileFor(event)) return false;
  const volume = volumeScale();
  if (volume <= 0) return false;
  try {
    const el = new Audio(`/sound/${event}?v=${encodeURIComponent(coverage!.active)}`);
    el.volume = volume;
    void el.play().catch(() => {
      // Autoplay blocked or decode error — fall back to the synth chime.
      playAttentionSynth("medium");
    });
    return true;
  } catch {
    return false;
  }
}

/* ── Public entry points (custom file first, synth fallback) ──────────────── */

/**
 * Which chime an attention change should ring, or undefined for none.
 *
 * Pure, so the rules can be pinned without an AudioContext. Medium and high
 * always ring; a step *into* low never does — low is where most runs sit for
 * harmless reasons — and a release out of high always rings, so the user hears
 * the run relax.
 */
export function attentionChimeFor(
  previous: "none" | "low" | "medium" | "high",
  level: "none" | "low" | "medium" | "high",
): "medium" | "high" | undefined {
  if (level === previous) return undefined;
  if (level === "high") return "high";
  if (level === "medium") return "medium";
  // Back to low or none: only a release from high is audible.
  return previous === "high" ? "medium" : undefined;
}

/** Human attention changed level — urgent when it reached high. */
export function playAttention(level: "medium" | "high"): void {
  if (volumeScale() <= 0) return;
  const file = attentionFileFor(level);
  if (file && playStored(file)) return;
  playAttentionSynth(level);
}

/** The run finished — a resolved, descending third. */
export function playComplete(): void {
  if (!useSettingsStore.getState().soundComplete || volumeScale() <= 0) return;
  if (playStored("complete")) return;
  playCompleteSynth();
}

/**
 * The runtime is waiting on the user's decision — a rising three-note alert.
 *
 * Tuned to be unmistakable next to `attention` (two notes, level-dependent) and
 * `complete` (two notes, descending): three ascending steps, the last one held,
 * so a blocked agent announces itself even when the user is looking elsewhere.
 */
export function playApproval(): void {
  if (!useSettingsStore.getState().soundApproval || volumeScale() <= 0) return;
  if (playStored("approval")) return;
  playApprovalSynth();
}

/* ── Synthesised chimes ──────────────────────────────────────────────────── */

function playAttentionSynth(level: "medium" | "high"): void {
  const at = audio();
  if (!at) return;
  if (level === "high") {
    tone(at, 0, 880, 0.14, 0.12);
    tone(at, 0.16, 1174, 0.2, 0.12); // D6
    tone(at, 0.38, 1174, 0.2, 0.1);
  } else {
    tone(at, 0, 660, 0.16, 0.08);
    tone(at, 0.18, 880, 0.2, 0.08);
  }
}

function playCompleteSynth(): void {
  const at = audio();
  if (!at) return;
  tone(at, 0, 880, 0.16, 0.1);
  tone(at, 0.18, 660, 0.28, 0.1);
}

function playApprovalSynth(): void {
  const at = audio();
  if (!at) return;
  tone(at, 0, 587, 0.12, 0.1); // D5
  tone(at, 0.14, 740, 0.12, 0.1); // F#5
  tone(at, 0.28, 988, 0.3, 0.11); // B5
}
