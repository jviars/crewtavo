/**
 * Error reports (Sentry, or a Sentry-compatible service like GlitchTip) must not carry personal
 * data. scrubEvent runs on every report from the web app and the API, just before it's sent:
 *
 *   - request bodies, cookies, query strings and headers (except User-Agent) are dropped
 *   - the user is dropped (no email, IP address or id)
 *   - emails, phone numbers, sign-in tokens and signed client links (/hub/..., /u/...) are masked
 *     in messages, error values, breadcrumbs, tags, extra data and contexts
 *   - values under keys like "email", "phone", "address" or "token" are replaced entirely
 *
 * Stack frames (file, function, line) are kept: that's what makes a report useful.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
/** 10 or more digits, optionally with a country code and separators: +1 (540) 555-0199, 540.555.0199. */
const PHONE = /(?<![\w/.:-])(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])/g;
/** JWTs (Supabase sessions) and Crewtavo's signed links are base64url JSON: they start with "eyJ". */
const TOKEN = /\beyJ[\w-]+(?:\.[\w-]+){1,2}/g;
/** Path segments that are secrets: Client Hub, unsubscribe, referral, review and calendar links. */
const SECRET_PATH = /\/(hub|u|refer|r|calendar)\/[^/?#\s"'<>]+/gi;
/** Query strings and fragments carry search terms, filters and auth tokens. */
const URL_QUERY = /(\b(?:https?|wss?):\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;
const SENSITIVE_KEY = /pass|secret|token|auth|cookie|session|email|phone|mobile|address|line1|postal|gate|card|iban|ssn|body/i;
const URL_KEY = /^(url|from|to|href)$/i;
const KEEP_HEADERS = /^user-agent$/i;

/** Mask personal data and secrets in free text. */
export function scrubText(text: string): string {
  return text
    .replace(URL_QUERY, "$1")
    .replace(TOKEN, "[token]")
    .replace(SECRET_PATH, "/$1/[token]")
    .replace(EMAIL, "[email]")
    .replace(PHONE, "[phone]");
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
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : scrubValue(v, k, depth + 1);
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
