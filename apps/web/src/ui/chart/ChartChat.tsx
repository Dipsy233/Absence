import { FaceChat } from "../shared/FaceChat";

/**
 * The report's input row: the shared `FaceChat` bar in Chart's chrome — one
 * rounded line pinned under the report page, the same send/stop/run contract
 * as every other face. A report is a record, but a question about it goes to
 * the same agent, so the bar is the page's one interactive element.
 */
export function ChartChat() {
  return (
    <FaceChat
      skin={{
        form: "chart-chat",
        box: "chart-chat__box",
        input: "chart-chat__input",
        send: "chart-chat__send",
        stop: "chart-chat__stop",
        observed: "chart-chat",
        observedChip: "mon-chip mon-chip--read",
        observedNote: "chart-chat__note",
        placeholder: "Ask about this moment, or / for commands",
        ariaLabel: "Ask the agent…",
      }}
    />
  );
}
