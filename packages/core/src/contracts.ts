/**
 * Contract sections (contract_sections): the business's own wording, like payment, warranty and the
 * right to cancel, kept in a library and printed with estimates and invoices, either above the
 * signatures or on the terms pages after them. The estimate template lists the sections every
 * estimate (and every invoice) gets, the option the customer picks adds its package's, and a quote
 * can add more for one job.
 *
 * The words can carry fill-ins like {Customer name}. The browser fills them in to show the paper
 * and the server fills them in to freeze the signed copy, both with contractValues() from the same
 * plain inputs, so the words match; and both fingerprint the words as filled (sectionsHash), so a
 * signature on words that changed meanwhile is turned down. The template settings are in
 * documents.ts; the paper is the web app's features/documents.
 */
import type { TemplateSettings } from "./documents";
import { toCents, type Amount } from "./money";
import { isIsoDate, isTimeZoneName, localDate } from "./time";

/** Above the signatures, or on the terms pages after them. */
export type ContractPlace = "signatures" | "terms";

/** A section as it prints: its words are HTML (sanitized when it's shown) with fill-ins in braces. */
export interface ContractSection {
  id: string;
  title: string;
  body: string;
  place: ContractPlace;
  /** The customer initials this section when they sign. */
  initials: boolean;
}

/** A row of the library as the database sends it. */
export interface LibrarySection {
  id: string;
  title: string;
  body: string;
  place: string;
  initials: boolean | null;
}

/** What contract_sections allows (its CHECKs). */
export const CONTRACT_LIMITS = { title: 120, body: 20000 } as const;

// ---------------------------------------------------------------------------------------------
// Which sections a document prints
// ---------------------------------------------------------------------------------------------

/**
 * The sections a document prints, in order, each once. An estimate prints the template's sections,
 * then the option's (its package's), then the ones added to the quote; an invoice prints the
 * template's invoice sections. The option's and the quote's go in the library's order (pass the
 * library in its order: sort, then created_at, then id), so moving a section in Settings moves it on
 * options already offered and on quotes too, as it does on templates and packages, which keep their
 * own lists in that order. Ids that aren't in the library (deleted, or another business's) are left
 * out, so load the library with the business's company_id.
 */
export function resolveSections(input: {
  kind: "estimate" | "invoice";
  template: Pick<TemplateSettings, "sections" | "invoice_sections">;
  optionSectionIds?: readonly string[] | null;
  quoteSectionIds?: readonly string[] | null;
  library: readonly LibrarySection[];
}): ContractSection[] {
  const position = new Map(input.library.map((s, i) => [s.id.toLowerCase(), i]));
  const inLibraryOrder = (list: readonly string[] | null | undefined) =>
    (list ?? []).filter((id) => position.has(id.toLowerCase())).sort((a, b) => position.get(a.toLowerCase())! - position.get(b.toLowerCase())!);
  const ids = input.kind === "invoice" ? input.template.invoice_sections : [...input.template.sections, ...inLibraryOrder(input.optionSectionIds), ...inLibraryOrder(input.quoteSectionIds)];
  const library = new Map(input.library.map((s) => [s.id.toLowerCase(), s]));
  const seen = new Set<string>();
  const sections: ContractSection[] = [];
  for (const id of ids) {
    const key = id.toLowerCase();
    const s = library.get(key);
    if (!s || seen.has(key)) continue;
    seen.add(key);
    sections.push({ id: s.id, title: s.title, body: s.body, place: s.place === "signatures" ? "signatures" : "terms", initials: s.initials === true });
  }
  return sections;
}

// ---------------------------------------------------------------------------------------------
// Fill-ins: {Customer name} and the rest
// ---------------------------------------------------------------------------------------------

/** The fill-ins a section can use, for the "Insert a fill-in" menu. The label is the name in the braces. */
export const FILL_INS = [
  { token: "{Customer name}", label: "Customer name", hint: "Who the estimate is for" },
  { token: "{Customer address}", label: "Customer address", hint: "The customer's address, on one line" },
  { token: "{Job address}", label: "Job address", hint: "Where the work is" },
  { token: "{Business name}", label: "Business name", hint: "Your business's name" },
  { token: "{Business phone}", label: "Business phone", hint: "Your business's phone number" },
  { token: "{License number}", label: "License number", hint: "The license on your estimate template" },
  { token: "{Estimate number}", label: "Estimate number", hint: "Like 1042" },
  { token: "{Date}", label: "Date", hint: "The estimate's date, like October 25, 2026" },
  { token: "{Total}", label: "Total", hint: "The price of the option they pick, with tax" },
  { token: "{Deposit}", label: "Deposit", hint: "The deposit on the estimate" },
  { token: "{Option}", label: "Option", hint: "The name of the option they pick" },
  { token: "{Warranty}", label: "Warranty", hint: "The warranty of the option they pick" },
] as const satisfies ReadonlyArray<{ token: `{${string}}`; label: string; hint: string }>;

