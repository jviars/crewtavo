/**
 * One paving project, start to finish, on one page (ProjectFlow): the takeoff from the map, the
 * estimate priced from the price list (services whose formulas read the takeoff's items), the
 * proposal the client signs online, the job and its schedule, and the invoices.
 *
 * The estimate can offer two or three options from packages (the options bar, quotes/
 * QuoteOptions.tsx). The services ticked here are then the ones of the option being looked at and
 * the shared ones. A service ticked goes on that option alone, or on every option when that's
 * chosen (rows.ts lineDestination: the option's own services, and ones another option has its own
 * line for, always go on it alone). Unticking one takes it off that option, or off every option when
 * it's on every option, as its row says.
 */
import { PAVING_ITEMS } from "@crewtavo/core/paving";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, useJustDone } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { formatMoney, formatMoneyCents, formatNumber } from "@/lib/format";
import { useSession } from "@/lib/session";
import { formatItemTotal, ItemSwatch } from "../measure/PavingItems";
import { optionTabs, quoteOptionsKey, viewedOption } from "../quotes/options";
import { QuoteOptions } from "../quotes/QuoteOptions";
import { destinationText, lineDestination, packageServices, type LinePlace } from "../roofing/estimate/rows";
import { useRoofPackages } from "../roofing/packages";
import { formulaValue, sectionsOf, serviceKind, STEPS, takeoffVariables, usesDepth, viewedLines } from "./data";
import { EstimateLines, ProjectFlow, SERVICE_FIELDS, type EstimateProps, type FlowTrade, type Service, type TakeoffProps } from "./ProjectFlow";

const PAVING: FlowTrade = {
  id: "paving",
  name: "Paving",
  path: "/paving",
  steps: STEPS,
  notFound: "That paving project wasn't found. It may have been deleted.",
  takeoff: {
    empty: "Measure the lot",
    text: "Outline the asphalt, mark the striping, stalls and cracks on the aerial, or let Find paving outline it for you.",
    start: "Start the takeoff",
    after: "After the takeoff",
    first: "Measure the lot first; the estimate prices from the takeoff.",
  },
  sheet: {
    name: "takeoff sheet",
    text: "The site plan with its scale, legend and quantities, so the client sees exactly what you're bidding.",
    missing: "Save the takeoff on the map first to make the sheet.",
  },
};

const ASPHALT_WORK = [
  { id: "seal", label: "Sealcoat it" },
  { id: "pave", label: "Pave it" },
  { id: "none", label: "Neither" },
] as const;
type AsphaltWork = (typeof ASPHALT_WORK)[number]["id"];

export function PavingProjectPage() {
  return <ProjectFlow trade={PAVING} takeoffView={(props) => <TakeoffSummary {...props} />} estimateView={(props) => <Estimate {...props} />} />;
}

function TakeoffSummary({ takeoff, picture, editLink }: TakeoffProps) {
  const sections = sectionsOf(takeoff);
  const items = PAVING_ITEMS.filter((item) => sections.some((s) => s.item === item.id));
  return (
    <div className="paving-takeoff">
      {picture ? (
        <a href={picture} target="_blank" rel="noreferrer" className="paving-takeoff-picture"><img src={picture} alt={`Takeoff sheet for ${takeoff.title}`} /></a>
      ) : (
        <div className="paving-takeoff-picture paving-takeoff-empty muted small">No picture saved yet. Save the takeoff on the map to make the sheet.</div>
      )}
      <div className="stack-sm">
        {items.length ? (
          <div className="paving-quantities">
            {items.map((item) => (
              <div key={item.id}>
                <ItemSwatch item={item} />
                <span className="grow">{item.name}</span>
                <strong className="num">{formatItemTotal(sections, item)}</strong>
              </div>
            ))}
          </div>
        ) : (
          <span className="muted small">{formatNumber(takeoff.total_area_sqft)} sq ft measured, with no paving items marked. Mark the shapes as asphalt, striping and so on to price each on its own line.</span>
        )}
        {editLink && <Link className="btn" style={{ justifySelf: "start" }} to={editLink}><Icon name="edit" size={16} /> Edit the takeoff</Link>}
      </div>
    </div>
  );
}

