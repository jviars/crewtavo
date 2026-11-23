/**
 * The pages a business's clients open (the Client Hub, a booking form, an unsubscribe link, a
 * referral page, a job showcase, a guide shared by link) are treated as theirs everywhere: light theme and English
 * whatever the device last ran Crewtavo in (so `lang` is right for a screen reader: WCAG 3.1.1), no
 * "Install Crewtavo", and left alone by the crew's service worker. Each of those is its own list of
 * paths, in a file that can't import the others, so this holds every list to the routes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The first part of each client-facing route's path, from the router itself. */
function clientRoutes(): string[] {
  const routes = read("src/routes.tsx");
  const block = routes.slice(routes.indexOf("// Client-facing pages work without an account."), routes.indexOf("// A subcontractor's link"));
  return [...block.matchAll(/\{ path: "([a-z]+)\//g)].map((m) => m[1]!);
}

/** Every regular expression in a file that lists the clients' pages, as the file wrote it. */
function lists(path: string): RegExp[] {
  return [...read(path).matchAll(/\/(\^\\\/\((?:[^/\\]|\\.)*\bhub\b(?:[^/\\]|\\.)*(?:\\\/|\(\\\/\|\$\)))\//g)].map((m) => new RegExp(m[1]!));
}

const FILES: Array<[path: string, lists: number, what: string]> = [
  ["src/lib/theme.ts", 1, "the light theme"],
  ["src/lib/i18n.tsx", 1, "English, and lang=\"en\""],
  ["src/lib/install.ts", 1, "no install prompt"],
  ["index.html", 2, "the theme and the language before the app loads"],
  ["public/sw.js", 2, "left alone by the service worker"],
];

describe("the pages clients open", () => {
  const routes = clientRoutes();

  it("are the hub, booking forms, unsubscribe links, referral pages, showcases and shared guides", () => {
    expect(routes).toEqual(["hub", "book", "u", "refer", "s", "g"]);
  });

  for (const [path, count, what] of FILES) {
    it(`are all listed in ${path} (${what})`, () => {
      const found = lists(path);
      expect(found, path).toHaveLength(count);
      for (const list of found) {
        for (const route of routes) expect(list.test(`/${route}/0123456789abcdef`), `${path}: /${route}/…`).toBe(true);
        // The crew's own screens that start with the same letters aren't clients' pages.
        for (const app of ["/schedule", "/settings", "/subs/1099", "/field", "/timesheets", "/users", "/"]) expect(list.test(app), `${path}: ${app}`).toBe(false);
      }
    });
  }

  it("so a showcase opened on a phone set to dark, or to Español, is still light and still says it's in English", () => {
    for (const [path] of FILES) for (const list of lists(path)) expect(list.test("/s/0123456789abcdef0123456789abcdef"), path).toBe(true);
    // A guide shared by link is read by people outside the team, the same way.
    for (const [path] of FILES) for (const list of lists(path)) expect(list.test("/g/0123456789abcdef0123456789abcdef"), path).toBe(true);
    // The two checks index.html makes before the app loads.
    const html = read("index.html");
    expect(html).toContain('if (!/^\\/(hub|book|u|refer|s|g)\\//.test(location.pathname) && (theme === "dark"');
    expect(html).toContain('localStorage.getItem("crewtavo.locale") === "es" && !/^\\/(hub|book|u|refer|s|g)\\//.test(location.pathname)) document.documentElement.lang = "es";');
  });

  it("include, for the light theme only, the roofing visit's screens a homeowner reads and signs on the salesperson's iPad", () => {
    const theme = read("src/lib/theme.ts");
    const homeowner = new RegExp(theme.match(/const HOMEOWNER = \/(.+)\/;/)![1]!);
    for (const path of ["/roofing/8442f1b2/visit", "/roofing/8442f1b2/sign", "/roofing/8442f1b2/signed"]) expect(homeowner.test(path), path).toBe(true);
    for (const path of ["/roofing", "/roofing/8442f1b2", "/roofing/8442f1b2/visit/x", "/roofing/packages"]) expect(homeowner.test(path), path).toBe(false);
    expect(theme).toContain("!CLIENT_FACING.test(pathname) && !HOMEOWNER.test(pathname)");
    // Opened from inside the app, not by a fresh load: every signed-in screen looks again as the path changes.
    expect(read("src/lib/session.tsx")).toContain("useThemeForPage();");
    // index.html's theme check has the same list, so reloading one in dark mode doesn't flash dark first; its language check doesn't.
    const [themeCheck, localeCheck] = read("index.html").split('localStorage.getItem("crewtavo.locale")');
    expect(themeCheck).toContain(`!/${theme.match(/const HOMEOWNER = \/(.+)\/;/)![1]}/.test(location.pathname)`);
    expect(localeCheck).not.toContain("roofing");
    // Still the team's app otherwise: its language, the install prompt and offline.
    for (const [path] of FILES.slice(1)) if (path !== "index.html") expect(read(path), path).not.toMatch(/roofing\\?\/\[\^/);
  });
});
