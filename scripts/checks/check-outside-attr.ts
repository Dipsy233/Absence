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
 */
import { OutsideAttribution } from "../../apps/server/src/sessions/OutsideAttribution";
import { pathsInJson, READ_ONLY_TOOL } from "../../apps/server/src/sessions/sessionStore";
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

section("attribution: windows path casing and separators are one file");
{
  const attribution = new OutsideAttribution(WINDOW);
  attribution.note("E:\\0down\\projB\\notes.txt", 1_000);
  check("same file, other casing", attribution.owns("e:/0down/PROJB/NOTES.TXT", 2_000));
  check("same file, other separator", attribution.owns("E:\\0down/projB/notes.txt", 2_000));
}

section("paths in a transcript call's arguments");
{
  const write = pathsInJson(JSON.stringify({ path: "E:\\0down\\projB\\x.txt", content: "hi" }));
  check("a write tool's path is found", write.includes("E:\\0down\\projB\\x.txt"), JSON.stringify(write));

  const edit = pathsInJson(JSON.stringify({ edits: [{ path: "/home/u/proj/y.ts", edits: [] }] }));
  check("a nested edit path is found", edit.includes("/home/u/proj/y.ts"), JSON.stringify(edit));

  check("no arguments, no paths", pathsInJson("{}").length === 0);
  check("unparseable arguments, no paths", pathsInJson("{broken").length === 0);

  const urls = pathsInJson(JSON.stringify({ url: "https://example.com/a", q: "not /a path" }));
  check("a URL is not a path", !urls.some((p) => p.includes("example.com")), JSON.stringify(urls));
}

section("read-only tools never attribute");
{
  for (const tool of ["read", "grep", "find", "ls", "observe", "inspect", "search", "list"]) {
    check(`${tool} is read-only`, READ_ONLY_TOOL.test(tool));
  }
  for (const tool of ["write", "edit", "apply_patch", "remove", "save"]) {
    check(`${tool} is not read-only`, !READ_ONLY_TOOL.test(tool));
  }
}

finish();
