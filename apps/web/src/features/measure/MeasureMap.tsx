/**
 * The measuring map: MapLibre with aerial imagery underneath and Terra Draw on top. The page talks
 * to it through a handle (tools, undo, fit, capture a picture) and hears back through callbacks.
 * Every shape gets its own color and a label on the map with its size, so the list beside the map
 * and the picture sent to clients read the same. Cutouts (the house out of the yard) are drawn in
 * red, and the areas under them are filled with the hole showing.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import type { MapKeys } from "@crewtavo/core/imagery";
import { cutOut, lineLengthM, mergePolygons, mToFt, polygonAreaM2, sqmToSqft, type Feature, type Position } from "@crewtavo/core/geo";
import { PAVING_ITEMS } from "@crewtavo/core/paving";
import maplibregl, { type GeoJSONSource, type ImageSource, type LayerSpecification, type Map as MapLibreMap, type Marker, type StyleSpecification } from "maplibre-gl";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  TerraDraw,
  TerraDrawLineStringMode,
  TerraDrawModeUndoRedo,
  TerraDrawPointMode,
  TerraDrawPolygonMode,
  TerraDrawSelectMode,
  TerraDrawSessionUndoRedo,
  type GeoJSONStoreFeatures,
  type HexColor,
} from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { KeyError, OVERLAYS, overlaySource, rasterSource, type ImageryId, type OverlayId } from "./imagery";
import { fromMercator, toMercator, type Corners, type LngLat } from "./planAlign";
import { drawSheet, feetPerPixel, type SheetInfo } from "./takeoffSheet";

export type Tool = "polygon" | "cutout" | "linestring" | "point" | "select";
/** The geometry each drawing mode makes; anything else in its layer (closing and snapping points) is a guide. */
const MODE_GEOMETRY: Record<string, string> = { polygon: "Polygon", cutout: "Polygon", linestring: "LineString", point: "Point" };

/** A finished shape as the page sees it. */
export interface Shape {
  id: string;
  kind: "Area" | "Length" | "Count" | "Cutout";
  geometry: Feature["geometry"];
  color: string;
  /** Square feet (a cutout's whole size), feet along the map, or 1 for a count. */
  value: number;
}

/** A picture of the imagery in view (MeasureMapHandle.viewImage). */
export interface ViewImage {
  canvas: HTMLCanvasElement;
  /** Where a pixel of the picture is on the map. */
  at: (x: number, y: number) => [number, number];
  /** Where a spot on the map is in the picture. */
  px: (at: LngLat) => [number, number];
}

export type SpotPicker = (at: LngLat, how: { alt: boolean }) => void;

export interface MeasureMapHandle {
  setTool(tool: Tool): void;
  /** Takes back the last point while drawing, or the last change. */
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  /** Stops the shape being drawn without keeping it. */
  cancel(): void;
  remove(id: string): void;
  /** Makes an area a cutout or a cutout an area. Returns its new id (it moves to the end), or null. */
  convert(id: string, kind: "Area" | "Cutout"): string | null;
  /** Adds shapes drawn elsewhere (building outlines), as areas or cutouts. Returns their ids. */
  add(polygons: number[][][][], kind: "Area" | "Cutout"): string[];
  /** Adds points (counts found on the imagery). Returns their ids. */
  addPoints(points: Array<[number, number]>): string[];
  /**
   * Building outlines from the street map's tiles already loaded for this view (OpenStreetMap data
   * from OpenFreeMap), as Polygon coordinates; null when none are loaded (street names off, say).
   */
  buildings(): Position[][][] | null;
  clear(): void;
  select(id: string): void;
  fitShapes(): void;
  jumpTo(lng: number, lat: number, zoom?: number): void;
  view(): { center: [number, number]; zoom: number };
  /** Puts saved shapes back on the map (reopening a measurement). Returns their new ids in order. */
  load(features: Feature[]): string[];
  /**
   * A JPEG of the shapes on the imagery, framed to fit them, or null when nothing is drawn. With
   * `imagery`, the picture is taken on that source instead (for one whose terms don't allow keeping
   * pictures of it), and the map goes back afterwards.
   */
  capture(options?: { imagery?: ImageryId; sheet?: SheetInfo }): Promise<Blob | null>;
  /**
   * The imagery in view as a picture with no drawing on it, for finding paving on it (detect.ts),
   * and where each of its pixels is on the map. Square from the middle of the map, `size` px across;
   * with `whole` all of the view, or with `bounds` ([west, south, east, north]) just that part of it
   * at the screen's full detail, `size` px along the longer side. Null before the map is ready.
   * With `imagery`, taken on that source instead (Google's terms don't allow sending it on).
   */
  viewImage(size: number, options?: { imagery?: ImageryId; whole?: boolean; bounds?: [number, number, number, number] }): Promise<ViewImage | null>;
  /** A plan sheet on the map, over the imagery and under the drawing; null takes it off. */
  setPlan(plan: { url: string; corners: Corners; opacity: number } | null): void;
  /**
   * While set, taps on the map go here instead of drawing (lining a plan up, tap to outline), with
   * whether Alt (Option) was held. Null with `owner` stops them only if they still go to `owner`.
   */
  pickSpots(onPick: SpotPicker | null, owner?: SpotPicker): void;
  /** While set, dragging on the map draws a box (its two corners go here) instead of moving the map. */
  pickBox(onBox: ((a: LngLat, b: LngLat) => void) | null): void;
  /** Pins for the spots picked so far: green on the map, blue on a plan, red for left out. */
  setPins(pins: Array<{ at: LngLat; label: string; tone: "plan" | "map" | "out" }>): void;
  /** Whether a shape is still on the map (Undo can take one away). */
  has(id: string): boolean;
  /** The view's middle and its west and east edges. */
  viewBox(): { center: LngLat; west: number; east: number } | null;
}

