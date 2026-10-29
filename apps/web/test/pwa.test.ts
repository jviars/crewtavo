/**
 * Crewtavo installed as a phone app: the manifest (maskable icons, shortcuts to real screens), the
 * first paint in the page's own color, the install button and iPhone tip (lib/install.ts), and the
 * service worker's notice about updates waiting to be sent (public/sw.js).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { inflateSync } from "node:zlib";
import { ROLES } from "@crewtavo/core/roles";
import { matchPath } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canLogRequests } from "../src/features/requests/RequestsPage";
import { SYNC_TAG, WAITING_CACHE } from "../src/lib/offline";
import { FakeCaches, loadServiceWorker } from "./serviceWorker";

const file = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(file(path), "utf8");

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
  id: string;
  start_url: string;
  scope: string;
  description: string;
  lang: string;
  categories: string[];
  display: string;
  background_color: string;
  icons: Icon[];
  shortcuts: Array<{ name: string; url: string; icons: Icon[] }>;
};

/** A PNG's pixels (8-bit RGB or RGBA, not interlaced: what Chromium writes). */
function decodePng(path: string) {
  const data = readFileSync(file(`public${path}`));
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const [depth, color, , , interlace] = data.subarray(24, 29);
  if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) throw new Error(`Unexpected PNG format in ${path}`);
  const channels = color === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let at = 8; at < data.length; ) {
    const length = data.readUInt32BE(at);
    if (data.toString("latin1", at + 4, at + 8) === "IDAT") idat.push(data.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter]!;
      pixels[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  const at = (x: number, y: number) => [...pixels.subarray(y * stride + x * channels, y * stride + x * channels + channels), ...(channels === 3 ? [255] : [])];
  return { width, height, at };
}

/** The page's own color, light and dark (--page in src/styles/tokens.css; dark mode maps it onto Radix's sand scale). */
function pageColors() {
  const tokens = read("src/styles/tokens.css");
  const light = tokens.match(/:root \{[^}]*?--page:\s*([^;]+);/)![1]!.trim();
  const dark = tokens.match(/:root\.dark \{[^}]*?--page:\s*([^;]+);/)![1]!.trim();
  const sand = readFileSync(fileURLToPath(new URL("../../../node_modules/@radix-ui/colors/sand-dark.css", import.meta.url)), "utf8");
  const resolved = dark.replace(/^var\((--[\w-]+)\)$/, (_, name: string) => sand.match(new RegExp(`${name}:\\s*([^;]+);`))![1]!.trim());
  return { light: hex(light), dark: hex(resolved) };
}
const hex = (color: string) => {
  const c = color.trim().toLowerCase();
  return /^#[0-9a-f]{3}$/.test(c) ? `#${[...c.slice(1)].map((d) => d + d).join("")}` : c;
};

describe("the manifest", () => {
  it("names the app once, for everything under it, and describes it to app stores and install sheets", () => {
    expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone", lang: "en" });
    expect(manifest.description).toMatch(/service businesses/);
    expect(manifest.categories).toEqual(expect.arrayContaining(["business", "productivity"]));
  });

  it("lists icons for any shape and maskable ones, 192 and 512, each a real PNG of its stated size", () => {
    const pngs = manifest.icons.filter((i) => i.type === "image/png");
    for (const purpose of ["any", "maskable"]) {
      expect(pngs.filter((i) => (i.purpose ?? "any") === purpose).map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    }
    for (const icon of [...pngs, ...manifest.shortcuts.flatMap((s) => s.icons)]) {
      const png = decodePng(icon.src);
      expect(`${png.width}x${png.height}`, icon.src).toBe(icon.sizes);
    }
  });

  it.each(["192", "512"])("maskable %s: the background reaches every edge and the mark stays inside the safe circle", (size) => {
    const icon = manifest.icons.find((i) => i.purpose === "maskable" && i.sizes === `${size}x${size}`)!;
    const png = decodePng(icon.src);
    const background = png.at(0, 0);
    expect(background[3]).toBe(255); // opaque: Android shows no white disc or square around it
    const n = png.width;
    for (let i = 0; i < n; i++) for (const [x, y] of [[i, 0], [i, n - 1], [0, i], [n - 1, i]] as const) expect(png.at(x, y)).toEqual(background);
    // Every pixel of the mark lies within 40% of the size from the center (the zone no launcher crops).
    let reach = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const px = png.at(x, y);
        if (px.some((v, i) => Math.abs(v - background[i]!) > 24)) reach = Math.max(reach, Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2));
      }
    }
    expect(reach).toBeLessThanOrEqual(0.4 * n);
    expect(reach).toBeGreaterThan(0.3 * n); // and it's not lost in the middle
  });

  it("starts on the page's own light color, so opening the app doesn't flash a different one", () => {
    expect(hex(manifest.background_color)).toBe(pageColors().light);
  });

  it("has shortcuts for the crew (My day, Schedule) and the office (Schedule, New request) to screens that exist", () => {
    expect(manifest.shortcuts.map((s) => s.name)).toEqual(["My day", "Schedule", "New request"]);
    const routes = read("src/routes.tsx");
    const paths = [...routes.matchAll(/path: "([^"]+)"/g)].map((m) => `/${m[1]}`).filter((p) => p !== "/*");
    for (const shortcut of manifest.shortcuts) {
      const url = new URL(shortcut.url, "https://crew.example.com");
      expect(paths.some((path) => matchPath({ path, end: true }, url.pathname)), shortcut.url).toBe(true);
      expect(shortcut.icons.some((i) => i.sizes === "96x96"), `${shortcut.name} needs a 96x96 icon for Android`).toBe(true);
    }
    // New request opens the form on Requests.
    expect(manifest.shortcuts.find((s) => s.name === "New request")!.url).toBe("/requests?new=1");
    expect(read("src/features/requests/RequestsPage.tsx")).toContain('params.get("new") === "1"');
  });

  it("New request opens the form only for people the database lets log one (everyone's phone has the shortcut)", () => {
    // The roles requests_insert allows: the write list given to private.apply_policies, as last set.
    const migrations = readdirSync(file("../../supabase/migrations")).sort().map((name) => read(`../../supabase/migrations/${name}`));
    const writers = [...migrations.join("\n").matchAll(/apply_policies\('requests', '\{([^}]+)\}'\)/g)].at(-1)![1]!.split(",");
    for (const role of ROLES) expect(canLogRequests({ role }), role).toBe(writers.includes(role));
    expect(canLogRequests({ role: "field_crew" })).toBe(false);
    // The crew get Requests without the form.
    expect(read("src/features/requests/RequestsPage.tsx")).toContain('const creating = params.get("new") === "1" && canLogRequests(session);');
  });
});

describe("the first paint", () => {
  const html = read("index.html");
  const head = html.slice(0, html.indexOf("</head>"));

  it("is the page's own color in light and dark before any stylesheet loads", () => {
    const { light, dark } = pageColors();
    const style = head.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    expect(hex(style.match(/(?:^|\n)\s*html \{[^}]*background:\s*([^;]+);/)![1]!)).toBe(light);
    expect(hex(style.match(/html\.dark \{[^}]*background:\s*([^;]+);/)![1]!)).toBe(dark);
    // The script that adds .dark runs in <head> too, before the body paints.
    expect(head).toContain('classList.add("dark")');
    // And the loading screen in the body agrees.
    expect(hex(html.match(/\.boot \{[^}]*background:\s*([^;]+);/)![1]!)).toBe(light);
    expect(hex(html.match(/\.dark \.boot \{[^}]*background:\s*([^;]+);/)![1]!)).toBe(dark);
  });

  it("names the app on an iPhone's Home Screen and draws under the notch and home indicator", () => {
    expect(head).toContain('<meta name="apple-mobile-web-app-title" content="Crewtavo" />');
    expect(head).toMatch(/<meta name="apple-mobile-web-app-status-bar-style" content="default" \/>/);
    expect(head).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/);
    // With viewport-fit=cover, the bars and the screen keep clear of the safe areas themselves.
    const css = read("src/styles/base.css");
    const phone = css.slice(css.indexOf("@media (max-width: 900px)"));
    expect(phone).toMatch(/\.content \{[^}]*env\(safe-area-inset-bottom\)[^}]*env\(safe-area-inset-left\)/);
    expect(phone).toMatch(/\.mobile-nav \{[^}]*env\(safe-area-inset-right\) env\(safe-area-inset-bottom\) env\(safe-area-inset-left\)/);
    expect(phone).toMatch(/\.topbar \{[^}]*env\(safe-area-inset-right\)[^}]*env\(safe-area-inset-left\)/);
  });

  it("keeps clear of the notch and home indicator on a big phone sideways too, wider than 900 px (the computer layout)", () => {
    const css = read("src/styles/base.css");
    const wide = css.slice(0, css.indexOf("@media (max-width: 900px)"));
    const rule = (selector: string) => wide.match(new RegExp(`\\n${selector.replace(".", "\\.")} \\{([^}]*)\\}`))![1]!;
    // The sidebar on the left (the notch on that side, the home indicator under its last links)...
    expect(rule(".sidebar")).toMatch(/padding-left: max\(12px, env\(safe-area-inset-left\)\)/);
    expect(rule(".sidebar")).toMatch(/padding-bottom: max\(16px, env\(safe-area-inset-bottom\)\)/);
    // ...and the top bar and the screen on the right.
    expect(rule(".topbar")).toMatch(/padding: 10px max\(24px, env\(safe-area-inset-right\)\) /);
    expect(rule(".content")).toMatch(/padding: 20px max\(48px, env\(safe-area-inset-right\)\) 56px 48px;/);
  });

  it("keeps toasts clear of the notch and home indicator, sideways too, in both layouts", () => {
    const css = read("src/styles/components.css");
    const wide = css.match(/\n\.toaster \{([^}]*)\}/)![1]!;
    // Plus the room the background task island takes while it's up (--island-space).
    expect(wide).toMatch(/inset: auto max\(20px, env\(safe-area-inset-right\)\) calc\(max\(20px, env\(safe-area-inset-bottom\)\) \+ var\(--island-space, 0px\)\) auto;/);
    const phone = css.match(/@media \(max-width: 900px\) \{ \.toaster \{([^}]*)\}/)![1]!;
    expect(phone).toMatch(/inset: auto max\(16px, env\(safe-area-inset-right\)\) calc\(var\(--mobile-nav-height\) \+ 12px \+ env\(safe-area-inset-bottom\) \+ var\(--island-space, 0px\)\) max\(16px, env\(safe-area-inset-left\)\);/);
  });
});

// --- Installing ----------------------------------------------------------------------------------

const UA = {
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1",
  iphoneFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15",
  iphoneFacebook: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.39.106]",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
};

/** A browser tab (or an installed app, with standalone) on some device, at some page. */
function device({ userAgent, platform = "", touch = 0, standalone = false, path = "/field", storage }: { userAgent: string; platform?: string; touch?: number; standalone?: boolean; path?: string; storage?: Storage }) {
  const media = Object.assign(new EventTarget(), { matches: standalone });
  const win = Object.assign(new EventTarget(), {
    location: { pathname: path },
    matchMedia: (query: string) => (query === "(display-mode: standalone)" ? media : Object.assign(new EventTarget(), { matches: false })),
    navigator: { userAgent, platform, maxTouchPoints: touch },
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", win.navigator);
  const saved = new Map<string, string>();
  vi.stubGlobal(
    "localStorage",
    storage ?? { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) },
  );
  return { win, saved };
}

/** Chrome offering to install, as `beforeinstallprompt`. */
function installPrompt(outcome: "accepted" | "dismissed") {
  return Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome }),
  });
}

