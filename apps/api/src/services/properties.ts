/**
 * Finding properties on the map (lat/lng) from their address, for routes, weather and the
 * measuring tool: one at a time when someone saves a property, and in the background for the
 * ones an import brought in. Always with the person's own client, so it changes only properties
 * they could change themselves. Each spot is saved with the geocoder that found it
 * (properties.located_by), and the pins task looks up again the ones nobody said that for, and the
 * ones with no spot that moved to their business's country (20261124100200_property_country.sql).
 */
import type { Env } from "../env";
import type { Db } from "../lib/supabase";
import { geocodeAddress, lookUpAddress, type GeocodeResult } from "./external";

const FIELDS = "id, line1, line2, city, region, postal_code, country";
type Located = { lat: number; lng: number } & Record<string, unknown>;
type Addressed = { line1: string | null; line2?: string | null; city: string | null; region?: string | null; postal_code: string | null; country?: string | null };

/** A property's address as the geocoders are asked for it, and whether it's outside the US (OpenStreetMap is asked about those too). */
export function addressOf(p: Addressed): { address: string; abroad: boolean } {
  const abroad = Boolean(p.country && !/^(us|usa|united states( of america)?)$/i.test(p.country.trim()));
  return { address: [p.line1, p.line2, p.city, p.region, p.postal_code, abroad ? p.country : null].filter(Boolean).join(", "), abroad };
}

/**
 * Saves where a property is, with the geocoder that said so. The database forgets the source of a
 * spot that moves without its source changing (that's how it tells a write from an older server),
 * so when the same geocoder moved it, the source is said once more.
 */
export async function saveLocation(db: Db, id: string, hit: Pick<GeocodeResult, "lat" | "lng" | "source">): Promise<void> {
  const { data, error } = await db.from("properties").update({ lat: hit.lat, lng: hit.lng, located_by: hit.source }).eq("id", id).select("located_by");
  if (error) throw new Error(error.message);
  if (data?.[0] && data[0].located_by !== hit.source) {
    const again = await db.from("properties").update({ located_by: hit.source }).eq("id", id);
    if (again.error) throw new Error(again.error.message);
  }
}

