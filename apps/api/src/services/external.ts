/** Small clients for keyless or key-only public APIs: Google's Solar API and the free geocoders (US Census, OpenStreetMap). (Forecasts: services/forecast.ts.) */
import { pitchFromDegrees, SQFT_PER_SQM } from "@crewtavo/core";
import { countryCode } from "@crewtavo/core/countries";
import { usStateCode } from "@crewtavo/core/postcards";

/** Places this close share a forecast: about a kilometer, finer than the forecast itself. */
export const placeKey = (lat: number, lng: number) => `${lat.toFixed(2)},${lng.toFixed(2)}`;

export interface RoofSegment {
  pitch: string;
  pitch_degrees: number;
  azimuth_degrees: number;
  sloped_area_sqft: number;
  plan_area_sqft: number;
}

/** Roof planes for the building nearest a point, from Google's Solar API (buildingInsights). */
export async function roofSegments(apiKey: string, lat: number, lng: number): Promise<{ segments: RoofSegment[]; imagery_date?: string } | null> {
  const params = new URLSearchParams({
    "location.latitude": String(lat),
    "location.longitude": String(lng),
    requiredQuality: "MEDIUM",
    key: apiKey,
  });
  const response = await fetch(`https://solar.googleapis.com/v1/buildingInsights:findClosest?${params}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Solar API returned ${response.status}`);
  const body = (await response.json()) as {
    imageryDate?: { year: number; month: number; day: number };
    solarPotential?: {
      roofSegmentStats?: Array<{
        pitchDegrees?: number;
        azimuthDegrees?: number;
        stats?: { areaMeters2?: number; groundAreaMeters2?: number };
      }>;
    };
  };
  const segments = (body.solarPotential?.roofSegmentStats ?? []).map((s) => ({
    pitch: pitchFromDegrees(s.pitchDegrees ?? 0),
    pitch_degrees: Math.round((s.pitchDegrees ?? 0) * 10) / 10,
    azimuth_degrees: Math.round(s.azimuthDegrees ?? 0),
    sloped_area_sqft: Math.round((s.stats?.areaMeters2 ?? 0) * SQFT_PER_SQM),
    plan_area_sqft: Math.round((s.stats?.groundAreaMeters2 ?? 0) * SQFT_PER_SQM),
  }));
  const d = body.imageryDate;
  return {
    segments,
    imagery_date: d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : undefined,
  };
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  formatted: string | null;
  /** Two-letter country code when the geocoder says (US for the Census geocoder). */
  country: string | null;
  source: "census" | "openstreetmap";
}

/**
 * What looking an address up said: where it is, "none" when the geocoders answered and don't know
 * it, or "failed" when one couldn't be reached or didn't answer properly (worth asking again later).
 */
export type AddressLookup = GeocodeResult | "none" | "failed";

/** Where to look an address up. */
export interface LookupOptions {
  /** Also outside the US: an address the Census doesn't know is looked up anywhere in OpenStreetMap. */
  world?: boolean;
  /**
   * The country the address is in, an ISO code (the business's, or the property's): outside the US,
   * only OpenStreetMap is asked, about that country, and only an answer there counts. With `world`
   * as well, an address it doesn't know there is then looked up as above. The US, or none, is as
   * before.
   */
  country?: string | null;
}

/**
 * Address -> coordinates, from the free US Census Bureau geocoder (US addresses only, no key). With
 * `world`, an address the Census doesn't know is looked up in OpenStreetMap (Photon, free, no key),
 * so the measuring map can find places outside the US; with another `country`, OpenStreetMap is
 * asked first, about that country. Only these two are asked: what they say can be kept with the
 * property and shown on any map.
 */
export async function lookUpAddress(address: string, options: LookupOptions = {}): Promise<AddressLookup> {
  const query = address.replace(/\s+/g, " ").trim();
  if (query.length < 5) return "none";
  const country = countryCode(options.country);
  if (country && country !== "US") {
    // A spot kept with a property has to pinpoint it; the measuring map only needs to go there.
    const there = await photon(query, country, !options.world);
    if (there !== "none" || !options.world) return there;
  }
  const params = new URLSearchParams({ address: query, benchmark: "Public_AR_Current", format: "json" });
  const res = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const body = res?.ok ? ((await res.json().catch(() => null)) as { result?: { addressMatches?: Array<{ matchedAddress: string; coordinates: { x: number; y: number } }> } } | null) : null;
  const matches = body?.result?.addressMatches;
  const match = Array.isArray(matches) ? matches[0] : undefined;
  if (match) return { lat: match.coordinates.y, lng: match.coordinates.x, formatted: match.matchedAddress, country: "US", source: "census" };
  if (options.world) return photon(query);
  // An answer with no matches means the Census doesn't know the address; anything else, that it didn't answer.
  return Array.isArray(matches) ? "none" : "failed";
}

/** Address -> coordinates (lookUpAddress). Null when nothing matched or the geocoder didn't answer. */
export async function geocodeAddress(address: string, options: LookupOptions = {}): Promise<GeocodeResult | null> {
  const found = await lookUpAddress(address, options);
  return typeof found === "string" ? null : found;
}

export interface PlaceSuggestion {
  label: string;
  detail: string | null;
  lat: number;
  lng: number;
  /** Two-letter country code. */
  country: string | null;
  /** How close in to zoom: a house, a street, or a town or landmark. */
  kind: "address" | "street" | "place";
  /** A house's address in a property's own boxes, for a form to fill in (a US state as its two letters). */
  parts?: AddressParts;
}

