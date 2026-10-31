import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { DripUI } from "./DripUI";
import "./drip.css";

/**
 * The desktop build of Drip — the packaged app's floating ball.
 *
 * The shell gives this face a frameless, transparent, always-on-top window that
 * covers the whole work area. That window is a sheet, not a widget: it never
 * moves and never resizes. The ball is only a position inside it (`bx`/`by`,
 * pushed by the shell), so the panel can unfold whichever way is roomier
 * without the window changing bounds at all. Resizing a transparent window on
 * the same frame it moves was what made expanding flicker before; now there is
 * nothing to resize.
 *
 * Because the sheet covers the screen, it must not eat the desktop's clicks:
 * the shell keeps it click-through (`setIgnoreMouseEvents(true, { forward:
 * true })`). Every pointer move, this face hit-tests the ball and the open
 * panel and turns click-through off only while the pointer is on them.
 *
 * The ball is also the drag handle: a press asks the shell to grab it, and every
 * move afterwards tells the shell to move it. Coordinates never cross the
 * bridge — the shell reads the cursor from the screen. A press that never
 * travels more than a few pixels still counts as a click that opens the card,
 * so the pointer capture is taken on the pill itself: the click then lands on
 * the pill's own handler instead of the wrapper, which would swallow it.
 */

/** The ball's diameter, as DripUI draws it. */
const BALL = 84;

/** The transparent margin kept along the screen edges. */
const INSET = 8;

/** The strip's width beside the ball when hovered; longer text is ellipsised. */
const STRIP = 256;

/** The card's width and tallest height, matching drip.css, plus the gap. */
const CARD_W = 380;
const CARD_MAX_H = 430;
const GAP = 10;

/** A press that travels farther than this is a drag, not a click. */
const DRAG_SLOP = 4;

/** Slack around the interactive shapes so their edges are not fiddly. */
const SLACK = 4;

/** One clamp call: hit boxes and the card's place both need it. */
function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

interface Layout {
  /** "left" = ball at the widget's left edge, strip grows right. */
  anchor: "left" | "right";
  vertical: "down" | "up";
  /** The strip's width in this position (0 when there is no room at all). */
  strip: number;
  /** CSS custom properties that place the widget and the card (see drip.css). */
  vars: CSSProperties;
}

/**
 * The panel decides where it fits, from where the ball is — not the other way
 * round. Horizontal: the strip unfolds towards whichever side has more room,
 * capped so it never runs past the screen edge. Vertical: the card hangs below
 * the ball when there is room for its tallest size, otherwise above; when
 * neither side is tall enough it takes the roomier one and shrinks to fit.
 */
function layoutFor(frame: DripFrame): Layout {
  const { bx, by, width: w, height: h } = frame;

  const roomRight = w - bx - BALL;
  const roomLeft = bx;
  const anchor = roomRight >= roomLeft ? "left" : "right";
  const strip = clamp(anchor === "left" ? roomRight : roomLeft, 0, STRIP);

  const roomBelow = h - by - BALL - GAP;
  const roomAbove = by - GAP;
  const vertical =
    roomBelow >= CARD_MAX_H
      ? "down"
      : roomAbove >= CARD_MAX_H
        ? "up"
        : roomBelow >= roomAbove
          ? "down"
          : "up";
  const cardH = Math.max(120, Math.min(CARD_MAX_H, vertical === "down" ? roomBelow : roomAbove));

  // The card is centred under the ball but never leaves the screen.
  const cardLeft = clamp(bx + BALL / 2 - CARD_W / 2, INSET, Math.max(INSET, w - INSET - CARD_W));
  // Where its left (or right) edge sits relative to the widget, whose own edge
  // is the ball's; drip.css anchors the card from that side.
  const cardDx = anchor === "left" ? cardLeft - bx : bx + BALL - (cardLeft + CARD_W);

  return {
    anchor,
    vertical,
    strip,
    vars: {
      "--drip-ball-x": `${bx}px`,
      "--drip-ball-y": `${by}px`,
      "--drip-widget-right": `${w - bx - BALL}px`,
      "--drip-strip-w": `${strip}px`,
      "--drip-card-dx": `${cardDx}px`,
      "--drip-card-max-h": `${cardH}px`,
    } as CSSProperties,
  };
}

/**
 * Is the pointer on something the face draws?
 *
 * Measured from the DOM, not from the last frame the shell sent: the pill's
 * rect is exactly what is on screen — ball, and the strip once it has stretched
 * — so a frame that arrives a beat late can never make the sheet swallow clicks
 * where nothing is drawn. The card is its own rect.
 */
function onShapes(x: number, y: number) {
  for (const element of document.querySelectorAll(".drip-pill, .drip-card")) {
    const box = element.getBoundingClientRect();
    if (
      x >= box.left - SLACK &&
      x <= box.right + SLACK &&
      y >= box.top - SLACK &&
      y <= box.bottom + SLACK
    ) {
      return true;
    }
  }
  return false;
}

