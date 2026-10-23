/**
 * The roofing flow's records: a roofing project is a quote with a roof measured on the map (a
 * measurement with a pitch or roof edges), the same records a paving project uses (paving/data.ts).
 * The estimate sorts the price list's services by what they price on a roof: the roof itself
 * (offered as one choice, or as Good, Better and Best), tearing off the old one, and the rest.
 * Also here: the words for a project's stage, and the pure parts of roof packages (packages.ts
 * has their records and hooks).
 */
import { formulaVariables } from "@crewtavo/core/formulas";
import { ROOFING_VARIABLE_NAMES, isRoofDrawing } from "@crewtavo/core/roofing";
import { invoicesSettled, sectionsOf, type FlowStep, type TakeoffRow } from "../paving/data";

/** A roofing project's steps: measure, price, send the range, check and sign on site, then the job. */
export type RoofStepId = "takeoff" | "estimate" | "range" | "visit" | "schedule" | "invoice";

export const ROOF_STEPS: Array<FlowStep<RoofStepId>> = [
  { id: "takeoff", label: "Measure", icon: "area", text: "Outline the roof and set its pitch" },
  { id: "estimate", label: "Estimate", icon: "dollar", text: "Price it from a roof package" },
  { id: "range", label: "Range", icon: "send", text: "Send the homeowner a price range" },
  { id: "visit", label: "Site visit", icon: "tablet", text: "Check the roof and sign on the iPad" },
  { id: "schedule", label: "Schedule", icon: "calendar", text: "Turn it into a job for a crew" },
  { id: "invoice", label: "Invoice", icon: "invoice", text: "Bill the deposit and the rest" },
];

/** The parts of a roof estimate its step reads. */
export interface RoofStepQuote {
  status: string;
  lines: readonly unknown[];
  jobs: ReadonlyArray<{ status: string }>;
  range_low?: number | null;
  range_accepted_at?: string | null;
  priced_on_site_at?: string | null;
  exact_sent_at?: string | null;
}

/**
 * Where a roofing project is: the first step not done yet ("done" once the last invoice is settled).
 * A draft is waiting for its range to go out; a range that's out waits for the homeowner's yes; once
 * they say yes (or the exact price went out instead, or it was priced on site) it's the site visit;
 * once signed, the job and its invoices.
 */
export function roofStep(q: RoofStepQuote | null, takeoff: unknown, invoices: ReadonlyArray<{ status: string }> = []): RoofStepId | "done" {
  if (!takeoff) return "takeoff";
  if (!q || !q.lines.length) return "estimate";
  if (q.status === "approved" || q.status === "converted") {
    if (q.status === "approved" || !q.jobs.length) return "schedule";
    return invoicesSettled(invoices) ? "done" : "invoice";
  }
  if (q.priced_on_site_at || q.exact_sent_at) return "visit";
  if (q.status === "draft") return "range";
  if (q.range_low !== null && q.range_low !== undefined && !q.range_accepted_at) return "range";
  return "visit";
}

/** Whether a saved measurement is a roof: it has squares (a pitch), or lines marked as roof edges. */
export const isRoof = (m: Pick<TakeoffRow, "sections" | "roof_pitch" | "roofing_squares">) => m.roofing_squares != null || isRoofDrawing(sectionsOf(m), m.roof_pitch);

/** The option group the roof's choices share on the quote: the client picks one of them. */
export const ROOF_CHOICE = "Roof";

const ROOF_VALUES = new Set<string>(["pitch_factor", ...ROOFING_VARIABLE_NAMES, "eave_ft", "rake_ft", "ridge_ft", "hip_ft", "valley_ft"]);
const TEAR_OFF = /tear|remov|dispos/i;

/**
 * What a service prices on a roof, by the values its formula reads (and, for tear-off, its name):
 * the roof itself (shingles or metal by the square, with waste), tearing off the old roof, the rest
 * of the roof (edges, flashing, a steep charge), or something that doesn't price from a roof.
 */
export function roofServiceKind(formula: string | null, name = ""): "roof" | "tearoff" | "extra" | "other" {
  if (!formula) return "other";
  let names: Set<string>;
  try {
    names = formulaVariables(formula);
  } catch {
    return "other";
  }
  if (![...names].some((n) => ROOF_VALUES.has(n))) return "other";
  if (TEAR_OFF.test(name)) return "tearoff";
  const surface = names.has("squares") || names.has("roof_squares") || names.has("roof_sqft") || names.has("pitch_factor");
  const withWaste = names.has("squares") || names.has("waste") || names.has("waste_pct");
  return surface && withWaste && !names.has("steep_squares") ? "roof" : "extra";
}

