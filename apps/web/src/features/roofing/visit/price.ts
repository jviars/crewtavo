/**
 * The site visit's numbers and words, as plain functions the iPad screens and the tests share: what
 * the estimate's lines come to, the price the salesperson sets with the homeowner (before tax) and
 * what the homeowner pays at it, where that sits on the range they were sent, what changed since
 * the range, what's still missing before signing, and the sentences on the signed screen.
 *
 * On an estimate with options, the price is the option they chose (quotes.option_id): its lines and
 * the shared ones, and a price set on site is "Price adjustment" lines on that option alone, above
 * or below what it comes to less the office's discount, as the server books it (services/
 * roofPackages.ts setSitePrice; core siteSubtotal, sitePriceAdjustment and siteAdjustmentLines).
 */
import { isSiteAdjustment, lineChanges, SITE_ADJUSTMENT_NAME, siteAdjustmentLines, sitePriceAdjustment, siteSubtotal, type LineChange, type SnapshotLine } from "@crewtavo/core/estimates";
import { lineTotal, quoteTotals, toCents, type Amount } from "@crewtavo/core/money";
import { formatNumber } from "@/lib/format";
import { counts, money } from "../estimate/rows";
import type { EstimateLine, EstimateQuote } from "../estimate/types";

/** The most a price set on site can be (PUT /roofing/:id/site-price). */
export const MAX_SITE_PRICE = 10_000_000;

/** "Round to" goes down to a whole hundred. */
export const ROUND_TO = 100;

type PriceLine = Pick<EstimateLine, "option_id" | "name" | "service_id" | "formula" | "quantity" | "unit" | "unit_price" | "taxable" | "optional" | "selected">;
/** The quote as the price reads it; `option_id` is the option they chose (none without options). */
type PriceQuote = Pick<EstimateQuote, "tax_rate" | "discount_amount" | "promo_code_id" | "priced_on_site_at"> & { option_id?: string | null; lines: readonly PriceLine[] };

const sumCents = (lines: readonly PriceLine[]) => lines.reduce((sum, l) => sum + toCents(lineTotal(l.quantity, l.unit_price)), 0);
/** The option the price is for: the one chosen, or none for an estimate without options. */
const chosen = (quote: Pick<PriceQuote, "option_id">) => quote.option_id ?? null;

/** The estimate's own lines: everything that counts with `optionId` chosen, without the price adjustment set on site. */
export const estimateLines = <L extends PriceLine>(lines: readonly L[], optionId: string | null = null): L[] => lines.filter((l) => counts(l, optionId) && !isSiteAdjustment(l));

/** What the estimate's lines come to with `optionId` chosen, before tax and any discount (core siteSubtotal). */
export const estimateSubtotal = (lines: readonly PriceLine[], optionId: string | null = null) => sumCents(estimateLines(lines, optionId)) / 100;

/** The price adjustment lines set on site that count with the option chosen, in cents (below zero on an option priced lower). */
const adjustmentCents = (quote: PriceQuote) => sumCents(quote.lines.filter((l) => counts(l, chosen(quote)) && isSiteAdjustment(l)));

/**
 * What's already on the quote beside its lines, in cents (less than 0 is money off): a promo code's
 * discount, or, until a price is set on site, the discount the office gave on the quote (and any
 * price adjustment line). Once a price was set on site, that price is where the screen starts
 * instead (savedSitePrice), so this is only the promo code's, or with options the office's discount.
 */
function keptCents(quote: PriceQuote): number {
  if (quote.promo_code_id) return -toCents(quote.discount_amount);
  // With options a price set on site is a line, so the quote's discount is always the office's.
  if (quote.priced_on_site_at) return chosen(quote) !== null ? -toCents(quote.discount_amount) : 0;
  return adjustmentCents(quote) - toCents(quote.discount_amount);
}

/**
 * The price when nobody sets one: the estimate, less a promo code's discount or a discount the office
 * gave on the quote. It follows the lines, so work added on site is charged for. Before tax.
 */
export function estimatePrice(quote: PriceQuote): number {
  return Math.max(0, sumCents(estimateLines(quote.lines, chosen(quote))) + keptCents(quote)) / 100;
}

