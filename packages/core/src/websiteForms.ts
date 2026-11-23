/**
 * Website forms (Apps → Crewtavo - Website Forms): a form in the business's own HTML posts to
 * /f/<key> on its Crewtavo, the way Formspree works (apps/api/src/routes/websiteForms.ts). Fields
 * are read here by their names, in the usual spellings of each: name, email, phone, company and
 * address go on the client and property, message on the request, and every other field comes along
 * as an answer under its own name. A promo code (promo, promo_code, promocode, coupon, coupon_code or
 * discount_code, in any case, with spaces or dashes) is checked as one too, and stays an answer.
 * Formspree's own fields work the same, so a form moves over by changing its action: _gotcha (left
 * empty by people, filled in by bots), _subject, _next and _replyto. Other fields that start with _
 * are instructions, never answers.
 *
 * Beyond _gotcha, a form can ask for a bot check (website_forms.bot_check): Crewtavo's own, one
 * script line on the page that sends a token in _check, or Cloudflare Turnstile, whose widget sends
 * cf-turnstile-response. botCheckLines() is what the business adds to its form for each.
 */
import { emailKey } from "./email";

// The platform's URL (browsers, Node): core is built without DOM types.
declare const URL: new (input: string) => { href: string; protocol: string; hostname: string };

export type FieldValue = string | string[];
export type Fields = Record<string, FieldValue>;

/** Sized well past any real form, so a script can't store megabytes with each message. */
export const MAX_FIELDS = 60;
export const MAX_VALUE = 5000;
export const MAX_TOTAL = 50_000;

export type Role = "name" | "first" | "last" | "email" | "phone" | "company" | "line1" | "line2" | "city" | "region" | "postal_code" | "message" | "promo";

// Spellings as they're compared: lower-case, letters and digits only ("E-mail Address" is emailaddress).
const SPELLINGS: Record<Role, string[]> = {
  name: ["name", "fullname", "yourname", "contactname", "customername"],
  first: ["firstname", "fname", "first", "givenname"],
  last: ["lastname", "lname", "last", "surname", "familyname"],
  email: ["email", "emailaddress", "youremail", "mail", "email1"],
  phone: ["phone", "phonenumber", "tel", "telephone", "mobile", "cell", "cellphone", "mobilephone", "yourphone", "phone1", "contactnumber"],
  company: ["company", "companyname", "business", "businessname", "organization", "organisation"],
  line1: ["address", "streetaddress", "street", "address1", "addressline1", "youraddress", "propertyaddress", "serviceaddress"],
  line2: ["address2", "addressline2", "apt", "unit", "suite"],
  city: ["city", "town"],
  region: ["state", "province", "region"],
  postal_code: ["zip", "zipcode", "postalcode", "postcode", "postal"],
  message: ["message", "comments", "comment", "details", "inquiry", "enquiry", "question", "questions", "notes", "yourmessage", "description", "body", "msg", "projectdetails"],
  promo: ["promo", "promocode", "coupon", "couponcode", "discountcode"],
};
const ROLE_OF = new Map<string, Role>(Object.entries(SPELLINGS).flatMap(([role, names]) => names.map((n) => [n, role as Role])));
/**
 * What keeps bots out beyond the hidden field: nothing more, Crewtavo's own check (a script on the
 * page), or Cloudflare Turnstile with the business's own keys.
 */
export const BOT_CHECKS = ["off", "script", "turnstile"] as const;
export type BotCheck = (typeof BOT_CHECKS)[number];
/** The hidden field Crewtavo's check adds to the form: its token (routes/websiteForms.ts). */
export const CHECK_FIELD = "_check";
/** The hidden field Turnstile's widget adds to the form: its answer. */
export const TURNSTILE_FIELD = "cf-turnstile-response";
/** Cloudflare's script, which draws the widget wherever the page has a cf-turnstile block. */
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";
/** A Turnstile site key as Cloudflare writes them (0x4AAAAAAA…): what's safe to put in the form's HTML. */
export const isTurnstileSiteKey = (value: string) => /^[0-9A-Za-z_-]{10,100}$/.test(value);

/** Captcha answers other form services' widgets add. */
const CAPTCHAS = new Set(["g-recaptcha-response", "h-captcha-response", "cf-turnstile-response", "frc-captcha-solution"]);