/** lib/install.ts as a page loads it, with nothing remembered from another test. */
async function freshInstall() {
  vi.resetModules();
  return import("../src/lib/install");
}

describe("installing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["Safari on an iPhone", { userAgent: UA.iphoneSafari }, "ios"],
    ["Safari on an iPad asking for desktop sites", { userAgent: UA.macSafari, platform: "MacIntel", touch: 5 }, "ios"],
    ["Crewtavo already on the iPhone's Home Screen", { userAgent: UA.iphoneSafari, standalone: true }, null],
    ["Chrome on an iPhone (no Add to Home Screen steps to give)", { userAgent: UA.iphoneChrome }, null],
    ["Firefox on an iPhone", { userAgent: UA.iphoneFirefox }, null],
    ["Facebook's built-in browser on an iPhone", { userAgent: UA.iphoneFacebook }, null],
    ["Safari on a Mac", { userAgent: UA.macSafari, platform: "MacIntel" }, null],
    ["Chrome on Android before it offers to install", { userAgent: UA.androidChrome }, null],
    ["Safari on an iPhone, on a client's hub page", { userAgent: UA.iphoneSafari, path: "/hub/abc" }, null],
    ["Safari on an iPhone, on a booking form", { userAgent: UA.iphoneSafari, path: "/book/acme/estimate" }, null],
  ] as const)("%s: %s", async (_, settings, expected) => {
    device(settings);
    const { currentInstallHint } = await freshInstall();
    expect(currentInstallHint()).toBe(expected);
  });

  it("on Android, holds Chrome's prompt for our button, opens it once, and hides the button once installed", async () => {
    const { win } = device({ userAgent: UA.androidChrome });
    const { watchInstall, currentInstallHint, installApp } = await freshInstall();
    watchInstall(win as unknown as Window);
    const offer = installPrompt("accepted");
    win.dispatchEvent(offer);
    expect(offer.defaultPrevented).toBe(true); // our button instead of Chrome's own banner
    expect(currentInstallHint()).toBe("prompt");

    await expect(installApp()).resolves.toBe(true);
    expect(offer.prompt).toHaveBeenCalledTimes(1);
    expect(currentInstallHint()).toBe(null); // a prompt opens once
    await expect(installApp()).resolves.toBe(false);

    win.dispatchEvent(installPrompt("accepted"));
    win.dispatchEvent(new Event("appinstalled"));
    expect(currentInstallHint()).toBe(null);
  });

  it("on Android, says no install button again until Chrome offers again, when the person said no", async () => {
    const { win } = device({ userAgent: UA.androidChrome });
    const { watchInstall, currentInstallHint, installApp } = await freshInstall();
    watchInstall(win as unknown as Window);
    win.dispatchEvent(installPrompt("dismissed"));
    await expect(installApp()).resolves.toBe(false);
    expect(currentInstallHint()).toBe(null);
    win.dispatchEvent(installPrompt("accepted"));
    expect(currentInstallHint()).toBe("prompt");
  });

  it("offers nothing once running as the installed app, or on a client's page", async () => {
    for (const settings of [{ standalone: true }, { path: "/refer/xyz" }, { path: "/u/token" }]) {
      const { win } = device({ userAgent: UA.androidChrome, ...settings });
      const { watchInstall, currentInstallHint } = await freshInstall();
      watchInstall(win as unknown as Window);
      win.dispatchEvent(installPrompt("accepted"));
      expect(currentInstallHint()).toBe(null);
    }
  });

  it("on a computer, Chrome's prompt counts too (the office sees the button in Settings only)", async () => {
    const { win } = device({ userAgent: UA.windowsChrome, path: "/settings" });
    const { watchInstall, currentInstallHint } = await freshInstall();
    watchInstall(win as unknown as Window);
    win.dispatchEvent(installPrompt("accepted"));
    expect(currentInstallHint()).toBe("prompt");
    // The crew's card is on Home (crew view) and My day only; the office's Home leaves it out.
    expect(read("src/features/home/HomePage.tsx")).toMatch(/\{!isOffice && <InstallAppCard \/>\}/);
    expect(read("src/features/field/FieldTodayPage.tsx")).toMatch(/\{!hasRole\(session, "admin", "office", "estimator"\) && <InstallAppCard \/>\}/);
  });

  it("remembers on this device that the tip was put away", async () => {
    const { saved } = device({ userAgent: UA.iphoneSafari });
    let install = await freshInstall();
    expect(install.installTipDismissed()).toBe(false);
    install.dismissInstallTip();
    expect(install.installTipDismissed()).toBe(true);
    expect(saved.get("crewtavo.install-tip.dismissed")).toBe("1");

    // The app opened again later.
    install = await freshInstall();
    expect(install.installTipDismissed()).toBe(true);
  });

  it("with storage turned off, the tip still goes away (until the app is opened again) and nothing breaks", async () => {
    const blocked = {
      getItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      },
      removeItem: () => undefined,
    } as unknown as Storage;
    device({ userAgent: UA.iphoneSafari, storage: blocked });
    const install = await freshInstall();
    expect(install.installTipDismissed()).toBe(false);
    expect(() => install.dismissInstallTip()).not.toThrow();
    expect(install.installTipDismissed()).toBe(true);
  });
});

