/**
 * Who reads which of the company's settings (companies.settings). The roles that see prices read all
 * of them; crew leads and field crew read only what their screens use, never the money settings
 * (minimum charge, late fees, tax, payment terms, storm prices, the profit alert...). The browser
 * can't read the column itself: it asks public.company_settings(), and GET /api/me hands each
 * person their company's settings by these rules. Subs get company_basics() instead.
 *
 * Mirrors private.field_settings and public.company_settings in the database
 * (supabase/migrations/20261123100100_prices_and_settings_for_the_office.sql).
 */
import type { Role } from "./roles";

/** The roles that read all of the settings: the ones that read a job's lines and prices. */
export const SEES_ALL_SETTINGS: readonly Role[] = ["owner", "admin", "office", "estimator"];

/** Settings crew leads and field crew read as they are. */
export const FIELD_SETTINGS = ["clock", "branding", "working_hours", "schedule", "depot", "arrival_window_min", "maps", "files", "contact_messages", "receipt_reading"] as const;

/** Apps the business turns on (Apps), of which crew leads and field crew read only whether each is on. */
export const FIELD_APPS = ["team_chat", "drive", "marketing", "paving_app", "roofing_app", "snow_app", "careers", "website"] as const;

/** What crew leads and field crew read of the settings: FIELD_SETTINGS, and whether each of FIELD_APPS is on. */
export function fieldSettings(settings: unknown): Record<string, unknown> {
  const all = settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of FIELD_SETTINGS) if (key in all) out[key] = all[key];
  for (const key of FIELD_APPS) {
    if (!(key in all)) continue;
    const app = all[key];
    out[key] = { enabled: app && typeof app === "object" && !Array.isArray(app) ? ((app as { enabled?: unknown }).enabled ?? null) : null };
  }
  return out;
}

/** The settings someone at this level reads: all of them, or fieldSettings. */
export function settingsFor(role: string, settings: unknown): Record<string, unknown> {
  if ((SEES_ALL_SETTINGS as readonly string[]).includes(role)) {
    return settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
  }
  return fieldSettings(settings);
}
