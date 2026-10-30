import { useMemo, useState, type FormEvent } from "react";
import { useMonitorData } from "../monitor/useMonitorData";
import { useSessionStore } from "../../stores/sessionStore";
import { useViewModeStore } from "../../stores/viewModeStore";
import { useT } from "../../lib/i18n";
import { renderRun } from "../../lib/report";
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

export function DripUI() {
  const t = useT();
  const data = useMonitorData();
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const setMode = useViewModeStore((s) => s.setMode);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const run = data.run;
  const running = run?.status === "running";
  const report = useMemo(() => (data.facts ? renderRun(data.facts) : undefined), [data.facts]);

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
    <div className="drip-root">
      <div className="drip-widget">
        <button
          type="button"
          className={`drip-pill drip-pill--${state}${open ? " is-open" : ""}`}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={nowText}
        >
          <span className="drip-cap drip-cap--left">
            <span className="drip-orb drip-orb--state">
              <img src="/app-icon.png" alt="" />
            </span>
            {attention.level !== "none" ? (
              <span
                className={`drip-dot drip-dot--${attention.level}`}
                title={`${t(attention.level)} · ${attention.reasons.length}`}
              />
            ) : null}
          </span>

          <span className="drip-mid">
            <span className="drip-mid__now">{nowText}</span>
          </span>
        </button>

        {open ? (
          <div className="drip-card" role="dialog" aria-label={t("Drip")}>
            <div className="drip-card__head">
              <button type="button" className="drip-open" onClick={() => setMode("monitor")}>
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
