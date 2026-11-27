/**
 * Measure on aerial imagery: draw areas, lines and counts and see their sizes as you go (the server
 * recomputes them on save), cut the house or a bed out of an area, keep a picture of the drawing,
 * and put it on a quote or invoice for the client. For roofs, each section can have its own pitch
 * (picked, read from USGS lidar, or measured with a phone or a photo: RoofPitch.tsx) and lines can
 * be marked as eaves, rakes, ridges, hips and valleys. The map opens on Auto: Google satellite when
 * the company added its own Google key in Settings > Maps, else the state's own imagery where it has
 * some, else US aerial (NAIP), else USGS, else (outside the US) Esri with a key from Settings > Maps,
 * or the street map. Anyone can pick a source themselves instead, from the Imagery button, and make
 * it what Measure opens on (an admin can set that for the whole team in Settings > Maps). On a phone
 * or tablet the map can fill the screen (lib/extendMap).
 */
import { addressLabels } from "@crewtavo/core/countries";
import { inBounds, stateImagery, stateImageryAt, type StateImagery } from "@crewtavo/core/imagery";
import { drawingSquares, edgeLengths, isPitch, isRoofEdge, lineLengthM, mToFt, normalizePitch, pitchFactor, pitchProblem, ROOF_EDGES, summarizeFeatureCollection, type Feature, type GroundSlope, type Position, type RoofEdge } from "@crewtavo/core/geo";
import { readSlope } from "@crewtavo/core/elevation";
import { drawingSlope, LAWN_ITEMS, LAWN_OFFER_TRADES, LAWN_TRADES, lawnItem, lawnQuantities, pickedSlope, SLOPE_CHOICE_IDS, SLOPE_CHOICES, type SlopeChoice } from "@crewtavo/core/lawn";
import { itemFits, PAVING_ITEMS, pavingItem, pavingQuantities, stallsAlong, takeoffItem, type PavingItem } from "@crewtavo/core/paving";
import { isReportRoof, REPORT_PROVIDER, ROOF_EDGE_COLORS } from "@crewtavo/core/roofing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker, useSearchParams } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { DecimalInput } from "@/components/ui/DecimalInput";
import { Dialog } from "@/components/ui/Dialog";
import { DetailHeader } from "@/components/ui/DetailPage";
import { Field, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { MetaLine } from "@/components/ui/InboxList";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Fact, Facts } from "@/components/ui/Section";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { useExtendedMap } from "@/lib/extendMap";
import { addressLine, companyCountry, formatNumber } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { AddressSearch, type ClientSuggestion, type PlaceSuggestion } from "./AddressSearch";
import { boxAround, buildingAt, buildingsIn, BuildingsError, buildingsOn, OSM_BUILDINGS_CREDIT } from "./buildings";
import { ShareDrawing, type DrawingRow } from "./drawings";
import { AUTO_NAME, choiceName, ELEVATION_CREDIT, imageryCredit, imageryInfo, imageryUsable, isImageryId, mapKeys, openingImagery, OVERLAYS, probeImagery, resolveAuto, setMyDefault, SLOPE_CLASSES, stateId, type ImageryChoice, type ImageryId, type OverlayId } from "./imagery";
import { imageryMenu, ImageryPicker, type ImageryPickerProps } from "./ImageryPicker";
import { helpSeen, markHelpSeen, MeasureHelp } from "./MeasureHelp";
import { drawnAs, itemAfterTool } from "./nextShape";
import { defaultNames, formatShapeValue, isDefaultName, MeasureMap, type MeasureMapHandle, type Shape, type Tool } from "./MeasureMap";
import { useTooLarge } from "../plans/UploadLimit";
import { isRoofingCompany } from "../roofing/data";
import { isSavedPlan, LineUpBanner, PlanCard, usePlanOnMap } from "./PlanOnMap";
import { FindInView } from "./FindInView";
import { googleElevationKey, readGoogleSlope } from "./googleElevation";
import { LawnAddOns } from "./LawnItems";
import { formatItemTotal, ItemSwatch, itemEntries, LAWN_MENU, PAVING_MENU, type AreaUnit, type ItemGroup } from "./PavingItems";
import { MeasurePitch, PitchPicker, pitchLabel, riseOf, STEEP_FROM } from "./RoofPitch";
import { EDGE_HINTS, RoofSteps } from "./RoofSteps";
import type { SheetInfo } from "./takeoffSheet";
import { LAWN_TAP, TAP_ITEMS, TapBanner, useTapOutline, type TapChoice } from "./TapOutline";
import { TakeoffList } from "./TakeoffList";
import { loadSettings } from "@/lib/companySettings";

