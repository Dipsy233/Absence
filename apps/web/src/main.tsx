import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./lib/monaco";
import { applyTheme } from "./lib/theme";
import { useSettingsStore } from "./stores/settingsStore";
import "./index.css";

// Apply the stored color theme before render: it sets the CSS vars the whole
// UI derives from and defines Monaco's "absence" theme ahead of any editor.
// The Settings dialog changes it through the settings store; this subscription
// keeps the CSS vars in sync with whatever the store holds.
applyTheme(useSettingsStore.getState().theme);
useSettingsStore.subscribe((s, prev) => {
  if (s.theme !== prev.theme) applyTheme(s.theme);
});

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
