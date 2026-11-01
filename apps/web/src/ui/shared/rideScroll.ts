import { useEffect, useRef, type RefObject } from "react";

/* ══════════════════════════════════════════════════════════════════════════
   useRideScroll — the border-riding scrollbar (see shared.css for the visual
   contract). The element keeps scrolling natively — refs, scrollTop, wheel
   handlers all stay as they were — but its native bar is hidden and a slim
   thumb is drawn in a fixed rail whose box is the scroller's own rect,
   refreshed every frame it could have moved: scroll, resize, and content
   mutations (feed rows stream in). The thumb straddles the container's
   right or bottom edge, exactly on the divider, and the content never
   yields a pixel to a scrollbar.

   The rail is appended to <body>, outside every face's clip and stacking
   context, so it survives `overflow: clip` ancestors; its colours are
   literal for the same reason.
   ══════════════════════════════════════════════════════════════════════════ */

export function useRideScroll<T extends HTMLElement>(
  side: "right" | "bottom" = "right",
  /** When the scroller is already referenced (feedRef, cardsRef), ride it. */
  external?: RefObject<T | null>,
): RefObject<T | null> {
  const own = useRef<T>(null);

  useEffect(() => {
    const view = external?.current ?? own.current;
    if (!view) return;
    view.classList.add("mon-ridesb");

    const rail = document.createElement("i");
    rail.className = "mon-ridesb__rail";
    rail.dataset.side = side;
    rail.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("i");
    thumb.className = "mon-ridesb__thumb";
    rail.appendChild(thumb);
    document.body.appendChild(rail);

    let raf = 0;
    const update = () => {
      raf = 0;
      const r = view.getBoundingClientRect();
      rail.style.left = `${r.left.toFixed(1)}px`;
      rail.style.top = `${r.top.toFixed(1)}px`;
      rail.style.width = `${r.width.toFixed(1)}px`;
      rail.style.height = `${r.height.toFixed(1)}px`;
      const vertical = side === "right";
      const total = vertical
        ? view.scrollHeight - view.clientHeight
        : view.scrollWidth - view.clientWidth;
      const visible = vertical ? view.clientHeight : view.clientWidth;
      const scrollable = total > 1;
      rail.dataset.scrollable = scrollable ? "true" : "false";
      if (!scrollable) return;
      const size = Math.max(28, (visible / (visible + total)) * visible);
      const pos =
        ((vertical ? view.scrollTop : view.scrollLeft) / total) * (visible - size);
      if (vertical) {
        thumb.style.height = `${size.toFixed(1)}px`;
        thumb.style.transform = `translateY(${pos.toFixed(1)}px)`;
      } else {
        thumb.style.width = `${size.toFixed(1)}px`;
        thumb.style.transform = `translateX(${pos.toFixed(1)}px)`;
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(view);
    /* Feed rows stream in and change scrollHeight without resizing the box. */
    const mo = new MutationObserver(schedule);
    mo.observe(view, { childList: true, subtree: true });
    view.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    return () => {
      ro.disconnect();
      mo.disconnect();
      view.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
      rail.remove();
      view.classList.remove("mon-ridesb");
    };
  }, [side, external]);

  return own;
}
