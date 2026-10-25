/**
 * The roofing estimate's money steps, shared by the web app and the API so both agree to the cent:
 * the price range a homeowner is sent (from the lowest option to the highest when the estimate
 * offers two or three), a package's roof price that follows ABC Supply, what changed between the
 * range and the signed estimate, and the exact price the salesperson sets on site.
 */
import { countsOn, discountSplit, inOptionBase, lineTotal, toCents, type Amount, type TotalsLine } from "./money";

// ---------------------------------------------------------------------------------------------
// The price range
// ---------------------------------------------------------------------------------------------

/** companies.settings.roofing: how much room the range leaves on top, and what it rounds to. */
export interface RangeSettings {
  pct: number;
  round: number;
}

export const DEFAULT_RANGE: RangeSettings = { pct: 15, round: 50 };
export const RANGE_ROUNDING = [10, 25, 50, 100, 250, 500, 1000] as const;

/** The range settings saved on a business, with the defaults for anything missing or out of shape. */
export function rangeSettings(companySettings: unknown): RangeSettings {
  const roofing = companySettings && typeof companySettings === "object" ? (companySettings as { roofing?: unknown }).roofing : null;
  const r = roofing && typeof roofing === "object" ? (roofing as { range_pct?: unknown; range_round?: unknown }) : {};
  const pct = typeof r.range_pct === "number" && Number.isFinite(r.range_pct) && r.range_pct >= 0 && r.range_pct <= 100 ? r.range_pct : DEFAULT_RANGE.pct;
  const round = typeof r.range_round === "number" && (RANGE_ROUNDING as readonly number[]).includes(r.range_round) ? r.range_round : DEFAULT_RANGE.round;
  return { pct, round };
}

/**
 * The range for an estimate: the low end is the estimate rounded down, the high end the estimate plus
 * the room on top, rounded up. $18,304 at 15% to the nearest $50 is $18,300 to $21,050.
 */
export function priceRange(amount: Amount, settings: RangeSettings = DEFAULT_RANGE): { low: number; high: number } {
  const cents = Math.max(0, toCents(amount));
  const step = Math.round(settings.round * 100);
  const low = Math.floor(cents / step) * step;
  // Basis points keep 15% exact (an estimate times 1.15 in floating point can land a cent high).
  const withRoom = Math.round((cents * Math.round(10000 + settings.pct * 100)) / 10000);
  const high = Math.max(low, Math.ceil(withRoom / step) * step);
  return { low: low / 100, high: high / 100 };
}

/**
 * The range for an estimate that offers options: from the cheapest option's low end to the
 * priciest one's high end, each worked out as priceRange does (so one option's range is its own).
 * Options with no total yet, or a zero one, are left out. Totals come from optionBaseTotal (money.ts).
 */
export function optionsRange(totals: readonly Amount[], settings: RangeSettings = DEFAULT_RANGE): { low: number; high: number } {
  const priced = totals.filter((t) => toCents(t) > 0).sort((a, b) => toCents(a) - toCents(b));
  if (!priced.length) return priceRange(0, settings);
  return { low: priceRange(priced[0], settings).low, high: priceRange(priced[priced.length - 1], settings).high };
}

/**
 * Whether a quote is out as a range: the homeowner hasn't seen an exact price yet, because nobody has
 * set one on site and the office hasn't sent the exact price instead.
 */
export function inRangeMode(quote: { range_low: Amount; priced_on_site_at: string | null; exact_sent_at?: string | null; status: string }): boolean {
  return quote.range_low !== null && quote.range_low !== undefined && quote.priced_on_site_at === null && !quote.exact_sent_at && ["draft", "sent", "changes_requested"].includes(quote.status);
}

/**
 * Whether a quote's exact price must stay off the homeowner's screen: it went out as a range and no
 * exact price has been set or sent since, whatever happened after (lost and archived included). Only a
 * signed estimate shows its price.
 */
export function hidesExactPrice(quote: { range_low: Amount; priced_on_site_at: string | null; exact_sent_at?: string | null; status: string }): boolean {
  return quote.range_low !== null && quote.range_low !== undefined && quote.priced_on_site_at === null && !quote.exact_sent_at && !["approved", "converted"].includes(quote.status);
}

// ---------------------------------------------------------------------------------------------
// A roof price that follows ABC Supply
// ---------------------------------------------------------------------------------------------

/** A square at today's materials: (materials + labor and the rest) plus the markup, to the cent. */
export function followPrice(materialsPerUnit: Amount, laborCost: Amount, markupPct: Amount): number {
  const cost = toCents(materialsPerUnit) + toCents(laborCost);
  const markup = Math.round(Number(markupPct ?? 0) * 100);
  return Math.round((cost * (10000 + markup)) / 10000) / 100;
}

/** The margin on a price, as a whole percent; null when there's no price. */
export function marginPct(price: Amount, cost: Amount): number | null {
  const p = toCents(price);
  if (!(p > 0)) return null;
  return Math.round(((p - toCents(cost)) / p) * 100);
}

// ---------------------------------------------------------------------------------------------
// What changed between the range and now
// ---------------------------------------------------------------------------------------------

