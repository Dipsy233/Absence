/**
 * A tiny line-based diff used by the mock runtime to fabricate a plausible
 * unified diff. The real Pi runtime supplies its own diff (edit tool
 * details.diff), so this is only needed for demos.
 */

function lcs(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  return dp;
}

export interface DiffOp {
  kind: "context" | "add" | "remove";
  line: string;
}

export function diffLines(before: string, after: string): DiffOp[] {
  // Normalise line endings before comparing: a Windows write (Set-Content,
  // apply_patch) lands as CRLF while the remembered version may be LF, and
  // without this every line of the file would compare as changed.
  const a = normalizeEol(before).split("\n");
  const b = normalizeEol(after).split("\n");
  const dp = lcs(a, b);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "context", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "remove", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j]! });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: "remove", line: a[i++]! });
  while (j < b.length) ops.push({ kind: "add", line: b[j++]! });
  return ops;
}

/** Treat CRLF and LF as the same line break, and drop a lone trailing CR. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const CONTEXT = 3;

/**
 * A standard unified diff: real `@@ -a,b +c,d @@` hunks with GNU-style line
 * numbers and CONTEXT lines of context, so the Stage gutter can show line
 * numbers (matching the web-side generator in apps/web/src/lib/diff.ts).
 */
export function unifiedDiff(before: string, after: string, from = "a", to = "b"): string {
  const ops = diffLines(before, after);
  const lines: string[] = [`--- ${from}`, `+++ ${to}`];

  // Group runs of edits separated by more than 2*CONTEXT equal lines into hunks.
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.kind === "context") {
      index++;
      continue;
    }
    const start = Math.max(0, index - CONTEXT);
    let end = index;
    let run = 0;
    for (let k = index; k < ops.length; k++) {
      if (ops[k]!.kind === "context") {
        run++;
        if (run > CONTEXT * 2) break;
      } else {
        run = 0;
        end = k + 1;
      }
    }
    const hunkEnd = Math.min(ops.length, end + CONTEXT);

    let aStart = 1;
    let aLines = 0;
    let bStart = 1;
    let bLines = 0;
    for (let k = 0; k < start; k++) {
      if (ops[k]!.kind !== "add") aStart++;
      if (ops[k]!.kind !== "remove") bStart++;
    }
    for (let k = start; k < hunkEnd; k++) {
      if (ops[k]!.kind !== "add") aLines++;
      if (ops[k]!.kind !== "remove") bLines++;
    }
    lines.push(`@@ -${aStart},${aLines} +${bStart},${bLines} @@`);
    for (let k = start; k < hunkEnd; k++) {
      const op = ops[k]!;
      lines.push(op.kind === "add" ? `+${op.line}` : op.kind === "remove" ? `-${op.line}` : ` ${op.line}`);
    }
    index = hunkEnd;
  }
  return lines.join("\n");
}
