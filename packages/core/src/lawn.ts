/**
 * Lawn takeoffs: what a shape on the measuring map is to a lawn crew (a bed, edging, a tree or an
 * obstacle to mow around) and the values those and the ground's slope give quote formulas
 * (FORMULA_VARIABLES). Plain areas are the lawn. Beds are drawn with Cut out, so they come out of
 * the mowed area and still count for mulch. Items ride on shapes the way paving's do (paving.ts).
 */
import type { GroundSlope, Section } from "./geo";
import type { PavingItem } from "./paving";

/**
 * Business types that measure lawns: their Measure gets these items and each lawn's slope. Not
 * landscaping: its starter mulch and sod are priced from the drawn area, and a bed cut out of the
 * lawn would take its area away from them.
 */
export const LAWN_TRADES: ReadonlySet<string> = new Set(["lawn_exterior"]);

/**
 * Business types that work outdoors and may measure a lawn now and then: Measure offers them its Lawn
 * section, closed, to turn the lawn tools on. Plumbers, electricians and the rest never see it.
 */
export const LAWN_OFFER_TRADES: ReadonlySet<string> = new Set(["general", "landscaping", "handyman", "pest_control"]);

/**
 * A lawn's slope picked by hand where none could be read (outside the US, or the elevation service
 * not answering), and the values it prices as. Steep is much of the lawn steeper than 3:1.
 */
export const SLOPE_CHOICES = {
  flat: { label: "Flat", hint: "Under 5%, easy to mow", mean_pct: 2, steep_pct: 0 },
  hilly: { label: "Hilly", hint: "Slopes to mow across", mean_pct: 15, steep_pct: 10 },
  steep: { label: "Steep", hint: "Much of it steeper than 3:1", mean_pct: 35, steep_pct: 60 },
} as const;
export type SlopeChoice = keyof typeof SLOPE_CHOICES;
export const SLOPE_CHOICE_IDS = Object.keys(SLOPE_CHOICES) as SlopeChoice[];
/** The slope a choice stands for, marked as picked. */
export const pickedSlope = (choice: SlopeChoice): GroundSlope => ({ mean_pct: SLOPE_CHOICES[choice].mean_pct, steep_pct: SLOPE_CHOICES[choice].steep_pct, picked: choice });

/** The lawn starter services priced from these values, for a price list that doesn't have them yet. */
export const LAWN_ADD_ONS = ["Steep slope mowing", "Trim around trees", "Trim around obstacles", "Bed edging", "Mulch install"] as const;

/** A bed is a cutout, and the map draws every cutout red (MeasureMap's CUT_COLOR), so it's red here too. */
export const LAWN_ITEMS: readonly PavingItem[] = [
  { id: "bed", name: "Bed", group: "Lawn items", geometry: "cutout", color: "#ef4444", hint: "Outline mulch and planting beds. Where they're over the lawn, they come out of the mowed area." },
  { id: "edging", name: "Edging", group: "Lawn items", geometry: "line", color: "#facc15", hint: "Draw along the walks, drives and beds you edge." },
  { id: "tree", name: "Tree", group: "Lawn items", geometry: "count", color: "#2dd4bf", hint: "Tap each tree to mow and trim around." },
  { id: "obstacle", name: "Obstacle", group: "Lawn items", geometry: "count", color: "#f472b6", hint: "Tap each playset, trampoline, rock or anything else to trim around." },
];

const BY_ID = new Map(LAWN_ITEMS.map((item) => [item.id, item]));
export const lawnItem = (id: unknown): PavingItem | null => (typeof id === "string" ? BY_ID.get(id) ?? null : null);

/** Values a lawn gives formulas, with what each means for the Price list's help and assistants. */
export const LAWN_VARIABLES = {
  slope_pct: "The lawn's average slope, in percent (USGS in the US, Google elsewhere when it's on in Settings > Maps, or Flat, Hilly or Steep picked by hand)",
  steep_pct: "How much of the lawn is steeper than 3:1, in percent",
  bed_sqft: "Beds, sq ft (each whole bed, on the lawn or not)",
  edging_ft: "Edging, ft",
  trees: "Trees",
  obstacles: "Obstacles: playsets, trampolines, rocks and the like",
} as const;
export type LawnVariable = keyof typeof LAWN_VARIABLES;
export const LAWN_VARIABLE_NAMES = Object.keys(LAWN_VARIABLES) as LawnVariable[];

/** Made-up values for checking a formula that uses lawn values (Settings → Price list). */
export const LAWN_SAMPLE: Record<LawnVariable, number> = { slope_pct: 8, steep_pct: 5, bed_sqft: 400, edging_ft: 150, trees: 3, obstacles: 1 };

/**
 * The ground's slope under a drawing's areas, weighted by area: slope_pct, the average grade, and
 * steep_pct, how much is steeper than 3:1. Null until every area has a reading.
 */
export function drawingSlope(summary: { sections: readonly Section[] }): { slope_pct: number | null; steep_pct: number | null } {
  const areas = summary.sections.filter((s) => s.kind === "Area" && Number(s.value) > 0);
  const total = areas.reduce((sum, s) => sum + Number(s.value), 0);
  if (!total || areas.some((s) => !s.slope)) return { slope_pct: null, steep_pct: null };
  const weighted = (pick: (slope: GroundSlope) => number) => Math.round((areas.reduce((sum, s) => sum + pick(s.slope!) * Number(s.value), 0) / total) * 10) / 10;
  return { slope_pct: weighted((s) => s.mean_pct), steep_pct: weighted((s) => s.steep_pct) };
}

/** Each lawn value for a saved or live drawing (its sections, as summarizeFeatureCollection makes them). */
export function lawnQuantities(sections: readonly Section[]): Record<LawnVariable, number | null> {
  const sum = (item: string) => Math.round(sections.reduce((total, s) => (s.item === item ? total + Number(s.uncut_value ?? s.value) : total), 0) * 100) / 100;
  return { ...drawingSlope({ sections }), bed_sqft: sum("bed"), edging_ft: sum("edging"), trees: sum("tree"), obstacles: sum("obstacle") };
}
