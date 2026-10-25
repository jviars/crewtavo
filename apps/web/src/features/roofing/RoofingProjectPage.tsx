/**
 * One roofing project, start to finish, on one page: the roof measured on the map, the estimate
 * priced from its package (with the range the homeowner will see beside it), the range going out
 * and the homeowner's yes, the site visit on the iPad and the signed estimate, then the job and the
 * invoices. Six steps (ROOF_STEPS); the page opens wherever the project is.
 *
 * The estimate is the estimate kit's (useEstimateQuote), so a tap on − or + shows at once; the rest
 * of the project (its dates, deposit and job) loads beside it (flow/data.ts). The pieces every trade
 * shares (the progress pills, the step cards, the invoices) are paving/ProjectFlow's.
 */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { ErrorState, NoAccess } from "@/components/ui/States";
import { addressLine, formatMoney, timeAgo } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { readApproval } from "../documents/data";
import { usePictures } from "../measure/drawings";
import { FlowProgress, InvoiceStepBody, invoiceStatus, measureLinkFor, StepCard, TakeoffEmpty, useJobInvoices, useScrollToHash, type FlowTrade } from "../paving/ProjectFlow";
import { ROOF_STEPS, roofStep, type RoofStepId } from "./data";
import { counts, useEstimateQuote } from "./estimate";
import { useFreshEstimate, useRefreshProject, useRoofProject, useTeam, useWatchProject } from "./flow/data";
import { EstimateStep } from "./flow/EstimateStep";
import { personName, rangeState, rangeStepStatus, visitStepStatus } from "./flow/model";
import type { SendChannel, SendMode } from "./flow/RangeCard";
import { RangeStep } from "./flow/RangeStep";
import { RoofCard } from "./flow/RoofCard";
import { RoofSchedule } from "./flow/RoofSchedule";
import { SendEstimateDialog } from "./flow/SendEstimateDialog";
import { VisitStep } from "./flow/VisitStep";

