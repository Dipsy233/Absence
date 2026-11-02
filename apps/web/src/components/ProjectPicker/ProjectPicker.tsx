import { useEffect, useMemo, useState } from "react";
import type { Project, SessionHistoryEntry } from "@absence/core";
import { fetchProjects, fetchSessionHistory, fetchRuntimes } from "../../lib/api";
import { WindowControls } from "../common/WindowControls";
import { useSessionStore } from "../../stores/sessionStore";
import { resetAllStores } from "../../stores/reset";
import "../../ui/shared/themes.css";
import "../../ui/shared/picker.css";

type Readiness = "ready" | "needs-adapter" | "needs-auth";
type LaunchSource = "auto" | "manual" | "override";

interface AgentModels {
  state: "session" | "declared" | "empty" | "unknown";
  items: string[];
  path?: string;
}

interface AdapterInfo {
  packages: string[];
  bins: string[];
  command: string;
  localCommand?: string;
  note: string;
  suggestedEntry: { command: string; args: string[] };
}

/** One row of the probe view (GET /api/runtimes). */
interface PickerRow {
  kind: string;
  label: string;
  state: Readiness;
  stateReason: string;
  source: LaunchSource;
  discoveredFrom?: string;
  auth: "configured" | "missing" | "unknown" | "not-required";
  authReason: string;
  models: AgentModels;
  willDownload?: boolean;
  capabilities?: string;
  adapter?: AdapterInfo;
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

interface CustomPayload {
  id: string;
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

const STATE_TEXT: Record<Readiness, string> = {
  ready: "可启动",
  "needs-adapter": "缺适配器",
  "needs-auth": "需登录",
};

const SOURCE_TEXT: Record<LaunchSource, string> = {
  auto: "自动发现",
  manual: "手动配置",
  override: "用户覆盖",
};

const AUTH_TEXT: Record<PickerRow["auth"], string> = {
  configured: "已配置",
  missing: "缺失",
  unknown: "未知",
  "not-required": "无需登录",
};

function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** args: one argument per line, so a path with spaces needs no quoting. */
function parseArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** env: `KEY=VALUE` lines. Returns undefined when a line is malformed. */
function parseEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) return undefined;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

function sourceLine(row: PickerRow): string {
  if (row.source === "manual" || row.source === "override") {
    return `${SOURCE_TEXT[row.source]} · ~/.absence/agents.json`;
  }
  if (row.discoveredFrom) {
    return row.discoveredFrom.includes("node_modules")
      ? `自动发现 · 本地 node_modules：${row.discoveredFrom}`
      : `自动发现 · ${row.discoveredFrom}`;
  }
  return "自动发现 · PATH";
}

function modelsLabel(models: AgentModels): string {
  if (models.state === "session") return "ACP 会话";
  if (models.state === "declared") return `agent 配置 · ${models.path ?? "（未标明文件）"}`;
  if (models.state === "empty") return "配置已读，agent 未声明模型";
  return "未知（未读到 agent 配置）";
}

/**
 * The probe view, laid out as the original compact tiles. It lists only what
 * `/api/runtimes` found on this machine; the last tile is the single "+" that
 * opens the custom-entry form.
 */
export function ProjectPicker() {
  const startSession = useSessionStore((s) => s.startSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);

  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SessionHistoryEntry[]>([]);
  const [path, setPath] = useState("");
  const [agent, setAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [runtimes, setRuntimes] = useState<PickerRow[]>([]);
  const [probing, setProbing] = useState(false);
  const [panelKind, setPanelKind] = useState<string | undefined>();
  const [copied, setCopied] = useState<string | undefined>();

  const [customOpen, setCustomOpen] = useState(false);
  const [customRows, setCustomRows] = useState<CustomAgentRow[]>([]);
  const [reservedIds, setReservedIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [formId, setFormId] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formEnv, setFormEnv] = useState("");
  const [formCwd, setFormCwd] = useState("");
  const [formError, setFormError] = useState<string | undefined>();
  const [formChecked, setFormChecked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const refreshSessions = () => {
    fetchSessionHistory()
      .then(setSessions)
      .catch(() => setSessions([]));
  };

  const refreshCustomAgents = () => {
    fetch("/api/agents")
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          agents?: CustomAgentRow[];
          reservedIds?: string[];
        };
        setCustomRows(body.agents ?? []);
        setReservedIds(body.reservedIds ?? []);
      })
      .catch(() => setCustomRows([]));
  };

