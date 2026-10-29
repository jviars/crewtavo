/**
 * The roofing flow's records: a roofing project is a quote with a roof measured on the map (a
 * measurement with a pitch or roof edges), the same records a paving project uses (paving/data.ts).
 * The estimate sorts the price list's services by what they price on a roof: the roof itself
 * (offered as one choice, or as Good, Better and Best), tearing off the old one, and the rest.
 * Also here: the words for a project's stage, and the pure parts of packages, which every trade has
 * now (packages.ts has their records and hooks): picking them, their highlights and contract sections.
 */
import { STARTER_NOTE } from "@crewtavo/core/contracts";
import { formulaVariables } from "@crewtavo/core/formulas";
import { isExampleWarranty, PACKAGE_LIMITS } from "@crewtavo/core/presets";
import { ROOFING_VARIABLE_NAMES, isRoofDrawing } from "@crewtavo/core/roofing";
import { statusText } from "@/components/ui/StatusPill";
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
  if (q.status === "lost") return { label: statusText("quote", q.status), tone: "danger" };
  if (q.status === "archived") return { label: statusText("quote", q.status), tone: "muted" };
  if (q.status === "converted") {
    const job = q.jobs?.[0];
    if (job?.status === "completed" || job?.status === "archived") return { label: "Done", tone: "good" };
    if (job?.status === "requires_invoicing") return { label: "To invoice", tone: "info" };
    return { label: "Scheduled", tone: "good" };
  }
  if (q.status === "approved") return { label: "Signed", tone: "good" };
  if (!hasTakeoff) return { label: "Measuring", tone: "muted" };
  if (!q.lines?.length) return { label: "Pricing", tone: "muted" };
  if (q.status === "changes_requested") return { label: statusText("quote", q.status), tone: "warning" };
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
// Packages (roof_packages): what goes on each kind of roof, or any trade's services sold together
// ---------------------------------------------------------------------------------------------

export type PackageStyle = "shingle" | "designer" | "metal" | "other";
export const PACKAGE_STYLES: Array<{ id: PackageStyle; label: string }> = [
  { id: "shingle", label: "Shingle" },
  { id: "designer", label: "Designer" },
  { id: "metal", label: "Metal" },
  { id: "other", label: "Other" },
];

/** Package names are 1 to 80 characters (roof_packages.name). */
export const PACKAGE_NAME_MAX = PACKAGE_LIMITS.name;

/** The tier words offered for a package or an option; a business can write its own. */
export const TIER_WORDS = ["Good", "Better", "Best"] as const;

/** A quote offers up to 3 options (quote_options). */
export const MAX_OPTIONS = 3;

/** Whether the business is a roofer: packages are roofs, priced by the square, with ranges and ABC Supply. */
export const isRoofingCompany = (company: { trade_preset?: string | null }) => company.trade_preset === "roofing_exteriors";

/** Where the business edits its packages: Roofing → Packages for a roofer, else its own page. */
export const packagesPath = (company: { trade_preset?: string | null }) => (isRoofingCompany(company) ? "/roofing/packages" : "/packages");

/**
 * What a tap on a package card picks. A tap picks that package instead of the one picked, as it
 * always has; `add` ("+ Offer as an option") puts it beside the others instead. With two or more
 * picked, or on a screen that only offers options (`toggle`), a tap adds a package or takes it off
 * again. Locked packages (already on the estimate) stay first and can't be taken off. Past `max`
 * nothing changes and `full` says so.
 */
export function pickPackage(
  value: readonly string[],
  id: string,
  { max = MAX_OPTIONS, locked = [], add = false, toggle = false }: { max?: number; locked?: readonly string[]; add?: boolean; toggle?: boolean } = {},
): { value: string[]; full: boolean } {
  const picked = [...locked, ...value.filter((v) => !locked.includes(v))];
  if (locked.includes(id)) return { value: picked, full: false };
  const on = picked.includes(id);
  if (!add && !toggle && picked.length <= 1) return { value: on ? picked : [...locked, id], full: false };
  if (on) return { value: add ? picked : picked.filter((v) => v !== id), full: false };
  if (picked.length >= max) return { value: picked, full: true };
  return { value: [...picked, id], full: false };
}

/**
 * Highlights as they're saved: each line trimmed, empty ones left out, at most 8 of them and 1,200
 * characters between them (roof_packages_highlights_check), the last ones cut to fit.
 */
