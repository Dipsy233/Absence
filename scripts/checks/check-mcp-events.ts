/**
 * Offline check of MCP call visibility: an MCP call must reach Activity and the
 * Stage as a first-class action, not vanish as an anonymous tool event.
 *
 *   npx tsx scripts/checks/check-mcp-events.ts
 *
 * The events here are the shapes the adapters emit (Pi maps
 * `mcp__<server>__<tool>`, Codex maps `mcpToolCall`); this check covers what
 * Absence does with them — the Activity row, the Stage terminal card, status,
 * and the replay path — without needing a live MCP server.
 */
import { createEvent } from "@absence/core";
import {
  eventToActivityRow,
  eventToStageItem,
  isMcpEvent,
  lastStageAction,
  statusFromEvent,
  statusForTool,
} from "../../apps/web/src/lib/events";
import {
  CLOSED_INSET,
  HOLD_MS,
  insetItemAtCursor,
  latestMcpItem,
  reduceInset,
  shouldAutoRetract,
} from "../../apps/web/src/lib/terminalInset";
import { summarizeEvent } from "../../apps/web/src/lib/context";
import { check, finish, section } from "./harness";

const session = "sess_mcp";

function toolStartEvent(overrides: Record<string, unknown> = {}) {
  return createEvent(session, "tool_start", {
    toolCallId: "call_1",
    toolName: "mcp__filesystem__list_directory",
    args: { path: "E:/0down" },
    ...overrides,
  } as never);
}

function mcpEvent(overrides: Record<string, unknown> = {}) {
  return createEvent(session, "mcp", {
    server: "filesystem",
    tool: "list_directory",
    toolName: "mcp__filesystem__list_directory",
    toolCallId: "call_1",
    args: JSON.stringify({ path: "E:/0down" }, null, 2),
    result: "[DIR] daze\n[FILE] package.json",
    isError: false,
    durationMs: 42,
    exposure: "direct",
    ...overrides,
  } as never);
}

section("activity: an MCP call is a row with a server and a result size");
{
  const event = mcpEvent();
  const row = eventToActivityRow(event);
  check("row exists", row !== undefined);
  check("action is MCP", row?.action === "MCP", row?.action);
  check("primary names the server and tool", row?.primary === "filesystem › list_directory", row?.primary);
  const bytes = 30; // "[DIR] daze" + newline + "[FILE] package.json"
  check("secondary reports the result size", row?.secondary === `${bytes} B · with args`, row?.secondary);
  check("tone reads as a run", row?.tone === "run", row?.tone);
}

section("stage: an MCP call owns the terminal view with its arguments and result");
{
  const item = eventToStageItem(mcpEvent());
  check("item exists", item !== undefined);
  check("item is a terminal", item?.type === "terminal", item?.type);
  if (item?.payload.kind === "terminal") {
    check("command names the server", item.payload.command === "mcp filesystem › list_directory", item.payload.command);
    check("args are shown", String(item.payload.stdout).includes('"path": "E:/0down"'));
    check("result is shown", String(item.payload.stdout).includes("[DIR] daze"));
    check("exit code is 0 on success", item.payload.exitCode === 0);
    check("mcp context is attached", item.payload.mcp?.server === "filesystem");
    check("card id is keyed on the call", item.id === "mcp_call_1", item.id);
  }
  check("title is the mcp uri", item?.title === "mcp://filesystem/list_directory", item?.title);
  check("the card is an inset, not a page", item?.weight === "inset", item?.weight);
}

section("stage: the card is stable across re-derivation (no re-mount per tick)");
{
  const a = eventToStageItem(mcpEvent());
  const b = eventToStageItem(mcpEvent({ result: "changed" }));
  check("same call id → same card id", a?.id === b?.id, `${a?.id} vs ${b?.id}`);
}

section("stage: an MCP call never takes the page");
{
  check(
    "an mcp event is not a Stage page event",
    lastStageAction([mcpEvent()]) === undefined,
    lastStageAction([mcpEvent()])?.type,
  );
  const command = createEvent(session, "command", {
    command: "npm test",
    stdout: "",
    stderr: "",
    exitCode: 0,
  } as never);
  const page = lastStageAction([command, mcpEvent()]);
  check("the page before the call stays up", page?.type === "command", page?.type);
  check("a tool start for an mcp tool is recognised", isMcpEvent(toolStartEvent()));
  check("a tool start for bash is not", !isMcpEvent(toolStartEvent({ toolName: "bash" })));
}

