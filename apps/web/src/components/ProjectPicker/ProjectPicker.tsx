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

type Readiness = "ready" | "needs-adapter" | "needs-auth" | "unavailable";
type LaunchSource = "auto" | "manual" | "override";

interface AgentModels {
  state: "session" | "declared" | "empty" | "unknown";
  items: string[];
  path?: string;
}

/**
 * What /api/runtimes adds on top of the shared DTO: the catalog's discovery
 * facts. The picker never names a product — it renders whatever rows come back.
 */
interface ProfileRuntime extends RuntimeStatus {
  profileId?: string;
  commandLine?: string;
  auth?: "configured" | "missing" | "unknown" | "not-required";
  authReason?: string;
  authHint?: "none" | "optional" | "required";
  capabilities?: string;
  requires?: string[];
  source?: LaunchSource;
  state?: Readiness;
  stateReason?: string;
  discoveredFrom?: string;
  models?: AgentModels;
  willDownload?: boolean;
  installHint?: string;
}

interface CustomAgentRow {
  id: string;
  label: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  commandLine: string;
  resolved?: string;
  available: boolean;
}

/** First startable runtime, or the first row the catalog offered. */
function pickDefault(list: ProfileRuntime[]): AgentChoice {
  return list.find((runtime) => runtime.state === "ready")?.kind ?? list[0]?.kind ?? "";
}

/** Short, human time for a session row: time only today, date + time otherwise. */
function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** Split an argument string into argv; quotes group, backslashes stay literal. */
function splitArgs(line: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) argv.push(current);
  return argv;
}

/** `KEY=VALUE` lines → an env object (blank lines ignored). */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

type TFn = (key: string, params?: Record<string, string | number>) => string;

function stateLabel(t: TFn, state: Readiness | undefined): string {
  switch (state) {
    case "ready":
      return t("ready");
    case "needs-adapter":
      return t("needs adapter");
    case "needs-auth":
      return t("needs sign-in");
    default:
      return t("unavailable");
  }
}

function sourceLabel(t: TFn, source: LaunchSource | undefined): string {
  if (source === "manual") return t("custom entry");
  if (source === "override") return t("user override");
  return t("auto-discovered");
}

