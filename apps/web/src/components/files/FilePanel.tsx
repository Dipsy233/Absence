import { useFileStore } from "../../stores/fileStore";
import { useUiStore } from "../../stores/uiStore";
import { useT } from "../../lib/i18n";
import { Panel } from "../Panel";
import { FileTree } from "./FileTree";
import { FileDetail } from "./FileDetail";
import { FileHistory } from "./FileHistory";

/**
 * Files is an entry point, not a dead end: tree → detail → history (read02 §5–10).
 *
 * `chrome={false}` is for a host that already titles the surface — Rounds'
 * floating Files window carries "Files" in its own title bar, so the panel must
 * not print a second header under it. The body keeps the same padding and
 * scrolling either way; only the frame and the header go. `onOpen` is the same
 * hand-off the tree takes: who handles a click (the Stage, or a window).
 */
export function FilePanel({ chrome = true, onOpen }: { chrome?: boolean; onOpen?: (rel: string) => void }) {
  const t = useT();
  const view = useUiStore((s) => s.filesView);
  const trackedCount = useFileStore((s) => Object.keys(s.files).length);

  const content = (
    <>
      {view.kind === "tree" ? <FileTree onOpen={onOpen} /> : null}
      {view.kind === "detail" ? <FileDetail path={view.path} /> : null}
      {view.kind === "history" ? <FileHistory path={view.path} /> : null}
    </>
  );

  if (!chrome) return <div className="panel-body p-2">{content}</div>;

  const aside =
    view.kind === "detail" ? t("inspect") : view.kind === "history" ? t("History") : t("{n} seen", { n: trackedCount });

  return (
    <Panel title={t("Files")} aside={aside} className="min-h-0 flex-1" bodyClassName="p-2">
      {content}
    </Panel>
  );
}
