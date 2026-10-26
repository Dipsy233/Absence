/**
 * The Chat panel's Markdown reader (apps/web/src/lib/markdown.ts).
 *   npx tsx scripts/checks/check-markdown.ts
 *
 * The parser is what stands between a model's prose and the chat bubble, so the
 * cases pinned here are the ones that break silently:
 *
 *   • a streaming message is re-parsed mid-token, so an unterminated fence or
 *     `**` must degrade to text instead of swallowing the rest of the reply;
 *   • anything that is not a known construct must stay literal — that is what
 *     makes rendering the tree safe without an HTML sanitiser;
 *   • prose full of `*` (arithmetic, `snake_case`) must not turn into emphasis.
 */
import { check, finish, section } from "./harness";
import { parseInline, parseMarkdown, type MarkdownBlock, type MarkdownInline } from "../../apps/web/src/lib/markdown";

/** Flatten the inline tree to the text a reader would see. */
function textOf(inlines: MarkdownInline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.kind) {
        case "text":
          return inline.text;
        case "code":
          return inline.code;
        case "break":
          return "\n";
        default:
          return textOf(inline.children);
      }
    })
    .join("");
}

const kinds = (blocks: MarkdownBlock[]) => blocks.map((block) => block.kind).join(",");

section("blocks");
{
  const blocks = parseMarkdown("# Title\n\nbody\n\n---\n\n> quote");
  check("heading, paragraph, rule, quote", kinds(blocks) === "heading,paragraph,rule,quote", kinds(blocks));
  const heading = blocks[0];
  check("heading level", heading?.kind === "heading" && heading.level === 1);
  check("setext underline makes a heading", kinds(parseMarkdown("Title\n===\n")) === "heading");
}

section("lists");
{
  const blocks = parseMarkdown("- a\n- b\n  - b1\n  - b2\n- c");
  const list = blocks[0];
  check("one list", blocks.length === 1 && list?.kind === "list");
  check("three items", list?.kind === "list" && list.items.length === 3);
  const nested = list?.kind === "list" ? list.items[1]!.blocks[1] : undefined;
  check("nested list inside item 2", nested?.kind === "list" && nested.items.length === 2);
  const ordered = parseMarkdown("3. three\n4. four")[0];
  check("ordered list keeps its start", ordered?.kind === "list" && ordered.ordered && ordered.start === 3);
  const tasks = parseMarkdown("- [x] done\n- [ ] todo")[0];
  check(
    "task list checks",
    tasks?.kind === "list" && tasks.items[0]!.checked === true && tasks.items[1]!.checked === false,
  );
  // A blank line between items keeps the list together when the next line is
  // still indented content of the previous item.
  const loose = parseMarkdown("- a\n\n  continued\n- b")[0];
  check(
    "blank line continues an indented item",
    loose?.kind === "list" && loose.items[0]!.blocks.length === 2 && loose.items.length === 2,
  );
}

section("code");
{
  const fenced = parseMarkdown("```ts\nconst a = 1;\n# not a heading\n```");
  check("fenced code is one block", fenced.length === 1 && fenced[0]?.kind === "code");
  check("language kept", fenced[0]?.kind === "code" && fenced[0].language === "ts");
  check("body is verbatim", fenced[0]?.kind === "code" && fenced[0].code === "const a = 1;\n# not a heading");

  // Streaming: the closing fence has not arrived yet.
  const open = parseMarkdown("```js\nlet x = 1\n\n# still code");
  check("unterminated fence keeps the rest as code", open.length === 1 && open[0]?.kind === "code");

  const indented = parseMarkdown("    indented\n    code");
  check("four-space indent is code", indented[0]?.kind === "code" && indented[0].language === null);
}

section("tables");
{
  const table = parseMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |")[0];
  check("table parsed", table?.kind === "table");
  check("alignment from the delimiter row", table?.kind === "table" && table.align[0] === "left" && table.align[1] === "right");
  check("header and body", table?.kind === "table" && table.header.length === 2 && table.rows.length === 1);
  const noOuterPipes = parseMarkdown("a | b\n--- | ---\n1 | 2")[0];
  check("outer pipes optional", noOuterPipes?.kind === "table" && noOuterPipes.rows.length === 1);
}

section("inline");
{
  const strong = parseInline("**bold**")[0];
  check("strong", strong?.kind === "strong" && textOf([strong]) === "bold");
  const em = parseInline("*em*")[0];
  check("em", em?.kind === "em" && textOf([em]) === "em");
  const del = parseInline("~~gone~~")[0];
  check("strikethrough", del?.kind === "del" && textOf([del]) === "gone");
  const code = parseInline("`a b`")[0];
  check("code span keeps its spaces", code?.kind === "code" && code.code === "a b");

  // Prose that only looks like markup.
  check("arithmetic stays text", textOf(parseInline("2 * 3 * 4")) === "2 * 3 * 4");
  check("snake_case stays text", textOf(parseInline("foo_bar_baz")) === "foo_bar_baz");
  check("unterminated strong stays text", textOf(parseInline("**open")) === "**open");
  check("unterminated link stays text", textOf(parseInline("[x](")) === "[x](");

  const link = parseInline("[docs](https://example.com/a)")[0];
  check("link href and text", link?.kind === "link" && link.href === "https://example.com/a" && textOf(link.children) === "docs");
  check("link title is dropped", parseInline('[x](https://a.b "t")')[0]?.kind === "link");
  const auto = parseInline("see https://example.com/x.")[1];
  check("bare URL linked", auto?.kind === "link" && auto.href === "https://example.com/x");
  check("javascript: link is dropped", textOf(parseInline("[x](javascript:alert(1))")) === "[x](javascript:alert(1))");
  check("html stays literal", textOf(parseInline("<script>x</script>")) === "<script>x</script>");

  const hard = parseInline("a  \nb");
  check("two trailing spaces = hard break", hard.some((node) => node.kind === "break"));
  check("soft newline = space", textOf(parseInline("a\nb")) === "a b");
}

section("streaming safety");
{
  // Whatever half-written text arrives, the parser must return a tree (no
  // throw) and must not lose the text it was given.
  const partials = ["#", "## ", "-", "1.", ">", "|", "```", "**", "*", "`", "[", "![", "<", "\\", "~~", "|-"];
  let survived = true;
  for (const partial of partials) {
    try {
      const blocks = parseMarkdown(`text ${partial}`);
      if (blocks.length === 0) survived = false;
    } catch {
      survived = false;
      console.error(`  threw on ${JSON.stringify(partial)}`);
    }
  }
  check("every half-written construct parses", survived);
  check("empty input is no blocks", parseMarkdown("").length === 0);
}

finish("markdown checks");
