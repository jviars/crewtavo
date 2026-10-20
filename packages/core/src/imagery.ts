/**
 * Aerial imagery the measuring map draws on. Platform-free, so the web app, API and tests share one
 * list.
 *   US aerial (NAIP) - every lower-48 state, public domain, about 2 ft pixels. The default.
 *   State imagery    - sharper (3 in to 1 ft) where a state publishes its own for free. Offered when
 *                      the map is over that state.
 *   Esri, Google     - sharp almost everywhere on Earth, with a key the business adds in Settings.
 *   Street map       - OpenStreetMap streets and buildings, worldwide, no key.
 * Every free source here was checked to load in a browser with no key or account (October 2026).
 */

/** [west, south, east, north] in degrees. */
export type Bounds = [number, number, number, number];

export interface StateImagery {
  /** Two-letter postal code. */
  state: string;
  name: string;
  /** ArcGIS REST service. */
  url: string;
  /** "tile": a Web Mercator tile cache. "export": a MapServer drawn on request. "image": an ImageServer drawn on request. */
  kind: "tile" | "export" | "image";
  /** Deepest zoom with real detail; the map stretches this level past it. */
  maxZoom: number;
  /** Ground size of one pixel, as people say it ("6 in"). */
  detail: string;
  /** When it was flown. */
  flown: string;
  attribution: string;
  bounds: Bounds;
}

export const STATE_IMAGERY: StateImagery[] = [
  { state: "AR", name: "Arkansas", url: "https://gis.arkansas.gov/arcgis/rest/services/ImageServices/High_Resolution_Composite/ImageServer", kind: "tile", maxZoom: 19, detail: "3–9 in", flown: "2023 and later", attribution: "Arkansas GIS Office", bounds: [-94.62, 33.0, -89.64, 36.5] },
  { state: "CT", name: "Connecticut", url: "https://cteco.uconn.edu/ctraster/rest/services/images/Ortho_2023/ImageServer", kind: "image", maxZoom: 21, detail: "3 in", flown: "spring 2023", attribution: "CT ECO, Connecticut GIS Office", bounds: [-73.73, 40.98, -71.79, 42.05] },
  { state: "DC", name: "Washington, DC", url: "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Ortho2025_WebMercator/MapServer", kind: "tile", maxZoom: 20, detail: "3 in", flown: "2025", attribution: "DC Office of the Chief Technology Officer (CC BY 4.0)", bounds: [-77.12, 38.79, -76.91, 39.0] },
  { state: "DE", name: "Delaware", url: "https://imagery.firstmap.delaware.gov/imagery/rest/services/DE_Imagery/DE_Imagery_2024/ImageServer", kind: "tile", maxZoom: 20, detail: "6 in", flown: "2024, leaf-off", attribution: "State of Delaware FirstMap", bounds: [-75.79, 38.45, -75.05, 39.84] },
  { state: "IN", name: "Indiana", url: "https://di-ingov.img.arcgis.com/arcgis/rest/services/DynamicWebMercator/Indiana_Current_Imagery/ImageServer", kind: "image", maxZoom: 20, detail: "6 in", flown: "2022–2025", attribution: "Indiana Geographic Information Office (CC0)", bounds: [-88.1, 37.77, -84.78, 41.76] },
  { state: "KY", name: "Kentucky", url: "https://kyraster.ky.gov/arcgis/rest/services/ImageServices/Ky_KYAPED_Phase3_3IN_WGS84WM/ImageServer", kind: "image", maxZoom: 21, detail: "3 in", flown: "2022–2024", attribution: "KyFromAbove", bounds: [-89.57, 36.5, -81.96, 39.15] },
  { state: "MA", name: "Massachusetts", url: "https://tiles.arcgis.com/tiles/hGdibHYSPO59RG1h/arcgis/rest/services/Massachusetts_Aerial_Imagery_2025/MapServer", kind: "tile", maxZoom: 20, detail: "6 in", flown: "spring 2025", attribution: "MassGIS", bounds: [-73.51, 41.24, -69.93, 42.89] },
  { state: "MD", name: "Maryland", url: "https://mdgeodata.md.gov/imagery/rest/services/SixInch/SixInchImagery/ImageServer", kind: "image", maxZoom: 20, detail: "6 in", flown: "2023–2025, leaf-off", attribution: "State of Maryland (MD iMAP)", bounds: [-79.49, 37.91, -75.05, 39.72] },
  { state: "NC", name: "North Carolina", url: "https://services.nconemap.gov/secure/rest/services/Imagery/Orthoimagery_Latest_cached/ImageServer", kind: "tile", maxZoom: 20, detail: "6 in", flown: "newest state flights", attribution: "NC OneMap, NC CGIA", bounds: [-84.33, 33.84, -75.46, 36.59] },
  { state: "ND", name: "North Dakota", url: "https://ndgishub.nd.gov/arcgis/rest/services/Imagery/AerialImage_DES_BaseMap_Cached/MapServer", kind: "tile", maxZoom: 20, detail: "under 1 m", flown: "NDDOT flights", attribution: "NDDOT, ND Dept. of Emergency Services, ND GIS Hub", bounds: [-104.05, 45.94, -96.55, 49.0] },
  { state: "NJ", name: "New Jersey", url: "https://maps.nj.gov/arcgis/rest/services/Basemap/Orthos_Natural_2020_NJ_WM/MapServer", kind: "tile", maxZoom: 20, detail: "1 ft", flown: "2020, leaf-off", attribution: "NJ Office of GIS", bounds: [-75.56, 38.93, -73.89, 41.36] },
  { state: "NY", name: "New York", url: "https://orthos.its.ny.gov/arcgis/rest/services/wms/Latest/MapServer", kind: "export", maxZoom: 20, detail: "6 in–1 ft", flown: "2022–2025", attribution: "NYS ITS Geospatial Services", bounds: [-79.77, 40.5, -71.85, 45.02] },
  { state: "OH", name: "Ohio", url: "https://maps.ohio.gov/image/rest/services/osip_most_current_cache/MapServer", kind: "tile", maxZoom: 20, detail: "6 in–1 ft", flown: "newest statewide flights", attribution: "Ohio OGRIP (OSIP)", bounds: [-84.82, 38.4, -80.52, 41.98] },
  { state: "OR", name: "Oregon", url: "https://imagery.oregonexplorer.info/arcgis/rest/services/OSIP_2024/OSIP_2024_WM/ImageServer", kind: "image", maxZoom: 19, detail: "1 ft", flown: "2024", attribution: "Oregon Imagery Framework (OSIP)", bounds: [-124.57, 41.99, -116.46, 46.29] },
  { state: "RI", name: "Rhode Island", url: "https://maps.edc.uri.edu/rigis/rest/services/IMG/RI_202103_RGB_3in_spf/ImageServer", kind: "image", maxZoom: 21, detail: "3 in", flown: "spring 2021", attribution: "RIGIS", bounds: [-71.91, 41.15, -71.12, 42.02] },
  { state: "TN", name: "Tennessee", url: "https://tnmap.tn.gov/arcgis/rest/services/BASEMAPS/IMAGERY_WEB_MERCATOR/MapServer", kind: "tile", maxZoom: 19, detail: "6 in–1 ft", flown: "TDOT flights", attribution: "TDOT Aerial Surveys", bounds: [-90.31, 34.98, -81.65, 36.68] },
  { state: "VA", name: "Virginia", url: "https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VBMP_Imagery/MostRecentImagery_WGS/MapServer", kind: "tile", maxZoom: 19, detail: "1 ft (sharper in some towns)", flown: "2022–2025, leaf-off", attribution: "Virginia Geographic Information Network (VGIN)", bounds: [-83.68, 36.54, -75.24, 39.47] },
  { state: "VT", name: "Vermont", url: "https://maps.vcgi.vermont.gov/arcgis/rest/services/EGC_services/IMG_VCGI_CLR2021_2025_SP_NOCACHE/ImageServer", kind: "image", maxZoom: 20, detail: "6 in–1 ft", flown: "2021–2025", attribution: "VCGI", bounds: [-73.44, 42.73, -71.46, 45.02] },
];

