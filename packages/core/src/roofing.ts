/**
 * Roofing values for quote formulas, from a roof measured on the map: its surface (each section at
 * its own pitch, else the drawing's), the squares that come to with and without waste, and how much
 * of it is steep enough for a steep charge. The roof edges (eave_ft and the rest) come from
 * edgeLengths in geo.ts. Used by quote formulas like any other measurement value (FORMULA_VARIABLES).
 */
import { pitchFactor, pitchSlope, roofAreaSqft, ROOF_EDGES, SQFT_PER_ROOFING_SQUARE, type RoofEdge, type Section } from "./geo";

/** Rise per 12: from here up, most crews need roof jacks and charge a steep fee. */
export const STEEP_RISE = 8;

/** Roof edges on the map, in the legend and on the roof report. Bright enough to read on shingles. */
export const ROOF_EDGE_COLORS: Record<RoofEdge, string> = {
  eave: "#38bdf8",
  rake: "#a3e635",
  ridge: "#f43f5e",
  hip: "#f59e0b",
  valley: "#c084fc",
};

/**
 * Values a roof measurement gives formulas, with what each one means for the Price list's help and
 * assistants.
 */
export const ROOFING_VARIABLES = {
  roof_sqft: "Roof surface, sq ft (each section at its pitch, before waste)",
  squares: "Roofing squares with waste (100 sq ft of roof each)",
  roof_squares: "Roofing squares without waste, for tear-off and labor",
  steep_squares: `Squares (without waste) on sections at ${STEEP_RISE}/12 or steeper`,
} as const;
export type RoofingVariable = keyof typeof ROOFING_VARIABLES;
export const ROOFING_VARIABLE_NAMES = Object.keys(ROOFING_VARIABLES) as RoofingVariable[];

/** Made-up values for checking a formula that uses roofing values (Settings → Price list). */
export const ROOFING_SAMPLE: Record<RoofingVariable, number> = { roof_sqft: 2800, squares: 30.8, roof_squares: 28, steep_squares: 6 };

const round2 = (n: number) => Math.round(n * 100) / 100;
const ownPitch = (s: Section, pitch: string | null | undefined) => (typeof s.pitch === "string" && s.pitch.trim() ? s.pitch : pitch);

/**
 * Each roofing value for a saved or live drawing (its sections, as summarizeFeatureCollection makes
 * them). A drawing with no pitch counts as flat. Throws RangeError for a pitch that doesn't read.
 */
export function roofingQuantities(sections: readonly Section[], pitch: string | null | undefined, wastePct: number): Record<RoofingVariable, number> {
  const surface = roofAreaSqft({ sections: [...sections] }, pitch);
  const steep = sections.reduce((sum, s) => {
    if (s.kind !== "Area") return sum;
    const at = ownPitch(s, pitch);
    return pitchSlope(at) * 12 >= STEEP_RISE - 1e-9 ? sum + Number(s.value) * pitchFactor(at) : sum;
  }, 0);
  const waste = 1 + (Number(wastePct) || 0) / 100;
  return {
    roof_sqft: round2(surface),
    squares: round2((surface * waste) / SQFT_PER_ROOFING_SQUARE),
    roof_squares: round2(surface / SQFT_PER_ROOFING_SQUARE),
    steep_squares: round2(steep / SQFT_PER_ROOFING_SQUARE),
  };
}

/** roofingQuantities for a saved drawing, or nulls when a pitch doesn't read (formulas that use them say so). */
export function savedRoofingQuantities(sections: readonly Section[], pitch: string | null | undefined, wastePct: number): Record<RoofingVariable, number | null> {
  try {
    return roofingQuantities(sections, pitch, wastePct);
  } catch {
    return Object.fromEntries(ROOFING_VARIABLE_NAMES.map((name) => [name, null])) as Record<RoofingVariable, null>;
  }
}

/** The waste % to start a roof on: about 10% for plain gables, 15% once it has hips or valleys. */
export function suggestedWaste(edges: Partial<Record<RoofEdge, number>>): number {
  return (edges.hip ?? 0) > 0 || (edges.valley ?? 0) > 0 ? 15 : 10;
}

/** Whether a drawing is a roof: a pitch on it somewhere, or lines marked as roof edges. */
export function isRoofDrawing(sections: readonly Pick<Section, "kind" | "pitch" | "edge">[], pitch?: string | null): boolean {
  return Boolean(pitch?.trim()) || sections.some((s) => (s.kind === "Area" && Boolean(s.pitch?.trim())) || (s.kind === "Length" && (ROOF_EDGES as readonly unknown[]).includes(s.edge)));
}

// ---------------------------------------------------------------------------------------------
// Before a roof estimate goes out (Roofing → Send): what its packages left off, and low slopes
// ---------------------------------------------------------------------------------------------

/** Below this rise per 12, shingles need low-slope underlayment (ice and water shield over the section). */
export const LOW_SLOPE_RISE = 4;
/** Below this rise per 12, shingles don't go on at all: the section is another system (modified bitumen, TPO). */
export const SHINGLE_MIN_RISE = 2;

/** A roof section too low for shingles as they are: under 4/12, or under 2/12 (`tooLow`). */
export interface LowSlopeSection {
  label: string;
  pitch: string;
  tooLow: boolean;
}

/** The roof's sections under 4/12, for a shingle roof. Sections with no pitch, or one that doesn't read, aren't judged. */
export function lowSlopeSections(sections: readonly Pick<Section, "kind" | "label" | "pitch">[], pitch: string | null | undefined): LowSlopeSection[] {
  return sections.flatMap((s) => {
    if (s.kind !== "Area") return [];
    const at = ownPitch(s as Section, pitch);
    if (!at?.trim()) return [];
    let rise: number;
    try {
      rise = pitchSlope(at) * 12;
    } catch {
      return [];
    }
    return rise < LOW_SLOPE_RISE - 1e-9 ? [{ label: s.label, pitch: rise === 0 ? "flat" : at, tooLow: rise < SHINGLE_MIN_RISE - 1e-9 }] : [];
  });
}

const EDGE_PLURALS: Record<RoofEdge, string> = { eave: "eaves", rake: "rakes", ridge: "ridges", hip: "hips", valley: "valleys" };

/**
 * Why a package line left off a roof estimate needs someone to decide before it goes out: it
 * couldn't be worked out (`reason`), or it came to nothing (`none`) from roof edges none of which
 * are marked ("No eaves or rakes marked on the roof"). Null for one that's simply none on this roof,
 * like a steep charge on a 6/12: there's nothing missing to decide about. `reads` is what its
 * formula reads (core formulaVariables).
 */
export function leftOutReason(reads: ReadonlySet<string>, none: boolean, reason: string): string | null {
  if (!none) return reason;
  const edges = ROOF_EDGES.filter((e) => reads.has(`${e}_ft`));
  if (!edges.length) return null;
  const words = edges.map((e) => EDGE_PLURALS[e]);
  return `No ${words.length < 3 ? words.join(" or ") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`} marked on the roof`;
}