function Estimate({ quote, takeoff, editable, onChanged }: EstimateProps) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const panelId = useId();
  // The option looked at (looking changes nothing), with its tier word and its package's own services.
  const [viewing, setViewing] = useState<string | null>(null);
  const viewed = viewedOption(quote.options, viewing, quote.option_id);
  const tab = viewed ? (optionTabs(quote.options, quote.lines, quote).find((t) => t.option.id === viewed) ?? null) : null;
  const packages = useRoofPackages({ enabled: quote.options.length > 0 });
  const own = packageServices(tab?.option.package_id ? packages.data?.find((p) => p.id === tab.option.package_id) : null);
  const label = tab ? (tab.tier ?? tab.option.name) : "";
  // The lines the option looked at is made of: its own and the shared ones (all of them without options).
  const visible = viewedLines(quote.lines, viewed);
  // Where a service ticked goes: in the office, the option looked at, unless they say every option.
  const [place, setPlace] = useState<LinePlace>("only");
  const destination = (s: Service) => lineDestination(s, viewed, { own, lines: quote.lines, place });
  // On every option here: taking it off takes it off them all.
  const shared = new Set(visible.filter((l) => tab && l.option_id === null && l.service_id).map((l) => l.service_id!));
  const servicesQuery = useQuery({
    queryKey: ["services", company.id, "with-formulas"],
    queryFn: async () => unwrap(await supabase().from("services").select(SERVICE_FIELDS).eq("company_id", company.id).eq("active", true).not("formula", "is", null).order("sort").order("name")) as Service[],
  });
  const services = servicesQuery.data ?? [];
  const loadingServices = servicesQuery.isPending;
  const [depth, setDepth] = useState("2");
  const onEstimate = new Set(visible.map((l) => l.service_id).filter(Boolean));
  const kinds = useMemo(() => new Map(services.map((s) => [s.id, serviceKind(s.formula, s.name)])), [services]);
  // What the asphalt gets decides which area services are suggested; until someone picks, it follows what's on the estimate.
  const [picked, setWork] = useState<AsphaltWork | null>(null);
  const work: AsphaltWork = picked ?? (visible.some((l) => l.service_id && kinds.get(l.service_id) === "pave") ? "pave" : "seal");
  const depthIn = Number(depth) > 0 ? Number(depth) : null;
  const vars = useMemo(() => takeoffVariables(takeoff, depthIn), [takeoff, depthIn]);
  const rows = services
    .map((s) => ({ service: s, kind: kinds.get(s.id) ?? "other", qty: s.formula ? formulaValue(s.formula, vars) : null }))
    .filter((r) => onEstimate.has(r.service.id) || ((r.qty ?? 0) > 0 && (r.kind === "other" || r.kind === work)));
  const needsDepth = rows.some((r) => usesDepth(r.service.formula) && (r.kind !== "pave" || work === "pave"));

  const add = useMutation({
    mutationFn: async (list: Service[]) => {
      const sort = quote.lines.reduce((m, l) => Math.max(m, l.sort), 0);
      const lines = list.map((s, i) => {
        const value = s.formula ? formulaValue(s.formula, vars) ?? 0 : 0;
        const byPrice = s.formula_target === "unit_price";
        return {
          company_id: company.id,
          quote_id: quote.id,
          option_id: destination(s),
          service_id: s.id,
          name: s.name,
          unit: s.unit,
          unit_price: byPrice ? Math.round(value * 100) / 100 : s.unit_price,
          unit_cost: s.unit_cost,
          taxable: s.taxable,
          formula: s.formula,
          quantity: byPrice ? 1 : value,
          sort: sort + i + 1,
        };
      });
      unwrap(await supabase().from("quote_line_items").insert(lines));
      // The server works the quantities out the same way, and links the takeoff to the quote.
      await api.post(`/quotes/${quote.id}/apply-measurement`, { measurement_id: takeoff.id, ...(depthIn ? { depth_in: depthIn } : {}) });
      // Priced for the first time: the proposal shows the takeoff sheet, unless someone turns it off.
      if (!quote.lines.length && takeoff.snapshot_path && !takeoff.show_on_quote) {
        unwrap(await supabase().from("measurements").update({ show_on_quote: true }).eq("id", takeoff.id));
      }
    },
    onSuccess: onChanged,
  });
  // Off the option looked at and the shared lines (viewedLines); another option keeps its own.
  const remove = useMutation({
    mutationFn: async (service: Service) => {
      const lines = supabase().from("quote_line_items").delete().eq("quote_id", quote.id).eq("service_id", service.id);
      unwrap(await (viewed ? lines.or(`option_id.is.null,option_id.eq.${viewed}`) : lines));
    },
    onSuccess: onChanged,
  });
  const reprice = useMutation({
    mutationFn: () => api.post(`/quotes/${quote.id}/apply-measurement`, { measurement_id: takeoff.id, ...(depthIn ? { depth_in: depthIn } : {}) }),
    onSuccess: onChanged,
  });
  const repriced = useJustDone(reprice);
  const notYet = rows.filter((r) => !onEstimate.has(r.service.id));
  const busy = add.isPending || remove.isPending || reprice.isPending;

  const anyPaveOrSeal = services.some((s) => kinds.get(s.id) !== "other");
  const optionsChanged = () => {
    void queryClient.invalidateQueries({ queryKey: quoteOptionsKey(quote.id) });
    onChanged();
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {(editable || quote.options.length > 0) && quote.lines.length > 0 && (
        <QuoteOptions quote={quote} options={quote.options} lines={quote.lines} viewing={viewing} onView={setViewing} mode="office" onChanged={optionsChanged} panelId={panelId} />
      )}
      {editable && (
        <div className="stack-sm" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 12 }}>
            {anyPaveOrSeal && (
              <div className="stack-sm" style={{ gap: 4 }}>
                <span className="small strong" id="asphalt-work">What's the asphalt getting?</span>
                <div className="segmented" role="group" aria-labelledby="asphalt-work">
                  {ASPHALT_WORK.map((w) => <button key={w.id} type="button" aria-pressed={work === w.id} onClick={() => setWork(w.id)}>{w.label}</button>)}
                </div>
              </div>
            )}
            {needsDepth && (
              <label className="stack-sm" style={{ gap: 4 }}>
                <span className="small strong">Depth (in)</span>
                <input className="input" inputMode="decimal" value={depth} onChange={(e) => setDepth(e.target.value.replace(/[^0-9.]/g, ""))} style={{ width: 90 }} />
              </label>
            )}
          </div>
          <span className="small strong">Services from your price list</span>
          {tab && (
            <div className="row wrap" style={{ gap: "6px 10px" }}>
              <span className="muted small">For {label}. What you tick goes</span>
              <div className="segmented" role="group" aria-label="What you tick goes" style={{ flexWrap: "wrap", maxWidth: "100%" }}>
                <button type="button" aria-pressed={place === "only"} onClick={() => setPlace("only")}>Only on {label}</button>
                <button type="button" aria-pressed={place === "every"} onClick={() => setPlace("every")}>On every option</button>
              </div>
            </div>
          )}
          {loadingServices ? (
            <span className="muted small">Loading your price list…</span>
          ) : !rows.length ? (
            <EmptyState inline title="None of your services price from this takeoff">
              Add the standard paving services on the <Link to="/paving">Paving</Link> page, or give your own a formula in <Link to="/settings?tab=prices">Settings → Price list</Link>.
            </EmptyState>
          ) : (
            <div className="paving-services">
              {rows.map(({ service, qty }) => {
                const on = onEstimate.has(service.id);
                const byPrice = service.formula_target === "unit_price";
                const goesTo = tab && !on ? destination(service) : null;
                // Where it is, or where it goes when that isn't where the control says.
                const where = !tab ? null : on ? (shared.has(service.id) ? destinationText(null, label) : null) : goesTo && place === "every" ? destinationText(goesTo, label) : null;
                const what = !tab ? "the estimate" : on ? (shared.has(service.id) ? "every option" : label) : goesTo ? label : "every option";
                return (
                  <label key={service.id} className="paving-service" data-on={on || undefined}>
                    <input type="checkbox" checked={on} disabled={busy} onChange={(e) => (e.target.checked ? add.mutate([service]) : remove.mutate(service))} aria-label={`${on ? "Take" : "Put"} ${service.name} ${on ? "off" : "on"} ${what}`} />
                    <span className="grow">
                      <strong>{service.name}</strong>
                      <span className="muted small">
                        {qty === null ? "Needs a value the takeoff doesn't have" : byPrice ? `Price works out to ${formatMoney(qty)}` : `${formatNumber(qty, qty < 100 ? 2 : 0)} ${service.unit} × ${formatMoneyCents(service.unit_price)}`}
                        {where ? ` · ${where}` : ""}
                      </span>
                    </span>
                    <strong className="num">{qty === null ? "—" : formatMoney(byPrice ? qty : qty * service.unit_price)}</strong>
                  </label>
                );
              })}
            </div>
          )}
          <div className="row wrap" style={{ gap: 8 }}>
            {notYet.length > 1 && <Button icon="plus" loading={add.isPending} disabled={busy} onClick={() => add.mutate(notYet.filter((r) => r.qty !== null).map((r) => r.service))}>Add all {notYet.length}</Button>}
            {quote.lines.some((l) => l.formula) && (
              <Button icon="refresh" loading={reprice.isPending} done={repriced} doneLabel="Updated" disabled={busy} onClick={() => reprice.mutate()} title="Work the quantities out again from the takeoff">
                Update quantities
              </Button>
            )}
          </div>
        </div>
      )}

      {quote.lines.length > 0 && (
        <div id={panelId} role={tab ? "tabpanel" : undefined} aria-label={tab ? `${label}'s lines and the ones on every option` : undefined}>
          <EstimateLines quote={quote} optionId={viewed} optionLabel={tab ? label : null} />
        </div>
      )}
    </div>
  );
}
