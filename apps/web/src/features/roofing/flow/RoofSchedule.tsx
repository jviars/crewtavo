/**
 * The schedule step: the signed estimate becomes a job (every line comes along; with options, the
 * shared ones and the option chosen), and the deposit it asked for can be billed straight away. Once
 * there's a job, it's the way to its schedule.
 */
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { RelatedList, RelatedRow } from "@/components/ui/Section";
import { EntityStatus } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";
import type { FlowInvoice } from "../../paving/ProjectFlow";
import type { EstimateQuote } from "../estimate";
import type { RoofProjectExtras } from "./data";
import { depositLabel, jobLinesText, OPEN, SIGNED } from "./model";
import styles from "./flow.module.css";

export function RoofSchedule({ quote, extras, invoices, canSell, current, refresh }: {
  quote: EstimateQuote;
  extras: RoofProjectExtras;
  /** The job's invoices, for whether the deposit's been billed (undefined until they load). */
  invoices: FlowInvoice[] | undefined;
  canSell: boolean;
  /** This is the step the project is at, so its next step is the page's green button. */
  current?: boolean;
  refresh: () => void;
}) {
  const session = useSession();
  const navigate = useNavigate();
  const job = extras.jobs[0] ?? null;
  const deposit = Number(extras.deposit_amount);
  // Billing is the office's (POST /jobs/:id/invoice).
  const canBill = hasRole(session, "admin", "office") && can(session, "invoices");
  const billed = (invoices ?? []).some((i) => i.kind === "deposit" && i.status !== "void");

  const convert = useMutation({
    meta: { success: "Job created", tone: "job" },
    mutationFn: () => api.post<{ job_id: string }>(`/quotes/${quote.id}/convert`),
    onSuccess: (r) => {
      refresh();
      navigate(`/jobs/${r.job_id}`);
    },
  });
  const bill = useMutation({
    meta: { success: "Deposit invoice created", tone: "invoice" },
    mutationFn: async () => {
      const jobId = job?.id ?? (await api.post<{ job_id: string }>(`/quotes/${quote.id}/convert`)).job_id;
      return (await api.post<{ invoice_id: string }>(`/jobs/${jobId}/invoice`, { kind: "deposit", amount: deposit })).invoice_id;
    },
    onSuccess: (invoiceId) => {
      refresh();
      navigate(`/invoices/${invoiceId}`);
    },
    // The job may have been made before the invoice failed.
    onError: refresh,
  });
  const depositButton = deposit > 0 && canBill && (job ? invoices !== undefined && !billed : true) && (
    <Button icon="invoice" loading={bill.isPending} disabled={convert.isPending} onClick={() => bill.mutate()}>
      {depositLabel(deposit, Number(quote.total))}
    </Button>
  );

  if (job) {
    return (
      <div className={styles.stepBody}>
        <RelatedList label="The job">
          <RelatedRow to={`/jobs/${job.id}`} lead={<span className="rel-icon"><Icon name="job" size={15} /></span>} title={`Job #${job.number}`} end={<EntityStatus kind="job" status={job.status} />} />
        </RelatedList>
        <div className={styles.actions}>
          <Link className={current ? "btn btn-primary" : "btn"} to={`/jobs/${job.id}`}><Icon name="calendar" size={16} /> Schedule the visits</Link>
          {depositButton}
        </div>
        <p className={styles.note}>Put it on a crew's day; the crew app shows them the scope, checklist and photos.</p>
      </div>
    );
  }
  if (!canSell) return <p className={styles.note}>The office turns it into a job once it's signed.</p>;
  if (SIGNED.includes(quote.status)) {
    return (
      <div className={styles.stepBody}>
        <p className={styles.stepLead}>Turn the signed estimate into a job. {jobLinesText(quote)}</p>
        <div className={styles.actions}>
          <Button variant={current ? "primary" : undefined} icon="calendar" loading={convert.isPending} disabled={bill.isPending} onClick={() => convert.mutate()}>Schedule the job</Button>
          {depositButton}
        </div>
      </div>
    );
  }
  const early = quote.lines.length > 0 && OPEN.includes(quote.status);
  if (!early) return <p className={styles.note}>After it's signed, the estimate becomes the crew's job.</p>;
  // An estimate with options becomes the job of the one they chose, so that's marked first (the quote's Mark approved asks which).
  if (quote.options.length) {
    return (
      <p className={styles.note}>
        Usually after it's signed. If {quote.client?.display_name ?? "the client"} said yes another way, <Link to={`/quotes/${quote.id}`}>mark it approved on the quote</Link> with the option they chose, then make the job here.
      </p>
    );
  }
  return (
    <div className={styles.stepBody}>
      <p className={styles.note}>Usually after it's signed. If {quote.client?.display_name ?? "the client"} said yes another way, you can make the job now.</p>
      <div className={styles.actions}>
        <Button size="sm" icon="job" loading={convert.isPending} onClick={() => convert.mutate()}>Create the job</Button>
      </div>
    </div>
  );
}
