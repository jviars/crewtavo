/**
 * The site visit's numbers and words, as plain functions the iPad screens and the tests share: what
 * the estimate's lines come to, the price the salesperson sets with the homeowner (before tax) and
 * what the homeowner pays at it, where that sits on the range they were sent, what changed since
 * the range, what's still missing before signing, and the sentences on the signed screen.
 */
import { isSiteAdjustment, lineChanges, sitePriceAdjustment, type LineChange, type SnapshotLine } from "@crewtavo/core/estimates";
import { lineTotal, quoteTotals, toCents } from "@crewtavo/core/money";
import { formatNumber } from "@/lib/format";
import type { TakeoffRow } from "../../paving/data";
import { counts, money } from "../estimate/rows";
import type { EstimateLine, EstimateQuote } from "../estimate/types";

/** The most a price set on site can be (PUT /roofing/:id/site-price). */
export const MAX_SITE_PRICE = 10_000_000;

/** "Round to" goes down to a whole hundred. */
export const ROUND_TO = 100;

type PriceLine = Pick<EstimateLine, "name" | "service_id" | "formula" | "quantity" | "unit" | "unit_price" | "taxable" | "optional" | "selected">;
type PriceQuote = Pick<EstimateQuote, "tax_rate" | "discount_amount" | "promo_code_id" | "priced_on_site_at"> & { lines: readonly PriceLine[] };

const sumCents = (lines: readonly PriceLine[]) => lines.reduce((sum, l) => sum + toCents(lineTotal(l.quantity, l.unit_price)), 0);

/** The estimate's own lines: everything that counts, without the price adjustment set on site. */
export const estimateLines = <L extends PriceLine>(lines: readonly L[]): L[] => lines.filter((l) => counts(l) && !isSiteAdjustment(l));

/** What the estimate's lines come to, before tax and any discount. */
export const estimateSubtotal = (lines: readonly PriceLine[]) => sumCents(estimateLines(lines)) / 100;

/**
 * What's already on the quote beside its lines, in cents (less than 0 is money off): a promo code's
 * discount, or, until a price is set on site, the discount the office gave on the quote (and any
 * price adjustment line). Once a price was set on site, that price is where the screen starts
 * instead (savedSitePrice), so this is only the promo code's.
 */
function keptCents(quote: PriceQuote): number {
  if (quote.promo_code_id) return -toCents(quote.discount_amount);
  if (quote.priced_on_site_at) return 0;
  return sumCents(quote.lines.filter((l) => counts(l) && isSiteAdjustment(l))) - toCents(quote.discount_amount);
}

/**
 * The price when nobody sets one: the estimate, less a promo code's discount or a discount the office
 * gave on the quote. It follows the lines, so work added on site is charged for. Before tax.
 */
export function estimatePrice(quote: PriceQuote): number {
  return Math.max(0, sumCents(estimateLines(quote.lines)) + keptCents(quote)) / 100;
}

/**
 * The price set on site last time (Review and sign saves it as an adjustment line or a discount).
 * The screen starts from it, so going on doesn't quietly drop it. Null when no price was set on
 * site (an office discount isn't one: the price follows the lines, less it), or a promo code sets
 * the discount.
 */
export function savedSitePrice(quote: PriceQuote): number | null {
  if (quote.promo_code_id || !quote.priced_on_site_at) return null;
  const extra = sumCents(quote.lines.filter((l) => counts(l) && isSiteAdjustment(l)));
  const discount = toCents(quote.discount_amount);
  if (!extra && !discount) return null;
  return Math.max(0, sumCents(estimateLines(quote.lines)) + extra - discount) / 100;
}

/**
 * The price Review and sign saves (PUT /roofing/:id/site-price): the one set here, else null for the
 * estimate as it is. When the office took money off the quote, the estimate's price is saved
 * instead, so its discount stays (a null price would clear it). A promo code keeps its own.
 */
export function priceToSave(quote: PriceQuote, override: number | null): number | null {
  if (quote.promo_code_id) return null;
  if (override !== null) return override;
  return keptCents(quote) ? estimatePrice(quote) : null;
}

/** The line under the price box while it's the estimate's price and the office took money off it. */
export function keptNote(quote: PriceQuote): string | null {
  if (quote.promo_code_id) return null;
  const kept = keptCents(quote);
  if (kept < 0) return `Before tax, with the ${money(-kept / 100)} off already on the estimate.`;
  if (kept > 0) return `Before tax, with the ${money(kept / 100)} price adjustment already on the estimate.`;
  return null;
}