export const ROOFING: FlowTrade<RoofStepId> = {
  id: "roofing",
  name: "Roofing",
  path: "/roofing",
  steps: ROOF_STEPS,
  current: roofStep,
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

/** Roof estimates are for the people who price work. */
export function RoofingProjectPage() {
  const session = useSession();
  if (!(hasRole(session, "admin", "office", "estimator") && can(session, "sales"))) {
    return (
      <>
        <BackLink to="/roofing">Roofing</BackLink>
        <NoAccess title="Roofing" />
      </>
    );
  }
  return <RoofProject />;
}

function RoofProject() {
  const { id = "" } = useParams();
  const session = useSession();
  const estimate = useEstimateQuote(id);
  const project = useRoofProject(id);
  useFreshEstimate(id);
  const refresh = useRefreshProject(id);
  const team = useTeam();
  const seesInvoices = hasRole(session, "admin", "office");
  const job = project.data?.jobs[0] ?? null;
  const invoices = useJobInvoices(job, seesInvoices);
  const pictures = usePictures([estimate.data?.takeoff?.snapshot_path]);
  useScrollToHash(Boolean(estimate.data && project.data));
  // Out with the homeowner, or out on the roof: their answer shows here when it comes.
  const awaiting = estimate.data ? ["waiting", "accepted", "exact"].includes(rangeState(estimate.data.quote)) : false;
  useWatchProject(id, awaiting);
  const [sending, setSending] = useState<{ mode: SendMode; startWith?: SendChannel } | null>(null);

  if (estimate.isPending || project.isPending) return <DetailSkeleton />;
  if (!estimate.data || !project.data) {
    return (
      <>
        <BackLink to={ROOFING.path}>{ROOFING.name}</BackLink>
        <ErrorState
          error={estimate.error ?? project.error}
          onRetry={() => {
            void estimate.refetch();
            void project.refetch();
          }}
        />
      </>
    );
  }

  const { quote, takeoff } = estimate.data;
  const extras = project.data;
  const tz = session.company.timezone;
  const step = roofStep({ ...quote, jobs: extras.jobs }, takeoff, invoices.data ?? []);
  const at = (s: RoofStepId) => ROOF_STEPS.findIndex((x) => x.id === s);
  const done = (s: RoofStepId) => step === "done" || at(step) > at(s);
  const reached = (s: RoofStepId) => step === "done" || at(step) >= at(s);
  const label = (s: RoofStepId) => ROOF_STEPS[at(s)]!.label;
  const measureLink = measureLinkFor(ROOFING, quote, takeoff);
  // Who goes out: the one booked, else whoever signed for the business.
  const salesperson = personName(team.data, quote.salesperson_id) ?? readApproval(quote.approval)?.company?.name ?? null;
  // The lines the option shown is made of (with options), else the estimate's.
  const lineCount = quote.lines.filter((l) => counts(l, quote.option_id)).length;
  const estimateStatus = quote.options.length
    ? `${quote.options.length} options`
    : lineCount
      ? `${lineCount} ${lineCount === 1 ? "line" : "lines"} · ${formatMoney(quote.subtotal)}`
      : reached("estimate")
        ? "Not priced yet"
        : ROOFING.takeoff.after;
  const send = (mode: SendMode, startWith?: SendChannel) => setSending({ mode, startWith });

  return (
    <>
      <BackLink to={ROOFING.path}>{ROOFING.name}</BackLink>
      <PageHeader title={quote.title} actions={<Link className="btn" to={`/quotes/${quote.id}`}>Open the quote</Link>} />
      <p className="page-subtitle">{[quote.client?.display_name, quote.property ? addressLine(quote.property) : null, quote.number ? `Estimate #${quote.number}` : null].filter(Boolean).join(" · ")}</p>

      <FlowProgress steps={ROOF_STEPS} step={step} />
      {(quote.status === "lost" || quote.status === "archived") && (
        <div className="callout callout-danger" role="status">
          <Icon name="alert" size={18} />
          <span className="grow">This estimate was marked {quote.status === "lost" ? "lost" : "archived"}. <Link to={`/quotes/${quote.id}`}>Reopen it from the quote</Link> to pick it up again.</span>
        </div>
      )}

      <div className="stack" style={{ gap: 16 }}>
        <StepCard id="takeoff" n={1} title={label("takeoff")} status={takeoff ? `Updated ${timeAgo(takeoff.updated_at)}` : "Not measured yet"} done={Boolean(takeoff)} current={step === "takeoff"}>
          {!takeoff ? (
            <TakeoffEmpty trade={ROOFING} measureLink={measureLink} />
          ) : (
            <RoofCard takeoff={takeoff} picture={takeoff.snapshot_path ? pictures.data?.[takeoff.snapshot_path] : undefined} editLink={measureLink} />
          )}
        </StepCard>

        <StepCard
          id="estimate"
          n={2}
          title={label("estimate")}
          status={estimateStatus}
          done={done("estimate")}
          current={step === "estimate"}
        >
          {!takeoff && !quote.lines.length ? (
            <span className="muted small">{quote.options.length ? `Measure the roof first; each of the ${quote.options.length} options is priced from its package once it's measured.` : ROOFING.takeoff.first}</span>
          ) : (
            <EstimateStep
              quote={quote}
              takeoff={takeoff}
              packageName={extras.package?.name ?? null}
              salesperson={salesperson}
              canSell
              fetching={estimate.isFetching}
              refresh={refresh}
              onSend={send}
            />
          )}
        </StepCard>

        <StepCard id="range" n={3} title={label("range")} status={rangeStepStatus(quote, quote.client?.display_name, tz)} done={done("range")} current={step === "range"}>
          <RangeStep quote={quote} salesperson={salesperson} canSell refresh={refresh} onSend={send} />
        </StepCard>

        <StepCard id="visit" n={4} title={label("visit")} status={visitStepStatus({ ...quote, sent_at: extras.sent_at, approval: readApproval(quote.approval) }, quote.client?.display_name, tz)} done={done("visit")} current={step === "visit"}>
          <VisitStep quote={quote} extras={extras} takeoff={takeoff} salesperson={salesperson} current={step === "visit"} canSell onSend={send} />
        </StepCard>

        <StepCard id="schedule" n={5} title={label("schedule")} status={job ? `Job #${job.number}` : quote.status === "approved" ? "Ready to schedule" : "After it's signed"} done={Boolean(job)} current={step === "schedule"}>
          <RoofSchedule quote={quote} extras={extras} invoices={invoices.data} canSell refresh={refresh} />
        </StepCard>

        <StepCard id="invoice" n={6} title={label("invoice")} status={invoiceStatus(job, invoices.data)} done={step === "done"} current={step === "invoice"}>
          <InvoiceStepBody job={job} seesInvoices={seesInvoices} invoices={invoices.data} />
        </StepCard>
      </div>

      {sending && (
        <SendEstimateDialog
          quote={quote}
          mode={sending.mode}
          startWith={sending.startWith}
          onClose={() => setSending(null)}
          onSent={refresh}
        />
      )}
    </>
  );
}
