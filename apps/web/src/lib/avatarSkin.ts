import { useEffect, useState } from "react";
import type { AgentStatus } from "@absence/core";

/* ══════════════════════════════════════════════════════════════════════════
   Avatar skin — the seam for replacing the built-in WhaleBun character with
   user-uploaded media, managed entirely from the Settings dialog (no URLs).

   The user picks a status and uploads a file (mp4 / gif / png / webp / svg);
   the file lands in <server>/avatar-skins/<skin name>/<status>.<ext> and the
   active skin's files are served at /avatar/<status>.

   This hook asks the server which statuses have an uploaded file. A status
   without one falls back to the built-in HTML character for that status, so a
   half-finished skin still works.
   ══════════════════════════════════════════════════════════════════════════ */

/** Which statuses the active skin covers (has a file for). */
export interface AvatarSkinCoverage {
  active: string;
  /** Status → stored file name (e.g. thinking → thinking.mp4). */
  files: Partial<Record<string, string>>;
}

/** Re-check this often so an upload applies without a reload. */
const POLL_MS = 4000;

export function useAvatarSkinCoverage(): AvatarSkinCoverage | undefined {
  const [coverage, setCoverage] = useState<AvatarSkinCoverage | undefined>();

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/avatar-skins", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as {
          active: string;
          activeFiles: Partial<Record<string, string>>;
        };
        if (!alive) return;
        setCoverage({
          active: json.active,
          files: json.activeFiles ?? {},
        });
      } catch {
        // Server unreachable: keep whatever we had.
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return coverage;
}

/** URL of the uploaded media for a status, or undefined to use the builtin. */
/**
 * Media for a status: the URL to render plus whether it is a video.
 * A status without its own file falls back to the skin's "default" file;
 * neither present means the built-in WhaleBun character.
 */
export function skinMediaFor(
  coverage: AvatarSkinCoverage | undefined,
  status: AgentStatus,
): { src: string; video: boolean } | undefined {
  if (!coverage || !coverage.active) return undefined;
  // The stored file name decides video vs image — the served URL has no
  // extension, so it cannot be sniffed from the URL alone.
  const fileName = coverage.files[status] ?? coverage.files.default;
  if (!fileName) return undefined;
  const served = coverage.files[status] ? status : "default";
  return {
    src: `/avatar/${served}?v=${coverage.active}`,
    video: /\.(mp4|webm|mov)$/i.test(fileName),
  };
}
