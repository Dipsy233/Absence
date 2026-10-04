import { useMemo } from "react";
import { useNow } from "../../hooks/useNow";
import { formatAgo, formatBytes } from "../../lib/format";
import { openKnownFile } from "../../lib/openFile";
import { useFileStore } from "../../stores/fileStore";
import { Panel } from "../Panel";

/**
 * The agent's view of the project: only the files it has in context. Clicking
 * one expands that content onto the Stage. The full project lives on the left.
 */
export function AgentTable() {
  useNow(5000);
  const files = useFileStore((s) => s.files);

  const rows = useMemo(
    () =>
      Object.values(files).sort(
        (a, b) => (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0) || a.path.localeCompare(b.path),
      ),
    [files],
  );

  return (
    <Panel
      title="Agent Table"
      aside={`${rows.length} known`}
      className="min-h-0 flex-1"
      bodyClassName="p-2"
    >
      {rows.length === 0 ? (
        <p className="text-[11px] text-desk-dim">
          The agent has not touched anything yet. Files appear here as it reads and edits them.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => openKnownFile(file.path)}
                title={`${file.path} · show the agent-known content on the Stage`}
                className="block w-full rounded px-1.5 py-1 text-left hover:bg-desk-panel2"
              >
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-mono text-[11px] text-desk-ink/85" title={file.path}>
                    {file.path}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-desk-dim/70">
                    {formatBytes(file.content.length)}
                  </span>
                </div>
                <div className="font-mono text-[10px] text-desk-dim">
                  v{file.version} · {file.version === 0 ? "read" : "edited"}
                  {file.lastModifiedAt ? ` · ${formatAgo(file.lastModifiedAt)}` : ""}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
