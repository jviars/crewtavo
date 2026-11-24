/**
 * Finance (Page-Finance.dc.html): money in, money owed and profit over one date range. The overview
 * leads with one figure against the period before and what's owed beside it, then the breakdowns
 * as rows and the latest payments; every table sorts and exports to CSV. Sales, work, team and
 * client figures are on Metrics. Owners and office staff who see invoices.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { DecimalInput } from "@/components/ui/DecimalInput";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, ListFoot, RowPerson } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { CardSkeleton, Skeleton, StatsSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { statusText } from "@/components/ui/StatusPill";
import { FilterTabs, SearchField, Toolbar } from "@/components/ui/Toolbar";
import { supabase, unwrap } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { decimalPoint } from "@/lib/decimal";
import { currencySymbol, dateIn, formatMoney, formatMoneyCents, formatNumber, formatTime, todayIn } from "@/lib/format";
import { everyRow } from "@/lib/paging";
import { can, hasRole, useSession } from "@/lib/session";
import { addDays, localDate } from "@crewtavo/core/time";
import { agingBuckets, previousRange, serviceFigures } from "@crewtavo/core/reports";
import { ReceiptDrafts } from "../jobs/ReceiptDrafts";
import { Sparkline } from "@/components/ui/Chart";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { Breakdown, Change, Lines, ReportCard, ReportTable, TrendChart, type Column, type LineRow, type Part } from "./Charts";
import { CostsWithoutJob, costsWithoutJobKey } from "./CostsWithoutJob";
import styles from "./Finance.module.css";
import { byJobs, jobRates, loadProfit } from "./jobCosts";
import { bucketize, bucketizeShifted, bucketsFor, dayWords, resolveRange, type Range } from "./range";
import { both, datesWords, pct, plural, RangeHeader, rangeQuery, sum, TabBody, TabPanel, useRangeParams } from "./shared";
import { loadSettings } from "@/lib/companySettings";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "payments", label: "Payments" },
  { key: "profit", label: "Profit" },
  { key: "services", label: "Services" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
type OpenTab = (tab: TabKey) => void;
/** Tabs that moved to Metrics; old links to them still land. */
const METRICS_TABS = ["sales", "work", "team", "clients"];

const running = (values: number[]) => {
  let total = 0;
  return values.map((v) => (total += v));
};
/** When a deposit lands or landed, mid-sentence: "today", "tomorrow", "yesterday", or "Mon, Nov 24" (with the year from another one). */
const bankDay = (day: string, today: string) => {
  if (day === today) return "today";
  if (day === addDays(today, 1)) return "tomorrow";
  if (day === addDays(today, -1)) return "yesterday";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: day.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric", timeZone: "UTC" });
};
/** Whole days from one date to a later one. */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
/** How late reads, as Unpaid invoices colors its ages: amber up to 30 days, red past that. */
const lateTone = (days: number) => (days > 30 ? "danger" : "warning");
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
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  return (
    <>
      <RangeHeader title="Finance" state={state} tabs={TABS} tab={tab} />
      <TabPanel tab={tab}>
        {tab === "overview" && <Overview range={range} openTab={openTab} />}
        {tab === "payments" && <Payments range={range} />}
        {tab === "profit" && <Profit range={range} />}
        {tab === "services" && <Services range={range} />}
      </TabPanel>
    </>
  );
}

/* ------------------------------------------------------------------ Payments, shared */

/** How a payment came in, and its color in the method bar (Page-Finance.dc.html: card blue, bank green, check amber, cash grey). */
const METHODS: Record<string, { label: string; color: string }> = {
  card: { label: "Card", color: "var(--invoice)" },
  ach: { label: "Bank transfer", color: "var(--job)" },
  check: { label: "Check", color: "var(--req)" },
  cash: { label: "Cash", color: "var(--quiet)" },
  other: { label: "Other", color: "var(--border-strong)" },
};
const methodOf = (m: string) => METHODS[m] ?? METHODS.other!;

/** Payments received in the range, newest first, with who paid and for which invoice. The Overview and Payments tabs share them. */
function usePayments(range: Range) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["finance", company.id, "payments", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: () =>
      everyRow(
        () =>
          supabase()
            .from("payments")
            .select("id, amount, fee_amount, tip_amount, method, received_at, notes, client:clients(id, display_name, email), invoice:invoices(id, number, issued_on)")
            .eq("company_id", company.id)
            .gte("received_at", range.start)
            .lt("received_at", range.end),
        { order: { column: "received_at", ascending: false } },
      ),
  });
}
type Payment = NonNullable<ReturnType<typeof usePayments>["data"]>[number];

/**
 * One payment on a hairline: the amount, how it was paid, what for (the invoice, which the row
 * opens), who paid and when. `time` says the time of day instead of the day, under a day's heading.
 */
