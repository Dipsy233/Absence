// DAZE desktop shell.
//
// The server runs *in this process* (not a spawned child), so the app has one
// lifecycle: closing the window can stop the server, and there is never a
// stray console window or a port to pick. The server code is TypeScript; tsx's
// CJS loader lets a CommonJS Electron main process require it directly.
//
// The window loads the same built web app the browser would — no UI fork.
const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
// `--dev` is explicit: it opens DevTools and skips request logging. A plain
// `electron .` run is the normal app — no DevTools stealing focus.
const IS_DEV = process.argv.includes("--dev");

// Single instance: a second launch focuses the existing window instead of
// fighting over the state directory.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/** @type {{ url: string, close: () => Promise<void> } | null} */
let server = null;
/** @type {import("electron").BrowserWindow | null} */
let win = null;
/** @type {import("electron").Tray | null} */
let tray = null;
let quitting = false;
/** The URL the window should load — dev server or embedded server, decided once. */
let windowUrl = null;

async function startEmbeddedServer() {
  // Both paths come from the repo checkout. The server source is TypeScript and
  // the web app is the built `dist` (or the Vite dev server under `--dev`).
  const serverEntry = path.join(REPO_ROOT, "apps", "server", "src", "index.ts");
  const webDist = path.join(REPO_ROOT, "apps", "web", "dist");

  if (!fs.existsSync(serverEntry)) {
    throw new Error(`server entry not found: ${serverEntry}`);
  }
  if (!fs.existsSync(webDist)) {
    // The in-process server still serves /api and /ws without it, but the
    // window would be blank — say so plainly instead of showing nothing.
    throw new Error(`web build not found: ${webDist}\nRun \`npm run build\` first.`);
  }

  // tsx's CJS API registers a require hook so we can import the TypeScript
  // server. `require` here is tsx's scoped require; `register` installs the
  // loader for the whole process (needed because the server then imports more
  // TS modules of its own).
  const tsx = require("tsx/cjs/api");
  tsx.register();
  const mod = tsx.require(serverEntry, __filename);
  const { startServer } = mod;

  return startServer({
    port: 0, // let the OS pick a free port — no conflicts, no config
    quiet: !IS_DEV,
    config: { webDist },
  });
}

/** True when a Vite dev server is already listening on the proxy port. */
async function viteDevServerIsUp() {
  try {
    await fetch("http://127.0.0.1:5173/", { method: "HEAD" });
    return true;
  } catch {
    return false;
  }
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0b0d12",
    title: "DAZE",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      // The UI is a plain web app talking over HTTP/WS to the in-process
      // server. It needs no Node access in the renderer.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win && win.show());

  // Open external links in the real browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  // Closing hides to the tray so observation can keep running in the
  // background; real quit goes through the tray menu or Cmd/Ctrl+Q.
  win.on("close", (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    win = null;
  });

  win.loadURL(url);

  if (IS_DEV) win.webContents.openDevTools({ mode: "detach" });
}

function createTray() {
  const iconPath = path.join(__dirname, "assets", "tray.png");
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // Fall back to an empty image so the tray still exists rather than crash.
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image);
  tray.setToolTip("DAZE — observing");
  const menu = Menu.buildFromTemplate([
    {
      label: "Show DAZE",
      click: () => {
        if (win) {
          win.show();
          win.focus();
        } else if (windowUrl) {
          createWindow(windowUrl);
        }
      },
    },
    { type: "separator" },
    {
      label: "Open in browser",
      click: () => server && shell.openExternal(server.url),
    },
    {
      label: "Quit DAZE",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (!win) {
      if (windowUrl) createWindow(windowUrl);
      return;
    }
    win.isVisible() ? win.hide() : (win.show(), win.focus());
  });
}

app.on("second-instance", () => {
  if (win) {
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  try {
    server = await startEmbeddedServer();
  } catch (error) {
    dialog.showErrorBox(
      "DAZE failed to start",
      error instanceof Error ? error.stack || error.message : String(error),
    );
    app.quit();
    return;
  }

  // Under --dev, prefer the Vite dev server for hot reload; the embedded
  // server still owns /api and /ws, and Vite proxies both to it. Fall back to
  // the built assets when Vite is not running.
  windowUrl = IS_DEV && (await viteDevServerIsUp()) ? "http://127.0.0.1:5173" : server.url;
  createWindow(windowUrl);
  createTray();

  app.on("activate", () => {
    if (!win && windowUrl) createWindow(windowUrl);
  });
});

app.on("window-all-closed", () => {
  // Keep running in the tray (observation is the point). Explicit quit exits.
  if (process.platform !== "darwin" && !tray) app.quit();
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("will-quit", (event) => {
  if (!server) return;
  event.preventDefault();
  const s = server;
  server = null;
  s.close().finally(() => app.quit());
});
