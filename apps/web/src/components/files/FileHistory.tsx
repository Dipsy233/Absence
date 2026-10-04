import { useState } from "react";
import { useFileStore } from "../../stores/fileStore";
import { useStageStore } from "../../stores/stageStore";
import { useUiStore } from "../../stores/uiStore";
import { formatClock } from "../../lib/format";
import { createStageItem } from "../../lib/events";
import { unifiedDiff } from "../../lib/diff";
import { PanelNav } from "../common/PanelNav";

/** Level 3: version history and the diff between any two versions (read02 §9). */
export function FileHistory({ path }: { path: string }) {
  const file = useFileStore((s) => s.files[path]);
  const setFilesView = useUiStore((s) => s.setFilesView);
  const openStage = useStageStore((s) => s.openStage);

  const history = file?.history ?? [];
  const [toVersion, setToVersion] = useState<number | undefined>(history.at(-1)?.version);

  const toIndex = history.findIndex((version) => version.version === toVersion);
  const effectiveTo = toIndex >= 0 ? toIndex : history.length - 1;
  const fromVersion = history[effectiveTo - 1];
  const toEntry = history[effectiveTo];

  const diff =
    fromVersion && toEntry
      ? unifiedDiff(fromVersion.content, toEntry.content, `v${fromVersion.version}`, `v${toEntry.version}`)
      : "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelNav
        title={`${path} · history`}
        onBack={() => setFilesView({ kind: "detail", path })}
        subtitle={`${history.length} version${history.length === 1 ? "" : "s"}`}
      />

      {history.length === 0 ? (
        <p className="text-xs text-desk-dim">No versions yet — the agent has not written to this file.</p>
      ) : (
        <>
          <ul className="shrink-0 space-y-0.5">
            {history.map((version, index) => {
              const selected = index === effectiveTo;
              return (
                <li key={version.version}>
                  <button
                    type="button"
                    onClick={() => setToVersion(version.version)}
                    className={[
                      "flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left font-mono text-[11px]",
                      selected ? "bg-desk-amber/15 text-desk-amber" : "text-desk-dim hover:bg-desk-panel2",
                    ].join(" ")}
                  >
                    <span className="w-8">v{version.version}</span>
                    <span>{formatClock(version.timestamp)}</span>
                    <span className="text-desk-dim/70">{version.source}</span>
                    {index === history.length - 1 ? <span className="ml-auto text-desk-teal">← current</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-2 flex shrink-0 items-center gap-2">
            <span className="label">
              {fromVersion ? `v${fromVersion.version} → v${toEntry?.version}` : "no previous version"}
            </span>
            <button
              type="button"
              disabled={!fromVersion}
              onClick={() =>
                fromVersion &&
                toEntry &&
                openStage(
                  createStageItem(
                    "diff",
                    path,
                    {
                      kind: "diff",
                      path,
                      before: fromVersion.content,
                      after: toEntry.content,
                      diff,
                      language: file?.language ?? "plaintext",
                    },
                    { path },
                  ),
                )
              }
              className="ml-auto rounded border border-desk-line px-2 py-1 text-[11px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber disabled:opacity-40"
            >
              Open Diff in Stage
            </button>
          </div>

          <pre className="mt-2 min-h-0 flex-1 overflow-auto rounded border border-desk-line bg-desk-bg p-2 font-mono text-[11px] leading-relaxed">
            {diff
              .split("\n")
              .map((line, index) => (
                <div
                  key={index}
                  className={
                    line.startsWith("+") && !line.startsWith("+++")
                      ? "text-desk-teal"
                      : line.startsWith("-") && !line.startsWith("---")
                        ? "text-desk-ember"
                        : "text-desk-dim"
                  }
                >
                  {line || " "}
                </div>
              ))}
          </pre>
        </>
      )}
    </div>
  );
}
