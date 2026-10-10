import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AgentStatus } from "@absence/core";
import { type AgentVisualState } from "../../lib/agent";
import { AgentStatusRow } from "./AgentStatusRow";
import "./whalebun.css";

/* ══════════════════════════════════════════════════════════════════════════
   WhaleBun — 鲸团团（毛绒鲸鱼套装虚拟形象） ("the agent")

   Ported from the standalone page at E:/dd/jy/agent/index.html, with the part
   boxes taken from whalebun.json. The PNG parts live in apps/web/public/whalebun/ and
   the stylesheet is generated into whalebun.css by scripts/gen-whalebun-css.mjs and
   scoped under .whalebun-root, so it cannot leak into the rest of the app.

   Unlike the original page (which has its own toolbar), the pose is driven by
   the agent's visual state — the same AgentVisualState seam the placeholder
   used, so nothing above this component changes.
   ══════════════════════════════════════════════════════════════════════════ */

/** The nine poses the character is authored with. */
type WhaleBunState =
  | "relax"
  | "think"
  | "speak"
  | "wait"
  | "read"
  | "type"
  | "write"
  | "confuse"
  | "error";

/** ABSENCE status → WhaleBun pose (README §Agent status). */
const STATE_FOR: Record<AgentStatus, WhaleBunState> = {
  listening: "relax",
  thinking: "think",
  speaking: "speak",
  reading: "read",
  searching: "read",
  editing: "write",
  running: "type",
  waiting: "wait",
  error: "error",
};

/** Which face a pose shows; `cycle` alternates two faces, `blink` winks. */
const FACE_FOR: Record<WhaleBunState, { face: string; blink?: boolean; cycle?: string[]; ms?: number }> = {
  relax: { face: "face_nomal", blink: true },
  think: { face: "face_serious" },
  speak: { face: "face_silly" },
  wait: { face: "face_eyesclose" },
  read: { face: "face_serious" },
  type: { face: "face_nomal" },
  write: { face: "face_serious" },
  confuse: { face: "face_surprised" },
  error: { face: "face_cry", cycle: ["face_cry", "face_surprised"], ms: 430 },
};

/** [name, left, top, width, height, z] on the 2048×2048 design canvas.
    z 110–200 leaves room for the props (175–180) to sit between the body and
    the hands, which is what makes them look held rather than pasted on. */
type Box = readonly [string, number, number, number, number, number?];

const PART = {
  tail: ["tail", 1293, 964, 450, 389, 110],
  head: ["head", 651, 863, 746, 623, 120],
  ahoge: ["ahoge", 813, 509, 423, 262, 140],
  body: ["body", 402, 406, 1244, 1235, 150],
  foot_right: ["foot_right", 727, 1475, 175, 133, 160],
  foot_left: ["foot_left", 1159, 1478, 176, 134, 170],
  hand_right: ["hand_right", 517, 1180, 183, 162, 190],
  hand_left: ["hand_left", 1370, 1180, 183, 162, 200],
} as const satisfies Record<string, Box>;

/** Seven interchangeable faces share one slot (face_eyesclose is aligned by eye). */
const FACES: Box[] = [
  ["face_nomal", 736, 1089, 577, 376],
  ["face_eyesclose", 756, 1098, 549, 376],
  ["face_silly", 762, 1092, 533, 378],
  ["face_wink", 749, 1095, 573, 385],
  ["face_surprised", 738, 1096, 579, 369],
  ["face_serious", 757, 1101, 549, 376],
  ["face_cry", 744, 1091, 553, 386],
];

const HAIR: Box = ["hair", 689, 769, 708, 648];

