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
  check("the card is a Stage page, like a shell command", item?.weight === undefined, item?.weight);
}

section("stage: the card is stable across re-derivation (no re-mount per tick)");
{
  const a = eventToStageItem(mcpEvent());
  const b = eventToStageItem(mcpEvent({ result: "changed" }));
  check("same call id → same card id", a?.id === b?.id, `${a?.id} vs ${b?.id}`);
}

section("stage: an MCP call takes the page, like a command");
{
  check(
    "an mcp event is a Stage page event",
    lastStageAction([mcpEvent()])?.type === "mcp",
    lastStageAction([mcpEvent()])?.type,
  );
  const command = createEvent(session, "command", {
    command: "npm test",
    stdout: "",
    stderr: "",
    exitCode: 0,
  } as never);
  const page = lastStageAction([command, mcpEvent()]);
  check("the newest call owns the page", page?.type === "mcp", page?.type);
  check("a tool start for an mcp tool is recognised", isMcpEvent(toolStartEvent()));
  check("a tool start for bash is not", !isMcpEvent(toolStartEvent({ toolName: "bash" })));
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
