/**
 * Trade presets: the starting catalog, formulas, checklists, intake forms and SOP categories for a
 * kind of business. Adding a trade means adding a JSON file here and to PRESETS.
 */
import general from "./presets/general.json";
import lawnExterior from "./presets/lawn_exterior.json";
import paving from "./presets/paving.json";
import roofingExteriors from "./presets/roofing_exteriors.json";
import type { WeatherRule } from "./weather";

export interface PresetService {
  name: string;
  unit: string;
  unit_price: number;
  /** What it costs the business, for the margin on quotes. */
  unit_cost?: number;
  category?: string;
  formula_name?: string;
}

export interface PresetFormula {
  name: string;
  formula: string;
  sets?: "quantity" | "unit_price"; // default quantity
}

export interface PresetChecklistItem {
  key: string;
  label: string;
  type: "check" | "number" | "text" | "choice" | "photo" | "signature";
  required: boolean;
  options?: string[];
}

export interface PresetQuestion {
  key: string;
  label: string;
  type: "address" | "text" | "long_text" | "number" | "yes_no" | "choice" | "multi_choice" | "photos";
  required: boolean;
  options?: string[];
}

export interface PresetIntakeForm {
  name: string;
  slug: string;
  kind: "request" | "assessment" | "booking";
  requires_approval: boolean;
  lead_time_days: number;
  slot_minutes?: number;
  max_per_day?: number;
  questions: PresetQuestion[];
}

/**
 * What a package's card can hold, as roof_packages and quote_options allow it (their CHECKs): the
 * name and tier in characters, up to 8 highlights with 1,200 characters between them, the warranty
 * in characters, the picture's pixels either way, and its contract sections.
 */
export const PACKAGE_LIMITS = { name: 80, tier: 40, highlights: 8, highlightChars: 1200, warranty: 400, picturePixels: 4000, sections: 50 } as const;

const PACKAGE_PICTURE = /^[0-9a-f-]{36}\/packages\/[0-9a-f-]{36}\.jpg$/;

/** A package picture's path in the files bucket (<company>/packages/<uuid>.jpg). */
export const isPackagePicturePath = (path: string) => PACKAGE_PICTURE.test(path);

/** Where a package picture loads from (`base` is the app's address, or "" on its own pages). */
export const packagePictureSrc = (path: string, base = "") => `${base}/api/public/package/${path.replace("/packages/", "/")}`;

/**
 * A roof package to start a roofing business with (roof_packages): the service that prices the roof
 * by the square, what's always on it and the one-tap quick adds, all by service name, and what the
 * homeowner reads on its card when it's offered as an option.
 */
export interface PresetPackage {
  name: string;
  style: "shingle" | "designer" | "metal" | "other";
  roof: string;
  default?: boolean;
  /** quantity: how many to start with when the service isn't measured (pipe boots: 3). */
  included: Array<{ service: string; quantity?: number }>;
  quick: string[];
  /** "Good", "Better" or "Best". */
  tier?: string;
  /** A few short lines on the option's card. */
  highlights?: string[];
  /**
   * One sentence: what the warranty covers, and for how long. Example wording, like the example
   * contract sections: wherever it's shown, say so (isExampleWarranty, contracts.ts STARTER_NOTE).
   */
  warranty?: string;
}

export interface TradePreset {
  id: string;
  name: string;
  description: string;
  services: PresetService[];
  job_types: string[];
  formulas: PresetFormula[];
  packages?: PresetPackage[];
  checklists: Array<{ name: string; job_type?: string; items: PresetChecklistItem[] }>;
  intake_forms: PresetIntakeForm[];
  weather_rules: WeatherRule[];
  sop_categories: string[];
}

export const PRESETS: Record<string, TradePreset> = {
  general: general as TradePreset,
  lawn_exterior: lawnExterior as TradePreset,
  paving: paving as TradePreset,
  roofing_exteriors: roofingExteriors as TradePreset,
};

export function getPreset(id: string): TradePreset {
  const preset = PRESETS[id];
  if (!preset) throw new RangeError(`Unknown trade preset "${id}"`);
  return preset;
}

const EXAMPLE_WARRANTIES = new Set(
  Object.values(PRESETS)
    .flatMap((p) => p.packages ?? [])
    .map((p) => p.warranty?.trim())
    .filter(Boolean),
);

/**
 * Whether a package's warranty is still a preset's example wording, which promises years of
 * workmanship the business never chose. Until the business writes its own, the office is told:
 * setup's message (roofing/packages.ts setupMessage), the packages page (STARTER_NOTE above the
 * list, a flag on the package and beside its warranty in the editor), and the office's package
 * pickers and options bar ("Example warranty"). Never where the homeowner is looking on.
 */
export const isExampleWarranty = (warranty: string | null | undefined) => EXAMPLE_WARRANTIES.has(warranty?.trim() ?? "");

export const presetSummaries = () =>
  Object.values(PRESETS).map(({ id, name, description }) => ({ id, name, description }));
