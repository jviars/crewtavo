/**
 * Metrics (Page-Metrics.dc.html): how the business is running beyond the money (quotes and lead sources, visits and
 * requests, the team's hours, and clients won and lapsed) over one date range. Money lives on
 * Finance. Owners and office staff with "Finance and metrics".
 */
import { breakPay, isUnpaidBreak } from "@crewtavo/core/breaks";
import { marketingOn } from "@crewtavo/core/marketing";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { RowPerson } from "@/components/ui/InboxList";
import { NoAccess } from "@/components/ui/States";
import { StatusPill, statusText } from "@/components/ui/StatusPill";
import { supabase } from "@/lib/api";
import { formatDate, formatMoney, formatNumber, todayIn } from "@/lib/format";
import { everyRow } from "@/lib/paging";
import { can, hasRole, useSession } from "@/lib/session";
import { CATEGORY_LABELS } from "../field/fieldData";
import { leadSource } from "../marketing/website";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { HBars, ReportCard, ReportTable, reportStyles as styles, TrendChart } from "../finance/Charts";
import { bucketize, bucketsFor, hoursBetween, type Range } from "../finance/range";
import { hrs, memberName, pct, plural, RangeHeader, sum, TabBody, TabPanel, timeRates, useRangeParams, useTeam } from "../finance/shared";