/** A tear-off line's formula for this many layers: the service's, times the layers past the first. */
export const layersFormula = (formula: string, layers: number) => (layers > 1 ? `(${formula}) * ${layers}` : formula);
/** A tear-off line's name for this many layers. */
export const layersName = (name: string, layers: number) => (layers > 1 ? `${name} (${layers} layers)` : name);
/** How many layers a tear-off line takes off, from its formula (layersFormula). */
export function layersOf(formula: string | null): number {
  const match = /^\(.*\) \* (\d+)$/.exec(formula ?? "");
  return match ? Number(match[1]) : 1;
}

/**
 * The roof choices offered and which one the quote shows first: the middle one of three (most
 * people pick the middle), else the cheapest. Each price is for the whole roof.
 */
export function firstChoice<T extends { price: number }>(choices: T[]): T | undefined {
  const sorted = [...choices].sort((a, b) => a.price - b.price);
  return sorted.length === 3 ? sorted[1] : sorted[0];
}

/** "28.4 squares · 6/12" for the project list, or the plan area when the roof has no pitch. */
export function roofSummary(m: Pick<TakeoffRow, "roofing_squares" | "roof_pitch" | "total_area_sqft">, format: (n: number, digits?: number) => string): string {
  if (m.roofing_squares == null) return `${format(Number(m.total_area_sqft))} sq ft from above`;
  return [`${format(Number(m.roofing_squares), 1)} squares`, m.roof_pitch ? (m.roof_pitch === "0/12" ? "flat" : m.roof_pitch) : "mixed pitches"].join(" · ");
}

// ---------------------------------------------------------------------------------------------
// Where a roof estimate is (the project list)
// ---------------------------------------------------------------------------------------------

/** A roofing project's quote, as far as its stage goes. */
export interface RoofStageQuote {
  status: string;
  lines?: unknown[];
  jobs?: Array<{ status: string }>;
  range_low?: number | null;
  range_accepted_at?: string | null;
  priced_on_site_at?: string | null;
  /** When the office sent the exact price instead of the range. */
  exact_sent_at?: string | null;
}

export type StageTone = "muted" | "info" | "warning" | "good" | "danger";

/**
 * A short word for where a roof estimate is: measuring the roof, pricing it, the range out with
 * the homeowner, the homeowner asking for a visit, priced on site (or the exact price sent from the
 * office instead), signed, then the job.
 */
export function roofStage(q: RoofStageQuote, hasTakeoff: boolean): { label: string; tone: StageTone } {
  if (q.status === "lost") return { label: "Lost", tone: "danger" };
  if (q.status === "archived") return { label: "Archived", tone: "muted" };
  if (q.status === "converted") {
    const job = q.jobs?.[0];
    if (job?.status === "completed" || job?.status === "archived") return { label: "Done", tone: "good" };
    if (job?.status === "requires_invoicing") return { label: "To invoice", tone: "info" };
    return { label: "Scheduled", tone: "good" };
  }
  if (q.status === "approved") return { label: "Signed", tone: "good" };
  if (!hasTakeoff) return { label: "Measuring", tone: "muted" };
  if (!q.lines?.length) return { label: "Pricing", tone: "muted" };
  if (q.status === "changes_requested") return { label: "Changes requested", tone: "warning" };
  const ranged = q.range_low !== null && q.range_low !== undefined;
  if (ranged && !q.priced_on_site_at && !q.exact_sent_at && q.range_accepted_at) return { label: "Wants a visit", tone: "warning" };
  if (q.priced_on_site_at) return { label: "Priced on site", tone: "info" };
  if (q.exact_sent_at) return { label: "Exact price sent", tone: "info" };
  if (q.status === "sent") return { label: ranged ? "Range sent" : "Proposal sent", tone: "info" };
  return { label: "Pricing", tone: "muted" };
}

/** "$18,300 – $21,050" */
export const rangeText = (low: number, high: number, format: (n: number) => string) => `${format(low)} – ${format(high)}`;

// ---------------------------------------------------------------------------------------------
// Roof packages (roof_packages): what goes on each kind of roof
// ---------------------------------------------------------------------------------------------

