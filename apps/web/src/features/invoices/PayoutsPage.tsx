/**
 * Deposits: each payout Stripe sent to the bank, what was taken out in fees, and the payments in
 * it, so the bank statement matches the invoices. Office and up, with the invoices area.
 */
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { DetailHeader } from "@/components/ui/DetailPage";
import { Icon } from "@/components/ui/Icon";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { useDocumentTitle } from "@/components/ui/PageHeader";
import { InboxPageSkeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { everyRow } from "@/lib/paging";
import { addDaysIso, formatDate, formatMoney, formatMoneyCents, todayIn } from "@/lib/format";
import { intlLocale } from "@/lib/i18n";
import { can, hasRole, useSession } from "@/lib/session";
import { stripeFeesSince } from "./totals";
import styles from "./invoices.module.css";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  paid: { label: "Deposited", tone: "good" },
  in_transit: { label: "On the way", tone: "info" },
  pending: { label: "Pending", tone: "info" },
  failed: { label: "Failed", tone: "danger" },
  canceled: { label: "Canceled", tone: "muted" },
};
const METHODS: Record<string, string> = { card: "Card", ach: "Bank", other: "Other", cash: "Cash", check: "Check" };

export function PayoutsPage() {
  const session = useSession();
  return hasRole(session, "admin", "office") && can(session, "invoices") ? <PayoutsScreen /> : <NoAccess title="Deposits" />;
}

