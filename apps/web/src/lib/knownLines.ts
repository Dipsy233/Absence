export interface LineRange {
  start: number;
  end: number;
}

/** Collapse a set of line numbers into ascending contiguous ranges. */
export function contiguousRanges(lineNumbers: number[]): LineRange[] {
  const sorted = [...new Set(lineNumbers)].sort((a, b) => a - b);
  const ranges: LineRange[] = [];
  for (const line of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && line === last.end + 1) last.end = line;
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}

export function gapMarker(line: number): string {
  return `⋯ (line ${line} — not in the agent's context)`;
}

/**
 * Render accumulated read lines as text. Line numbers are preserved: unknown
 * lines between the lowest and highest known line become an explicit marker, so
 * the rendered text lines up with the real file.
 */
export function renderKnownLines(known: Record<number, string>): { text: string; ranges: LineRange[] } {
  const ranges = contiguousRanges(Object.keys(known).map(Number));
  if (ranges.length === 0) return { text: "", ranges };

  const first = ranges[0]!.start;
  const last = ranges[ranges.length - 1]!.end;
  const lines: string[] = [];
  for (let line = first; line <= last; line++) {
    lines.push(known[line] ?? gapMarker(line));
  }
  return { text: lines.join("\n"), ranges };
}

export function describeRanges(ranges: LineRange[]): string {
  return ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`)).join(", ");
}