export interface MeasureMapProps {
  start: { lng: number; lat: number; zoom: number };
  imagery: ImageryId;
  /** Bump to load the imagery again (after it failed). */
  imageryRevision?: number;
  keys: MapKeys;
  /** Each shape's name for its label on the map. */
  labels: Record<string, string>;
  /** Sizes for the labels when they differ from the shape's own: areas after cutouts, what each cutout took out, roof edges at true length. */
  values?: Record<string, number>;
  /** A line under a shape's size on the map ("11 stalls" on a stall row). */
  notes?: Record<string, string>;
  /** A shape's own color (its paving item's) instead of one from the palette. */
  colors?: Record<string, string>;
  showStreetNames: boolean;
  /** House numbers from the street map's tiles (OpenStreetMap addresses), zoomed in close. */
  showHouseNumbers: boolean;
  /** Slope and contours, on top of the imagery and under the drawing. */
  overlays: OverlayId[];
  onReady: () => void;
  onFailed: (message: string) => void;
  onShapes: (shapes: Shape[], drawing: Shape | null) => void;
  onSelect: (id: string | null) => void;
  onMoved: (center: { lng: number; lat: number }, zoom: number) => void;
  /** The imagery isn't loading (server down, key refused); the page offers another. */
  onImageryTrouble: (id: ImageryId, message: string) => void;
  onHistory?: (canUndo: boolean, canRedo: boolean) => void;
  onStreetMap?: (available: boolean) => void;
}

// Bright enough to see on grass, roofs and asphalt alike.
const PALETTE = ["#22c55e", "#f59e0b", "#38bdf8", "#f472b6", "#a78bfa", "#facc15", "#fb7185", "#2dd4bf", "#f97316", "#60a5fa"];
const OPENFREEMAP = "https://tiles.openfreemap.org/styles/liberty";
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const LABEL_FONT = ["Noto Sans Bold"];
const CUT_COLOR = "#ef4444";

const kindOf = (mode: string, type: string): Shape["kind"] => (mode === "cutout" ? "Cutout" : type === "Polygon" ? "Area" : type === "LineString" ? "Length" : "Count");

export function shapeValue(geometry: Feature["geometry"]): number {
  if (!geometry) return 0;
  if (geometry.type === "Polygon") return sqmToSqft(polygonAreaM2(geometry.coordinates as number[][][]));
  if (geometry.type === "LineString") return mToFt(lineLengthM(geometry.coordinates as number[][]));
  return 1;
}

/**
 * Names for unnamed shapes, numbered within their kind: Area 1, Area 2, Cutout 1, Line 1, Count 1.
 * A line marked as a roof edge is named for it: Eave 1, Rake 1; a paving item too: Asphalt 1, Stall row 1.
 */
export function defaultNames(shapes: Array<Pick<Shape, "id" | "kind"> & { edge?: string | null; itemName?: string | null }>): Record<string, string> {
  const seen: Record<string, number> = {};
  return Object.fromEntries(shapes.map((s) => {
    const word = s.itemName && s.kind !== "Cutout" ? s.itemName : s.kind === "Length" && s.edge ? s.edge[0].toUpperCase() + s.edge.slice(1) : s.kind === "Length" ? "Line" : s.kind;
    seen[word] = (seen[word] ?? 0) + 1;
    return [s.id, `${word} ${seen[word]}`];
  }));
}
const MADE_UP = new RegExp(`^(Area|Cutout|Line|Length|Count|Eave|Rake|Ridge|Hip|Valley|${PAVING_ITEMS.map((i) => i.name).join("|")}) \\d+$`);
/** A name we made up rather than one someone typed (so reopening a drawing renumbers it). */
export const isDefaultName = (name: string) => MADE_UP.test(name.trim());

export function formatShapeValue(kind: Shape["kind"], value: number): string {
  const n = (v: number, d = 0) => v.toLocaleString(undefined, { maximumFractionDigits: d });
  if (kind === "Cutout") return `−${n(value)} sq ft`;
  if (kind === "Area") return value >= 43_560 ? `${n(value)} sq ft · ${n(value / 43_560, 2)} ac` : `${n(value)} sq ft`;
  if (kind === "Length") return `${n(value, value < 100 ? 1 : 0)} ft`;
  return "";
}

/** Where a shape's label sits: the middle of an area, halfway along a line, above a point. */
function labelPoint(geometry: Feature["geometry"]): [number, number] | null {
  if (!geometry) return null;
  if (geometry.type === "Point") return geometry.coordinates as [number, number];
  if (geometry.type === "LineString") {
    const line = geometry.coordinates as number[][];
    const half = lineLengthM(line) / 2;
    let walked = 0;
    for (let i = 1; i < line.length; i++) {
      const step = lineLengthM([line[i - 1], line[i]]);
      if (walked + step >= half && step > 0) {
        const t = (half - walked) / step;
        return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
      }
      walked += step;
    }
    return line[0] as [number, number];
  }
  if (geometry.type === "Polygon") {
    // Measured from the first corner: with whole longitudes and latitudes the products cancel out
    // and the middle lands meters off.
    const ring = (geometry.coordinates as number[][][])[0];
    const [ox, oy] = ring[0];
    let a = 0, x = 0, y = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0, x1, y1] = [ring[i][0] - ox, ring[i][1] - oy, ring[i + 1][0] - ox, ring[i + 1][1] - oy];
      const f = x0 * y1 - x1 * y0;
      a += f;
      x += (x0 + x1) * f;
      y += (y0 + y1) * f;
    }
    if (Math.abs(a) < 1e-18) return ring[0] as [number, number];
    return [ox + x / (3 * a), oy + y / (3 * a)];
  }
  return null;
}

/**
 * Where an area's label sits once cutouts have taken some of it: its middle when nothing came out
 * of the middle, else the spot in its biggest piece farthest from any edge, so the label sits in the
 * yard rather than on the house (a grid search is plenty at this size).
 */
