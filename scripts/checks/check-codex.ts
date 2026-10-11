/**
 * Checks for the Codex command parser (CodexCommands.ts).
 *   npx tsx scripts/checks/check-codex.ts
 *
 * Codex reads files by shelling out, so Absence has to recognise a read from
 * the command text before it can turn it into a `file_read`. The shapes pinned
 * here are the ones Codex actually emits on Windows and POSIX, plus the
 * near-misses that must stay plain commands.
 */
import { commandActionsFromItem, parseReadCommand } from "../../apps/server/src/agents/CodexCommands";
import {
  approvalOptions,
  chooseApprovalDecision,
  isDeclineDecision,
  PERMISSION_LEVELS,
} from "../../apps/server/src/agents/CodexAdapter";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`);
  }
}

// A. Codex's own declaration wins: `commandActions` off the item.
{
  const item = {
    command: 'powershell.exe -Command "Get-Content -Path \\"E:\\0down\\daze-demo\\notes.txt\\" -Raw"',
    commandActions: [
      {
        type: "read",
        command: 'Get-Content -Path "E:\\0down\\daze-demo\\notes.txt" -Raw',
        name: "notes.txt",
        path: "E:\\0down\\daze-demo\\notes.txt",
      },
    ],
  };
  const actions = commandActionsFromItem(item);
  check("a read action is read from commandActions", actions?.reads.length === 1, JSON.stringify(actions));
  check("with Codex's resolved path", actions?.reads[0]?.path === "E:\\0down\\daze-demo\\notes.txt", JSON.stringify(actions));
}

// A2. listFiles and search are recognised too.
{
  const actions = commandActionsFromItem({
    commandActions: [
      { type: "listFiles", command: "ls -la", path: "src" },
      { type: "search", command: "rg TODO src", query: "TODO", path: "src" },
      { type: "unknown", command: "git status" },
    ],
  });
  check("a listFiles action is recognised", actions?.lists.length === 1, JSON.stringify(actions));
  check("a search action keeps its query", actions?.searches[0]?.query === "TODO", JSON.stringify(actions));
  check("an unknown action is not captured", actions?.reads.length === 0 && actions?.lists.length === 1 && actions?.searches.length === 1, JSON.stringify(actions));
}

// A3. An app-server without the field returns undefined, so the fallback runs.
{
  check("a missing commandActions field yields undefined", commandActionsFromItem({ command: "cat x" }) === undefined);
  check("a null commandActions field yields undefined", commandActionsFromItem({ commandActions: null }) === undefined);
}

// B. The command from the report, as a fallback (no commandActions).
{
  const read = parseReadCommand('Get-Content -Path "E:\\0down\\daze-demo\\notes.txt" -Raw');
  check("Get-Content -Path … -Raw is a read", read !== undefined, JSON.stringify(read));
  check("with the path it names", read?.path === "E:\\0down\\daze-demo\\notes.txt", JSON.stringify(read));
  check("and is whole-file", read?.whole === true, JSON.stringify(read));
}

// B. The other shapes a Windows agent emits.
{
  const unquoted = parseReadCommand("Get-Content notes.txt");
  check("Get-Content with a bare path is a read", unquoted?.path === "notes.txt" && unquoted.whole, JSON.stringify(unquoted));

  const gc = parseReadCommand('gc "src/index.ts"');
  check("gc is an alias for Get-Content", gc?.path === "src/index.ts", JSON.stringify(gc));

  const typeCmd = parseReadCommand("type notes.txt");
  check("cmd's type is a read", typeCmd?.path === "notes.txt", JSON.stringify(typeCmd));

  const head = parseReadCommand("Get-Content app.log -TotalCount 40");
  check("Get-Content -TotalCount is a bounded read", head?.startLine === 1 && head?.endLine === 40 && !head.whole, JSON.stringify(head));

  const piped = parseReadCommand("Get-Content app.log | Select-Object -First 20");
  check("a read piped into -First stays a read", piped?.endLine === 20 && !piped.whole, JSON.stringify(piped));

  const skip = parseReadCommand("Get-Content app.log | Select-Object -Skip 10 -First 5");
  check("skip/first become a line range", skip?.startLine === 11 && skip?.endLine === 15, JSON.stringify(skip));
}

// C. POSIX shapes.
{
  const cat = parseReadCommand("cat src/main.ts");
  check("cat is a read", cat?.path === "src/main.ts" && cat.whole, JSON.stringify(cat));

  const headN = parseReadCommand("head -n 30 README.md");
  check("head -n is a bounded read", headN?.startLine === 1 && headN?.endLine === 30, JSON.stringify(headN));

  const abs = parseReadCommand("cat /etc/hosts");
  check("an absolute POSIX path is not mistaken for a switch", abs?.path === "/etc/hosts", JSON.stringify(abs));
}

// C2. Escaped quotes and spaces, as Codex carries them.
{
  const spaced = parseReadCommand('Get-Content -Path \\"E:\\my file.txt\\" -Raw');
  check("an escaped-quote path with a space is one path", spaced?.path === "E:\\my file.txt", JSON.stringify(spaced));
}

// D. Near-misses that must NOT be captured as reads.
{
  check("a pipeline that transforms is not a read", parseReadCommand("Get-Content x.log | Select-String error") === undefined);
  check("a search is not a read", parseReadCommand("Select-String -Path x.ts -Pattern foo") === undefined);
  check("a write is not a read", parseReadCommand('Set-Content -Path x.txt -Value "hi"') === undefined);
  check("a redirect makes it more than a read", parseReadCommand("Get-Content a.txt > b.txt") === undefined);
  check("a sequence is not a read", parseReadCommand("Get-Content a.txt; rm a.txt") === undefined);
  check("type with no path-looking argument is not a read", parseReadCommand("type foo") === undefined);
  check("an unrelated command is not a read", parseReadCommand("Get-ChildItem -Recurse") === undefined);
  check("an empty command is not a read", parseReadCommand("") === undefined);
}

// E. Approval decisions: Absence answers Codex's prompts itself.
{
  const offered = ["accept", "acceptForSession", "decline", "cancel"];
  check("default accept picks accept", chooseApprovalDecision("accept", offered) === "accept");
  check("accept-for-session prefers the session grant", chooseApprovalDecision("accept-for-session", offered) === "acceptForSession");
  check("decline picks decline when offered", chooseApprovalDecision("decline", offered) === "decline");
  check("decline falls back to cancel", chooseApprovalDecision("decline", ["accept", "cancel"]) === "cancel");
  check("a missing list still accepts", chooseApprovalDecision("accept", undefined) === "accept");
  check("a missing list honours accept-for-session", chooseApprovalDecision("accept-for-session", null) === "acceptForSession");
  check("object decisions (with data) are ignored", chooseApprovalDecision("accept", [{ acceptWithExecpolicyAmendment: {} }, "accept"]) === "accept");
  check("accept-for-session without a session option falls back to accept", chooseApprovalDecision("accept-for-session", ["accept", "decline"]) === "accept");
  check("isDeclineDecision is true only for decline", !isDeclineDecision("accept") && !isDeclineDecision("accept-for-session") && isDeclineDecision("decline"));
}

// F. Approval options shown on the Stage, derived from Codex's own list.
{
  const offered = approvalOptions(["accept", "acceptForSession", "decline", "cancel"]);
  check("every offered decision becomes an option", offered.length === 4, JSON.stringify(offered));
  check("accept maps to Allow once", offered[0]?.value === "accept" && offered[0]?.tone === "accept", JSON.stringify(offered[0]));
  check("acceptForSession maps to the session grant", offered[1]?.value === "acceptForSession" && offered[1]?.tone === "accept-session", JSON.stringify(offered[1]));
  check("decline and cancel are the negative tones", offered[2]?.tone === "decline" && offered[3]?.tone === "cancel", JSON.stringify(offered));

  const minimal = approvalOptions(["accept", "decline"]);
  check("a shorter list yields fewer options", minimal.length === 2, JSON.stringify(minimal));

  const objectsOnly = approvalOptions([{ acceptWithExecpolicyAmendment: {} }]);
  check("data-carrying decisions fall back to the basics", objectsOnly.length === 2 && objectsOnly[0]?.value === "accept", JSON.stringify(objectsOnly));

  const absent = approvalOptions(undefined);
  check("a missing list offers the usual options", absent.length >= 2 && absent.some((o) => o.value === "accept"), JSON.stringify(absent));

  check("the permission levels are Codex's own slugs", PERMISSION_LEVELS.length === 3 && PERMISSION_LEVELS[1] === "workspace-write", JSON.stringify(PERMISSION_LEVELS));
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures === 0 ? 0 : 1);