function modelsText(t: TFn, models: AgentModels | undefined): string {
  if (!models) return t("model list unknown");
  if (models.state === "session") {
    return t("models from the ACP session: {list}", { list: models.items.join(", ") });
  }
  if (models.state === "declared") {
    return t("agent-declared models: {list}", { list: models.items.join(", ") });
  }
  if (models.state === "empty") return t("the agent has not declared any models");
  return t("model list unknown (agent config unreadable)");
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
  const [customOpen, setCustomOpen] = useState(false);
  const [customRows, setCustomRows] = useState<CustomAgentRow[]>([]);
  const [customEditId, setCustomEditId] = useState<string | undefined>();
  const [customLabel, setCustomLabel] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [customArgs, setCustomArgs] = useState("");
  const [customEnv, setCustomEnv] = useState("");
  const [customCwd, setCustomCwd] = useState("");
  const [customBusy, setCustomBusy] = useState(false);
  const [customError, setCustomError] = useState<string | undefined>();

  const refreshSessions = () => {
    fetchSessionHistory()
      .then(setSessions)
      .catch(() => setSessions([]));
  };

  const refreshCustomAgents = () => {
    fetch("/api/agents")
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { agents?: CustomAgentRow[] };
        setCustomRows(body.agents ?? []);
      })
      .catch(() => setCustomRows([]));
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
    refreshCustomAgents();
  }, []);

  const query = path.trim().toLowerCase();
  /**
   * The side panels stay open and follow the selected runtime: the path
   * editor shows that runtime's row, the history only its sessions. Typing
   * a path narrows the history further.
   */
  const selectedRuntime = runtimes.find((runtime) => runtime.kind === agent);
  const canStart = selectedRuntime?.state === "ready";
  const hasDirtyPath = Object.values(dirtyPaths).some(Boolean);

  const visibleSessions = useMemo(() => {
    const byRuntime = sessions.filter((s) => s.runtime === agent);
    return query ? byRuntime.filter((s) => s.projectPath.toLowerCase().includes(query)) : byRuntime;
  }, [sessions, agent, query]);

  const start = async (projectPath: string) => {
    if (!projectPath.trim()) return;
    if (!canStart) {
      setError(
        selectedRuntime?.stateReason ??
          t("This runtime is not startable. Fix its ACP entry below first."),
      );
      return;
    }
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

  const resetCustomForm = () => {
    setCustomEditId(undefined);
    setCustomLabel("");
    setCustomCommand("");
    setCustomArgs("");
    setCustomEnv("");
    setCustomCwd("");
    setCustomError(undefined);
  };

  const saveCustom = async () => {
    setCustomBusy(true);
    setCustomError(undefined);
    try {
      const payload = {
        label: customLabel.trim(),
        command: customCommand.trim(),
        args: splitArgs(customArgs),
        env: parseEnv(customEnv),
        cwd: customCwd.trim(),
      };
      const response = await fetch(
        customEditId ? `/api/agents/${encodeURIComponent(customEditId)}` : "/api/agents",
        {
          method: customEditId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
      resetCustomForm();
      refreshRuntimes();
      refreshCustomAgents();
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    } finally {
      setCustomBusy(false);
    }
  };

  const editCustom = (row: CustomAgentRow) => {
    setCustomEditId(row.id);
    setCustomLabel(row.label);
    setCustomCommand(row.command);
    setCustomArgs((row.args ?? []).join(" "));
    setCustomEnv(
      Object.entries(row.env ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    setCustomCwd(row.cwd ?? "");
    setCustomError(undefined);
    setCustomOpen(true);
  };

  const deleteCustom = async (row: CustomAgentRow) => {
    setCustomBusy(true);
    setCustomError(undefined);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
      if (customEditId === row.id) resetCustomForm();
      refreshRuntimes();
      refreshCustomAgents();
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    } finally {
      setCustomBusy(false);
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
              <button
                type="button"
                disabled={busy || !path.trim() || !canStart}
                onClick={() => void start(path)}
              >
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
                    disabled={busy || !canStart}
                    onClick={() => void start(project.path)}
                    title={canStart ? project.path : selectedRuntime?.stateReason}
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
                  title={rt.stateReason ?? rt.note}
                  data-on={agent === rt.kind ? "true" : undefined}
                  data-state={rt.state ?? "unavailable"}
                >
                  <i data-state={rt.state ?? "unavailable"} />
                  {rt.label}
                  <small>{stateLabel(t, rt.state)}</small>
                </button>
              ))}
            </div>
            <p className="picker__note">
              {t(
                "Green means the ACP entry was found on this machine. Amber means the agent CLI is installed but its ACP adapter is missing (or sign-in is missing). Red means neither was found.",
              )}
            </p>
            {selectedRuntime ? (
              <div className="picker__agentfacts">
                <p className="picker__note">
                  <strong>{stateLabel(t, selectedRuntime.state)}</strong>
                  {" · "}
                  {sourceLabel(t, selectedRuntime.source)}
                  {selectedRuntime.discoveredFrom ? ` · ${selectedRuntime.discoveredFrom}` : null}
                </p>
                <p className="picker__note">{selectedRuntime.stateReason}</p>
                {selectedRuntime.willDownload ? (
                  <p className="picker__note picker__warn">
                    {t("This launch uses npx and will download a package temporarily.")}
                  </p>
                ) : null}
                {selectedRuntime.installHint ? (
                  <p className="picker__note">{selectedRuntime.installHint}</p>
                ) : null}
                <p className="picker__note">
                  {t("sign-in")}: {selectedRuntime.auth ?? "unknown"}
                  {selectedRuntime.authReason ? ` — ${selectedRuntime.authReason}` : null}
                </p>
                <p className="picker__note">{modelsText(t, selectedRuntime.models)}</p>
              </div>
            ) : null}
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
                      <i data-state={rt.state ?? "unavailable"} />
                      <span>{rt.label}</span>
                      <em>{stateLabel(t, rt.state)}</em>
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
                    <p className="picker__note">{rt.stateReason}</p>
                    {rt.auth === "missing" ? (
                      <p className="picker__note">
                        {t(
                          "No credentials were found for this agent. Absence does not read or store them — sign in through the agent's own tools.",
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

          <section className="picker__block">
            <div className="picker__hhead">
              <label className="picker__label">{t("custom ACP entry")}</label>
              <button
                type="button"
                className="picker__link"
                onClick={() => {
                  if (customOpen) resetCustomForm();
                  setCustomOpen(!customOpen);
                }}
              >
                {customOpen ? t("close") : t("add…")}
              </button>
            </div>
            {customRows.length > 0 ? (
              <div className="picker__pathlist">
                {customRows.map((row) => (
                  <div key={row.id} className="picker__pathrow picker__customrow">
                    <i data-state={row.available ? "ready" : "unavailable"} />
                    <span>{row.label}</span>
                    <em>{row.available ? row.resolved : t("command not found")}</em>
                    <button type="button" className="picker__link" onClick={() => editCustom(row)}>
                      {t("edit")}
                    </button>
                    <button
                      type="button"
                      className="picker__link"
                      disabled={customBusy}
                      onClick={() => void deleteCustom(row)}
                    >
                      {t("delete")}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {customOpen ? (
              <div className="picker__custom">
                <input
                  value={customLabel}
                  onChange={(e) => setCustomLabel(e.target.value)}
                  placeholder={t("display name")}
                  spellCheck={false}
                />
                <input
                  value={customCommand}
                  onChange={(e) => setCustomCommand(e.target.value)}
                  placeholder={t("command (absolute path or PATH name)")}
                  spellCheck={false}
                />
                <input
                  value={customArgs}
                  onChange={(e) => setCustomArgs(e.target.value)}
                  placeholder={t("arguments (optional)")}
                  spellCheck={false}
                />
                <input
                  value={customCwd}
                  onChange={(e) => setCustomCwd(e.target.value)}
                  placeholder={t("working directory (optional)")}
                  spellCheck={false}
                />
                <textarea
                  value={customEnv}
                  onChange={(e) => setCustomEnv(e.target.value)}
                  placeholder={t("environment, one KEY=VALUE per line (optional)")}
                  spellCheck={false}
                  rows={3}
                />
                {customError ? <div className="picker__error">{customError}</div> : null}
                <div className="picker__customactions">
                  <button
                    type="button"
                    className="picker__save"
                    disabled={customBusy || !customCommand.trim()}
                    onClick={() => void saveCustom()}
                  >
                    {customBusy ? t("saving…") : customEditId ? t("update entry") : t("add entry")}
                  </button>
                </div>
                <p className="picker__note">
                  {t(
                    "Saved to ~/.absence/agents.json. Absence never changes the agent's own configuration; models and sign-in stay the agent's business.",
                  )}
                </p>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
