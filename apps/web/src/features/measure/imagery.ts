/**
 * Imagery for the measuring map: which picture is under the drawing, how MapLibre loads it, and
 * how we tell "this spot has no picture" from "the picture server is down". The free list itself
 * (NAIP and the states) lives in @crewtavo/core/imagery.
 *
 * Auto (the default) isn't imagery of its own: it picks the sharpest free source for wherever the
 * map is (autoOrder), and moves down the list when one isn't answering. The source it picked is
 * always named and credited, on the map and on saved drawings.
 *
 * Terrain, slope and contours come from the USGS 3D Elevation Program (3DEP, lidar, about 1 m in
 * most of the US, public domain), drawn by USGS on request: Terrain is a map type, slope and
 * contours lie on top of any of them.
 */
import {
  esriImageryInfo,
  esriImageryTiles,
  GOOGLE_SESSION_URL,
  googleSatelliteTiles,
  stateImagery,
  stateImageryAt,
  stateTileUrl,
  type MapKeys,
  type StateImagery,
} from "@crewtavo/core/imagery";
import type { RasterSourceSpecification } from "maplibre-gl";

/** "naip", "usgs-naip", "usgs", "terrain", "esri", "google", "street", or "state:VA". */
export type ImageryId = "naip" | "usgs-naip" | "usgs" | "terrain" | "esri" | "google" | "street" | `state:${string}`;
/** What someone picked: a source, or Auto (the Crewtavo map). */
export type ImageryChoice = ImageryId | "auto";
export const AUTO_NAME = "Auto";

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
    case "usgs-naip":
      return { id, name: "US aerial (NAIP) from USGS", detail: "The same photos, from USGS's own server · free" };
    case "usgs":
      return { id, name: "USGS imagery", detail: "Nationwide, less detail up close · free" };
    case "terrain":
      return { id, name: "Terrain", detail: "Shaded hills and hollows from USGS lidar · US · free" };
    default:
      return { id: "naip", name: "US aerial (NAIP)", detail: "All lower 48 states · about 2 ft · free" };
  }
}

/**
 * The credit for a source, as shown on the map and under a saved drawing. Public-domain sources
 * don't legally need one, but their publishers ask for it; DC's (CC BY), OpenStreetMap's (ODbL),
 * Esri's and Google's terms require it.
 */
export function imageryCredit(id: ImageryId): string {
  const state = stateOf(id);
  if (state) return state.state === "VA" ? "Imagery courtesy of the Commonwealth of Virginia (VGIN)" : `Imagery: ${state.attribution}`;
  switch (id) {
    case "esri":
      return "Powered by Esri · Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community";
    case "google":
      return "Imagery ©Google";
    case "street":
      return "Map data © OpenStreetMap contributors · © OpenMapTiles · OpenFreeMap";
    case "usgs-naip":
      return "Imagery: USDA NAIP (public domain), courtesy of the U.S. Geological Survey";
    case "usgs":
      return "Imagery courtesy of the U.S. Geological Survey (The National Map)";
    case "terrain":
      return ELEVATION_CREDIT;
    default:
      return "Imagery: USDA NAIP (public domain), via Microsoft Planetary Computer";
  }
}

/**
 * Where Auto looks, best first. Zoomed out, the USGS basemap (fast, nationwide). Zoomed in: the
 * state's own imagery, NAIP, the same NAIP photos from USGS's server (Microsoft's copy is a preview
 * service with no uptime promise), the USGS basemap, then, outside the US, Esri when there's a key,
 * and the street map, which loads anywhere. Google is never picked for you: its terms don't allow
 * keeping pictures of it with a drawing.
 */
export function autoOrder(lng: number, lat: number, zoom: number, keys: MapKeys): ImageryId[] {
  if (zoom < 11) return ["usgs", "street"];
  return [...stateImageryAt(lng, lat).map(stateId), "naip", "usgs-naip", "usgs", ...(keys.esri_key ? (["esri"] as const) : []), "street"];
}

/**
 * The first source in autoOrder that has a picture here, skipping ones that aren't answering.
 * `probe` answers "ok", "empty" or "down" (the page caches it).
 */
