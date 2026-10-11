import type { StageItem } from "../../types/stage";
import { FileStage } from "./FileStage";
import { DiffStage } from "./DiffStage";
import { TerminalStage } from "./TerminalStage";
import { ThoughtStage } from "./ThoughtStage";
import { ProcessStage } from "./ProcessStage";
import { ApprovalStage } from "./ApprovalStage";

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
    case "thought":
      return <ThoughtStage text={payload.text} streaming={payload.streaming} event={item.event} />;
    case "process":
      return (
        <ProcessStage
          pid={payload.pid}
          ppid={payload.ppid}
          name={payload.name}
          commandLine={payload.commandLine}
          status={payload.status}
          children={payload.children}
          command={payload.command}
          startedAt={payload.startedAt}
          exitedAt={payload.exitedAt}
          event={item.event}
        />
      );
    case "approval":
      return (
        <ApprovalStage
          approvalId={payload.approvalId}
          approvalKind={payload.approvalKind}
          title={payload.title}
          detail={payload.detail}
          reason={payload.reason}
          cwd={payload.cwd}
          options={payload.options}
          event={item.event}
        />
      );
    default:
      return null;
  }
}
