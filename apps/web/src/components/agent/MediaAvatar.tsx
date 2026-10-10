import { useState } from "react";
import type { AgentStatus } from "@absence/core";
import { type AgentVisualState } from "../../lib/agent";
import { AgentStatusRow } from "./AgentStatusRow";

/* ══════════════════════════════════════════════════════════════════════════
   MediaAvatar — renders an uploaded animation as <video> (mp4/webm/mov) or
   <img> (gif/png/webp/svg), filling the panel while preserving the same
   `visual` prop contract as the built-in Avatar.
   ══════════════════════════════════════════════════════════════════════════ */

function MediaFrame({ src, video, status }: { src: string; video: boolean; status: AgentStatus }) {
  const [failed, setFailed] = useState(false);

  if (video) {
    if (failed) {
      return (
        <div className="flex h-full items-center justify-center p-2 text-center">
          <p className="text-[10px] leading-snug text-desk-ember">
            this video can't be decoded by the browser —
            re-encode it (H.264, yuv420p, faststart)
          </p>
        </div>
      );
    }
    return (
      <video
        key={src}
        src={src}
        className="h-full w-full"
        style={{ objectFit: "contain" }}
        autoPlay
        loop
        playsInline
        muted
        aria-label={`Agent ${status}`}
        onError={() => setFailed(true)}
        // Some browsers pause muted videos offscreen; nudge them alive.
        onLoadedData={(e) => void e.currentTarget.play().catch(() => {})}
      />
    );
  }
  return (
    <img
      key={src}
      src={src}
      alt={`Agent ${status}`}
      draggable={false}
      className="h-full w-full select-none"
      style={{ objectFit: "contain" }}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Media-backed avatar. Drop-in replacement for the HTML character — same
 * `visual` prop. Rendered only when a skin file exists for this status.
 */
export function MediaAvatar({
  visual,
  src,
  video,
}: {
  visual: AgentVisualState;
  src: string;
  video: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <MediaFrame src={src} video={video} status={visual.status} />
      </div>
      <AgentStatusRow status={visual.status} />
    </div>
  );
}
