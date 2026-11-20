/**
 * Whose language the app is in (lib/i18n.tsx): always the signed-in person's own, never one left on
 * a shared device by whoever used it before; a language picked on the sign-in page is saved with
 * the person who then signs in; opening in Spanish never hangs on its file; a language that can't
 * be kept doesn't reload the page for ever; and dates follow the language of the screen.
 */
import { getLocale, setLanguageChoice, setLocale } from "@crewtavo/core/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToasts } from "../src/lib/toast";

const {
  askedHere, canReloadInto, deviceLocale, followProfile, forgetLanguageAtSignOut, inEnglish, intlLocale, languageAtSignIn, loadSpanish, noteAsked, onSpanishScreen, openingLocale,
  pickAtSignIn, pickedAtSignIn, PICK_LASTS_MS, screenIntlLocale, screenLang, showScreenLang, spanishDidntLoad, startLocale, switchLocale, tellIfSpanishDidntLoad,
} = await import("../src/lib/i18n");
const { formatDay } = await import("../src/lib/format");

/** A device's storage, which a test can fill up (nothing more can be written). */
function storageOf(store: Map<string, string>, state: { full: boolean }) {
  return {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (state.full) throw new Error("QuotaExceededError");
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
  };
}

const device = new Map<string, string>();
const tab = new Map<string, string>();
const state = { full: false };
const reload = vi.fn();
const page = { pathname: "/field", search: "", reload };
const SIGNED_IN = "sb-crew-auth-token";

