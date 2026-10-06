import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * The desk world — ported from the `daze-table.html` prototype.
 *
 * This is the Stage's *default page*: it is rendered as a persistent background
 * behind every other view, so FILE / DIFF / TERMINAL / LIVE appear as translucent
 * overlays on top of the desk rather than replacing it.
 *
 * `focus` frames the camera on the object the current action is about.
 */
export type WorldFocus = "desk" | "reading" | "editing" | "terminal" | "thinking";

interface StageWorldProps {
  focus?: WorldFocus;
}

/* ---------- camera: frame a rectangle given in viewBox units ---------- */
const VB = { w: 1200, h: 760 };
type Frame = { rect: [number, number, number, number]; fill: number };
const DESK_FRAME: Frame = { rect: [0, 0, 1200, 760], fill: 1 };
const FRAMES: Record<string, Frame> = {
  desk: DESK_FRAME,
  paperUp: { rect: [140, 165, 545, 480], fill: 0.88 }, // read: sheet lifted
  paper: { rect: [140, 205, 545, 520], fill: 0.88 }, // edit: sheet at rest
  screen: { rect: [688, 80, 1102, 540], fill: 0.92 }, // monitor + keyboard
};

const FOCUS_FRAME: Record<WorldFocus, keyof typeof FRAMES> = {
  desk: "desk",
  thinking: "desk",
  reading: "paperUp",
  editing: "paper",
  terminal: "screen",
};

const TERM_WORD = "----------DAZE----------";

