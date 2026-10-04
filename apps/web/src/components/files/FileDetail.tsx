import { useChatStore } from "../../stores/chatStore";
import { useFileStore } from "../../stores/fileStore";
import { useStageStore } from "../../stores/stageStore";
import { useUiStore } from "../../stores/uiStore";
import { formatAgo } from "../../lib/format";
import { createStageItem } from "../../lib/events";
import { openKnownFile } from "../../lib/openFile";
import { fileContext } from "../../lib/context";
import { unifiedDiff } from "../../lib/diff";
import { CodeView } from "../common/CodeView";
import { PanelNav } from "../common/PanelNav";

/** Level 2: inspect one file before opening it on the Stage (read02 §5, §10). */
export function FileDetail({ path }: { path: string }) {
  const file = useFileStore((s) => s.files[path]);
  const setFilesView = useUiStore((s) => s.setFilesView);
  const openStage = useStageStore((s) => s.openStage);
  const addContext = useChatStore((s) => s.addContext);

  const content = file?.content ?? "";
  const history = file?.history ?? [];

  const openInStage = () => openKnownFile(path);

  const openDiffInStage = () => {
    if (history.length < 2) return;
    const previous = history[history.length - 2]!;
    const current = history[history.length - 1]!;
    openStage(
      createStageItem(
        "diff",
        path,
        {
          kind: "diff",
          path,
          before: previous.content,
          after: current.content,
          diff: unifiedDiff(previous.content, current.content, `v${previous.version}`, `v${current.version}`),
          language: file?.language ?? "plaintext",
        },
        { path },
      ),
    );
  };

  const button =
    "rounded border border-desk-line px-2 py-1 text-[11px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber disabled:opacity-40";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelNav
        title={path}
        onBack={() => setFilesView({ kind: "tree" })}
        subtitle={file ? `v${file.version} · edited ${formatAgo(file.lastModifiedAt)}` : "not seen yet"}
      />

      <div className="mb-2 flex h-40 shrink-0 overflow-hidden rounded border border-desk-line">
        <CodeView value={content || "// (the agent has not read this file yet)"} language={file?.language ?? "plaintext"} />
      </div>

      <div className="flex flex-wrap gap-1">
        <button type="button" className={button} disabled={!file} onClick={openInStage}>
          Open in Stage
        </button>
        <button
          type="button"
          className={button}
          disabled={history.length === 0}
          onClick={() => setFilesView({ kind: "history", path })}
        >
          View History
        </button>
        <button type="button" className={button} disabled={history.length < 2} onClick={openDiffInStage}>
          View Diff
        </button>
        <button type="button" className={button} disabled={!file} onClick={() => addContext(fileContext(path, content))}>
          Add to Chat
        </button>
      </div>

      {history.length > 0 ? (
        <div className="mt-3 overflow-auto border-t border-desk-line pt-2">
          <div className="label mb-1">last edits</div>
          <ul className="space-y-0.5 font-mono text-[10px] text-desk-dim">
            {history
              .slice(-5)
              .reverse()
              .map((version) => (
                <li key={version.version}>
                  v{version.version} · {version.source} · {formatAgo(version.timestamp)}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
