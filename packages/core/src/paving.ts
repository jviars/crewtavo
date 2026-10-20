/**
 * Paving takeoff items: what a shape on the measuring map is (asphalt, a striped line, an ADA stall),
 * so a paving takeoff can price each kind of work on its own line. A shape carries its item in its
 * GeoJSON properties (`item`); the totals per item are the formula values below, used by quote
 * formulas like any other measurement value (FORMULA_VARIABLES).
 *
 * Stall rows save clicking every stall: a line drawn along the front of a row of stalls counts one
 * stall per STALL_WIDTH_FT and the painted lines between them, STALL_LINE_FT each.
 */
import type { Section } from "./geo";

export type PavingGeometry = "area" | "line" | "count";

export interface PavingItem {
  id: string;
  name: string;
  group: PavingGroup;
  geometry: PavingGeometry;
  /** On the map, in the legend and on the takeoff sheet. Bright enough to read on asphalt. */
  color: string;
  /** One line on how to draw it. */
  hint: string;
}

export const PAVING_GROUPS = ["Pavement", "Sealcoat and repair", "Striping", "Curb and site"] as const;
export type PavingGroup = (typeof PAVING_GROUPS)[number];

/** Standard stall: 9 ft wide, with an 18 ft line between neighbors. */
export const STALL_WIDTH_FT = 9;
export const STALL_LINE_FT = 18;

export const PAVING_ITEMS: readonly PavingItem[] = [
  { id: "asphalt", name: "Asphalt", group: "Pavement", geometry: "area", color: "#3b82f6", hint: "Outline the asphalt. Cut out islands and buildings." },
  { id: "concrete", name: "Concrete", group: "Pavement", geometry: "area", color: "#f472b6", hint: "Sidewalks, pads and aprons." },
  { id: "gravel", name: "Gravel", group: "Pavement", geometry: "area", color: "#d97706", hint: "Gravel or stone surfaces." },
  { id: "sealcoat", name: "Sealcoat area", group: "Sealcoat and repair", geometry: "area", color: "#8b5cf6", hint: "Only when part of the asphalt gets sealed; otherwise all of it does." },
  { id: "patch", name: "Patch", group: "Sealcoat and repair", geometry: "area", color: "#f97316", hint: "Potholes and failed spots to cut out and patch." },
  { id: "overlay", name: "Mill and overlay", group: "Sealcoat and repair", geometry: "area", color: "#14b8a6", hint: "Areas to mill and pave over." },
  { id: "crack", name: "Crack seal", group: "Sealcoat and repair", geometry: "line", color: "#fb923c", hint: "Trace the cracks to fill." },
  { id: "stall_row", name: "Stall row", group: "Striping", geometry: "line", color: "#ffffff", hint: `Draw along the front of a row: one stall every ${STALL_WIDTH_FT} ft, with its ${STALL_LINE_FT} ft lines.` },
  { id: "stall", name: "Stall", group: "Striping", geometry: "count", color: "#e2e8f0", hint: "Tap single stalls that aren't in a row." },
  { id: "ada_stall", name: "ADA stall", group: "Striping", geometry: "count", color: "#60a5fa", hint: "Tap each accessible stall." },
  { id: "stripe_white", name: "White line", group: "Striping", geometry: "line", color: "#f8fafc", hint: "Lane lines and other white striping." },
  { id: "stripe_yellow", name: "Yellow line", group: "Striping", geometry: "line", color: "#facc15", hint: "Yellow striping and curb paint." },
  { id: "stripe_blue", name: "Blue line", group: "Striping", geometry: "line", color: "#2563eb", hint: "ADA aisle and access striping." },
  { id: "stripe_red", name: "Red line", group: "Striping", geometry: "line", color: "#dc2626", hint: "Fire lanes." },
  { id: "crosswalk", name: "Crosswalk", group: "Striping", geometry: "line", color: "#5eead4", hint: "Draw across the crosswalk: its length." },
  { id: "stop_bar", name: "Stop bar", group: "Striping", geometry: "line", color: "#fca5a5", hint: "Draw along each stop bar." },
  { id: "arrow", name: "Arrow", group: "Striping", geometry: "count", color: "#fde047", hint: "Tap each arrow." },
  { id: "symbol", name: "Stencil or symbol", group: "Striping", geometry: "count", color: "#c084fc", hint: "ADA symbols, FIRE LANE, STOP and other stencils." },
  { id: "curb", name: "Curb", group: "Curb and site", geometry: "line", color: "#a3e635", hint: "Curb and gutter, along its face." },
  { id: "wheel_stop", name: "Wheel stop", group: "Curb and site", geometry: "count", color: "#f59e0b", hint: "Tap each wheel stop." },
  { id: "bollard", name: "Bollard", group: "Curb and site", geometry: "count", color: "#eab308", hint: "Tap each bollard." },
  { id: "speed_bump", name: "Speed bump", group: "Curb and site", geometry: "count", color: "#fb7185", hint: "Tap each speed bump." },
  { id: "drain", name: "Drain", group: "Curb and site", geometry: "count", color: "#22d3ee", hint: "Catch basins and drains." },
];