/** A line as it was when the range was sent (quotes.range_lines). */
export interface SnapshotLine {
  id: string;
  /** The option it's on; null on every option. Missing from ranges sent before options. */
  option_id?: string | null;
  service_id: string | null;
  name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  unit_cost: number | null;
  taxable: boolean;
  formula: string | null;
  total: number;
}

/** The parts of a quote line the comparison reads. Unselected optional lines don't count. */
export interface CurrentLine {
  id: string;
  /** The option it's on; null on every option. Optional only for screens that don't offer options yet: select it. */
  option_id?: string | null;
  service_id: string | null;
  name: string;
  quantity: Amount;
  unit: string;
  unit_price: Amount;
  optional?: boolean;
  selected?: boolean;
}

export interface LineChange {
  kind: "added" | "removed" | "changed";
  /** The current line, or the one that was taken off. */
  id: string;
  name: string;
  unit: string;
  from: number | null;
  to: number | null;
  /** What it adds to the price; negative when it takes away. */
  amount: number;
  /** For a line that was taken off: what to put back. */
  snapshot?: SnapshotLine;
}

/**
 * The lines of a quote as they are now, to save on the quote when the range goes out: exactly what
 * the range was priced from (money.ts inOptionBase). That's the shared lines as they're picked and
 * every option's required lines, without the add-ons on an option, so whichever option is shown the
 * snapshot is the same, and each option's lines in it add up to its optionBaseTotal. Select the
 * lines' option_id, or every option's lines are saved as shared.
 */
export function snapshotLines(lines: ReadonlyArray<CurrentLine & { unit_cost?: Amount; taxable?: boolean; formula?: string | null }>): SnapshotLine[] {
  return lines
    .filter((l) => inOptionBase(l, l.option_id ?? null))
    .map((l) => ({
      id: l.id,
      option_id: l.option_id ?? null,
      service_id: l.service_id,
      name: l.name,
      quantity: Number(l.quantity ?? 0),
      unit: l.unit,
      unit_price: Number(l.unit_price ?? 0),
      unit_cost: l.unit_cost === null || l.unit_cost === undefined ? null : Number(l.unit_cost),
      taxable: l.taxable ?? true,
      formula: l.formula ?? null,
      total: lineTotal(l.quantity, l.unit_price),
    }));
}

/**
 * What changed since the range: lines added, lines taken off and lines whose quantity or price moved.
 * Lines match by id, and a line that was taken off and put back (a new id) matches by its service and
 * name, so putting it back isn't shown as a change. Only the shared lines and those of `optionId`
 * (the quote's option_id) are compared, so with no option that's the shared lines, which is every
 * line of a quote without options. An add-on picked on the option shows as added: the range was
 * priced without it.
 */
export function lineChanges(snapshot: readonly SnapshotLine[] | null | undefined, current: readonly CurrentLine[], optionId: string | null = null): LineChange[] {
  if (!snapshot) return [];
  const counted = current.filter((l) => countsOn(l, optionId));
  const kept = snapshot.filter((s) => s.option_id == null || s.option_id === optionId);
  const left = new Map(kept.map((s) => [s.id, s]));
  const pairs: Array<[CurrentLine, SnapshotLine | undefined]> = counted.map((l) => {
    const s = left.get(l.id);
    if (s) left.delete(l.id);
    return [l, s];
  });
  for (const pair of pairs) {
    if (pair[1]) continue;
    const match = [...left.values()].find((s) => s.service_id === pair[0].service_id && s.name === pair[0].name);
    if (match) {
      left.delete(match.id);
      pair[1] = match;
    }
  }
  const changes: LineChange[] = [];
  for (const [l, s] of pairs) {
    const total = lineTotal(l.quantity, l.unit_price);
    const quantity = Number(l.quantity ?? 0);
    if (!s) {
      changes.push({ kind: "added", id: l.id, name: l.name, unit: l.unit, from: null, to: quantity, amount: total });
    } else if (toCents(total) !== toCents(s.total)) {
      changes.push({ kind: "changed", id: l.id, name: l.name, unit: l.unit, from: s.quantity, to: quantity, amount: (toCents(total) - toCents(s.total)) / 100 });
    }
  }
  for (const s of left.values()) {
    changes.push({ kind: "removed", id: s.id, name: s.name, unit: s.unit, from: s.quantity, to: null, amount: -s.total, snapshot: s });
  }
  return changes;
}

// ---------------------------------------------------------------------------------------------
// The exact price, set on site
// ---------------------------------------------------------------------------------------------

/** The line that carries a price set above the estimate, or any price set on an estimate with options. */
export const SITE_ADJUSTMENT_NAME = "Price adjustment";

export const isSiteAdjustment = (line: { name: string; service_id: string | null; formula?: string | null }) =>
  line.name === SITE_ADJUSTMENT_NAME && line.service_id === null && !line.formula;

/**
 * What the lines a price set on site is measured against come to, before tax and any discount: the
 * ones that count with `shownOptionId` shown (null for a quote without options), without an earlier
 * price adjustment. The server (setSitePrice) and the iPad (visit/price.ts) both start from it.
 */
