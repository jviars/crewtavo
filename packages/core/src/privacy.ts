/**
 * Error reports (Sentry, or a Sentry-compatible service like GlitchTip) must not carry personal
 * data. scrubEvent runs on every report from the web app and the API, just before it's sent:
 *
 *   - request bodies, cookies, query strings and headers (except User-Agent) are dropped
 *   - the user is dropped (no email, IP address or id)
 *   - emails, phone numbers, sign-in tokens and signed client links (/hub/..., /u/...) are masked
 *     in messages, error values, breadcrumbs, tags, extra data and contexts
 *   - values under keys like "email", "phone", "address", "token" or "lockbox_code" are replaced entirely
 *   - text longer than 10,000 characters is cut there
 *
 * Stack frames (file, function, line) are kept: that's what makes a report useful.
 */

/** Starts only where an address can start: trying every letter of a long word made this O(n²). */
const EMAIL = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
/**
 * 10 or more digits, optionally with a country code and separators: +1 (540) 555-0199, 540.555.0199.
 * Not inside longer numbers, words or paths, though "Phone:5405550199", "x5405550199" and "5405550199x12" count.
 */
const PHONE = /(?<![\w/.-](?<![xX]))(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-](?<![xX]))/g;
/** tel: and sms: links are phone numbers, however they're written (and sms: can carry the message). */
const TEL_LINK = /\b(tel|sms):[^\s"'<>]+/gi;
/** JWTs (Supabase sessions) and Crewtavo's signed links are base64url JSON: they start with "eyJ". */
const TOKEN = /\beyJ[\w-]+(?:\.[\w-]+){1,2}/g;
/** Path segments that are secrets: Client Hub, unsubscribe, referral, review and calendar links. */
const SECRET_PATH = /\/(hub|u|refer|r|calendar)\/[^/?#\s"'<>]+/gi;
/** Query strings and fragments carry search terms, filters and auth tokens. */
const URL_QUERY = /(\b(?:https?|wss?):\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;
/** The same in relative URLs and bare fragments: /verify?token_hash=..., #refresh_token=... */
const QUERY_STRING = /[?#][^\s"'<>=?#]*=[^\s"'<>]*/g;
const SENSITIVE_KEY = /pass|secret|token|auth|cookie|session|email|phone|mobile|address|line1|postal|gate|lockbox|alarm|card|iban|ssn|body/i;
/** Door, lockbox and other access codes: any "..._code" key except status, error and other harmless codes. */
const CODE_KEY = /(?<!^|(?:status|error|err|exit|http|response|reason|country|currency|language|lang|locale)[_-]?)code$/i;
const URL_KEY = /^(url|from|to|href)$/i;
const KEEP_HEADERS = /^user-agent$/i;
/** Longest text kept; the rest is dropped, so one huge string can't stall an error report. */
const MAX_TEXT = 10_000;
/** How much of a longer text is scrubbed before it's cut (the patterns are linear, and masking shortens it). */
const SCRUBBED_TEXT = 2 * MAX_TEXT;
/** The longest email address there is (RFC 5321); phone numbers are far shorter. */
const LONGEST_PART = 254;
/** The end of a text that could be the start of an email or phone number: their characters, and spaces between a phone number's digits. */
const PART_AT_END = /(?:[\w.%+@()-]|(?<=[\d)])\s(?=[\d(]|$))*$/;

/** Mask personal data and secrets in free text. */
export function scrubText(text: string): string {
  const long = text.length > MAX_TEXT;
  const cut = text.length > SCRUBBED_TEXT;
  let scrubbed = (cut ? text.slice(0, SCRUBBED_TEXT) : text)
    .replace(URL_QUERY, "$1")
    .replace(QUERY_STRING, "")
    .replace(TOKEN, "[token]")
    .replace(SECRET_PATH, "/$1/[token]")
    .replace(EMAIL, "[email]")
    .replace(TEL_LINK, "$1:[phone]")
    .replace(PHONE, "[phone]");
  // Where the text was cut, its end may be half of an email or phone number, which the patterns don't
  // recognize. Masking can shorten the text enough for that end to be kept, so drop it.
  if (cut) scrubbed = scrubbed.slice(0, -LONGEST_PART) + scrubbed.slice(-LONGEST_PART).replace(PART_AT_END, "");
  return long ? `${scrubbed.slice(0, MAX_TEXT)} [truncated]` : scrubbed;
}

/** A URL without its query string or fragment, with secrets in the path masked. */
export function scrubUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return scrubText(cut === -1 ? url : url.slice(0, cut));
}

function scrubValue(value: unknown, key = "", depth = 0): unknown {
  if (typeof value === "string") return URL_KEY.test(key) ? scrubUrl(value) : scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, "", depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) || CODE_KEY.test(k) ? "[redacted]" : scrubValue(v, k, depth + 1);
  return out;
}

/**
 * The Sentry SDK's `dataCollection` option: collect nothing about people or requests beyond the
 * error itself (the SDK's defaults collect headers, cookies, bodies, query strings and users).
 */
export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: { allow: ["user-agent"] }, response: false },
  httpBodies: [] as never[],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};

// The parts of a Sentry event that can hold personal data. Typed loosely so this package doesn't
// depend on the Sentry SDK; tests pin down the behavior.
type Loose = Record<string, any>;

/** Strip personal data from a Sentry event. Returns the same event, changed in place. */
export function scrubEvent<T>(event: T): T {
  const e = event as Loose;
  if (typeof e.message === "string") e.message = scrubText(e.message);
  if (e.logentry) e.logentry = scrubValue(e.logentry);
  if (typeof e.transaction === "string") e.transaction = scrubText(e.transaction);
  for (const exception of e.exception?.values ?? []) {
    if (typeof exception.value === "string") exception.value = scrubText(exception.value);
  }
  if (Array.isArray(e.breadcrumbs)) {
    e.breadcrumbs = e.breadcrumbs.map((crumb: Loose) => ({
      ...crumb,
      message: typeof crumb.message === "string" ? scrubText(crumb.message) : crumb.message,
      data: crumb.data ? scrubValue(crumb.data) : crumb.data,
    }));
  }
  if (e.request) {
    const headers = Object.fromEntries(Object.entries((e.request.headers ?? {}) as Record<string, string>).filter(([name]) => KEEP_HEADERS.test(name)));
    e.request = {
      ...(typeof e.request.url === "string" ? { url: scrubUrl(e.request.url) } : {}),
      ...(e.request.method ? { method: e.request.method } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }
  delete e.user;
  for (const field of ["extra", "contexts", "tags"]) if (e[field]) e[field] = scrubValue(e[field]);
  return event;
}
