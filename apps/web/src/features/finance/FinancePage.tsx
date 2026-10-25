/**
 * Finance: money in, money owed and profit over one date range. The overview leads with a running
 * total against the period before; every table sorts and exports to CSV. Sales, work, team and
 * client figures are on Metrics. Owners and office staff who see invoices.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { CardSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { formatDate, formatMoney, formatMoneyCents, formatMoneyCompact, formatNumber, todayIn } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { localDate } from "@crewtavo/core/time";
import { Breakdown, Change, Kpi, KpiStrip, ReportCard, ReportTable, TrendChart, type Part } from "./Charts";
import { agingBuckets, jobProfit, previousRange } from "@crewtavo/core/reports";
import { bucketize, bucketizeShifted, bucketsFor, resolveRange, shortDate, type Range } from "./range";
import { both, fetchAll, pct, plural, RangeHeader, rangeQuery, SectionHead, sum, TabBody, timeRates, useRangeParams, type Rates } from "./shared";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "payments", label: "Payments" },
  { key: "profit", label: "Profit" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
type OpenTab = (tab: TabKey) => void;
/** Tabs that moved to Metrics; old links to them still land. */
const METRICS_TABS = ["sales", "work", "team", "clients"];

const running = (values: number[]) => {
  let total = 0;
  return values.map((v) => (total += v));
};
/** "Oct 16, 4:52 PM" in the company's zone. */
const paidAt = (iso: string, timeZone: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });

