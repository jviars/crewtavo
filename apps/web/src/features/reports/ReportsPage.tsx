/**
 * Reports: one date range across six views (overview, sales, work, money, team and clients), each
 * with charts, sortable tables and CSV export. Owners and office staff only.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading, StatsSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { formatDate, formatMoney, formatMoneyCompact, formatNumber, todayIn } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { CATEGORY_LABELS } from "../field/fieldData";
import { BarChart, HBars, ReportCard, ReportTable, Stat } from "./Charts";
import { bucketize, bucketsFor, hoursBetween, PRESETS, resolveRange, shortDate, type PresetKey, type Range } from "./range";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "sales", label: "Sales" },
  { key: "work", label: "Work" },
  { key: "money", label: "Money" },
  { key: "team", label: "Team" },
  { key: "clients", label: "Clients" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

interface TeamMember { user_id: string; labor_rate: number | null; active: boolean; profile: { full_name: string; color: string | null } | null }

/** Supabase returns at most 1,000 rows per request; page through larger result sets. */
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 25; i++) {
    const rows = unwrap(await page(i * 1000, i * 1000 + 999) as never) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
const hrs = (n: number) => (n > 0 && n < 1 ? `${Math.max(1, Math.round(n * 60))} min` : `${formatNumber(n, n < 10 && n % 1 ? 1 : 0)} h`);
const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + (f(r) || 0), 0);
function delta(now: number, before: number): ReactNode {
  if (!before && !now) return null;
  if (!before) return <span style={{ color: "var(--green-dark)", fontWeight: 700 }}>New this period</span>;
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) return "Same as the previous period";
  return <span style={{ color: change > 0 ? "var(--green-dark)" : "var(--danger)", fontWeight: 700 }}>{change > 0 ? "▲" : "▼"} {Math.abs(change)}% <span className="muted" style={{ fontWeight: 500 }}>vs previous period</span></span>;
}

export function ReportsPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const tz = session.company.timezone;
  const today = todayIn(tz);
  const tabs = TABS.filter((t) => t.key !== "money" || can(session, "invoices"));
  const tab = (tabs.find((t) => t.key === params.get("tab"))?.key ?? "overview") as TabKey;
  const presetKey = (PRESETS.find((p) => p.key === params.get("range"))?.key ?? "month") as PresetKey;
  const range = resolveRange(presetKey, today, tz, { from: params.get("from"), to: params.get("to") });
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null ? next.delete(k) : next.set(k, v);
    setParams(next, { replace: true });
  };

  if (!hasRole(session, "admin", "office") || !can(session, "reports")) return <NoAccess title="Reports" />;

  return (
    <>
      <PageHeader
        title="Reports"
        actions={
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="select-pill">
              <Icon name="calendar" size={15} />
              <span className="sr-only">Date range</span>
              <select value={presetKey} onChange={(e) => update(e.target.value === "custom" ? { range: "custom", from: range.from, to: range.to } : { range: e.target.value, from: null, to: null })}>
                {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
              <Icon name="chevronDown" size={14} />
            </label>
            {presetKey === "custom" && (
              <div className="row" style={{ gap: 6 }}>
                <input className="input" type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && update({ from: e.target.value })} aria-label="From" style={{ width: 150 }} />
                <span className="muted">to</span>
                <input className="input" type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && update({ to: e.target.value })} aria-label="To" style={{ width: 150 }} />
              </div>
            )}
          </div>
        }
      />
      <p className="page-subtitle">{shortDate(range.from)}{range.from !== range.to && ` – ${shortDate(range.to)}`}{range.to.slice(0, 4) !== today.slice(0, 4) || range.from.slice(0, 4) !== today.slice(0, 4) ? `, ${range.to.slice(0, 4)}` : ""} · {range.days} {range.days === 1 ? "day" : "days"}</p>
      <div className="underline-tabs" role="tablist" aria-label="Report">
        {tabs.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => update({ tab: t.key === "overview" ? null : t.key })}>{t.label}</button>)}
      </div>
      <div key={tab} className="stack" style={{ gap: 20, animation: "page-in var(--dur-slow) var(--ease-out)" }} role="tabpanel">
        {tab === "overview" && <Overview range={range} />}
        {tab === "sales" && <Sales range={range} />}
        {tab === "work" && <Work range={range} />}
        {tab === "money" && <Money range={range} />}
        {tab === "team" && <Team range={range} />}
        {tab === "clients" && <Clients range={range} />}
      </div>
    </>
  );
}

