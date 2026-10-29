import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { isAgentBusy, type CommandOption } from "@absence/core";
import * as api from "../../lib/api";
import { buildPrompt } from "../../lib/context";
import { COMMANDS, findCommand, isSkillInvocation, type CommandSpec } from "../../lib/commands";
import { useChatStore } from "../../stores/chatStore";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import type { ChatContext } from "../../types/chat";

/* ══════════════════════════════════════════════════════════════════════════
   The chat input, as one implementation.

   Two faces use it — Classic's dock and Monitor's input row — and the `/`
   command palette has to behave the same in both: type `/`, the overlay opens
   above the input, arrows move, Enter runs. Duplicating that derivation per
   face is how the two drift apart, so the state machine lives here and the
   faces only supply their own chrome.

   The overlay itself is `ChatCommandPalette` (its own file): it is markup, and
   both faces want exactly the same markup.
   ══════════════════════════════════════════════════════════════════════════ */

export interface ChatInput {
  text: string;
  setText: (value: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** The line starts with `/`: it is a command, not a prompt. */
  commandMode: boolean;
  command?: CommandSpec;
  /** Which half of the command is being typed. */
  phase: "name" | "arg";
  paletteOpen: boolean;
  /** Whether the overlay should be drawn at all. */
  showPalette: boolean;
  paletteItems: CommandOption[];
  highlight: number;
  setHighlight: (index: number) => void;
  loadingOptions: boolean;
  busy: boolean;
  connected: boolean;
  observed: boolean;
  pending: ChatContext[];
  handleChange: (value: string) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  chooseItem: (value: string) => void;
  /** The `/` button: opens the palette on an empty command. */
  toggleSlash: () => void;
  closePalette: () => void;
  /** Send the line: prompt, skill invocation, or command. */
  submit: () => Promise<void>;
  /** True when there is something worth sending. */
  canSend: boolean;
}

export function useChatInput(): ChatInput {
  const pending = useChatStore((s) => s.pending);
  const clearContext = useChatStore((s) => s.clearContext);
  const status = useSessionStore((s) => s.agent.status);
  const connected = useSessionStore((s) => s.connected);
  const sessionId = useSessionStore((s) => s.session?.id);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const runCommand = useSessionStore((s) => s.runCommand);
  const observed = useIsObserved();

  const [text, setText] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [options, setOptions] = useState<CommandOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
    () => (commandMode && phase === "name" ? COMMANDS.filter((c) => c.name.startsWith(cmdName)) : []),
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

  const submit = async () => {
    // `/skill:<name> [request]` is a skill invocation: it belongs in the prompt,
    // where the runtime expands it into the skill's instructions.
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

  const toggleSlash = () => {
    if (commandMode) {
      closePalette();
    } else {
      setText("/");
      setPaletteOpen(true);
      setHighlight(0);
      inputRef.current?.focus();
    }
  };

  return {
    text,
    setText,
    inputRef,
    commandMode,
    command,
    phase,
    paletteOpen,
    showPalette,
    paletteItems,
    highlight,
    setHighlight,
    loadingOptions,
    busy: isAgentBusy(status),
    connected,
    observed,
    pending,
    handleChange,
    handleKeyDown,
    chooseItem,
    toggleSlash,
    closePalette,
    submit,
    canSend: text.trim().length > 0 || pending.length > 0,
  };
}