function PayoutsScreen() {
  const { company } = useSession();
  useDocumentTitle("Deposits");
  const today = todayIn(company.timezone);
  const since = addDaysIso(today, -30);
  const [open, setOpen] = useState<string | null>(null);

  const data = useQuery({
    queryKey: ["payouts", company.id],
    queryFn: async () => {
      const db = supabase();
      const [payouts, fees] = await Promise.all([
        db.from("payouts").select("id, amount, gross_amount, fee_amount, status, arrival_on, failure_message, itemized_at").eq("company_id", company.id).order("arrival_on", { ascending: false }).limit(200),
        // The database adds these up (stripe_fees): there can be more payments than one request hands over.
        stripeFeesSince(company.id, since),
      ]);
      const rows = unwrap(payouts);
      const ids = rows.map((p) => p.id);
      const payments = [];
      for (let i = 0; i < ids.length; i += 100) {
        // A hundred deposits can hold more payments than one request hands over, so they're read to the end.
        payments.push(
          ...(await everyRow(
            () =>
              db
                .from("payments")
                .select("id, amount, tip_amount, fee_amount, method, received_at, payout_id, invoice:invoices(id, number), client:clients(id, display_name)")
                .eq("company_id", company.id)
                .in("payout_id", ids.slice(i, i + 100)),
            { order: "received_at", most: Infinity },
          )),
        );
      }
      return { payouts: rows, payments, fees };
    },
  });

  if (data.isPending) return <InboxPageSkeleton tabs={0} groups={2} />;
  const d = data.data;
  const recent = (d?.payouts ?? []).filter((p) => p.status === "paid" && p.arrival_on >= since);
  const coming = (d?.payouts ?? []).filter((p) => p.status === "pending" || p.status === "in_transit");
  const byPayout = new Map<string, NonNullable<typeof d>["payments"]>();
  for (const payment of d?.payments ?? []) byPayout.set(payment.payout_id!, [...(byPayout.get(payment.payout_id!) ?? []), payment]);
  // By the month they reach the bank, newest first, as a bank statement reads.
  const months = new Map<string, NonNullable<typeof d>["payouts"]>();
  for (const p of d?.payouts ?? []) months.set(p.arrival_on.slice(0, 7), [...(months.get(p.arrival_on.slice(0, 7)) ?? []), p]);

  const exportCsv = () =>
    downloadCsv(
      `deposits-${today}.csv`,
      toCsv(
        (d?.payouts ?? []).map((p) => ({ ...p, status: STATUS[p.status]?.label ?? p.status, payments: byPayout.get(p.id)?.length ?? "" })),
        [
          { key: "arrival_on", label: "Date" }, { key: "status", label: "Status" }, { key: "gross_amount", label: "Payments" },
          { key: "fee_amount", label: "Stripe fees" }, { key: "amount", label: "Deposited" }, { key: "payments", label: "Number of payments" },
        ],
      ),
    );

  return (
    <>
      <DetailHeader
        crumb={{ to: "/invoices", label: "Invoices" }}
        title="Deposits"
        more={[{ label: "Download as spreadsheet", icon: "download", onSelect: exportCsv, disabled: !d?.payouts.length }]}
      >
        <p className={`page-lede ${styles.lede}`}>Money Stripe sent to your bank, what it kept in fees, and the payments in each deposit.</p>
      </DetailHeader>
      {d && (
        <StatStrip label="Deposit totals">
          <Stat label="Deposited, last 30 days" value={formatMoney(recent.reduce((sum, p) => sum + Number(p.amount), 0))} note={`${recent.length} ${recent.length === 1 ? "deposit" : "deposits"}`} />
          <Stat label="Stripe fees, last 30 days" value={formatMoneyCents(d.fees)} note="On payments received" />
          <Stat label="On the way" value={formatMoney(coming.reduce((sum, p) => sum + Number(p.amount), 0))} note={coming.length ? `Next ${formatDate(coming.at(-1)!.arrival_on)}` : "Nothing pending"} />
        </StatStrip>
      )}
      {data.error && !d ? (
        <ErrorState error={data.error} onRetry={() => data.refetch()} />
      ) : !d?.payouts.length ? (
        <EmptyState icon="bank" title="No deposits yet" action={<Link className="btn" to="/apps">Open Apps</Link>}>
          When Stripe sends money to your bank, it shows up here. To bring in deposits you already have, import your Stripe history from Apps.
        </EmptyState>
      ) : (
        [...months].map(([month, payouts]) => (
          <Section key={month} title={monthName(month, today)} count={payouts.length} action={<span className={styles.monthSum}>{formatMoneyCents(payouts.filter((p) => p.status === "paid").reduce((sum, p) => sum + Number(p.amount), 0))} deposited</span>}>
            <RelatedList label={monthName(month, today)}>
              {payouts.map((p) => {
                const payments = byPayout.get(p.id) ?? [];
                const expanded = open === p.id;
                const status = STATUS[p.status] ?? { label: p.status, tone: "muted" as Tone };
                return (
                  <Fragment key={p.id}>
                    <RelatedRow
                      title={formatDate(p.arrival_on)}
                      sub={[
                        <StatusPill {...status} />,
                        p.gross_amount !== null && `${formatMoneyCents(p.gross_amount)} in payments`,
                        p.failure_message && <span className={`meta-break ${styles.failed}`}>{p.failure_message}</span>,
                        // Opens the payments under it: at the end of its line (its own line on a phone), so the money keeps the right edge.
                        payments.length > 0 && (
                          <span className="meta-break">
                            <button type="button" className={`link-btn ${styles.toggle}`} aria-expanded={expanded} aria-controls={expanded ? `deposit-${p.id}` : undefined} onClick={() => setOpen(expanded ? null : p.id)}>
                              {payments.length} {payments.length === 1 ? "payment" : "payments"} <Icon name={expanded ? "chevronUp" : "chevronDown"} size={14} />
                            </button>
                          </span>
                        ),
                      ]}
                      end={
                        <span className={styles.depositEnd}>
                          <b className={p.status === "failed" || p.status === "canceled" ? styles.voided : undefined}>{formatMoneyCents(p.amount)}</b>
                          {p.fee_amount !== null && Number(p.fee_amount) !== 0 && <span className="il-sub">−{formatMoneyCents(p.fee_amount)} fees</span>}
                        </span>
                      }
                    />
                    {expanded && (
                      <li className={styles.inDeposit}>
                        <ul className="rel" role="list" id={`deposit-${p.id}`} aria-label={`Payments in the ${formatDate(p.arrival_on)} deposit`}>
                          {payments.map((payment) => {
                            const invoice = payment.invoice as { id: string; number: number } | null;
                            const client = payment.client as { id: string; display_name: string } | null;
                            const gross = Number(payment.amount) + Number(payment.tip_amount);
                            return (
                              <RelatedRow
                                key={payment.id}
                                to={invoice ? `/invoices/${invoice.id}` : client ? `/clients/${client.id}` : undefined}
                                title={client?.display_name ?? (invoice ? `Invoice #${invoice.number}` : "Payment")}
                                detail={client && invoice ? `#${invoice.number}` : undefined}
                                sub={[formatDate(payment.received_at), METHODS[payment.method] ?? payment.method, Number(payment.fee_amount) ? `${formatMoneyCents(gross)} less ${formatMoneyCents(payment.fee_amount)} fee` : null]}
                                end={formatMoneyCents(gross - Number(payment.fee_amount))}
                              />
                            );
                          })}
                        </ul>
                      </li>
                    )}
                  </Fragment>
                );
              })}
            </RelatedList>
          </Section>
        ))
      )}
    </>
  );
}

/** "November", or "November 2025" from another year. */
const monthName = (month: string, today: string) =>
  new Date(`${month}-15T12:00:00`).toLocaleDateString(intlLocale(), month.slice(0, 4) === today.slice(0, 4) ? { month: "long" } : { month: "long", year: "numeric" });