export async function resolveAuto(
  lng: number, lat: number, zoom: number, keys: MapKeys,
  probe: (id: ImageryId) => Promise<"ok" | "empty" | "down">,
  skip: (id: ImageryId) => boolean = () => false,
): Promise<{ id: ImageryId; passed: Array<{ id: ImageryId; why: "empty" | "down" }> }> {
  const passed: Array<{ id: ImageryId; why: "empty" | "down" }> = [];
  for (const id of autoOrder(lng, lat, zoom, keys)) {
    if (id === "street") return { id, passed };
    if (skip(id)) {
      passed.push({ id, why: "down" });
      continue;
    }
    // Zoomed out there's nothing to check: the USGS basemap covers the country.
    const result = zoom < 11 ? "ok" : await probe(id);
    if (result === "ok") return { id, passed };
    passed.push({ id, why: result });
  }
  return { id: "street", passed };
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

// ---------------------------------------------------------------------------------------------
// Elevation (USGS 3DEP): terrain, slope and contours, drawn by USGS for each tile.
// ---------------------------------------------------------------------------------------------

export const ELEVATION_CREDIT = "Elevation courtesy of the U.S. Geological Survey (3D Elevation Program)";
const DEP = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage";
// 512px tiles: USGS draws each one on its own, so bigger tiles mean fewer seams between them.
const depTiles = (rule: object, format: "jpg" | "png") =>
  `${DEP}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=${format}&transparent=true&renderingRule=${encodeURIComponent(JSON.stringify(rule))}&f=image`;
/** 3DEP covers the US and its territories; nothing is asked for outside this box. */
const US_BOX: [number, number, number, number] = [-179.5, 17.5, -64.5, 71.5];
const depSource = (tiles: string, attribution: string): RasterSourceSpecification =>
  // Drawn on request from about 1 m elevation, so it stays sharp up close.
  ({ type: "raster", tiles: [tiles], tileSize: 512, minzoom: 10, maxzoom: 20, bounds: US_BOX, attribution });

/** Slope classes, by grade (rise over run), with the colors the map and its legend use. */
export const SLOPE_CLASSES = [
  { upTo: 2, color: "#60a5fa", label: "Flat, under 2%", note: "water can sit" },
  { upTo: 5, color: "#4ade80", label: "2–5%", note: "gentle" },
  { upTo: 10, color: "#facc15", label: "5–10%", note: "noticeable" },
  { upTo: 33.3, color: "#fb923c", label: "10–33%", note: "steep" },
  { upTo: Infinity, color: "#ef4444", label: "Over 33%", note: "steeper than 3:1, hard to mow" },
] as const;

function slopeRule() {
  const degrees = (grade: number) => (grade === Infinity ? 90 : (Math.atan(grade / 100) * 180) / Math.PI);
  const ranges = SLOPE_CLASSES.flatMap((c, i) => [i ? degrees(SLOPE_CLASSES[i - 1].upTo) : 0, degrees(c.upTo)]);
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return {
    rasterFunction: "Colormap",
    rasterFunctionArguments: {
      Colormap: SLOPE_CLASSES.map((c, i) => [i + 1, ...rgb(c.color)]),
      Raster: {
        rasterFunction: "Remap",
        rasterFunctionArguments: { InputRanges: ranges, OutputValues: SLOPE_CLASSES.map((_, i) => i + 1), Raster: { rasterFunction: "Slope", rasterFunctionArguments: { ZFactor: 1, SlopeType: 1 } } },
        variableName: "Raster",
      },
    },
    variableName: "Raster",
  };
}

export type OverlayId = "slope" | "contours";
export const OVERLAYS: Record<OverlayId, { name: string; detail: string; opacity: number }> = {
  slope: { name: "Slope", detail: "How steep the ground is, by color · US", opacity: 0.5 },
  contours: { name: "Contour lines", detail: "Every 2 ft of rise · US", opacity: 0.9 },
};
export function overlaySource(id: OverlayId): RasterSourceSpecification {
  return depSource(id === "slope" ? depTiles(slopeRule(), "png") : depTiles({ rasterFunction: "Preset 2ft Contour Interval" }, "png"), ELEVATION_CREDIT);
}

const USGS = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}";
const USGS_NAIP = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=jpg&f=image";

export async function rasterSource(id: ImageryId, keys: MapKeys): Promise<RasterSourceSpecification | null> {
  const attribution = imageryCredit(id);
  const state = stateOf(id);
  if (state) return { type: "raster", tiles: [stateTileUrl(state)], tileSize: 256, maxzoom: state.maxZoom, bounds: state.bounds, attribution };
  switch (id) {
    case "esri":
      if (!keys.esri_key) throw new KeyError("Esri imagery needs a key. An admin can add one in Settings > Maps.", "esri");
      return { type: "raster", tiles: [esriImageryTiles(keys.esri_key)], tileSize: 512, maxzoom: 19, attribution };
    case "google":
      if (!keys.google_key) throw new KeyError("Google satellite needs a key. An admin can add one in Settings > Maps.", "google");
      return { type: "raster", tiles: [googleSatelliteTiles(keys.google_key, await googleSession(keys.google_key))], tileSize: 256, maxzoom: 21, attribution };
    case "street":
      return null; // drawn from the street map's own layers
    case "usgs":
      // USGS's cache stops at zoom 16; the map stretches it past that.
      return { type: "raster", tiles: [USGS], tileSize: 256, maxzoom: 16, attribution };
    case "usgs-naip":
      return { type: "raster", tiles: [USGS_NAIP], tileSize: 256, maxzoom: 18, attribution };
    case "terrain":
      return { ...depSource(depTiles({ rasterFunction: "Hillshade Multidirectional" }, "jpg"), attribution), minzoom: 0 };
    default:
      // NAIP's pixels are about 2 ft, so past zoom 18 the map stretches what it has.
      return { type: "raster", tiles: [naipTiles(await naipSearchId())], tileSize: 256, maxzoom: 18, attribution };
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
