/* ══════════════════════════════════════════════════════════════════════════
   Motion toolkit — the faces' shared animation primitives, as pure functions
   of time. No rAF state machines live here: an effect drives `t` and every
   value is `f(t)`, so the same math works for entrances, counters and (later)
   replay seeking.

   Sourced from the m1–m4 samples (E:\0down\Absence): closed-form damped
   springs (01-flat-vector), frame-quantized scramble/roll (22-hud) and the
   arrival effects built on them.
   ══════════════════════════════════════════════════════════════════════════ */

export const clamp = (x: number, a = 0, b = 1): number => Math.min(b, Math.max(a, x));

export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

/* ── Closed-form damped spring ─────────────────────────────────────────────
   `f` is frequency in Hz, `z` the damping ratio (0.3–0.5 feels physical).
   Underdamped, so a value animated with `spring` overshoots ~once and
   settles — the "weight" CSS transitions don't have. */

export function spring(t: number, f = 2, z = 0.4): number {
  const w = 2 * Math.PI * f;
  const a = z * w;
  const b = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-a * t) * (Math.cos(b * t) + (a / b) * Math.sin(b * t));
}

/** The spring's velocity — drives squash & stretch, badge pulses and so on. */
export function springV(t: number, f = 2, z = 0.4): number {
  const w = 2 * Math.PI * f;
  const a = z * w;
  const b = w * Math.sqrt(1 - z * z);
  return ((w * w) / b) * Math.exp(-a * t) * Math.sin(b * t);
}

/**
 * An entrance "pop": the spring's position plus a squash factor from its
 * velocity. Returns `[scale, squash]` — apply as
 * `scale(sx = s / (1 + k), sy = s * (1 + k))` to stretch along the motion
 * axis. Past `pin` seconds it snaps to rest so a long-lived element cannot
 * drift on sub-pixel rounding.
 */
export function pop(t: number, f = 2.4, z = 0.42, amt = 0.12, pin = 0.9): [number, number] {
  if (t >= pin) return [1, 0];
  const s = spring(t, f, z);
  const k = clamp(springV(t, f, z) * amt, -0.32, 0.32);
  return [s, k];
}

/* ── Easing curve library (one power per intent) ────────────────────────── */

export const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);
export const easeOutQuart = (x: number): number => 1 - Math.pow(1 - x, 4);
export const easeInOutCubic = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
export const easeOutBack = (x: number): number => {
  const s = 1.70158;
  return 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2);
};

/* ── Small helpers ───────────────────────────────────────────────────────── */

/** Stateless integer hash → [0,1). Deterministic per (a, b), no Math.random. */
export function hash(a: number, b: number): number {
  let h = 2166136261 >>> 0;
  h = Math.imul(h ^ a, 16777619);
  h = Math.imul(h ^ b, 16777619);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** 15fps frame quantization: scramble/roll effects step on frames, not rAFs. */
export const frameOf = (tSeconds: number): number => Math.floor(tSeconds * 15);

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * One-shot imperative tween: `fn(elapsedSeconds)` every frame until `ms` has
 * passed, then `done`. Returns a cancel function. Honors reduced motion by
 * jumping straight to the end.
 */
export function tween(
  ms: number,
  fn: (tSeconds: number) => void,
  done?: () => void,
): () => void {
  if (prefersReducedMotion()) {
    fn(ms / 1000);
    done?.();
    return () => {};
  }
  const t0 = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const t = (now - t0) / 1000;
    if (t * 1000 >= ms) {
      fn(ms / 1000);
      done?.();
      return;
    }
    fn(t);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
