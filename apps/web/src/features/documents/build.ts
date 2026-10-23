/**
 * Turning the app's records into a document (types.ts), and the words and numbers printed on it.
 * Plain functions with no data loading, so the Client Hub, the office, the iPad and Settings all
 * print a quote the same way, and tests can check them without a browser.
 */
import { pickTemplate, templateSettings, type TemplateSettings } from "@crewtavo/core/documents";
import { lineTotal, toCents, type Amount } from "@crewtavo/core/money";
import type { DocumentCompany, DocumentData, DocumentLine, DocumentSignature } from "./types";

// ---------------------------------------------------------------------------------------------
// The business
// ---------------------------------------------------------------------------------------------

type Address = { line1?: string | null; line2?: string | null; city?: string | null; region?: string | null; postal_code?: string | null } | null | undefined;

/** An address as printed: the street, then "City, ST 12345". Empty parts are left out. */
export function addressLines(address: unknown): string[] {
  const a = (address && typeof address === "object" ? address : {}) as NonNullable<Address>;
  const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const place = [[clean(a.city), clean(a.region)].filter(Boolean).join(", "), clean(a.postal_code)].filter(Boolean).join(" ");
  return [clean(a.line1), clean(a.line2), place].filter(Boolean);
}

/** Where the business's logo loads from (the public logo route), or null when it has none. */
export function logoUrl(settings: unknown): string | null {
  const branding = settings && typeof settings === "object" ? (settings as { branding?: { logo?: unknown } }).branding : null;
  const path = branding?.logo;
  return typeof path === "string" && path.includes("/logo/") ? `/api/public/logo/${path.replace("/logo/", "/")}` : null;
}

