import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { isAgentBusy, type CommandOption } from "@absence/core";
import { buildPrompt } from "../../lib/context";
import { findCommand, mergeAgentCommands, type CommandSpec } from "../../lib/commands";
import { useChatStore } from "../../stores/chatStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { ChatContext } from "../../types/chat";

/* ══════════════════════════════════════════════════════════════════════════
   The chat input, as one implementation.

   A line starting with `/` is still a normal prompt: the agent owns what
   `/model`, `/skill`, `/mcp` or any advertised command means. The palette is
   only a completer — it suggests the commands the agent advertised and the one
   ACP action Absence performs (`/auth`). Everything else is forwarded verbatim.

   Every chat face uses it — Monitor's input row, Rounds' and Chart's bars — and
   the `/` palette has to behave the same in all of them: type `/`, the overlay
   opens above the input, arrows move, Enter sends.
   ══════════════════════════════════════════════════════════════════════════ */

export interface ChatInput {
  text: string;
  setText: (value: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** The line starts with `/`: it is a command-shaped prompt, not plain text. */
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
  busy: boolean;
  connected: boolean;
  pending: ChatContext[];
  handleChange: (value: string) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  chooseItem: (value: string) => void;
  /** The `/` button: opens the palette on an empty command. */
  toggleSlash: () => void;
  closePalette: () => void;
  /** Send the line: plain prompt, forwarded `/` line, or ACP auth. */
  submit: () => Promise<void>;
  /** True when there is something worth sending. */
  canSend: boolean;
}

export function useChatInput(): ChatInput {
  const pending = useChatStore((s) => s.pending);
  const clearContext = useChatStore((s) => s.clearContext);
  const status = useSessionStore((s) => s.agent.status);
  const connected = useSessionStore((s) => s.connected);
  const agentCommands = useSessionStore((s) => s.agentCommands);
  const authMethods = useSessionStore((s) => s.authMethods);
  const commands = useMemo(() => mergeAgentCommands(agentCommands), [agentCommands]);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const runCommand = useSessionStore((s) => s.runCommand);

  const [text, setText] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // --- command-mode derivation ---------------------------------------------
  const commandMode = text.startsWith("/");
  const body = commandMode ? text.slice(1) : "";
  const spaceAt = body.indexOf(" ");
  const cmdName = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
  const phase: "name" | "arg" = spaceAt === -1 ? "name" : "arg";
  const command = commandMode ? findCommand(cmdName, commands) : undefined;

  const nameMatches = useMemo(
    () => (commandMode && phase === "name" ? commands.filter((c) => c.name.startsWith(cmdName)) : []),
    [commandMode, phase, cmdName, commands],
  );

  // `/auth` is the one choice list Absence draws: the methods the agent
  // advertised during its ACP handshake.
  const authOptions: CommandOption[] = useMemo(
    () =>
      command?.name === "auth"
        ? (authMethods ?? []).map((method) => ({
            value: method.id,
            label: method.id,
            description: method.description ?? method.name,
          }))
        : [],
    [command?.name, authMethods],
  );

  const activeOptions: CommandOption[] = phase === "arg" && command?.kind === "choice" ? authOptions : [];

  const paletteItems: CommandOption[] =
    phase === "name"
      ? nameMatches.map((spec) => ({ value: spec.name, label: `/${spec.name}`, description: spec.description }))
      : activeOptions;

  const showPalette =
    paletteOpen &&
    commandMode &&
    (phase === "name"
      ? nameMatches.length > 0
      : command?.kind === "choice" || command?.kind === "text");

  // Keep the highlight inside the current list.
  useEffect(() => {
    const length = paletteItems.length;
    setHighlight((h) => (length === 0 ? 0 : Math.min(h, length - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteItems.length]);

  const closePalette = () => {
    setText("");
    setPaletteOpen(false);
    setHighlight(0);
  };

  /** Send the line exactly as typed. The agent decides what it means. */
  const forward = async (line: string) => {
    const value = line.trim();
    if (!value) return;
    setText("");
    setPaletteOpen(false);
    await sendPrompt(value);
  };

  const authenticate = async (methodId: string) => {
    closePalette();
    await runCommand("auth", methodId);
  };

  const openArgPhase = (spec: CommandSpec) => {
    setText(`/${spec.name} `);
    setPaletteOpen(true);
    setHighlight(0);
    inputRef.current?.focus();
  };

  const chooseItem = (value: string) => {
    if (phase === "name") {
      const spec = findCommand(value, commands);
      if (!spec) return;
      if (spec.kind === "none") void forward(`/${spec.name}`);
      else openArgPhase(spec);
      return;
    }
    if (command?.name === "auth") {
      void authenticate(value);
      return;
    }
    // A command-shaped line with a chosen argument is still just a prompt.
    void forward(`/${command?.name ?? ""} ${value}`);
  };

  const submit = async () => {
    if (!commandMode) {
      const value = text.trim();
      if (!value && pending.length === 0) return;
      const prompt = buildPrompt(pending, value || "(content above)");
      setText("");
      clearContext();
      await sendPrompt(prompt);
      return;
    }
    // `/auth` without an argument: list the agent's methods in the input's
    // submenu rather than forwarding a line the agent would not understand.
    if (phase === "name" && command?.name === "auth") return openArgPhase(command);
    if (phase === "arg" && command?.name === "auth") {
      const item = activeOptions[highlight];
      if (item) return void authenticate(item.value);
    }
    // Everything else — an advertised command, `/model`, `/skill:<name>`,
    // `/mcp`, an unknown `/foo` — is sent to the agent verbatim. Absence no
    // longer drops a line it does not recognise.
    await forward(text);
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
    busy: isAgentBusy(status),
    connected,
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
