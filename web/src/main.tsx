import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { escapeLineBrowser } from "./lib/inapp";
import "./styles.css";

if (!escapeLineBrowser())
  createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