beforeEach(() => {
  device.clear();
  tab.clear();
  state.full = false;
  reload.mockClear();
  Object.assign(page, { pathname: "/field", search: "" });
  const local = storageOf(device, state);
  // Object.keys(localStorage) is how a saved sign-in is found.
  vi.stubGlobal("localStorage", new Proxy(local, { ownKeys: () => [...device.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }));
  vi.stubGlobal("sessionStorage", storageOf(tab, state));
  vi.stubGlobal("window", { location: page });
  vi.stubGlobal("document", { documentElement: { lang: "en" } });
  setLocale("en");
  setLanguageChoice(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setLocale("en");
  setLanguageChoice(false);
});

/** Their profile's language is saved by the server; here, by the test. */
const saving = () => {
  const saved: string[] = [];
  return { saved, save: async (locale: string) => void saved.push(locale) };
};

describe("with no choice of language", () => {
  beforeEach(() => setLanguageChoice(false));

  it("opens in English, whatever the device kept for whoever is signed in", async () => {
    device.set(SIGNED_IN, "{}");
    device.set("crewtavo.locale", "es");
    const load = vi.fn();
    await startLocale();
    expect(getLocale()).toBe("en");
    expect(load).not.toHaveBeenCalled();
  });

  it("stays in English for someone whose profile says Spanish, and keeps nothing of it on the device", async () => {
    device.set(SIGNED_IN, "{}");
    device.set("crewtavo.locale", "es");
    await startLocale();
    const maria = saving();
    await followProfile("es", maria.save);
    expect(reload).not.toHaveBeenCalled();
    expect(maria.saved).toEqual([]);
    expect(deviceLocale()).toBeNull();
    expect(getLocale()).toBe("en");
  });
});

describe("a shared device", () => {
  it("is English for the next person: Maria's Spanish leaves with her when she signs out", async () => {
    // Maria, who uses Spanish, signed in on the shop tablet: it holds her language, and that My day asked her.
    device.set(SIGNED_IN, "{}");
    await startLocale();
    await followProfile("es", saving().save);
    noteAsked("maria");
    expect(deviceLocale()).toBe("es");
    // (The page reloads into her Spanish.)
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockClear();
    setLocale("es");

    // She signs out.
    device.delete(SIGNED_IN);
    forgetLanguageAtSignOut();
    expect(deviceLocale()).toBeNull();
    expect(askedHere("maria")).toBe(false);
    expect(getLocale()).toBe("en");
    expect([...device.keys()].filter((k) => k.startsWith("crewtavo.locale"))).toEqual([]);

    // Bob, who never chose a language, signs in: English, nothing reloads into Spanish, nothing is saved for him.
    device.set(SIGNED_IN, "{}");
    const bob = saving();
    await followProfile(null, bob.save);
    expect(reload).not.toHaveBeenCalled();
    expect(bob.saved).toEqual([]);
    expect(deviceLocale()).toBeNull();
    expect(askedHere("bob")).toBe(false);
  });

  it("doesn't open in a language left on it by someone before (an older version never cleared it)", async () => {
    device.set("crewtavo.locale", "es");
    await startLocale();
    expect(getLocale()).toBe("en");
    expect(deviceLocale()).toBeNull();
    expect(openingLocale("es", false, null)).toBe("en");
    // Signed in, it's theirs; picked on the sign-in page a moment ago, it's for whoever signs in next.
    expect(openingLocale("es", true, null)).toBe("es");
    expect(openingLocale("es", false, "es")).toBe("es");
    expect(openingLocale(null, true, null)).toBe("en");
  });

  it("puts someone who is signed in with no choice of their own back in English, once, when the device still holds another's Spanish", async () => {
    // Bob signed in before the update, on a tablet Maria had left in Spanish: it opens in Spanish for him.
    device.set(SIGNED_IN, "{}");
    device.set("crewtavo.locale", "es");
    await startLocale();
    expect(getLocale()).toBe("es");
    await followProfile(null, saving().save);
    expect(deviceLocale()).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("changes nothing while the server is one from before languages (mid-update): it says nothing about theirs", async () => {
    device.set(SIGNED_IN, "{}");
    device.set("crewtavo.locale", "es");
    await startLocale();
    const none = saving();
    await followProfile(undefined, none.save);
    expect(deviceLocale()).toBe("es");
    expect(reload).not.toHaveBeenCalled();
    expect(none.saved).toEqual([]);
  });

  it("asks each person for themselves on My day", () => {
    noteAsked("maria");
    expect(askedHere("maria")).toBe(true);
    expect(askedHere("bob")).toBe(false);
  });
});

describe("a language picked on the sign-in page", () => {
  it("belongs to the person who then signs in: saved with them, so their bell and their pushes agree", async () => {
    pickAtSignIn("es");
    expect(deviceLocale()).toBe("es");
    expect(pickedAtSignIn()).toBe("es");
    // The page reloads into it; then Ana signs in. She had never chosen.
    expect(reload).toHaveBeenCalledTimes(1);
    setLocale("es");
    await startLocale().catch(() => undefined);
    const ana = saving();
    await followProfile(null, ana.save);
    expect(ana.saved).toEqual(["es"]);
    expect(deviceLocale()).toBe("es");
    // Used up: it isn't there for anyone after her.
    expect(pickedAtSignIn()).toBeNull();
  });

  it("is their newest choice, over what they chose before; the same choice saves nothing", () => {
    expect(languageAtSignIn("en", "es")).toEqual({ locale: "es", save: true });
    expect(languageAtSignIn("es", "es")).toEqual({ locale: "es", save: false });
    expect(languageAtSignIn(null, "en")).toEqual({ locale: "en", save: true });
    // No pick: their own, else English.
    expect(languageAtSignIn("es", null)).toEqual({ locale: "es", save: false });
    expect(languageAtSignIn(null, null)).toEqual({ locale: "en", save: false });
    expect(languageAtSignIn(undefined, null)).toEqual({ locale: "en", save: false });
  });

  it("never carries to the next person: it lapses when nobody signs in, and goes at sign-out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T15:00:00Z"));
    pickAtSignIn("es");
    expect(pickedAtSignIn()).toBe("es");
    // Whoever picked it walked away. Bob signs in that afternoon.
    vi.setSystemTime(new Date(Date.parse("2026-11-13T15:00:00Z") + PICK_LASTS_MS + 1));
    expect(pickedAtSignIn()).toBeNull();
    await startLocale();
    expect(getLocale()).toBe("en");
    const bob = saving();
    await followProfile(null, bob.save);
    expect(bob.saved).toEqual([]);
    expect(deviceLocale()).toBeNull();

    pickAtSignIn("es");
    forgetLanguageAtSignOut();
    expect(pickedAtSignIn()).toBeNull();
  });

  it("is tried again later when it couldn't be saved with them, and their screens are in it meanwhile", async () => {
    pickAtSignIn("es");
    await followProfile(null, async () => {
      throw new Error("Failed to fetch");
    });
    expect(deviceLocale()).toBe("es");
    expect(pickedAtSignIn()).toBe("es");
    const later = saving();
    await followProfile(null, later.save);
    expect(later.saved).toEqual(["es"]);
  });
});

describe("opening the app in Spanish", () => {
  const lines = { installSpanish: () => undefined };

  it("doesn't hang on a blank screen: past a few seconds it opens in English", async () => {
    vi.useFakeTimers();
    // One bar: the file never arrives.
    const opening = loadSpanish(() => new Promise(() => undefined), 4000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await opening).toBe(false);
    expect(getLocale()).toBe("en");
  });

  it("opens in English when the file can't be had at all, and in Spanish when it comes", async () => {
    expect(await loadSpanish(() => Promise.reject(new TypeError("Failed to fetch")), 4000)).toBe(false);
    expect(getLocale()).toBe("en");
    expect(await loadSpanish(async () => lines, 4000)).toBe(true);
    expect(getLocale()).toBe("es");
  });

  it("says so once, with a way to try again, and choosing Español again tries again", async () => {
    // Signed in as someone who uses Spanish, and the file didn't load: the app is in English.
    device.set(SIGNED_IN, "{}");
    device.set("crewtavo.locale", "es");
    vi.doMock("@crewtavo/core/i18n/es", () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    await startLocale();
    vi.doUnmock("@crewtavo/core/i18n/es");
    expect(getLocale()).toBe("en");
    expect(spanishDidntLoad()).toBe(true);

    const before = getToasts().length;
    tellIfSpanishDidntLoad();
    const told = getToasts().slice(before);
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toBe("No se pudo cargar el español");
    expect(told[0]!.description).toContain("Crewtavo is in English for now");
    told[0]!.action!.onClick();
    expect(reload).toHaveBeenCalledTimes(1);
    // Not again at every reload of the same visit to the app.
    tellIfSpanishDidntLoad();
    expect(getToasts().slice(before)).toHaveLength(1);

    // The Español switch (the sign-in page's, or Settings → Profile): the app isn't in it, so it tries again.
    reload.mockClear();
    tab.delete("crewtavo.locale-reloaded");
    switchLocale("es");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("a language the device can't keep", () => {
  it("doesn't reload for ever: with storage full, the page stays as it is", async () => {
    device.set(SIGNED_IN, "{}");
    await startLocale();
    state.full = true;
    // Their profile says Spanish, the device can't hold it: a reload would open in English again, and reload again.
    await followProfile("es", saving().save);
    expect(reload).not.toHaveBeenCalled();
    switchLocale("es");
    expect(reload).not.toHaveBeenCalled();
  });

  it("doesn't reload twice in a row into a language it still isn't in", () => {
    const now = Date.parse("2026-11-13T15:00:00Z");
    expect(canReloadInto("es", "es", null, now)).toBe(true);
    expect(canReloadInto("es", null, null, now)).toBe(false);
    expect(canReloadInto("en", null, null, now)).toBe(true);
    expect(canReloadInto("es", "es", `es:${now - 3_000}`, now)).toBe(false);
    // Into the other language, or a while later: fine.
    expect(canReloadInto("en", "en", `es:${now - 3_000}`, now)).toBe(true);
    expect(canReloadInto("es", "es", `es:${now - 60_000}`, now)).toBe(true);
  });
});

describe("the language the page says it's in (<html lang>)", () => {
  it("is Spanish on the crew's screens for someone using Spanish, and English on the office's, which still are", () => {
    for (const path of ["/field", "/field/visits/v1", "/chat", "/kb/p1", "/schedule", "/timesheets", "/paperwork/tok"]) {
      expect(screenLang("es", path), path).toBe("es");
      expect(screenLang("en", path), path).toBe("en");
    }
    for (const path of ["/", "/jobs", "/invoices/i1", "/clients", "/finance", "/chat/settings", "/kb/new", "/marketing", "/roofing/r1/visit"]) expect(screenLang("es", path), path).toBe("en");
    expect(screenLang("es", "/settings", "?tab=profile")).toBe("es");
    expect(screenLang("es", "/settings", "?tab=company")).toBe("en");
  });

  it("is Spanish on the sign-in page for someone who picked Spanish there, whatever the address", () => {
    expect(screenLang("es", "/", "", false)).toBe("es");
    expect(screenLang("es", "/invoices/i1", "", false)).toBe("es");
    expect(screenLang("en", "/", "", false)).toBe("en");
  });

  it("is always English on the pages clients open", () => {
    for (const path of ["/hub/tok", "/book/acme/estimate", "/u/tok", "/refer/tok", "/s/tok"]) {
      expect(screenLang("es", path), path).toBe("en");
      expect(screenLang("es", path, "", false), path).toBe("en");
    }
  });

  it("follows the screen as someone moves between them, and is right as the app opens", async () => {
    setLocale("es");
    showScreenLang("/field");
    expect(document.documentElement.lang).toBe("es");
    // Into the office: the words are English, and so is what a screen reader is told.
    showScreenLang("/invoices");
    expect(document.documentElement.lang).toBe("en");
    showScreenLang("/timesheets");
    expect(document.documentElement.lang).toBe("es");
    // Opening straight onto an office screen, signed in with Spanish on the device.
    device.set(SIGNED_IN, "{}");
    device.set("crewtavo.locale", "es");
    page.pathname = "/jobs";
    await startLocale();
    expect(getLocale()).toBe("es");
    expect(document.documentElement.lang).toBe("en");
    page.pathname = "/field";
    await startLocale();
    expect(document.documentElement.lang).toBe("es");
  });

  it("is set by the app's shell at every move, and the navigation says it's in Spanish on an English screen", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(new URL("../src/components/shell/AppShell.tsx", import.meta.url), "utf8");
    expect(shell).toContain("showScreenLang(location.pathname, location.search);");
    expect(shell).toContain("}, [location.pathname, location.search]);");
    expect(shell).toContain('const shellLang = getLocale() === "es" ? "es" : undefined;');
    for (const part of ['<aside className="sidebar" aria-label={t("Primary")} lang={shellLang}>', '<header className="topbar" data-scrolled={scrolled || undefined} lang={shellLang}>', 'lang={shellLang} data-typing']) expect(shell).toContain(part);
    // And the sign-in page says its own.
    expect(readFileSync(new URL("../src/features/auth/LoginPage.tsx", import.meta.url), "utf8")).toContain("useEffect(() => showScreenLang(window.location.pathname, window.location.search, false), []);");
  });
});

describe("dates and times", () => {
  it("are Spanish on the screens that are in Spanish, and English on the office's, for someone using Spanish", () => {
    for (const path of ["/field", "/field/visits/v1", "/field/jobs", "/chat", "/chat/c1", "/kb", "/kb/p1", "/schedule", "/timesheets", "/paperwork/tok"]) {
      expect(screenIntlLocale("es", path), path).toBe("es-US");
      expect(screenIntlLocale("en", path), path).toBe("en-US");
    }
    for (const path of ["/", "/jobs", "/jobs/j1", "/invoices", "/quotes/q1", "/clients", "/finance", "/chat/settings", "/kb/new", "/kb/insights", "/kb/p1/edit", "/equipment", "/subs", "/marketing", "/payouts"]) {
      expect(screenIntlLocale("es", path), path).toBe("en-US");
    }
    // Settings: their own profile is in Spanish, the office's tabs aren't.
    expect(onSpanishScreen("/settings", "?tab=profile")).toBe(true);
    expect(onSpanishScreen("/settings", "")).toBe(true);
    expect(onSpanishScreen("/settings", "?tab=company")).toBe(false);
  });

  it("follow the screen as it's drawn", () => {
    setLocale("es");
    page.pathname = "/field";
    expect(intlLocale()).toBe("es-US");
    expect(formatDay("2026-10-15T12:00:00")).toBe("jue, 15 de oct");
    page.pathname = "/invoices";
    expect(intlLocale()).toBe("en-US");
    expect(formatDay("2026-10-15T12:00:00")).toBe("Thu, Oct 15");
  });

  it("are always English in a file that's downloaded, whatever screen it's made on", () => {
    setLocale("es");
    page.pathname = "/timesheets";
    expect(formatDay("2026-10-15T12:00:00")).toBe("jue, 15 de oct");
    expect(inEnglish(() => formatDay("2026-10-15T12:00:00"))).toBe("Thu, Oct 15");
    // And back to the screen's once the file is made, also when making it fails.
    expect(() => inEnglish(() => { throw new Error("no"); })).toThrow("no");
    expect(intlLocale()).toBe("es-US");
  });
});
