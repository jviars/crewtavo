/**
 * A lawn's slope from Google's elevation, where USGS has none (outside the US), for a company that
 * turned it on in Settings > Maps with its own Google key (settings.maps.google_elevation). Google's
 * Elevation API won't answer a browser directly, so this loads the Maps JavaScript API, once and only
 * when it's first needed, and asks its ElevationService for heights on a grid over the lawn
 * (slopeGrid in core); the grade between neighboring points gives the slope (slopeFromGrid). Measure
 * only asks while it shows Google satellite: Google's terms keep its data on a Google map.
 */
import { slopeFromGrid, slopeGrid } from "@crewtavo/core/elevation";
import { cutOut, type Geometry, type GroundSlope } from "@crewtavo/core/geo";
import type { MapSettings } from "@crewtavo/core/imagery";

interface LatLng { lat: number; lng: number }
interface ElevationService { getElevationForLocations(request: { locations: LatLng[] }): Promise<{ results: Array<{ elevation: number }> }> }
interface MapsLibrary { importLibrary(name: "elevation"): Promise<{ ElevationService: new () => ElevationService }> }
declare global {
  interface Window {
    google?: { maps?: MapsLibrary };
    gm_authFailure?: () => void;
    crewtavoMapsReady?: () => void;
  }
}

/** The company's own Google key, when it turned on slope from Google in Settings > Maps. */
export function googleElevationKey(settings: Record<string, unknown> | null | undefined): string | null {
  const maps = ((settings ?? {}).maps ?? {}) as MapSettings;
  return maps.google_elevation ? maps.google_key?.trim() || null : null;
}

/** A sentence to show when Google refuses, saying what to fix. */
export class ElevationError extends Error {}

const REFUSED = "Google refused this key for elevation. In Google Cloud, enable the Maps JavaScript API and the Elevation API for its project, and allow both on the key.";

// Google turns a key down after its library has loaded (gm_authFailure), and then leaves requests
// unanswered: each waits for that or 15 seconds, whichever comes first.
let refused = false;
const waiting = new Set<(error: Error) => void>();
function refuse() {
  refused = true;
  for (const stop of waiting) stop(new ElevationError(REFUSED));
  waiting.clear();
}
function guarded<T>(request: Promise<T>): Promise<T> {
  if (refused) return Promise.reject(new ElevationError(REFUSED));
  return new Promise<T>((resolve, reject) => {
    const stop = (error: Error) => reject(error);
    waiting.add(stop);
    const timer = setTimeout(() => stop(new ElevationError("Google didn't answer. Check that the key allows the Maps JavaScript API and the Elevation API, then try again.")), 15_000);
    request.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      waiting.delete(stop);
    });
  });
}

let loading: Promise<MapsLibrary> | null = null;
/** The key the library was loaded with: it can't be loaded again with another until the page reloads. */
let loadedKey: string | null = null;
/** Google's Maps JavaScript API, loaded once for this page with the company's key. */
function mapsLibrary(key: string): Promise<MapsLibrary> {
  if (loadedKey && loadedKey !== key) return Promise.reject(new ElevationError("Google's library here still has the old key. Reload the page, then try again."));
  if (window.google?.maps?.importLibrary) return Promise.resolve(window.google.maps);
  loadedKey = key;
  loading ??= new Promise<MapsLibrary>((resolve, reject) => {
    window.crewtavoMapsReady = () => (window.google?.maps ? resolve(window.google.maps) : reject(new ElevationError(REFUSED)));
    window.gm_authFailure = () => {
      refuse();
      reject(new ElevationError(REFUSED));
    };
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=crewtavoMapsReady`;
    script.async = true;
    script.onerror = () => reject(new ElevationError("Couldn't reach Google. Check your internet connection."));
    document.head.append(script);
  }).catch((error) => {
    loading = null;
    loadedKey = null;
    throw error;
  });
  return loading;
}

/** Heights for these points, in Google's batches of up to 500. */
async function heights(key: string, points: LatLng[]): Promise<number[]> {
  const { ElevationService } = await guarded((await mapsLibrary(key)).importLibrary("elevation"));
  const service = new ElevationService();
  const out: number[] = [];
  for (let at = 0; at < points.length; at += 500) {
    const answer = await guarded(service.getElevationForLocations({ locations: points.slice(at, at + 500) })).catch((error: { code?: string }) => {
      if (error instanceof ElevationError) throw error;
      throw new ElevationError(error?.code === "OVER_QUERY_LIMIT" ? "This key has used up its elevation quota for now." : REFUSED);
    });
    out.push(...answer.results.map((r) => r.elevation));
  }
  return out;
}

/** The slope under a lawn, less the cutouts over it, from Google's heights; null when there's nothing to ask about. */
export async function readGoogleSlope(key: string, area: Geometry, cutouts: Geometry[]): Promise<GroundSlope | null> {
  const grid = slopeGrid(cutOut(area, cutouts));
  if (grid.points.length < 2) return null;
  return slopeFromGrid(grid, await heights(key, grid.points.map((p) => ({ lat: p.lat, lng: p.lng }))));
}

/** Null when the key gives heights, else what to fix (Settings > Maps checks before turning it on). */
export async function checkGoogleElevation(key: string): Promise<string | null> {
  try {
    await heights(key, [{ lat: 51.5, lng: -0.13 }]);
    return null;
  } catch (error) {
    return error instanceof ElevationError ? error.message : "Couldn't check the key with Google. Try again.";
  }
}
