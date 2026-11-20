/**
 * Crewtavo's own small translation layer, the same in the web app, the API and core.
 *
 *   t("Clock in")                                         the English text is the key
 *   t("Quote #{number} sent to {client}", { number, client })
 *   t.plural(n, { one: "{count} visit", other: "{count} visits" })   Intl.PluralRules; Spanish "many" falls back to "other"
 *   t("Open", { context: "verb" })                        same English, different Spanish ("Abrir" / "Abierta")
 *   msg("Schedule")                                       marks a module-level constant; t(label) where it's shown
 *
 * A line with no translation shows in English, and the catalog test (packages/core/test/i18n.test.ts)
 * fails until it has one. English is the key, so changing English copy flags its Spanish line.
 *
 * The web app has one language at a time (setLocale at start-up, and a reload when it changes), so
 * the plain `t` reads the current one. The server answers many people at once and makes a
 * translator per person or request: `const t = translator(profile.locale)`.
 *
 * Catalog keys: the English text; with a context, "context::English"; a plural is keyed by its
 * English "other" form and holds { one, other }.
 */

export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];

export const isLocale = (value: unknown): value is Locale => value === "en" || value === "es";

/** Each language's name in itself, for the choice between them. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", es: "Español" };

export interface PluralForms {
  one: string;
  other: string;
  /** Spanish uses it for millions ("1 000 000 de visitas"); "other" stands in when it's missing. */
  many?: string;
}
export type CatalogEntry = string | PluralForms;
export type Catalog = Record<string, CatalogEntry>;

/** Values for {placeholders}; `context` picks between translations of the same English. */
export type Params = { context?: string } & Record<string, string | number | null | undefined>;

export interface Translate {
  (text: string, params?: Params): string;
  plural: (count: number, forms: PluralForms, params?: Params) => string;
  readonly locale: Locale;
}

const catalogs: Partial<Record<Locale, Catalog>> = {};

/** Adds lines to a language's catalog: the API at start-up, the web app once its chunk has loaded. */
export function addCatalog(locale: Locale, lines: Catalog) {
  catalogs[locale] = { ...catalogs[locale], ...lines };
}

export const hasCatalog = (locale: Locale) => locale === "en" || Boolean(catalogs[locale]);

/** Between a context and its text, in a key made at run time by msg(text, context). */
const CONTEXT_MARK = "\u0004";
/** Between a context and its text, in a catalog key. */
export const CONTEXT_SEPARATOR = "::";

/** "es-US" formats numbers and money as in the US ($1,234.50), never as in Spain (1234,50 US$). */
export const intlLocaleOf = (locale: Locale) => (locale === "es" ? "es-US" : "en-US");

const rules = new Map<string, Intl.PluralRules>();
const pluralRule = (locale: Locale, count: number) => {
  const tag = intlLocaleOf(locale);
  let rule = rules.get(tag);
  if (!rule) rules.set(tag, (rule = new Intl.PluralRules(tag)));
  return rule.select(count) as keyof PluralForms | "zero" | "two" | "few";
};

/** Fills {name} with params.name; a placeholder with no value stays as it is. */
export function fill(text: string, params?: Params): string {
  if (!params || !text.includes("{")) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name !== "context" && name in params ? String(params[name] ?? "") : whole));
}

/**
 * Spanish says "a la 1:15" and "desde la 1:15" for one o'clock, and "las" for every other hour. A
 * line is written with "las {time}", and put right here once the time is in.
 */
export const oneOClock = (text: string) => (text.includes("as 1:") ? text.replace(/\b([Ll])as (1:\d{2})(?!\d)/g, "$1a $2") : text);

/** The text and context of a key: msg("Open", "verb") travels as "verb\u0004Open". */
function split(text: string, context?: string): { english: string; key: string } {
  const mark = text.indexOf(CONTEXT_MARK);
  if (mark >= 0) {
    const ctx = text.slice(0, mark);
    const english = text.slice(mark + 1);
    return { english, key: `${ctx}${CONTEXT_SEPARATOR}${english}` };
  }
  return { english: text, key: context ? `${context}${CONTEXT_SEPARATOR}${text}` : text };
}

function translate(locale: Locale, text: string, params?: Params): string {
  if (text == null) return text;
  const { english, key } = split(String(text), params?.context);
  if (locale === "en") return fill(english, params);
  const line = catalogs[locale]?.[key];
  const filled = fill(typeof line === "string" ? line : english, params);
  return locale === "es" && params ? oneOClock(filled) : filled;
}

function plural(locale: Locale, count: number, forms: PluralForms, params?: Params): string {
  const values = { count: String(count), ...params };
  const english = pluralRule("en", count) === "one" ? forms.one : forms.other;
  if (locale === "en") return fill(english, values);
  const key = params?.context ? `${params.context}${CONTEXT_SEPARATOR}${forms.other}` : forms.other;
  const line = catalogs[locale]?.[key];
  if (!line || typeof line === "string") return fill(english, values);
  const form = pluralRule(locale, count);
  return oneOClock(fill(line[form as keyof PluralForms] ?? line.other, values));
}

let choosing = false;
/**
 * Whether people choose their own language (Settings → Profile, My day's question, the sign-in
 * page). While it's false, everyone has English, whatever their profile holds.
 */
export const languageChoice = () => choosing;
/** Turns the choice on or off (the tests of the Spanish turn it on). */
export function setLanguageChoice(on: boolean) {
  choosing = on;
}

/** A translator for one language, for a server answering a person in theirs. */
export function translator(locale: Locale | string | null | undefined): Translate {
  const theirs: Locale = isLocale(locale) ? locale : "en";
  const lang = (): Locale => (choosing ? theirs : "en");
  const fn = ((text: string, params?: Params) => translate(lang(), text, params)) as Translate;
  fn.plural = (count, forms, params) => plural(lang(), count, forms, params);
  Object.defineProperty(fn, "locale", { get: lang });
  return fn;
}

let current: Locale = "en";

/** The web app's language, set once at start-up (changing it reloads the page). */
export function setLocale(locale: Locale) {
  current = locale;
}

export const getLocale = (): Locale => current;

/** The current language's Intl tag: "en-US" or "es-US". */
export const intlLocale = () => intlLocaleOf(current);

/** Translates into the current language (the web app's). */
export const t: Translate = Object.defineProperty(
  Object.assign((text: string, params?: Params) => translate(current, text, params), {
    plural: (count: number, forms: PluralForms, params?: Params) => plural(current, count, forms, params),
  }),
  "locale",
  { get: () => current },
) as Translate;

/**
 * Marks English kept in a module-level constant (a nav item, a status label) for the catalog, and
 * leaves it as it is: it's translated with t() where it's shown, once the language is known.
 */
export function msg(text: string, context?: string): string {
  return context ? `${context}${CONTEXT_MARK}${text}` : text;
}

/** The English of a msg(): what to compare, sort or search by. */
export const english = (text: string) => split(text).english;
