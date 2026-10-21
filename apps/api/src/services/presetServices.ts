/**
 * A trade's standard services for a price list that doesn't have them yet (Paving → Price book,
 * Roofing → Price book): the preset's services the list is missing, matched by name, with their
 * formulas, after the services already there.
 */
import { getPreset } from "@crewtavo/core";
import { dbError, must } from "../lib/http";
import type { Db } from "../lib/supabase";

export async function addMissingServices(db: Db, companyId: string, presetId: string): Promise<string[]> {
  const preset = getPreset(presetId);
  const existing = new Set(must(await db.from("services").select("name").eq("company_id", companyId)).map((s) => s.name.trim().toLowerCase()));
  const formulas = new Map(preset.formulas.map((f) => [f.name, f]));
  const sortFrom = must(await db.from("services").select("sort").eq("company_id", companyId).order("sort", { ascending: false }).limit(1)).at(0)?.sort ?? 0;
  const missing = preset.services.filter((s) => !existing.has(s.name.toLowerCase()));
  if (missing.length) {
    const { error } = await db.from("services").insert(
      missing.map((s, i) => {
        const formula = s.formula_name ? formulas.get(s.formula_name) : undefined;
        return {
          company_id: companyId,
          name: s.name,
          unit: s.unit,
          unit_price: s.unit_price,
          unit_cost: s.unit_cost ?? null,
          category: s.category ?? null,
          formula: formula?.formula ?? null,
          formula_target: formula?.sets ?? "quantity",
          sort: sortFrom + i + 1,
        };
      }),
    );
    if (error) throw dbError(error);
  }
  return missing.map((s) => s.name);
}
