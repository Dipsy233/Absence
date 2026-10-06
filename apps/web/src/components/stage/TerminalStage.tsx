import { useState } from "react";
import { eventContext } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";
import type { DazeEvent } from "@daze/core";

interface TerminalStageProps {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  event?: DazeEvent;
}

export function TerminalStage({ command, stdout, stderr, exitCode, event }: TerminalStageProps) {
  const addContext = useChatStore((s) => s.addContext);
  const output = [stdout, stderr].filter((part) => part.length > 0).join("\n");

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0f0d0b]/60">
      <div className="flex shrink-0 items-center gap-2 border-b border-desk-line px-3 py-2 font-mono text-xs">
        <span className="text-desk-teal">$</span>
        <span className="truncate text-desk-ink" title={command}>
          {command}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className={["chip", exitCode === 0 ? "text-desk-teal" : "text-desk-ember"].join(" ")}>
            exit {exitCode}
          </span>
          <CopyButton label="copy cmd" text={command} title="Copy the command" />
          <CopyButton label="copy out" text={output} title="Copy the output" disabled={output.length === 0} />
          {event ? (
            <button
              type="button"
              onClick={() => addContext(eventContext(event))}
              className="rounded border border-desk-line px-1.5 py-0.5 text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
              title="Add this command to Chat"
            >
              + Chat
            </button>
          ) : null}
        </span>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-desk-ink/85">
        {stdout || "(no output)"}
        {stderr ? `\n${stderr}` : ""}
      </pre>
    </div>
  );
}

/** A small header button that copies text and briefly confirms. */
function CopyButton({
  label,
  text,
  title,
  disabled,
}: {
  label: string;
  text: string;
  title: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      type="button"
      onClick={copy}
      disabled={disabled}
      title={title}
      className={[
        "rounded border px-1.5 py-0.5 text-[10px] transition-colors",
        copied
          ? "border-desk-teal/60 text-desk-teal"
          : "border-desk-line text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-desk-line disabled:hover:text-desk-dim",
      ].join(" ")}
    >
      {copied ? "copied" : label}
    </button>
  );
}

/** Clipboard API with a fallback for insecure contexts. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
