/**
 * A trade project's page, start to finish: the takeoff from the map, the estimate priced from the
 * price list, the proposal the client signs online, the job and its schedule, and the invoices.
 * Paving (PavingProjectPage) passes its takeoff and estimate in. Each step uses the records the rest
 * of Crewtavo uses (quote, job, invoices), so nothing is typed twice.
 *
 * Each trade has its own steps and works out its own current step (FlowTrade). Roofing has six
 * (measure, estimate, range, site visit, schedule, invoice) and builds its page from the pieces
 * exported here (the progress pills, the step cards, the invoices), with the roof estimate's own
 * data (features/roofing/RoofingProjectPage.tsx).
 *
 * A quote can offer two or three options (quotes/options.ts): the estimate shows one at a time with
 * the shared lines, its cost and margin counted the way the database counts it (core countsOn and
 * optionTotals), and it becomes a job once it's approved for the option chosen.
 */
import type { LineMaterials } from "@crewtavo/core/materials";
import { countsOn, optionLabels, type TotalsPromo } from "@crewtavo/core/money";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { usePictures } from "../measure/drawings";
import { QUOTE_OPTIONS_EMBED, sortOptions, type QuoteOptionRow } from "../quotes/options";
import { SendDialog } from "../quotes/SendDialog";
import { currentStep, estimateSums, TAKEOFF_FIELDS, viewedLines, type FlowStep, type StepId, type TakeoffRow } from "./data";

export interface Line { id: string; option_id: string | null; name: string; quantity: number; unit: string; unit_price: number; unit_cost: number | null; taxable: boolean; formula: string | null; service_id: string | null; optional: boolean; selected: boolean; option_group: string | null; sort: number; materials: LineMaterials | null; material_cost: number | null }
export interface Quote {
  id: string;
  number: number | null;
  title: string;
  status: string;
  subtotal: number;
  discount_amount: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  promo: TotalsPromo | null;
  /** The option shown first (once signed, the one chosen); null without options. */
  option_id: string | null;
  /** The package of the option shown, or of the estimate. */
  roof_package_id: string | null;
  priced_on_site_at: string | null;
  sent_at: string | null;
  approved_at: string | null;
  approval: { name?: string; signature?: string | null } | null;
  client: { id: string; display_name: string; email: string | null; phone: string | null } | null;
  property: { id: string; line1: string | null; city: string | null; region: string | null; postal_code: string | null } | null;
  lines: Line[];
  /** The options it offers, in order; none for a single estimate. */
  options: QuoteOptionRow[];
  jobs: Array<{ id: string; number: number | null; status: string }>;
}
export interface Service { id: string; name: string; unit: string; unit_price: number; unit_cost: number | null; taxable: boolean; formula: string | null; formula_target: string; category: string | null }
export const SERVICE_FIELDS = "id, name, unit, unit_price, unit_cost, taxable, formula, formula_target, category";

/** Quotes whose lines can still change. */
export const EDITABLE = ["draft", "sent", "changes_requested"];

/** A project's quote as far as its step goes. */
export interface FlowQuote {
  status: string;
  lines: readonly unknown[];
  jobs: ReadonlyArray<{ id: string; status: string }>;
}

/** What a trade's project page says and where it links. */
export interface FlowTrade<Id extends string = StepId> {
  /** Query keys and the Measure link's flag (`/measure?paving=1`). */
  id: "paving" | "roofing";
  name: string;
  path: string;
  steps: Array<FlowStep<Id>>;
  /** Where a project is: the first step not done yet. Paving's is currentStep. */
  current?: (q: FlowQuote, takeoff: TakeoffRow | null, invoices: Array<{ status: string }>) => Id | "done";
  notFound: string;
  takeoff: { empty: string; text: string; start: string; after: string; first: string };
  /** The picture of the takeoff on the proposal: "takeoff sheet", "roof report". */
  sheet: { name: string; text: string; missing: string };
}

export interface TakeoffProps { takeoff: TakeoffRow; picture?: string; editLink: string | null }
export interface EstimateProps { quote: Quote; takeoff: TakeoffRow; editable: boolean; onChanged: () => void }

export const scrollToStep = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