describe("zooming", () => {
  afterEach(() => vi.unstubAllGlobals());

  const tag = read("index.html").match(/<meta name="viewport" content="([^"]*)"/)![1]!;

  /** The page's viewport tag and a pinch in Safari (its `gesturestart`), in a browser tab or the installed app. */
  async function pinch(settings: { userAgent: string; standalone?: boolean }) {
    const { win } = device(settings);
    let content = tag;
    const viewport = { getAttribute: () => content, setAttribute: (_: string, value: string) => void (content = value) };
    const document = Object.assign(new EventTarget(), { querySelector: () => viewport, documentElement: { style: { touchAction: "" } } });
    const { lockZoomInApp } = await freshInstall();
    lockZoomInApp(Object.assign(win, { document }) as unknown as Window);
    const gesture = new Event("gesturestart", { cancelable: true });
    document.dispatchEvent(gesture);
    return { content, refused: gesture.defaultPrevented, touchAction: document.documentElement.style.touchAction };
  }

  it("is off in the installed app, on an iPhone and on Android, keeping the notch settings", async () => {
    for (const userAgent of [UA.iphoneSafari, UA.androidChrome]) {
      const app = await pinch({ userAgent, standalone: true });
      expect(app.content).toBe(`${tag}, maximum-scale=1, user-scalable=no`);
      expect(app.content).toContain("viewport-fit=cover");
      expect(app.refused).toBe(true); // Safari ignores user-scalable=no
      expect(app.touchAction).toBe("manipulation"); // no double-tap zoom
    }
  });

  it("stays on in a browser tab, where the page itself allows it", async () => {
    expect(tag).not.toMatch(/user-scalable|maximum-scale/);
    for (const userAgent of [UA.iphoneSafari, UA.androidChrome, UA.windowsChrome]) {
      expect(await pinch({ userAgent })).toEqual({ content: tag, refused: false, touchAction: "" });
    }
    expect(read("src/main.tsx")).toMatch(/\nlockZoomInApp\(\);\n/);
  });
});

