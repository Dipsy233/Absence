import { FaceChat } from "../shared/FaceChat";

/**
 * The input bar: the shared `FaceChat` bar in Rounds' chrome (`rounds-chat`) —
 * one rounded line under the story, the slash button inside the box, and a
 * stop button that is the row's only filled element while the agent runs.
 */
export function RoundsChat() {
  return (
    <FaceChat
      skin={{
        form: "rounds-chat",
        box: "rounds-inp",
        input: "rounds-inp__input",
        send: "rounds-send",
        stop: "rounds-stop",
        slashInsideBox: true,
        stopLead: "■ ",
        placeholder: "Say something to the agent…",
        ariaLabel: "Say something to the agent…",
      }}
    />
  );
}