export function DripDesktop() {
  const shell = window.absenceDesktop;
  /** Where the ball sits inside the sheet; null until the shell answers. */
  const [frame, setFrame] = useState<DripFrame | null>(null);
  /** Whether the shell is currently ignoring the mouse (see the effect below). */
  const ignoreRef = useRef(true);
  /** The press in flight, if any. */
  const pressRef = useRef<{ x: number; y: number; dragging: boolean; pill: HTMLElement } | null>(null);
  /** Set on release so the click that follows a drag can be swallowed. */
  const swallowClickRef = useRef(false);

  const layout = useMemo(() => (frame ? layoutFor(frame) : null), [frame]);

  // The shell's window is transparent, and index.css paints the page dark for
  // every face. The class keeps html, body and #root clear (see drip.css) —
  // an opaque page would show as a rectangle behind the ball.
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.classList.add("drip-transparent");
    return () => html.classList.remove("drip-transparent");
  }, []);

  // The ball's place inside the sheet: once on load, then on every drag.
  useEffect(() => {
    if (!shell) return;
    let alive = true;
    shell
      .dripBall()
      .then((value) => {
        if (alive && value) setFrame(value);
      })
      .catch(() => {
        // A shell that cannot answer keeps the sheet empty until a drag moves
        // the ball and pushes a frame.
      });
    const off = shell.onDripBall((value) => setFrame(value));
    return () => {
      alive = false;
      off();
    };
  }, [shell]);

  // Click-through, decided per pointer move: the sheet covers the whole work
  // area, so leaving it interactive outside the ball would eat the desktop's
  // clicks. A press keeps it interactive until the gesture ends.
  useEffect(() => {
    if (!shell) return;
    const apply = (next: boolean) => {
      if (next === ignoreRef.current) return;
      ignoreRef.current = next;
      shell.setDripIgnore(next);
    };
    const onMove = (event: MouseEvent) => {
      if (pressRef.current) {
        apply(false);
        return;
      }
      apply(!onShapes(event.clientX, event.clientY));
    };
    // The pointer left the window entirely: nothing of the face is under it.
    const onLeave = () => apply(true);

    window.addEventListener("mousemove", onMove);
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      apply(true);
    };
  }, [shell]);

  /** Open Absence: the shell closes this window and brings the main one back. */
  const leave = useCallback(() => shell?.leaveDrip(), [shell]);

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!shell || event.button !== 0) return;
      const pill = (event.target as Element | null)?.closest(".drip-pill");
      if (!(pill instanceof HTMLElement)) return;

      // A new press invalidates the previous gesture's swallow flag.
      swallowClickRef.current = false;
      pressRef.current = { x: event.clientX, y: event.clientY, dragging: false, pill };
      // Capture on the pill, not on the wrapper: with capture the click that
      // follows a press is delivered to the capturing element, and only the
      // pill's own handler knows how to open the card.
      pill.setPointerCapture(event.pointerId);
      shell.startDripDrag();
    },
    [shell],
  );

  const onPointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const press = pressRef.current;
      if (!press) return;
      if (!press.dragging) {
        // These coordinates are the pointer's honest travel only until the ball
        // starts following; past the threshold the shell reads the cursor itself.
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_SLOP) return;
        press.dragging = true;
      }
      shell?.dragDrip();
    },
    [shell],
  );

  const finishPress = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const press = pressRef.current;
      if (!press) return;
      swallowClickRef.current = press.dragging;
      pressRef.current = null;
      if (press.pill.hasPointerCapture(event.pointerId)) {
        press.pill.releasePointerCapture(event.pointerId);
      }
      shell?.endDripDrag();
    },
    [shell],
  );

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!swallowClickRef.current) return;
    // The click belongs to a drag: do not open the card with it.
    swallowClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  /**
   * Capture lost mid-press (focus went elsewhere): stop following the cursor,
   * otherwise the ball would trail it forever.
   */
  const onLostPointerCapture = useCallback(() => {
    if (!pressRef.current) return;
    pressRef.current = null;
    swallowClickRef.current = true;
    shell?.endDripDrag();
  }, [shell]);

  // Losing focus ends the gesture too — a drag has no business continuing after
  // the shell has handed the window to another app.
  useEffect(() => {
    const onBlur = () => {
      if (!pressRef.current) return;
      pressRef.current = null;
      swallowClickRef.current = true;
      shell?.endDripDrag();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [shell]);

  // Nothing is drawn until the shell has said where the ball is: a ball at
  // (0, 0) for one frame would flash in the sheet's corner.
  const style: CSSProperties = { ...layout?.vars, visibility: frame ? "visible" : "hidden" };

  return (
    <div
      className="drip-desktop"
      style={style}
      onPointerDownCapture={onPointerDownCapture}
      onPointerMoveCapture={onPointerMoveCapture}
      onPointerUpCapture={finishPress}
      onPointerCancelCapture={finishPress}
      onLostPointerCapture={onLostPointerCapture}
      onClickCapture={onClickCapture}
    >
      {layout ? (
        <DripUI
          desktop
          anchor={layout.anchor}
          vertical={layout.vertical}
          onOpenAbsence={leave}
        />
      ) : null}
    </div>
  );
}
