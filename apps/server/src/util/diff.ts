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
  const a = before.split("\n");
  const b = after.split("\n");
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

export function unifiedDiff(before: string, after: string, from = "a", to = "b"): string {
  const ops = diffLines(before, after);
  const body = ops
    .map((op) => (op.kind === "add" ? `+${op.line}` : op.kind === "remove" ? `-${op.line}` : ` ${op.line}`))
    .join("\n");
  return `--- ${from}\n+++ ${to}\n@@\n${body}`;
}
