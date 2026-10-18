/**
 * Imagery for the measuring map: which picture is under the drawing, how MapLibre loads it, and
 * how we tell "this spot has no picture" from "the picture server is down". The free list itself
 * (NAIP and the states) lives in @crewtavo/core/imagery.
 */
import {
  esriImageryInfo,
  esriImageryTiles,
  GOOGLE_SESSION_URL,
  googleSatelliteTiles,
  stateImagery,
  stateTileUrl,
  type MapKeys,
  type StateImagery,
} from "@crewtavo/core/imagery";
import type { RasterSourceSpecification } from "maplibre-gl";

/** "naip", "esri", "google", "street", or "state:VA". */
export type ImageryId = "naip" | "esri" | "google" | "street" | `state:${string}`;

export interface ImageryInfo {
  id: ImageryId;
  name: string;
  /** One line under the name: how sharp, when, where. */
  detail: string;
  /** Needs a key the business adds in Settings > Maps. */
  needs?: "esri" | "google";
}

export const stateId = (s: StateImagery): ImageryId => `state:${s.state}`;
const stateOf = (id: ImageryId) => (id.startsWith("state:") ? stateImagery(id.slice(6)) : null);

export function imageryInfo(id: ImageryId): ImageryInfo {
  const state = stateOf(id);
  if (state) return { id, name: `${state.name} imagery`, detail: `${state.detail} · ${state.flown} · free from the state` };
  switch (id) {
    case "esri":
      return { id, name: "Esri World Imagery", detail: "Sharp almost everywhere on Earth · needs a free Esri key", needs: "esri" };
    case "google":
      return { id, name: "Google satellite", detail: "Worldwide · needs a Google Maps key", needs: "google" };
    case "street":
      return { id, name: "Street map", detail: "Streets and building outlines, worldwide · free" };
    default:
      return { id: "naip", name: "US aerial (NAIP)", detail: "All lower 48 states · about 2 ft · free" };
  }
}

/** Keys from Settings > Maps, with the deployment's Google key as a fallback. */
export function mapKeys(settings: Record<string, unknown>, deploymentGoogleKey: string | null): MapKeys {
  const maps = (settings.maps ?? {}) as MapKeys;
  return { esri_key: maps.esri_key?.trim() || null, google_key: maps.google_key?.trim() || deploymentGoogleKey || null };
}

// ---------------------------------------------------------------------------------------------
// NAIP through Microsoft's Planetary Computer: a saved search over the NAIP collection, newest
// flight on top. Registering the same search always gives the same id, so the id below works even
// when registering can't be reached; registering again keeps it alive on their side.
// ---------------------------------------------------------------------------------------------

const PC = "https://planetarycomputer.microsoft.com/api/data/v1";
const NAIP_SEARCH = { collections: ["naip"], "filter-lang": "cql2-json", filter: { op: "=", args: [{ property: "collection" }, "naip"] }, sortby: [{ field: "datetime", direction: "desc" }] };
const KNOWN_NAIP_SEARCH = "a4af8950beff7827a890bb61534fc469";
let naipSearch: Promise<string> | null = null;

function naipSearchId(): Promise<string> {
  naipSearch ??= fetch(`${PC}/mosaic/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(NAIP_SEARCH), signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((body: { searchid?: string } | null) => body?.searchid || KNOWN_NAIP_SEARCH)
    .catch(() => KNOWN_NAIP_SEARCH);
  return naipSearch;
}

const naipTiles = (search: string) => `${PC}/mosaic/${search}/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?collection=naip&assets=image&asset_bidx=image%7C1%2C2%2C3`;

// ---------------------------------------------------------------------------------------------
// Google: tiles need a session from the same key, good for about two weeks.
// ---------------------------------------------------------------------------------------------

const GOOGLE_SESSION_KEY = "crewtavo.googleTiles";

export class KeyError extends Error {
  constructor(message: string, readonly provider: "esri" | "google") {
    super(message);
  }
}

async function googleSession(key: string): Promise<string> {
  try {
    const saved = JSON.parse(sessionStorage.getItem(GOOGLE_SESSION_KEY) ?? "null") as { key: string; session: string; expiry: number } | null;
    if (saved && saved.key === key && saved.expiry * 1000 > Date.now() + 3600_000) return saved.session;
  } catch {
    /* storage blocked: ask Google again */
  }
  const res = await fetch(GOOGLE_SESSION_URL(key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapType: "satellite", language: navigator.language || "en-US", region: "US" }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) throw new KeyError("Couldn't reach Google. Check your internet connection.", "google");
  const body = (await res.json().catch(() => ({}))) as { session?: string; expiry?: string; error?: { message?: string; status?: string } };
  if (!res.ok || !body.session) throw new KeyError(googleKeyProblem(res.status, body.error), "google");
  try {
    sessionStorage.setItem(GOOGLE_SESSION_KEY, JSON.stringify({ key, session: body.session, expiry: Number(body.expiry) }));
  } catch {
    /* fine without it */
  }
  return body.session;
}

function googleKeyProblem(status: number, error?: { message?: string; status?: string }): string {
  const text = `${error?.status ?? ""} ${error?.message ?? ""}`;
  if (/not valid|API_KEY_INVALID/i.test(text)) return "Google didn't accept this key. Check that you copied all of it.";
  if (/has not been used|disabled|SERVICE_DISABLED/i.test(text)) return "This key can't load map tiles yet. In Google Cloud, turn on the Map Tiles API for the project this key belongs to.";
  if (/referer|referrer/i.test(text)) return `This key is limited to other websites. In Google Cloud, add ${location.origin} to the key's website restrictions.`;
  if (/billing/i.test(text)) return "Google needs a billing account on this key's project before it serves map tiles.";
  if (status === 403) return "Google refused this key for map tiles. Check that the Map Tiles API is allowed for it.";
  return "Google's map tiles aren't working with this key right now.";
}

// ---------------------------------------------------------------------------------------------
// Checking keys (Settings > Maps). Each answers with a sentence to show, or null when it works.
// ---------------------------------------------------------------------------------------------

export async function checkEsriKey(key: string): Promise<string | null> {
  const res = await fetch(esriImageryInfo(key), { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) return "Couldn't reach Esri to check the key. Check your internet connection and try again.";
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } };
  if (res.ok && !body.error) return null;
  const code = body.error?.code ?? res.status;
  const message = body.error?.message ?? "";
  if (code === 498 || code === 499 || /invalid token/i.test(message)) return "Esri didn't accept this key. Check that you copied all of it (it starts with AAPT or AAPK).";
  if (/referer|referrer/i.test(message)) return `This key is limited to other websites. In your Esri key's settings, add ${location.origin} as a referrer.`;
  if (code === 403 || /privilege|permission/i.test(message)) return "This key isn't allowed to load basemaps. In Esri, edit the key and tick Basemaps under Location services.";
  return `Esri said: ${message || `error ${code}`}`;
}

