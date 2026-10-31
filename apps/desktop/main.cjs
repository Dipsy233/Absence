// ABSENCE desktop shell (project ABSENCE → renamed Absence).
//
// The server runs *in this process* (not a spawned child), so the app has one
// lifecycle: closing the window can stop the server, and there is never a
// stray console window or a port to pick. The server code is TypeScript; tsx's
// CJS loader lets a CommonJS Electron main process require it directly.
//
// The window loads the same built web app the browser would — no UI fork.
const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage, Notification, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// `--dev` is explicit: it opens DevTools and skips request logging. A plain
// `electron .` run is the normal app — no DevTools stealing focus.
const IS_DEV = process.argv.includes("--dev");

// A packaged app ships its resources beside the executable (`resources/`), a
// checkout has them at the repo root. Resolve once and never think about it
// again: both `server/` and `web/dist` live under the same root in either case
// (see `build.extraResources` in package.json).
const RESOURCES_ROOT = app.isPackaged
  ? process.resourcesPath
  : path.resolve(__dirname, "..", "..");

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
/** @type {import("electron").BrowserWindow | null} */
let dripWin = null;
/** @type {import("electron").Tray | null} */
let tray = null;
let quitting = false;
/** The URL the window should load — dev server or embedded server, decided once. */
let windowUrl = null;
/** Unsubscribe hooks for the in-process status listeners (dev only cleanup). */
let teardownStatus = null;

/** Append a line to the desktop log so a packaged app is debuggable. */
function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  if (IS_DEV) process.stdout.write(line);
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "desktop.log"), line);
  } catch {
    // Logging must never take the app down.
  }
}

/**
 * Load the ABSENCE server module — the compiled bundle when packaged, the
 * TypeScript sources via tsx in a checkout. Both cases return the same object
 * shape (`{ startServer, sessionStore }`) so callers never branch.
 */
function loadServerModule() {
  const bundleEntry = path.join(RESOURCES_ROOT, "apps", "server-bundle.cjs");
  if (app.isPackaged && fs.existsSync(bundleEntry)) {
    return require(bundleEntry);
  }
  // tsx's CJS API registers a require hook so we can import the TypeScript
  // server. `register` installs the loader for the whole process (needed
  // because the server then imports more TS modules of its own).
  const tsx = require("tsx/cjs/api");
  tsx.register();
  return tsx.require(path.join(RESOURCES_ROOT, "apps", "server", "src", "desktop-entry.ts"), __filename);
}

/** Subscribe to the in-process session store: window title, tray, notifications. */
function watchSessions() {
  let store;
  let isAgentBusy;
  try {
    const mod = loadServerModule();
    store = mod.sessionStore;
    isAgentBusy = mod.isAgentBusy;
  } catch (error) {
    logLine(`session watch unavailable: ${error && error.message}`);
    return;
  }

  /** @type {Map<string, { name: string, status: string, unsub: () => void }>} */
  const tracked = new Map();

  const refresh = () => {
    const running = [...tracked.values()].filter((s) => isAgentBusy(s.status));
    const title =
      running.length === 0
        ? `ABSENCE${tracked.size > 0 ? " — idle" : ""}`
        : `ABSENCE — ${running[0].name} (${running[0].status})`;
    if (win) win.setTitle(title);
    if (tray) tray.setToolTip(running.length > 0 ? `ABSENCE — ${running.length} running` : "ABSENCE — observing");
  };

  const attach = (session) => {
    if (tracked.has(session.id)) return;
    const entry = {
      name: session.session.projectName || "project",
      status: session.session.status,
      unsub: () => {},
    };
    entry.unsub = session.stateBus.subscribe((state) => {
      const previous = entry.status;
      entry.status = state.agent ? state.agent.status : entry.status;
      refresh();
      // A run finishing (busy → idle) is worth a native notification, but only
      // if the user is not already looking at the window.
      const finished = isAgentBusy(previous) && !isAgentBusy(entry.status);
      if (finished && win && !win.isFocused() && Notification.isSupported()) {
        new Notification({
          title: "ABSENCE — run finished",
          body: `${entry.name} is idle again.`,
        }).show();
      }
    });
    tracked.set(session.id, entry);
    refresh();
  };

  // Track sessions created from now on. `create()` is async, so poll the store
  // cheaply — it is a plain in-memory Map.
  const scan = setInterval(() => {
    for (const session of store.list()) attach(session);
  }, 500);
  scan.unref?.();

  teardownStatus = () => {
    clearInterval(scan);
    for (const entry of tracked.values()) entry.unsub();
    tracked.clear();
  };
  refresh();
}

