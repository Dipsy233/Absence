import { useEffect, useMemo, useState } from "react";
import type { Project, SessionHistoryEntry } from "@absence/core";
import {
  fetchProjects,
  fetchSessionHistory,
  fetchRuntimes,
  saveRuntimePaths,
  type RuntimeKind,
  type RuntimeStatus,
} from "../../lib/api";
import { WindowControls } from "../common/WindowControls";
import { useSessionStore } from "../../stores/sessionStore";
import { resetAllStores } from "../../stores/reset";
import { useT } from "../../lib/i18n";
import "../../ui/shared/themes.css";
import "../../ui/shared/picker.css";

type AgentChoice = RuntimeKind;

/** Short, human time for a session row: time only today, date + time otherwise. */
function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/**
 * The first screen: pick a local project and start watching. It renders
 * inside `.mon-root` so the chosen UI style dresses it too — the picker is
 * the front door, not a separate app.
 */
export function ProjectPicker() {
  const t = useT();
  const startSession = useSessionStore((s) => s.startSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);

  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SessionHistoryEntry[]>([]);
  const [path, setPath] = useState("");
  const [agent, setAgent] = useState<AgentChoice>("pi");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  // Paths the user is editing in the runtime config panel, keyed by kind.
  const [pathEdits, setPathEdits] = useState<{ pi?: string; codex?: string; dsh?: string }>({});
  const [savingPaths, setSavingPaths] = useState(false);

  const refreshSessions = () => {
    fetchSessionHistory()
      .then(setSessions)
      .catch(() => setSessions([]));
  };

  const refreshRuntimes = () => {
    fetchRuntimes()
      .then((list) => {
        setRuntimes(list);
        setPathEdits((prev) => ({
          pi: prev.pi ?? list.find((r) => r.kind === "pi")?.path ?? "",
          codex: prev.codex ?? list.find((r) => r.kind === "codex")?.path ?? "",
          dsh: prev.dsh ?? list.find((r) => r.kind === "dsh")?.path ?? "",
        }));
      })
      .catch(() => setRuntimes([]));
  };

  useEffect(() => {
    fetchProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
    refreshSessions();
    refreshRuntimes();
  }, []);

  const query = path.trim().toLowerCase();
  /**
   * The side panels stay open and follow the selected runtime: the path
   * editor shows that runtime's row, the history only its sessions. Typing
   * a path narrows the history further.
   */
  const visibleSessions = useMemo(() => {
    const byRuntime = sessions.filter((s) => s.runtime === agent);
    return query ? byRuntime.filter((s) => s.projectPath.toLowerCase().includes(query)) : byRuntime;
  }, [sessions, agent, query]);

  const start = async (projectPath: string) => {
    if (!projectPath.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      resetAllStores();
      await startSession(projectPath.trim(), agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const savePaths = async () => {
    setSavingPaths(true);
    setError(undefined);
    try {
      const list = await saveRuntimePaths({
        piBin: pathEdits.pi,
        codexBin: pathEdits.codex,
        dshBin: pathEdits.dsh,
      });
      setRuntimes(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPaths(false);
    }
  };

  const resume = async (entry: SessionHistoryEntry) => {
    setBusy(true);
    setError(undefined);
    try {
      resetAllStores();
      await resumeSession(entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      refreshSessions();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mon-root picker-root">
      {window.absenceDesktop ? (
        <div className="absence-drag absolute inset-x-0 top-0 z-10 flex h-8 items-stretch justify-end">
          <WindowControls />
        </div>
      ) : null}

      <div className="picker">
        {/* One column, top to bottom: the path, the runtime, the history, the
            runtime's own path. The history takes the space that is left and
            scrolls, so the card never changes size. */}
        <header className="picker__brand">
          <h1>
            ABSENCE
            <span>发呆症</span>
          </h1>
          <p>{t("AI moves fast. Humans watch. Choose a project and let the agent work.")}</p>
        </header>

        <div className="picker__body">
          <section className="picker__block">
            <label className="picker__label">{t("project path")}</label>
            <div className="picker__openrow">
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="E:/path/to/project"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && path.trim() && !busy) void start(path);
                }}
              />
              <button type="button" disabled={busy || !path.trim()} onClick={() => void start(path)}>
                {busy ? t("opening…") : t("Open")}
              </button>
            </div>
            {error ? <div className="picker__error">{error}</div> : null}
          </section>

          {projects.length > 0 ? (
            <section className="picker__block">
              <label className="picker__label">{t("recent")}</label>
              <div className="picker__list picker__projects">
                {projects.map((project) => (
                  <button
                    key={project.path}
                    type="button"
                    disabled={busy}
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

          <section className="picker__block">
            <label className="picker__label">{t("runtime")}</label>
            <div className="picker__runtimes">
              {runtimes.map((rt) => (
                <button
                  key={rt.kind}
                  type="button"
                  onClick={() => setAgent(rt.kind)}
                  title={rt.note}
                  data-on={agent === rt.kind ? "true" : undefined}
                >
                  <i data-ok={rt.available ? "true" : undefined} />
                  {rt.label}
                </button>
              ))}
            </div>
            <p className="picker__note">
              {t(
                "A green dot means the runtime was found. A red dot means it is not installed (or the path is wrong) — fix it below before opening.",
              )}
            </p>
          </section>

          <section className="picker__block picker__block--fill">
            <div className="picker__hhead">
              <label className="picker__label">{t("History")}</label>
              <span>{t("{n} sessions", { n: visibleSessions.length })}</span>
            </div>
            <div className="picker__list picker__history">
              {visibleSessions.length === 0 ? (
                <p className="picker__note">
                  {query
                    ? t("No saved sessions for this path.")
                    : t("No saved sessions for this runtime yet — open a project to start one.")}
                </p>
              ) : (
                visibleSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void resume(session)}
                    title={t("Resume {id}", { id: session.piSessionFile ?? session.absenceSessionId ?? session.id })}
                  >
                    <span className="picker__hrow">
                      <b>{session.name ?? session.projectName}</b>
                      <em>{formatWhen(session.updatedAt)}</em>
                    </span>
                    <span className="picker__hpath">{session.projectPath}</span>
                    <span className="picker__hmeta">
                      <i data-runtime={session.runtime}>{session.runtime}</i>
                      {"· "}
                      {t("{n} msgs", { n: session.messageCount })}
                      {session.firstPrompt ? ` · ${session.firstPrompt}` : null}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="picker__block">
            {/* The selected runtime's path: switching the runtime switches the
                row, so what you edit is always what you will open with. */}
            <label className="picker__label">{t("runtime paths")}</label>
            <div className="picker__pathlist">
              {runtimes
                .filter((rt) => rt.configurable && rt.kind === agent)
                .map((rt) => {
                  const key = rt.kind as "pi" | "codex" | "dsh";
                  return (
                    <div key={rt.kind} className="picker__pathedit">
                      <div className="picker__pathrow">
                        <i data-ok={rt.available ? "true" : undefined} />
                        <span>{rt.label}</span>
                        <em>{rt.available ? t("found") : t("not found")}</em>
                      </div>
                      <input
                        value={pathEdits[key] ?? ""}
                        onChange={(e) => setPathEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                        placeholder={rt.note}
                        spellCheck={false}
                      />
                    </div>
                  );
                })}
              <button type="button" className="picker__save" disabled={savingPaths} onClick={() => void savePaths()}>
                {savingPaths ? t("saving…") : t("save paths")}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
