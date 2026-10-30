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
  width = 460,
  z = 1,
  onFocus,
  onClose,
  children,
}: {
  title: string;
  initial: { x: number; y: number };
  width?: number;
  z?: number;
  onFocus?: () => void;
  onClose?: () => void;
  children: ReactNode;
}) {
  const [pos, setPos] = useState(initial);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

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
  };

  return (
    <section
      className="rounds-win"
      style={{ left: pos.x, top: pos.y, width, zIndex: 5 + z }}
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
    </section>
  );
}