function labelInside(polygons: number[][][][]): [number, number] | null {
  const pieces = polygons.filter((p) => p[0]?.length >= 4).map((p) => ({ p, a: polygonAreaM2(p) })).sort((x, y) => y.a - x.a);
  const piece = pieces[0]?.p;
  if (!piece) return null;
  const inRing = (r: number[][], x: number, y: number) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
    }
    return inside;
  };
  const inside = (x: number, y: number) => inRing(piece[0], x, y) && !piece.slice(1).some((hole) => inRing(hole, x, y));
  const middle = labelPoint({ type: "Polygon", coordinates: [piece[0]] });
  if (middle && piece.length === 1 && inside(...middle)) return middle;
  const [[w, s], [e, n]] = boundsOf([{ geometry: { type: "Polygon", coordinates: piece } }])!;
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180); // longitude degrees are shorter
  const edgeDistance = (x: number, y: number) => {
    let best = Infinity;
    for (const r of piece) {
      for (let i = 1; i < r.length; i++) {
        const [ax, ay, bx, by] = [r[i - 1][0] * k, r[i - 1][1], r[i][0] * k, r[i][1]];
        const t = Math.max(0, Math.min(1, ((x * k - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 || 1)));
        best = Math.min(best, Math.hypot(x * k - (ax + t * (bx - ax)), y - (ay + t * (by - ay))));
      }
    }
    return best;
  };
  let spot: { at: [number, number]; d: number } | null = null;
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const [x, y] = [w + ((e - w) * i) / steps, s + ((n - s) * j) / steps];
      if (!inside(x, y)) continue;
      const d = edgeDistance(x, y);
      if (!spot || d > spot.d) spot = { at: [x, y], d };
    }
  }
  return spot?.at ?? middle;
}

function boundsOf(shapes: Array<{ geometry: Feature["geometry"] }>): [[number, number], [number, number]] | null {
  let w = 180, s = 90, e = -180, n = -90;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1] as number); n = Math.max(n, c[1] as number);
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  shapes.forEach((f) => f.geometry && visit(f.geometry.coordinates));
  return w <= e ? [[w, s], [e, n]] : null;
}

/** OpenFreeMap's street map, its ids prefixed so they never meet ours or Terra Draw's. */
async function streetMap(): Promise<{ sources: StyleSpecification["sources"]; layers: LayerSpecification[]; sprite?: string } | null> {
  try {
    const style = (await (await fetch(OPENFREEMAP, { signal: AbortSignal.timeout(5000) })).json()) as StyleSpecification;
    const sources = Object.fromEntries(Object.entries(style.sources).map(([id, s]) => [`street-${id}`, s]));
    const layers = style.layers
      .filter((l) => l.type !== "background")
      .map((l) => ({ ...l, id: `street-${l.id}`, ...("source" in l && l.source ? { source: `street-${l.source}` } : {}) }) as LayerSpecification);
    return { sources, layers, sprite: typeof style.sprite === "string" ? style.sprite : undefined };
  } catch {
    return null;
  }
}
const isStreetName = (l: LayerSpecification) =>
  l.type === "symbol" && /^street-(highway-name|label_(town|village|other|city)|water_name|waterway_line_label)/.test(l.id) && !(l.layout && "icon-image" in l.layout);

