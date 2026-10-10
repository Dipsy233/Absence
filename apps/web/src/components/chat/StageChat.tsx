import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { isAgentBusy, type CommandOption } from "@daze/core";
import { buildPrompt } from "../../lib/context";
import * as api from "../../lib/api";
import { COMMANDS, findCommand, type CommandSpec } from "../../lib/commands";
import { useChatStore } from "../../stores/chatStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { ContextChip } from "./ContextChip";

/**
 * Chat docked at the bottom of the Stage (read02 §30). It floats over the Stage
 * instead of taking layout space, so the middle never shrinks: it is always one
 * input row, and the history unfolds upward as a translucent layer — at most 30%
 * of the Stage by default, with an arrow to blow it up to full height. The
 * history only shows while the Stage is on its default page, and whether it is
 * unfolded is remembered, so it docks the way you left it every time you return.
 *
 * The input is also a small terminal: a `/` at the start switches to command
 * mode, where a `/` button and a filterable palette (above the input) run Pi
 * commands. Anything else is an ordinary prompt.
 */
export function StageChat({ expanded }: { expanded: boolean }) {
  const messages = useChatStore((s) => s.messages);
  const pending = useChatStore((s) => s.pending);
  const clearContext = useChatStore((s) => s.clearContext);
  const status = useSessionStore((s) => s.agent.status);
  const connected = useSessionStore((s) => s.connected);
  const sessionId = useSessionStore((s) => s.session?.id);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const runCommand = useSessionStore((s) => s.runCommand);
  const abort = useSessionStore((s) => s.abort);

  const [text, setText] = useState("");
  const [full, setFull] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [options, setOptions] = useState<CommandOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const historyOpen = useUiStore((s) => s.chatHistoryOpen);
  const setHistoryOpen = useUiStore((s) => s.setChatHistoryOpen);
  const showHistory = expanded && historyOpen;

  // --- command-mode derivation ---------------------------------------------
  const commandMode = text.startsWith("/");
  const body = commandMode ? text.slice(1) : "";
  const spaceAt = body.indexOf(" ");
  const cmdName = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
  const argText = spaceAt === -1 ? "" : body.slice(spaceAt + 1);
  const phase: "name" | "arg" = spaceAt === -1 ? "name" : "arg";
  const command = commandMode ? findCommand(cmdName) : undefined;

  const nameMatches = useMemo(
    () => (commandMode && phase === "name" ? COMMANDS.filter((c) => c.name.startsWith(cmdName)) : []),
    [commandMode, phase, cmdName],
  );

  const activeOptions: CommandOption[] =
    phase === "arg" && command?.kind === "choice" ? (command.staticOptions ?? options) : [];

  const paletteItems: CommandOption[] =
    phase === "name"
      ? nameMatches.map((spec) => ({ value: spec.name, label: `/${spec.name}`, description: spec.description }))
      : activeOptions;

  const showPalette =
    paletteOpen &&
    commandMode &&
    (phase === "name" ? nameMatches.length > 0 : command?.kind === "choice" || command?.kind === "text");

  // Fetch the choice list for server-backed commands (/model, /thinking) when
  // the argument phase opens.
  useEffect(() => {
    if (!commandMode || phase !== "arg") return;
    if (command?.kind !== "choice" || command.staticOptions) return;
    if (!sessionId) return;
    let cancelled = false;
    setLoadingOptions(true);
    api
      .fetchCommandOptions(sessionId, command.name)
      .then((fetched) => {
        if (cancelled) return;
        setOptions(fetched);
        setHighlight(0);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingOptions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [commandMode, phase, command?.name, command?.kind, command?.staticOptions, sessionId]);

  // Keep the highlight inside the current list.
  useEffect(() => {
    const length = paletteItems.length;
    setHighlight((h) => (length === 0 ? 0 : Math.min(h, length - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteItems.length]);

  useEffect(() => {
    // Leaving the default page resets the "full height" state; the remembered
    // open/closed choice is kept.
    if (!expanded) setFull(false);
  }, [expanded]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && showHistory) element.scrollTop = element.scrollHeight;
  }, [messages, showHistory, full]);

  const busy = isAgentBusy(status);

  const closePalette = () => {
    setText("");
    setPaletteOpen(false);
    setOptions([]);
    setHighlight(0);
  };

  const execute = async (name: string, args: string) => {
    closePalette();
    await runCommand(name, args);
  };

  const openArgPhase = (spec: CommandSpec) => {
    setText(`/${spec.name} `);
    setPaletteOpen(true);
    setOptions([]);
    setHighlight(0);
    inputRef.current?.focus();
  };

  const chooseItem = (value: string) => {
    if (phase === "name") {
      const spec = findCommand(value);
      if (!spec) return;
      if (spec.kind === "none") void execute(spec.name, "");
      else openArgPhase(spec);
      return;
    }
    if (command) void execute(command.name, value);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!commandMode) {
      const value = text.trim();
      if (!value && pending.length === 0) return;
      const prompt = buildPrompt(pending, value || "(content above)");
      setText("");
      clearContext();
      await sendPrompt(prompt);
      return;
    }
    if (phase === "name") {
      if (!command) return closePalette();
      if (command.kind === "none") return void execute(command.name, "");
      return openArgPhase(command);
    }
    if (!command) return closePalette();
    if (command.kind === "choice") {
      const item = activeOptions[highlight];
      if (!item) return;
      void execute(command.name, item.value);
    } else {
      void execute(command.name, argText.trim());
    }
  };

  const handleChange = (value: string) => {
    setText(value);
    setPaletteOpen(value.startsWith("/"));
    setHighlight(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Never fight an IME (Chinese/Japanese composition).
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      if (commandMode || paletteOpen) {
        event.preventDefault();
        closePalette();
      }
      return;
    }
    if (!paletteOpen) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const length = paletteItems.length;
      if (length === 0) return;
      event.preventDefault();
      setHighlight((h) => (event.key === "ArrowDown" ? (h + 1) % length : (h - 1 + length) % length));
    }
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex flex-col justify-end">
      <AnimatePresence initial={false}>
        {showHistory ? (
          <motion.div
            key="history"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className={[
              "pointer-events-auto mx-2 mb-1 flex min-h-0 flex-col overflow-hidden rounded-lg border border-desk-line/70",
              "bg-desk-panel/85 shadow-[0_18px_50px_rgba(0,0,0,.45)] backdrop-blur-[3px]",
              full ? "max-h-[calc(100%-4rem)]" : "max-h-[30%]",
            ].join(" ")}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-desk-line/70 px-2 py-1">
              <span className="label">Chat</span>
              <button
                type="button"
                onClick={() => setFull((value) => !value)}
                title={full ? "Collapse the history" : "Expand the full history"}
                className="rounded px-1.5 py-0.5 font-mono text-[10px] text-desk-dim hover:bg-desk-panel2 hover:text-desk-ink"
              >
                {full ? "▼ collapse" : "▲ expand"}
              </button>
            </div>
            <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2">
              {messages.length === 0 ? (
                <p className="text-xs text-desk-dim">
                  Ask the agent to do something, or type <span className="font-mono text-desk-amber">/</span> for
                  commands. Attach context from Files, Activity or a selection.
                </p>
              ) : (
                messages.map((message) => (
                  <div key={message.id}>
                    <div className="label mb-0.5">
                      {message.role === "user" ? "You" : message.role === "system" ? "ABSENCE" : "Agent"}
                    </div>
                    <div
                      className={[
                        "whitespace-pre-wrap rounded px-2 py-1.5 text-xs leading-relaxed",
                        message.role === "user"
                          ? "bg-desk-panel2 text-desk-ink"
                          : message.role === "system"
                            ? "border border-desk-line/60 bg-desk-panel2/40 font-mono text-[11px] text-desk-dim"
                            : "border border-desk-line bg-desk-bg text-desk-ink/90",
                      ].join(" ")}
                    >
                      {message.content}
                      {message.streaming ? <span className="ml-0.5 animate-pulse text-desk-amber">▍</span> : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {pending.length > 0 ? (
        <div className="pointer-events-auto mx-2 mb-1 flex flex-wrap items-center gap-1 rounded-lg border border-desk-line/70 bg-desk-panel/85 px-2 py-1.5 backdrop-blur-[3px]">
          <span className="label">context</span>
          {pending.map((context, index) => (
            <ContextChip key={`${context.label}-${index}`} context={context} index={index} />
          ))}
        </div>
      ) : null}

      <form
        onSubmit={submit}
        className="pointer-events-auto relative mx-2 mb-2 flex items-center gap-2 rounded-lg border border-desk-line/70 bg-desk-panel/85 px-2 py-1.5 shadow-[0_12px_36px_rgba(0,0,0,.4)] backdrop-blur-[3px]"
      >
        {showPalette ? (
          <div className="absolute bottom-full left-0 right-0 mb-1 max-h-56 overflow-auto rounded-lg border border-desk-line/70 bg-desk-panel/95 p-1 shadow-[0_18px_50px_rgba(0,0,0,.45)] backdrop-blur-[3px]">
            {phase === "name" || command?.kind === "choice" ? (
              paletteItems.length === 0 ? (
                <div className="px-2 py-1 text-xs text-desk-dim">{loadingOptions ? "loading…" : "no options"}</div>
              ) : (
                paletteItems.map((item, index) => (
                  <PaletteRow
                    key={item.value}
                    active={index === highlight}
                    onHover={() => setHighlight(index)}
                    onSelect={() => chooseItem(item.value)}
                  >
                    <span className={phase === "name" ? "font-mono text-desk-amber" : "font-mono text-desk-ink"}>
                      {item.label}
                    </span>
                    {item.description ? <span className="ml-2 truncate text-desk-dim">{item.description}</span> : null}
                    {item.active ? <span className="ml-auto pl-2 text-desk-teal">●</span> : null}
                  </PaletteRow>
                ))
              )
            ) : (
              <div className="px-2 py-1 text-xs text-desk-dim">
                <span className="font-mono text-desk-amber">/{command?.name}</span>
                {command?.argHint ? <span className="ml-2">{command.argHint}</span> : null}
                <span className="ml-2">— press Enter to run</span>
              </div>
            )}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => {
            if (commandMode) {
              closePalette();
            } else {
              setText("/");
              setPaletteOpen(true);
              setHighlight(0);
              inputRef.current?.focus();
            }
          }}
          title="Commands — type / and pick one"
          className={[
            "shrink-0 rounded border px-2 py-1 font-mono text-xs transition-colors",
            commandMode
              ? "border-desk-amber/70 bg-desk-panel2 text-desk-amber"
              : "border-desk-line text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber",
          ].join(" ")}
        >
          /
        </button>

        <button
          type="button"
          onClick={() => setHistoryOpen(!historyOpen)}
          disabled={!expanded}
          title={
            expanded
              ? historyOpen
                ? "Hide the conversation — keep just the input row"
                : "Show the conversation"
              : "The conversation shows on the desk page"
          }
          className="shrink-0 rounded border border-desk-line px-1.5 py-1 font-mono text-[10px] text-desk-dim transition-colors hover:border-desk-amber/60 hover:text-desk-amber disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-desk-line disabled:hover:text-desk-dim"
        >
          {historyOpen ? "▾ hide" : "▴ chat"}
        </button>

        <input
          ref={inputRef}
          value={text}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={connected ? (commandMode ? "type a command…" : "Ask the agent…") : "connecting…"}
          disabled={!connected}
          className="min-w-0 flex-1 rounded border border-desk-line bg-desk-panel2 px-2 py-1.5 font-mono text-xs text-desk-ink outline-none placeholder:text-desk-dim/60 focus:border-desk-amber/70 disabled:opacity-50"
        />

        {commandMode ? (
          <button
            type="submit"
            disabled={!connected}
            className="shrink-0 rounded border border-desk-amber/60 bg-desk-panel2 px-3 py-1.5 text-xs text-desk-amber hover:bg-desk-amber/10 disabled:opacity-40"
          >
            Run
          </button>
        ) : busy ? (
          <button
            type="button"
            onClick={() => void abort()}
            className="shrink-0 rounded border border-desk-ember/60 px-3 py-1.5 text-xs text-desk-ember hover:bg-desk-ember/10"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!connected || (!text.trim() && pending.length === 0)}
            className="shrink-0 rounded border border-desk-line bg-desk-panel2 px-3 py-1.5 text-xs text-desk-ink hover:border-desk-amber/70 disabled:opacity-40"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}

/** One row in the command palette. Mouse-down is swallowed so the input keeps focus. */
function PaletteRow({
  active,
  onHover,
  onSelect,
  children,
}: {
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onHover}
      onClick={onSelect}
      className={[
        "flex w-full items-center rounded px-2 py-1 text-left text-xs",
        active ? "bg-desk-panel2 text-desk-ink" : "text-desk-dim hover:bg-desk-panel2/60",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
