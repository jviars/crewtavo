/**
 * The app's language: English, or Spanish for whoever chooses it (Settings → Profile → Language, My
 * day's question when the phone speaks Spanish, or the switch on the sign-in page). The translation
 * layer itself is @crewtavo/core/i18n; this keeps the choice and loads the Spanish lines.
 *
 * Whose choice it is. A language is always a person's own (profiles.locale, the same on every
 * phone they use), never the device's: a shop tablet or an office computer is shared.
 *   - Signed in, the app is in the person's language, English when they've never chosen. It's kept
 *     on the device while they're signed in, so the app opens in it straight away, with no signal too.
 *   - Signing out takes it off the device (with whether My day asked), and the sign-in page is
 *     English again for whoever is next.
 *   - Picked on the sign-in page, a language belongs to the person who then signs in: it's saved
 *     with them as they do (session.tsx), so their bell, pushes, emails and texts agree with their
 *     screens. A pick nobody followed with a sign-in lapses after an hour.
 * The phone's own language doesn't switch anyone over by itself: it only makes My day ask.
 *
 * Changing language reloads the page, so lists and labels made as the app loaded don't mix the two.
 * Spanish is its own file, downloaded only for someone using it (the service worker keeps it for
 * when there's no signal). When it can't be had in a few seconds the app opens in English and says
 * so once, with a way to try again; choosing Español again tries again too.
 *
 * Dates and times are written the Spanish way only on screens that are in Spanish. Office screens
 * are still in English, and keep English dates for someone who uses Spanish (screenIntlLocale).
 */
import { Fragment, type ReactNode } from "react";
import { getLocale, intlLocaleOf, isLocale, languageChoice, setLocale, t, type Locale } from "@crewtavo/core/i18n";
import { toast } from "./toast";

export { english, getLocale, isLocale, languageChoice, LOCALE_NAMES, msg, t, type Locale } from "@crewtavo/core/i18n";

const KEY = "crewtavo.locale";
/** When a language was picked on the sign-in page (a time, in milliseconds): it's for whoever signs in next, soon. */
const PICKED = "crewtavo.locale-picked";
/** That My day asked someone on this device (SpanishOffer.tsx), one mark for each person. */
const ASKED = "crewtavo.locale-asked";
/** How long a pick on the sign-in page waits for its sign-in. */
export const PICK_LASTS_MS = 60 * 60_000;
/** How long opening the app waits for the Spanish lines before opening in English. */
export const SPANISH_WAIT_MS = 4000;
/** When the page last reloaded to change language, so it can't do so over and over (sessionStorage). */
const RELOADED = "crewtavo.locale-reloaded";

