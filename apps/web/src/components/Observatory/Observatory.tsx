import { useEffect, useMemo, useState } from "react";
import type { Project, SessionHistoryEntry } from "@absence/core";
import { fetchProjects, fetchSessionHistory, fetchObserveBoard, launchTerminal, deleteSessionArchive } from "../../lib/api";
import { useSessionStore } from "../../stores/sessionStore";
import { resetAllStores } from "../../stores/reset";
import { WindowControls } from "../common/WindowControls";
import { useT } from "../../lib/i18n";
import "../../ui/shared/themes.css";
import "../../ui/shared/picker.css";
import "../../ui/shared/observatory.css";

function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/**
 * The observation board — the original switcher page, launcher edition.
 *
 * Absence opens the user's own terminal running the agent and steps back: a
 * path plus 打开 starts a fresh session in that directory; a history row
 * resumes that conversation (`pi --session <transcript>`). Absence never
 * talks to the agent — the transcript channel observes whatever it writes,
 * and a resumed conversation lands on its own archive through re-attach.
 */
export function Observatory() {
  const t = useT();
  const openSession = useSessionStore((s) => s.openSession);

  const [path, setPath] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SessionHistoryEntry[]>([]);
  const [agentKind, setAgentKind] = useState<string>("pi");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    fetchProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
    fetchSessionHistory()
      .then(setSessions)
      .catch(() => setSessions([]));
    // The runtime the board lists and launches is profile data, not a
    // hard-coded product name: the transcript sources' own agent kind.
    fetchObserveBoard()
      .then((board) => setAgentKind(board.sources[0]?.agentKind ?? "pi"))
      .catch(() => undefined);
  }, []);

  // 反斜杠与正斜杠一个意思:历史里的路径存的是正斜杠形式,Windows 用户
  // 按习惯输入 E:\0down\daze-demo 也必须命中同一批会话。
  const normalizePath = (value: string) => value.trim().toLowerCase().replace(/\\/g, "/");
  const query = normalizePath(path);

  const visibleSessions = useMemo(() => {
    const byRuntime = sessions.filter((s) => s.runtime === agentKind);
    return query ? byRuntime.filter((s) => normalizePath(s.projectPath).includes(query)) : byRuntime;
  }, [sessions, agentKind, query]);

  const withBusy = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  /** 在这个路径打开一个跑 pi 的终端;观察随转录自动跟上。 */
  const start = (projectPath: string) =>
    withBusy(projectPath, async () => {
      await launchTerminal({ cwd: projectPath.trim().replace(/\\/g, "/") });
      setNotice(t("pi is running in a new terminal — Absence is watching."));
    });

  /** 点击历史会话:唤起终端继续这场对话,并立即进入它的观察视图。 */
  const resume = (entry: SessionHistoryEntry) =>
    withBusy(entry.id, async () => {
      if (!entry.absenceSessionId) {
        setError(t("This archive predates Absence's own session ids and cannot be reopened."));
        return;
      }
      const launched = await launchTerminal({ absenceSessionId: entry.absenceSessionId });
      if (launched.sessionId) {
        resetAllStores();
        await openSession(launched.sessionId);
      } else {
        setNotice(t("pi is continuing that conversation in a new terminal — Absence is watching."));
      }
    });

  /** 删除一份归档(事件、run、文件版本、指标与行本身)。 */
  const removeArchive = (entry: SessionHistoryEntry) =>
    withBusy(`del-${entry.id}`, async () => {
      if (!entry.absenceSessionId) return;
      if (!window.confirm(t("Delete the archive of {path}? This cannot be undone.", { path: entry.projectPath }))) return;
      await deleteSessionArchive(entry.absenceSessionId);
      setSessions((current) => current.filter((row) => row.id !== entry.id));
    });

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
            <section className="picker__block">
              <label className="picker__label" htmlFor="project-path">
                {t("project path")}
              </label>
              <div className="picker__openrow">
                <input
                  id="project-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="E:/path/to/project"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && path.trim() && !busy) void start(path);
                  }}
                />
                <button
                  type="button"
                  disabled={busy !== undefined || !path.trim()}
                  aria-label="打开项目"
                  onClick={() => void start(path)}
                >
                  {busy === path ? t("opening…") : t("Open")}
                </button>
              </div>
              {error ? <div className="picker__error">{error}</div> : null}
              {notice ? <div className="picker__note">{notice}</div> : null}
            </section>

            {projects.length > 0 ? (
              <section className="picker__block">
                <label className="picker__label">{t("recent")}</label>
                <div className="picker__list picker__projects">
                  {projects.map((project) => (
                    <button
                      key={project.path}
                      type="button"
                      disabled={busy !== undefined}
                      aria-label={`打开 ${project.path}`}
                      onClick={() => void start(project.path)}
                      title={project.path}
                    >
                      <b>{project.name}</b>
                      <span>{project.path}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <section className="picker__block picker__side">
            <div className="picker__hhead">
              <label className="picker__label">{t("History")}</label>
              <span>{t("{n} sessions", { n: visibleSessions.length })}</span>
            </div>
            <div className="picker__list picker__history">
              {visibleSessions.length === 0 ? (
                <p className="picker__note">
                  {query
                    ? t("No saved sessions for this path.")
                    : t("No saved sessions yet — open a project to start one.")}
                </p>
              ) : (
                visibleSessions.map((session) => (
                  <div key={session.id} className="picker__hrowwrap">
                    <button
                      type="button"
                      disabled={busy !== undefined}
                      aria-label={`唤起会话 ${session.absenceSessionId ?? session.id}`}
                      onClick={() => void resume(session)}
                      title={session.projectPath}
                    >
                      <span className="picker__hrow">
                        <b>{session.projectPath}</b>
                        <em>{formatWhen(session.updatedAt)}</em>
                      </span>
                      <span className="picker__hmeta">
                        <span className="picker__hmetatext">
                          <i data-runtime={session.runtime}>{session.runtime}</i>
                          {" · "}
                          {session.messageCount} 条消息
                          {session.firstPrompt ? ` · ${session.firstPrompt}` : null}
                        </span>
                        <em className="picker__hsid" title={session.id}>
                          {session.absenceSessionId?.slice(-4) ?? session.id.slice(-4)}
                        </em>
                      </span>
                    </button>
                    {session.absenceSessionId ? (
                      <button
                        type="button"
                        className="picker__hdel"
                        aria-label={t("Delete archive")}
                        title={t("Delete archive")}
                        disabled={busy !== undefined}
                        onClick={() => void removeArchive(session)}
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
