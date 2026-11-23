/**
 * Snow → Season: every storm this season at every snow customer (snow_events, written when its
 * people are told or it's scheduled): what was forecast, what fell (the forecast's own estimate the
 * day after, until the office writes what it measured), the storm's visits with a report for each
 * (SnowReportPage.tsx), and what it bills. A customer with storm prices bills by the depth that
 * fell (private.snow_price, which follows this figure until the visit is invoiced); one without
 * bills each push the job's own lines. Above it, the season so far in figures and by customer: a
 * table, since its numbers are read across. The storms are inbox rows by the day they fell.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { cx } from "@/components/ui/Button";
import { InboxGroup, InboxList, InboxRow, ListFoot } from "@/components/ui/InboxList";
import { InboxSkeleton, StatsSkeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { addressLine, formatDate, formatDay, formatMoney, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { inches } from "./snowData";
import { workText } from "./storm";
import styles from "./snow.module.css";
import { NumberInput } from "@/components/ui/NumberInput";

const FIELDS =
  "job_id, snow_date, kind, forecast_in, actual_in, actual_by, pushes, job:jobs!inner(number, title, client:clients(display_name), property:properties(line1, city), financials:job_financials(contract_total)), visits:snow_visits(visit:visits(id, title, status, invoice_id))";
/** Each storm, with what its visits bill: read through visit_prices(), since the browser doesn't read a visit's price itself. */
async function loadEvents(companyId: string, since: string) {
  const db = supabase();
  const events = unwrap(await db.from("snow_events").select(FIELDS).eq("company_id", companyId).gte("snow_date", since).order("snow_date", { ascending: false }).limit(1000));
  const ids = events.flatMap((e) => e.visits.flatMap((v) => (v.visit ? [v.visit.id] : [])));
  const prices = new Map<string, number | null>();
  for (let i = 0; i < ids.length; i += 500) {
    for (const p of unwrap(await db.rpc("visit_prices", { p_visits: ids.slice(i, i + 500) }))) prices.set(p.id, p.price);
  }
  return events.map((e) => ({ ...e, visits: e.visits.map((v) => ({ ...v, visit: v.visit && { ...v.visit, price: prices.get(v.visit.id) ?? null } })) }));
}
type Storm = Awaited<ReturnType<typeof loadEvents>>[number];

/** A snow season runs July to June: the winter is one season, whichever year a storm falls in. */
const seasonStart = (today: string) => `${Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) >= 7 ? 0 : 1)}-07-01`;
const name = (e: Storm) => e.job.client?.display_name ?? e.job.title;
const depth = (e: Storm) => (e.actual_in ?? e.forecast_in) as number | null;
const visitsOf = (e: Storm) => e.visits.flatMap((v) => (v.visit && v.visit.status !== "cancelled" ? [v.visit] : []));
/** What a visit bills: its own price (a storm priced by depth), or the job's lines. */
function charge(e: Storm, visit: { price: number | null }): number {
  const lines = Array.isArray(e.job.financials) ? e.job.financials[0] : e.job.financials;
  return Number(visit.price ?? lines?.contract_total ?? 0);
}
const done = (e: Storm) => visitsOf(e).filter((v) => v.status === "completed");
const billed = (e: Storm) => done(e).reduce((total, v) => total + charge(e, v), 0);

export function StormLog() {
  const { company } = useSession();
  const since = seasonStart(todayIn(company.timezone));
  const storms = useQuery({ queryKey: ["snow", company.id, "log", since], queryFn: () => loadEvents(company.id, since) });
  if (storms.isPending) return <><StatsSkeleton count={4} /><InboxSkeleton rows={4} groups={2} /></>;
  if (storms.error && !storms.data) return <ErrorState error={storms.error} onRetry={() => storms.refetch()} />;
  const all = storms.data ?? [];
  if (!all.length) {
    return (
      <EmptyState icon="snow" title="No storms logged this season">
        A storm goes in the log when a snow customer's people are told about it, or when you schedule it. What fell is filled in the day after.
      </EmptyState>
    );
  }
  const customers = [...new Map(all.map((e) => [e.job_id, e])).values()]
    .map((first) => {
      const mine = all.filter((e) => e.job_id === first.job_id);
      return { first, storms: mine.length, snow: mine.reduce((n, e) => n + (depth(e) ?? 0), 0), visits: mine.reduce((n, e) => n + done(e).length, 0), billed: mine.reduce((n, e) => n + billed(e), 0) };
    })
    .sort((a, b) => name(a.first).localeCompare(name(b.first)));
  // The storms by the day they fell, newest first.
  const days = [...new Set(all.map((e) => e.snow_date))].map((date) => ({ date, storms: all.filter((e) => e.snow_date === date) }));
  return (
    <>
      <StatStrip label="This season">
        <Stat label="Storm days this season" value={days.length} note={`Since ${formatDate(since)}`} />
        <Stat label="Customers with a storm" value={customers.length} note={`${all.length} ${all.length === 1 ? "storm" : "storms"} between them`} />
        <Stat label="Visits done" value={customers.reduce((n, c) => n + c.visits, 0)} note="Plow and salt" />
        <Stat label="Billed for them" value={formatMoney(customers.reduce((n, c) => n + c.billed, 0))} note="Before tax, for the visits done" />
      </StatStrip>

      <div className={styles.listHead}>
        <div className={styles.listTitle}><h2>This season by customer</h2></div>
      </div>
      <div className={cx("card", styles.byCustomer)}>
        <table className="table table-stack">
          <thead><tr><th>Customer</th><th className="num">Storms</th><th className="num">Snow</th><th className="num">Visits done</th><th className="num">Billed</th></tr></thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.first.job_id}>
                <td><Link className="cell-link" to={`/jobs/${c.first.job_id}`}>{name(c.first)}</Link><div className="muted small">{addressLine(c.first.job.property) || c.first.job.title}</div></td>
                <td className="num tabular">{c.storms} <span className="muted small">{c.storms === 1 ? "storm" : "storms"}</span></td>
                <td className="num tabular">{inches(c.snow)} <span className="muted small">total</span></td>
                <td className="num tabular">{c.visits} <span className="muted small">{c.visits === 1 ? "visit" : "visits"}</span></td>
                <td className="num tabular strong">{formatMoney(c.billed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.listHead}>
        <div className={styles.listTitle}>
          <h2>Storms</h2>
          <span>What fell sets a storm's price, until its visit is invoiced. Where that's an estimate, enter what you measured first.</span>
        </div>
      </div>
      <InboxList label="Storms this season" inset className={styles.rows} foot={<ListFoot>{all.length} {all.length === 1 ? "storm" : "storms"}</ListFoot>}>
        {days.map(({ date, storms: those }) => {
          const total = those.reduce((n, e) => n + billed(e), 0);
          return (
            <InboxGroup key={date} label={formatDay(`${date}T12:00:00`)} count={those.length} end={total ? formatMoney(total) : undefined}>
              {those.map((e) => <StormRow key={`${e.job_id}:${e.snow_date}`} storm={e} />)}
            </InboxGroup>
          );
        })}
      </InboxList>
    </>
  );
}

