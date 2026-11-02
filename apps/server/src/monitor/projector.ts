import {
  createEvent,
  type AbsenceEvent,
  type AbsenceEventPayloadMap,
  type AbsenceEventType,
  type MonitorBus,
  type MonitorEvent,
  type MonitorFidelity,
  type MonitorSource,
} from "@absence/core";
import { AcpToolMapper, type MappedEventRecord } from "../agents/acp/AcpToolMapper";
import {
  textOfContentBlock,
  textOfToolContent,
  type AcpToolFacts,
} from "../agents/acp/ToolRules";

/**
 * ACP `session/update` → `MonitorEvent`.
 *
 * This layer only projects; it never asks the agent for anything, never runs
 * the agent's commands and never fills a field the protocol did not send. Each
 * projected fact carries `source: "acp"` and a `fidelity`:
 *
 *   exact    — the protocol carried the value verbatim
 *   reported — the agent reported an outcome Absence did not verify
 *   inferred — Absence derived a display fallback from protocol fields
 *   unknown  — the protocol omitted it; the payload says so instead of guessing
 *
 * Tool calls follow the protocol's lifecycle: one `tool_start` when the call
 * first appears, one `tool_end` when it reaches `completed`/`failed`, and the
 * mapped result events exactly once. Duplicate terminal updates are ignored.
 */

/** The process-window port. `begin`/`end` are called at most once per call. */
export interface ProjectorCommandWindow {
  begin(command: string, cwd: string): number | undefined;
  end(windowId: number): void;
}

export interface AcpMonitorProjectorOptions {
  sessionId: string;
  cwd: string;
  /** Where projected events go. Without a bus they are only returned. */
  bus?: MonitorBus;
  mapper?: AcpToolMapper;
  /** Optional command window (the ProcessWatcher in production). */
  commandWindow?: ProjectorCommandWindow;
  /** Clock override for deterministic checks. */
  now?: () => number;
}

interface CallRecord {
  facts: AcpToolFacts;
  started: boolean;
  /** `exact` for a tool_call; `reported` when the start had to be inferred
   *  from a later update (ACP normally sends tool_call first). */
  startFidelity: MonitorFidelity;
  ended: boolean;
  windowOpened: boolean;
  windowId?: number;
  lastUpdateAt?: number;
}

export class AcpMonitorProjector {
  private readonly mapper: AcpToolMapper;
  private readonly calls = new Map<string, CallRecord>();

  constructor(private readonly options: AcpMonitorProjectorOptions) {
    this.mapper = options.mapper ?? new AcpToolMapper(options.cwd);
  }

  /** Project one agent notification. Anything other than session/update is ignored. */
  async project(method: string, params: any): Promise<MonitorEvent[]> {
    if (method !== "session/update") return [];
    const update = params?.update;
    if (!update || typeof update !== "object") return [];
    return this.projectUpdate(update);
  }

