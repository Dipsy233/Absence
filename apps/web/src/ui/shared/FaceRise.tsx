import { useEffect, useRef, type ReactNode } from "react";
import { clamp, spring, tween } from "../../lib/anim";

/* ══════════════════════════════════════════════════════════════════════════
   FaceRise — the mode switch's entrance. Each face mounts into this wrapper
   and rises once: opacity, a 12px rise, and a spring on the scale path so
   the face lands with a little weight instead of hard-cutting. Identity
   styles are restored at the end, so nothing here constrains the face after
   the first second.
   ══════════════════════════════════════════════════════════════════════════ */

export function FaceRise({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return tween(
      560,
      (t) => {
        const s = spring(t, 3.2, 0.5);
        el.style.opacity = String(clamp(t * 3));
        el.style.transform = `translateY(${((1 - s) * 12).toFixed(2)}px)`;
      },
      () => {
        el.style.opacity = "";
        el.style.transform = "";
      },
    );
  }, []);

  return (
    /* height: 100% keeps the face's own height chain intact — Rounds' root,
       for one, is `height: 100%` (not 100vh) and collapses to its content
       otherwise. */
    <div ref={ref} style={{ minHeight: 0, height: "100%" }}>
      {children}
    </div>
  );
}
