/**
 * Finding properties on the map (lat/lng) from their address, for routes, weather and the
 * measuring tool: one at a time when someone saves a property, and in the background for the
 * ones an import brought in. Always with the person's own client, so it changes only properties
 * they could change themselves.
 */
import type { Env } from "../env";
import type { Db } from "../lib/supabase";
import { geocodeAddress } from "./external";

const FIELDS = "id, line1, line2, city, region, postal_code, country";
type Located = { lat: number; lng: number } & Record<string, unknown>;

/** Finds the property on the map and saves where. Null when it isn't found (or isn't there). */
export async function geocodeProperty(db: Db, env: Env, companyId: string, id: string): Promise<Located | null> {
  const { data: property } = await db.from("properties").select(FIELDS).eq("id", id).eq("company_id", companyId).maybeSingle();
  if (!property) return null;
  const abroad = Boolean(property.country && !/^(us|usa|united states( of america)?)$/i.test(property.country.trim()));
  const address = [property.line1, property.line2, property.city, property.region, property.postal_code, abroad ? property.country : null].filter(Boolean).join(", ");
  const result = await geocodeAddress(address, env.GOOGLE_MAPS_SERVER_KEY, { world: abroad });
  if (!result) return null;
  const { error } = await db.from("properties").update({ lat: result.lat, lng: result.lng }).eq("id", id);
  if (error) throw new Error(error.message);
  return result as unknown as Located;
}

/**
 * Finds these properties on the map one after another, in the background: the free geocoder
 * answers about once a second, so a big import shouldn't wait for it. Any that aren't found stay
 * "Not on the map yet", as before.
 */
export function geocodeLater(db: Db, env: Env, companyId: string, ids: readonly string[]): void {
  if (!ids.length) return;
  void (async () => {
    for (const id of ids.slice(0, 2000)) await geocodeProperty(db, env, companyId, id).catch(() => null);
  })();
}
