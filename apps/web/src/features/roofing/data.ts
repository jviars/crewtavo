/**
 * The roofing flow's records: a roofing project is a quote with a roof measured on the map (a
 * measurement with a pitch or roof edges), the same records a paving project uses (paving/data.ts).
 * The estimate sorts the price list's services by what they price on a roof: the roof itself
 * (offered as one choice, or as Good, Better and Best), tearing off the old one, and the rest.
 */
import { formulaVariables } from "@crewtavo/core/formulas";
import { ROOFING_VARIABLE_NAMES, isRoofDrawing } from "@crewtavo/core/roofing";
import { sectionsOf, type StepId, type TakeoffRow } from "../paving/data";
import type { IconName } from "@/components/ui/Icon";

export const ROOF_STEPS: Array<{ id: StepId; label: string; icon: IconName; text: string }> = [
  { id: "takeoff", label: "Measure", icon: "area", text: "Outline the roof and set its pitch" },
  { id: "estimate", label: "Estimate", icon: "dollar", text: "Pick the roof, price it from your price book" },
  { id: "proposal", label: "Proposal", icon: "send", text: "Send it to sign online" },
  { id: "schedule", label: "Schedule", icon: "calendar", text: "Turn it into a job for a crew" },
  { id: "invoice", label: "Invoice", icon: "invoice", text: "Bill the deposit and the rest" },
];

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