  const applyRows = (list: PickerRow[]) => {
    setRuntimes(list);
    setAgent((current) => {
      if (list.some((row) => row.kind === current)) return current;
      return list.find((row) => row.state === "ready")?.kind ?? list[0]?.kind ?? "";
    });
    setPanelKind((current) => (list.some((row) => row.kind === current) ? current : undefined));
  };

  const refreshRuntimes = (showSpinner = false) => {
    if (showSpinner) setProbing(true);
    return fetchRuntimes()
      .then((list) => applyRows(list as unknown as PickerRow[]))
      .catch(() => setRuntimes([]))
      .finally(() => {
        if (showSpinner) setProbing(false);
      });
  };

  useEffect(() => {
    fetchProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
    refreshSessions();
    void refreshRuntimes();
    refreshCustomAgents();
  }, []);

  useEffect(() => {
    if (!panelKind && !customOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPanelKind(undefined);
      setCustomOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelKind, customOpen]);

  const query = path.trim().toLowerCase();
  const selected = runtimes.find((row) => row.kind === agent);
  const canStart = selected?.state === "ready";
  const panelRow = runtimes.find((row) => row.kind === panelKind);

  const visibleSessions = useMemo(() => {
    const byRuntime = sessions.filter((s) => s.runtime === agent);
    return query ? byRuntime.filter((s) => s.projectPath.toLowerCase().includes(query)) : byRuntime;
  }, [sessions, agent, query]);

  const start = async (projectPath: string) => {
    if (!projectPath.trim()) return;
    if (!canStart) {
      setError(selected?.stateReason ?? "当前 agent 不可启动，请先补全它的 ACP 入口。");
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

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? undefined : current)), 1500);
    } catch {
      setCopied(undefined);
    }
  };

  const resetForm = () => {
    setEditingId(undefined);
    setFormId("");
    setFormLabel("");
    setFormCommand("");
    setFormArgs("");
    setFormEnv("");
    setFormCwd("");
    setFormError(undefined);
    setFormChecked([]);
  };

  const openCustomForm = () => {
    resetForm();
    setCustomOpen(true);
    setPanelKind(undefined);
  };

  const editCustom = (row: CustomAgentRow) => {
    setEditingId(row.id);
    setFormId(row.id);
    setFormLabel(row.label);
    setFormCommand(row.command);
    setFormArgs((row.args ?? []).join("\n"));
    setFormEnv(
      Object.entries(row.env ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    setFormCwd(row.cwd ?? "");
    setFormError(undefined);
    setFormChecked([]);
    setCustomOpen(true);
    setPanelKind(undefined);
  };

  const prefillFromAdapter = (row: PickerRow) => {
    resetForm();
    setFormLabel(`${row.label} ACP`);
    setFormCommand(row.adapter?.suggestedEntry.command ?? "");
    setFormArgs((row.adapter?.suggestedEntry.args ?? []).join("\n"));
    setCustomOpen(true);
    setPanelKind(undefined);
  };

  const validateForm = (): CustomPayload | undefined => {
    const command = formCommand.trim();
    if (!command) {
      setFormError("请填写命令（绝对路径或 PATH 上的名称）。");
      return undefined;
    }
    const id = formId.trim();
    if (id && !/^[A-Za-z0-9._-]+$/.test(id)) {
      setFormError("id 只能包含字母、数字、点、横线和下划线。");
      return undefined;
    }
    if (id && id !== editingId && reservedIds.includes(id)) {
      setFormError(`id “${id}” 与内置 agent 冲突，请换一个。`);
      return undefined;
    }
    const env = parseEnv(formEnv);
    if (env === undefined) {
      setFormError("环境变量每行必须是 KEY=VALUE。");
      return undefined;
    }
    return {
      id,
      label: formLabel.trim(),
      command,
      args: parseArgs(formArgs),
      env,
      cwd: formCwd.trim(),
    };
  };

  const saveCustom = async () => {
    const payload = validateForm();
    if (!payload) return;
    setSaving(true);
    setFormError(undefined);
    setFormChecked([]);
    try {
      const response = await fetch(
        editingId ? `/api/agents/${encodeURIComponent(editingId)}` : "/api/agents",
        {
          method: editingId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(payload.id ? { id: payload.id } : {}),
            label: payload.label,
            command: payload.command,
            args: payload.args,
            env: payload.env,
            cwd: payload.cwd,
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        checked?: string[];
      };
      if (!response.ok) {
        setFormError(body.error ?? `${response.status} ${response.statusText}`);
        setFormChecked(body.checked ?? []);
        return;
      }
      resetForm();
      setCustomOpen(false);
      refreshCustomAgents();
      await refreshRuntimes();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteCustom = async (row: CustomAgentRow) => {
    setFormError(undefined);
    setFormChecked([]);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
      if (editingId === row.id) resetForm();
      refreshCustomAgents();
      await refreshRuntimes();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
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
        <header className="picker__brand">
          <h1>
            ABSENCE
            <span>发呆症</span>
          </h1>
          <p>只列出这台机器上探测到的 agent。Absence 不会代装，也不会改它们的配置。</p>
        </header>

        <div className="picker__body">
          <section className="picker__block">
            <label className="picker__label" htmlFor="project-path">
              项目路径
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
                disabled={busy || !path.trim() || !canStart}
                aria-label="打开项目"
                onClick={() => void start(path)}
              >
                {busy ? "打开中…" : "打开"}
              </button>
            </div>
            {error ? <div className="picker__error">{error}</div> : null}
          </section>

          {projects.length > 0 ? (
            <section className="picker__block">
              <label className="picker__label">最近</label>
              <div className="picker__list picker__projects">
                {projects.map((project) => (
                  <button
                    key={project.path}
                    type="button"
                    disabled={busy || !canStart}
                    aria-label={`打开 ${project.path}`}
                    onClick={() => void start(project.path)}
                    title={canStart ? project.path : selected?.stateReason}
                  >
                    <b>{project.name}</b>
                    <span>{project.path}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <section className="picker__block">
            <div className="picker__hhead">
              <label className="picker__label">检测到的 Agent</label>
              <button
                type="button"
                className="picker__link"
                aria-label="重新探测本机 agent"
                disabled={probing}
                onClick={() => void refreshRuntimes(true)}
              >
                {probing ? "探测中…" : "重新探测"}
              </button>
            </div>

            {runtimes.length === 0 ? (
              <p className="picker__note">
                没有探测到任何可用的 agent。Absence 只读取本机已安装的 ACP 入口，不会联网下载或代装。
              </p>
            ) : null}

            <div className="picker__runtimes">
              {runtimes.map((row) => (
                <button
                  key={row.kind}
                  type="button"
                  aria-pressed={agent === row.kind}
                  aria-label={`选择 ${row.label}（${STATE_TEXT[row.state]}）`}
                  title={row.stateReason}
                  data-on={agent === row.kind ? "true" : undefined}
                  data-state={row.state}
                  onClick={() => setAgent(row.kind)}
                >
                  <i data-state={row.state} />
                  {row.label}
                  <small>{STATE_TEXT[row.state]}</small>
                </button>
              ))}
              <button
                type="button"
                aria-label="添加自定义 ACP"
                title="添加自定义 ACP"
                onClick={() => (customOpen ? (resetForm(), setCustomOpen(false)) : openCustomForm())}
              >
                +
              </button>
            </div>

            {selected ? (
              <div className="picker__agentfacts">
                <p className="picker__note">
                  <strong>
                    {STATE_TEXT[selected.state]} · {SOURCE_TEXT[selected.source]}
                  </strong>
                </p>
                <p className="picker__note">{selected.stateReason}</p>
                {selected.willDownload ? (
                  <p className="picker__note picker__warn">
                    npx 兜底已显式开启，启动时会临时下载包。
                  </p>
                ) : null}
                <p className="picker__note">
                  认证：{AUTH_TEXT[selected.auth]}
                  {selected.authReason ? ` — ${selected.authReason}` : null}
                </p>
                <p className="picker__note">
                  模型来源：{modelsLabel(selected.models)}
                  {selected.models.items.length > 0 ? ` — ${selected.models.items.join("、")}` : null}
                </p>
                <p className="picker__note">{sourceLine(selected)}</p>
              </div>
            ) : null}

            {panelRow?.adapter ? (
              <div className="picker__agentfacts">
                <div className="picker__hhead">
                  <strong>补全 {panelRow.label} 的 ACP</strong>
                  <button
                    type="button"
                    className="picker__link"
                    aria-label="关闭补全面板"
                    onClick={() => setPanelKind(undefined)}
                  >
                    关闭
                  </button>
                </div>
                {panelRow.adapter.packages.length > 0 ? (
                  <p className="picker__note">
                    适配器包：<code>{panelRow.adapter.packages.join("、")}</code>
                  </p>
                ) : null}
                {panelRow.adapter.bins.length > 0 ? (
                  <p className="picker__note">
                    需要的可执行文件：<code>{panelRow.adapter.bins.join("、")}</code>
                  </p>
                ) : null}
                {panelRow.adapter.command ? (
                  <p className="picker__note">
                    安装命令：<code>{panelRow.adapter.command}</code>{" "}
                    <button
                      type="button"
                      className="picker__link"
                      aria-label="复制安装命令"
                      onClick={() =>
                        void copy(panelRow.adapter?.command ?? "", `${panelRow.kind}:install`)
                      }
                    >
                      {copied === `${panelRow.kind}:install` ? "已复制" : "复制"}
                    </button>
                  </p>
                ) : null}
                {panelRow.adapter.localCommand ? (
                  <p className="picker__note">
                    项目内安装：<code>{panelRow.adapter.localCommand}</code>{" "}
                    <button
                      type="button"
                      className="picker__link"
                      aria-label="复制项目内安装命令"
                      onClick={() =>
                        void copy(panelRow.adapter?.localCommand ?? "", `${panelRow.kind}:local`)
                      }
                    >
                      {copied === `${panelRow.kind}:local` ? "已复制" : "复制"}
                    </button>
                  </p>
                ) : null}
                <p className="picker__note">{panelRow.adapter.note}</p>
                <div className="picker__customactions">
                  <button
                    type="button"
                    className="picker__save"
                    aria-label="重新探测本机 agent"
                    disabled={probing}
                    onClick={() => void refreshRuntimes(true)}
                  >
                    {probing ? "探测中…" : "重新探测"}
                  </button>
                  <button
                    type="button"
                    className="picker__save"
                    aria-label={`用 ${panelRow.label} 的适配器预填自定义入口`}
                    onClick={() => prefillFromAdapter(panelRow)}
                  >
                    预填自定义入口
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="picker__block picker__block--fill">
            <div className="picker__hhead">
              <label className="picker__label">历史</label>
              <span>{visibleSessions.length} 个会话</span>
            </div>
            <div className="picker__list picker__history">
              {visibleSessions.length === 0 ? (
                <p className="picker__note">
                  {query
                    ? "此路径没有已保存的会话。"
                    : "该 agent 还没有历史——打开一个项目开始第一轮。"}
                </p>
              ) : (
                visibleSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    disabled={busy}
                    aria-label={`恢复会话 ${session.absenceSessionId ?? session.id}`}
                    onClick={() => void resume(session)}
                    title={`恢复 ${session.absenceSessionId ?? session.id}`}
                  >
                    <span className="picker__hrow">
                      <b>{session.name ?? session.projectName}</b>
                      <em>{formatWhen(session.updatedAt)}</em>
                    </span>
                    <span className="picker__hpath">{session.projectPath}</span>
                    <span className="picker__hmeta">
                      <i data-runtime={session.runtime}>{session.runtime}</i>
                      {" · "}
                      {session.messageCount} 条消息
                      {session.firstPrompt ? ` · ${session.firstPrompt}` : null}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          {customOpen ? (
            <section className="picker__block">
              <label className="picker__label">自定义 ACP</label>

              {customRows.length > 0 ? (
                <div className="picker__pathlist">
                  {customRows.map((row) => (
                    <div key={row.id} className="picker__pathrow picker__customrow">
                      <i data-state={row.available ? "ready" : "unavailable"} />
                      <span>{row.label}</span>
                      <em>{row.available ? row.resolved : "命令未找到"}</em>
                      <button
                        type="button"
                        className="picker__link"
                        aria-label={`编辑 ${row.label}`}
                        onClick={() => editCustom(row)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="picker__link"
                        aria-label={`删除 ${row.label}`}
                        onClick={() => void deleteCustom(row)}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="picker__custom">
                <input
                  value={formId}
                  onChange={(e) => setFormId(e.target.value)}
                  placeholder="id（可留空，自动生成）"
                  aria-label="自定义 ACP id"
                  spellCheck={false}
                  disabled={editingId !== undefined}
                />
                <input
                  value={formLabel}
                  onChange={(e) => setFormLabel(e.target.value)}
                  placeholder="显示名称"
                  aria-label="自定义 ACP 显示名称"
                  spellCheck={false}
                />
                <input
                  value={formCommand}
                  onChange={(e) => setFormCommand(e.target.value)}
                  placeholder="命令（绝对路径或 PATH 上的名称）"
                  aria-label="自定义 ACP 命令"
                  spellCheck={false}
                />
                <textarea
                  value={formArgs}
                  onChange={(e) => setFormArgs(e.target.value)}
                  placeholder="参数（每行一个）"
                  aria-label="自定义 ACP 参数"
                  spellCheck={false}
                  rows={3}
                />
                <textarea
                  value={formEnv}
                  onChange={(e) => setFormEnv(e.target.value)}
                  placeholder="环境变量（每行 KEY=VALUE）"
                  aria-label="自定义 ACP 环境变量"
                  spellCheck={false}
                  rows={3}
                />
                <input
                  value={formCwd}
                  onChange={(e) => setFormCwd(e.target.value)}
                  placeholder="工作目录（可选）"
                  aria-label="自定义 ACP 工作目录"
                  spellCheck={false}
                />
                {formError ? <div className="picker__error">{formError}</div> : null}
                {formChecked.length > 0 ? (
                  <p className="picker__note">检查过：{formChecked.slice(0, 5).join("、")}</p>
                ) : null}
                <div className="picker__customactions">
                  <button
                    type="button"
                    className="picker__link"
                    aria-label="取消自定义 ACP 编辑"
                    onClick={() => {
                      resetForm();
                      setCustomOpen(false);
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="picker__save"
                    disabled={saving || !formCommand.trim()}
                    aria-label={editingId ? "保存自定义 ACP 修改" : "添加自定义 ACP 入口"}
                    onClick={() => void saveCustom()}
                  >
                    {saving ? "保存中…" : editingId ? "保存修改" : "添加"}
                  </button>
                </div>
                <p className="picker__note">
                  只写入 ~/.absence/agents.json。命令必须能解析（PATHEXT 感知）；失败时会列出检查过的路径。
                </p>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
