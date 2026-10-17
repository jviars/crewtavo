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
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);
  const { daily } = (await response.json()) as {
    daily?: { time: string[]; temperature_2m_min: number[]; temperature_2m_max: number[]; precipitation_probability_max: number[] };
  };
  if (!daily) return [];
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
  source: "google" | "census";
}

/**
 * Address -> coordinates. Google's Geocoding API when GOOGLE_MAPS_SERVER_KEY is set, otherwise the
 * free US Census Bureau geocoder (US addresses only, no key). Returns null when nothing matched.
 */
export async function geocodeAddress(address: string, googleKey?: string | null): Promise<GeocodeResult | null> {
  const query = address.replace(/\s+/g, " ").trim();
  if (query.length < 5) return null;
  if (googleKey) {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${new URLSearchParams({ address: query, key: googleKey })}`).catch(() => null);
    if (res?.ok) {
      const body = (await res.json()) as { status: string; results?: Array<{ formatted_address: string; geometry: { location: { lat: number; lng: number } } }> };
      const hit = body.results?.[0];
      if (body.status === "OK" && hit) return { lat: hit.geometry.location.lat, lng: hit.geometry.location.lng, formatted: hit.formatted_address, source: "google" };
      if (body.status === "ZERO_RESULTS") return null;
    }
  }
  const params = new URLSearchParams({ address: query, benchmark: "Public_AR_Current", format: "json" });
  const res = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params}`, { headers: { Accept: "application/json" } }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { result?: { addressMatches?: Array<{ matchedAddress: string; coordinates: { x: number; y: number } }> } } | null;
  const match = body?.result?.addressMatches?.[0];
  return match ? { lat: match.coordinates.y, lng: match.coordinates.x, formatted: match.matchedAddress, source: "census" } : null;
}
