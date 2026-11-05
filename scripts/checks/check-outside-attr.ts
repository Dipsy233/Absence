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
  check(
    "still owned within the short tail (duplicate watcher events)",
    attribution.owns("E:/0down/shared/config.json", 2_500),
  );
  check("not owned after the tail", !attribution.owns("E:/0down/shared/config.json", 4_000));
  check(
    "the sibling's later edit of the same file is not owned",
    !attribution.owns("E:/0down/shared/config.json", 60_000),
  );
}

section("attribution: the content on disk must match what the agent reported");
{
  // Time + path was not enough: a sibling saving the same shared file inside
  // the window was reported as this agent's. The tool write now carries its
  // content, so the watcher's content is the second half of the proof.
  const attribution = new OutsideAttribution(WINDOW);
  const shared = "E:/0down/shared/config.json";
  attribution.note(shared, 1_000, '{"a":1}');
  check("the agent's own content is owned", attribution.owns(shared, 2_000, '{"a":1}'));
  check("a sibling's different content is not", !attribution.owns(shared, 2_000, '{"a":2}'));
  check("content cannot be verified → not owned", !attribution.owns(shared, 2_000, undefined));
  check("the time window still expires", !attribution.owns(shared, 1_000 + WINDOW + 1, '{"a":1}'));
}

section("attribution: a command-named path has only a short window");
{
  // A shell write names the path but declares no content. Its claim is short
  // and explicit; it must not become a 120 s permission on the same path.
  const attribution = new OutsideAttribution(WINDOW);
  const named = "E:/0down/out/report.txt";
  attribution.note(named, 1_000, undefined, 5_000);
  check("owned inside the command window", attribution.owns(named, 3_000));
  check("expired after the short window", !attribution.owns(named, 1_000 + 5_000 + 1));
  check("has() agrees while the claim is live", attribution.has(named, 3_000));
  check("has() is false after expiry", !attribution.has(named, 1_000 + 5_000 + 1));
}

section("attribution: windows path casing and separators are one file");
{
  const attribution = new OutsideAttribution(WINDOW);
  attribution.note("E:\\0down\\projB\\notes.txt", 1_000);
  check("same file, other casing", attribution.owns("e:/0down/PROJB/NOTES.TXT", 2_000));
  check("same file, other separator", attribution.owns("E:\\0down/projB/notes.txt", 2_000));
}

finish();