function PaymentRow({ p, time }: { p: Payment; time?: boolean }) {
  const { company } = useSession();
  const tz = company.timezone;
  const refund = Number(p.amount) < 0;
  const method = methodOf(p.method);
  const what = refund ? "Refund" : "Payment";
  const day = dateIn(p.received_at, tz);
  return (
    <li className={styles.pay} data-no-client={p.client ? undefined : ""}>
      <span className={styles.payAmount} data-refund={refund || undefined}>
        {formatMoneyCents(p.amount)}
        {Number(p.tip_amount) > 0 && <span className={styles.payTip}>+{formatMoneyCents(p.tip_amount)} tip</span>}
      </span>
      <span className={styles.payMethod}><i className={styles.dot} style={{ background: method.color }} aria-hidden="true" />{method.label}</span>
      <span className={styles.payWhat}>
        {p.invoice ? (
          <Link className={styles.payLink} to={`/invoices/${p.invoice.id}`}>{what} for invoice #{p.invoice.number}</Link>
        ) : (
          p.notes?.trim() || what
        )}
      </span>
      {p.client && <span className={styles.payClient}><Link to={`/clients/${p.client.id}`}>{p.client.display_name}</Link></span>}
      <time className={styles.payWhen} dateTime={p.received_at} title={paidAt(p.received_at, tz)}>{time ? formatTime(p.received_at, tz) : dayWords(day, todayIn(tz))}</time>
    </li>
  );
}

function PaymentList({ rows }: { rows: Payment[] }) {
  return <ul className={cx("rel", styles.pays)} aria-label="Payments">{rows.map((p) => <PaymentRow key={p.id} p={p} />)}</ul>;
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
    .sort((a, b) => by.get(b)!.value - by.get(a)!.value)
    .map((k) => ({ key: k, label: METHODS[k]!.label, color: METHODS[k]!.color, value: by.get(k)!.value, hint: plural(by.get(k)!.count, "payment") }));
  if (refunds) parts.push({ key: "refunded", label: "Refunded", color: "var(--fill-3)", value: refunded, hint: plural(refunds, "refund") });
  return parts;
}

/* ------------------------------------------------------------------ Overview */

