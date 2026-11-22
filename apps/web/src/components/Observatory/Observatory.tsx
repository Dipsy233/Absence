import { useEffect, useState } from "react";
import type { AcpProxySessionRow, ObserveSessionRow, SessionHistoryEntry } from "@absence/core";
import { attachTranscript, deleteSessionArchive, fetchObserveBoard, fetchProxySessions, fetchSessionHistory } from "../../lib/api";
import { useSessionStore } from "../../stores/sessionStore";
import { resetAllStores } from "../../stores/reset";
import { useT } from "../../lib/i18n";
import { WindowControls } from "../common/WindowControls";
import "../../ui/shared/themes.css";
import "../../ui/shared/observatory.css";

/**
 * The Observatory — the observation board, the app's entry page.
 *
 * Absence starts no agent here. It lists what it can already see: the
 * transcripts agent software writes on its own (attach = monitor one), the ACP
 * proxies running on this host, and the archived sessions it has already
 * recorded. Opening a row never launches anything; the agents the rows describe
 * are running in the user's own terminal (or editor), exactly as they always
 * were.
 */

function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function formatAgo(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function Observatory() {
  const t = useT();
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const openSession = useSessionStore((s) => s.openSession);

  const [tails, setTails] = useState<ObserveSessionRow[]>([]);
  const [sources, setSources] = useState<Array<{ id: string; label: string; roots: string[]; watched: boolean }>>([]);
  const [proxies, setProxies] = useState<AcpProxySessionRow[]>([]);
  const [sessions, setSessions] = useState<SessionHistoryEntry[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      fetchObserveBoard()
        .then((board) => {
          if (!alive) return;
          setTails(board.sessions);
          setSources(board.sources);
        })
        .catch(() => undefined);
      fetchProxySessions()
        .then((body) => alive && setProxies(body.sessions))
        .catch(() => undefined);
      fetchSessionHistory()
        .then((list) => alive && setSessions(list))
        .catch(() => undefined);
    };
    refresh();
    // The board is a glance: tails move on their own, so the lists refresh on a
    // slow cadence while the page is open.
    const refreshTimer = window.setInterval(refresh, 5000);
    const clockTimer = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => {
      alive = false;
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, []);

  const withBusy = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  /** Attach a transcript (full backfill) and enter the session it names. */
  const attach = (row: ObserveSessionRow) =>
    withBusy(row.file, async () => {
      resetAllStores();
      const attached = row.sessionId ? row : await attachTranscript(row.file);
      if (attached.sessionId) await openSession(attached.sessionId);
      else setError(t("The transcript could not be attached (identity unknown)."));
    });

  const resume = (entry: SessionHistoryEntry) =>
    withBusy(entry.absenceSessionId ?? entry.id, async () => {
      if (!entry.absenceSessionId) {
        setError(t("This archive predates Absence's own session ids and cannot be reopened."));
        return;
      }
      resetAllStores();
      await resumeSession(entry);
    });

  const openProxy = (row: AcpProxySessionRow) =>
    withBusy(row.id, async () => {
      if (!row.sessionId) return;
      resetAllStores();
      await openSession(row.sessionId);
    });

  /** Remove one archive entirely (events, runs, files, metrics, the row). */
  const removeArchive = (entry: SessionHistoryEntry) =>
    withBusy(`del-${entry.id}`, async () => {
      if (!entry.absenceSessionId) return;
      if (!window.confirm(t("Delete the archive of {path}? This cannot be undone.", { path: entry.projectPath }))) return;
      await deleteSessionArchive(entry.absenceSessionId);
      setSessions((current) => current.filter((row) => row.id !== entry.id));
    });

  void tick; // the clock re-renders the "ago" columns

  return (
    <div className="picker-root">
      <div className="picker-shell">
        <header className="picker-head">
          <h1 className="picker-title">ABSENCE</h1>
          <p className="picker-sub">{t("The observation board — nothing here starts an agent.")}</p>
          <WindowControls />
        </header>

        {error ? <p className="picker-error">{error}</p> : null}

        <section className="picker-card">
          <h2 className="picker-card__title">{t("Live observation — transcripts")}</h2>
          <p className="picker-card__note">
            {t("Session files the agent software writes on its own. Attach one to monitor it, whenever you like.")}
          </p>
          {sources.length > 0 ? (
            <p className="picker-card__note picker-card__note--dim">
              {sources
                .map((source) => `${source.label}: ${source.roots.join(", ")}`)
                .join(" · ")}
            </p>
          ) : null}
          {tails.length === 0 ? (
            <p className="picker-empty">{t("No transcripts found yet.")}</p>
          ) : (
            <ul className="picker-list">
              {tails.map((row) => (
                <li key={row.file} className="picker-row">
                  <span className="picker-row__main">
                    <span className="picker-row__kind">{row.agentKind}</span>
                    <span className="picker-row__path" title={row.file}>
                      {row.projectPath ?? row.file}
                    </span>
                  </span>
                  <span className="picker-row__meta">
                    {t("{time} active", { time: formatAgo(row.lastActivityAt) })} ·{" "}
                    {t("{n} events", { n: row.events })}
                    {row.malformed > 0 ? ` · ${t("{n} malformed", { n: row.malformed })}` : ""}
                  </span>
                  {row.sessionId ? (
                    <button
                      type="button"
                      className="picker-btn"
                      disabled={busy !== undefined}
                      onClick={() => void attach(row)}
                    >
                      {busy === row.file ? t("opening…") : t("Open")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="picker-btn picker-btn--pri"
                      disabled={busy !== undefined}
                      onClick={() => void attach(row)}
                    >
                      {busy === row.file ? t("attaching…") : t("Attach")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="picker-card">
          <h2 className="picker-card__title">{t("ACP proxies")}</h2>
          <p className="picker-card__note">
            {t("Agents an editor ACP client reaches through Absence's proxy — byte-level facts, exact processes.")}
          </p>
          {proxies.length === 0 ? (
            <p className="picker-empty">{t("No proxy sessions on this host.")}</p>
          ) : (
            <ul className="picker-list">
              {proxies.map((row) => (
                <li key={row.id} className="picker-row">
                  <span className="picker-row__main">
                    <span className="picker-row__kind">{row.label}</span>
                    <span className="picker-row__path" title={row.cwd}>
                      {row.cwd}
                    </span>
                  </span>
                  <span className="picker-row__meta">
                    {row.status}
                    {row.pid ? ` · pid ${row.pid}` : ""}
                    {row.endpoint ? ` · ${row.endpoint.host}:${row.endpoint.port}` : ""}
                    {row.closedAt ? ` · ${t("closed {time}", { time: formatWhen(row.closedAt) })}` : ""}
                  </span>
                  {row.sessionId ? (
                    <button
                      type="button"
                      className="picker-btn"
                      disabled={busy !== undefined}
                      onClick={() => void openProxy(row)}
                    >
                      {t("Open")}
                    </button>
                  ) : (
                    <span className="picker-row__meta">{t("waiting for a client")}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="picker-card">
          <h2 className="picker-card__title">{t("History")}</h2>
          <p className="picker-card__note">{t("Everything Absence has already recorded.")}</p>
          {sessions.length === 0 ? (
            <p className="picker-empty">{t("No saved sessions yet.")}</p>
          ) : (
            <ul className="picker-list">
              {sessions.map((entry) => (
                <li key={entry.id} className="picker-row">
                  <span className="picker-row__main">
                    <span className="picker-row__kind">{entry.runtime}</span>
                    <span className="picker-row__path" title={entry.projectPath}>
                      {entry.projectPath}
                    </span>
                  </span>
                  <span className="picker-row__meta">
                    {formatWhen(entry.updatedAt)} · {t("{n} msgs", { n: entry.messageCount })}
                    {entry.firstPrompt ? ` · ${entry.firstPrompt}` : ""}
                  </span>
                  {entry.absenceSessionId ? (
                    <>
                      <button
                        type="button"
                        className="picker-btn"
                        disabled={busy !== undefined}
                        onClick={() => void resume(entry)}
                      >
                        {t("Resume {id}", { id: entry.absenceSessionId.slice(-4) })}
                      </button>
                      <button
                        type="button"
                        className="picker-btn picker-btn--danger"
                        title={t("Delete archive")}
                        disabled={busy !== undefined}
                        onClick={() => void removeArchive(entry)}
                      >
                        ✕
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
