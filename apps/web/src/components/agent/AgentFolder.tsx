import { useMemo, useState } from "react";
import { useNow } from "../../hooks/useNow";
import { formatBytes, formatClock } from "../../lib/format";
import { openKnownFile } from "../../lib/openFile";
import { useFileStore } from "../../stores/fileStore";
import { useStageStore } from "../../stores/stageStore";
import type { FileVersion } from "../../types/file";
import { Panel } from "../Panel";
import { useT } from "../../lib/i18n";

function versionLabel(t: (key: string, params?: Record<string, string | number>) => string, entry: FileVersion): string {
  if (entry.complete) return t("whole file");
  if (entry.startLine !== undefined && entry.endLine !== undefined) {
    return t("lines {a}–{b}", { a: entry.startLine, b: entry.endLine });
  }
  return t("partial");
}

/**
 * The agent's view of the project: only the files it has in context, and every
 * version it has held of each. Content is the text captured at the time, so a
 * later change on disk never rewrites what the agent saw.
 */
export function AgentFolder() {
  useNow(5000);
  const t = useT();
  const files = useFileStore((s) => s.files);
  const activeId = useStageStore((s) => s.activeItem?.id);
  const stageMode = useStageStore((s) => s.mode);
  const agentFile = useStageStore((s) => s.agentFile);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const rows = useMemo(
    () =>
      Object.values(files).sort(
        (a, b) => (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0) || a.path.localeCompare(b.path),
      ),
    [files],
  );

  const shown =
    stageMode === "file" &&
    agentFile !== undefined &&
    activeId === agentFile.id &&
    agentFile.payload.kind === "file"
      ? agentFile.payload
      : undefined;

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <Panel
      title={t("Agent Folder")}
      aside={t("{n} known", { n: rows.length })}
      className="min-h-0 flex-1"
      bodyClassName="p-2"
    >
      {rows.length === 0 ? (
        <p className="text-[11px] text-desk-dim">
          {t("The agent has not touched anything yet. Files appear here as it reads and edits them.")}
        </p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((file) => {
            const latest = file.history.at(-1);
            const open = expanded.has(file.path);
            const fileShown = shown?.path === file.path;

            return (
              <li key={file.path}>
                <div className={["flex items-center rounded", fileShown ? "bg-desk-amber/15" : ""].join(" ")}>
                  <button
                    type="button"
                    onClick={() => toggle(file.path)}
                    title={open ? t("Hide versions") : t("Show versions")}
                    className="shrink-0 px-1 py-1 font-mono text-[10px] text-desk-dim hover:text-desk-ink"
                  >
                    {open ? "▾" : "▸"}
                  </button>
                  <button
                    type="button"
                    onClick={() => openKnownFile(file.path)}
                    title={t("{path} · show the newest agent-known content", { path: file.path })}
                    className="min-w-0 flex-1 py-1 pr-1 text-left"
                  >
                    <div className="flex items-baseline gap-2">
                      <span
                        className={[
                          "truncate font-mono text-[11px]",
                          fileShown ? "text-desk-amber" : "text-desk-ink/85",
                        ].join(" ")}
                        title={file.path}
                      >
                        {file.path}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-desk-dim/70">
                        {formatBytes(file.content.length)}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] text-desk-dim">
                      {t("{n} versions", { n: file.history.length })}
                      {latest ? ` · v${latest.version} ${latest.source}` : ""}
                    </div>
                  </button>
                </div>

                {open ? (
                  <ul className="mb-1 ml-4 border-l border-desk-line pl-2">
                    {[...file.history].reverse().map((entry) => {
                      const selected = fileShown && shown?.version === entry.version;
                      return (
                        <li key={entry.version}>
                          <button
                            type="button"
                            onClick={() => openKnownFile(file.path, entry.version)}
                            title={t("Show v{v} on the Stage", { v: entry.version })}
                            className={[
                              "flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left font-mono text-[10px]",
                              selected
                                ? "bg-desk-amber/15 text-desk-amber"
                                : "text-desk-dim hover:bg-desk-panel2 hover:text-desk-ink",
                            ].join(" ")}
                          >
                            <span className="w-6 shrink-0">v{entry.version}</span>
                            <span className="w-9 shrink-0">{entry.source}</span>
                            <span className="truncate">{versionLabel(t, entry)}</span>
                            <span className="ml-auto shrink-0 text-desk-dim/70">
                              {formatClock(entry.timestamp)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
