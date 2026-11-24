/**
 * "Payment schedule" on a quote (quotes.payment_schedule): how the client pays it, a row at a time,
 * each a percent of the total, an amount, or (the last one) the rest, and when it's due. The rows
 * have to come to the quote's total: the editor shows what's left and won't save until they do (the
 * database says the same: 20261113001100_payment_schedules.sql). The payment due at approval is the
 * deposit. A total that changes afterwards moves the percents; amounts that no longer fit are
 * flagged here. Once it's signed, it shows the amounts kept with the approval.
 *
 * A dated payment is due on a day or so many days after they approve
 * (20261113001640_schedule_dates.sql). A copy or a quote from a template has its days to set again,
 * and a day already gone has to be changed before the quote is sent: both are flagged here.
 */
import { DEPOSIT_LAW_NOTE, SCHEDULE_AFTER_MAX, SCHEDULE_DUE, scheduleAmounts, scheduleDateProblem, scheduleDueText, scheduleProblem, scheduleRows, type ScheduleDue, type ScheduleRow } from "@crewtavo/core/money";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { supabase, unwrap } from "@/lib/api";
import { currencySymbol, formatDate, formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import styles from "./QuotePage.module.css";
import { Select } from "@/components/ui/Select";

/** When a payment is due as the editor asks it: a schedule's five, with "on a date" asked two ways. */
export type DraftDue = ScheduleDue | "after";
const DRAFT_DUE: readonly DraftDue[] = ["approval", "after", ...SCHEDULE_DUE.filter((due) => due !== "approval")];
const DUE_LABELS: Record<DraftDue, string> = {
  approval: "When they approve",
  after: "Days after they approve",
  date: "On a date",
  work_starts: "When the work starts",
  work_done: "When the work is done",
  by_hand: "When we invoice it",
};

/** A row as it's typed: the amount and the days as text, so a half-typed number isn't lost. */
export interface DraftRow {
  kind: ScheduleRow["kind"];
  value: string;
  due: DraftDue;
  on: string;
  after: string;
}

export const toDraft = (r: ScheduleRow): DraftRow => ({
  kind: r.kind,
  value: r.value == null ? "" : String(r.value),
  due: r.due === "date" && r.after != null ? "after" : r.due,
  on: r.on ?? "",
  after: r.after == null ? "" : String(r.after),
});
/** As it's saved: numbers, a day or a number of days only when it's due on a date, no value for the rest. */
export const fromDraft = (d: DraftRow): ScheduleRow => ({
  kind: d.kind,
  ...(d.kind === "rest" ? {} : { value: d.value.trim() === "" ? null : Number(d.value) }),
  due: d.due === "after" ? "date" : d.due,
  ...(d.due === "date" ? { on: d.on || null } : {}),
  // Nothing typed is 0 days, which the checks turn away, rather than a date with no day.
  ...(d.due === "after" ? { after: Number(d.after) } : {}),
});
/** Half when they approve, the rest when the work is done: the usual start. */
const STARTER: DraftRow[] = [
  { kind: "percent", value: "50", due: "approval", on: "", after: "" },
  { kind: "rest", value: "", due: "work_done", on: "", after: "" },
];

export interface ScheduleQuote {
  id: string;
  status: string;
  total: number | string | null;
  payment_schedule?: unknown;
  approval?: unknown;
  recurrence_rule?: string | null;
  change_order_for?: string | null;
}

/** The payments as they show: signed, as kept with the approval; open, worked out on the total. */
export function shownSchedule(quote: ScheduleQuote) {
  const signed = quote.status === "approved" || quote.status === "converted";
  if (signed) {
    const kept = scheduleRows(quote.approval && typeof quote.approval === "object" ? (quote.approval as { payment_schedule?: unknown }).payment_schedule : null);
    return { rows: kept.map((r) => ({ ...r, amount: Number((r as { amount?: unknown }).amount ?? 0) })), fits: true, left: 0, signed };
  }
  return { ...scheduleAmounts(scheduleRows(quote.payment_schedule), quote.total), signed };
}

export function PaymentScheduleCard({ quote, editable, onSaved }: { quote: ScheduleQuote; editable: boolean; onSaved: () => void }) {
  const session = useSession();
  const today = todayIn(session.company.timezone);
  const [draft, setDraft] = useState<DraftRow[] | null>(null);
  const shown = shownSchedule(quote);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async (rows: ScheduleRow[] | null) => {
      unwrap(await supabase().from("quotes").update({ payment_schedule: rows as never }).eq("id", quote.id));
    },
    onSuccess: () => {
      setDraft(null);
      onSaved();
    },
  });
  // Repeating work is billed by the visit or the month, and a change order with its job.
  if (quote.recurrence_rule || quote.change_order_for) return null;
  if (!shown.rows.length && !editable && !draft) return null;

  if (draft) {
    const rows = draft.map(fromDraft);
    const sums = scheduleAmounts(rows, quote.total);
    const problem = scheduleProblem(rows, quote.total) ?? scheduleDateProblem(rows, today, (iso) => formatDate(iso));
    const set = (i: number, change: Partial<DraftRow>) => setDraft(draft.map((d, n) => (n === i ? { ...d, ...change } : d)));
    return (
      <Section title="Payment schedule" className={styles.schedule}>
        <p className={styles.quiet}>The payments have to come to the total, {formatMoneyCents(Number(quote.total ?? 0))}. The one due when they approve is the deposit. {DEPOSIT_LAW_NOTE}</p>
        {draft.map((d, i) => {
          const last = i === draft.length - 1;
          return (
            <div key={i} className={styles.scheduleRow}>
              <span className={styles.paymentName}>Payment {i + 1}</span>
              <div className={styles.paymentLine}>
                <Select className={`select input-sm ${styles.paymentKind}`} aria-label={`Payment ${i + 1} as`} value={d.kind} onChange={(e) => set(i, { kind: e.target.value as DraftRow["kind"] })}>
                  <option value="percent">%</option>
                  <option value="amount">{currencySymbol()}</option>
                  {last && <option value="rest">The rest</option>}
                </Select>
                {d.kind !== "rest" && (
                  <input className="input input-sm" style={{ width: 96, textAlign: "right" }} inputMode="decimal" aria-label={d.kind === "percent" ? `Payment ${i + 1} percent` : `Payment ${i + 1} amount`}
                    value={d.value} onChange={(e) => set(i, { value: e.target.value.replace(/[^0-9.]/g, "") })} />
                )}
                <span className={styles.paymentAmount}>{formatMoneyCents(sums.rows[i]?.amount ?? 0)}</span>
              </div>
              <div className={styles.paymentLine}>
                <Select className={`select input-sm ${styles.paymentDue}`} aria-label={`Payment ${i + 1} due`} value={d.due} onChange={(e) => set(i, { due: e.target.value as DraftDue })}>
                  {DRAFT_DUE.map((due) => <option key={due} value={due}>{DUE_LABELS[due]}</option>)}
                </Select>
                {d.due === "date" && <input className="input input-sm" type="date" min={today} aria-label={`Payment ${i + 1} date`} value={d.on} onChange={(e) => set(i, { on: e.target.value })} />}
                {d.due === "after" && (
                  <input className="input input-sm" style={{ width: 72, textAlign: "right" }} inputMode="numeric" placeholder="30" aria-label={`Payment ${i + 1} days after they approve, 1 to ${SCHEDULE_AFTER_MAX}`}
                    value={d.after} onChange={(e) => set(i, { after: e.target.value.replace(/[^0-9]/g, "") })} />
                )}
                {draft.length > 1 && (
                  <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove payment ${i + 1}`}
                    onClick={() => setDraft(draft.filter((_, n) => n !== i).map((r, n, all) => (n === all.length - 1 || r.kind !== "rest" ? r : { ...r, kind: "percent" })))} />
                )}
              </div>
            </div>
          );
        })}
        {draft.length < 12 && (
          <Button size="sm" variant="ghost" icon="plus" style={{ justifySelf: "start" }}
            onClick={() => setDraft([...draft.map((r) => (r.kind === "rest" ? { ...r, kind: "percent" as const } : r)), { kind: "rest", value: "", due: "work_done", on: "", after: "" }])}>
            Add a payment
          </Button>
        )}
        {/* .line lays out as a row only inside .totals (components.css). */}
        <div className={`totals ${styles.sum}`}><div className="line"><span>{sums.left < 0 ? "Over the total by" : "Left to place"}</span><strong className="tabular">{formatMoneyCents(Math.abs(sums.left))}</strong></div></div>
        {problem && <p className={styles.warn} role="status">{problem}</p>}
        <FormError error={save.error} />
        <div className={styles.scheduleActions}>
          {/* Inside the column, the page's next step keeps the one solid green button. */}
          <Button size="sm" loading={save.isPending} disabled={Boolean(problem)} onClick={() => save.mutate(rows)}>Save schedule</Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          {shown.rows.length > 0 && <Button size="sm" variant="ghost" className={styles.takeOff} onClick={() => save.mutate(null)}>Take the schedule off</Button>}
        </div>
      </Section>
    );
  }

  // A day to set again (a copy's, a template's) or one that has gone by: said here, before Send says it.
  const dateProblem = shown.signed ? null : scheduleDateProblem(shown.rows, today, (iso) => formatDate(iso));
  return (
    <Section
      title="Payment schedule"
      className={styles.schedule}
      action={editable && <button type="button" onClick={() => setDraft(shown.rows.length ? scheduleRows(quote.payment_schedule).map(toDraft) : STARTER)}>{shown.rows.length ? "Edit" : "Add"}</button>}
    >
      {shown.rows.length ? (
        <>
          <div className={`totals ${styles.sum}`}>
            {shown.rows.map((r, i) => (
              <div key={i} className="line"><span>Payment {i + 1}: {scheduleDueText(r, (iso) => formatDate(iso))}</span><span className="tabular">{formatMoneyCents(r.amount)}</span></div>
            ))}
          </div>
          {!shown.fits && (
            <p className={styles.warn} role="status">
              <Icon name="alert" size={14} /> The total changed, so these payments {shown.left > 0 ? `leave ${formatMoneyCents(shown.left)} out` : `come to ${formatMoneyCents(-shown.left)} more than it`}. The last one takes what's left: edit the schedule to change that.
            </p>
          )}
          {!shown.signed && dateProblem && (
            <p className={styles.warn} role="status">
              <Icon name="alert" size={14} /> {dateProblem} The quote can't be sent until then.
            </p>
          )}
          {shown.signed && <p className={styles.quiet}>As it was approved. The job invoices each payment when it's due.</p>}
        </>
      ) : (
        <p className={styles.quiet}>One deposit, or payments over the job: when they approve, on a date, when the work starts or when it's done.</p>
      )}
    </Section>
  );
}
