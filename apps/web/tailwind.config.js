/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      colors: {
        // The desk palette lives in CSS custom properties (see src/lib/theme.ts)
        // so themes can swap it at runtime. Vars are "R G B" channel triples;
        // <alpha-value> keeps opacity modifiers (bg-desk-panel/85) working.
        desk: {
          bg: "rgb(var(--desk-bg) / <alpha-value>)",
          panel: "rgb(var(--desk-panel) / <alpha-value>)",
          panel2: "rgb(var(--desk-panel2) / <alpha-value>)",
          deep: "rgb(var(--desk-deep) / <alpha-value>)",
          line: "rgb(var(--desk-line) / <alpha-value>)",
          ink: "rgb(var(--desk-ink) / <alpha-value>)",
          dim: "rgb(var(--desk-dim) / <alpha-value>)",
          amber: "rgb(var(--desk-accent) / <alpha-value>)",
          ember: "rgb(var(--desk-ember) / <alpha-value>)",
          teal: "rgb(var(--desk-teal) / <alpha-value>)",
          wood: "rgb(var(--desk-wood) / <alpha-value>)",
          woodLit: "rgb(var(--desk-wood-lit) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};
