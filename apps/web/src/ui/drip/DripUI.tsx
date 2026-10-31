import { useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMonitorData } from "../monitor/useMonitorData";
import { useSessionStore } from "../../stores/sessionStore";
import { useViewModeStore } from "../../stores/viewModeStore";
import { useT } from "../../lib/i18n";
import { renderRun } from "../../lib/report";
import { formatOffset } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import "./drip.css";

/**
 * Drip — 输液: almost nothing.
 *
 * The packaged app puts this face in its own always-on-top window and shrinks
 * the main window around it. A browser cannot resize itself, so the browser
 * build keeps the whole viewport and hides the app behind the same backdrop the
 * widget floats over: the face is the pill, everything else is empty. The
 * desktop build should mount this same component in a small window instead of
 * in `#root`; nothing here assumes the window is large.
 *
 * Reading order, collapsed: the icon (state) and one dot at its bottom-right
 * (the attention level). Hovering stretches the middle to say what is
 * happening now. Clicking opens the card below: the live event list while the
 * agent works, the final reply when it rests, and the composer in either case.
 */

export interface DripProps {
  /**
   * Rendered inside a Document Picture-in-Picture window instead of the page.
   * The widget then anchors at the window's top-left, because the host resizes
   * the window as the pill expands — a right-anchored ball would jump sideways
   * every time the window grew.
   */
  pip?: boolean;
  /**
   * Rendered inside the desktop shell's floating window: a fixed, transparent
   * sheet where the ball is drawn at an offset the shell reports. Hover
   * stretches the strip and a click opens the card, all inside that sheet, so
   * nothing here changes the window's bounds.
   */
  desktop?: boolean;
  /**
   * Which edge of the window the widget hugs. The browser build grows a PiP
   * window rightwards, so it anchors left; the desktop face anchors whichever
   * side leaves room on screen so the strip never runs off an edge.
   */
  anchor?: "left" | "right";
  /**
   * Which way the card opens from the pill: downwards unless the ball sits too
   * close to the bottom of the screen, in which case it unfolds upwards.
   */
  vertical?: "down" | "up";
  /** Leave Drip and bring the last face back. Defaults to the mode store. */
  onOpenAbsence?: () => void;

  /**
   * Browser PiP only: reports the exact window size the face needs — `null` for
   * the ball, or the card's measured box plus its margins. Called from a layout
   * effect, which still runs inside the click's user gesture — `resizeTo`
   * refuses to work after that gesture expires.
   */
  onLayout?: (size: { width: number; height: number } | null) => void;
}

