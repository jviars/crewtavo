/**
 * Reading companies.settings on the server. The browser's role doesn't read that column (the money
 * settings are the office's: supabase/migrations/20261123100100_prices_and_settings_for_the_office.sql),
 * so the person's own client can't select it.
 *
 * settingsAs reads it as the person asking does, through public.company_settings(): all of it for
 * the office and sales, what their screens use (the time clock, the schedule's settings, the shop,
 * maps, which apps are on...) for crew leads and field crew. The routes that read it for their own
 * work read it with the server's key instead, for the company requireCompany checked the person
 * into, and never hand it back whole: what a person is shown of it comes from GET /api/me
 * (settingsFor) or company_settings().
 */
import { dbError } from "./http";
import type { Db } from "./supabase";

export async function settingsAs(db: Db, companyId: string): Promise<Record<string, any>> {
  const { data, error } = await db.rpc("company_settings", { p_company: companyId });
  if (error) throw dbError(error);
  return (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, any>;
}