export interface AddressParts { line1: string; city: string; region: string; postal_code: string }

// Typeahead asks again on every few keystrokes; the same text near the same place gets the same
// answer for a day, which also keeps us a fair user of the public server.
const SUGGEST_CACHE = new Map<string, { at: number; places: PlaceSuggestion[] }>();
const SUGGEST_TTL = 24 * 3600_000;

/**
 * Place suggestions as someone types (Photon, OpenStreetMap data, no key), leaning toward places
 * near `near`. Good for streets, towns and landmarks; OpenStreetMap is missing many rural US house
 * numbers, which is why a full address still goes to the Census geocoder on Enter.
 */
export async function suggestPlaces(text: string, near?: { lat: number; lng: number }): Promise<PlaceSuggestion[]> {
  const query = text.replace(/\s+/g, " ").trim();
  const key = `${query.toLowerCase()}|${near ? `${near.lat.toFixed(1)},${near.lng.toFixed(1)}` : ""}`;
  const cached = SUGGEST_CACHE.get(key);
  if (cached && Date.now() - cached.at < SUGGEST_TTL) return cached.places;
  const params = new URLSearchParams({ q: query, limit: "6", lang: "en" });
  if (near) {
    params.set("lat", near.lat.toFixed(4));
    params.set("lon", near.lng.toFixed(4));
    // A strong pull toward the map, so "Diamond Av" finds the one in town before one across the country.
    params.set("zoom", "12");
    params.set("location_bias_scale", "0.1");
  }
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, {
    headers: { Accept: "application/json", "User-Agent": "Crewtavo (https://github.com/jviars/crewtavo)" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Photon returned ${res.status}`);
  const body = (await res.json()) as { features?: Array<{ geometry?: { coordinates?: [number, number] }; properties: Record<string, string | undefined> }> };
  const seen = new Set<string>();
  const places = (body.features ?? []).flatMap((f): PlaceSuggestion[] => {
    const [lng, lat] = f.geometry?.coordinates ?? [];
    if (typeof lat !== "number" || typeof lng !== "number") return [];
    const p = f.properties;
    const country = p.countrycode?.toUpperCase() ?? null;
    const street = [p.housenumber, p.street].filter(Boolean).join(" ");
    const kind = p.housenumber ? "address" : p.type === "street" || p.osm_key === "highway" ? "street" : "place";
    const label = (kind === "address" ? street : p.name || street) || p.city || p.county || "";
    const detail = [kind === "place" && street && street !== label ? street : null, p.city !== label ? p.city ?? p.county : null, p.state, country !== "US" ? p.country : null].filter(Boolean).join(", ") || null;
    const id = `${label}|${detail}`;
    if (!label || seen.has(id)) return [];
    seen.add(id);
    const parts = kind === "address" ? { line1: street, city: p.city ?? p.locality ?? "", region: (country === "US" ? usStateCode(p.state) : null) ?? p.state ?? "", postal_code: p.postcode ?? "" } : undefined;
    return [{ label, detail, lat, lng, country, kind, ...(parts ? { parts } : {}) }];
  });
  if (SUGGEST_CACHE.size > 2000) SUGGEST_CACHE.clear();
  SUGGEST_CACHE.set(key, { at: Date.now(), places });
  return places;
}

const squash = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Whether an answer says where the address is, rather than only its town or district: a house (it
 * has a number), or a street in the address's own postcode (a UK postcode is a few dozen doors).
 * OpenStreetMap often lacks the house numbers of British and Canadian streets, and a spot in the
 * middle of town would be kept as the property's for its routes, weather and the clock at the
 * property.
 */
export function pinpoints(p: Record<string, string | undefined>, query: string): boolean {
  if (p.housenumber || p.type === "house") return true;
  const street = p.type === "street" || p.osm_key === "highway";
  return street && Boolean(p.postcode) && squash(query).includes(squash(p.postcode!));
}

/**
 * OpenStreetMap search through komoot's public Photon server (fair use, no key). With a country,
 * Photon is asked about that country only (its countrycode filter), and an answer from anywhere else
 * is passed over all the same; `precise` passes over one that doesn't pinpoint the address too.
 */
async function photon(query: string, country?: string, precise = false): Promise<AddressLookup> {
  const params = new URLSearchParams({ q: query, limit: country ? "3" : "1" });
  if (country) params.set("countrycode", country);
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, {
    headers: { Accept: "application/json", "User-Agent": "Crewtavo (https://github.com/jviars/crewtavo)" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return "failed";
  const body = (await res.json().catch(() => null)) as {
    features?: Array<{ geometry: { coordinates: [number, number] }; properties: Record<string, string | undefined> }>;
  } | null;
  if (!Array.isArray(body?.features)) return "failed";
  const hit = country
    ? body.features.find((f) => f.properties?.countrycode?.toUpperCase() === country && (!precise || pinpoints(f.properties, query)))
    : body.features[0];
  if (!hit) return "none";
  const p = hit.properties;
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  const formatted = [p.name && p.name !== street ? p.name : null, street || null, p.city ?? p.county, p.state, p.country].filter(Boolean).join(", ") || null;
  return { lat: hit.geometry.coordinates[1], lng: hit.geometry.coordinates[0], formatted, country: p.countrycode?.toUpperCase() ?? null, source: "openstreetmap" };
}