export function cleanHighlights(lines: readonly string[]): string[] {
  const out: string[] = [];
  let room = PACKAGE_LIMITS.highlightChars;
  for (const line of lines) {
    const text = line.trim().slice(0, room).trim();
    if (!text || out.length >= PACKAGE_LIMITS.highlights) continue;
    out.push(text);
    room -= text.length;
  }
  return out;
}

/**
 * The highlights to show once the saved ones change: the lines as they're being typed while they
 * still come to what's saved (with an empty line just added, say), else the saved ones (changed
 * somewhere else, or put back after a save failed).
 */
export const typedOrSaved = (typed: string[], saved: string[]): string[] => (sameList(cleanHighlights(typed), saved) ? typed : saved);

/** How many characters the highlight at `index` can have, with the others as they are. */
export function highlightRoom(lines: readonly string[], index: number): number {
  const others = lines.reduce((sum, line, i) => (i === index ? sum : sum + line.trim().length), 0);
  return Math.max(0, PACKAGE_LIMITS.highlightChars - others);
}

/** The list with one item moved from `from` to `to` (both kept inside the list). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(Math.min(Math.max(to, 0), next.length), 0, item!);
  return next;
}

/** Whether two lists hold the same things in the same order. */
export const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A package's (or an option's) contract sections after one is switched on or off: in the library's
 * order, as the template's are, without sections that aren't in the library any more, at most 50.
 */
export function toggleSection(library: ReadonlyArray<{ id: string }>, sectionIds: readonly string[], id: string, on: boolean): string[] {
  const chosen = new Set(sectionIds);
  if (on) chosen.add(id);
  else chosen.delete(id);
  return library.filter((s) => chosen.has(s.id)).map((s) => s.id).slice(0, PACKAGE_LIMITS.sections);
}

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

/** "$560 a square" for a roof priced by the square (else its price and unit), or null without one. */
export function squarePrice(roof: { unit_price: number; unit: string } | null | undefined, format: { whole: (n: number) => string; cents: (n: number) => string }): string | null {
  if (!roof) return null;
  return isSquareUnit(roof.unit) ? `${moneyText(roof.unit_price, format)} a square` : unitPrice(roof.unit_price, roof.unit, format);
}

/**
 * The price line on a package's card: a roof's price a square; elsewhere its main service and that
 * service's price, or how many services are always in it.
 */
export function packagePriceLine(
  p: { roof: { name: string; unit: string; unit_price: number } | null; items: ReadonlyArray<{ kind: string }> },
  roofing: boolean,
  format: { whole: (n: number) => string; cents: (n: number) => string },
): string {
  if (p.roof) return roofing ? squarePrice(p.roof, format)! : `${p.roof.name}, ${unitPrice(p.roof.unit_price, p.roof.unit, format)}`;
  if (roofing) return "No roof picked yet";
  const included = p.items.filter((i) => i.kind === "included").length;
  return included ? `${included} ${included === 1 ? "service" : "services"}` : "Nothing in it yet";
}

/**
 * The small line under a package card's price: its highlights and, for a roof, its quick adds (only
 * a roofer's estimates show them) and whether new estimates start from it; "No quick adds" for a
 * roof with none of those, and nothing elsewhere.
 */
export function packageExtras(p: { highlights: readonly string[]; items: ReadonlyArray<{ kind: string }>; is_default: boolean }, roofing: boolean): string {
  const quick = roofing ? p.items.filter((i) => i.kind === "quick").length : 0;
  const extras = [
    p.highlights.length ? `${p.highlights.length} ${p.highlights.length === 1 ? "highlight" : "highlights"}` : null,
    quick ? `${quick} quick ${quick === 1 ? "add" : "adds"}` : null,
    // Only a roofer's new estimates start from the default package.
    roofing && p.is_default ? "Default" : null,
  ].filter(Boolean);
  return extras.length ? extras.join(" · ") : roofing ? "No quick adds" : "";
}

/**
 * What the packages page says while packages still have the example warranty setup gave them (core
 * isExampleWarranty, which promises years of workmanship the business never chose): which ones, and
 * STARTER_NOTE. Null once each has the business's own, or none.
 */
export function exampleWarrantyNote(packages: ReadonlyArray<{ name: string; warranty: string }>): string | null {
  const names = packages.filter((p) => isExampleWarranty(p.warranty)).map((p) => p.name.trim());
  if (!names.length) return null;
  const which = names.length === 1 ? `The warranty on ${names[0]} is` : names.length === packages.length ? "The warranties on your packages are" : `The warranties on ${names.slice(0, -1).join(", ")} and ${names.at(-1)} are`;
  return `${which} from setup. ${STARTER_NOTE}`;
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
