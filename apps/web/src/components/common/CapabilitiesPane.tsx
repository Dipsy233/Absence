import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSkill,
  deleteMcpServer,
  deleteSkill,
  fetchCapabilities,
  importSkillFile,
  importSkillFiles,
  saveMcpServer,
  setMcpServerEnabled,
  type CapabilityMcp,
  type CapabilitySkill,
  type CapabilityState,
} from "../../lib/api";
import { useSessionStore } from "../../stores/sessionStore";

/**
 * Skills & MCP (a pane of the Settings dialog, v0.4).
 *
 * Both are cross-runtime formats — a skill is a folder with a SKILL.md, an MCP
 * server is an `mcpServers` entry — so what is managed here is what Pi, Codex
 * and DSH read. The pane is deliberately shaped like its neighbours:
 *
 *   list    — skills (click to inspect) or MCP servers (with toggles)
 *   bottom  — the Add forms, and the directory the next write lands in
 *
 * A skill is created from a name + description (the SKILL.md is templated) or
 * imported: drag a folder onto the pane, or use `import…`, which asks for a
 * folder first and falls back to a single SKILL.md. Nothing is guessed — every
 * write reports the absolute directory it touched, and MCP entries defined in
 * Codex's `config.toml` are shown read-only, because rewriting a user's TOML
 * is not something a JSON editor should do.
 */
type Tab = "skills" | "mcp";

