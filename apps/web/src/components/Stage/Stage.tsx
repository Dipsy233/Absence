import { AnimatePresence, motion } from "framer-motion";
import type { AgentStatus } from "@daze/core";
import { useDazeStore } from "../../stores/useDazeStore";
import { useUiStore } from "../../stores/useUiStore";
import { Panel } from "../Panel";
import { FileReadView } from "./FileReadView";
import { DiffView } from "./DiffView";
import { TerminalView } from "./TerminalView";
import { languageFromPath } from "../../lib/language";

export function Stage() {
  const action = useDazeStore((s) => s.currentAction);
  const files = useDazeStore((s) => s.files);
  const agent = useDazeStore((s) => s.agent);
  const selectedPath = useUiStore((s) => s.selectedPath);

  let key = "idle";
  let content = <IdleView status={agent.status} />;

  if (action?.type === "file_read") {
    key = action.id;
    content = (
      <FileReadView
        path={action.payload.path}
        content={action.payload.content}
        language={action.payload.language ?? languageFromPath(action.payload.path)}
        startLine={action.payload.startLine}
        endLine={action.payload.endLine}
        caption="Agent is reading"
      />
    );
  } else if (action?.type === "file_write") {
    key = action.id;
    content = (
      <FileReadView
        path={action.payload.path}
        content={action.payload.content}
        language={languageFromPath(action.payload.path)}
        badge="written"
        caption="Agent wrote this file"
      />
    );
  } else if (action?.type === "file_edit") {
    key = action.id;
    content = (
      <DiffView
        path={action.payload.path}
        before={action.payload.before}
        after={action.payload.after}
        diff={action.payload.diff}
        language={languageFromPath(action.payload.path)}
      />
    );
  } else if (action?.type === "command") {
    key = action.id;
    content = (
      <TerminalView
        command={action.payload.command}
        stdout={action.payload.stdout}
        stderr={action.payload.stderr}
        exitCode={action.payload.exitCode}
      />
    );
  } else if (selectedPath) {
    const file = files.find((f) => f.path === selectedPath);
    if (file) {
      key = `selected:${selectedPath}`;
      content = (
        <FileReadView
          path={file.path}
          content={file.content}
          language={languageFromPath(file.path)}
          startLine={file.lastRead?.startLine}
          endLine={file.lastRead?.endLine}
          caption="Remembered file (click the agent to follow it live)"
        />
      );
    }
  }

  return (
    <Panel title="Stage" className="min-h-0 flex-1" bodyClassName="p-0 overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.div
          key={key}
          className="h-full"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
    </Panel>
  );
}

export function IdleView({ status }: { status: AgentStatus }) {
  const caption =
    status === "idle"
      ? "The agent is sitting quietly."
      : status === "thinking"
        ? "The agent is thinking…"
        : "Waiting…";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 text-desk-dim">
      <div className="relative">
        <div className="h-24 w-40 rounded-md border border-desk-line bg-desk-panel2 shadow-inner">
          <div className="m-2 h-[calc(100%-16px)] rounded bg-[#0f0d0b]">
            <div className="flex h-full items-center justify-center font-mono text-[10px] text-desk-dim/60">
              DAZE
            </div>
          </div>
        </div>
        <div className="mx-auto h-3 w-12 rounded-b border-x border-b border-desk-line bg-desk-panel2" />
        <div className="mx-auto h-1.5 w-24 rounded-b bg-desk-line" />
      </div>
      <p className="text-xs italic">{caption}</p>
    </div>
  );
}
