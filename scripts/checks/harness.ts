/**
 * Shared harness for the acceptance checks. Every check script used to
 * copy-paste the same counter + `check()` + summary trio; they import it here
 * now, so a failure reads the same everywhere and the summary prints once.
 */
let failures = 0;
let checks = 0;

export function check(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `  — ${detail}` : ""}`);
  }
}

/** Print the final summary and exit with a status CI can use. */
export function finish(name = "checks"): never {
  // A script that imports the wrong thing, or whose whole body is skipped by a
  // guard, reports 0/0 and would otherwise pass: green with nothing checked.
  // That is the one failure mode a check harness must not have.
  if (checks === 0) {
    console.error(`\n0 ${name} ran — a check that asserts nothing must not pass.`);
    process.exit(1);
  }
  console.log(`\n${checks - failures}/${checks} ${name} passed.`);
  process.exit(failures === 0 ? 0 : 1);
}

/** A header between sections, purely for readable output. */
export function section(title: string): void {
  console.log(`\n[${title}]`);
}

/**
 * Await a predicate with a deadline. Several integration checks (fsdiff,
 * history, execserver) each define their own; this is the shared one.
 */
export const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 4000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
};