// --- Updates waiting while the app is closed ---------------------------------------------------------

describe("the service worker, when the phone has signal again (Background Sync)", () => {
  let caches: FakeCaches;
  beforeEach(async () => {
    caches = new FakeCaches();
    const cache = await caches.open(WAITING_CACHE);
    await cache.put("/waiting/u1", new Response("2"));
    await cache.put("/waiting/u2", new Response("1"));
  });

  it("with Crewtavo closed, shows one notification saying how many updates wait, which opens the app", async () => {
    const sw = loadServiceWorker({ caches, windows: [] });
    await expect(sw.dispatch("sync", { tag: SYNC_TAG })).resolves.toBe("done");
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = sw.showNotification.mock.calls[0]!;
    expect(title).toBe("Crewtavo");
    expect(options).toMatchObject({ body: "3 updates are waiting to be sent. Open Crewtavo to send them.", tag: SYNC_TAG, data: { link: "/field" } });

    // Tapping it opens Crewtavo on My day.
    await sw.dispatch("notificationclick", { notification: { close: () => undefined, data: options.data } });
    expect(sw.openWindow).toHaveBeenCalledWith("https://crew.example.com/field");
  });

  it("says “1 update is” for one", async () => {
    const one = new FakeCaches();
    await (await one.open(WAITING_CACHE)).put("/waiting/u1", new Response("1"));
    const sw = loadServiceWorker({ caches: one });
    await sw.dispatch("sync", { tag: SYNC_TAG });
    expect(sw.showNotification.mock.calls[0]![1]).toMatchObject({ body: "1 update is waiting to be sent. Open Crewtavo to send them." });
  });

  it("with Crewtavo on the screen, leaves it to the app, and fails so the browser asks again later (unless it's the last try)", async () => {
    const sw = loadServiceWorker({ caches, windows: ["https://crew.example.com/field"] });
    await expect(sw.dispatch("sync", { tag: SYNC_TAG })).rejects.toThrow(/open/);
    await expect(sw.dispatch("sync", { tag: SYNC_TAG, lastChance: true })).resolves.toBe("done");
    // On the screen next to another app (split screen) counts, focused or not.
    const beside = loadServiceWorker({ caches, windows: [{ url: "https://crew.example.com/field", visibilityState: "visible", focused: false }] });
    await expect(beside.dispatch("sync", { tag: SYNC_TAG })).rejects.toThrow(/open/);
    expect(sw.showNotification).not.toHaveBeenCalled();
    expect(beside.showNotification).not.toHaveBeenCalled();
  });

  it("with Crewtavo put away (in a pocket, behind another app), says so all the same: the app sends nothing until it's back on the screen", async () => {
    // React Query only carries on with a paused action while the page is visible.
    const hidden = { url: "https://crew.example.com/field", visibilityState: "hidden" } as const;
    const sw = loadServiceWorker({ caches, windows: [hidden, "https://elsewhere.example.com/"] });
    await expect(sw.dispatch("sync", { tag: SYNC_TAG })).resolves.toBe("done");
    expect(sw.showNotification.mock.calls[0]![1]).toMatchObject({ body: "3 updates are waiting to be sent. Open Crewtavo to send them.", tag: SYNC_TAG });
    const last = loadServiceWorker({ caches, windows: [hidden] });
    await expect(last.dispatch("sync", { tag: SYNC_TAG, lastChance: true })).resolves.toBe("done");
    expect(last.showNotification).toHaveBeenCalledTimes(1);

    // Tapping it brings that window back on the screen as it was, which sends them: going to My day
    // would load the page again and lose a note typed there, or checklist answers not saved.
    const { tag, data } = sw.showNotification.mock.calls[0]![1];
    await sw.dispatch("notificationclick", { notification: { close: () => undefined, tag, data } });
    expect(sw.windows[0]!.focus).toHaveBeenCalled();
    expect(sw.windows[0]!.navigate).not.toHaveBeenCalled();
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it("doesn't count a client's page (Client Hub, a booking form) as Crewtavo: it holds nothing back, and the notice opens the app itself", async () => {
    const hub = { url: "https://crew.example.com/hub/tok123", visibilityState: "visible", focused: true } as const;
    const sw = loadServiceWorker({ caches, windows: [hub] });
    await expect(sw.dispatch("sync", { tag: SYNC_TAG })).resolves.toBe("done");
    const { tag, data } = sw.showNotification.mock.calls[0]![1];
    await sw.dispatch("notificationclick", { notification: { close: () => undefined, tag, data } });
    expect(sw.windows[0]!.navigate).not.toHaveBeenCalled();
    expect(sw.openWindow).toHaveBeenCalledWith("https://crew.example.com/field");

    // With the app put away behind a booking form, it's the app that comes back.
    const both = loadServiceWorker({ caches, windows: ["https://crew.example.com/book/acme/quote", { url: "https://crew.example.com/visit/v1", visibilityState: "hidden" }] });
    await both.dispatch("notificationclick", { notification: { close: () => undefined, tag, data } });
    expect(both.windows[0]!.focus).not.toHaveBeenCalled();
    expect(both.windows[1]!.focus).toHaveBeenCalled();
    expect(both.windows[1]!.navigate).not.toHaveBeenCalled();
    expect(both.openWindow).not.toHaveBeenCalled();
  });

  it("still opens what a pushed notification links to in a window that's open", async () => {
    const sw = loadServiceWorker({ windows: [{ url: "https://crew.example.com/field", visibilityState: "hidden" }] });
    await sw.dispatch("notificationclick", { notification: { close: () => undefined, tag: "visit-moved", data: { link: "/schedule" } } });
    expect(sw.windows[0]!.focus).toHaveBeenCalled();
    expect(sw.windows[0]!.navigate).toHaveBeenCalledWith("https://crew.example.com/schedule");
  });

  it("stays quiet with notifications not allowed, with nothing waiting, and for other sync tags", async () => {
    const blocked = loadServiceWorker({ caches, permission: "default" });
    await expect(blocked.dispatch("sync", { tag: SYNC_TAG })).resolves.toBe("done");
    expect(blocked.showNotification).not.toHaveBeenCalled();

    const empty = loadServiceWorker({ caches: new FakeCaches() });
    await expect(empty.dispatch("sync", { tag: SYNC_TAG })).resolves.toBe("done");
    expect(empty.showNotification).not.toHaveBeenCalled();

    const other = loadServiceWorker({ caches });
    await expect(other.dispatch("sync", { tag: "something-else" })).resolves.toBe("unhandled");
    expect(other.showNotification).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps the count when a new version of the worker takes over (offline: %s)", async (offline) => {
    await caches.open("crewtavo-app-v0");
    const sw = loadServiceWorker({ caches, offline });
    await sw.dispatch("activate");
    expect(caches.entries(WAITING_CACHE)).toEqual({ "/waiting/u1": "2", "/waiting/u2": "1" });
    expect(await caches.keys()).not.toContain("crewtavo-app-v0");
  });
});

describe("the service worker, offline (production builds)", () => {
  it("fetches the manifest from the network, so installed apps get new icons and shortcuts, and keeps a copy for no signal", async () => {
    let online = true;
    const caches = new FakeCaches();
    const network = vi.fn(async () => (online ? new Response('{"name":"Crewtavo","v":2}') : Promise.reject(new TypeError("Failed to fetch"))));
    await (await caches.open("crewtavo-app-v2")).put("/manifest.webmanifest", new Response('{"name":"Crewtavo","v":1}'));
    const sw = loadServiceWorker({ caches, offline: true, network });
    const request = { url: "https://crew.example.com/manifest.webmanifest", method: "GET", mode: "cors" };

    const fresh = (await sw.dispatch("fetch", { request })) as Response;
    expect(await fresh.text()).toBe('{"name":"Crewtavo","v":2}');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(caches.entries("crewtavo-app-v2")["/manifest.webmanifest"]).toBe('{"name":"Crewtavo","v":2}');

    online = false;
    const saved = (await sw.dispatch("fetch", { request })) as Response;
    expect(await saved.text()).toBe('{"name":"Crewtavo","v":2}');
  });

  it("never keeps a stored file, so one moved to the Trash stops opening; pictures of the app itself are still kept", async () => {
    const caches = new FakeCaches();
    const network = vi.fn(async () => new Response("picture"));
    const sw = loadServiceWorker({ caches, offline: true, network });
    const stored = { url: "https://crew.example.com/storage/v1/object/sign/files/c1/plans/f1.png?token=abc", method: "GET", mode: "cors" };
    expect(await sw.dispatch("fetch", { request: stored })).toBe("unhandled");
    expect(network).not.toHaveBeenCalled();

    const icon = { url: "https://crew.example.com/icon-192.png", method: "GET", mode: "no-cors" };
    expect(await ((await sw.dispatch("fetch", { request: icon })) as Response).text()).toBe("picture");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Object.keys(caches.entries("crewtavo-app-v2"))).toEqual(["/icon-192.png"]);
  });

  it("empties what the last version kept when this one takes over (stored pictures among it)", async () => {
    const caches = new FakeCaches();
    await (await caches.open("crewtavo-app-v1")).put("/storage/v1/object/sign/files/c1/visit/v1/p.png", new Response("old"));
    const sw = loadServiceWorker({ caches, offline: true });
    await sw.dispatch("activate");
    expect(await caches.keys()).not.toContain("crewtavo-app-v1");
  });
});

it("the app and the worker agree on the sync tag and where the count is kept", () => {
  const sw = read("public/sw.js");
  expect(sw).toContain(`const SYNC_TAG = "${SYNC_TAG}";`);
  expect(sw).toContain(`const WAITING = "${WAITING_CACHE}";`);
  expect(existsSync(file("public/icon-maskable-512.png"))).toBe(true);
});
