import type { AgentStatus } from "@daze/core";
import { statusLabel, type AgentVisualState } from "../../lib/agent";

interface Pose {
  headRotate: number;
  headY: number;
  armRotate: number;
  breathe: string;
  prop?: "paper" | "keyboard" | "monitor" | "coffee";
  dots: boolean;
  question: boolean;
}

function poseFor(status: AgentStatus): Pose {
  switch (status) {
    case "thinking":
      return { headRotate: -10, headY: 2, armRotate: 0, breathe: "daze-breathe 2.4s ease-in-out infinite", dots: true, question: false };
    case "speaking":
      return { headRotate: 0, headY: 0, armRotate: -6, breathe: "daze-breathe 2.2s ease-in-out infinite", dots: true, question: false };
    case "reading":
      return { headRotate: 10, headY: 3, armRotate: -14, breathe: "daze-breathe 3s ease-in-out infinite", prop: "paper", dots: false, question: false };
    case "searching":
      return { headRotate: 6, headY: 2, armRotate: -10, breathe: "daze-breathe 2.8s ease-in-out infinite", prop: "paper", dots: false, question: false };
    case "editing":
      return { headRotate: 6, headY: 3, armRotate: -24, breathe: "daze-breathe 2.6s ease-in-out infinite", prop: "keyboard", dots: false, question: false };
    case "running":
      return { headRotate: 0, headY: 1, armRotate: -8, breathe: "daze-breathe 3.2s ease-in-out infinite", prop: "monitor", dots: false, question: false };
    case "waiting":
      return { headRotate: 14, headY: 6, armRotate: 0, breathe: "daze-breathe 3.6s ease-in-out infinite", prop: "coffee", dots: false, question: false };
    case "error":
      return { headRotate: -18, headY: 0, armRotate: 0, breathe: "none", dots: false, question: true };
    default:
      return { headRotate: 0, headY: 0, armRotate: 0, breathe: "daze-breathe 3s ease-in-out infinite", prop: "coffee", dots: false, question: false };
  }
}

/**
 * A CSS/SVG placeholder character driven by the agent's visual state
 * (read02 §31–33). v0.3 can swap the artwork for Live2D without changing
 * the state machine.
 */
export function Avatar({ visual }: { visual: AgentVisualState }) {
  const status = visual.status;
  const pose = poseFor(status);
  const mood = visual.mood ?? "calm";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3" data-mood={mood}>
      <svg viewBox="0 0 200 150" className="w-[85%] max-w-[280px]" role="img" aria-label={`Agent ${status}`}>
        {/* desk */}
        <rect x="18" y="118" width="164" height="5" rx="2" fill="#2e2822" />
        <rect x="30" y="123" width="6" height="22" fill="#241f1a" />
        <rect x="164" y="123" width="6" height="22" fill="#241f1a" />

        {/* props */}
        {pose.prop === "monitor" ? (
          <g>
            <rect x="118" y="62" width="56" height="40" rx="3" fill="#211d19" stroke="#2e2822" />
            <rect x="123" y="67" width="46" height="30" rx="2" fill="#0f0d0b" />
            <rect x="138" y="102" width="16" height="6" fill="#2e2822" />
            <rect x="146" y="96" width="2" height="8" fill="#2e2822" />
          </g>
        ) : null}
        {pose.prop === "keyboard" ? (
          <rect x="108" y="104" width="66" height="10" rx="3" fill="#211d19" stroke="#2e2822" />
        ) : null}
        {pose.prop === "paper" ? (
          <g>
            <rect x="112" y="96" width="46" height="22" rx="2" fill="#efe7db" opacity="0.9" />
            <line x1="118" y1="103" x2="152" y2="103" stroke="#9a8f80" strokeWidth="1.5" />
            <line x1="118" y1="108" x2="146" y2="108" stroke="#9a8f80" strokeWidth="1.5" />
          </g>
        ) : null}
        {pose.prop === "coffee" ? (
          <g>
            <rect x="146" y="98" width="16" height="18" rx="2" fill="#c56b3f" />
            <path d="M162 103 q8 3 0 8" fill="none" stroke="#c56b3f" strokeWidth="2.5" />
          </g>
        ) : null}

        <g style={{ animation: pose.breathe, transformOrigin: "88px 110px" }}>
          <path d="M64 118 q0 -34 24 -34 q24 0 24 34 z" fill="#3a332c" />
          <g style={{ transform: `rotate(${pose.armRotate}deg)`, transformOrigin: "104px 96px" }}>
            <rect x="100" y="92" width="10" height="26" rx="5" fill="#4a4139" />
          </g>

          <g
            style={{
              transform: `translateY(${pose.headY}px) rotate(${pose.headRotate}deg)`,
              transformOrigin: "88px 62px",
              transition: "transform 500ms ease",
            }}
          >
            <circle cx="88" cy="62" r="17" fill="#e0a458" />
            <circle cx="82" cy="60" r="2.4" fill="#141210" />
            <circle cx="95" cy="60" r="2.4" fill="#141210" />
            {pose.question ? (
              <text x="110" y="46" fill="#c56b3f" fontSize="18" fontWeight="bold">
                ?
              </text>
            ) : null}
          </g>
        </g>

        {pose.dots ? (
          <g fill="#9a8f80">
            <circle cx="112" cy="46" r="2.5" style={{ animation: "daze-blink 1.6s infinite" }} />
            <circle cx="122" cy="46" r="2.5" style={{ animation: "daze-blink 1.6s infinite 0.2s" }} />
            <circle cx="132" cy="46" r="2.5" style={{ animation: "daze-blink 1.6s infinite 0.4s" }} />
          </g>
        ) : null}
      </svg>

      <div className="flex items-center gap-2">
        <span
          className={[
            "h-1.5 w-1.5 rounded-full",
            status === "error"
              ? "bg-desk-ember"
              : status === "idle" || status === "completed"
                ? "bg-desk-dim"
                : "bg-desk-teal",
          ].join(" ")}
        />
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-desk-dim">
          {statusLabel(status)}
        </span>
      </div>
    </div>
  );
}
