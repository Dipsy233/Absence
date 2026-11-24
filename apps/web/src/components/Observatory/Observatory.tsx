import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ObserveLiveRow, ObserveTargetRow, SessionHistoryEntry } from "@absence/core";
import {
  deleteSessionArchive,
  fetchObserveLive,
  fetchObserveTargets,
  fetchSessionHistory,
  watchTarget,
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

/** What a target row's liveness reads as. */
function livenessLabel(row: ObserveTargetRow, t: ReturnType<typeof useT>): string {
  if (row.sessionId !== undefined) return t("watching");
  switch (row.liveness) {
    case "running":
      return t("running");
    case "idle":
      return t("idle");
    case "exited":
      return t("exited");
    case "missing":
      return t("missing");
    default:
      return row.liveness;
  }
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
  const [targets, setTargets] = useState<ObserveTargetRow[]>([]);
  const [history, setHistory] = useState<SessionHistoryEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const [liveResult, targetResult, historyResult] = await Promise.allSettled([
      fetchObserveLive(),
      fetchObserveTargets(),
      fetchSessionHistory(),
    ]);
    if (!mounted.current) return;
    if (liveResult.status === "fulfilled") setLive(liveResult.value.sessions);
    if (targetResult.status === "fulfilled") setTargets(targetResult.value.targets);
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

  /** Choose a target: attach it, record the lease, open its panel. */
  const watch = (row: ObserveTargetRow) =>
    withBusy(`watch-${row.key}`, async () => {
      if (row.sessionId !== undefined) {
        resetAllStores();
        await openSession(row.sessionId);
        return;
      }
      const result = await watchTarget(row.key);
      resetAllStores();
      await openSession(result.sessionId);
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
  /** Targets not already being watched — the board's “可监控”. */
  const available = useMemo(() => targets.filter((row) => row.sessionId === undefined), [targets]);
  /** Targets whose agent is genuinely running right now — the left column. */
  const runningAvailable = useMemo(
    () => available.filter((row) => row.liveness === "running"),
    [available],
  );
  /** Transcripts whose agent has exited/idled — historical, shown on the right. */
  const historical = useMemo(
    () => available.filter((row) => row.liveness !== "running"),
    [available],
  );
  /** History rows not currently live — the live ones are in the left section. */
  const archived = useMemo(
    () => history.filter((entry) => !entry.absenceSessionId || !liveIds.has(entry.absenceSessionId)),
    [history, liveIds],
  );
  const runningCount = live.length + runningAvailable.length;
  const historyCount = archived.length + historical.length;

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
          <section className="picker__block picker__side">
            {error ? <div className="picker__error">{error}</div> : null}
            <div className="picker__hhead">
              <label className="picker__label">{t("Running now")}</label>
              <span>{t("{n} running", { n: runningCount })}</span>
            </div>
            {runningCount === 0 ? (
              <p className="picker__note">
                {t("No agents running. Start one in your own terminal — it appears here.")}
              </p>
            ) : (
              <div className="picker__list picker__running">
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
                      {row.backfilling ? ` · ${t("backfilling…")}` : ""}
                      {row.transcriptResumeBlocked ? ` · ${t("transcript diverged; re-watch to continue")}` : ""}
                      {row.leased ? ` · ${t("watching")}` : ""}
                      {row.viewers > 0 ? ` · ${t("{n} viewing", { n: row.viewers })}` : ""}
                    </span>
                    {row.firstPrompt ? (
                      <span className="picker__hprompt">{row.firstPrompt}</span>
                    ) : null}
                  </button>
                ))}
                {runningAvailable.map((row) => (
                  <button
                    key={row.key}
                    type="button"
                    disabled={busy !== undefined || !row.watchable}
                    onClick={() => void watch(row)}
                    title={row.reason ?? row.transcriptFile ?? row.cwd ?? row.key}
                  >
                    <b>{row.cwd ?? row.transcriptFile ?? row.key}</b>
                    <span>
                      {row.agentKind} · {row.channels.map(channelLabel).join("+")} ·{" "}
                      {livenessLabel(row, t)} · {formatAgo(row.lastActivityAt, now)}
                      {row.watchable
                        ? busy === `watch-${row.key}`
                          ? ` · ${t("attaching…")}`
                          : ` · ${t("Monitor")}`
                        : row.reason
                          ? ` · ${row.reason}`
                          : ""}
                    </span>
                    {row.firstPrompt ? (
                      <span className="picker__hprompt">{row.firstPrompt}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="picker__block picker__side">
            <div className="picker__hhead">
              <label className="picker__label">{t("History")}</label>
              <span>{t("{n} sessions", { n: historyCount })}</span>
            </div>
            <div className="picker__list picker__history">
              {historyCount === 0 ? (
                <p className="picker__note">{t("No saved sessions yet — open a project to start one.")}</p>
              ) : (
                <>
                  {archived.map((entry) => (
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
                  ))}
                  {historical.map((row) => (
                    <div key={row.key} className="picker__hrowwrap">
                      <button
                        type="button"
                        disabled={busy !== undefined || !row.watchable}
                        onClick={() => void watch(row)}
                        title={row.reason ?? row.transcriptFile ?? row.cwd ?? row.key}
                      >
                        <span className="picker__hrow">
                          <b>{row.cwd ?? row.transcriptFile ?? row.key}</b>
                          <em>{formatWhen(row.lastActivityAt)}</em>
                        </span>
                        <span className="picker__hmeta">
                          <span className="picker__hmetatext">
                            <i data-runtime={row.agentKind}>{row.agentKind}</i>
                            {" · "}
                            {livenessLabel(row, t)} · {formatAgo(row.lastActivityAt, now)}
                            {row.watchable
                              ? busy === `watch-${row.key}`
                                ? ` · ${t("attaching…")}`
                                : ` · ${t("Monitor")}`
                              : row.reason
                                ? ` · ${row.reason}`
                                : ""}
                          </span>
                          <em className="picker__hsid" title={row.key}>
                            {(row.externalId ?? row.key).slice(-4)}
                          </em>
                        </span>
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
