/**
 * One paving project, start to finish, on one page: the takeoff from the map, the estimate priced
 * from the price list (services whose formulas read the takeoff's items), the proposal the client
 * signs online, the job and its schedule, and the invoices. Each step uses the records the rest of
 * Crewtavo uses (quote, job, invoices), so nothing is typed twice.
 */
import { PAVING_ITEMS } from "@crewtavo/core/paving";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus, StatusPill } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { addressLine, formatDate, formatMoney, formatMoneyCents, formatNumber, timeAgo } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { usePictures } from "../measure/drawings";
import { formatItemTotal, ItemSwatch } from "../measure/PavingItems";
import { SendDialog } from "../quotes/SendDialog";
import { currentStep, formulaValue, sectionsOf, serviceKind, STEPS, TAKEOFF_FIELDS, takeoffVariables, usesDepth, type StepId, type TakeoffRow } from "./data";

interface Line { id: string; name: string; quantity: number; unit: string; unit_price: number; unit_cost: number | null; formula: string | null; service_id: string | null; optional: boolean; selected: boolean; sort: number }
interface Quote {
  id: string;
  number: number | null;
  title: string;
  status: string;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  sent_at: string | null;
  approved_at: string | null;
  approval: { name?: string; signature?: string | null } | null;
  client: { id: string; display_name: string; email: string | null; phone: string | null } | null;
  property: { id: string; line1: string | null; city: string | null; region: string | null; postal_code: string | null } | null;
  lines: Line[];
  jobs: Array<{ id: string; number: number | null; status: string }>;
}
interface Service { id: string; name: string; unit: string; unit_price: number; unit_cost: number | null; taxable: boolean; formula: string | null; formula_target: string; category: string | null }

const EDITABLE = ["draft", "sent", "changes_requested"];
const ASPHALT_WORK = [
  { id: "seal", label: "Sealcoat it" },
  { id: "pave", label: "Pave it" },
  { id: "none", label: "Neither" },
] as const;
type AsphaltWork = (typeof ASPHALT_WORK)[number]["id"];

