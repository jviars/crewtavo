/**
 * The roofing estimate's money steps, shared by the web app and the API so both agree to the cent:
 * the price range a homeowner is sent, a package's roof price that follows ABC Supply, what changed
 * between the range and the signed estimate, and the exact price the salesperson sets on site.
 */
import { lineTotal, toCents, type Amount } from "./money";

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

/** The lines of a quote as they are now, to save on the quote when the range goes out. */
export function snapshotLines(lines: ReadonlyArray<CurrentLine & { unit_cost?: Amount; taxable?: boolean; formula?: string | null }>): SnapshotLine[] {
  return lines
    .filter((l) => !l.optional || l.selected)
    .map((l) => ({
      id: l.id,
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
 * name, so putting it back isn't shown as a change.
 */
export function lineChanges(snapshot: readonly SnapshotLine[] | null | undefined, current: readonly CurrentLine[]): LineChange[] {
  if (!snapshot) return [];
  const counted = current.filter((l) => !l.optional || l.selected);
  const left = new Map(snapshot.map((s) => [s.id, s]));
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

/** The line that carries a price set above the estimate. */
export const SITE_ADJUSTMENT_NAME = "Price adjustment";

export const isSiteAdjustment = (line: { name: string; service_id: string | null; formula?: string | null }) =>
  line.name === SITE_ADJUSTMENT_NAME && line.service_id === null && !line.formula;

/**
 * How a price set on site lands on the quote, before tax: below the estimate it's a discount, above
 * it a price adjustment line. `subtotal` leaves out any earlier adjustment line.
 */
export function sitePriceAdjustment(subtotal: Amount, price: Amount): { discount: number; extra: number } {
  const diff = toCents(price) - toCents(subtotal);
  return diff < 0 ? { discount: -diff / 100, extra: 0 } : { discount: 0, extra: diff / 100 };
}
