/**
 * A trade project's page, start to finish: the takeoff from the map, the estimate priced from the
 * price list, the proposal the client signs online, the job and its schedule, and the invoices.
 * Paving (PavingProjectPage) passes its takeoff and estimate in. Each step uses the records the rest
 * of Crewtavo uses (quote, job, invoices), so nothing is typed twice.
 *
 * The page is a record page (DetailHeader, DetailColumns): the steps as a strip under the title, each
 * step a section on a hairline with its number (a check once done), and beside them the project's
 * facts. Only the step it's at has a green button, so the page has one.
 *
 * Each trade has its own steps and works out its own current step (FlowTrade). Roofing has six
 * (measure, estimate, range, site visit, schedule, invoice) and builds its page from the pieces
 * exported here (the step strip, the step sections, the invoices), with the roof estimate's own
 * data (features/roofing/RoofingProjectPage.tsx).
 *
 * A quote can offer two or three options (quotes/options.ts): the estimate shows one at a time with
 * the shared lines, its cost and margin counted the way the database counts it (core countsOn and
 * optionTotals), and it becomes a job once it's approved for the option chosen.
 */
import type { LineMaterials } from "@crewtavo/core/materials";
import { countsOn, optionLabels, type TotalsPromo } from "@crewtavo/core/money";
import { pavingQuantities } from "@crewtavo/core/paving";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { AnimatedNumber, MONEY } from "@/components/ui/AnimatedNumber";
import { Button, cx } from "@/components/ui/Button";
import { DetailColumns, DetailHeader } from "@/components/ui/DetailPage";
import { Icon } from "@/components/ui/Icon";
import { BackLink } from "@/components/ui/PageHeader";
import { Fact, Facts, RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus, StatusPill, statusText } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { addressLine, formatDate, formatMoney, formatMoneyCents, formatNumber, timeAgo } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { hasRole, useSession } from "@/lib/session";
import { usePictures } from "../measure/drawings";
import { QUOTE_OPTIONS_EMBED, sortOptions, type QuoteOptionRow } from "../quotes/options";
import { SendDialog } from "../quotes/SendDialog";
import { lowestOption, SIGNED } from "../roofing/flow/model";
import { currentStep, estimateSums, sectionsOf, stageLabel, TAKEOFF_FIELDS, viewedLines, type FlowStep, type StepId, type TakeoffRow } from "./data";
import styles from "./paving.module.css";

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
export interface Service { id: string; name: string; unit: string; unit_price: number; unit_cost: number | null; taxable: boolean; formula: string | null; formula_target: string; category: string | null; default_depth_in: number | null }
export const SERVICE_FIELDS = "id, name, unit, unit_price, unit_cost, taxable, formula, formula_target, category, default_depth_in";

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
/** `current`: the estimate is the step the project is at, so its way forward is the page's green button. */
export interface EstimateProps { quote: Quote; takeoff: TakeoffRow; editable: boolean; onChanged: () => void; current?: boolean }

