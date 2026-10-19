/** Small clients for keyless or key-only public APIs: Open-Meteo weather and Google's Solar API. */
import { pitchFromDegrees, SQFT_PER_SQM, type DayOutlook } from "@crewtavo/core";

/** Daily outlook from Open-Meteo (no key needed). */
export async function dailyOutlook(lat: number, lng: number, days = 7): Promise<DayOutlook[]> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    daily: "temperature_2m_min,temperature_2m_max,precipitation_probability_max",
    temperature_unit: "fahrenheit",
    timezone: "auto",
    forecast_days: String(days),
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);
  const { daily } = (await response.json()) as {
    daily?: { time: string[]; temperature_2m_min: number[]; temperature_2m_max: number[]; precipitation_probability_max: number[] };
  };
  // No forecast isn't good weather: callers treat this like a failed request.
  if (!daily?.time) throw new Error("Open-Meteo returned no forecast");
  return daily.time.map((date, i) => ({
    date,
    temp_min_f: daily.temperature_2m_min[i] ?? null,
    temp_max_f: daily.temperature_2m_max[i] ?? null,
    rain_chance_pct: daily.precipitation_probability_max[i] ?? null,
  }));
}

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
  source: "google" | "census" | "openstreetmap";
}

/**
 * Address -> coordinates. Google's Geocoding API when GOOGLE_MAPS_SERVER_KEY is set, otherwise the
 * free US Census Bureau geocoder (US addresses only, no key). With `world`, an address the Census
 * doesn't know is looked up in OpenStreetMap (Photon, free, no key), so the measuring map can find
 * places outside the US. Returns null when nothing matched.
 */
export async function geocodeAddress(address: string, googleKey?: string | null, options: { world?: boolean } = {}): Promise<GeocodeResult | null> {
  const query = address.replace(/\s+/g, " ").trim();
  if (query.length < 5) return null;
  if (googleKey) {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${new URLSearchParams({ address: query, key: googleKey })}`).catch(() => null);
    if (res?.ok) {
      const body = (await res.json()) as {
        status: string;
        results?: Array<{ formatted_address: string; geometry: { location: { lat: number; lng: number } }; address_components?: Array<{ short_name: string; types: string[] }> }>;
      };
      const hit = body.results?.[0];
      const country = hit?.address_components?.find((part) => part.types.includes("country"))?.short_name ?? null;
      if (body.status === "OK" && hit) return { lat: hit.geometry.location.lat, lng: hit.geometry.location.lng, formatted: hit.formatted_address, country, source: "google" };
      if (body.status === "ZERO_RESULTS") return null;
    }
  }
  const params = new URLSearchParams({ address: query, benchmark: "Public_AR_Current", format: "json" });
  const res = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const body = res?.ok ? ((await res.json().catch(() => null)) as { result?: { addressMatches?: Array<{ matchedAddress: string; coordinates: { x: number; y: number } }> } } | null) : null;
  const match = body?.result?.addressMatches?.[0];
  if (match) return { lat: match.coordinates.y, lng: match.coordinates.x, formatted: match.matchedAddress, country: "US", source: "census" };
  return options.world ? photon(query) : null;
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
}

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
    return [{ label, detail, lat, lng, country, kind }];
  });
  if (SUGGEST_CACHE.size > 2000) SUGGEST_CACHE.clear();
  SUGGEST_CACHE.set(key, { at: Date.now(), places });
  return places;
}

/** OpenStreetMap search through komoot's public Photon server (fair use, no key). */
async function photon(query: string): Promise<GeocodeResult | null> {
  const res = await fetch(`https://photon.komoot.io/api/?${new URLSearchParams({ q: query, limit: "1" })}`, {
    headers: { Accept: "application/json", "User-Agent": "Crewtavo (https://github.com/jviars/crewtavo)" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    features?: Array<{ geometry: { coordinates: [number, number] }; properties: Record<string, string | undefined> }>;
  } | null;
  const hit = body?.features?.[0];
  if (!hit) return null;
  const p = hit.properties;
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  const formatted = [p.name && p.name !== street ? p.name : null, street || null, p.city ?? p.county, p.state, p.country].filter(Boolean).join(", ") || null;
  return { lat: hit.geometry.coordinates[1], lng: hit.geometry.coordinates[0], formatted, country: p.countrycode?.toUpperCase() ?? null, source: "openstreetmap" };
}
