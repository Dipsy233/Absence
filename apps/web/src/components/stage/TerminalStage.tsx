import { useState } from "react";
import { eventContext } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";
import { useT } from "../../lib/i18n";
import type { AbsenceEvent } from "@absence/core";

/** The MCP context a terminal card carries when it is an MCP call. */
export interface McpTerminalContext {
  server: string;
  tool: string;
  namespace?: string;
  structured?: string;
  /** The call's arguments, shown by the header's text/json toggle. */
  args?: string;
  /** `call` while in flight, `result` once the server answered. */
  phase?: "call" | "result";
  toolCallId?: string;
  /** Rebuilt from a tool start only: no result was ever reported. */
  pending?: boolean;
  /** Absence's honest note about a call it only saw start. */
  note?: string;
}

interface TerminalStageProps {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Present when this terminal shows an MCP call rather than a shell command. */
  mcp?: McpTerminalContext;
  event?: AbsenceEvent;
}

export function TerminalStage({
  command,
  stdout,
  stderr,
  exitCode,
  mcp,
  event,
}: TerminalStageProps) {
  const t = useT();
  const addContext = useChatStore((s) => s.addContext);
  const [showStructured, setShowStructured] = useState(false);
  const output = [stdout, stderr].filter((part) => part.length > 0).join(String.fromCharCode(10));
  // A call the adapter only announced: in flight, with nothing back yet.
  const pending = mcp?.phase === "call";
  const NL = String.fromCharCode(10);

  return (
    <div className="flex h-full min-h-0 flex-col bg-desk-deep/60">
      <div className="flex shrink-0 items-center gap-2 border-b border-desk-line px-3 py-2 font-mono text-xs">
        {mcp ? (
          // An MCP call is not a shell: the prompt says so, and the server is
          // named, so a person never mistakes one for the other.
          <span className="chip shrink-0 text-desk-lavender" title={`MCP server ${mcp.server}`}>
            mcp
          </span>
        ) : (
          <span className="text-desk-teal">$</span>
        )}
        <span className="truncate text-desk-ink" title={command}>
          {command}
        </span>
        {mcp ? (
          <span className="shrink-0 rounded border border-desk-line px-1 text-[9px] uppercase text-desk-dim">
            {mcp.server}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {mcp?.structured ? (
            <button
              type="button"
              onClick={() => setShowStructured((on) => !on)}
              className="rounded border border-desk-line px-1.5 py-0.5 text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
              title={t("Toggle the server's structured (JSON) result")}
            >
              {showStructured ? t("text") : t("json")}
            </button>
          ) : null}
          <span
            className={[
              "chip",
              mcp && pending ? "text-desk-dim" : exitCode === 0 ? "text-desk-teal" : "text-desk-ember",
            ].join(" ")}
          >
            {mcp ? (pending ? t("running") : exitCode === 0 ? t("ok") : t("error")) : t("exit {code}", { code: exitCode })}
          </span>
          <CopyButton label={t("copy cmd")} text={command} title={t("Copy the command")} />
          <CopyButton label={t("copy out")} text={output} title={t("Copy the output")} disabled={output.length === 0} />
          {event ? (
            <button
              type="button"
              onClick={() => addContext(eventContext(event))}
              className="rounded border border-desk-line px-1.5 py-0.5 text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
              title={t("Add this command to Chat")}
            >
              {t("+ Chat")}
            </button>
          ) : null}
        </span>
      </div>
      {mcp?.note ? (
        // Say plainly what Absence saw. A call it only watched start must not
        // pass for one whose result it has.
        <p className="shrink-0 border-b border-desk-line/60 px-3 py-1 text-[10px] italic text-desk-dim">
          {mcp.note}
        </p>
      ) : null}
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-desk-ink/85">
        {pending && !output ? (
          <span className="text-desk-dim">…</span>
        ) : (
          <>
            {stdout || t("(no output)")}
            {stderr ? `\n${stderr}` : ""}
          </>
        )}
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
  const t = useT();
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
      {copied ? t("copied") : label}
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