const BY_ID = new Map(PAVING_ITEMS.map((item) => [item.id, item]));
export const pavingItem = (id: unknown): PavingItem | null => (typeof id === "string" ? BY_ID.get(id) ?? null : null);

/** Whether an item can be drawn as this kind of shape (an area item on an area, and so on). */
export function itemFits(id: unknown, kind: Section["kind"]): boolean {
  const item = pavingItem(id);
  if (!item) return false;
  return item.geometry === "area" ? kind === "Area" : item.geometry === "line" ? kind === "Length" : kind === "Count";
}

/** Stalls along a stall row of this length: one per 9 ft, rounded. */
export const stallsAlong = (lengthFt: number) => Math.max(0, Math.round(lengthFt / STALL_WIDTH_FT));
/** Painted feet in a stall row: the line on each side of every stall. */
export const stallRowStripeFt = (lengthFt: number) => {
  const stalls = stallsAlong(lengthFt);
  return stalls ? (stalls + 1) * STALL_LINE_FT : 0;
};

/**
 * Values a paving takeoff gives formulas, with what each one means for the Price list's help and
 * assistants. Square feet are after cutouts; lines are feet along the map.
 */
export const PAVING_VARIABLES = {
  asphalt_sqft: "Asphalt, sq ft (every area, when a drawing marks none as an item)",
  asphalt_sqyd: "Asphalt, sq yd",
  concrete_sqft: "Concrete, sq ft",
  gravel_sqft: "Gravel, sq ft",
  sealcoat_sqft: "Sealcoat areas, sq ft (all the asphalt when none are drawn)",
  patch_sqft: "Patch areas, sq ft",
  overlay_sqft: "Mill and overlay areas, sq ft",
  crack_ft: "Crack seal, ft",
  curb_ft: "Curb, ft",
  stripe_ft: "All painted lines, ft (white, yellow, blue and red lines, and the lines in stall rows)",
  stripe_white_ft: "White lines, ft, with stall rows",
  stripe_yellow_ft: "Yellow lines, ft",
  stripe_blue_ft: "Blue lines, ft",
  stripe_red_ft: "Red lines, ft",
  crosswalk_ft: "Crosswalks, ft",
  stop_bar_ft: "Stop bars, ft",
  stalls: "Stalls, ADA stalls included (single stalls and stall rows)",
  ada_stalls: "ADA stalls",
  arrows: "Arrows",
  symbols: "Stencils and symbols",
  wheel_stops: "Wheel stops",
  bollards: "Bollards",
  speed_bumps: "Speed bumps",
  drains: "Drains",
} as const;
export type PavingVariable = keyof typeof PAVING_VARIABLES;
export const PAVING_VARIABLE_NAMES = Object.keys(PAVING_VARIABLES) as PavingVariable[];

