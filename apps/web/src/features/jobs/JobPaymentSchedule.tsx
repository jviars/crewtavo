/**
 * "Payment schedule" on a job made from a quote that had one (job_installments,
 * 20261113001100_payment_schedules.sql): each payment, when it's due, and where it is: to come, its
 * invoice (and whether it's paid), or on the final invoice. The office can invoice one early, or
 * again after its invoice was voided ("Invoice now"); the database makes each once, so pressing it
 * twice says which invoice it's on. Each invoice is for the amount signed, and the last payment to
 * be invoiced is the job's final invoice (20261113001600_scheduled_payments_bill_what_was_signed.sql).
 */
import { scheduleDueText, schedulePaymentName } from "@crewtavo/core/money";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { MetaLine } from "@/components/ui/InboxList";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { EntityStatus } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatDate, formatMoneyCents } from "@/lib/format";
import styles from "./jobMoney.module.css";

export interface InstallmentRow {
  id: string;
  position: number;
  count: number;
  due: "approval" | "date" | "work_starts" | "work_done" | "by_hand";
  due_on: string | null;
  amount: number;
  problem: string | null;
  invoice: { id: string; number: number | null; status: string; total: number } | null;
}

export type InstallmentState =
  | { kind: "invoiced"; invoice: NonNullable<InstallmentRow["invoice"]> }
  | { kind: "final"; invoice: { id: string; number: number | null } }
  | { kind: "voided"; invoice: NonNullable<InstallmentRow["invoice"]> }
  | { kind: "to_come" };

/**
 * Where a payment is: its invoice; on the job's final invoice along with others (that invoice was
 * made while several had none, so it billed them together); voided (to invoice again by hand); or
 * still to come. `shared`: another payment has the same invoice.
 */
export function installmentState(row: Pick<InstallmentRow, "invoice">, finalInvoice: { id: string; number: number | null } | null, shared = false): InstallmentState {
  if (row.invoice && row.invoice.status !== "void") {
    return shared && finalInvoice?.id === row.invoice.id ? { kind: "final", invoice: finalInvoice } : { kind: "invoiced", invoice: row.invoice };
  }
  if (row.invoice) return { kind: "voided", invoice: row.invoice };
  if (finalInvoice) return { kind: "final", invoice: finalInvoice };
  return { kind: "to_come" };
}

/**
 * Whether "Invoice now" is offered: for a payment to come or one whose invoice was voided, until
 * the job has its final invoice (that one bills what's left, so it's voided first).
 */
export const canInvoiceNow = (state: InstallmentState, finalInvoice: { id: string } | null) => !finalInvoice && (state.kind === "to_come" || state.kind === "voided");

/** What a job's payments are read with, here and where the job's billing is changed. */
export const INSTALLMENT_COLUMNS = "id, position, count, due, due_on, amount, problem, invoice:invoices(id, number, status, total)";

/**
 * Whether a job billed this way bills each visit, or each month, in full: a payment schedule can't
 * sit beside that, since what it went on to invoice would be billed twice
 * (20261113001630_schedule_or_visit_by_visit.sql refuses the change while payments are to come).
 */
export const billsOutsideSchedule = (kind: string, billingMode: string) => kind === "recurring" || billingMode === "per_visit" || billingMode === "fixed_schedule";

/**
 * What to ask before a job with a payment schedule is changed to bill visit by visit or as repeating
 * work: the payments with no invoice yet are dropped, each named with its amount, and the ones
 * already invoiced are said to stay. Null when there's nothing to drop.
 */
