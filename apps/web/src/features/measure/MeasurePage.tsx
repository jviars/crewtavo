/**
 * Measure on satellite imagery: draw areas, lines and counts, see totals live (the server recomputes
 * them on save), and attach the measurement to a property, request or quote.
 */
import { Loader } from "@googlemaps/js-api-loader";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useBlocker, useNavigate, useSearchParams } from "react-router-dom";
import { TerraDraw, TerraDrawLineStringMode, TerraDrawPointMode, TerraDrawPolygonMode, TerraDrawSelectMode } from "terra-draw";
import { TerraDrawGoogleMapsAdapter } from "terra-draw-google-maps-adapter";
import { roofingSquares, summarizeFeatureCollection, type Feature } from "@crewtavo/core/geo";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { addressLine, formatNumber } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

type Mode = "polygon" | "linestring" | "point" | "select";
const MODES: Array<{ mode: Mode; label: string; icon: IconName; hint: string }> = [
  { mode: "polygon", label: "Area", icon: "area", hint: "Click each corner; click the first point (or double-click) to close the shape." },
  { mode: "linestring", label: "Line", icon: "line", hint: "Click along the edge; double-click to finish." },
  { mode: "point", label: "Count", icon: "pin", hint: "Click to drop a marker for each item (drains, posts, trees)." },
  { mode: "select", label: "Edit", icon: "pointer", hint: "Click a shape to select it, drag points to adjust, or delete it." },
];

interface SaveResult { id: string; total_area_sqft: number; total_area_sqyd: number; total_length_ft: number; roofing_squares: number | null }

const safeSquares = (areaSqft: number, pitch: string, wastePct: number) => {
  try {
    return roofingSquares(areaSqft, pitch, wastePct);
  } catch {
    return null; // pitch still being typed
  }
};
const editable = { feature: { draggable: true, coordinates: { midpoints: true, draggable: true, deletable: true } } };