export function CapabilitiesPane() {
  const projectPath = useProjectPath();
  const [tab, setTab] = useState<Tab>("skills");
  const [state, setState] = useState<CapabilityState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
  const [scope, setScope] = useState<"user" | "project">("user");

  const load = useCallback(async () => {
    try {
      const next = await fetchCapabilities(projectPath);
      setState(next);
      setError(undefined);
      setSelectedSkill((prev) =>
        prev && next.skills.some((skill) => skill.filePath === prev) ? prev : next.skills[0]?.filePath,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>, okText: string, refresh = true) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await action();
      const detail =
        typeof result === "object" && result && "dir" in result
          ? ` → ${String((result as { dir: unknown }).dir)}`
          : "";
      setMessage({ ok: true, text: `${okText}${detail}` });
      if (refresh) await load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  /** Drop a skill folder (or bare SKILL.md files) onto the pane. */
  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const entries = [...event.dataTransfer.items]
      .filter((item) => item.kind === "file")
      .map((item) => item.webkitGetAsEntry());
    const files: Array<{ path: string; content: string }> = [];
    for (const entry of entries) {
      if (!entry) continue;
      if (entry.isFile) {
        const file = await fileFromEntry(entry as FileSystemFileEntry);
        files.push(...(await readFileEntry(file, entry.name)));
      } else if (entry.isDirectory) {
        files.push(...(await walkDirectory(entry as FileSystemDirectoryEntry)));
      }
    }
    if (files.length === 0) {
      setMessage({ ok: false, text: "nothing importable was dropped" });
      return;
    }
    // The server validates the frontmatter and confines writes to the
    // destination folder before anything is created.
    await run(() => importSkillFiles({ files, scope, cwd: projectPath }), "skill imported");
  };

  /**
   * Import picked with the native dialog. Chromium's `webkitdirectory` returns
   * a folder's files with `webkitRelativePath`, so one pick can carry a whole
   * skill (`scripts/`, `references/` included). A user who picks a single
   * SKILL.md instead gets the raw single-file import.
   */
  const pickSkillFiles = async (picked: File[]) => {
    if (picked.length === 0) return;
    const relative = picked.filter((file) => fileRelativePath(file).length > 0);
    if (relative.length === 0) {
      await run(() => importSkillFile({ file: picked[0]!, scope, cwd: projectPath }), "skill imported");
      return;
    }
    const skillFile = relative.find((file) => fileRelativePath(file).at(-1) === "SKILL.md");
    if (!skillFile) {
      setMessage({ ok: false, text: "the folder must contain a SKILL.md" });
      return;
    }
    // Re-base every path on the picked folder: that folder is the skill root.
    const payload: Array<{ path: string; content: string }> = [];
    for (const file of relative) {
      const path = fileRelativePath(file).slice(1).join("/");
      if (!path) continue;
      payload.push(...(await readFileEntry(file, path)));
    }
    if (payload.length === 0) {
      setMessage({ ok: false, text: "nothing importable in the picked folder" });
      return;
    }
    await run(() => importSkillFiles({ files: payload, scope, cwd: projectPath }), "skill imported");
  };

  const skills = state?.skills ?? [];
  const mcp = state?.mcp ?? [];
  const diagnostics = state?.diagnostics ?? [];
  const selected = skills.find((skill) => skill.filePath === selectedSkill);
  const writeDir =
    scope === "project" && state ? state.dirs.skills[state.dirs.skills.length - 1] : state?.dirs.userSkills;

  return (
    <div
      className="relative flex min-w-0 flex-1 basis-0 flex-col p-4"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => void onDrop(event)}
    >
      <div className="mb-1 flex items-baseline gap-2">
        <h2 className="font-mono text-sm tracking-widest text-desk-ink">SKILLS &amp; MCP</h2>
        <span className="font-mono text-[10px] text-desk-dim">
          {skills.length} skill{skills.length === 1 ? "" : "s"} · {mcp.length} server{mcp.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="mb-2 shrink-0 text-[11px] leading-snug text-desk-dim">
        Cross-runtime: a skill is a folder with a <span className="font-mono">SKILL.md</span>, an MCP server is an{" "}
        <span className="font-mono">mcpServers</span> entry. Pi, Codex and DSH all read what you change here; a new
        session picks it up.
      </p>

      <div className="mb-2 flex shrink-0 gap-1">
        {(["skills", "mcp"] as Tab[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setTab(option)}
            className={[
              "rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors",
              tab === option
                ? "border-desk-amber/70 bg-desk-amber/10 text-desk-amber"
                : "border-desk-line bg-desk-panel2 text-desk-dim hover:text-desk-ink",
            ].join(" ")}
          >
            {option}
            <span className="ml-1 normal-case text-desk-dim">
              {option === "skills" ? skills.length : mcp.length}
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => void run(load, "reloaded")}
          className="ml-auto rounded border border-desk-line px-2 py-0.5 font-mono text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
          title="Re-scan the skills and MCP files"
        >
          reload
        </button>
      </div>

      {error ? <p className="mb-2 shrink-0 font-mono text-[10px] text-desk-ember">✕ {error}</p> : null}

      {tab === "skills" ? (
        <SkillList
          skills={skills}
          selected={selectedSkill}
          onSelect={setSelectedSkill}
          onDelete={(skill) => {
            if (!window.confirm(`Delete skill "${skill.name}"?\n\n${skill.baseDir}`)) return;
            void run(() => deleteSkill(skill.filePath, projectPath), `deleted ${skill.name}`);
          }}
          busy={busy}
        />
      ) : (
        <McpList
          servers={mcp}
          userConfig={state?.dirs.mcp}
          projectConfig={state?.dirs.projectMcp}
          codexConfig={state?.dirs.codexConfig}
          onToggle={(server, enabled) =>
            void run(
              () => setMcpServerEnabled(server.name, enabled, projectPath),
              `${server.name} ${enabled ? "enabled" : "disabled"}`,
            )
          }
          onDelete={(server) => {
            if (!window.confirm(`Remove MCP server "${server.name}" from mcp.json?`)) return;
            void run(() => deleteMcpServer(server.name, projectPath), `removed ${server.name}`);
          }}
        />
      )}

      {selected && tab === "skills" ? (
        <div className="mt-2 shrink-0 truncate rounded border border-desk-line bg-desk-panel2/60 px-2 py-1 font-mono text-[10px] leading-snug text-desk-dim">
          <span className="text-desk-ink/80">{selected.name}</span> · {selected.scope} · {selected.baseDir}
        </div>
      ) : null}

      <IsolationNote />

      {diagnostics.length > 0 ? (
        <div className="mt-1 shrink-0 space-y-0.5 font-mono text-[10px] text-desk-dim">
          {diagnostics.slice(0, 3).map((diagnostic, index) => (
            <span
              key={`${diagnostic.path ?? ""}-${index}`}
              className="block truncate"
              title={diagnostic.path}
            >
              {diagnostic.type === "error" ? "✕" : "!"} {diagnostic.message}
            </span>
          ))}
        </div>
      ) : null}

      {/* Bottom band: the Add form, the scope picker and the write target. */}
      <div className="mt-2 shrink-0 border-t border-desk-line/70 pt-2">
        {tab === "skills" ? (
          <AddSkillForm
            scope={scope}
            setScope={setScope}
            defaultScope={projectPath ? "project" : "user"}
            busy={busy}
            dir={writeDir}
            onCreate={(name, description) =>
              void run(() => createSkill({ name, description, scope, cwd: projectPath }), `created skill ${name}`)
            }
            onPick={(files) => void pickSkillFiles(files)}
          />
        ) : (
          <AddMcpForm
            busy={busy}
            target={state?.dirs.mcp}
            onSave={(input) => void run(() => saveMcpServer(input), `saved ${input.name}`)}
          />
        )}
        <div className="mt-1 flex items-center gap-2">
          {message ? (
            <span
              className={[
                "truncate font-mono text-[10px]",
                message.ok ? "text-desk-teal" : "text-desk-ember",
              ].join(" ")}
              title={message.text}
            >
              {message.ok ? "✓" : "✕"} {message.text}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 font-mono text-[10px] text-desk-dim/70">
            drop a skill folder anywhere on this pane
          </span>
        </div>
      </div>

      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded border-2 border-dashed border-desk-amber/70 bg-desk-deep/80">
          <span className="font-mono text-xs text-desk-amber">
            drop a skill folder (must contain SKILL.md)
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ── skills ──────────────────────────────────────────────────────────────── */

function SkillList({
  skills,
  selected,
  onSelect,
  onDelete,
  busy,
}: {
  skills: CapabilitySkill[];
  selected?: string;
  onSelect: (filePath: string) => void;
  onDelete: (skill: CapabilitySkill) => void;
  busy: boolean;
}) {
  return (
    <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
      {skills.length === 0 ? (
        <li className="font-mono text-[10px] text-desk-dim/70">
          none found — create one below, or drop a folder with a SKILL.md
        </li>
      ) : null}
      {skills.map((skill) => (
        <li key={skill.filePath} className="group flex items-start gap-1">
          <button
            type="button"
            onClick={() => onSelect(skill.filePath)}
            title={skill.filePath}
            className={[
              "min-w-0 flex-1 rounded px-1.5 py-1 text-left",
              selected === skill.filePath ? "bg-desk-amber/10" : "hover:bg-desk-panel2",
            ].join(" ")}
          >
            <span className="flex items-baseline gap-1.5">
              <span className="truncate font-mono text-[11px] text-desk-ink/90">{skill.name}</span>
              <span className="ml-auto shrink-0 rounded border border-desk-line px-1 text-[9px] uppercase text-desk-dim">
                {skill.scope}
              </span>
            </span>
            <span className="block text-[10px] leading-snug text-desk-dim">{skill.description}</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDelete(skill)}
            className="mt-1 shrink-0 rounded px-1 font-mono text-[10px] text-desk-dim opacity-0 hover:text-desk-ember group-hover:opacity-100 disabled:opacity-30"
            title={`Delete ${skill.baseDir}`}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}

function AddSkillForm({
  scope,
  setScope,
  defaultScope,
  busy,
  dir,
  onCreate,
  onPick,
}: {
  scope: "user" | "project";
  setScope: (scope: "user" | "project") => void;
  defaultScope: "user" | "project";
  busy: boolean;
  dir?: string;
  onCreate: (name: string, description: string) => void;
  onPick: (files: File[]) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const scopeInited = useRef(false);
  if (!scopeInited.current) {
    scopeInited.current = true;
    // A project is open → project level is the useful default; otherwise the
    // user-level folder, which every project shares.
    setScope(defaultScope);
  }
  const valid = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && description.trim().length > 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-desk-dim">new skill</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name (lowercase-hyphens)"
          className="w-40 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[10px] text-desk-ink placeholder:text-desk-dim/60 focus:border-desk-amber/60 focus:outline-none"
        />
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid && !busy) onCreate(name, description);
          }}
          placeholder="description — when should the agent load it?"
          className="min-w-0 flex-1 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[10px] text-desk-ink placeholder:text-desk-dim/60 focus:border-desk-amber/60 focus:outline-none"
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "user" | "project")}
          className="shrink-0 rounded border border-desk-line bg-desk-panel2 px-1 py-1 font-mono text-[10px] text-desk-ink focus:border-desk-amber/60 focus:outline-none"
          title="Where the folder is written"
        >
          <option value="user">user</option>
          <option value="project">project</option>
        </select>
        <button
          type="button"
          disabled={busy || !valid}
          onClick={() => onCreate(name, description)}
          className="shrink-0 rounded border border-desk-amber/60 bg-desk-amber/10 px-2 py-1 font-mono text-[10px] text-desk-amber hover:bg-desk-amber/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          create
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="shrink-0 rounded border border-desk-line px-2 py-1 font-mono text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber disabled:opacity-40"
          title="Import an existing skill folder (or a single SKILL.md)"
        >
          import…
        </button>
        <input
          type="file"
          multiple
          className="hidden"
          // Chromium-only attributes; TS does not know them, so they are set on
          // the element rather than through JSX props.
          ref={(element) => {
            input.current = element;
            if (element) {
              element.setAttribute("webkitdirectory", "");
              element.setAttribute("directory", "");
            }
          }}
          onChange={(e) => {
            onPick([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      {dir ? (
        <p className="truncate font-mono text-[9px] text-desk-dim/70" title={dir}>
          writes to {dir}
        </p>
      ) : null}
    </div>
  );
}

/* ── mcp ─────────────────────────────────────────────────────────────────── */

function McpList({
  servers,
  userConfig,
  projectConfig,
  codexConfig,
  onToggle,
  onDelete,
}: {
  servers: CapabilityMcp[];
  userConfig?: string;
  projectConfig?: string;
  codexConfig?: string;
  onToggle: (server: CapabilityMcp, enabled: boolean) => void;
  onDelete: (server: CapabilityMcp) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p
        className="mb-1 shrink-0 truncate font-mono text-[9px] text-desk-dim/70"
        title={[userConfig, projectConfig].filter(Boolean).join(" · ")}
      >
        {userConfig}
        {projectConfig ? ` · ${projectConfig}` : ""}
      </p>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {servers.length === 0 ? (
          <li className="font-mono text-[10px] text-desk-dim/70">none configured — add one below</li>
        ) : null}
        {servers.map((server) => (
          <li
            key={`${server.scope}-${server.name}`}
            className="group flex items-start gap-1 rounded px-1.5 py-1 hover:bg-desk-panel2"
          >
            <input
              type="checkbox"
              checked={server.enabled}
              disabled={!server.editable}
              onChange={(e) => onToggle(server, e.target.checked)}
              className="mt-0.5 accent-[rgb(var(--desk-accent))]"
              title={server.editable ? "enabled" : "Codex config.toml is read-only here"}
            />
            <div className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="truncate font-mono text-[11px] text-desk-ink/90">{server.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[9px] uppercase text-desk-dim">
                  {server.scope} · {server.type}
                  {server.exposure ? ` · ${server.exposure}` : ""}
                </span>
              </span>
              <span
                className="block truncate font-mono text-[10px] text-desk-dim"
                title={server.command ?? server.url}
              >
                {server.type === "http" ? server.url : [server.command, ...(server.args ?? [])].join(" ")}
              </span>
              {server.description ? (
                <span className="block text-[10px] leading-snug text-desk-dim/80">{server.description}</span>
              ) : null}
            </div>
            {server.editable ? (
              <button
                type="button"
                onClick={() => onDelete(server)}
                className="mt-1 shrink-0 rounded px-1 font-mono text-[10px] text-desk-dim opacity-0 hover:text-desk-ember group-hover:opacity-100"
                title={`Remove ${server.name}`}
              >
                ✕
              </button>
            ) : (
              <span className="mt-1 shrink-0 font-mono text-[9px] text-desk-dim/60" title={codexConfig}>
                read-only
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddMcpForm({
  busy,
  target,
  onSave,
}: {
  busy: boolean;
  target?: string;
  onSave: (input: {
    name: string;
    type: "stdio" | "http";
    command?: string;
    args?: string[];
    url?: string;
    exposure?: string;
    description?: string;
  }) => void;
}) {
  const [type, setType] = useState<"stdio" | "http">("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [exposure, setExposure] = useState("codemode");
  const [description, setDescription] = useState("");

  const valid =
    /^[A-Za-z0-9_-]+$/.test(name) &&
    (type === "stdio" ? command.trim().length > 0 : /^https?:\/\//i.test(url.trim())) &&
    !busy;

  const submit = () => {
    if (!valid) return;
    onSave({
      name: name.trim(),
      type,
      command: type === "stdio" ? command.trim() : undefined,
      // A shell-like string is split on whitespace, quotes respected — how
      // every MCP client writes args in practice.
      args: type === "stdio" && args.trim() ? splitArgs(args) : undefined,
      url: type === "http" ? url.trim() : undefined,
      exposure,
      description: description.trim() || undefined,
    });
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-desk-dim">new server</span>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as "stdio" | "http")}
          className="shrink-0 rounded border border-desk-line bg-desk-panel2 px-1 py-1 font-mono text-[10px] text-desk-ink focus:border-desk-amber/60 focus:outline-none"
        >
          <option value="stdio">stdio</option>
          <option value="http">http</option>
        </select>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name"
          className="w-28 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[10px] text-desk-ink placeholder:text-desk-dim/60 focus:border-desk-amber/60 focus:outline-none"
        />
        {type === "stdio" ? (
          <>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="command (npx, uvx, node…)"
              className="w-40 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[10px] text-desk-ink placeholder:text-desk-dim/60 focus:border-desk-amber/60 focus:outline-none"
            />
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="args"
              className="min-w-0 flex-1 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[10px] text-desk-ink placeholder:text-desk-dim/60 focus:border-desk-amber/60 focus:outline-none"
            />
          </>
        ) : (
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="https://example.com/mcp"
            className="min-w-0 flex-1 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[10px] text-desk-ink placeholder:text-desk-dim/60 focus:border-desk-amber/60 focus:outline-none"
          />
        )}
        <select
          value={exposure}
          onChange={(e) => setExposure(e.target.value)}
          className="shrink-0 rounded border border-desk-line bg-desk-panel2 px-1 py-1 font-mono text-[10px] text-desk-ink focus:border-desk-amber/60 focus:outline-none"
          title="How the model reaches this server's tools"
        >
          <option value="codemode">codemode</option>
          <option value="deferred">deferred</option>
          <option value="direct">direct</option>
          <option value="hidden">hidden</option>
        </select>
        <button
          type="button"
          disabled={!valid}
          onClick={submit}
          className="shrink-0 rounded border border-desk-amber/60 bg-desk-amber/10 px-2 py-1 font-mono text-[10px] text-desk-amber hover:bg-desk-amber/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          add
        </button>
      </div>
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="description (one line — shown in the system prompt / tool search)"
        className="w-full rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[10px] text-desk-ink placeholder:text-desk-dim/60 focus:border-desk-amber/60 focus:outline-none"
      />
      {target ? (
        <p className="truncate font-mono text-[9px] text-desk-dim/70" title={target}>
          writes to {target}
        </p>
      ) : null}
    </div>
  );
}

/* ── session view ────────────────────────────────────────────────────────── */

/**
 * The one thing a file scan cannot show: what the *running session* actually
 * has. A capability added here appears in the next session, and a runtime's
 * own layer (Codex plugin skills, a server that failed to connect) is reported
 * by the runtime, not by the files. So the pane shows both and says which is
 * which, instead of implying "listed" means "live right now".
 */
function IsolationNote() {
  const capabilities = useSessionStore((s) => s.capabilities);
  if (!capabilities) {
    return (
      <p className="mt-1 shrink-0 font-mono text-[9px] leading-snug text-desk-dim/70">
        no session yet — changes apply to the next one
      </p>
    );
  }
  const connected = capabilities.mcp.filter((server) => server.connected).length;
  const enabled = capabilities.mcp.filter((server) => server.enabled).length;
  const pending = capabilities.mcp.some((server) => server.connected === false && server.enabled);
  return (
    <p className="mt-1 shrink-0 font-mono text-[9px] leading-snug text-desk-dim/70">
      running session: {capabilities.skills.length} skill{capabilities.skills.length === 1 ? "" : "s"} ·{" "}
      {connected}/{enabled} MCP connected
      {pending ? " — an enabled server that is not connected may need a new session" : ""}
    </p>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * The open session's project — a project-level write targets it, and a
 * session switch (which changes it) makes the pane re-scan.
 */
function useProjectPath(): string | undefined {
  const [projectPath, setProjectPath] = useState<string | undefined>();
  const [, bump] = useState(0);
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    const sync = () => setProjectPath(useSessionStore.getState().session?.projectPath);
    sync();
    unsubscribe = useSessionStore.subscribe((state, previous) => {
      if (state.session?.id !== previous.session?.id) {
        bump((v) => v + 1);
        sync();
      }
    });
    return () => unsubscribe?.();
  }, []);
  return projectPath;
}

/** `npx -y @scope/pkg .` → ["-y", "@scope/pkg", "."] with quotes respected. */
function splitArgs(input: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return out;
}

/** Heuristic: a NUL byte in the first slice means the file is not text. */
function isBinaryText(text: string): boolean {
  return text.slice(0, 4096).includes(String.fromCharCode(0));
}

/** Chromium's relative path for a picked file (empty without `webkitdirectory`). */
function fileRelativePath(file: File): string[] {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
  return relative ? relative.split("/") : [];
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Read one dropped/picked file as text, skipping binary and oversized ones. */
async function readFileEntry(file: File, path: string): Promise<Array<{ path: string; content: string }>> {
  // Binary assets are skipped: a skill's scripts still work from disk if the
  // folder is copied there, and shipping unreadable bytes as text would
  // corrupt them.
  if (file.size > 2 * 1024 * 1024) return [];
  const text = await file.text();
  if (isBinaryText(text)) return [];
  return [{ path, content: text }];
}

async function walkDirectory(
  entry: FileSystemDirectoryEntry,
  prefix = "",
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  const children = await new Promise<FileSystemEntry[]>((resolve, reject) =>
    entry.createReader().readEntries(resolve, reject),
  );
  for (const child of children) {
    if (child.name.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isFile) {
      const file = await fileFromEntry(child as FileSystemFileEntry);
      out.push(...(await readFileEntry(file, relative)));
    } else if (child.isDirectory) {
      out.push(...(await walkDirectory(child as FileSystemDirectoryEntry, relative)));
    }
  }
  return out;
}
