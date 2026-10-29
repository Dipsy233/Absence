import type { ReactNode } from "react";
import type { CommandOption } from "@absence/core";
import type { CommandSpec } from "../../lib/commands";
import { useT } from "../../lib/i18n";
import type { ChatInput } from "./useChatInput";

/* ══════════════════════════════════════════════════════════════════════════
   The `/` overlay, as one implementation.

   It sits above the input row and opens the moment a line starts with `/`:
   command names first, then the command's arguments (a static list, or the
   session's models / thinking levels fetched from the server), or the skill
   list for `/skill:`.

   Classic and Monitor both draw exactly this, so it is one component rather
   than two copies. It is written against the desk tokens, which `.mon-root`
   re-points at Monitor's palette — so the same markup lands in either face's
   colours without a variant flag.
   ══════════════════════════════════════════════════════════════════════════ */

export function ChatCommandPalette({ input }: { input: ChatInput }) {
  const t = useT();
  const { command, phase, paletteItems, highlight, setHighlight, chooseItem, loadingOptions } = input;

  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-56 overflow-auto rounded-lg border border-desk-line/70 bg-desk-panel/95 p-1 shadow-[0_18px_50px_rgba(0,0,0,.45)] backdrop-blur-[3px]">
      {phase === "name" || command?.kind === "choice" ? (
        paletteItems.length === 0 ? (
          <div className="px-2 py-1 text-xs text-desk-dim">{loadingOptions ? t("loading…") : t("no options")}</div>
        ) : (
          paletteItems.map((item: CommandOption, index: number) => (
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

/** The `/` button that opens the palette on an empty command. */
export function SlashButton({ input }: { input: ChatInput }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={input.toggleSlash}
      title={t("Commands — type / and pick one")}
      className={[
        "shrink-0 rounded border px-2 py-1 font-mono text-xs transition-colors",
        input.commandMode
          ? "border-desk-amber/70 bg-desk-panel2 text-desk-amber"
          : "border-desk-line text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber",
      ].join(" ")}
    >
      /
    </button>
  );
}

/** The command spec for the current line, for faces that want to show it. */
export type { CommandSpec };