export function FinancePage() {
  const session = useSession();
  const state = useRangeParams();
  const { params, range, update } = state;
  // Payments was called Money; old links still open it.
  const asked = params.get("tab") === "money" ? "payments" : params.get("tab");
  if (asked && METRICS_TABS.includes(asked)) return <Navigate to={`/metrics?${params}`} replace />;
  if (!hasRole(session, "admin", "office") || !can(session, "reports") || !can(session, "invoices")) return <NoAccess title="Finance" />;
  const tab = (TABS.find((t) => t.key === asked)?.key ?? "overview") as TabKey;
  const openTab: OpenTab = (t) => {
    update({ tab: t === "overview" ? null : t });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return (
    <>
      <RangeHeader title="Finance" state={state} tabs={TABS} tab={tab} />
      <div key={tab} className="stack" style={{ gap: 28, animation: "page-in var(--dur-slow) var(--ease-out)" }} role="tabpanel">
        {tab === "overview" && <Overview range={range} openTab={openTab} />}
        {tab === "payments" && <Payments range={range} />}
        {tab === "profit" && <Profit range={range} />}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ Payments, shared */

const METHODS: Record<string, { label: string; icon: IconName; color: string }> = {
  card: { label: "Card", icon: "card", color: "var(--green)" },
  ach: { label: "Bank transfer", icon: "bank", color: "var(--invoice)" },
  cash: { label: "Cash", icon: "cash", color: "var(--req)" },
  check: { label: "Check", icon: "receipt", color: "var(--chat-purple)" },
  other: { label: "Other", icon: "dollar", color: "var(--text-4)" },
};
const methodOf = (m: string) => METHODS[m] ?? METHODS.other!;

/** Payments received in the range, newest first, with who paid and for which invoice. The Overview and Payments tabs share them. */
function usePayments(range: Range) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["finance", company.id, "payments", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: () =>
      fetchAll((a, b) =>
        supabase()
          .from("payments")
          .select("id, amount, fee_amount, tip_amount, method, received_at, notes, client:clients(id, display_name, email), invoice:invoices(id, number, issued_on)")
          .eq("company_id", company.id)
          .gte("received_at", range.start)
          .lt("received_at", range.end)
          .order("received_at", { ascending: false })
          .order("id")
          .range(a, b),
      ),
  });
}
type Payment = NonNullable<ReturnType<typeof usePayments>["data"]>[number];

function PaymentsTable({ rows }: { rows: Payment[] }) {
  const { company } = useSession();
  const navigate = useNavigate();
  return (
    <table className="table table-stack pay-table">
      <thead><tr><th className="num">Amount</th><th>Status</th><th>Method</th><th>Description</th><th>Client</th><th>Date</th></tr></thead>
      <tbody>
        {rows.map((p) => {
          const refund = Number(p.amount) < 0;
          const method = methodOf(p.method);
          const what = refund ? "Refund" : "Payment";
          return (
            <tr key={p.id} className={p.invoice ? "row-link" : undefined} onClick={() => p.invoice && navigate(`/invoices/${p.invoice.id}`)}>
              <td className="num tabular"><strong>{formatMoneyCents(p.amount)}</strong>{Number(p.tip_amount) > 0 && <div className="muted small">+{formatMoneyCents(p.tip_amount)} tip</div>}</td>
              <td><StatusPill label={refund ? "Refunded" : "Paid"} tone={refund ? "muted" : "good"} /></td>
              <td><span className="pay-method"><Icon name={method.icon} size={15} />{method.label}</span></td>
              <td>
                {p.invoice ? (
                  <Link className="cell-link" to={`/invoices/${p.invoice.id}`} onClick={(e) => e.stopPropagation()}>{what} for invoice #{p.invoice.number}</Link>
                ) : (
                  p.notes?.trim() || what
                )}
              </td>
              <td>
                {p.client ? (
                  <Link className="cell-link" to={`/clients/${p.client.id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 500 }}>{p.client.display_name}</Link>
                ) : <span className="muted">—</span>}
              </td>
              <td className="muted tabular" style={{ whiteSpace: "nowrap" }}>{paidAt(p.received_at, company.timezone)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** What came in, by how it was paid; refunds listed on their own. */
function methodParts(payments: Payment[]): Part[] {
  const by = new Map<string, { value: number; count: number }>();
  let refunded = 0;
  let refunds = 0;
  for (const p of payments) {
    const amount = Number(p.amount);
    if (amount < 0) {
      refunded += amount;
      refunds++;
      continue;
    }
    const key = METHODS[p.method] ? p.method : "other";
    const row = by.get(key) ?? { value: 0, count: 0 };
    row.value += amount;
    row.count++;
    by.set(key, row);
  }
  const parts: Part[] = Object.keys(METHODS)
    .filter((k) => by.get(k)?.value)
    .map((k) => ({ key: k, label: METHODS[k]!.label, color: METHODS[k]!.color, value: by.get(k)!.value, hint: plural(by.get(k)!.count, "payment") }));
  if (refunds) parts.push({ key: "refunded", label: "Refunded", color: "var(--fill-3)", value: refunded, hint: plural(refunds, "refund") });
  return parts;
}

/* ------------------------------------------------------------------ Overview */

const FIGURES = {
  collected: { label: "Collected", chart: "Collected, running total" },
  net: { label: "Net after fees", chart: "Collected after fees, running total" },
  invoiced: { label: "Invoiced", chart: "Invoiced, running total" },
} as const;
type Figure = keyof typeof FIGURES;

function Overview({ range, openTab }: { range: Range; openTab: OpenTab }) {
  const { company } = useSession();
  const cid = company.id;
  const tz = company.timezone;
  const [figure, setFigure] = useState<Figure>("collected");
  const prev = previousRange(range);
  const payments = usePayments(range);
  const rest = useQuery({
    queryKey: ["finance", cid, "overview", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [before, invoices, open, quotes, payouts] = await Promise.all([
        fetchAll((a, b) => db.from("payments").select("amount, fee_amount, received_at").eq("company_id", cid).gte("received_at", prev.start).lt("received_at", prev.end).range(a, b)),
        fetchAll((a, b) => db.from("invoices").select("total, issued_on").eq("company_id", cid).not("status", "in", "(draft,void)").gte("issued_on", prev.from).lte("issued_on", range.to).range(a, b)),
        fetchAll((a, b) => db.from("invoices").select("id, number, balance_due, due_on, client:clients(id, display_name)").eq("company_id", cid).in("status", ["sent", "partially_paid", "overdue"]).range(a, b)),
        fetchAll((a, b) => db.from("quotes").select("status, total, sent_at").eq("company_id", cid).gte("sent_at", prev.start).lt("sent_at", range.end).range(a, b)),
        db.from("payouts").select("amount, status, arrival_on").eq("company_id", cid).order("arrival_on", { ascending: false }).limit(12),
      ]);
      return { before, invoices, open, quotes, payouts: unwrap(payouts) };
    },
  });
  const buckets = bucketsFor(range);
  const today = todayIn(tz);
  return (
    <TabBody query={both(payments, rest)} skeleton={<OverviewSkeleton />}>
      {([pay, d]) => {
        const amount = (p: { amount: number | string }) => Number(p.amount);
        const net = (p: { amount: number | string; fee_amount: number | string | null }) => Number(p.amount) - Number(p.fee_amount ?? 0);
        const invoicedNow = d.invoices.filter((i) => i.issued_on >= range.from);
        const invoicedBefore = d.invoices.filter((i) => i.issued_on < range.from);
        const series: Record<Figure, { now: number[]; before: number[] }> = {
          collected: { now: bucketize(pay, buckets, (p) => p.received_at, amount, tz), before: bucketizeShifted(d.before, buckets, (p) => p.received_at, amount, tz, range.days) },
          net: { now: bucketize(pay, buckets, (p) => p.received_at, net, tz), before: bucketizeShifted(d.before, buckets, (p) => p.received_at, net, tz, range.days) },
          invoiced: { now: bucketize(invoicedNow, buckets, (i) => i.issued_on, (i) => Number(i.total), tz), before: bucketizeShifted(invoicedBefore, buckets, (i) => i.issued_on, (i) => Number(i.total), tz, range.days) },
        };
        const totals: Record<Figure, { now: number; before: number }> = {
          collected: { now: sum(pay, amount), before: sum(d.before, amount) },
          net: { now: sum(pay, net), before: sum(d.before, net) },
          invoiced: { now: sum(invoicedNow, (i) => Number(i.total)), before: sum(invoicedBefore, (i) => Number(i.total)) },
        };
        const fees = sum(pay, (p) => Number(p.fee_amount ?? 0));
        const owed = sum(d.open, (i) => Number(i.balance_due));
        const late = d.open.filter((i) => i.due_on && i.due_on < today && Number(i.balance_due) > 0).sort((a, b) => a.due_on!.localeCompare(b.due_on!));
        const coming = d.payouts.filter((p) => p.status === "pending" || p.status === "in_transit");
        const deposited = d.payouts.find((p) => p.status === "paid");
        const quotesNow = d.quotes.filter((q) => q.sent_at && q.sent_at >= range.start);
        const quotesBefore = d.quotes.filter((q) => q.sent_at && q.sent_at < range.start);
        const won = (q: { status: string }) => q.status === "approved" || q.status === "converted";
        // How long invoices took to be paid: issue date to payment date.
        const waits = pay.filter((p) => Number(p.amount) > 0 && p.invoice?.issued_on).map((p) => ({ amount: Number(p.amount), days: Math.max(0, Math.round((Date.parse(localDate(new Date(p.received_at), tz)) - Date.parse(p.invoice!.issued_on)) / 86_400_000)) }));
        const avgWait = waits.length ? sum(waits, (w) => w.days) / waits.length : null;
        const speed = [
          { key: "week", label: "Within a week", color: "var(--green)", test: (n: number) => n <= 7 },
          { key: "month", label: "1–4 weeks", color: "#d9a43b", test: (n: number) => n > 7 && n <= 30 },
          { key: "two", label: "1–2 months", color: "#d97a3b", test: (n: number) => n > 30 && n <= 60 },
          { key: "more", label: "Over 2 months", color: "#c8553d", test: (n: number) => n > 60 },
        ].map((b) => {
          const rows = waits.filter((w) => b.test(w.days));
          return { key: b.key, label: b.label, color: b.color, value: sum(rows, (w) => w.amount), hint: plural(rows.length, "payment") };
        });
        const payers = new Map<string, { id: string; name: string; email: string | null; paid: number }>();
        for (const p of pay) {
          if (!p.client) continue;
          const row = payers.get(p.client.id) ?? { id: p.client.id, name: p.client.display_name, email: p.client.email, paid: 0 };
          row.paid += Number(p.amount);
          payers.set(p.client.id, row);
        }
        const top = [...payers.values()].filter((c) => c.paid > 0).sort((a, b) => b.paid - a.paid).slice(0, 5);
        const agingColors: Record<string, string> = { current: "var(--green)", "30": "#d9a43b", "60": "#d97a3b", "90": "#c8553d", "90+": "var(--danger)" };
        const aging = agingBuckets(d.open, today).map((b) => ({ key: b.key, label: b.label, value: b.amount, color: agingColors[b.key]!, hint: plural(b.count, "invoice") }));
        const days = (due: string) => Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000);
        return (
          <>
            <section className="fin-hero" aria-label="Overview">
              <div className="fin-hero-main">
                <div className="fin-figures">
                  <div className="fin-figure">
                    <label className="metric-pick">
                      <i className="key" style={{ borderColor: figure === "invoiced" ? "var(--invoice)" : undefined }} aria-hidden />
                      <span className="sr-only">Figure to chart</span>
                      <select value={figure} onChange={(e) => setFigure(e.target.value as Figure)}>
                        {Object.entries(FIGURES).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
                      </select>
                      <Icon name="chevronDown" size={14} />
                    </label>
                    <div className="fin-hero-value">{formatMoney(totals[figure].now)}</div>
                    <div className="fin-hero-hint"><Change now={totals[figure].now} before={totals[figure].before} /> {range.label}</div>
                  </div>
                  <div className="fin-figure">
                    <div className="fin-figure-label"><i className="key dashed" aria-hidden />Previous period</div>
                    <div className="fin-hero-value is-muted">{formatMoney(totals[figure].before)}</div>
                    <div className="fin-hero-hint">{shortDate(prev.from)} – {shortDate(prev.to)}</div>
                  </div>
                </div>
                <TrendChart key={figure} buckets={buckets} values={running(series[figure].now)} previous={running(series[figure].before)} format={formatMoneyCompact} label={FIGURES[figure].chart} color={figure === "invoiced" ? "var(--invoice)" : "var(--green)"} height={240} />
                <div className="fin-balances">
                  <Balance label="Owed to you" value={formatMoney(owed)} hint={`${plural(d.open.length, "open invoice")}`} to="/invoices" />
                  <Balance label="Past due" value={formatMoney(sum(late, (i) => Number(i.balance_due)))} hint={late.length ? plural(late.length, "invoice") : "Nothing late"} to="/invoices?status=overdue" tone={late.length ? "bad" : undefined} />
                  {coming.length > 0 ? (
                    <Balance label="On the way to your bank" value={formatMoneyCents(sum(coming, (p) => Number(p.amount)))} hint={`Arrives ${formatDate(coming.map((p) => p.arrival_on).sort()[0])}`} to="/payouts" />
                  ) : deposited ? (
                    <Balance label="Last deposit" value={formatMoneyCents(deposited.amount)} hint={`Deposited ${formatDate(deposited.arrival_on)}`} to="/payouts" />
                  ) : null}
                </div>
              </div>
              <RevenueGoal />
            </section>

            <section className="stack" style={{ gap: 14 }} aria-labelledby="fin-performance">
              <SectionHead title="Performance" id="fin-performance"><span className="muted small">{range.label}</span></SectionHead>
              <div className="fin-grid">
                <ReportCard as="h3" title="Payments" info="Money received, by how it was paid. Refunds are listed on their own." footer={plural(pay.filter((p) => Number(p.amount) > 0).length, "payment")} more={{ label: "View all", onClick: () => openTab("payments") }}>
                  <Breakdown parts={methodParts(pay)} format={formatMoney} label="Payments by method" empty="No payments in this period." />
                </ReportCard>
                <ReportCard as="h3" title="Collected" info="Payments received, less refunds. Tips aren't included." value={<>{formatMoney(totals.collected.now)}<Change now={totals.collected.now} before={totals.collected.before} /></>} more={{ label: "More details", onClick: () => openTab("payments") }}>
                  <TrendChart buckets={buckets} values={series.collected.now} format={formatMoneyCompact} label="Collected over time" />
                </ReportCard>
                <ReportCard as="h3" title="Net volume" info="Collected, less card and bank processing fees: roughly what reaches your bank." value={<>{formatMoney(totals.net.now)}<Change now={totals.net.now} before={totals.net.before} /></>} footer={fees ? `${formatMoneyCents(fees)} in fees` : "No fees"} more={d.payouts.length ? { label: "Deposits", to: "/payouts" } : undefined}>
                  <TrendChart buckets={buckets} values={series.net.now} format={formatMoneyCompact} label="Net volume over time" />
                </ReportCard>
                <ReportCard as="h3" title="Unpaid invoices" info="What clients owe today, by how late it is." value={formatMoney(owed)} more={{ label: "View all", to: "/invoices" }}>
                  <Breakdown parts={aging} format={formatMoney} label="Unpaid invoices by age" empty="Nothing owed." />
                </ReportCard>
                <ReportCard as="h3" title="Invoiced" info="Invoices issued, not counting drafts or voided invoices." value={<>{formatMoney(totals.invoiced.now)}<Change now={totals.invoiced.now} before={totals.invoiced.before} /></>} footer={plural(invoicedNow.length, "invoice")} more={{ label: "Invoices", to: "/invoices" }}>
                  <TrendChart buckets={buckets} values={series.invoiced.now} format={formatMoneyCompact} label="Invoiced over time" color="var(--invoice)" />
                </ReportCard>
                <ReportCard as="h3" title="Past due" info="Invoices past their due date that still have a balance, oldest first." footer={late.length ? plural(late.length, "invoice") : undefined} more={late.length ? { label: "View all", to: "/invoices?status=overdue" } : undefined}>
                  {late.length ? (
                    <ul className="fin-list">
                      {late.slice(0, 4).map((i) => (
                        <li key={i.id}>
                          <Link to={`/invoices/${i.id}`} className="fin-list-main">
                            <strong className="tabular">{formatMoneyCents(i.balance_due)}</strong>
                            <span className="muted small ellipsis">#{i.number} · {i.client?.display_name ?? "—"} · due {shortDate(i.due_on!)}</span>
                          </Link>
                          <StatusPill label={`${days(i.due_on!)} ${days(i.due_on!) === 1 ? "day" : "days"} late`} tone={days(i.due_on!) > 60 ? "danger" : "warning"} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="fin-clear"><Icon name="check" size={16} />Every invoice is within its terms.</p>
                  )}
                </ReportCard>
                <ReportCard as="h3" title="Top clients by spend" info="Who paid you the most in this period." footer={payers.size ? plural(payers.size, "client") + " paid" : undefined}>
                  {top.length ? (
                    <ul className="fin-list">
                      {top.map((c) => (
                        <li key={c.id}>
                          <Link to={`/clients/${c.id}`} className="fin-list-main">
                            <strong className="ellipsis">{c.name}</strong>
                            {c.email && <span className="muted small ellipsis">{c.email}</span>}
                          </Link>
                          <strong className="tabular">{formatMoneyCents(c.paid)}</strong>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small" style={{ margin: 0 }}>No payments in this period.</p>
                  )}
                </ReportCard>
                <ReportCard as="h3" title="Time to get paid" info="Days from an invoice being issued to its payment, for payments received in this period." value={avgWait === null ? "—" : `${formatNumber(avgWait, avgWait < 10 ? 1 : 0)} days`} footer={waits.length ? `Average of ${plural(waits.length, "invoice payment")}` : undefined}>
                  <Breakdown parts={speed} format={formatMoney} label="Payments by how long they took" empty="No invoice payments in this period." />
                </ReportCard>
                <ReportCard as="h3" title="Quotes won" info="The value of quotes sent in this period that were approved." value={<>{formatMoney(sum(quotesNow.filter(won), (q) => Number(q.total)))}<Change now={sum(quotesNow.filter(won), (q) => Number(q.total))} before={sum(quotesBefore.filter(won), (q) => Number(q.total))} /></>} footer={`${quotesNow.filter(won).length} of ${quotesNow.length} won · ${pct(quotesNow.filter(won).length, quotesNow.length)}`} more={{ label: "Sales metrics", to: `/metrics?tab=sales&${rangeQuery(range)}` }}>
                  <TrendChart buckets={buckets} values={bucketize(quotesNow.filter(won), buckets, (q) => q.sent_at, (q) => Number(q.total), tz)} format={formatMoneyCompact} label="Quotes won over time" color="var(--quote)" />
                </ReportCard>
              </div>
            </section>

            <section className="stack" style={{ gap: 14 }}>
              <SectionHead title="Recent payments">{pay.length > 0 && <button type="button" className="section-link" onClick={() => openTab("payments")}>View all<Icon name="arrowRight" size={14} /></button>}</SectionHead>
              {pay.length ? (
                <div className="card"><PaymentsTable rows={pay.slice(0, 6)} /></div>
              ) : (
                <div className="card"><EmptyState compact icon="dollar" title="No payments in this period">Payments you record or receive online show up here.</EmptyState></div>
              )}
            </section>
          </>
        );
      }}
    </TabBody>
  );
}

function Balance({ label, value, hint, to, tone }: { label: string; value: string; hint: string; to: string; tone?: "bad" }) {
  return (
    <div className="fin-balance">
      <div className="row-between">
        <span className="fin-balance-label">{label}</span>
        <Link to={to} aria-label={`View ${label.toLowerCase()}`}>View</Link>
      </div>
      <div className="fin-balance-value" style={tone === "bad" ? { color: "var(--danger)" } : undefined}>{value}</div>
      <div className="muted small">{hint}</div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <div className="fin-hero" aria-hidden>
        <div className="fin-hero-main" style={{ display: "grid", gap: 14 }}>
          <Skeleton width={120} height={14} />
          <Skeleton width={220} height={40} />
          <Skeleton height={240} radius={8} />
        </div>
        <CardSkeleton lines={4} />
      </div>
      <div className="fin-grid" aria-hidden>{[0, 1, 2, 3, 4, 5].map((i) => <CardSkeleton key={i} lines={4} height={230} />)}</div>
    </>
  );
}

function RevenueGoal() {
  const session = useSession();
  const { company } = session;
  const tz = company.timezone;
  const today = todayIn(tz);
  const year = today.slice(0, 4);
  const [editing, setEditing] = useState(false);
  const query = useQuery({
    queryKey: ["finance", company.id, "goal", year],
    queryFn: async () => {
      const db = supabase();
      const yearRange = resolveRange("year", today, tz);
      const [settings, payments] = await Promise.all([
        db.from("companies").select("settings").eq("id", company.id).single(),
        fetchAll((a, b) => db.from("payments").select("amount").eq("company_id", company.id).gte("received_at", yearRange.start).range(a, b)),
      ]);
      const s = (unwrap(settings).settings ?? {}) as Record<string, unknown>;
      return { settings: s, goal: Number(s.revenue_goal ?? 0), margin: Number(s.margin_target ?? 0), ytd: sum(payments, (p) => Number(p.amount)) };
    },
  });
  const isAdmin = hasRole(session, "admin");
  if (!query.data)
    return query.error ? <div className="card"><ErrorState compact error={query.error} onRetry={() => query.refetch()} /></div> : <CardSkeleton lines={3} />;
  const { goal, ytd } = query.data;
  const dayOfYear = Math.floor((Date.parse(today) - Date.parse(`${year}-01-01`)) / 86_400_000) + 1;
  const daysInYear = Number(year) % 4 === 0 ? 366 : 365;
  const pace = dayOfYear / daysInYear;
  const progress = goal > 0 ? ytd / goal : 0;
  const projected = ytd / pace;
  return (
    <ReportCard title={`${year} revenue goal`} info="Collected since January 1, against the yearly goal an admin sets." action={isAdmin && <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(true)}>{goal ? "Edit" : "Set goal"}</Button>}>
      {goal > 0 ? (
        <div className="stack" style={{ gap: 14 }}>
          <div className="row" style={{ alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span className="report-card-value" style={{ fontSize: 30 }}>{formatMoney(ytd)}</span>
            <span className="muted">of {formatMoney(goal)}</span>
          </div>
          <div className="goal-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Progress to revenue goal">
            <span className="fill" style={{ width: `${Math.min(100, progress * 100)}%`, background: progress >= pace ? "var(--green)" : "#d9a43b" }} />
            <span className="pace" style={{ left: `${pace * 100}%` }} title="Where you'd be on an even pace" />
          </div>
          <div className="kv" style={{ gridTemplateColumns: "1fr auto" }}>
            <span className="muted">Progress</span><strong className="tabular">{Math.round(progress * 100)}%</strong>
            <span className="muted">Even pace by today</span><strong className="tabular">{formatMoney(goal * pace)}</strong>
            <span className="muted">On track for</span><strong className="tabular" style={{ color: projected >= goal ? "var(--green-dark)" : "var(--warning)" }}>{formatMoney(projected)}</strong>
          </div>
          <span className="small" style={{ color: progress >= pace ? "var(--green-dark)" : "var(--warning)", fontWeight: 700 }}>
            {progress >= 1 ? "Goal reached. Nice work!" : progress >= pace ? `Ahead of pace by ${formatMoney(ytd - goal * pace)}` : `Behind pace by ${formatMoney(goal * pace - ytd)}`}
          </span>
        </div>
      ) : (
        <EmptyState compact icon="finance" title="No goal set" action={isAdmin ? <Button size="sm" variant="primary" onClick={() => setEditing(true)}>Set a revenue goal</Button> : undefined}>
          {formatMoney(ytd)} collected so far this year.
        </EmptyState>
      )}
      {editing && <GoalDialog settings={query.data.settings} onClose={() => setEditing(false)} />}
    </ReportCard>
  );
}

function GoalDialog({ settings, onClose }: { settings: Record<string, unknown>; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [goal, setGoal] = useState(settings.revenue_goal ? String(settings.revenue_goal) : "");
  const [margin, setMargin] = useState(settings.margin_target ? String(settings.margin_target) : "");
  const save = useMutation({
    meta: { inline: true, success: "Goals saved" },
    mutationFn: async () => {
      const m = margin.trim() ? Number(margin) : null;
      const g = goal.trim() ? Number(goal.replace(/,/g, "")) : null;
      if (g !== null && !(g >= 0 && g < 1e10)) throw new Error("Enter a revenue goal of $0 or more.");
      if (m !== null && !(m >= 0 && m < 100)) throw new Error("Target margin must be between 0 and 99%.");
      // Re-read settings so a concurrent change elsewhere isn't overwritten.
      const current = (unwrap(await supabase().from("companies").select("settings").eq("id", company.id).single()).settings ?? {}) as Record<string, unknown>;
      unwrap(await supabase().from("companies").update({ settings: { ...current, revenue_goal: g || null, margin_target: m } as never }).eq("id", company.id));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance", company.id] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Goals" size="sm">
      <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Yearly revenue goal">
          <div className="input-group"><span className="addon">$</span><input className="input" inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value.replace(/[^0-9.,]/g, ""))} placeholder="500,000" autoFocus /></div>
        </Field>
        <Field label="Target job margin" optional>
          <div className="input-group"><input className="input" inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="30" style={{ paddingLeft: 12, paddingRight: 32 }} /><span className="addon addon-right">%</span></div>
        </Field>
        <FormError error={save.error} />
        <div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={save.isPending}>Save goals</Button></div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Payments */

const PAGE = 25;

function Payments({ range }: { range: Range }) {
  const { company } = useSession();
  const cid = company.id;
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const payments = usePayments(range);
  const rest = useQuery({
    queryKey: ["finance", cid, "billed", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [invoices, open, writtenOff, payouts] = await Promise.all([
        fetchAll((a, b) => db.from("invoices").select("total, tax_amount").eq("company_id", cid).not("status", "in", "(draft,void)").gte("issued_on", range.from).lte("issued_on", range.to).range(a, b)),
        fetchAll((a, b) => db.from("invoices").select("balance_due, due_on, client:clients(id, display_name)").eq("company_id", cid).in("status", ["sent", "partially_paid", "overdue"]).range(a, b)),
        // Bad debt: what was left on invoices written off in the range.
        fetchAll((a, b) => db.from("invoices").select("balance_due").eq("company_id", cid).eq("status", "written_off").gte("written_off_at", range.start).lt("written_off_at", range.end).range(a, b)),
        db.from("payouts").select("id", { count: "exact", head: true }).eq("company_id", cid),
      ]);
      if (payouts.error) throw payouts.error;
      return { invoices, open, writtenOff, payouts: payouts.count ?? 0 };
    },
  });
  return (
    <TabBody query={both(payments, rest)}>
      {([pay, d]) => {
        const today = todayIn(company.timezone);
        const refunds = pay.filter((p) => Number(p.amount) < 0);
        const collected = sum(pay, (p) => Number(p.amount));
        const fees = sum(pay, (p) => Number(p.fee_amount ?? 0));
        const writtenOff = sum(d.writtenOff, (i) => Number(i.balance_due));
        const filters = [
          { key: "all", label: "All", rows: pay },
          ...Object.keys(METHODS).map((k) => ({ key: k, label: METHODS[k]!.label, rows: pay.filter((p) => Number(p.amount) >= 0 && (METHODS[p.method] ? p.method : "other") === k) })),
          { key: "refunds", label: "Refunds", rows: refunds },
        ].filter((f) => f.key === "all" || f.rows.length);
        const shown = (filters.find((f) => f.key === filter) ?? filters[0]!).rows;
        const pages = Math.max(1, Math.ceil(shown.length / PAGE));
        const at = Math.min(page, pages - 1);
        const balances = new Map<string, { id: string; name: string; count: number; balance: number; oldest: string | null }>();
        for (const i of d.open) {
          if (!i.client) continue;
          const row = balances.get(i.client.id) ?? { id: i.client.id, name: i.client.display_name, count: 0, balance: 0, oldest: null };
          row.count++;
          row.balance += Number(i.balance_due);
          if (i.due_on && (!row.oldest || i.due_on < row.oldest)) row.oldest = i.due_on;
          balances.set(i.client.id, row);
        }
        const exportCsv = () =>
          downloadCsv(
            `payments-${range.from}-to-${range.to}.csv`,
            toCsv(
              shown.map((p) => ({
                date: p.received_at, amount: p.amount, fee: p.fee_amount, tip: p.tip_amount, method: methodOf(p.method).label,
                status: Number(p.amount) < 0 ? "Refunded" : "Paid", invoice: p.invoice?.number ?? "", client: p.client?.display_name ?? "", notes: p.notes ?? "",
              })),
              [
                { key: "date", label: "Date" }, { key: "amount", label: "Amount" }, { key: "fee", label: "Fee" }, { key: "tip", label: "Tip" }, { key: "method", label: "Method" },
                { key: "status", label: "Status" }, { key: "invoice", label: "Invoice" }, { key: "client", label: "Client" }, { key: "notes", label: "Notes" },
              ],
            ),
          );
        return (
          <>
            <KpiStrip label="Payments this period">
              <Kpi label="Collected" value={formatMoney(collected)} hint={plural(pay.length - refunds.length, "payment")} />
              <Kpi label="Refunded" value={formatMoney(-sum(refunds, (p) => Number(p.amount)))} hint={plural(refunds.length, "refund")} />
              <Kpi label="Processing fees" value={formatMoneyCents(fees)} hint={d.payouts ? <Link to="/payouts">See deposits</Link> : "Card and bank payments"} />
              <Kpi label="Net after fees" value={formatMoney(collected - fees)} />
              <Kpi label="Tips" value={formatMoney(sum(pay, (p) => Number(p.tip_amount ?? 0)))} />
              <Kpi label="Sales tax billed" value={formatMoney(sum(d.invoices, (i) => Number(i.tax_amount)))} hint={`On ${plural(d.invoices.length, "invoice")}`} />
              {writtenOff > 0 && <Kpi label="Written off" value={formatMoneyCents(writtenOff)} hint={<Link to="/invoices?status=written_off">{plural(d.writtenOff.length, "invoice")}</Link>} />}
            </KpiStrip>

            <section className="stack" style={{ gap: 12 }}>
              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <div className="tabs" role="group" aria-label="Filter payments">
                  {filters.map((f) => (
                    <button key={f.key} type="button" className="tab" aria-pressed={filter === f.key || (f.key === "all" && !filters.some((x) => x.key === filter))} onClick={() => { setFilter(f.key); setPage(0); }}>
                      {f.label}<span className="badge">{formatNumber(f.rows.length)}</span>
                    </button>
                  ))}
                </div>
                {shown.length > 0 && <Button size="sm" icon="download" onClick={exportCsv}>Download</Button>}
              </div>
              {shown.length ? (
                <div className="card">
                  <PaymentsTable rows={shown.slice(at * PAGE, at * PAGE + PAGE)} />
                  <div className="list-foot">
                    <span className="tabular">{formatNumber(at * PAGE + 1)}–{formatNumber(Math.min(shown.length, at * PAGE + PAGE))} of {plural(shown.length, "result")}</span>
                    {pages > 1 && (
                      <div className="row" style={{ gap: 4 }}>
                        <button type="button" className="btn btn-icon btn-sm" disabled={at === 0} onClick={() => setPage(at - 1)} aria-label="Previous page"><Icon name="chevronLeft" size={16} /></button>
                        <button type="button" className="btn btn-icon btn-sm" disabled={at >= pages - 1} onClick={() => setPage(at + 1)} aria-label="Next page"><Icon name="chevronRight" size={16} /></button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="card"><EmptyState compact icon="dollar" title="No payments in this period">Payments you record or receive online show up here.</EmptyState></div>
              )}
            </section>

            <ReportCard title="Client balances" subtitle="Who owes you, as of today">
              <ReportTable
                rows={[...balances.values()]}
                rowKey={(r) => r.id}
                filename={`client-balances-${today}`}
                initialSort={{ key: "balance", desc: true }}
                empty="Nothing owed"
                columns={[
                  { key: "name", label: "Client", value: (r) => r.name, render: (r) => <Link className="cell-link" to={`/clients/${r.id}`}>{r.name}</Link> },
                  { key: "count", label: "Open invoices", num: true, value: (r) => r.count },
                  { key: "oldest", label: "Oldest due", value: (r) => r.oldest, render: (r) => (r.oldest ? <span style={{ color: r.oldest < today ? "var(--danger)" : undefined, fontWeight: r.oldest < today ? 700 : undefined }}>{formatDate(r.oldest)}</span> : "—") },
                  { key: "balance", label: "Balance", num: true, value: (r) => Math.round(r.balance * 100) / 100, render: (r) => <strong>{formatMoney(r.balance)}</strong> },
                ]}
              />
            </ReportCard>
          </>
        );
      }}
    </TabBody>
  );
}


/* ------------------------------------------------------------------ Profit */

function Profit({ range }: { range: Range }) {
  const session = useSession();
  const { company } = session;
  const costs = can(session, "job_costs");
  const cid = company.id;
  const query = useQuery({
    queryKey: ["finance", cid, "profit", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [jobs, lines, settings] = await Promise.all([
        fetchAll((a, b) => db.from("jobs").select("id, number, title, status, financials:job_financials(contract_total), client:clients(display_name), lines:job_line_items(quantity, unit_cost, unit_labor_cost)").eq("company_id", cid).in("status", ["requires_invoicing", "completed"]).gte("updated_at", range.start).lt("updated_at", range.end).range(a, b)),
        // Deposit and progress invoices are partial billings of the same work, so count items from the rest.
        fetchAll((a, b) => db.from("invoice_line_items").select("name, quantity, unit_price, invoice:invoices!inner(issued_on, status, kind)").eq("company_id", cid).gte("invoice.issued_on", range.from).lte("invoice.issued_on", range.to).not("invoice.status", "in", "(draft,void)").not("invoice.kind", "in", "(deposit,progress)").gte("unit_price", 0).range(a, b)),
        db.from("companies").select("settings").eq("id", cid).single(),
      ]);
      const ids = jobs.map((j) => j.id);
      const [time, expenses, rates, crewPay] = ids.length
        ? await Promise.all([
            fetchAll((a, b) => db.from("time_entries").select("id, job_id, started_at, ended_at").in("job_id", ids.slice(0, 300)).range(a, b)),
            fetchAll((a, b) => db.from("expenses").select("job_id, amount").in("job_id", ids.slice(0, 300)).range(a, b)),
            timeRates(costs, { job_ids: ids.slice(0, 300) }),
            // Sub and crew pay that's agreed, done or paid: for those with job costs, nothing for anyone else.
            costs ? db.rpc("job_pay_costs", { p_jobs: ids.slice(0, 300) }).then(unwrap) : Promise.resolve([]),
          ])
        : [[], [], {} as Rates, []];
      const target = Number(((unwrap(settings).settings ?? {}) as Record<string, unknown>).margin_target ?? 0) || null;
      // Costed as AI assistants' job_profit costs it (packages/core/src/reports.ts).
      const costed = jobProfit(jobs, time, expenses, (t) => Number(rates[t.id] ?? 0), target, crewPay).jobs.map((j) => ({ ...j, margin: j.margin_percent }));
      return { jobs: costed, lines, target };
    },
  });
  return (
    <TabBody query={query}>
      {(d) => {
        const revenue = sum(d.jobs, (j) => j.revenue);
        const profit = sum(d.jobs, (j) => j.profit);
        const below = d.target ? d.jobs.filter((j) => j.margin !== null && j.margin < d.target!) : [];
        const services = new Map<string, { name: string; qty: number; revenue: number }>();
        for (const l of d.lines) {
          if (Number(l.unit_price) < 0) continue; // discounts and credits aren't services
          const row = services.get(l.name) ?? { name: l.name, qty: 0, revenue: 0 };
          row.qty += Number(l.quantity);
          row.revenue += Number(l.quantity) * Number(l.unit_price);
          services.set(l.name, row);
        }
        return (
          <>
            <KpiStrip label="Profit this period">
              <Kpi label="Jobs completed" value={formatNumber(d.jobs.length)} />
              <Kpi label="Job revenue" value={formatMoney(revenue)} hint="Contract totals" />
              <Kpi label="Average job" value={d.jobs.length ? formatMoney(revenue / d.jobs.length) : "—"} />
              {costs && <Kpi label="Job profit" value={formatMoney(profit)} hint={revenue ? `${Math.round((profit / revenue) * 100)}% margin` : undefined} tone={profit < 0 ? "bad" : undefined} />}
              {costs && <Kpi label="Below target margin" value={d.target ? formatNumber(below.length) : "—"} hint={d.target ? `Target ${d.target}%` : "No target set"} tone={below.length ? "bad" : undefined} />}
            </KpiStrip>
            {costs && (
              <ReportCard title="Job profitability" subtitle="Labor, sub and crew pay, expenses and materials against each job's contract total">
                <ReportTable
                  rows={d.jobs}
                  rowKey={(r) => r.id}
                  filename={`job-profitability-${range.from}-to-${range.to}`}
                  initialSort={{ key: "margin", desc: false }}
                  empty="No jobs were completed in this period."
                  columns={[
                    { key: "number", label: "Job", value: (r) => r.number, render: (r) => <Link className="cell-link" to={`/jobs/${r.id}`}>#{r.number} {r.title}</Link> },
                    { key: "client", label: "Client", value: (r) => r.client },
                    { key: "revenue", label: "Revenue", num: true, value: (r) => r.revenue, render: (r) => formatMoney(r.revenue) },
                    { key: "cost", label: "Costs", num: true, value: (r) => Math.round(r.cost * 100) / 100, render: (r) => formatMoney(r.cost) },
                    { key: "profit", label: "Profit", num: true, value: (r) => Math.round(r.profit * 100) / 100, render: (r) => <span style={{ color: r.profit < 0 ? "var(--danger)" : undefined }}>{formatMoney(r.profit)}</span> },
                    {
                      key: "margin", label: "Margin", num: true, value: (r) => (r.margin === null ? null : Math.round(r.margin)),
                      render: (r) => r.margin === null ? "—" : <span className="pill" data-tone={d.target && r.margin < d.target ? "danger" : r.margin < 0 ? "danger" : "success"}>{Math.round(r.margin)}%</span>,
                    },
                  ]}
                />
              </ReportCard>
            )}
            <ReportCard title="Products & services sold" subtitle="From invoices issued in this period">
              <ReportTable
                rows={[...services.values()]}
                rowKey={(r) => r.name}
                filename={`services-sold-${range.from}-to-${range.to}`}
                initialSort={{ key: "revenue", desc: true }}
                empty="No invoices were issued in this period."
                columns={[
                  { key: "name", label: "Item", value: (r) => r.name, render: (r) => <strong>{r.name}</strong> },
                  { key: "qty", label: "Quantity", num: true, value: (r) => Math.round(r.qty * 100) / 100, render: (r) => formatNumber(r.qty, r.qty % 1 ? 2 : 0) },
                  { key: "revenue", label: "Revenue", num: true, value: (r) => Math.round(r.revenue * 100) / 100, render: (r) => formatMoney(r.revenue) },
                ]}
              />
            </ReportCard>
          </>
        );
      }}
    </TabBody>
  );
}
