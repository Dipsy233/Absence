import { useMemo, useState, type ReactNode } from "react";
import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
  type MarkdownListItem,
} from "../../lib/markdown";
import { openUserFile } from "../../lib/openFile";
import { useSessionStore } from "../../stores/sessionStore";
import { useT } from "../../lib/i18n";

/**
 * Markdown for agent messages (read02 §30).
 *
 * The parser (`lib/markdown.ts`) hands back a typed tree and this file renders
 * it as React elements — no HTML string, so nothing the model writes can become
 * markup. Two affordances go beyond plain rendering, because this is a chat
 * about a *project*:
 *
 *   • a link to a project path opens that file on the Stage (the same action as
 *     clicking it in the Files panel) instead of doing nothing in the browser;
 *   • inline code that looks like a path does the same, since agents write
 *     `apps/web/src/App.tsx` far more often than they write a link to it.
 *
 * External links keep their href but open in a new tab; `javascript:` and
 * friends never reach the DOM (the parser drops them to literal text).
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // Re-parsing on every streamed token is wasted work for the messages above
  // the streaming one; memoising by content keeps that to one parse per change.
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  return (
    <div className={streaming ? "md md-streaming" : "md"}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}

/* ── blocks ───────────────────────────────────────────────────────────────── */

const HEADING_TAG = { 1: "h1", 2: "h2", 3: "h3", 4: "h4", 5: "h5", 6: "h6" } as const;

function BlockView({ block }: { block: MarkdownBlock }): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = HEADING_TAG[block.level];
      return (
        <Tag>
          <Inlines inlines={block.inlines} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p>
          <Inlines inlines={block.inlines} />
        </p>
      );
    case "code":
      return <CodeBlock language={block.language} code={block.code} />;
    case "rule":
      return <hr />;
    case "quote":
      return (
        <blockquote>
          {block.blocks.map((inner, index) => (
            <BlockView key={index} block={inner} />
          ))}
        </blockquote>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag start={block.ordered ? block.start : undefined}>
          {block.items.map((item, index) => (
            <ItemView key={index} item={item} />
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div className="md-table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} className={alignClass(block.align[index] ?? null)}>
                    <Inlines inlines={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className={alignClass(block.align[cellIndex] ?? null)}>
                      <Inlines inlines={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

// Tailwind only sees literal class names, so alignment is a lookup, not a
// template string.
const ALIGN_CLASS = { left: "text-left", center: "text-center", right: "text-right", none: "" } as const;

function alignClass(align: "left" | "center" | "right" | null): string {
  return ALIGN_CLASS[align ?? "none"];
}

function ItemView({ item }: { item: MarkdownListItem }): ReactNode {
  const blocks = item.blocks.map((block, index) => <BlockView key={index} block={block} />);

  // A GFM task item draws its own marker, so the browser's bullet goes away and
  // the checkbox sits where the bullet was.
  if (item.checked !== undefined) {
    return (
      <li className="md-task">
        <span aria-hidden className={item.checked ? "md-check md-check-on" : "md-check"}>
          {item.checked ? "✓" : "○"}
        </span>
        <div className="min-w-0 flex-1">{blocks}</div>
      </li>
    );
  }

  return <li>{blocks}</li>;
}

/* ── inlines ──────────────────────────────────────────────────────────────── */

function Inlines({ inlines }: { inlines: MarkdownInline[] }): ReactNode {
  return (
    <>
      {inlines.map((inline, index) => (
        <InlineView key={index} node={inline} />
      ))}
    </>
  );
}

function InlineView({ node }: { node: MarkdownInline }): ReactNode {
  switch (node.kind) {
    case "text":
      return node.text;
    case "break":
      return <br />;
    case "code":
      return isProjectPath(node.code) ? <FileChip path={node.code} /> : <code>{node.code}</code>;
    case "strong":
      return (
        <strong>
          <Inlines inlines={node.children} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inlines inlines={node.children} />
        </em>
      );
    case "del":
      return (
        <del>
          <Inlines inlines={node.children} />
        </del>
      );
    case "link":
      return <LinkView href={node.href}>{<Inlines inlines={node.children} />}</LinkView>;
    default:
      return null;
  }
}

const EXTERNAL_RE = /^(?:https?|mailto):/i;

function LinkView({ href, children }: { href: string; children: ReactNode }): ReactNode {
  if (EXTERNAL_RE.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  // `#anchor` has nowhere to point inside a chat bubble; keep the words, drop
  // the link. Everything else is treated as a project path.
  if (href.startsWith("#")) return <>{children}</>;
  return <FileChip path={href}>{children}</FileChip>;
}

/* ── project paths ────────────────────────────────────────────────────────── */

/**
 * Something that reads as a file in this project: a name with a dotted
 * extension, optionally behind directories, optionally with a line suffix
 * (`src/App.tsx:12-20`). Deliberately conservative — a false positive turns
 * prose into a clickable button, which is worse than a false negative.
 */
const PATH_RE = /^(?:[\w.@~+-]+\/)*[\w.@~+-]+\.[a-zA-Z][a-zA-Z0-9]{0,7}(?::\d+(?:-\d+)?)?$/;

function isProjectPath(text: string): boolean {
  const value = text.trim();
  if (value.length === 0 || value.length > 240) return false;
  if (/\s/.test(value)) return false;
  if (EXTERNAL_RE.test(value) || value.startsWith("#")) return false;
  return PATH_RE.test(value.replace(/\\/g, "/"));
}

/** Strip a `:12-20` line suffix and make the path usable by the API. */
function normalizeProjectPath(raw: string): string {
  const text = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const withoutLines = text.replace(/:\d+(?:-\d+)?$/, "");
  const projectPath = useSessionStore.getState().session?.projectPath?.replace(/\\/g, "/").replace(/\/$/, "");
  // An absolute path inside the project becomes project-relative, which is what
  // the file API and the file store both key on.
  if (projectPath && withoutLines.startsWith(`${projectPath}/`)) {
    return withoutLines.slice(projectPath.length + 1);
  }
  return withoutLines;
}

function FileChip({ path, children }: { path: string; children?: ReactNode }): ReactNode {
  const t = useT();
  const target = normalizeProjectPath(path);
  return (
    <button
      type="button"
      onClick={() => void openUserFile(target)}
      title={t("Open {path} on the Stage", { path: target })}
      className="md-file"
    >
      {children ?? path}
    </button>
  );
}

/* ── fenced code ──────────────────────────────────────────────────────────── */

function CodeBlock({ language, code }: { language: string | null; code: string }): ReactNode {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    // Clipboard access can be missing (insecure context) or refused; failing
    // silently leaves the button as it was, which is the honest outcome.
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{language ?? t("text")}</span>
        <button type="button" onClick={copy} title={t("Copy this block")}>
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
