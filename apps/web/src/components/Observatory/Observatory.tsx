import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AcpProxySessionRow,
  ObserveLiveRow,
  ObserveSessionRow,
  SessionHistoryEntry,
} from "@absence/core";
import {
  attachTranscript,
  deleteSessionArchive,
  fetchObserveBoard,
  fetchObserveLive,
  fetchProxySessions,
  fetchSessionHistory,
} from "../../lib/api";
import { useSessionStore } from "../../stores/sessionStore";
import { resetAllStores } from "../../stores/reset";
import { WindowControls } from "../common/WindowControls";
import { useT } from "../../lib/i18n";
import "../../ui/shared/themes.css";
import "../../ui/shared/picker.css";
import "../../ui/shared/observatory.css";

/** How often the board refreshes while it is open: a new agent shows up on its own. */
const REFRESH_MS = 4_000;

function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function formatAgo(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The channel badges a row shows: what Absence can see, not what it hopes to. */
function channelLabel(channel: string): string {
  if (channel === "transcript") return "transcript";
  if (channel === "acp-proxy") return "acp proxy";
  if (channel === "os") return "OS";
  return channel;
}

/**
 * The observation board — the app's front door.
 *
 * Nothing here starts an agent. The board lists what Absence can see on this
 * machine right now (agents running in their own terminals, transcripts they
 * write, ACP proxies), what it is already watching, and everything it has
 * recorded before. Choosing a target attaches it and opens its panel; the
 * observation then outlives the tab (see `stores/reset.ts`).
 */
export function Observatory() {
  const t = useT();
  const openSession = useSessionStore((s) => s.openSession);

  const [live, setLive] = useState<ObserveLiveRow[]>([]);
  const [transcripts, setTranscripts] = useState<ObserveSessionRow[]>([]);
  const [proxies, setProxies] = useState<AcpProxySessionRow[]>([]);
  const [history, setHistory] = useState<SessionHistoryEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const [liveResult, boardResult, proxyResult, historyResult] = await Promise.allSettled([
      fetchObserveLive(),
      fetchObserveBoard(),
      fetchProxySessions(),
      fetchSessionHistory(),
    ]);
    if (!mounted.current) return;
    if (liveResult.status === "fulfilled") setLive(liveResult.value.sessions);
    if (boardResult.status === "fulfilled") setTranscripts(boardResult.value.sessions);
    if (proxyResult.status === "fulfilled") setProxies(proxyResult.value.sessions);
    if (historyResult.status === "fulfilled") setHistory(historyResult.value);
    setNow(Date.now());
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      // A hidden tab does not need to poll; it refreshes on the way back.
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const withBusy = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setBusy(undefined);
    }
  };

  /** Enter a live session's panel. Nothing is created; the session exists. */
  const enter = (sessionId: string) =>
    withBusy(`open-${sessionId}`, async () => {
      resetAllStores();
      await openSession(sessionId);
    });

  /** Attach a transcript (full backfill) and open its panel. */
  const attach = (file: string) =>
    withBusy(`attach-${file}`, async () => {
      const row = await attachTranscript(file);
      if (!row.sessionId) {
        setError(t("The transcript could not be attached (identity unknown)."));
        return;
      }
      resetAllStores();
      await openSession(row.sessionId);
    });

  /** Open an archived session: the server replays its own record. */
  const openArchive = (entry: SessionHistoryEntry) =>
    withBusy(`open-${entry.id}`, async () => {
      if (!entry.absenceSessionId) {
        setError(t("This archive predates Absence's own session ids and cannot be reopened."));
        return;
      }
      resetAllStores();
      await openSession(entry.absenceSessionId);
    });

  /** Delete one archive (events, runs, file versions, metrics and the row). */
  const removeArchive = (entry: SessionHistoryEntry) =>
    withBusy(`del-${entry.id}`, async () => {
      if (!entry.absenceSessionId) return;
      if (!window.confirm(t("Delete the archive of {path}? This cannot be undone.", { path: entry.projectPath }))) return;
      await deleteSessionArchive(entry.absenceSessionId);
      setHistory((current) => current.filter((row) => row.id !== entry.id));
    });

  const liveIds = useMemo(() => new Set(live.map((row) => row.sessionId)), [live]);
  const liveExternalIds = useMemo(
    () => new Set(live.filter((row) => row.channel === "transcript").map((row) => row.externalId)),
    [live],
  );
  /** Transcripts not already watched: the board's “可监控”. */
  const available = useMemo(
    () => transcripts.filter((row) => !liveIds.has(row.sessionId ?? "") && !liveExternalIds.has(row.externalId)),
    [transcripts, liveIds, liveExternalIds],
  );
  const waitingProxies = useMemo(
    () => proxies.filter((row) => !row.sessionId || !liveIds.has(row.sessionId)),
    [proxies, liveIds],
  );
  /** History rows not currently live — the live ones are in the top section. */
  const archived = useMemo(
    () => history.filter((entry) => !entry.absenceSessionId || !liveIds.has(entry.absenceSessionId)),
    [history, liveIds],
  );

  return (
    <div className="mon-root picker-root">
      {window.absenceDesktop ? (
        <div className="absence-drag absolute inset-x-0 top-0 z-10 flex h-8 items-stretch justify-end">
          <WindowControls />
        </div>
      ) : null}

      <div className="picker">
        <header className="picker__brand">
          <h1>
            ABSENCE
            <span>发呆症</span>
          </h1>
        </header>

        <div className="picker__body">
          <div className="picker__main">
            {error ? <div className="picker__error">{error}</div> : null}
            {notice ? <div className="picker__note">{notice}</div> : null}

            <section className="picker__block">
              <div className="picker__hhead">
                <label className="picker__label">{t("Watching now")}</label>
                <span>{t("{n} observed", { n: live.length })}</span>
              </div>
              {live.length === 0 ? (
                <p className="picker__note">
                  {t("Nothing is being watched yet. Start your agent in its own terminal — it appears here on its own.")}
                </p>
              ) : (
                <div className="picker__list picker__projects">
                  {live.map((row) => (
                    <button
                      key={row.sessionId}
                      type="button"
                      disabled={busy !== undefined}
                      onClick={() => void enter(row.sessionId)}
                      title={row.transcriptFile ?? row.projectPath}
                    >
                      <b>{row.projectPath}</b>
                      <span>
                        {row.agentKind} · {channelLabel(row.channel)} · {formatAgo(row.lastActivityAt, now)} ·{" "}
                        {t("{n} events", { n: row.events })}
                        {row.viewers > 0 ? ` · ${t("{n} viewing", { n: row.viewers })}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="picker__block">
              <div className="picker__hhead">
                <label className="picker__label">{t("Available to watch")}</label>
                <span>{t("{n} found", { n: available.length + waitingProxies.length })}</span>
              </div>
              {available.length === 0 && waitingProxies.length === 0 ? (
                <p className="picker__note">{t("No transcripts found yet.")}</p>
              ) : (
                <div className="picker__list picker__projects">
                  {available.map((row) => (
                    <button
                      key={row.file}
                      type="button"
                      disabled={busy !== undefined}
                      onClick={() => void attach(row.file)}
                      title={row.file}
                    >
                      <b>{row.projectPath ?? row.file}</b>
                      <span>
                        {row.agentKind} · transcript · {formatAgo(row.lastActivityAt, now)} ·{" "}
                        {busy === `attach-${row.file}` ? t("attaching…") : t("Attach")}
                      </span>
                    </button>
                  ))}
                  {waitingProxies.map((row) => (
                    <button key={row.id} type="button" disabled title={row.endpoint ? `${row.endpoint.host}:${row.endpoint.port}` : row.cwd}>
                      <b>{row.cwd}</b>
                      <span>
                        {row.label} · {t("ACP proxies")} ·{" "}
                        {row.status === "waiting" ? t("waiting for a client") : row.status}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section className="picker__block picker__side">
            <div className="picker__hhead">
              <label className="picker__label">{t("History")}</label>
              <span>{t("{n} sessions", { n: archived.length })}</span>
            </div>
            <div className="picker__list picker__history">
              {archived.length === 0 ? (
                <p className="picker__note">{t("No saved sessions yet — open a project to start one.")}</p>
              ) : (
                archived.map((entry) => (
                  <div key={entry.id} className="picker__hrowwrap">
                    <button
                      type="button"
                      disabled={busy !== undefined}
                      aria-label={`open ${entry.absenceSessionId ?? entry.id}`}
                      onClick={() => void openArchive(entry)}
                      title={entry.projectPath}
                    >
                      <span className="picker__hrow">
                        <b>{entry.projectPath}</b>
                        <em>{formatWhen(entry.updatedAt)}</em>
                      </span>
                      <span className="picker__hmeta">
                        <span className="picker__hmetatext">
                          <i data-runtime={entry.runtime}>{entry.runtime}</i>
                          {" · "}
                          {t("{n} msgs", { n: entry.messageCount })}
                          {entry.firstPrompt ? ` · ${entry.firstPrompt}` : null}
                        </span>
                        <em className="picker__hsid" title={entry.id}>
                          {entry.absenceSessionId?.slice(-4) ?? entry.id.slice(-4)}
                        </em>
                      </span>
                    </button>
                    {entry.absenceSessionId ? (
                      <button
                        type="button"
                        className="picker__hdel"
                        aria-label={t("Delete archive")}
                        title={t("Delete archive")}
                        disabled={busy !== undefined}
                        onClick={() => void removeArchive(entry)}
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
