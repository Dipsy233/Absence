/** Line-based unified diff for comparing file versions in the browser. */

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

/** One edit op of the LCS walk. */
type Op = { kind: "same" | "del" | "add"; text: string };

/** Treat CRLF and LF as the same line break, so a Windows write does not
 *  make every line of the file compare as changed. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function diffOps(a0: string[], b0: string[]): Op[] {
  const a = a0.map((l) => l.replace(/\r$/, ""));
  const b = b0.map((l) => l.replace(/\r$/, ""));
  const dp = lcs(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: "del", text: a[i++]! });
  while (j < b.length) ops.push({ kind: "add", text: b[j++]! });
  return ops;
}

const CONTEXT = 3;

/**
 * A standard unified diff: real `@@ -a,b +c,d @@` hunks with the same line
 * numbering GNU diff produces, so the Stage gutter can show line numbers.
 */
export function unifiedDiff(before: string, after: string, from = "before", to = "after"): string {
  const ops = diffOps(normalizeEol(before).split("\n"), normalizeEol(after).split("\n"));
  const lines: string[] = [`--- ${from}`, `+++ ${to}`];

  // Group runs of edits separated by > 2*CONTEXT equal lines into hunks.
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.kind === "same") {
      index++;
      continue;
    }
    // Hunk start: up to CONTEXT equal lines before the first edit.
    const start = Math.max(0, index - CONTEXT);
    // Hunk end: the first edit after a gap of more than 2*CONTEXT equal lines.
    let end = index;
    let run = 0;
    for (let k = index; k < ops.length; k++) {
      if (ops[k]!.kind === "same") {
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
      const op = ops[k]!;
      if (op.kind !== "add") aStart++;
      if (op.kind !== "del") bStart++;
    }
    for (let k = start; k < hunkEnd; k++) {
      const op = ops[k]!;
      if (op.kind !== "add") aLines++;
      if (op.kind !== "del") bLines++;
    }
    lines.push(`@@ -${aStart},${aLines} +${bStart},${bLines} @@`);
    for (let k = start; k < hunkEnd; k++) {
      const op = ops[k]!;
      lines.push(op.kind === "same" ? ` ${op.text}` : op.kind === "del" ? `-${op.text}` : `+${op.text}`);
    }
    index = hunkEnd;
  }
  return lines.join("\n");
}