const FIGURES = {
  collected: { label: "Collected", chart: "Collected, running total, against the period before", info: "Payments received, less refunds. Tips aren't included." },
  net: { label: "Net after fees", chart: "Collected after fees, running total, against the period before", info: "Collected, less card and bank processing fees: roughly what reaches your bank." },
  invoiced: { label: "Invoiced", chart: "Invoiced, running total, against the period before", info: "Invoices issued, not counting drafts or voided invoices." },
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
        everyRow(() => db.from("payments").select("amount, fee_amount, received_at").eq("company_id", cid).gte("received_at", prev.start).lt("received_at", prev.end)),
        everyRow(() => db.from("invoices").select("total, issued_on").eq("company_id", cid).not("status", "in", "(draft,void)").gte("issued_on", prev.from).lte("issued_on", range.to)),
        everyRow(() => db.from("invoices").select("id, number, balance_due, due_on, client:clients(id, display_name)").eq("company_id", cid).in("status", ["sent", "partially_paid", "overdue"])),
        everyRow(() => db.from("quotes").select("status, total, sent_at").eq("company_id", cid).gte("sent_at", prev.start).lt("sent_at", range.end)),
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
        const received = pay.filter((p) => Number(p.amount) > 0);
        const fees = sum(pay, (p) => Number(p.fee_amount ?? 0));
        const owed = sum(d.open, (i) => Number(i.balance_due));
        const late = d.open.filter((i) => i.due_on && i.due_on < today && Number(i.balance_due) > 0).sort((a, b) => a.due_on!.localeCompare(b.due_on!));
        const coming = d.payouts.filter((p) => p.status === "pending" || p.status === "in_transit");
        const deposited = d.payouts.find((p) => p.status === "paid");
        const quotesNow = d.quotes.filter((q) => q.sent_at && q.sent_at >= range.start);
        const won = (q: { status: string }) => q.status === "approved" || q.status === "converted";
        const wonNow = quotesNow.filter(won);
        // How long invoices took to be paid: issue date to payment date.
        const waits = received.filter((p) => p.invoice?.issued_on).map((p) => ({ amount: Number(p.amount), days: Math.max(0, Math.round((Date.parse(localDate(new Date(p.received_at), tz)) - Date.parse(p.invoice!.issued_on)) / 86_400_000)) }));
        const avgWait = waits.length ? sum(waits, (w) => w.days) / waits.length : null;
        const waited = sum(waits, (w) => w.amount);
        const speed: LineRow[] = [
          { key: "week", label: "Within a week", test: (n: number) => n <= 7 },
          { key: "month", label: "1–4 weeks", test: (n: number) => n > 7 && n <= 30 },
          { key: "two", label: "1–2 months", test: (n: number) => n > 30 && n <= 60 },
          { key: "more", label: "Over 2 months", test: (n: number) => n > 60 },
        ].map((b) => {
          const rows = waits.filter((w) => b.test(w.days));
          return { key: b.key, label: b.label, note: rows.length ? formatMoney(sum(rows, (w) => w.amount)) : undefined, value: waited ? pct(sum(rows, (w) => w.amount), waited) : "0%", none: !rows.length };
        });
        // Nothing paid on an invoice yet: one quiet line instead of four empty ones.
        if (!waits.length) speed.splice(0, speed.length, { key: "none", label: "No invoice payments in this period", value: "", none: true });
        speed.push({
          key: "won",
          label: <Link to={`/metrics?tab=sales&${rangeQuery(range)}`}>Quotes won</Link>,
          note: wonNow.length ? formatMoney(sum(wonNow, (q) => Number(q.total))) : undefined,
          value: quotesNow.length ? `${wonNow.length} of ${quotesNow.length} · ${pct(wonNow.length, quotesNow.length)}` : "None sent",
          none: !wonNow.length,
        });
        const payers = new Map<string, { id: string; name: string; email: string | null; paid: number }>();
        for (const p of pay) {
          if (!p.client) continue;
          const row = payers.get(p.client.id) ?? { id: p.client.id, name: p.client.display_name, email: p.client.email, paid: 0 };
          row.paid += Number(p.amount);
          payers.set(p.client.id, row);
        }
        const top = [...payers.values()].filter((c) => c.paid > 0).sort((a, b) => b.paid - a.paid).slice(0, 5);
        const aging: LineRow[] = agingBuckets(d.open, today).map((b) => ({
          key: b.key,
          label: b.label,
          note: b.count ? plural(b.count, "invoice") : undefined,
          value: formatMoney(b.amount),
          tone: b.key === "current" ? undefined : b.key === "30" ? "warning" : "danger",
          none: !b.amount,
        }));
        const now = totals[figure].now;
        const before = totals[figure].before;
        const lead = figure === "collected" ? plural(received.length, "payment") : figure === "net" ? `${formatMoneyCents(fees)} in fees` : plural(invoicedNow.length, "invoice");
        return (
          <>
            <div className={styles.hero}>
              <section className={styles.heroMain} aria-label={FIGURES[figure].label}>
                <div className="segmented" role="group" aria-label="Figure to chart">
                  {(Object.keys(FIGURES) as Figure[]).map((k) => (
                    <button key={k} type="button" aria-pressed={figure === k} title={FIGURES[k].info} onClick={() => setFigure(k)}>{FIGURES[k].label}</button>
                  ))}
                </div>
                <div className={styles.big}>{formatMoney(now)}<Change now={now} before={before} /></div>
                <p className={styles.prev}>{lead} · Previous period {formatMoney(before)}, {datesWords(prev.from, prev.to, today)}</p>
                <div className={styles.heroChart}>
                  <TrendChart key={figure} buckets={buckets} values={running(series[figure].now)} previous={running(series[figure].before)} format={formatMoney} label={FIGURES[figure].chart} height={180} area />
                </div>
              </section>
              <aside className={styles.side} aria-label="What you're owed">
                <div className={styles.bals}>
                  <Balance label="Owed to you" value={formatMoney(owed)} hint={plural(d.open.length, "open invoice")} to="/invoices" />
                  <Balance label={statusText("invoice", "overdue")} value={formatMoney(sum(late, (i) => Number(i.balance_due)))} hint={late.length ? plural(late.length, "invoice") : "Nothing late"} to="/invoices?status=overdue" tone={late.length ? "danger" : undefined} />
                  {coming.length > 0 ? (
                    <Balance label="On the way to your bank" value={formatMoney(sum(coming, (p) => Number(p.amount)))} hint={`Arrives ${bankDay(coming.map((p) => p.arrival_on).sort()[0]!, today)}`} to="/payouts" />
                  ) : deposited ? (
                    <Balance label="Last deposit" value={formatMoney(Number(deposited.amount))} hint={`Deposited ${bankDay(deposited.arrival_on, today)}`} to="/payouts" />
                  ) : null}
                </div>
                <RevenueGoal />
              </aside>
            </div>

            <div className={styles.cols3}>
              <ReportCard title="Payments" info="Money received, by how it was paid. Refunds are listed on their own." count={received.length ? formatNumber(received.length) : undefined}>
                <Breakdown parts={methodParts(pay)} format={formatMoney} label="Payments by method" empty="No payments in this period" />
              </ReportCard>
              <ReportCard title="Unpaid invoices" info="What clients owe today, by how late it is." count={formatMoney(owed)}>
                <Lines rows={aging} label="Unpaid invoices by how late they are" />
              </ReportCard>
              <ReportCard title="Time to get paid" info="Days from an invoice being issued to its payment, on average, for payments received in this period; then how much came in how soon." count={avgWait === null ? undefined : `${formatNumber(avgWait, avgWait < 10 ? 1 : 0)} days`}>
                <Lines rows={speed} label="Payments by how long they took" />
              </ReportCard>
            </div>

            <ReportCard title="Recent payments" more={pay.length ? { label: "View all", onClick: () => openTab("payments") } : undefined}>
              {pay.length ? <PaymentList rows={pay.slice(0, 6)} /> : <EmptyState inline title="No payments in this period" />}
            </ReportCard>

            <div className={styles.cols2}>
              <Section title={statusText("invoice", "overdue")} count={late.length || undefined} action={late.length > 4 ? <Link to="/invoices?status=overdue">View all</Link> : undefined}>
                {late.length ? (
                  <RelatedList label="Past due invoices, oldest first">
                    {late.slice(0, 4).map((i) => {
                      const n = daysBetween(i.due_on!, today);
                      return (
                        <RelatedRow
                          key={i.id}
                          to={`/invoices/${i.id}`}
                          lead={`#${i.number}`}
                          title={i.client?.display_name ?? `Invoice #${i.number}`}
                          sub={[`Due ${datesWords(i.due_on!, i.due_on!, today)}`, <span key="late" className={styles.late} data-tone={lateTone(n)}>{n} {n === 1 ? "day" : "days"} late</span>]}
                          end={<b>{formatMoneyCents(i.balance_due)}</b>}
                        />
                      );
                    })}
                  </RelatedList>
                ) : (
                  <EmptyState inline title="Every invoice is within its terms" />
                )}
              </Section>
              <Section title="Top clients by spend" count={payers.size ? plural(payers.size, "client") + " paid" : undefined}>
                {top.length ? (
                  <RelatedList label="Who paid you the most in this period">
                    {top.map((c) => (
                      <RelatedRow key={c.id} to={`/clients/${c.id}`} lead={<RowPerson name={c.name} />} title={c.name} sub={c.email ?? undefined} end={<b>{formatMoneyCents(c.paid)}</b>} />
                    ))}
                  </RelatedList>
                ) : (
                  <EmptyState inline title="No payments in this period" />
                )}
              </Section>
            </div>
          </>
        );
      }}
    </TabBody>
  );
}

