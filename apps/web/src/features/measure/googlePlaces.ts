/**
 * Address suggestions from Google (Places API (New): Autocomplete, then Place Details for the one
 * picked), for a company that added its own Google key in Settings > Maps and turned suggestions on
 * there. Asked from the browser with that key, like the map tiles: it's a browser key, limited to the
 * company's web address in Google Cloud. The suggestions shown while someone types and the lookup of
 * the one they pick share a session token, so Google bills them as one session. Google's terms want
 * its name on suggestions shown without a Google map, which AddressSearch heads "From Google Maps".
 */
import type { MapSettings } from "@crewtavo/core/imagery";

const PLACES = "https://places.googleapis.com/v1";

export interface GooglePrediction {
  placeId: string;
  label: string;
  detail: string | null;
  /** How close in to zoom: a house, a street, or a town or landmark. */
  kind: "address" | "street" | "place";
}

export interface GooglePlace {
  lat: number;
  lng: number;
  /** Two-letter country code. */
  country: string | null;
}

/** The company's own Google key, when it turned on Google's address suggestions in Settings > Maps. */
export function googlePlacesKey(settings: Record<string, unknown> | null | undefined): string | null {
  const maps = ((settings ?? {}).maps ?? {}) as MapSettings;
  return maps.google_places ? maps.google_key?.trim() || null : null;
}

/** A sentence to show when Google refuses, saying what to fix. */
export class PlacesError extends Error {}

type GoogleError = { error?: { message?: string; status?: string; details?: Array<{ reason?: string }> } };

async function ask<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(8000) }).catch(() => null);
  if (!res) throw new PlacesError("Couldn't reach Google. Check your internet connection.");
  const body = (await res.json().catch(() => ({}))) as T & GoogleError;
  if (!res.ok || body.error) throw new PlacesError(placesProblem(res.status, body.error));
  return body;
}

export function placesProblem(status: number, error?: GoogleError["error"]): string {
  const text = `${error?.status ?? ""} ${error?.message ?? ""} ${(error?.details ?? []).map((d) => d.reason ?? "").join(" ")}`;
  if (/API_KEY_INVALID|not valid/i.test(text)) return "Google didn't accept this key. Check that you copied all of it.";
  if (/referer|referrer/i.test(text)) return `This key is limited to other websites. In Google Cloud, add ${location.origin} to the key's website restrictions.`;
  if (/SERVICE_DISABLED|has not been used|is disabled/i.test(text)) return "This key's project doesn't have Places API (New) turned on. In Google Cloud, enable Places API (New) for the project this key belongs to.";
  if (/API_KEY_SERVICE_BLOCKED|are blocked/i.test(text)) return "This key isn't allowed to use Places API (New). In Google Cloud, edit the key and add Places API (New) to its API restrictions.";
  if (/billing/i.test(text)) return "Google needs a billing account on this key's project before it suggests places.";
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(text)) return "This key has used up its Places quota for now.";
  if (status === 403) return "Google refused this key for place suggestions. Check that Places API (New) is allowed for it.";
  return "Google's place suggestions aren't working with this key right now.";
}

const kindOf = (types: string[] = []): GooglePrediction["kind"] =>
  types.some((t) => t === "street_address" || t === "premise" || t === "subpremise") ? "address" : types.includes("route") ? "street" : "place";

/** Places matching what's typed, leaning toward `near` (within about 30 miles). */
export async function googleSuggest(key: string, input: string, near: { lat: number; lng: number } | null, session: string): Promise<GooglePrediction[]> {
  const body = await ask<{
    suggestions?: Array<{ placePrediction?: { placeId?: string; text?: { text?: string }; structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } }; types?: string[] } }>;
  }>(`${PLACES}/places:autocomplete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
    body: JSON.stringify({
      input,
      sessionToken: session,
      languageCode: navigator.language || "en",
      ...(near ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50_000 } } } : {}),
    }),
  });
  return (body.suggestions ?? []).flatMap(({ placePrediction: p }): GooglePrediction[] => {
    const label = p?.structuredFormat?.mainText?.text || p?.text?.text;
    if (!p?.placeId || !label) return [];
    // US addresses read like the rest of the app's, without the country.
    const detail = p.structuredFormat?.secondaryText?.text?.replace(/, USA$/, "") || null;
    return [{ placeId: p.placeId, label, detail, kind: kindOf(p.types) }];
  });
}

/** Where a suggested place is. Ends the session its suggestions were asked in. */
export async function googlePlace(key: string, placeId: string, session: string): Promise<GooglePlace> {
  const body = await ask<{ location?: { latitude?: number; longitude?: number }; addressComponents?: Array<{ shortText?: string; types?: string[] }> }>(
    `${PLACES}/places/${encodeURIComponent(placeId)}?${new URLSearchParams({ sessionToken: session })}`,
    { headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "location,addressComponents" } },
  );
  const { latitude: lat, longitude: lng } = body.location ?? {};
  if (typeof lat !== "number" || typeof lng !== "number") throw new PlacesError("Google didn't say where that place is.");
  const country = body.addressComponents?.find((c) => c.types?.includes("country"))?.shortText?.toUpperCase() ?? null;
  return { lat, lng, country };
}

/** Settings > Maps: whether this key can suggest places. A sentence to show, or null when it works. */
export async function checkGooglePlaces(key: string): Promise<string | null> {
  try {
    await googleSuggest(key, "1600 Pennsylvania Ave", null, crypto.randomUUID());
    return null;
  } catch (error) {
    return error instanceof PlacesError ? error.message : "Couldn't check the key with Google. Try again.";
  }
}
