import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web app talks to the Daze server over /api and /ws. In dev we proxy
// both to the server so the browser sees a single origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8848",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:8848",
        ws: true,
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