/** Shared loading/error/stale wrapper for a tab's query. */
function TabBody<T>({ query, stats = 4, children }: { query: { data: T | undefined; error: unknown; isPlaceholderData: boolean; refetch: () => unknown }; stats?: number; children: (data: T) => ReactNode }) {
  if (query.error && !query.data) return <div className="card"><ErrorState error={query.error} onRetry={() => query.refetch()} /></div>;
  if (!query.data)
    return (
      <Loading label="Loading report" className="stack" >
        <StatsSkeleton count={stats} />
        <div className="report-grid"><CardSkeleton height={240} /><CardSkeleton lines={5} /></div>
      </Loading>
    );
  return <div className={`stack${query.isPlaceholderData ? " is-stale" : ""}`} style={{ gap: 20 }}>{children(query.data)}</div>;
}

function useTeam() {
  const session = useSession();
  return useQuery({ queryKey: ["team", session.company.id], staleTime: 5 * 60_000, queryFn: () => api.get<TeamMember[]>("/team") });
}

/* ------------------------------------------------------------------ Overview */

function Overview({ range }: { range: Range }) {
  const session = useSession();
  const { company } = session;
  const money = can(session, "invoices");
  const cid = company.id;
  const prevFrom = new Date(Date.parse(range.start) - (Date.parse(range.end) - Date.parse(range.start))).toISOString();
  const query = useQuery({
    queryKey: ["reports", cid, "overview", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const prevDateFrom = new Date(Date.parse(range.from) - range.days * 86_400_000).toISOString().slice(0, 10);
      const [payments, invoices, open, quotes, clientsNow, clientsBefore, visits] = await Promise.all([
        fetchAll((a, b) => db.from("payments").select("amount, received_at").eq("company_id", cid).gte("received_at", prevFrom).lt("received_at", range.end).range(a, b)),
        fetchAll((a, b) => db.from("invoices").select("total, issued_on").eq("company_id", cid).not("status", "in", "(draft,void)").gte("issued_on", prevDateFrom).lte("issued_on", range.to).range(a, b)),
        fetchAll((a, b) => db.from("invoices").select("balance_due, due_on").eq("company_id", cid).in("status", ["sent", "partially_paid", "overdue"]).range(a, b)),
        fetchAll((a, b) => db.from("quotes").select("status, total").eq("company_id", cid).gte("sent_at", range.start).lt("sent_at", range.end).range(a, b)),
        db.from("clients").select("id", { count: "exact", head: true }).eq("company_id", cid).gte("created_at", range.start).lt("created_at", range.end),
        db.from("clients").select("id", { count: "exact", head: true }).eq("company_id", cid).gte("created_at", prevFrom).lt("created_at", range.start),
        db.from("visits").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "completed").gte("completed_at", range.start).lt("completed_at", range.end),
      ]);
      for (const r of [clientsNow, clientsBefore, visits]) if (r.error) throw r.error;
      return { payments, invoices, open, quotes, newClients: clientsNow.count ?? 0, newClientsBefore: clientsBefore.count ?? 0, visits: visits.count ?? 0 };
    },
  });
  const buckets = bucketsFor(range);
  return (
    <TabBody query={query} stats={6}>
      {(d) => {
        const inRange = d.payments.filter((p) => p.received_at >= range.start);
        const collected = sum(inRange, (p) => Number(p.amount));
        const collectedBefore = sum(d.payments.filter((p) => p.received_at < range.start), (p) => Number(p.amount));
        const invoicedNow = d.invoices.filter((i) => i.issued_on && i.issued_on >= range.from);
        const invoiced = sum(invoicedNow, (i) => Number(i.total));
        const invoicedBefore = sum(d.invoices.filter((i) => i.issued_on && i.issued_on < range.from), (i) => Number(i.total));
        const owed = sum(d.open, (i) => Number(i.balance_due));
        const won = d.quotes.filter((q) => ["approved", "converted"].includes(q.status));
        return (
          <>
            <div className="stat-row">
              {money && (
                <>
                  <Stat label="Collected" value={formatMoney(collected)} hint={delta(collected, collectedBefore)} />
                  <Stat label="Invoiced" value={formatMoney(invoiced)} hint={delta(invoiced, invoicedBefore)} />
                  <Stat label="Owed to you now" value={formatMoney(owed)} hint={`${d.open.length} open ${d.open.length === 1 ? "invoice" : "invoices"}`} />
                </>
              )}
              <Stat label="Quote conversion" value={pct(won.length, d.quotes.length)} hint={`${won.length} of ${d.quotes.length} sent`} />
              <Stat label="New clients" value={formatNumber(d.newClients)} hint={delta(d.newClients, d.newClientsBefore)} />
              <Stat label="Visits completed" value={formatNumber(d.visits)} />
            </div>
            {money && (
              <>
                <div className="report-grid">
                  <ReportCard title="Cash collected" subtitle={`${formatMoney(collected)} from ${inRange.length} ${inRange.length === 1 ? "payment" : "payments"}`}>
                    <BarChart buckets={buckets} values={bucketize(inRange, buckets, (p) => p.received_at, (p) => Number(p.amount), company.timezone)} format={formatMoneyCompact} label="Cash collected over time" />
                  </ReportCard>
                  <RevenueGoal />
                </div>
                <Aging open={d.open} />
              </>
            )}
          </>
        );
      }}
    </TabBody>
  );
}