/** Glides to a step's section, or jumps there for someone who prefers less motion. */
export const scrollToStep = (id: string) => {
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(id)?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
};

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
  const navigate = useNavigate();
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
  const preview = useMutation({
    mutationFn: () => api.get<{ link: string }>(`/quotes/${id}/link`),
    onSuccess: ({ link }) => window.open(link, "_blank", "noopener"),
  });
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
  const stage = stageLabel(q, Boolean(takeoff));
  const editable = canSell && EDITABLE.includes(q.status);
  const signed = SIGNED.includes(q.status);
  // Not chosen yet: from its cheapest option. Once signed, the total is the one chosen.
  const from = q.options.length && !signed ? lowestOption(q) : null;
  const asphalt = takeoff ? pavingQuantities(sectionsOf(takeoff)).asphalt_sqft ?? 0 : 0;

  return (
    <>
      <DetailHeader
        crumb={{ to: trade.path, label: trade.name }}
        title={q.title}
        status={<StatusPill label={stage.label} tone={stage.tone} />}
        meta={[q.client?.display_name, q.property ? addressLine(q.property) : null]}
        actions={<Link className="btn" to={`/quotes/${q.id}`}><Icon name="quote" size={16} />Open the quote</Link>}
        more={
          canSell
            ? [
                { label: "Preview the proposal", icon: "eye", kbd: "P", disabled: !q.lines.length || preview.isPending, onSelect: () => preview.mutate() },
                { label: takeoff ? "Edit the takeoff" : trade.takeoff.start, icon: "area", kbd: "M", onSelect: () => navigate(measureLink) },
                { label: "Price on the calculator", icon: "calculator", kbd: "C", hidden: !editable || !takeoff, onSelect: () => navigate(`/paving/calculator?quote=${q.id}`) },
                { separator: true },
                { label: "Open the client", icon: "user", hidden: !q.client, onSelect: () => navigate(`/clients/${q.client!.id}`) },
              ]
            : undefined
        }
      />

      <FlowProgress steps={steps} step={step} />
      {/* Quiet, like a lost quote everywhere else: nothing here needs doing. */}
      {q.status === "lost" && <div className="callout" role="status"><Icon name="info" size={16} /><span className="grow">This proposal was marked lost.</span></div>}

      <DetailColumns
        grouped
        side={
          <Section title="Project">
            <Facts>
              <Fact label="Quote"><Link to={`/quotes/${q.id}`}>{q.number ? `#${q.number}` : "Draft"}</Link></Fact>
              <Fact label="Client">{q.client && <Link to={`/clients/${q.client.id}`}>{q.client.display_name}</Link>}</Fact>
              <Fact label="Asphalt">{asphalt > 0 ? `${formatNumber(asphalt)} sq ft` : takeoff ? `${formatNumber(takeoff.total_area_sqft)} sq ft measured` : null}</Fact>
              <Fact label="Price">{from !== null ? `From ${formatMoney(from)}` : q.lines.length ? formatMoney(q.total) : null}</Fact>
              <Fact label="Sent">{q.sent_at && formatDate(q.sent_at)}</Fact>
              <Fact label="Signed">{q.approved_at && `${formatDate(q.approved_at)}${q.approval?.name ? ` by ${q.approval.name}` : ""}`}</Fact>
              <Fact label="Job">{job && <Link to={`/jobs/${job.id}`}>#{job.number}</Link>}</Fact>
            </Facts>
          </Section>
        }
      >
        <StepCard
          id="takeoff"
          n={1}
          title={label("takeoff")}
          status={takeoff ? `Updated ${timeAgo(takeoff.updated_at)}` : "Not measured yet"}
          done={Boolean(takeoff)}
          current={step === "takeoff"}
          action={takeoff && canSell && <Link to={measureLink}><Icon name="edit" size={14} />Edit the takeoff</Link>}
        >
          {!takeoff ? (
            <TakeoffEmpty trade={trade} measureLink={canSell ? measureLink : null} primary />
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
          current={step === "estimate"}
          action={q.lines.length > 0 && <Link to={`/quotes/${q.id}`}>Adjust on the quote</Link>}
        >
          {!takeoff ? (
            <p className="paving-step-note">{trade.takeoff.first}</p>
          ) : (
            estimateView({ quote: q, takeoff, editable, onChanged: refresh, current: step === "estimate" })
          )}
        </StepCard>

        <StepCard id="proposal" n={3} title={label("proposal")} status={proposalStatus(q)} done={["approved", "converted"].includes(q.status)} current={step === "proposal"}>
          {!q.lines.length ? (
            <p className="paving-step-note">Price the estimate first; the proposal shows its lines.</p>
          ) : (
            <Proposal quote={q} takeoff={takeoff} sheet={trade.sheet} canSell={canSell} onChanged={refresh} preview={() => preview.mutate()} previewing={preview.isPending} />
          )}
        </StepCard>

        <StepCard id="schedule" n={4} title={label("schedule")} status={job ? `Job #${job.number}` : q.status === "approved" ? "Ready to schedule" : "After it's signed"} done={Boolean(job)} current={step === "schedule"}>
          <Schedule quote={q} job={job} canSell={canSell} onChanged={refresh} />
        </StepCard>

        <StepCard id="invoice" n={5} title={label("invoice")} status={invoiceStatus(job, invoices.data)} done={step === "done"} current={step === "invoice"}>
          <InvoiceStepBody job={job} seesInvoices={seesInvoices} invoices={invoices.data} primary={step === "invoice"} />
        </StepCard>
      </DetailColumns>
    </>
  );
}

/**
 * The steps under the title, on a hairline above and below (App-Paving.dc.html): a check for each one
 * done, the one it's at numbered in ink, the rest quiet. Each goes to its section. A phone scrolls them.
 */
export function FlowProgress<Id extends string>({ steps, step }: { steps: ReadonlyArray<FlowStep<Id>>; step: Id | "done" }) {
  const list = useRef<HTMLOListElement>(null);
  // Scrolled along, its left edge fades, so a step cut off there doesn't read as a stray mark.
  const edge = () => list.current?.toggleAttribute("data-scrolled", list.current.scrollLeft > 2);
  // A phone scrolls the strip sideways: bring the step it's at into view, the one done before it
  // first, without moving the page.
  useEffect(() => {
    const ol = list.current;
    const current = ol?.querySelector<HTMLElement>('[data-state="current"]');
    if (!ol || !current || ol.scrollWidth <= ol.clientWidth) return;
    const lead = (current.previousElementSibling as HTMLElement | null) ?? current;
    const from = ol.getBoundingClientRect().left + parseFloat(getComputedStyle(ol).paddingLeft || "0");
    // The step before it starts just past the faded edge (features.css), so it reads whole.
    ol.scrollLeft += lead.getBoundingClientRect().left - from - 28;
    ol.toggleAttribute("data-scrolled", ol.scrollLeft > 2);
  }, [step]);
  return (
    <ol ref={list} className="paving-progress" aria-label="Where this project is" onScroll={edge}>
      {steps.map((s, i) => {
        const done = step === "done" || steps.findIndex((x) => x.id === step) > i;
        return (
          <li key={s.id} data-state={done ? "done" : s.id === step ? "current" : "todo"}>
            <a href={`#${s.id}`} aria-current={s.id === step ? "step" : undefined} onClick={(e) => { e.preventDefault(); scrollToStep(s.id); }}>
              <span className="paving-progress-dot" data-done={done || undefined}>{done ? <Icon name="check" size={12} bold /> : i + 1}</span>
              <span className="paving-progress-label">{s.label}{done && <span className="sr-only"> (done)</span>}</span>
            </a>
            {i < steps.length - 1 && <span className="paving-progress-chevron" aria-hidden="true"><Icon name="chevronRight" size={14} /></span>}
          </li>
        );
      })}
    </ol>
  );
}

/** The first step before anything's measured: one line saying what to do, and the way to the map. */
export function TakeoffEmpty({ trade, measureLink, primary }: { trade: Pick<FlowTrade<string>, "takeoff">; measureLink: string | null; primary?: boolean }) {
  return (
    <EmptyState inline icon="area" title={trade.takeoff.empty} action={measureLink && <Link className={cx("btn", primary && "btn-primary")} to={measureLink}><Icon name="area" size={16} />{trade.takeoff.start}</Link>}>
      {trade.takeoff.text}
    </EmptyState>
  );
}

/** "2 invoices", "Not billed yet", "After the job". */
export const invoiceStatus = (job: unknown, invoices: readonly unknown[] | undefined) =>
  invoices?.length ? `${invoices.length} ${invoices.length === 1 ? "invoice" : "invoices"}` : job ? "Not billed yet" : "After the job";

/** The last step: the job's invoices, and making the next one. */
/** The invoice step: the job's invoices, then one way to make the next. `primary`: the step the project is at, so it's the green button. */
export function InvoiceStepBody({ job, seesInvoices, invoices, primary }: { job: { id: string } | null; seesInvoices: boolean; invoices: FlowInvoice[] | undefined; primary?: boolean }) {
  if (!job) return <p className="paving-step-note">Bill the deposit and the rest once there's a job.</p>;
  if (!seesInvoices) return <p className="paving-step-note">The office bills this job.</p>;
  return (
    <div className="paving-step-body">
      {invoices && invoices.length > 0 && (
        <RelatedList label="Invoices">
          {invoices.map((inv) => (
            <RelatedRow
              key={inv.id}
              to={`/invoices/${inv.id}`}
              lead={<span className="rel-icon"><Icon name="invoice" size={15} /></span>}
              title={`Invoice #${inv.number}`}
              detail={inv.kind !== "standard" ? inv.kind : undefined}
              end={<><EntityStatus kind="invoice" status={inv.status} /><b>{formatMoney(inv.total)}</b></>}
            />
          ))}
        </RelatedList>
      )}
      <div className="paving-step-foot">
        <Link className={cx("btn btn-sm", primary && "btn-primary")} to={`/jobs/${job.id}?invoice=1`}><Icon name="invoice" size={14} />{invoices?.length ? "Create another invoice" : "Create an invoice"}</Link>
        <span className="paving-step-note">Deposit, progress or final: clients pay online from their link.</span>
      </div>
    </div>
  );
}

function proposalStatus(q: Quote): string {
  if (q.status === "approved" || q.status === "converted") return `Signed${q.approved_at ? ` ${formatDate(q.approved_at)}` : ""}${q.approval?.name ? ` by ${q.approval.name}` : ""}`;
  if (q.status === "changes_requested") return statusText("quote", q.status);
  if (q.status === "sent") return `Sent${q.sent_at ? ` ${formatDate(q.sent_at)}` : ""}, waiting on the client`;
  if (q.status === "lost") return statusText("quote", q.status);
  return q.lines.length ? "Ready to send" : "After the estimate";
}

/**
 * One step's section: a 15px heading on a hairline with its number (a check once done; the step the
 * project is at, numbered in ink), where it stands in quiet words, and one quiet action on the right.
 */
export function StepCard({ id, n, title, status, done, current, action, children }: { id: string; n: number; title: string; status: string; done: boolean; current?: boolean; action?: ReactNode; children: ReactNode }) {
  return (
    <Section
      id={id}
      className={cx("paving-step-card", current && !done && "is-current")}
      title={
        <span className="paving-step-title">
          <span className="paving-progress-dot" data-done={done || undefined} data-current={(current && !done) || undefined} aria-hidden="true">{done ? <Icon name="check" size={12} bold /> : n}</span>
          {title}
        </span>
      }
      count={status}
      action={action || undefined}
    >
      {children}
    </Section>
  );
}

/**
 * The estimate's lines with their cost, price and margin, then the totals. With options, the option
 * looked at (`optionId`, called `optionLabel`) and the shared lines, priced as that option (data.ts
 * estimateSums).
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
  // Lines slide in and out as services are ticked above.
  const linesRef = useListAnimation<HTMLTableSectionElement>();
  // Costs and margins only when a line has a cost: empty columns say nothing.
  const anyCost = lines.some((l) => l.unit_cost != null);
  return (
    <div className={styles.lines}>
      <table className={cx("table", styles.estimate)}>
        <thead><tr><th>On the estimate</th><th className="num">Qty</th><th className={cx("num", styles.wide)}>Price</th>{anyCost && <th className={cx("num", styles.wide)}>Cost</th>}<th className="num">Total</th>{anyCost && <th className={cx("num", styles.wide)}>Margin</th>}</tr></thead>
        <tbody ref={linesRef}>
          {lines.map((l) => {
            const lineTotal = Number(l.quantity) * Number(l.unit_price);
            const lineCost = l.unit_cost != null ? Number(l.quantity) * Number(l.unit_cost) : null;
            const choice = choices.get(l.id);
            return (
              <tr key={l.id} data-optional={!counted(l) || undefined}>
                <td>
                  <span className={styles.estimateName}>{l.name}</span>
                  {choice && <span className="tag">{choice}</span>}
                  {l.optional && <span className={styles.lineNote}>{choice ? choiceNote(l.selected) : "Optional"}</span>}
                </td>
                <td className="num nowrap">{formatNumber(Number(l.quantity), Number(l.quantity) < 100 ? 2 : 0)} {l.unit}</td>
                <td className={cx("num", styles.wide)}>{formatMoneyCents(l.unit_price)}</td>
                {anyCost && <td className={cx("num", styles.wide)}>{lineCost === null ? "" : formatMoney(lineCost)}</td>}
                <td className="num strong">{formatMoney(lineTotal)}</td>
                {anyCost && <td className={cx("num", styles.wide)}>{lineCost === null || !lineTotal ? "" : `${Math.round(((lineTotal - lineCost) / lineTotal) * 100)}%`}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      <StatStrip label="The estimate's totals">
        {materials !== null && <Stat label="Materials" value={<><AnimatedNumber value={materials} format={MONEY} />{materialsPartial ? "+" : ""}</>} />}
        {/* A cost only some lines have is at least that much; none at all is left out, not "$0". */}
        {(costKnown || cost > 0) && <Stat label="Cost" value={<><AnimatedNumber value={cost} format={MONEY} />{costKnown ? "" : "+"}</>} note={costKnown ? undefined : "some lines have no cost"} />}
        <Stat label="Price" value={<AnimatedNumber value={price} format={MONEY} />} note="before tax" />
        {costKnown && <Stat label="Profit" tone={profit < 0 ? "danger" : undefined} value={<AnimatedNumber value={profit} format={MONEY} />} note={margin === null ? undefined : `${Math.round(margin)}% margin`} />}
        <Stat label="Total with tax" value={<AnimatedNumber value={total} format={MONEY} />} />
      </StatStrip>
      {!signed && quote.options.length > 0 && optionLabel ? (
        <p className="paving-step-note">
          The totals are for {optionLabel}{choices.size > 0 ? ", with the choices shown first" : ""}. The client chooses one of the options on the proposal, and the total follows.
        </p>
      ) : (
        choices.size > 0 && !signed && <p className="paving-step-note">The totals are for the choice shown first. The client picks one on the proposal, and the total follows.</p>
      )}
      {!costKnown && <p className="paving-step-note">Add costs to your services in the price list to see the profit and margin.</p>}
    </div>
  );
}