/** Made-up values for checking a formula that uses paving values (Settings → Price list). */
export const PAVING_SAMPLE: Record<PavingVariable, number> = {
  asphalt_sqft: 20_000, asphalt_sqyd: 2222.2, concrete_sqft: 1200, gravel_sqft: 300, sealcoat_sqft: 20_000, patch_sqft: 150, overlay_sqft: 2500,
  crack_ft: 600, curb_ft: 400, stripe_ft: 1500, stripe_white_ft: 1300, stripe_yellow_ft: 150, stripe_blue_ft: 50, stripe_red_ft: 0,
  crosswalk_ft: 60, stop_bar_ft: 24, stalls: 64, ada_stalls: 3, arrows: 6, symbols: 4, wheel_stops: 10, bollards: 2, speed_bumps: 1, drains: 2,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Each paving value for a saved or live drawing (its sections, as summarizeFeatureCollection makes them). */
export function pavingQuantities(sections: readonly Section[]): Record<PavingVariable, number> {
  const sum = (item: string) => sections.reduce((total, s) => (s.item === item ? total + Number(s.value) : total), 0);
  const count = (item: string) => sections.reduce((total, s) => (s.item === item && s.kind === "Count" ? total + Number(s.value) : total), 0);
  const rows = sections.filter((s) => s.item === "stall_row");
  const rowStalls = rows.reduce((total, s) => total + stallsAlong(Number(s.value)), 0);
  const rowLines = rows.reduce((total, s) => total + stallRowStripeFt(Number(s.value)), 0);
  const areas = sections.filter((s) => s.kind === "Area");
  // An older drawing (or one drawn without items) still prices: every area counts as asphalt.
  const asphalt = areas.some((s) => pavingItem(s.item)) ? sum("asphalt") : areas.reduce((t, s) => t + Number(s.value), 0);
  const sealcoat = sum("sealcoat");
  const lines = { white: sum("stripe_white") + rowLines, yellow: sum("stripe_yellow"), blue: sum("stripe_blue"), red: sum("stripe_red") };
  const adaStalls = count("ada_stall");
  return {
    asphalt_sqft: round2(asphalt),
    asphalt_sqyd: round2(asphalt / 9),
    concrete_sqft: round2(sum("concrete")),
    gravel_sqft: round2(sum("gravel")),
    sealcoat_sqft: round2(sealcoat > 0 ? sealcoat : asphalt),
    patch_sqft: round2(sum("patch")),
    overlay_sqft: round2(sum("overlay")),
    crack_ft: round2(sum("crack")),
    curb_ft: round2(sum("curb")),
    stripe_ft: round2(lines.white + lines.yellow + lines.blue + lines.red),
    stripe_white_ft: round2(lines.white),
    stripe_yellow_ft: round2(lines.yellow),
    stripe_blue_ft: round2(lines.blue),
    stripe_red_ft: round2(lines.red),
    crosswalk_ft: round2(sum("crosswalk")),
    stop_bar_ft: round2(sum("stop_bar")),
    stalls: count("stall") + adaStalls + rowStalls,
    ada_stalls: adaStalls,
    arrows: count("arrow"),
    symbols: count("symbol"),
    wheel_stops: count("wheel_stop"),
    bollards: count("bollard"),
    speed_bumps: count("speed_bump"),
    drains: count("drain"),
  };
}

/** One item's total, the way the takeoff shows it: sq ft, feet, or a count (stall rows count stalls). */
export function itemTotal(sections: readonly Section[], id: string): { value: number; unit: "sq ft" | "ft" | "ea" } {
  const item = pavingItem(id);
  const mine = sections.filter((s) => s.item === id);
  if (id === "stall_row") return { value: mine.reduce((t, s) => t + stallsAlong(Number(s.value)), 0), unit: "ea" };
  const value = round2(mine.reduce((t, s) => t + Number(s.value), 0));
  return { value, unit: item?.geometry === "area" ? "sq ft" : item?.geometry === "line" ? "ft" : "ea" };
}

/** Whether a drawing is a paving takeoff: any shape marked as a paving item. */
export const isPavingTakeoff = (sections: readonly Pick<Section, "item">[]) => sections.some((s) => pavingItem(s.item));