export function dropPaymentsQuestion(rows: readonly Pick<InstallmentRow, "position" | "count" | "amount" | "invoice">[], repeating: boolean) {
  const live = (row: Pick<InstallmentRow, "invoice">) => !!row.invoice && row.invoice.status !== "void";
  const unmade = rows.filter((row) => !live(row));
  if (!unmade.length) return null;
  const made = rows.filter(live);
  const one = unmade.length === 1;
  const named = unmade.map((row) => `${schedulePaymentName(row.position, row.count)} (${formatMoneyCents(row.amount)})`).join(", ");
  const kept = made.map((row) => `${schedulePaymentName(row.position, row.count)} (invoice #${row.invoice!.number})`).join(", ");
  return {
    title: one ? "Drop the payment still to come?" : `Drop the ${unmade.length} payments still to come?`,
    body:
      `This job has a payment schedule. Invoicing ${repeating ? "it as repeating work" : "after each visit"} bills the work in full as it goes, so ${one ? "the payment" : "the payments"} not invoiced yet would be billed twice. ` +
      `Saving drops ${one ? "it" : "them"}: ${named}.` +
      (made.length ? ` Already invoiced, and staying as ${made.length === 1 ? "it is" : "they are"}: ${kept}. Visit invoices won't take ${made.length === 1 ? "it" : "them"} off.` : ""),
    confirmLabel: one ? "Drop it and save" : "Drop them and save",
  };
}

export function JobPaymentSchedule({ jobId, finalInvoice }: { jobId: string; finalInvoice: { id: string; number: number | null } | null }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const rows = useQuery({
    queryKey: ["job", jobId, "installments"],
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("job_installments")
          .select(INSTALLMENT_COLUMNS)
          .eq("job_id", jobId)
          .order("position"),
      ) as unknown as InstallmentRow[],
  });
  const invoiceNow = useMutation({
    meta: { success: "Invoice created as a draft", tone: "invoice" },
    mutationFn: async (id: string) => unwrap(await supabase().rpc("invoice_installment", { p_installment: id })) as string,
    onSuccess: (invoiceId) => {
      queryClient.invalidateQueries({ queryKey: ["job", jobId] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      navigate(`/invoices/${invoiceId}`);
    },
  });
  if (!rows.data?.length) return null;
  return (
    <Section className="rel-figures" title="Payment schedule" count={rows.data.length}>
      <RelatedList label="Payment schedule">
        {rows.data.map((row) => {
          const shared = !!row.invoice && rows.data.some((other) => other.id !== row.id && other.invoice?.id === row.invoice?.id);
          const state = installmentState(row, finalInvoice, shared);
          const problem = row.problem && state.kind !== "invoiced" && state.kind !== "final" ? row.problem : null;
          return (
            <RelatedRow
              key={row.id}
              title={schedulePaymentName(row.position, row.count)}
              sub={(
                <>
                  <span className={styles.subLine}>{scheduleDueText({ due: row.due, on: row.due_on }, (iso) => formatDate(iso))}</span>
                  <MetaLine
                    className={styles.subLine}
                    parts={[
                      state.kind === "invoiced" ? (
                        <span className={styles.inline}><Link to={`/invoices/${state.invoice.id}`}>Invoice #{state.invoice.number}</Link><EntityStatus kind="invoice" status={state.invoice.status} /></span>
                      ) : state.kind === "final" ? (
                        <Link to={`/invoices/${state.invoice.id}`}>On the final invoice #{state.invoice.number}</Link>
                      ) : state.kind === "voided" ? (
                        `Invoice #${state.invoice.number} was voided`
                      ) : "To come",
                      problem && <span className={styles.danger}>{problem}</span>,
                      canInvoiceNow(state, finalInvoice) && (
                        <button type="button" className="link-btn" disabled={invoiceNow.isPending} aria-busy={(invoiceNow.isPending && invoiceNow.variables === row.id) || undefined} onClick={() => invoiceNow.mutate(row.id)}>
                          {invoiceNow.isPending && invoiceNow.variables === row.id ? "Making it…" : state.kind === "voided" ? "Invoice it again" : "Invoice now"}
                        </button>
                      ),
                    ]}
                  />
                </>
              )}
              end={<b>{formatMoneyCents(row.amount)}</b>}
            />
          );
        })}
      </RelatedList>
    </Section>
  );
}
