/**
 * The company's settings as saved now, for the screens that change them (Settings, the apps' own
 * set-up, the revenue goal...), which read them fresh rather than trust the copy from sign-in
 * (useSession().company.settings). The browser doesn't read companies.settings itself:
 * public.company_settings() gives the office and sales all of them, and crew leads and field crew
 * what their screens use (fieldSettings in packages/core/src/companySettings.ts).
 */
import { supabase, unwrap } from "./api";

export async function loadSettings(companyId: string): Promise<Record<string, unknown>> {
  const settings = unwrap(await supabase().rpc("company_settings", { p_company: companyId }));
  return settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
}
