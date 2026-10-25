/**
 * How a roof estimate reads, as plain functions the office page, the iPad and the tests share: which
 * kind of line each one is (the roof itself, the tear-off by layers, something measured from the roof,
 * or a count like pipe boots), the words beside it ("48 ft of ridge · $9 a foot", "3 boots"), what −
 * and + do to it, the rows in their two sections with what changed since the range, where a line
 * added to an estimate with options goes, and the office's own numbers (cost, profit, margin), each
 * for the option being looked at (core money.ts countsOn and optionTotals).
 */
import { isSiteAdjustment, marginPct, type LineChange, type SnapshotLine } from "@crewtavo/core/estimates";
import { countsOn, lineTotal, optionTotals, quoteTotals, toCents, type Amount, type TotalsPromo } from "@crewtavo/core/money";
import { formatMoney, formatMoneyCents, formatNumber } from "@/lib/format";
import { formulaValue } from "../../paving/data";
import { layersOf, roofServiceKind } from "../data";
import type { EstimateLine, EstimateQuote, EstimateService } from "./types";

// ---------------------------------------------------------------------------------------------
// Money and words
// ---------------------------------------------------------------------------------------------

/** "$560", or "$3.50" when there are cents. */
export const money = (n: number) => (toCents(n) % 100 === 0 ? formatMoney(n) : formatMoneyCents(n));

/** An amount with a real minus sign when it takes away: "$650", "−$304". */
export const signedMoney = (n: number) => (toCents(n) < 0 ? `−${money(Math.abs(n))}` : money(n));

/** Units sold one at a time, where the thing itself is named by the line ("3 boots", "1 dumpster"). */
const EACH = /^(ea|each|lump sum|ls|job|item|items|unit|units|pc|pcs|piece|pieces|allowance)$/i;
/** Units that measure something rather than count it. */
const MEASURE = /^(sq|squares?|ft|lf|lin ft|linear ft|foot|feet|sq ?ft|sf|sqft|square f(oo|ee)t|sq ?yd|sy|yd|yards?|in|inches|gal|gallons?|lbs?|tons?|cu ?yd|cy)$/i;
/** Words at the end of a name that aren't the thing you count ("Chimney flashing" counts chimneys). */
const UNCOUNTABLE = new Set(["flashing", "decking", "cleanup", "disposal", "removal", "labor", "work", "installation", "install", "service", "charge", "fee", "trim", "wrap", "coating", "sealing", "shield", "underlayment", "replacement"]);

const unitKey = (unit: string) => unit.trim().toLowerCase().replace(/\.$/, "");

