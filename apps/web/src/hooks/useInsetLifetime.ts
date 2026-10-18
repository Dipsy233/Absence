import { useEffect } from "react";
import { EXIT_MS, HOLD_MS, shouldAutoRetract } from "../lib/terminalInset";
import { useSessionStore } from "../stores/sessionStore";

/**
 * Drives the docked MCP inset's lifetime.
 *
 * The store only decides *what* is docked; timing is a side effect and lives
 * here, in one place, so the store stays a plain reducer. Two timers:
 *
 *   hold     a finished call counts down HOLD_MS, then folds away
 *   finish   once folded (`closing`), the dock empties after EXIT_MS so the
 *            card animates out instead of vanishing
 *
 * A call in flight (`phase: "call"`) and a pinned one arm no timer at all: a slow
 * server stays visible however long it is slow, and a click from Activity holds
 * the card until it is dismissed.
 */
export function useInsetLifetime() {
  const inset = useSessionStore((s) => s.inset);
  const retractInset = useSessionStore((s) => s.retractInset);
  const closeInset = useSessionStore((s) => s.closeInset);

  useEffect(() => {
    if (!inset.item) return;
    if (inset.phase === "closing") {
      const timer = setTimeout(closeInset, EXIT_MS);
      return () => clearTimeout(timer);
    }
    if (!shouldAutoRetract(inset)) return;
    const timer = setTimeout(retractInset, HOLD_MS);
    return () => clearTimeout(timer);
  }, [inset, retractInset, closeInset]);
}