/** Where the map opens for a project: its roof or lot, else a new drawing at the property. */
export function measureLinkFor(trade: Pick<FlowTrade<string>, "id">, quote: { id: string; property: { id: string } | null }, takeoff: { id: string } | null): string {
  return takeoff
    ? `/measure?measurement=${takeoff.id}&${trade.id}=1`
    : `/measure?${new URLSearchParams({ quote: quote.id, [trade.id]: "1", ...(quote.property ? { property: quote.property.id } : {}) })}`;
}

/** Opened at a step (#estimate from the map): scroll to it once the page is there, not again on every refresh. */
export function useScrollToHash(ready: boolean) {
  const location = useLocation();
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !location.hash || scrolledTo.current === location.hash) return;
    scrolledTo.current = location.hash;
    scrollToStep(location.hash.slice(1));
  }, [ready, location.hash]);
}

export interface FlowInvoice { id: string; number: number | null; kind: string; status: string; total: number; balance_due: number }

/** A project's job's invoices (for the people who see invoices). */
export function useJobInvoices(job: { id: string } | null, enabled: boolean) {
  return useQuery({
    queryKey: ["job", job?.id, "invoices"],
    enabled: Boolean(job && enabled),
    queryFn: async () => unwrap(await supabase().from("invoices").select("id, number, kind, status, total, balance_due").eq("job_id", job!.id).order("number")) as FlowInvoice[],
  });
}

export function ProjectFlow({ trade, takeoffView, estimateView }: { trade: FlowTrade; takeoffView: (props: TakeoffProps) => ReactNode; estimateView: (props: EstimateProps) => ReactNode }) {
  const { id = "" } = useParams();
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const canSell = hasRole(session, "admin", "office", "estimator");
  const seesInvoices = hasRole(session, "admin", "office");

  const project = useQuery({
    queryKey: [`${trade.id}-project`, id],
    queryFn: async () => {
      const db = supabase();
      const [quote, takeoff] = await Promise.all([
        db
          .from("quotes")
          .select(
            `id, number, title, status, subtotal, discount_amount, tax_rate, tax_amount, total, promo:promo_codes(kind, value), option_id, roof_package_id, priced_on_site_at, sent_at, approved_at, approval, client:clients(id, display_name, email, phone), property:properties(id, line1, city, region, postal_code), lines:quote_line_items(id, option_id, name, quantity, unit, unit_price, unit_cost, taxable, formula, service_id, optional, selected, option_group, sort, materials, material_cost), ${QUOTE_OPTIONS_EMBED}, jobs!jobs_company_id_quote_id_fkey(id, number, status)`,
          )
          .eq("id", id)
          .maybeSingle(),
        db.from("measurements").select(TAKEOFF_FIELDS).eq("quote_id", id).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const q = unwrap(quote) as unknown as Quote | null;
      if (!q) throw new Error(trade.notFound);
      q.lines.sort((a, b) => a.sort - b.sort);
      return { quote: { ...q, options: sortOptions(q.options ?? []) }, takeoff: (unwrap(takeoff) ?? null) as TakeoffRow | null };
    },
  });
  const job = project.data?.quote.jobs[0] ?? null;
  const invoices = useJobInvoices(job, seesInvoices);
  const pictures = usePictures([project.data?.takeoff?.snapshot_path]);
  useScrollToHash(Boolean(project.data));

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [`${trade.id}-project`, id] });
    queryClient.invalidateQueries({ queryKey: [`${trade.id}-projects`, company.id] });
    queryClient.invalidateQueries({ queryKey: ["quote", id] });
  };

  if (project.isPending) return <DetailSkeleton />;
  if (project.error || !project.data) {
    return (
      <>
        <BackLink to={trade.path}>{trade.name}</BackLink>
        <ErrorState error={project.error} onRetry={() => project.refetch()} />
      </>
    );
  }
  const { quote: q, takeoff } = project.data;
  const steps = trade.steps;
  const step = (trade.current ?? currentStep)(q, takeoff, invoices.data ?? []);
  const reached = (s: StepId) => step === "done" || steps.findIndex((x) => x.id === s) <= steps.findIndex((x) => x.id === step);
  const measureLink = measureLinkFor(trade, q, takeoff);
  const label = (s: StepId) => steps.find((x) => x.id === s)!.label;

  return (
    <>
      <BackLink to={trade.path}>{trade.name}</BackLink>
      <PageHeader title={q.title} actions={<Link className="btn" to={`/quotes/${q.id}`}>Open the quote</Link>} />
      <p className="page-subtitle">{[q.client?.display_name, q.property ? addressLine(q.property) : null, q.number ? `Quote #${q.number}` : null].filter(Boolean).join(" · ")}</p>

      <FlowProgress steps={steps} step={step} />
      {q.status === "lost" && <div className="callout callout-danger" role="status"><Icon name="alert" size={18} /><span className="grow">This proposal was marked lost.</span></div>}

      <div className="stack" style={{ gap: 16 }}>
        <StepCard id="takeoff" n={1} title={label("takeoff")} status={takeoff ? `Updated ${timeAgo(takeoff.updated_at)}` : "Not measured yet"} done={Boolean(takeoff)}>
          {!takeoff ? (
            <TakeoffEmpty trade={trade} measureLink={canSell ? measureLink : null} />
          ) : (
            takeoffView({ takeoff, picture: takeoff.snapshot_path ? pictures.data?.[takeoff.snapshot_path] : undefined, editLink: canSell ? measureLink : null })
          )}
        </StepCard>

        <StepCard
          id="estimate"
          n={2}
          title={label("estimate")}
          status={q.options.length ? `${q.options.length} options` : q.lines.length ? `${q.lines.length} ${q.lines.length === 1 ? "line" : "lines"} · ${formatMoney(q.subtotal)}` : reached("estimate") ? "Not priced yet" : trade.takeoff.after}
          done={q.lines.length > 0}
        >
          {!takeoff ? (
            <span className="muted small">{trade.takeoff.first}</span>
          ) : (
            estimateView({ quote: q, takeoff, editable: canSell && EDITABLE.includes(q.status), onChanged: refresh })
          )}
        </StepCard>

        <StepCard id="proposal" n={3} title={label("proposal")} status={proposalStatus(q)} done={["approved", "converted"].includes(q.status)}>
          {!q.lines.length ? <span className="muted small">Price the estimate first; the proposal shows its lines.</span> : <Proposal quote={q} takeoff={takeoff} sheet={trade.sheet} canSell={canSell} onChanged={refresh} />}
        </StepCard>

        <StepCard id="schedule" n={4} title={label("schedule")} status={job ? `Job #${job.number}` : q.status === "approved" ? "Ready to schedule" : "After it's signed"} done={Boolean(job)}>
          <Schedule quote={q} job={job} canSell={canSell} onChanged={refresh} />
        </StepCard>

        <StepCard id="invoice" n={5} title={label("invoice")} status={invoiceStatus(job, invoices.data)} done={step === "done"}>
          <InvoiceStepBody job={job} seesInvoices={seesInvoices} invoices={invoices.data} />
        </StepCard>
      </div>
    </>
  );
}