export function PavingProjectPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const location = useLocation();
  const canSell = hasRole(session, "admin", "office", "estimator");
  const seesInvoices = hasRole(session, "admin", "office");

  const project = useQuery({
    queryKey: ["paving-project", id],
    queryFn: async () => {
      const db = supabase();
      const [quote, takeoff] = await Promise.all([
        db
          .from("quotes")
          .select("id, number, title, status, subtotal, discount_amount, tax_amount, total, sent_at, approved_at, approval, client:clients(id, display_name, email, phone), property:properties(id, line1, city, region, postal_code), lines:quote_line_items(id, name, quantity, unit, unit_price, unit_cost, formula, service_id, optional, selected, sort), jobs!jobs_company_id_quote_id_fkey(id, number, status)")
          .eq("id", id)
          .maybeSingle(),
        db.from("measurements").select(TAKEOFF_FIELDS).eq("quote_id", id).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const q = unwrap(quote) as unknown as Quote | null;
      if (!q) throw new Error("That paving project wasn't found. It may have been deleted.");
      q.lines.sort((a, b) => a.sort - b.sort);
      return { quote: q, takeoff: (unwrap(takeoff) ?? null) as TakeoffRow | null };
    },
  });
  const services = useQuery({
    queryKey: ["services", company.id, "with-formulas"],
    queryFn: async () => unwrap(await supabase().from("services").select("id, name, unit, unit_price, unit_cost, taxable, formula, formula_target, category").eq("company_id", company.id).eq("active", true).not("formula", "is", null).order("sort").order("name")) as Service[],
  });
  const job = project.data?.quote.jobs[0] ?? null;
  const invoices = useQuery({
    queryKey: ["job", job?.id, "invoices"],
    enabled: Boolean(job && seesInvoices),
    queryFn: async () => unwrap(await supabase().from("invoices").select("id, number, kind, status, total, balance_due").eq("job_id", job!.id).order("number")),
  });
  const pictures = usePictures([project.data?.takeoff?.snapshot_path]);

  // Opened at a step (#estimate from the map): scroll to it once it's on the page, not again on every refresh.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!project.data || !location.hash || scrolledTo.current === location.hash) return;
    scrolledTo.current = location.hash;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [project.data, location.hash]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["paving-project", id] });
    queryClient.invalidateQueries({ queryKey: ["paving-projects", company.id] });
    queryClient.invalidateQueries({ queryKey: ["quote", id] });
  };

  if (project.isPending) return <DetailSkeleton />;
  if (project.error || !project.data) {
    return (
      <>
        <BackLink to="/paving">Paving</BackLink>
        <ErrorState error={project.error} onRetry={() => project.refetch()} />
      </>
    );
  }
  const { quote: q, takeoff } = project.data;
  const step = currentStep(q, takeoff, invoices.data ?? []);
  const reached = (s: StepId) => step === "done" || STEPS.findIndex((x) => x.id === s) <= STEPS.findIndex((x) => x.id === step);
  const measureLink = takeoff ? `/measure?measurement=${takeoff.id}&paving=1` : `/measure?${new URLSearchParams({ quote: q.id, paving: "1", ...(q.property ? { property: q.property.id } : {}) })}`;

  return (
    <>
      <BackLink to="/paving">Paving</BackLink>
      <PageHeader title={q.title} actions={<Link className="btn" to={`/quotes/${q.id}`}>Open the quote</Link>} />
      <p className="page-subtitle">{[q.client?.display_name, q.property ? addressLine(q.property) : null, q.number ? `Quote #${q.number}` : null].filter(Boolean).join(" · ")}</p>

      <ol className="paving-progress" aria-label="Where this project is">
        {STEPS.map((s, i) => {
          const done = step === "done" || STEPS.findIndex((x) => x.id === step) > i;
          return (
            <li key={s.id} data-state={done ? "done" : s.id === step ? "current" : "todo"}>
              <a href={`#${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                <span className="paving-progress-dot">{done ? <Icon name="check" size={14} strokeWidth={3} /> : i + 1}</span>
                <span>{s.label}</span>
              </a>
            </li>
          );
        })}
      </ol>
      {q.status === "lost" && <div className="callout callout-danger" role="status"><Icon name="alert" size={18} /><span className="grow">This proposal was marked lost.</span></div>}

      <div className="stack" style={{ gap: 16 }}>
        <StepCard id="takeoff" n={1} title="Takeoff" status={takeoff ? `Updated ${timeAgo(takeoff.updated_at)}` : "Not measured yet"} done={Boolean(takeoff)}>
          {!takeoff ? (
            <EmptyState compact icon="area" title="Measure the lot" action={canSell && <Link className="btn btn-primary" to={measureLink}><Icon name="area" size={16} /> Start the takeoff</Link>}>
              Outline the asphalt, mark the striping, stalls and cracks on the aerial, or let Find paving outline it for you.
            </EmptyState>
          ) : (
            <TakeoffSummary takeoff={takeoff} picture={takeoff.snapshot_path ? pictures.data?.[takeoff.snapshot_path] : undefined} editLink={canSell ? measureLink : null} />
          )}
        </StepCard>

        <StepCard id="estimate" n={2} title="Estimate" status={q.lines.length ? `${q.lines.length} ${q.lines.length === 1 ? "line" : "lines"} · ${formatMoney(q.subtotal)}` : reached("estimate") ? "Not priced yet" : "After the takeoff"} done={q.lines.length > 0}>
          {!takeoff ? (
            <span className="muted small">Measure the lot first; the estimate prices from the takeoff.</span>
          ) : (
            <Estimate quote={q} takeoff={takeoff} services={services.data ?? []} loadingServices={services.isPending} editable={canSell && EDITABLE.includes(q.status)} onChanged={refresh} />
          )}
        </StepCard>

        <StepCard id="proposal" n={3} title="Proposal" status={proposalStatus(q)} done={["approved", "converted"].includes(q.status)}>
          {!q.lines.length ? <span className="muted small">Price the estimate first; the proposal shows its lines.</span> : <Proposal quote={q} takeoff={takeoff} canSell={canSell} onChanged={refresh} />}
        </StepCard>

        <StepCard id="schedule" n={4} title="Schedule" status={job ? `Job #${job.number}` : q.status === "approved" ? "Ready to schedule" : "After it's signed"} done={Boolean(job)}>
          <Schedule quote={q} job={job} canSell={canSell} onChanged={refresh} />
        </StepCard>

        <StepCard id="invoice" n={5} title="Invoice" status={invoices.data?.length ? `${invoices.data.length} ${invoices.data.length === 1 ? "invoice" : "invoices"}` : job ? "Not billed yet" : "After the job"} done={step === "done"}>
          {!job ? (
            <span className="muted small">Bill the deposit and the rest once there's a job.</span>
          ) : !seesInvoices ? (
            <span className="muted small">The office bills this job.</span>
          ) : (
            <div className="stack-sm">
              {(invoices.data ?? []).map((inv) => (
                <Link key={inv.id} to={`/invoices/${inv.id}`} className="card-row paving-row">
                  <Icon name="invoice" size={16} />
                  <span className="grow">Invoice #{inv.number}{inv.kind !== "standard" ? ` · ${inv.kind}` : ""}</span>
                  <span className="num">{formatMoney(inv.total)}</span>
                  <EntityStatus kind="invoice" status={inv.status} />
                </Link>
              ))}
              <Link className="btn" style={{ justifySelf: "start" }} to={`/jobs/${job.id}?invoice=1`}><Icon name="invoice" size={16} /> {invoices.data?.length ? "Create another invoice" : "Create an invoice"}</Link>
              <span className="muted small">Deposit, progress or final: clients pay online from their link.</span>
            </div>
          )}
        </StepCard>
      </div>
    </>
  );
}

function proposalStatus(q: Quote): string {
  if (q.status === "approved" || q.status === "converted") return `Signed${q.approved_at ? ` ${formatDate(q.approved_at)}` : ""}${q.approval?.name ? ` by ${q.approval.name}` : ""}`;
  if (q.status === "changes_requested") return "Changes requested";
  if (q.status === "sent") return `Sent${q.sent_at ? ` ${formatDate(q.sent_at)}` : ""}, waiting on the client`;
  if (q.status === "lost") return "Lost";
  return q.lines.length ? "Ready to send" : "After the estimate";
}

function StepCard({ id, n, title, status, done, children }: { id: StepId; n: number; title: string; status: string; done: boolean; children: ReactNode }) {
  return (
    <section id={id} className="card paving-step-card" aria-labelledby={`${id}-title`} style={{ scrollMarginTop: 16 }}>
      <div className="card-head">
        <span className="paving-progress-dot" data-done={done || undefined} aria-hidden="true">{done ? <Icon name="check" size={14} strokeWidth={3} /> : n}</span>
        <h2 id={`${id}-title`}>{title}</h2>
        <span className="muted small">{status}</span>
      </div>
      <div className="card-pad">{children}</div>
    </section>
  );
}

function TakeoffSummary({ takeoff, picture, editLink }: { takeoff: TakeoffRow; picture?: string; editLink: string | null }) {
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

function Estimate({ quote, takeoff, services, loadingServices, editable, onChanged }: { quote: Quote; takeoff: TakeoffRow; services: Service[]; loadingServices: boolean; editable: boolean; onChanged: () => void }) {
  const { company } = useSession();
  const [depth, setDepth] = useState("2");
  const onEstimate = new Set(quote.lines.map((l) => l.service_id).filter(Boolean));
  const kinds = useMemo(() => new Map(services.map((s) => [s.id, serviceKind(s.formula, s.name)])), [services]);
  // What the asphalt gets decides which area services are suggested; it starts from what's on the estimate.
  const [work, setWork] = useState<AsphaltWork>(() => {
    if (quote.lines.some((l) => l.service_id && kinds.get(l.service_id) === "pave")) return "pave";
    return "seal";
  });
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
    onError: (error) => toast.error((error as Error).message),
  });
  const remove = useMutation({
    mutationFn: async (service: Service) => unwrap(await supabase().from("quote_line_items").delete().eq("quote_id", quote.id).eq("service_id", service.id)),
    onSuccess: onChanged,
    onError: (error) => toast.error((error as Error).message),
  });
  const reprice = useMutation({
    meta: { success: "Quantities updated from the takeoff" },
    mutationFn: () => api.post(`/quotes/${quote.id}/apply-measurement`, { measurement_id: takeoff.id, ...(depthIn ? { depth_in: depthIn } : {}) }),
    onSuccess: onChanged,
  });
  const notYet = rows.filter((r) => !onEstimate.has(r.service.id));
  const busy = add.isPending || remove.isPending || reprice.isPending;

  const cost = quote.lines.reduce((t, l) => t + (l.unit_cost != null && (!l.optional || l.selected) ? Number(l.unit_cost) * Number(l.quantity) : 0), 0);
  const costKnown = quote.lines.every((l) => l.unit_cost != null);
  const price = Number(quote.subtotal);
  const profit = price - cost;
  const anyPaveOrSeal = services.some((s) => kinds.get(s.id) !== "other");

  return (
    <div className="stack" style={{ gap: 16 }}>
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
          {loadingServices ? (
            <span className="muted small">Loading your price list…</span>
          ) : !rows.length ? (
            <span className="muted small">
              None of your services price from what this takeoff measured. Add the standard paving services on the <Link to="/paving">Paving</Link> page, or give your own a formula in <Link to="/settings?tab=prices">Settings → Price list</Link>.
            </span>
          ) : (
            <div className="paving-services">
              {rows.map(({ service, qty }) => {
                const on = onEstimate.has(service.id);
                const byPrice = service.formula_target === "unit_price";
                return (
                  <label key={service.id} className="paving-service" data-on={on || undefined}>
                    <input type="checkbox" checked={on} disabled={busy} onChange={(e) => (e.target.checked ? add.mutate([service]) : remove.mutate(service))} aria-label={`${on ? "Take" : "Put"} ${service.name} ${on ? "off" : "on"} the estimate`} />
                    <span className="grow">
                      <strong>{service.name}</strong>
                      <span className="muted small">{qty === null ? "Needs a value the takeoff doesn't have" : byPrice ? `Price works out to ${formatMoney(qty)}` : `${formatNumber(qty, qty < 100 ? 2 : 0)} ${service.unit} × ${formatMoneyCents(service.unit_price)}`}</span>
                    </span>
                    <strong className="num">{qty === null ? "—" : formatMoney(byPrice ? qty : qty * service.unit_price)}</strong>
                  </label>
                );
              })}
            </div>
          )}
          <div className="row wrap" style={{ gap: 8 }}>
            {notYet.length > 1 && <Button variant="primary" icon="plus" loading={add.isPending} disabled={busy} onClick={() => add.mutate(notYet.filter((r) => r.qty !== null).map((r) => r.service))}>Add all {notYet.length} to the estimate</Button>}
            {quote.lines.some((l) => l.formula) && <Button icon="refresh" loading={reprice.isPending} disabled={busy} onClick={() => reprice.mutate()}>Update quantities from the takeoff</Button>}
          </div>
        </div>
      )}

      {quote.lines.length > 0 && (
        <div className="stack-sm">
          <table className="table paving-estimate">
            <thead><tr><th>On the estimate</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Cost</th><th className="num">Total</th><th className="num">Margin</th></tr></thead>
            <tbody>
              {quote.lines.map((l) => {
                const total = Number(l.quantity) * Number(l.unit_price);
                const lineCost = l.unit_cost != null ? Number(l.quantity) * Number(l.unit_cost) : null;
                return (
                  <tr key={l.id} data-optional={l.optional || undefined}>
                    <td>{l.name}{l.optional && <span className="muted small"> · optional</span>}</td>
                    <td className="num nowrap">{formatNumber(Number(l.quantity), Number(l.quantity) < 100 ? 2 : 0)} {l.unit}</td>
                    <td className="num">{formatMoneyCents(l.unit_price)}</td>
                    <td className="num">{lineCost === null ? <span className="muted">—</span> : formatMoney(lineCost)}</td>
                    <td className="num strong">{formatMoney(total)}</td>
                    <td className="num">{lineCost === null || !total ? <span className="muted">—</span> : `${Math.round(((total - lineCost) / total) * 100)}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <dl className="paving-totals">
            <div><dt>Cost</dt><dd>{costKnown ? formatMoney(cost) : `${formatMoney(cost)}+`}</dd></div>
            <div><dt>Price</dt><dd>{formatMoney(price)}</dd></div>
            <div><dt>Profit</dt><dd data-good={profit > 0 || undefined}>{costKnown ? formatMoney(profit) : "—"}</dd></div>
            <div><dt>Margin</dt><dd>{costKnown && price ? `${Math.round((profit / price) * 100)}%` : "—"}</dd></div>
            <div><dt>Total with tax</dt><dd>{formatMoney(quote.total)}</dd></div>
          </dl>
          {!costKnown && <span className="muted small">Add costs to your services in the price list to see the profit on every line.</span>}
          <div className="row wrap" style={{ gap: 8 }}>
            <Link className="btn" to={`/quotes/${quote.id}`}>Adjust on the quote</Link>
            <a className="btn btn-primary" href="#proposal" onClick={(e) => { e.preventDefault(); document.getElementById("proposal")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Next: Proposal <Icon name="arrowRight" size={15} /></a>
          </div>
        </div>
      )}
    </div>
  );
}

function Proposal({ quote, takeoff, canSell, onChanged }: { quote: Quote; takeoff: TakeoffRow | null; canSell: boolean; onChanged: () => void }) {
  const [sending, setSending] = useState(false);
  const preview = useMutation({
    mutationFn: () => api.get<{ link: string }>(`/quotes/${quote.id}/link`),
    onSuccess: ({ link }) => window.open(link, "_blank", "noopener"),
  });
  const showSheet = useMutation({
    meta: { success: (_: unknown, on: boolean) => (on ? "The client will see the takeoff sheet on the proposal" : "Takeoff sheet hidden from the client") },
    mutationFn: async (on: boolean) => unwrap(await supabase().from("measurements").update({ show_on_quote: on, quote_id: quote.id }).eq("id", takeoff!.id)),
    onSuccess: onChanged,
  });
  const signed = quote.status === "approved" || quote.status === "converted";
  return (
    <div className="stack-sm" style={{ gap: 12 }}>
      {takeoff && (
        <label className="switch-row">
          <input type="checkbox" className="switch" checked={takeoff.show_on_quote} disabled={!canSell || showSheet.isPending || !takeoff.snapshot_path} onChange={(e) => showSheet.mutate(e.target.checked)} />
          <span className="grow" style={{ display: "grid", gap: 1 }}>
            <strong>Show the takeoff sheet on the proposal</strong>
            <span className="muted small">{takeoff.snapshot_path ? "The site plan with its scale, legend and quantities, so the client sees exactly what you're bidding." : "Save the takeoff on the map first to make the sheet."}</span>
          </span>
        </label>
      )}
      {signed && quote.approval?.signature && <img src={quote.approval.signature} alt={`Signature of ${quote.approval.name ?? "the client"}`} className="paving-signature" />}
      <div className="row wrap" style={{ gap: 8 }}>
        <Button icon="eye" loading={preview.isPending} onClick={() => preview.mutate()}>Preview what the client sees</Button>
        {canSell && !signed && quote.status !== "lost" && <Button variant="primary" icon="send" onClick={() => setSending(true)}>{quote.status === "draft" ? "Send the proposal" : "Send it again"}</Button>}
      </div>
      <span className="muted small">{signed ? "Signed online: schedule the job next." : "The client opens it on any phone or computer, picks any optional items and signs. No account needed."}</span>
      {sending && <SendDialog kind="quote" id={quote.id} number={quote.number} email={quote.client?.email ?? null} phone={quote.client?.phone ?? null} onClose={() => setSending(false)} onSent={() => { setSending(false); onChanged(); }} />}
    </div>
  );
}

function Schedule({ quote, job, canSell, onChanged }: { quote: Quote; job: Quote["jobs"][number] | null; canSell: boolean; onChanged: () => void }) {
  const navigate = useNavigate();
  const convert = useMutation({
    meta: { success: "Job created. Schedule the work next." },
    mutationFn: () => api.post<{ job_id: string }>(`/quotes/${quote.id}/convert`),
    onSuccess: (res) => {
      onChanged();
      navigate(`/jobs/${res.job_id}`);
    },
  });
  if (job) {
    return (
      <div className="stack-sm">
        <Link to={`/jobs/${job.id}`} className="card-row paving-row">
          <Icon name="job" size={16} />
          <span className="grow">Job #{job.number}</span>
          <EntityStatus kind="job" status={job.status} />
        </Link>
        <Link className="btn" style={{ justifySelf: "start" }} to={`/jobs/${job.id}`}><Icon name="calendar" size={16} /> Schedule the visits</Link>
        <span className="muted small">Put it on a crew's day; the crew app shows them the scope, checklist and photos.</span>
      </div>
    );
  }
  if (!canSell) return <span className="muted small">The office turns it into a job once it's signed.</span>;
  const signed = quote.status === "approved";
  return (
    <div className="stack-sm">
      <Button variant={signed ? "primary" : undefined} icon="job" loading={convert.isPending} disabled={!quote.lines.length || quote.status === "lost"} onClick={() => convert.mutate()} style={{ justifySelf: "start" }}>
        {signed ? "Create the job" : "Create the job now"}
      </Button>
      <span className="muted small">{signed ? "The estimate's lines become the job's scope." : "Usually once the client signs. You can start it now if they said yes another way."}</span>
      {quote.status === "approved" && <StatusPill label="Signed" tone="good" />}
    </div>
  );
}