/** A field's name as names are compared: lower-case, letters and digits only. */
export const spelling = (name: string) => name.replace(/\[\]$/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** What a field is, by its name: "E-mail Address" is the email. Careers reads its own on top (careers.ts). */
export const fieldRole = (name: string): Role | undefined => ROLE_OF.get(spelling(name));
const text = (value: FieldValue | undefined) => (Array.isArray(value) ? value.join(", ") : (value ?? "")).trim();

export interface Submission {
  name: string | null;
  /** A whole address, as emailKey() spells it. */
  email: string | null;
  /** As typed, when it has enough digits to be a number. */
  phone: string | null;
  companyName: string | null;
  address: { line1?: string; line2?: string; city?: string; region?: string; postal_code?: string };
  message: string | null;
  /** _subject: the email's subject, and the request's title. */
  subject: string | null;
  /** _next: where to go after sending, when it's a web address. */
  next: string | null;
  /** _gotcha filled in: a bot. Treated as sent, and nothing is kept. */
  bot: boolean;
  /** The first promo code field, trimmed, to check as a code. It stays among the answers too. */
  promo: string | null;
  /** Every field people filled in, in the order the form sent them (for the email). */
  fields: Array<[string, FieldValue]>;
  /** The fields that aren't the client, the property or the message, under their own names. */
  answers: Fields;
  /** The client's fields as typed. They go on the request when the message is from a client Crewtavo already has. */
  contact: Fields;
}

export type ReadResult = { ok: true; submission: Submission } | { ok: false; error: string };

/** Without U+0000, which Postgres keeps in neither text nor JSON: one in a field would lose the whole message as it's stored. */
const withoutNul = (text: string) => (text.includes("\u0000") ? text.split("\u0000").join("") : text);

/** The values a form sent, trimmed, empty ones left out. Files aren't taken. */
export function cleanFields(entries: Iterable<[string, unknown]>): { ok: true; fields: Array<[string, FieldValue]> } | { ok: false; error: string } {
  const out = new Map<string, FieldValue>();
  let size = 0;
  for (const [rawName, raw] of entries) {
    const name = withoutNul(rawName).trim().slice(0, 100);
    if (!name) continue;
    const values = (Array.isArray(raw) ? raw : [raw])
      .map((v) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null))
      .filter((v): v is string => v !== null)
      .map((v) => withoutNul(v).replace(/\r\n?/g, "\n").trim())
      .filter(Boolean);
    if (!values.length) continue;
    if (values.some((v) => v.length > MAX_VALUE)) return { ok: false, error: "Part of the message is too long. Shorten it and try again." };
    size += name.length + values.join("").length;
    const had = out.get(name);
    const all = had === undefined ? values : [...(Array.isArray(had) ? had : [had]), ...values];
    out.set(name, all.length === 1 && !name.endsWith("[]") ? all[0]! : all.slice(0, 50));
  }
  if (out.size > MAX_FIELDS || size > MAX_TOTAL) return { ok: false, error: "That's too much to send in one message." };
  return { ok: true, fields: [...out] };
}