function Proposal({ quote, takeoff, sheet, canSell, onChanged, preview, previewing }: { quote: Quote; takeoff: TakeoffRow | null; sheet: FlowTrade["sheet"]; canSell: boolean; onChanged: () => void; preview: () => void; previewing: boolean }) {
  const [sending, setSending] = useState(false);
  const showSheet = useMutation({
    mutationFn: async (on: boolean) => unwrap(await supabase().from("measurements").update({ show_on_quote: on, quote_id: quote.id }).eq("id", takeoff!.id)),
    onSuccess: onChanged,
  });
  const signed = quote.status === "approved" || quote.status === "converted";
  return (
    <div className="paving-step-body">
      {takeoff && (
        <label className={styles.switchRow}>
          <input type="checkbox" className="switch" checked={takeoff.show_on_quote} disabled={!canSell || showSheet.isPending || !takeoff.snapshot_path} onChange={(e) => showSheet.mutate(e.target.checked)} />
          <span className={styles.switchText}>
            <span className={styles.switchLabel}>Show the {sheet.name} on the proposal</span>
            <span className={styles.switchHint}>{takeoff.snapshot_path ? sheet.text : sheet.missing}</span>
          </span>
        </label>
      )}
      {signed && quote.approval?.signature && <img src={quote.approval.signature} alt={`Signature of ${quote.approval.name ?? "the client"}`} className="paving-signature" />}
      <div className="paving-step-foot">
        {canSell && !signed && quote.status !== "lost" && <Button variant="primary" icon="send" onClick={() => setSending(true)}>{quote.status === "draft" ? "Send the proposal" : "Send it again"}</Button>}
        <Button icon="eye" loading={previewing} onClick={preview}>Preview</Button>
      </div>
      <p className="paving-step-note">
        {signed
          ? "Signed online: schedule the job next."
          : `The client opens it on any phone or computer, ${quote.options.length ? `chooses one of the ${quote.options.length} options, ` : ""}picks any optional items and signs. No account needed.`}
      </p>
      {sending && <SendDialog kind="quote" id={quote.id} number={quote.number} email={quote.client?.email ?? null} phone={quote.client?.phone ?? null} onClose={() => setSending(false)} onSent={() => { setSending(false); onChanged(); }} />}
    </div>
  );
}