/** Finds the property on the map and saves where. Null when it isn't found (or isn't there). */
export async function geocodeProperty(db: Db, env: Env, companyId: string, id: string): Promise<Located | null> {
  const { data: property } = await db.from("properties").select(FIELDS).eq("id", id).eq("company_id", companyId).maybeSingle();
  if (!property) return null;
  const { address, abroad } = addressOf(property);
  const result = await geocodeAddress(address, { world: abroad });
  if (!result) return null;
  await saveLocation(db, id, result);
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

// ---------------------------------------------------------------------------------------------
// The pins task
// ---------------------------------------------------------------------------------------------

/** Properties a run of the pins task looks up at most, and how long it goes on for: short, so a restart isn't kept waiting. */
const RELOCATE_BATCH = 12;
const RELOCATE_MS = 15_000;
/** A breath between lookups: the free geocoders are shared public services. */
const RELOCATE_PAUSE_MS = 1000;
/** After this many lookups in a row with no answer, the geocoder is taken to be down until the next run. */
const RELOCATE_GIVE_UP = 3;

/** Where the last run got to, so a property whose lookup keeps failing doesn't hold up the ones after it. */
let relocatedTo: string | null = null;
let foundTo: string | null = null;

/**
 * The pins task. On a server with a Google server key, map spots saved before each one's source was
 * kept can't be told apart from spots a free geocoder found. So every spot with no source is looked
 * up once more with the free geocoders (the Census, and OpenStreetMap for an address abroad), a few
 * each run, and what they say replaces it. An address neither of them knows keeps the spot it has,
 * marked 'unknown' so it isn't asked about again: there's no way to put a pin back by hand, and a
 * stop with no spot drops out of routes, weather checks and the clock at the property. A lookup
 * that got no answer is tried again on a later run. The shop's spot (settings.depot) gets the same.
 * A server with no Google server key skips this: its spots only ever came from the free geocoders.
 *
 * Before that, on every server: the properties that never got a spot and were moved to their
 * business's country (public.properties_to_find, which the database fills when a business's country
 * changes), each looked up once in that country. One that isn't found stays "Not on the map yet".
 */
export async function relocatePins(env: Env, admin: Db, options: { pauseMs?: number; now?: () => number } = {}) {
  const tally = { placed: 0, not_found: 0, shops: 0, looked_up: 0, moved: 0, same: 0, kept: 0, unanswered: 0 };
  const now = options.now ?? Date.now;
  const until = now() + RELOCATE_MS;
  const pause = options.pauseMs ?? RELOCATE_PAUSE_MS;
  let asked = 0;
  let silent = 0;
  /** One lookup, after a pause if it isn't the run's first. Null when the run should stop here. */
  const lookUp = async (address: string, world: boolean) => {
    if (silent >= RELOCATE_GIVE_UP || now() >= until) return null;
    if (asked++ && pause) await new Promise((done) => setTimeout(done, pause));
    const found = address.replace(/\s+/g, " ").trim().length < 5 ? "none" : await lookUpAddress(address, { world });
    silent = found === "failed" ? silent + 1 : 0;
    return found;
  };

  const waiting = async (after: string | null) => {
    const { data, error } = await admin.rpc("properties_to_find", { p_after: after ?? undefined, p_limit: RELOCATE_BATCH });
    if (error) throw new Error(error.message);
    return data ?? [];
  };
  let lost = await waiting(foundTo);
  // Past the last one: back to the top, for any whose lookup got no answer before.
  if (!lost.length && foundTo) {
    foundTo = null;
    lost = await waiting(null);
  }
  for (const p of lost) {
    const { address, abroad } = addressOf(p);
    const found = await lookUp(address, abroad);
    if (found === null) break;
    foundTo = p.id;
    if (found === "failed") {
      tally.unanswered++;
      continue;
    }
    const spot = found === "none" ? {} : { p_lat: found.lat, p_lng: found.lng, p_source: found.source };
    const { data: saved, error } = await admin.rpc("property_found", { p_property: p.id, ...spot });
    if (error) throw new Error(error.message);
    if (saved) tally.placed++;
    else if (found === "none") tally.not_found++;
  }
  if (!env.GOOGLE_MAPS_SERVER_KEY) return tally;

  const { data: shops, error: shopsError } = await admin.rpc("depots_to_relocate", { p_limit: 5 });
  if (shopsError) throw new Error(shopsError.message);
  for (const shop of shops ?? []) {
    const a = (shop.address ?? {}) as Record<string, string | undefined>;
    const was = shop.depot as { lat: number; lng: number };
    const found = await lookUp([a.line1, a.city, a.region, a.postal_code].filter(Boolean).join(", "), false);
    if (found === null) break;
    if (found === "failed") {
      tally.unanswered++;
      continue;
    }
    const depot = found === "none" ? { ...was, source: "unknown" } : { lat: found.lat, lng: found.lng, source: found.source };
    const { data: saved, error } = await admin.rpc("relocate_depot", { p_company: shop.company_id, p_address: shop.address, p_was: shop.depot, p_depot: depot });
    if (error) throw new Error(error.message);
    if (saved) tally.shops++;
  }

  const read = (after: string | null) => {
    const query = admin.from("properties").select(`${FIELDS}, lat, lng`).not("lat", "is", null).not("lng", "is", null).is("located_by", null).order("id").limit(RELOCATE_BATCH);
    return after ? query.gt("id", after) : query;
  };
  let { data: rows, error } = await read(relocatedTo);
  if (error) throw new Error(error.message);
  // Past the last one: back to the top, for any whose lookup got no answer before.
  if (!rows?.length && relocatedTo) {
    relocatedTo = null;
    ({ data: rows, error } = await read(null));
    if (error) throw new Error(error.message);
  }
  for (const p of rows ?? []) {
    const { address, abroad } = addressOf(p);
    const found = await lookUp(address, abroad);
    if (found === null) break;
    relocatedTo = p.id;
    tally.looked_up++;
    if (found === "failed") {
      tally.unanswered++;
      continue;
    }
    const moved = found !== "none" && (found.lat !== p.lat || found.lng !== p.lng);
    // Only while the spot is still the one that was read: an address changed meanwhile has been looked up afresh.
    const { data: saved, error: saveError } = await admin
      .from("properties")
      .update(found === "none" ? { located_by: "unknown" } : { lat: found.lat, lng: found.lng, located_by: found.source })
      .eq("id", p.id)
      .eq("lat", p.lat!)
      .eq("lng", p.lng!)
      .is("located_by", null)
      .select("id");
    if (saveError) throw new Error(saveError.message);
    if (!saved?.length) continue;
    if (found === "none") tally.kept++;
    else if (moved) tally.moved++;
    else tally.same++;
  }
  return tally;
}

/** Tests start each run from the top. */
export const resetRelocatePins = () => {
  relocatedTo = null;
  foundTo = null;
};