/** A fill-in's name, as written in its braces. */
export type FillInName = (typeof FILL_INS)[number]["label"];

/** What each fill-in says on one estimate; "" when there's nothing to say. */
export type ContractValues = Record<FillInName, string>;

/** The plain facts the fill-ins come from. Both the browser and the server pass the same ones. */
export interface ContractInput {
  customerName?: string | null;
  /** As printed, one line each ("12 Oak St", "Radford, VA 24141"), or already on one line. */
  customerAddress?: readonly string[] | string | null;
  jobAddress?: readonly string[] | string | null;
  businessName?: string | null;
  businessPhone?: string | null;
  /** The template's license, as typed. */
  license?: string | null;
  estimateNumber?: number | string | null;
  /** The estimate's date: "2026-10-25", or a timestamp, read on the business's calendar when `timeZone` is given (else in UTC). */
  date?: string | null;
  /** The business's time zone (companies.timezone). */
  timeZone?: string | null;
  /** The price of the option being signed, with tax. */
  total?: Amount;
  deposit?: Amount;
  /** The option's name as it's offered (quote_options.name). */
  optionName?: string | null;
  warranty?: string | null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const clean = (value: string | null | undefined) => (value ?? "").trim().replace(/\s+/g, " ");

/** Address lines on one line: "12 Oak St, Radford, VA 24141". */
const oneLine = (value: readonly string[] | string | null | undefined) =>
  (typeof value === "string" ? value.split(/\r?\n/) : value ?? []).map(clean).filter(Boolean).join(", ");

/** "2026-10-25" (or a timestamp) as "October 25, 2026"; the same words wherever it runs. */
function dateWords(value: string | null | undefined, timeZone: string | null | undefined): string {
  if (!value) return "";
  let day = isIsoDate(value) ? value : null;
  if (!day) {
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) return "";
    day = timeZone && isTimeZoneName(timeZone) ? localDate(instant, timeZone) : instant.toISOString().slice(0, 10);
  }
  const [year, month, date] = day.split("-").map(Number);
  return `${MONTHS[month - 1]} ${date}, ${year}`;
}

