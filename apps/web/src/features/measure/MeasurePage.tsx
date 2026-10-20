/**
 * Measure on aerial imagery: draw areas, lines and counts and see their sizes as you go (the server
 * recomputes them on save), cut the house or a bed out of an area, keep a picture of the drawing,
 * and put it on a quote or invoice for the client. For roofs, each section can have its own pitch
 * (picked, read from USGS lidar, or measured with a phone or a photo: RoofPitch.tsx) and lines can
 * be marked as eaves, rakes, ridges, hips and valleys. The map opens on Auto: the state's own
 * imagery where it has some, else US aerial (NAIP), else USGS, else (outside the US) Esri with a key
 * from Settings > Maps, or the street map. Anyone can pick a source themselves instead, from the
 * Imagery button, and make it what Measure opens on (an admin can set that for the whole team in
 * Settings > Maps).
 */
import { inBounds, stateImagery, stateImageryAt, type StateImagery } from "@crewtavo/core/imagery";
import { drawingSquares, edgeLengths, isPitch, isRoofEdge, normalizePitch, pitchFactor, pitchProblem, ROOF_EDGES, summarizeFeatureCollection, type Feature, type Position, type RoofEdge } from "@crewtavo/core/geo";
import { itemFits, PAVING_ITEMS, pavingItem, stallsAlong, type PavingItem } from "@crewtavo/core/paving";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { addressLine, formatNumber } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { AddressSearch, type ClientSuggestion, type PlaceSuggestion } from "./AddressSearch";
import { boxAround, buildingAt, buildingsIn, BuildingsError, buildingsOn, OSM_BUILDINGS_CREDIT } from "./buildings";
import { ShareDrawing, type DrawingRow } from "./drawings";
import { AUTO_NAME, choiceName, ELEVATION_CREDIT, imageryCredit, imageryInfo, imageryUsable, isImageryId, mapKeys, openingImagery, OVERLAYS, probeImagery, resolveAuto, setMyDefault, SLOPE_CLASSES, stateId, type ImageryChoice, type ImageryId, type OverlayId } from "./imagery";
import { ImageryPicker } from "./ImageryPicker";
import { helpSeen, markHelpSeen, MeasureHelp } from "./MeasureHelp";
import { defaultNames, formatShapeValue, isDefaultName, MeasureMap, type MeasureMapHandle, type Shape, type Tool } from "./MeasureMap";
import { useTooLarge } from "../plans/UploadLimit";
import { isSavedPlan, LineUpBanner, PlanCard, usePlanOnMap } from "./PlanOnMap";
import { FindPaving } from "./FindPaving";
import { formatItemTotal, ItemSelect, PavingItemsCard } from "./PavingItems";
import { MeasurePitch, PitchPicker, pitchLabel, riseOf, STEEP_FROM } from "./RoofPitch";
import type { SheetInfo } from "./takeoffSheet";
import { TapBanner, useTapOutline } from "./TapOutline";

const TOOLS: Array<{ tool: Tool; label: string; icon: IconName; key: string; what: string }> = [
  { tool: "polygon", label: "Area", icon: "area", key: "A", what: "Lawns, roofs, lots, driveways" },
  { tool: "cutout", label: "Cut out", icon: "scissors", key: "X", what: "Leave out the house, a pool or a bed" },
  { tool: "linestring", label: "Line", icon: "line", key: "L", what: "Edges, fences, curbs" },
  { tool: "point", label: "Count", icon: "pin", key: "C", what: "Trees, drains, posts" },
  { tool: "select", label: "Edit", icon: "pointer", key: "E", what: "Move corners, delete shapes" },
];

type Banner =
  | { kind: "no-aerial" }
  | { kind: "trouble"; imagery: ImageryId; message: string }
  | { kind: "empty"; imagery: ImageryId }
  | { kind: "sharper"; state: StateImagery }
  | { kind: "left-state"; state: StateImagery };

interface SaveResult { id: string; total_area_sqft: number; total_area_sqyd: number; total_length_ft: number; roofing_squares: number | null }
interface SavedView { center?: [number, number]; zoom?: number; imagery?: string; mode?: "auto" | "manual"; overlays?: string[] }
interface Found { found: boolean; lat?: number; lng?: number; formatted?: string | null; country?: string | null }

/** A pitch the way it's saved ("6/12" for 6-12), or as typed while it doesn't read yet. */
const tidyPitch = (pitch: string) => (pitch.trim() && isPitch(pitch) ? normalizePitch(pitch) : pitch.trim());
const EDGE_NAMES: Record<RoofEdge, string> = { eave: "Eave", rake: "Rake", ridge: "Ridge", hip: "Hip", valley: "Valley" };
const EDGE_PLURALS: Record<RoofEdge, string> = { eave: "Eaves", rake: "Rakes", ridge: "Ridges", hip: "Hips", valley: "Valleys" };
/** Edges that run up the roof, so their length depends on the pitch. */
const slopedEdge = (edge: RoofEdge | undefined) => edge === "rake" || edge === "hip" || edge === "valley";
const polygonsOf = (shapes: Shape[], kind: Shape["kind"]) =>
  shapes.filter((s) => s.kind === kind && s.geometry?.type === "Polygon").map((s) => s.geometry!.coordinates as Position[][]);
// Slope and contours stay on (or off) between visits, per browser.
const OVERLAYS_KEY = "crewtavo.measureOverlays";
function savedOverlays(): OverlayId[] {
  try {
    const list = JSON.parse(localStorage.getItem(OVERLAYS_KEY) ?? "[]") as string[];
    return list.filter((o): o is OverlayId => o in OVERLAYS);
  } catch {
    return [];
  }
}
// House numbers stay on (or off) between visits too.
const HOUSE_NUMBERS_KEY = "crewtavo.measureHouseNumbers";
function savedHouseNumbers(): boolean {
  try {
    return localStorage.getItem(HOUSE_NUMBERS_KEY) !== "off";
  } catch {
    return true;
  }
}
const touchScreen = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

function hintFor(tool: Tool, drawing: Shape | null, selected: boolean, shapes: number, touch: boolean) {
  const tap = touch ? "Tap" : "Click";
  switch (tool) {
    case "polygon":
      return drawing
        ? `${formatShapeValue("Area", drawing.value) || "0 sq ft"} so far. ${tap} the first point${touch ? "" : " or press Enter"} to finish.`
        : `${tap} each corner of the area you're measuring.`;
    case "cutout":
      return drawing
        ? `${formatShapeValue("Area", drawing.value) || "0 sq ft"} to leave out so far. ${tap} the first point${touch ? "" : " or press Enter"} to finish.`
        : `${tap} each corner of what to leave out, like the house. It comes off the areas under it.`;
    case "linestring":
      return drawing
        ? `${formatShapeValue("Length", drawing.value)} so far. Double-${tap.toLowerCase()}${touch ? "" : " or press Enter"} to finish.`
        : `${tap} along the edge, one corner at a time.`;
    case "point":
      return `${tap} each item to count it.`;
    default:
      return selected ? "Drag a corner to move it. Drag a small middle dot to add a corner." : shapes ? `${tap} a shape to change or delete it.` : "Nothing to edit yet. Pick Area, Line or Count to start.";
  }
}

