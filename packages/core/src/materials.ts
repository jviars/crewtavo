/**
 * Materials from a supplier's catalog on a price list's services (service_materials): how many of
 * each go into one unit of a service, what to order for a line (whole bundles and rolls), and what
 * that comes to. The API prices estimates with these and the web app shows them, so both agree.
 */
import { lineTotal, toCents, type Amount } from "./money";

/** A material on a service, with the supplier's last price for one of it. */
export interface MaterialLink {
  item_number: string;
  name: string;
  /** The supplier's unit: BD (bundle), SQ (square), RL (roll), PC (piece)... */
  uom: string;
  uom_name?: string | null;
  /** How many go into one unit of the service. */
  per_unit: Amount;
  unit_price: Amount;
  length_ft?: Amount;
  price_note?: string | null;
}

/** A material on a priced line: what to order and what it comes to. */
export interface PricedMaterial {
  item_number: string;
  name: string;
  uom: string;
  uom_name: string | null;
  per_unit: number;
  length_ft: number | null;
  /** Whole ones, rounded up. */
  quantity: number;
  /** Null when the supplier gave no price (the branch hasn't priced it). */
  unit_price: number | null;
  total: number | null;
  note: string | null;
}

/** What a quote line's materials came to (quote_line_items.materials). */
export interface LineMaterials {
  supplier: "abc_supply";
  branch: string;
  branch_name: string | null;
  priced_at: string;
  /** The line's quantity they were worked out for: a line changed since needs pricing again. */
  line_quantity: number;
  items: PricedMaterial[];
}

const num = (value: Amount) => (value === null || value === undefined || value === "" ? null : Number(value));

/**
 * What to order for this much of a service: whole ones, rounded up. A 28.4-square roof at 3 bundles
 * a square is 86 bundles. Float dust is rounded off first, so 10 squares at 3 a square is 30.
 */
export function orderQuantity(lineQuantity: Amount, perUnit: Amount): number {
  const qty = num(lineQuantity) ?? 0;
  const per = num(perUnit) ?? 0;
  if (!(qty > 0) || !(per > 0)) return 0;
  return Math.ceil(Math.round(qty * per * 1e6) / 1e6);
}

/** A line's materials at their prices, and the total. A material with no price counts as nothing, and is counted in `unpriced`. */
export function priceMaterials(lineQuantity: Amount, links: readonly MaterialLink[]): { items: PricedMaterial[]; total: number; unpriced: number } {
  let cents = 0;
  let unpriced = 0;
  const items = links.map((link): PricedMaterial => {
    const quantity = orderQuantity(lineQuantity, link.per_unit);
    const price = num(link.unit_price);
    // The supplier says 0.00 for something the branch hasn't priced: that's not free.
    const priced = price !== null && price > 0;
    const total = priced ? lineTotal(quantity, price) : null;
    if (total === null) {
      if (quantity > 0) unpriced += 1;
    } else cents += toCents(total);
    return {
      item_number: link.item_number,
      name: link.name,
      uom: link.uom,
      uom_name: link.uom_name ?? null,
      per_unit: num(link.per_unit) ?? 0,
      length_ft: num(link.length_ft),
      quantity,
      unit_price: priced ? price : null,
      total,
      note: priced ? null : (link.price_note ?? "No price from the branch yet"),
    };
  });
  return { items, total: cents / 100, unpriced };
}

/** What one unit of a service costs in materials at their last prices, unrounded. */
export function materialsPerUnit(links: readonly MaterialLink[]): number {
  return links.reduce((sum, link) => sum + (num(link.per_unit) ?? 0) * (num(link.unit_price) ?? 0), 0);
}

/**
 * The materials with no price at all: the branch never priced them. A price that follows the
 * materials would leave them out and come out too low, so it waits until they have one.
 */
export const unpricedLinks = <T extends MaterialLink>(links: readonly T[]): T[] => links.filter((link) => !((num(link.unit_price) ?? 0) > 0));

/**
 * The price a material keeps when the supplier gives none today (it stopped carrying it, or the
 * branch stopped pricing it): its last one, so nothing it's in gets cheaper by itself.
 */
export const keptPrice = (today: number | null, last: Amount): number | null => today ?? ((num(last) ?? 0) > 0 ? num(last) : null);

const cents = (value: number) => Math.round(value * 100) / 100;

/** A service's whole cost per unit (services.unit_cost): its materials at their last prices and the rest. */
export const serviceUnitCost = (links: readonly MaterialLink[], laborCost: Amount) => cents(materialsPerUnit(links) + (num(laborCost) ?? 0));

