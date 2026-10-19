/**
 * Offline check of outside file-change attribution (no server, no agent).
 *
 *   npx tsx scripts/checks/check-outside-attr.ts
 *
 * The filesystem watcher also watches the project's parent directory, so the
 * agent cannot quietly edit a file outside its own project without Absence
 * seeing it. But a parent directory holds sibling projects, and those have
 * agents of their own: with two pi processes side by side, every edit one
 * makes lands in the other session's watcher too. Reported unattributed, the
 * first session's Activity fills with the second agent's work — exactly the
 * lie this check pins the fix to.
 *
 * Attribution is a whitelist, twice over. Only tools whose *semantics* are
 * writing a file may attribute (a `bash` that merely cats a path must not),
 * and within a tool's arguments only path-shaped fields count (a file whose
 * *content* mentions other paths must not attribute those).
 */
import { OutsideAttribution } from "../../apps/server/src/sessions/OutsideAttribution";
import { pathsInJson, WRITE_TOOL } from "../../apps/server/src/sessions/sessionStore";
import { check, finish, section } from "./harness";

const WINDOW = 120_000;

section("attribution: only a path the agent wrote reads as the agent's");
{
  const attribution = new OutsideAttribution(WINDOW);
  const agentFile = "E:/0down/projB/notes.txt";
  const otherFile = "E:/0down/projB/src/other.ts";

  attribution.note(agentFile, 1_000);
  check("a path the agent wrote is owned right after", attribution.owns(agentFile, 2_000));
  check("still owned near the window's end", attribution.owns(agentFile, 1_000 + WINDOW));
  check("expired past the window", !attribution.owns(agentFile, 1_000 + WINDOW + 1));
  check("a path the agent never wrote is not owned", !attribution.owns(otherFile, 2_000));
}

section("attribution: the sibling agent's edits are not this agent's");
{
  // The exact report: two pi processes, sibling project directories. Session A
  // watched the agent write only projA; pi-B writes projB — none of it may
  // read as session A's agent's doing, however close in time.
  const attribution = new OutsideAttribution(WINDOW);
  attribution.note("E:/0down/projA/src/a.ts", 1_000);
  check(
    "the other agent's edit in a sibling project is not owned",
    !attribution.owns("E:/0down/projB/src/b.ts", 1_500),
  );
}

section("attribution: an echo claimed is an echo spent");
{
  // Agent A wrote the outside file, the watcher echoed it, the session
  // reported it. Every change on that path from now on is *someone else's* —
  // most plausibly the sibling agent that writes the same shared file — and
  // must not ride the rest of the window as this agent's doing. A short tail
  // remains only so the write's own trailing watcher events still count.
  const attribution = new OutsideAttribution(WINDOW);
  attribution.note("E:/0down/shared/config.json", 1_000);
  check("owned before the echo", attribution.owns("E:/0down/shared/config.json", 2_000));
  attribution.demote("E:/0down/shared/config.json", 2_000);
  check("still owned within the tail (duplicate watcher events)", attribution.owns("E:/0down/shared/config.json", 3_000));
  check("not owned after the tail", !attribution.owns("E:/0down/shared/config.json", 2_000 + 6_000));
  check(
    "the sibling's later edit of the same file is not owned",
    !attribution.owns("E:/0down/shared/config.json", 60_000),
  );
}

section("attribution: windows path casing and separators are one file");
{
  const attribution = new OutsideAttribution(WINDOW);
  attribution.note("E:\\0down\\projB\\notes.txt", 1_000);
  check("same file, other casing", attribution.owns("e:/0down/PROJB/NOTES.TXT", 2_000));
  check("same file, other separator", attribution.owns("E:\\0down/projB/notes.txt", 2_000));
}

section("paths in a transcript call's arguments: only path-shaped fields");
{
  const write = pathsInJson(JSON.stringify({ path: "E:\\0down\\projB\\x.txt", content: "hi" }));
  check("a write tool's path is found", write.includes("E:\\0down\\projB\\x.txt"), JSON.stringify(write));

  const edit = pathsInJson(JSON.stringify({ path: "/home/u/proj/y.ts", edits: [{ oldText: "a", newText: "b" }] }));
  check("a nested edit path is found", edit.includes("/home/u/proj/y.ts"), JSON.stringify(edit));

  // The hole the whitelist closed: a file written whose *content* mentions
  // other absolute paths (a config, a script) attributed every path it named.
  const config = pathsInJson(
    JSON.stringify({ path: "E:\\0down\\projA\\config.json", content: '{"db": "E:/0down/projB/data.db"}' }),
  );
  check("the written file's own path is found", config.includes("E:\\0down\\projA\\config.json"), JSON.stringify(config));
  check("a path inside the written content is not attributed", !config.some((p) => p.includes("projB")), JSON.stringify(config));

  // Codex's patch body carries the target after `*** Update File:`; the patch
  // field is where the paths live, so it counts.
  const patch = pathsInJson(
    JSON.stringify({ patch: "*** Update File: E:\\0down\\projB\\x.ts\n@@\n-a\n+b" }),
  );
  check("a patch body's target is found", patch.some((p) => p.endsWith("x.ts")), JSON.stringify(patch));

  // A changes map keyed by absolute path (Codex `fileChange` shape).
  const changes = pathsInJson(JSON.stringify({ changes: { "E:\\0down\\projB\\z.ts": "+x" } }));
  check("a changes map's path key is found", changes.some((p) => p.endsWith("z.ts")), JSON.stringify(changes));

  check("no arguments, no paths", pathsInJson("{}").length === 0);
  check("unparseable arguments, no paths", pathsInJson("{broken").length === 0);

  const urls = pathsInJson(JSON.stringify({ url: "https://example.com/a", q: "not /a path" }));
  check("a URL is not a path", !urls.some((p) => p.includes("example.com")), JSON.stringify(urls));
}

section("only write-semantics tools attribute");
{
  // First-class file writers: the tools whose arguments name their targets.
  for (const tool of ["write", "edit", "apply_patch", "multiedit", "save", "remove", "create", "move", "rename"]) {
    check(`${tool} may attribute`, WRITE_TOOL.test(tool));
  }
  // Everything else must not — including the whole shell family. The report
  // that reopened this: a `bash cat E:/other/x.txt` (a *read*) attributed the
  // path, and the sibling agent's later write of that file read as this
  // agent's outside change.
  for (const tool of ["bash", "powershell", "shell", "command", "exec", "read", "grep", "find", "ls", "web_search"]) {
    check(`${tool} must not attribute`, !WRITE_TOOL.test(tool));
  }
  // MCP tools (mcp__server__tool) have unknown semantics: no attribution.
  check("an mcp tool must not attribute", !WRITE_TOOL.test("mcp__fs__write_file"));
}

finish();