/** The language kept on this device, or null for none. */
export function deviceLocale(): Locale | null {
  try {
    const value = localStorage.getItem(KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

function keepOnDevice(locale: Locale | null) {
  try {
    if (locale) localStorage.setItem(KEY, locale);
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: the choice lasts until the tab closes.
  }
}

/** The language picked on the sign-in page a little while ago, by whoever is about to sign in. */
export function pickedAtSignIn(now = Date.now()): Locale | null {
  try {
    const at = Number(localStorage.getItem(PICKED));
    return at > 0 && now >= at && now - at < PICK_LASTS_MS ? deviceLocale() : null;
  } catch {
    return null;
  }
}

const forgetPick = () => {
  try {
    localStorage.removeItem(PICKED);
  } catch {
    // Nothing kept, nothing to forget.
  }
};

/** Whether someone is signed in on this device, as far as it shows before the app has loaded (Supabase keeps the sign-in here). */
const signedInHere = () => {
  try {
    return Object.keys(localStorage).some((k) => /^sb-.+-auth-token$/.test(k));
  } catch {
    return false;
  }
};

/** Whether My day already asked this person on this device. */
export const askedHere = (userId: string) => {
  try {
    return localStorage.getItem(`${ASKED}:${userId}`) === "1";
  } catch {
    return false;
  }
};
export const noteAsked = (userId: string) => {
  try {
    localStorage.setItem(`${ASKED}:${userId}`, "1");
  } catch {
    // Private mode: saved with them all the same.
  }
};

/** What the language was meant to be as the app opened (Spanish can fail to load with no signal). */
let wanted: Locale = "en";

/** Pages for clients (their hub, booking forms, referral and unsubscribe links, a job showcase) stay in English for now. */
const CLIENT_FACING = /^\/(hub|book|u|refer|s|g)\//;

/**
 * Which language to open in, from what the device holds. What's kept is somebody's own only while
 * they're signed in here, or for a while after it was picked on the sign-in page: anything else is
 * left over from someone before, and the app is English.
 */
export function openingLocale(device: Locale | null, signedIn: boolean, picked: Locale | null): Locale {
  return signedIn || picked ? device ?? "en" : "en";
}

/**
 * Makes Spanish the app's language, if its lines arrive in time. They're a file of their own: on
 * one bar it can take a minute, and the app must not sit on a blank screen for it. Late, it still
 * finishes downloading, so trying again finds it there.
 */
export async function loadSpanish(load: () => Promise<{ installSpanish: () => void }> = () => import("@crewtavo/core/i18n/es"), waitMs = SPANISH_WAIT_MS): Promise<boolean> {
  try {
    const loading = load();
    const lines = await Promise.race([loading, new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs))]);
    if (!lines) {
      loading.catch(() => undefined);
      return false;
    }
    lines.installSpanish();
    setLocale("es");
    return true;
  } catch {
    // Not downloaded yet and no signal: English until it can be.
    return false;
  }
}

/** Loads the language for this device before the first screen shows. */
export async function startLocale() {
  const picked = pickedAtSignIn();
  const signedIn = signedInHere();
  if (!signedIn && !picked && deviceLocale()) {
    // Left over from whoever used this device before: not the next person's choice.
    keepOnDevice(null);
    forgetPick();
  }
  wanted = !languageChoice() || CLIENT_FACING.test(window.location.pathname) ? "en" : openingLocale(deviceLocale(), signedIn, picked);
  if (wanted === "es") await loadSpanish();
  showScreenLang(window.location.pathname, window.location.search, signedIn);
}

/** Spanish was wanted and couldn't be loaded: the app is in English for now. */
export const spanishDidntLoad = () => wanted === "es" && getLocale() !== "es";

/**
 * Says once (each time the app is opened, not at every reload) that Spanish couldn't be loaded,
 * with a way to try again. In both languages: the person reads Spanish, and the app is in English.
 */
export function tellIfSpanishDidntLoad() {
  if (!spanishDidntLoad()) return;
  const TOLD = "crewtavo.locale-told";
  try {
    if (sessionStorage.getItem(TOLD) === "1") return;
    sessionStorage.setItem(TOLD, "1");
  } catch {
    // Told again after a reload, then.
  }
  toast.warning("No se pudo cargar el español", {
    description: "Crewtavo está en inglés por ahora. Spanish couldn't be loaded, so Crewtavo is in English for now.",
    duration: 15_000,
    action: { label: "Reintentar · Try again", onClick: () => window.location.reload() },
  });
}

/**
 * Reloads into another language, unless that can't help: the device didn't take the new language
 * (storage full or off), so the page would open as it is now and reload again, for ever; or it
 * reloaded for this a moment ago and is still in the wrong one.
 */
function reloadInto(locale: Locale) {
  if (!canReloadInto(locale, deviceLocale(), readReloaded(), Date.now())) return false;
  try {
    sessionStorage.setItem(RELOADED, `${locale}:${Date.now()}`);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
const readReloaded = () => {
  try {
    return sessionStorage.getItem(RELOADED);
  } catch {
    return null;
  }
};

/**
 * Whether reloading can put the app in a language: the device must hold it now (English is also
 * what it opens in with nothing held), and the page mustn't have just reloaded into that same
 * language (`reloaded`: "es:1731500000000") and still not be in it.
 */
export function canReloadInto(locale: Locale, device: Locale | null, reloaded: string | null, now: number): boolean {
  if ((device ?? "en") !== locale) return false;
  const [to, at] = (reloaded ?? "").split(":");
  return !(to === locale && Number(at) > 0 && now - Number(at) < 10_000);
}

/**
 * Switches the app to a language now: kept on this device, and the page reloads into it. Asked for
 * the language it was meant to be in already but isn't (Spanish didn't load), it tries again.
 */
export function switchLocale(locale: Locale) {
  keepOnDevice(locale);
  if (locale !== getLocale()) reloadInto(locale);
  else wanted = locale;
}

/** The sign-in page's switch: for whoever signs in next, and saved with them as they do. */
export function pickAtSignIn(locale: Locale) {
  try {
    localStorage.setItem(PICKED, String(Date.now()));
  } catch {
    // Private mode: it lasts until the tab closes, and isn't saved with them.
  }
  switchLocale(locale);
}

/**
 * The language for someone who has just signed in, and whether to save it with them: what they
 * picked on the sign-in page (their newest choice), else what they chose before, else English.
 */
export function languageAtSignIn(profile: string | null | undefined, picked: Locale | null): { locale: Locale; save: boolean } {
  if (picked) return { locale: picked, save: picked !== profile };
  return { locale: isLocale(profile) ? profile : "en", save: false };
}

/**
 * Once the signed-in person is known: the app is in their language, never in one left on the
 * device by someone else. A language picked on the sign-in page is saved with them first (`save`
 * resolves once their profile has it); if that fails it's tried again the next time the app opens.
 * Reloads when that means another language than the one the app opened in.
 */
export async function followProfile(profileLocale: string | null | undefined, save: (locale: Locale) => Promise<void>) {
  // A server from before languages (mid-update) says nothing about theirs: left as the app opened, until it does.
  if (profileLocale === undefined) return;
  if (!languageChoice()) {
    // English for everyone: nothing of a language is kept on the device.
    keepOnDevice(null);
    forgetPick();
    return;
  }
  const { locale, save: saves } = languageAtSignIn(profileLocale, pickedAtSignIn());
  if (saves) {
    try {
      await save(locale);
      forgetPick();
    } catch {
      // Their screens are in it meanwhile; their profile gets it at the next try.
    }
  } else {
    forgetPick();
  }
  // Theirs, kept for opening the app next time. English with no choice made needs nothing kept.
  keepOnDevice(isLocale(profileLocale) || saves ? locale : null);
  if (locale !== wanted) reloadInto(locale);
}

/**
 * Signing out, on purpose or by the app: the language and My day's "asked" marks leave the device
 * with the person, and the sign-in page is in English for whoever is next (English needs no
 * loading, and the sign-in page is drawn afresh).
 */
export function forgetLanguageAtSignOut() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(PICKED);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(ASKED)) localStorage.removeItem(k);
    }
  } catch {
    // Nothing was kept.
  }
  wanted = "en";
  setLocale("en");
  if (typeof document !== "undefined") document.documentElement.lang = "en";
}

