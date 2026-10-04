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
        desk: {
          bg: "#141210",
          panel: "#1b1815",
          panel2: "#211d19",
          line: "#2e2822",
          ink: "#efe7db",
          dim: "#9a8f80",
          amber: "#e0a458",
          ember: "#c56b3f",
          teal: "#5fa8a0",
        },
      },
    },
  },
  plugins: [],
};