export const MeasureMap = forwardRef<MeasureMapHandle, MeasureMapProps>(function MeasureMap(props, ref) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const toolRef = useRef<Tool>("polygon");
  const colors = useRef(new Map<string, string>());
  const shapesRef = useRef<Shape[]>([]);
  const streetLayers = useRef<string[]>([]);
  const nameLayers = useRef<string[]>([]);
  const imageryToken = useRef(0);
  const trouble = useRef({ errors: 0, loaded: 0, since: 0 });
  const planRef = useRef<{ url: string; corners: Corners; opacity: number } | null>(null);
  const planUrl = useRef<string | null>(null);
  const pickRef = useRef<SpotPicker | null>(null);
  const boxRef = useRef<(() => void) | null>(null); // stops drawing a box
  const pins = useRef<Marker[]>([]);
  // Callbacks change every render; the map's listeners read the latest through this.
  const live = useRef(props);
  live.current = props;

  const colorOf = (id: string) => {
    const own = live.current.colors?.[id];
    if (own) return own;
    let c = colors.current.get(id);
    if (!c) {
      c = PALETTE[colors.current.size % PALETTE.length];
      colors.current.set(id, c);
    }
    return c;
  };
  // The color Terra Draw last drew each shape in, so a shape whose item changes gets redrawn.
  const drawnColors = useRef(new Map<string, string>());
  const styleColor = (feature: GeoJSONStoreFeatures) => {
    const color = colorOf(String(feature.id));
    drawnColors.current.set(String(feature.id), color);
    return color as HexColor;
  };
  /** Fill while a shape is being drawn, and after (Terra Draw asks for each shape). */
  const drawingFill = (drawing: number, done = 0) => (feature: GeoJSONStoreFeatures) => (feature.properties.currentlyDrawing ? drawing : done);

  // ----- Map and drawing, once ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | null = null;
    (async () => {
      const streets = await streetMap();
      if (cancelled || !el.current) return;
      const style: StyleSpecification = {
        version: 8,
        glyphs: GLYPHS,
        ...(streets?.sprite ? { sprite: streets.sprite } : {}),
        sources: {
          ...(streets?.sources ?? {}),
          "measure-labels": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
          "measure-fill": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        },
        layers: [
          { id: "background", type: "background", paint: { "background-color": "#d9ded9" } },
          ...(streets?.layers ?? []).map((l) => ({ ...l, layout: { ...(l.layout ?? {}), visibility: "none" } }) as LayerSpecification),
        ],
      };
      streetLayers.current = (streets?.layers ?? []).filter((l) => !isStreetName(l)).map((l) => l.id);
      nameLayers.current = (streets?.layers ?? []).filter(isStreetName).map((l) => l.id);
      live.current.onStreetMap?.(Boolean(streets));
      try {
        map = new maplibregl.Map({
          container: el.current,
          style,
          center: [props.start.lng, props.start.lat],
          zoom: props.start.zoom,
          maxZoom: 21.5,
          attributionControl: { compact: true },
          // Keeps the last frame readable so the drawing can be saved as a picture.
          canvasContextAttributes: { preserveDrawingBuffer: true },
          dragRotate: false,
          pitchWithRotate: false,
        });
      } catch {
        live.current.onFailed("This browser can't show the map (WebGL is turned off or not supported). Try an up-to-date Chrome, Edge, Safari or Firefox, or turn on hardware acceleration.");
        return;
      }
      mapRef.current = map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "imperial", maxWidth: 120 }), "bottom-left");

      map.on("error", (e: { sourceId?: string; error?: Error }) => {
        if (e.sourceId !== "imagery") return;
        const t = trouble.current;
        t.errors += 1;
        // Many failed tiles and none loaded since the imagery or the view changed: it's down.
        if (t.errors >= 6 && t.loaded === 0 && Date.now() - t.since < 30_000) {
          t.since = 0;
          live.current.onImageryTrouble(live.current.imagery, "isn't loading right now");
        }
      });
      map.on("data", (e: { sourceId?: string; tile?: unknown }) => {
        if (e.sourceId === "imagery" && e.tile) trouble.current.loaded += 1;
      });
      map.on("moveend", () => {
        const c = map!.getCenter();
        trouble.current = { errors: 0, loaded: 0, since: Date.now() };
        live.current.onMoved({ lng: c.lng, lat: c.lat }, map!.getZoom());
      });

      map.once("load", () => {
        if (cancelled) return;
        // The tools don't wait for the imagery server.
        void applyImagery(live.current.imagery).then(() => applyStreetNames(live.current.showStreetNames));
        const editable = { feature: { draggable: true, coordinates: { midpoints: true, draggable: true, deletable: true } } };
        const draw = new TerraDraw({
          adapter: new TerraDrawMapLibreGLAdapter({ map: map!, coordinatePrecision: 9 }),
          modes: [
            // A finished area's fill is the measure-fill layer, so a cutout shows as a hole in it.
            new TerraDrawPolygonMode({
              snapping: { toCoordinate: true },
              styles: { fillColor: styleColor, fillOpacity: drawingFill(0.28), outlineColor: styleColor, outlineWidth: 3, closingPointColor: "#ffffff", closingPointWidth: 6, closingPointOutlineColor: "#0f2a35", closingPointOutlineWidth: 2 },
            }),
            new TerraDrawPolygonMode({
              modeName: "cutout",
              snapping: { toCoordinate: true },
              styles: { fillColor: CUT_COLOR, fillOpacity: drawingFill(0.22, 0.1), outlineColor: CUT_COLOR, outlineWidth: 3, closingPointColor: "#ffffff", closingPointWidth: 6, closingPointOutlineColor: "#0f2a35", closingPointOutlineWidth: 2 },
            }),
            new TerraDrawLineStringMode({ snapping: { toCoordinate: true }, styles: { lineStringColor: styleColor, lineStringWidth: 4, closingPointColor: "#ffffff", closingPointWidth: 6 } }),
            new TerraDrawPointMode({ styles: { pointColor: styleColor, pointWidth: 7, pointOutlineColor: "#ffffff", pointOutlineWidth: 2 } }),
            new TerraDrawSelectMode({
              flags: { polygon: editable, cutout: editable, linestring: editable, point: { feature: { draggable: true } } },
              styles: { selectionPointColor: "#ffffff", selectionPointOutlineColor: "#0f2a35", selectionPointWidth: 6, selectionPointOutlineWidth: 2, midPointColor: "#0f2a35", midPointOutlineColor: "#ffffff", midPointWidth: 4 },
            }),
          ],
          undoRedo: { modeLevel: new TerraDrawModeUndoRedo(), sessionLevel: new TerraDrawSessionUndoRedo() },
        });
        draw.start();
        draw.setMode(toolRef.current);
        drawRef.current = draw;
        // Under Terra Draw's own layers, so corners and outlines stay on top.
        map!.addLayer({ id: "measure-fill", type: "fill", source: "measure-fill", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.28 } }, map!.getLayer("td-polygon") ? "td-polygon" : undefined);
        // House numbers: in the street map's tiles, but its style doesn't draw them. Light on a dark
        // halo, like the shapes' labels, so they read on aerial imagery; under the drawing.
        if (map!.getSource("street-openmaptiles")) {
          map!.addLayer({
            id: "measure-housenumbers",
            type: "symbol",
            source: "street-openmaptiles",
            "source-layer": "housenumber",
            minzoom: 17,
            layout: { "text-field": ["get", "housenumber"], "text-font": LABEL_FONT, "text-size": 12, visibility: live.current.showHouseNumbers ? "visible" : "none" },
            paint: { "text-color": "#ffffff", "text-halo-color": "rgba(15, 42, 53, 0.9)", "text-halo-width": 1.6 },
          }, "measure-fill");
        }
        map!.addLayer({
          id: "measure-labels",
          type: "symbol",
          source: "measure-labels",
          layout: {
            "text-field": ["get", "text"],
            "text-font": LABEL_FONT,
            "text-size": 13,
            "text-line-height": 1.25,
            "text-allow-overlap": true,
            "text-ignore-placement": true,
            "text-offset": ["case", ["==", ["get", "kind"], "Count"], ["literal", [0, -1.3]], ["literal", [0, 0]]],
          },
          paint: { "text-color": "#ffffff", "text-halo-color": "rgba(15, 42, 53, 0.92)", "text-halo-width": 1.8 },
        });
        let frame = 0;
        draw.on("change", () => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(report);
        });
        draw.on("select", (id) => live.current.onSelect(String(id)));
        draw.on("deselect", () => live.current.onSelect(null));
        draw.on("history", () => live.current.onHistory?.(draw.canUndo(), draw.canRedo()));
        // Lining up a plan: taps pick spots instead of drawing.
        map!.on("click", (e) => pickRef.current?.([e.lngLat.lng, e.lngLat.lat], { alt: e.originalEvent.altKey }));
        trouble.current = { errors: 0, loaded: 0, since: Date.now() };
        applyOverlays(live.current.overlays);
        applyPlan();
        live.current.onReady();
        // Where the map starts counts as a move, so the page checks the imagery there straight away.
        const c = map!.getCenter();
        live.current.onMoved({ lng: c.lng, lat: c.lat }, map!.getZoom());
      });
    })();
    return () => {
      cancelled = true;
      try {
        drawRef.current?.stop();
      } catch {
        /* map already gone */
      }
      drawRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
    // The map is made once; later changes go through the effects below and the handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Tell the page what's drawn, and redraw the size labels. */
  function report() {
    const draw = drawRef.current;
    const map = mapRef.current;
    if (!draw || !map) return;
    const shapes: Shape[] = [];
    let drawing: Shape | null = null;
    for (const f of draw.getSnapshot()) {
      if (!f.geometry || MODE_GEOMETRY[String(f.properties.mode)] !== f.geometry.type) continue;
      const geometry = f.geometry as Feature["geometry"];
      const kind = kindOf(String(f.properties.mode), f.geometry.type);
      const shape: Shape = { id: String(f.id), kind, geometry, color: kind === "Cutout" ? CUT_COLOR : colorOf(String(f.id)), value: shapeValue(geometry) };
      if (f.properties.currentlyDrawing) drawing = shape;
      else shapes.push(shape);
    }
    shapesRef.current = shapes;
    live.current.onShapes(shapes, drawing);
    paintFill();
    paintLabels();
  }

  /** Each finished area's fill, with the cutouts over it left out. */
  function paintFill() {
    const source = mapRef.current?.getSource("measure-fill") as GeoJSONSource | undefined;
    if (!source) return;
    const cuts = shapesRef.current.filter((s) => s.kind === "Cutout" && s.geometry).map((s) => s.geometry!);
    const features = shapesRef.current.flatMap((s) =>
      s.kind === "Area" && s.geometry
        ? [{ type: "Feature" as const, geometry: { type: "MultiPolygon" as const, coordinates: cutOut(s.geometry, cuts) }, properties: { color: s.color } }]
        : [],
    );
    source.setData({ type: "FeatureCollection", features });
  }

  function paintLabels() {
    const source = mapRef.current?.getSource("measure-labels") as GeoJSONSource | undefined;
    if (!source) return;
    let count = 0;
    const names = defaultNames(shapesRef.current);
    const cuts = shapesRef.current.filter((s) => s.kind === "Cutout" && s.geometry).map((s) => s.geometry!);
    const features = shapesRef.current.flatMap((s) => {
      // An area with a hole in its middle (the house) gets its label off to the side, in the yard.
      const at = s.kind === "Area" && cuts.length && s.geometry ? labelInside(cutOut(s.geometry, cuts) as number[][][][]) : labelPoint(s.geometry);
      if (!at) return [];
      const name = live.current.labels[s.id]?.trim() || names[s.id];
      const note = live.current.notes?.[s.id];
      const text = s.kind === "Count" ? String(++count) : `${name}\n${formatShapeValue(s.kind, live.current.values?.[s.id] ?? s.value)}${note ? `\n${note}` : ""}`;
      return [{ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: at }, properties: { text, kind: s.kind } }];
    });
    source.setData({ type: "FeatureCollection", features });
  }

  async function applyImagery(id: ImageryId) {
    const map = mapRef.current;
    if (!map) return;
    const token = ++imageryToken.current;
    let source;
    try {
      source = await rasterSource(id, live.current.keys);
    } catch (error) {
      if (token === imageryToken.current) live.current.onImageryTrouble(id, error instanceof KeyError ? error.message : "couldn't be set up");
      return;
    }
    if (token !== imageryToken.current || !mapRef.current) return;
    if (map.getLayer("imagery")) map.removeLayer("imagery");
    if (map.getSource("imagery")) map.removeSource("imagery");
    if (source) {
      map.addSource("imagery", source);
      // Just above the background, under the street map, labels and drawing.
      map.addLayer({ id: "imagery", type: "raster", source: "imagery", paint: { "raster-fade-duration": 120 } }, map.getStyle().layers[1]?.id);
    }
    for (const layer of streetLayers.current) map.setLayoutProperty(layer, "visibility", id === "street" ? "visible" : "none");
    trouble.current = { errors: 0, loaded: 0, since: Date.now() };
  }

  function applyOverlays(list: OverlayId[]) {
    const map = mapRef.current;
    if (!map?.getLayer("measure-labels")) return;
    for (const id of Object.keys(OVERLAYS) as OverlayId[]) {
      const layer = `overlay-${id}`;
      if (list.includes(id) && !map.getLayer(layer)) {
        if (!map.getSource(layer)) map.addSource(layer, overlaySource(id));
        // Over the imagery, under a plan sheet, the street names and the drawing.
        const below = map.getLayer("plan") ? "plan" : drawingBelow(map);
        map.addLayer({ id: layer, type: "raster", source: layer, paint: { "raster-opacity": OVERLAYS[id].opacity, "raster-fade-duration": 120 } }, below);
      } else if (!list.includes(id) && map.getLayer(layer)) {
        map.removeLayer(layer);
        map.removeSource(layer);
      }
    }
  }

  /** The first layer above the imagery that stays on top: street names, else the drawing. */
  function drawingBelow(map: MapLibreMap) {
    return nameLayers.current.find((l) => map.getLayer(l)) ?? ["measure-fill", "td-polygon"].find((l) => map.getLayer(l)) ?? "measure-labels";
  }

  function applyPlan() {
    const map = mapRef.current;
    if (!map?.getLayer("measure-labels")) return;
    const plan = planRef.current;
    const source = map.getSource("plan") as ImageSource | undefined;
    if (!plan) {
      if (map.getLayer("plan")) map.removeLayer("plan");
      if (source) map.removeSource("plan");
      planUrl.current = null;
      return;
    }
    if (!source) {
      map.addSource("plan", { type: "image", url: plan.url, coordinates: plan.corners });
      map.addLayer({ id: "plan", type: "raster", source: "plan", paint: { "raster-opacity": plan.opacity, "raster-fade-duration": 0 } }, drawingBelow(map));
    } else if (planUrl.current !== plan.url) {
      source.updateImage({ url: plan.url, coordinates: plan.corners });
    } else {
      source.setCoordinates(plan.corners);
    }
    planUrl.current = plan.url;
    map.setPaintProperty("plan", "raster-opacity", plan.opacity);
  }

  function applyStreetNames(show: boolean) {
    const map = mapRef.current;
    if (!map) return;
    for (const layer of nameLayers.current) if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", show || live.current.imagery === "street" ? "visible" : "none");
  }

  useEffect(() => {
    // Before the map is ready, its load handler puts the imagery on.
    if (mapRef.current?.getLayer("measure-labels")) void applyImagery(props.imagery).then(() => applyStreetNames(live.current.showStreetNames));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.imagery, props.imageryRevision, props.keys.esri_key, props.keys.google_key]);
  useEffect(() => applyStreetNames(props.showStreetNames), [props.showStreetNames]);
  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("measure-housenumbers")) map.setLayoutProperty("measure-housenumbers", "visibility", props.showHouseNumbers ? "visible" : "none");
  }, [props.showHouseNumbers]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => applyOverlays(props.overlays), [props.overlays.join()]);
  useEffect(paintLabels, [props.labels, props.values, props.notes]);
  // A shape given an item (or a new one) is redrawn in its color, and its fill follows.
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    let changed = false;
    for (const s of shapesRef.current) {
      if (s.kind === "Cutout" || !draw.hasFeature(s.id)) continue;
      const color = colorOf(s.id);
      // Terra Draw only restyles a shape when it changes (styleColor notes what it drew), so this nudges it.
      if (drawnColors.current.get(s.id) === color && s.color === color) continue;
      draw.updateFeatureProperties(s.id, { color });
      changed = true;
    }
    if (changed) report();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.colors]);

  useImperativeHandle(ref, () => ({
    setTool(tool) {
      toolRef.current = tool;
      drawRef.current?.setMode(tool);
    },
    undo() {
      const draw = drawRef.current;
      if (draw?.canUndo()) draw.undo();
    },
    redo() {
      const draw = drawRef.current;
      if (draw?.canRedo()) draw.redo();
    },
    canUndo: () => Boolean(drawRef.current?.canUndo()),
    cancel() {
      const draw = drawRef.current;
      if (!draw) return;
      // Switching modes drops the unfinished shape.
      draw.setMode("static");
      draw.setMode(toolRef.current);
    },
    remove(id) {
      const draw = drawRef.current;
      if (!draw?.hasFeature(id)) return;
      if (draw.getMode() === "select") draw.deselectFeature(id);
      draw.removeFeatures([id]);
      live.current.onSelect(null);
    },
    convert(id, kind) {
      const draw = drawRef.current;
      const feature = draw?.hasFeature(id) ? draw.getSnapshotFeature(id) : undefined;
      if (!draw || !feature || feature.geometry.type !== "Polygon") return null;
      const mode = kind === "Cutout" ? "cutout" : "polygon";
      if (feature.properties.mode === mode) return id;
      // Terra Draw keeps which mode drew a shape to itself, so it's drawn again in the other one.
      if (draw.getMode() === "select") draw.deselectFeature(id);
      const next = String(draw.getFeatureId());
      draw.removeFeatures([id]);
      const [result] = draw.addFeatures([{ type: "Feature", id: next, geometry: feature.geometry, properties: { mode } } as GeoJSONStoreFeatures]);
      if (result?.valid === false) {
        draw.addFeatures([feature]);
        return null;
      }
      live.current.onSelect(null);
      report();
      return next;
    },
    add(polygons, kind) {
      const draw = drawRef.current;
      if (!draw) return [];
      const mode = kind === "Cutout" ? "cutout" : "polygon";
      // Terra Draw refuses points finer than the 9 decimals it keeps (map tiles give about 15).
      const round = (n: number) => Math.round(n * 1e9) / 1e9;
      const rows = polygons.map((p) => ({ type: "Feature", id: String(draw.getFeatureId()), geometry: { type: "Polygon", coordinates: p.map((ring) => ring.map(([x, y]) => [round(x), round(y)])) }, properties: { mode } }) as GeoJSONStoreFeatures);
      const results = draw.addFeatures(rows);
      report();
      return rows.filter((_, i) => results[i]?.valid !== false).map((r) => String(r.id));
    },
    addPoints(points) {
      const draw = drawRef.current;
      if (!draw) return [];
      const round = (n: number) => Math.round(n * 1e9) / 1e9;
      const rows = points.map(([x, y]) => ({ type: "Feature", id: String(draw.getFeatureId()), geometry: { type: "Point", coordinates: [round(x), round(y)] }, properties: { mode: "point" } }) as GeoJSONStoreFeatures);
      const results = draw.addFeatures(rows);
      report();
      return rows.filter((_, i) => results[i]?.valid !== false).map((r) => String(r.id));
    },
    buildings() {
      const map = mapRef.current;
      if (!map?.getSource("street-openmaptiles")) return null;
      const features = map.querySourceFeatures("street-openmaptiles", { sourceLayer: "building" });
      if (!features.length) return null;
      // A building crossing a tile edge comes back in pieces (and twice near the edge): join them.
      const byId = new Map<string, Position[][][]>();
      features.forEach((f, i) => {
        const g = f.geometry;
        const parts = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
        const key = f.id === undefined ? `#${i}` : String(f.id);
        byId.set(key, [...(byId.get(key) ?? []), ...(parts as Position[][][])]);
      });
      return [...byId.values()].flatMap((parts) => (parts.length > 1 ? mergePolygons(parts) : parts));
    },
    clear() {
      drawRef.current?.clear();
      colors.current.clear();
      live.current.onSelect(null);
      report();
    },
    select(id) {
      const draw = drawRef.current;
      if (!draw?.hasFeature(id)) return;
      toolRef.current = "select";
      draw.selectFeature(id);
      const b = boundsOf(shapesRef.current.filter((s) => s.id === id));
      const map = mapRef.current;
      // Bring it into view if it's off the edge.
      if (b && map && !(map.getBounds().contains(b[0]) && map.getBounds().contains(b[1]))) map.fitBounds(b, { padding: 80, maxZoom: Math.max(map.getZoom(), 18), duration: 400 });
    },
    fitShapes() {
      const b = boundsOf(shapesRef.current);
      if (b) mapRef.current?.fitBounds(b, { padding: 70, maxZoom: 20, duration: 500 });
    },
    jumpTo(lng, lat, zoom = 19) {
      mapRef.current?.jumpTo({ center: [lng, lat], zoom });
    },
    view() {
      const map = mapRef.current;
      const c = map?.getCenter();
      return { center: [c?.lng ?? props.start.lng, c?.lat ?? props.start.lat], zoom: map?.getZoom() ?? props.start.zoom };
    },
    load(features) {
      const draw = drawRef.current;
      if (!draw) return [];
      const ids: string[] = [];
      const rows = features.flatMap((f) => {
        if (!f.geometry || !["Polygon", "LineString", "Point"].includes(f.geometry.type)) return [];
        const id = String(draw.getFeatureId());
        ids.push(id);
        const mode = f.geometry.type === "Polygon" ? (f.properties?.cutout === true ? "cutout" : "polygon") : f.geometry.type === "LineString" ? "linestring" : "point";
        return [{ type: "Feature", id, geometry: f.geometry, properties: { mode } } as GeoJSONStoreFeatures];
      });
      const results = draw.addFeatures(rows);
      report();
      return ids.filter((_, i) => results[i]?.valid !== false);
    },
    async capture(options = {}) {
      const map = mapRef.current;
      const draw = drawRef.current;
      const b = boundsOf(shapesRef.current);
      if (!map || !draw || !b) return null;
      const before = { center: map.getCenter(), zoom: map.getZoom() };
      const mode = draw.getMode();
      const swap = options.imagery && options.imagery !== live.current.imagery ? options.imagery : null;
      // No handles or half-drawn shapes in the picture.
      draw.setMode("static");
      if (swap) await applyImagery(swap);
      map.fitBounds(b, { padding: 60, maxZoom: 20, animate: false });
      await new Promise<void>((resolve) => {
        const done = setTimeout(resolve, 8000); // a slow tile shouldn't hold up saving
        map.once("idle", () => {
          clearTimeout(done);
          resolve();
        });
        map.triggerRepaint();
      });
      const blob = await new Promise<Blob | null>((resolve) => {
        try {
          const canvas = map.getCanvas();
          // With the graphic scale, north arrow, title block and legend when asked (takeoffSheet.ts).
          const ratio = canvas.width / Math.max(1, canvas.clientWidth);
          const picture = options.sheet ? drawSheet(canvas, feetPerPixel(map.getZoom(), map.getCenter().lat, ratio), options.sheet) : canvas;
          picture.toBlob(resolve, "image/jpeg", 0.86);
        } catch {
          resolve(null);
        }
      });
      map.jumpTo(before);
      if (swap) await applyImagery(live.current.imagery);
      draw.setMode(pickRef.current ? "static" : mode === "static" ? toolRef.current : mode);
      return blob;
    },
    async viewImage(size, options = {}) {
      const map = mapRef.current;
      const draw = drawRef.current;
      if (!map || !draw) return null;
      const mode = draw.getMode();
      const swap = options.imagery && options.imagery !== live.current.imagery ? options.imagery : null;
      // Only the imagery: no shapes, labels, street names, overlays or plan sheet.
      draw.setMode("static");
      const hidden = map.getStyle().layers.filter((l) => l.id !== "imagery" && l.id !== "background" && map.getLayoutProperty(l.id, "visibility") !== "none").map((l) => l.id);
      for (const id of hidden) map.setLayoutProperty(id, "visibility", "none");
      try {
        if (swap) await applyImagery(swap);
        await new Promise<void>((resolve) => {
          const done = setTimeout(resolve, 10_000);
          map.once("idle", () => {
            clearTimeout(done);
            resolve();
          });
          map.triggerRepaint();
        });
        const canvas = map.getCanvas();
        const side = Math.min(canvas.width, canvas.height);
        let [sx, sy, sw, sh] = options.whole ? [0, 0, canvas.width, canvas.height] : [(canvas.width - side) / 2, (canvas.height - side) / 2, side, side];
        if (options.bounds) {
          const [w, s, e, n] = options.bounds;
          const k = canvas.width / Math.max(1, canvas.clientWidth);
          const [a, b] = [map.project([w, n]), map.project([e, s])];
          const [x0, y0] = [Math.max(0, Math.floor(a.x * k)), Math.max(0, Math.floor(a.y * k))];
          const [x1, y1] = [Math.min(canvas.width, Math.ceil(b.x * k)), Math.min(canvas.height, Math.ceil(b.y * k))];
          if (x1 - x0 >= 8 && y1 - y0 >= 8) [sx, sy, sw, sh] = [x0, y0, x1 - x0, y1 - y0];
        }
        const scale = size / Math.max(sw, sh);
        const picture = document.createElement("canvas");
        picture.width = Math.round(sw * scale);
        picture.height = Math.round(sh * scale);
        const ctx = picture.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, picture.width, picture.height);
        // Where the picture's corners are, so each pixel's place is known after the map moves on.
        const ratio = canvas.width / Math.max(1, canvas.clientWidth);
        const corner = (x: number, y: number) => {
          const p = map.unproject([x / ratio, y / ratio]);
          return toMercator([p.lng, p.lat]);
        };
        const [mx0, my0] = corner(sx, sy);
        const [mx1, my1] = corner(sx + sw, sy + sh);
        const [w, h] = [picture.width, picture.height];
        const at = (x: number, y: number): [number, number] => fromMercator([mx0 + ((mx1 - mx0) * x) / w, my0 + ((my1 - my0) * y) / h]);
        const px = (spot: LngLat): [number, number] => {
          const [mx, my] = toMercator(spot);
          return [((mx - mx0) / (mx1 - mx0)) * w, ((my - my0) / (my1 - my0)) * h];
        };
        return { canvas: picture, at, px };
      } finally {
        for (const id of hidden) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
        if (swap) await applyImagery(live.current.imagery);
        // Still not drawing while taps are being picked (tap to outline takes pictures between taps).
        draw.setMode(pickRef.current ? "static" : mode === "static" ? toolRef.current : mode);
      }
    },
    setPlan(plan) {
      planRef.current = plan;
      applyPlan();
    },
    pickSpots(onPick, owner) {
      // Lining up a plan can take the taps over from tap to outline: then stopping that leaves them.
      if (!onPick && owner && pickRef.current !== owner) return;
      pickRef.current = onPick;
      const draw = drawRef.current;
      const map = mapRef.current;
      if (!draw || !map) return;
      // Stops any shape half drawn, and taps stop adding corners.
      draw.setMode(onPick ? "static" : toolRef.current);
      map.getCanvas().style.cursor = onPick ? "crosshair" : "";
    },
    pickBox(onBox) {
      boxRef.current?.();
      boxRef.current = null;
      const map = mapRef.current;
      const container = el.current;
      if (!onBox || !map || !container) return;
      const target = map.getCanvasContainer();
      const rect = document.createElement("div");
      rect.className = "measure-box";
      let start: { x: number; y: number; id: number } | null = null;
      const local = (e: PointerEvent) => {
        const r = container.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };
      const down = (e: PointerEvent) => {
        if (e.button !== 0 || !e.isPrimary) return;
        start = { ...local(e), id: e.pointerId };
        target.setPointerCapture(e.pointerId);
      };
      const move = (e: PointerEvent) => {
        if (!start || e.pointerId !== start.id) return;
        const p = local(e);
        Object.assign(rect.style, { left: `${Math.min(p.x, start.x)}px`, top: `${Math.min(p.y, start.y)}px`, width: `${Math.abs(p.x - start.x)}px`, height: `${Math.abs(p.y - start.y)}px` });
        if (!rect.isConnected) container.append(rect);
      };
      const up = (e: PointerEvent) => {
        if (!start || e.pointerId !== start.id) return;
        const [a, b] = [start, local(e)];
        start = null;
        rect.remove();
        // Barely moved: a tap, not a box.
        if (Math.abs(b.x - a.x) < 12 || Math.abs(b.y - a.y) < 12) return;
        const [p, q] = [map.unproject([a.x, a.y]), map.unproject([b.x, b.y])];
        onBox([p.lng, p.lat], [q.lng, q.lat]);
      };
      const cancel = () => {
        start = null;
        rect.remove();
      };
      // One finger or the mouse draws; two fingers still zoom.
      map.dragPan.disable();
      const touchAction = target.style.touchAction;
      target.style.touchAction = "none";
      target.addEventListener("pointerdown", down);
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", cancel);
      boxRef.current = () => {
        target.removeEventListener("pointerdown", down);
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", cancel);
        target.style.touchAction = touchAction;
        rect.remove();
        map.dragPan.enable();
      };
    },
    has(id) {
      return Boolean(drawRef.current?.hasFeature(id));
    },
    setPins(list) {
      const map = mapRef.current;
      for (const pin of pins.current) pin.remove();
      pins.current = [];
      if (!map) return;
      for (const p of list) {
        const el = document.createElement("div");
        el.textContent = p.label;
        el.setAttribute("aria-label", `${p.tone === "plan" ? "Spot on the plan" : p.tone === "out" ? "Left out" : "Spot on the map"} ${p.label}`);
        Object.assign(el.style, {
          width: "26px", height: "26px", display: "grid", placeItems: "center", borderRadius: "50%", border: "2px solid #fff",
          background: p.tone === "plan" ? "#2563eb" : p.tone === "out" ? "#dc2626" : "#16a34a", color: "#fff", font: "700 13px/1 system-ui, sans-serif",
          boxShadow: "0 1px 4px rgba(0, 0, 0, 0.45)", pointerEvents: "none",
        });
        pins.current.push(new maplibregl.Marker({ element: el }).setLngLat(p.at).addTo(map));
      }
    },
    viewBox() {
      const map = mapRef.current;
      if (!map) return null;
      const b = map.getBounds();
      const c = map.getCenter();
      return { center: [c.lng, c.lat], west: b.getWest(), east: b.getEast() };
    },
  }));

  return <div ref={el} className="measure-map" role="application" aria-label="Map for drawing measurements" />;
});
