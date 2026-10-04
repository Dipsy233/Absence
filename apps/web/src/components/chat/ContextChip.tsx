import type { ChatContext } from "../../types/chat";
import { contextLabel } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";

export function ContextChip({ context, index }: { context: ChatContext; index: number }) {
  const removeContext = useChatStore((s) => s.removeContext);

  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded border border-desk-line bg-desk-panel2 px-1.5 py-0.5 font-mono text-[10px] text-desk-dim">
      <span className="truncate" title={contextLabel(context)}>
        {contextLabel(context)}
      </span>
      <button
        type="button"
        onClick={() => removeContext(index)}
        className="shrink-0 text-desk-dim/70 hover:text-desk-ember"
        title="Remove context"
      >
        ×
      </button>
    </span>
  );
}
