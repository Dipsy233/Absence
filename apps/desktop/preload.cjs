// Preload for the frameless desktop window. The web UI renders its own
// min/max/close; this bridge is the only thing it needs from the shell —
// three one-way commands plus the maximize state. In a plain browser
// `window.absenceDesktop` stays undefined and the UI hides the controls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("absenceDesktop", {
  minimize: () => ipcRenderer.send("desktop:minimize"),
  toggleMaximize: () => ipcRenderer.send("desktop:maximizeToggle"),
  close: () => ipcRenderer.send("desktop:close"),
  isMaximized: () => ipcRenderer.invoke("desktop:isMaximized"),
  onMaximizedChanged: (callback) => {
    const listener = (_event, maximized) => callback(maximized);
    ipcRenderer.on("desktop:maximizedChanged", listener);
    return () => ipcRenderer.removeListener("desktop:maximizedChanged", listener);
  },
  // Drip's floating window: the web face draws the ball inside a fixed,
  // transparent sheet and the shell owns the real window, so opening, moving
  // and leaving all go through here.
  openDrip: (sessionId) => ipcRenderer.send("desktop:openDrip", sessionId),
  leaveDrip: () => ipcRenderer.send("desktop:leaveDrip"),
  // The sheet is click-through except under the ball and the open panel.
  setDripIgnore: (ignore) => ipcRenderer.send("desktop:dripIgnore", ignore),
  // A drag is three signals, never coordinates: the shell reads the cursor
  // itself and moves the ball.
  startDripDrag: () => ipcRenderer.send("desktop:dripDragStart"),
  dragDrip: () => ipcRenderer.send("desktop:dripDrag"),
  endDripDrag: () => ipcRenderer.send("desktop:dripDragEnd"),
  // Where the ball sits inside the sheet ("bx"/"by"), plus the sheet's size.
  dripBall: () => ipcRenderer.invoke("desktop:dripBall"),
  onDripBall: (callback) => {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on("desktop:dripBall", listener);
    return () => ipcRenderer.removeListener("desktop:dripBall", listener);
  },
  onDripClosed: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("desktop:dripClosed", listener);
    return () => ipcRenderer.removeListener("desktop:dripClosed", listener);
  },
});
