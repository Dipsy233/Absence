import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web app talks to the Absence server over /api, /ws, and the served
// avatar-skin / sound-set media. In dev we proxy all of them to the server so
// the browser sees a single origin. ABSENCE_PORT lets a second dev stack run
// against a server on another port without editing this file.
const apiPort = process.env.ABSENCE_PORT ?? "8848";
const apiTarget = `http://localhost:${apiPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.ABSENCE_WEB_PORT ?? 5173),
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://localhost:${apiPort}`,
        ws: true,
      },
      // Active avatar-skin media (/avatar/<status>) and sound-set audio
      // (/sound/<event>) are served by the server too; without these the dev
      // server would answer with index.html and media elements would fail.
      "/avatar": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/sound": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    // Everything buildable lands under the repo-root `dist/`, so the outputs
    // of every form (web, desktop) live in one predictable place instead of
    // being scattered next to each app. Relative to this file: apps/web → root.
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
