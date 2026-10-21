/**
 * One roofing project, start to finish, on one page (ProjectFlow): the roof measured on the map,
 * the estimate priced from the price list, the proposal the client signs online, the job and the
 * invoices. The estimate asks what a roofer decides: which roof goes on (one, or Good, Better and
 * Best for the client to pick from), how many layers come off, and what else the roof needs.
 */
import { edgeLengths, ROOF_EDGES, type RoofEdge } from "@crewtavo/core/geo";
import { optionLabels } from "@crewtavo/core/money";
import { ROOF_EDGE_COLORS, savedRoofingQuantities, STEEP_RISE } from "@crewtavo/core/roofing";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { api, supabase, unwrap } from "@/lib/api";
import { formatMoney, formatMoneyCents, formatNumber } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { formulaValue, sectionsOf, takeoffVariables } from "../paving/data";
import { EstimateLines, ProjectFlow, SERVICE_FIELDS, type EstimateProps, type FlowTrade, type Line, type Service, type TakeoffProps } from "../paving/ProjectFlow";
import { firstChoice, layersFormula, layersName, layersOf, ROOF_CHOICE, ROOF_STEPS, roofServiceKind } from "./data";

const ROOFING: FlowTrade = {
  id: "roofing",
  name: "Roofing",
  path: "/roofing",
  steps: ROOF_STEPS,
  notFound: "That roofing project wasn't found. It may have been deleted.",
  takeoff: {
    empty: "Measure the roof",
    text: "Outline the roof on the aerial (or start from the building's outline), set its pitch, and mark the eaves, rakes, ridges, hips and valleys.",
    start: "Measure the roof",
    after: "After the roof is measured",
    first: "Measure the roof first; the estimate prices from it.",
  },
  sheet: {
    name: "roof report",
    text: "The roof on the aerial with its edges, scale and measurements, so the client sees exactly what you're pricing.",
    missing: "Save the roof on the map first to make the report.",
  },
};

const EDGE_NAMES: Record<RoofEdge, string> = { eave: "Eaves", rake: "Rakes", ridge: "Ridges", hip: "Hips", valley: "Valleys" };

export function RoofingProjectPage() {
  return <ProjectFlow trade={ROOFING} takeoffView={(props) => <RoofSummary {...props} />} estimateView={(props) => <RoofEstimate {...props} />} />;
}

function RoofSummary({ takeoff, picture, editLink }: TakeoffProps) {
  const sections = sectionsOf(takeoff);
  const edges = edgeLengths({ sections });
  const values = savedRoofingQuantities(sections, takeoff.roof_pitch, Number(takeoff.waste_pct));
  const pitches = [...new Set(sections.filter((s) => s.kind === "Area").map((s) => s.pitch || takeoff.roof_pitch || "").filter(Boolean))];
  const pitched = takeoff.roofing_squares != null;
  return (
    <div className="paving-takeoff">
      {picture ? (
        <a href={picture} target="_blank" rel="noreferrer" className="paving-takeoff-picture"><img src={picture} alt={`Roof report for ${takeoff.title}`} /></a>
      ) : (
        <div className="paving-takeoff-picture paving-takeoff-empty muted small">No picture saved yet. Save the roof on the map to make the report.</div>
      )}
      <div className="stack-sm">
        {pitched ? (
          <div className="paving-quantities">
            <div className="roof-squares"><span className="grow">Squares</span><strong className="num">{formatNumber(Number(takeoff.roofing_squares), 1)}</strong></div>
            <div><span className="grow">Roof area</span><strong className="num">{formatNumber(values.roof_sqft ?? 0)} sq ft</strong></div>
            <div><span className="grow">Pitch</span><strong>{pitches.length ? pitches.map((p) => (p === "0/12" ? "Flat" : p)).join(", ") : "Flat"}</strong></div>
            <div><span className="grow">Waste</span><strong className="num">{formatNumber(Number(takeoff.waste_pct))}%</strong></div>
            {(values.steep_squares ?? 0) > 0 && <div><span className="grow">Steep ({STEEP_RISE}/12 and up)</span><strong className="num">{formatNumber(values.steep_squares!, 1)} sq</strong></div>}
            {ROOF_EDGES.filter((e) => edges[e] > 0).map((e) => (
              <div key={e}>
                <span className="paving-swatch" data-geometry="line" style={{ "--swatch": ROOF_EDGE_COLORS[e] } as React.CSSProperties} aria-hidden="true" />
                <span className="grow">{EDGE_NAMES[e]}</span>
                <strong className="num">{formatNumber(edges[e])} ft</strong>
              </div>
            ))}
          </div>
        ) : (
          <span className="muted small">{formatNumber(takeoff.total_area_sqft)} sq ft measured from above, with no pitch yet. Set the roof's pitch on the map (Flat counts) to work out the squares.</span>
        )}
        {pitched && !ROOF_EDGES.some((e) => edges[e] > 0) && <span className="muted small">No edges marked. Mark the eaves, rakes, ridges, hips and valleys on the map to price drip edge, ridge cap and flashing.</span>}
        {editLink && <Link className="btn" style={{ justifySelf: "start" }} to={editLink}><Icon name="edit" size={16} /> Edit the roof</Link>}
      </div>
    </div>
  );
}