  /** Project one `session/update` body directly. */
  async projectUpdate(update: any): Promise<MonitorEvent[]> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOfContentBlock(update.content);
        if (text.length === 0) return [];
        return [
          this.wrap(
            "message",
            { role: "assistant", content: text, delta: text, streaming: true },
            "exact",
          ),
        ];
      }

      case "agent_thought_chunk": {
        const text = textOfContentBlock(update.content);
        if (text.length === 0) return [];
        return [this.wrap("thinking", { content: text, delta: text, streaming: true }, "exact")];
      }

      case "tool_call":
        return this.toolCall(update);

      case "tool_call_update":
        return this.toolCallUpdate(update);

      case "plan":
        return this.plan(update);

      case "current_mode_update":
        return this.currentMode(update);

      default:
        // usage_update / config_option_update / available_commands_update /
        // session_info_update are session state, not monitor facts.
        return [];
    }
  }

  /**
   * Close every window a cancelled or crashed turn left open. This emits no
   * `tool_end`: the protocol never said the call ended, so Absence does not
   * invent an ending. It only stops attributing later processes to it.
   */
  endTurn(): void {
    for (const record of this.calls.values()) this.closeWindow(record);
    this.calls.clear();
  }

  dispose(): void {
    this.endTurn();
  }

  // --------------------------------------------------------------------------

  private async toolCall(update: any): Promise<MonitorEvent[]> {
    const record = this.upsert(update);
    if (!record || record.ended) return [];
    const events: MonitorEvent[] = [];
    if (!record.started) {
      events.push(this.start(record));
      record.started = true;
    }
    if (isTerminal(update.status)) events.push(...(await this.finish(record, update)));
    return events;
  }

  private async toolCallUpdate(update: any): Promise<MonitorEvent[]> {
    const record = this.upsert(update);
    if (!record || record.ended) return [];
    const events: MonitorEvent[] = [];
    if (!record.started) {
      // ACP should send tool_call before updates. If an adapter skips it, the
      // update is the only evidence of the call — pair it with a start rather
      // than emit an orphan tool_end. The start is marked `reported`.
      events.push(this.start(record));
      record.started = true;
    }
    if (isTerminal(update.status)) {
      events.push(...(await this.finish(record, update)));
      return events;
    }

    const text = textOfToolContent(update.content) || textOfToolContent(update.rawOutput);
    const status = ctx(update.status);
    if (text.length === 0 && status === undefined) return events;

    const now = this.options.now?.() ?? Date.now();
    if (text.length > 0 && record.lastUpdateAt !== undefined && now - record.lastUpdateAt < TOOL_UPDATE_MS) {
      return events;
    }
    if (text.length > 0) record.lastUpdateAt = now;

    const resolved = this.mapper.resolve(record.facts);
    events.push(
      this.wrap(
        "tool_update",
        {
          toolCallId: record.facts.toolCallId,
          toolName: record.facts.name,
          partial: text.length > 0 ? { kind: resolved.kind, text } : { status },
        },
        "reported",
      ),
    );
    return events;
  }

  private plan(update: any): MonitorEvent[] {
    const entries = Array.isArray(update.entries) ? update.entries : undefined;
    // Plan has no first-class AbsenceEvent. A `system` message carries the
    // agent's entries verbatim — no status or priority is inferred.
    const content = JSON.stringify(entries ?? update, null, 2);
    return [this.wrap("message", { role: "system", content }, entries ? "reported" : "unknown")];
  }

  private currentMode(update: any): MonitorEvent[] {
    const mode =
      typeof update.currentModeId === "string"
        ? update.currentModeId
        : typeof update.modeId === "string"
          ? update.modeId
          : undefined;
    // When the protocol omitted the mode id, the raw update is the only honest
    // payload; the event is marked `unknown` rather than given a made-up name.
    return [
      this.wrap(
        "message",
        { role: "system", content: mode ?? JSON.stringify(update, null, 2) },
        mode === undefined ? "unknown" : "exact",
      ),
    ];
  }

  private upsert(update: any): CallRecord | undefined {
    const toolCallId = ctx(update.toolCallId);
    if (toolCallId === undefined) return undefined;
    const existing = this.calls.get(toolCallId);
    if (existing) {
      if (existing.ended) return existing;
      existing.facts = factsOf(update, existing.facts);
      // A later update may be the first one to carry the command; open then.
      this.openWindow(existing);
      return existing;
    }
    const record: CallRecord = {
      facts: factsOf(update),
      started: false,
      startFidelity: update.sessionUpdate === "tool_call" ? "exact" : "reported",
      ended: false,
      windowOpened: false,
    };
    this.calls.set(toolCallId, record);
    this.openWindow(record);
    return record;
  }

  private start(record: CallRecord): MonitorEvent {
    return this.wrap(
      "tool_start",
      {
        toolCallId: record.facts.toolCallId,
        toolName: record.facts.name,
        // `unknown` when the protocol omitted rawInput: an empty object would
        // claim the agent passed no arguments.
        args: record.facts.rawInput,
      },
      record.startFidelity,
    );
  }

  private async finish(record: CallRecord, update: any): Promise<MonitorEvent[]> {
    if (record.ended) return [];
    record.ended = true;
    record.facts = factsOf(update, record.facts);
    this.closeWindow(record);

    const events: MonitorEvent[] = [
      this.wrap(
        "tool_end",
        {
          toolCallId: record.facts.toolCallId,
          toolName: record.facts.name,
          isError: String(update.status ?? "") === "failed",
        },
        "exact",
      ),
    ];

    const mapped = await this.mapper.mapCompletedDetailed(record.facts);
    for (const item of mapped) events.push(this.wrapMapped(item));
    return events;
  }

  /** Open one process window for an execute call, at most once. */
  private openWindow(record: CallRecord): void {
    if (!this.options.commandWindow || record.windowOpened) return;
    const resolved = this.mapper.resolve(record.facts);
    if (resolved.kind !== "execute" || !resolved.command) return;
    record.windowOpened = true;
    const windowId = this.options.commandWindow.begin(resolved.command, this.options.cwd);
    if (windowId !== undefined) record.windowId = windowId;
  }

  private closeWindow(record: CallRecord): void {
    if (record.windowId === undefined) return;
    const windowId = record.windowId;
    record.windowId = undefined;
    this.options.commandWindow?.end(windowId);
  }

  private wrapMapped(record: MappedEventRecord): MonitorEvent {
    return this.wrap(
      record.event.type as AbsenceEventType,
      record.event.payload as AbsenceEventPayloadMap[AbsenceEventType],
      record.fidelity,
      record.source,
    );
  }

  private wrap<K extends AbsenceEventType>(
    type: K,
    payload: AbsenceEventPayloadMap[K],
    fidelity: MonitorFidelity,
    source: MonitorSource = "acp",
  ): MonitorEvent {
    const created = createEvent(this.options.sessionId, type, payload);
    const event = (this.options.now
      ? { ...created, timestamp: this.options.now() }
      : created) as AbsenceEvent;
    const projected: MonitorEvent = {
      sessionId: this.options.sessionId,
      at: event.timestamp,
      source,
      fidelity,
      event,
    };
    this.options.bus?.publish(projected);
    return projected;
  }
}

const TOOL_UPDATE_MS = 150;

function isTerminal(status: unknown): boolean {
  return status === "completed" || status === "failed";
}

function ctx(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Merge a partial ACP update over what earlier updates reported for the call. */
function factsOf(update: any, previous?: AcpToolFacts): AcpToolFacts {
  return {
    toolCallId: ctx(update.toolCallId) ?? previous?.toolCallId ?? "",
    name: ctx(update.title) ?? previous?.name ?? ctx(update.kind) ?? "tool",
    kind: typeof update.kind === "string" ? update.kind : previous?.kind,
    rawInput: parseRawInput(update.rawInput ?? previous?.rawInput),
    status: ctx(update.status) ?? previous?.status,
    locations: Array.isArray(update.locations) ? update.locations : previous?.locations,
    content: update.content !== undefined ? update.content : previous?.content,
    rawOutput: update.rawOutput !== undefined ? update.rawOutput : previous?.rawOutput,
    // ACP's extension bag carries `terminal_exit` on agents that report the
    // exit code outside rawOutput.
    meta: update._meta !== undefined ? update._meta : previous?.meta,
    permissionDenied:
      update.permissionDenied === true || previous?.permissionDenied === true,
  };
}

/**
 * Some adapters send `rawInput` as a JSON string. Parse it generically so the
 * shape rules see the same fields for every agent.
 */
function parseRawInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{")) return value;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}
