import { useEffect, useMemo, useState } from "react";
import type { Project, SessionHistoryEntry } from "@absence/core";
import {
  fetchProjects,
  fetchSessionHistory,
  fetchRuntimes,
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

/**
 * What /api/runtimes adds on top of the shared DTO: the catalog's profile
 * facts. The picker never names a product — it renders whatever rows come back.
 */
interface ProfileRuntime extends RuntimeStatus {
  profileId?: string;
  commandLine?: string;
  auth?: "none" | "optional" | "required";
  capabilities?: string;
  requires?: string[];
  source?: string;
}

/** First startable runtime, or the first row the catalog offered. */
function pickDefault(list: ProfileRuntime[]): AgentChoice {
  return list.find((runtime) => runtime.available)?.kind ?? list[0]?.kind ?? "";
}

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
  const [agent, setAgent] = useState<AgentChoice>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [runtimes, setRuntimes] = useState<ProfileRuntime[]>([]);
  // Launch lines the user is editing, keyed by profile id — never by product.
  const [pathEdits, setPathEdits] = useState<Record<string, string>>({});
  const [dirtyPaths, setDirtyPaths] = useState<Record<string, boolean>>({});
  const [savingPaths, setSavingPaths] = useState(false);

  const refreshSessions = () => {
    fetchSessionHistory()
      .then(setSessions)
      .catch(() => setSessions([]));
  };

  /** Seed the launch editor from the catalog's rows; keep unlucky edits intact. */
  const applyRuntimes = (list: ProfileRuntime[]) => {
    setRuntimes(list);
    setPathEdits((prev) => {
      const next = { ...prev };
      for (const rt of list) {
        if (rt.configurable && next[rt.kind] === undefined) {
          next[rt.kind] = rt.commandLine ?? rt.path ?? "";
        }
      }
      return next;
    });
    setAgent((current) => current || pickDefault(list));
  };

  const refreshRuntimes = () => {
    fetchRuntimes()
      .then((list) => applyRuntimes(list as ProfileRuntime[]))
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
  const selectedRuntime = runtimes.find((runtime) => runtime.kind === agent);
  const hasDirtyPath = Object.values(dirtyPaths).some(Boolean);

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
    const launch: Record<string, string> = {};
    for (const runtime of runtimes) {
      if (runtime.configurable && dirtyPaths[runtime.kind]) {
        launch[runtime.kind] = pathEdits[runtime.kind] ?? "";
      }
    }
    if (Object.keys(launch).length === 0) return;
    setSavingPaths(true);
    setError(undefined);
    try {
      const response = await fetch("/api/runtimes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ launch }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        runtimes?: ProfileRuntime[];
      };
      if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
      const list = body.runtimes ?? [];
      setDirtyPaths({});
      setPathEdits((prev) => {
        const next = { ...prev };
        for (const runtime of list) {
          if (runtime.configurable) next[runtime.kind] = runtime.commandLine ?? runtime.path ?? "";
        }
        return next;
      });
      applyRuntimes(list);
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
            {selectedRuntime?.note ? <p className="picker__note">{selectedRuntime.note}</p> : null}
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
                    title={t("Resume {id}", { id: session.absenceSessionId ?? session.id })}
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
            {/* The selected profile's launch line: switching the runtime
                switches the row, so what you edit is always what you will
                open with. Rows come from the catalog, never a product list. */}
            <label className="picker__label">{t("runtime paths")}</label>
            <div className="picker__pathlist">
              {runtimes
                .filter((rt) => rt.configurable && rt.kind === agent)
                .map((rt) => (
                  <div key={rt.kind} className="picker__pathedit">
                    <div className="picker__pathrow">
                      <i data-ok={rt.available ? "true" : undefined} />
                      <span>{rt.label}</span>
                      <em>{rt.available ? t("found") : t("not found")}</em>
                    </div>
                    <input
                      value={pathEdits[rt.kind] ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        setPathEdits((prev) => ({ ...prev, [rt.kind]: value }));
                        setDirtyPaths((prev) => ({ ...prev, [rt.kind]: true }));
                      }}
                      placeholder={rt.commandLine ?? rt.note}
                      spellCheck={false}
                    />
                    {rt.auth === "required" ? (
                      <p className="picker__note">
                        {t(
                          "Sign-in required: the agent may refuse to open until its own authenticate method succeeds. Absence shows the agent's methods and forwards the login — it never reads credentials.",
                        )}
                      </p>
                    ) : null}
                  </div>
                ))}
              <button
                type="button"
                className="picker__save"
                disabled={savingPaths || !hasDirtyPath}
                onClick={() => void savePaths()}
              >
                {savingPaths ? t("saving…") : t("save paths")}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
