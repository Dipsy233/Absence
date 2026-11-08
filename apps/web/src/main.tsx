import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./index.css";

// Monaco is not imported here: the library weighs several megabytes and lives
// in a lazy chunk (see lib/monaco.ts). App's theme effect asks for it right
// after the first paint, which starts the download without delaying boot.

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