/**
 * Whether a screen is in Spanish for someone using it: their day and visits, chat, reading guides,
 * the schedule, timesheets, their own profile and a sub's paperwork link. Everything else (the
 * office's screens, and the ones for editing guides and setting up chat) is still in English.
 */
export function onSpanishScreen(pathname: string, search = ""): boolean {
  const [, first = "", second, third] = pathname.split("/");
  if (first === "field" || first === "schedule" || first === "timesheets") return true;
  if (first === "chat") return second !== "settings";
  if (first === "kb") return second === undefined || (second !== "new" && second !== "insights" && third === undefined);
  if (first === "paperwork") return Boolean(second);
  // Settings opens on the person's own profile for everyone but an admin; the other tabs are the office's.
  if (first === "settings") return (new URLSearchParams(search).get("tab") ?? "profile") === "profile";
  return false;
}

/**
 * The language a page says it's in (<html lang>), which is what a screen reader pronounces it in
 * (WCAG 3.1.1): Spanish only on a screen that's in Spanish for someone using Spanish. Not signed
 * in, that's the sign-in page, which is in the language picked on it. An office screen is still in
 * English, and says so, with the app's own navigation around it marked as Spanish (the shell).
 */
export function screenLang(locale: Locale, pathname: string, search = "", signedIn = true): Locale {
  if (locale !== "es" || CLIENT_FACING.test(pathname)) return "en";
  return !signedIn || onSpanishScreen(pathname, search) ? "es" : "en";
}

