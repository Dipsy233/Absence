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
import { isAgentBusy, type CommandOption } from "@absence/core";
import { buildPrompt } from "../../lib/context";
import * as api from "../../lib/api";
import { COMMANDS, findCommand, isSkillInvocation, type CommandSpec } from "../../lib/commands";
import { useChatStore } from "../../stores/chatStore";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useT } from "../../lib/i18n";
import { ContextChip } from "./ContextChip";
import { Markdown } from "../common/Markdown";

/**
 * Chat docked at the bottom of the Stage (read02 §30). It floats over the Stage
 * instead of taking layout space, so the middle never shrinks: it is always one
 * input row, and the history unfolds upward as a translucent layer — at most 30%
 * of the Stage by default, with an arrow to blow it up to full height. Whether
 * it is unfolded is remembered, and by default it stays put across pages; the
 * "collapse on content" setting (Settings → APPEARANCE) makes a content page
 * fold it away instead.
 *
 * The input is also a small terminal: a `/` at the start switches to command
 * mode, where a `/` button and a filterable palette (above the input) run Pi
 * commands. Anything else is an ordinary prompt.
 */
export function StageChat({ expanded }: { expanded: boolean }) {
  const t = useT();
  const messages = useChatStore((s) => s.messages);
  const pending = useChatStore((s) => s.pending);
  const clearContext = useChatStore((s) => s.clearContext);
  const status = useSessionStore((s) => s.agent.status);
  const connected = useSessionStore((s) => s.connected);
  const sessionId = useSessionStore((s) => s.session?.id);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const runCommand = useSessionStore((s) => s.runCommand);
  const abort = useSessionStore((s) => s.abort);
  // Observing somebody else's agent: there is nothing to send a prompt to, so
  // the input row becomes a read-only note instead of a disabled textbox that
  // looks broken. Chat history is still shown — it is the agent's conversation,
  // mirrored, not Absence's.
  const observed = useIsObserved();

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
  const collapseChatOnContent = useSettingsStore((s) => s.collapseChatOnContent);
  // Agent replies are Markdown; the toggle in the header shows the raw text
  // instead when the rendering gets in the way.
  const chatMarkdown = useSettingsStore((s) => s.chatMarkdown);
  const setChatMarkdown = useSettingsStore((s) => s.setChatMarkdown);
  // `expanded` marks the Stage's default (desk) page. By default the chat stays
  // put no matter which page is up; only the "collapse on content" setting makes
  // a content page fold the history away.
  // An observed agent's conversation is worth showing by default: it is the only
  // thing on the Stage that says what the agent is thinking about. The user's own
  // preference still wins when they explicitly hide it.
  const showHistory = observed ? historyOpen : historyOpen && (expanded || !collapseChatOnContent);

  // --- command-mode derivation ---------------------------------------------
  const commandMode = text.startsWith("/");
  const body = commandMode ? text.slice(1) : "";
  const spaceAt = body.indexOf(" ");
  const cmdName = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
  const argText = spaceAt === -1 ? "" : body.slice(spaceAt + 1);
  const phase: "name" | "arg" = spaceAt === -1 ? "name" : "arg";
  const command = commandMode ? findCommand(cmdName) : undefined;
  // `/skill:` completes skill names, not command names: the palette needs the
  // session's skills, which the server reports with the capability state.
  const skills = useSessionStore((s) => s.capabilities?.skills);
  const skillPrefix = commandMode && body.startsWith("skill:") ? body.slice("skill:".length) : undefined;

  const nameMatches = useMemo(
    () =>
      commandMode && phase === "name"
        ? COMMANDS.filter((c) => c.name.startsWith(cmdName))
        : [],
    [commandMode, phase, cmdName],
  );

  const skillMatches: CommandOption[] = useMemo(() => {
    if (skillPrefix === undefined) return [];
    const q = skillPrefix.toLowerCase();
    return (skills ?? [])
      .filter((skill) => skill.name.toLowerCase().includes(q))
      .map((skill) => ({
        value: `/skill:${skill.name} `,
        label: `/skill:${skill.name}`,
        description: skill.description,
      }));
  }, [skillPrefix, skills]);

  const activeOptions: CommandOption[] =
    phase === "arg" && command?.kind === "choice" ? (command.staticOptions ?? options) : [];

  const paletteItems: CommandOption[] =
    skillPrefix !== undefined
      ? skillMatches
      : phase === "name"
        ? nameMatches.map((spec) => ({ value: spec.name, label: `/${spec.name}`, description: spec.description }))
        : activeOptions;

  const showPalette =
    paletteOpen &&
    commandMode &&
    (skillPrefix !== undefined
      ? skillMatches.length > 0
      : phase === "name"
        ? nameMatches.length > 0
        : command?.kind === "choice" || command?.kind === "text");

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
    // A content page resets the "full height" state only when the setting asks
    // the chat to make way for it; otherwise the dock is left untouched.
    if (!expanded && collapseChatOnContent) setFull(false);
  }, [expanded, collapseChatOnContent]);

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
    if (value.startsWith("/skill:")) {
      setText(value);
      setPaletteOpen(false);
      inputRef.current?.focus();
      return;
    }
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
    // `/skill:<name> [request]` is a skill invocation: it belongs in the prompt,
    // where the runtime expands it into the skill's instructions. Turns it into
    // one instead of dispatching an unknown command.
    if (isSkillInvocation(text.trim())) {
      const prompt = text.trim();
      setText("");
      closePalette();
      await sendPrompt(prompt);
      return;
    }
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
      // `/mcp reconnect` takes an optional server name, so choosing it keeps
      // the line open instead of running half a command.
      if (command.name === "mcp" && item.value !== "list") {
        setText(`/${command.name} ${item.value} `);
        setPaletteOpen(false);
        inputRef.current?.focus();
        return;
      }
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
    <div className="pointer-events-none absolute inset-0 z-50 flex flex-col justify-end">
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
              <span className="label">{t("Chat")}</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setChatMarkdown(!chatMarkdown)}
                  title={
                    chatMarkdown
                      ? t("Show the agent's replies as raw text")
                      : t("Render the agent's replies as Markdown")
                  }
                  className={[
                    "rounded px-1.5 py-0.5 font-mono text-[10px] hover:bg-desk-panel2",
                    chatMarkdown ? "text-desk-teal" : "text-desk-dim hover:text-desk-ink",
                  ].join(" ")}
                >
                  {chatMarkdown ? t("md") : t("raw")}
                </button>
                <button
                  type="button"
                  onClick={() => setFull((value) => !value)}
                  title={full ? t("Collapse the history") : t("Expand the full history")}
                  className="rounded px-1.5 py-0.5 font-mono text-[10px] text-desk-dim hover:bg-desk-panel2 hover:text-desk-ink"
                >
                  {full ? t("▼ collapse") : t("▲ expand")}
                </button>
              </div>
            </div>
            <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2">
              {messages.length === 0 ? (
                <p className="text-xs text-desk-dim">
                  {t("Ask the agent to do something, or type <slash> for commands. Attach context from Files, Activity or a selection.")
                    .split("<slash>")[0]}
                  <span className="font-mono text-desk-amber">/</span>
                  {t("Ask the agent to do something, or type <slash> for commands. Attach context from Files, Activity or a selection.")
                    .split("<slash>")[1]}
                </p>
              ) : (
                messages.map((message) => (
                  <div key={message.id}>
                    <div className="label mb-0.5">
                      {message.role === "user" ? t("You") : message.role === "system" ? "ABSENCE" : t("Agent")}
                    </div>
                    <div
                      className={[
                        "rounded px-2 py-1.5 text-xs leading-relaxed",
                        message.role === "user"
                          ? "whitespace-pre-wrap bg-desk-panel2 text-desk-ink"
                          : message.role === "system"
                            ? "whitespace-pre-wrap border border-desk-line/60 bg-desk-panel2/40 font-mono text-[11px] text-desk-dim"
                            : "border border-desk-line bg-desk-bg text-desk-ink/90",
                      ].join(" ")}
                    >
                      {message.role === "assistant" && chatMarkdown ? (
                        <Markdown text={message.content} streaming={message.streaming} />
                      ) : (
                        <>
                          <span className="whitespace-pre-wrap">{message.content}</span>
                          {message.streaming ? <span className="ml-0.5 animate-pulse text-desk-amber">▍</span> : null}
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {observed ? (
        <div className="pointer-events-auto mx-2 mb-2 flex items-center gap-2 rounded-lg border border-desk-line/70 bg-desk-panel/85 px-2 py-1.5 font-mono text-[10px] text-desk-dim backdrop-blur-[3px]">
          <span className="rounded border border-desk-line px-1.5 py-0.5 uppercase tracking-[0.12em] text-desk-teal">
            {t("observing")}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {t("Absence is watching this agent's terminal. Prompt it there — here it only shows what it does.")}
          </span>
        </div>
      ) : pending.length > 0 ? (
        <div className="pointer-events-auto mx-2 mb-1 flex flex-wrap items-center gap-1 rounded-lg border border-desk-line/70 bg-desk-panel/85 px-2 py-1.5 backdrop-blur-[3px]">
          <span className="label">{t("context")}</span>
          {pending.map((context, index) => (
            <ContextChip key={`${context.label}-${index}`} context={context} index={index} />
          ))}
        </div>
      ) : null}

      {observed ? null : (
      <form
        onSubmit={submit}
        className="pointer-events-auto relative mx-2 mb-2 flex items-center gap-2 rounded-lg border border-desk-line/70 bg-desk-panel/85 px-2 py-1.5 shadow-[0_12px_36px_rgba(0,0,0,.4)] backdrop-blur-[3px]"
      >
        {showPalette ? (
          <div className="absolute bottom-full left-0 right-0 mb-1 max-h-56 overflow-auto rounded-lg border border-desk-line/70 bg-desk-panel/95 p-1 shadow-[0_18px_50px_rgba(0,0,0,.45)] backdrop-blur-[3px]">
            {phase === "name" || command?.kind === "choice" ? (
              paletteItems.length === 0 ? (
                <div className="px-2 py-1 text-xs text-desk-dim">
                  {loadingOptions ? t("loading…") : t("no options")}
                </div>
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
                <span className="ml-2">{t("— press Enter to run")}</span>
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
          title={t("Commands — type / and pick one")}
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
          disabled={!expanded && collapseChatOnContent}
          title={
            historyOpen
              ? t("Hide the conversation — keep just the input row")
              : t("Show the conversation")
          }
          className="shrink-0 rounded border border-desk-line px-1.5 py-1 font-mono text-[10px] text-desk-dim transition-colors hover:border-desk-amber/60 hover:text-desk-amber disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-desk-line disabled:hover:text-desk-dim"
        >
          {historyOpen ? t("▾ hide") : t("▴ chat")}
        </button>

        <input
          ref={inputRef}
          value={text}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            connected
              ? commandMode
                ? t("type a command…")
                : t("Ask the agent…")
              : t("connecting…")
          }
          disabled={!connected}
          className="min-w-0 flex-1 rounded border border-desk-line bg-desk-panel2 px-2 py-1.5 font-mono text-xs text-desk-ink outline-none placeholder:text-desk-dim/60 focus:border-desk-amber/70 disabled:opacity-50"
        />

        {commandMode ? (
          <button
            type="submit"
            disabled={!connected}
            className="shrink-0 rounded border border-desk-amber/60 bg-desk-panel2 px-3 py-1.5 text-xs text-desk-amber hover:bg-desk-amber/10 disabled:opacity-40"
          >
            {t("Run")}
          </button>
        ) : busy ? (
          <button
            type="button"
            onClick={() => void abort()}
            className="shrink-0 rounded border border-desk-ember/60 px-3 py-1.5 text-xs text-desk-ember hover:bg-desk-ember/10"
          >
            {t("Stop")}
          </button>
        ) : (
          <button
            type="submit"
            disabled={!connected || (!text.trim() && pending.length === 0)}
            className="shrink-0 rounded border border-desk-line bg-desk-panel2 px-3 py-1.5 text-xs text-desk-ink hover:border-desk-amber/70 disabled:opacity-40"
          >
            {t("Send")}
          </button>
        )}
      </form>
      )}
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