export function siteSubtotal(
  lines: ReadonlyArray<{ option_id: string | null; optional?: boolean | null; selected?: boolean | null; name: string; service_id: string | null; formula?: string | null; quantity: Amount; unit_price: Amount }>,
  shownOptionId: string | null,
): number {
  return lines.filter((l) => countsOn(l, shownOptionId) && !isSiteAdjustment(l)).reduce((sum, l) => sum + toCents(lineTotal(l.quantity, l.unit_price)), 0) / 100;
}

/**
 * How a price set on site lands on the quote, before tax: below the estimate it's a discount, above
 * it a price adjustment line. `subtotal` is siteSubtotal(). On a quote with options (`onOption`) the
 * whole difference is the price adjustment, below zero when the price is lower, on the shown option's
 * lines (option_id = the shown option; siteAdjustmentLines), so it never moves another option's price
 * the way a discount on the whole quote would. Zero means no line.
 */
export function sitePriceAdjustment(subtotal: Amount, price: Amount, options: { onOption?: boolean } = {}): { discount: number; extra: number } {
  const diff = toCents(price) - toCents(subtotal);
  if (options.onOption) return { discount: 0, extra: diff / 100 };
  return diff < 0 ? { discount: -diff / 100, extra: 0 } : { discount: 0, extra: diff / 100 };
}

/**
 * The "Price adjustment" lines that carry `extra` (sitePriceAdjustment's) on an option. Above the
 * estimate it's one taxed line. Below it, it comes off like a discount: a taxed line and an untaxed
 * one, in proportion to the charges of `lines` (the lines that count, without an earlier adjustment;
 * core discountSplit), so tax comes off as it would without options, and as when an estimate priced
 * on site becomes option 1 (quote_option_added). A zero part is left out. The server books these
 * (setSitePrice) and the iPad prices with them (visit/price.ts totalsAt).
 */
export function siteAdjustmentLines(extra: Amount, lines: readonly TotalsLine[]): Array<{ unit_price: number; taxable: boolean }> {
  const cents = toCents(extra);
  if (cents >= 0) return cents ? [{ unit_price: cents / 100, taxable: true }] : [];
  const { taxed, untaxed } = discountSplit(-cents / 100, lines);
  return [
    { unit_price: -taxed, taxable: true },
    { unit_price: -untaxed, taxable: false },
  ].filter((l) => l.unit_price !== 0);
}

/**
 * Whether a price set on site is in effect: its "Price adjustment" line on what counts (the shown
 * option's, or every option's), or, on a quote without options, the discount it set. A promo code
 * doesn't go on top of it, as the price doesn't go on top of a code: on an option the code would come
 * off the price agreed, and without options it would replace it. A visit that kept the estimate's
 * price set neither, so a code still goes on then. The API refuses the code (the office's and the
 * Client Hub's promo routes) and the screens don't offer it.
 */
export function sitePriceSet(
  quote: { priced_on_site_at: string | null; option_id: string | null; promo_code_id: string | null; discount_amount: Amount },
  lines: ReadonlyArray<{ option_id: string | null; name: string; service_id: string | null; formula?: string | null; optional?: boolean | null; selected?: boolean | null }>,
): boolean {
  if (quote.priced_on_site_at === null) return false;
  if (lines.some((l) => isSiteAdjustment(l) && countsOn(l, quote.option_id))) return true;
  return quote.option_id === null && quote.promo_code_id === null && toCents(quote.discount_amount) > 0;
}

/** Why the office can't add a promo code to an estimate priced on site (sitePriceSet). */
export const SITE_PRICE_SET = "A price was set on site for this estimate, so a promo code can't go on it too. Set the price back to the estimate's first.";

// ---------------------------------------------------------------------------------------------
// The words an estimate goes out with
// ---------------------------------------------------------------------------------------------

/**
 * The message a price range goes out with unless the office writes its own, with `low` and `high`
 * already formatted ("$18,300"). An estimate that offers two or three options says the range runs
 * across them. The server's email (services/sales.ts rangeMessage) and the office's send dialog
 * (roofing/flow/model.ts rangeIntro) both use it, so they never drift apart.
 */
export function rangeIntroText(low: string, high: string, optionCount = 0): string {
  return optionCount >= 2
    ? `Thanks for having us look at your roof. From our measurements, your new roof will cost between ${low} and ${high}, depending on the option you pick. You can see the options and let us know when you'd like us to come out:`
    : `Thanks for having us look at your roof. From our measurements, your new roof will cost between ${low} and ${high}. You can see what's included and let us know when you'd like us to come out:`;
}

/**
 * The message a quote that offers options goes out with unless the office writes its own: how many
 * options there are and the lowest price among them (`from`, already formatted), each option priced
 * before its add-ons as the Client Hub prices its cards (money.ts optionBaseTotal; count only the
 * options that have a price). The server's email (services/sales.ts optionsMessage) uses it, and so
 * should any screen that shows the words before they go.
 */
export function optionsIntroText(count: number, from: string): string {
  return `Thanks for the opportunity. Here's your quote, with ${count} options from ${from}. You can compare them, choose the one you want and approve it online:`;
}