/** A figure beside the chart: its label and View, the figure, a quiet line. On a phone, a row of an inset card. */
function Balance({ label, value, hint, to, tone }: { label: string; value: string; hint: string; to: string; tone?: "danger" }) {
  return (
    <div className={styles.bal}>
      <span className={styles.balLabel}>{label}</span>
      <Link className={styles.balLink} to={to} aria-label={`View ${label.toLowerCase()}: ${value}`}>View</Link>
      <span className={styles.balValue} data-tone={tone}>{value}</span>
      <span className={styles.balHint}>{hint}</span>
      <span className={styles.chev} aria-hidden="true"><Icon name="chevronRight" size={16} /></span>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <div className={styles.hero} aria-hidden="true">
        <div className={styles.heroMain} style={{ display: "grid", gap: 12 }}>
          <Skeleton width={260} height={34} radius={10} />
          <Skeleton width={200} height={36} />
          <Skeleton width={240} height={11} />
          <Skeleton height={180} radius={8} />
        </div>
        <div className={styles.side}>
          <div className={styles.bals}>
            {[0, 1, 2].map((i) => <div key={i} className={styles.bal}><span style={{ display: "grid", flex: 1, gap: 6, gridColumn: "1 / -1" }}><Skeleton width="45%" height={10} /><Skeleton width="60%" height={20} /></span></div>)}
          </div>
        </div>
      </div>
      <div className={styles.cols3} aria-hidden="true">{[0, 1, 2].map((i) => <CardSkeleton key={i} lines={4} />)}</div>
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
        // The goals are kept apart from the settings crews read (company_private_settings); saving them below still goes through the company.
        db.from("company_private_settings").select("settings").eq("company_id", company.id).maybeSingle(),
        everyRow(() => db.from("payments").select("amount").eq("company_id", company.id).gte("received_at", yearRange.start)),
      ]);
      const s = (unwrap(settings)?.settings ?? {}) as Record<string, unknown>;
      return { settings: s, goal: Number(s.revenue_goal ?? 0), margin: Number(s.margin_target ?? 0), ytd: sum(payments, (p) => Number(p.amount)) };
    },
  });
  const isAdmin = hasRole(session, "admin");
  const head = (action?: ReactNode) => (
    <div className={styles.goalHead}>
      <h2 className={styles.goalTitle} id="fin-goal">{year} revenue goal</h2>
      {action}
    </div>
  );
  if (!query.data)
    return (
      <section className={styles.goal} aria-labelledby="fin-goal">
        {head()}
        <div className={styles.goalBody}>
          {query.error ? <ErrorState compact error={query.error} onRetry={() => query.refetch()} /> : <div style={{ display: "grid", gap: 8, marginTop: 6 }} aria-hidden="true"><Skeleton width="70%" height={13} /><Skeleton height={8} radius={999} /></div>}
        </div>
      </section>
    );
  const { goal, ytd } = query.data;
  const dayOfYear = Math.floor((Date.parse(today) - Date.parse(`${year}-01-01`)) / 86_400_000) + 1;
  const daysInYear = Number(year) % 4 === 0 ? 366 : 365;
  const pace = dayOfYear / daysInYear;
  const progress = goal > 0 ? ytd / goal : 0;
  const projected = ytd / pace;
  const ahead = progress >= pace;
  return (
    <section className={styles.goal} aria-labelledby="fin-goal">
      {head(isAdmin && goal > 0 && <button type="button" onClick={() => setEditing(true)}>Edit goal</button>)}
      <div className={styles.goalBody}>
        {goal > 0 ? (
          <>
            <div className={styles.goalFigure}>{formatMoney(ytd)} <span>of {formatMoney(goal)}</span></div>
            <div className={styles.track} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(progress * 100))} aria-label="Progress to revenue goal">
              <span className={styles.trackFill} style={{ width: `${Math.min(100, progress * 100)}%` }} />
              <span className={styles.trackPace} style={{ left: `${pace * 100}%` }} title="Where an even pace would be by today" />
            </div>
            <p className={styles.goalState} data-tone={ahead ? "good" : "warning"}>
              {progress >= 1 ? "Goal reached" : ahead ? `Ahead of even pace by ${formatMoney(ytd - goal * pace)}` : `Behind even pace by ${formatMoney(goal * pace - ytd)}`}
            </p>
            <p className={styles.goalNote}>{Math.round(progress * 100)}% there · on track for {formatMoney(projected)}</p>
          </>
        ) : (
          <p className={styles.goalEmpty}>
            No goal set. {formatMoney(ytd)} collected so far this year.
            {isAdmin && <button type="button" onClick={() => setEditing(true)}>Set a revenue goal</button>}
          </p>
        )}
      </div>
      {editing && <GoalDialog settings={query.data.settings} onClose={() => setEditing(false)} />}
    </section>
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
      const g = goal.trim() ? Number(decimalPoint(goal)) : null;
      if (g !== null && !(g >= 0 && g < 1e10)) throw new Error(`Enter a revenue goal of ${currencySymbol()}0 or more.`);
      if (m !== null && !(m >= 0 && m < 100)) throw new Error("Target margin must be between 0 and 99%.");
      // Re-read settings so a concurrent change elsewhere isn't overwritten.
      const current = await loadSettings(company.id);
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
        <Field label="Yearly revenue goal" hint="Collected from January 1, against an even pace through the year.">
          <div className="input-group"><span className="addon">{currencySymbol()}</span><input className="input" inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value.replace(/[^0-9.,]/g, ""))} placeholder="500,000" autoFocus /></div>
        </Field>
        <Field label="Target job margin" optional hint="Jobs under it are counted on Profit.">
          <div className="input-group"><DecimalInput className="input" inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="30" style={{ paddingLeft: 12, paddingRight: 32 }} /><span className="addon addon-right">%</span></div>
        </Field>
        <FormError error={save.error} />
        <div className="form-actions"><FormChecks /><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={save.isPending}>Save goals</Button></div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Payments */

