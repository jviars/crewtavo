/**
 * A trade's standard services for a price list that doesn't have them yet (Paving → Price book,
 * Roofing → Price book): the preset's services the list is missing, matched by name, with their
 * formulas, after the services already there.
 * And a trade's starter custom fields for a business that doesn't have them yet (roofing's insurance
 * claim details on quotes and jobs), the same way.
 */
import { getPreset, presetCustomFields } from "@crewtavo/core";
import { dbError, must } from "../lib/http";
import type { Db } from "../lib/supabase";

/** `only`: just these of the preset's services (lawn's add-ons), not the whole list. */
export async function addMissingServices(db: Db, companyId: string, presetId: string, only?: readonly string[]): Promise<string[]> {
  const preset = getPreset(presetId);
  const existing = new Set(must(await db.from("services").select("name").eq("company_id", companyId)).map((s) => s.name.trim().toLowerCase()));
  const formulas = new Map(preset.formulas.map((f) => [f.name, f]));
  const sortFrom = must(await db.from("services").select("sort").eq("company_id", companyId).order("sort", { ascending: false }).limit(1)).at(0)?.sort ?? 0;
  const missing = preset.services.filter((s) => !existing.has(s.name.toLowerCase()) && (!only || only.includes(s.name)));
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
          default_depth_in: s.default_depth_in ?? null,
          sort: sortFrom + i + 1,
        };
      }),
    );
    if (error) throw dbError(error);
  }
  return missing.map((s) => s.name);
}

/**
 * The preset's formula for these services where the price list has them without one (a lawn
 * business's "Mulch install" from before it priced from beds). Never over a formula someone set.
 */
export async function fillMissingFormulas(db: Db, companyId: string, presetId: string, names: readonly string[]): Promise<string[]> {
  const preset = getPreset(presetId);
  const formulas = new Map(preset.formulas.map((f) => [f.name, f]));
  const wanted = new Map(preset.services.filter((s) => names.includes(s.name) && s.formula_name).map((s) => [s.name.toLowerCase(), s]));
  const bare = must(await db.from("services").select("id, name").eq("company_id", companyId).is("formula", null));
  const filled: string[] = [];
  for (const row of bare) {
    const s = wanted.get(row.name.trim().toLowerCase());
    const formula = s?.formula_name ? formulas.get(s.formula_name) : undefined;
    if (!s || !formula) continue;
    const change = { formula: formula.formula, formula_target: formula.sets ?? "quantity", ...(s.default_depth_in != null ? { default_depth_in: s.default_depth_in } : {}) };
    const { error } = await db.from("services").update(change).eq("id", row.id).is("formula", null);
    if (error) throw dbError(error);
    filled.push(row.name);
  }
  return filled;
}

/**
 * The preset's custom fields a business doesn't have yet, after the fields it has; the labels of
 * those added, each once. A field of the same key on the same kind of record counts as there,
 * whatever it's called now and archived or not: the business made it, renamed it or put it away.
 */
export async function addMissingCustomFields(db: Db, companyId: string, presetId: string): Promise<string[]> {
  const wanted = presetCustomFields(getPreset(presetId));
  if (!wanted.length) return [];
  const have = must(await db.from("custom_field_definitions").select("record_type, key, sort").eq("company_id", companyId));
  const taken = new Set(have.map((f) => `${f.record_type}:${f.key}`));
  const sortFrom = have.reduce((most, f) => Math.max(most, f.sort), 0);
  const missing = wanted.filter((f) => !taken.has(`${f.record_type}:${f.key}`));
  if (missing.length) {
    const { error } = await db.from("custom_field_definitions").insert(missing.map((f) => ({ ...f, company_id: companyId, sort: sortFrom + f.sort + 1 })));
    if (error) throw dbError(error);
  }
  return [...new Set(missing.map((f) => f.label))];
}
