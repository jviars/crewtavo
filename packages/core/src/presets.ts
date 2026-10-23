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
 * A roof package to start a roofing business with (roof_packages): the service that prices the roof
 * by the square, what's always on it and the one-tap quick adds, all by service name.
 */
export interface PresetPackage {
  name: string;
  style: "shingle" | "designer" | "metal" | "other";
  roof: string;
  default?: boolean;
  /** quantity: how many to start with when the service isn't measured (pipe boots: 3). */
  included: Array<{ service: string; quantity?: number }>;
  quick: string[];
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

export const presetSummaries = () =>
  Object.values(PRESETS).map(({ id, name, description }) => ({ id, name, description }));