function plural(word: string): string {
  if (/(s|sh|ch|x|z)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function singular(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(sh|ch|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

/** A number of things, without float dust: 3, 2.5, 0.25. */
export const countText = (n: number) => formatNumber(n, Number.isInteger(Math.round(n * 1000) / 1000) ? 0 : Math.round(n * 100) % 10 === 0 ? 1 : 2);

/**
 * What a count line counts, one and many: its unit when that's a thing ("sheet"), else the thing the
 * line is named for ("Pipe boot" → boots, "Chimney flashing" → chimneys). Null when it measures.
 */
export function countNoun(name: string, unit: string): [string, string] | null {
  const u = unitKey(unit);
  if (MEASURE.test(u)) {
    if (/^(sq|squares?)$/.test(u)) return ["square", "squares"];
    return null;
  }
  if (!EACH.test(u)) {
    const one = singular(u);
    return [one, plural(one)];
  }
  const words = name
    .toLowerCase()
    .replace(/\s+(off and (back|on)( on)?|and cleanup|and haul away)$/, "")
    .split(/[\s/-]+/)
    .map((w) => w.replace(/[^a-z]/g, ""))
    .filter(Boolean);
  if (!words.length) return null;
  let word = words[words.length - 1]!;
  if (UNCOUNTABLE.has(word)) {
    const first = words[0]!;
    if (words.length < 2 || UNCOUNTABLE.has(first)) return null;
    word = first;
  }
  const one = singular(word);
  return [one, plural(one)];
}

/** "3 boots", "6 sheets", "1 dumpster", "120 ft"; just the number when there's no word for it. */
export function countLabel(quantity: number, name: string, unit: string): string {
  const noun = countNoun(name, unit);
  if (noun) return `${countText(quantity)} ${quantity === 1 ? noun[0] : noun[1]}`;
  return MEASURE.test(unitKey(unit)) ? quantityText(quantity, unit) : countText(quantity);
}

/** A measured amount: "24.2 squares", "210 ft", "1,250 sq ft". */
export function quantityText(quantity: number, unit: string): string {
  const u = unitKey(unit);
  if (/^(sq|squares?)$/.test(u)) return `${formatNumber(quantity, 1)} ${quantity === 1 ? "square" : "squares"}`;
  if (/^(ft|lf|lin ft|linear ft|foot|feet)$/.test(u)) return `${formatNumber(quantity, quantity < 10 && !Number.isInteger(quantity) ? 1 : 0)} ft`;
  if (/^(sq ?ft|sf|sqft|square f(oo|ee)t)$/.test(u)) return `${formatNumber(quantity)} sq ft`;
  if (MEASURE.test(u)) return `${countText(quantity)} ${u}`;
  return countLabel(quantity, "", unit);
}

/** A price for one: "$560 a square", "$3.50 a foot", "$45 each", "$95 a sheet". */
export function unitPricePhrase(price: number, unit: string): string {
  const m = money(Number(price));
  const u = unitKey(unit);
  if (!u || EACH.test(u)) return `${m} each`;
  if (/^(ft|lf|lin ft|linear ft|foot|feet)$/.test(u)) return `${m} a foot`;
  if (/^(sq ?ft|sf|sqft|square f(oo|ee)t)$/.test(u)) return `${m} a sq ft`;
  if (/^(sq|squares?)$/.test(u)) return `${m} a square`;
  if (/^(sq ?yd|sy)$/.test(u)) return `${m} a sq yd`;
  if (/^(hr|hrs|hours?)$/.test(u)) return `${m} an hour`;
  const word = singular(u);
  return `${m} ${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

// ---------------------------------------------------------------------------------------------
// What kind of line it is, and what −/+ do
// ---------------------------------------------------------------------------------------------

const LAYERED = /^\((.*)\) \* (\d+)$/;
/** A tear-off line's own formula, without the layers it was multiplied by (layersFormula). */
export const baseFormula = (formula: string) => LAYERED.exec(formula)?.[1] ?? formula;
/** A tear-off line's name without its layers (layersName). */
export const baseName = (name: string) => name.replace(/ \(\d+ layers\)$/, "");

/** The most layers of old roof a tear-off line takes off. */
export const MAX_LAYERS = 3;

/**
 * - roof: the roof itself, by the square. It stays (change the package to change it).
 * - layers: tearing off the old roof; −/+ change the layers.
 * - measured: worked out from the roof (drip edge, ridge vent); − takes it off.
 * - count: counted by hand (pipe boots, a dumpster); −/+ change how many, − at one takes it off.
 * - adjustment: the price set on site above the estimate; it changes only from the price.
 */
export type RowKind = "roof" | "layers" | "measured" | "count" | "adjustment";

type KindLine = Pick<EstimateLine, "name" | "service_id" | "formula">;

export function lineKind(line: KindLine): RowKind {
  if (isSiteAdjustment(line)) return "adjustment";
  if (!line.formula) return "count";
  const kind = roofServiceKind(baseFormula(line.formula), baseName(line.name));
  return kind === "roof" ? "roof" : kind === "tearoff" ? "layers" : "measured";
}

/** A line shown while it's still being saved (put back, or just added): its buttons wait for it. */
export const isPendingLine = (line: Pick<EstimateLine, "id">) => line.id.startsWith("pending:");

/** Rows in "The roof · from the measurements"; the rest are "Everything else". */
export const isRoofSection = (kind: RowKind) => kind === "roof" || kind === "layers" || kind === "measured";

export type Step = { op: "quantity"; quantity: number } | { op: "layers"; layers: number } | { op: "delete" } | null;

type StepLine = KindLine & Pick<EstimateLine, "quantity">;

/** What − does to a line: one fewer, one layer fewer, or take it off. */
export function lessOf(line: StepLine): Step {
  const kind = lineKind(line);
  if (kind === "count") {
    const next = Math.round((Number(line.quantity) - 1) * 1000) / 1000;
    return next > 0 ? { op: "quantity", quantity: next } : { op: "delete" };
  }
  if (kind === "layers") {
    const layers = layersOf(line.formula);
    return layers > 1 ? { op: "layers", layers: layers - 1 } : { op: "delete" };
  }
  if (kind === "measured") return { op: "delete" };
  return null;
}

/** What + does to a line: one more, or one more layer (up to MAX_LAYERS). */
export function moreOf(line: StepLine): Step {
  const kind = lineKind(line);
  if (kind === "count") return { op: "quantity", quantity: Math.round((Number(line.quantity) + 1) * 1000) / 1000 };
  if (kind === "layers") {
    const layers = layersOf(line.formula);
    return layers < MAX_LAYERS ? { op: "layers", layers: layers + 1 } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The words beside a line
// ---------------------------------------------------------------------------------------------

const MEASURED_FROM: Record<string, string> = {
  "eave_ft+rake_ft": "eaves and rakes",
  "hip_ft+ridge_ft": "ridges and hips",
  "eave_ft+valley_ft": "eaves and valleys",
  valley_ft: "valleys",
  ridge_ft: "ridge",
  eave_ft: "eaves",
  rake_ft: "rakes",
  hip_ft: "hips",
  steep_squares: "steep roof",
};

/** What a formula measures, in a roofer's words ("eaves and rakes"), or null when it's not one of those. */
export function measuredWhat(formula: string | null | undefined): string | null {
  if (!formula) return null;
  const key = baseFormula(formula).replace(/\s+/g, "").split("+").sort().join("+");
  return MEASURED_FROM[key] ?? null;
}

/** Why a measured service can't go on yet: the roof has nothing to measure it from. */
export function nothingToMeasure(name: string, formula: string | null): string {
  const key = formula ? baseFormula(formula).replace(/\s+/g, "") : "";
  if (key === "steep_squares") return `${name} is for steep parts of the roof (8/12 and up), and this roof has none.`;
  const what = measuredWhat(formula);
  if (what) return `This roof has nothing to measure ${name} from. Mark the ${what} on the map first, then add it.`;
  return `This roof has nothing to measure ${name} from yet. Measure it on the map first, then add it.`;
}

type DetailLine = KindLine & Pick<EstimateLine, "quantity" | "unit" | "unit_price"> & { description?: string | null };

/**
 * The detail under a line's name: "24.2 squares with 10% waste · $560 a square", "210 ft of eaves and
 * rakes · $3.50 a foot", "22.0 squares · $85 a square for each layer", "$45 each".
 */
export function lineDetail(line: DetailLine, wastePct?: number | null): string {
  const kind = lineKind(line);
  const quantity = Number(line.quantity);
  const description = line.description?.trim() || null;
  if (kind === "adjustment") return description ?? "Set on site";
  const per = unitPricePhrase(Number(line.unit_price), line.unit);
  if (kind === "count") return [description, per].filter(Boolean).join(" · ");
  if (kind === "layers") {
    const layers = layersOf(line.formula);
    return `${quantityText(quantity / Math.max(1, layers), line.unit)} · ${per}${layers > 1 ? " for each layer" : ""}`;
  }
  const what = measuredWhat(line.formula);
  const waste = baseFormula(line.formula!).replace(/\s+/g, "") === "squares" && wastePct ? ` with ${formatNumber(Number(wastePct))}% waste` : "";
  return `${quantityText(quantity, line.unit)}${what ? ` of ${what}` : ""}${waste} · ${per}`;
}

// ---------------------------------------------------------------------------------------------
// The rows, in two sections, with what changed
// ---------------------------------------------------------------------------------------------

/** A line taken off on this screen, kept to show crossed out with Put back (and its place). */
export interface RemovedLine extends SnapshotLine {
  sort: number | null;
  description?: string | null;
}

export type RowTag = "added" | "changed" | "removed";

export interface EstimateRow {
  key: string;
  kind: RowKind;
  /** The line on the estimate; null for one that was taken off. */
  line: EstimateLine | null;
  /** What to put back, for one that was taken off. */
  removed: RemovedLine | null;
  name: string;
  detail: string;
  /** "3 boots", "2 layers": shown between − and +. */
  quantity: string | null;
  amount: number;
  tag: RowTag | null;
  /** What − and + do, null when they don't apply. */
  less: Step;
  more: Step;
  /** Labels for − and + (screen readers): "One fewer boot", "Take Drip edge off". */
  lessLabel: string;
  moreLabel: string;
  /** Looking at one option of several: the line is on every option, so taking it off takes it off them all. */
  shared: boolean;
}

export interface RowOptions {
  /** What changed since the range (lineChanges); without it, this screen's own changes are tagged. */
  changes?: readonly LineChange[] | null;
  /** The lines the range was made from, to put lines taken off since back in their places. */
  rangeLines?: readonly SnapshotLine[] | null;
  /** Lines added, changed and taken off on this screen. */
  added?: readonly string[];
  changed?: readonly string[];
  removed?: readonly RemovedLine[];
  /** The roof's waste, for "with 10% waste". */
  wastePct?: number | null;
  /** The option being looked at: its lines and the shared ones show. Null for an estimate without options. */
  optionId?: string | null;
}

/**
 * Whether a line counts with `optionId` being looked at (null for an estimate without options): it's
 * on every option or on that one, and it isn't an add-on left off (core countsOn). A required line of
 * an option that isn't shown counts on its own option, as it will once that option is chosen.
 */
export const counts = (l: Pick<EstimateLine, "option_id" | "optional" | "selected">, optionId: string | null) => countsOn(l, optionId);

function labels(kind: RowKind, name: string, unit: string, quantity: number, formula: string | null, shared: boolean): { lessLabel: string; moreLabel: string } {
  const off = (what: string) => `Take ${what} off${shared ? " every option" : ""}`;
  if (kind === "layers") return { lessLabel: layersOf(formula) > 1 ? "One fewer layer" : off(baseName(name)), moreLabel: "One more layer" };
  if (kind === "count") {
    const noun = countNoun(name, unit)?.[0];
    return { lessLabel: quantity <= 1 ? off(name) : `One fewer ${noun ?? `of ${name}`}`, moreLabel: `One more ${noun ?? `of ${name}`}` };
  }
  return { lessLabel: off(name), moreLabel: "" };
}

/** The estimate's rows: the roof's (from the measurements) and everything else, in order. */
export function estimateRows(lines: readonly EstimateLine[], options: RowOptions = {}): { roof: EstimateRow[]; other: EstimateRow[] } {
  const optionId = options.optionId ?? null;
  const visible = lines.filter((l) => counts(l, optionId)).sort((a, b) => a.sort - b.sort);
  // Since the range when there is one (a line changed and changed back isn't a change), else this screen's own.
  const tags = new Map<string, RowTag>();
  if (options.changes) {
    for (const c of options.changes) if (c.kind !== "removed") tags.set(c.id, c.kind);
  } else {
    for (const id of options.changed ?? []) tags.set(id, "changed");
    for (const id of options.added ?? []) tags.set(id, "added");
  }

  const placed: Array<{ row: EstimateRow; at: number; order: number }> = visible.map((line, order) => {
    const kind = lineKind(line);
    const quantity = Number(line.quantity);
    const shared = optionId !== null && line.option_id == null;
    return {
      at: line.sort,
      order,
      row: {
        key: line.id,
        kind,
        line,
        removed: null,
        name: line.name,
        detail: lineDetail(line, options.wastePct),
        quantity: kind === "count" ? countLabel(quantity, line.name, line.unit) : kind === "layers" ? `${layersOf(line.formula)} ${layersOf(line.formula) === 1 ? "layer" : "layers"}` : null,
        amount: lineTotal(line.quantity, line.unit_price),
        tag: tags.get(line.id) ?? null,
        less: lessOf(line),
        more: moreOf(line),
        ...labels(kind, line.name, line.unit, quantity, line.formula, shared),
        shared,
      },
    };
  });

  // Lines taken off: this screen's own (they know their place), then the range's; another option's stay with it.
  const gone = new Map<string, RemovedLine>();
  for (const r of options.removed ?? []) if (r.option_id == null || r.option_id === optionId) gone.set(r.id, r);
  for (const c of options.changes ?? []) if (c.kind === "removed" && c.snapshot && !gone.has(c.id)) gone.set(c.id, { ...c.snapshot, sort: null });
  const present = (s: SnapshotLine) => visible.find((l) => l.id === s.id) ?? visible.find((l) => l.service_id === s.service_id && l.name === s.name);
  const range = options.rangeLines ?? [];
  let extra = visible.length;
  for (const r of gone.values()) {
    if (visible.some((l) => l.id === r.id)) continue;
    let at = r.sort ?? Number.POSITIVE_INFINITY;
    if (r.sort === null) {
      const i = range.findIndex((s) => s.id === r.id);
      if (i >= 0) {
        for (let j = i - 1; j >= 0 && at === Number.POSITIVE_INFINITY; j--) {
          const anchor = present(range[j]!);
          if (anchor) at = anchor.sort + 0.001 * (i - j);
        }
        for (let j = i + 1; j < range.length && at === Number.POSITIVE_INFINITY; j++) {
          const anchor = present(range[j]!);
          if (anchor) at = anchor.sort - 0.001 * (j - i);
        }
      }
    }
    const kind = lineKind(r);
    placed.push({
      at,
      order: extra++,
      row: {
        key: `removed:${r.id}`,
        kind: kind === "roof" ? "measured" : kind,
        line: null,
        removed: r,
        name: r.name,
        detail: lineDetail(r, options.wastePct),
        quantity: null,
        amount: r.total ?? lineTotal(r.quantity, r.unit_price),
        tag: "removed",
        less: null,
        more: null,
        lessLabel: "",
        moreLabel: "",
        shared: false,
      },
    });
  }
  placed.sort((a, b) => a.at - b.at || a.order - b.order);
  const rows = placed.map((p) => p.row);
  const roof = rows.filter((r) => isRoofSection(r.kind));
  const other = rows.filter((r) => !isRoofSection(r.kind));
  // The price set on site sits at the end, under everything it's added to. Set below the estimate on
  // an option it's two lines, the taxed part and the untaxed (core siteAdjustmentLines): one price, one row.
  const set = other.filter((r) => r.kind === "adjustment" && r.line);
  const price = set.length > 1 ? [{ ...set[0]!, amount: set.reduce((sum, r) => sum + toCents(r.amount), 0) / 100, tag: set.find((r) => r.tag)?.tag ?? null }] : set;
  return { roof, other: [...other.filter((r) => r.kind !== "adjustment"), ...price, ...other.filter((r) => r.kind === "adjustment" && !r.line)] };
}

/** A line as it is now, to keep while it's crossed out (and to put it back from). */
export function removedLine(line: EstimateLine): RemovedLine {
  return {
    id: line.id,
    option_id: line.option_id,
    service_id: line.service_id,
    name: line.name,
    quantity: Number(line.quantity),
    unit: line.unit,
    unit_price: Number(line.unit_price),
    unit_cost: line.unit_cost === null ? null : Number(line.unit_cost),
    taxable: line.taxable,
    formula: line.formula,
    total: lineTotal(line.quantity, line.unit_price),
    sort: line.sort,
    description: line.description,
  };
}

/** A line just saved, with the amount the roof gave it (apply-measurement fills its quantity or its price). */
export function measuredInto<L extends Pick<EstimateLine, "quantity" | "unit_price">>(line: L, applied: { field?: string; value?: number } | null | undefined): L {
  if (applied?.value === undefined) return line;
  return applied.field === "unit_price" ? { ...line, unit_price: Math.round(applied.value * 100) / 100 } : { ...line, quantity: applied.value };
}

/**
 * The lines once a new one has saved: it takes the place of the line shown while it saved (a count
 * or a put-back line), or goes on in its place in the order (a measured line shows only once it's
 * measured). Until the estimate loads again, the next tap counts from it, so tapping a quick add
 * again finds it on the estimate instead of adding it twice.
 */
export function withSavedLine<L extends Pick<EstimateLine, "id" | "sort">>(lines: readonly L[], saved: L, pendingId: string | null): L[] {
  const rest = lines.filter((l) => l.id !== pendingId);
  return rest.some((l) => l.id === saved.id) ? rest : [...rest, saved].sort((a, b) => a.sort - b.sort);
}

/**
 * A quote's totals after its lines change on screen, the way the database will work them out: the
 * option shown and the shared lines (another option's lines are kept unselected, so they don't count).
 */
export function withLines<Q extends Pick<EstimateQuote, "lines" | "tax_rate" | "discount_amount" | "promo_code_id" | "subtotal" | "tax_amount" | "total">>(quote: Q, lines: EstimateLine[]): Q {
  // A promo code's discount is worked out from the lines in the database: wait for it.
  if (quote.promo_code_id) return { ...quote, lines };
  const totals = quoteTotals(lines, { taxRate: quote.tax_rate, discountAmount: quote.discount_amount });
  return { ...quote, lines, subtotal: totals.subtotal, tax_amount: totals.tax, total: totals.total };
}

// ---------------------------------------------------------------------------------------------
// Adding from the package and the price list
// ---------------------------------------------------------------------------------------------

/** A quick add's price on its button: what it comes to on this roof, or its price for one. */
export function quickAddPrice(service: Pick<EstimateService, "formula" | "formula_target" | "unit" | "unit_price">, vars?: Record<string, number | null> | null): string {
  if (service.formula) {
    const value = vars ? formulaValue(service.formula, vars) : null;
    if (value !== null && value > 0) return formatMoney(service.formula_target === "unit_price" ? value : lineTotal(value, service.unit_price));
    return unitPricePhrase(Number(service.unit_price), service.unit);
  }
  return EACH.test(unitKey(service.unit)) ? money(Number(service.unit_price)) : unitPricePhrase(Number(service.unit_price), service.unit);
}

/** A service in the price list search: its price, and whether it's measured from the roof. */
export const serviceDetail = (service: Pick<EstimateService, "formula" | "unit" | "unit_price">) =>
  service.formula ? `${unitPricePhrase(Number(service.unit_price), service.unit)} · measured from the roof` : unitPricePhrase(Number(service.unit_price), service.unit);

/** Services matching what was typed, the ones whose name starts with it first. Everything when nothing's typed. */
export function searchServices<S extends Pick<EstimateService, "name" | "category">>(services: readonly S[], term: string): S[] {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...services];
  const scored: Array<{ s: S; score: number; i: number }> = [];
  services.forEach((s, i) => {
    const name = s.name.toLowerCase();
    const text = `${name} ${(s.category ?? "").toLowerCase()}`;
    if (!words.every((w) => text.includes(w))) return;
    const score = name.startsWith(words[0]!) ? 0 : name.split(/[\s/-]+/).some((p) => p.startsWith(words[0]!)) ? 1 : 2;
    scored.push({ s, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.s);
}

// ---------------------------------------------------------------------------------------------
// What changed, and the range
// ---------------------------------------------------------------------------------------------

/** "Chimney flashing, 1 chimney", "Rotten decking, 6 sheets", or the name for a measured line or one taken off. */
export function changeLabel(change: Pick<LineChange, "kind" | "name" | "unit" | "to">): string {
  if (change.kind === "removed" || change.to === null) return change.name;
  const u = unitKey(change.unit);
  return !MEASURE.test(u) ? `${change.name}, ${countLabel(change.to, change.name, change.unit)}` : change.name;
}

/** What the changes add up to, to the cent. */
export const changesTotal = (changes: readonly Pick<LineChange, "amount">[]) => changes.reduce((t, c) => t + toCents(c.amount), 0) / 100;

/** Where a price sits on a range: how far along (0 to 1, held to the ends) and whether it's above it. */
export function rangePosition(low: number, high: number, value: number): { at: number; where: "below" | "inside" | "above"; over: number } {
  const v = toCents(value);
  const lo = toCents(low);
  const hi = toCents(high);
  const where = v > hi ? "above" : v < lo ? "below" : "inside";
  const at = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : where === "above" ? 1 : where === "below" ? 0 : 0.5;
  return { at, where, over: where === "above" ? (v - hi) / 100 : 0 };
}

// ---------------------------------------------------------------------------------------------
// The office's numbers
// ---------------------------------------------------------------------------------------------

export interface EstimateFigures {
  /** What the ABC Supply materials come to, when any line has them. */
  materials: number | null;
  /** Some materials aren't priced by the branch yet, so materials are at least this. */
  materialsPartial: boolean;
  /** Materials, labor and the rest: each line's cost for one times how many. */
  cost: number;
  /** Some lines have no cost in the price list, so the cost is at least this. */
  costPartial: boolean;
  /** The price before tax, after any discount. */
  price: number;
  profit: number;
  margin: number | null;
  /** When the materials were last priced. */
  pricedAt: string | null;
}

/** What estimateFigures reads: the quote's saved totals, and what an option's own are worked out with. */
export type FiguresQuote = Pick<EstimateQuote, "subtotal" | "discount_amount" | "lines"> & { option_id?: string | null; tax_rate?: Amount; promo?: TotalsPromo | null };

/**
 * The estimate's cost, profit and margin, for the option being looked at (`optionId`; the one shown,
 * else none): its lines and the shared ones, priced as the database will price it once that option
 * is shown (core optionTotals). Null when nothing's known about its cost.
 */
export function estimateFigures(quote: FiguresQuote, optionId: string | null = quote.option_id ?? null): EstimateFigures | null {
  const counted = quote.lines.filter((l) => counts(l, optionId));
  let cost = 0;
  let known = 0;
  let unknown = 0;
  let materials = 0;
  let withMaterials = 0;
  let materialsPartial = false;
  let pricedAt: string | null = null;
  for (const l of counted) {
    if (l.material_cost !== null && l.material_cost !== undefined) {
      materials += toCents(l.material_cost);
      withMaterials++;
    }
    if (l.materials) {
      if (l.materials.items.some((i) => i.total === null && i.quantity > 0)) materialsPartial = true;
      if (!pricedAt || l.materials.priced_at > pricedAt) pricedAt = l.materials.priced_at;
    }
    // The price set on site is all price, no cost.
    if (isSiteAdjustment(l)) continue;
    if (l.unit_cost === null || l.unit_cost === undefined) unknown++;
    else {
      known++;
      cost += toCents(lineTotal(l.quantity, l.unit_cost));
    }
  }
  if (!known && !withMaterials) return null;
  const price = toCents(beforeTax(quote, optionId));
  return {
    materials: withMaterials ? materials / 100 : null,
    materialsPartial,
    cost: cost / 100,
    costPartial: unknown > 0,
    price: price / 100,
    profit: (price - cost) / 100,
    margin: marginPct(price / 100, cost / 100),
    pricedAt,
  };
}

/**
 * The price before tax, after any discount, of the option being looked at: the saved totals for the
 * one shown (and an estimate without options), else that option's as the database will work it out.
 */
export function beforeTax(quote: FiguresQuote, optionId: string | null): number {
  if (optionId === (quote.option_id ?? null)) {
    const subtotal = toCents(quote.subtotal);
    return (subtotal - Math.min(toCents(quote.discount_amount), Math.max(subtotal, 0))) / 100;
  }
  const totals = optionTotals(quote.lines, optionId, quote.option_id, { taxRate: quote.tax_rate ?? 0, discountAmount: quote.discount_amount, promo: quote.promo ?? null });
  return (toCents(totals.subtotal) - toCents(totals.discount)) / 100;
}

/** A margin to look twice at. */
export const LOW_MARGIN = 25;

// ---------------------------------------------------------------------------------------------
// Where a line goes on an estimate with options
// ---------------------------------------------------------------------------------------------

/** A package's own services: its main one and what's always on it (not its quick adds). */
export function packageServices(pkg: { roof_service_id: string | null; items: ReadonlyArray<{ service_id: string; kind: string }> } | null | undefined): Set<string> {
  if (!pkg) return new Set();
  return new Set([pkg.roof_service_id, ...pkg.items.filter((i) => i.kind === "included").map((i) => i.service_id)].filter((id): id is string => Boolean(id)));
}

/**
 * An option's own services: its package's (packageServices), and any it's had a line of its own for
 * (`had`: the lines the range was made from, and the ones taken off on this screen), so one put on
 * again goes back on it even while its package is loading, or after it was deleted.
 */
export function ownServices(own: ReadonlySet<string>, optionId: string | null, had: ReadonlyArray<{ option_id?: string | null; service_id: string | null }>): ReadonlySet<string> {
  if (!optionId) return own;
  const mine = had.flatMap((l) => (l.option_id === optionId && l.service_id ? [l.service_id] : []));
  return mine.length ? new Set([...own, ...mine]) : own;
}

/** Where a line added on an estimate with options goes: on every option, or only on the one looked at. */
export type LinePlace = "every" | "only";

/** What lineDestination reads besides the service and the option looked at. */
export interface LineWhere {
  /** The option's own services (ownServices): they go on it alone. */
  own?: ReadonlySet<string>;
  /** The quote's lines, every option's: a service another option has a line of its own for goes on this one alone. */
  lines?: ReadonlyArray<{ option_id: string | null; service_id: string | null }>;
  /** Where the person chose it goes; "every" when they haven't. */
  place?: LinePlace;
}

/**
 * The option a line added on screen goes on, or null for every option (and for an estimate without
 * options). Some services can only go on the option looked at: its own (its package's main or
 * always-included one, `own`), a roof by the square (each option is a roof of its own), and one
 * another option already has a line of its own for, which on every option that option would have
 * twice and charge for twice. Anything else goes where the person chose (`place`): on every option
 * unless they say otherwise, since what turns up on the job is there whichever option they pick.
 */
export function lineDestination(service: { id: string; name?: string; formula?: string | null } | null, optionId: string | null, { own, lines, place = "every" }: LineWhere = {}): string | null {
  if (!optionId) return null;
  if (service && (own?.has(service.id) || roofServiceKind(service.formula ?? null, service.name) === "roof" || lines?.some((l) => l.option_id !== null && l.option_id !== optionId && l.service_id === service.id))) return optionId;
  return place === "only" ? optionId : null;
}

/** Where a line goes, in words beside the add control: "On every option", "Only on Better". */
export const destinationText = (optionId: string | null, optionLabel: string) => (optionId ? `Only on ${optionLabel}` : "On every option");

// ---------------------------------------------------------------------------------------------
// Notes and photos
// ---------------------------------------------------------------------------------------------

export interface ThreadEntry {
  id: string;
  created_at: string;
  author_id: string | null;
}

/** A note with the photos its author took around it, or photos on their own. */
export interface ThreadItem<N extends ThreadEntry, P extends ThreadEntry> {
  key: string;
  author_id: string | null;
  /** When it was written (or the first photo taken). */
  at: string;
  note: N | null;
  photos: P[];
}

/**
 * Notes and photos as one thread, newest first: photos someone takes within half an hour of their
 * note go with it, and a note written just after someone's photos goes with them.
 */
export function threadItems<N extends ThreadEntry, P extends ThreadEntry>(notes: readonly N[], photos: readonly P[], windowMinutes = 30): ThreadItem<N, P>[] {
  const events = [...notes.map((n) => ({ note: n, photo: null })), ...photos.map((p) => ({ note: null, photo: p }))].sort(
    (a, b) => Date.parse((a.note ?? a.photo)!.created_at) - Date.parse((b.note ?? b.photo)!.created_at),
  );
  const items: Array<ThreadItem<N, P> & { last: number }> = [];
  const window = windowMinutes * 60_000;
  for (const e of events) {
    const entry = (e.note ?? e.photo)!;
    const time = Date.parse(entry.created_at);
    const prev = items.at(-1);
    const near = prev && prev.author_id === entry.author_id && time - prev.last <= window;
    if (e.note) {
      if (near && !prev.note) {
        prev.note = e.note;
        prev.last = time;
      } else items.push({ key: `note:${e.note.id}`, author_id: entry.author_id, at: entry.created_at, note: e.note, photos: [], last: time });
    } else if (near) {
      prev.photos.push(e.photo!);
      prev.last = time;
    } else items.push({ key: `photo:${e.photo!.id}`, author_id: entry.author_id, at: entry.created_at, note: null, photos: [e.photo!], last: time });
  }
  return items.reverse().map(({ last: _last, ...item }) => item);
}

/** "today at 9:12 AM", "yesterday at 4:30 PM", "Oct 22 at 2:09 PM", in the business's time zone. */
export function whenText(iso: string, timeZone: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  if (day(at) === day(now)) return `today at ${time}`;
  if (day(at) === day(new Date(now.getTime() - 86_400_000))) return `yesterday at ${time}`;
  const sameYear = at.toLocaleDateString("en-US", { year: "numeric", timeZone }) === now.toLocaleDateString("en-US", { year: "numeric", timeZone });
  return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: sameYear ? undefined : "numeric", timeZone })} at ${time}`;
}

/** The first name, for "Notes for Mike" and "Dana never sees these". */
export const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] ?? "";