async function startEmbeddedServer() {
  // A packaged app ships:
  //   resources/apps/server-bundle.cjs   our compiled server (no tsx needed)
  //   resources/dist/web                 the built UI
  //   resources/node_modules             only the server's runtime deps
  //   resources/native/agentwatch*       the process-observer helpers
  // A checkout has the same server as TypeScript plus a full node_modules,
  // which tsx loads directly. Resolve the two modes here, once.
  const webDist = path.join(RESOURCES_ROOT, "dist", "web");
  const bundleEntry = path.join(RESOURCES_ROOT, "apps", "server-bundle.cjs");
  const serverEntry = path.join(RESOURCES_ROOT, "apps", "server", "src", "index.ts");

  if (!fs.existsSync(webDist)) {
    // The in-process server still serves /api and /ws without it, but the
    // window would be blank — say so plainly instead of showing nothing.
    throw new Error(`web build not found: ${webDist}\nRun \`npm run build\` first.`);
  }

  let mod;
  if (app.isPackaged && fs.existsSync(bundleEntry)) {
    // Point the native observer at the shipped helper before the server's
    // path heuristic (which assumes a checkout layout) can guess wrong.
    const nativeRoot = path.join(RESOURCES_ROOT, "native");
    const winHelper = path.join(nativeRoot, "agentwatch", "agentwatch.exe");
    const linuxHelper = path.join(nativeRoot, "agentwatch-linux", "agentwatch-linux");
    if (fs.existsSync(winHelper) && !process.env.ABSENCE_AGENTWATCH) {
      process.env.ABSENCE_AGENTWATCH = winHelper;
    }
    if (fs.existsSync(linuxHelper) && !process.env.ABSENCE_AGENTWATCH_LINUX) {
      process.env.ABSENCE_AGENTWATCH_LINUX = linuxHelper;
    }
  } else if (!fs.existsSync(serverEntry)) {
    throw new Error(`server entry not found: ${serverEntry}`);
  }

  mod = loadServerModule();
  const { startServer } = mod;
  return startServer({
    port: 0, // let the OS pick a free port — no conflicts, no config
    quiet: !IS_DEV,
    config: { webDist },
  });
}

/**
 * True when *a ABSENCE* Vite dev server is listening on the proxy port.
 *
 * A bare `HEAD /` would happily connect to any Vite project that happens to
 * own 5173. Instead we ask the embedded server's own `/api/projects` — which
 * Vite proxies — and only accept the answer if it is a JSON array, the shape
 * only ABSENCE's route returns. A foreign Vite answers that path with its SPA
 * fallback HTML, so `res.ok` is true but the body is not an array, and we
 * correctly fall back to the built assets.
 */
async function viteDevServerIsUp() {
  try {
    const res = await fetch("http://127.0.0.1:5173/api/projects", { method: "GET" });
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body);
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
    title: "ABSENCE",
    autoHideMenuBar: true,
    // Frameless: the native title bar is gone and the web UI renders its own
    // min/max/close (see apps/web/src/components/common/WindowControls.tsx).
    // The top bars are -webkit-app-region: drag; the window controls go over
    // IPC through preload.cjs.
    frame: false,
    show: false,
    webPreferences: {
      // The UI is a plain web app talking over HTTP/WS to the in-process
      // server. It needs no Node access in the renderer; the preload only
      // bridges the three window-control IPC calls.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.once("ready-to-show", () => win && win.show());

  // Keep the renderer's maximize glyph honest (restore vs maximize icon).
  const pushMaximized = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send("desktop:maximizedChanged", win.isMaximized());
    }
  };
  win.on("maximize", pushMaximized);
  win.on("unmaximize", pushMaximized);

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

/**
 * Drip's floating window: frameless, transparent, always on top.
 *
 * The face gets a real window instead of a Document Picture-in-Picture one,
 * because the shell can resize it at any time — a PiP window only resizes
 * inside a click's gesture. The web face measures itself and sends the size
 * over IPC; the window grows leftwards from the ball's right edge, so the ball
 * keeps its place on screen while the card unfolds.
 *
 * The main window is hidden as soon as the face is up; closing this window
 * (Open Absence, Alt+F4, or a failed load) brings it back and leaves Drip.
 */
