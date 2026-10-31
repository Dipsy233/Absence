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
  // Drip's floating window: the web face measures itself and the shell owns
  // the real window, so opening, resizing and leaving all go through here.
  openDrip: (sessionId) => ipcRenderer.send("desktop:openDrip", sessionId),
  leaveDrip: () => ipcRenderer.send("desktop:leaveDrip"),
  resizeDrip: (size) => ipcRenderer.send("desktop:dripResize", size),
  startDripDrag: () => ipcRenderer.send("desktop:dripDragStart"),
  endDripDrag: () => ipcRenderer.send("desktop:dripDragEnd"),
  onDripClosed: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("desktop:dripClosed", listener);
    return () => ipcRenderer.removeListener("desktop:dripClosed", listener);
  },
});