export function DripUI({
  pip = false,
  desktop = false,
  anchor = "left",
  vertical = "down",
  onOpenAbsence,
  onLayout,
}: DripProps = {}) {
  const t = useT();
  const data = useMonitorData();
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const runtime = useSessionStore((s) => s.session?.agentRuntime);
  const exitDrip = useViewModeStore((s) => s.exitDrip);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  /**
   * The card's height at the moment it opened, fixed for the PiP window.
   *
   * A PiP window can only be resized during the click's user gesture, so it
   * cannot grow when later events arrive. Freezing the card at its first
   * height keeps the composer inside the window; the event list then scrolls
   * in the body instead of pushing content past the bottom edge.
   */
  const [cardH, setCardH] = useState<number | null>(null);

  const leave = onOpenAbsence ?? exitDrip;

  /**
   * The window is fitted to the card, not to a guessed size: a short reply
   * gets a short window, a long event list gets one tall enough for all 430px.
   * The window has 8px above the pill, the 84px pill, a 10px gap and 8px
   * below.
   */
  const cardRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!open) setCardH(null);
    if (!onLayout) return;
    if (!open) {
      onLayout(null);
      return;
    }
    const card = cardRef.current;
    if (!card) return;
    const box = card.getBoundingClientRect();
    const height = Math.ceil(box.height);
    if (pip) setCardH(height);
    onLayout({ width: Math.ceil(box.width) + 16, height: height + 110 });
  }, [open, pip, onLayout]);

  const run = data.run;
  const running = run?.status === "running";
  const report = useMemo(() => (data.facts ? renderRun(data.facts) : undefined), [data.facts]);

  /**
   * The strip's second line, mirrored from the Monitor's run selector: how
   * long this round has been going and the tools it has used so far. A live
   * run's clock has to move without new events, hence its own second hand.
   */
  const now = useNow(1000);
  const elapsed = run ? formatOffset((run.endedAt ?? now) - run.startedAt) : "—";
  const counts = run
    ? `${elapsed} · R${run.counts.read} S${run.counts.search} E${run.counts.edit} $${run.counts.run}`
    : "—";
  const round = run ? `run #${run.index} · ${runtime ?? "—"}` : "—";

  const last = data.rows[data.rows.length - 1];
  const attention = data.attention;

  /**
   * The one thing the left orb's colour says: red only when the run itself
   * ended in error, green while work is in flight, blue otherwise — listening,
   * the state a dipped agent spends most of its life in. Attention is read in
   * the small orb on the right, not here.
   */
  const state = run?.status === "error" ? "error" : running ? "running" : "idle";

  const nowText = running
    ? (data.liveHeadline ?? (last ? `${last.action} ${last.primary}` : t("Waiting for the first event.")))
    : (last ? `${last.action} ${last.primary}` : t("Listening"));

  /** Newest first: the card is a glance, not a log. */
  const recent = data.rows.slice(-8).reverse();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await sendPrompt(text);
      setDraft("");
      setOpen(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className={`drip-root${pip ? " drip-root--pip" : ""}${desktop ? " drip-root--desktop" : ""}${
        anchor === "right" ? " drip-root--anchor-right" : ""
      }${vertical === "up" ? " drip-root--grow-up" : ""}`}
    >
      <div className="drip-widget">
        <button
          type="button"
          className={`drip-pill drip-pill--${state}${open ? " is-open" : ""}`}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          /* No `title`: a tooltip would hang outside the ball's window and read
             as the sentence leaking out of it. */
          aria-label={nowText}
        >
          <span className="drip-cap drip-cap--left">
            <span className="drip-orb drip-orb--state">
              <img src="/app-icon.png" alt="" />
            </span>
            {attention.level !== "none" ? (
              <span
                className={`drip-dot drip-dot--${attention.level}`}
                title={pip || desktop ? undefined : `${t(attention.level)} · ${attention.reasons.length}`}
              />
            ) : null}
          </span>

          <span className="drip-mid">
            {pip || desktop ? <span className="drip-mid__round">{round}</span> : null}
            <span className="drip-mid__now">{nowText}</span>
            {pip || desktop ? <span className="drip-mid__meta">{counts}</span> : null}
          </span>
        </button>

        {open ? (
          <div
            className="drip-card"
            role="dialog"
            aria-label={t("Drip")}
            ref={cardRef}
            style={pip && cardH ? { height: cardH } : undefined}
          >
            <div className="drip-card__head">
              <span className="drip-card__prompt">{run?.prompt ?? ""}</span>
              <button type="button" className="drip-open" onClick={leave}>
                {t("Open Absence")}
              </button>
            </div>

            <div className="drip-card__body">
              {running ? (
                recent.length > 0 ? (
                  <ul className="drip-evs">
                    {recent.map((row) => (
                      <li key={row.id} className="drip-e">
                        <span className={`drip-e__tag drip-tone--${row.tone}`}>{row.action}</span>
                        <span className="drip-e__text">{row.primary}</span>
                        <span className="drip-e__time">{row.time}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="drip-empty">{t("Waiting for the first event.")}</p>
                )
              ) : report?.response ? (
                <div className="drip-reply">{report.response}</div>
              ) : (
                <p className="drip-empty">{t("No reply yet.")}</p>
              )}
            </div>

            <form className="drip-form" onSubmit={submit}>
              <input
                className="drip-form__input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t("Send a task…")}
                aria-label={t("Send a task…")}
              />
              <button type="submit" className="drip-form__send" disabled={!draft.trim() || sending}>
                {t("Send")}
              </button>
            </form>
          </div>
        ) : null}
      </div>
    </div>
  );
}
