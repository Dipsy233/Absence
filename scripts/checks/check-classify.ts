/**
 * Pure checks for command-intent parsing and process classification (read.md §6).
 *   npx tsx scripts/check-classify.ts
 *
 * The point of these two modules is that *names are not the criterion*. A `cat`
 * that lives ten minutes is not a tool; a `python train.py` is not a tool just
 * because the interpreter is common. So the checks below pin the structural
 * signals — the command's own subjects, where the code came from, whether it
 * survived its command — and treat the name list as the prior it is.
 */
import { parseCommandIntent } from "../../apps/server/src/process/CommandIntent";
import { classifyProcess, type ClassifyInput } from "../../apps/server/src/process/classify";

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

const INTENT = parseCommandIntent("");
void INTENT;

// A. command intent: the agent's own command is the strongest signal.
{
  const daemon = parseCommandIntent("./daemon.sh > /tmp/daemon_run.log 2>&1 &");
  check("a backgrounded, redirected script is a subject", daemon.subjects.some((s) => s.name === "daemon.sh"));
  check("it is marked backgrounded", daemon.hasBackground);
  check("it is marked redirected", daemon.hasRedirection);
  check("the subject records both", daemon.subjects.find((s) => s.name === "daemon.sh")?.background === true);

  const train = parseCommandIntent("python train.py --epochs 10");
  check("an interpreter's script is the subject, not the interpreter", train.subjects.length === 1 && train.subjects[0]?.name === "train.py", JSON.stringify(train.subjects));

  const inline = parseCommandIntent(`python -c "print(1)"`);
  check("inline interpreter code is not a subject", inline.subjects.length === 0, JSON.stringify(inline.subjects));

  const ps1 = parseCommandIntent("powershell -NoProfile -File .\\run.ps1");
  check("powershell -File names the script", ps1.subjects.some((s) => s.name === "run.ps1"), JSON.stringify(ps1.subjects));

  const pipeline = parseCommandIntent("cat x | grep y");
  check("a pipeline names no subject program", pipeline.subjects.length === 0, JSON.stringify(pipeline.subjects));

  // A query tool with a redirect is still just a query tool: `ps -p 1 > /dev/null`
  // must not become a subject just because somewhere in the line `>` appeared.
  const psRedirect = parseCommandIntent('kill 1 2>&1; ps -p 1 > /dev/null 2>&1 && echo up; tail -n 5 x.log');
  check("ps/kill/tail with redirects name no subject", psRedirect.subjects.length === 0, JSON.stringify(psRedirect.subjects));

  const npm = parseCommandIntent("npm run dev -- --port 3000 &");
  check("npm is a subject when run directly", npm.subjects.some((s) => s.name === "npm"), JSON.stringify(npm.subjects));
  check("and is backgrounded", npm.hasBackground);

  const nullRedirect = parseCommandIntent("nohup ./svc > /dev/null 2>&1 &");
  check("redirect to null counts as detached", nullRedirect.hasRedirection);
}

// B. classification is structural, not a name list.
function input(over: Partial<ClassifyInput> & { name: string }): ClassifyInput {
  return {
    commandLine: over.name,
    cwd: "E:\\proj",
    intent: { subjects: [], hasBackground: false, hasRedirection: false },
    survivedCommand: false,
    ageMs: 0,
    children: 0,
    ppid: 100,
    ...over,
  };
}

{
  // Survival beats every name: a `cat` that outlived its command is not a tool.
  const cat = classifyProcess(input({ name: "cat.exe", survivedCommand: true }));
  check("a cat that outlived its command is primary", cat.kind === "primary", cat.reason);

  // A named subject is primary even if it looks like a tool.
  const named = classifyProcess(
    input({
      name: "node.exe",
      exePath: "C:\\Program Files\\nodejs\\node.exe",
      intent: { subjects: [{ name: "server.js", path: "server.js", background: false, redirected: false }], hasBackground: false, hasRedirection: false },
      commandLine: "node server.js",
    }),
  );
  check("a process named by the command is primary", named.kind === "primary", named.reason);

  // A childless short-lived helper from a tool directory is a tool.
  const grep = classifyProcess(
    input({
      name: "grep.exe",
      exePath: "C:\\Program Files\\Git\\usr\\bin\\grep.exe",
      ageMs: 40,
    }),
  );
  check("a short git-bash helper is a tool", grep.kind === "tool", grep.reason);

  // The same holds for the query tools an agent uses to check its own daemons.
  for (const name of ["ps.exe", "kill.exe", "tail.exe"]) {
    const v = classifyProcess(
      input({
        name,
        exePath: "C:\\Program Files\\Git\\usr\\bin\\" + name,
        intent: { subjects: [], hasBackground: true, hasRedirection: true },
        ageMs: 30,
      }),
    );
    check(name + " is a tool even in a backgrounded command", v.kind === "tool", v.reason);
  }

  // The same name, but it spawned children: a scheduler, not a tool.
  const grepWithKids = classifyProcess(
    input({ name: "grep.exe", exePath: "C:\\Program Files\\Git\\usr\\bin\\grep.exe", ageMs: 40, children: 2 }),
  );
  check("a process that spawns its own is primary", grepWithKids.kind === "primary", grepWithKids.reason);

  // Code that runs from the workspace is the project's own, whatever it is named.
  const workspace = classifyProcess(
    input({ name: "weird.bin", exePath: "E:\\proj\\tools\\weird.bin", ageMs: 50 }),
  );
  check("an executable inside the workspace is primary", workspace.kind === "primary", workspace.reason);

  // Background + redirect is daemon intent, for a process that is not a launcher.
  const bg = classifyProcess(
    input({
      name: "server",
      intent: { subjects: [], hasBackground: true, hasRedirection: true },
    }),
  );
  check("background + redirect is primary", bg.kind === "primary", bg.reason);

  // An unknown process is not hidden by default.
  const unknown = classifyProcess(input({ name: "mystery.exe", ageMs: 5000 }));
  check("an unclassified process stays primary", unknown.kind === "primary", unknown.reason);

  // Shape wins over an unknown name: a process that lived a few tens of
  // milliseconds, started nothing, and is not a subject is a helper wherever it
  // lives — this is what catches `fd.exe` in Pi's bin and `getprocaddr64.exe` in
  // Git's libexec without maintaining a directory list.
  const fd = classifyProcess(
    input({ name: "fd.exe", exePath: "C:\\Users\\x\\.pi\\agent\\bin\\fd.exe", ageMs: 13 }),
  );
  check("an ephemeral process from an unknown directory is a tool", fd.kind === "tool", fd.reason);

  // `find` is in the tool prior — the same list the search-event filter defers
  // to, so a process named find and a find search share one vocabulary.
  const findProc = classifyProcess(
    input({ name: "find.exe", exePath: "C:\\tools\\find.exe", ageMs: 60 }),
  );
  check("find in the tool prior is a tool", findProc.kind === "tool", findProc.reason);

  // But a named subject is never demoted to a helper, however brief it is.
  const namedBrief = classifyProcess(
    input({
      name: "run.exe",
      exePath: "C:\\tools\\run.exe",
      ageMs: 20,
      intent: { subjects: [{ name: "run.exe", path: "run.exe", background: false, redirected: false }], hasBackground: false, hasRedirection: false },
    }),
  );
  check("a named subject is not demoted for being brief", namedBrief.kind === "primary", namedBrief.reason);
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures === 0 ? 0 : 1);
