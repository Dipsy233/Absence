import type { AgentStatus } from "@daze/core";
import type { StageItem } from "../../types/stage";
import { FileStage } from "./FileStage";
import { DiffStage } from "./DiffStage";
import { TerminalStage } from "./TerminalStage";
import { SearchStage } from "./SearchStage";
import { DeskStage } from "./DeskStage";

/** Renders whichever Stage item is active (read02 §11–17). */
export function StageItemView({ item, status }: { item: StageItem; status: AgentStatus }) {
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
    case "search":
      return (
        <SearchStage
          tool={payload.tool}
          query={payload.query}
          scope={payload.scope}
          matches={payload.matches}
          output={payload.output}
          event={item.event}
        />
      );
    case "plan":
      return <DeskStage plan={payload.plan} status={status} />;
    default:
      return null;
  }
}
