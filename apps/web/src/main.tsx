import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadConfig } from "./lib/api";
import { registerServiceWorker } from "./lib/push";
import { initTheme } from "./lib/theme";
import "@fontsource-variable/figtree";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/features.css";

// Start fetching settings right away: it also turns on error reporting, client pages included.
loadConfig().catch(() => undefined);
initTheme();
registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