/** An amount as "$1,234.56", to the cent; "" when there's none. */
function dollars(amount: Amount): string {
  if (amount === null || amount === undefined || String(amount).trim() === "") return "";
  const cents = toCents(amount);
  const whole = String(Math.floor(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}$${whole}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}

const blank = (amount: Amount) => amount === null || amount === undefined || String(amount).trim() === "";

/**
 * The deposit as it's asked for: never more than the total being signed, which a cheaper option or
 * a price set on site can bring under it (the Client Hub's "Deposit to book" and the paper say the
 * same). Without a total, the deposit as it is.
 */
function depositWithin(deposit: Amount, total: Amount): Amount {
  if (blank(deposit) || blank(total)) return deposit;
  return Math.min(toCents(deposit), Math.max(toCents(total), 0)) / 100;
}

/**
 * What each fill-in says, from plain facts. Pure: no clock, no locale and no time zone but the one
 * given, so the preview a customer reads and the copy frozen when they sign say the same thing.
 */
export function contractValues(input: ContractInput): ContractValues {
  return {
    "Customer name": clean(input.customerName),
    "Customer address": oneLine(input.customerAddress),
    "Job address": oneLine(input.jobAddress),
    "Business name": clean(input.businessName),
    "Business phone": clean(input.businessPhone),
    "License number": clean(input.license),
    "Estimate number": input.estimateNumber === null || input.estimateNumber === undefined ? "" : clean(String(input.estimateNumber)),
    Date: dateWords(input.date, input.timeZone),
    Total: dollars(input.total),
    Deposit: dollars(depositWithin(input.deposit, input.total)),
    Option: clean(input.optionName),
    Warranty: clean(input.warranty),
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A fill-in's name as it's matched: any case, any spacing. */
const fillInKey = (name: string) => name.replace(/&nbsp;| /g, " ").trim().replace(/\s+/g, " ").toLowerCase();

const FILL_IN_NAMES = new Map<string, FillInName>(FILL_INS.map((f) => [fillInKey(f.label), f.label]));

const TOKEN = /\{([^{}<>\n]{1,60})\}/g;

/**
 * Words with their fill-ins filled: {customer name} or {Customer Name} both work, and braces that
 * aren't a fill-in are left as they are. By default the words are HTML (a section's body) and the
 * values go in HTML-escaped.
 *
 * The template's terms are plain text, not HTML. `plain` escapes the whole text first and returns
 * safe HTML, which must be rendered as HTML, with its line breaks kept by `white-space: pre-line` (or
 * turned into <br>). `text` returns plain text with the values as they are, for a React text node,
 * which escapes it itself (an escaped value there would print as "R&amp;R Roofing").
 */
export function fillIn(text: string, values: Partial<Record<FillInName, string | null>>, options: { plain?: boolean; text?: boolean } = {}): string {
  const source = options.plain && !options.text ? escapeHtml(text) : text;
  const value = (v: string) => (options.text ? v : escapeHtml(v));
  return source.replace(TOKEN, (token, name: string) => {
    const known = FILL_IN_NAMES.get(fillInKey(name));
    return known ? value(values[known] ?? "") : token;
  });
}

// ---------------------------------------------------------------------------------------------
// The fingerprint sent with a signature
// ---------------------------------------------------------------------------------------------

/**
 * The option a contract is signed for, as its card shows it and the signed copy keeps it
 * (approval.option): its name, the tier word on its card (its own, or "Good", "Better" or "Best" by
 * price: core optionTierLabels, as the card words it, not the option's own column alone), its
 * warranty and its highlights.
 */
export interface ContractOption {
  name: string;
  tier: string | null;
  warranty: string | null;
  highlights: readonly string[] | null;
}

/**
 * A short fingerprint of what a customer signs, as it's kept: the template's terms (the words printed
 * above the signatures) and each section's id, title, words, place and initials, in order, with the
 * fill-ins filled from `values` exactly as the paper prints them and the signed copy keeps them; then
 * the option chosen, as its card says it (null without options). So a warranty, deposit, customer
 * name or date that changed is caught wherever the paper prints it, like changed words are, and a fact
 * nothing prints changes nothing.
 *
 * The Client Hub and the iPad send it with a signature, from the paper they showed; the server works
 * it out again from the rows as they are when it's signed, with the values it freezes the copy with
 * (contractValues of contractInput, with the total being signed) and the option card it keeps, and
 * turns the signature down when they differ. FNV-1a (64-bit) over the text as UTF-8, as 16 hex digits.
 */
export function sectionsHash(
  sections: ReadonlyArray<Pick<ContractSection, "id" | "title" | "body" | "place" | "initials">>,
  input: { terms: string | null; values: ContractValues; option: ContractOption | null },
): string {
  const field = (value: string) => `${value.length}:${value}`;
  // Filled as they print: the terms as plain text, trimmed and not at all when they're blank; a section's words as HTML.
  const terms = fillIn(input.terms ?? "", input.values, { text: true }).trim();
  const o = input.option;
  const card = o ? field(clean(o.name)) + field(clean(o.tier)) + field(clean(o.warranty)) + field((o.highlights ?? []).map(clean).filter(Boolean).map(field).join("")) : "";
  // "T" and "O" keep the terms and the option apart from a section, which starts with a digit.
  const text = [
    ...(terms ? [`T${field(terms)}`] : []),
    ...(o ? [`O${card}`] : []),
    ...sections.map((s) => field(s.id) + field(s.title) + field(fillIn(s.body, input.values)) + field(s.place) + (s.initials ? "1" : "0")),
  ].join("|");
  return fnv1a64(text);
}

/** FNV-1a (64-bit) over the text as UTF-8, as 16 hex digits. */
function fnv1a64(text: string): string {
  // The 64-bit hash as two 32-bit halves; its prime is 2^40 + 0x1b3.
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  const mix = (byte: number) => {
    lo = (lo ^ byte) >>> 0;
    const low = lo * 0x1b3;
    hi = (Math.imul(hi, 0x1b3) + (lo << 8) + Math.floor(low / 0x100000000)) >>> 0;
    lo = low >>> 0;
  };
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) mix(c);
    else if (c < 0x800) [0xc0 | (c >> 6), 0x80 | (c & 63)].forEach(mix);
    else if (c < 0x10000) [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)].forEach(mix);
    else [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)].forEach(mix);
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------------------------
// Example sections to start from
// ---------------------------------------------------------------------------------------------

/** A section to add to an empty library. */
export type ContractStarter = Omit<ContractSection, "id">;

/** Said wherever the example sections are offered. */
export const STARTER_NOTE = "Example wording to start from — have your attorney review it before you use it.";

const terms = (title: string, body: string): ContractStarter => ({ title, body, place: "terms", initials: false });

const TRADE_STARTERS: Record<string, ContractStarter[]> = {
  roofing_exteriors: [
    terms(
      "Hidden decking damage",
      "<p>We can't see the wood under your old roof until it's torn off. If we find rotten or damaged decking, we'll show you and replace it at the price per sheet on the estimate, so your new roof goes on a solid deck.</p>" +
        "<p>If it needs more than a few sheets, we'll call you before we go further.</p>",
    ),
    terms(
      "Insurance claims",
      "<p>If your insurance company is paying for some of this work, you're still responsible for the full price in this agreement, including your deductible. We can't pay or waive a deductible.</p>" +
        "<p>We're glad to meet your adjuster and send them photos and the estimate. Anything more they approve, we'll write up as a change for your OK.</p>",
    ),
    terms(
      "Weather",
      "<p>We only tear off when the forecast looks dry. If rain comes up while your roof is open, we'll cover it to keep the water out.</p>" +
        "<p>Wind, cold and heat can move the schedule too. Shingles need warm days to seal down, so in cold weather some may not seal until it warms up.</p>",
    ),
  ],
  paving: [
    terms(
      "Cure time",
      "<p>New asphalt and fresh sealcoat need time to set up:</p>" +
        "<ul><li><strong>Sealcoat:</strong> stay off it for at least 24 hours on foot and 48 hours in a car, longer when it's cool or damp.</li>" +
        "<li><strong>New asphalt:</strong> it stays soft for a few weeks in warm weather. Don't turn your wheels while you're parked, and keep trailers, kickstands, jacks and heavy trucks off it.</li>" +
        "<li>Scuffs and tire marks in the first few weeks are normal and fade as it cures.</li></ul>",
    ),
    terms(
      "Cracks coming back",
      "<p>Filling cracks slows down damage, but it can't stop the ground from moving. As it freezes, thaws and settles, filled cracks can open again and new ones can form.</p>" +
        "<p>That's normal wear, and the warranty doesn't cover it.</p>",
    ),
  ],
  lawn_exterior: [
    terms(
      "Access and pets",
      "<p>Please leave gates unlocked and keep pets inside on service days. If we can't get in, or it isn't safe to work, we'll skip that visit and let you know.</p>" +
        "<p>Tell us about anything hidden in the grass, like sprinkler heads, buried pet fence wires or cables, so we can work around it.</p>",
    ),
    terms(
      "Weather",
      "<p>Rain, storms, heat and drought can move a visit by a day or more. We'll come back as soon as it's safe to work, and we won't mow or treat when it would hurt your lawn.</p>",
    ),
  ],
};

/**
 * Example sections for a new library, in plain words: the ones every business needs (payment,
 * changes, warranty, the right to cancel and so on) with a few for the trade. They're a start to
 * edit, not finished legal terms, which is what STARTER_NOTE tells the business.
 */
export function contractStarters(trade: string | null | undefined): ContractStarter[] {
  const cleanup =
    "<p>We keep the work area tidy as we go and haul away our debris when the job is done.</p>" +
    (trade === "roofing_exteriors" ? "<p>We run a magnet over the yard and driveway for stray nails. Keep an eye out for any we missed for a few days.</p>" : "");
  return [
    terms(
      "Payment",
      "<p>The price for this work is {Total}, as shown on the estimate.</p>" +
        "<ul><li>Any deposit on the estimate is due when you sign, to hold your place on our schedule.</li>" +
        "<li>The rest is due when the work is done.</li>" +
        "<li>Please make checks out to {Business name}.</li></ul>",
    ),
    terms(
      "Changes to the work",
      "<p>The estimate lists everything this price includes. Anything else is extra, and we'll only do it with your OK.</p>" +
        "<p>If you ask for a change, or we find something that needs one, we'll tell you what it costs and how it moves the schedule before we start on it, and get your OK in writing. A text or an email is fine.</p>",
    ),
    ...(trade ? TRADE_STARTERS[trade] ?? [] : []),
    terms(
      "Warranty",
      "<p>{Warranty}</p>" +
        "<p>Manufacturer warranties on materials pass on to you, and we'll help you with a claim. Our workmanship warranty covers how we did the work. It doesn't cover damage from storms, accidents or settling, or work done by anyone else.</p>" +
        "<p>The warranty starts when the work is done and paid in full.</p>",
    ),
    terms(
      "Permits and inspections",
      "<p>We'll get the permits this work needs and schedule the inspections. A permit fee is part of the price only when it's on the estimate.</p>" +
        "<p>If an inspector asks for something that isn't on the estimate, we'll talk with you about it first, as a change.</p>",
    ),
    terms("Cleanup", cleanup),
    terms(
      "Delays beyond our control",
      "<p>Weather, material shortages, waits for permits and inspections, and other things outside our control can move the start or finish date. We'll keep you posted and get back to work as soon as we can.</p>",
    ),
    terms(
      "Liens",
      "<p>Anyone who supplies labor or materials for work on your property and isn't paid may be able to put a lien on it. We pay our crews and suppliers from the payments you make to us.</p>" +
        "<p>Once you've paid in full, you can ask us for a lien waiver.</p>",
    ),
    {
      title: "Your right to cancel",
      body:
        "<p>If you signed this agreement at your home, you may cancel it <strong>within three business days</strong> after the day you signed, without any penalty.</p>" +
        "<p>To cancel, let {Business name} know in writing (a letter or an email is fine) by midnight of the third business day. If you cancel, we'll return any payment you made within 10 business days.</p>",
      place: "signatures",
      initials: true,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// The facts a quote's or an invoice's fill-ins come from
// ---------------------------------------------------------------------------------------------

/**
 * An address as it prints: the street (and a second line, like a suite), then "City, ST 12345".
 * The same lines the staff app prints (web documents/build.ts addressLines): the business's on a
 * letterhead, and the customer's and the job's in a contract's fill-ins.
 */
export function addressLines(address: unknown): string[] {
  const a = address && typeof address === "object" && !Array.isArray(address) ? (address as Record<string, unknown>) : {};
  const part = (key: string) => (typeof a[key] === "string" ? (a[key] as string).trim() : "");
  const place = [[part("city"), part("region")].filter(Boolean).join(", "), part("postal_code")].filter(Boolean).join(" ");
  return [part("line1"), part("line2"), place].filter(Boolean);
}

/**
 * The plain facts a quote's fill-ins come from (core contractValues), the same on the server and in
 * the browser: the customer and their address (the job's when there's no billing address), the job
 * address, the business, the template's license, the estimate's number and date on the business's
 * calendar, its total and deposit, and the option chosen. `quote.total` is the total being signed:
 * pass the chosen option's (the total the homeowner saw) when it isn't the quote's own.
 */
export function contractInput(
  quote: { number: number | null; sent_at: string | null; created_at: string; total: Amount; deposit_amount: Amount },
  client: { display_name?: string | null; billing_address?: unknown } | null,
  property: unknown,
  company: { name: string; phone: string | null; timezone: string | null },
  template: Pick<TemplateSettings, "license">,
  option?: { name: string; warranty: string | null } | null,
): ContractInput {
  const job = addressLines(property);
  const billing = addressLines(client?.billing_address);
  return {
    customerName: client?.display_name ?? "",
    customerAddress: billing.length ? billing : job,
    jobAddress: job,
    businessName: company.name,
    businessPhone: company.phone,
    license: template.license,
    estimateNumber: quote.number,
    date: quote.sent_at ?? quote.created_at,
    timeZone: company.timezone,
    total: quote.total,
    deposit: quote.deposit_amount,
    optionName: option?.name ?? null,
    warranty: option?.warranty ?? null,
  };
}

/**
 * The facts an invoice's fill-ins come from, as an estimate's (contractInput) but with the invoice's
 * own number, date and total. An invoice has no deposit, so {Deposit} fills in blank. `option` is
 * what {Option} and {Warranty} say: for a job made from a quote, the option the client chose (or the
 * package it was priced from without options); none, and they fill in blank.
 */
export function invoiceInput(
  invoice: { number: number | null; issued_on: string; total: Amount },
  client: { display_name?: string | null; billing_address?: unknown } | null,
  property: unknown,
  company: { name: string; phone: string | null; timezone: string | null },
  template: Pick<TemplateSettings, "license">,
  option: { name: string; warranty: string | null } | null = null,
): ContractInput {
  return contractInput({ number: invoice.number, sent_at: invoice.issued_on, created_at: invoice.issued_on, total: invoice.total, deposit_amount: null }, client, property, company, template, option);
}