export function MeasurePage() {
  const session = useSession();
  const { company } = session;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const propertyId = params.get("property");
  const quoteId = params.get("quote");
  const requestId = params.get("request");
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const [mode, setMode] = useState<Mode>("polygon");
  const [features, setFeatures] = useState<Feature[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [depth, setDepth] = useState("");
  const [pitch, setPitch] = useState("");
  const [waste, setWaste] = useState("10");
  const [title, setTitle] = useState("Measurement");
  const [mapState, setMapState] = useState<"loading" | "ready" | "error">("loading");
  const [mapError, setMapError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Where to start: the property (looked up and geocoded if needed), else the shop, else a default.
  const context = useQuery({
    queryKey: ["measure-context", propertyId, quoteId, requestId],
    queryFn: async () => {
      const db = supabase();
      const [property, quote, request, companyRow] = await Promise.all([
        propertyId ? db.from("properties").select("id, line1, city, region, postal_code, lat, lng, client:clients(id, display_name)").eq("id", propertyId).maybeSingle() : null,
        quoteId ? db.from("quotes").select("id, number, title").eq("id", quoteId).maybeSingle() : null,
        requestId ? db.from("requests").select("id, number, title").eq("id", requestId).maybeSingle() : null,
        db.from("companies").select("settings").eq("id", company.id).single(),
      ]);
      let p = property ? unwrap(property) : null;
      if (p && (p.lat == null || p.lng == null)) {
        const hit = await api.post<{ found: boolean; lat?: number; lng?: number }>(`/properties/${p.id}/geocode`).catch(() => null);
        if (hit?.found) p = { ...p, lat: hit.lat!, lng: hit.lng! };
      }
      const depot = ((unwrap(companyRow).settings ?? {}) as { depot?: { lat: number; lng: number } }).depot ?? null;
      return { property: p, quote: quote ? unwrap(quote) : null, request: request ? unwrap(request) : null, depot };
    },
  });
  const start = useMemo(() => {
    const lat = Number(params.get("lat"));
    const lng = Number(params.get("lng"));
    if (params.get("lat") && Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, zoom: 20 };
    const p = context.data?.property;
    if (p?.lat != null && p?.lng != null) return { lat: p.lat, lng: p.lng, zoom: 20 };
    if (context.data?.depot) return { lat: context.data.depot.lat, lng: context.data.depot.lng, zoom: 17 };
    return context.data ? { lat: 37.1318, lng: -80.5764, zoom: 16 } : null;
  }, [params, context.data]);

  useEffect(() => {
    const key = session.config.mapsBrowserKey;
    if (!key) {
      setMapState("error");
      setMapError("The map isn't turned on yet. Ask whoever set up Crewtavo to add a Google Maps key.");
      return;
    }
    if (!start) return;
    let cancelled = false;
    new Loader({ apiKey: key, version: "weekly" })
      .importLibrary("maps")
      .then(() => {
        if (cancelled || !mapEl.current) return;
        const map = new google.maps.Map(mapEl.current, {
          center: { lat: start.lat, lng: start.lng },
          zoom: start.zoom,
          mapTypeId: "satellite",
          tilt: 0,
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          gestureHandling: "greedy",
        });
        mapRef.current = map;
        google.maps.event.addListenerOnce(map, "tilesloaded", () => !cancelled && setMapState("ready"));
        // Terra Draw's Google adapter needs the map projection before start().
        map.addListener("projection_changed", () => {
          if (drawRef.current) return;
          const draw = new TerraDraw({
            adapter: new TerraDrawGoogleMapsAdapter({ lib: google.maps, map, coordinatePrecision: 9 }),
            modes: [
              new TerraDrawPolygonMode(),
              new TerraDrawLineStringMode(),
              new TerraDrawPointMode(),
              new TerraDrawSelectMode({ flags: { polygon: editable, linestring: editable, point: { feature: { draggable: true } } } }),
            ],
          });
          draw.start();
          draw.setMode("polygon");
          draw.on("change", () => setFeatures(draw.getSnapshot() as unknown as Feature[]));
          draw.on("select", (id) => setSelected(String(id)));
          draw.on("deselect", () => setSelected(null));
          drawRef.current = draw;
        });
      })
      .catch(() => {
        setMapState("error");
        setMapError("The map didn't load. Check your internet connection and reload the page.");
      });
    return () => {
      cancelled = true;
      drawRef.current?.stop();
      drawRef.current = null;
      mapRef.current = null;
    };
    // Start once per location; panning later uses the map directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.config.mapsBrowserKey, start?.lat, start?.lng]);

  useEffect(() => {
    drawRef.current?.setMode(mode);
    if (mode !== "select") setSelected(null);
  }, [mode]);

  // Same math the server uses on save (packages/core), so live numbers match stored ones.
  const summary = useMemo(() => summarizeFeatureCollection({ type: "FeatureCollection", features }), [features]);
  const rows = summary.sections.map((s) => ({ id: s.feature_id, kind: s.kind, value: s.value, unit: s.unit }));
  const depthIn = Number(depth) || 0;
  const squares = pitch ? safeSquares(summary.total_area_sqft, pitch, Number(waste || 0)) : null;
  const cubicYards = depthIn ? (summary.total_area_sqft * (depthIn / 12)) / 27 : 0;
  const asphaltTons = depthIn ? (summary.total_area_sqyd * depthIn * 110) / 2000 : 0;
  const dirty = features.length > 0 && !savedAt;

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    confirm({ title: "Leave without saving?", body: "The shapes you drew will be lost.", confirmLabel: "Leave", danger: true }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker]);
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => dirty && e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  const back = context.data?.quote
    ? { to: `/quotes/${context.data.quote.id}`, label: `Quote #${context.data.quote.number}` }
    : context.data?.request
      ? { to: `/requests/${context.data.request.id}`, label: `Request #${context.data.request.number}` }
      : context.data?.property?.client
        ? { to: `/clients/${context.data.property.client.id}`, label: context.data.property.client.display_name }
        : null;

  const save = useMutation({
    meta: { inline: true },
    mutationFn: () => {
      if (pitch && squares === null) throw new Error("Roof pitch should look like 7/12.");
      return api.post<SaveResult>("/measurements", {
        title: title.trim() || "Measurement",
        property_id: propertyId ?? undefined,
        request_id: requestId ?? undefined,
        quote_id: quoteId ?? undefined,
        provider: "google",
        roof_pitch: pitch.trim() || null,
        waste_pct: Math.min(100, Math.max(0, Number(waste || 0))),
        geojson: {
          type: "FeatureCollection",
          features: features.map((f) => ({
            type: "Feature",
            id: f.id,
            geometry: f.geometry,
            properties: { label: labels[String(f.id)]?.trim() || undefined, depth_in: depthIn || undefined, pitch: pitch || undefined },
          })),
        },
      });
    },
    onSuccess: (r) => {
      setSavedAt(new Date().toISOString());
      if (quoteId) queryClient.invalidateQueries({ queryKey: ["quote", quoteId] });
      if (requestId) queryClient.invalidateQueries({ queryKey: ["request", requestId] });
      toast.success(`Measurement saved: ${formatNumber(r.total_area_sqft)} sq ft${r.total_length_ft ? `, ${formatNumber(r.total_length_ft)} ft` : ""}`, back ? { action: { label: `Back to ${back.label}`, onClick: () => navigate(back.to) } } : undefined);
    },
  });

  const find = useMutation({
    meta: { inline: true },
    mutationFn: async (address: string) => {
      const r = await api.post<{ found: boolean; lat?: number; lng?: number }>("/geocode", { address });
      if (!r.found) throw new Error("Couldn't find that address. Try adding the city and state.");
      return r;
    },
    onSuccess: (r) => {
      mapRef.current?.panTo({ lat: r.lat!, lng: r.lng! });
      mapRef.current?.setZoom(20);
    },
  });
  const onFind = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const address = String(new FormData(e.currentTarget).get("address") ?? "").trim();
    if (address.length >= 5) find.mutate(address);
  };
  const removeSelected = () => {
    if (!selected || !drawRef.current) return;
    drawRef.current.selectFeature(selected);
    drawRef.current.removeFeatures([selected]);
    setSelected(null);
    setFeatures(drawRef.current.getSnapshot() as unknown as Feature[]);
  };
  const clearAll = async () => {
    if (!features.length || !(await confirm({ title: "Clear every shape?", body: "This removes everything you've drawn on the map.", confirmLabel: "Clear", danger: true }))) return;
    drawRef.current?.clear();
    setFeatures([]);
    setSelected(null);
    setSavedAt(null);
  };
  const p = context.data?.property;

  return (
    <>
      {back && <BackLink to={back.to}>{back.label}</BackLink>}
      <PageHeader
        title="Measure"
        actions={
          <>
            {savedAt && back && <Link to={back.to} className="btn">Back to {back.label}</Link>}
            <Button variant="primary" icon={savedAt ? "check" : undefined} loading={save.isPending} disabled={rows.length === 0 || Boolean(savedAt)} onClick={() => save.mutate()}>{savedAt ? "Saved" : "Save measurement"}</Button>
          </>
        }
      />
      {p && <p className="page-subtitle">{addressLine(p)}{p.client && ` · ${p.client.display_name}`}{context.data?.quote && ` · for quote #${context.data.quote.number}`}</p>}
      <FormError error={save.error} />
      <div className="two-col measure-layout">
        <div className="wide card" style={{ overflow: "hidden" }}>
          {mapState !== "error" && <div className="measure-toolbar" role="toolbar" aria-label="Drawing tools">
            <div className="segmented" role="group" aria-label="Tool">
              {MODES.map((m) => (
                <button key={m.mode} type="button" aria-pressed={m.mode === mode} onClick={() => setMode(m.mode)} disabled={mapState !== "ready"} title={m.hint}>
                  <Icon name={m.icon} size={15} />{m.label}
                </button>
              ))}
            </div>
            {mode === "select" && selected && <Button size="sm" variant="ghost" icon="trash" onClick={removeSelected}>Delete shape</Button>}
            <form className="measure-find" onSubmit={onFind} role="search">
              <div className="input-group">
                <span className="addon">{find.isPending ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <Icon name="search" size={15} />}</span>
                <input name="address" className="input" placeholder="Find an address" aria-label="Find an address" disabled={mapState !== "ready"} onChange={() => find.isError && find.reset()} />
              </div>
            </form>
            <Button size="sm" variant="ghost" icon="trash" onClick={clearAll} disabled={!features.length}>Clear</Button>
          </div>}
          {find.error && <div className="field-error" style={{ padding: "6px 12px 0" }}>{(find.error as Error).message}</div>}
          {mapState === "error" ? (
            <EmptyState icon="map" title="The map isn't available" action={back && <Link className="btn" to={back.to}>Back to {back.label}</Link>}>{mapError}</EmptyState>
          ) : (
            <div className="measure-map-wrap">
              {mapState === "loading" && <div className="measure-map-skeleton" aria-label="Loading map"><Skeleton height="100%" radius={0} /><span className="muted small strong"><Icon name="map" size={16} /> Loading satellite imagery…</span></div>}
              <div ref={mapEl} className="measure-map" aria-label="Satellite map for drawing measurements" />
              {mapState === "ready" && <div className="measure-hint">{MODES.find((m) => m.mode === mode)!.hint}</div>}
            </div>
          )}
        </div>

        <aside className="narrow stack" style={{ gap: 16 }}>
          <div className="card card-pad stack" style={{ gap: 12 }}>
            <Field label="Title"><input className="input" value={title} onChange={(e) => { setTitle(e.target.value); setSavedAt(null); }} maxLength={200} /></Field>
            <div className="form-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
              <Field label="Depth (in)"><input className="input" inputMode="decimal" value={depth} onChange={(e) => { setDepth(e.target.value.replace(/[^0-9.]/g, "")); setSavedAt(null); }} placeholder="2" /></Field>
              <Field label="Roof pitch" error={pitch && squares === null ? "e.g. 7/12" : null}><input className="input" value={pitch} onChange={(e) => { setPitch(e.target.value); setSavedAt(null); }} placeholder="7/12" /></Field>
              <Field label="Waste %"><input className="input" inputMode="decimal" value={waste} onChange={(e) => { setWaste(e.target.value.replace(/[^0-9.]/g, "")); setSavedAt(null); }} /></Field>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><strong>Shapes</strong><span className="badge">{rows.length}</span></div>
            {rows.length === 0 ? (
              <EmptyState compact icon="area" title="Nothing drawn yet">Pick a tool and draw on the map.</EmptyState>
            ) : (
              rows.map((row, i) => (
                <div key={row.id} className="card-row" style={{ padding: "10px 16px", background: selected === row.id ? "var(--green-tint)" : undefined }}>
                  <Icon name={row.kind === "Area" ? "area" : row.kind === "Count" ? "pin" : "line"} size={16} />
                  <input
                    className="input grow"
                    style={{ height: 32 }}
                    aria-label={`Label for shape ${i + 1}`}
                    placeholder={`${row.kind} ${i + 1}`}
                    value={labels[row.id] ?? ""}
                    onChange={(e) => { setLabels({ ...labels, [row.id]: e.target.value }); setSavedAt(null); }}
                    maxLength={80}
                  />
                  <span className="num strong nowrap">{formatNumber(row.value, row.kind === "Count" ? 0 : 1)} {row.unit}</span>
                </div>
              ))
            )}
            <div className="measure-totals">
              <div><span className="muted">Area</span><strong>{formatNumber(summary.total_area_sqft)} sq ft</strong><span className="muted small">{formatNumber(summary.total_area_sqyd, 1)} sq yd</span></div>
              <div><span className="muted">Length</span><strong>{formatNumber(summary.total_length_ft)} ft</strong></div>
              {depthIn > 0 && summary.total_area_sqft > 0 && (
                <>
                  <div><span className="muted">Volume at {depthIn}"</span><strong>{formatNumber(cubicYards, 1)} cu yd</strong></div>
                  <div><span className="muted">Asphalt (approx.)</span><strong>{formatNumber(asphaltTons, 1)} tons</strong><span className="muted small">at 110 lb per sq yd per inch</span></div>
                </>
              )}
              {squares !== null && <div><span className="muted">Roofing squares</span><strong>{formatNumber(squares, 1)}</strong><span className="muted small">{pitch} pitch, {waste || 0}% waste</span></div>}
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