/** Keyboard rows: per-key flex weights (plain 1, Enter 1.7, Shift 1.5, Space 5). */
const KB_ROWS: { indent: number; keys: number[] }[] = [
  { indent: 0, keys: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
  { indent: 26, keys: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
  { indent: 46, keys: [1.7, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
  { indent: 16, keys: [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 5, 1, 1, 1.5] },
];

function Part({ box, cls }: { box: Box; cls?: string }) {
  const [name, left, top, width, height, z] = box;
  return (
    <div className={`part ${cls ?? "p-" + name}`} style={{ left, top, width, height, zIndex: z }}>
      <img src={`/whalebun/${name}.png`} alt={name} draggable={false} />
    </div>
  );
}

function PropPaper() {
  return (
    <div className="fx-item prop-paper">
      <span className="ln l1" />
      <span className="ln l2" />
      <span className="ln l3" />
      <span className="ln l4" />
      <span className="ln l5" />
      <span className="inkwrap">
        <svg viewBox="0 0 250 100">
          <path d="M6 82 C 28 20, 52 20, 70 82 S 110 20, 128 82 S 168 20, 186 82 S 226 32, 244 60" />
        </svg>
      </span>
    </div>
  );
}

function PropPen() {
  return (
    <div className="fx-item prop-pen">
      <span className="pen-rot">
        <svg viewBox="0 0 244 72">
          <polygon points="2,36 34,20 34,52" fill="#efd2ac" />
          <polygon points="2,36 13,29 13,43" fill="#3d4b5c" />
          <rect x="34" y="20" width="152" height="32" rx="5" fill="#f5c765" />
          <rect x="34" y="20" width="152" height="10" rx="5" fill="#ffdd93" />
          <rect x="34" y="44" width="152" height="8" rx="4" fill="#dfa93f" />
          <rect x="186" y="16" width="18" height="40" rx="5" fill="#b8c6d6" />
          <rect x="204" y="19" width="36" height="34" rx="12" fill="#f4a3ac" />
        </svg>
      </span>
    </div>
  );
}

function PropCup() {
  return (
    <div className="fx-item prop-cup">
      <svg viewBox="0 0 170 190">
        <defs>
          <linearGradient id="whalebun-cupShade" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="55%" stopColor="#f7fbff" />
            <stop offset="100%" stopColor="#dae7f5" />
          </linearGradient>
        </defs>
        {/* handle */}
        <path
          d="M128 66 C 162 66, 162 116, 128 116"
          fill="none"
          stroke="#c3d6e9"
          strokeWidth="19"
          strokeLinecap="round"
        />
        <path
          d="M128 66 C 162 66, 162 116, 128 116"
          fill="none"
          stroke="#ffffff"
          strokeWidth="13"
          strokeLinecap="round"
        />
        {/* body */}
        <path
          d="M20 40 H128 L119 158 A16 16 0 0 1 103 174 H45 A16 16 0 0 1 29 158 Z"
          fill="url(#whalebun-cupShade)"
          stroke="#c3d6e9"
          strokeWidth="3"
        />
        <path d="M40 52 L33 152 A11 11 0 0 0 44 163 H50 L57 52 Z" fill="#ffffff" opacity=".9" />
        {/* rim + coffee */}
        <ellipse cx="74" cy="40" rx="54" ry="15" fill="#ffffff" stroke="#c3d6e9" strokeWidth="3" />
        <ellipse cx="74" cy="41" rx="44" ry="11" fill="#7a4a2e" />
        <ellipse cx="74" cy="41" rx="44" ry="11" fill="none" stroke="#b98a63" strokeWidth="2" opacity=".65" />
      </svg>
      <span className="steam">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function PropKeyboard() {
  return (
    <div className="fx-item prop-kb">
      <div className="kb-rows">
        {KB_ROWS.map((row, r) => (
          <div className="kb-row" key={r} style={{ paddingLeft: row.indent }}>
            {row.keys.map((flex, c) => (
              <i key={c} style={{ flex, "--c": c, "--r": r } as CSSProperties} />
            ))}
          </div>
        ))}
      </div>
      <span className="kb-sweep" />
    </div>
  );
}

function Fx() {
  return (
    <div className="fx">
      <div className="fx-item fx-relax">
        <span>♪</span>
        <span>♫</span>
        <span>♪</span>
      </div>

      <div className="fx-item fx-think">
        <div className="loader">
          <svg viewBox="0 0 72 72">
            <circle className="track" cx="36" cy="36" r="26" />
            <circle className="arc" cx="36" cy="36" r="26" />
          </svg>
        </div>
        <span className="t1" />
        <span className="t2" />
      </div>

      <div className="fx-item fx-speak">
        <div className="cloud">
          <i />
          <i />
          <i />
        </div>
        <span className="t1" />
        <span className="t2" />
      </div>

      <div className="fx-item fx-wait">
        <span>Z</span>
        <span>Z</span>
        <span>Z</span>
      </div>

      <div className="fx-item fx-read">
        <span className="glow" />
      </div>

      <div className="fx-item fx-type">
        <span className="spark d1" />
        <span className="spark d2" />
        <span className="spark d3" />
        <span className="spark d4" />
      </div>

      <div className="fx-item fx-confuse">
        <span>?</span>
      </div>

      <div className="fx-item fx-error">
        <div className="flash" />
        <span className="bang b1">!</span>
        <span className="bang b2">!</span>
      </div>
    </div>
  );
}

/** Blink / expression cycling, mirroring the original page's setState. */
function useFace(state: WhaleBunState): string {
  const [face, setFace] = useState(FACE_FOR[state].face);

  useEffect(() => {
    const cfg = FACE_FOR[state];
    setFace(cfg.face);

    let cycle: ReturnType<typeof setInterval> | undefined;
    let wink: ReturnType<typeof setTimeout> | undefined;
    let restore: ReturnType<typeof setTimeout> | undefined;

    if (cfg.cycle) {
      const list = cfg.cycle;
      let i = 0;
      cycle = setInterval(() => {
        i = (i + 1) % list.length;
        setFace(list[i] ?? cfg.face);
      }, cfg.ms);
    } else if (cfg.blink) {
      const schedule = () => {
        wink = setTimeout(
          () => {
            setFace("face_eyesclose");
            restore = setTimeout(() => setFace(cfg.face), 125);
            schedule();
          },
          3400 + Math.random() * 3600,
        );
      };
      schedule();
    }

    return () => {
      clearInterval(cycle);
      clearTimeout(wink);
      clearTimeout(restore);
    };
  }, [state]);

  return face;
}

/** Scale the 2048px canvas to fit the container, like the original page's fit(). */
function useFit() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.2);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const s = Math.min((el.clientWidth - 24) / 1420, (el.clientHeight - 24) / 1330, 1.25);
      setScale(Math.max(s, 0.02));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, scale };
}

/**
 * The agent's avatar: the WhaleBun character, posed entirely by the event stream.
 * Drop-in replacement for the old CSS/SVG placeholder — same `visual` prop.
 */
export function Avatar({ visual }: { visual: AgentVisualState }) {
  const status = visual.status;
  const mood = visual.mood ?? "calm";
  const state = STATE_FOR[status];
  const face = useFace(state);
  const { ref, scale } = useFit();

  return (
    <div className="whalebun-root flex h-full flex-col" data-mood={mood} data-state={state}>
      <div ref={ref} className="viewport min-h-0 flex-1" role="img" aria-label={`Agent ${status}`}>
        <div className={`stage s-${state}`} style={{ "--s": scale } as CSSProperties}>
          <div className="shadow" />

          <div className="char-sway">
            <div className="char-float">
              <div className="char-squash">
                {/* props: z 175–180 sits between the body (150) and the hands (190/200) */}
                <PropPaper />
                <PropPen />
                <PropCup />
                <PropKeyboard />

                <Part box={PART.tail} />
                <Part box={PART.head} />

                {/* faces + hair + ahoge share one group so they can look / turn together */}
                <div className="g-face">
                  {FACES.map((f) => (
                    <Part key={f[0]} box={f} cls={"p-face" + (face === f[0] ? " on" : "")} />
                  ))}
                  <Part box={HAIR} />
                  <Part box={PART.ahoge} />
                </div>

                <Part box={PART.body} />
                <Part box={PART.foot_right} />
                <Part box={PART.foot_left} />
                <Part box={PART.hand_right} />
                <Part box={PART.hand_left} />
              </div>
            </div>
          </div>

          <Fx />
        </div>
      </div>

      <AgentStatusRow status={status} />
    </div>
  );
}