function Aging({ open }: { open: Array<{ balance_due: number | string; due_on: string | null }> }) {
  const { company } = useSession();
  const today = todayIn(company.timezone);
  const late = (due: string | null) => (due ? Math.floor((Date.parse(today) - Date.parse(due)) / 86_400_000) : 0);
  const buckets = [
    { key: "current", label: "Not yet due", test: (n: number) => n <= 0, color: "var(--green)" },
    { key: "30", label: "1–30 days late", test: (n: number) => n >= 1 && n <= 30, color: "#d9a43b" },
    { key: "60", label: "31–60 days late", test: (n: number) => n >= 31 && n <= 60, color: "#d97a3b" },
    { key: "90", label: "61–90 days late", test: (n: number) => n >= 61 && n <= 90, color: "#c8553d" },
    { key: "90+", label: "Over 90 days late", test: (n: number) => n > 90, color: "var(--danger)" },
  ].map((b) => {
    const rows = open.filter((i) => b.test(late(i.due_on)));
    return { key: b.key, label: b.label, color: b.color, value: sum(rows, (i) => Number(i.balance_due)), hint: `${rows.length}` };
  });
  const total = sum(buckets, (b) => b.value);
  return (
    <ReportCard title="Unpaid invoices by age" subtitle={`${formatMoney(total)} outstanding today`} action={<Link to="/invoices?status=overdue" className="btn btn-ghost btn-sm">Overdue invoices<Icon name="arrowRight" size={14} /></Link>}>
      <HBars rows={buckets.map((b) => ({ ...b, hint: `${b.hint} ${b.hint === "1" ? "invoice" : "invoices"}` }))} format={formatMoney} empty="Nothing owed" />
    </ReportCard>
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
    queryKey: ["reports", company.id, "goal", year],
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
    <ReportCard title={`${year} revenue goal`} action={isAdmin && <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(true)}>{goal ? "Edit" : "Set goal"}</Button>}>
      {goal > 0 ? (
        <div className="stack" style={{ gap: 14 }}>
          <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" }}>{formatMoney(ytd)}</span>
            <span className="muted">of {formatMoney(goal)}</span>
          </div>
          <div className="goal-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Progress to revenue goal">
            <span className="fill" style={{ width: `${Math.min(100, progress * 100)}%`, background: progress >= pace ? "var(--green)" : "#d9a43b" }} />
            <span className="pace" style={{ left: `${pace * 100}%` }} title="Where you'd be on an even pace" />
          </div>
          <div className="kv" style={{ gridTemplateColumns: "1fr auto" }}>
            <span className="muted">Progress</span><strong>{Math.round(progress * 100)}%</strong>
            <span className="muted">Even pace by today</span><strong>{formatMoney(goal * pace)}</strong>
            <span className="muted">On track for</span><strong style={{ color: projected >= goal ? "var(--green-dark)" : "var(--warning)" }}>{formatMoney(projected)}</strong>
          </div>
          <span className="small" style={{ color: progress >= pace ? "var(--green-dark)" : "var(--warning)", fontWeight: 700 }}>
            {progress >= 1 ? "Goal reached. Nice work!" : progress >= pace ? `Ahead of pace by ${formatMoney(ytd - goal * pace)}` : `Behind pace by ${formatMoney(goal * pace - ytd)}`}
          </span>
        </div>
      ) : (
        <EmptyState compact icon="reports" title="No goal set" action={isAdmin ? <Button size="sm" variant="primary" onClick={() => setEditing(true)}>Set a revenue goal</Button> : undefined}>
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
    meta: { inline: true, success: "Report goals saved" },
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
      queryClient.invalidateQueries({ queryKey: ["reports", company.id] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Report goals" size="sm">
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

/* ------------------------------------------------------------------ Sales */

function Sales({ range }: { range: Range }) {
  const { company } = useSession();
  const cid = company.id;
  const team = useTeam();
  const query = useQuery({
    queryKey: ["reports", cid, "sales", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [quotes, clients] = await Promise.all([
        fetchAll((a, b) => db.from("quotes").select("id, status, total, sent_at, approved_at, salesperson_id, created_by, lost_reason, client:clients(lead_source)").eq("company_id", cid).gte("sent_at", range.start).lt("sent_at", range.end).range(a, b)),
        fetchAll((a, b) => db.from("clients").select("id, lead_source, status").eq("company_id", cid).gte("created_at", range.start).lt("created_at", range.end).range(a, b)),
      ]);
      return { quotes, clients };
    },
  });
  const buckets = bucketsFor(range);
  const nameOf = (id: string | null) => (id ? team.data?.find((m) => m.user_id === id)?.profile?.full_name ?? "Former team member" : "Unassigned");
  return (
    <TabBody query={query} stats={6}>
      {(d) => {
        const won = d.quotes.filter((q) => ["approved", "converted"].includes(q.status));
        const lost = d.quotes.filter((q) => q.status === "lost");
        const open = d.quotes.filter((q) => ["sent", "changes_requested"].includes(q.status));
        const approvalDays = won.filter((q) => q.approved_at && q.sent_at).map((q) => (Date.parse(q.approved_at!) - Date.parse(q.sent_at!)) / 86_400_000);
        const avgDays = approvalDays.length ? sum(approvalDays, (n) => n) / approvalDays.length : null;
        const people = new Map<string, { id: string; name: string; sent: number; won: number; value: number; sentValue: number }>();
        for (const q of d.quotes) {
          const id = q.salesperson_id ?? q.created_by ?? "none";
          const row = people.get(id) ?? { id, name: nameOf(id === "none" ? null : id), sent: 0, won: 0, value: 0, sentValue: 0 };
          row.sent++;
          row.sentValue += Number(q.total);
          if (["approved", "converted"].includes(q.status)) { row.won++; row.value += Number(q.total); }
          people.set(id, row);
        }
        const sources = new Map<string, { source: string; clients: number; quotes: number; won: number; value: number }>();
        const src = (s: string | null | undefined) => s?.trim() || "Not recorded";
        for (const c of d.clients) {
          const row = sources.get(src(c.lead_source)) ?? { source: src(c.lead_source), clients: 0, quotes: 0, won: 0, value: 0 };
          row.clients++;
          sources.set(row.source, row);
        }
        for (const q of d.quotes) {
          const key = src(q.client?.lead_source);
          const row = sources.get(key) ?? { source: key, clients: 0, quotes: 0, won: 0, value: 0 };
          row.quotes++;
          if (["approved", "converted"].includes(q.status)) { row.won++; row.value += Number(q.total); }
          sources.set(key, row);
        }
        const reasons = new Map<string, number>();
        for (const q of lost) reasons.set(q.lost_reason?.trim() || "No reason given", (reasons.get(q.lost_reason?.trim() || "No reason given") ?? 0) + 1);
        return (
          <>
            <div className="stat-row">
              <Stat label="Quotes sent" value={formatNumber(d.quotes.length)} hint={formatMoney(sum(d.quotes, (q) => Number(q.total)))} />
              <Stat label="Won" value={formatNumber(won.length)} hint={formatMoney(sum(won, (q) => Number(q.total)))} />
              <Stat label="Conversion" value={pct(won.length, d.quotes.length)} hint={`${lost.length} lost · ${open.length} awaiting`} />
              <Stat label="Average quote" value={d.quotes.length ? formatMoney(sum(d.quotes, (q) => Number(q.total)) / d.quotes.length) : "—"} />
              <Stat label="Days to approval" value={avgDays === null ? "—" : formatNumber(avgDays, 1)} />
              <Stat label="Still awaiting" value={formatMoney(sum(open, (q) => Number(q.total)))} hint={<Link to="/pipeline">Open pipeline</Link>} />
            </div>
            <div className="report-grid">
              <ReportCard title="Quoted value">
                <BarChart buckets={buckets} values={bucketize(d.quotes, buckets, (q) => q.sent_at, (q) => Number(q.total), company.timezone)} format={formatMoneyCompact} label="Quote value sent over time" color="var(--quote, #7b61c9)" />
              </ReportCard>
              <ReportCard title="Why quotes were lost" subtitle={`${lost.length} lost ${lost.length === 1 ? "quote" : "quotes"}`}>
                <HBars rows={[...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ key: label, label, value, color: "var(--danger)" }))} format={(n) => formatNumber(n)} empty="No lost quotes in this period." />
              </ReportCard>
            </div>
            <ReportCard title="By salesperson">
              <ReportTable
                rows={[...people.values()]}
                rowKey={(r) => r.id}
                filename={`sales-by-person-${range.from}-to-${range.to}`}
                initialSort={{ key: "value", desc: true }}
                empty="No quotes were sent in this period."
                columns={[
                  { key: "name", label: "Salesperson", value: (r) => r.name, render: (r) => <strong>{r.name}</strong> },
                  { key: "sent", label: "Sent", num: true, value: (r) => r.sent },
                  { key: "won", label: "Won", num: true, value: (r) => r.won },
                  { key: "rate", label: "Conversion", num: true, value: (r) => (r.sent ? Math.round((r.won / r.sent) * 100) : 0), render: (r) => pct(r.won, r.sent) },
                  { key: "value", label: "Won value", num: true, value: (r) => r.value, render: (r) => formatMoney(r.value) },
                ]}
              />
            </ReportCard>
            <ReportCard title="Lead sources">
              <ReportTable
                rows={[...sources.values()]}
                rowKey={(r) => r.source}
                filename={`lead-sources-${range.from}-to-${range.to}`}
                initialSort={{ key: "value", desc: true }}
                empty="No new clients or quotes in this period."
                columns={[
                  { key: "source", label: "Source", value: (r) => r.source, render: (r) => <strong>{r.source}</strong> },
                  { key: "clients", label: "New clients", num: true, value: (r) => r.clients },
                  { key: "quotes", label: "Quotes sent", num: true, value: (r) => r.quotes },
                  { key: "won", label: "Won", num: true, value: (r) => r.won },
                  { key: "value", label: "Won value", num: true, value: (r) => r.value, render: (r) => formatMoney(r.value) },
                ]}
              />
            </ReportCard>
          </>
        );
      }}
    </TabBody>
  );
}

/* ------------------------------------------------------------------ Work */

function Work({ range }: { range: Range }) {
  const session = useSession();
  const { company } = session;
  const costs = can(session, "job_costs");
  const money = can(session, "invoices");
  const cid = company.id;
  const query = useQuery({
    queryKey: ["reports", cid, "work", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [visits, requests, jobs, lines, settings] = await Promise.all([
        fetchAll((a, b) => db.from("visits").select("completed_at, kind").eq("company_id", cid).eq("status", "completed").gte("completed_at", range.start).lt("completed_at", range.end).range(a, b)),
        fetchAll((a, b) => db.from("requests").select("status").eq("company_id", cid).gte("created_at", range.start).lt("created_at", range.end).range(a, b)),
        fetchAll((a, b) => db.from("jobs").select("id, number, title, status, financials:job_financials(contract_total), client:clients(display_name), lines:job_line_items(quantity, unit_cost)").eq("company_id", cid).in("status", ["requires_invoicing", "completed"]).gte("updated_at", range.start).lt("updated_at", range.end).range(a, b)),
        // Deposit and progress invoices are partial billings of the same work, so count items from the rest.
        fetchAll((a, b) => db.from("invoice_line_items").select("name, quantity, unit_price, invoice:invoices!inner(issued_on, status, kind)").eq("company_id", cid).gte("invoice.issued_on", range.from).lte("invoice.issued_on", range.to).not("invoice.status", "in", "(draft,void)").not("invoice.kind", "in", "(deposit,progress)").gte("unit_price", 0).range(a, b)),
        db.from("companies").select("settings").eq("id", cid).single(),
      ]);
      const ids = jobs.map((j) => j.id);
      const [time, expenses] = ids.length
        ? await Promise.all([
            fetchAll((a, b) => db.from("time_entries").select("job_id, started_at, ended_at, labor_rate").in("job_id", ids.slice(0, 300)).range(a, b)),
            fetchAll((a, b) => db.from("expenses").select("job_id, amount").in("job_id", ids.slice(0, 300)).range(a, b)),
          ])
        : [[], []];
      const target = Number(((unwrap(settings).settings ?? {}) as Record<string, unknown>).margin_target ?? 0) || null;
      const costed = jobs.map((j) => {
        const labor = sum(time.filter((t) => t.job_id === j.id), (t) => hoursBetween(t.started_at, t.ended_at) * Number(t.labor_rate ?? 0));
        const spent = sum(expenses.filter((e) => e.job_id === j.id), (e) => Number(e.amount));
        const materials = sum(j.lines, (l) => Number(l.quantity) * Number(l.unit_cost ?? 0));
        const revenue = Number(j.financials?.contract_total ?? 0);
        const cost = labor + spent + materials;
        return { id: j.id, number: j.number, title: j.title, client: j.client?.display_name ?? "", revenue, cost, profit: revenue - cost, margin: revenue > 0 ? ((revenue - cost) / revenue) * 100 : null };
      });
      return { visits, requests, jobs: costed, lines, target };
    },
  });
  const buckets = bucketsFor(range);
  return (
    <TabBody query={query} stats={6}>
      {(d) => {
        const converted = d.requests.filter((r) => ["quoted", "converted"].includes(r.status)).length;
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
            <div className="stat-row">
              <Stat label="Visits completed" value={formatNumber(d.visits.length)} hint={d.visits.length / range.days >= 1 ? `${formatNumber(d.visits.length / range.days, 1)} per day` : `${formatNumber((d.visits.length / range.days) * 7, 1)} per week`} />
              <Stat label="Requests received" value={formatNumber(d.requests.length)} hint={`${pct(converted, d.requests.length)} quoted or booked`} />
              <Stat label="Jobs completed" value={formatNumber(d.jobs.length)} hint={formatMoney(revenue)} />
              <Stat label="Average job" value={d.jobs.length ? formatMoney(revenue / d.jobs.length) : "—"} />
              {costs && <Stat label="Job profit" value={formatMoney(profit)} hint={revenue ? `${Math.round((profit / revenue) * 100)}% margin` : undefined} tone={profit < 0 ? "bad" : undefined} />}
              {costs && <Stat label="Below target margin" value={d.target ? formatNumber(below.length) : "—"} hint={d.target ? `Target ${d.target}%` : undefined} tone={below.length ? "bad" : undefined} />}
            </div>
            <ReportCard title="Visits completed">
              <BarChart buckets={buckets} values={bucketize(d.visits, buckets, (v) => v.completed_at, () => 1, company.timezone)} format={(n) => formatNumber(n)} label="Visits completed over time" color="var(--job, #3b7dd8)" />
            </ReportCard>
            {costs && (
            <ReportCard title="Job profitability">
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
            {money && (
            <ReportCard title="Products & services sold">
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
            )}
          </>
        );
      }}
    </TabBody>
  );
}

/* ------------------------------------------------------------------ Money */

const METHOD_LABELS: Record<string, string> = { card: "Card", ach: "Bank transfer (ACH)", cash: "Cash", check: "Check", other: "Other" };

function Money({ range }: { range: Range }) {
  const { company } = useSession();
  const cid = company.id;
  const [series, setSeries] = useState<"collected" | "invoiced">("collected");
  const query = useQuery({
    queryKey: ["reports", cid, "money", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [invoices, payments, open] = await Promise.all([
        fetchAll((a, b) => db.from("invoices").select("total, tax_amount, issued_on").eq("company_id", cid).not("status", "in", "(draft,void)").gte("issued_on", range.from).lte("issued_on", range.to).range(a, b)),
        fetchAll((a, b) => db.from("payments").select("amount, tip_amount, method, received_at").eq("company_id", cid).gte("received_at", range.start).lt("received_at", range.end).range(a, b)),
        fetchAll((a, b) => db.from("invoices").select("balance_due, due_on, client:clients(id, display_name)").eq("company_id", cid).in("status", ["sent", "partially_paid", "overdue"]).range(a, b)),
      ]);
      return { invoices, payments, open };
    },
  });
  const buckets = bucketsFor(range);
  return (
    <TabBody query={query} stats={6}>
      {(d) => {
        const today = todayIn(company.timezone);
        const overdue = d.open.filter((i) => i.due_on && i.due_on < today);
        const methods = new Map<string, number>();
        for (const p of d.payments) methods.set(p.method, (methods.get(p.method) ?? 0) + Number(p.amount));
        const balances = new Map<string, { id: string; name: string; count: number; balance: number; oldest: string | null }>();
        for (const i of d.open) {
          if (!i.client) continue;
          const row = balances.get(i.client.id) ?? { id: i.client.id, name: i.client.display_name, count: 0, balance: 0, oldest: null };
          row.count++;
          row.balance += Number(i.balance_due);
          if (i.due_on && (!row.oldest || i.due_on < row.oldest)) row.oldest = i.due_on;
          balances.set(i.client.id, row);
        }
        return (
          <>
            <div className="stat-row">
              <Stat label="Invoiced" value={formatMoney(sum(d.invoices, (i) => Number(i.total)))} hint={`${d.invoices.length} ${d.invoices.length === 1 ? "invoice" : "invoices"}`} />
              <Stat label="Collected" value={formatMoney(sum(d.payments, (p) => Number(p.amount)))} hint={`${d.payments.length} ${d.payments.length === 1 ? "payment" : "payments"}`} />
              <Stat label="Tips" value={formatMoney(sum(d.payments, (p) => Number(p.tip_amount ?? 0)))} />
              <Stat label="Sales tax billed" value={formatMoney(sum(d.invoices, (i) => Number(i.tax_amount)))} />
              <Stat label="Outstanding now" value={formatMoney(sum(d.open, (i) => Number(i.balance_due)))} />
              <Stat label="Past due now" value={formatMoney(sum(overdue, (i) => Number(i.balance_due)))} hint={`${overdue.length} ${overdue.length === 1 ? "invoice" : "invoices"}`} tone={overdue.length ? "bad" : undefined} />
            </div>
            <div className="report-grid">
              <ReportCard
                title={series === "collected" ? "Cash collected" : "Invoiced"}
                action={
                  <div className="segmented" role="group" aria-label="Show">
                    <button type="button" aria-pressed={series === "collected"} onClick={() => setSeries("collected")}>Collected</button>
                    <button type="button" aria-pressed={series === "invoiced"} onClick={() => setSeries("invoiced")}>Invoiced</button>
                  </div>
                }
              >
                <BarChart
                  key={series}
                  buckets={buckets}
                  values={series === "collected" ? bucketize(d.payments, buckets, (p) => p.received_at, (p) => Number(p.amount), company.timezone) : bucketize(d.invoices, buckets, (i) => i.issued_on, (i) => Number(i.total), company.timezone)}
                  format={formatMoneyCompact}
                  label={series === "collected" ? "Cash collected over time" : "Invoiced over time"}
                  color={series === "invoiced" ? "var(--invoice, #2f8f6b)" : undefined}
                />
              </ReportCard>
              <ReportCard title="Payments by method">
                <HBars rows={[...methods].sort((a, b) => b[1] - a[1]).map(([m, value]) => ({ key: m, label: METHOD_LABELS[m] ?? m, value }))} format={formatMoney} empty="No payments in this period." />
              </ReportCard>
            </div>
            <ReportCard title="Client balances">
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
            <Aging open={d.open} />
          </>
        );
      }}
    </TabBody>
  );
}

/* ------------------------------------------------------------------ Team */

function Team({ range }: { range: Range }) {
  const session = useSession();
  const { company } = session;
  const cid = company.id;
  const team = useTeam();
  const query = useQuery({
    queryKey: ["reports", cid, "team", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const rows = await fetchAll((a, b) => supabase().from("time_entries").select("id, user_id, started_at, ended_at, category, approved_at, labor_rate").eq("company_id", cid).gte("started_at", range.start).lt("started_at", range.end).range(a, b));
      // A running timer counts up to now.
      const now = new Date().toISOString();
      return rows.map((e) => ({ ...e, running: !e.ended_at, ended_at: e.ended_at ?? now }));
    },
  });
  const buckets = bucketsFor(range);
  return (
    <TabBody query={query}>
      {(entries) => {
        const member = (id: string) => team.data?.find((m) => m.user_id === id);
        const people = new Map<string, { id: string; name: string; total: number; visit: number; drive: number; other: number; approved: number; cost: number; running: boolean }>();
        for (const e of entries) {
          const h = hoursBetween(e.started_at, e.ended_at);
          const row = people.get(e.user_id) ?? { id: e.user_id, name: member(e.user_id)?.profile?.full_name ?? "Former team member", total: 0, visit: 0, drive: 0, other: 0, approved: 0, cost: 0, running: false };
          row.total += h;
          if (e.category === "visit" || e.category === "assessment") row.visit += h;
          else if (e.category === "drive") row.drive += h;
          else row.other += h;
          if (e.approved_at) row.approved += h;
          if (e.running) row.running = true;
          row.cost += h * Number(e.labor_rate ?? member(e.user_id)?.labor_rate ?? 0);
          people.set(e.user_id, row);
        }
        const total = sum(entries, (e) => hoursBetween(e.started_at, e.ended_at));
        const onVisits = sum(entries.filter((e) => e.category === "visit" || e.category === "assessment"), (e) => hoursBetween(e.started_at, e.ended_at));
        const pending = sum(entries.filter((e) => !e.approved_at && !e.running), (e) => hoursBetween(e.started_at, e.ended_at));
        const categories = new Map<string, number>();
        for (const e of entries) categories.set(e.category, (categories.get(e.category) ?? 0) + hoursBetween(e.started_at, e.ended_at));
        return (
          <>
            <div className="stat-row">
              <Stat label="Hours tracked" value={hrs(total)} hint={`${people.size} ${people.size === 1 ? "person" : "people"}`} />
              <Stat label="On visits" value={pct(onVisits, total)} hint={hrs(onVisits)} />
              {can(session, "job_costs") && <Stat label="Labor cost" value={formatMoney(sum([...people.values()], (p) => p.cost))} />}
              <Stat label="Awaiting approval" value={hrs(pending)} hint={pending ? <Link to="/timesheets">Review timesheets</Link> : "All caught up"} />
            </div>
            <div className="report-grid">
              <ReportCard title="Hours worked">
                <BarChart buckets={buckets} values={bucketize(entries, buckets, (e) => e.started_at, (e) => hoursBetween(e.started_at, e.ended_at), company.timezone)} format={(n) => hrs(n)} label="Hours worked over time" color="var(--ink)" />
              </ReportCard>
              <ReportCard title="Where the time went">
                <HBars rows={[...categories].sort((a, b) => b[1] - a[1]).map(([c, value]) => ({ key: c, label: CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS] ?? c, value }))} format={hrs} empty="No time tracked in this period." />
              </ReportCard>
            </div>
            <ReportCard title="By team member">
              <ReportTable
                rows={[...people.values()]}
                rowKey={(r) => r.id}
                filename={`hours-by-person-${range.from}-to-${range.to}`}
                initialSort={{ key: "total", desc: true }}
                empty="No time tracked in this period."
                columns={[
                  { key: "name", label: "Name", value: (r) => r.name, render: (r) => <span className="row" style={{ gap: 6 }}><strong>{r.name}</strong>{r.running && <span className="pill" data-tone="success">Clocked in</span>}</span> },
                  { key: "total", label: "Total", num: true, value: (r) => Math.round(r.total * 100) / 100, render: (r) => hrs(r.total) },
                  { key: "visit", label: "On visits", num: true, value: (r) => Math.round(r.visit * 100) / 100, render: (r) => hrs(r.visit) },
                  { key: "drive", label: "Driving", num: true, value: (r) => Math.round(r.drive * 100) / 100, render: (r) => hrs(r.drive) },
                  { key: "other", label: "Other", num: true, value: (r) => Math.round(r.other * 100) / 100, render: (r) => hrs(r.other) },
                  { key: "approved", label: "Approved", num: true, value: (r) => (r.total ? Math.round((r.approved / r.total) * 100) : 0), render: (r) => pct(r.approved, r.total) },
                  { key: "cost", label: "Labor cost", num: true, value: (r) => Math.round(r.cost * 100) / 100, render: (r) => formatMoney(r.cost) },
                ]}
              />
            </ReportCard>
          </>
        );
      }}
    </TabBody>
  );
}

/* ------------------------------------------------------------------ Clients */

function Clients({ range }: { range: Range }) {
  const { company } = useSession();
  const cid = company.id;
  const query = useQuery({
    queryKey: ["reports", cid, "clients", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [created, active, leads, jobs] = await Promise.all([
        fetchAll((a, b) => db.from("clients").select("created_at, lead_source").eq("company_id", cid).gte("created_at", range.start).lt("created_at", range.end).range(a, b)),
        db.from("clients").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "active"),
        db.from("clients").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "lead"),
        fetchAll((a, b) => db.from("jobs").select("status, updated_at, client:clients(id, display_name, status, email, marketing_opt_out)").eq("company_id", cid).neq("status", "archived").range(a, b)),
      ]);
      for (const r of [active, leads]) if (r.error) throw r.error;
      // Lapsed: past work, nothing active, nothing touched in a year.
      const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
      const byClient = new Map<string, { id: string; name: string; email: string | null; optOut: boolean; last: string; active: boolean }>();
      for (const j of jobs) {
        if (!j.client || j.client.status === "archived") continue;
        const row = byClient.get(j.client.id) ?? { id: j.client.id, name: j.client.display_name, email: j.client.email, optOut: Boolean(j.client.marketing_opt_out), last: j.updated_at, active: false };
        if (j.updated_at > row.last) row.last = j.updated_at;
        if (j.status === "active") row.active = true;
        byClient.set(j.client.id, row);
      }
      const lapsed = [...byClient.values()].filter((c) => !c.active && c.last < yearAgo);
      return { created, active: active.count ?? 0, leads: leads.count ?? 0, lapsed };
    },
  });
  const buckets = bucketsFor(range);
  return (
    <TabBody query={query}>
      {(d) => {
        const sources = new Map<string, number>();
        for (const c of d.created) sources.set(c.lead_source?.trim() || "Not recorded", (sources.get(c.lead_source?.trim() || "Not recorded") ?? 0) + 1);
        return (
          <>
            <div className="stat-row">
              <Stat label="New clients" value={formatNumber(d.created.length)} hint={`${formatNumber((d.created.length / range.days) * 30, 1)} per month`} />
              <Stat label="Active clients" value={formatNumber(d.active)} />
              <Stat label="Leads" value={formatNumber(d.leads)} hint={<Link to="/clients?status=lead">View leads</Link>} />
              <Stat label="No work in 12+ months" value={formatNumber(d.lapsed.length)} />
            </div>
            <div className="report-grid">
              <ReportCard title="New clients">
                <BarChart buckets={buckets} values={bucketize(d.created, buckets, (c) => c.created_at, () => 1, company.timezone)} format={(n) => formatNumber(n)} label="New clients over time" color="var(--req, #c8553d)" />
              </ReportCard>
              <ReportCard title="How they found you">
                <HBars rows={[...sources].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ key: label, label, value }))} format={(n) => formatNumber(n)} empty="No new clients in this period." />
              </ReportCard>
            </div>
            <ReportCard
              title="No work in 12+ months"
              action={d.lapsed.length > 0 && <Link to="/marketing" className="btn btn-ghost btn-sm"><Icon name="marketing" size={14} />Start a campaign</Link>}
            >
              <ReportTable
                rows={d.lapsed}
                rowKey={(r) => r.id}
                filename={`win-back-${todayIn(company.timezone)}`}
                initialSort={{ key: "last", desc: true }}
                empty="None"
                columns={[
                  { key: "name", label: "Client", value: (r) => r.name, render: (r) => <Link className="cell-link" to={`/clients/${r.id}`}>{r.name}</Link> },
                  { key: "email", label: "Email", value: (r) => r.email ?? "", render: (r) => r.email ? <span className="row" style={{ gap: 6 }}>{r.email}{r.optOut && <span className="pill">Unsubscribed</span>}</span> : <span className="muted">—</span> },
                  { key: "last", label: "Last activity", value: (r) => r.last.slice(0, 10), render: (r) => formatDate(r.last) },
                ]}
              />
            </ReportCard>
          </>
        );
      }}
    </TabBody>
  );
}