export async function checkGoogleKey(key: string): Promise<string | null> {
  try {
    sessionStorage.removeItem(GOOGLE_SESSION_KEY);
  } catch {
    /* nothing saved */
  }
  try {
    await googleSession(key);
    return null;
  } catch (error) {
    return error instanceof KeyError ? error.message : "Couldn't check the key. Try again.";
  }
}

// ---------------------------------------------------------------------------------------------
// MapLibre sources
// ---------------------------------------------------------------------------------------------

export async function rasterSource(id: ImageryId, keys: MapKeys): Promise<RasterSourceSpecification | null> {
  const state = stateOf(id);
  if (state) {
    return { type: "raster", tiles: [stateTileUrl(state)], tileSize: 256, maxzoom: state.maxZoom, bounds: state.bounds, attribution: `Imagery: ${state.attribution}` };
  }
  switch (id) {
    case "esri":
      if (!keys.esri_key) throw new KeyError("Esri imagery needs a key. An admin can add one in Settings > Maps.", "esri");
      return { type: "raster", tiles: [esriImageryTiles(keys.esri_key)], tileSize: 512, maxzoom: 19, attribution: "Powered by Esri · Esri, Maxar, Earthstar Geographics, and the GIS User Community" };
    case "google":
      if (!keys.google_key) throw new KeyError("Google satellite needs a key. An admin can add one in Settings > Maps.", "google");
      return { type: "raster", tiles: [googleSatelliteTiles(keys.google_key, await googleSession(keys.google_key))], tileSize: 256, maxzoom: 21, attribution: "Imagery ©Google" };
    case "street":
      return null; // drawn from the street map's own layers
    default:
      // NAIP's pixels are about 2 ft, so past zoom 18 the map stretches what it has.
      return { type: "raster", tiles: [naipTiles(await naipSearchId())], tileSize: 256, maxzoom: 18, attribution: "Imagery: USDA NAIP (public domain) via Microsoft Planetary Computer" };
  }
}

/**
 * Whether the picture under a point has anything in it: "ok", "empty" (outside what the source
 * covers) or "down" (the server didn't answer). Looks at one tile, so it's cheap to ask after a pan.
 */
export async function probeImagery(id: ImageryId, keys: MapKeys, lng: number, lat: number, zoom = 17): Promise<"ok" | "empty" | "down"> {
  if (id === "street") return "ok";
  let source: RasterSourceSpecification | null;
  try {
    source = await rasterSource(id, keys);
  } catch {
    return "down";
  }
  if (!source?.tiles?.[0]) return "ok";
  const z = Math.min(zoom, source.maxzoom ?? zoom);
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const s = Math.sin((lat * Math.PI) / 180);
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  const size = (2 * 20037508.342789244) / n;
  const bbox = [x * size - 20037508.342789244, 20037508.342789244 - (y + 1) * size, (x + 1) * size - 20037508.342789244, 20037508.342789244 - y * size].join(",");
  const url = source.tiles[0].replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)).replace("{bbox-epsg-3857}", bbox);
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) }).catch(() => null);
  if (!res) return "down";
  if (res.status === 204 || res.status === 404) return "empty";
  if (!res.ok) return res.status >= 500 ? "down" : "empty";
  const bytes = (await res.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength;
  // A blank tile is a few hundred bytes; a picture is thousands.
  return bytes > 1200 ? "ok" : "empty";
}
