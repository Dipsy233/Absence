/**
 * Checks for undoing Codex's shell wrapper (CodexShell.ts).
 *   npx tsx scripts/checks/check-codexshell.ts
 *
 * Codex never runs the model's command directly — it wraps it in a shell
 * (`pwsh -NoProfile -Command "…"`, `bash -lc "…"`, `cmd /c …`) and prepends a
 * UTF-8 preamble to PowerShell scripts. The egg panel and the command event must
 * show the model's own command, not that wrapper. These pin both the argv path
 * (exact, used by the exec-server) and the text path (used for observer lines).
 */
import { unwrapArgv, unwrapCommandText, UTF8_OUTPUT_PREFIX } from "../../apps/server/src/process/CodexShell";

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

const P = UTF8_OUTPUT_PREFIX; // ends with a newline

// A. argv — the exact path. This is the user's case.
{
  check(
    "pwsh -Command <preamble>node ticker.mjs → the model's command",
    unwrapArgv(["pwsh.exe", "-Command", `${P}node ticker.mjs`]) === "node ticker.mjs",
    JSON.stringify(unwrapArgv(["pwsh.exe", "-Command", `${P}node ticker.mjs`])),
  );
  check(
    "multi-flag pwsh -NoProfile -Command is unwrapped too",
    unwrapArgv(["pwsh.exe", "-NoProfile", "-Command", `${P}echo hi`]) === "echo hi",
  );
  check(
    "powershell -NoLogo -NoProfile -Command is unwrapped",
    unwrapArgv(["powershell.exe", "-NoLogo", "-NoProfile", "-Command", `${P}Get-ChildItem`]) === "Get-ChildItem",
  );
  check("a full exe path is recognised", unwrapArgv(["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "node x"]) === "node x");
  check("cmd.exe /c is unwrapped", unwrapArgv(["cmd.exe", "/c", "node ticker.mjs"]) === "node ticker.mjs");
  check("cmd.exe /C is unwrapped", unwrapArgv(["cmd.exe", "/C", "dir"]) === "dir");
  check("bash -lc is unwrapped", unwrapArgv(["bash", "-lc", "echo hi"]) === "echo hi");
  check("bash -c is unwrapped", unwrapArgv(["bash", "-c", "pwd"]) === "pwd");
}

// B. argv — a non-shell command is left alone (joined).
{
  check("node -v is left as-is", unwrapArgv(["node", "-v"]) === "node -v");
  check("npm run dev is left as-is", unwrapArgv(["npm", "run", "dev"]) === "npm run dev");
  check("a bare script path is joined", unwrapArgv(["node", "ticker.mjs"]) === "node ticker.mjs");
  check("an empty argv yields empty", unwrapArgv([]) === "");
}

// C. a multi-line script keeps its body (only the preamble goes).
{
  const script = `${P}Get-ChildItem\nnode ticker.mjs`;
  const out = unwrapArgv(["pwsh.exe", "-Command", script]);
  check("a multi-line script keeps its own lines", out === "Get-ChildItem\nnode ticker.mjs", JSON.stringify(out));
}

// D. text — the observer's command line.
{
  check(
    "a pwsh command line is unwrapped",
    unwrapCommandText(`pwsh.exe -Command "${P}node ticker.mjs"`) === "node ticker.mjs",
  );
  check(
    "a multi-flag pwsh command line is unwrapped",
    unwrapCommandText(`pwsh.exe -NoProfile -Command "${P}ls E:\\x"`) === "ls E:\\x",
  );
  check(
    "a quoted exe path is unwrapped",
    unwrapCommandText('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "node ticker.mjs"') === "node ticker.mjs",
  );
  check("a bash -lc line is unwrapped", unwrapCommandText('bash -lc "echo hi"') === "echo hi");
  check("a cmd /c line is unwrapped", unwrapCommandText("cmd.exe /c node ticker.mjs") === "node ticker.mjs");
}

// E. text — near-misses stay untouched.
{
  check("a plain command is untouched", unwrapCommandText("node -v") === "node -v");
  check("a non-shell invocation is untouched", unwrapCommandText("docker run -it ubuntu") === "docker run -it ubuntu");
  check("a shell without -Command is untouched", unwrapCommandText("pwsh.exe") === "pwsh.exe");
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures === 0 ? 0 : 1);