/**
 * What the quote comes to at a price set before tax (null: the estimate's price), worked out the way
 * the server and the database will: below the estimate's lines it's a discount, above them a taxable
 * price adjustment line. A promo code keeps its own discount.
 */
export function totalsAt(quote: PriceQuote, price: number | null): { subtotal: number; discount: number; tax: number; total: number } {
  const lines = estimateLines(quote.lines);
  if (quote.promo_code_id) return quoteTotals([...lines], { taxRate: quote.tax_rate, discountAmount: quote.discount_amount });
  const { discount, extra } = sitePriceAdjustment(estimateSubtotal(quote.lines), price ?? estimatePrice(quote));
  const priced = extra > 0 ? [...lines, { quantity: 1, unit_price: extra, taxable: true }] : [...lines];
  return quoteTotals(priced, { taxRate: quote.tax_rate, discountAmount: discount });
}

/** An amount rounded down to a whole `step` ($19,524 → $19,500). */
export const roundDown = (amount: number, step = ROUND_TO) => (Math.floor(toCents(amount) / (step * 100)) * step * 100) / 100;

/** A price as typed ("19,500", "$19,500.50"), to the cent; null when it isn't one. */
export function parsePrice(text: string): number | null {
  const clean = text.replace(/[\s$,]/g, "");
  if (!/^\d*(\.\d{0,2})?$/.test(clean) || !/\d/.test(clean)) return null;
  const value = toCents(Number(clean)) / 100;
  return value > 0 && value <= MAX_SITE_PRICE ? value : null;
}

/** A price in the box: "19,524", or "19,524.50" when there are cents. */
export const priceInputText = (n: number) => formatNumber(n, toCents(n) % 100 === 0 ? 0 : 2);

/**
 * What the set price does to the estimate, in a line under the box: the difference from what its
 * lines come to (estimateSubtotal), which is what the document shows as a discount or an adjustment.
 */
export function adjustmentNote(subtotal: number, price: number | null): string | null {
  if (price === null) return null;
  const diff = toCents(price) - toCents(subtotal);
  if (diff > 0) return `The extra ${money(diff / 100)} shows on the estimate as a price adjustment.`;
  if (diff < 0) return `The ${money(-diff / 100)} off shows on the estimate as a discount.`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// The range
// ---------------------------------------------------------------------------------------------

/** Where the price sits on the range, in words for the price panel and the bar along the bottom. */
export function rangeNote(where: "below" | "inside" | "above", over: number, first: string, accepted: boolean): { text: string; short: string } {
  const who = first || "they";
  if (where === "above") return { text: `${money(over)} above the range. Say why in your notes.`, short: `${money(over)} above the range` };
  const range = accepted ? `the range ${who} said yes to` : `the range ${who} ${first ? "was" : "were"} sent`;
  if (where === "below") return { text: `Under ${range}`, short: "Under the range" };
  return { text: `Inside ${range}`, short: "Inside the range" };
}

/** "$18,300 to $21,050" */
export const rangeWords = (low: number, high: number) => `${money(low)} to ${money(high)}`;

/** "Oct 23", with the year when it isn't this year, in the business's time zone. */
export function shortDay(iso: string, timeZone: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const year = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", timeZone });
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: year(at) === year(now) ? undefined : "numeric", timeZone });
}

/**
 * What the salesperson changed since the range went out. The price adjustment isn't a change to the
 * work: it's the price, shown on its own.
 */
export function visitChanges(rangeLines: readonly SnapshotLine[] | null | undefined, lines: ReadonlyArray<PriceLine & { id: string }>): LineChange[] | null {
  if (!rangeLines) return null;
  return lineChanges(
    rangeLines.filter((s) => !isSiteAdjustment(s)),
    lines.filter((l) => !isSiteAdjustment(l)),
  );
}

// ---------------------------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------------------------

/** What's still missing before the estimate can be signed, as the button says it; null when ready. */
export function signBlocker(s: { name: string; signature: string | null; companyNeeded: boolean; companySignature: string | null; company: string }): string | null {
  if (!s.signature) return "Sign above to finish";
  if (s.name.trim().length < 2) return "Type your name to finish";
  if (s.companyNeeded && !s.companySignature) return `Sign for ${s.company} to finish`;
  return null;
}

