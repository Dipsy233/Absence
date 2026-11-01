import { useEffect } from "react";
import { prefersReducedMotion } from "../../lib/anim";
import { useUiStyleStore } from "../../stores/uistyleStore";

const SEEDS = [2, 7, 13];

/* ══════════════════════════════════════════════════════════════════════════
   InkBoil — the filter source for the hand-drawn line boil.

   One feTurbulence whose seed steps every 250ms: a new "drawing" two or three
   times a second, the cadence at which a wobble reads as line boil instead of
   jitter (the m3/m5 constraint: the noise is spatially continuous, so the
   line wobbles as a whole but never shatters into fringes).

   The filter lives in the document once; themes.css boils a card's border
   pseudo-element through it (`filter: url(#mon-ink-boil)`). Rotating the seed
   is the only JS here, and it stops under reduced motion — the border then
   holds one drawing. An SVG filter cannot reach a Document PiP window, so
   only faces of the main document (Rounds' cards) consume it.
   ══════════════════════════════════════════════════════════════════════════ */
export function InkBoil() {
  const uiStyle = useUiStyleStore((s) => s.uiStyle);

  useEffect(() => {
    if (uiStyle !== "ink" || prefersReducedMotion()) return;
    const turb = document.querySelector("#mon-ink-boil feTurbulence");
    if (!turb) return;
    let i = 0;
    const timer = setInterval(() => {
      i = (i + 1) % SEEDS.length;
      turb.setAttribute("seed", String(SEEDS[i]!));
    }, 250);
    return () => clearInterval(timer);
  }, [uiStyle]);

  // Always mounted: other themes never reference the filter and an inert one
  // costs nothing, while remounting per theme would reset the seed phase.
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden focusable="false">
      <defs>
        <filter id="mon-ink-boil" x="-8%" y="-8%" width="116%" height="116%">
          <feTurbulence type="fractalNoise" baseFrequency="0.02 0.035" numOctaves={2} seed={SEEDS[0]} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={4} />
        </filter>
      </defs>
    </svg>
  );
}
