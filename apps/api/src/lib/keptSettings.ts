import { dbError } from "./http";
import type { Db } from "./supabase";

/**
 * The business's prices and targets kept apart from its settings (company_private_settings: the
 * paving calculator, the roofing price ranges, the revenue goal and margin target). Empty when it has
 * none, or for someone the database doesn't give them to (a crew).
 */
export async function keptSettings(db: Db, companyId: string): Promise<Record<string, unknown>> {
  const { data, error } = await db.from("company_private_settings").select("settings").eq("company_id", companyId).maybeSingle();
  if (error) throw dbError(error);
  return (data?.settings ?? {}) as Record<string, unknown>;
}