export type PackageStyle = "shingle" | "designer" | "metal" | "other";
export const PACKAGE_STYLES: Array<{ id: PackageStyle; label: string }> = [
  { id: "shingle", label: "Shingle" },
  { id: "designer", label: "Designer" },
  { id: "metal", label: "Metal" },
  { id: "other", label: "Other" },
];

/** Package names are 1 to 80 characters (roof_packages.name). */
export const PACKAGE_NAME_MAX = 80;

/** A copy's name: "Architectural shingle (copy)", cut to fit. */
export function copyName(name: string): string {
  const suffix = " (copy)";
  return `${name.trim().slice(0, PACKAGE_NAME_MAX - suffix.length)}${suffix}`;
}

const FORMULA_WORDS: Record<string, string> = {
  squares: "Roof area plus waste",
  roof_squares: "Roof area",
  "eave_ft+rake_ft": "Eaves and rakes",
  "rake_ft+eave_ft": "Eaves and rakes",
  "ridge_ft+hip_ft": "Ridges and hips",
  "hip_ft+ridge_ft": "Ridges and hips",
  valley_ft: "Valleys",
  steep_squares: "Steep parts (8/12 and up)",
  ridge_ft: "Ridge",
  "eave_ft+valley_ft": "Eaves and valleys",
  "valley_ft+eave_ft": "Eaves and valleys",
  eave_ft: "Eaves",
  rake_ft: "Rakes",
  hip_ft: "Hips",
  length_ft: "Measured length",
  area_sqft: "Measured area",
};

/**
 * How much of a service goes on a roof, in words: "Roof area plus waste" for `squares`, "Eaves and
 * rakes" for `eave_ft + rake_ft`. Null when it isn't measured: it's counted by hand.
 */
export function formulaWords(formula: string | null | undefined): string | null {
  if (!formula?.trim()) return null;
  const compact = formula.replace(/\s+/g, "");
  return FORMULA_WORDS[compact] ?? "From the measurements";
}

/** Whether a price list unit is the roofing square (100 sq ft of roof). */
export const isSquareUnit = (unit: string) => /^(sq|square|squares|roofing squares?)\.?$/i.test(unit.trim());

const EACH = /^(ea|each|unit|units|item|items|)$/i;
const WHOLE = /^(lump sum|job|flat|flat rate|ls)$/i;

/** A unit as it reads after a price: "sq", "ft", "sheet". */
export function unitShort(unit: string): string {
  const u = unit.trim();
  if (isSquareUnit(u)) return "sq";
  if (/^(ft|feet|foot|lf|lin ft|linear ft|linear feet)\.?$/i.test(u)) return "ft";
  return u.toLowerCase();
}

/** Dollars, with cents only when there are some: "$560", "$3.50". */
export function moneyText(amount: number, format: { whole: (n: number) => string; cents: (n: number) => string }): string {
  return Math.round(amount * 100) % 100 === 0 ? format.whole(amount) : format.cents(amount);
}

/**
 * A price with its unit: "$560 / sq", "$9 / ft", "$45 each". `short` leaves "each" off, for chips.
 * A job-priced service is just its price.
 */
export function unitPrice(amount: number, unit: string, format: { whole: (n: number) => string; cents: (n: number) => string }, short = false): string {
  const price = moneyText(amount, format);
  if (WHOLE.test(unit.trim())) return price;
  if (EACH.test(unit.trim())) return short ? price : `${price} each`;
  return `${price} / ${unitShort(unit)}`;
}

/** The parts of a service and a package item the quick-add chips need. */
export interface ChipService { id: string; name: string; active: boolean; sort: number }
export interface ChipItem { service_id: string; kind: string; sort: number }

/**
 * The chips under Quick adds: every active service that isn't already on the roof, the package's
 * quick adds first in their order, then the rest of the price list in its order.
 */
export function quickAddChips<S extends ChipService>(services: readonly S[], items: readonly ChipItem[], roofServiceId: string | null): Array<{ service: S; on: boolean }> {
  const included = new Set(items.filter((i) => i.kind === "included").map((i) => i.service_id));
  const quick = new Map(items.filter((i) => i.kind === "quick").map((i) => [i.service_id, i.sort]));
  const offered = services.filter((s) => s.active && s.id !== roofServiceId && !included.has(s.id));
  const on = offered.filter((s) => quick.has(s.id)).sort((a, b) => quick.get(a.id)! - quick.get(b.id)!);
  const off = offered.filter((s) => !quick.has(s.id)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  return [...on.map((service) => ({ service, on: true })), ...off.map((service) => ({ service, on: false }))];
}
