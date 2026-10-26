/* ══════════════════════════════════════════════════════════════════════════
   A small, dependency-free Markdown reader for the Chat panel (read02 §30).

   Agent replies arrive as Markdown — headings, lists, fenced code, tables,
   links — and rendering them as `whitespace-pre-wrap` text made every answer
   look like a dump of its own source. This module turns that text into a typed
   tree; `components/common/Markdown.tsx` renders the tree as React elements.

   Two decisions are deliberate:

     • **No HTML string, ever.** The tree is rendered element by element, so
       there is no `dangerouslySetInnerHTML` and no sanitiser to keep up to
       date. Anything this parser does not recognise stays literal text, which
       is the right default for content that comes from a model.
     • **Tolerant of half-written input.** The chat re-parses while the agent
       streams, so an unterminated fence, a lone `**` or a dangling `[` must
       degrade to plain text instead of eating the rest of the message. Every
       construct below falls back rather than throwing.

   The subset is CommonMark + GFM tables/strikethrough/task lists — what agents
   actually emit — not a full CommonMark implementation.
   ══════════════════════════════════════════════════════════════════════════ */

export type MarkdownAlign = "left" | "center" | "right" | null;

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: MarkdownInline[] }
  | { kind: "paragraph"; inlines: MarkdownInline[] }
  | { kind: "code"; language: string | null; code: string }
  | { kind: "list"; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { kind: "quote"; blocks: MarkdownBlock[] }
  | { kind: "table"; align: MarkdownAlign[]; header: MarkdownInline[][]; rows: MarkdownInline[][][] }
  | { kind: "rule" };

export interface MarkdownListItem {
  blocks: MarkdownBlock[];
  /** GFM task list: `true` / `false` when the item starts with `[x]` / `[ ]`. */
  checked?: boolean;
}

export type MarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "code"; code: string }
  | { kind: "strong"; children: MarkdownInline[] }
  | { kind: "em"; children: MarkdownInline[] }
  | { kind: "del"; children: MarkdownInline[] }
  | { kind: "link"; href: string; children: MarkdownInline[] }
  | { kind: "break" };

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RULE_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
const LIST_RE = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIM_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const INDENTED_RE = /^ {4}/;

/* ── entry point ──────────────────────────────────────────────────────────── */

/** Parse a message into blocks. Never throws; unknown syntax stays text. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return parseBlocks(lines);
}

/* ── block level ──────────────────────────────────────────────────────────── */