function createDripWindow(sessionId) {
  if (dripWin && !dripWin.isDestroyed()) {
    dripWin.showInactive();
    return;
  }
  if (!windowUrl) return;

  const BALL = 100;
  const url = `${windowUrl}${windowUrl.includes("?") ? "&" : "?"}face=drip&session=${encodeURIComponent(sessionId)}`;
  const area = screen.getDisplayMatching(win ? win.getBounds() : screen.getPrimaryDisplay().workArea).workArea;

  dripWin = new BrowserWindow({
    width: BALL,
    height: BALL,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    title: "Absence",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // Fixed right edge: the card opens leftwards, so the ball never moves.
  dripWin.setPosition(
    Math.round(area.x + area.width - BALL - 40),
    Math.round(area.y + (area.height - BALL) / 2),
  );

  const restoreMain = () => {
    if (!win || win.isDestroyed()) return;
    win.show();
    win.focus();
    win.webContents.send("desktop:dripClosed");
  };

  dripWin.once("ready-to-show", () => {
    if (dripWin) dripWin.showInactive();
  });

  dripWin.webContents.on("did-fail-load", (_event, _code, _text, _url, isMainFrame) => {
    if (isMainFrame && dripWin && !dripWin.isDestroyed()) dripWin.destroy();
  });

  dripWin.on("closed", () => {
    dripWin = null;
    restoreMain();
  });

  dripWin.loadURL(url);

  // The launcher window has already rendered empty, so hide it now rather than
  // after `ready-to-show`: that would flash a blank window. If the face fails
  // to load, `closed` brings it back.
  if (win && !win.isDestroyed()) win.hide();
}

function closeDripWindow() {
  if (dripWin && !dripWin.isDestroyed()) dripWin.close();
}

function createTray() {
  const iconPath = path.join(__dirname, "assets", "tray.png");
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // Fall back to an empty image so the tray still exists rather than crash.
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image);
  tray.setToolTip("ABSENCE — observing");
  const menu = Menu.buildFromTemplate([
    {
      label: "Show ABSENCE",
      click: () => {
        // While Drip is floating the main window is the hidden launcher; show
        // the normal UI again instead of revealing a blank window.
        if (dripWin) {
          closeDripWindow();
          return;
        }
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
      label: "Quit ABSENCE",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (dripWin) {
      closeDripWindow();
      return;
    }
    if (!win) {
      if (windowUrl) createWindow(windowUrl);
      return;
    }
    win.isVisible() ? win.hide() : (win.show(), win.focus());
  });
}

// Window controls for the frameless window: the renderer asks, the main
// process owns the real window. Close intentionally goes through win.close()
// so the hide-to-tray handler below still applies.
ipcMain.handle("desktop:isMaximized", () => (win ? win.isMaximized() : false));
ipcMain.on("desktop:minimize", () => win && win.minimize());
ipcMain.on("desktop:maximizeToggle", () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on("desktop:close", () => win && win.close());

// Drip's floating window. `sessionId` comes from the face that asked for it; it
// becomes a query parameter so the new window can attach to the same session.
ipcMain.on("desktop:openDrip", (_event, sessionId) => {
  if (typeof sessionId === "string" && sessionId) createDripWindow(sessionId);
});
ipcMain.on("desktop:leaveDrip", () => closeDripWindow());
ipcMain.on("desktop:dripResize", (_event, size) => {
  if (!dripWin || dripWin.isDestroyed() || !size) return;
  const width = Math.round(Number(size.width));
  const height = Math.round(Number(size.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return;

  const bounds = dripWin.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const w = Math.min(width, area.width);
  const h = Math.min(height, area.height);
  dripWin.setBounds({
    // Keep the right edge, where the ball sits, still; grow leftwards.
    x: Math.max(area.x, bounds.x + bounds.width - w),
    // Keep the top edge (the ball's) still; grow downwards, nudging up only
    // when the card would fall off the bottom of the screen.
    y: Math.min(bounds.y, area.y + area.height - h),
    width: w,
    height: h,
  });
});

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
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    logLine(`failed to start: ${detail}`);
    dialog.showErrorBox("ABSENCE failed to start", detail);
    app.quit();
    return;
  }

  logLine(`server listening on ${server.url}`);

  // Under --dev, prefer the Vite dev server for hot reload; the embedded
  // server still owns /api and /ws, and Vite proxies both to it. Fall back to
  // the built assets when Vite is not running.
  windowUrl = IS_DEV && (await viteDevServerIsUp()) ? "http://127.0.0.1:5173" : server.url;
  logLine(`window url: ${windowUrl}`);
  createWindow(windowUrl);
  createTray();
  watchSessions();

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
  if (teardownStatus) teardownStatus();
  const s = server;
  server = null;
  s.close().finally(() => app.quit());
});