export function StageWorld({ focus = "desk" }: StageWorldProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const termLineRef = useRef<SVGTextElement>(null);
  const termCursorRef = useRef<SVGRectElement>(null);
  const keysGroupRef = useRef<SVGGElement>(null);

  /* ---------- camera transform ---------- */
  useLayoutEffect(() => {
    const root = rootRef.current;
    const camera = cameraRef.current;
    if (!root || !camera) return;

    const frame = FRAMES[FOCUS_FRAME[focus]] ?? DESK_FRAME;
    const apply = () => {
      const W = root.clientWidth;
      const H = root.clientHeight;
      if (W === 0 || H === 0) return;
      const k = Math.min(W / VB.w, H / VB.h); // viewBox -> px (xMidYMid meet)
      const offX = (W - VB.w * k) / 2;
      const offY = (H - VB.h * k) / 2;
      const [x0, y0, x1, y1] = frame.rect;
      const cx = offX + ((x0 + x1) / 2) * k;
      const cy = offY + ((y0 + y1) / 2) * k;
      const w = (x1 - x0) * k;
      const h = (y1 - y0) * k;
      let s = Math.min((W * frame.fill) / w, (H * frame.fill) / h);
      if (FOCUS_FRAME[focus] === "desk") s = 1;
      s = Math.min(s, 4.5);
      const tx = W / 2 - cx;
      const ty = H / 2 - cy;
      camera.style.transform = `scale(${s}) translate(${tx}px, ${ty}px)`;
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(root);
    return () => observer.disconnect();
  }, [focus]);

  /* ---------- terminal typing loop + keyboard ---------- */
  useEffect(() => {
    if (focus !== "terminal") return;
    const line = termLineRef.current;
    const cursor = termCursorRef.current;
    if (!line || !cursor) return;

    const placeCursor = () => {
      let len = 0;
      try {
        len = line.getComputedTextLength();
      } catch {
        len = line.textContent.length * 11;
      }
      cursor.setAttribute("x", String(762 + len + 2));
    };

    let termTimer: ReturnType<typeof setTimeout> | null = null;
    let typingTimer: ReturnType<typeof setInterval> | null = null;
    const keys = keysGroupRef.current
      ? Array.from(keysGroupRef.current.querySelectorAll<SVGRectElement>(".key"))
      : [];

    let i = 0;
    const step = () => {
      i++;
      line.textContent = TERM_WORD.slice(0, i);
      placeCursor();
      if (i >= TERM_WORD.length) {
        termTimer = setTimeout(() => {
          i = 0;
          line.textContent = "";
          placeCursor();
          step();
        }, 1200);
      } else {
        termTimer = setTimeout(step, 95);
      }
    };
    line.textContent = "";
    placeCursor();
    step();

    typingTimer = setInterval(() => {
      if (keys.length === 0) return;
      const active = keys[Math.floor(Math.random() * keys.length)];
      if (!active) return;
      active.classList.add("pressed");
      setTimeout(() => active.classList.remove("pressed"), 90);
    }, 110);

    return () => {
      if (termTimer) clearTimeout(termTimer);
      if (typingTimer) clearInterval(typingTimer);
      line.textContent = "";
      placeCursor();
      keys.forEach((key) => key.classList.remove("pressed"));
    };
  }, [focus]);

  const classes = [
    "daze-world",
    focus === "reading" ? "reading focus-paper" : "",
    focus === "editing" ? "editing focus-paper" : "",
    focus === "terminal" ? "focus-screen" : "",
    focus === "thinking" ? "thinking" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={rootRef} className={classes} aria-hidden="true">
      <div ref={cameraRef} className="daze-world__camera">
        <svg viewBox="0 0 1200 760" preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id="dazeDeskGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#2a221c" />
              <stop offset="1" stopColor="#1b1815" />
            </linearGradient>
            <linearGradient id="dazeScreenGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#16201e" />
              <stop offset="1" stopColor="#0f0d0b" />
            </linearGradient>
            <filter id="dazeSoftGlow">
              <feGaussianBlur stdDeviation="10" />
            </filter>
          </defs>

          {/* DESK */}
          <g id="deskSurface">
            <rect
              x="35"
              y="35"
              width="1130"
              height="690"
              rx="18"
              fill="url(#dazeDeskGrad)"
              stroke="#2e2822"
            />
            <path
              d="M60 170 C300 125 540 185 790 135 S1060 140 1140 185"
              fill="none"
              stroke="rgba(224,164,88,.06)"
              strokeWidth={3}
            />
            <path
              d="M90 560 C330 520 560 585 830 540 S1060 530 1120 565"
              fill="none"
              stroke="rgba(224,164,88,.05)"
              strokeWidth={2}
            />
          </g>

          {/* MONITOR */}
          <g id="monitorGroup" className="object">
            <rect x="730" y="92" width="330" height="235" rx="12" fill="#211d19" stroke="#2e2822" />
            <rect x="748" y="110" width="294" height="198" rx="8" fill="url(#dazeScreenGrad)" />
            <rect
              id="monitorGlow"
              x="748"
              y="110"
              width="294"
              height="198"
              rx="8"
              fill="#5fa8a0"
              filter="url(#dazeSoftGlow)"
            />
            <rect id="screenWake" x="748" y="110" width="294" height="198" rx="8" fill="#e0a458" />
            <text x="766" y="148" fill="#5fa8a0" fontSize={13} fontFamily="monospace">
              $ daze-agent
            </text>
            <text id="termLine" ref={termLineRef} x="762" y="205" />
            <rect id="termCursor" ref={termCursorRef} x="762" y="189" width="10" height="18" rx="2" fill="#e0a458" />
            <text id="terminalText" x="766" y="245" fill="#9a8f80" fontSize={13} fontFamily="monospace">
              waiting...
            </text>
            <rect x="855" y="327" width="80" height="20" rx="6" fill="#2e2822" />
            <path d="M820 349 H970 L1000 372 H790 Z" fill="#211d19" stroke="#2e2822" />
          </g>

          {/* PAPER */}
          <g id="paperGroup" className="object">
            <rect
              id="paperSheet"
              x="150"
              y="220"
              width="380"
              height="285"
              rx="5"
              fill="#efe7db"
              transform="rotate(-4 340 362)"
            />
            <g
              id="paperWriting"
              transform="rotate(-4 340 362)"
              stroke="#9a8f80"
              strokeWidth={2}
              strokeLinecap="round"
            >
              <path d="M190 275 H465" />
              <path d="M190 305 H430" />
              <path d="M190 335 H470" />
              <path d="M190 365 H390" />
              <path d="M190 395 H450" />
              <path d="M190 425 H420" />
              <path d="M190 455 H350" />
            </g>
          </g>

          {/* PEN */}
          <g id="pen" className="object" transform="translate(490 470) rotate(32)">
            <rect x="-9" y="-95" width="18" height="120" rx="8" fill="#3a332c" stroke="#2e2822" />
            <polygon points="-9,25 9,25 0,48" fill="#e0a458" />
            <circle cx="0" cy="-72" r="3" fill="#9a8f80" />
          </g>

          {/* KEYBOARD */}
          <g id="keyboard" className="object" transform="translate(45,-80)">
            <rect x="650" y="480" width="400" height="130" rx="12" fill="#211d19" stroke="#2e2822" />
            <g id="keys" ref={keysGroupRef} fill="#3a332c">
              <rect className="key" x="675" y="505" width="34" height="20" rx="4" />
              <rect className="key" x="716" y="505" width="34" height="20" rx="4" />
              <rect className="key" x="757" y="505" width="34" height="20" rx="4" />
              <rect className="key" x="798" y="505" width="34" height="20" rx="4" />
              <rect className="key" x="839" y="505" width="34" height="20" rx="4" />
              <rect className="key" x="880" y="505" width="34" height="20" rx="4" />
              <rect className="key" x="921" y="505" width="34" height="20" rx="4" />
              <rect className="key" x="962" y="505" width="62" height="20" rx="4" />

              <rect className="key" x="675" y="535" width="46" height="20" rx="4" />
              <rect className="key" x="728" y="535" width="34" height="20" rx="4" />
              <rect className="key" x="769" y="535" width="34" height="20" rx="4" />
              <rect className="key" x="810" y="535" width="34" height="20" rx="4" />
              <rect className="key" x="851" y="535" width="34" height="20" rx="4" />
              <rect className="key" x="892" y="535" width="34" height="20" rx="4" />
              <rect className="key" x="933" y="535" width="91" height="20" rx="4" />

              <rect className="key" x="675" y="565" width="60" height="20" rx="4" />
              <rect className="key" x="742" y="565" width="34" height="20" rx="4" />
              <rect className="key" x="783" y="565" width="34" height="20" rx="4" />
              <rect className="key" x="824" y="565" width="34" height="20" rx="4" />
              <rect className="key" x="865" y="565" width="34" height="20" rx="4" />
              <rect className="key" x="906" y="565" width="34" height="20" rx="4" />
              <rect className="key" x="947" y="565" width="77" height="20" rx="4" />
            </g>
            <rect x="780" y="592" width="150" height="8" rx="4" fill="#2e2822" />
          </g>

          {/* COFFEE */}
          <g id="coffee">
            <ellipse id="coffeeShadow" cx="610" cy="424" rx="50" ry="15" fill="#000" opacity=".32" />
            <g id="coffeeCup">
              <path
                d="M651 356 C697 346 697 392 654 388"
                fill="none"
                stroke="#efe7db"
                strokeWidth={12}
                strokeLinecap="round"
              />
              <rect x="575" y="332" width="70" height="82" rx="12" fill="#efe7db" />
              <ellipse cx="610" cy="332" rx="35" ry="12" fill="#553a29" />
              <g id="coffeeLid">
                <ellipse cx="610" cy="330" rx="39" ry="13" fill="#cfc7b8" />
                <ellipse cx="610" cy="330" rx="25" ry="7" fill="#bdb3a2" />
                <rect x="606" y="313" width="8" height="9" rx="3" fill="#9a8f80" />
              </g>
              <g id="coffeeSteam">
                <path className="steam s1" d="M596 318 C590 306 602 300 596 288" />
                <path className="steam s2" d="M610 314 C604 300 616 294 610 280" />
                <path className="steam s3" d="M624 318 C618 306 630 300 624 288" />
              </g>
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}