/** "Ridgeline Roofing Co." -> "RR", for a business with no logo. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s&]/gu, " ").split(/\s+/).filter((w) => w && !/^(co|inc|llc|ltd|the|and|&)$/i.test(w));
  return (words.length ? words : [name]).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

/** A website as people read it: no "https://", no trailing slash. */
export const websiteLabel = (url: string | null | undefined) => (url ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** The license line: "License #RC-104882", unless they typed the word themselves. */
export const licenseLine = (license: string) => (/^lic/i.test(license.trim()) ? license.trim() : `License ${license.trim()}`);

// ---------------------------------------------------------------------------------------------
// Colors on paper
// ---------------------------------------------------------------------------------------------

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const INK = "#0f2a35";

/** The text color that reads best on a band of `hex`: white, or ink on a light color. */
export function inkOn(hex: string): string {
  const l = luminance(hex);
  if (l === null) return "#ffffff";
  return 1.05 / (l + 0.05) >= (l + 0.05) / (luminance(INK)! + 0.05) ? "#ffffff" : INK;
}

/** The color for words on white paper: the document's color, or ink when it's too light to read. */
export function readableOnWhite(hex: string): string {
  const l = luminance(hex);
  return l !== null && 1.05 / (l + 0.05) >= 3 ? hex : INK;
}

// ---------------------------------------------------------------------------------------------
// Words and numbers on the page
// ---------------------------------------------------------------------------------------------

const BARE = new Set(["", "ea", "each", "lump sum", "ls", "lot"]);
const SHORT: Record<string, string> = { square: "sq", squares: "sq", sq: "sq", hour: "hr", hours: "hr", hrs: "hr", foot: "ft", feet: "ft", "linear ft": "ft", "lin ft": "ft", lf: "ft", sqft: "sq ft", "square feet": "sq ft" };
const ABBREVIATED = new Set(["sq", "ft", "sq ft", "sq yd", "yd", "cu yd", "cy", "hr", "sf", "in", "lb", "lbs", "gal", "mo", "wk", "km", "m", "m2", "sq m", "kg", "l"]);

function plural(word: string): string {
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** A quantity as written on the page: "24.2 sq", "210 ft", "6 sheets", or just "3" for each. */
export function quantityLabel(quantity: Amount, unit: string | null | undefined): string {
  const q = Number(quantity ?? 0);
  const number = q.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const u = (unit ?? "").trim().toLowerCase();
  if (BARE.has(u)) return number;
  const short = SHORT[u] ?? u;
  if (ABBREVIATED.has(short) || q === 1 || /\s/.test(short) || /s$/.test(short)) return `${number} ${short}`;
  return `${number} ${plural(short)}`;
}

/** "2026-10-22" or a timestamp -> "October 22, 2026". */
export function longDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** "2026-10-24T18:14:00Z" -> "Oct 24, 2026", for the date beside a signature. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------------------------------
// A quote as a document
// ---------------------------------------------------------------------------------------------

/** The business's signature on an approval (quotes.approval.company). */
export interface CompanyApproval {
  name: string;
  user_id: string | null;
  signature: string;
  signed_at: string;
}

/** quotes.approval as the app reads it, whichever way the quote was approved. */
export interface QuoteApproval {
  /** The customer's printed name; for an office "Mark approved", the office person's. */
  name: string;
  signature: string | null;
  signed_at: string | null;
  /** Online approvals have none; "manual" is the office marking it approved; "in_person" is signed on site. */
  method: "manual" | "in_person" | null;
  company: CompanyApproval | null;
  /**
   * The template it was signed (or marked approved) on, saved with the approval so later edits to
   * the business's templates never change the terms above a signature. Older approvals have none.
   */
  template?: TemplateSettings | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const PNG = /^data:image\/png;base64,/;

/** Reads quotes.approval (free-form jsonb) into its known shape; null when there's none. */
export function readApproval(raw: unknown): QuoteApproval | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const c = a.company && typeof a.company === "object" ? (a.company as Record<string, unknown>) : null;
  const companySignature = str(c?.signature);
  return {
    name: str(a.name)?.trim() ?? "",
    signature: str(a.signature) && PNG.test(str(a.signature)!) ? str(a.signature) : null,
    signed_at: str(a.signed_at),
    method: a.method === "manual" || a.method === "in_person" ? a.method : null,
    company: c && companySignature && PNG.test(companySignature) ? { name: str(c.name)?.trim() ?? "", user_id: str(c.user_id), signature: companySignature, signed_at: str(c.signed_at) ?? "" } : null,
    template: a.template && typeof a.template === "object" && !Array.isArray(a.template) ? templateSettings(a.template) : null,
  };
}

/** A quote the customer has said yes to: its look and its signatures are settled. */
export const isSignedQuote = (status: string) => status === "approved" || status === "converted";

/** The quote fields that decide which template it prints with. */
export interface TemplatedQuote {
  template_id: string | null;
  approval: unknown;
  /** Without it, an approval that saved its template counts as signed. */
  status?: string;
}

/**
 * The template a signed quote keeps: the one saved with its approval. Null for a quote that isn't
 * signed, or was signed before approvals saved their template.
 */
export function signedTemplate(quote: TemplatedQuote): TemplateSettings | null {
  if (quote.status !== undefined && !isSignedQuote(quote.status)) return null;
  return readApproval(quote.approval)?.template ?? null;
}

/**
 * The template a quote prints with: the one it was signed on, else the one it names, else the
 * business's default, else the built-in look.
 */
export function quoteTemplate<T extends { id: string; is_default: boolean; settings: unknown }>(templates: readonly T[], quote: TemplatedQuote): TemplateSettings {
  return signedTemplate(quote) ?? pickTemplate(templates, quote.template_id);
}

/**
 * The signatures an approval puts on the document. An office "Mark approved" isn't the customer's
 * signature, so their line stays blank to sign by hand.
 */
export function approvalSignatures(raw: unknown, approvedAt?: string | null): NonNullable<DocumentData["signatures"]> {
  const approval = readApproval(raw);
  const customer: DocumentSignature | null =
    approval && approval.method !== "manual" && (approval.signature || approval.name) ? { name: approval.name, image: approval.signature, date: approval.signed_at ?? approvedAt ?? null } : null;
  const company: DocumentSignature | null = approval?.company ? { name: approval.company.name, image: approval.company.signature, date: approval.company.signed_at || null } : null;
  return { customer, company };
}

/** The quote fields a document reads. Rows from Supabase, the estimate kit and the hub all fit. */
export interface DocumentQuote {
  number: number | null;
  title?: string | null;
  message?: string | null;
  subtotal: Amount;
  discount_amount: Amount;
  tax_amount: Amount;
  total: Amount;
  deposit_amount?: Amount;
  valid_until?: string | null;
  sent_at?: string | null;
  created_at?: string | null;
  approved_at?: string | null;
  approval?: unknown;
  promo?: { code?: string | null } | null;
  client?: { display_name: string } | null;
  property?: Address;
}

export interface DocumentQuoteLine {
  name: string;
  description?: string | null;
  quantity: Amount;
  unit: string;
  unit_price: Amount;
  optional?: boolean | null;
  selected?: boolean | null;
  sort?: number | null;
}

/** What a screen knows beyond the quote: who it's for, the strip under the address, its date. */
export interface DocumentExtras {
  client?: { name: string; lines: string[] };
  title?: string | null;
  facts?: string[];
  /** The date it's dated; else when it was sent, else when it was made. */
  date?: string | null;
  signatures?: DocumentData["signatures"];
}

/** Whether a line counts: everything but the optional ones the customer didn't pick. */
export const countedLine = (l: { optional?: boolean | null; selected?: boolean | null }) => !l.optional || l.selected !== false;

/** A quote's lines as printed: the ones that count, in order. A price set on site prints as a normal line. */
export function documentLines(lines: readonly DocumentQuoteLine[]): DocumentLine[] {
  return lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => countedLine(line))
    .sort((a, b) => (a.line.sort ?? 0) - (b.line.sort ?? 0) || a.i - b.i)
    .map(({ line }) => ({
      name: line.name,
      description: line.description?.trim() || null,
      quantity: Number(line.quantity ?? 0),
      unit: line.unit,
      unit_price: Number(line.unit_price ?? 0),
      total: lineTotal(line.quantity, line.unit_price),
    }));
}

/** A quote as an estimate document, with its signatures once it's signed. */
export function quoteDocument(quote: DocumentQuote, lines: readonly DocumentQuoteLine[], extras: DocumentExtras = {}): DocumentData {
  const discount = Number(quote.discount_amount ?? 0);
  const deposit = Number(quote.deposit_amount ?? 0);
  return {
    kind: "estimate",
    number: quote.number,
    date: extras.date ?? quote.sent_at ?? quote.created_at ?? null,
    validUntil: quote.valid_until ?? null,
    title: extras.title !== undefined ? extras.title : quote.title ?? null,
    facts: extras.facts ?? [],
    client: extras.client ?? { name: quote.client?.display_name ?? "", lines: addressLines(quote.property) },
    lines: documentLines(lines),
    subtotal: Number(quote.subtotal ?? 0),
    discount,
    discountLabel: discount > 0 && quote.promo?.code ? `Promo code ${quote.promo.code}` : undefined,
    tax: Number(quote.tax_amount ?? 0),
    total: Number(quote.total ?? 0),
    deposit: deposit > 0 ? deposit : null,
    notes: quote.message?.trim() || null,
    signatures: extras.signatures ?? approvalSignatures(quote.approval, quote.approved_at),
  };
}

// ---------------------------------------------------------------------------------------------
// The footer on every printed page
// ---------------------------------------------------------------------------------------------

/** Text as a quoted CSS string. Quotes, backslashes, angle brackets and line breaks are escaped. */
export const cssString = (text: string) => `"${text.replace(/[\\"<>\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;

/**
 * The template's footer and "Page 2 of 3" as @page margin boxes, so they print along the bottom of
 * every page (the footer in the document itself only reaches the end of the last one). Goes inside
 * an @page rule; empty when the template has neither. The rule over them is the document's color,
 * set in from the edges like the page's own footer.
 */
export function pageFooterCss(template: Pick<TemplateSettings, "footer" | "page_numbers">, color: string, fontFamily: string): string {
  const footer = template.footer.trim();
  if (!footer && !template.page_numbers) return "";
  const rule = /^#[0-9a-f]{6}$/i.test(color) ? color : INK;
  const box = `vertical-align: top; padding-top: 10px; border-top: 2px solid ${rule}; font-family: ${fontFamily}; font-size: 10.5px; color: #5f6f76;`;
  const both = Boolean(footer) && template.page_numbers;
  return [
    footer && `@bottom-left { content: ${cssString(footer)}; ${box} text-align: left; margin-left: 44px;${both ? "" : " margin-right: 44px;"} }`,
    template.page_numbers && `@bottom-right { content: "Page " counter(page) " of " counter(pages); ${box} text-align: right; white-space: nowrap; margin-right: 44px;${both ? "" : " margin-left: 44px;"} }`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------------------------
// Samples for the template builder
// ---------------------------------------------------------------------------------------------

function sample(lines: Array<[name: string, quantity: number, unit: string, price: number, description?: string]>, rest: Omit<DocumentData, "kind" | "lines" | "subtotal" | "discount" | "tax" | "total" | "number" | "date" | "validUntil">): DocumentData {
  const docLines = lines.map(([name, quantity, unit, unit_price, description]) => ({ name, description: description ?? null, quantity, unit, unit_price, total: lineTotal(quantity, unit_price) }));
  const subtotal = docLines.reduce((sum, l) => sum + toCents(l.total), 0) / 100;
  const today = new Date();
  const until = new Date(today.getTime() + 30 * 86_400_000);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { kind: "estimate", number: 1042, date: iso(today), validUntil: iso(until), lines: docLines, subtotal, discount: 0, tax: 0, total: subtotal, ...rest };
}

/** A believable roof estimate, for the live preview and "Print a sample". */
export const SAMPLE_DOCUMENT: DocumentData = sample(
  [
    ["Architectural shingle roof", 24.2, "square", 560, "Installed, with 10% for waste"],
    ["Tear-off and disposal", 22, "square", 85, "One layer"],
    ["Drip edge", 210, "ft", 3.5, "Eaves and rakes"],
    ["Ridge cap", 64, "ft", 9, "Ridges and hips"],
    ["Valley flashing", 38, "ft", 8],
    ["Ridge vent", 48, "ft", 9],
    ["Pipe boot", 3, "ea", 45],
    ["Dumpster", 1, "ea", 450, "And cleanup"],
    ["Building permit", 1, "ea", 250],
  ],
  { title: "Architectural shingle roof", facts: ["22.0 squares", "6/12 pitch", "Tear off 1 layer"], client: { name: "Alex Morgan", lines: ["1482 Maple Ave", "Springfield, IL 62704"] }, deposit: null },
);

/** A plain estimate for any other trade. */
export const SAMPLE_GENERAL_DOCUMENT: DocumentData = sample(
  [
    ["Labor, two-person crew", 12, "hr", 95],
    ["Materials", 1, "ea", 860, "Everything the job needs, delivered"],
    ["Equipment rental", 1, "ea", 180],
    ["Cleanup and haul away", 1, "ea", 150],
  ],
  { title: "Your project", facts: ["About 2 days of work"], client: { name: "Alex Morgan", lines: ["1482 Maple Ave", "Springfield, IL 62704"] }, deposit: null },
);

/** The sample that looks like the business's own work. */
export const sampleDocument = (trade: string | null | undefined) => (trade === "roofing_exteriors" ? SAMPLE_DOCUMENT : SAMPLE_GENERAL_DOCUMENT);

/** A business as printed, from what the app already knows (session company, or a companies row). */
export function documentCompany(row: { name: string; phone?: string | null; email?: string | null; website?: string | null; address?: unknown; settings?: unknown }): DocumentCompany {
  return {
    name: row.name,
    phone: row.phone?.trim() || null,
    email: row.email?.trim() || null,
    website: row.website?.trim() || null,
    address: addressLines(row.address),
    logo: logoUrl(row.settings),
    settings: row.settings ?? {},
  };
}