function parseBlocks(lines: string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code first: everything inside is literal, including blank lines
    // and anything that looks like a heading.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const info = fence[2]!.trim();
      const char = marker[0]!;
      const closing = new RegExp(`^ {0,3}${char === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !closing.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence; an unterminated one just ends here
      blocks.push({ kind: "code", language: languageOf(info), code: body.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      const text = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
      blocks.push({ kind: "heading", level, inlines: parseInline(text) });
      i++;
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const quoted = QUOTE_RE.exec(current);
        if (quoted) {
          body.push(quoted[1]!);
          i++;
          continue;
        }
        // A blank line continues the quote only when the next line is quoted
        // again; otherwise the quote has ended.
        const next = lines[i + 1];
        if (!current.trim() && next !== undefined && QUOTE_RE.test(next)) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(body) });
      continue;
    }

    if (LIST_RE.test(line)) {
      const list = parseList(lines, i);
      blocks.push(list.block);
      i = list.next;
      continue;
    }

    const table = readTable(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    // Four-space indent outside a list is a code block (CommonMark's old rule).
    if (INDENTED_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (INDENTED_RE.test(lines[i]!) || !lines[i]!.trim())) {
        body.push(lines[i]!.slice(4));
        i++;
      }
      while (body.length > 0 && !body[body.length - 1]!.trim()) body.pop();
      blocks.push({ kind: "code", language: null, code: body.join("\n") });
      continue;
    }

    // Paragraph: run until a blank line or the start of another block. A
    // `===` / `---` underline turns the run into a setext heading instead.
    const body: string[] = [];
    let setext: 1 | 2 | null = null;
    while (i < lines.length) {
      const current = lines[i]!;
      if (!current.trim()) break;
      if (body.length > 0) {
        const underline = SETEXT_RE.exec(current);
        if (underline) {
          setext = underline[1]!.startsWith("=") ? 1 : 2;
          i++;
          break;
        }
        if (startsBlock(lines, i)) break;
      }
      body.push(trimParagraphLine(current));
      i++;
    }
    const inlines = parseInline(body.join("\n"));
    blocks.push(setext ? { kind: "heading", level: setext, inlines } : { kind: "paragraph", inlines });
  }

  return blocks;
}

/** Does `lines[i]` open a block that ends the paragraph currently being read? */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    RULE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    INDENTED_RE.test(line) ||
    readTable(lines, i) !== null
  );
}

/** Drop the 0–3 leading spaces and collapse trailing whitespace to a hard break. */
function trimParagraphLine(line: string): string {
  return line.replace(/^ {0,3}/, "").replace(/[ \t]+$/, (spaces) => (spaces.length >= 2 ? "  " : ""));
}

function languageOf(info: string): string | null {
  const first = info.split(/[ \t]+/)[0] ?? "";
  // `js`, `{.js}` and `.js` are all the same hint.
  const cleaned = first.replace(/^\{/, "").replace(/\}$/, "").replace(/^\./, "").toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

/* ── lists ────────────────────────────────────────────────────────────────── */

interface ListMarker {
  indent: number;
  ordered: boolean;
  start: number;
  /** Column where the item's own text begins — continuation lines dedent by this. */
  width: number;
  text: string;
}

function matchListMarker(line: string): ListMarker | null {
  const match = LIST_RE.exec(line);
  if (!match) return null;
  const marker = match[2]!;
  const ordered = /\d/.test(marker);
  return {
    indent: match[1]!.length,
    ordered,
    start: ordered ? Number.parseInt(marker, 10) : 1,
    width: match[1]!.length + marker.length + match[3]!.length,
    text: match[4]!,
  };
}

function parseList(lines: string[], from: number): { block: MarkdownBlock; next: number } {
  const first = matchListMarker(lines[from]!)!;
  const items: MarkdownListItem[] = [];
  let i = from;

  while (i < lines.length) {
    const head = matchListMarker(lines[i]!);
    if (!head || head.indent !== first.indent || head.ordered !== first.ordered) break;

    const body: string[] = [head.text];
    i++;

    while (i < lines.length) {
      const line = lines[i]!;
      if (!line.trim()) {
        // Blank lines belong to the item only when indented content follows.
        const next = lines[i + 1];
        if (next !== undefined && next.trim() && leadingSpaces(next) > first.indent) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      const marker = matchListMarker(line);
      if (marker && marker.indent <= first.indent) break;
      if (leadingSpaces(line) > first.indent) {
        body.push(dedent(line, head.width));
        i++;
        continue;
      }
      // Lazy continuation: a plain line that wraps the item's own paragraph.
      if (marker) break;
      body.push(line.trim());
      i++;
    }

    items.push(readListItem(body));
  }

  return {
    block: { kind: "list", ordered: first.ordered, start: first.start, items },
    next: i,
  };
}

function readListItem(body: string[]): MarkdownListItem {
  const task = /^\[([ xX])\][ \t]+(.*)$/.exec(body[0] ?? "");
  if (task) {
    return {
      blocks: parseBlocks([task[2]!, ...body.slice(1)]),
      checked: task[1] !== " ",
    };
  }
  return { blocks: parseBlocks(body) };
}

function leadingSpaces(line: string): number {
  let count = 0;
  while (line[count] === " ") count++;
  return count;
}

function dedent(line: string, width: number): string {
  let removed = 0;
  while (removed < width && line[removed] === " ") removed++;
  return line.slice(removed);
}

/* ── tables ───────────────────────────────────────────────────────────────── */

function readTable(lines: string[], from: number): { block: MarkdownBlock; next: number } | null {
  const header = lines[from]!;
  const delimiter = lines[from + 1];
  if (!header.includes("|") || delimiter === undefined) return null;
  if (!delimiter.includes("-") || !TABLE_DELIM_RE.test(delimiter)) return null;

  const headerCells = splitRow(header);
  const delimiters = splitRow(delimiter);
  // A row without a pipe cannot be the header of a table.
  if (headerCells.length < 2 || delimiters.length === 0) return null;

  const align: MarkdownAlign[] = delimiters.map((cell) => {
    const left = cell.trim().startsWith(":");
    const right = cell.trim().endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const rows: MarkdownInline[][][] = [];
  let i = from + 2;
  while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
    rows.push(splitRow(lines[i]!).map((cell) => parseInline(cell.trim())));
    i++;
  }

  return {
    block: {
      kind: "table",
      align,
      header: headerCells.map((cell) => parseInline(cell.trim())),
      rows,
    },
    next: i,
  };
}

/** Split one table row on unescaped pipes, dropping the outer pipes. */
function splitRow(line: string): string[] {
  const text = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\\" && text[i + 1] === "|") {
      cell += "|";
      i++;
      continue;
    }
    if (char === "|") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

/* ── inline level ─────────────────────────────────────────────────────────── */

/** Parse inline markup. Exported for the checks; the renderer uses it via blocks. */
export function parseInline(source: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer.length > 0) {
      out.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };

  while (i < source.length) {
    const char = source[i]!;

    // Backslash escapes: the next punctuation character is literal.
    if (char === "\\" && i + 1 < source.length && /[\\`*_{}()[\]#+\-.!|~<>"]/.test(source[i + 1]!)) {
      buffer += source[i + 1]!;
      i += 2;
      continue;
    }

    if (char === "`") {
      const span = readCodeSpan(source, i);
      if (span) {
        flush();
        out.push({ kind: "code", code: span.code });
        i = span.end;
        continue;
      }
      buffer += char;
      i++;
      continue;
    }

    if (char === "*" || char === "_" || char === "~") {
      const emphasis = readEmphasis(source, i);
      if (emphasis) {
        flush();
        out.push(emphasis.node);
        i = emphasis.end;
        continue;
      }
      buffer += char;
      i++;
      continue;
    }

    if (char === "[" || (char === "!" && source[i + 1] === "[")) {
      const image = char === "!";
      const link = readLink(source, image ? i + 1 : i, image);
      if (link) {
        flush();
        out.push(link.node);
        i = link.end;
        continue;
      }
      buffer += char;
      i++;
      continue;
    }

    if (char === "<") {
      const auto = readAutolink(source, i);
      if (auto) {
        flush();
        out.push(auto.node);
        i = auto.end;
        continue;
      }
      buffer += char;
      i++;
      continue;
    }

    if (char === "\n") {
      // Two trailing spaces or a backslash are CommonMark's hard break.
      if (buffer.endsWith("  ")) {
        buffer = buffer.replace(/[ ]+$/, "");
        flush();
        out.push({ kind: "break" });
      } else if (buffer.endsWith("\\")) {
        buffer = buffer.slice(0, -1);
        flush();
        out.push({ kind: "break" });
      } else {
        buffer += " ";
      }
      i++;
      continue;
    }

    if ((char === "h" || char === "H") && /^https?:\/\//i.test(source.slice(i, i + 8))) {
      const url = readBareUrl(source, i);
      flush();
      out.push({ kind: "link", href: url.href, children: [{ kind: "text", text: url.text }] });
      i = url.end;
      continue;
    }

    buffer += char;
    i++;
  }

  flush();
  return out;
}

