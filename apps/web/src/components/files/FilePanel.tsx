import { useFileStore } from "../../stores/fileStore";
import { useUiStore } from "../../stores/uiStore";
import { Panel } from "../Panel";
import { FileTree } from "./FileTree";
import { FileDetail } from "./FileDetail";
import { FileHistory } from "./FileHistory";

/** Files is an entry point, not a dead end: tree → detail → history (read02 §5–10). */
export function FilePanel() {
  const view = useUiStore((s) => s.filesView);
  const trackedCount = useFileStore((s) => Object.keys(s.files).length);

  const aside =
    view.kind === "detail" ? "inspect" : view.kind === "history" ? "history" : `${trackedCount} seen`;

  return (
    <Panel title="Files" aside={aside} className="min-h-0 flex-1" bodyClassName="p-2">
      {view.kind === "tree" ? <FileTree /> : null}
      {view.kind === "detail" ? <FileDetail path={view.path} /> : null}
      {view.kind === "history" ? <FileHistory path={view.path} /> : null}
    </Panel>
  );
}
