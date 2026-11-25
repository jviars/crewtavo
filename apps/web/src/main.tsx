import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadConfig } from "./lib/api";
import { startSlidingIndicators } from "./lib/indicator";
import { lockZoomInApp, watchInstall } from "./lib/install";
import { startLocale, tellIfSpanishDidntLoad } from "./lib/i18n";
import { registerServiceWorker } from "./lib/push";
import { initTheme } from "./lib/theme";
import "@fontsource-variable/figtree";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/features.css";

// Browsers only give crypto.randomUUID to HTTPS pages (and localhost), and an instance can be opened at
// a plain http:// address on a home network or a tailnet. getRandomValues works everywhere.
if (typeof crypto.randomUUID !== "function") {
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // the variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` as ReturnType<Crypto["randomUUID"]>;
  };
}

// Start fetching settings right away: it also turns on error reporting, client pages included.
loadConfig().catch(() => undefined);
initTheme();
registerServiceWorker();
watchInstall();
lockZoomInApp();
startSlidingIndicators();

// Spanish, for whoever chose it, loads before the first screen (English has nothing to load). It
// gets a few seconds: after that the app opens in English and says so, with a way to try again.
void startLocale().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  tellIfSpanishDidntLoad();
});