/** ``code`` spans: a run of N backticks closes on the next run of exactly N. */
function readCodeSpan(source: string, start: number): { code: string; end: number } | null {
  let run = 0;
  while (source[start + run] === "`") run++;
  const fence = "`".repeat(run);
  let i = start + run;
  while (i < source.length) {
    if (source.startsWith(fence, i) && source[i + run] !== "`") {
      let code = source.slice(start + run, i);
      // CommonMark strips one space on each side when both are present.
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim().length > 0) {
        code = code.slice(1, -1);
      }
      return { code: code.replace(/\n/g, " "), end: i + run };
    }
    i++;
  }
  return null;
}

interface InlineNode {
  node: MarkdownInline;
  end: number;
}

/**
 * `*em*`, `**strong**`, `***both***`, `~~del~~`.
 *
 * `_` is only emphasis at a word boundary, so `snake_case_names` in prose stays
 * literal — a very common false positive in agent output.
 */
function readEmphasis(source: string, start: number): InlineNode | null {
  const char = source[start]!;
  if (char === "~" && source[start + 1] !== "~") return null;

  let run = 0;
  while (source[start + run] === char) run++;
  if (char === "_" && /[\p{L}\p{N}]/u.test(source[start - 1] ?? "")) return null;

  const delimiter = char.repeat(run >= 3 ? 3 : run >= 2 ? 2 : 1);
  const from = start + delimiter.length;
  // An opener must be followed by non-space: `2 * 3 * 4` is arithmetic, not
  // emphasis, and prose full of `*` is common in agent output.
  if (from >= source.length || /\s/.test(source[from]!)) return null;
  const close = findEmphasisClose(source, from, delimiter);
  if (close === -1) return null;

  const inner = source.slice(from, close);
  if (inner.trim().length === 0) return null;

  const children = parseInline(inner);
  const node: MarkdownInline =
    delimiter.length === 3
      ? { kind: "strong", children: [{ kind: "em", children }] }
      : delimiter.length === 2
        ? char === "~"
          ? { kind: "del", children }
          : { kind: "strong", children }
        : { kind: "em", children };

  return { node, end: close + delimiter.length };
}

