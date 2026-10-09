// Preload for the frameless desktop window. The web UI renders its own
// min/max/close; this bridge is the only thing it needs from the shell —
// three one-way commands plus the maximize state. In a plain browser
// `window.dazeDesktop` stays undefined and the UI hides the controls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dazeDesktop", {
  minimize: () => ipcRenderer.send("desktop:minimize"),
  toggleMaximize: () => ipcRenderer.send("desktop:maximizeToggle"),
  close: () => ipcRenderer.send("desktop:close"),
  isMaximized: () => ipcRenderer.invoke("desktop:isMaximized"),
  onMaximizedChanged: (callback) => {
    const listener = (_event, maximized) => callback(maximized);
    ipcRenderer.on("desktop:maximizedChanged", listener);
    return () => ipcRenderer.removeListener("desktop:maximizedChanged", listener);
  },
});