const PAGE = 25;
type FilterKey = string;

function Payments({ range }: { range: Range }) {
  const { company } = useSession();
  const cid = company.id;
  const tz = company.timezone;
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [count, setCount] = useState(PAGE);
  const payments = usePayments(range);
  const rest = useQuery({
    queryKey: ["finance", cid, "billed", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [invoices, open, writtenOff, payouts] = await Promise.all([
        everyRow(() => db.from("invoices").select("total, tax_amount").eq("company_id", cid).not("status", "in", "(draft,void)").gte("issued_on", range.from).lte("issued_on", range.to)),
        everyRow(() => db.from("invoices").select("balance_due, due_on, client:clients(id, display_name)").eq("company_id", cid).in("status", ["sent", "partially_paid", "overdue"])),
        // Bad debt: what was left on invoices written off in the range.
        everyRow(() => db.from("invoices").select("balance_due").eq("company_id", cid).eq("status", "written_off").gte("written_off_at", range.start).lt("written_off_at", range.end)),
        db.from("payouts").select("id", { count: "exact", head: true }).eq("company_id", cid),
      ]);
      if (payouts.error) throw payouts.error;
      return { invoices, open, writtenOff, payouts: payouts.count ?? 0 };
    },
  });
  return (
    <TabBody query={both(payments, rest)} skeleton={<><StatsSkeleton count={4} /><CardSkeleton lines={6} /></>}>
      {([pay, d]) => {
        const today = todayIn(tz);
        const refunds = pay.filter((p) => Number(p.amount) < 0);
        const collected = sum(pay, (p) => Number(p.amount));
        const fees = sum(pay, (p) => Number(p.fee_amount ?? 0));
        const writtenOff = sum(d.writtenOff, (i) => Number(i.balance_due));
        const tips = sum(pay, (p) => Number(p.tip_amount ?? 0));
        const filters = [
          { key: "all", label: "All", rows: pay },
          ...Object.keys(METHODS).map((k) => ({ key: k, label: METHODS[k]!.label, rows: pay.filter((p) => Number(p.amount) >= 0 && (METHODS[p.method] ? p.method : "other") === k) })),
          { key: "refunds", label: "Refunds", rows: refunds },
        ].filter((f) => f.key === "all" || f.rows.length);
        const current = filters.find((f) => f.key === filter) ?? filters[0]!;
        const term = search.trim().toLowerCase().replace(/^#/, "");
        const shown = term
          ? current.rows.filter((p) =>
              [p.client?.display_name, p.notes, p.invoice ? String(p.invoice.number) : null, methodOf(p.method).label, formatMoneyCents(p.amount), String(p.amount)].some((v) => v?.toLowerCase().includes(term)),
            )
          : current.rows;
        const visible = shown.slice(0, count);
        const days: Array<{ day: string; rows: Payment[] }> = [];
        for (const p of visible) {
          const day = dateIn(p.received_at, tz);
          const last = days.at(-1);
          if (last?.day === day) last.rows.push(p);
          else days.push({ day, rows: [p] });
        }
        const pick = (key: FilterKey) => { setFilter(key); setCount(PAGE); };
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
            <StatStrip label="Payments this period">
              <Stat label="Collected" value={formatMoney(collected)} note={plural(pay.length - refunds.length, "payment")} />
              {refunds.length > 0 && <Stat label="Refunded" value={formatMoney(Math.abs(sum(refunds, (p) => Number(p.amount))))} note={plural(refunds.length, "refund")} />}
              <Stat label="Processing fees" value={formatMoneyCents(fees)} note={d.payouts ? <Link to="/payouts">See deposits</Link> : "Card and bank payments"} />
              <Stat label="Net after fees" value={formatMoney(collected - fees)} />
              {tips > 0 && <Stat label="Tips" value={formatMoney(tips)} />}
              <Stat label="Sales tax billed" value={formatMoney(sum(d.invoices, (i) => Number(i.tax_amount)))} note={`On ${plural(d.invoices.length, "invoice")}`} />
              {writtenOff > 0 && <Stat label="Written off" value={formatMoney(writtenOff)} note={<Link to="/invoices?status=written_off">{plural(d.writtenOff.length, "invoice")}</Link>} />}
            </StatStrip>

            <section className={styles.body} style={{ gap: 12 }} aria-label="Payments">
              <Toolbar
                filters={filters.length > 1 && <div className={styles.deskOnly}><FilterTabs label="Filter payments" value={current.key} onChange={pick} options={filters.map((f) => ({ value: f.key, label: f.label, count: f.rows.length }))} /></div>}
                search={<SearchField value={search} onChange={(v) => { setSearch(v); setCount(PAGE); }} placeholder="Client, invoice # or note" label="Search payments" />}
                tools={
                  <>
                    {filters.length > 1 && <Menu
                      items={filters.map((f) => ({ label: f.label, end: formatNumber(f.rows.length), checked: current.key === f.key, onSelect: () => pick(f.key) }))}
                      label={`Show: ${current.label}`}
                      title="Show"
                      triggerClassName={cx("btn btn-sm btn-ghost toolbar-btn", styles.phoneOnly, current.key !== "all" && "is-on")}
                      trigger={<><Icon name="filter" size={15} /><span className="toolbar-btn-text">{current.label}</span></>}
                    />}
                    <button type="button" className="btn btn-sm btn-ghost toolbar-btn" onClick={exportCsv} disabled={!shown.length}>
                      <Icon name="download" size={15} /><span className="toolbar-btn-text">Download</span>
                    </button>
                  </>
                }
              />
              {visible.length ? (
                <InboxList
                  label="Payments"
                  inset
                  foot={
                    <ListFoot end={<><b>{formatMoneyCents(sum(shown, (p) => Number(p.amount)))}</b> in all</>} more={visible.length < shown.length ? { onClick: () => setCount(count + PAGE) } : undefined}>
                      {visible.length < shown.length ? `${formatNumber(visible.length)} of ${plural(shown.length, "payment")}` : plural(shown.length, "payment")}
                    </ListFoot>
                  }
                >
                  {days.map((g) => (
                    <InboxGroup key={g.day} label={dayWords(g.day, today)} count={g.rows.length} end={formatMoneyCents(sum(g.rows, (p) => Number(p.amount)))}>
                      {g.rows.map((p) => <PaymentRow key={p.id} p={p} time />)}
                    </InboxGroup>
                  ))}
                </InboxList>
              ) : (
                <EmptyState icon="dollar" title={term ? `No payments match “${search.trim()}”` : current.key === "all" ? "No payments in this period" : `No ${current.label.toLowerCase()} payments in this period`}>
                  {term ? "Try a client's name, an invoice number or part of a note." : "Payments show here as they come in, by card, bank transfer, check or cash."}
                </EmptyState>
              )}
            </section>

            <ReportCard title="Client balances" subtitle="Who owes you, as of today" count={balances.size ? plural(balances.size, "client") : undefined}>
              <ReportTable
                rows={[...balances.values()]}
                rowKey={(r) => r.id}
                filename={`client-balances-${today}`}
                initialSort={{ key: "balance", desc: true }}
                empty="Nothing owed"
                columns={[
                  { key: "name", label: "Client", value: (r) => r.name, render: (r) => <Link className="cell-link" to={`/clients/${r.id}`}>{r.name}</Link> },
                  { key: "count", label: "Open invoices", num: true, value: (r) => r.count },
                  { key: "oldest", label: "Oldest due", value: (r) => r.oldest, render: (r) => (r.oldest ? <span className={styles.tone} data-tone={r.oldest < today ? lateTone(daysBetween(r.oldest, today)) : undefined}>{datesWords(r.oldest, r.oldest, today)}</span> : null) },
                  { key: "balance", label: "Balance", num: true, value: (r) => Math.round(r.balance * 100) / 100, render: (r) => formatMoney(r.balance) },
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
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["finance", cid, "profit", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: () => loadProfit({ companyId: cid, range, costs }),
  });
  return (
    <TabBody query={query}>
      {(d) => {
        const revenue = sum(d.jobs, (j) => j.revenue);
        const profit = sum(d.jobs, (j) => j.profit);
        const below = d.target ? d.jobs.filter((j) => j.margin !== null && j.margin < d.target!) : [];
        return (
          <>
            <StatStrip label="Profit this period">
              <Stat label="Jobs completed" value={formatNumber(d.jobs.length)} />
              <Stat label="Job revenue" value={formatMoney(revenue)} note="Contract totals" />
              <Stat label="Average job" value={formatMoney(d.jobs.length ? revenue / d.jobs.length : 0)} note={d.jobs.length ? undefined : "No jobs completed"} />
              {costs && <Stat label="Job profit" value={formatMoney(profit)} note={revenue ? `${Math.round((profit / revenue) * 100)}% margin` : undefined} tone={profit < 0 ? "danger" : undefined} />}
              {costs && <Stat label="Below target margin" value={d.target ? formatNumber(below.length) : "No target"} note={d.target ? `Target ${d.target}%` : "Set it with the revenue goal"} tone={below.length ? "warning" : undefined} />}
            </StatStrip>
            {/* Receipts for any job, or none: each waits as a draft until it's checked and saved as an expense. */}
            {costs && hasRole(session, "admin", "office") && (
              <ReportCard title="Receipts and supplier invoices" subtitle="Add several at once: each is read, then waits here to be checked and saved as an expense on its job.">
                <ReceiptDrafts onSaved={() => Promise.all([queryClient.invalidateQueries({ queryKey: ["finance", cid, "profit"] }), queryClient.invalidateQueries({ queryKey: costsWithoutJobKey(cid) })])} />
              </ReportCard>
            )}
            {/* The ones saved with no job: nothing else lists them, so they're kept findable here. */}
            {costs && hasRole(session, "admin", "office") && <CostsWithoutJob onChanged={() => queryClient.invalidateQueries({ queryKey: ["finance", cid, "profit"] })} />}
            {costs && (
              <ReportCard title="Job profitability" subtitle="Labor, sub and crew pay, expenses and materials against each job's contract total" count={d.jobs.length ? plural(d.jobs.length, "job") : undefined}>
                <ReportTable
                  rows={d.jobs}
                  rowKey={(r) => r.id}
                  filename={`job-profitability-${range.from}-to-${range.to}`}
                  initialSort={{ key: "margin", desc: false }}
                  empty="No jobs completed in this period"
                  columns={[
                    { key: "number", label: "Job", value: (r) => r.number, render: (r) => <Link className="cell-link" to={`/jobs/${r.id}`}><span className={styles.quiet}>#{r.number}</span> {r.title}</Link> },
                    { key: "client", label: "Client", value: (r) => r.client },
                    { key: "revenue", label: "Revenue", num: true, value: (r) => r.revenue, render: (r) => formatMoney(r.revenue) },
                    { key: "cost", label: "Costs", num: true, value: (r) => Math.round(r.cost * 100) / 100, render: (r) => formatMoney(r.cost) },
                    { key: "profit", label: "Profit", num: true, value: (r) => Math.round(r.profit * 100) / 100, render: (r) => <span className={styles.tone} data-tone={r.profit < 0 ? "danger" : undefined}>{formatMoney(r.profit)}</span> },
                    {
                      key: "margin", label: "Margin", num: true, value: (r) => (r.margin === null ? null : Math.round(r.margin)),
                      render: (r) => (r.margin === null ? <span className={styles.quiet}>No revenue</span> : <span className={styles.tone} data-tone={r.margin < 0 ? "danger" : d.target && r.margin < d.target ? "warning" : undefined}>{Math.round(r.margin)}%</span>),
                    },
                  ]}
                />
              </ReportCard>
            )}
          </>
        );
      }}
    </TabBody>
  );
}

/* ------------------------------------------------------------------ Services */

const SERVICE_LINES = "service_id, name, quantity, unit_price, invoice:invoices!inner(id, job_id, kind, status, issued_on, discount_amount, credit_amount)";
type ServiceRow = ReturnType<typeof serviceFigures>["services"][number];

function Services({ range }: { range: Range }) {
  const session = useSession();
  const { company } = session;
  const costs = can(session, "job_costs");
  const cid = company.id;
  const query = useQuery({
    queryKey: ["finance", cid, "services", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      // serviceFigures leaves out drafts, voids and part billings too; this just reads fewer rows.
      const [sold, items] = await Promise.all([
        everyRow(() => db.from("invoice_line_items").select(SERVICE_LINES).eq("company_id", cid).gte("invoice.issued_on", range.from).lte("invoice.issued_on", range.to).not("invoice.status", "in", "(draft,void)").not("invoice.kind", "in", "(deposit,progress,retainage)")),
        everyRow(() => db.from("services").select("id, name, category, unit_cost, labor_cost").eq("company_id", cid)),
      ]);
      if (!costs) return serviceFigures(sold, items);
      const ids = [...new Set(sold.flatMap((l) => (l.invoice?.job_id ? [l.invoice.job_id] : [])))];
      const [jobLines, time, expenses, rates, crewPay, costLines, materials] = await Promise.all([
        // Everything the jobs have been invoiced, whenever: their labor is split across all of it.
        byJobs(ids, (jobs) => everyRow(() => db.from("invoice_line_items").select(SERVICE_LINES).eq("company_id", cid).in("invoice.job_id", jobs).not("invoice.status", "in", "(draft,void)").not("invoice.kind", "in", "(deposit,progress,retainage)"))),
        byJobs(ids, (jobs) => everyRow(() => db.from("time_entries").select("id, job_id, started_at, ended_at").in("job_id", jobs))),
        byJobs(ids, (jobs) => everyRow(() => db.from("expenses").select("job_id, amount, in_line_costs").in("job_id", jobs))),
        jobRates(true, ids),
        byJobs(ids, (jobs) => db.rpc("job_pay_costs", { p_jobs: jobs }).then(unwrap)),
        // The jobs' own lines and what was logged on them: logged materials over or under the estimate
        // count here as they do on the job and in Profit.
        byJobs(ids, (jobs) => everyRow(() => db.from("job_line_items").select("job_id, quantity, unit_cost, unit_labor_cost, service_id, unit, parts").in("job_id", jobs))),
        byJobs(ids, (jobs) => everyRow(() => db.from("job_materials").select("job_id, service_id, name, unit, quantity").in("job_id", jobs))),
      ]);
      return serviceFigures(sold, items, { jobLines, time, expenses, rateOf: (t) => Number(rates[t.id] ?? 0), crewPay, costLines, materials });
    },
  });
  const key = (s: ServiceRow) => s.service_id ?? "other";
  const columns: Column<ServiceRow>[] = [
    { key: "name", label: "Service", value: (r) => r.name, render: (r) => <span style={{ fontWeight: 500 }}>{r.name}</span> },
    { key: "category", label: "Category", value: (r) => r.category ?? "", render: (r) => r.category ?? null },
    { key: "count", label: "Times billed", num: true, value: (r) => r.count },
    { key: "revenue", label: "Revenue", num: true, value: (r) => r.revenue, render: (r) => formatMoney(r.revenue) },
  ];
  if (costs)
    columns.push(
      { key: "cost", label: "Costs", num: true, value: (r) => r.cost, render: (r) => formatMoney(r.cost ?? 0) },
      { key: "profit", label: "Profit", num: true, value: (r) => r.profit, render: (r) => <span className={styles.tone} data-tone={(r.profit ?? 0) < 0 ? "danger" : undefined}>{formatMoney(r.profit ?? 0)}</span> },
      {
        key: "margin", label: "Margin", num: true, value: (r) => (r.margin_percent === null ? null : Math.round(r.margin_percent)),
        render: (r) => (r.margin_percent === null ? <span className={styles.quiet}>No revenue</span> : <span className={styles.tone} data-tone={r.margin_percent < 0 ? "danger" : undefined}>{Math.round(r.margin_percent)}%</span>),
      },
    );
  return (
    <TabBody query={query}>
      {(d) => {
        const buckets = bucketsFor(range);
        const top = d.services.filter((s) => s.revenue > 0).slice(0, 6);
        const profit = d.profit ?? 0;
        return (
          <>
            <StatStrip label="Services this period">
              <Stat label="Service revenue" value={formatMoney(d.revenue)} note="Invoiced, paid or not" />
              <Stat label="Items billed" value={formatNumber(d.lines.length)} note={plural(d.services.filter((s) => s.service_id).length, "service")} />
              {costs && <Stat label="Service profit" value={formatMoney(profit)} note={d.revenue ? `${pct(profit, d.revenue)} margin` : undefined} tone={profit < 0 ? "danger" : undefined} />}
            </StatStrip>
            {top.length > 0 && (
              <Section title="Top services">
                <RelatedList label="Top services by revenue">
                  {top.map((s) => {
                    const values = bucketize(d.lines.filter((l) => l.key === key(s)), buckets, (l) => l.issued_on, (l) => l.revenue, company.timezone);
                    return (
                      <RelatedRow
                        key={key(s)}
                        title={s.name}
                        detail={s.category ?? undefined}
                        sub={`Billed ${plural(s.count, "time")}`}
                        end={
                          <>
                            <span className={styles.spark} aria-hidden="true">
                              <Sparkline data={buckets.map((b, i) => ({ label: b.title, value: values[i] ?? 0 }))} config={{ value: { label: s.name, color: "var(--green)" } }} format={formatMoney} height={28} />
                            </span>
                            <b className={styles.endMoney}>{formatMoney(s.revenue)}</b>
                          </>
                        }
                      />
                    );
                  })}
                </RelatedList>
              </Section>
            )}
            <ReportCard
              title={costs ? "Revenue and profit by service" : "Revenue by service"}
              info="Invoices issued in this period, paid or not (not drafts or voided ones), before tax and after discounts and credits. Deposits and progress billing count when the final invoice lists the work. Lines not from the price list are Other."
              subtitle={costs ? "Costs: each item's price list cost, plus its share of the job's labor and expenses, split by what the job's been invoiced" : "From invoices issued in this period"}
            >
              <ReportTable rows={d.services} rowKey={key} filename={`services-${range.from}-to-${range.to}`} initialSort={{ key: "revenue", desc: true }} empty="No invoices issued in this period" columns={columns} />
            </ReportCard>
          </>
        );
      }}
    </TabBody>
  );
}
