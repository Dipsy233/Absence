import type { StageItem } from "../../types/stage";
import { FileStage } from "./FileStage";
import { DiffStage } from "./DiffStage";
import { TerminalStage } from "./TerminalStage";

/** Renders whichever Stage item is active (read02 §11–17). */
export function StageItemView({ item }: { item: StageItem }) {
  const payload = item.payload;
  switch (payload.kind) {
    case "file":
      return (
        <FileStage
          path={payload.path}
          content={payload.content}
          language={payload.language}
          startLine={payload.startLine}
          endLine={payload.endLine}
          lineOffset={payload.lineOffset}
          caption={payload.caption}
          badge={payload.badge}
          badgeTone={payload.badgeTone}
        />
      );
    case "diff":
      return (
        <DiffStage
          path={payload.path}
          before={payload.before}
          after={payload.after}
          diff={payload.diff}
          language={payload.language}
          emptied={payload.emptied}
        />
      );
    case "terminal":
      return (
        <TerminalStage
          command={payload.command}
          stdout={payload.stdout}
          stderr={payload.stderr}
          exitCode={payload.exitCode}
          event={item.event}
        />
      );
    default:
      return null;
  }
}
