import type { ApprovalOption, PermissionAnswer } from "@absence/core";

/**
 * `session/request_permission` ↔ UI.
 *
 * The bridge does one job: hold each agent request open until the user picks
 * one of the options the *agent* offered, then send that answer back through
 * the same JSON-RPC id. It never decides for the user, never accepts by
 * default and never validates the option id against a private vocabulary —
 * the UI's `PermissionAnswer` is forwarded verbatim.
 */
export interface PermissionPrompt {
  requestId: string;
  title: string;
  detail: string;
  itemId?: string;
  options: ApprovalOption[];
}

export interface AcpPermissionBridgeOptions {
  /** Surface the card. Called after the resolver is registered. */
  onPrompt(prompt: PermissionPrompt): void;
}

interface PendingPermission {
  resolve(result: unknown): void;
  toolCallId?: string;
  /**
   * Standard ACP `kind`s that mean "do not run it". Used only to annotate the
   * finished tool call (`permissionDenied`), never to change the outcome.
   */
  rejectOptionIds: Set<string>;
}

export class AcpPermissionBridge {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly denied = new Set<string>();
  private sequence = 0;

  constructor(private readonly options: AcpPermissionBridgeOptions) {}

  /**
   * Route one agent request. The returned promise is the JSON-RPC result; it
   * resolves only when `respond` is called (or the turn is cancelled).
   */
  request(params: any): Promise<unknown> {
    const requestId = this.newRequestId();
    const toolCall = params?.toolCall ?? {};
    const rawOptions: Array<{ optionId?: string; name?: string; kind?: string }> =
      Array.isArray(params?.options) ? params.options : [];
    const callId =
      toolCall.toolCallId !== undefined ? String(toolCall.toolCallId) : undefined;

    const rejectOptionIds = new Set(
      rawOptions
        .filter(
          (option) => option.kind === "reject_once" || option.kind === "reject_always",
        )
        .map((option) => option.optionId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );

    return new Promise<unknown>((resolve) => {
      // Register before surfacing the card: a subscriber may answer synchronously,
      // and an answer with no pending entry would leave the agent blocked.
      this.pending.set(requestId, {
        resolve,
        ...(callId !== undefined ? { toolCallId: callId } : {}),
        rejectOptionIds,
      });
      this.options.onPrompt({
        requestId,
        title: String(toolCall.title ?? toolCall.toolCallId ?? "Run a tool"),
        detail: formatToolCallDetail(toolCall),
        ...(callId !== undefined ? { itemId: callId } : {}),
        // Only what the agent offered: Absence never invents an option.
        options: permissionOptions(rawOptions),
      });
    });
  }

  /**
   * Forward one answer. Returns false when the request is no longer pending
   * (it was already answered or cancelled).
   */
  respond(requestId: string, answer: PermissionAnswer): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);

    if (answer.outcome === "selected") {
      if (
        pending.toolCallId !== undefined &&
        pending.rejectOptionIds.has(answer.optionId)
      ) {
        // The agent will report the call as failed; remembering which answer
        // produced that lets the projector say "never ran" instead of guessing.
        this.denied.add(pending.toolCallId);
      }
      pending.resolve({ outcome: { outcome: "selected", optionId: answer.optionId } });
    } else {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    return true;
  }

  /**
   * Answer every pending request `cancelled`. This is a protocol requirement of
   * a cancelled turn, not a decision: the caller must do this *before* sending
   * `session/cancel`, so the agent is never left waiting for an answer.
   */
  async cancelAll(): Promise<void> {
    if (this.pending.size === 0) return;
    const cancellation = { outcome: { outcome: "cancelled" } };
    for (const pending of this.pending.values()) pending.resolve(cancellation);
    this.pending.clear();
    // Resolving the handler promises answers the agent's requests on the next
    // microtask. Yield a macrotask so those JSON-RPC frames are written before
    // the caller's `session/cancel` notification.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** Whether the selected answer means "do not run it" (for one tool call). */
  consumeDenied(toolCallId: unknown): boolean {
    if (typeof toolCallId !== "string" || toolCallId.length === 0) return false;
    if (!this.denied.has(toolCallId)) return false;
    this.denied.delete(toolCallId);
    return true;
  }

  resetDenials(): void {
    this.denied.clear();
  }

  private newRequestId(): string {
    this.sequence += 1;
    return `appr_${Date.now().toString(36)}_${this.sequence.toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }
}

/** The choices a permission card offers, from ACP's own options. */
function permissionOptions(
  options: Array<{ optionId?: string; name?: string; kind?: string }>,
): ApprovalOption[] {
  return options
    .filter((option) => typeof option.optionId === "string" && option.optionId.length > 0)
    .map((option) => ({
      value: option.optionId as string,
      label: option.name || (option.optionId as string),
      tone: toneForAcpKind(option.kind),
    }));
}

function toneForAcpKind(kind: string | undefined): ApprovalOption["tone"] {
  switch (kind) {
    case "allow_once":
      return "accept";
    case "allow_always":
      return "accept-session";
    case "reject_once":
      return "decline";
    case "reject_always":
      return "cancel";
    default:
      return "accept";
  }
}

function formatToolCallDetail(toolCall: any): string {
  const lines: string[] = [];
  if (toolCall.title) lines.push(String(toolCall.title));
  if (toolCall.rawInput !== undefined) {
    lines.push(
      typeof toolCall.rawInput === "string"
        ? toolCall.rawInput
        : JSON.stringify(toolCall.rawInput, null, 2),
    );
  }
  for (const location of (toolCall.locations ?? []) as Array<{ path?: string }>) {
    if (location.path) lines.push(location.path);
  }
  return lines.length > 0 ? lines.join("\n") : "(no detail)";
}