/** A quote line's cost per unit (its unit_cost), from what its materials came to and the rest per unit. */
export function lineUnitCost(materialCost: number, laborCost: Amount, quantity: Amount): number {
  const qty = num(quantity) ?? 0;
  if (!(qty > 0)) return cents(num(laborCost) ?? 0);
  return cents(materialCost / qty + (num(laborCost) ?? 0));
}

/** The kind of unit a service is sold by, as far as materials go. */
function unitKind(unit: string): "square" | "ft" | "sqft" | "ea" | null {
  const u = unit.trim().toLowerCase().replace(/\.$/, "");
  if (/^(sq|square|squares|roofing square)$/.test(u)) return "square";
  if (/^(ft|lf|feet|foot|linear ft|linear feet|lin ft)$/.test(u)) return "ft";
  if (/^(sq ft|sqft|sf|square feet|square foot)$/.test(u)) return "sqft";
  if (/^(ea|each|pc|piece|unit)$/.test(u)) return "ea";
  return null;
}

/** What a supplier's unit is, as far as matching a service's goes. */
const UOM_KINDS: Record<string, "square" | "ft" | "sqft" | "ea"> = { SQ: "square", LF: "ft", FT: "ft", SF: "sqft", EA: "ea", PC: "ea" };

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`;
const read = (pattern: string, text: string) => {
  const match = new RegExp(pattern, "i").exec(text);
  return match ? Number(match[1]!.replace(/,/g, "")) : null;
};

/**
 * A first guess at how many of an item go into one unit of a service, from how the supplier
 * describes it. "3 Bdl Per Square" shingles are 3 bundles a square; a "10 Sq" roll covers 10
 * squares; a 10 ft piece of drip edge covers 10 ft. `covers` is set when "one covers this much"
 * is the natural way to say it. People see the guess and fix it before it's saved.
 */
export function suggestPerUnit(description: string, uom: string, serviceUnit: string): { per_unit: number; covers?: number } {
  const unit = unitKind(serviceUnit);
  const code = uom.trim().toUpperCase();
  if (unit && UOM_KINDS[code] === unit) return { per_unit: 1 };
  const covering = (amount: number | null) => (amount && amount > 0 ? { per_unit: 1 / amount, covers: amount } : null);
  if (unit === "square") {
    const perSquare = code === "BD" ? read(String.raw`${NUMBER}\s*(?:bdls?|bundles?|bds?)\.?\s*(?:\/|per|a)\s*(?:sq|square)`, description) : null;
    if (perSquare) return { per_unit: perSquare };
    const squares = covering(read(String.raw`${NUMBER}\s*(?:sq|squares?)\b(?!\.?\s*f)`, description));
    if (squares) return squares;
    const sqft = read(String.raw`${NUMBER}\s*(?:sq\.?\s*ft|sf|square\s*feet)\b`, description);
    const fromSqft = covering(sqft ? sqft / 100 : null);
    if (fromSqft) return fromSqft;
  }
  if (unit === "sqft") {
    const sqft = covering(read(String.raw`${NUMBER}\s*(?:sq\.?\s*ft|sf|square\s*feet)\b`, description));
    if (sqft) return sqft;
  }
  if (unit === "ft") {
    const linear = covering(read(String.raw`${NUMBER}\s*(?:lf|lin\.?\s*ft|linear\s*f(?:ee|oo)?t)\b`, description));
    if (linear) return linear;
    const length = covering(read(String.raw`${NUMBER}\s*(?:'|ft\b|foot\b|feet\b)`, description));
    if (length) return length;
  }
  return { per_unit: 1 };
}

/** Abbreviations read the same for one or many: 120 ft, 2 ea. */
const SAME_PLURAL = new Set(["ft", "ea", "lf", "sf", "in", "yd", "gal", "each", "sqft"]);
const plural = (word: string, n: number) => {
  if (n === 1 || !/^[a-z]+$/i.test(word) || SAME_PLURAL.has(word.toLowerCase())) return word;
  return /(s|x|ch|sh)$/i.test(word) ? `${word}es` : `${word}s`;
};

/** "3 bundles per square", or "1 roll per 10 squares" when one covers more than a unit. */
export function describePerUnit(perUnit: Amount, uomName: string, serviceUnit: string): string {
  const per = num(perUnit) ?? 0;
  const item = uomName.trim().toLowerCase() || "each";
  const unit = serviceUnit.trim() || "unit";
  if (per > 0 && per < 1) {
    const covers = Math.round((1 / per) * 100) / 100;
    return `1 ${item} per ${formatAmount(covers)} ${plural(unit, covers)}`;
  }
  return `${formatAmount(per)} ${plural(item, per)} per ${unit}`;
}

const formatAmount = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