function Schedule({ quote, job, canSell, onChanged }: { quote: Quote; job: Quote["jobs"][number] | null; canSell: boolean; onChanged: () => void }) {
  const navigate = useNavigate();
  const convert = useMutation({
    meta: { success: "Job created", tone: "job" },
    mutationFn: () => api.post<{ job_id: string }>(`/quotes/${quote.id}/convert`),
    onSuccess: (res) => {
      onChanged();
      navigate(`/jobs/${res.job_id}`);
    },
  });
  if (job) {
    return (
      <div className="paving-step-body">
        <RelatedList label="Job">
          <RelatedRow to={`/jobs/${job.id}`} lead={<span className="rel-icon"><Icon name="job" size={15} /></span>} title={`Job #${job.number}`} end={<EntityStatus kind="job" status={job.status} />} />
        </RelatedList>
        <div className="paving-step-foot">
          <Link className="btn btn-sm" to={`/jobs/${job.id}`}><Icon name="calendar" size={14} />Schedule the visits</Link>
          <span className="paving-step-note">Put it on a crew's day; the crew app shows them the scope, checklist and photos.</span>
        </div>
      </div>
    );
  }
  if (!canSell) return <p className="paving-step-note">The office turns it into a job once it's signed.</p>;
  const signed = quote.status === "approved";
  // An estimate with options becomes the job of the one they chose, so that's marked first (the quote's Mark approved asks which).
  if (!signed && quote.options.length) {
    return (
      <p className="paving-step-note">
        Usually once the client signs for the option they chose. If they said yes another way, <Link to={`/quotes/${quote.id}`}>mark it approved on the quote</Link> with their option, then create the job here.
      </p>
    );
  }
  return (
    <div className="paving-step-body">
      <div className="paving-step-foot">
        <Button variant={signed ? "primary" : undefined} size={signed ? undefined : "sm"} icon="job" loading={convert.isPending} disabled={!quote.lines.length || quote.status === "lost"} onClick={() => convert.mutate()}>
          Create the job
        </Button>
        <span className="paving-step-note">{signed ? "The estimate's lines become the job's scope." : "Usually once the client signs. You can start it now if they said yes another way."}</span>
      </div>
    </div>
  );
}