function findEmphasisClose(source: string, from: number, delimiter: string): number {
  const char = delimiter[0]!;
  let i = from;
  while (i < source.length) {
    const at = source.indexOf(delimiter, i);
    if (at === -1) return -1;
    const inner = source.slice(from, at);
    const before = source[at - 1];
    const after = source[at + delimiter.length];
    // The closer must follow non-space, must not run on into more of the same
    // character, and `_` must end on a word boundary.
    const usable =
      inner.trim().length > 0 &&
      before !== undefined &&
      !/\s/.test(before) &&
      after !== char &&
      (char !== "_" || !/[\p{L}\p{N}]/u.test(after ?? ""));
    if (usable) return at;
    i = at + delimiter.length;
  }
  return -1;
}

/** `[text](href)`, `[text](<href> "title")`, and images (rendered as links). */
function readLink(source: string, start: number, image: boolean): InlineNode | null {
  const close = matchBracket(source, start);
  if (close === -1 || source[close + 1] !== "(") return null;

  const text = source.slice(start + 1, close);
  const end = matchParen(source, close + 1);
  if (end === -1) return null;

  const target = source.slice(close + 2, end);
  const href = safeHref(stripTitle(target));
  if (href === null) return null;

  // An image has no inline children of its own; showing its alt text as a link
  // is honest about what is there without fetching anything from the network.
  const children = image && text.trim().length === 0 ? [{ kind: "text" as const, text: href }] : parseInline(text);
  return {
    node: { kind: "link", href, children },
    end: end + 1,
  };
}

function matchBracket(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "[") depth++;
    if (char === "]") {
      depth--;
      if (depth === 0) return i;
    }
    if (char === "\n" && i - start > 400) return -1;
  }
  return -1;
}

function matchParen(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Drop a `"title"` / `'title'` / `(title)` suffix from a link target. */
function stripTitle(target: string): string {
  const trimmed = target.trim();
  const angle = /^<([^>]*)>/.exec(trimmed);
  if (angle) return angle[1]!;
  const titled = /^(\S+)[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(trimmed);
  return titled ? titled[1]! : trimmed;
}

/**
 * Only schemes that are safe to hand to the browser. Relative targets survive:
 * `Markdown.tsx` treats them as project paths and opens them on the Stage.
 */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href.length === 0) return null;
  if (/^(?:javascript|data|vbscript|file):/i.test(href)) return null;
  return href;
}

/** `<https://…>`, `<mailto:…>`, `<user@host>`. */
function readAutolink(source: string, start: number): InlineNode | null {
  const end = source.indexOf(">", start + 1);
  if (end === -1) return null;
  const target = source.slice(start + 1, end).trim();
  if (target.length === 0 || /[\s<>]/.test(target)) return null;

  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    const href = safeHref(target);
    if (!href) return null;
    return { node: { kind: "link", href, children: [{ kind: "text", text: target }] }, end: end + 1 };
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
    return {
      node: { kind: "link", href: `mailto:${target}`, children: [{ kind: "text", text: target }] },
      end: end + 1,
    };
  }
  return null;
}

/** A bare URL in running text — agents paste these constantly. */
function readBareUrl(source: string, start: number): { href: string; text: string; end: number } {
  let end = start;
  while (end < source.length && !/[\s<>"`]/.test(source[end]!)) end++;
  let url = source.slice(start, end);
  // Trailing sentence punctuation is not part of the link.
  url = url.replace(/[.,;:!?]+$/, "");
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1);
  }
  return { href: url, text: url, end: start + url.length };
}
