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

/** A display-ready partial version built from accumulated reads. */
export interface KnownState {
  content: string;
  lineOffset: number;
  startLine?: number;
  endLine?: number;
  caption: string;
}

/** Turn accumulated read lines into something the Stage can render directly. */
export function renderKnownState(known: Record<number, string>): KnownState {
  const ranges = contiguousRanges(Object.keys(known).map(Number));
  if (ranges.length === 0) {
    return { content: "", lineOffset: 0, caption: "Nothing read yet" };
  }

  const first = ranges[0]!.start;
  const last = ranges[ranges.length - 1]!.end;
  const contiguous = ranges.length === 1;
  return {
    content: renderKnownLines(known).text,
    lineOffset: first - 1,
    startLine: contiguous ? first : undefined,
    endLine: contiguous ? last : undefined,
    caption: contiguous
      ? `Agent has lines ${first}–${last} of this file`
      : `Agent has lines ${describeRanges(ranges)} — the gaps are not in its context`,
  };
}
