interface TerminalViewProps {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function TerminalView({ command, stdout, stderr, exitCode }: TerminalViewProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0f0d0b]">
      <div className="flex shrink-0 items-center gap-2 border-b border-desk-line px-3 py-2 font-mono text-xs">
        <span className="text-desk-teal">$</span>
        <span className="truncate text-desk-ink" title={command}>
          {command}
        </span>
        <span className="ml-auto shrink-0">
          <span
            className={[
              "chip",
              exitCode === 0 ? "text-desk-teal" : "text-desk-ember",
            ].join(" ")}
          >
            exit {exitCode}
          </span>
        </span>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-desk-ink/85">
        {stdout || "(no output)"}
        {stderr ? `\n${stderr}` : ""}
      </pre>
    </div>
  );
}