/**
 * The price set on site last time (Review and sign saves it as an adjustment line or a discount;
 * with options, a line on the option chosen). The screen starts from it, so going on doesn't quietly
 * drop it. Null when no price was set on site (an office discount isn't one: the price follows the
 * lines, less it), or a promo code sets the discount. Choosing another option clears it (the
 * database takes the price off with the option it was set for).
 */
export function savedSitePrice(quote: PriceQuote): number | null {
  if (quote.promo_code_id || !quote.priced_on_site_at) return null;
  const extra = adjustmentCents(quote);
  const discount = toCents(quote.discount_amount);
  if (!extra && !discount) return null;
  return Math.max(0, sumCents(estimateLines(quote.lines, chosen(quote))) + extra - discount) / 100;
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
 * price adjustment line. With options it's always price adjustment lines, on the option chosen, of
 * the price less what the option comes to after the office's discount (which stays): below the
 * estimate a taxed and an untaxed one, as a discount comes off (core siteAdjustmentLines, which the
 * server books). A promo code keeps its own discount.
 */
export function totalsAt(quote: PriceQuote, price: number | null): { subtotal: number; discount: number; tax: number; total: number } {
  const optionId = chosen(quote);
  const lines = estimateLines(quote.lines, optionId);
  if (quote.promo_code_id) return quoteTotals([...lines], { taxRate: quote.tax_rate, discountAmount: quote.discount_amount });
  const target = price ?? estimatePrice(quote);
  if (optionId !== null) {
    const { extra } = sitePriceAdjustment(optionNet(quote), target, { onOption: true });
    const priced = [...lines, ...siteAdjustmentLines(extra, lines).map((l) => ({ quantity: 1, ...l }))];
    return quoteTotals(priced, { taxRate: quote.tax_rate, discountAmount: quote.discount_amount });
  }
  const { discount, extra } = sitePriceAdjustment(estimateSubtotal(quote.lines), target);
  const priced = extra > 0 ? [...lines, { quantity: 1, unit_price: extra, taxable: true }] : [...lines];
  return quoteTotals(priced, { taxRate: quote.tax_rate, discountAmount: discount });
}

/** A line as the paper beside the visit prints it. */
export type PaperLine = Pick<EstimateLine, "id" | "option_id" | "service_id" | "name" | "description" | "quantity" | "unit" | "unit_price" | "taxable" | "optional" | "selected" | "formula" | "sort">;

/**
 * The estimate's lines and discount as they will be once Review and sign saves the price set here
 * (null: the estimate's), for the paper beside the visit: the earlier price adjustment swapped for
 * the new one, booked as the server books it (services/roofPackages.ts setSitePrice). Below the
 * estimate it's a discount, above it a price adjustment line; with options it's always lines on the
 * option chosen, and the office's discount stays. A promo code keeps its own discount, so the
 * estimate is as it is.
 */
export function sitePriced<L extends PaperLine>(quote: Omit<PriceQuote, "lines"> & { lines: readonly L[] }, override: number | null): { lines: Array<L | PaperLine>; discount: number } {
  if (quote.promo_code_id) return { lines: [...quote.lines], discount: Number(quote.discount_amount) };
  const shown = chosen(quote);
  const onOption = shown !== null;
  const price = priceToSave(quote, override);
  const subtotal = siteSubtotal(quote.lines, shown);
  const net = onOption ? (toCents(subtotal) - toCents(quote.discount_amount)) / 100 : subtotal;
  const { discount, extra } = price === null ? { discount: 0, extra: 0 } : sitePriceAdjustment(net, price, { onOption });
  const work = quote.lines.filter((l) => counts(l, shown) && !isSiteAdjustment(l));
  const parts = onOption ? siteAdjustmentLines(extra, work) : extra > 0 ? [{ unit_price: extra, taxable: true }] : [];
  const sort = quote.lines.reduce((max, l) => Math.max(max, l.sort), 0) + 1;
  const kept = quote.lines.filter((l) => !(isSiteAdjustment(l) && (l.option_id === null || l.option_id === shown)));
  const added: PaperLine[] = parts.map((part, i) => ({
    id: `site-price-${i}`,
    option_id: shown,
    service_id: null,
    name: SITE_ADJUSTMENT_NAME,
    description: null,
    quantity: 1,
    unit: "ea",
    unit_price: part.unit_price,
    taxable: part.taxable,
    optional: false,
    selected: true,
    formula: null,
    sort: sort + i,
  }));
  return { lines: [...kept, ...added], discount: onOption ? Number(quote.discount_amount) : discount };
}

/**
 * What the option chosen comes to before tax, less the office's discount and without a price set on
 * site: what the server measures a price set on an option against (siteSubtotal less discount_amount).
 */
export const optionNet = (quote: PriceQuote) => (toCents(estimateSubtotal(quote.lines, chosen(quote))) - toCents(quote.discount_amount)) / 100;

/**
 * The key the price typed on the iPad is kept under for the tab: the quote's, and with options the
 * option's too, so choosing another option starts from its own price.
 */
export const keptPriceKey = (quoteId: string, optionId: string | null) => `crewtavo.site-price.${quoteId}${optionId ? `.${optionId}` : ""}`;

/** An amount rounded down to a whole `step` ($19,524 → $19,500). */
export const roundDown = (amount: number, step = ROUND_TO) => (Math.floor(toCents(amount) / (step * 100)) * step * 100) / 100;

/** A price as typed ("19,500", "$19,500.50"), to the cent; null when it isn't one. */
export function parsePrice(text: string): number | null {
  const clean = text.replace(/[\s$,]/g, "");
  if (!/^\d*(\.\d{0,2})?$/.test(clean) || !/\d/.test(clean)) return null;
  const value = toCents(Number(clean)) / 100;
  return value > 0 && value <= MAX_SITE_PRICE ? value : null;
}

/** The most of one thing a line can be set to by hand (LineEditor). */
export const MAX_QUANTITY = 100_000;

/** How many of something, as typed ("3", "1,200", "2.5"), to a thousandth; null when it isn't one above zero. */
export function readQuantity(text: string): number | null {
  const clean = text.replace(/[\s,]/g, "");
  if (!/^\d*(\.\d{0,3})?$/.test(clean) || !/\d/.test(clean)) return null;
  const n = Math.round(Number(clean) * 1000) / 1000;
  return n > 0 && n <= MAX_QUANTITY ? n : null;
}

/** A price in the box: "19,524", or "19,524.50" when there are cents. */
export const priceInputText = (n: number) => formatNumber(n, toCents(n) % 100 === 0 ? 0 : 2);

/**
 * What the set price does to the estimate, in a line under the box: the difference from what its
 * lines come to (estimateSubtotal), which is what the document shows as a discount or an adjustment.
 * On an option (`onOption`), it's the difference from what the option comes to after the office's
 * `discount`, and either way it's a price adjustment line.
 */
export function adjustmentNote(subtotal: number, price: number | null, { onOption = false, discount = 0 }: { onOption?: boolean; discount?: Amount } = {}): string | null {
  if (price === null) return null;
  const diff = toCents(price) - toCents(subtotal) + (onOption ? toCents(discount) : 0);
  if (diff > 0) return `The extra ${money(diff / 100)} shows on the estimate as a price adjustment.`;
  if (diff < 0) return `The ${money(-diff / 100)} off shows on the estimate as ${onOption ? "a price adjustment" : "a discount"}.`;
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
 * What the salesperson changed since the range went out, on the option being looked at (null without
 * options) and the shared lines. The price adjustment isn't a change to the work: it's the price,
 * shown on its own.
 */
export function visitChanges(rangeLines: readonly SnapshotLine[] | null | undefined, lines: ReadonlyArray<PriceLine & { id: string }>, optionId: string | null = null): LineChange[] | null {
  if (!rangeLines) return null;
  return lineChanges(
    rangeLines.filter((s) => !isSiteAdjustment(s)),
    lines.filter((l) => !isSiteAdjustment(l)),
    optionId,
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
