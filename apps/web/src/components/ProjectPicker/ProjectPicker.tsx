import { useEffect, useState } from "react";
import type { Project } from "@daze/core";
import { fetchProjects } from "../../lib/api";
import { useSessionStore } from "../../stores/sessionStore";
import { resetAllStores } from "../../stores/reset";

type AgentChoice = "auto" | "pi" | "mock";

/** The first screen: pick a local project and start watching (read.md §25). */
export function ProjectPicker() {
  const startSession = useSessionStore((s) => s.startSession);

  const [projects, setProjects] = useState<Project[]>([]);
  const [path, setPath] = useState("");
  const [agent, setAgent] = useState<AgentChoice>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    fetchProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

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

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-xl border border-desk-line bg-desk-panel p-6">
        <div className="flex items-baseline gap-3">
          <h1 className="font-mono text-3xl tracking-tight text-desk-ink">DAZE</h1>
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

        <div className="mt-4">
          <div className="label mb-1">runtime</div>
          <div className="flex gap-1">
            {(["auto", "pi", "mock"] as AgentChoice[]).map((choice) => (
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
            auto uses Pi when credentials are configured, otherwise falls back to the mock runtime.
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