/** The pills along the top: done steps checked, the current one filled. Each scrolls to its card. */
export function FlowProgress<Id extends string>({ steps, step }: { steps: ReadonlyArray<FlowStep<Id>>; step: Id | "done" }) {
  return (
    <ol className="paving-progress" aria-label="Where this project is">
      {steps.map((s, i) => {
        const done = step === "done" || steps.findIndex((x) => x.id === step) > i;
        return (
          <li key={s.id} data-state={done ? "done" : s.id === step ? "current" : "todo"}>
            <a href={`#${s.id}`} aria-current={s.id === step ? "step" : undefined} onClick={(e) => { e.preventDefault(); scrollToStep(s.id); }}>
              <span className="paving-progress-dot">{done ? <Icon name="check" size={14} strokeWidth={3} /> : i + 1}</span>
              <span>{s.label}</span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}

/** The first step before anything's measured: what to do, and the way to the map. */
export function TakeoffEmpty({ trade, measureLink }: { trade: Pick<FlowTrade<string>, "takeoff">; measureLink: string | null }) {
  return (
    <EmptyState compact icon="area" title={trade.takeoff.empty} action={measureLink && <Link className="btn btn-primary" to={measureLink}><Icon name="area" size={16} /> {trade.takeoff.start}</Link>}>
      {trade.takeoff.text}
    </EmptyState>
  );
}

/** "2 invoices", "Not billed yet", "After the job". */
export const invoiceStatus = (job: unknown, invoices: readonly unknown[] | undefined) =>
  invoices?.length ? `${invoices.length} ${invoices.length === 1 ? "invoice" : "invoices"}` : job ? "Not billed yet" : "After the job";

/** The last step: the job's invoices, and making the next one. */
export function InvoiceStepBody({ job, seesInvoices, invoices }: { job: { id: string } | null; seesInvoices: boolean; invoices: FlowInvoice[] | undefined }) {
  if (!job) return <span className="muted small">Bill the deposit and the rest once there's a job.</span>;
  if (!seesInvoices) return <span className="muted small">The office bills this job.</span>;
  return (
    <div className="stack-sm">
      {(invoices ?? []).map((inv) => (
        <Link key={inv.id} to={`/invoices/${inv.id}`} className="card-row paving-row">
          <Icon name="invoice" size={16} />
          <span className="grow">Invoice #{inv.number}{inv.kind !== "standard" ? ` · ${inv.kind}` : ""}</span>
          <span className="num">{formatMoney(inv.total)}</span>
          <EntityStatus kind="invoice" status={inv.status} />
        </Link>
      ))}
      <Link className="btn" style={{ justifySelf: "start" }} to={`/jobs/${job.id}?invoice=1`}><Icon name="invoice" size={16} /> {invoices?.length ? "Create another invoice" : "Create an invoice"}</Link>
      <span className="muted small">Deposit, progress or final: clients pay online from their link.</span>
    </div>
  );
}

function proposalStatus(q: Quote): string {
  if (q.status === "approved" || q.status === "converted") return `Signed${q.approved_at ? ` ${formatDate(q.approved_at)}` : ""}${q.approval?.name ? ` by ${q.approval.name}` : ""}`;
  if (q.status === "changes_requested") return "Changes requested";
  if (q.status === "sent") return `Sent${q.sent_at ? ` ${formatDate(q.sent_at)}` : ""}, waiting on the client`;
  if (q.status === "lost") return "Lost";
  return q.lines.length ? "Ready to send" : "After the estimate";
}

/** One step's card: its number (a check once done), its name and where it stands, then its body. */
export function StepCard({ id, n, title, status, done, current, children }: { id: string; n: number; title: string; status: string; done: boolean; current?: boolean; children: ReactNode }) {
  return (
    <section id={id} className="card paving-step-card" data-current={current || undefined} aria-labelledby={`${id}-title`} style={{ scrollMarginTop: 16 }}>
      <div className="card-head">
        <span className="paving-progress-dot" data-done={done || undefined} aria-hidden="true">{done ? <Icon name="check" size={14} strokeWidth={3} /> : n}</span>
        <h2 id={`${id}-title`}>{title}</h2>
        <span className="muted small">{status}</span>
      </div>
      <div className="card-pad">{children}</div>
    </section>
  );
}

/**
 * The estimate's lines with their cost, price and margin, the totals, and on to the proposal. With
 * options, the option looked at (`optionId`, called `optionLabel`) and the shared lines, priced as
 * that option (data.ts estimateSums).
 */
export function EstimateLines({ quote, optionId = null, optionLabel = null }: { quote: Quote; optionId?: string | null; optionLabel?: string | null }) {
  const lines = viewedLines(quote.lines, optionId);
  const counted = (l: Line) => countsOn(l, optionId);
  // Materials priced at the supplier (Roofing → Materials), for the lines that count.
  const { cost, costKnown, price, profit, margin, total, materials, materialsPartial } = estimateSums(quote, optionId);
  // With options, the tiers are the options' own: a group of lines is just one to pick.
  const groups = optionLabels(lines);
  const choices = quote.options.length ? new Map([...groups.keys()].map((id) => [id, "Pick one"])) : groups;
  const signed = quote.status === "approved" || quote.status === "converted";
  const choiceNote = (selected: boolean) => (signed ? (selected ? "the client's pick" : "not picked") : selected ? "shown first" : "the client can pick it");
  return (
    <div className="stack-sm">
      <table className="table paving-estimate">
        <thead><tr><th>On the estimate</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Cost</th><th className="num">Total</th><th className="num">Margin</th></tr></thead>
        <tbody>
          {lines.map((l) => {
            const total = Number(l.quantity) * Number(l.unit_price);
            const lineCost = l.unit_cost != null ? Number(l.quantity) * Number(l.unit_cost) : null;
            const choice = choices.get(l.id);
            return (
              <tr key={l.id} data-optional={!counted(l) || undefined}>
                <td>
                  {choice && <span className="chip chip-blue estimate-choice">{choice}</span>}
                  {l.name}
                  {l.optional && <span className="muted small"> · {choice ? choiceNote(l.selected) : "optional"}</span>}
                </td>
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
        {materials !== null && <div><dt>Materials</dt><dd>{formatMoney(materials)}{materialsPartial ? "+" : ""}</dd></div>}
        <div><dt>Cost</dt><dd>{costKnown ? formatMoney(cost) : `${formatMoney(cost)}+`}</dd></div>
        <div><dt>Price</dt><dd>{formatMoney(price)}</dd></div>
        <div><dt>Profit</dt><dd data-good={profit > 0 || undefined}>{costKnown ? formatMoney(profit) : "—"}</dd></div>
        <div><dt>Margin</dt><dd>{margin === null ? "—" : `${margin}%`}</dd></div>
        <div><dt>Total with tax</dt><dd>{formatMoney(total)}</dd></div>
      </dl>
      {!signed && quote.options.length > 0 && optionLabel ? (
        <span className="muted small">
          The totals are for {optionLabel}{choices.size > 0 ? ", with the choices shown first" : ""}. The client chooses one of the options on the proposal, and the total follows.
        </span>
      ) : (
        choices.size > 0 && !signed && <span className="muted small">The totals are for the choice shown first. The client picks one on the proposal, and the total follows.</span>
      )}
      {!costKnown && <span className="muted small">Add costs to your services in the price list to see the profit on every line.</span>}
      <div className="row wrap" style={{ gap: 8 }}>
        <Link className="btn" to={`/quotes/${quote.id}`}>Adjust on the quote</Link>
        <a className="btn btn-primary" href="#proposal" onClick={(e) => { e.preventDefault(); scrollToStep("proposal"); }}>Next: Proposal <Icon name="arrowRight" size={15} /></a>
      </div>
    </div>
  );
}

function Proposal({ quote, takeoff, sheet, canSell, onChanged }: { quote: Quote; takeoff: TakeoffRow | null; sheet: FlowTrade["sheet"]; canSell: boolean; onChanged: () => void }) {
  const [sending, setSending] = useState(false);
  const preview = useMutation({
    mutationFn: () => api.get<{ link: string }>(`/quotes/${quote.id}/link`),
    onSuccess: ({ link }) => window.open(link, "_blank", "noopener"),
  });
  const showSheet = useMutation({
    meta: { success: (_: unknown, on: boolean) => (on ? `The client will see the ${sheet.name} on the proposal` : `The ${sheet.name} is hidden from the client`) },
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
            <strong>Show the {sheet.name} on the proposal</strong>
            <span className="muted small">{takeoff.snapshot_path ? sheet.text : sheet.missing}</span>
          </span>
        </label>
      )}
      {signed && quote.approval?.signature && <img src={quote.approval.signature} alt={`Signature of ${quote.approval.name ?? "the client"}`} className="paving-signature" />}
      <div className="row wrap" style={{ gap: 8 }}>
        <Button icon="eye" loading={preview.isPending} onClick={() => preview.mutate()}>Preview what the client sees</Button>
        {canSell && !signed && quote.status !== "lost" && <Button variant="primary" icon="send" onClick={() => setSending(true)}>{quote.status === "draft" ? "Send the proposal" : "Send it again"}</Button>}
      </div>
      <span className="muted small">
        {signed
          ? "Signed online: schedule the job next."
          : `The client opens it on any phone or computer, ${quote.options.length ? `chooses one of the ${quote.options.length} options, ` : ""}picks any optional items and signs. No account needed.`}
      </span>
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
  // An estimate with options becomes the job of the one they chose, so that's marked first (the quote's Mark approved asks which).
  if (!signed && quote.options.length) {
    return (
      <span className="muted small">
        Usually once the client signs for the option they chose. If they said yes another way, <Link to={`/quotes/${quote.id}`}>mark it approved on the quote</Link> with their option, then create the job here.
      </span>
    );
  }
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
