/**
 * Deposits: each payout Stripe sent to the bank, what was taken out in fees, and the payments in
 * it, so the bank statement matches the invoices. Office and up, with the invoices area.
 */
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { BackLink, PageHeader, useDocumentTitle } from "@/components/ui/PageHeader";
import { ListPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { addDaysIso, formatDate, formatMoney, formatMoneyCents, todayIn } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { Stat } from "../finance/Charts";

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
        db.from("payments").select("fee_amount").eq("company_id", company.id).eq("processor", "stripe").gte("received_at", `${since}T00:00:00`).limit(5000),
      ]);
      const rows = unwrap(payouts);
      const ids = rows.map((p) => p.id);
      const payments = [];
      for (let i = 0; i < ids.length; i += 100) {
        payments.push(
          ...unwrap(
            await db
              .from("payments")
              .select("id, amount, tip_amount, fee_amount, method, received_at, payout_id, invoice:invoices(id, number), client:clients(id, display_name)")
              .eq("company_id", company.id)
              .in("payout_id", ids.slice(i, i + 100))
              .order("received_at"),
          ),
        );
      }
      return { payouts: rows, payments, fees: unwrap(fees).reduce((sum, p) => sum + Number(p.fee_amount), 0) };
    },
  });

  if (data.isPending) return <ListPageSkeleton columns={6} tabs={0} />;
  const d = data.data;
  const recent = (d?.payouts ?? []).filter((p) => p.status === "paid" && p.arrival_on >= since);
  const coming = (d?.payouts ?? []).filter((p) => p.status === "pending" || p.status === "in_transit");
  const byPayout = new Map<string, NonNullable<typeof d>["payments"]>();
  for (const payment of d?.payments ?? []) byPayout.set(payment.payout_id!, [...(byPayout.get(payment.payout_id!) ?? []), payment]);

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
      <BackLink to="/invoices">Invoices</BackLink>
      <PageHeader title="Deposits" actions={<Menu items={[{ label: "Download as spreadsheet", icon: "download", onSelect: exportCsv, disabled: !d?.payouts.length }]} />} />
      <p className="page-subtitle">Money Stripe sent to your bank, what it kept in fees, and the payments in each deposit.</p>
      {d && (
        <div className="stat-row">
          <Stat label="Deposited, last 30 days" value={formatMoney(recent.reduce((sum, p) => sum + Number(p.amount), 0))} hint={`${recent.length} ${recent.length === 1 ? "deposit" : "deposits"}`} />
          <Stat label="Stripe fees, last 30 days" value={formatMoneyCents(d.fees)} hint="On payments received" />
          <Stat label="On the way" value={formatMoney(coming.reduce((sum, p) => sum + Number(p.amount), 0))} hint={coming.length ? `Next ${formatDate(coming.at(-1)!.arrival_on)}` : "Nothing pending"} />
        </div>
      )}
      {data.error && !d ? (
        <div className="card"><ErrorState error={data.error} onRetry={() => data.refetch()} /></div>
      ) : !d?.payouts.length ? (
        <div className="card">
          <EmptyState icon="dollar" title="No deposits yet" action={<Link className="btn" to="/apps">Open Apps</Link>}>
            When Stripe sends money to your bank, it shows up here. To bring in deposits you already have, import your Stripe history from Apps.
          </EmptyState>
        </div>
      ) : (
        <div className="card">
          <table className="table table-stack">
            <thead><tr><th>Date</th><th>Status</th><th className="num">Payments</th><th className="num">Stripe fees</th><th className="num">Deposited</th><th aria-label="Details" /></tr></thead>
            <tbody>
              {d.payouts.map((p) => {
                const payments = byPayout.get(p.id) ?? [];
                const expanded = open === p.id;
                return (
                  <Fragment key={p.id}>
                    <tr className={payments.length ? "row-link" : undefined} onClick={() => payments.length && setOpen(expanded ? null : p.id)}>
                      <td>{formatDate(p.arrival_on)}</td>
                      <td><StatusPill {...(STATUS[p.status] ?? { label: p.status, tone: "muted" as Tone })} />{p.failure_message && <div className="small" style={{ color: "var(--danger)" }}>{p.failure_message}</div>}</td>
                      <td className="num tabular">{p.gross_amount === null ? "—" : formatMoneyCents(p.gross_amount)}</td>
                      <td className="num tabular">{p.fee_amount === null ? "—" : `−${formatMoneyCents(p.fee_amount)}`}</td>
                      <td className="num tabular strong">{formatMoneyCents(p.amount)}</td>
                      <td className="num">
                        {payments.length > 0 && (
                          <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={(e) => { e.stopPropagation(); setOpen(expanded ? null : p.id); }}>
                            {payments.length} {payments.length === 1 ? "payment" : "payments"} <Icon name={expanded ? "chevronUp" : "chevronDown"} size={14} />
                          </Button>
                        )}
                      </td>
                    </tr>
                    {expanded &&
                      payments.map((payment) => {
                        const invoice = payment.invoice as { id: string; number: number } | null;
                        const client = payment.client as { id: string; display_name: string } | null;
                        return (
                          <tr key={payment.id} className="muted">
                            <td className="small">{formatDate(payment.received_at)}</td>
                            <td className="small">
                              {client ? <Link to={`/clients/${client.id}`} className="cell-link">{client.display_name}</Link> : "—"}
                              {invoice && <> · <Link to={`/invoices/${invoice.id}`} className="cell-link">#{invoice.number}</Link></>}
                              {" · "}{METHODS[payment.method] ?? payment.method}
                            </td>
                            <td className="num tabular small">{formatMoneyCents(Number(payment.amount) + Number(payment.tip_amount))}</td>
                            <td className="num tabular small">{Number(payment.fee_amount) ? `−${formatMoneyCents(payment.fee_amount)}` : ""}</td>
                            <td className="num tabular small">{formatMoneyCents(Number(payment.amount) + Number(payment.tip_amount) - Number(payment.fee_amount))}</td>
                            <td />
                          </tr>
                        );
                      })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
