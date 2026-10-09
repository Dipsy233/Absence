import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./lib/monaco";
import { applyTheme, readStoredTheme } from "./lib/theme";
import "./index.css";

// Apply the stored color theme before render: it sets the CSS vars the whole
// UI derives from and defines Monaco's "daze" theme ahead of any editor.
applyTheme(readStoredTheme());

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
