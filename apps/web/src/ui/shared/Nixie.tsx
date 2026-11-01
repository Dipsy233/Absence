import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../../lib/anim";

/* ══════════════════════════════════════════════════════════════════════════
   Nixie — the arrival effect for a fixed-width field (a counter line, a
   status word). The field's width is the final value's width: the volatile
   cells scramble fast and truly randomly (each frame redraws all of them),
   the tail eases off, then they snap to the real value with one flash. It
   never types in or reveals per character — a value *arrives*.

   Which cells are volatile:
   - digits always are (a count line's numbers);
   - in a word with no digits ("RUNNING", a status), everything but spaces is;
   - separators and labels — spaces, "·", "R"/"S"/"$" in `R3 S1 E3 $2` — are
     fixed from the first frame. They are structure, not data.

   Two variants:
   - "tube": each character sits in a glowing vacuum-tube cell (nixie look).
   - "plain": the same scramble in the surrounding text's own face — for
     count lines (`R14 S23 E9 $0.42`) where tubes would be too loud.

   This is a shared atom: it reads no stores, imports no face.
   ══════════════════════════════════════════════════════════════════════════ */

const GLYPHS = "0123456789abcdef#+-·×%$/\\<>_";
const CJK_GLYPHS = "数输运待校验运行监视光注读写";

const poolFor = (c: string): string =>
  /[\u4e00-\u9fff]/.test(c) ? CJK_GLYPHS : GLYPHS;

export function Nixie({
  value,
  variant = "tube",
  ms = 500,
  className,
}: {
  value: string | number;
  /** "tube" renders glowing cells; "plain" scrambles in the ambient type. */
  variant?: "tube" | "plain";
  /** Total scramble duration in ms. */
  ms?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const text = String(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chars = [...text];
    el.textContent = "";
    // Digits are data and scramble; in a digitless word everything but the
    // spaces arrives; separators and labels are structure and never move.
    const hasDigits = /\d/.test(text);
    const volatile = chars.map(
      (c) => /\d/.test(c) || (!hasDigits && c !== " "),
    );
    const cells = chars.map((c, i) => {
      const s = document.createElement("span");
      s.className = "mon-nix__cell";
      if (!volatile[i]) {
        s.textContent = c === " " ? "\u00a0" : c;
        s.classList.add("mon-nix__cell--settled");
      } else {
        s.textContent = "·";
      }
      el.appendChild(s);
      return s;
    });

    const settle = () => {
      chars.forEach((c, i) => {
        const cell = cells[i];
        if (!cell || !volatile[i]) return;
        cell.textContent = c === " " ? "\u00a0" : c;
        cell.classList.add("mon-nix__cell--settled", "mon-nix__cell--flash");
      });
      // The flash is a one-frame-bright settle cue; the settled style stays.
      window.setTimeout(
        () => cells.forEach((c) => c.classList.remove("mon-nix__cell--flash")),
        520,
      );
    };

    if (prefersReducedMotion()) {
      settle();
      return;
    }

    const poolCells = chars.map((c) => poolFor(c));
    const t0 = performance.now();
    let lastSwap = 0;
    let raf = 0;
    const step = (now: number) => {
      const t = now - t0;
      if (t >= ms) {
        settle();
        return;
      }
      // The last 30% eases off (every other frame), the rest redraws all
      // volatile cells every frame — fast, whole-field, truly random.
      if (t < ms * 0.7 || now - lastSwap >= 48) {
        lastSwap = now;
        chars.forEach((_, i) => {
          const cell = cells[i];
          const pool = poolCells[i];
          if (!cell || !pool || !volatile[i]) return;
          cell.textContent = pool.charAt((Math.random() * pool.length) | 0);
        });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, variant, ms]);

  return (
    <span className={`mon-nix mon-nix--${variant}${className ? ` ${className}` : ""}`}>
      {/* The scramble is visual noise: screen readers get the final value. */}
      <span className="mon-nix__sr">{text}</span>
      <span className="mon-nix__live" aria-hidden="true" ref={ref} />
    </span>
  );
}
