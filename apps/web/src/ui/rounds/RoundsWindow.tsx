import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

/**
 * A floating window on the Rounds desktop.
 *
 * The dock's icons are shortcuts; clicking one opens one of these, and the
 * agent's own actions pop them too. It drags by its title bar (pointer capture
 * keeps the move stream even when the cursor leaves the bar), it can be
 * closed, and it stacks above the transparent chat that is the desktop's
 * wallpaper.
 */
export function RoundsWindow({
  title,
  initial,
  size,
  z = 1,
  onFocus,
  onClose,
  children,
}: {
  title: string;
  initial: { x: number; y: number };
  /** The window's size. Sibling windows share one; children another (see the
      face's two default sizes), and the corner handle adjusts either. */
  size: { w: number; h: number };
  z?: number;
  onFocus?: () => void;
  onClose?: () => void;
  children: ReactNode;
}) {
  const [pos, setPos] = useState(initial);
  const [dim, setDim] = useState(size);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const grow = useRef<{ px: number; py: number; w: number; h: number } | null>(null);

  const down = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest(".rounds-win__x")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { px: event.clientX, py: event.clientY, x: pos.x, y: pos.y };
    onFocus?.();
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    const x = Math.min(Math.max(4, drag.current.x + event.clientX - drag.current.px), window.innerWidth - 140);
    const y = Math.min(Math.max(4, drag.current.y + event.clientY - drag.current.py), window.innerHeight - 90);
    setPos({ x, y });
  };
  const up = () => {
    drag.current = null;
    grow.current = null;
  };

  const growDown = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    grow.current = { px: event.clientX, py: event.clientY, w: dim.w, h: dim.h };
    onFocus?.();
  };
  const growMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!grow.current) return;
    setDim({
      w: Math.min(Math.max(300, grow.current.w + event.clientX - grow.current.px), window.innerWidth - 60),
      h: Math.min(Math.max(200, grow.current.h + event.clientY - grow.current.py), window.innerHeight - 80),
    });
  };

  return (
    <section
      className="rounds-win"
      style={{ left: pos.x, top: pos.y, width: dim.w, height: dim.h, zIndex: 5 + z }}
      onPointerDown={onFocus}
      role="dialog"
      aria-label={title}
    >
      <header
        className="rounds-win__h"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <span className="rounds-win__t" title={title}>
          {title}
        </span>
        {onClose ? (
          <button type="button" className="rounds-win__x" onClick={onClose} aria-label="Close" title="Close">
            ✕
          </button>
        ) : null}
      </header>
      <div className="rounds-win__b">{children}</div>
      <span
        className="rounds-win__rs"
        onPointerDown={growDown}
        onPointerMove={growMove}
        onPointerUp={up}
        aria-hidden
      />
    </section>
  );
}