/** Read a message from its fields (cleanFields first). */
export function readSubmission(fields: Array<[string, FieldValue]>): ReadResult {
  const kept: Array<[string, FieldValue]> = [];
  const found: Partial<Record<Role, string>> = {};
  const roleFields: Partial<Record<Role, string>> = {};
  let subject: string | null = null;
  let next: string | null = null;
  let replyTo: string | null = null;
  let bot = false;
  for (const [name, value] of fields) {
    if (CAPTCHAS.has(name.toLowerCase())) continue;
    if (name.startsWith("_")) {
      const special = name.toLowerCase();
      if (special === "_gotcha") bot = true;
      else if (special === "_subject") subject = text(value).replace(/\s+/g, " ").slice(0, 150) || null;
      else if (special === "_next") next = webAddress(text(value));
      else if (special === "_replyto") replyTo = text(value);
      continue;
    }
    kept.push([name, value]);
    const role = fieldRole(name);
    // The first field for each part wins; a second one (a confirm-email field) is an answer.
    if (role && found[role] === undefined) {
      found[role] = text(value);
      roleFields[role] = name;
    }
  }

  const typedEmail = found.email ?? replyTo ?? "";
  const email = emailKey(typedEmail);
  const phone = (found.phone ?? "").replace(/\D/g, "").length >= 7 ? found.phone! : null;
  // A bot is told it worked, whatever it typed.
  if (!email && !phone && !bot) {
    return { ok: false, error: typedEmail ? "That email address doesn't look right. Check it and try again." : "Add an email or phone number so we can reach you." };
  }
  const name = found.name || [found.first, found.last].filter(Boolean).join(" ") || null;

  // Fields that went somewhere else: the client, the property, the message. What wasn't used (an
  // email that isn't a whole address) stays an answer, so nothing typed is lost.
  const used = new Set<string>();
  const contact: Fields = {};
  const take = (role: Role, ok = true) => {
    const field = roleFields[role];
    if (!field || !ok) return;
    used.add(field);
    if (role !== "message") contact[field] = fields.find(([n]) => n === field)![1];
  };
  take("name");
  take("first");
  take("last");
  take("email", Boolean(email && found.email));
  take("phone", Boolean(phone));
  take("company");
  for (const role of ["line1", "line2", "city", "region", "postal_code"] as const) take(role, Boolean(found.line1));
  take("message");
  const answers: Fields = Object.fromEntries(kept.filter(([n]) => !used.has(n)));

  const address = found.line1
    ? Object.fromEntries((["line1", "line2", "city", "region", "postal_code"] as const).flatMap((r) => (found[r] ? [[r, found[r]!]] : [])))
    : {};
  return {
    ok: true,
    submission: {
      name: name?.slice(0, 200) ?? null,
      email,
      phone: phone?.slice(0, 30) ?? null,
      companyName: found.company?.slice(0, 200) || null,
      address,
      message: found.message || null,
      subject,
      next,
      bot,
      promo: found.promo?.slice(0, 40) || null,
      fields: kept,
      answers,
      contact,
    },
  };
}

