import { FaceChat } from "../shared/FaceChat";

/**
 * The input row: one line, always present.
 *
 * The shared `FaceChat` bar in Monitor's chrome (`mon-chat`). Monitor reads
 * traces in the centre column, so the conversation is a *tab* of the Stage
 * rather than a layer over it, and this bar therefore has no expand toggle.
 * Typing `/` still opens the palette above the line.
 */
export function MonitorChat() {
  return (
    <FaceChat
      skin={{
        form: "mon-chat",
        box: "mon-chat__box",
        input: "mon-chat__input",
        send: "mon-btn mon-btn--pri mon-chat__send",
        stop: "mon-btn mon-btn--danger mon-chat__send",
        placeholder: "Ask about this moment, or / for commands",
        ariaLabel: "Ask the agent…",
      }}
    />
  );
}