type Row = Record<string, unknown>;
interface Priced { service: Service; qty: number | null; price: number }

function RoofEstimate({ quote, takeoff, editable, onChanged }: EstimateProps) {
  const { company } = useSession();
  const services = useQuery({
    queryKey: ["services", company.id, "active"],
    queryFn: async () => unwrap(await supabase().from("services").select(SERVICE_FIELDS).eq("company_id", company.id).eq("active", true).order("sort").order("name")) as Service[],
  });
  const vars = useMemo(() => takeoffVariables(takeoff, null), [takeoff]);
  const priceOf = (s: Service, formula = s.formula): Priced => {
    const qty = formula ? formulaValue(formula, vars) : null;
    return { service: s, qty, price: qty === null ? 0 : s.formula_target === "unit_price" ? qty : qty * Number(s.unit_price) };
  };
  const sorted = useMemo(() => {
    const groups = { roof: [] as Service[], tearoff: [] as Service[], extra: [] as Service[], other: [] as Service[] };
    for (const s of services.data ?? []) groups[roofServiceKind(s.formula, s.name)].push(s);
    return groups;
  }, [services.data]);
  const roofs = sorted.roof.map((s) => priceOf(s));
  const tearoff = sorted.tearoff[0] ?? null;
  const extras = [...sorted.tearoff.slice(1), ...sorted.extra].map((s) => priceOf(s));

  const lineOf = (serviceId: string) => quote.lines.find((l) => l.service_id === serviceId);
  const roofIds = new Set(sorted.roof.map((s) => s.id));
  const roofLines = quote.lines.filter((l) => l.service_id && roofIds.has(l.service_id));
  const [mode, setMode] = useState<"one" | "choices" | null>(null);
  // The choice someone said to show first (Show first); until then the middle one is.
  const [pickedFirst, setPickedFirst] = useState<string | null>(null);
  const choosing = (mode ?? (roofLines.some((l) => l.option_group === ROOF_CHOICE) ? "choices" : "one")) === "choices";
  const nextSort = quote.lines.reduce((m, l) => Math.max(m, l.sort), 0) + 1;

  /** A line for a service, priced from the roof (a tear-off can pass its formula for more layers). */
  const lineFor = (s: Service, sort: number, patch: Row = {}, formula = s.formula): Row => {
    const value = formula ? formulaValue(formula, vars) ?? 0 : 0;
    const byPrice = s.formula_target === "unit_price";
    return {
      company_id: company.id,
      quote_id: quote.id,
      service_id: s.id,
      name: s.name,
      unit: s.unit,
      unit_price: byPrice ? Math.round(value * 100) / 100 : s.unit_price,
      unit_cost: s.unit_cost,
      taxable: s.taxable,
      formula,
      quantity: byPrice ? 1 : value,
      sort,
      ...patch,
    };
  };

  const save = useMutation({
    mutationFn: async ({ remove = [], add = [] }: { remove?: string[]; add?: Row[] }) => {
      const db = supabase();
      if (remove.length) unwrap(await db.from("quote_line_items").delete().in("id", remove));
      if (add.length) unwrap(await db.from("quote_line_items").insert(add as never));
      // The server works the quantities out the same way, and links the roof to the quote.
      if (add.some((r) => r.formula)) await api.post(`/quotes/${quote.id}/apply-measurement`, { measurement_id: takeoff.id });
      // Priced for the first time: the proposal shows the roof report, unless someone turns it off.
      if (!quote.lines.length && add.length && takeoff.snapshot_path && !takeoff.show_on_quote) {
        unwrap(await db.from("measurements").update({ show_on_quote: true }).eq("id", takeoff.id));
      }
    },
    onSuccess: onChanged,
    onError: (error) => toast.error((error as Error).message),
  });
  const showFirst = useMutation({
    mutationFn: async (line: Line) => {
      const db = supabase();
      unwrap(await db.from("quote_line_items").update({ selected: false }).eq("quote_id", quote.id).eq("option_group", ROOF_CHOICE).neq("id", line.id));
      unwrap(await db.from("quote_line_items").update({ selected: true }).eq("id", line.id));
    },
    onSuccess: (_, line) => {
      setPickedFirst(line.service_id);
      onChanged();
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const reprice = useMutation({
    meta: { success: "Quantities updated from the roof" },
    mutationFn: () => api.post(`/quotes/${quote.id}/apply-measurement`, { measurement_id: takeoff.id }),
    onSuccess: onChanged,
  });
  const busy = save.isPending || showFirst.isPending || reprice.isPending;

  /** Put these roofs on the estimate in place of the ones there: one roof, or choices for the client. */
  const setRoofs = (chosen: Service[], asChoices: boolean, first?: string) => {
    const priced = chosen.map((s) => priceOf(s)).sort((a, b) => a.price - b.price);
    const shown = first && chosen.some((s) => s.id === first) ? first : firstChoice(priced)?.service.id;
    const from = roofLines.length ? Math.min(...roofLines.map((l) => l.sort)) : nextSort;
    const add = priced.map((p, i) => lineFor(p.service, from + i, asChoices ? { optional: true, option_group: ROOF_CHOICE, selected: p.service.id === shown } : {}));
    save.mutate({ remove: roofLines.map((l) => l.id), add });
  };
  const roofServices = roofLines.map((l) => sorted.roof.find((s) => s.id === l.service_id)!).filter(Boolean);
  const shownFirst = roofLines.find((l) => l.selected)?.service_id ?? undefined;
  const switchMode = (next: "one" | "choices") => {
    setMode(next);
    if (!roofLines.length) return;
    // One roof keeps the one shown first; choices start from the roof that's on.
    if (next === "one") setRoofs(roofServices.filter((s) => s.id === (shownFirst ?? roofServices[0]?.id)).slice(0, 1), false);
    else setRoofs(roofServices, true, pickedFirst ?? undefined);
  };
  const toggleChoice = (s: Service, on: boolean) => {
    const next = on ? [...roofServices, s] : roofServices.filter((x) => x.id !== s.id);
    if (next.length > 3) return void toast.info("Offer up to three: Good, Better and Best.");
    setRoofs(next, true, pickedFirst ?? undefined);
  };

  const tearLine = tearoff ? lineOf(tearoff.id) : undefined;
  const layers = tearLine ? layersOf(tearLine.formula) : 0;
  const setLayers = (n: number) => {
    if (!tearoff?.formula || n === layers) return;
    const add = n ? [lineFor(tearoff, tearLine?.sort ?? nextSort, { name: layersName(tearoff.name, n) }, layersFormula(tearoff.formula, n))] : [];
    save.mutate({ remove: tearLine ? [tearLine.id] : [], add });
  };

  // The rest of the roof: what it has (drip edge on eaves, flashing in valleys) or is already on.
  const extraRows = extras.filter((r) => lineOf(r.service.id) || (r.qty ?? 0) > 0);
  const notYet = extraRows.filter((r) => !lineOf(r.service.id) && r.qty !== null);
  const addExtras = (list: Service[]) => save.mutate({ add: list.map((s, i) => lineFor(s, nextSort + i)) });
  const otherLines = quote.lines.filter((l) => !l.service_id || sorted.other.some((s) => s.id === l.service_id));
  const noEdges = !ROOF_EDGES.some((e) => (vars[`${e}_ft`] ?? 0) > 0);
  const choices = optionLabels(quote.lines);

  if (!editable) return quote.lines.length ? <EstimateLines quote={quote} /> : <span className="muted small">This proposal can't be changed anymore.</span>;
  if (services.isPending) return <span className="muted small">Loading your price list…</span>;
  return (
    <div className="stack" style={{ gap: 20 }}>
      {takeoff.roofing_squares == null && (
        <div className="callout callout-warning" role="status"><Icon name="alert" size={18} /><span className="grow">The roof has no pitch yet, so it prices as flat. Set the pitch on the map for the real squares.</span></div>
      )}

      <section className="stack-sm" style={{ gap: 10 }} aria-labelledby="roof-what">
        <div className="row wrap" style={{ gap: 12 }}>
          <span className="small strong grow" id="roof-what">What's going on the roof?</span>
          {roofs.length > 1 && (
            <div className="segmented" role="group" aria-label="How many roofs to offer">
              <button type="button" aria-pressed={!choosing} disabled={busy} onClick={() => switchMode("one")}>One roof</button>
              <button type="button" aria-pressed={choosing} disabled={busy} onClick={() => switchMode("choices")}>Good, Better, Best</button>
            </div>
          )}
        </div>
        {!roofs.length ? (
          <span className="muted small">
            None of your services price a roof by the square. Add the standard roofing services on the <Link to="/roofing">Roofing</Link> page, or give your own the formula <code>squares</code> in <Link to="/settings?tab=prices">Settings → Price list</Link>.
          </span>
        ) : (
          <div className="paving-services">
            {roofs.map(({ service, qty, price }) => {
              const line = lineOf(service.id);
              return (
                <label key={service.id} className="paving-service" data-on={line ? true : undefined}>
                  {choosing ? (
                    <input type="checkbox" checked={Boolean(line)} disabled={busy} onChange={(e) => toggleChoice(service, e.target.checked)} aria-label={`${line ? "Take" : "Offer"} ${service.name}${line ? " off the choices" : " as a choice"}`} />
                  ) : (
                    <input type="radio" name="roof" checked={Boolean(line)} disabled={busy} onChange={() => setRoofs([service], false)} aria-label={`Put ${service.name} on the roof`} />
                  )}
                  <span className="grow">
                    <strong>{line && choices.get(line.id) && <span className="chip chip-blue estimate-choice">{choices.get(line.id)}</span>}{service.name}</strong>
                    <span className="muted small">{qty === null ? "Needs a value the roof doesn't have" : `${formatNumber(qty, 1)} ${service.unit} × ${formatMoneyCents(service.unit_price)}`}</span>
                  </span>
                  {choosing && line && roofLines.length > 1 && (
                    line.selected ? <span className="chip">Shown first</span> : <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={(e) => { e.preventDefault(); showFirst.mutate(line); }}>Show first</button>
                  )}
                  <strong className="num">{qty === null ? "—" : formatMoney(price)}</strong>
                </label>
              );
            })}
          </div>
        )}
        {choosing && <span className="muted small">Pick two or three. The client chooses one on the proposal; the one shown first counts in the total until they do.</span>}
      </section>

      {tearoff && (
        <section className="stack-sm" style={{ gap: 6 }} aria-labelledby="roof-tearoff">
          <span className="small strong" id="roof-tearoff">Tear off the old roof?</span>
          <div className="row wrap" style={{ gap: 12 }}>
            <div className="segmented" role="group" aria-labelledby="roof-tearoff">
              {[0, 1, 2].map((n) => <button key={n} type="button" aria-pressed={layers === n} disabled={busy} onClick={() => setLayers(n)}>{n === 0 ? "No" : n === 1 ? "1 layer" : "2 layers"}</button>)}
            </div>
            {layers > 0 && <span className="muted small">{tearoff.name}: {formatNumber((priceOf(tearoff).qty ?? 0) * layers, 1)} {tearoff.unit} · {formatMoney(priceOf(tearoff).price * layers)}</span>}
          </div>
        </section>
      )}

      <section className="stack-sm" style={{ gap: 10 }} aria-labelledby="roof-extras">
        <span className="small strong" id="roof-extras">Also on this roof</span>
        {extraRows.length > 0 && (
          <div className="paving-services">
            {extraRows.map(({ service, qty, price }) => {
              const line = lineOf(service.id);
              return (
                <label key={service.id} className="paving-service" data-on={line ? true : undefined}>
                  <input type="checkbox" checked={Boolean(line)} disabled={busy} onChange={(e) => (e.target.checked ? addExtras([service]) : save.mutate({ remove: [line!.id] }))} aria-label={`${line ? "Take" : "Put"} ${service.name} ${line ? "off" : "on"} the estimate`} />
                  <span className="grow">
                    <strong>{service.name}</strong>
                    <span className="muted small">{qty === null ? "Needs a value the roof doesn't have" : `${formatNumber(qty, qty < 100 ? 1 : 0)} ${service.unit} × ${formatMoneyCents(service.unit_price)}`}</span>
                  </span>
                  <strong className="num">{qty === null ? "—" : formatMoney(price)}</strong>
                </label>
              );
            })}
            {otherLines.map((l) => (
              <label key={l.id} className="paving-service" data-on>
                <input type="checkbox" checked disabled={busy} onChange={() => save.mutate({ remove: [l.id] })} aria-label={`Take ${l.name} off the estimate`} />
                <span className="grow">
                  <strong>{l.name}</strong>
                  <span className="muted small">{formatNumber(Number(l.quantity), 2)} {l.unit} × {formatMoneyCents(l.unit_price)}</span>
                </span>
                <strong className="num">{formatMoney(Number(l.quantity) * Number(l.unit_price))}</strong>
              </label>
            ))}
          </div>
        )}
        {noEdges && sorted.extra.length > 0 && <span className="muted small">Mark the eaves, rakes, ridges, hips and valleys on the map to price drip edge, ridge cap and flashing from them.</span>}
        {notYet.length > 1 && <Button icon="plus" disabled={busy} onClick={() => addExtras(notYet.map((r) => r.service))} style={{ justifySelf: "start" }}>Add all {notYet.length}</Button>}
        <AddFromPriceList services={sorted.other} disabled={busy} onAdd={(s, quantity) => save.mutate({ add: [{ ...lineFor(s, nextSort), formula: null, quantity }] })} />
      </section>

      {quote.lines.some((l) => l.formula) && <Button icon="refresh" loading={reprice.isPending} disabled={busy} onClick={() => reprice.mutate()} style={{ justifySelf: "start" }}>Update quantities from the roof</Button>}
      {quote.lines.length > 0 && <EstimateLines quote={quote} />}
    </div>
  );
}

/** Anything else from the price list, by the each: a dumpster, pipe boots, a permit. */
function AddFromPriceList({ services, disabled, onAdd }: { services: Service[]; disabled: boolean; onAdd: (service: Service, quantity: number) => void }) {
  const [id, setId] = useState("");
  const [qty, setQty] = useState("1");
  if (!services.length) return null;
  const service = services.find((s) => s.id === id);
  return (
    <form className="row wrap roof-add-other" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (service && Number(qty) > 0) { onAdd(service, Number(qty)); setId(""); setQty("1"); } }}>
      <select className="select" value={id} onChange={(e) => setId(e.target.value)} aria-label="Something else from your price list">
        <option value="">Something else from your price list…</option>
        {services.map((s) => <option key={s.id} value={s.id}>{s.name} ({formatMoneyCents(s.unit_price)} / {s.unit})</option>)}
      </select>
      <input className="input" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="How many" style={{ width: 80 }} />
      <Button type="submit" icon="plus" disabled={disabled || !service || !(Number(qty) > 0)}>Add</Button>
    </form>
  );
}