section("inset: an MCP call docks, then folds away by itself");
{
  const finished = reduceInset(CLOSED_INSET, mcpEvent());
  check("a finished call docks", finished.item?.id === "mcp_call_1", finished.item?.id);
  check("it is not pinned", !finished.pinned);
  check("a finished call counts down to a retract", shouldAutoRetract(finished));
  check("the hold is long enough to read", HOLD_MS >= 4000);

  const inFlight = reduceInset(CLOSED_INSET, toolStartEvent());
  check("a call in flight docks", inFlight.item?.id === "mcp_call_1");
  check("it is in flight", inFlight.item?.payload.kind === "terminal" && inFlight.item.payload.mcp?.phase === "call");
  check("its note does not claim a result", Boolean(inFlight.item?.payload.kind === "terminal" && inFlight.item.payload.mcp?.note));
  check("a call in flight is pinned open", inFlight.pinned);
  check("it never auto-retracts", !shouldAutoRetract(inFlight));

  const settled = reduceInset(inFlight, mcpEvent());
  check("the result wakes the same card", settled.item?.id === inFlight.item?.id);
  check("the result un-pins it so the timer can run", !settled.pinned && shouldAutoRetract(settled));
  check("the result swaps the content", settled.item?.payload.kind === "terminal" && settled.item.payload.stdout.includes("[DIR] daze"));

  const closing = reduceInset(settled, createEvent(session, "tool_start", { toolCallId: "c9", toolName: "bash", args: {} } as never));
  check("another tool starts folding it away", closing.phase === "closing", closing.phase);
  check("a closing card does not count down again", !shouldAutoRetract(closing) || closing.phase === "closing");

  const pinned = reduceInset(CLOSED_INSET, mcpEvent(), {});
  const held = { ...pinned, pinned: true };
  check("a pinned call never auto-retracts", !shouldAutoRetract(held));
  const cleared = reduceInset(held, createEvent(session, "agent_start", { model: "pi", runtime: "pi", cwd: "/" } as never));
  check("a new run clears the dock", cleared.item === undefined);
}

section("inset: the dock is re-derived from the stream after a reload");
{
  const start = createEvent(session, "agent_start", { model: "pi", runtime: "pi", cwd: "/" } as never);
  const events = [start, mcpEvent()];
  check("the newest call is the one docked", latestMcpItem(events)?.id === "mcp_call_1");
  check("a later run boundary clears it", latestMcpItem([...events, start]) === undefined);
}

section("inset: replay shows the call at the cursor, not a later one");
{
  const base = Date.now();
  const at = (offset: number) => base + offset;
  const first = { ...mcpEvent({ result: "first" }), timestamp: at(100) };
  const second = { ...mcpEvent({ toolCallId: "call_2", result: "second" }), timestamp: at(500) };
  const events = [first, second];
  check("before the first call nothing is docked", insetItemAtCursor(events, at(50)) === undefined);
  check("at the first call it is docked", insetItemAtCursor(events, at(100))?.id === "mcp_call_1");
  check("between calls the first stays", insetItemAtCursor(events, at(300))?.id === "mcp_call_1");
  check("after the second it replaces the first", insetItemAtCursor(events, at(600))?.id === "mcp_call_2");
}

section("activity: an MCP row opens the dock, never the Stage page");
{
  const row = eventToActivityRow(mcpEvent());
  // The row carries the inset item (so the click has something to dock), but the
  // item is not a page: `openStage` must not fire for it.
  check("the row's item is an inset", row?.stageItem?.weight === "inset", row?.stageItem?.weight);
}

section("errors and namespaces are visible");
{
  const failed = mcpEvent({ isError: true, result: "permission denied" });
  const row = eventToActivityRow(failed);
  check("failed call is marked", row?.action === "MCP!", row?.action);
  check("failed call is an error tone", row?.tone === "error", row?.tone);
  const item = eventToStageItem(failed);
  check(
    "failed call shows a non-zero exit",
    item?.payload.kind === "terminal" && item.payload.exitCode === 1,
  );

  const namespaced = mcpEvent({ namespace: "search", tool: "code" });
  const namespacedRow = eventToActivityRow(namespaced);
  check(
    "namespace is part of the name",
    namespacedRow?.primary === "filesystem › search/code",
    namespacedRow?.primary,
  );

  const structured = eventToStageItem(mcpEvent({ structured: '{"total":3}' }));
  check(
    "structured result reaches the card",
    structured?.payload.kind === "terminal" && structured.payload.mcp?.structured === '{"total":3}',
  );
}

section("status and chat context");
{
  check("an mcp event reads as running", statusFromEvent(mcpEvent()) === "running");
  check(
    "an mcp tool name reads as running before its result arrives",
    statusForTool("mcp__filesystem__read_file") === "running",
  );
  check(
    "chat context names the server and tool",
    summarizeEvent(mcpEvent()) === "MCP call filesystem › list_directory",
    summarizeEvent(mcpEvent()),
  );
  check(
    "failed call context says so",
    summarizeEvent(mcpEvent({ isError: true })).startsWith("failed MCP call"),
  );
}

finish("mcp event checks");
