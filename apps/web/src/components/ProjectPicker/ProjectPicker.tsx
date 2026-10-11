import { useEffect, useMemo, useState } from "react";
import type { Project, SessionHistoryEntry } from "@absence/core";
import { fetchProjects, fetchSessionHistory } from "../../lib/api";
import { WindowControls } from "../common/WindowControls";
import { useSessionStore } from "../../stores/sessionStore";
import { resetAllStores } from "../../stores/reset";

type AgentChoice = "auto" | "pi" | "codex" | "dsh" | "mock";

/** Short, human time for a session row: time only today, date + time otherwise. */
function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** The first screen: pick a local project and start watching (read.md §25). */
export function ProjectPicker() {
  const startSession = useSessionStore((s) => s.startSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);

  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SessionHistoryEntry[]>([]);
  const [path, setPath] = useState("");
  const [agent, setAgent] = useState<AgentChoice>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [historyOpen, setHistoryOpen] = useState(false);

  const refreshSessions = () => {
    fetchSessionHistory()
      .then(setSessions)
      .catch(() => setSessions([]));
  };

  useEffect(() => {
    fetchProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
    refreshSessions();
  }, []);

  // Typing a path filters the history — and unfolds it so the matches are visible.
  useEffect(() => {
    if (path.trim()) setHistoryOpen(true);
  }, [path]);

  const query = path.trim().toLowerCase();
  const visibleSessions = useMemo(
    () => (query ? sessions.filter((s) => s.projectPath.toLowerCase().includes(query)) : sessions),
    [sessions, query],
  );

  const start = async (projectPath: string) => {
    if (!projectPath.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      resetAllStores();
      await startSession(projectPath.trim(), agent === "auto" ? undefined : agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
    <div className="relative flex h-full items-center justify-center p-6">
      {/* Frameless desktop shell: a slim drag strip across the top carries the
          window controls; a plain browser tab renders neither. */}
      {window.absenceDesktop ? (
        <div className="absence-drag absolute inset-x-0 top-0 z-10 flex h-8 items-stretch justify-end">
          <WindowControls />
        </div>
      ) : null}
      <div className="w-full max-w-lg rounded-xl border border-desk-line bg-desk-panel p-6">
        <div className="flex items-baseline gap-3">
          <h1 className="font-mono text-3xl tracking-tight text-desk-ink">ABSENCE</h1>
          <span className="text-xs text-desk-dim">发呆症</span>
        </div>
        <p className="mt-2 text-sm text-desk-dim">
          AI moves fast. Humans watch. Choose a project and let the agent work.
        </p>

        <div className="mt-5">
          <div className="label mb-1">project path</div>
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="E:/path/to/project"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-desk-line bg-desk-panel2 px-2 py-2 font-mono text-xs text-desk-ink outline-none placeholder:text-desk-dim/60 focus:border-desk-amber/70"
            />
            <button
              type="button"
              disabled={busy || !path.trim()}
              onClick={() => void start(path)}
              className="shrink-0 rounded border border-desk-amber/60 bg-desk-amber/10 px-4 py-2 text-xs text-desk-amber hover:bg-desk-amber/20 disabled:opacity-40"
            >
              {busy ? "opening…" : "Open"}
            </button>
          </div>
        </div>

        {/* History: persisted sessions (ABSENCE archives + Pi sessions), newest first */}
        <div className="mt-3">
          <button
            type="button"
            onClick={() => {
              setHistoryOpen((value) => !value);
              refreshSessions();
            }}
            className="flex w-full items-center justify-between rounded border border-transparent px-1 py-1 text-left hover:border-desk-line hover:bg-desk-panel2"
          >
            <span className="label">History</span>
            <span className="font-mono text-[10px] text-desk-dim">
              {visibleSessions.length} session{visibleSessions.length === 1 ? "" : "s"} {historyOpen ? "▾" : "▸"}
            </span>
          </button>

          {historyOpen ? (
            <div className="mt-1 max-h-56 space-y-1 overflow-auto">
              {visibleSessions.length === 0 ? (
                <p className="px-2 py-1.5 text-[11px] text-desk-dim">
                  {query
                    ? "No saved sessions for this path."
                    : "No saved sessions yet — open a project to start one."}
                </p>
              ) : (
                visibleSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void resume(session)}
                    title={`Resume ${session.piSessionFile ?? session.absenceSessionId ?? session.id}`}
                    className="block w-full rounded border border-transparent px-2 py-1.5 text-left hover:border-desk-line hover:bg-desk-panel2 disabled:opacity-40"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="truncate font-mono text-xs text-desk-ink/85">
                        {session.name ?? session.projectName}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-desk-dim">
                        {formatWhen(session.updatedAt)}
                      </span>
                    </div>
                    <div className="truncate font-mono text-[10px] text-desk-dim" title={session.projectPath}>
                      {session.projectPath}
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-[10px] text-desk-dim">
                      <span className={session.runtime === "pi" ? "text-desk-teal" : "text-desk-dim"}>
                        {session.runtime}
                      </span>
                      <span>
                        · {session.messageCount} msg{session.messageCount === 1 ? "" : "s"}
                      </span>
                      {session.firstPrompt ? (
                        <span className="truncate text-desk-dim/80">· {session.firstPrompt}</span>
                      ) : null}
                    </div>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        <div className="mt-4">
          <div className="label mb-1">runtime</div>
          <div className="flex gap-1">
            {(["auto", "pi", "codex", "dsh", "mock"] as AgentChoice[]).map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => setAgent(choice)}
                className={[
                  "rounded border px-3 py-1 text-xs",
                  agent === choice
                    ? "border-desk-amber/70 bg-desk-amber/10 text-desk-amber"
                    : "border-desk-line bg-desk-panel2 text-desk-dim hover:text-desk-ink",
                ].join(" ")}
              >
                {choice}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-desk-dim/80">
            auto uses Pi when credentials are configured; codex uses the Codex CLI; dsh uses DeepSeek Harness over its ACP server; otherwise falls back to the mock runtime.
          </p>
        </div>

        {error ? (
          <div className="mt-4 rounded border border-desk-ember/50 bg-desk-ember/10 px-3 py-2 text-xs text-desk-ember">
            {error}
          </div>
        ) : null}

        {projects.length > 0 ? (
          <div className="mt-5">
            <div className="label mb-1">recent</div>
            <div className="max-h-48 space-y-1 overflow-auto">
              {projects.map((project) => (
                <button
                  key={project.path}
                  type="button"
                  disabled={busy}
                  onClick={() => void start(project.path)}
                  className="block w-full truncate rounded border border-transparent px-2 py-1.5 text-left font-mono text-xs text-desk-ink/80 hover:border-desk-line hover:bg-desk-panel2 hover:text-desk-ink disabled:opacity-40"
                  title={project.path}
                >
                  {project.name}
                  <span className="ml-2 text-desk-dim/70">{project.path}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