export function MeasurePage() {
  const session = useSession();
  const { company } = session;
  const isAdmin = hasRole(session, "admin");
  const canAddPlans = hasRole(session, "admin", "office", "estimator", "crew_lead");
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const linkIds = { property: params.get("property"), quote: params.get("quote"), request: params.get("request"), invoice: params.get("invoice"), measurement: params.get("measurement") };
  const keys = useMemo(() => mapKeys(company.settings ?? {}, session.config.mapsBrowserKey), [company.settings, session.config.mapsBrowserKey]);
  // What Measure opens on: this person's default, the team's, or Auto.
  const [defaultRevision, setDefaultRevision] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const opening = useMemo(() => openingImagery(company.settings ?? {}, keys), [company.settings, keys, defaultRevision]);
  const touch = useMemo(touchScreen, []);

  const mapRef = useRef<MeasureMapHandle>(null);
  const [tool, setTool] = useState<Tool>("polygon");
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [drawing, setDrawing] = useState<Shape | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  // A roof section's own pitch (blank follows the drawing's), roof edges, and outlines from OpenStreetMap.
  const [pitches, setPitches] = useState<Record<string, string>>({});
  const [edges, setEdges] = useState<Record<string, RoofEdge>>({});
  // Paving takeoff items (PavingItems.tsx): what each shape is, and what new shapes become.
  const [items, setItems] = useState<Record<string, string>>({});
  const [activeItem, setActiveItem] = useState<PavingItem | null>(null);
  const knownIds = useRef(new Set<string>());
  const [fromOsm, setFromOsm] = useState<string[]>([]);
  const [pitchFor, setPitchFor] = useState<string | null>(null);
  const [finding, setFinding] = useState<"cut" | "outline" | null>(null);
  const [roofOpen, setRoofOpen] = useState(false);
  const [depth, setDepth] = useState("");
  const [pitch, setPitch] = useState("");
  const [waste, setWaste] = useState("10");
  const [title, setTitle] = useState("Measurement");
  const [mapState, setMapState] = useState<"loading" | "ready" | "error">("loading");
  const [mapError, setMapError] = useState<string | null>(null);
  // What someone picked (Auto unless they chose a source), and what's on the map now.
  const [choice, setChoice] = useState<ImageryChoice | null>(null);
  const [imagery, setImagery] = useState<ImageryId | null>(null);
  const [overlays, setOverlays] = useState<OverlayId[]>(savedOverlays);
  const [resolveTick, setResolveTick] = useState(0);
  // Sources that stopped answering, and until when Auto leaves them alone.
  const down = useRef(new Map<ImageryId, number>());
  const [streetNames, setStreetNames] = useState(true);
  const [houseNumbers, setHouseNumbers] = useState(savedHouseNumbers);
  const showHouseNumbers = (on: boolean) => {
    setHouseNumbers(on);
    try {
      localStorage.setItem(HOUSE_NUMBERS_KEY, on ? "on" : "off");
    } catch {
      /* remembered for this visit only */
    }
  };
  const [streetMap, setStreetMap] = useState(true);
  const [center, setCenter] = useState<{ lng: number; lat: number; zoom: number } | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [abroad, setAbroad] = useState<{ place: string } | null>(null);
  const [help, setHelp] = useState(false);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [capturing, setCapturing] = useState(false);
  const [imageryRevision, setImageryRevision] = useState(0);
  // The saved drawing (after the first save, or when reopening one).
  const [saved, setSaved] = useState<(Pick<DrawingRow, "id" | "quote_id" | "invoice_id" | "show_on_quote" | "show_on_invoice"> & { snapshot_path: string | null }) | null>(null);
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const baseline = useRef<number | null>(null);
  const autoImagery = useRef(false);

  // Where to start and what it's for: the drawing being reopened, the property (looked up and
  // geocoded if needed), the quote, request or invoice it came from, else the shop.
  const context = useQuery({
    queryKey: ["measure-context", linkIds.property, linkIds.quote, linkIds.request, linkIds.invoice, linkIds.measurement],
    queryFn: async () => {
      const db = supabase();
      const m = linkIds.measurement
        ? unwrap(await db.from("measurements").select("id, title, geojson, roof_pitch, waste_pct, property_id, request_id, quote_id, invoice_id, show_on_quote, show_on_invoice, snapshot_path, view").eq("id", linkIds.measurement).maybeSingle())
        : null;
      if (linkIds.measurement && !m) throw new Error("That drawing wasn't found. It may have been deleted.");
      const ids = {
        property: linkIds.property ?? m?.property_id ?? null,
        quote: linkIds.quote ?? m?.quote_id ?? null,
        request: linkIds.request ?? m?.request_id ?? null,
        invoice: linkIds.invoice ?? m?.invoice_id ?? null,
      };
      const [property, quote, request, invoice, companyRow] = await Promise.all([
        ids.property ? db.from("properties").select("id, line1, city, region, postal_code, lat, lng, client:clients(id, display_name)").eq("id", ids.property).maybeSingle() : null,
        ids.quote ? db.from("quotes").select("id, number, title, client_id").eq("id", ids.quote).maybeSingle() : null,
        ids.request ? db.from("requests").select("id, number, title, client_id").eq("id", ids.request).maybeSingle() : null,
        ids.invoice ? db.from("invoices").select("id, number, subject, client_id").eq("id", ids.invoice).maybeSingle() : null,
        db.from("companies").select("settings").eq("id", company.id).single(),
      ]);
      let p = property ? unwrap(property) : null;
      if (p && (p.lat == null || p.lng == null)) {
        const hit = await api.post<Found>(`/properties/${p.id}/geocode`).catch(() => null);
        if (hit?.found) p = { ...p, lat: hit.lat!, lng: hit.lng! };
      }
      const q = quote ? unwrap(quote) : null;
      const r = request ? unwrap(request) : null;
      const inv = invoice ? unwrap(invoice) : null;
      const depot = ((unwrap(companyRow).settings ?? {}) as { depot?: { lat: number; lng: number } }).depot ?? null;
      const clientId = p?.client?.id ?? q?.client_id ?? inv?.client_id ?? r?.client_id ?? null;
      return { measurement: m, property: p, quote: q, request: r, invoice: inv, depot, ids, clientId };
    },
  });
  const ctx = context.data;

  const start = useMemo(() => {
    if (!ctx) return null;
    const lat = Number(params.get("lat"));
    const lng = Number(params.get("lng"));
    if (params.get("lat") && Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, zoom: 19 };
    const view = (ctx.measurement?.view ?? null) as SavedView | null;
    if (view?.center) return { lng: view.center[0], lat: view.center[1], zoom: view.zoom ?? 19 };
    const p = ctx.property;
    if (p?.lat != null && p?.lng != null) return { lat: p.lat, lng: p.lng, zoom: 19 };
    if (ctx.depot) return { lat: ctx.depot.lat, lng: ctx.depot.lng, zoom: 17 };
    return { lng: -98.58, lat: 39.83, zoom: 4 }; // the whole US: search for an address to start
    // Start once per place; later moves are the map's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  // First imagery: the source a reopened drawing was made on, if someone picked it; else this
  // person's default, the team's, or Auto. Auto starts on a guess so the map can load, and settles
  // once it has looked.
  useEffect(() => {
    if (!start || choice) return;
    const view = (ctx?.measurement?.view ?? null) as SavedView | null;
    const savedOn = isImageryId(view?.imagery) && imageryUsable(view.imagery, keys) ? view.imagery : null;
    if (view?.mode === "manual" && savedOn) {
      setChoice(savedOn);
      setImagery(savedOn);
    } else if (opening !== "auto") {
      setChoice(opening);
      setImagery(opening);
    } else {
      setChoice("auto");
      setImagery(savedOn ?? (start.zoom < 11 ? "usgs" : "naip"));
    }
  }, [start, choice, ctx, keys, opening]);

  useEffect(() => {
    // A new drawing is named after the property until someone names it (a paving takeoff, after its project).
    const street = params.has("paving") && ctx?.quote?.title ? ctx.quote.title : ctx?.property?.line1;
    if (!ctx?.measurement && street) setTitle((t) => (t === "Measurement" ? street : t));
    if (ctx?.measurement) {
      setTitle(ctx.measurement.title);
      setPitch(ctx.measurement.roof_pitch ?? "");
      setWaste(String(Number(ctx.measurement.waste_pct ?? 10)));
      setSaved({ id: ctx.measurement.id, quote_id: ctx.measurement.quote_id, invoice_id: ctx.measurement.invoice_id, show_on_quote: ctx.measurement.show_on_quote, show_on_invoice: ctx.measurement.show_on_invoice, snapshot_path: ctx.measurement.snapshot_path });
    }
  }, [ctx?.measurement]);

  useEffect(() => {
    if (mapState === "ready" && !helpSeen()) setHelp(true);
  }, [mapState]);

  // ----- What's drawn ---------------------------------------------------------------------------
  const names = useMemo(() => defaultNames(shapes.map((s) => ({ ...s, edge: edges[s.id], itemName: itemFits(items[s.id], s.kind) ? pavingItem(items[s.id])?.name : null }))), [shapes, edges, items]);
  const nameOf = (id: string) => labels[id]?.trim() || names[id] || "this shape";
  // Unnamed shapes are saved as "Area 1", "Line 1", so the client sees the same names as the map.
  // Roof sections and the edges that run up the roof carry the pitch they're measured at.
  const features: Feature[] = useMemo(
    () =>
      shapes.map((s) => {
        const edge = s.kind === "Length" ? edges[s.id] : undefined;
        const own = s.kind === "Area" || slopedEdge(edge) ? tidyPitch(pitches[s.id] ?? "") || tidyPitch(pitch) : "";
        return {
          type: "Feature",
          id: s.id,
          geometry: s.geometry,
          properties: {
            label: labels[s.id]?.trim() || names[s.id],
            depth_in: Number(depth) || undefined,
            pitch: own || undefined,
            ...(s.kind === "Cutout" ? { cutout: true } : {}),
            ...(edge ? { edge } : {}),
            ...(itemFits(items[s.id], s.kind) ? { item: items[s.id] } : {}),
            ...(fromOsm.includes(s.id) ? { source: "openstreetmap" } : {}),
          },
        };
      }),
    [shapes, labels, names, depth, pitch, pitches, edges, items, fromOsm],
  );
  // Same math the server uses on save (packages/core), so live numbers match stored ones.
  const summary = useMemo(() => summarizeFeatureCollection({ type: "FeatureCollection", features }, { pitch }), [features, pitch]);
  const sections = useMemo(() => new Map(summary.sections.map((s) => [s.feature_id, s])), [summary]);
  const depthIn = Number(depth) || 0;
  const pitchError = pitchProblem(summary, pitch);
  const squares = pitchError ? null : drawingSquares(summary, pitch, Number(waste || 0));
  const roofEdges = edgeLengths(summary);
  const cubicYards = depthIn ? (summary.total_area_sqft * (depthIn / 12)) / 27 : 0;
  const asphaltTons = depthIn ? (summary.total_area_sqyd * depthIn * 110) / 2000 : 0;
  // Roofing shows the roof tools on every row; anyone else gets them once they set a pitch or an edge.
  const roofing = company.trade_preset === "roofing_exteriors" || roofOpen || Boolean(pitch.trim()) || Object.values(pitches).some(Boolean) || Object.keys(edges).length > 0;
  const mapNames = useMemo(() => Object.fromEntries(shapes.map((s) => [s.id, labels[s.id]?.trim() || names[s.id]])), [shapes, labels, names]);
  const mapValues = useMemo(() => Object.fromEntries(summary.sections.map((s) => [s.feature_id, s.value])), [summary]);
  // Paving: the items panel shows for paving businesses, a takeoff opened from Paving, or a drawing with items.
  const paving = company.trade_preset === "paving" || params.has("paving") || Object.keys(items).length > 0;
  const mapColors = useMemo(() => Object.fromEntries(Object.entries(items).flatMap(([id, item]) => (pavingItem(item) ? [[id, pavingItem(item)!.color]] : []))), [items]);
  const mapNotes = useMemo(
    () => Object.fromEntries(summary.sections.flatMap((s) => (s.item === "stall_row" ? [[s.feature_id, `${stallsAlong(s.value)} stalls`]] : []))),
    [summary],
  );
  const signature = JSON.stringify([shapes.map((s) => [s.kind, s.geometry]), shapes.map((s) => labels[s.id] ?? ""), title, depth, pitch, waste, pitches, edges, items, fromOsm]);
  const shapesDirty = shapes.length > 0 && signature !== savedSignature;
  // A reopened drawing starts out saved.
  useEffect(() => {
    if (baseline.current !== null && shapes.length === baseline.current) {
      baseline.current = null;
      setSavedSignature(signature);
    }
  }, [signature, shapes.length]);

  const onReady = useCallback(() => {
    setMapState("ready");
    const m = context.data?.measurement;
    const saved = ((m?.geojson ?? null) as { features?: Feature[] } | null)?.features ?? [];
    if (!saved.length) return;
    const ids = mapRef.current?.load(saved) ?? [];
    const kept = saved.filter((f) => f.geometry && ["Polygon", "LineString", "Point"].includes(f.geometry.type));
    setLabels(Object.fromEntries(ids.map((id, i) => {
      const label = String(kept[i]?.properties?.label ?? "");
      return [id, isDefaultName(label) ? "" : label];
    })));
    const savedDepth = kept.find((f) => f.properties?.depth_in)?.properties?.depth_in;
    if (savedDepth) setDepth(String(savedDepth));
    // A section saved at the drawing's own pitch follows it; one at another pitch keeps its own.
    const roofPitch = tidyPitch(m?.roof_pitch ?? "");
    setPitches(Object.fromEntries(ids.flatMap((id, i) => {
      const own = kept[i]?.properties?.pitch;
      return typeof own === "string" && own && tidyPitch(own) !== roofPitch ? [[id, own]] : [];
    })));
    setEdges(Object.fromEntries(ids.flatMap((id, i) => (isRoofEdge(kept[i]?.properties?.edge) ? [[id, kept[i]!.properties!.edge as RoofEdge]] : []))));
    setItems(Object.fromEntries(ids.flatMap((id, i) => (pavingItem(kept[i]?.properties?.item) ? [[id, String(kept[i]!.properties!.item)]] : []))));
    ids.forEach((id) => knownIds.current.add(id));
    setFromOsm(ids.filter((_, i) => kept[i]?.properties?.source === "openstreetmap"));
    baseline.current = ids.length;
    setTimeout(() => mapRef.current?.fitShapes(), 50);
    if (ids.length < kept.length) toast.error("Some shapes in this drawing couldn't be shown. Check it before saving again.");
  }, [context.data]);

  // ----- Imagery: suggestions and problems ----------------------------------------------------
  const probes = useRef(new Map<string, Promise<"ok" | "empty" | "down">>());
  const probe = useCallback((id: ImageryId, lng: number, lat: number) => {
    // One look per source per ~1 km square is plenty.
    const cell = `${id}:${lng.toFixed(2)}:${lat.toFixed(2)}`;
    let result = probes.current.get(cell);
    if (!result) {
      result = probeImagery(id, keys, lng, lat);
      probes.current.set(cell, result);
      result.then((r) => r === "down" && probes.current.delete(cell)); // ask again later
    }
    return result;
  }, [keys]);
  const centerKey = center ? `${center.lng.toFixed(3)},${center.lat.toFixed(3)},${Math.floor(center.zoom)}` : "";

  // Auto: look again after each move, and when a source stops answering.
  useEffect(() => {
    if (choice !== "auto" || !center || mapState !== "ready") return;
    let stale = false;
    const timer = setTimeout(async () => {
      const { lng, lat, zoom } = center;
      const now = Date.now();
      const { id, passed } = await resolveAuto(lng, lat, zoom, keys, (source) => probe(source, lng, lat), (source) => (down.current.get(source) ?? 0) > now);
      if (stale) return;
      setImagery(id);
      // NAIP coming back empty means this spot is outside the US: the US-only servers after it
      // aren't down, they just have nothing here.
      const abroad = passed.some((p) => p.id === "naip" && p.why === "empty");
      const failed = abroad ? undefined : passed.find((p) => p.why === "down");
      // Nothing aerial here (outside the US, with no Esri key): say why it's the street map.
      setBanner(id === "street" && zoom >= 11 && !failed && !dismissed.includes("no-aerial") ? { kind: "no-aerial" } : null);
    }, 350);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // centerKey stands in for center.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, centerKey, mapState, resolveTick, keys.esri_key, dismissed, probe]);

  // A source someone picked: offer something better, or say when it doesn't cover this spot.
  useEffect(() => {
    if (choice === "auto" || mapState !== "ready" || !imagery || !center || center.zoom < 11) return;
    let stale = false;
    const timer = setTimeout(async () => {
      const { lng, lat } = center;
      if (imagery === "naip") {
        const naip = await probe("naip", lng, lat);
        if (stale) return;
        if (naip !== "ok") return setBanner(naip === "empty" ? { kind: "empty", imagery } : { kind: "trouble", imagery, message: "isn't loading right now" });
        for (const s of stateImageryAt(lng, lat).filter((s) => !dismissed.includes(s.state))) {
          if ((await probe(stateId(s), lng, lat)) === "ok") return !stale && setBanner({ kind: "sharper", state: s });
          if (stale) return;
        }
        setBanner(null);
      } else if (imagery.startsWith("state:")) {
        const s = stateImagery(imagery.slice(6))!;
        const here = inBounds(s.bounds, lng, lat) ? await probe(imagery, lng, lat) : "empty";
        if (stale) return;
        setBanner(here === "ok" ? null : here === "down" ? { kind: "trouble", imagery, message: "isn't loading right now" } : dismissed.includes(`left:${s.state}`) ? null : { kind: "left-state", state: s });
      } else {
        setBanner((b) => (b?.kind === "trouble" && b.imagery === imagery ? b : null));
      }
    }, 600);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // centerKey stands in for center.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, mapState, centerKey, imagery, dismissed, probe]);

  /** Pick a source, or Auto. `fromAbroad`: picked because the address was outside the US. */
  const chooseImagery = (next: ImageryChoice, fromAbroad = false) => {
    autoImagery.current = fromAbroad;
    setBanner(null);
    setChoice(next);
    if (next === "auto") setResolveTick((n) => n + 1);
    else setImagery(next);
  };
  const makeDefault = (next: ImageryChoice) => {
    setMyDefault(next);
    setDefaultRevision((n) => n + 1);
    toast.success(`Measure opens on ${choiceName(next)} from now on`);
  };
  const toggleOverlay = (id: OverlayId, on: boolean) => {
    const next = on ? [...overlays.filter((o) => o !== id), id] : overlays.filter((o) => o !== id);
    setOverlays(next);
    try {
      localStorage.setItem(OVERLAYS_KEY, JSON.stringify(next));
    } catch {
      /* remembered for this visit only */
    }
  };
  const imageryTrouble = (id: ImageryId, message: string) => {
    if (choice === "auto" && id !== "street") {
      // Auto moves on by itself, and tries this one again in ten minutes.
      down.current.set(id, Date.now() + 10 * 60_000);
      setResolveTick((n) => n + 1);
    } else setBanner({ kind: "trouble", imagery: id, message });
  };

  // ----- Find an address (US or anywhere) ---------------------------------------------------
  const find = useMutation({
    meta: { inline: true },
    mutationFn: async (address: string) => {
      const r = await api.post<Found>("/geocode", { address, world: true });
      if (!r.found) throw new Error(`Couldn't find "${address}". Try adding the city and state, or the country.`);
      return r;
    },
    onSuccess: (r) => {
      // Somewhere else now, so the drawing is no longer for a client picked earlier.
      unpick();
      goTo({ lat: r.lat!, lng: r.lng!, zoom: 19, country: r.country ?? null, place: r.formatted ?? "This address" });
    },
  });
  /** Move the map to a place found by search or picked from the suggestions. */
  const goTo = (to: { lat: number; lng: number; zoom: number; country: string | null; place: string }) => {
    mapRef.current?.jumpTo(to.lng, to.lat, to.zoom);
    if (to.country && to.country !== "US") {
      // Auto finds the best there is by itself; a US-only source someone picked gets explained.
      if (choice !== "auto" && (imagery === "naip" || imagery === "terrain" || imagery?.startsWith("state:") || imagery?.startsWith("usgs"))) setAbroad({ place: to.place });
    } else if (autoImagery.current && choice !== "auto") {
      chooseImagery("auto");
      toast.success(`Back on ${AUTO_NAME}`);
    }
  };
  // A client's property picked from the suggestions. When Measure wasn't opened for a property,
  // the drawing is for this one: it's saved with it, and offered to this client's quotes.
  const [picked, setPicked] = useState<ClientSuggestion | null>(null);
  const pickClient = async (s: ClientSuggestion) => {
    find.reset();
    let at = s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null;
    if (!at) {
      const hit = await api.post<Found>(`/properties/${s.property_id}/geocode`).catch(() => null);
      if (hit?.found) at = { lat: hit.lat!, lng: hit.lng! };
    }
    if (!ctx?.ids.property && !saved) {
      setPicked(s);
      setTitle((t) => (t === "Measurement" || t === picked?.label ? s.label : t));
    }
    if (!at) return toast.error(`Couldn't find ${s.label} on the map. Check the property's address on ${s.client ?? "the client"}'s page.`);
    goTo({ ...at, zoom: 19, country: "US", place: s.label });
  };
  /** The drawing is no longer for the client picked earlier (and loses their address as its name). */
  const unpick = () => {
    if (!picked) return;
    setTitle((t) => (t === picked.label ? "Measurement" : t));
    setPicked(null);
  };
  const pickPlace = (s: PlaceSuggestion) => {
    find.reset();
    unpick();
    goTo({ lat: s.lat, lng: s.lng, zoom: s.kind === "address" ? 19 : s.kind === "street" ? 17 : 15, country: s.country, place: [s.label, s.detail].filter(Boolean).join(", ") });
  };
  const locate = () => {
    if (!navigator.geolocation) return toast.error("This browser can't share its location. Search for the address instead.");
    navigator.geolocation.getCurrentPosition(
      (p) => mapRef.current?.jumpTo(p.coords.longitude, p.coords.latitude, 19),
      (error) =>
        toast.error(error.code === error.PERMISSION_DENIED ? "Location is turned off for this site. Allow it in your browser's settings, or search for the address." : "Couldn't tell where you are. Search for the address instead."),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  // ----- A plan sheet on the map (PlanOnMap.tsx) --------------------------------------------------
  const savedPlan = useMemo(() => {
    const plan = (ctx?.measurement?.view as { plan?: unknown } | null)?.plan;
    return isSavedPlan(plan) ? plan : null;
  }, [ctx?.measurement]);
  const tooLarge = useTooLarge();
  const plan = usePlanOnMap({
    map: mapRef,
    ready: mapState === "ready",
    companyId: company.id,
    where: { property: ctx?.ids.property ?? picked?.property_id ?? null, quote: ctx?.ids.quote ?? null },
    saved: savedPlan,
    open: params.get("plan"),
    onTooLarge: tooLarge.report,
  });
  const aligning = Boolean(plan.step);
  // The plan's place counts as a change to save, once a reopened drawing's plan is back on the map.
  const planSig = JSON.stringify(plan.savedPlan);
  const [planSavedSig, setPlanSavedSig] = useState<string | null>(null);
  useEffect(() => {
    if (planSavedSig !== null || !ctx) return;
    if (!savedPlan) setPlanSavedSig("null");
    else if (plan.savedPlan) setPlanSavedSig(planSig);
  }, [planSavedSig, ctx, savedPlan, plan.savedPlan, planSig]);
  const planDirty = planSavedSig !== null && planSig !== planSavedSig;
  const dirty = shapesDirty || (shapes.length > 0 && planDirty);

  // ----- Tools ---------------------------------------------------------------------------------
  const pickTool = (next: Tool) => {
    tap.stop();
    setTool(next);
    mapRef.current?.setTool(next);
    if (next !== "select") setSelected(null);
    // A plain tool draws plain shapes; cutting out an island keeps the item picked.
    if (next !== "cutout") setActiveItem(null);
  };
  const removeSelected = () => {
    if (!selected) return;
    mapRef.current?.remove(selected);
    setSelected(null);
  };
  /** An area becomes a cutout or back. Its name and pitch go with it to its new id. */
  const convert = (id: string, kind: "Area" | "Cutout") => {
    const next = mapRef.current?.convert(id, kind);
    if (!next || next === id) return;
    const move = <T,>(map: Record<string, T>): Record<string, T> => {
      if (!(id in map)) return map;
      const { [id]: value, ...rest } = map;
      return { ...rest, [next]: value };
    };
    setLabels(move);
    setPitches(move);
    // An area made a cutout stops being a paving item; a cutout made an area again starts plain.
    setItems(({ [id]: _, ...rest }) => rest);
    knownIds.current.add(next);
    setFromOsm((list) => list.map((x) => (x === id ? next : x)));
    setSelected(null);
  };
  const setEdge = (id: string, edge: RoofEdge | "") =>
    setEdges(({ [id]: _, ...rest }) => (edge ? { ...rest, [id]: edge } : rest));
  const setItem = (id: string, item: string) =>
    setItems(({ [id]: _, ...rest }) => (item ? { ...rest, [id]: item } : rest));
  /** Draw a paving item: its tool, and new shapes become it. Null goes back to plain shapes. */
  const pickItem = (item: PavingItem | null) => {
    tap.stop();
    setActiveItem(item);
    if (!item) return;
    const next: Tool = item.geometry === "area" ? "polygon" : item.geometry === "line" ? "linestring" : "point";
    setTool(next);
    mapRef.current?.setTool(next);
    setSelected(null);
  };
  /** Shapes just finished while an item was picked become that item. */
  const onShapes = (next: Shape[], inProgress: Shape | null) => {
    const fresh = next.filter((s) => !knownIds.current.has(s.id));
    fresh.forEach((s) => knownIds.current.add(s.id));
    if (activeItem) {
      const mine = fresh.filter((s) => itemFits(activeItem.id, s.kind));
      if (mine.length) setItems((list) => ({ ...list, ...Object.fromEntries(mine.map((s) => [s.id, activeItem.id])) }));
    }
    setShapes(next);
    setDrawing(inProgress);
  };
  /** Shapes Find paving added, as the items it found them as. */
  const addFound = (ids: string[], item: string) => {
    ids.forEach((id) => knownIds.current.add(id));
    setItems((list) => ({ ...list, ...Object.fromEntries(ids.map((id) => [id, item])) }));
  };
  const setShapePitch = (id: string, value: string) =>
    setPitches(({ [id]: _, ...rest }) => (value.trim() ? { ...rest, [id]: value } : rest));

  // ----- Building outlines from OpenStreetMap (buildings.ts) -----------------------------------
  const cutBuildings = async () => {
    const areas = polygonsOf(shapes, "Area");
    const box = boxAround(areas);
    if (!box) return;
    setFinding("cut");
    try {
      // The street map's tiles have them already, most places; OpenStreetMap's own server is slower.
      const found = buildingsOn(mapRef.current?.buildings() ?? (await buildingsIn(box)), areas, polygonsOf(shapes, "Cutout"));
      if (!found.length) return void toast.info("OpenStreetMap has no buildings on these areas. Draw them with Cut out.");
      const ids = mapRef.current?.add(found, "Cutout") ?? [];
      if (!ids.length) return void toast.error("Those building outlines couldn't be added. Draw them with Cut out.");
      setFromOsm((list) => [...list, ...ids]);
      setLabels((l) => ({ ...l, ...Object.fromEntries(ids.map((id, i) => [id, ids.length === 1 ? "Building" : `Building ${i + 1}`])) }));
      toast.success(`Cut out ${ids.length === 1 ? "a building" : `${ids.length} buildings`} from OpenStreetMap. Check the outlines against the imagery and drag any corners that are off.`);
    } catch (error) {
      toast.error(error instanceof BuildingsError ? error.message : "Couldn't look up buildings. Try again.");
    } finally {
      setFinding(null);
    }
  };
  const outlineBuilding = async () => {
    const view = mapRef.current?.view();
    if (!view) return;
    if (view.zoom < 16) return void toast.info("Zoom in until the building fills most of the map, then try again.");
    const [lng, lat] = view.center;
    const d = 0.0007;
    setFinding("outline");
    try {
      const loaded = mapRef.current?.buildings();
      const building = (loaded && buildingAt(loaded, [lng, lat])) || buildingAt(await buildingsIn([lng - d, lat - d, lng + d, lat + d]), [lng, lat]);
      if (!building) return void toast.info("OpenStreetMap has no outline for the building in the middle of the map. Draw the roof with Area.");
      const ids = mapRef.current?.add([building], "Area") ?? [];
      if (!ids.length) return void toast.error("That building's outline couldn't be added. Draw the roof with Area.");
      setFromOsm((list) => [...list, ...ids]);
      toast.success("Added the building's outline. It follows the walls, so drag the corners out to the eaves (often 1 to 2 ft).");
    } catch (error) {
      toast.error(error instanceof BuildingsError ? error.message : "Couldn't look up the building. Try again.");
    } finally {
      setFinding(null);
    }
  };

  const clearAll = async () => {
    if (!shapes.length) return;
    if (!(await confirm({ title: "Clear every shape?", body: "This removes everything you've drawn on the map. Undo can bring it back.", confirmLabel: "Clear", danger: true }))) return;
    mapRef.current?.clear();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || mapState !== "ready") return;
      if (tap.item && e.key === "Escape") return void tap.stop();
      if (aligning) {
        if (e.key === "Escape") plan.cancelLineUp();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) mapRef.current?.redo();
        else mapRef.current?.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        mapRef.current?.redo();
        return;
      }
      if (mod || e.altKey) return;
      const next = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (next) pickTool(next.tool);
      else if (e.key.toLowerCase() === "f") mapRef.current?.fitShapes();
      else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        removeSelected();
      } else if (e.key === "?") setHelp(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ----- Leaving with unsaved shapes ------------------------------------------------------------
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    confirm({ title: "Leave without saving?", body: "The shapes you drew since the last save will be lost.", confirmLabel: "Leave", danger: true }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker]);
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => dirty && e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  // A takeoff opened from Paving goes back to its project there, and on to the estimate.
  const pavingProject = params.has("paving") && ctx?.quote ? ctx.quote : null;
  const back = pavingProject
    ? { to: `/paving/${pavingProject.id}`, label: pavingProject.title || `Quote #${pavingProject.number}` }
    : ctx?.invoice
    ? { to: `/invoices/${ctx.invoice.id}`, label: `Invoice #${ctx.invoice.number}` }
    : ctx?.quote
      ? { to: `/quotes/${ctx.quote.id}`, label: `Quote #${ctx.quote.number}` }
      : ctx?.request
        ? { to: `/requests/${ctx.request.id}`, label: `Request #${ctx.request.number}` }
        : ctx?.property?.client
          ? { to: `/clients/${ctx.property.client.id}`, label: ctx.property.client.display_name }
          : null;

  /** The best free imagery here, for pictures Google's terms don't allow (the saved one, Find paving). */
  const freePicture = async (): Promise<ImageryId> => {
    if (!center) return "naip";
    const now = Date.now();
    return (await resolveAuto(center.lng, center.lat, 19, { ...keys, esri_key: null }, (source) => probe(source, center.lng, center.lat), (source) => (down.current.get(source) ?? 0) > now)).id;
  };
  // Tap to outline (TapOutline.tsx): the free way to find paving. Lining up a plan takes the taps.
  const tap = useTapOutline({ map: mapRef, imagery, pictureImagery: freePicture, onFound: addFound });
  useEffect(() => {
    if (aligning) tap.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aligning]);

  /** What the takeoff sheet under the saved picture says (takeoffSheet.ts). */
  const sheetInfo = (pictureOn: ImageryId): SheetInfo => {
    const place = ctx?.property ? addressLine(ctx.property) : picked?.label ?? null;
    const credit = [imageryCredit(pictureOn), overlays.length && pictureOn !== "terrain" ? ELEVATION_CREDIT : null, shapes.some((sh) => fromOsm.includes(sh.id)) ? OSM_BUILDINGS_CREDIT : null].filter(Boolean).join(" · ");
    const cut = summary.sections.reduce((t, s) => (s.kind === "Cutout" ? t + s.value : t), 0);
    const cutRow = cut > 0 ? [{ color: "#ef4444", label: "Cut out", value: `−${formatNumber(cut)} sq ft`, shape: "area" as const }] : [];
    const itemRows = PAVING_ITEMS.filter((item) => summary.sections.some((s) => s.item === item.id)).map((item) => ({ color: item.color, label: item.name, value: formatItemTotal(summary.sections, item), shape: item.geometry }));
    let legend;
    if (itemRows.length) legend = [...itemRows, ...cutRow];
    else {
      const drawn = summary.sections.filter((s) => s.kind === "Area" || s.kind === "Length");
      const counts = summary.sections.filter((s) => s.kind === "Count").length;
      legend = drawn.length <= 10
        ? [
            ...drawn.map((s) => ({ color: shapes.find((sh) => sh.id === s.feature_id)?.color ?? "#999", label: nameOf(s.feature_id), value: s.kind === "Area" ? `${formatNumber(s.value)} sq ft` : `${formatNumber(s.value, 1)} ft`, shape: s.kind === "Area" ? ("area" as const) : ("line" as const) })),
            ...cutRow,
            ...(counts ? [{ color: "#f59e0b", label: "Count", value: String(counts), shape: "count" as const }] : []),
          ]
        : [
            { color: "#22c55e", label: "Area", value: `${formatNumber(summary.total_area_sqft)} sq ft`, shape: "area" as const },
            ...(summary.total_length_ft ? [{ color: "#38bdf8", label: "Length", value: `${formatNumber(summary.total_length_ft)} ft`, shape: "line" as const }] : []),
            ...cutRow,
            ...(counts ? [{ color: "#f59e0b", label: "Count", value: String(counts), shape: "count" as const }] : []),
          ];
    }
    return { business: company.name, title: title.trim() || "Measurement", place, date: new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }), credit, legend };
  };

  // ----- Save -----------------------------------------------------------------------------------
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      if (!shapes.length) throw new Error("Draw at least one shape first.");
      if (drawing) throw new Error("Finish or cancel the shape you're drawing first.");
      if (aligning) throw new Error("Finish lining up the plan first, or cancel it.");
      if (pitchError) throw new Error(pitchError);
      // A picture of the drawing for the quote, invoice and PDF. Saving goes ahead without one.
      let snapshot: string | undefined;
      let pictureProblem = false;
      const shown = imagery ?? "naip";
      // Google's terms don't allow keeping pictures of its imagery, so the saved picture uses the
      // best free imagery here instead (Esri's allow it with the credit, which goes with it).
      const pictureOn: ImageryId = shown === "google" ? await freePicture() : shown;
      setCapturing(true);
      try {
        const blob = await mapRef.current?.capture({ imagery: pictureOn, sheet: sheetInfo(pictureOn) });
        if (blob) {
          const path = `${company.id}/measurements/${crypto.randomUUID()}.jpg`;
          const { error } = await supabase().storage.from("files").upload(path, blob, { contentType: "image/jpeg", upsert: false });
          if (error) throw error;
          snapshot = path;
        } else pictureProblem = true;
      } catch {
        pictureProblem = true;
      } finally {
        setCapturing(false);
      }
      const view = mapRef.current?.view();
      const result = await api.post<SaveResult>("/measurements", {
        id: saved?.id,
        title: title.trim() || "Measurement",
        property_id: ctx?.ids.property ?? picked?.property_id ?? undefined,
        request_id: ctx?.ids.request ?? undefined,
        quote_id: saved ? undefined : ctx?.ids.quote ?? undefined,
        invoice_id: saved ? undefined : ctx?.ids.invoice ?? undefined,
        provider: shown,
        roof_pitch: tidyPitch(pitch) || null,
        waste_pct: Math.min(100, Math.max(0, Number(waste || 0))),
        geojson: { type: "FeatureCollection", features },
        view: view
          ? { ...view, imagery: shown, mode: choice === "auto" ? "auto" : "manual", overlays, plan: plan.savedPlan ?? undefined, attribution: [imageryCredit(pictureOn), overlays.length && pictureOn !== "terrain" ? ELEVATION_CREDIT : null, shapes.some((sh) => fromOsm.includes(sh.id)) ? OSM_BUILDINGS_CREDIT : null].filter(Boolean).join(" · ") }
          : undefined,
        snapshot_path: snapshot,
      });
      return { result, snapshot, pictureProblem, previous: saved?.snapshot_path ?? null, swapped: pictureOn !== shown ? pictureOn : null, planSig };
    },
    onSuccess: ({ result, snapshot, pictureProblem, previous, swapped, planSig: savedPlanSig }) => {
      setSavedSignature(signature);
      setPlanSavedSig(savedPlanSig);
      setSaved((s) => ({
        id: result.id,
        quote_id: s?.quote_id ?? ctx?.ids.quote ?? null,
        invoice_id: s?.invoice_id ?? ctx?.ids.invoice ?? null,
        show_on_quote: s?.show_on_quote ?? false,
        show_on_invoice: s?.show_on_invoice ?? false,
        snapshot_path: snapshot ?? s?.snapshot_path ?? null,
      }));
      // The old picture is replaced; tidy it away (best effort: only some roles may delete files).
      if (snapshot && previous && previous !== snapshot) void supabase().storage.from("files").remove([previous]);
      queryClient.invalidateQueries({ queryKey: ["measurements"] });
      if (ctx?.ids.quote) queryClient.invalidateQueries({ queryKey: ["quote", ctx.ids.quote] });
      if (ctx?.ids.request) queryClient.invalidateQueries({ queryKey: ["request", ctx.ids.request] });
      const where = ctx?.quote ? ` on quote #${ctx.quote.number}` : ctx?.invoice ? ` on invoice #${ctx.invoice.number}` : "";
      toast.success(`Saved${where}: ${formatNumber(result.total_area_sqft)} sq ft${result.total_length_ft ? `, ${formatNumber(result.total_length_ft)} ft` : ""}`);
      if (pictureProblem) toast.error("Saved, but the map picture couldn't be kept, so clients would see the sizes only. Save again to retry.");
      else if (swapped) toast.success(`The saved picture uses ${imageryInfo(swapped).name}, since Google's terms don't allow keeping pictures of its imagery.`);
    },
  });

  // ----- Render ---------------------------------------------------------------------------------
  if (context.error) {
    return (
      <>
        <PageHeader title="Measure" />
        <div className="card"><EmptyState icon="map" title="Couldn't open this drawing" action={<Button onClick={() => context.refetch()}>Try again</Button>}>{(context.error as Error).message}</EmptyState></div>
      </>
    );
  }
  const p = ctx?.property;
  const rows = summary.sections.map((s, i) => ({ id: s.feature_id, kind: s.kind, value: s.value, unit: s.unit, color: shapes[i]?.color ?? "#999" }));
  const counts = rows.filter((r) => r.kind === "Count").length;
  const cutTotal = summary.sections.reduce((t, s) => (s.kind === "Cutout" ? t + s.value : t), 0);
  const selectedShape = shapes.find((s) => s.id === selected) ?? null;
  // Each roof section at the pitch it's measured at, for the squares line and the breakdown.
  const roofSections = summary.sections.filter((s) => s.kind === "Area").map((s) => ({ id: s.feature_id, label: nameOf(s.feature_id), sqft: s.value, pitch: tidyPitch(s.pitch ?? "") || tidyPitch(pitch) }));
  const roofPitches = [...new Set(roofSections.map((r) => r.pitch))];
  const sectionSquares = (sqft: number, at: string) => (sqft * pitchFactor(at) * (1 + Number(waste || 0) / 100)) / 100;
  const near = center ? { lat: center.lat, lng: center.lng } : null;
  // The roof sections drawn, for reading their pitch from lidar.
  const roofOutlines = shapes.filter((s) => s.kind === "Area" && s.geometry?.type === "Polygon").map((s) => ({ id: s.id, name: nameOf(s.id), ring: (s.geometry!.coordinates as Position[][])[0] }));
  const hasEdges = ROOF_EDGES.some((e) => roofEdges[e] > 0);
  const roofCard = (
    <details key="roof" className="card measure-extra" open={roofing} onToggle={(e) => setRoofOpen(e.currentTarget.open)}>
      <summary className="card-pad"><strong>Roof pitch and edges</strong><span className="muted small">For roofing squares, drip edge and ridge cap</span></summary>
      <div className="card-pad stack" style={{ paddingTop: 0 }}>
        <PitchPicker value={pitch} onChange={setPitch} />
        <MeasurePitch near={near} onPick={setPitch} roofs={roofOutlines} onPickSection={setShapePitch} />
        <Field label="Waste %" hint="About 10% for a plain gable roof, 15% or more with hips and valleys.">
          <input className="input" inputMode="decimal" value={waste} onChange={(e) => setWaste(e.target.value.replace(/[^0-9.]/g, ""))} style={{ maxWidth: 120 }} />
        </Field>
        {squares !== null && roofSections.length > 1 && (
          <div className="measure-breakdown">
            <span className="small strong">Each roof section</span>
            {roofSections.map((r) => (
              <button key={r.id} type="button" className="measure-breakdown-row" onClick={() => setPitchFor(r.id)}>
                <span className="grow">{r.label}</span>
                <span className="muted small">{r.pitch ? pitchLabel(r.pitch) : "Flat"}</span>
                <strong className="num">{formatNumber(sectionSquares(r.sqft, r.pitch), 1)} sq</strong>
              </button>
            ))}
          </div>
        )}
        {hasEdges ? (
          <div className="measure-totals measure-edges">
            {ROOF_EDGES.filter((e) => roofEdges[e] > 0).map((e) => <div key={e}><span className="muted">{EDGE_PLURALS[e]}</span><strong>{formatNumber(roofEdges[e])} ft</strong></div>)}
            <div><span className="muted">Drip edge (eaves and rakes)</span><strong>{formatNumber(roofEdges.eave + roofEdges.rake)} ft</strong></div>
            {roofEdges.ridge + roofEdges.hip > 0 && <div><span className="muted">Ridge cap (ridges and hips)</span><strong>{formatNumber(roofEdges.ridge + roofEdges.hip)} ft</strong></div>}
          </div>
        ) : (
          <span className="muted small">
            {rows.some((r) => r.kind === "Length")
              ? "Mark your lines as eaves, rakes, ridges, hips or valleys in the Shapes list to get drip edge and ridge cap lengths."
              : "Draw the roof's edges with Line, then mark each as an eave, rake, ridge, hip or valley for drip edge and ridge cap lengths. Rakes, hips and valleys are stretched by the pitch."}
          </span>
        )}
        <div className="stack-sm">
          <Button size="sm" icon="home" loading={finding === "outline"} disabled={Boolean(finding) || mapState !== "ready"} onClick={outlineBuilding} style={{ justifySelf: "start" }}>Outline the building in the middle</Button>
          <span className="muted small">Starts the roof from OpenStreetMap's outline of the building in the middle of the map, where it has one.</span>
        </div>
      </div>
    </details>
  );
  const depthCard = (
    <details key="depth" className="card measure-extra" open={Boolean(depth)}>
      <summary className="card-pad"><strong>Depth</strong><span className="muted small">For mulch, gravel and asphalt</span></summary>
      <div className="card-pad" style={{ paddingTop: 0 }}>
        <Field label="Depth (in)"><input className="input" inputMode="decimal" value={depth} onChange={(e) => setDepth(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="2" style={{ maxWidth: 120 }} /></Field>
      </div>
    </details>
  );

  return (
    <>
      {back && <BackLink to={back.to}>{back.label}</BackLink>}
      <PageHeader
        title={saved ? title || "Measurement" : "Measure"}
        actions={
          <>
            <Button variant="ghost" icon="info" onClick={() => setHelp(true)}>How it works</Button>
            {!dirty && saved && pavingProject ? (
              <Link to={`/paving/${pavingProject.id}#estimate`} className="btn btn-primary">Next: Estimate <Icon name="arrowRight" size={15} /></Link>
            ) : (
              !dirty && saved && back && <Link to={back.to} className="btn">Back to {back.label}</Link>
            )}
            <Button variant="primary" icon={!dirty && saved ? "check" : undefined} loading={save.isPending} disabled={!shapes.length || aligning || (!dirty && Boolean(saved))} onClick={() => save.mutate()}>
              {!dirty && saved ? "Saved" : saved ? "Save changes" : "Save measurement"}
            </Button>
          </>
        }
      />
      {p && <p className="page-subtitle">{addressLine(p)}{p.client && ` · ${p.client.display_name}`}{ctx?.quote && ` · for quote #${ctx.quote.number}`}{ctx?.invoice && ` · for invoice #${ctx.invoice.number}`}</p>}
      {!p && picked && (
        <p className="page-subtitle">
          For {picked.label}{picked.client && ` · ${picked.client}`}
          {!saved && <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={unpick}>Not for this client</button>}
        </p>
      )}
      <FormError error={save.error} />
      <div className="two-col measure-layout">
        <div className="wide card measure-card">
          {mapState !== "error" && (
            <div className="measure-toolbar">
              <AddressSearch
                disabled={mapState !== "ready"}
                busy={find.isPending}
                near={center && center.zoom >= 8 ? center : null}
                onSubmit={(address) => find.mutate(address)}
                onPickClient={pickClient}
                onPickPlace={pickPlace}
                onEdit={() => find.isError && find.reset()}
              />
              {imagery && (
                <ImageryPicker choice={choice ?? "auto"} opening={opening} showing={imagery} center={center} keys={keys} isAdmin={isAdmin} streetMap={streetMap} streetNames={streetNames} houseNumbers={houseNumbers} overlays={overlays} onPick={(next) => chooseImagery(next)} onMakeDefault={makeDefault} onStreetNames={setStreetNames} onHouseNumbers={showHouseNumbers} onOverlay={toggleOverlay} />
              )}
            </div>
          )}
          {find.error && <div className="field-error" role="alert" style={{ padding: "6px 12px 0" }}>{(find.error as Error).message}</div>}
          {mapState === "error" ? (
            <EmptyState icon="map" title="The map isn't available" action={<div className="row" style={{ gap: 8 }}><Button onClick={() => window.location.reload()}>Reload</Button>{back && <Link className="btn" to={back.to}>Back to {back.label}</Link>}</div>}>{mapError}</EmptyState>
          ) : (
            <div className="measure-map-wrap">
              {mapState === "loading" && (
                <div className="measure-map-skeleton" aria-label="Loading map"><Skeleton height="100%" radius={0} /><span className="muted small strong"><Icon name="map" size={16} /> Loading imagery…</span></div>
              )}
              {start && imagery && (
                <MeasureMap
                  ref={mapRef}
                  start={start}
                  imagery={imagery}
                  imageryRevision={imageryRevision}
                  keys={keys}
                  labels={mapNames}
                  values={mapValues}
                  notes={mapNotes}
                  colors={mapColors}
                  showStreetNames={streetNames}
                  showHouseNumbers={houseNumbers}
                  overlays={overlays}
                  onReady={onReady}
                  onFailed={(message) => { setMapError(message); setMapState("error"); }}
                  onShapes={onShapes}
                  onSelect={setSelected}
                  onMoved={(c, zoom) => setCenter({ ...c, zoom })}
                  onImageryTrouble={imageryTrouble}
                  onHistory={(undo, redo) => setHistory({ undo, redo })}
                  onStreetMap={setStreetMap}
                />
              )}
              {mapState === "ready" && (
                <>
                  {!aligning && <div className="measure-rail" role="toolbar" aria-label="Drawing tools" aria-orientation="vertical">
                    {TOOLS.map((t) => (
                      <button key={t.tool} type="button" className="measure-tool" aria-pressed={tool === t.tool} onClick={() => pickTool(t.tool)} title={touch ? t.what : `${t.label} (${t.key}): ${t.what}`}>
                        <Icon name={t.icon} size={18} />
                        <span>{t.label}</span>
                      </button>
                    ))}
                    <span className="measure-rail-sep" aria-hidden="true" />
                    {drawing ? (
                      <button type="button" className="measure-tool" onClick={() => mapRef.current?.cancel()} title={touch ? "Stop drawing this shape" : "Stop drawing this shape (Esc)"}>
                        <Icon name="x" size={18} /><span>Cancel</span>
                      </button>
                    ) : null}
                    <button type="button" className="measure-tool" onClick={() => mapRef.current?.undo()} disabled={!history.undo && !drawing} title={touch ? "Undo" : "Undo (Ctrl+Z)"}>
                      <Icon name="undo" size={18} /><span>Undo</span>
                    </button>
                    <button type="button" className="measure-tool" onClick={() => mapRef.current?.redo()} disabled={!history.redo} title={touch ? "Redo" : "Redo (Ctrl+Shift+Z)"}>
                      <Icon name="redo" size={18} /><span>Redo</span>
                    </button>
                    {tool === "select" && selectedShape && (selectedShape.kind === "Area" || selectedShape.kind === "Cutout") && (
                      <button
                        type="button"
                        className="measure-tool"
                        aria-pressed={selectedShape.kind === "Cutout"}
                        onClick={() => convert(selectedShape.id, selectedShape.kind === "Cutout" ? "Area" : "Cutout")}
                        title={selectedShape.kind === "Cutout" ? "This is a cutout. Tap to count it as an area again." : "Make this a cutout: leave it out of the areas under it"}
                      >
                        <Icon name="scissors" size={18} /><span>Cut out</span>
                      </button>
                    )}
                    {tool === "select" && selected && (
                      <button type="button" className="measure-tool" data-danger onClick={removeSelected} title={touch ? "Delete this shape" : "Delete this shape (Delete)"}>
                        <Icon name="trash" size={18} /><span>Delete</span>
                      </button>
                    )}
                  </div>}
                  <div className="measure-corner">
                    <button type="button" className="measure-round" onClick={locate} title="Go to where I am" aria-label="Go to where I am"><Icon name="navigation" size={17} /></button>
                    {shapes.length > 0 && <button type="button" className="measure-round" onClick={() => mapRef.current?.fitShapes()} title={touch ? "Show all shapes" : "Show all shapes (F)"} aria-label="Show all shapes"><Icon name="eye" size={17} /></button>}
                    <button type="button" className="measure-round" onClick={() => setHelp(true)} title="How to measure" aria-label="How to measure"><Icon name="info" size={17} /></button>
                  </div>
                  {aligning ? <LineUpBanner plan={plan} /> : tap.item ? <TapBanner tap={tap} /> : banner && <ImageryBanner banner={banner} keys={keys} isAdmin={isAdmin} streetMap={streetMap} onUse={chooseImagery} onDismiss={(key) => { setDismissed((d) => [...d, key]); setBanner(null); }} onRetry={() => { probes.current.clear(); setBanner(null); setImageryRevision((n) => n + 1); }} />}
                  {overlays.includes("slope") && (
                    <div className="measure-legend" aria-label="Slope colors">
                      <strong>Slope</strong>
                      {SLOPE_CLASSES.map((c) => <span key={c.label}><i style={{ background: c.color }} />{c.label}<span className="muted"> · {c.note}</span></span>)}
                    </div>
                  )}
                  {!aligning && !tap.item && <div className="measure-hint" role="status" aria-live="polite">{activeItem && !drawing && tool !== "select" ? `${activeItem.name}: ${activeItem.hint}` : hintFor(tool, drawing, Boolean(selected), shapes.length, touch)}</div>}
                  {capturing && <div className="measure-capturing" role="status"><span className="spinner" style={{ width: 16, height: 16 }} /> Saving a picture of the drawing…</div>}
                  {center && center.zoom < 12 && !shapes.length && !banner && !aligning && (
                    <div className="measure-zoom-note">Search an address or zoom in to the property to start measuring.</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <aside className="narrow stack" style={{ gap: 16 }}>
          {saved && (
            <ShareDrawing
              drawing={saved}
              clientId={ctx?.clientId ?? picked?.client_id ?? null}
              hasPicture={Boolean(saved.snapshot_path)}
              onChange={(patch) => setSaved((s) => (s ? { ...s, ...patch } : s))}
            />
          )}
          <div className="card card-pad stack-sm">
            <Field label="Name this measurement"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Front lawn and driveway" /></Field>
          </div>

          {paving && (
            <PavingItemsCard
              sections={summary.sections}
              active={activeItem?.id ?? null}
              onPick={pickItem}
              finder={
                <FindPaving
                  map={mapRef}
                  ready={mapState === "ready" && !aligning && !tap.item}
                  connected={Boolean(session.config.features.findPaving)}
                  isAdmin={isAdmin}
                  imagery={imagery}
                  pictureImagery={freePicture}
                  zoom={center?.zoom ?? 0}
                  activeItem={activeItem?.id ?? null}
                  onFound={addFound}
                  onTap={(item) => {
                    setSelected(null);
                    tap.start(item);
                  }}
                />
              }
            />
          )}

          <div className="card">
            <div className="card-head"><strong>Shapes</strong><span className="badge">{rows.length}</span>{shapes.length > 0 && <Button size="sm" variant="ghost" icon="trash" onClick={clearAll} style={{ marginLeft: "auto" }}>Clear all</Button>}</div>
            {rows.length === 0 ? (
              <EmptyState compact icon="area" title="Nothing drawn yet">
                Pick <strong>Area</strong>, <strong>Line</strong> or <strong>Count</strong> on the map, then {touch ? "tap" : "click"} to draw. <strong>Cut out</strong> leaves the house or a bed out of an area. Sizes show up here as you go.
              </EmptyState>
            ) : (
              rows.map((row, i) => {
                const section = sections.get(row.id);
                const edge = edges[row.id];
                const own = pitches[row.id] ?? "";
                const at = own || pitch;
                const showPitch = roofing && (row.kind === "Area" || slopedEdge(edge));
                const polygon = row.kind === "Area" || row.kind === "Cutout";
                const more = (row.kind === "Area" && section?.uncut_value !== undefined) || row.kind === "Cutout" || (roofing && row.kind === "Length") || showPitch || paving;
                return (
                  <div key={row.id} className="card-row measure-shape" data-selected={selected === row.id || undefined} data-kind={row.kind}>
                    <button type="button" className="measure-swatch" style={{ background: row.color }} onClick={() => { pickTool("select"); mapRef.current?.select(row.id); }} aria-label={`Select ${nameOf(row.id)} on the map`} />
                    <div className="grow measure-shape-body">
                      <input
                        className="input"
                        style={{ height: 32 }}
                        aria-label={`Name for shape ${i + 1}`}
                        placeholder={`${names[row.id] ?? ""}${items[row.id] ? "" : row.kind === "Area" ? " (e.g. Front lawn)" : row.kind === "Cutout" ? " (e.g. House)" : row.kind === "Length" && !roofing ? " (e.g. Fence)" : ""}`}
                        value={labels[row.id] ?? ""}
                        onChange={(e) => setLabels({ ...labels, [row.id]: e.target.value })}
                        maxLength={80}
                      />
                      {more && (
                        <div className="measure-shape-more">
                          {paving && row.kind !== "Cutout" && <ItemSelect kind={row.kind} value={items[row.id]} label={nameOf(row.id)} onChange={(item) => setItem(row.id, item)} />}
                          {section?.item === "stall_row" && <span className="muted small">{stallsAlong(section.value)} stalls</span>}
                          {row.kind === "Area" && section?.uncut_value !== undefined && <span className="muted small">{formatNumber(section.uncut_value)} sq ft before cutouts</span>}
                          {row.kind === "Cutout" && <span className="muted small">{row.value > 0 ? "Left out of the areas under it" : "Not over an area, so nothing comes off"}</span>}
                          {roofing && row.kind === "Length" && (
                            <select className="select measure-edge" value={edge ?? ""} onChange={(e) => setEdge(row.id, e.target.value as RoofEdge | "")} aria-label={`Roof edge for ${nameOf(row.id)}`}>
                              <option value="">Not a roof edge</option>
                              {ROOF_EDGES.map((e) => <option key={e} value={e}>{EDGE_NAMES[e]}</option>)}
                            </select>
                          )}
                          {showPitch && (
                            <button type="button" className="chip measure-pitch-chip" data-own={own ? true : undefined} data-steep={(riseOf(at) ?? 0) >= STEEP_FROM || undefined} onClick={() => setPitchFor(row.id)} aria-label={`Pitch for ${nameOf(row.id)}: ${at.trim() ? pitchLabel(at) : "not set"}. Change it`}>
                              <Icon name="pitch" size={12} />{at.trim() ? pitchLabel(at) : "Set pitch"}{!own && at.trim() ? " · roof" : ""}
                            </button>
                          )}
                          {section?.plan_value !== undefined && <span className="muted small">{formatNumber(section.plan_value, 1)} ft from above</span>}
                        </div>
                      )}
                    </div>
                    <span className="num strong nowrap" data-cut={row.kind === "Cutout" || undefined}>
                      {row.kind === "Count" ? "1" : row.kind === "Cutout" ? `−${formatNumber(row.value)} sq ft` : `${formatNumber(row.value, row.kind === "Length" ? 1 : 0)} ${row.unit}`}
                    </span>
                    {polygon && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost btn-icon"
                        aria-pressed={row.kind === "Cutout"}
                        onClick={() => convert(row.id, row.kind === "Cutout" ? "Area" : "Cutout")}
                        aria-label={row.kind === "Cutout" ? `Count ${nameOf(row.id)} as an area` : `Make ${nameOf(row.id)} a cutout`}
                        title={row.kind === "Cutout" ? "Count it as an area again" : "Make it a cutout: leave it out of the areas under it"}
                      >
                        <Icon name={row.kind === "Cutout" ? "area" : "scissors"} size={15} />
                      </button>
                    )}
                    <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => mapRef.current?.remove(row.id)} aria-label={`Delete shape ${i + 1}`} title="Delete this shape"><Icon name="trash" size={15} /></button>
                  </div>
                );
              })
            )}
            {rows.some((r) => r.kind === "Area") && (
              <div className="card-row measure-buildings">
                <Button size="sm" icon="home" loading={finding === "cut"} disabled={Boolean(finding)} onClick={cutBuildings}>Cut out buildings</Button>
                <span className="muted small">Finds the buildings on your areas in OpenStreetMap and leaves them out.</span>
              </div>
            )}
            <div className="measure-totals">
              <div><span className="muted">Area</span><strong>{formatNumber(summary.total_area_sqft)} sq ft</strong><span className="muted small">{formatNumber(summary.total_area_sqyd, 1)} sq yd{summary.total_area_sqft >= 4356 ? ` · ${formatNumber(summary.total_area_sqft / 43_560, 2)} acres` : ""}</span></div>
              <div><span className="muted">Length</span><strong>{formatNumber(summary.total_length_ft)} ft</strong></div>
              {cutTotal > 0 && <div><span className="muted">Cut out</span><strong>{formatNumber(cutTotal)} sq ft</strong><span className="muted small">not counted in the area</span></div>}
              {counts > 0 && <div><span className="muted">Count</span><strong>{counts}</strong></div>}
              {depthIn > 0 && summary.total_area_sqft > 0 && (
                <>
                  <div><span className="muted">Volume at {depthIn}"</span><strong>{formatNumber(cubicYards, 1)} cu yd</strong></div>
                  <div><span className="muted">Asphalt (approx.)</span><strong>{formatNumber(asphaltTons, 1)} tons</strong><span className="muted small">at 110 lb per sq yd per inch</span></div>
                </>
              )}
              {squares !== null && <div><span className="muted">Roofing squares</span><strong>{formatNumber(squares, 1)}</strong><span className="muted small">{roofPitches.length > 1 ? "mixed pitches" : `${roofPitches[0] ? pitchLabel(roofPitches[0]) : "flat"} pitch`}, {waste || 0}% waste</span></div>}
            </div>
          </div>

          {(plan.shown || plan.plans.data?.length || plan.sending || company.trade_preset !== "lawn_exterior") && (
            <PlanCard plan={plan} canAdd={canAddPlans} hasPlace={Boolean(ctx?.ids.property || picked?.property_id || ctx?.ids.quote)} />
          )}

          {pitchError && shapes.length > 0 && <div className="field-error" role="alert">{pitchError}</div>}
          {company.trade_preset === "roofing_exteriors" ? [roofCard, depthCard] : [depthCard, roofCard]}
        </aside>
      </div>

      <MeasureHelp open={help} touch={touch} onClose={() => { markHelpSeen(); setHelp(false); }} />
      {pitchFor && shapes.some((s) => s.id === pitchFor) && (
        <Dialog open onClose={() => setPitchFor(null)} title={`Pitch for ${nameOf(pitchFor)}`} description="For a porch, dormer or addition that isn't at the main roof's pitch." size="md">
          <div className="dialog-body stack">
            <PitchPicker value={pitches[pitchFor] ?? ""} inherit={pitch} label={`Pitch for ${nameOf(pitchFor)}`} onChange={(value) => setShapePitch(pitchFor, value)} />
            <MeasurePitch near={near} onPick={(value) => setShapePitch(pitchFor, value)} roofs={roofOutlines.filter((r) => r.id === pitchFor)} />
            <div className="form-actions"><Button variant="primary" onClick={() => setPitchFor(null)}>Done</Button></div>
          </div>
        </Dialog>
      )}
      {tooLarge.dialog}
      {abroad && (
        <OutsideUs
          place={abroad.place}
          hasEsri={Boolean(keys.esri_key)}
          isAdmin={isAdmin}
          streetMap={streetMap}
          onUse={(id) => { chooseImagery(id, true); setAbroad(null); }}
          onClose={() => setAbroad(null)}
        />
      )}
    </>
  );
}

function ImageryBanner({
  banner, keys, isAdmin, streetMap, onUse, onDismiss, onRetry,
}: {
  banner: Banner;
  keys: { esri_key?: string | null };
  isAdmin: boolean;
  streetMap: boolean;
  onUse: (id: ImageryChoice, fromAbroad?: boolean) => void;
  onDismiss: (key: string) => void;
  onRetry: () => void;
}) {
  const settingsLink = isAdmin && <Link className="btn btn-sm" to="/settings?tab=maps" target="_blank" rel="noreferrer">Add an Esri key</Link>;
  if (banner.kind === "no-aerial") {
    return (
      <div className="measure-banner" role="status">
        <Icon name="info" size={16} />
        <span className="grow">
          <strong>No free aerial imagery here.</strong> It covers the US, so {AUTO_NAME} is showing the street map.{" "}
          {isAdmin ? "For aerial imagery anywhere, add a free Esri key." : "An admin can add a free Esri key in Settings for aerial imagery anywhere."}
        </span>
        {settingsLink}
        <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => onDismiss("no-aerial")} aria-label="Dismiss"><Icon name="x" size={14} /></button>
      </div>
    );
  }
  if (banner.kind === "sharper") {
    const s = banner.state;
    return (
      <div className="measure-banner measure-banner-good" role="status">
        <Icon name="sparkle" size={16} />
        <span className="grow"><strong>Sharper imagery here.</strong> {s.name}'s free state imagery: {s.detail} · {s.flown}.</span>
        <Button size="sm" variant="primary" onClick={() => onUse(stateId(s))}>Use it</Button>
        <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => onDismiss(s.state)} aria-label="Not now"><Icon name="x" size={14} /></button>
      </div>
    );
  }
  if (banner.kind === "left-state") {
    return (
      <div className="measure-banner" role="status">
        <Icon name="info" size={16} />
        <span className="grow">{banner.state.name}'s imagery doesn't reach this spot.</span>
        <Button size="sm" variant="primary" onClick={() => onUse("auto")}>Use {AUTO_NAME}</Button>
        <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => onDismiss(`left:${banner.state.state}`)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
      </div>
    );
  }
  if (banner.kind === "empty") {
    return (
      <div className="measure-banner measure-banner-warn" role="alert">
        <Icon name="alert" size={16} />
        <span className="grow"><strong>No free US imagery here.</strong> It covers the lower 48 states. {keys.esri_key ? "Esri covers the rest of the world." : isAdmin ? "For aerial imagery anywhere, add a free Esri key." : "An admin can add a free Esri key in Settings for imagery anywhere."}</span>
        {keys.esri_key ? <Button size="sm" variant="primary" onClick={() => onUse("esri", true)}>Use Esri</Button> : settingsLink}
        <Button size="sm" onClick={() => onUse("auto")}>Use {AUTO_NAME}</Button>
      </div>
    );
  }
  const name = imageryInfo(banner.imagery).name;
  const sentence = /[.!?]$/.test(banner.message);
  return (
    <div className="measure-banner measure-banner-warn" role="alert">
      <Icon name="alert" size={16} />
      <span className="grow">{sentence ? banner.message : <><strong>{name}</strong> {banner.message}. Their server may be busy; you can switch for now.</>}</span>
      <Button size="sm" onClick={onRetry}>Try again</Button>
      <Button size="sm" variant="primary" onClick={() => onUse("auto")}>Use {AUTO_NAME}</Button>
      {banner.imagery === "naip" && keys.esri_key && <Button size="sm" variant="primary" onClick={() => onUse("esri", true)}>Use Esri</Button>}
      {streetMap && banner.imagery !== "street" && <Button size="sm" onClick={() => onUse("street", true)}>Street map</Button>}
    </div>
  );
}

function OutsideUs({
  place, hasEsri, isAdmin, streetMap, onUse, onClose,
}: {
  place: string;
  hasEsri: boolean;
  isAdmin: boolean;
  streetMap: boolean;
  onUse: (id: ImageryChoice) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onClose={onClose} title="This address is outside the US" description={place} size="sm">
      <div className="dialog-body stack">
        <p style={{ margin: 0 }}>The free US imagery only covers the lower 48 states, so the map would be blank there.</p>
        {hasEsri ? (
          <p className="muted" style={{ margin: 0 }}>Esri World Imagery covers it, and your company has Esri set up.</p>
        ) : isAdmin ? (
          <p className="muted" style={{ margin: 0 }}>
            For aerial imagery here, add a free Esri key in Settings › Maps. It takes about five minutes and opens in a new tab, so nothing here is lost. Until then you
            can draw on the street map.
          </p>
        ) : (
          <p className="muted" style={{ margin: 0 }}>Ask an admin to add a free Esri key in Settings › Maps for aerial imagery here. Until then you can draw on the street map.</p>
        )}
        <div className="form-actions">
          {hasEsri ? (
            <Button variant="primary" onClick={() => onUse("esri")}>Use Esri World Imagery</Button>
          ) : (
            isAdmin && <Link className="btn btn-primary" to="/settings?tab=maps" target="_blank" rel="noreferrer">Set up Esri</Link>
          )}
          {streetMap && <Button onClick={() => onUse("street")}>Use the street map</Button>}
          <Button variant="ghost" onClick={onClose}>Keep this imagery</Button>
        </div>
      </div>
    </Dialog>
  );
}
