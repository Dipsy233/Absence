import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./lib/monaco";
import { applyMonacoTheme } from "./lib/monaco";
import "./index.css";

// Define Monaco's "absence" theme ahead of any editor mounting. The desk
// palette is fixed now — the faces' UI styles (themes.css) handle looks.
applyMonacoTheme();

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