const TABS = [
  { key: "sales", label: "Sales" },
  { key: "work", label: "Work" },
  { key: "team", label: "Team" },
  { key: "clients", label: "Clients" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function MetricsPage() {
  const session = useSession();
  const state = useRangeParams();
  const tab = (TABS.find((t) => t.key === state.params.get("tab"))?.key ?? "sales") as TabKey;
  if (!hasRole(session, "admin", "office") || !can(session, "reports")) return <NoAccess title="Metrics" />;
  const { range } = state;
  return (
    <>
      <RangeHeader title="Metrics" state={state} tabs={TABS} tab={tab} />
      <TabPanel tab={tab}>
        {tab === "sales" && <Sales range={range} />}
        {tab === "work" && <Work range={range} />}
        {tab === "team" && <Team range={range} />}
        {tab === "clients" && <Clients range={range} />}
      </TabPanel>
    </>
  );
}

/* ------------------------------------------------------------------ Sales */

function Sales({ range }: { range: Range }) {
  const { company } = useSession();
  const cid = company.id;
  const team = useTeam();
  const query = useQuery({
    queryKey: ["metrics", cid, "sales", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [quotes, clients] = await Promise.all([
        everyRow(() => db.from("quotes").select("id, status, total, sent_at, approved_at, salesperson_id, created_by, lost_reason, client:clients(lead_source, requests(web_visit))").eq("company_id", cid).gte("sent_at", range.start).lt("sent_at", range.end)),
        everyRow(() => db.from("clients").select("id, lead_source, status, requests(web_visit)").eq("company_id", cid).gte("created_at", range.start).lt("created_at", range.end)),
      ]);
      return { quotes, clients };
    },
  });
  const buckets = bucketsFor(range);
  const nameOf = (id: string | null) => (id ? memberName(team.data?.find((m) => m.user_id === id)) : "Unassigned");
  return (
    <TabBody query={query}>
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
        // Website-form leads by where their visit came from, once the website counts visits ("Website form · Google").
        for (const c of d.clients) {
          const key = leadSource(c.lead_source, c.requests);
          const row = sources.get(key) ?? { source: key, clients: 0, quotes: 0, won: 0, value: 0 };
          row.clients++;
          sources.set(row.source, row);
        }
        for (const q of d.quotes) {
          const key = leadSource(q.client?.lead_source, q.client?.requests);
          const row = sources.get(key) ?? { source: key, clients: 0, quotes: 0, won: 0, value: 0 };
          row.quotes++;
          if (["approved", "converted"].includes(q.status)) { row.won++; row.value += Number(q.total); }
          sources.set(key, row);
        }
        const reasons = new Map<string, number>();
        for (const q of lost) reasons.set(q.lost_reason?.trim() || "No reason given", (reasons.get(q.lost_reason?.trim() || "No reason given") ?? 0) + 1);
        return (
          <>
            <StatStrip label="Sales this period">
              <Stat label="Quotes sent" value={formatNumber(d.quotes.length)} note={formatMoney(sum(d.quotes, (q) => Number(q.total)))} />
              <Stat label="Won" value={formatNumber(won.length)} note={formatMoney(sum(won, (q) => Number(q.total)))} />
              <Stat label="Conversion" value={d.quotes.length ? pct(won.length, d.quotes.length) : "0%"} note={`${lost.length} ${statusText("quote", "lost").toLowerCase()} · ${open.length} waiting`} />
              <Stat label="Average quote" value={formatMoney(d.quotes.length ? sum(d.quotes, (q) => Number(q.total)) / d.quotes.length : 0)} />
              <Stat label="Days to approval" value={avgDays === null ? "None yet" : formatNumber(avgDays, 1)} note={avgDays === null ? "No quotes approved" : "average"} />
              <Stat label={statusText("quote", "sent")} value={formatNumber(open.length)} note={<>{formatMoney(sum(open, (q) => Number(q.total)))} · <Link to="/pipeline">Open pipeline</Link></>} />
            </StatStrip>
            <div className={styles.cols2}>
              <ReportCard title="Quoted value" count={plural(d.quotes.length, "quote") + " sent"}>
                <TrendChart buckets={buckets} values={bucketize(d.quotes, buckets, (q) => q.sent_at, (q) => Number(q.total), company.timezone)} format={formatMoney} label="Quote value sent over time" height={150} />
              </ReportCard>
              <ReportCard title="Why quotes were lost" count={lost.length || undefined}>
                <HBars
                  rows={[...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ key: label, label, value, quiet: label === "No reason given" }))}
                  format={(n) => formatNumber(n)}
                  color="var(--quote)"
                  empty="No lost quotes in this period"
                />
              </ReportCard>
            </div>
            <div className={styles.cols2}>
              <ReportCard title="By salesperson">
                <ReportTable
                  rows={[...people.values()]}
                  rowKey={(r) => r.id}
                  filename={`sales-by-person-${range.from}-to-${range.to}`}
                  initialSort={{ key: "value", desc: true }}
                  empty="No quotes sent in this period"
                  columns={[
                    { key: "name", label: "Salesperson", value: (r) => r.name, render: (r) => <span className={styles.who}><RowPerson name={r.id === "none" ? null : r.name} empty="Unassigned" />{r.name}</span> },
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
                  empty="No new clients or quotes in this period"
                  columns={[
                    { key: "source", label: "Source", value: (r) => r.source },
                    { key: "clients", label: "New clients", num: true, value: (r) => r.clients },
                    { key: "quotes", label: "Sent", num: true, value: (r) => r.quotes },
                    { key: "won", label: "Won", num: true, value: (r) => r.won },
                    { key: "value", label: "Won value", num: true, value: (r) => r.value, render: (r) => formatMoney(r.value) },
                  ]}
                />
              </ReportCard>
            </div>
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
  const cid = company.id;
  const query = useQuery({
    queryKey: ["metrics", cid, "work", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [visits, requests, jobs] = await Promise.all([
        everyRow(() => db.from("visits").select("completed_at, kind").eq("company_id", cid).eq("status", "completed").gte("completed_at", range.start).lt("completed_at", range.end)),
        everyRow(() => db.from("requests").select("status, created_at").eq("company_id", cid).gte("created_at", range.start).lt("created_at", range.end)),
        db.from("jobs").select("id", { count: "exact", head: true }).eq("company_id", cid).in("status", ["requires_invoicing", "completed"]).gte("updated_at", range.start).lt("updated_at", range.end),
      ]);
      if (jobs.error) throw jobs.error;
      return { visits, requests, jobs: jobs.count ?? 0 };
    },
  });
  const buckets = bucketsFor(range);
  return (
    <TabBody query={query}>
      {(d) => {
        const converted = d.requests.filter((r) => ["quoted", "converted"].includes(r.status)).length;
        const perDay = d.visits.length / range.days;
        return (
          <>
            <StatStrip label="Work this period">
              <Stat label="Visits completed" value={formatNumber(d.visits.length)} note={perDay >= 1 ? `${formatNumber(perDay, 1)} per day` : `${formatNumber(perDay * 7, 1)} per week`} />
              <Stat label="Requests received" value={formatNumber(d.requests.length)} note={d.requests.length ? `${pct(converted, d.requests.length)} quoted or booked` : "None quoted or booked"} />
              <Stat label="Jobs completed" value={formatNumber(d.jobs)} note={can(session, "invoices") ? <Link to="/finance?tab=profit">Profit by job</Link> : undefined} />
            </StatStrip>
            <div className={styles.cols2}>
              <ReportCard title="Visits completed" count={plural(d.visits.length, "visit")}>
                <TrendChart buckets={buckets} values={bucketize(d.visits, buckets, (v) => v.completed_at, () => 1, company.timezone)} format={(n) => plural(n, "visit")} label="Visits completed over time" height={150} />
              </ReportCard>
              <ReportCard title="Requests received" count={`${formatNumber(converted)} of ${formatNumber(d.requests.length)} quoted or booked`}>
                <TrendChart buckets={buckets} values={bucketize(d.requests, buckets, (r) => r.created_at, () => 1, company.timezone)} format={(n) => plural(n, "request")} label="Requests received over time" height={150} />
              </ReportCard>
            </div>
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
    queryKey: ["metrics", cid, "team", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const [rows, rates] = await Promise.all([
        everyRow(() => supabase().from("time_entries").select("id, user_id, started_at, ended_at, category, approved_at").eq("company_id", cid).gte("started_at", range.start).lt("started_at", range.end)),
        timeRates(can(session, "job_costs"), { from: range.start, to: range.end }),
      ]);
      // A running timer counts up to now. Breaks the company doesn't pay for aren't paid hours.
      const now = new Date().toISOString();
      const pay = breakPay(company.settings);
      return rows.map((e) => ({ ...e, labor_rate: rates[e.id] ?? null, running: !e.ended_at, ended_at: e.ended_at ?? now, paid: isUnpaidBreak(e, pay) ? 0 : hoursBetween(e.started_at, e.ended_at ?? now) }));
    },
  });
  const buckets = bucketsFor(range);
  return (
    <TabBody query={query}>
      {(entries) => {
        const member = (id: string) => team.data?.find((m) => m.user_id === id);
        const people = new Map<string, { id: string; name: string; total: number; visit: number; drive: number; other: number; approved: number; cost: number; running: boolean }>();
        for (const e of entries) {
          const h = e.paid;
          const row = people.get(e.user_id) ?? { id: e.user_id, name: memberName(member(e.user_id)), total: 0, visit: 0, drive: 0, other: 0, approved: 0, cost: 0, running: false };
          row.total += h;
          if (e.category === "visit" || e.category === "assessment") row.visit += h;
          else if (e.category === "drive") row.drive += h;
          else row.other += h;
          if (e.approved_at) row.approved += h;
          if (e.running) row.running = true;
          row.cost += h * Number(e.labor_rate ?? member(e.user_id)?.labor_rate ?? 0);
          people.set(e.user_id, row);
        }
        const total = sum(entries, (e) => e.paid);
        const onVisits = sum(entries.filter((e) => e.category === "visit" || e.category === "assessment"), (e) => hoursBetween(e.started_at, e.ended_at));
        const pending = sum(entries.filter((e) => !e.approved_at && !e.running), (e) => e.paid);
        const categories = new Map<string, number>();
        for (const e of entries) categories.set(e.category, (categories.get(e.category) ?? 0) + hoursBetween(e.started_at, e.ended_at));
        return (
          <>
            <StatStrip label="Team this period">
              <Stat label="Paid hours" value={hrs(total)} note={plural(people.size, "person", "people")} />
              <Stat label="On visits" value={total ? pct(onVisits, total) : "0%"} note={hrs(onVisits)} />
              {can(session, "job_costs") && <Stat label="Labor cost" value={formatMoney(sum([...people.values()], (p) => p.cost))} />}
              <Stat label="Awaiting approval" value={hrs(pending)} note={pending ? <Link to="/timesheets">Review timesheets</Link> : "All caught up"} />
            </StatStrip>
            <div className={styles.cols2}>
              <ReportCard title="Hours worked" count={hrs(total)}>
                <TrendChart buckets={buckets} values={bucketize(entries, buckets, (e) => e.started_at, (e) => e.paid, company.timezone)} format={(n) => hrs(n)} label="Hours worked over time" height={150} />
              </ReportCard>
              <ReportCard title="Where the time went" count={categories.size ? plural(categories.size, "kind") : undefined}>
                <HBars rows={[...categories].sort((a, b) => b[1] - a[1]).map(([c, value]) => ({ key: c, label: CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS] ?? c, value }))} format={hrs} empty="No time tracked in this period" />
              </ReportCard>
            </div>
            <ReportCard title="By team member" count={people.size ? plural(people.size, "person", "people") : undefined}>
              <ReportTable
                rows={[...people.values()]}
                rowKey={(r) => r.id}
                filename={`hours-by-person-${range.from}-to-${range.to}`}
                initialSort={{ key: "total", desc: true }}
                empty="No time tracked in this period"
                columns={[
                  { key: "name", label: "Name", value: (r) => r.name, render: (r) => <span className={styles.who}><RowPerson name={r.name} />{r.name}{r.running && <StatusPill label="Clocked in" tone="good" />}</span> },
                  { key: "total", label: "Total", num: true, value: (r) => Math.round(r.total * 100) / 100, render: (r) => hrs(r.total) },
                  { key: "visit", label: "On visits", num: true, value: (r) => Math.round(r.visit * 100) / 100, render: (r) => hrs(r.visit) },
                  { key: "drive", label: "Driving", num: true, value: (r) => Math.round(r.drive * 100) / 100, render: (r) => hrs(r.drive) },
                  { key: "other", label: "Other", num: true, value: (r) => Math.round(r.other * 100) / 100, render: (r) => hrs(r.other) },
                  { key: "approved", label: "Approved", num: true, value: (r) => (r.total ? Math.round((r.approved / r.total) * 100) : 0), render: (r) => (r.total ? pct(r.approved, r.total) : "0%") },
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
  const session = useSession();
  const { company } = session;
  const cid = company.id;
  // Referrals made in the range, as Marketing → Referrals counts them: only with Marketing, and installed.
  const referrals = hasRole(session, "admin", "office") && can(session, "marketing") && marketingOn(company.settings);
  const query = useQuery({
    queryKey: ["metrics", cid, "clients", range.from, range.to, referrals],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [created, active, leads, jobs, referred] = await Promise.all([
        everyRow(() => db.from("clients").select("created_at, lead_source, requests(web_visit)").eq("company_id", cid).gte("created_at", range.start).lt("created_at", range.end)),
        db.from("clients").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "active"),
        db.from("clients").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "lead"),
        everyRow(() => db.from("jobs").select("status, updated_at, client:clients(id, display_name, status, email, marketing_opt_out)").eq("company_id", cid).neq("status", "archived")),
        referrals ? db.rpc("referral_stats", { p_company: cid, p_from: range.start, p_to: range.end }) : Promise.resolve({ data: null, error: null }),
      ]);
      for (const r of [active, leads, referred]) if (r.error) throw r.error;
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
      const stats = referred.data as { leads: number; won: number; revenue: number | null } | null;
      return { created, active: active.count ?? 0, leads: leads.count ?? 0, lapsed, referred: stats };
    },
  });
  const buckets = bucketsFor(range);
  return (
    <TabBody query={query}>
      {(d) => {
        const sources = new Map<string, number>();
        for (const c of d.created) sources.set(leadSource(c.lead_source, c.requests), (sources.get(leadSource(c.lead_source, c.requests)) ?? 0) + 1);
        return (
          <>
            <StatStrip label="Clients">
              <Stat label="New clients" value={formatNumber(d.created.length)} note={`${formatNumber((d.created.length / range.days) * 30, 1)} per month`} />
              <Stat label="Active clients" value={formatNumber(d.active)} />
              <Stat label="Leads" value={formatNumber(d.leads)} note={<Link to="/clients?status=lead">View leads</Link>} />
              <Stat label="No work in 12+ months" value={formatNumber(d.lapsed.length)} note="Past clients to win back" />
              {d.referred && (
                <Stat
                  label="Referrals"
                  value={formatNumber(d.referred.leads)}
                  note={<>{[`${formatNumber(d.referred.won)} won`, d.referred.revenue === null ? null : formatMoney(d.referred.revenue)].filter(Boolean).join(" · ")} · <Link to="/marketing?tab=referrals">View referrals</Link></>}
                />
              )}
            </StatStrip>
            <div className={styles.cols2}>
              <ReportCard title="New clients" count={plural(d.created.length, "client")}>
                <TrendChart buckets={buckets} values={bucketize(d.created, buckets, (c) => c.created_at, () => 1, company.timezone)} format={(n) => plural(n, "client")} label="New clients over time" height={150} />
              </ReportCard>
              <ReportCard title="How they found you" count={sources.size ? plural(sources.size, "source") : undefined}>
                <HBars rows={[...sources].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ key: label, label, value }))} format={(n) => formatNumber(n)} empty="No new clients in this period" />
              </ReportCard>
            </div>
            <ReportCard
              title="No work in 12+ months"
              count={d.lapsed.length || undefined}
              action={d.lapsed.length > 0 && marketingOn(company.settings) && <Link to="/marketing"><Icon name="marketing" size={14} />Start a campaign</Link>}
            >
              <ReportTable
                rows={d.lapsed}
                rowKey={(r) => r.id}
                filename={`win-back-${todayIn(company.timezone)}`}
                initialSort={{ key: "last", desc: true }}
                empty="No clients to win back"
                columns={[
                  { key: "name", label: "Client", value: (r) => r.name, render: (r) => <Link className="cell-link" to={`/clients/${r.id}`}>{r.name}</Link> },
                  { key: "email", label: "Email", value: (r) => r.email ?? "", render: (r) => (r.email ? <span className={styles.who}>{r.email}{r.optOut && <StatusPill label="Unsubscribed" tone="muted" />}</span> : null) },
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
