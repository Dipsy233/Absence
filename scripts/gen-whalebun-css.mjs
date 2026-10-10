/**
 * One-off generator: turns the standalone WhaleBun character page
 * (E:/dd/jy/agent/index.html) into a scoped stylesheet for the web app.
 *
 * - extracts the <style> block
 * - drops the toolbar / html / body / hint rules (ABSENCE owns the page chrome)
 * - prefixes every selector with `.whalebun-root` so nothing leaks globally
 * - keeps @keyframes verbatim
 *
 * Run: node scripts/gen-whalebun-css.mjs
 */
import fs from "node:fs";

const SRC = "E:/dd/jy/agent/index.html";
const OUT = "apps/web/src/components/agent/whalebun.css";

const html = fs.readFileSync(SRC, "utf8");
const style = html.match(/<style>([\s\S]*?)<\/style>/);
if (!style) throw new Error("no <style> block found");

// Comments may contain braces-looking text; safe to strip first.
let css = style[1].replace(/\/\*[\s\S]*?\*\//g, "");

// Rules that belong to the standalone page chrome, not the character.
const DROP = new Set([
  "*",
  "html,body",
  "html, body",
  "body",
  "body::after",
  ".ui",
  ".brand",
  ".brand b",
  ".brand i",
  ".btn",
  ".btn:hover",
  ".btn.on",
  ".btn.auto",
  ".btn.auto.on",
  ".hint",
  "kbd",
]);

const out = [];
let i = 0;
while (i < css.length) {
  const open = css.indexOf("{", i);
  if (open === -1) break;

  const prelude = css.slice(i, open).trim();

  // find matching close brace
  let j = open + 1;
  let depth = 1;
  while (j < css.length && depth > 0) {
    const c = css[j];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    j++;
  }
  const body = css.slice(open + 1, j - 1).trim();
  i = j;

  if (prelude.startsWith("@keyframes") || prelude.startsWith("@font-face")) {
    out.push(`${prelude}{${body}}`);
    continue;
  }
  if (prelude.startsWith("@")) {
    throw new Error(`unhandled at-rule: ${prelude}`);
  }
  if (DROP.has(prelude)) continue;

  const scoped = prelude
    .split(",")
    .map((s) => {
      const sel = s.trim();
      if (!sel) return "";
      if (sel === ":root") return ".whalebun-root";
      if (sel.startsWith(".whalebun-root")) return sel;
      return `.whalebun-root ${sel}`;
    })
    .filter(Boolean)
    .join(",\n");

  out.push(`${scoped}{${body}}`);
}

const header = `/* ============================================================
   WhaleBun — 毛绒鲸鱼套装虚拟形象 (character only)
   Generated from E:/dd/jy/agent/index.html by scripts/gen-whalebun-css.mjs.
   Every selector is scoped under .whalebun-root; the page background is left
   transparent so the character sits on ABSENCE's own surface.
   Assets live in apps/web/public/whalebun/*.png.
   ============================================================ */\n`;

fs.writeFileSync(OUT, header + out.join("\n\n") + "\n");
console.log(`wrote ${OUT}: ${out.length} rules`);