function StormRow({ storm: e }: { storm: Storm }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [fell, setFell] = useState(e.actual_in == null ? "" : String(e.actual_in));
  const save = useMutation({
    meta: { success: "What fell is saved" },
    mutationFn: async () => {
      const amount = fell.trim() === "" ? null : Number(fell);
      if (amount != null && !(amount >= 0 && amount <= 100)) throw new Error("What fell is 0 to 100 inches.");
      unwrap(await supabase().from("snow_events").update({ actual_in: amount }).eq("job_id", e.job_id).eq("snow_date", e.snow_date));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["snow", company.id, "log"] }),
  });
  const changed = fell.trim() !== (e.actual_in == null ? "" : String(e.actual_in));
  const visits = visitsOf(e);
  const finished = done(e);
  // The estimate runs low where snow is light and dry, and it sets the price: said before the invoice, not after.
  const estimated = e.actual_by == null && finished.some((v) => v.price != null && !v.invoice_id);
  const work = workText({ kind: e.kind === "salt" ? "salt" : "plow", pushes: e.pushes });
  return (
    <InboxRow
      to={`/jobs/${e.job_id}`}
      title={name(e)}
      square
      badge={<span className={cx("il-num", styles.wideOnly)}>{work}</span>}
      subject={addressLine(e.job.property) || e.job.title}
      meta={[
        <span className={styles.fell}>
          <span className="input-group">
            <NumberInput
              className="input" inputMode="decimal" min={0} max={100} step={0.1} value={fell} placeholder="—" aria-label={`What fell at ${name(e)} on ${formatDate(e.snow_date)}, in inches`}
              onChange={(ev) => setFell(ev.target.value)} onBlur={() => changed && save.mutate()} onKeyDown={(ev) => ev.key === "Enter" && changed && save.mutate()}
            />
            <span className="addon addon-right addon-unit">in</span>
          </span>
          fell
        </span>,
        // On a phone the field says it on its own; the aside says when the price is an estimate.
        save.error ? <span className={styles.fellError}>{save.error.message}</span> : <span className={styles.wideOnly}>{e.actual_in == null ? "Not known yet" : e.actual_by ? "As the office wrote it" : "The forecast's estimate"}</span>,
        e.forecast_in != null && <span className={styles.wideOnly}>{inches(Number(e.forecast_in))} was forecast</span>,
        // On a phone the work is said here, so the name has the first line.
        <span className={styles.phoneOnly}>{work}</span>,
        <span className="meta-break">
          {visits.length ? `${finished.length} of ${visits.length} done` : "Not scheduled"}
          {visits.map((v, i) => (
            <span key={v.id} className={styles.reportLink}>
              <Link to={`/snow/report/${v.id}`}>{visits.length > 1 ? `Report ${i + 1}` : "Service report"}</Link>
              {v.status !== "completed" && <span> · not done yet</span>}
            </span>
          ))}
        </span>,
      ]}
      aside={
        finished.length > 0 && (
          <>
            <span className="il-money">{formatMoney(billed(e))}</span>
            {estimated ? <span className="il-sub" data-tone="warning">Priced on an estimate</span> : finished.every((v) => v.invoice_id) ? <StatusPill label="Invoiced" tone="good" /> : <StatusPill label="To invoice" tone="pending" />}
          </>
        )
      }
    />
  );
}