/**
 * The strip under the address on the document: the package, the roof's squares and its pitch,
 * worded as the homeowner's link words them (hub/document.ts), so both copies read the same.
 */
export function roofFacts(packageName: string | null | undefined, takeoff: Pick<TakeoffRow, "roofing_squares" | "roof_pitch"> | null | undefined): string[] {
  const facts = packageName?.trim() ? [packageName.trim()] : [];
  const squares = takeoff?.roofing_squares == null ? 0 : Number(takeoff.roofing_squares);
  if (squares > 0) {
    facts.push(`${formatNumber(squares, 1)} squares`);
    if (takeoff?.roof_pitch) facts.push(`${takeoff.roof_pitch} pitch`);
  }
  return facts;
}

// ---------------------------------------------------------------------------------------------
// Signed
// ---------------------------------------------------------------------------------------------

/** How signing went, for the signed screen: whether the copy was emailed, and why not. */
export interface SigningOutcome {
  emailed: boolean;
  email_reason: string | null;
}

/** A signing outcome passed along (router state, or kept for the tab); null when it isn't one. */
export function readSigningOutcome(value: unknown): SigningOutcome | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { emailed?: unknown; email_reason?: unknown };
  if (typeof v.emailed !== "boolean") return null;
  return { emailed: v.emailed, email_reason: typeof v.email_reason === "string" && v.email_reason.trim() ? v.email_reason : null };
}

export interface CopyMessage {
  channel: string;
  subject: string | null;
  created_at: string;
}

/**
 * The signed copies sent since it was signed (messages logged by POST /quotes/:id/sign and
 * send-copy), the newest of each kind, so the signed screen knows after a reload too.
 */
export function signedCopies(messages: readonly CopyMessage[], approvedAt: string | null): { email: CopyMessage | null; sms: CopyMessage | null } {
  // A couple of minutes' grace for the clocks of the server and the database.
  const since = approvedAt ? Date.parse(approvedAt) - 120_000 : Number.NEGATIVE_INFINITY;
  const newest = (channel: string) =>
    messages
      .filter((m) => m.channel === channel && /signed estimate/i.test(m.subject ?? "") && Date.parse(m.created_at) >= since)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
  return { email: newest("email"), sms: newest("sms") };
}

/** "at 2:14 PM" today, else "on Oct 22 at 2:14 PM", in the business's time zone. */
export function signedWhen(iso: string, timeZone: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  return day(at) === day(now) ? `at ${time}` : `on ${shortDay(iso, timeZone, now)} at ${time}`;
}

/**
 * The sentence under "Signed.": who signed, for how much (shown bold) and when.
 * "Dana Whitfield and you signed the estimate for | $19,524 | at 2:14 PM. It's saved on the project
 * with both signatures."
 */
export function signedSentence(s: {
  client: string;
  amount: number;
  signedAt: string | null;
  timeZone: string;
  method: "manual" | "in_person" | null;
  /** Who signed for the business, and whether that's the person looking. */
  companySigner: string | null;
  byMe: boolean;
  now?: Date;
}): { lead: string; amount: string; rest: string } {
  const client = s.client.trim() || "The homeowner";
  const when = s.signedAt ? ` ${signedWhen(s.signedAt, s.timeZone, s.now)}` : "";
  const amount = money(s.amount);
  if (s.method === "manual") return { lead: "The estimate for", amount, rest: ` was marked approved${when}.` };
  const both = Boolean(s.companySigner) || s.byMe;
  const saved = ` It's saved on the project${both ? " with both signatures" : ""}.`;
  if (s.method === "in_person") {
    const who = s.byMe ? `${client} and you` : s.companySigner ? `${client} and ${s.companySigner}` : client;
    return { lead: `${who} signed the estimate for`, amount, rest: `${when}.${saved}` };
  }
  return { lead: `${client} signed the estimate online for`, amount, rest: `${when}.${saved}` };
}

// ---------------------------------------------------------------------------------------------
// The price being set, kept for this tab
// ---------------------------------------------------------------------------------------------

/**
 * A price typed on the iPad is kept for the tab until it's saved, so stepping away (to fix the
 * measurements, say) doesn't lose it. "estimate" means they chose the estimate as it is.
 */
export function readKeptPrice(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  if (raw === "estimate") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= MAX_SITE_PRICE ? toCents(n) / 100 : undefined;
}

export const keptPriceText = (price: number | null) => (price === null ? "estimate" : String(price));