/** An absolute http(s) address, or null. */
export function webAddress(input: string | null | undefined): string | null {
  const value = (input ?? "").trim();
  if (!value || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A website as its host name, the way the allowed websites are kept: greenlawn.com for https://www.greenlawn.com/contact. */
export function siteHost(input: string | null | undefined): string | null {
  let value = (input ?? "").trim().toLowerCase();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.replace(/^www\./, "").replace(/\.$/, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Whether a message from this page (its Origin or Referer) may come in: any website when none are listed, and their subdomains. */
export function siteAllowed(from: string | null | undefined, sites: readonly string[]): boolean {
  if (!sites.length) return true;
  const host = siteHost(from);
  return Boolean(host && sites.some((site) => host === site || host.endsWith(`.${site}`)));
}

/** A field's name as people read it: how_did_you_hear is "How did you hear", firstName "First name". */
export function fieldLabel(name: string): string {
  const words = name
    .replace(/\[\]$/, "")
    .replace(/^_+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()));
  const label = words.join(" ");
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : name;
}

/** The line that stands for a visitor's blank lines in the office's email (visitorLines): a no-break space. */
const VISITOR_GAP = "\u00a0";

/**
 * What a visitor typed, as it goes in the office's email: its lines kept, and each run of blank lines
 * between them a line holding only a no-break space (VISITOR_GAP). Their paragraphs still read apart,
 * but the email never has two line breaks in a row from them, so none of it stands as a paragraph of
 * its own there, where a link alone in one would be a button (apps/api/src/lib/email.ts). A job
 * application's email (careers.ts) does the same.
 */
export function visitorLines(value: string): string {
  const lines: string[] = [];
  for (const line of value.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim()) lines.push(line);
    else if (lines.length && lines.at(-1) !== VISITOR_GAP) lines.push(VISITOR_GAP);
  }
  if (lines.at(-1) === VISITOR_GAP) lines.pop();
  return lines.join("\n");
}

/** And what a visitor typed that's shown on one line: a field's name, a promo code. */
export const visitorLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** What became of a message's promo code: ready to apply (no problem), or why it wasn't applied. */
export type PromoResult = { code: string; problem: string | null } | null;

/** The office email's line for a message's promo code. */
export function promoLine(promo: PromoResult): string | null {
  if (!promo) return null;
  const code = visitorLine(promo.code);
  if (!promo.problem) return `Promo code ${code}, ready to apply on the quote.`;
  return `Promo code ${code} wasn't applied: ${promo.problem.charAt(0).toLowerCase()}${promo.problem.slice(1)}`;
}

/**
 * The email the people a form names get for each message: its subject and words (lib/email.ts
 * renders them). `link`: the request in Crewtavo; null when the server doesn't know its own address,
 * and the email says where to find it instead.
 */
export function messageEmail(input: { formName: string; submission: Submission; link: string | null; promo?: PromoResult }): { subject: string; text: string } {
  const { submission: s, formName, link } = input;
  const who = s.name ?? s.email ?? s.phone ?? "someone";
  const short: string[] = [];
  const long: string[] = [];
  for (const [name, value] of s.fields) {
    const shown = visitorLines(Array.isArray(value) ? value.join(", ") : value);
    const label = visitorLine(fieldLabel(name));
    if (shown.includes("\n") || shown.length > 80) long.push(`${label}:\n${shown}`);
    else short.push(`${label}: ${shown}`);
  }
  const first = (s.name ?? "").split(/\s+/)[0];
  return {
    subject: s.subject ?? `New message from ${who}`,
    text: [
      `New message from your website's ${formName}.`,
      short.join("\n"),
      ...long,
      promoLine(input.promo ?? null),
      link ?? "It's in Requests in Crewtavo.",
      s.email ? `Reply to this email to answer ${first || "them"}.` : null,
    ].filter(Boolean).join("\n\n"),
  };
}

/** Where a form's check script loads from: its address, then /check.js. */
export const checkScriptUrl = (action: string) => `${action.replace(/\/+$/, "")}/check.js`;

const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Turnstile's widget, for inside the form: it adds its own hidden field with the answer. */
const turnstileWidget = (siteKey: string | null | undefined) => `<div class="cf-turnstile" data-sitekey="${attribute(siteKey ?? "")}"></div>`;
const scriptLine = (src: string, defer = false) => `<script src="${attribute(src)}" async${defer ? " defer" : ""}></script>`;

/**
 * What a form that's already on the website needs for its check, each line with where it goes.
 * Crewtavo's check is one script, anywhere on the page. Turnstile is its widget inside the form and
 * Cloudflare's script on the page. Nothing for a form with no check.
 */
export function botCheckLines(action: string, check: BotCheck, siteKey?: string | null): Array<{ where: string; line: string }> {
  if (check === "script") return [{ where: "Anywhere on each page that has the form", line: scriptLine(checkScriptUrl(action)) }];
  if (check === "turnstile") {
    return [
      { where: "Inside the form, above its Send button", line: turnstileWidget(siteKey) },
      { where: "Anywhere on each page that has the form", line: scriptLine(TURNSTILE_SCRIPT, true) },
    ];
  }
  return [];
}

/** The same lines where an example form has them: what goes above the button, and what goes after the form. */
export function exampleCheckLines(action: string, check: BotCheck = "off", siteKey?: string | null): { aboveButton: string[]; afterForm: string[] } {
  if (check === "script") return { aboveButton: [], afterForm: [`<!-- Checks that a person is sending it. Leave it on the page. -->`, scriptLine(checkScriptUrl(action))] };
  if (check === "turnstile") return { aboveButton: [`  <!-- Cloudflare's check that a person is sending it. -->`, `  ${turnstileWidget(siteKey)}`], afterForm: [scriptLine(TURNSTILE_SCRIPT, true)] };
  return { aboveButton: [], afterForm: [] };
}

/**
 * A form to start from: paste it into the website and it works. `promo`: a promo code box too, for a
 * business that has codes (an empty box sends visitors looking for one). `botCheck`: the form's
 * check comes with it (`siteKey`: the business's Turnstile site key).
 */
export function exampleForm(action: string, options: { promo?: boolean; botCheck?: BotCheck; siteKey?: string | null } = {}): string {
  const check = exampleCheckLines(action, options.botCheck, options.siteKey);
  return [
    `<form action="${action}" method="POST">`,
    `  <label>Name <input type="text" name="name" autocomplete="name" required></label>`,
    `  <label>Email <input type="email" name="email" autocomplete="email" required></label>`,
    `  <label>Phone <input type="tel" name="phone" autocomplete="tel"></label>`,
    `  <label>Address <input type="text" name="address" autocomplete="street-address"></label>`,
    `  <label>Message <textarea name="message" rows="5" required></textarea></label>`,
    ...(options.promo ? [`  <label>Promo code <input type="text" name="promo" autocomplete="off"></label>`] : []),
    `  <!-- Keeps bots out. Leave it here, hidden. -->`,
    `  <input type="text" name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">`,
    ...check.aboveButton,
    `  <button type="submit">Send</button>`,
    `</form>`,
    ...check.afterForm,
  ].join("\n");
}