/** Sets <html lang> for the screen showing: as the app opens, and at every move between screens (the app's shell). */
export function showScreenLang(pathname: string, search = "", signedIn = true) {
  if (typeof document !== "undefined") document.documentElement.lang = screenLang(getLocale(), pathname, search, signedIn);
}

/** How many inEnglish runs are under way: formats are English while any is. */
let forcedEnglish = 0;

/**
 * How dates, times and numbers are written on the screen showing: "es-US" on a screen that's in
 * Spanish for someone using Spanish, "en-US" everywhere else, so an English office screen never
 * shows "jue, 15 de oct" in the middle of English.
 */
export function screenIntlLocale(locale: Locale, pathname: string, search = ""): "en-US" | "es-US" {
  return locale === "es" && onSpanishScreen(pathname, search) ? "es-US" : "en-US";
}

/** The Intl tag for what's being drawn now: the screen's (screenIntlLocale), or en-US inside inEnglish. */
export const intlLocale = () => {
  if (forcedEnglish > 0) return "en-US";
  // With no page (the tests), the language alone decides.
  if (typeof window === "undefined" || !window.location) return intlLocaleOf(getLocale());
  return screenIntlLocale(getLocale(), window.location.pathname, window.location.search);
};

/**
 * Runs something with dates, times and numbers written the English way whatever the screen: a
 * file to download (a CSV for payroll or a bookkeeper) is always en-US.
 */
export function inEnglish<R>(run: () => R): R {
  forcedEnglish++;
  try {
    return run();
  } finally {
    forcedEnglish--;
  }
}

/** For dates shown in the browser's own way: its language in English (as before), es-US on a screen in Spanish. */
export const browserOrSpanish = () => (intlLocale() === "es-US" ? "es-US" : undefined);

/** Whether the phone or browser is set to Spanish (for offering it, never for switching unasked). */
export const phoneSpeaksSpanish = () => {
  try {
    return /^es\b/i.test(navigator.languages?.[0] ?? navigator.language ?? "");
  } catch {
    return false;
  }
};

type Part = ReactNode | ((inner: ReactNode) => ReactNode);

/**
 * A sentence with links or emphasis inside, translated whole:
 *   <T text="Read the <link>terms</link> before {date}" link={(s) => <Link to="/license">{s}</Link>} date={when} />
 * Each <name>…</name> is drawn by the function of that name; each {name} is the value of that name.
 */
export function T({ text, ...parts }: { text: string } & Record<string, Part>) {
  return <>{render(t(text), parts)}</>;
}

function render(text: string, parts: Record<string, Part>): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /<(\w+)>([\s\S]*?)<\/\1>|\{(\w+)\}/g;
  let last = 0;
  let index = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [whole, tag, inner, name] = m;
    const part = parts[tag ?? name!];
    if (tag) out.push(<Fragment key={index++}>{typeof part === "function" ? part(render(inner!, parts)) : render(inner!, parts)}</Fragment>);
    else if (part === undefined) out.push(whole);
    else out.push(<Fragment key={index++}>{typeof part === "function" ? part(null) : part}</Fragment>);
    last = m.index + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
