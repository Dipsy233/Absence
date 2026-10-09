/**
 * Daze's two chimes, synthesised with the WebAudio API — no audio assets, and
 * no sound until the user has interacted with the page (the browser's autoplay
 * policy is also the mute switch: Daze never asks, it just stays silent until
 * the page has been touched).
 *
 * - `attention`: the Human-attention level crossed a threshold — two rising
 *   notes, urgent at high, a softer pair at medium.
 * - `complete`: the run finished and the agent has a reply — one resolved
 *   major third, descending, like a kettle clicking off.
 */

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
  env.gain.setValueAtTime(0, at.currentTime + start);
  env.gain.linearRampToValueAtTime(gain, at.currentTime + start + 0.02);
  env.gain.exponentialRampToValueAtTime(0.0001, at.currentTime + start + duration);
  osc.connect(env).connect(at.destination);
  osc.start(at.currentTime + start);
  osc.stop(at.currentTime + start + duration + 0.05);
}

/** Human attention changed level — urgent when it reached high. */
export function playAttention(level: "medium" | "high"): void {
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

/** The run finished — a resolved, descending third. */
export function playComplete(): void {
  const at = audio();
  if (!at) return;
  tone(at, 0, 880, 0.16, 0.1);
  tone(at, 0.18, 660, 0.28, 0.1);
}