const TOOLS: Array<{ tool: Tool; label: string; icon: IconName; key: string; what: string }> = [
  { tool: "select", label: "Select", icon: "pointer", key: "V", what: "Pick a shape to name it, change it or drag its corners" },
  { tool: "polygon", label: "Area", icon: "area", key: "A", what: "Lawns, roofs, lots, driveways" },
  { tool: "linestring", label: "Line", icon: "line", key: "L", what: "Edges, fences, curbs" },
  { tool: "point", label: "Count", icon: "pin", key: "C", what: "Trees, drains, posts" },
  { tool: "cutout", label: "Cut out", icon: "scissors", key: "X", what: "Leave out the house, a pool or a bed" },
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

/** The totals as formatNumber writes them, rolling to each new value as shapes are drawn. */
const WHOLE = { maximumFractionDigits: 0 };
const TENTHS = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
/**
 * A lawn's slope (readSlope, or readGoogleSlope outside the US) and the outline it was read for: SAVED
 * came with the drawing. No `reading` yet: still reading. `google`: Google was asked too.
 */
interface SlopeEntry { key: string; reading?: GroundSlope | null; failed?: boolean; google?: boolean }
const SAVED = "saved";

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
// Lawn tools for a business that isn't lawn care: on once someone opens Lawn, and kept on in this browser.
const LAWN_KEY = "crewtavo.measureLawn";
function savedLawn(): boolean {
  try {
    return localStorage.getItem(LAWN_KEY) === "on";
  } catch {
    return false;
  }
}
// House numbers stay on (or off) between visits too.
const HOUSE_NUMBERS_KEY = "crewtavo.measureHouseNumbers";
/** The panel beside the map (open or not), kept per browser. */
const PANEL_KEY = "crewtavo.measurePanel";
const WIDE = "(min-width: 901px)";
function savedHouseNumbers(): boolean {
  try {
    return localStorage.getItem(HOUSE_NUMBERS_KEY) !== "off";
  } catch {
    return true;
  }
}
const touchScreen = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

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
  // On a wide screen the map fills the page and the panel sits beside it, on its right.
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      return localStorage.getItem(PANEL_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const showPanel = (open: boolean) => {
    setPanelOpen(open);
    try {
      localStorage.setItem(PANEL_KEY, open ? "open" : "closed");
    } catch {
      /* nothing to remember it in */
    }
  };
  const panelShown = panelOpen || !wide;
  // Square feet or square yards, for the totals and the list.
  const [unit, setUnit] = useState<AreaUnit>("sqft");
  // A phone's sheet: its totals only, or pulled up to the whole list; and the search over the map.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [itemSearch, setItemSearch] = useState("");
  // On a phone or tablet the map can fill the whole screen; on a phone the panel waits underneath.
  const extend = useExtendedMap();

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
  // A shape's measured value as it was saved (a roof typed in from a report is made of these): kept
  // through a save, so opening such a measurement here and saving it doesn't lose its numbers.
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const [slopes, setSlopes] = useState<Record<string, SlopeEntry>>({});
  const slopesReading = useRef(new Set<string>());
  const [activeItem, setActiveItem] = useState<PavingItem | null>(null);
  // A roof edge picked to draw (RoofSteps.tsx): new lines become that edge.
  const [activeEdge, setActiveEdge] = useState<RoofEdge | null>(null);
  const [roofPitchOpen, setRoofPitchOpen] = useState(false);
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
  const [lawnOn, setLawnOn] = useState(savedLawn);
  const showLawn = (on: boolean) => {
    setLawnOn(on);
    try {
      localStorage.setItem(LAWN_KEY, on ? "on" : "off");
    } catch {
      /* remembered for this visit only */
    }
  };
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
        ? unwrap(await db.from("measurements").select("id, title, geojson, roof_pitch, waste_pct, property_id, request_id, quote_id, invoice_id, show_on_quote, show_on_invoice, snapshot_path, view, provider").eq("id", linkIds.measurement).maybeSingle())
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
        loadSettings(company.id),
      ]);
      let p = property ? unwrap(property) : null;
      if (p && (p.lat == null || p.lng == null)) {
        const hit = await api.post<Found>(`/properties/${p.id}/geocode`).catch(() => null);
        if (hit?.found) p = { ...p, lat: hit.lat!, lng: hit.lng! };
      }
      const q = quote ? unwrap(quote) : null;
      const r = request ? unwrap(request) : null;
      const inv = invoice ? unwrap(invoice) : null;
      const depot = (companyRow as { depot?: { lat: number; lng: number } }).depot ?? null;
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
    // A new drawing is named after the property until someone names it (a paving or roofing project's, after the project).
    const street = (params.has("paving") || params.has("roofing")) && ctx?.quote?.title ? ctx.quote.title : ctx?.property?.line1;
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
    // No map to fill the screen with: back to the page, which says why.
    if (mapState === "error") extend.setExtended(false);
    // On a phone the map always fills the screen, with the panel as a sheet over its foot.
    else if (!wide) extend.setExtended(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapState, wide]);

  // ----- What's drawn ---------------------------------------------------------------------------
  // Typed in from a report (roofing/flow/RoofReport.tsx), not drawn here: its shapes only carry the report's numbers.
  const fromReport = isReportRoof(context.data?.measurement);
  const names = useMemo(() => defaultNames(shapes.map((s) => ({ ...s, edge: edges[s.id], itemName: itemFits(items[s.id], s.kind) ? takeoffItem(items[s.id])?.name : null }))), [shapes, edges, items]);
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
            ...(measured[s.id] != null && s.kind !== "Cutout" ? { manual_value: measured[s.id] } : {}),
            ...(s.kind === "Area" && slopes[s.id]?.reading ? { slope: slopes[s.id].reading } : {}),
          },
        };
      }),
    [shapes, labels, names, depth, pitch, pitches, edges, items, fromOsm, measured, slopes],
  );
  // Same math the server uses on save (packages/core), so live numbers match stored ones.
  const summary = useMemo(() => summarizeFeatureCollection({ type: "FeatureCollection", features }, { pitch }), [features, pitch]);
  const sections = useMemo(() => new Map(summary.sections.map((s) => [s.feature_id, s])), [summary]);
  const depthIn = Number(depth) || 0;
  const pitchError = pitchProblem(summary, pitch);
  const squares = pitchError ? null : drawingSquares(summary, pitch, Number(waste || 0));
  const roofEdges = edgeLengths(summary);
  const cubicYards = depthIn ? (summary.total_area_sqft * (depthIn / 12)) / 27 : 0;
  // The asphalt areas only (every area, on a drawing that marks none as an item): not the concrete, gravel or patches.
  const asphaltTons = depthIn ? (pavingQuantities(summary.sections).asphalt_sqyd * depthIn * 110) / 2000 : 0;
  // With Roofing installed the roof tools show on every row; anyone else gets them once they set a pitch or an edge.
  const roofer = isRoofingCompany(company);
  const roofing = roofer || params.has("roofing") || roofOpen || Boolean(pitch.trim()) || Object.values(pitches).some(Boolean) || Object.keys(edges).length > 0;
  // The roof, step by step (RoofSteps.tsx), with Roofing installed and for a roof opened from Roofing.
  const roofSteps = roofer || params.has("roofing");
  const mapNames = useMemo(() => Object.fromEntries(shapes.map((s) => [s.id, labels[s.id]?.trim() || names[s.id]])), [shapes, labels, names]);
  const mapValues = useMemo(() => Object.fromEntries(summary.sections.map((s) => [s.feature_id, s.value])), [summary]);
  // Paving: the items panel shows with Paving installed, for a takeoff opened from Paving, or a drawing with items.
  const paving = featureOn(company.settings, "paving_app") || params.has("paving") || Object.values(items).some((i) => pavingItem(i));
  // Lawns: lawn items in the dock and the list, and each area's ground slope from USGS (readSlope), for
  // a lawn care business, a drawing with lawn items or a slope, and anyone who opens Lawn under the
  // list. The slope is read once the drawing settles and again when the area or a cutout changes; one
  // opened with the drawing keeps what was saved.
  const lawnTrade = LAWN_TRADES.has(company.trade_preset ?? "");
  const lawnDrawing = Object.values(items).some((i) => lawnItem(i)) || summary.sections.some((s) => s.slope);
  const lawn = !roofing && (lawnTrade || lawnDrawing || lawnOn);
  const slopeKeys = useMemo(() => {
    const cuts = JSON.stringify(shapes.filter((s) => s.kind === "Cutout").map((s) => s.geometry));
    return Object.fromEntries(shapes.filter((s) => s.kind === "Area").map((s) => [s.id, JSON.stringify(s.geometry) + cuts]));
  }, [shapes]);
  // Outside the US, with slope from Google turned on (Settings > Maps): Google's heights, asked only
  // while the map shows Google satellite, as Google's terms want.
  const googleSlopeKey = imagery === "google" ? googleElevationKey(company.settings) : null;
  useEffect(() => {
    if (!lawn) return;
    // A lawn opened with the drawing, or picked by hand, keeps its slope through a change; one USGS
    // had nothing for is asked of Google once Google satellite shows.
    const changed = Object.entries(slopeKeys).filter(([id, key]) => slopes[id]?.key !== key || (googleSlopeKey && slopes[id]?.reading === null && !slopes[id]?.google));
    if (changed.length) setSlopes((all) => ({ ...all, ...Object.fromEntries(changed.map(([id, key]) => [id, all[id]?.key === SAVED || all[id]?.reading?.picked ? { ...all[id], key } : { key }])) }));
  }, [lawn, slopeKeys, slopes, googleSlopeKey]);
  useEffect(() => {
    const waiting = Object.entries(slopes).filter(([id, e]) => e.reading === undefined && !e.failed && slopeKeys[id] === e.key && !slopesReading.current.has(e.key));
    if (!waiting.length) return;
    const timer = setTimeout(() => {
      const cutouts = shapes.flatMap((s) => (s.kind === "Cutout" && s.geometry ? [s.geometry] : []));
      for (const [id, { key }] of waiting) {
        const area = shapes.find((s) => s.id === id)?.geometry;
        if (!area) continue;
        slopesReading.current.add(key);
        const done = (entry: SlopeEntry) => {
          slopesReading.current.delete(key);
          setSlopes((all) => (all[id]?.key === key ? { ...all, [id]: entry } : all));
        };
        const google = googleSlopeKey;
        const asked = google ? { google: true } : {};
        readSlope(area, cutouts)
          .then((reading) => (reading === null && google ? readGoogleSlope(google, area, cutouts) : reading))
          .then((reading) => done({ key, reading, ...asked }), () => done({ key, failed: true, ...asked }));
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [slopes, slopeKeys, shapes, googleSlopeKey]);
  const groundSlope = drawingSlope(summary);
  const bedSqft = lawn ? Number(lawnQuantities(summary.sections).bed_sqft) : 0;
  const bedYards = (bedSqft * depthIn) / 12 / 27;
  // The items a shape can be: a lawn's, paving's, or both.
  const itemGroups: ItemGroup[] = [...(lawn ? LAWN_MENU : []), ...(paving ? PAVING_MENU : [])];
  const itemGeometry = (kind: Shape["kind"]) => (kind === "Area" ? "area" : kind === "Cutout" ? "cutout" : kind === "Length" ? "line" : "count");
  const hasItemsFor = (kind: Shape["kind"]) => itemGroups.some((g) => g.items.some((i) => i.geometry === itemGeometry(kind)));
  // Paving items and roof edges show in their own colors, the ones the legend and the sheet use.
  const mapColors = useMemo(
    () => ({
      ...Object.fromEntries(Object.entries(edges).map(([id, edge]) => [id, ROOF_EDGE_COLORS[edge]])),
      ...Object.fromEntries(Object.entries(items).flatMap(([id, item]) => (takeoffItem(item) ? [[id, takeoffItem(item)!.color]] : []))),
    }),
    [items, edges],
  );
  const mapNotes = useMemo(
    () => Object.fromEntries(summary.sections.flatMap((s) => (s.item === "stall_row" ? [[s.feature_id, `${stallsAlong(s.value)} stalls`]] : []))),
    [summary],
  );
  const signature = JSON.stringify([shapes.map((s) => [s.kind, s.geometry]), shapes.map((s) => labels[s.id] ?? ""), title, depth, pitch, waste, pitches, edges, items, fromOsm, shapes.map((s) => slopes[s.id]?.reading ?? null)]);
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
    setItems(Object.fromEntries(ids.flatMap((id, i) => (takeoffItem(kept[i]?.properties?.item) ? [[id, String(kept[i]!.properties!.item)]] : []))));
    setMeasured(Object.fromEntries(ids.flatMap((id, i) => {
      const value = kept[i]?.properties?.manual_value;
      return typeof value === "number" && value >= 0 ? [[id, value]] : [];
    })));
    setSlopes(Object.fromEntries(ids.flatMap((id, i) => {
      const slope = kept[i]?.properties?.slope;
      return slope && typeof slope === "object" ? [[id, { key: SAVED, reading: slope as GroundSlope }]] : [];
    })));
    ids.forEach((id) => knownIds.current.add(id));
    setFromOsm(ids.filter((_, i) => kept[i]?.properties?.source === "openstreetmap"));
    baseline.current = ids.length;
    // A drawing reopened starts on Select, its totals in view, rather than ready to draw another shape.
    setTool("select");
    mapRef.current?.setTool("select");
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
      if (!r.found) {
        const words = addressLabels(companyCountry());
        throw new Error(`Couldn't find "${address}". Try adding the city and ${words.regionOptional ? words.postalCodeInText : words.regionInText}, or the country.`);
      }
      return r;
    },
    onSuccess: (r) => {
      setSearchOpen(false);
      // Somewhere else now, so the drawing is no longer for a client picked earlier.
      unpick();
      goTo({ lat: r.lat!, lng: r.lng!, zoom: 19, country: r.country ?? null, place: r.formatted ?? "This address" });
    },
  });
  /**
   * Move the map to a place found by search or picked from the suggestions. `keepImagery`: leave
   * the imagery as it is (a place Google found stays on Google's tiles).
   */
  const goTo = (to: { lat: number; lng: number; zoom: number; country: string | null; place: string }, keepImagery = false) => {
    mapRef.current?.jumpTo(to.lng, to.lat, to.zoom);
    if (keepImagery) return;
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
    setSearchOpen(false);
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
    // In the property's country: its business's unless it says otherwise.
    goTo({ ...at, zoom: 19, country: s.country ?? companyCountry(), place: s.label });
  };
  /** The drawing is no longer for the client picked earlier (and loses their address as its name). */
  const unpick = () => {
    if (!picked) return;
    setTitle((t) => (t === picked.label ? "Measurement" : t));
    setPicked(null);
  };
  const pickPlace = (s: PlaceSuggestion) => {
    find.reset();
    setSearchOpen(false);
    const place = [s.label, s.detail].filter(Boolean).join(", ");
    // Where Google says a place is moves only a map showing Google's tiles. On any other imagery
    // (it changed while Google was answering), the words are looked up with the free geocoder.
    if (s.from === "google" && imagery !== "google") return find.mutate(place);
    unpick();
    goTo({ lat: s.lat, lng: s.lng, zoom: s.kind === "address" ? 19 : s.kind === "street" ? 17 : 15, country: s.country, place }, s.from === "google");
  };
  const locate = () => {
    if (!window.isSecureContext) return toast.error("Browsers only share your location with HTTPS pages. Open Crewtavo at its https:// address, or search for the address.");
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
    // A plain tool draws plain shapes; cutting out an island keeps the item picked, but not a bed (nextShape.ts).
    setActiveItem((item) => itemAfterTool(item, next));
    setActiveEdge(null);
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
  /** Draw a paving or lawn item: its tool, and new shapes become it. Null goes back to plain shapes. */
  const pickItem = (item: PavingItem | null) => {
    tap.stop();
    setActiveEdge(null);
    setActiveItem(item);
    if (!item) return;
    const next: Tool = item.geometry === "area" ? "polygon" : item.geometry === "cutout" ? "cutout" : item.geometry === "line" ? "linestring" : "point";
    setTool(next);
    mapRef.current?.setTool(next);
    setSelected(null);
  };
  /** Draw a roof edge: lines drawn now become it. Null goes back to plain lines. */
  const pickEdge = (edge: RoofEdge | null) => {
    tap.stop();
    setActiveItem(null);
    setActiveEdge(edge);
    if (!edge) return;
    setTool("linestring");
    mapRef.current?.setTool("linestring");
    setSelected(null);
  };
  /**
   * Shapes just drawn while an item or a roof edge was picked become that item or edge. Not the ones
   * put on the map for the person (Find's outlines and holes, OpenStreetMap's buildings): a house cut
   * out while Bed is picked is no bed.
   */
  const onShapes = (next: Shape[], inProgress: Shape | null) => {
    const fresh = next.filter((s) => !knownIds.current.has(s.id));
    fresh.forEach((s) => knownIds.current.add(s.id));
    const tagged = drawnAs(fresh, activeItem);
    if (Object.keys(tagged).length) setItems((list) => ({ ...list, ...tagged }));
    if (activeEdge) {
      const lines = fresh.filter((s) => s.kind === "Length" && !s.byCode);
      if (lines.length) setEdges((list) => ({ ...list, ...Object.fromEntries(lines.map((s) => [s.id, activeEdge])) }));
    }
    setShapes(next);
    setDrawing(inProgress);
  };
  /** Shapes Find added, as the items it found them as (a lawn is a plain area; `osm` when OpenStreetMap's buildings shaped them). */
  const addFound = (ids: string[], item: string, osm = false) => {
    ids.forEach((id) => knownIds.current.add(id));
    if (takeoffItem(item)) setItems((list) => ({ ...list, ...Object.fromEntries(ids.map((id) => [id, item])) }));
    if (osm) setFromOsm((list) => [...list, ...ids]);
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
  /** The building in the middle of the map as a roof section. Quiet when it's tried on its own, as a new roof opens. */
  const outlineBuilding = async (quiet = false) => {
    const view = mapRef.current?.view();
    if (!view) return;
    if (view.zoom < 16) return void (quiet || toast.info("Zoom in until the building fills most of the map, then try again."));
    const [lng, lat] = view.center;
    const d = 0.0007;
    setFinding("outline");
    try {
      const loaded = mapRef.current?.buildings();
      const building = (loaded && buildingAt(loaded, [lng, lat])) || buildingAt(await buildingsIn([lng - d, lat - d, lng + d, lat + d]), [lng, lat]);
      if (!building) return void (quiet || toast.info("OpenStreetMap has no outline for the building in the middle of the map. Draw the roof with Area."));
      const ids = mapRef.current?.add([building], "Area") ?? [];
      if (!ids.length) return void toast.error("That building's outline couldn't be added. Draw the roof with Area.");
      setFromOsm((list) => [...list, ...ids]);
      toast.success("Added the building's outline. It follows the walls, so drag the corners out to the eaves (often 1 to 2 ft).");
    } catch (error) {
      if (!quiet) toast.error(error instanceof BuildingsError ? error.message : "Couldn't look up the building. Try again.");
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
      // A menu or a dialog that's open takes its own keys (a menu's letters pick its items).
      if (e.target instanceof Element && e.target.closest('[role="menu"], dialog')) return;
      if (tap.item && e.key === "Escape") return void tap.done();
      if (tap.item && e.key === "Enter" && tap.mode === "box" && tap.box) return void tap.outlineBox();
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
      else if (e.key.toLowerCase() === "b" && (paving || lawn)) startFind();
      else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        removeSelected();
      } else if (e.key === "?") setHelp(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ----- Leaving with unsaved shapes, or unsaved changes to the plan open in the viewer -----------
  // The one check for both: the viewer leaves it to this one (the router heeds only one at a time).
  const planTitle = plan.shown?.file.title ?? "the plan";
  const leaveBody = useRef("");
  leaveBody.current =
    dirty && plan.viewerDirty
      ? `The shapes you drew since the last save, and your changes to ${planTitle}, will be lost.`
      : plan.viewerDirty
        ? `Your changes to ${planTitle} will be lost.`
        : "The shapes you drew since the last save will be lost.";
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (dirty || plan.viewerDirty) && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    confirm({ title: "Leave without saving?", body: leaveBody.current, confirmLabel: "Leave", danger: true }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker]);
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => dirty && e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  // A takeoff opened from Paving (or a roof from Roofing) goes back to its project there, and on to the estimate.
  const pavingProject = params.has("paving") && ctx?.quote ? ctx.quote : null;
  const roofingProject = params.has("roofing") && ctx?.quote ? ctx.quote : null;
  const project = pavingProject ? { ...pavingProject, path: `/paving/${pavingProject.id}` } : roofingProject ? { ...roofingProject, path: `/roofing/${roofingProject.id}` } : null;
  const back = project
    ? { to: project.path, label: project.title || `Quote #${project.number}` }
    : ctx?.invoice
    ? { to: `/invoices/${ctx.invoice.id}`, label: `Invoice #${ctx.invoice.number}` }
    : ctx?.quote
      ? { to: `/quotes/${ctx.quote.id}`, label: `Quote #${ctx.quote.number}` }
      : ctx?.request
        ? { to: `/requests/${ctx.request.id}`, label: `Request #${ctx.request.number}` }
        : ctx?.property?.client
          ? { to: `/clients/${ctx.property.client.id}`, label: ctx.property.client.display_name }
          : null;

  /** The best free imagery here, for pictures Google's terms don't allow (the saved one, Find). */
  const freePicture = async (): Promise<ImageryId> => {
    if (!center) return "naip";
    const now = Date.now();
    return (await resolveAuto(center.lng, center.lat, 19, { esri_key: null, google_key: null }, (source) => probe(source, center.lng, center.lat), (source) => (down.current.get(source) ?? 0) > now)).id;
  };
  // Tap to outline (TapOutline.tsx): the free way to find paving or a lawn. Lining up a plan takes the taps.
  // Done (or Esc) goes over to Select, so the outline's corners can be fixed and a click doesn't start
  // a shape by mistake.
  const editShapes = () => {
    setActiveItem(null);
    setTool("select");
    mapRef.current?.setTool("select");
  };
  const tap = useTapOutline({ map: mapRef, imagery, pictureImagery: freePicture, onFound: addFound, onDone: editShapes });
  useEffect(() => {
    if (aligning) tap.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aligning]);
  /** What Find outlines: a lawn, the paving items that are areas, or both. */
  const findChoices: TapChoice[] = [...(lawn ? [{ id: LAWN_TAP, name: "Lawn" }] : []), ...(paving ? TAP_ITEMS : [])];
  /** Find: a box round a lot or a yard, then Outline, as the paving item picked (if it's an area), else a lawn for a lawn business or asphalt. */
  const startFind = () => {
    if (!findChoices.length) return;
    if (imagery === "street" || imagery === "terrain") return void toast.info(`Switch to aerial imagery first: Find needs a photo of the ${paving && !lawn ? "lot" : "yard"}.`);
    setSelected(null);
    if (tap.item) return void tap.setMode("box");
    tap.start(activeItem && findChoices.some((i) => i.id === activeItem.id) ? activeItem.id : lawn && (lawnTrade || !paving) ? LAWN_TAP : "asphalt");
  };
  // A new paving takeoff opens on Find paving: the box is the quickest way to measure a lot.
  const hasSaved = Boolean(((context.data?.measurement?.geojson ?? null) as { features?: unknown[] } | null)?.features?.length);
  const openedOnFind = useRef(false);
  useEffect(() => {
    if (openedOnFind.current || mapState !== "ready" || !context.data || !paving || aligning) return;
    openedOnFind.current = true;
    if (!hasSaved && imagery !== "street" && imagery !== "terrain") startFind();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapState, context.data, paving, aligning, hasSaved]);

  // A new roof opens on the building at the address, outlined from the map's buildings where they have it.
  const openedOnRoof = useRef(false);
  useEffect(() => {
    if (openedOnRoof.current || mapState !== "ready" || !context.data || !roofingProject || aligning) return;
    openedOnRoof.current = true;
    if (hasSaved || shapes.length) return;
    // A moment for the street tiles (and their buildings) to load under the map.
    const timer = setTimeout(() => void outlineBuilding(true), 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapState, context.data, roofingProject, aligning, hasSaved]);

  /** What the takeoff sheet under the saved picture says (takeoffSheet.ts). */
  const sheetInfo = (pictureOn: ImageryId): SheetInfo => {
    const place = ctx?.property ? addressLine(ctx.property) : picked?.label ?? null;
    const credit = [imageryCredit(pictureOn), overlays.length && pictureOn !== "terrain" ? ELEVATION_CREDIT : null, shapes.some((sh) => fromOsm.includes(sh.id)) ? OSM_BUILDINGS_CREDIT : null].filter(Boolean).join(" · ");
    const cut = summary.sections.reduce((t, s) => (s.kind === "Cutout" ? t + s.value : t), 0);
    const cutRow = cut > 0 ? [{ color: "#ef4444", label: "Cut out", value: `−${formatNumber(cut)} sq ft`, shape: "area" as const }] : [];
    const rowsFor = (catalog: readonly PavingItem[]) => catalog.filter((item) => summary.sections.some((s) => s.item === item.id)).map((item) => ({ color: item.color, label: item.name, value: formatItemTotal(summary.sections, item), shape: item.geometry === "cutout" ? ("area" as const) : item.geometry }));
    const itemRows = rowsFor(PAVING_ITEMS);
    const lawnRows = rowsFor(LAWN_ITEMS);
    let legend;
    if (itemRows.length) legend = [...itemRows, ...cutRow];
    else if (lawnRows.length) {
      // A lawn: its size and slope, its items, and what else was cut out (the house, the drive), not the beds again.
      const other = summary.sections.reduce((t, s) => (s.kind === "Cutout" && !s.item ? t + s.value : t), 0);
      legend = [
        { color: "#22c55e", label: groundSlope.slope_pct === null ? "Lawn" : `Lawn, ${formatNumber(groundSlope.slope_pct, 0)}% slope`, value: `${formatNumber(summary.total_area_sqft)} sq ft`, shape: "area" as const },
        ...lawnRows,
        ...(other > 0 ? [{ color: "#ef4444", label: "Cut out", value: `−${formatNumber(other)} sq ft`, shape: "area" as const }] : []),
      ];
    }
    else if (squares !== null) {
      // A roof: its squares, each section at its pitch, and the edges in their colors.
      const areas = summary.sections.filter((s) => s.kind === "Area");
      const atPitch = (s: (typeof areas)[number]) => s.value * pitchFactor(tidyPitch(s.pitch ?? "") || tidyPitch(pitch));
      legend = [
        { color: "#111827", label: `Roofing squares, ${waste || 0}% waste`, value: formatNumber(squares, 1), shape: "area" as const },
        ...(areas.length <= 6
          ? areas.map((s) => ({ color: shapes.find((sh) => sh.id === s.feature_id)?.color ?? "#999", label: `${nameOf(s.feature_id)} · ${pitchLabel(tidyPitch(s.pitch ?? "") || tidyPitch(pitch) || "0/12")}`, value: `${formatNumber(atPitch(s))} sq ft`, shape: "area" as const }))
          : [{ color: "#22c55e", label: "Roof", value: `${formatNumber(areas.reduce((t, s) => t + atPitch(s), 0))} sq ft`, shape: "area" as const }]),
        ...ROOF_EDGES.filter((e) => roofEdges[e] > 0).map((e) => ({ color: ROOF_EDGE_COLORS[e], label: EDGE_PLURALS[e], value: `${formatNumber(roofEdges[e])} ft`, shape: "line" as const })),
        ...cutRow,
      ];
    } else {
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
      if (roofingProject && squares === null) throw new Error("Set the roof's pitch first (Flat counts), so the estimate has its squares.");
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
        // A roof typed in from a report stays one while every shape still carries a typed-in number.
        provider: fromReport && shapes.length > 0 && shapes.every((s) => measured[s.id] != null) ? REPORT_PROVIDER : shown,
        roof_pitch: tidyPitch(pitch) || null,
        waste_pct: Math.min(100, Math.max(0, Number(waste || 0))),
        geojson: { type: "FeatureCollection", features },
        view: view
          ? { ...view, imagery: shown, mode: choice === "auto" ? "auto" : "manual", overlays, plan: plan.savedPlan ?? undefined, attribution: [imageryCredit(pictureOn), overlays.length && pictureOn !== "terrain" ? ELEVATION_CREDIT : null, shapes.some((sh) => fromOsm.includes(sh.id)) ? OSM_BUILDINGS_CREDIT : null].filter(Boolean).join(" · ") }
          : undefined,
        snapshot_path: snapshot,
      });
      return { result, snapshot, pictureProblem, swapped: pictureOn !== shown ? pictureOn : null, planSig };
    },
    onSuccess: ({ result, snapshot, pictureProblem, swapped, planSig: savedPlanSig }) => {
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
      // A replaced picture goes to the Trash by itself (out of sight there) and the server deletes it later.
      queryClient.invalidateQueries({ queryKey: ["measurements"] });
      if (ctx?.ids.quote) queryClient.invalidateQueries({ queryKey: ["quote", ctx.ids.quote] });
      if (ctx?.ids.request) queryClient.invalidateQueries({ queryKey: ["request", ctx.ids.request] });
      // The button turns to Saved where it was pressed; a toast only for what didn't go to plan.
      if (pictureProblem) toast.error("Saved, but the map picture couldn't be kept, so clients would see the sizes only. Save again to retry.");
      else if (swapped) toast.success(`The saved picture uses ${imageryInfo(swapped).name}, since Google's terms don't allow keeping pictures of its imagery.`);
    },
  });

  // ----- Render ---------------------------------------------------------------------------------
  if (context.error) {
    return (
      <div className="measure-page">
        <div className="measure-head">
          <DetailHeader title="Measure" />
          <EmptyState icon="map" title="Couldn't open this drawing" action={<Button onClick={() => context.refetch()}>Try again</Button>}>{(context.error as Error).message}</EmptyState>
        </div>
      </div>
    );
  }
  const p = ctx?.property;
  const rows = summary.sections.map((s, i) => ({ id: s.feature_id, kind: s.kind, value: s.value, unit: s.unit, color: shapes[i]?.color ?? "#999" }));
  const counts = rows.filter((r) => r.kind === "Count").length;
  const lawnAreas = rows.filter((r) => r.kind === "Area");
  /** A lawn's slope as its row (`always` false: only with more than one lawn) and its card say it. */
  const shapeSlope = (id: string, always: boolean): React.ReactNode => {
    const entry = slopes[id];
    const slope = sections.get(id)?.slope;
    if (!lawn || !entry) return null;
    if (entry.failed) return <button type="button" className="link-btn" onClick={() => setSlopes((all) => ({ ...all, [id]: { key: slopeKeys[id] } }))}>Slope didn't load. Try again</button>;
    if (entry.reading === undefined) return "Reading the slope…";
    if (entry.reading === null) return always ? "No slope reading here" : "No slope reading here: pick one in its menu";
    if (slope?.picked) return `${SLOPE_CHOICES[slope.picked].label}, picked by hand`;
    return (always || lawnAreas.length > 1) && slope ? `${formatNumber(slope.mean_pct, 0)}% slope, ${formatNumber(slope.steep_pct, 0)}% steep${slope.from === "google" ? " (Google)" : ""}` : null;
  };
  /** A lawn's slope picked by hand where none could be read, or null to clear it. */
  const pickSlope = (id: string, choice: SlopeChoice | null) =>
    setSlopes((all) => ({ ...all, [id]: choice ? { key: slopeKeys[id], reading: pickedSlope(choice) } : { key: slopeKeys[id], reading: null, google: true } }));
  const canPickSlope = (id: string) => lawn && Boolean(slopes[id]) && (Boolean(slopes[id].failed) || slopes[id].reading === null || Boolean(slopes[id].reading?.picked));
  const slopeEntries = (id: string): MenuEntry[] => {
    const picked = slopes[id]?.reading?.picked;
    return [
      ...SLOPE_CHOICE_IDS.map((c): MenuEntry => ({ label: SLOPE_CHOICES[c].label, description: SLOPE_CHOICES[c].hint, checked: picked === c, onSelect: () => pickSlope(id, c) })),
      ...(picked ? [{ separator: true } as MenuEntry, { label: "Clear it", onSelect: () => pickSlope(id, null) }] : []),
    ];
  };
  // The totals' Slope: the drawing's, or why there's none yet.
  const slopeNote = !lawnAreas.length
    ? "Draw the lawn"
    : lawnAreas.some((r) => slopes[r.id]?.failed)
      ? "Didn't load"
      : lawnAreas.some((r) => slopes[r.id] && slopes[r.id].reading === undefined)
        ? "Reading…"
        : lawnAreas.some((r) => slopes[r.id]?.reading === null)
          ? "US only"
          : groundSlope.steep_pct !== null
            ? `${formatNumber(groundSlope.steep_pct, 0)}% steep`
            : "";
  const cutTotal = summary.sections.reduce((t, s) => (s.kind === "Cutout" ? t + s.value : t), 0);
  // Each roof section at the pitch it's measured at, for the squares line and the breakdown.
  const roofSections = summary.sections.filter((s) => s.kind === "Area").map((s) => ({ id: s.feature_id, label: nameOf(s.feature_id), sqft: s.value, pitch: tidyPitch(s.pitch ?? "") || tidyPitch(pitch) }));
  const roofPitches = [...new Set(roofSections.map((r) => r.pitch))];
  const sectionSquares = (sqft: number, at: string) => (sqft * pitchFactor(at) * (1 + Number(waste || 0) / 100)) / 100;
  const near = center ? { lat: center.lat, lng: center.lng } : null;
  // The roof sections drawn, for reading their pitch from lidar.
  const roofOutlines = shapes.filter((s) => s.kind === "Area" && s.geometry?.type === "Polygon").map((s) => ({ id: s.id, name: nameOf(s.id), ring: (s.geometry!.coordinates as Position[][])[0] }));
  const hasEdges = ROOF_EDGES.some((e) => roofEdges[e] > 0);
  const savedClean = !dirty && Boolean(saved);
  // What the map needs from you (sharper imagery, tap to outline, lining up a plan): over the map,
  // or on a phone's page right under it, where it doesn't cover the map it's about.
  const mapBanner = aligning ? <LineUpBanner plan={plan} /> : tap.item ? <TapBanner tap={tap} choices={findChoices} /> : banner && <ImageryBanner banner={banner} keys={keys} isAdmin={isAdmin} streetMap={streetMap} onUse={chooseImagery} onDismiss={(key) => { setDismissed((d) => [...d, key]); setBanner(null); }} onRetry={() => { probes.current.clear(); setBanner(null); setImageryRevision((n) => n + 1); }} />;
  const bannerOnMap = wide || extend.extended;
  // A phone's Measure is the map, full screen: its own bar over the top, the panel as a sheet.
  const phone = !wide && extend.extended;
  // The sheet follows a finger on its head: up for the whole panel, down for the totals. A tap on the handle still switches.
  const pull = useRef<{ pointer: number; y: number; from: number; moved: boolean } | null>(null);
  const pulled = useRef(false);
  const sheetPull = {
    onPointerDown(e: React.PointerEvent<HTMLElement>) {
      if (e.button !== 0 || (e.target as Element).closest("button:not(.measure-sheet-grab), a, input, select, textarea")) return;
      const panel = e.currentTarget.closest<HTMLElement>(".measure-panel");
      if (panel) pull.current = { pointer: e.pointerId, y: e.clientY, from: panel.offsetHeight, moved: false };
    },
    onPointerMove(e: React.PointerEvent<HTMLElement>) {
      const p = pull.current;
      const panel = e.currentTarget.closest<HTMLElement>(".measure-panel");
      if (!p || p.pointer !== e.pointerId || !panel) return;
      const dy = e.clientY - p.y;
      if (!p.moved) {
        if (Math.abs(dy) < 6) return;
        p.moved = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        panel.dataset.pulling = "";
      }
      panel.style.height = `${Math.min(window.innerHeight - 70, Math.max(120, p.from - dy))}px`;
    },
    onPointerUp(e: React.PointerEvent<HTMLElement>) {
      const p = pull.current;
      pull.current = null;
      if (!p?.moved) return;
      const panel = e.currentTarget.closest<HTMLElement>(".measure-panel");
      if (panel) {
        panel.style.height = "";
        delete panel.dataset.pulling;
      }
      // The handle's click follows its pointer up: this was a pull, not a tap.
      pulled.current = true;
      setTimeout(() => (pulled.current = false), 0);
      const dy = e.clientY - p.y;
      if (Math.abs(dy) > 40) setSheetOpen(dy < 0);
    },
    onPointerCancel(e: React.PointerEvent<HTMLElement>) {
      pull.current = null;
      const panel = e.currentTarget.closest<HTMLElement>(".measure-panel");
      if (panel) {
        panel.style.height = "";
        delete panel.dataset.pulling;
      }
    },
  };
  const panelName = roofSteps ? "Roof" : paving ? "Takeoff" : "Measurement";
  const ready = mapState === "ready";
  const status = save.isPending ? "Saving…" : savedClean ? "Saved" : dirty ? "Unsaved changes" : null;
  const home = back ?? { to: "/", label: "Home" };

  // The quiet line beside the name: where it is, whose, and what it's for.
  const meta = p
    ? [addressLine(p), p.client?.display_name, ctx?.quote && `for quote #${ctx.quote.number}`, ctx?.invoice && `for invoice #${ctx.invoice.number}`].filter(Boolean).join(" · ")
    : picked
      ? [
          [`For ${picked.label}`, picked.client].filter(Boolean).join(" · "),
          !saved && <button key="unpick" type="button" className="link-btn" onClick={unpick}>Not for this client</button>,
        ]
      : undefined;
  const imageryProps: ImageryPickerProps | null = imagery
    ? { choice: choice ?? "auto", opening, showing: imagery, center, keys, isAdmin, streetMap, streetNames, houseNumbers, overlays, onPick: (next) => chooseImagery(next), onMakeDefault: makeDefault, onStreetNames: setStreetNames, onHouseNumbers: showHouseNumbers, onOverlay: toggleOverlay }
    : null;
  // A phone's bar has no room for the Imagery button: its choices are a sub menu of ⋯.
  const phoneImagery = phone && imageryProps ? imageryMenu(imageryProps) : null;
  const more: MenuEntry[] = [
    ...(phoneImagery ? [{ label: "Imagery", icon: "layers", end: phoneImagery.label, items: phoneImagery.items } satisfies MenuEntry, { separator: true } satisfies MenuEntry] : []),
    { label: "How to measure", icon: "help", kbd: "?", onSelect: () => setHelp(true) },
    { label: "Show all shapes", icon: "eye", kbd: "F", onSelect: () => mapRef.current?.fitShapes(), hidden: !shapes.length || !ready },
    { label: "Go to where I am", icon: "navigation", onSelect: locate, hidden: !ready || phone },
    { separator: true },
    { label: "Clear every shape", icon: "trash", danger: true, onSelect: () => void clearAll(), hidden: !shapes.length },
  ];
  // Saved and unchanged: a quiet "Saved" where the button was (a phone's green button comes back with the next change).
  const saveButton = savedClean ? (
    <span className="save-status measure-saved" data-state="saved" role="status"><Icon name="check" size={13} />Saved</span>
  ) : (
    <Button variant="primary" className={shapes.length ? undefined : "hide-mobile"} loading={save.isPending} disabled={!shapes.length || aligning} onClick={() => save.mutate()}>
      {saved ? "Save changes" : "Save measurement"}
    </Button>
  );
  const nameField = (className: string) => (
    <input
      className={className}
      aria-label="Name"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      maxLength={200}
      placeholder="Name this measurement"
      size={Math.min(40, Math.max(8, title.length + 1))}
    />
  );

  /** Picks a shape on the map, from the list (a phone's sheet drops back down, so the map and the shape's card show). */
  const showShape = (id: string) => {
    pickTool("select");
    mapRef.current?.select(id);
    setSheetOpen(false);
  };
  /** A shape's own menu: what it is (a takeoff item, a roof edge), its pitch, cut out or not, and delete. */
  const shapeMenu = (row: (typeof rows)[number]): MenuEntry[] => {
    const edge = edges[row.id];
    const at = (pitches[row.id] ?? "") || pitch;
    const item = itemFits(items[row.id], row.kind) ? takeoffItem(items[row.id]) : null;
    const entries: MenuEntry[] = [
      { label: "Show it on the map", icon: "pointer", onSelect: () => showShape(row.id) },
    ];
    if (hasItemsFor(row.kind)) {
      entries.push({ label: paving ? "Takeoff item" : "Lawn item", icon: paving ? "paving" : "mower", end: item?.name ?? "None", items: itemEntries({ current: item?.id ?? null, geometry: itemGeometry(row.kind), groups: itemGroups, none: paving ? "No takeoff item" : "Not a lawn item", onPick: (i) => setItem(row.id, i?.id ?? "") }) });
    }
    if (roofing && row.kind === "Length") {
      entries.push({
        label: "Roof edge",
        icon: "roofing",
        end: edge ? EDGE_NAMES[edge] : "None",
        items: [
          { label: "Not a roof edge", checked: !edge, onSelect: () => setEdge(row.id, "") },
          ...ROOF_EDGES.map((e) => ({ label: EDGE_NAMES[e], lead: <span className="paving-swatch" data-geometry="line" style={{ "--swatch": ROOF_EDGE_COLORS[e] } as React.CSSProperties} />, checked: edge === e, onSelect: () => setEdge(row.id, e) })),
        ],
      });
    }
    if (roofing && (row.kind === "Area" || slopedEdge(edge))) entries.push({ label: "Pitch", icon: "pitch", end: at.trim() ? pitchLabel(at) : "Not set", onSelect: () => setPitchFor(row.id) });
    if (row.kind === "Area" && canPickSlope(row.id)) {
      const picked = slopes[row.id]?.reading?.picked;
      entries.push({ label: "Slope", icon: "pitch", end: picked ? SLOPE_CHOICES[picked].label : "Not read", items: slopeEntries(row.id) });
    }
    if (row.kind === "Area" || row.kind === "Cutout") {
      entries.push(
        row.kind === "Cutout"
          ? { label: "Count it as an area again", icon: "area", onSelect: () => convert(row.id, "Area") }
          : { label: "Make it a cutout", icon: "scissors", description: "Leave it out of the areas under it", onSelect: () => convert(row.id, "Cutout") },
      );
    }
    entries.push({ separator: true }, { label: "Delete this shape", icon: "trash", danger: true, onSelect: () => mapRef.current?.remove(row.id) });
    return entries;
  };

  /** What a shape is under its name: its item or edge, stalls, what cutouts took, its pitch. */
  const shapeMeta = (row: (typeof rows)[number], nested: boolean) => {
    const section = sections.get(row.id);
    const edge = edges[row.id];
    const own = pitches[row.id] ?? "";
    const at = own || pitch;
    const showPitch = roofing && (row.kind === "Area" || slopedEdge(edge));
    const item = (paving || lawn) && itemFits(items[row.id], row.kind) ? takeoffItem(items[row.id]) : null;
    return [
      !nested && item?.name,
      row.kind === "Area" && shapeSlope(row.id, false),
      section?.item === "stall_row" && `${stallsAlong(section.value)} stalls`,
      row.kind === "Area" && section?.uncut_value !== undefined && `${formatNumber(section.uncut_value)} sq ft before cutouts`,
      row.kind === "Cutout" && (row.value > 0 ? "Left out of the areas under it" : "Not over an area, so nothing comes off"),
      showPitch && (
        <button type="button" className="measure-pitch-chip" data-own={own ? true : undefined} data-steep={(riseOf(at) ?? 0) >= STEEP_FROM || undefined} onClick={() => setPitchFor(row.id)} aria-label={`Pitch for ${nameOf(row.id)}: ${at.trim() ? pitchLabel(at) : "not set"}. Change it`}>
          <Icon name="pitch" size={12} />{at.trim() ? pitchLabel(at) : "Set pitch"}{!own && at.trim() ? " · roof" : ""}
        </button>
      ),
      section?.plan_value !== undefined && `${formatNumber(section.plan_value, 1)} ft from above`,
    ];
  };
  const shapeSize = (row: (typeof rows)[number]) =>
    row.kind === "Count" ? "1" : row.kind === "Cutout" ? `−${formatNumber(row.value)} sq ft` : row.kind === "Area" ? (unit === "sqyd" ? `${formatNumber(row.value / 9, 1)} sq yd` : `${formatNumber(row.value)} sq ft`) : `${formatNumber(row.value, 1)} ft`;

  /** A shape's row in the list: its swatch (shows it on the map), its name to type over, what it is, its size and its menu. */
  const shapeRow = (listRow: { id: string }, nested: boolean) => {
    const row = rows.find((r) => r.id === listRow.id)!;
    const name = nameOf(row.id);
    const item = itemFits(items[row.id], row.kind) ? items[row.id] : "";
    return (
      <div key={row.id} className="measure-shape" data-selected={selected === row.id || undefined} data-kind={row.kind} data-nested={nested || undefined}>
        <button type="button" className="measure-swatch" style={{ "--swatch": row.color } as React.CSSProperties} onClick={() => showShape(row.id)} aria-label={`Show ${name} on the map`} />
        <div className="measure-shape-body">
          <input
            className="measure-shape-name"
            aria-label={`Name for ${name}`}
            placeholder={`${names[row.id] ?? ""}${item ? "" : row.kind === "Area" ? " (e.g. Front lawn)" : row.kind === "Cutout" ? " (e.g. House)" : row.kind === "Length" && !roofing ? " (e.g. Fence)" : ""}`}
            value={labels[row.id] ?? ""}
            onChange={(e) => setLabels({ ...labels, [row.id]: e.target.value })}
            maxLength={80}
          />
          <MetaLine className="measure-shape-meta" parts={shapeMeta(row, nested)} />
        </div>
        <span className="measure-shape-value num" data-cut={row.kind === "Cutout" || undefined}>{shapeSize(row)}</span>
        <Menu items={shapeMenu(row)} label={`Actions for ${name}`} title={name} triggerClassName="btn btn-sm btn-ghost btn-icon measure-shape-menu" />
      </div>
    );
  };

  /** The shape picked on the map, in a card over its top right: its name, size, what it is, and what to do with it. */
  const pickedRow = tool === "select" && selected && !aligning && !tap.item ? rows.find((r) => r.id === selected) : undefined;
  const shapeCard = (row: (typeof rows)[number]) => {
    const name = nameOf(row.id);
    const edge = edges[row.id];
    const section = sections.get(row.id);
    const item = itemFits(items[row.id], row.kind) ? takeoffItem(items[row.id]) : null;
    const shape = shapes.find((s) => s.id === row.id);
    const ring = shape?.geometry?.type === "Polygon" ? (shape.geometry.coordinates as Position[][])[0] : null;
    const at = (pitches[row.id] ?? "") || pitch;
    const note =
      row.kind === "Area"
        ? [`${formatNumber(row.value / 9, 1)} sq yd`, ring && `${formatNumber(mToFt(lineLengthM(ring)))} ft around`, section?.uncut_value !== undefined && `${formatNumber(section.uncut_value)} before cutouts`, shapeSlope(row.id, true)]
        : row.kind === "Cutout"
          ? [row.value > 0 ? "Left out of the areas under it" : "Not over an area, so nothing comes off"]
          : row.kind === "Length"
            ? [section?.item === "stall_row" && `${stallsAlong(section.value)} stalls`, section?.plan_value !== undefined && `${formatNumber(section.plan_value, 1)} ft from above`]
            : ["Counted once"];
    return (
      <section className="measure-card" aria-label={name}>
        <div className="measure-card-head">
          <span className="measure-swatch measure-card-swatch" data-kind={row.kind} style={{ "--swatch": row.color } as React.CSSProperties} aria-hidden="true" />
          <input className="measure-card-name" aria-label="Shape name" placeholder={names[row.id]} value={labels[row.id] ?? ""} onChange={(e) => setLabels({ ...labels, [row.id]: e.target.value })} maxLength={80} />
          <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Done with this shape" title="Done with this shape" onClick={() => mapRef.current?.deselect()}><Icon name="x" size={15} /></button>
        </div>
        <div className="measure-card-size num">{shapeSize(row)}</div>
        <MetaLine className="measure-card-note" parts={note} />
        {hasItemsFor(row.kind) && (
          <div className="measure-card-row">
            <span>Item</span>
            <Menu
              items={itemEntries({ current: item?.id ?? null, geometry: itemGeometry(row.kind), groups: itemGroups, none: paving ? "No takeoff item" : "Not a lawn item", onPick: (i) => setItem(row.id, i?.id ?? "") })}
              label={`${paving ? "Takeoff" : "Lawn"} item for ${name}: ${item?.name ?? "none"}. Change it`}
              title={name}
              triggerClassName="measure-card-pick"
              trigger={<>{item && <ItemSwatch item={item} />}<span>{item?.name ?? "None"}</span><Icon name="chevronDown" size={14} /></>}
            />
          </div>
        )}
        {roofing && row.kind === "Length" && (
          <div className="measure-card-row">
            <span>Roof edge</span>
            <Menu
              items={[{ label: "Not a roof edge", checked: !edge, onSelect: () => setEdge(row.id, "") }, ...ROOF_EDGES.map((e) => ({ label: EDGE_NAMES[e], lead: <span className="paving-swatch" data-geometry="line" style={{ "--swatch": ROOF_EDGE_COLORS[e] } as React.CSSProperties} />, checked: edge === e, onSelect: () => setEdge(row.id, e) }))]}
              label={`Roof edge for ${name}: ${edge ? EDGE_NAMES[edge] : "none"}. Change it`}
              title={name}
              triggerClassName="measure-card-pick"
              trigger={<>{edge && <span className="paving-swatch" data-geometry="line" style={{ "--swatch": ROOF_EDGE_COLORS[edge] } as React.CSSProperties} />}<span>{edge ? EDGE_NAMES[edge] : "None"}</span><Icon name="chevronDown" size={14} /></>}
            />
          </div>
        )}
        {row.kind === "Area" && canPickSlope(row.id) && (
          <div className="measure-card-row">
            <span>Slope</span>
            <Menu
              items={slopeEntries(row.id)}
              label={`Slope for ${name}: ${slopes[row.id]?.reading?.picked ? SLOPE_CHOICES[slopes[row.id].reading!.picked!].label : "not read"}. Pick it`}
              title={name}
              triggerClassName="measure-card-pick"
              trigger={<><span>{slopes[row.id]?.reading?.picked ? SLOPE_CHOICES[slopes[row.id].reading!.picked!].label : "Pick it"}</span><Icon name="chevronDown" size={14} /></>}
            />
          </div>
        )}
        {roofing && (row.kind === "Area" || slopedEdge(edge)) && (
          <div className="measure-card-row">
            <span>Pitch</span>
            <button type="button" className="measure-card-pick" onClick={() => setPitchFor(row.id)}><Icon name="pitch" size={14} /><span>{at.trim() ? pitchLabel(at) : "Set it"}</span></button>
          </div>
        )}
        <div className="measure-card-actions">
          {(row.kind === "Area" || row.kind === "Cutout") && (
            <Button size="sm" icon={row.kind === "Cutout" ? "area" : "scissors"} onClick={() => convert(row.id, row.kind === "Cutout" ? "Area" : "Cutout")}>{row.kind === "Cutout" ? "Count it as an area" : "Make it a cutout"}</Button>
          )}
          <Button size="sm" variant="ghost" icon="trash" className="measure-card-delete" onClick={removeSelected}>Delete</Button>
        </div>
        {row.kind !== "Count" && <p className="measure-card-tip">Drag a corner to move it. Drag a small dot between corners to add one.</p>}
      </section>
    );
  };

  // What's being drawn, for the bar over the dock (and the phone's buttons).
  const drawItem = activeItem ?? null;
  const drawWhat = drawItem?.name ?? (activeEdge ? EDGE_NAMES[activeEdge] : tool === "cutout" ? "Cut out" : tool === "linestring" ? "Line" : tool === "point" ? "Count" : "Area");
  const drawColor = drawItem?.color ?? (activeEdge ? ROOF_EDGE_COLORS[activeEdge] : tool === "cutout" ? "#ef4444" : null);
  const drawSwatch = drawColor && <span className="paving-swatch" data-geometry={tool === "linestring" ? "line" : tool === "point" ? "count" : "area"} style={{ "--swatch": drawColor } as React.CSSProperties} aria-hidden="true" />;
  const drawSoFar = drawing ? `${formatShapeValue(drawing.kind, drawing.value) || (drawing.kind === "Length" ? "0 ft" : "0 sq ft")} so far` : "";
  const drawBar = drawing && tool !== "point" && (
    <div className="measure-drawbar" role="status" aria-live="polite">
      <div className="measure-drawbar-text">
        <span className="measure-drawbar-what">{drawSwatch}<strong>{drawWhat}</strong><span className="num">{drawSoFar}</span></span>
        <span className="measure-drawbar-how">{tool === "linestring" ? `Double-${touch ? "tap" : "click"}, or press Finish, to end it.` : touch ? "Tap the first corner, or press Finish, to close it." : "Click the first corner, or press Enter, to finish. Esc drops it."}</span>
      </div>
      <button type="button" className="measure-drawbar-btn" onClick={() => mapRef.current?.undo()} aria-label="Undo corner" title="Undo corner">{phone ? <Icon name="undo" size={16} /> : "Undo corner"}</button>
      <button type="button" className="measure-drawbar-btn" data-solid onClick={() => mapRef.current?.finish()}>Finish{!touch && <kbd>Enter</kbd>}</button>
      <button type="button" className="measure-drawbar-x" onClick={() => mapRef.current?.cancel()} aria-label="Stop drawing this shape" title={touch ? "Stop drawing this shape" : "Stop drawing this shape (Esc)"}><Icon name="x" size={16} /></button>
    </div>
  );

  /** What the next shape is (a takeoff or lawn item, or plain), as a menu on whatever `trigger` is. */
  const itemMenu = (triggerClassName: string, trigger: React.ReactNode) => (
    <Menu
      items={itemEntries({ current: activeItem?.id ?? null, search: itemSearch, groups: itemGroups, none: paving ? "Plain shapes, no takeoff item" : "Plain shapes, no lawn item", onPick: pickItem })}
      search={{ value: itemSearch, onChange: setItemSearch, placeholder: "Find an item", label: "Find an item" }}
      label={`Next shape: ${activeItem?.name ?? "a plain shape"}. Change the takeoff item`}
      title="Next shape"
      align="start"
      triggerClassName={triggerClassName}
      trigger={trigger}
    />
  );
  // Every drawing tool, in one dock at the foot of the map. On a phone the next shape's item is a round button at its left end, just the item's swatch.
  const dock = (
    <div className="measure-dock" role="toolbar" aria-label="Drawing tools">
      {itemGroups.length > 0 && (
        <>
          {phone
            ? itemMenu("measure-dock-chip", activeItem ? <ItemSwatch item={activeItem} /> : <Icon name={paving ? "paving" : "mower"} size={18} />)
            : itemMenu(
                "measure-dock-item",
                <>
                  {activeItem ? <ItemSwatch item={activeItem} /> : <Icon name={paving ? "paving" : "mower"} size={16} />}
                  <span className="measure-dock-item-text"><span>Next shape</span><strong>{activeItem?.name ?? "Plain"}</strong></span>
                  <Icon name="chevronDown" size={14} />
                </>,
              )}
          <span className="measure-dock-sep measure-dock-item-sep" aria-hidden="true" />
        </>
      )}
      {TOOLS.map((t) => (
        <button key={t.tool} type="button" className="measure-tool" aria-pressed={tool === t.tool && !tap.item && !(t.tool === "linestring" && activeEdge)} onClick={() => pickTool(t.tool)} title={touch ? t.what : `${t.label} (${t.key}): ${t.what}`}>
          <Icon name={t.icon} size={18} />
          <span>{t.label}</span>
        </button>
      ))}
      {roofSteps && (
        <div className="measure-dock-edges" role="group" aria-label="Roof edges">
          <span className="measure-dock-sep" aria-hidden="true" />
          {ROOF_EDGES.map((e) => (
            <button key={e} type="button" className="measure-tool" aria-pressed={activeEdge === e} onClick={() => pickEdge(activeEdge === e ? null : e)} title={`${EDGE_NAMES[e]}: draw along ${EDGE_HINTS[e]}`}>
              <span className="measure-tool-edge" style={{ "--swatch": ROOF_EDGE_COLORS[e] } as React.CSSProperties} aria-hidden="true" />
              <span>{EDGE_NAMES[e]}</span>
            </button>
          ))}
        </div>
      )}
      {(paving || lawn) && (
        <>
          <span className="measure-dock-sep" aria-hidden="true" />
          <button type="button" className="measure-tool measure-tool-find" aria-pressed={Boolean(tap.item)} onClick={startFind} title={`${!lawn ? "Find paving" : !paving ? "Find lawn" : "Find"}${touch ? "" : " (B)"}: put a box round ${!lawn ? "a lot" : !paving ? "the yard" : "a lot or yard"}, then press Outline`}>
            <Icon name="sparkle" size={18} />
            <span>Find</span>
          </button>
        </>
      )}
      <span className="measure-dock-sep" aria-hidden="true" />
      <button type="button" className="measure-tool" onClick={() => mapRef.current?.undo()} disabled={!history.undo && !drawing} title={touch ? "Undo" : "Undo (Ctrl+Z)"}>
        <Icon name="undo" size={18} /><span>Undo</span>
      </button>
      <button type="button" className="measure-tool measure-tool-redo" onClick={() => mapRef.current?.redo()} disabled={!history.redo} title={touch ? "Redo" : "Redo (Ctrl+Shift+Z)"}>
        <Icon name="redo" size={18} /><span>Redo</span>
      </button>
    </div>
  );

  const roofCard = (
    <details key="roof" className="measure-extra" open={roofing} onToggle={(e) => setRoofOpen(e.currentTarget.open)}>
      <summary>
        <Icon name="pitch" size={17} />
        <span className="measure-extra-text"><strong>Roof pitch and edges</strong><span>{squares !== null ? `${formatNumber(squares, 1)} squares` : "Roofing squares, drip edge, ridge cap"}</span></span>
        <Icon name="chevronDown" size={16} />
      </summary>
      <div className="measure-extra-body">
        <PitchPicker value={pitch} onChange={setPitch} />
        <MeasurePitch near={near} onPick={setPitch} roofs={roofOutlines} onPickSection={setShapePitch} />
        <Field label="Waste %" hint="About 10% for a plain gable roof, 15% or more with hips and valleys.">
          <DecimalInput className="input" inputMode="decimal" value={waste} onChange={(e) => setWaste(e.target.value.replace(/[^0-9.]/g, ""))} style={{ maxWidth: 120 }} />
        </Field>
        {hasEdges ? (
          <Facts label="Roof edges">
            {ROOF_EDGES.filter((e) => roofEdges[e] > 0).map((e) => <Fact key={e} label={EDGE_PLURALS[e]}>{formatNumber(roofEdges[e])} ft</Fact>)}
            <Fact label="Drip edge (eaves and rakes)">{formatNumber(roofEdges.eave + roofEdges.rake)} ft</Fact>
            {roofEdges.ridge + roofEdges.hip > 0 && <Fact label="Ridge cap (ridges and hips)">{formatNumber(roofEdges.ridge + roofEdges.hip)} ft</Fact>}
          </Facts>
        ) : (
          <p className="measure-quiet">
            {rows.some((r) => r.kind === "Length")
              ? "Mark your lines as eaves, rakes, ridges, hips or valleys from each one's menu to get drip edge and ridge cap lengths."
              : "Draw the roof's edges with Line, then mark each as an eave, rake, ridge, hip or valley for drip edge and ridge cap lengths. Rakes, hips and valleys are stretched by the pitch."}
          </p>
        )}
        <div className="measure-inline-action">
          <Button size="sm" icon="home" loading={finding === "outline"} disabled={Boolean(finding) || !ready} onClick={() => outlineBuilding()}>Outline the building in the middle</Button>
          <span className="measure-quiet">Starts the roof from OpenStreetMap's outline of the building in the middle of the map, where it has one.</span>
        </div>
      </div>
    </details>
  );
  const depthCard = (
    <details key="depth" className="measure-extra" open={Boolean(depth) && !depthIn}>
      <summary>
        <Icon name="ruler" size={17} />
        <span className="measure-extra-text"><strong>Depth</strong><span>{depthIn > 0 ? `${depthIn} in · ${bedSqft > 0 ? `${formatNumber(bedYards, 1)} cu yd of mulch in beds` : `${formatNumber(cubicYards, 1)} cu yd`}${paving ? ` · ${formatNumber(asphaltTons, 1)} tons of asphalt` : ""}` : "For mulch, gravel and asphalt"}</span></span>
        <Icon name="chevronDown" size={16} />
      </summary>
      <div className="measure-extra-body">
        <Field label="Depth (in)"><DecimalInput className="input" inputMode="decimal" value={depth} onChange={(e) => setDepth(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="2" style={{ maxWidth: 120 }} /></Field>
        {depthIn > 0 && summary.total_area_sqft > 0 && (
          <p className="measure-quiet">
            {bedSqft > 0
              ? `${formatNumber(bedYards, 1)} cu yd of mulch for ${formatNumber(bedSqft)} sq ft of beds at ${depthIn}".`
              : lawn
                ? `${formatNumber(cubicYards, 1)} cu yd at ${depthIn}".`
                : `${formatNumber(cubicYards, 1)} cu yd at ${depthIn}". Asphalt, about ${formatNumber(asphaltTons, 1)} tons at 110 lb per sq yd per inch.`}
          </p>
        )}
      </div>
    </details>
  );
  const lawnCard = (
    <details key="lawn" className="measure-extra" open={lawn} onToggle={(e) => { if (!lawnTrade && !lawnDrawing) showLawn(e.currentTarget.open); }}>
      <summary>
        <Icon name="mower" size={17} />
        <span className="measure-extra-text"><strong>Lawn</strong><span>{lawn && groundSlope.slope_pct !== null ? `${formatNumber(groundSlope.slope_pct, 0)}% slope · ${formatNumber(groundSlope.steep_pct ?? 0, 0)}% steep` : "Beds, edging, trees and the ground's slope"}</span></span>
        <Icon name="chevronDown" size={16} />
      </summary>
      <div className="measure-extra-body">
        <p className="measure-quiet"><strong>Find</strong> outlines the lawn: put a box round the yard. Mark beds, edging, trees and obstacles with {phone ? "the round button at the left of the tools" : "Next shape under the map"}. Each prices on its own, and so does the slope: read from USGS (US) or Google (if it's on in Settings), or picked on the lawn's card.</p>
        <LawnAddOns />
      </div>
    </details>
  );
  const planShown = Boolean(plan.shown || plan.plans.data?.length || plan.sending || company.trade_preset !== "lawn_exterior");

  return (
    <div className="measure-page m-grouped">
      <div className="measure-head">
        <DetailHeader
          crumb={back ? { to: back.to, label: back.label } : undefined}
          title={nameField("page-title measure-title")}
          documentTitle={title.trim() || "Measure"}
          meta={meta}
          actions={
            savedClean && project ? (
              <>
                {saveButton}
                <Link to={`${project.path}#estimate`} className="btn btn-primary">Open the estimate <Icon name="arrowRight" size={16} /></Link>
              </>
            ) : (
              <>
                {savedClean && back && <Link to={back.to} className="btn hide-mobile"><Icon name="arrowLeft" size={16} />Back to {back.label}</Link>}
                {saveButton}
              </>
            )
          }
          more={more}
          moreTitle={title || "Measure"}
        />
      </div>
      <div
        className="measure-stage"
        data-panel={panelShown ? "open" : "closed"}
        data-extended={extend.extended || undefined}
        data-sheet={sheetOpen ? "open" : "peek"}
        data-google={imagery === "google" || undefined}
      >
        {phone && (
          <div className="measure-topbar">
            <Link className="measure-round" to={home.to} aria-label={`Back to ${home.label}`}><Icon name="chevronLeft" size={20} /></Link>
            <div className="measure-topbar-title">
              {nameField("measure-topbar-name")}
              <span className="measure-topbar-status" data-state={savedClean ? "saved" : dirty ? "dirty" : undefined}>{status ?? (p ? addressLine(p) : "Not saved yet")}</span>
            </div>
            <button type="button" className="measure-round" aria-label="Search an address or client" aria-pressed={searchOpen} onClick={() => setSearchOpen(!searchOpen)}><Icon name="search" size={19} /></button>
            <button type="button" className="measure-round" aria-label="Go to where I am" disabled={!ready} onClick={locate}><Icon name="navigation" size={19} /></button>
            <Menu items={more} title={title || "Measure"} triggerClassName="measure-round" />
          </div>
        )}
        {mapState !== "error" && (!phone || searchOpen) && (
          <div className="measure-searchbar">
            <AddressSearch
              disabled={!ready}
              busy={find.isPending}
              near={center && center.zoom >= 8 ? center : null}
              onSubmit={(address) => find.mutate(address)}
              onPickClient={pickClient}
              onPickPlace={pickPlace}
              onEdit={() => find.isError && find.reset()}
              // Google's suggestions only while the map shows Google's tiles; OpenStreetMap's otherwise.
              google={imagery === "google"}
            />
          </div>
        )}
        {find.error && <div className="field-error measure-find-error" role="alert">{(find.error as Error).message}</div>}
        {mapState === "error" ? (
          <div className="measure-map-error">
            <EmptyState icon="map" title="The map isn't available" action={<div className="row" style={{ gap: 8 }}><Button onClick={() => window.location.reload()}>Reload</Button>{back && <Link className="btn" to={back.to}>Back to {back.label}</Link>}</div>}>{mapError}</EmptyState>
          </div>
        ) : (
          <div className="measure-map-wrap">
            {imageryProps && !phone && <div className="measure-imagery"><ImageryPicker {...imageryProps} /></div>}
            {mapState === "loading" && (
              <div className="measure-map-skeleton" aria-label="Loading map"><Skeleton height="100%" radius={0} /><span className="measure-map-loading"><span className="spinner" style={{ width: 14, height: 14 }} />Loading imagery…</span></div>
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
                // Clear of the search over the top and the dock at the foot (on a phone, its sheet too), so the middle is where the crosshair is.
                padding={wide ? { top: 64, right: 0, bottom: 88, left: 0 } : { top: 64, right: 0, bottom: 240, left: 0 }}
              />
            )}
            {ready && (
              <>
                {!aligning && dock}
                {!phone && <div className="measure-mapstack">
                  <div className="measure-mapgroup measure-zoom">
                    <button type="button" className="measure-round-btn" onClick={() => mapRef.current?.zoomIn()} aria-label="Zoom in" title="Zoom in"><Icon name="plus" size={17} /></button>
                    <button type="button" className="measure-round-btn" onClick={() => mapRef.current?.zoomOut()} aria-label="Zoom out" title="Zoom out"><Icon name="minus" size={17} /></button>
                  </div>
                  <div className="measure-mapgroup">
                    {shapes.length > 0 && <button type="button" className="measure-round-btn" onClick={() => mapRef.current?.fitShapes()} aria-label="Show all shapes" title={touch ? "Show all shapes" : "Show all shapes (F)"}><Icon name="eye" size={17} /></button>}
                    <button type="button" className="measure-round-btn" onClick={locate} aria-label="Go to where I am" title="Go to where I am"><Icon name="navigation" size={17} /></button>
                    {extend.available && wide && (
                      <button type="button" className="measure-round-btn" onClick={() => extend.setExtended(!extend.extended)} title={extend.extended ? "Back to the page" : "Fill the screen with the map"} aria-label="Full-screen map" aria-pressed={extend.extended}>
                        <Icon name={extend.extended ? "minimize" : "maximize"} size={17} />
                      </button>
                    )}
                  </div>
                </div>}
                {bannerOnMap && mapBanner}
                {overlays.includes("slope") && (
                  <div className="measure-legend" aria-label="Slope colors">
                    <strong>Slope</strong>
                    {SLOPE_CLASSES.map((c) => <span key={c.label}><i style={{ background: c.color }} />{c.label}<span className="measure-legend-note"> · {c.note}</span></span>)}
                  </div>
                )}
                {pickedRow
                  ? shapeCard(pickedRow)
                  : !aligning && !tap.item && drawBar}
                {capturing && <div className="measure-capturing" role="status"><span className="spinner" style={{ width: 16, height: 16 }} /> Saving a picture of the drawing…</div>}
                {center && center.zoom < 12 && !shapes.length && !banner && !aligning && (
                  <div className="measure-zoom-note">Search an address or zoom in to the property to start measuring.</div>
                )}
              </>
            )}
          </div>
        )}
        {ready && !bannerOnMap && mapBanner}
        <aside className="measure-panel" aria-label={panelName}>
          <div className="measure-panel-scroll">
            <div className="measure-panel-head" {...(phone ? sheetPull : {})}>
              {phone && <button type="button" className="measure-sheet-grab" aria-label={sheetOpen ? "Show less of the panel" : "Show the whole panel"} aria-expanded={sheetOpen} onClick={() => (pulled.current ? (pulled.current = false) : setSheetOpen(!sheetOpen))} />}
              <h2>{panelName}</h2>
              {(paving || rows.some((r) => r.kind === "Area")) && !roofSteps && (
                <div className="segmented measure-unit" role="group" aria-label="Show areas in">
                  <button type="button" aria-pressed={unit === "sqft"} onClick={() => setUnit("sqft")}>SF</button>
                  <button type="button" aria-pressed={unit === "sqyd"} onClick={() => setUnit("sqyd")}>SY</button>
                </div>
              )}
              {wide && <button type="button" className="btn btn-icon btn-sm btn-ghost" onClick={() => showPanel(false)} aria-label="Hide this panel" title="Hide this panel, for more map"><Icon name="chevronRight" size={16} /></button>}
              {phone && saveButton}
            </div>
            <FormError error={save.error} />
            {roofSteps ? (
              <RoofSteps
                sections={roofSections.map((r) => ({ id: r.id, label: r.label, pitch: r.pitch ? pitchLabel(r.pitch) : "", squares: pitchError ? null : sectionSquares(r.sqft, r.pitch) }))}
                planArea={summary.total_area_sqft}
                roofArea={squares !== null ? roofSections.reduce((t, r) => t + r.sqft * pitchFactor(r.pitch), 0) : null}
                pitch={roofPitches.length > 1 ? "Mixed pitches" : roofPitches[0] ? pitchLabel(roofPitches[0]) : ""}
                squares={squares}
                waste={waste}
                edges={roofEdges}
                activeEdge={activeEdge}
                outlining={finding === "outline"}
                ready={ready && !aligning}
                onOutline={() => outlineBuilding()}
                onDraw={() => pickTool("polygon")}
                onPitch={() => setRoofPitchOpen(true)}
                onSectionPitch={setPitchFor}
                onEdge={pickEdge}
                onWaste={setWaste}
                finish={
                  savedClean && project ? (
                    <Link to={`${project.path}#estimate`} className="btn btn-sm">Open the estimate <Icon name="arrowRight" size={14} /></Link>
                  ) : savedClean ? (
                    <span className="save-status" data-state="saved"><Icon name="check" size={13} />Saved</span>
                  ) : (
                    <Button size="sm" loading={save.isPending} disabled={!shapes.length || aligning} onClick={() => save.mutate()}>
                      {project ? "Save the roof" : saved ? "Save changes" : "Save measurement"}
                    </Button>
                  )
                }
              />
            ) : (
              <div className="measure-sum" role="group" aria-label="Totals">
                <div className="measure-fig">
                  <span className="measure-fig-label">Area</span>
                  <span className="measure-fig-value">{unit === "sqyd" ? <AnimatedNumber value={summary.total_area_sqyd} format={TENTHS} /> : <AnimatedNumber value={summary.total_area_sqft} format={WHOLE} />}<small>{unit === "sqyd" ? "sq yd" : "sq ft"}</small></span>
                  <span className="measure-fig-note">{unit === "sqyd" ? `${formatNumber(summary.total_area_sqft)} sq ft` : `${formatNumber(summary.total_area_sqyd, 1)} sq yd`}{summary.total_area_sqft >= 4356 ? ` · ${formatNumber(summary.total_area_sqft / 43_560, 2)} ac` : ""}</span>
                </div>
                <div className="measure-fig">
                  <span className="measure-fig-label">Length</span>
                  <span className="measure-fig-value"><AnimatedNumber value={summary.total_length_ft} format={WHOLE} /><small>ft</small></span>
                  {cutTotal > 0 && <span className="measure-fig-note">{formatNumber(cutTotal)} sq ft cut out</span>}
                </div>
                {squares !== null ? (
                  <div className="measure-fig">
                    <span className="measure-fig-label">Squares</span>
                    <span className="measure-fig-value"><AnimatedNumber value={squares} format={TENTHS} /></span>
                    <span className="measure-fig-note">{roofPitches.length > 1 ? "mixed" : roofPitches[0] ? pitchLabel(roofPitches[0]) : "flat"}, {waste || 0}% waste</span>
                  </div>
                ) : lawn ? (
                  <div className="measure-fig">
                    <span className="measure-fig-label">Slope</span>
                    <span className="measure-fig-value">{groundSlope.slope_pct === null ? "–" : <><AnimatedNumber value={groundSlope.slope_pct} format={WHOLE} /><small>%</small></>}</span>
                    {slopeNote && <span className="measure-fig-note">{slopeNote}</span>}
                  </div>
                ) : (
                  <div className="measure-fig">
                    <span className="measure-fig-label">Count</span>
                    <span className="measure-fig-value">{counts}</span>
                  </div>
                )}
              </div>
            )}

            <div className="measure-shapes">
              {rows.length === 0 ? (
                <p className="measure-empty">
                  Nothing drawn yet. Pick <strong>Area</strong>, <strong>Line</strong> or <strong>Count</strong> {phone ? "above" : "under the map"}, then {touch ? "tap" : "click"} each corner. <strong>Cut out</strong> leaves the house or a bed out of an area.
                </p>
              ) : (
                <TakeoffList rows={rows} sections={summary.sections} items={items} edges={edges} roofing={roofing} lawn={lawn} unit={unit} selected={selected} row={shapeRow} />
              )}
            </div>

            {pitchError && shapes.length > 0 && <div className="field-error" role="alert">{pitchError}</div>}
            {fromReport && shapes.some((s) => measured[s.id] != null) && (
              <div className="callout callout-info" role="note"><Icon name="info" size={16} /><span className="grow">These measurements were typed in from a report. The small shapes on the map only carry its numbers: change them from the roofing project's first step, or draw the roof here as a new measurement.</span></div>
            )}

            <div className="measure-extras">
              {lawnTrade && !roofing && lawnCard}
              {depthCard}
              {!roofSteps && roofCard}
              {/* Where it was when opened, so it doesn't jump: a business of another type's way in. */}
              {!lawnTrade && (lawn || (!roofing && !paving && LAWN_OFFER_TRADES.has(company.trade_preset || "general"))) && lawnCard}
              {planShown && (
                <details className="measure-extra" open={Boolean(plan.shown || plan.sending)}>
                  <summary>
                    <Icon name="map" size={17} />
                    <span className="measure-extra-text"><strong>Site plan on the map</strong><span>{plan.shown ? plan.shown.file.title : "Draw over a plan where the aerial is old"}</span></span>
                    <Icon name="chevronDown" size={16} />
                  </summary>
                  <div className="measure-extra-body">
                    <PlanCard plan={plan} canAdd={canAddPlans} hasPlace={Boolean(ctx?.ids.property || picked?.property_id || ctx?.ids.quote)} />
                  </div>
                </details>
              )}
              {rows.some((r) => r.kind === "Area") && (
                <div className="measure-row">
                  <Icon name="home" size={17} />
                  <span className="grow">Cut out buildings <span className="measure-row-meta">· OpenStreetMap</span></span>
                  <button type="button" className="link-btn" disabled={Boolean(finding)} onClick={cutBuildings}>{finding === "cut" ? "Finding…" : "Run"}</button>
                </div>
              )}
              {(paving || lawn) && (
                <FindInView
                  map={mapRef}
                  ready={ready && !aligning && !tap.item}
                  connected={Boolean(session.config.features.findPaving)}
                  isAdmin={isAdmin}
                  imagery={imagery}
                  pictureImagery={freePicture}
                  zoom={center?.zoom ?? 0}
                  paving={paving}
                  lawn={lawn}
                  lawns={shapes.filter((s) => s.kind === "Area" && s.geometry?.type === "Polygon" && !pavingItem(items[s.id])).map((s) => s.geometry!.coordinates as Position[][])}
                  onFound={addFound}
                />
              )}
            </div>
          </div>

          <footer className="measure-panel-foot">
            {saved ? (
              <ShareDrawing
                drawing={saved}
                clientId={ctx?.clientId ?? picked?.client_id ?? null}
                hasPicture={Boolean(saved.snapshot_path)}
                onChange={(patch) => setSaved((s) => (s ? { ...s, ...patch } : s))}
              />
            ) : (
              <p className="drawing-note">
                {ctx?.quote ? `Goes on quote #${ctx.quote.number} when you save it.` : ctx?.invoice ? `Goes on invoice #${ctx.invoice.number} when you save it.` : "Save it to put it on a quote or invoice."}
              </p>
            )}
          </footer>
        </aside>
        {!panelShown && (
          <button type="button" className="measure-panel-show" onClick={() => showPanel(true)} title="Show the panel: totals, what you drew, and where it's used">
            <Icon name="chevronLeft" size={16} />
            <strong>{panelName}</strong>
            <span className="measure-quiet num">{formatNumber(summary.total_area_sqft)} sq ft</span>
          </button>
        )}
      </div>

      <MeasureHelp open={help} touch={touch} onClose={() => { markHelpSeen(); setHelp(false); }} />
      {roofPitchOpen && (
        <Dialog open onClose={() => setRoofPitchOpen(false)} title="Roof pitch" description="The main roof's pitch. A porch or dormer at another pitch can have its own: pick it on the map, or tap its row under Set the pitch." size="md">
          <div className="dialog-body stack">
            <PitchPicker value={pitch} onChange={setPitch} />
            <MeasurePitch near={near} onPick={setPitch} roofs={roofOutlines} onPickSection={setShapePitch} />
            <div className="form-actions"><Button variant="primary" onClick={() => setRoofPitchOpen(false)}>Done</Button></div>
          </div>
        </Dialog>
      )}
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
    </div>
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
        <Icon name="image" size={16} />
        <span className="grow"><strong>Sharper imagery here.</strong> {s.name}'s free state imagery: {s.detail} · {s.flown}.</span>
        <Button size="sm" onClick={() => onUse(stateId(s))}>Use it</Button>
        <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => onDismiss(s.state)} aria-label="Not now"><Icon name="x" size={14} /></button>
      </div>
    );
  }
  if (banner.kind === "left-state") {
    return (
      <div className="measure-banner" role="status">
        <Icon name="info" size={16} />
        <span className="grow">{banner.state.name}'s imagery doesn't reach this spot.</span>
        <Button size="sm" onClick={() => onUse("auto")}>Use {AUTO_NAME}</Button>
        <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => onDismiss(`left:${banner.state.state}`)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
      </div>
    );
  }
  if (banner.kind === "empty") {
    return (
      <div className="measure-banner measure-banner-warn" role="alert">
        <Icon name="alert" size={16} />
        <span className="grow"><strong>No free US imagery here.</strong> It covers the lower 48 states. {keys.esri_key ? "Esri covers the rest of the world." : isAdmin ? "For aerial imagery anywhere, add a free Esri key." : "An admin can add a free Esri key in Settings for imagery anywhere."}</span>
        {keys.esri_key ? <Button size="sm" onClick={() => onUse("esri", true)}>Use Esri</Button> : settingsLink}
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
      <Button size="sm" onClick={() => onUse("auto")}>Use {AUTO_NAME}</Button>
      {banner.imagery === "naip" && keys.esri_key && <Button size="sm" onClick={() => onUse("esri", true)}>Use Esri</Button>}
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
