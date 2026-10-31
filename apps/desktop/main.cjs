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
/**
 * Drip's ball, top-left in the same DIP screen coordinates `setBounds` uses.
 *
 * The ball and the panel are independent: the window is a fixed, transparent
 * sheet the size of the whole work area, so it never moves and never resizes.
 * The face positions the ball inside it from `ball - area` and decides on its
 * own which way the panel opens. Windows quantizes bounds to whole device
 * pixels, and resizing a transparent window on the same frame it moves is what
 * made the old grow-from-the-ball window flicker.
 */
let dripBall = null;
/** The work area Drip's window covers, in DIPs; the ball lives inside it. */
let dripArea = null;
/** The pointer's offset inside the ball while a drag gesture is down. */
let dripGrab = null;
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

/** The ball's diameter, as the face draws it. */
const DRIP_BALL = 84;

/** Whole-number clamp; nested `Math.min`/`Math.max` reads poorly inline. */
function clampDrip(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

/**
 * Drip's floating window: frameless, transparent, always on top, and exactly
 * the size of the work area.
 *
 * It is a sheet, not a widget: it covers the screen once, never moves and never
 * resizes, and it is click-through by default (`setIgnoreMouseEvents(true,
 * { forward: true })`, the same trick KoBar uses). The ball is just a shape
 * drawn inside that sheet, so the panel can open whichever way it likes without
 * the window ever changing bounds — the cause of the flicker is gone.
 *
 * The face reports where the pointer is: over the ball or the open panel it
 * turns click-through off, anywhere else back on. That is the only state that
 * crosses the bridge besides the ball's offset.
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

  const url = `${windowUrl}${windowUrl.includes("?") ? "&" : "?"}face=drip&session=${encodeURIComponent(sessionId)}`;
  const area = screen.getDisplayMatching(win ? win.getBounds() : screen.getPrimaryDisplay().workArea).workArea;

  dripWin = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    useContentSize: true,
    frame: false,
    transparent: true,
    // Borrowed from KoBar (electron/main/windows/mainWindow.cts): a transparent
    // window still needs the zero-alpha surface stated outright. Without it
    // Windows' DWM composites its own backdrop behind the window, which shows
    // up as a faintly opaque dark rectangle around the ball.
    backgroundColor: "#00000000",
    // Windows only: `toolbar` makes it a tool window, which DWM composites
    // without the throttle it applies to ordinary top-level windows. The usual
    // side effects (no taskbar entry, no Alt+Tab entry) are what a floating
    // ball wants anyway. `skipTaskbar` below keeps the rest of it quiet.
    ...(process.platform === "win32" ? { type: "toolbar", roundedCorners: false } : {}),
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

  // The ball starts near the work area's right edge, vertically centred, and
  // that is only a position inside the sheet — the window itself never moves.
  dripArea = area;
  dripBall = {
    x: Math.round(area.x + area.width - DRIP_BALL - 40),
    y: Math.round(area.y + (area.height - DRIP_BALL) / 2),
  };
  dripGrab = null;

  // The sheet is transparent almost everywhere, so it must not eat clicks:
  // ignore the mouse, but keep forwarding moves so the face can tell when the
  // pointer is over the ball or the panel and turns interaction back on.
  dripWin.setIgnoreMouseEvents(true, { forward: true });

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
    dripBall = null;
    dripArea = null;
    dripGrab = null;
    restoreMain();
  });

  dripWin.loadURL(url);

  // The launcher window has already rendered empty, so hide it now rather than
  // after `ready-to-show`: that would flash a blank window. If the face fails
  // to load, `closed` brings it back.
  if (win && !win.isDestroyed()) win.hide();
}

/**
 * Where the ball is inside the sheet, and how big the sheet is.
 *
 * The face draws the ball at `(bx, by)` and measures the room around it to
 * decide which way the panel opens. It is a position, not geometry the shell
 * derives: the window is fixed, so the ball is the only thing that moves.
 */
function dripFrame() {
  if (!dripArea || !dripBall) return null;
  return {
    bx: dripBall.x - dripArea.x,
    by: dripBall.y - dripArea.y,
    width: dripArea.width,
    height: dripArea.height,
  };
}

/** Push the ball's place inside the sheet to the face. */
function sendDripFrame() {
  if (!dripWin || dripWin.isDestroyed()) return;
  const frame = dripFrame();
  if (frame) dripWin.webContents.send("desktop:dripBall", frame);
}

/**
 * Remember where inside the ball the pointer went down.
 *
 * The cursor is read from the screen, not taken from the renderer. Nothing is
 * moved here — a press that never travels is still a click.
 */
function dripPress() {
  if (!dripWin || dripWin.isDestroyed() || !dripBall) return;
  const cursor = screen.getCursorScreenPoint();
  dripGrab = { x: cursor.x - dripBall.x, y: cursor.y - dripBall.y };
}

/** Move the ball so the grabbed point sits under the cursor, then tell the face. */
function dripMove() {
  if (!dripWin || dripWin.isDestroyed() || !dripBall || !dripGrab || !dripArea) return;
  const cursor = screen.getCursorScreenPoint();
  const area = dripArea;
  dripBall = {
    x: Math.round(clampDrip(cursor.x - dripGrab.x, area.x, area.x + area.width - DRIP_BALL)),
    y: Math.round(clampDrip(cursor.y - dripGrab.y, area.y, area.y + area.height - DRIP_BALL)),
  };
  sendDripFrame();
}

/** Land exactly on the release point, then forget the grab. */
function dripRelease() {
  dripMove();
  dripGrab = null;
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
// Clicks pass through the sheet except where the face says the pointer is on
// the ball or the panel. `forward` keeps pointer moves coming either way.
ipcMain.on("desktop:dripIgnore", (_event, ignore) => {
  if (!dripWin || dripWin.isDestroyed()) return;
  dripWin.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
});
// A press grabs the ball, each move re-places it under the cursor, and a
// release lands it. The renderer only says when, never where.
ipcMain.on("desktop:dripDragStart", () => dripPress());
ipcMain.on("desktop:dripDrag", () => dripMove());
ipcMain.on("desktop:dripDragEnd", () => dripRelease());
// The face asks once on load where the ball sits inside the sheet; after that
// every drag pushes the same frame at it.
ipcMain.handle("desktop:dripBall", () => dripFrame());

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