export const inBounds = (b: Bounds, lng: number, lat: number) => lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];

/** State imagery whose box holds this point, smallest first (DC before Maryland and Virginia). */
export function stateImageryAt(lng: number, lat: number): StateImagery[] {
  const size = (b: Bounds) => (b[2] - b[0]) * (b[3] - b[1]);
  return STATE_IMAGERY.filter((s) => inBounds(s.bounds, lng, lat)).sort((a, b) => size(a.bounds) - size(b.bounds));
}

export const stateImagery = (state: string) => STATE_IMAGERY.find((s) => s.state === state.toUpperCase()) ?? null;

/**
 * The tile URL a web map asks for: {z}/{y}/{x} for a tile cache, or a 256px picture of the tile's
 * box ({bbox-epsg-3857}, which MapLibre fills in) for a service that draws on request.
 */
export function stateTileUrl(s: StateImagery): string {
  if (s.kind === "tile") return `${s.url}/tile/{z}/{y}/{x}`;
  const draw = s.kind === "image" ? "exportImage" : "export";
  return `${s.url}/${draw}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=jpg&f=image`;
}

/** Lower 48 states. NAIP covers these; anywhere else the free US layer comes back empty. */
export const LOWER_48: Bounds = [-124.85, 24.4, -66.88, 49.39];

/** Esri's World Imagery as 512px tiles, for a key from an ArcGIS Location Platform account. */
export const esriImageryTiles = (key: string) =>
  `https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/imagery/static/tile/{z}/{y}/{x}?token=${encodeURIComponent(key)}`;

/** Esri's style metadata; it answers (or refuses) a key, so it tells whether a key works. */
export const esriImageryInfo = (key: string) =>
  `https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/imagery/static?f=json&token=${encodeURIComponent(key)}`;

/** Google's satellite tiles (Map Tiles API); `session` comes from createSession with the same key. */
export const googleSatelliteTiles = (key: string, session: string) =>
  `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(session)}&key=${encodeURIComponent(key)}`;
export const GOOGLE_SESSION_URL = (key: string) => `https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`;

/** Map keys a company keeps in its settings (companies.settings.maps). Both are browser keys. */
export interface MapKeys {
  esri_key?: string | null;
  google_key?: string | null;
}

/** companies.settings.maps: the keys, and what Measure opens on for the team ("auto" or a source). */
export interface MapSettings extends MapKeys {
  default_imagery?: string | null;
}
