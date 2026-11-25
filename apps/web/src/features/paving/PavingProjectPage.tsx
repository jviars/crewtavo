/**
 * One paving project, start to finish, on one page (ProjectFlow): the takeoff from the map, the
 * estimate, the proposal the client signs online, the job and its schedule, and the invoices.
 *
 * The estimate prices the paving on the calculator first (PavingCalculatorPage, with the takeoff's
 * asphalt filled in), and the extras from the price list: services whose formulas read the takeoff's
 * items, like sealcoat, striping, crack seal and patching. Price-list services that price the
 * asphalt itself (data.ts pavesAsphalt) aren't offered beside the calculator, so the same asphalt is
 * never priced in two places; one already on an estimate shows, to be taken off, and says so.
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
import { Button, cx, useJustDone } from "@/components/ui/Button";
import { DecimalInput } from "@/components/ui/DecimalInput";
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
import { formulaValue, pavesAsphalt, sectionsOf, serviceKind, STEPS, takeoffVariables, usesDepth, viewedLines } from "./data";
import { EstimateLines, ProjectFlow, SERVICE_FIELDS, type EstimateProps, type FlowTrade, type Service, type TakeoffProps } from "./ProjectFlow";
import styles from "./paving.module.css";
import { useWorksheets, WorksheetsCard } from "./WorksheetsCard";

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

function TakeoffSummary({ takeoff, picture }: TakeoffProps) {
  const sections = sectionsOf(takeoff);
  const items = PAVING_ITEMS.filter((item) => sections.some((s) => s.item === item.id));
  return (
    <div className={styles.takeoff}>
      {picture ? (
        <a href={picture} target="_blank" rel="noreferrer" className={styles.takeoffPicture}><img src={picture} alt={`Takeoff sheet for ${takeoff.title}`} /></a>
      ) : (
        <div className={cx(styles.takeoffPicture, styles.takeoffEmpty)}>No picture saved yet. Save the takeoff on the map to make the sheet.</div>
      )}
      {items.length ? (
        <dl className={styles.quantities} aria-label="Measured">
          {items.map((item) => (
            <div key={item.id}>
              <dt><ItemSwatch item={item} />{item.name}</dt>
              <dd>{formatItemTotal(sections, item)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="paving-step-note">{formatNumber(takeoff.total_area_sqft)} sq ft measured, with no paving items marked. Mark the shapes as asphalt, striping and so on to price each on its own line.</p>
      )}
    </div>
  );
}

function Estimate({ quote, takeoff, editable, onChanged, current }: EstimateProps) {
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
  const kinds = useMemo(() => new Map(services.map((s) => [s.id, serviceKind(s.formula, s.name, s.category)])), [services]);
  // Priced on the calculator: its worksheets, at the top of the estimate.
  const worksheets = useWorksheets(quote.id);
  const priced = (worksheets.data?.rows.length ?? 0) > 0;
  // What the asphalt gets decides what's offered; until someone picks, it follows what's on the estimate.
  const [picked, setWork] = useState<AsphaltWork | null>(null);
  const work: AsphaltWork = picked ?? (priced || visible.some((l) => l.service_id && kinds.get(l.service_id) === "pave") ? "pave" : "seal");
  const depthIn = Number(depth) > 0 ? Number(depth) : null;
  const vars = useMemo(() => takeoffVariables(takeoff, depthIn), [takeoff, depthIn]);
  // An item with a depth of its own in the price list (6 inches of stone base) is worked out at
  // that; the rest at the depth typed here. The server does the same (item_depths).
  const valueOf = (s: Service) => (s.formula ? formulaValue(s.formula, s.default_depth_in != null ? { ...vars, depth_in: Number(s.default_depth_in) } : vars) : null);
  // The calculator prices the asphalt itself, so the price list's paving is only shown to take it off.
  const covered = useMemo(() => new Set(services.filter((s) => pavesAsphalt(s.formula, s.name)).map((s) => s.id)), [services]);
  const rows = services
    .map((s) => ({ service: s, kind: kinds.get(s.id) ?? "other", qty: valueOf(s) }))
    .filter((r) => onEstimate.has(r.service.id) || ((r.qty ?? 0) > 0 && !covered.has(r.service.id) && (r.kind === "other" || r.kind === work)));
  const twice = priced ? rows.filter((r) => onEstimate.has(r.service.id) && covered.has(r.service.id)).map((r) => r.service.name) : [];
  const calculatorLink = `/paving/calculator?quote=${quote.id}`;
  const needsDepth = rows.some((r) => usesDepth(r.service.formula) && r.service.default_depth_in == null && (r.kind !== "pave" || work === "pave"));

  const add = useMutation({
    mutationFn: async (list: Service[]) => {
      const sort = quote.lines.reduce((m, l) => Math.max(m, l.sort), 0);
      const lines = list.map((s, i) => {
        const value = valueOf(s) ?? 0;
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
      await api.post(`/quotes/${quote.id}/apply-measurement`, { measurement_id: takeoff.id, item_depths: true, ...(depthIn ? { depth_in: depthIn } : {}) });
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
    mutationFn: () => api.post(`/quotes/${quote.id}/apply-measurement`, { measurement_id: takeoff.id, item_depths: true, ...(depthIn ? { depth_in: depthIn } : {}) }),
    onSuccess: onChanged,
  });
  const repriced = useJustDone(reprice);
  const notYet = rows.filter((r) => !onEstimate.has(r.service.id));
  const busy = add.isPending || remove.isPending || reprice.isPending;

  const optionsChanged = () => {
    void queryClient.invalidateQueries({ queryKey: quoteOptionsKey(quote.id) });
    onChanged();
  };

  return (
    <div className="paving-step-body">
      {(editable || quote.options.length > 0) && quote.lines.length > 0 && (
        <QuoteOptions quote={quote} options={quote.options} lines={quote.lines} viewing={viewing} onView={setViewing} mode="office" onChanged={optionsChanged} panelId={panelId} />
      )}
      {editable && (
        <div className={styles.work}>
          <div className={styles.workField}>
            <span className={styles.fieldLabel} id={`${panelId}-work`}>What's the asphalt getting?</span>
            <div className="segmented" role="group" aria-labelledby={`${panelId}-work`}>
              {ASPHALT_WORK.map((w) => <button key={w.id} type="button" aria-pressed={work === w.id} onClick={() => setWork(w.id)}>{w.label}</button>)}
            </div>
          </div>
          {needsDepth && (
            <label className={styles.workField}>
              <span className={styles.fieldLabel}>Depth (in)</span>
              <DecimalInput className="input" inputMode="decimal" value={depth} onChange={(e) => setDepth(e.target.value.replace(/[^0-9.]/g, ""))} style={{ width: 90 }} />
            </label>
          )}
        </div>
      )}

      {/* The paving first: priced on the calculator. */}
      {priced ? (
        <WorksheetsCard quoteId={quote.id} editable={editable} level={3} flush />
      ) : (
        editable &&
        work === "pave" && (
          <div className={styles.calcLead}>
            <span className="rel-icon" aria-hidden="true"><Icon name="calculator" size={15} /></span>
            <span className={styles.calcLeadText}>
              <span className={styles.calcLeadTitle}>Price the paving on the calculator</span>
              The takeoff's {formatNumber(vars.asphalt_sqft ?? 0)} sq ft of asphalt fills in. Its tons, crew days, trucking and profit work out there, and the job goes on this estimate as one line.
            </span>
            {/* The way forward while nothing's priced; once something is, the proposal's Send is the green one. */}
            <Link className={cx("btn", current ? "btn-primary" : "btn-sm")} to={calculatorLink}><Icon name="calculator" size={current ? 16 : 14} />Use the calculator</Link>
          </div>
        )
      )}
      {twice.length > 0 && (
        <div className="callout callout-warning" role="status">
          <Icon name="alert" size={16} />
          <span className="grow">The asphalt is priced twice: on the calculator, and by {twice.join(" and ")} from your price list. Untick {twice.length === 1 ? "it" : "them"} below unless that's on purpose.</span>
        </div>
      )}

      {editable && (
        <div className={styles.extras}>
          <div className={styles.subhead}>
            <h3 className={styles.subheadTitle}>{work === "pave" ? "Extras from your price list" : "Services from your price list"}</h3>
            {notYet.length > 1 && (
              <button type="button" className={styles.subheadAction} disabled={busy} onClick={() => add.mutate(notYet.filter((r) => r.qty !== null).map((r) => r.service))}>
                {add.isPending ? <span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" /> : <Icon name="plus" size={14} />}
                Add all {notYet.length}
              </button>
            )}
          </div>
          {work === "pave" && <p className="paving-step-note">Sealcoat, striping, crack seal, patching and the rest. The asphalt itself is priced on the calculator.</p>}
          {tab && (
            <div className={styles.place}>
              <span id={`${panelId}-place`}>For {label}. What you tick goes</span>
              <div className="segmented" role="group" aria-labelledby={`${panelId}-place`}>
                <button type="button" aria-pressed={place === "only"} onClick={() => setPlace("only")}>Only on {label}</button>
                <button type="button" aria-pressed={place === "every"} onClick={() => setPlace("every")}>On every option</button>
              </div>
            </div>
          )}
          {loadingServices ? (
            <p className="paving-step-note" role="status">Loading your price list…</p>
          ) : !rows.length ? (
            <EmptyState inline title={work === "pave" ? "No extras from your price list for this takeoff" : "None of your services price from this takeoff"}>
              Add the standard paving services on the <Link to="/paving">Paving</Link> page, or give your own a formula in <Link to="/settings?tab=prices">Settings → Price list</Link>.
            </EmptyState>
          ) : (
            <ul className={styles.services} role="list">
              {rows.map(({ service, qty }) => {
                const on = onEstimate.has(service.id);
                const byPrice = service.formula_target === "unit_price";
                const goesTo = tab && !on ? destination(service) : null;
                // Where it is, or where it goes when that isn't where the control says.
                const where = !tab ? null : on ? (shared.has(service.id) ? destinationText(null, label) : null) : goesTo && place === "every" ? destinationText(goesTo, label) : null;
                const what = !tab ? "the estimate" : on ? (shared.has(service.id) ? "every option" : label) : goesTo ? label : "every option";
                return (
                  <li key={service.id}>
                    <label className={styles.service} data-on={on || undefined}>
                      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => (e.target.checked ? add.mutate([service]) : remove.mutate(service))} aria-label={`${on ? "Take" : "Put"} ${service.name} ${on ? "off" : "on"} ${what}`} />
                      <span className={styles.serviceText}>
                        <span className={styles.serviceName}>{service.name}</span>
                        <span className={styles.serviceSub}>
                          {qty === null ? "Needs a value the takeoff doesn't have" : byPrice ? `Price works out to ${formatMoney(qty)}` : `${formatNumber(qty, qty < 100 ? 2 : 0)} ${service.unit} × ${formatMoneyCents(service.unit_price)}`}
                          {where ? ` · ${where}` : ""}
                          {on && covered.has(service.id) ? " · The calculator prices the asphalt now" : ""}
                        </span>
                      </span>
                      {qty !== null && <span className={styles.serviceAmount}>{formatMoney(byPrice ? qty : qty * service.unit_price)}</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {((work !== "pave" && !priced) || quote.lines.some((l) => l.formula)) && (
            <div className="paving-step-foot">
              {work !== "pave" && !priced && <Link className="btn btn-sm" to={calculatorLink}><Icon name="calculator" size={14} />Use the calculator</Link>}
              {quote.lines.some((l) => l.formula) && (
                <Button size="sm" icon="refresh" loading={reprice.isPending} done={repriced} doneLabel="Updated" disabled={busy} onClick={() => reprice.mutate()} title="Work the quantities out again from the takeoff">
                  Update quantities
                </Button>
              )}
            </div>
          )}
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
